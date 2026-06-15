import { readdirSync, statSync, readFileSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import type { InstanceDef } from "./instances.ts";
import {
  blockResetAt,
  bucketEntries,
  weekWindowStart,
  type UsageEntry,
  type WindowTotals,
} from "./usage.ts";
import type { SessState } from "./tracker.ts";

export interface SessionMeta {
  sessionId: string;
  path: string;
  lastTs: number;
  cwd: string;
  gitBranch: string;
  version: string;
  title: string; // best available: customTitle > aiTitle > lastPrompt
  lastPrompt: string;
  sessionKind: string;
  entrypoint: string;
  /** newest streamed event in the session (assistant text or tool call) */
  activity: string;
  activityKind: "text" | "tool" | "user" | "";
  turns: number; // assistant text messages — substance signal
  tools: number; // tool_use calls — substance signal
  ended: boolean; // last assistant turn ended (awaiting user) vs mid-task (tool running)
  model: string; // model id of the latest assistant message
  ctxTokens: number; // context window fill of the latest turn (input+cache read+create)
  thinking: boolean; // latest assistant turn used extended thinking
  bgShells: number; // running run_in_background shells (launches minus kills)
}

export type Status = "WORKING" | "LIVE" | "IDLE" | "OFFLINE";

export interface AccountInfo {
  email: string;
  login: string; // displayName
  org: string; // organizationName
  role: string; // organizationRole
  plan: string; // prettified Max tier
}

export interface SessionSummary {
  sessionId: string;
  path: string;
  title: string;
  activity: string;
  activityKind: SessionMeta["activityKind"];
  cwd: string;
  gitBranch: string;
  lastTs: number;
  working: boolean; // registry status === busy
  live: boolean; // present in the session registry (a running process)
  ended: boolean; // last assistant turn ended (awaiting user) vs mid-task
  state: SessState; // aktiv | monitor | wartet | stale
  regStatus: string; // raw status from Claude Code's session registry
  model: string; // model id of the latest assistant message
  ctxTokens: number; // context window fill of the latest turn
  thinking: boolean; // latest turn used extended thinking
  bg: boolean; // session is a background job (registry kind === "bg")
  bgShells: number; // running run_in_background shells inside this session
  pid: number; // OS pid of the running session process (0 = history)
}

export interface InstanceState {
  def: InstanceDef;
  account: AccountInfo;
  status: Status;
  running: boolean;
  sessions: SessionSummary[]; // recently-active ("laufende") user sessions, newest first
  block5h: WindowTotals;
  today: WindowTotals;
  week: WindowTotals;
  reset5h: number; // epoch ms when the 5h block resets (0 = none active)
  resetWk: number; // epoch ms when the weekly block resets (0 = none active)
  error?: string;
}

/** A session counts as "running" if it was written within this window. */
const ACTIVE_MS = Number(process.env.CD_ACTIVE_MINS ?? 15) * 60_000;
/** Also show recent, substantial, NON-running sessions (history) for this long,
 *  so restarting an instance doesn't hide its sessions. 0 disables. */
const HISTORY_MS = Number(process.env.CD_HISTORY_MINS ?? 360) * 60_000;
/** Wrote within this window => actively generating right now. */
const WORKING_MS = 8_000;

interface ParsedSession {
  mtimeMs: number;
  size: number;
  entries: UsageEntry[];
  meta: SessionMeta;
}

const cache = new Map<string, ParsedSession>();

function safeJson<T>(line: string): T | null {
  try {
    return JSON.parse(line) as T;
  } catch {
    return null;
  }
}

function clip(s: string, n = 200): string {
  const flat = s.replace(/\s+/g, " ").trim();
  const cp = [...flat]; // split by code points so emoji/surrogates aren't cut
  return cp.length > n ? cp.slice(0, n - 1).join("") + "…" : flat;
}

function toolSummary(name: string, input: any): string {
  if (!input || typeof input !== "object") return name;
  const arg =
    input.command ??
    input.file_path ??
    input.path ??
    input.pattern ??
    input.query ??
    input.prompt ??
    input.description ??
    "";
  return arg ? `${name}: ${clip(String(arg), 60)}` : name;
}

/** Describe the newest event of a message for the live activity line. */
function describeMessage(
  type: string,
  msg: any,
): { text: string; kind: "text" | "tool" | "user" } | null {
  const content = msg?.content;
  if (type === "user") {
    if (typeof content === "string") {
      if (/<system-reminder>|tool_result|<local-command|<command-(name|message|args|stdout)/.test(content))
        return null;
      return { text: clip(content), kind: "user" };
    }
    return null; // array user messages are tool results — skip as noise
  }
  // assistant
  const clean = (t: string) => (t && t.trim() && t.trim() !== "(no content)" ? t : "");
  if (typeof content === "string")
    return clean(content) ? { text: clip(content), kind: "text" } : null;
  if (!Array.isArray(content)) return null;
  let text = "";
  let tool: string | null = null;
  for (const part of content) {
    if (part?.type === "text" && clean(part.text)) text = part.text;
    else if (part?.type === "tool_use" && part.name) tool = toolSummary(part.name, part.input);
  }
  if (tool) return { text: tool, kind: "tool" };
  if (text) return { text: clip(text), kind: "text" };
  return null;
}

function parseSessionFile(path: string, sessionId: string): ParsedSession {
  const st = statSync(path);
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;

  const entries: UsageEntry[] = [];
  const meta: SessionMeta = {
    sessionId,
    path,
    lastTs: st.mtimeMs,
    cwd: "",
    gitBranch: "",
    version: "",
    title: "",
    lastPrompt: "",
    sessionKind: "",
    entrypoint: "",
    activity: "",
    activityKind: "",
    turns: 0,
    tools: 0,
    ended: false,
    model: "",
    ctxTokens: 0,
    thinking: false,
    bgShells: 0,
  };

  let aiTitle = "";
  let customTitle = "";
  let firstPrompt = "";
  let lastKind = ""; // assistant_end | assistant_tool | tool_result | user
  let bgLaunch = 0; // run_in_background Bash launches
  let bgKill = 0; // KillShell calls
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    if (!line) continue;
    const o = safeJson<any>(line);
    if (!o) continue;

    // FIRST cwd only = the session's launch/project dir. Later lines may have
    // cd'd into a subdir; that drifted cwd doesn't map to the project dir where
    // the transcript is filed, which breaks `claude --resume` (it's cwd-scoped).
    if (o.cwd && !meta.cwd) meta.cwd = o.cwd;
    if (o.gitBranch) meta.gitBranch = o.gitBranch;
    if (o.version) meta.version = o.version;
    if (o.sessionKind) meta.sessionKind = o.sessionKind;
    if (o.entrypoint) meta.entrypoint = o.entrypoint;
    if (typeof o.aiTitle === "string" && o.aiTitle) aiTitle = o.aiTitle;
    // Ignore the dashboard's own auto-generated "dash <key> <folder>" names so a
    // previously-clobbered session shows its real (ai) title again.
    if (typeof o.customTitle === "string" && o.customTitle && !/^dash c\d+ /.test(o.customTitle))
      customTitle = o.customTitle;
    if (typeof o.lastPrompt === "string" && o.lastPrompt) meta.lastPrompt = o.lastPrompt;

    if (o.timestamp) {
      const t = Date.parse(o.timestamp);
      if (!Number.isNaN(t) && t > meta.lastTs) meta.lastTs = t;
    }

    if ((o.type === "assistant" || o.type === "user") && !o.isMeta && o.message) {
      const act = describeMessage(o.type, o.message);
      if (act) {
        meta.activity = act.text;
        meta.activityKind = act.kind;
      }
    }

    // first real user prompt — fallback name for sessions Claude hasn't titled
    if (!firstPrompt && o.type === "user" && !o.isMeta && typeof o.message?.content === "string") {
      const c = o.message.content;
      if (c.trim() && !/^PREVIOUS AI RESPONSE|<system-reminder>|<local-command|<command-/.test(c)) {
        firstPrompt = clip(c, 70);
      }
    }

    if (o.type === "assistant" && Array.isArray(o.message?.content)) {
      let thinking = false;
      for (const p of o.message.content) {
        if (p?.type === "text" && typeof p.text === "string" && p.text.trim()) meta.turns++;
        else if (p?.type === "tool_use") {
          meta.tools++;
          if (p.name === "Bash" && p.input?.run_in_background === true) bgLaunch++;
          else if (p.name === "KillShell") bgKill++;
        } else if (p?.type === "thinking") thinking = true;
      }
      lastKind = o.message.stop_reason === "tool_use" ? "assistant_tool" : "assistant_end";
      // latest-turn snapshot: model, context window fill, thinking
      if (o.message.model) meta.model = o.message.model;
      const u = o.message.usage;
      if (u) {
        meta.ctxTokens =
          (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      }
      meta.thinking = thinking;
    } else if (o.type === "user" && !o.isMeta && o.message) {
      const c = o.message.content;
      if (Array.isArray(c)) lastKind = "tool_result"; // tool result → Claude will continue
      else if (typeof c === "string" && !/<system-reminder>|<local-command|<command-/.test(c)) lastKind = "user";
    }

    const u = o?.message?.usage;
    if (o.type === "assistant" && u) {
      const ts = o.timestamp ? Date.parse(o.timestamp) : st.mtimeMs;
      entries.push({
        ts: Number.isNaN(ts) ? st.mtimeMs : ts,
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheCreate: u.cache_creation_input_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        model: o?.message?.model ?? "",
      });
    }
  }

  meta.title = customTitle || aiTitle || firstPrompt;
  meta.bgShells = Math.max(0, bgLaunch - bgKill);
  meta.ended = lastKind === "assistant_end";
  const parsed: ParsedSession = { mtimeMs: st.mtimeMs, size: st.size, entries, meta };
  cache.set(path, parsed);
  return parsed;
}

/** Map of configDir -> number of live processes using it. */
export function getRunningConfigDirs(): Map<string, number> {
  const map = new Map<string, number>();
  try {
    const out = Bun.spawnSync(["ps", "eww", "-axo", "command"]).stdout.toString();
    const re = /CLAUDE_CONFIG_DIR=(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(out))) {
      const dir = m[1];
      map.set(dir, (map.get(dir) ?? 0) + 1);
    }
  } catch {
    /* ps unavailable — treat as no running info */
  }
  return map;
}

function prettyPlan(acc: any): string {
  const tier: string = acc.organizationRateLimitTier ?? "";
  const m = tier.match(/max_(\d+x)/i);
  if (m) return `Max ${m[1]}`;
  if (acc.organizationType === "claude_max") return "Max";
  if (typeof acc.organizationType === "string" && acc.organizationType)
    return acc.organizationType.replace(/^claude_/, "").replace(/_/g, " ");
  return "";
}

function readAccount(configDir: string): AccountInfo {
  const empty: AccountInfo = { email: "", login: "", org: "", role: "", plan: "" };
  try {
    const raw = readFileSync(join(configDir, ".claude.json"), "utf8");
    const o = JSON.parse(raw);
    const acc = o.oauthAccount ?? {};
    return {
      email: acc.emailAddress ?? acc.email ?? "",
      login: acc.displayName ?? "",
      org: acc.organizationName ?? "",
      role: acc.organizationRole ?? "",
      plan: prettyPlan(acc),
    };
  } catch {
    return empty;
  }
}

function listSessionFiles(projectsDir: string): { path: string; id: string; mtimeMs: number }[] {
  const files: { path: string; id: string; mtimeMs: number }[] = [];
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(projectsDir);
  } catch {
    return files;
  }
  for (const pd of projectDirs) {
    const full = join(projectsDir, pd);
    let names: string[];
    try {
      if (!statSync(full).isDirectory()) continue;
      names = readdirSync(full);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith(".jsonl")) continue;
      const p = join(full, n);
      try {
        files.push({ path: p, id: n.replace(/\.jsonl$/, ""), mtimeMs: statSync(p).mtimeMs });
      } catch {
        /* skip */
      }
    }
  }
  return files;
}

/**
 * A real work session. Includes interactive terminals (`cli`), subagent/SDK
 * sessions (`sdk-cli`), background tasks (`bg`) and worktree sessions — all of
 * which are genuinely running across the instances. Only internal memory /
 * observer infrastructure is excluded as noise.
 */
function isUserSession(m: SessionMeta): boolean {
  if (/observer-sessions|\.claude-mem/.test(m.cwd)) return false;
  return true;
}

/** A running session as recorded in Claude Code's own registry (sessions/*.json). */
interface RegEntry {
  sessionId: string;
  cwd: string;
  status: string; // busy | idle | shell | ...
  kind: string;
  entrypoint: string;
  name: string;
  startedAt: number;
  updatedAt: number;
  pid: number;
}

/** Sessions the user dismissed from the dashboard view (session-scoped, in-memory). */
const dismissed = new Set<string>();
export function dismissSession(id: string): void {
  if (id) dismissed.add(id);
}

/** Is a pid still running? (EPERM means it exists but isn't ours — treat alive.) */
function pidAlive(pid: number): boolean {
  if (!pid) return true; // unknown pid → don't hide the session
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

/** Read the live process registry — the authoritative set of running sessions. */
function readRegistry(configDir: string): RegEntry[] {
  const dir = join(configDir, "sessions");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const byId = new Map<string, RegEntry>();
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    try {
      const o = JSON.parse(readFileSync(join(dir, n), "utf8"));
      if (!o.sessionId) continue;
      const e: RegEntry = {
        sessionId: o.sessionId,
        cwd: o.cwd ?? "",
        status: o.status ?? "",
        kind: o.kind ?? "",
        entrypoint: o.entrypoint ?? "",
        name: o.name ?? "",
        startedAt: o.startedAt ?? 0,
        updatedAt: o.updatedAt ?? o.statusUpdatedAt ?? 0,
        pid: o.pid ?? 0,
      };
      const prev = byId.get(e.sessionId);
      if (!prev || e.updatedAt >= prev.updatedAt) byId.set(e.sessionId, e);
    } catch {
      /* skip */
    }
  }
  return [...byId.values()];
}

/** Drop internal infra (memory observers) and non-session shell helpers. */
function isRealReg(r: RegEntry): boolean {
  if (/observer-sessions|\.claude-mem/.test(r.cwd)) return false;
  if (r.status === "shell" || !r.status) return false;
  return true;
}

function stateOf(status: string, ended: boolean, background: boolean): SessState {
  if (status === "busy") return "aktiv";
  if (background) return "monitor"; // a live background job: active, not waiting/stale
  return ended ? "wartet" : "monitor";
}

export function collectInstance(
  def: InstanceDef,
  now: number,
  running: Map<string, number>,
): InstanceState {
  const account = readAccount(def.configDir);
  const isRunning = (running.get(def.configDir) ?? 0) > 0;
  const projectsDir = join(def.configDir, "projects");
  const files = listSessionFiles(projectsDir);

  const weekStart = weekWindowStart(now);
  const allEntries: UsageEntry[] = [];
  let newest: { path: string; id: string; mtimeMs: number } | null = null;
  const candidates: SessionMeta[] = [];

  for (const f of files) {
    if (!newest || f.mtimeMs > newest.mtimeMs) newest = f;
    // Only parse files touched within the usage window to keep ticks cheap.
    if (f.mtimeMs < weekStart) continue;
    try {
      const parsed = parseSessionFile(f.path, f.id);
      for (const e of parsed.entries) allEntries.push(e);
      candidates.push(parsed.meta);
    } catch {
      /* skip unreadable file */
    }
  }

  // Sessions come from Claude Code's own live registry — the authoritative set
  // of running processes (matches the in-app session picker). Each is joined to
  // its transcript .jsonl (by sessionId) for title/activity/branch. This avoids
  // counting historical/automation fragment files that aren't actually running.
  const jsonlById = new Map(files.map((f) => [f.id, f.path]));
  // Only real sessions: present in the registry AND backed by a transcript.
  // Helper processes (pty-host, computer-use, spares) have no projects/*.jsonl.
  const reg = readRegistry(def.configDir).filter(
    (r) => isRealReg(r) && jsonlById.has(r.sessionId) && pidAlive(r.pid) && !dismissed.has(r.sessionId),
  );
  const liveSessions: SessionSummary[] = reg
    .map((r) => {
      const path = jsonlById.get(r.sessionId);
      let m: SessionMeta | null = null;
      if (path) {
        try {
          m = parseSessionFile(path, r.sessionId).meta;
        } catch {
          /* no transcript */
        }
      }
      const ended = m ? m.ended : true;
      const lastTs = Math.max(m?.lastTs ?? 0, r.updatedAt, r.startedAt);
      const bg = r.kind === "bg";
      const bgShells = m?.bgShells ?? 0;
      return {
        sessionId: r.sessionId,
        path: path ?? "",
        title: m?.title || m?.lastPrompt || "", // empty → renderer shows ~folder
        activity: m?.activity ?? "",
        activityKind: m?.activityKind ?? "",
        cwd: r.cwd || m?.cwd || "",
        gitBranch: m?.gitBranch ?? "",
        lastTs,
        working: r.status === "busy",
        live: true,
        ended,
        state: stateOf(r.status, ended, bg),
        regStatus: r.status,
        model: m?.model ?? "",
        ctxTokens: m?.ctxTokens ?? 0,
        thinking: m?.thinking ?? false,
        bg,
        bgShells,
        pid: r.pid,
      };
    })
    .sort((a, b) => b.lastTs - a.lastTs);

  // Recent, substantial, NON-running sessions (history) — so a restarted
  // instance still shows its earlier sessions instead of resetting to one.
  // Marked `live:false` + state "stale"; the renderer greys them out.
  const runningIds = new Set(liveSessions.map((s) => s.sessionId));
  const historyStart = now - HISTORY_MS;
  const history: SessionSummary[] = HISTORY_MS <= 0 ? [] : candidates
    .filter((m) =>
      isUserSession(m) && (m.turns >= 2 || m.tools >= 1) &&
      m.lastTs >= historyStart && !runningIds.has(m.sessionId) && !dismissed.has(m.sessionId))
    .sort((a, b) => b.lastTs - a.lastTs)
    .slice(0, 24)
    .map((m) => ({
      sessionId: m.sessionId,
      path: m.path,
      title: m.title || m.lastPrompt || "",
      activity: m.activity,
      activityKind: m.activityKind,
      cwd: m.cwd,
      gitBranch: m.gitBranch,
      lastTs: m.lastTs,
      working: false,
      live: false,
      ended: m.ended,
      state: "stale" as const,
      regStatus: "",
      model: m.model,
      ctxTokens: m.ctxTokens,
      thinking: m.thinking,
      bg: false,
      bgShells: 0,
      pid: 0,
    }));

  const sessions: SessionSummary[] = [...liveSessions, ...history].sort((a, b) => b.lastTs - a.lastTs);

  const { block5h, today, week } = bucketEntries(allEntries, now);

  const isRunningNow = isRunning || liveSessions.length > 0;
  let status: Status;
  if (sessions.some((s) => s.working)) status = "WORKING";
  else if (sessions.length) status = "LIVE";
  else if (isRunning) status = "IDLE";
  else status = "OFFLINE";

  const ts = allEntries.map((e) => e.ts);
  const reset5h = blockResetAt(ts, 5 * 3_600_000, now);
  const resetWk = blockResetAt(ts, 7 * 24 * 3_600_000, now);

  return { def, account, status, running: isRunningNow, sessions, block5h, today, week, reset5h, resetWk };
}

export function collectAll(instances: InstanceDef[], now = Date.now()): InstanceState[] {
  const running = getRunningConfigDirs();
  return instances.map((def) => collectInstance(def, now, running));
}

/** Read the first `bytes` of a file (transcripts start with a cwd-bearing line). */
function readHead(path: string, bytes = 65536): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.toString("utf8", 0, n);
  } finally {
    closeSync(fd);
  }
}

/** The launch cwd of a transcript: first JSON line carrying a `cwd` field. */
function firstCwd(path: string): string {
  try {
    let scanned = 0;
    for (const line of readHead(path).split("\n")) {
      if (!line) continue;
      const o = safeJson<any>(line);
      if (o?.cwd) return o.cwd;
      if (++scanned > 50) break;
    }
  } catch {
    /* unreadable */
  }
  return "";
}

export interface FolderHist {
  cwd: string;
  lastTs: number;
}

const folderCache = new Map<string, { mtimeMs: number; folders: FolderHist[] }>();

/**
 * Every working folder this instance has ever had a session in — read from the
 * full `projects/` history (not just the recent window), recency-sorted. Only
 * each project's newest transcript head is read (for its cwd), and the result is
 * cached against the projects-dir mtime so repeated frames are cheap.
 */
export function instanceFolders(configDir: string): FolderHist[] {
  const projectsDir = join(configDir, "projects");
  let dmt = 0;
  try {
    dmt = statSync(projectsDir).mtimeMs;
  } catch {
    return [];
  }
  const hit = folderCache.get(configDir);
  if (hit && hit.mtimeMs === dmt) return hit.folders;

  const byCwd = new Map<string, number>();
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(projectsDir);
  } catch {
    return [];
  }
  for (const pd of projectDirs) {
    const full = join(projectsDir, pd);
    let newest: { p: string; mt: number } | null = null;
    try {
      if (!statSync(full).isDirectory()) continue;
      for (const n of readdirSync(full)) {
        if (!n.endsWith(".jsonl")) continue;
        const p = join(full, n);
        const mt = statSync(p).mtimeMs;
        if (!newest || mt > newest.mt) newest = { p, mt };
      }
    } catch {
      continue;
    }
    if (!newest) continue;
    const cwd = firstCwd(newest.p);
    if (cwd && /observer-sessions|\.claude-mem/.test(cwd) === false) {
      byCwd.set(cwd, Math.max(byCwd.get(cwd) ?? 0, newest.mt));
    }
  }
  const folders = [...byCwd.entries()]
    .map(([cwd, lastTs]) => ({ cwd, lastTs }))
    .sort((a, b) => b.lastTs - a.lastTs);
  folderCache.set(configDir, { mtimeMs: dmt, folders });
  return folders;
}

export interface FolderUsage {
  cwd: string;
  lastTs: number;
  users: { key: string; lastTs: number }[]; // instances that ran here, newest first
}

/** All folders across all instances, each with the instances that used it. */
export function allFolders(instances: InstanceDef[]): FolderUsage[] {
  const map = new Map<string, { lastTs: number; users: Map<string, number> }>();
  for (const def of instances) {
    for (const f of instanceFolders(def.configDir)) {
      let e = map.get(f.cwd);
      if (!e) {
        e = { lastTs: 0, users: new Map() };
        map.set(f.cwd, e);
      }
      e.lastTs = Math.max(e.lastTs, f.lastTs);
      e.users.set(def.key, Math.max(e.users.get(def.key) ?? 0, f.lastTs));
    }
  }
  return [...map.entries()]
    .map(([cwd, e]) => ({
      cwd,
      lastTs: e.lastTs,
      users: [...e.users.entries()]
        .map(([key, lastTs]) => ({ key, lastTs }))
        .sort((a, b) => b.lastTs - a.lastTs),
    }))
    .sort((a, b) => b.lastTs - a.lastTs);
}

export interface TLine {
  role: "user" | "assistant" | "tool" | "result";
  text: string;
}

const transcriptCache = new Map<string, { mtimeMs: number; size: number; lines: TLine[] }>();

const ROLE_CAP: Record<TLine["role"], number> = { user: 4000, assistant: 4000, tool: 300, result: 300 };

/** Parse a session .jsonl into a readable transcript (recent segments only). */
export function readTranscript(path: string, maxSegments = 800): TLine[] {
  let st;
  try {
    st = statSync(path);
  } catch {
    return [];
  }
  const hit = transcriptCache.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.lines;

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }

  const out: TLine[] = [];
  const push = (role: TLine["role"], text: string) => {
    // Preserve newlines for prose roles so the markdown renderer can see tables,
    // lists and paragraphs; collapse hard for the noisy tool/result roles.
    const t =
      role === "assistant" || role === "user"
        ? text.replace(/\t/g, "  ").replace(/[  ]+/g, " ").replace(/ *\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim()
        : text.replace(/\s+/g, " ").trim();
    if (t) out.push({ role, text: t.length > ROLE_CAP[role] ? t.slice(0, ROLE_CAP[role]) + "…" : t });
  };

  for (const line of text.split("\n")) {
    if (!line) continue;
    const o = safeJson<any>(line);
    if (!o || o.isMeta) continue;
    const m = o.message;
    if (o.type === "user" && m) {
      const c = m.content;
      if (typeof c === "string") {
        if (/<system-reminder>|<local-command|<command-(name|message|args|stdout)|^PREVIOUS AI RESPONSE/.test(c)) continue;
        push("user", c);
      } else if (Array.isArray(c)) {
        for (const p of c) {
          if (p?.type === "tool_result") {
            const t = typeof p.content === "string"
              ? p.content
              : Array.isArray(p.content) ? p.content.map((x: any) => x?.text || "").join(" ") : "";
            push("result", t);
          }
        }
      }
    } else if (o.type === "assistant" && m && Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p?.type === "text") push("assistant", p.text || "");
        else if (p?.type === "tool_use" && p.name) {
          const a = p.input?.command ?? p.input?.file_path ?? p.input?.path ?? p.input?.pattern ?? p.input?.description ?? "";
          push("tool", a ? `${p.name}: ${a}` : p.name);
        }
      }
    }
  }

  const tail = out.slice(-maxSegments);
  transcriptCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, lines: tail });
  return tail;
}
