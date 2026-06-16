/**
 * Remote-control fleet: a thin supervisor over `claude remote-control` servers
 * plus a RAM governor. The servers are a research preview, so we couple only to
 * the documented CLI flags (`--spawn`, `--capacity`, `--permission-mode`,
 * `--name`) and otherwise just OBSERVE the OS (see the helpers in collect.ts).
 *
 * Servers run inside detached tmux sessions so they survive the Mac client (and
 * the laptop lid) closing — exactly the "Deckel zu → Session tot" fix. One server
 * per (account × project); each accepts many concurrent sessions on demand and
 * serves both the Mac TUI and the Claude mobile app.
 */
import type { InstanceDef } from "./instances.ts";
import type { Host } from "./hosts.ts";
import { isLocal } from "./hosts.ts";
import { runOn, shellQuote } from "./ssh.ts";
import {
  findRcServers, psSnapshot, descendants, sumMemoryKb, liveSessions, type RegEntry,
} from "./collect.ts";

const TMUX_PREFIX = "cplex-rc-";

/** Stable, collision-resistant tmux session name for an (account, project). */
export function tmuxName(instanceKey: string, cwd: string): string {
  const slug = cwd.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(-40);
  return `${TMUX_PREFIX}${instanceKey}-${slug}`;
}

/** Names of all tmux sessions we manage on a host (prefix-scoped). */
export async function managedTmux(host: Host): Promise<string[]> {
  const r = await runOn(host, `tmux list-sessions -F '#{session_name}' 2>/dev/null`);
  if (!r.ok) return [];
  return r.out.split("\n").map((s) => s.trim()).filter((s) => s.startsWith(TMUX_PREFIX));
}

export interface RcLaunchOpts {
  spawn?: "same-dir" | "worktree" | "session";
  capacity?: number;
  permissionMode?: string; // acceptEdits | auto | bypassPermissions | default | dontAsk | plan
  name?: string;
  key?: string; // instance key for the tmux session name (default "default")
  configDir?: string; // account data dir; omit (or isDefault) ⇒ default account
  isDefault?: boolean; // default account ⇒ spawn with CLAUDE_CONFIG_DIR unset
}

export interface RcLaunchResult {
  tmux: string;
  ok: boolean;
  reused?: boolean;
  error?: string;
}

/**
 * Launch (or reuse) a remote-control server in a project dir ON A HOST (local or
 * remote). The command runs through `env` to scrub the API key / nesting markers
 * and pin the login; the default account spawns with CLAUDE_CONFIG_DIR UNSET (it
 * lives at ~/.claude.json). On a remote host the whole `tmux new-session …` runs
 * over ssh, so the server persists there independently of the client. Everything
 * is shell-quoted because both paths go through a shell (see ssh.runOn). Worktree
 * mode needs a git repo + an accepted trust dialog for that account.
 */
export async function launchRcServer(host: Host, cwd: string, opts: RcLaunchOpts = {}): Promise<RcLaunchResult> {
  const name = tmuxName(opts.key ?? "default", cwd);
  if (await hasSession(host, name)) return { tmux: name, ok: true, reused: true };

  const claude = ["claude", "remote-control", "--spawn", opts.spawn ?? "worktree", "--capacity", String(opts.capacity ?? 32)];
  if (opts.permissionMode) claude.push("--permission-mode", opts.permissionMode);
  if (opts.name) claude.push("--name", shellQuote(opts.name));

  const env = ["env", "-u", "ANTHROPIC_API_KEY", "-u", "CLAUDECODE", "-u", "CLAUDE_CODE_ENTRYPOINT"];
  if (opts.isDefault || !opts.configDir) env.push("-u", "CLAUDE_CONFIG_DIR");
  else env.push(`CLAUDE_CONFIG_DIR=${shellQuote(opts.configDir)}`);

  const cmd = `tmux new-session -d -s ${shellQuote(name)} -c ${shellQuote(cwd)} ${env.join(" ")} ${claude.join(" ")}`;
  const r = await runOn(host, cmd);
  return r.ok ? { tmux: name, ok: true } : { tmux: name, ok: false, error: (r.err || r.out).trim() || "tmux launch failed" };
}

async function hasSession(host: Host, name: string): Promise<boolean> {
  return (await runOn(host, `tmux has-session -t ${shellQuote(name)} 2>/dev/null`)).ok;
}

/** Stop a server (kills its tmux session, ending the claude server cleanly). */
export async function stopRcServer(host: Host, key: string, cwd: string): Promise<boolean> {
  return (await runOn(host, `tmux kill-session -t ${shellQuote(tmuxName(key, cwd))}`)).ok;
}

/** Stop a server by its exact tmux session name. */
export async function stopRcServerByName(host: Host, name: string): Promise<boolean> {
  return (await runOn(host, `tmux kill-session -t ${shellQuote(name)}`)).ok;
}

/** Restart: stop then relaunch (picks up new plugins / MCP / flags). */
export async function restartRcServer(host: Host, cwd: string, opts: RcLaunchOpts = {}): Promise<RcLaunchResult> {
  await stopRcServer(host, opts.key ?? "default", cwd);
  return launchRcServer(host, cwd, opts);
}

/**
 * The remote-control fleet + governor on a REMOTE host, via `ssh host claudeplex
 * --json`. Returns null if claudeplex isn't installed there or ssh fails (the
 * caller shows a hint). The local host uses remoteSnapshot() directly.
 */
export async function fetchRemoteFleet(host: Host): Promise<RemoteSnapshot | null> {
  if (isLocal(host)) return null;
  const r = await runOn(host, "claudeplex --json");
  if (!r.ok) return null;
  try {
    return (JSON.parse(r.out).remote as RemoteSnapshot) ?? null;
  } catch {
    return null;
  }
}

/* ── RAM governor ─────────────────────────────────────────────────────────── */

const KB_PER_MB = 1024;
/**
 * Calibrated on devhost (claude 2.1.177, default Max-20x account, --spawn=worktree):
 *   server overhead ≈ 142 MB · active session ≈ 330 MB (of which ~106 MB / ~32%
 *   is per-session MCP servers: aiui, python, bun) · idle (server + 1 session) ≈ 474 MB.
 * At a 16 GB ceiling that's ~40–46 concurrent sessions. These feed the headroom
 * estimate; override per host via env.
 */
export const sessionMb = (): number => Number(process.env.CD_RC_SESSION_MB ?? 330);
export const serverMb = (): number => Number(process.env.CD_RC_SERVER_MB ?? 142);
/** Global ceiling (MB). Default 16 GB — devhost is upgradable; calibrated via E. */
export const ramCeilingMb = (): number => Number(process.env.CD_RC_RAM_CEILING_MB ?? 16384);
/** Warn at this fraction of the ceiling. */
export const ramWarnFrac = (): number => {
  const f = Number(process.env.CD_RC_RAM_WARN ?? 0.8);
  return f > 0 && f <= 1 ? f : 0.8;
};
/** Live reaping is opt-in (observe + warn by default — the preview is fragile). */
export const governEnabled = (): boolean => process.env.CD_RC_GOVERN === "1";

export interface RcSessionView {
  sessionId: string;
  cwd: string;
  status: string;
  kind: string;
  name: string;
  pid: number;
  idleMs: number;
}

export interface RcServerView {
  pid: number;
  instanceKey: string;
  configDir: string;
  cwd: string;
  spawn: string;
  capacity: number;
  permissionMode: string;
  tmux: string | null;
  memMb: number; // PSS of the server + all its descendants
  sessions: RcSessionView[];
}

export interface GovernorView {
  ceilingMb: number;
  warnMb: number;
  usedMb: number;
  headroomMb: number;
  sessionMb: number; // calibrated per-session estimate
  roomForSessions: number; // how many more sessions fit under the warn line
  overWarn: boolean;
  overCeiling: boolean;
  governing: boolean;
}

export interface RemoteSnapshot {
  servers: RcServerView[];
  governor: GovernorView;
}

/** A reap action the governor would take to get back under the warn threshold. */
export interface ReapAction {
  kind: "session" | "server";
  pid: number;
  reason: string;
  instanceKey: string;
  cwd: string;
}

/**
 * Observe the whole fleet: every running server, its hosted sessions (registry
 * entries whose process is a descendant of the server), accurate per-server PSS,
 * and the global governor totals. Pure observation — never mutates anything.
 */
export function remoteSnapshot(instances: InstanceDef[], now = Date.now()): RemoteSnapshot {
  const procs = psSnapshot();
  const keyByDir = new Map(instances.map((d) => [d.configDir, d.key] as const));
  // local managed tmux sessions (sync — remoteSnapshot is the local snapshot)
  let tmuxNames = new Set<string>();
  try {
    const out = Bun.spawnSync(["tmux", "list-sessions", "-F", "#{session_name}"]).stdout.toString();
    tmuxNames = new Set(out.split("\n").map((s) => s.trim()).filter((s) => s.startsWith(TMUX_PREFIX)));
  } catch {
    /* no tmux */
  }
  const servers: RcServerView[] = [];
  const counted = new Set<number>();

  for (const s of findRcServers()) {
    const tree = descendants(s.pid, procs);
    for (const p of tree) counted.add(p);
    const instanceKey = keyByDir.get(s.configDir) ?? "";
    const treeSet = new Set(tree);
    const sessions: RcSessionView[] = liveSessions(s.configDir)
      .filter((e: RegEntry) => treeSet.has(e.pid) || (e.cwd && e.cwd.startsWith(s.cwd)))
      .map((e) => ({
        sessionId: e.sessionId, cwd: e.cwd, status: e.status, kind: e.kind,
        name: e.name, pid: e.pid, idleMs: Math.max(0, now - (e.updatedAt || 0)),
      }));
    const tname = tmuxName(instanceKey || s.configDir.split("/").pop() || "", s.cwd);
    servers.push({
      pid: s.pid, instanceKey, configDir: s.configDir, cwd: s.cwd, spawn: s.spawn,
      capacity: s.capacity, permissionMode: s.permissionMode,
      tmux: tmuxNames.has(tname) ? tname : null,
      memMb: Math.round(sumMemoryKb(tree, procs) / KB_PER_MB),
      sessions,
    });
  }

  const usedMb = Math.round(sumMemoryKb([...counted], procs) / KB_PER_MB);
  const ceilingMb = ramCeilingMb();
  const warnMb = Math.round(ceilingMb * ramWarnFrac());
  const sMb = sessionMb();
  return {
    servers,
    governor: {
      ceilingMb, warnMb, usedMb, headroomMb: ceilingMb - usedMb,
      sessionMb: sMb, roomForSessions: Math.max(0, Math.floor((warnMb - usedMb) / sMb)),
      overWarn: usedMb >= warnMb, overCeiling: usedMb >= ceilingMb, governing: governEnabled(),
    },
  };
}

/**
 * Plan which sessions/servers to reap to get back under the warn threshold:
 * the most-idle hosted sessions first (never the pre-created in-cwd one), then
 * empty servers. Returns an ordered list; caller decides whether to enforce.
 */
export function planReap(snap: RemoteSnapshot): ReapAction[] {
  const actions: ReapAction[] = [];
  if (!snap.governor.overWarn) return actions;
  // candidate idle sessions across all servers, most-idle first
  const cands = snap.servers.flatMap((srv) =>
    srv.sessions
      .filter((s) => s.pid && s.status !== "busy" && !(s.cwd && s.cwd === srv.cwd)) // keep the in-cwd session
      .map((s) => ({ srv, s })),
  ).sort((a, b) => b.s.idleMs - a.s.idleMs);
  for (const { srv, s } of cands) {
    actions.push({
      kind: "session", pid: s.pid, instanceKey: srv.instanceKey, cwd: srv.cwd,
      reason: `idle ${Math.round(s.idleMs / 1000)}s`,
    });
  }
  // servers hosting no live sessions are pure overhead when over budget
  for (const srv of snap.servers) {
    if (!srv.sessions.length) {
      actions.push({ kind: "server", pid: srv.pid, instanceKey: srv.instanceKey, cwd: srv.cwd, reason: "no live sessions" });
    }
  }
  return actions;
}

/**
 * Enforce a reap plan (only when CD_RC_GOVERN=1). Stops just enough — idle
 * sessions, then empty servers — to drop below the warn threshold. Returns the
 * actions actually taken. SIGTERM (not KILL) so sessions checkpoint cleanly.
 */
export function enforceGovernor(instances: InstanceDef[]): ReapAction[] {
  if (!governEnabled()) return [];
  const taken: ReapAction[] = [];
  let snap = remoteSnapshot(instances);
  for (const action of planReap(snap)) {
    if (!snap.governor.overWarn) break;
    // local enforcement: SIGTERM the pid (server or session) so it checkpoints;
    // for a server this also collapses its now-idle tmux session.
    try { process.kill(action.pid, "SIGTERM"); } catch { /* already gone */ }
    taken.push(action);
    snap = remoteSnapshot(instances); // re-measure after each reap
  }
  return taken;
}
