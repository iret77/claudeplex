#!/usr/bin/env bun
import { collectAll, dismissSession, instanceFolders, type InstanceState } from "./collect.ts";
import {
  render, recentCwds, waitingSessions, closeableSessions, cockpitTabs,
  wizardFolders, wizardOrderedInstances, issueRepos, emptyPane, type UIState,
} from "./render.ts";
import { updateStates, type Transition } from "./tracker.ts";
import { AgentRegistry } from "./agents.ts";
import { BUDGET_5H, BUDGET_WEEK, type InstanceDef } from "./instances.ts";
import { discoverInstances } from "./discover.ts";
import { dirSuggestions, expandTilde, isDir } from "./paths.ts";
import { readClipboardImage } from "./clipboard.ts";
import { loadLocale, toggleLocale, t, stateLabel } from "./i18n.ts";
import { loadTheme, previewTheme, setTheme, themeIndex, getTheme, THEMES } from "./theme.ts";
import { remoteSnapshot, launchRcServer, stopRcServer, fetchRemoteFleet, tmuxName } from "./remote.ts";
import { discoverHosts, isLocal, type Host } from "./hosts.ts";
import { listDir, resolveHome, pathJoin, shellOutArgv, copyEntry } from "./ssh.ts";
import { pickFreeInstance, draftIssue, createIssue, splitDraft, isError } from "./issue.ts";

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
    commander: false, cmdLevel: "hosts", cmdHosts: [], cmdHostSel: 0, cmdActive: 0,
    cmdPanes: [emptyPane(), emptyPane()], cmdRemote: null, cmdFeedback: "",
    issueStage: "pick", issuePane: "folder", issueFolderSel: 0, issueInput: "", issueFeedback: "",
    issueDraft: "", issueScroll: 0, issueRepo: "", issueInstance: "", issueUrl: "", issueError: "",
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

  // ── Commander (multi-host) ──
  const cmdTokens = [0, 0]; // per-pane stale-async guards

  /** Open the Commander; resolve the host list once. Return to files if a pane is set. */
  const openCommander = (): void => {
    ui.commander = true;
    ui.cmdHosts = discoverHosts();
    ui.cmdHostSel = 0;
    ui.cmdFeedback = "";
    ui.cmdLevel = ui.cmdPanes.some((p) => p.host) ? "files" : "hosts";
  };

  /** The Host object backing a pane. */
  const cmdHostOf = (p: { host: string }): Host | undefined => ui.cmdHosts.find((h) => h.name === p.host);

  /** Refresh the fleet/governor for the active host: local = live snapshot, remote = ssh --json. */
  const refreshFleet = (host: Host): void => {
    if (isLocal(host)) {
      ui.cmdRemote = remoteSnapshot(instances);
      return;
    }
    void fetchRemoteFleet(host).then((snap) => {
      const active = ui.cmdPanes[ui.cmdActive];
      if (ui.commander && active.host === host.name) {
        ui.cmdRemote = snap;
        draw();
      }
    });
  };

  /** Fetch (async) the listing of `path` on a host into pane `idx`; ignores stale results. */
  const fetchListing = (idx: number, host: Host, path: string): void => {
    const p = ui.cmdPanes[idx];
    p.loading = true;
    p.error = "";
    p.path = path;
    p.sel = 0;
    if (idx === ui.cmdActive) refreshFleet(host);
    const token = ++cmdTokens[idx];
    void listDir(host, path).then(
      (entries) => {
        if (token !== cmdTokens[idx] || !ui.commander) return;
        p.entries = entries;
        p.loading = false;
        draw();
      },
      (e) => {
        if (token !== cmdTokens[idx] || !ui.commander) return;
        p.entries = [];
        p.loading = false;
        p.error = String(e?.message ?? e);
        draw();
      },
    );
  };

  /** Enter a host into the ACTIVE pane: resolve its home (absolute), then list it. */
  const enterHost = (h: Host): void => {
    const idx = ui.cmdActive;
    const p = ui.cmdPanes[idx];
    p.host = h.name;
    p.entries = [];
    p.loading = true;
    ui.cmdLevel = "files";
    ui.cmdFeedback = "";
    const token = ++cmdTokens[idx];
    void resolveHome(h).then((home) => {
      if (token !== cmdTokens[idx] || !ui.commander) return;
      fetchListing(idx, h, home);
    });
  };

  const doRefresh = (t: number) => {
    states = collectAll(instances, t);
    lastRefresh = t;
    notifyTransitions(updateStates(states, t));
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
      if (ui.commander) {
        if (k === "\x03") return quit();
        if (ui.cmdLevel === "hosts") {
          const hosts = ui.cmdHosts;
          if (ESC) {
            if (ui.cmdPanes.some((p) => p.host)) ui.cmdLevel = "files"; // a pane is set → back
            else ui.commander = false;
          } else if (UP) ui.cmdHostSel = Math.max(0, ui.cmdHostSel - 1);
          else if (DOWN) ui.cmdHostSel = Math.min(Math.max(0, hosts.length - 1), ui.cmdHostSel + 1);
          else if (ENTER || RIGHT) {
            const h = hosts[Math.min(ui.cmdHostSel, Math.max(0, hosts.length - 1))];
            if (h) enterHost(h);
          } else return;
          return draw();
        }
        // files level — operate on the ACTIVE pane
        const ai = ui.cmdActive;
        const p = ui.cmdPanes[ai];
        const other = ui.cmdPanes[ai === 0 ? 1 : 0];
        const host = cmdHostOf(p);
        const rcOpts = () => {
          const local = host ? isLocal(host) : false;
          const def = local ? instances[ui.sel] ?? instances[0] : undefined;
          return { key: def?.key ?? "default", configDir: def?.configDir, isDefault: def?.isDefault };
        };
        const count = p.entries.length + 1; // +1 for the ".." row
        const sel = Math.min(Math.max(0, p.sel), count - 1);
        if (ESC) {
          ui.cmdLevel = "hosts"; // re-pick the active pane's host
          ui.cmdFeedback = "";
        } else if (k === "\t") {
          ui.cmdActive = ai === 0 ? 1 : 0;
          ui.cmdFeedback = "";
          const np = ui.cmdPanes[ui.cmdActive];
          const nh = cmdHostOf(np);
          if (np.host && nh) refreshFleet(nh);
          else ui.cmdLevel = "hosts"; // empty pane → pick a host for it
        } else if (UP) {
          p.sel = Math.max(0, sel - 1);
        } else if (DOWN) {
          p.sel = Math.min(count - 1, sel + 1);
        } else if (LEFT) {
          if (host) fetchListing(ai, host, pathJoin(p.path, ".."));
        } else if (ENTER || RIGHT) {
          if (host) {
            if (sel === 0) fetchListing(ai, host, pathJoin(p.path, ".."));
            else {
              const e = p.entries[sel - 1];
              if (e && e.type === "dir") fetchListing(ai, host, pathJoin(p.path, e.name));
            }
          }
        } else if (k === "c") {
          // copy the active pane's selection → the OTHER pane's dir (host↔host, no scp)
          const otherHost = cmdHostOf(other);
          if (host && otherHost && other.host && sel > 0) {
            const e = p.entries[sel - 1];
            if (e) {
              const srcPath = pathJoin(p.path, e.name);
              const dstPath = other.path;
              const oi = ai === 0 ? 1 : 0;
              ui.cmdFeedback = t("cmdCopying");
              void copyEntry({ host, path: srcPath }, { host: otherHost, path: dstPath }).then((r) => {
                if (!ui.commander) return;
                ui.cmdFeedback = r.ok ? `✓ ${e.name} → ${other.host}` : `error: ${r.error}`;
                if (r.ok) fetchListing(oi, otherHost, dstPath); // refresh dest to show the copy
                else draw();
              });
            }
          } else if (!other.host) {
            ui.cmdFeedback = `${t("cmdPickHost")} → ${t("cmdSwitch")} (Tab)`;
          }
        } else if (k === "s") {
          if (host) shellOut(shellOutArgv(host, { cwd: p.path }));
        } else if (k === "L") {
          if (host) {
            const cwd = p.path;
            ui.cmdFeedback = t("cmdLaunching");
            void launchRcServer(host, cwd, { spawn: "worktree", ...rcOpts() }).then((r) => {
              if (!ui.commander) return;
              ui.cmdFeedback = r.ok ? `${r.reused ? "running" : "✓ launched"} @ ${cwd}` : `error: ${r.error}`;
              refreshFleet(host);
              draw();
            });
          }
        } else if (k === "K") {
          if (host) {
            const cwd = p.path;
            ui.cmdFeedback = "stopping…";
            void stopRcServer(host, rcOpts().key, cwd).then((ok) => {
              if (!ui.commander) return;
              ui.cmdFeedback = ok ? `✓ stopped @ ${cwd}` : "no server here";
              refreshFleet(host);
              draw();
            });
          }
        } else if (k === "a") {
          if (host) shellOut(shellOutArgv(host, { tmux: tmuxName(rcOpts().key, p.path) }));
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
