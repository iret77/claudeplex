#!/usr/bin/env bun
import { collectAll, dismissSession, instanceFolders, type InstanceState } from "./collect.ts";
import {
  render, recentCwds, waitingSessions, closeableSessions, cockpitTabs,
  wizardFolders, wizardOrderedInstances, issueRepos, emptyPane,
  type UIState, type PaneItem, type CmdPane,
} from "./render.ts";
import { updateStates, type Transition, type SessState } from "./tracker.ts";
import { AgentRegistry } from "./agents.ts";
import { BUDGET_5H, BUDGET_WEEK, type InstanceDef } from "./instances.ts";
import { discoverInstances } from "./discover.ts";
import { dirSuggestions, expandTilde, isDir } from "./paths.ts";
import { readClipboardImage } from "./clipboard.ts";
import { loadLocale, toggleLocale, t, stateLabel } from "./i18n.ts";
import { loadTheme, previewTheme, setTheme, themeIndex, getTheme, THEMES } from "./theme.ts";
import { remoteSnapshot, launchRcServer, stopRcServer, fetchRemoteFleet, tmuxName } from "./remote.ts";
import { discoverHosts, isLocal, sshTarget, type Host } from "./hosts.ts";
import { tfg, ICONS, RESET } from "./ui.ts";
import { listDir, resolveHome, pathJoin, shellOutArgv, copyEntry } from "./ssh.ts";
import { pickFreeInstance, draftIssue, createIssue, splitDraft, isError } from "./issue.ts";
import { listPRs, analyzePR, reviewPR, mergePR, isPrError, type ReviewEvent } from "./pr.ts";

/** Put the host terminal window into native macOS fullscreen (best-effort). */
function enterFullscreen(): void {
  if (process.env.CD_NO_FULLSCREEN || !process.stdout.isTTY) return;
  const script =
    'tell application "System Events" to tell (first process whose frontmost is true) ' +
    'to set value of attribute "AXFullScreen" of front window to true';
  try {
    Bun.spawn(["osascript", "-e", script], { stdout: "ignore", stderr: "ignore" });
  } catch {
    /* osascript / accessibility unavailable — ignore */
  }
}

/** Opt-in macOS notification when sessions finish a turn (aktiv → wartet). */
function notifyTransitions(trans: Transition[]): void {
  if (!process.env.CD_NOTIFY) return;
  const waiting = trans.filter((t) => t.to === "wartet");
  if (!waiting.length) return;
  const esc = (s: string) =>
    '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ").slice(0, 180) + '"';
  let title: string;
  let body: string;
  if (waiting.length === 1) {
    title = `${waiting[0].instance} · ${stateLabel("wartet")}`;
    body = waiting[0].title;
  } else {
    title = `${waiting.length} ${t("sessionsWaiting")}`;
    body = waiting.map((t) => t.title).slice(0, 4).join(" · ");
  }
  try {
    Bun.spawn(["osascript", "-e", `display notification ${esc(body)} with title ${esc(title)}`], {
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    /* osascript unavailable — ignore */
  }
}

const FRAME_MS = 120; // animation cadence
const REFRESH_MS = 1000; // data re-collection cadence

const args = new Set(process.argv.slice(2));

function termWidth(): number {
  return process.stdout.columns || Number(process.env.COLUMNS) || 100;
}

async function runJson(): Promise<void> {
  const instances = discoverInstances();
  const states = collectAll(instances);
  const remote = remoteSnapshot(instances);
  // strip noisy fields, keep the useful summary
  const accounts = states.map((s) => ({
    key: s.def.key,
    label: s.def.label,
    account: s.account,
    status: s.status,
    running: s.running,
    sessions: s.sessions.map((ss) => ({
      title: ss.title,
      cwd: ss.cwd,
      gitBranch: ss.gitBranch,
      activity: ss.activity,
      working: ss.working,
      lastActivity: new Date(ss.lastTs).toISOString(),
    })),
    usage5h: { workTokens: s.block5h.work, messages: s.block5h.messages, cost: s.block5h.cost },
    usageToday: { workTokens: s.today.work, messages: s.today.messages, cost: s.today.cost },
    usageWeek: { workTokens: s.week.work, messages: s.week.messages, cost: s.week.cost },
  }));
  // Multi-host clients consume this over `ssh <host> claudeplex --json`.
  process.stdout.write(JSON.stringify({ accounts, remote }, null, 2) + "\n");
}

function runOnce(): void {
  const now = Date.now();
  const states = collectAll(discoverInstances(), now);
  process.stdout.write(render(states, 0, now, termWidth(), undefined, process.stdout.rows || 40).join("\n") + "\n");
}

function runLoop(): void {
  let frame = 0;
  const instances = discoverInstances(); // resolved once at startup
  let states: InstanceState[] = collectAll(instances);
  let lastRefresh = Date.now();
  updateStates(states, lastRefresh); // baseline — no flashes on startup
  const ui: UIState = {
    sel: 0, expanded: false, sessSel: 0, transcript: false, scroll: 0,
    cockpit: false, focus: "", input: "", cockpitArea: "input", listSel: 0, pendingImages: [],
    picker: "", pickerInput: "", pickerSel: 0, pickerInstance: "", pickerPane: "instance", pickerInstSel: 0,
    pickerMode: "instance", gridRegion: "cards", collapsed: { cards: false, live: false, questions: false }, closeArm: "", renaming: "",
    themePicker: false, themeSel: 0,
    commander: false, cmdHosts: [], cmdActive: 0,
    cmdPanes: [emptyPane(), emptyPane()], cmdRemote: null, cmdFeedback: "", fromCommander: false,
    issueStage: "pick", issuePane: "folder", issueFolderSel: 0, issueInput: "", issueFeedback: "",
    issueDraft: "", issueScroll: 0, issueRepo: "", issueInstance: "", issueUrl: "", issueError: "",
    prStage: "pick", prPane: "repo", prRepoSel: 0, prPrSel: 0, prList: [], prRepoCwd: "",
    prInstance: "", prAnalysis: null, prPendingAction: null, prActionInput: "", prResult: "",
    prError: "", prScroll: 0, prStart: 0, prToken: 0,
  };
  const registry = new AgentRegistry();
  let issueToken = 0; // bumped on each draft/create/open to ignore stale async results
  let themeOrig = ""; // theme name to restore if the picker is cancelled


  /** Default cwd for a new agent: the instance's most recent session, else $HOME. */
  const cwdFor = (def: InstanceDef): string => {
    const st = states.find((s) => s.def.key === def.key);
    return st?.sessions[0]?.cwd || process.env.HOME || ".";
  };

  /**
   * Enter a session: reuse the existing agent for it if one is already running
   * (avoids spawning a duplicate fork on every Enter), otherwise adopt it via
   * resume-fork. Returns the launch id.
   */
  const enterSession = (def: InstanceDef, sessionId: string, cwd: string, _pid = 0): string => {
    const existing = registry.forSession(sessionId);
    if (existing) return existing.launchId; // already in the cockpit → reuse, no new agent
    // CONTINUE the session in place: resume its EXACT id (no fork, no kill). The
    // id is preserved, so the dashboard agent and the native CLI share it. We do
    // NOT SIGTERM the original — killing it disrupts the user's terminal and can
    // trigger a respawn (two processes on one session = the handover problem).
    const safeCwd = isDir(cwd) ? cwd : (process.env.HOME || ".");
    return registry.resume(def, sessionId, safeCwd).launchId;
  };

  /** Open the working-folder picker for a fresh agent on this instance. */
  const openPicker = (def: InstanceDef): void => {
    ui.picker = "cwd";
    ui.pickerInstance = def.key;
    ui.pickerInput = cwdFor(def);
    ui.pickerSel = 0;
  };

  /** Point the wizard's folder pane at the currently-highlighted instance. */
  const syncWizardInstance = (): void => {
    const def = states[Math.min(ui.pickerInstSel, states.length - 1)]?.def;
    if (!def) return;
    ui.pickerInstance = def.key;
    ui.pickerInput = cwdFor(def);
    ui.pickerSel = 0;
  };

  /** Open the new-agent wizard: centered popup, instance→folder by default. */
  const openWizard = (): void => {
    ui.picker = "wizard";
    ui.pickerMode = "instance";
    ui.pickerPane = "instance";
    ui.pickerInstSel = ui.sel; // start on the currently-selected instance
    ui.pickerSel = 0;
    syncWizardInstance();
  };

  /** Open the quick-issue modal: pick a repo + describe, then draft on a free instance. */
  const openIssue = (): void => {
    issueToken++; // invalidate any in-flight draft/create from a previous run
    ui.picker = "issue";
    ui.issueStage = "pick";
    ui.issuePane = "folder";
    ui.issueFolderSel = 0;
    ui.issueInput = "";
    ui.issueFeedback = "";
    ui.issueDraft = "";
    ui.issueUrl = "";
    ui.issueError = "";
    ui.issueScroll = 0;
  };

  /** Draft (or redraft) the issue on the freest idle instance; async → review/error. */
  const startDraft = (cwd: string, description: string, prior?: { draft: string; feedback: string }): void => {
    const inst = pickFreeInstance(states, registry);
    if (!inst) {
      ui.issueStage = "error";
      ui.issueError = t("noInstances");
      return;
    }
    ui.issueRepo = cwd;
    ui.issueInstance = inst.def.key;
    ui.issueStage = "drafting";
    ui.issueScroll = 0;
    const token = ++issueToken;
    void draftIssue(inst.def, cwd, description, prior).then((r) => {
      if (token !== issueToken || ui.picker !== "issue") return; // superseded or closed
      if (isError(r)) {
        ui.issueStage = "error";
        ui.issueError = r.error;
      } else {
        ui.issueDraft = r.raw;
        ui.issueStage = "review";
        ui.issueScroll = 0;
      }
    });
  };

  /** Create the reviewed issue via gh (deterministic, post-confirmation); async → done/error. */
  const startCreate = (): void => {
    const { title, body } = splitDraft(ui.issueDraft);
    if (!title) {
      ui.issueStage = "error";
      ui.issueError = "draft had no title line";
      return;
    }
    ui.issueStage = "creating";
    const token = ++issueToken;
    void createIssue(ui.issueRepo, title, body).then((r) => {
      if (token !== issueToken || ui.picker !== "issue") return;
      if (isError(r)) {
        ui.issueStage = "error";
        ui.issueError = r.error;
      } else {
        ui.issueUrl = r.url;
        ui.issueStage = "done";
      }
    });
  };

  // ── PR-review (picker === "pr") — structural twin of the quick-issue flow ──

  /** Load a repo's open PRs into the right pane (lazy, on repo change). */
  const loadPrList = async (cwd: string): Promise<void> => {
    const token = ++ui.prToken;
    ui.prRepoCwd = cwd;
    ui.prList = [];
    ui.prPrSel = 0;
    ui.prError = "";
    ui.prStage = "pick";
    const res = await listPRs(cwd);
    if (token !== ui.prToken || ui.picker !== "pr") return; // superseded or closed
    if (isPrError(res)) {
      ui.prStage = "error";
      ui.prError = res.error;
    } else {
      ui.prList = res;
      ui.prPrSel = 0;
    }
    draw();
  };

  /** Open the PR-review modal: pick a repo, load its open PRs, then analyze one. */
  const openPr = (): void => {
    ui.prToken++; // invalidate any in-flight load/analyze
    ui.picker = "pr";
    ui.prStage = "pick";
    ui.prPane = "repo";
    ui.prRepoSel = 0;
    ui.prPrSel = 0;
    ui.prList = [];
    ui.prAnalysis = null;
    ui.prResult = "";
    ui.prError = "";
    ui.prScroll = 0;
    const repos = issueRepos(states);
    if (repos[0]) void loadPrList(repos[0].cwd);
  };

  /** Analyze the selected PR on the freest idle instance; async → review/error. */
  const startAnalyze = (): void => {
    const pr = ui.prList[Math.min(ui.prPrSel, Math.max(0, ui.prList.length - 1))];
    if (!pr) return;
    const inst = pickFreeInstance(states, registry);
    if (!inst) {
      ui.prStage = "error";
      ui.prError = t("noInstances");
      return;
    }
    ui.prInstance = inst.def.key;
    ui.prStage = "analyzing";
    ui.prScroll = 0;
    ui.prStart = Date.now(); // headless one-shot → elapsed timer, no live stream
    const token = ++ui.prToken;
    void analyzePR(inst.def, ui.prRepoCwd, pr).then((r) => {
      if (token !== ui.prToken || ui.picker !== "pr") return;
      if (isPrError(r)) {
        ui.prStage = "error";
        ui.prError = r.error;
      } else {
        ui.prAnalysis = r;
        ui.prStage = "review";
        ui.prScroll = 0;
      }
      draw();
    });
  };

  /** Post a PR review (approve/comment/request-changes) via gh; async → done/error. */
  const runReview = (event: ReviewEvent, body?: string): void => {
    const a = ui.prAnalysis;
    if (!a) return;
    ui.prStage = "commenting";
    ui.prStart = Date.now();
    const token = ++ui.prToken;
    void reviewPR(ui.prRepoCwd, a.pr.number, event, body).then((r) => {
      if (token !== ui.prToken || ui.picker !== "pr") return;
      if (isPrError(r)) {
        ui.prStage = "error";
        ui.prError = r.error;
      } else {
        ui.prResult = t("prReviewed");
        ui.prStage = "done";
      }
      draw();
    });
  };

  /** Merge the reviewed PR via gh (squash, post-confirmation); async → done/error. */
  const runMerge = (): void => {
    const a = ui.prAnalysis;
    if (!a) return;
    ui.prStage = "merging";
    ui.prStart = Date.now();
    const token = ++ui.prToken;
    void mergePR(ui.prRepoCwd, a.pr.number, "squash").then((r) => {
      if (token !== ui.prToken || ui.picker !== "pr") return;
      if (isPrError(r)) {
        ui.prStage = "error";
        ui.prError = r.error;
      } else {
        ui.prResult = t("prMerged");
        ui.prStage = "done";
      }
      draw();
    });
  };

  /**
   * Launch a session to keep working on the PR: spawn an agent in the repo on the
   * analyzing instance and pre-fill the cockpit input with a kickoff prompt (the
   * user presses ⏎ to send — a built-in review step before the agent runs).
   */
  const startPrSession = (): void => {
    const a = ui.prAnalysis;
    if (!a) return;
    const inst = states.find((s) => s.def.key === ui.prInstance) ?? pickFreeInstance(states, registry);
    if (!inst) {
      ui.prStage = "error";
      ui.prError = t("noInstances");
      return;
    }
    const cwd = isDir(ui.prRepoCwd) ? ui.prRepoCwd : (process.env.HOME || ".");
    const seed = [
      `Bitte bearbeite GitHub PR #${a.pr.number} ("${a.pr.title}") in diesem Repo weiter.`,
      `Checke ihn aus: \`gh pr checkout ${a.pr.number}\`.`,
      a.summary ? `Review-Zusammenfassung: ${a.summary}` : "",
      ...(a.findings.length
        ? ["Findings:", ...a.findings.map((f) => `- [${f.category}/${f.severity}] ${f.title}${f.location ? ` (${f.location})` : ""}: ${f.detail}`)]
        : []),
    ].filter(Boolean).join("\n");
    ui.focus = `a:${registry.launch(inst.def, cwd).launchId}`;
    ui.input = seed; // pre-filled kickoff — ⏎ sends
    ui.picker = "";
    ui.cockpit = true;
    ui.cockpitArea = "input";
  };

  // ── Commander (multi-host, mc/nc) — the whole app is the commander ──
  const cmdTokens = [0, 0]; // per-pane stale-async guards
  const baseName = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;
  const sizeStr = (n: number) =>
    n < 1024 ? `${n}B` : n < 1048576 ? `${Math.round(n / 1024)}K` : `${(n / 1048576).toFixed(1)}M`;
  const dirParent = (p: string) => { const i = p.replace(/\/+$/, "").lastIndexOf("/"); return i <= 0 ? "/" : p.slice(0, i); };
  /** Longest common directory prefix (by path segment) of a set of paths. */
  const commonRoot = (paths: string[]): string => {
    if (!paths.length) return "/";
    const segs = paths.map((p) => p.replace(/\/+$/, "").split("/"));
    let n = segs[0].length;
    for (const s of segs) { let i = 0; while (i < n && i < s.length && s[i] === segs[0][i]) i++; n = i; }
    return segs[0].slice(0, n).join("/") || "/";
  };

  const cmdHostOf = (p: { host: string }): Host | undefined => ui.cmdHosts.find((h) => h.name === p.host);
  const cmdSel = (p: CmdPane): PaneItem | undefined => p.items[Math.min(Math.max(0, p.sel), p.items.length - 1)];
  /** rc-server tmux key for a host: local picks the selected account, else "default". */
  const rcKey = (host: Host): string =>
    (isLocal(host) ? (instances[ui.sel] ?? instances[0])?.key : undefined) ?? "default";

  /** Refresh the active pane's host fleet/governor (local live, remote via ssh --json). */
  const refreshFleet = (host: Host | undefined): void => {
    if (!host) { ui.cmdRemote = null; return; }
    if (isLocal(host)) { ui.cmdRemote = remoteSnapshot(instances); return; }
    void fetchRemoteFleet(host).then((snap) => {
      if (ui.commander && cmdHostOf(ui.cmdPanes[ui.cmdActive])?.name === host.name) { ui.cmdRemote = snap; draw(); }
    });
  };

  const UP_ITEM: PaneItem = { kind: "up", label: ".." };

  // ── Conductor: the Host▸Project▸Session agent tree (left pane) ──
  const treeExpanded = new Set<string>(); // expanded node ids, persists across rebuilds
  let treeInit = false;
  const modelShort = (m: string) => m.match(/(opus|sonnet|haiku|fable)/i)?.[1]?.toLowerCase() ?? "";
  const ctxPct = (ctx: number, m: string) => (ctx > 0 ? Math.round((ctx / (/opus|sonnet/i.test(m) ? 1e6 : 2e5)) * 100) : 0);
  const stateBadge = (st: SessState): string => {
    const th = getTheme();
    const [w, col] = st === "aktiv" ? ["WORK", th.success] : st === "wartet" ? ["WAIT", th.warning]
      : st === "monitor" ? ["MON", th.accentHi] : ["IDLE", th.text3];
    return `${tfg(col as any)}[${w}]${RESET}`;
  };
  /** Plain-language project/host summary badge: "[2 WORK] [1 WAIT]" or dim "idle". */
  const summaryBadge = (work: number, wait: number, total: number): string => {
    const th = getTheme();
    const b: string[] = [];
    if (work) b.push(`${tfg(th.success)}${work} WORK${RESET}`);
    if (wait) b.push(`${tfg(th.warning)}${wait} WAIT${RESET}`);
    if (!b.length) b.push(`${tfg(th.textDim)}${total ? "idle" : "—"}${RESET}`);
    return b.join("  ");
  };

  /** Build the flattened agent tree into pane `idx` (respecting `treeExpanded`). */
  const buildTree = (idx: number): void => {
    const p = ui.cmdPanes[idx];
    p.view = "tree"; p.error = ""; p.loading = false; p.title = "Projects & Agents";
    if (!ui.cmdHosts.length) ui.cmdHosts = discoverHosts();
    const local = ui.cmdHosts.find((h) => isLocal(h));
    if (!treeInit) { treeInit = true; if (local) treeExpanded.add(`h:${local.name}`); }
    const th = getTheme();
    const items: PaneItem[] = [];

    type Sess = { acct: string; state: SessState; title: string; sessionId: string; cwd: string; path: string; model: string; ctx: number; ts: number };
    interface TNode { path: string; label: string; sessions: Sess[]; kids: Map<string, TNode>; work: number; wait: number; ts: number }
    const mkNode = (path: string): TNode => ({ path, label: baseName(path) || path, sessions: [], kids: new Map(), work: 0, wait: 0, ts: 0 });
    const sessItem = (ss: Sess, depth: number): PaneItem => {
      const pc = ctxPct(ss.ctx, ss.model);
      return {
        kind: "session", label: ss.title || baseName(ss.cwd) || ss.sessionId.slice(0, 8), depth,
        badge: `${stateBadge(ss.state)} ${tfg(th.text3)}${modelShort(ss.model)}${pc ? " " + pc + "%" : ""}${RESET}`,
        state: ss.state, sessionId: ss.sessionId, cwd: ss.cwd, path: ss.path, accountKey: ss.acct,
      };
    };

    for (const h of ui.cmdHosts) {
      const hid = `h:${h.name}`;
      const hExp = treeExpanded.has(hid);
      const all: Sess[] = [];
      if (isLocal(h)) {
        for (const s of states) for (const ss of s.sessions) {
          if (!ss.cwd) continue;
          all.push({ acct: s.def.key, state: ss.state, title: ss.title, sessionId: ss.sessionId, cwd: ss.cwd, path: ss.path, model: ss.model, ctx: ss.ctxTokens, ts: ss.lastTs });
        }
      }
      const hostBadge = h.online === false ? `${tfg(th.textDim)}offline${RESET}`
        : summaryBadge(all.filter((x) => x.state === "aktiv").length, all.filter((x) => x.state === "wartet").length, all.length);
      items.push({ kind: "host", label: h.name, depth: 0, expandable: true, expanded: hExp, nodeId: hid, badge: hostBadge, host: h.name, online: h.online });
      if (!hExp) continue;
      if (!all.length) { items.push({ kind: "project", label: `${tfg(th.textDim)}(no active agents)${RESET}`, depth: 1 }); continue; }

      // path trie of the session cwds; sessions live at their leaf dir
      const root = commonRoot(all.map((s) => s.cwd));
      const nodes = new Map<string, TNode>();
      const ensure = (path: string) => nodes.get(path) ?? (nodes.set(path, mkNode(path)), nodes.get(path)!);
      ensure(root);
      for (const s of all) {
        ensure(s.cwd).sessions.push(s);
        let cur = s.cwd;
        while (cur.length > root.length && cur !== root) {
          const par = dirParent(cur);
          ensure(par).kids.set(cur, ensure(cur));
          cur = par;
        }
      }
      // bottom-up aggregate → the "needs-me" attractor bubbles UP to every ancestor dir
      const agg = (n: TNode): void => {
        let w = 0, wt = 0, ts = 0;
        for (const s of n.sessions) { if (s.state === "aktiv") w++; else if (s.state === "wartet") wt++; ts = Math.max(ts, s.ts); }
        for (const c of n.kids.values()) { agg(c); w += c.work; wt += c.wait; ts = Math.max(ts, c.ts); }
        n.work = w; n.wait = wt; n.ts = ts;
      };
      agg(nodes.get(root)!);
      // collapse single-child dir chains with no own sessions ("a/b/c" as one row)
      const compress = (n: TNode): TNode => {
        let cur = n;
        while (cur.sessions.length === 0 && cur.kids.size === 1) {
          const c = [...cur.kids.values()][0];
          c.label = `${cur.label}/${c.label}`;
          cur = c;
        }
        const nk = new Map<string, TNode>();
        for (const c of cur.kids.values()) { const cc = compress(c); nk.set(cc.path, cc); }
        cur.kids = nk;
        return cur;
      };
      const actionable = (a: TNode, b: TNode) => (b.wait - a.wait) || (b.work - a.work) || (b.ts - a.ts);
      const flatten = (n: TNode, depth: number): void => {
        const nid = `d:${h.name}:${n.path}`;
        const exp = treeExpanded.has(nid);
        items.push({
          kind: "project", label: n.label, depth, expandable: n.kids.size > 0 || n.sessions.length > 0, expanded: exp, nodeId: nid,
          badge: summaryBadge(n.work, n.wait, n.sessions.length + n.kids.size), host: h.name, path: n.path,
        });
        if (!exp) return;
        for (const c of [...n.kids.values()].sort(actionable)) flatten(c, depth + 1);
        for (const ss of n.sessions.sort((a, b) => b.ts - a.ts)) items.push({ ...sessItem(ss, depth + 1), host: h.name });
      };
      const cr = compress(nodes.get(root)!);
      const tops = cr.sessions.length ? [cr] : [...cr.kids.values()].sort(actionable);
      for (const tn of tops) flatten(tn, 1);
    }
    p.items = items;
  };

  /** Claude context for the active host — the heart of the claudeplex×mc fusion.
   *  Local: sessions from `states` + RC servers from the live snapshot. Remote:
   *  RC servers from the cached fleet (sessions need the host's --json; TODO). */
  const claudeIndex = (p: CmdPane) => {
    const host = cmdHostOf(p);
    const sessions: { accountKey: string; cwd: string; state: SessState; title: string; sessionId: string }[] = [];
    const rc = new Map<string, string | undefined>(); // project cwd → tmux name (RC server runs there)
    if (host && isLocal(host)) {
      for (const s of states) for (const ss of s.sessions) {
        if (ss.cwd) sessions.push({ accountKey: s.def.key, cwd: ss.cwd, state: ss.state, title: ss.title, sessionId: ss.sessionId });
      }
      for (const sv of remoteSnapshot(instances).servers) rc.set(sv.cwd, sv.tmux ?? undefined);
    } else if (host && ui.cmdRemote && cmdHostOf(ui.cmdPanes[ui.cmdActive])?.name === host.name) {
      for (const sv of ui.cmdRemote.servers) rc.set(sv.cwd, sv.tmux ?? undefined);
    }
    return { sessions, rc };
  };

  /** Coloured Claude annotation for a directory row: session-state counts + RC marker. */
  const dirAnnotation = (childPath: string, ix: ReturnType<typeof claudeIndex>): string => {
    const th = getTheme();
    const under = ix.sessions.filter((s) => s.cwd === childPath || s.cwd.startsWith(childPath + "/"));
    const n = (st: SessState) => under.filter((s) => s.state === st).length;
    const a = n("aktiv"), m = n("monitor"), w = n("wartet"), st = n("stale");
    return [
      a && `${tfg(th.success)}${ICONS.active}${a}${RESET}`,
      m && `${tfg(th.accentHi)}${ICONS.monitor}${m}${RESET}`,
      w && `${tfg(th.warning)}${ICONS.waiting}${w}${RESET}`,
      st && `${tfg(th.text3)}${ICONS.idle}${st}${RESET}`,
      ix.rc.has(childPath) && `${tfg(th.accent)}${ICONS.background}${RESET}`,
    ].filter(Boolean).join(" ");
  };

  /** (Re)build a pane's items from its view. Sync for hosts/drives/accounts/sessions/local-fleet;
   *  async for files + remote fleet. */
  const listPane = (idx: number): void => {
    const p = ui.cmdPanes[idx];
    const host = cmdHostOf(p);
    p.error = "";
    if (idx === ui.cmdActive) refreshFleet(host);

    if (p.view === "hosts") {
      ui.cmdHosts = discoverHosts();
      p.items = ui.cmdHosts.map((h): PaneItem => ({ kind: "host", label: h.name, meta: sshTarget(h), online: h.online, host: h.name }));
      p.title = `${t("cmdNetwork")} · ${ui.cmdHosts.length}`;
      p.loading = false;
      return;
    }
    if (p.view === "drives") {
      p.items = [UP_ITEM,
        { kind: "drive", label: "Files", drive: "files" },
        { kind: "drive", label: "Accounts", drive: "accounts" },
        { kind: "drive", label: "RC-Fleet", drive: "fleet" }];
      p.title = `${p.host}`;
      p.loading = false;
      return;
    }
    if (p.view === "accounts") {
      p.items = [UP_ITEM, ...states.map((s): PaneItem => ({
        kind: "account", label: `${s.def.key} ${s.def.label}`,
        meta: `${s.account.plan || "—"} · ${s.sessions.filter((x) => x.live).length}↑`, accountKey: s.def.key,
      }))];
      p.title = `${p.host} · Accounts`;
      p.loading = false;
      return;
    }
    if (p.view === "sessions") {
      const sess = states.find((s) => s.def.key === p.accountKey)?.sessions ?? [];
      p.items = [UP_ITEM, ...sess.map((ss): PaneItem => ({
        kind: "session", label: ss.title || (ss.cwd ? "~" + baseName(ss.cwd) : ss.sessionId.slice(0, 8)),
        meta: stateLabel(ss.state), state: ss.state, sessionId: ss.sessionId, cwd: ss.cwd, accountKey: p.accountKey,
      }))];
      p.title = `${p.accountKey} · Sessions`;
      p.loading = false;
      return;
    }
    if (p.view === "fleet") {
      p.title = `${p.host} · RC-Fleet`;
      const build = (snap: ReturnType<typeof remoteSnapshot>) => {
        ui.cmdRemote = snap;
        p.items = [UP_ITEM, ...snap.servers.map((sv): PaneItem => ({
          kind: "rcserver", label: baseName(sv.cwd) || sv.cwd,
          meta: `${sv.memMb}MB · ${sv.sessions.length}s`, host: p.host, cwd: sv.cwd, tmux: sv.tmux ?? undefined,
        }))];
        p.loading = false;
      };
      if (host && isLocal(host)) build(remoteSnapshot(instances));
      else if (host) {
        p.loading = true;
        const token = ++cmdTokens[idx];
        void fetchRemoteFleet(host).then((snap) => {
          if (token !== cmdTokens[idx] || !ui.commander) return;
          if (snap) build(snap);
          else { p.items = [UP_ITEM]; p.loading = false; p.error = "fleet unavailable (claudeplex on PATH?)"; }
          draw();
        });
      }
      return;
    }
    // files — fused with Claude context: sessions/RC of THIS dir as virtual
    // entries at the top, child dirs annotated with their session-state + RC.
    if (!host) { p.items = [UP_ITEM]; p.loading = false; return; }
    p.loading = true;
    p.title = `${p.host}:${p.path}`;
    const token = ++cmdTokens[idx];
    void listDir(host, p.path).then(
      (entries) => {
        if (token !== cmdTokens[idx] || !ui.commander) return;
        const ix = claudeIndex(p);
        const th = getTheme();
        const virtual: PaneItem[] = [];
        for (const ss of ix.sessions.filter((s) => s.cwd === p.path)) {
          virtual.push({
            kind: "session", label: ss.title || ss.sessionId.slice(0, 8),
            meta: `${tfg(th.text3)}${ss.accountKey}${RESET}`, state: ss.state,
            sessionId: ss.sessionId, cwd: ss.cwd, accountKey: ss.accountKey,
          });
        }
        if (ix.rc.has(p.path)) {
          virtual.push({
            kind: "rcserver", label: "remote-control",
            meta: `${tfg(th.accent)}${ICONS.background} RC${RESET}`,
            host: p.host, cwd: p.path, tmux: ix.rc.get(p.path),
          });
        }
        const rows = entries.map((e): PaneItem => {
          const childPath = pathJoin(p.path, e.name);
          const meta = e.type === "dir"
            ? dirAnnotation(childPath, ix)
            : `${tfg(th.textDim)}${sizeStr(e.size)}${RESET}`;
          return {
            kind: e.type === "dir" ? "dir" : e.type === "link" ? "link" : "file",
            label: e.name, meta, host: p.host, path: childPath,
          };
        });
        p.items = [UP_ITEM, ...virtual, ...rows];
        p.loading = false;
        draw();
      },
      (e) => {
        if (token !== cmdTokens[idx] || !ui.commander) return;
        p.items = [UP_ITEM]; p.loading = false; p.error = String(e?.message ?? e); draw();
      },
    );
  };

  /** Ascend the hierarchy in pane `idx`. */
  const goUp = (idx: number): void => {
    const p = ui.cmdPanes[idx];
    p.sel = 0;
    if (p.view === "files") {
      const parent = pathJoin(p.path, "..");
      if (cmdHostOf(p) && parent !== p.path) { p.path = parent; listPane(idx); }
      else { p.view = "drives"; listPane(idx); }
    } else if (p.view === "sessions") { p.view = "accounts"; listPane(idx); }
    else if (p.view === "accounts" || p.view === "fleet") { p.view = "drives"; listPane(idx); }
    else if (p.view === "drives") { p.view = "hosts"; listPane(idx); }
    // hosts = root → nothing
  };

  /** Open a session as a full-screen cockpit view (returns to the Commander on Esc). */
  const openSession = (it: PaneItem): void => {
    const def = instances.find((d) => d.key === it.accountKey) ?? instances[0];
    if (!def || !it.sessionId) { ui.cmdFeedback = "no account for session"; return; }
    ui.focus = `a:${enterSession(def, it.sessionId, it.cwd || process.env.HOME || ".", 0)}`;
    ui.fromCommander = true; // Esc in the cockpit returns here
    ui.commander = false;
    ui.cockpit = true;
    ui.cockpitArea = "input";
  };

  /** Enter the selected item in pane `idx` (descend the hierarchy / act). */
  const enterItem = (idx: number): void => {
    const p = ui.cmdPanes[idx];
    const it = cmdSel(p);
    if (!it) return;
    if (it.kind === "up") { goUp(idx); return; }
    const host = cmdHostOf(p);
    if (it.kind === "host") { p.host = it.host!; p.view = "drives"; p.sel = 0; listPane(idx); }
    else if (it.kind === "drive") {
      p.view = it.drive!; p.sel = 0;
      if (it.drive === "files" && host) {
        p.loading = true;
        const tk = ++cmdTokens[idx];
        void resolveHome(host).then((home) => { if (tk !== cmdTokens[idx] || !ui.commander) return; p.path = home; listPane(idx); draw(); });
      } else listPane(idx);
    } else if (it.kind === "dir") { if (host) { p.path = it.path!; p.sel = 0; listPane(idx); } }
    else if (it.kind === "account") { p.accountKey = it.accountKey!; p.view = "sessions"; p.sel = 0; listPane(idx); }
    else if (it.kind === "session") { openSession(it); }
    else if (it.kind === "rcserver") { if (host && it.tmux) shellOut(shellOutArgv(host, { tmux: it.tmux })); }
    // file/link: leaf — no descent (use Shell/F3 to open a shell in the dir)
  };

  /** The currently-selected node in the left tree. */
  const treeSel = (): PaneItem | undefined => {
    const p = ui.cmdPanes[0];
    return p.items[Math.min(Math.max(0, p.sel), p.items.length - 1)];
  };

  /** Toggle expand/collapse of the selected tree node (or open it if a leaf session). */
  const treeEnter = (): void => {
    const p = ui.cmdPanes[0];
    const it = treeSel();
    if (!it) return;
    if (it.expandable && it.nodeId) {
      if (treeExpanded.has(it.nodeId)) treeExpanded.delete(it.nodeId);
      else treeExpanded.add(it.nodeId);
      buildTree(0);
    } else if (it.kind === "session") {
      openSession(it); // → full cockpit to steer
    }
  };

  /** Collapse the selected node, or its parent if already collapsed/leaf. */
  const treeCollapse = (): void => {
    const p = ui.cmdPanes[0];
    const it = treeSel();
    if (!it) return;
    if (it.expandable && it.expanded && it.nodeId) { treeExpanded.delete(it.nodeId); buildTree(0); return; }
    const d = it.depth ?? 0;
    for (let i = p.sel - 1; i >= 0; i--) {
      if ((p.items[i].depth ?? 0) === d - 1) {
        const par = p.items[i];
        if (par.nodeId) treeExpanded.delete(par.nodeId);
        buildTree(0);
        p.sel = i;
        return;
      }
    }
  };

  /** Jump the tree selection to the next agent waiting for input (expands as needed). */
  const jumpNextWaiting = (): void => {
    const p = ui.cmdPanes[0];
    const local = ui.cmdHosts.find((h) => isLocal(h));
    // expand the host + every dir on the path to each waiting session (all prefixes
    // — covers compressed chain nodes whose id is the deepest path on the chain)
    for (const s of states) for (const ss of s.sessions) {
      if (ss.state !== "wartet" || !local || !ss.cwd) continue;
      treeExpanded.add(`h:${local.name}`);
      let cur = ss.cwd;
      while (cur.length > 1) { treeExpanded.add(`d:${local.name}:${cur}`); cur = dirParent(cur); }
    }
    ui.cmdActive = 0;
    buildTree(0);
    const waits = p.items.map((it, i) => ({ it, i })).filter((x) => x.it.kind === "session" && x.it.state === "wartet").map((x) => x.i);
    if (!waits.length) { ui.cmdFeedback = "no agents waiting"; return; }
    p.sel = waits.find((i) => i > p.sel) ?? waits[0];
    ui.cmdFeedback = "";
  };

  /** Flip the RIGHT pane between the live session detail and a file browser of the selection. */
  const toggleRight = (): void => {
    const r = ui.cmdPanes[1];
    if (r.view === "files") { r.view = "session"; return; }
    const sel = treeSel();
    const host = sel?.host ? ui.cmdHosts.find((h) => h.name === sel.host) : ui.cmdHosts.find((h) => isLocal(h));
    const cwd = sel?.path ?? sel?.cwd;
    if (host && cwd) { r.view = "files"; r.host = host.name; r.path = cwd; r.sel = 0; listPane(1); }
    else ui.cmdFeedback = "select a project to browse its files";
  };

  /** Launch a fresh agent in the selected node's project dir → straight to the cockpit. */
  const newAgentHere = (sel: PaneItem | undefined): void => {
    const cwd = sel?.path ?? sel?.cwd;
    if (!cwd) { ui.cmdFeedback = "select a project first"; return; }
    const def = instances[ui.sel] ?? instances[0];
    if (!def) { ui.cmdFeedback = "no account"; return; }
    ui.focus = `a:${registry.launch(def, cwd).launchId}`;
    ui.fromCommander = true; ui.commander = false; ui.cockpit = true; ui.cockpitArea = "input";
  };

  /** Shell-out into the selected node's project dir (real PTY). */
  const shellHere = (sel: PaneItem | undefined): void => {
    const host = sel?.host ? ui.cmdHosts.find((h) => h.name === sel.host) : ui.cmdHosts.find((h) => isLocal(h));
    const cwd = sel?.path ?? sel?.cwd;
    if (host && cwd) shellOut(shellOutArgv(host, { cwd }));
  };

  /** Land in the Conductor: left = agent tree, right = live session detail. */
  const commanderHome = (): void => {
    ui.commander = true;
    ui.cmdHosts = discoverHosts();
    ui.cmdFeedback = "";
    ui.cmdActive = 0;
    buildTree(0);
    ui.cmdPanes[1].view = "session";
    ui.cmdPanes[1].items = [];
    refreshFleet(ui.cmdHosts.find((h) => isLocal(h)));
  };

  /** Open the Commander: resume if the tree is built, else home. */
  const openCommander = (): void => {
    ui.commander = true;
    ui.cmdFeedback = "";
    if (!ui.cmdPanes.some((p) => p.items.length)) commanderHome();
  };

  const doRefresh = (t: number) => {
    states = collectAll(instances, t);
    lastRefresh = t;
    notifyTransitions(updateStates(states, t));
    // keep the agent tree live (preserving expand state + selection)
    if (ui.commander && ui.cmdPanes[0].view === "tree") {
      const keep = ui.cmdPanes[0].sel;
      buildTree(0);
      ui.cmdPanes[0].sel = Math.min(keep, Math.max(0, ui.cmdPanes[0].items.length - 1));
    }
  };

  enterFullscreen(); // force the terminal window fullscreen (CD_NO_FULLSCREEN to skip)
  const enter = "\x1b[?1049h\x1b[?25l"; // alt screen + hide cursor
  const leave = "\x1b[?25h\x1b[?1049l"; // show cursor + leave alt screen
  process.stdout.write(enter);

  const cleanup = () => {
    clearInterval(timer);
    registry.killAll();
    process.stdout.write(leave);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
  };

  const quit = () => {
    cleanup();
    process.exit(0);
  };

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (buf) => {
      const k = buf.toString();
      const n = states.length;
      const UP = k === "\x1b[A" || k === "\x1bOA";
      const DOWN = k === "\x1b[B" || k === "\x1bOB";
      const RIGHT = k === "\x1b[C" || k === "\x1bOC";
      const LEFT = k === "\x1b[D" || k === "\x1bOD";
      const ENTER = k === "\r" || k === "\n";
      const ESC = k === "\x1b";
      const PGUP = k === "\x1b[5~";
      const PGDN = k === "\x1b[6~";
      const page = Math.max(1, (process.stdout.rows || 40) - 8);
      // function keys F1–F10 (xterm SS3 + CSI + linux-console forms) for the mc-style bar
      const fkey =
        k === "\x1bOP" || k === "\x1b[11~" || k === "\x1b[[A" ? 1 :
        k === "\x1bOQ" || k === "\x1b[12~" || k === "\x1b[[B" ? 2 :
        k === "\x1bOR" || k === "\x1b[13~" || k === "\x1b[[C" ? 3 :
        k === "\x1bOS" || k === "\x1b[14~" || k === "\x1b[[D" ? 4 :
        k === "\x1b[15~" || k === "\x1b[[E" ? 5 :
        k === "\x1b[17~" ? 6 :
        k === "\x1b[18~" ? 7 :
        k === "\x1b[19~" ? 8 :
        k === "\x1b[20~" ? 9 :
        k === "\x1b[21~" ? 10 : 0;

      // No accounts discovered → quit / rescan / open the Commander (which can
      // browse remote hosts even with no local accounts).
      if (states.length === 0 && !ui.commander) {
        if (k === "q" || k === "\x03") return quit();
        if (k === "r") doRefresh(Date.now());
        if (k === "h") { openCommander(); return draw(); }
        return draw();
      }

      // Live theme picker: ↑/↓ previews, ⏎ commits + persists, Esc restores.
      if (ui.themePicker) {
        if (k === "\x03") return quit();
        if (ESC) {
          previewTheme(themeOrig);
          ui.themePicker = false;
        } else if (ENTER) {
          setTheme(THEMES[Math.min(ui.themeSel, THEMES.length - 1)].name);
          ui.themePicker = false;
        } else if (UP) {
          ui.themeSel = (ui.themeSel - 1 + THEMES.length) % THEMES.length;
          previewTheme(THEMES[ui.themeSel].name);
        } else if (DOWN) {
          ui.themeSel = (ui.themeSel + 1) % THEMES.length;
          previewTheme(THEMES[ui.themeSel].name);
        } else {
          return;
        }
        return draw();
      }

      // Commander: Ebene 0 hosts → Ebene 1 two-pane files (copy/shell-out/RC control).
      // A modal picker (wizard/cwd/issue/pr) opened from the Commander overlays it
      // and must own the keyboard — defer to the picker blocks below.
      if (ui.commander && !ui.picker) {
        if (k === "q" || k === "\x03" || fkey === 10) return quit(); // q / Ctrl-C / F10
        const ai = ui.cmdActive;
        const p = ui.cmdPanes[ai];
        const other = ui.cmdPanes[ai === 0 ? 1 : 0];
        const host = cmdHostOf(p);
        const it = cmdSel(p);
        const rcOpts = (h: Host) => {
          const def = isLocal(h) ? (instances[ui.sel] ?? instances[0]) : undefined;
          return { key: def?.key ?? "default", configDir: def?.configDir, isDefault: def?.isDefault };
        };

        // ── global keys (any view) ──
        if (fkey === 1) {
          ui.cmdFeedback = "↑↓ move · ⏎ open/steer · → expand · ← collapse · w next-waiting · Tab pane · n new · i issue · P pr · s shell · F9 files · F8 theme · q quit";
          return draw();
        }
        if (fkey === 8) {
          themeOrig = getTheme().name;
          ui.themeSel = themeIndex();
          ui.themePicker = true;
          return draw();
        }
        if (k === "\t") {
          ui.cmdActive = ai === 0 ? 1 : 0;
          ui.cmdFeedback = "";
          refreshFleet(cmdHostOf(ui.cmdPanes[ui.cmdActive]));
          return draw();
        }
        if (k === "w") { jumpNextWaiting(); return draw(); } // jump to next agent waiting on you

        // ── tree: the agent overview (left spine) ──
        if (p.view === "tree") {
          const sel = treeSel();
          if (UP) p.sel = Math.max(0, p.sel - 1);
          else if (DOWN) p.sel = Math.min(Math.max(0, p.items.length - 1), p.sel + 1);
          else if (ENTER || RIGHT || fkey === 3) treeEnter();
          else if (LEFT) treeCollapse();
          else if (fkey === 2) jumpNextWaiting();
          else if (k === "f" || fkey === 9) toggleRight();
          else if (k === "n" || fkey === 4) newAgentHere(sel);
          else if (k === "i" || fkey === 5) openIssue();
          else if (k === "P") openPr(); // capital P → PR-review (p is the theme picker)
          else if (k === "s" || fkey === 6) shellHere(sel);
          else return;
          return draw();
        }

        // ── session detail (right pane) ──
        if (p.view === "session") {
          const sel = treeSel();
          if (ENTER || fkey === 3) { if (sel?.kind === "session") openSession(sel); }
          else if (LEFT || ESC) ui.cmdActive = 0;
          else if (fkey === 2) jumpNextWaiting();
          else if (k === "f" || fkey === 9) toggleRight();
          else if (k === "n" || fkey === 4) newAgentHere(sel);
          else if (k === "s" || fkey === 6) shellHere(sel);
          else return;
          return draw();
        }

        // ── files / drives / accounts / fleet (the mc browser) ──
        if (fkey === 2) {
          p.view = p.host ? "drives" : "hosts";
          p.sel = 0; ui.cmdFeedback = ""; listPane(ai);
        } else if (k === "f" || fkey === 9) {
          ui.cmdPanes[1].view = "session"; ui.cmdActive = 0; // back to the tree+session conductor
        } else if (UP) {
          p.sel = Math.max(0, p.sel - 1);
        } else if (DOWN) {
          p.sel = Math.min(Math.max(0, p.items.length - 1), p.sel + 1);
        } else if (LEFT || ESC) {
          goUp(ai);
        } else if (ENTER || RIGHT) {
          enterItem(ai);
        } else if (fkey === 4 && (p.view === "sessions" || p.view === "accounts")) {
          openWizard(); // F4 → new-agent wizard
        } else if (fkey === 5 && (p.view === "sessions" || p.view === "accounts")) {
          openIssue(); // F5 → quick-issue
        } else if (k === "P" && (p.view === "sessions" || p.view === "accounts")) {
          openPr(); // capital P → PR-review (p is the theme picker)
        } else if (fkey === 3 && p.view !== "files") {
          enterItem(ai); // F3 = Open/Enter/Attach in non-file views
        } else if ((k === "s" || fkey === 3) && p.view === "files") {
          if (host) shellOut(shellOutArgv(host, { cwd: p.path }));
        } else if ((k === "c" || fkey === 5) && p.view === "files") {
          // copy active selection → the OTHER pane's dir (host↔host, no scp)
          const otherHost = cmdHostOf(other);
          if (host && otherHost && other.view === "files" && it && it.path && it.kind !== "up") {
            const srcPath = it.path, dstPath = other.path, oi = ai === 0 ? 1 : 0, nm = it.label;
            ui.cmdFeedback = t("cmdCopying");
            void copyEntry({ host, path: srcPath }, { host: otherHost, path: dstPath }).then((r) => {
              if (!ui.commander) return;
              ui.cmdFeedback = r.ok ? `✓ ${nm} → ${other.host}` : `error: ${r.error}`;
              if (r.ok) listPane(oi);
              else draw();
            });
          } else if (other.view !== "files") {
            ui.cmdFeedback = "Ziel-Pane muss Dateien zeigen (Tab → .. → Files)";
          }
        } else if ((k === "L" || fkey === 4) && (p.view === "files" || p.view === "fleet")) {
          if (host) {
            const cwd = p.view === "files" ? p.path : (it?.cwd ?? p.path);
            ui.cmdFeedback = t("cmdLaunching");
            void launchRcServer(host, cwd, { spawn: "worktree", ...rcOpts(host) }).then((r) => {
              if (!ui.commander) return;
              ui.cmdFeedback = r.ok ? `${r.reused ? "running" : "✓ launched"} @ ${cwd}` : `error: ${r.error}`;
              if (p.view === "fleet") listPane(ai);
              refreshFleet(host);
              draw();
            });
          }
        } else if ((k === "K" || fkey === 7) && (p.view === "files" || p.view === "fleet")) {
          if (host) {
            const cwd = p.view === "files" ? p.path : (it?.cwd ?? p.path);
            ui.cmdFeedback = "stopping…";
            void stopRcServer(host, rcOpts(host).key, cwd).then((ok) => {
              if (!ui.commander) return;
              ui.cmdFeedback = ok ? `✓ stopped @ ${cwd}` : "no server here";
              if (p.view === "fleet") listPane(ai);
              refreshFleet(host);
              draw();
            });
          }
        } else if ((k === "a" || fkey === 6) && p.view === "files") {
          if (host) shellOut(shellOutArgv(host, { tmux: tmuxName(rcOpts(host).key, p.path) }));
        } else {
          return;
        }
        return draw();
      }

      // Working-folder picker: editable path + directory suggestions. Printable
      // keys edit the path, so this must run before the global quit letters.
      if (ui.picker === "cwd") {
        if (k === "\x03") return quit();
        const def = instances.find((d) => d.key === ui.pickerInstance) ?? instances[0];
        const sugg = dirSuggestions(ui.pickerInput, recentCwds(states, ui.pickerInstance));
        if (ESC) {
          ui.picker = "";
        } else if (ENTER) {
          const cwd = expandTilde(ui.pickerInput);
          if (isDir(cwd)) {
            ui.focus = `a:${registry.launch(def, cwd).launchId}`;
            ui.picker = "";
            ui.cockpit = true;
          } // invalid path: stay in picker (shown red)
        } else if (UP) {
          ui.pickerSel = Math.max(0, ui.pickerSel - 1);
        } else if (DOWN) {
          ui.pickerSel = Math.min(Math.max(0, sugg.length - 1), ui.pickerSel + 1);
        } else if (k === "\t" || RIGHT) {
          const pick = sugg[Math.min(ui.pickerSel, sugg.length - 1)];
          if (pick) {
            ui.pickerInput = pick.endsWith("/") ? pick : pick + "/";
            ui.pickerSel = 0;
          }
        } else if (k === "\x7f" || k === "\b") {
          ui.pickerInput = ui.pickerInput.slice(0, -1);
          ui.pickerSel = 0;
        } else if (k.length > 0 && ![...k].some((c) => c.charCodeAt(0) < 0x20)) {
          ui.pickerInput += k;
          ui.pickerSel = 0;
        } else {
          return;
        }
        return draw();
      }

      // New-agent wizard: centered popup with two orientations (^T toggles).
      // Left pane = ui.pickerInstSel, right pane = ui.pickerSel; Tab/←/→ route.
      if (ui.picker === "wizard") {
        if (k === "\x03") return quit();
        if (ESC) {
          ui.picker = "";
          return draw();
        }
        if (k === "\x14") {
          // Ctrl-T: flip orientation (instance→folder ↔ folder→instance)
          ui.pickerMode = ui.pickerMode === "folder" ? "instance" : "folder";
          ui.pickerPane = "instance";
          ui.pickerInstSel = 0;
          ui.pickerSel = 0;
          if (ui.pickerMode === "instance") syncWizardInstance();
          return draw();
        }
        const folderMode = ui.pickerMode === "folder";

        // LEFT pane (instances, or folders in folder-mode)
        if (ui.pickerPane === "instance") {
          const len = folderMode ? wizardFolders(states).length : states.length;
          if (UP) {
            ui.pickerInstSel = Math.max(0, ui.pickerInstSel - 1);
            ui.pickerSel = 0;
            if (!folderMode) syncWizardInstance();
          } else if (DOWN) {
            ui.pickerInstSel = Math.min(Math.max(0, len - 1), ui.pickerInstSel + 1);
            ui.pickerSel = 0;
            if (!folderMode) syncWizardInstance();
          } else if (ENTER || RIGHT || k === "\t") {
            ui.pickerPane = "cwd"; // into the right pane
          } else {
            return;
          }
          return draw();
        }

        // RIGHT pane — folder-mode: pick the instance that runs in the folder
        if (folderMode) {
          const folders = wizardFolders(states);
          const folder = folders[Math.min(Math.max(0, ui.pickerInstSel), Math.max(0, folders.length - 1))];
          const ordered = wizardOrderedInstances(states, folder);
          if (ENTER) {
            const inst = ordered[Math.min(Math.max(0, ui.pickerSel), Math.max(0, ordered.length - 1))];
            if (inst && folder && isDir(folder.cwd)) {
              ui.focus = `a:${registry.launch(inst.def, folder.cwd).launchId}`;
              ui.picker = "";
              ui.cockpit = true;
            }
          } else if (k === "\t" || LEFT) {
            ui.pickerPane = "instance";
          } else if (UP) {
            ui.pickerSel = Math.max(0, ui.pickerSel - 1);
          } else if (DOWN) {
            ui.pickerSel = Math.min(Math.max(0, ordered.length - 1), ui.pickerSel + 1);
          } else {
            return;
          }
          return draw();
        }

        // RIGHT pane — instance-mode: editable folder path + history suggestions
        const def = instances.find((d) => d.key === ui.pickerInstance) ?? instances[0];
        const history = def
          ? [...new Set([...recentCwds(states, def.key), ...instanceFolders(def.configDir).map((f) => f.cwd)])]
          : recentCwds(states, ui.pickerInstance);
        const sugg = dirSuggestions(ui.pickerInput, history, 60);
        if (ENTER) {
          const cwd = expandTilde(ui.pickerInput);
          if (isDir(cwd)) {
            ui.focus = `a:${registry.launch(def, cwd).launchId}`;
            ui.picker = "";
            ui.cockpit = true;
          } // invalid path: stay (shown red)
        } else if (k === "\t" || LEFT) {
          ui.pickerPane = "instance";
        } else if (UP) {
          ui.pickerSel = Math.max(0, ui.pickerSel - 1);
        } else if (DOWN) {
          ui.pickerSel = Math.min(Math.max(0, sugg.length - 1), ui.pickerSel + 1);
        } else if (RIGHT) {
          const pick = sugg[Math.min(ui.pickerSel, sugg.length - 1)];
          if (pick) {
            ui.pickerInput = pick.endsWith("/") ? pick : pick + "/";
            ui.pickerSel = 0;
          }
        } else if (k === "\x7f" || k === "\b") {
          ui.pickerInput = ui.pickerInput.slice(0, -1);
          ui.pickerSel = 0;
        } else if (k.length > 0 && ![...k].some((c) => c.charCodeAt(0) < 0x20)) {
          ui.pickerInput += k;
          ui.pickerSel = 0;
        } else {
          return;
        }
        return draw();
      }

      // Quick-issue modal: pick → draft → review → create, a small stage machine.
      if (ui.picker === "issue") {
        if (k === "\x03") return quit();

        // Async stages: only cancel is meaningful while the instance / gh runs.
        if (ui.issueStage === "drafting" || ui.issueStage === "creating") {
          if (ESC) {
            issueToken++; // abandon the in-flight result
            ui.picker = "";
          }
          return draw();
        }

        if (ui.issueStage === "pick") {
          const folders = issueRepos(states);
          if (ESC) {
            ui.picker = "";
          } else if (k === "\t") {
            ui.issuePane = ui.issuePane === "folder" ? "desc" : "folder";
          } else if (ui.issuePane === "folder") {
            if (UP) ui.issueFolderSel = Math.max(0, ui.issueFolderSel - 1);
            else if (DOWN) ui.issueFolderSel = Math.min(Math.max(0, folders.length - 1), ui.issueFolderSel + 1);
            else if (RIGHT || ENTER) ui.issuePane = "desc";
            else return;
          } else {
            // description pane: editable text; ← jumps back to the repo list
            if (LEFT) {
              ui.issuePane = "folder";
            } else if (ENTER) {
              const folder = folders[Math.min(ui.issueFolderSel, Math.max(0, folders.length - 1))];
              if (folder && ui.issueInput.trim()) startDraft(folder.cwd, ui.issueInput.trim());
            } else if (k === "\x7f" || k === "\b") {
              ui.issueInput = ui.issueInput.slice(0, -1);
            } else if (k.length > 0 && ![...k].some((c) => c.charCodeAt(0) < 0x20)) {
              ui.issueInput += k;
            } else {
              return;
            }
          }
          return draw();
        }

        if (ui.issueStage === "review") {
          if (ESC) ui.picker = "";
          else if (ENTER) startCreate();
          else if (k === "r" || k === "R") { ui.issueStage = "rewrite"; ui.issueFeedback = ""; }
          else if (UP) ui.issueScroll = Math.max(0, ui.issueScroll - 1);
          else if (DOWN) ui.issueScroll += 1; // clamped in render
          else if (PGUP) ui.issueScroll = Math.max(0, ui.issueScroll - page);
          else if (PGDN) ui.issueScroll += page;
          else return;
          return draw();
        }

        if (ui.issueStage === "rewrite") {
          if (ESC) {
            ui.issueStage = "review";
          } else if (ENTER) {
            if (ui.issueFeedback.trim()) {
              startDraft(ui.issueRepo, ui.issueInput.trim(), { draft: ui.issueDraft, feedback: ui.issueFeedback.trim() });
            }
          } else if (k === "\x7f" || k === "\b") {
            ui.issueFeedback = ui.issueFeedback.slice(0, -1);
          } else if (k.length > 0 && ![...k].some((c) => c.charCodeAt(0) < 0x20)) {
            ui.issueFeedback += k;
          } else {
            return;
          }
          return draw();
        }

        if (ui.issueStage === "done") {
          if (ESC || ENTER) ui.picker = "";
          return draw();
        }

        // error stage: r retries the draft, Esc closes
        if (k === "r" || k === "R") {
          if (ui.issueRepo && ui.issueInput.trim()) startDraft(ui.issueRepo, ui.issueInput.trim());
          else ui.issueStage = "pick";
        } else if (ESC) {
          ui.picker = "";
        } else {
          return;
        }
        return draw();
      }

      // PR-review modal: pick → analyze → review → act, a small stage machine.
      if (ui.picker === "pr") {
        if (k === "\x03") return quit();

        // Async stages: only cancel is meaningful while the instance / gh runs.
        if (ui.prStage === "analyzing" || ui.prStage === "commenting" || ui.prStage === "merging" || ui.prStage === "launching") {
          if (ESC) {
            ui.prToken++; // abandon the in-flight result
            ui.picker = "";
          }
          return draw();
        }

        if (ui.prStage === "pick") {
          const repos = issueRepos(states);
          const repoCwd = () => repos[Math.min(ui.prRepoSel, Math.max(0, repos.length - 1))]?.cwd;
          if (ESC) {
            ui.picker = "";
          } else if (k === "\t") {
            ui.prPane = ui.prPane === "repo" ? "list" : "repo";
          } else if (ui.prPane === "repo") {
            if (UP) { ui.prRepoSel = Math.max(0, ui.prRepoSel - 1); const c = repoCwd(); if (c) void loadPrList(c); }
            else if (DOWN) { ui.prRepoSel = Math.min(Math.max(0, repos.length - 1), ui.prRepoSel + 1); const c = repoCwd(); if (c) void loadPrList(c); }
            else if (RIGHT || ENTER) ui.prPane = "list";
            else return;
          } else {
            // PR list pane: ← back to repos, ⏎ analyzes the highlighted PR
            if (LEFT) ui.prPane = "repo";
            else if (UP) ui.prPrSel = Math.max(0, ui.prPrSel - 1);
            else if (DOWN) ui.prPrSel = Math.min(Math.max(0, ui.prList.length - 1), ui.prPrSel + 1);
            else if (ENTER) { if (ui.prList[ui.prPrSel]) startAnalyze(); }
            else return;
          }
          return draw();
        }

        if (ui.prStage === "review") {
          if (ESC) ui.picker = "";
          else if (k === "a" || k === "A") runReview("approve");
          else if (k === "c" || k === "C") { ui.prPendingAction = "comment"; ui.prStage = "action-input"; ui.prActionInput = ""; }
          else if (k === "r" || k === "R") { ui.prPendingAction = "request-changes"; ui.prStage = "action-input"; ui.prActionInput = ""; }
          else if (k === "m" || k === "M") runMerge();
          else if (k === "s" || k === "S") startPrSession();
          else if (UP) ui.prScroll = Math.max(0, ui.prScroll - 1);
          else if (DOWN) ui.prScroll += 1; // clamped in render
          else if (PGUP) ui.prScroll = Math.max(0, ui.prScroll - page);
          else if (PGDN) ui.prScroll += page;
          else return;
          return draw();
        }

        if (ui.prStage === "action-input") {
          if (ESC) { ui.prStage = "review"; ui.prActionInput = ""; }
          else if (ENTER) {
            const ev: ReviewEvent = ui.prPendingAction === "request-changes" ? "request-changes" : "comment";
            runReview(ev, ui.prActionInput.trim() || undefined);
          } else if (k === "\x7f" || k === "\b") {
            ui.prActionInput = ui.prActionInput.slice(0, -1);
          } else if (k.length > 0 && ![...k].some((ch) => ch.charCodeAt(0) < 0x20)) {
            ui.prActionInput += k;
          } else {
            return;
          }
          return draw();
        }

        if (ui.prStage === "done") {
          if (ESC || ENTER) ui.picker = "";
          return draw();
        }

        // error stage: r restarts at the picker, Esc closes
        if (k === "r" || k === "R") { ui.prStage = "pick"; ui.prError = ""; }
        else if (ESC) ui.picker = "";
        else return;
        return draw();
      }


      // Cockpit: input-bar mode. Printable keys type into ui.input, so the
      // global quit/refresh letters below must NOT fire here.
      if (ui.cockpit) {
        const tabs = cockpitTabs(states, registry);
        let focus = tabs.find((t) => t.id === ui.focus);
        if (!focus && tabs.length) {
          focus = tabs[0];
          ui.focus = focus.id;
        }
        if (k === "\x03") return quit(); // Ctrl-C still quits

        // Lower area: navigating the "offene Fragen" list.
        if (ui.cockpitArea === "list") {
          if (k === "\t" || ESC) {
            ui.cockpitArea = "input";
          } else if (UP) {
            ui.listSel = Math.max(0, ui.listSel - 1);
          } else if (DOWN) {
            ui.listSel = Math.min(tabs.length - 1, ui.listSel + 1);
          } else if (ENTER) {
            const t = tabs[Math.min(ui.listSel, tabs.length - 1)];
            if (t) {
              ui.focus = t.id; // make it the active session up top
              ui.input = "";
            }
            ui.cockpitArea = "input";
          } else {
            return;
          }
          return draw();
        }

        // Upper area: input bar.
        if (ESC) {
          ui.cockpit = false;
          ui.input = "";
          ui.cockpitArea = "input";
          ui.pendingImages = [];
          if (ui.fromCommander) { ui.commander = true; ui.fromCommander = false; } // back to the Commander
        } else if (k === "\t") {
          // jump down into the open-questions list
          ui.cockpitArea = "list";
          ui.listSel = Math.max(0, tabs.findIndex((t) => t.id === ui.focus));
        } else if (k === "\x16") {
          // Ctrl-V: attach an image from the clipboard (sent with the next message)
          const img = readClipboardImage();
          if (img) ui.pendingImages.push(img);
        } else if (ENTER) {
          const imgs = ui.pendingImages;
          if (focus?.kind === "agent") {
            if (ui.input.trim() || imgs.length) {
              focus.agent.send(ui.input, imgs);
              ui.input = "";
              ui.pendingImages = [];
            }
          } else if (focus?.kind === "waiting") {
            // re-enter the session (reuse existing agent, else take it over), then send
            const lid = enterSession(focus.def, focus.ss.sessionId, focus.ss.cwd || process.env.HOME || ".", focus.ss.pid);
            const a = registry.get(lid);
            ui.focus = `a:${lid}`;
            if (a && (ui.input.trim() || imgs.length)) {
              a.send(ui.input, imgs);
              ui.input = "";
              ui.pendingImages = [];
            }
          }
        } else if (k === "\x7f" || k === "\b") {
          // backspace: delete a char, or (on empty input) pop the last attached image
          if (!ui.input && ui.pendingImages.length) ui.pendingImages.pop();
          else ui.input = ui.input.slice(0, -1);
        } else if (k === "\x0e") {
          // Ctrl-N: pick a working folder, then launch a fresh agent
          const key = focus?.kind === "agent" ? focus.agent.opts.instanceKey : focus?.def?.key;
          const def = instances.find((d) => d.key === key) ?? instances[ui.sel] ?? instances[0];
          openPicker(def);
        } else if (k === "\x12") {
          // Ctrl-R: restart focused agent (picks up new plugins/MCP, keeps convo)
          if (focus?.kind === "agent") ui.focus = `a:${registry.restart(focus.agent).launchId}`;
        } else if (k === "\x0b") {
          // Ctrl-K: kill focused agent
          if (focus?.kind === "agent") focus.agent.kill();
        } else if (k.length > 0 && ![...k].some((c) => c.charCodeAt(0) < 0x20)) {
          ui.input += k; // printable text (incl. paste)
        } else {
          return;
        }
        return draw();
      }

      // Rename a session (modal text input — captures every key incl. q).
      if (ui.renaming) {
        if (k === "\x03") return quit();
        if (ESC) {
          ui.renaming = "";
          ui.input = "";
        } else if (ENTER) {
          registry.rename(ui.renaming, ui.input.trim());
          ui.renaming = "";
          ui.input = "";
        } else if (k === "\x7f" || k === "\b") {
          ui.input = ui.input.slice(0, -1);
        } else if (k.length > 0 && ![...k].some((c) => c.charCodeAt(0) < 0x20)) {
          ui.input += k;
        } else {
          return;
        }
        return draw();
      }

      if (k === "q" || k === "\x03") return quit(); // q / Ctrl-C
      if (k === "L") { toggleLocale(); return draw(); } // flip DE ↔ EN (persisted)

      if (ui.transcript) {
        if (UP) ui.scroll += 1; // older
        else if (DOWN) ui.scroll = Math.max(0, ui.scroll - 1); // newer
        else if (PGUP) ui.scroll += page;
        else if (PGDN) ui.scroll = Math.max(0, ui.scroll - page);
        else if (LEFT || ESC) ui.transcript = false;
        else if (k === "r") doRefresh(Date.now());
        else return;
      } else if (ui.expanded) {
        if (UP) ui.sessSel = Math.max(0, ui.sessSel - 1);
        else if (DOWN) ui.sessSel += 1; // clamped in render
        else if (RIGHT || ENTER) {
          ui.transcript = true; // open session transcript
          ui.scroll = 0;
        } else if (LEFT || ESC) ui.expanded = false;
        else if (k === "r") doRefresh(Date.now());
        else return;
      } else {
        // grid: three regions (① cards / ② live / ③ questions); Tab or 1-3 switch
        if (k === "\t") {
          ui.gridRegion = ui.gridRegion === "cards" ? "live" : ui.gridRegion === "live" ? "questions" : "cards";
          ui.listSel = 0;
          ui.closeArm = "";
        } else if (k === "1") {
          if (ui.gridRegion === "cards") ui.collapsed.cards = !ui.collapsed.cards;
          else ui.gridRegion = "cards";
          ui.closeArm = "";
        } else if (k === "2") {
          if (ui.gridRegion === "live") ui.collapsed.live = !ui.collapsed.live;
          else ui.gridRegion = "live";
          ui.closeArm = "";
        } else if (k === "3") {
          if (ui.gridRegion === "questions") ui.collapsed.questions = !ui.collapsed.questions;
          else { ui.gridRegion = "questions"; ui.listSel = 0; }
          ui.closeArm = "";
        } else if (ui.gridRegion === "questions" && (k === "x" || k === "X")) {
          // close a session: first x arms, second x terminates (if running) + hides it
          const qs = closeableSessions(states);
          const w = qs[Math.min(ui.listSel, qs.length - 1)];
          if (w) {
            if (ui.closeArm === w.ss.sessionId) {
              if (w.ss.pid) {
                try { process.kill(w.ss.pid, "SIGTERM"); } catch { /* already gone */ }
              }
              dismissSession(w.ss.sessionId); // hide immediately (covers stale too)
              ui.closeArm = "";
              doRefresh(Date.now());
            } else {
              ui.closeArm = w.ss.sessionId; // arm; press x again to confirm
            }
          }
        } else if (ui.gridRegion === "questions" && (k === "e" || k === "E")) {
          // rename the selected session
          const qs = closeableSessions(states);
          const w = qs[Math.min(ui.listSel, qs.length - 1)];
          if (w) {
            ui.renaming = w.ss.sessionId;
            ui.input = registry.nameOverride(w.ss.sessionId) ?? w.ss.title ?? "";
          }
        } else if (ui.gridRegion === "questions" && UP) {
          ui.closeArm = "";
          ui.listSel = Math.max(0, ui.listSel - 1);
        } else if (ui.gridRegion === "questions" && DOWN) {
          ui.closeArm = "";
          ui.listSel = Math.min(Math.max(0, closeableSessions(states).length - 1), ui.listSel + 1);
        } else if (ui.gridRegion === "questions" && (RIGHT || ENTER)) {
          ui.closeArm = "";
          const qs = closeableSessions(states);
          const w = qs[Math.min(ui.listSel, qs.length - 1)];
          if (w) {
            // re-enter the session (reuse existing agent, else take it over) → cockpit
            ui.focus = `a:${enterSession(w.def, w.ss.sessionId, w.ss.cwd || process.env.HOME || ".", w.ss.pid)}`;
            ui.cockpit = true;
            ui.cockpitArea = "input";
          }
        } else if (UP) {
          ui.sel = (ui.sel - 1 + n) % n;
        } else if (DOWN) {
          ui.sel = (ui.sel + 1) % n;
        } else if (RIGHT || ENTER) {
          ui.expanded = true;
          ui.sessSel = 0;
        } else if (k === "c") {
          ui.cockpit = true; // open the agent cockpit
          ui.cockpitArea = "input";
        } else if (k === "n") {
          openWizard(); // 2-pane modal: instance (with load) | working-folder
        } else if (k === "i") {
          openIssue(); // quick-issue: pick repo + describe → draft on a free instance
        } else if (k === "P") {
          openPr(); // capital P → PR-review (lowercase p is the theme picker)
        } else if (k === "p") {
          themeOrig = getTheme().name; // live theme picker (preview + persist)
          ui.themeSel = themeIndex();
          ui.themePicker = true;
        } else if (k === "h") {
          openCommander(); // multi-host Commander (hosts → files → control)
        } else if (k === "N") {
          openPicker(states[ui.sel].def); // quick-launch on the selected instance
        } else if (k === "A") {
          const started = registry.startAll(instances, cwdFor);
          const f = started[0] ?? registry.list()[0];
          if (f) ui.focus = `a:${f.launchId}`;
          ui.cockpit = true;
        } else if (k === "r") doRefresh(Date.now());
        else return;
      }
      draw(); // immediate feedback, don't wait for the tick
    });
  }
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);

  let lastW = -1;
  let lastH = -1;
  const draw = () => {
    const now = Date.now();
    if (now - lastRefresh >= REFRESH_MS) doRefresh(now);
    const w = termWidth();
    const h = process.stdout.rows || 0;
    let prefix = "\x1b[H";
    if (w !== lastW || h !== lastH) {
      prefix = "\x1b[2J\x1b[H"; // full clear on resize to avoid artifacts
      lastW = w;
      lastH = h;
    }
    // \x1b[K after every line clears trailing chars (no ghosting);
    // \x1b[0J wipes any leftover lines below the frame.
    const frameStr = render(states, frame, now, w, ui, h, registry).join("\x1b[K\n") + "\x1b[K\x1b[0J";
    process.stdout.write(prefix + frameStr);
    frame++;
  };

  let timer = setInterval(draw, FRAME_MS);

  /**
   * Shell-out: suspend the TUI, hand the terminal to a real interactive process
   * (ssh -t / tmux attach / claude --resume), and re-enter cleanly on exit. This
   * is what makes the Commander a full iTerm replacement.
   */
  const shellOut = (argv: string[]): void => {
    clearInterval(timer);
    process.stdout.write(leave); // show cursor, leave alt screen
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    try {
      Bun.spawnSync(argv, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    } catch {
      /* spawn failed — fall through to re-enter */
    }
    process.stdout.write(enter); // back to alt screen, hide cursor
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
    }
    lastW = -1; // force a full clear on the next draw
    timer = setInterval(draw, FRAME_MS);
    draw();
  };

  commanderHome(); // mc/nc-style two-pane Commander is the default view (F4 → dashboard)
  draw();
}

loadLocale(); // resolve locale once: CD_LANG env > persisted config > $LANG detect
loadTheme(); // resolve theme once: CD_THEME env > persisted config > Atelier default

if (args.has("--json")) {
  await runJson();
} else if (args.has("--once")) {
  runOnce();
} else {
  runLoop();
}
