import type { InstanceState, SessionSummary, Status } from "./collect.ts";
import { readTranscript, allFolders, instanceFolders, type TLine, type FolderUsage } from "./collect.ts";
import { BUDGET_5H, BUDGET_WEEK } from "./instances.ts";
import { formatCost, formatDuration, formatTokens, type WindowTotals } from "./usage.ts";
import {
  RESET, BOLD, DIM, fg, bg, rgb, vwidth, pad, trunc, center, rule, meter, heat, overlayBox,
} from "./ui.ts";
import { isFlashing, type SessState } from "./tracker.ts";
import type { AgentRegistry } from "./agents.ts";
import type { ManagedAgent, AgentLine } from "./agent.ts";
import { dirSuggestions, expandTilde, isDir } from "./paths.ts";
import { renderMarkdown } from "./markdown.ts";
import { t, stateLabel, localeTag } from "./i18n.ts";
import { repoSlug, repoLabel, repoParts } from "./git.ts";
import { homedir } from "node:os";

const HOME = homedir();
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const STREAM = ["⟩  ", "⟩⟩ ", "⟩⟩⟩", " ⟩⟩", "  ⟩"];

const STATUS_COLOR: Record<Status, number> = {
  WORKING: 46, LIVE: 51, IDLE: 244, OFFLINE: 240,
};
const STATUS_DOT: Record<Status, string> = {
  WORKING: "", LIVE: "●", IDLE: "○", OFFLINE: "·",
};

const MIN_CARD = 54;
const TRANSCRIPT_LINES = 200;

function tilde(p: string): string {
  return p.startsWith(HOME) ? "~" + p.slice(HOME.length) : p;
}
function dirName(p: string): string {
  const seg = p.replace(/\/+$/, "").split("/").pop() || p;
  return seg || "~";
}
/** Tilde'd path fit to a column width, keeping the informative tail. */
function pathCol(p: string, w: number): string {
  const t = tilde(p);
  if (vwidth(t) <= w) return t;
  const cp = [...t];
  return "…" + cp.slice(cp.length - (w - 1)).join("");
}
function timeAgo(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
function actIcon(k: SessionSummary["activityKind"]): string {
  return k === "tool" ? "🔧" : k === "text" ? "💬" : k === "user" ? "🧑" : "·";
}
function planChip(plan: string): string {
  if (!plan) return "";
  const c = /max/i.test(plan) ? 170 : 39; // Max=violet, team=blue
  return `${bg(c)}${fg(231)}${BOLD} ${plan} ${RESET}`;
}

/** Right-align `right` after `left` within `width` (space filler). */
function spread(left: string, right: string, width: number): string {
  const inner = Math.max(0, width - vwidth(right));
  return pad(left, inner) + right;
}

function statTrail(t: WindowTotals, withMsg: boolean): string {
  return (
    `${formatTokens(t.work)}` +
    (withMsg ? ` ${DIM}·${RESET} ${t.messages}m` : "") +
    ` ${DIM}·${RESET} ${formatCost(t.cost)}`
  );
}

function loadRow(
  tag: string, t: WindowTotals, budget: number, innerW: number, withMsg: boolean,
  resetAt: number, now: number,
): string {
  const pct = t.work / budget;
  const c = heat(pct);
  const rest = resetAt > now ? ` ${DIM}↻ ${formatDuration(resetAt - now)}${RESET}` : "";
  const trail = ` ${fg(c)}${BOLD}${String(Math.round(pct * 100)).padStart(3)}%${RESET} ${DIM}${statTrail(t, withMsg)}${RESET}${rest}`;
  const barW = Math.max(8, innerW - 4 - vwidth(trail));
  return `${DIM}${tag}${RESET} ${meter(pct, barW, c)}${trail}`;
}

interface Vis { color: number; glyph: string; }
function visual(state: SessState): Vis {
  if (state === "aktiv") return { color: 46, glyph: "◆" };
  if (state === "monitor") return { color: 39, glyph: "◑" };
  if (state === "wartet") return { color: 220, glyph: "◐" };
  return { color: 245, glyph: "○" };
}

const CTX_MAX_ENV = Number(process.env.CD_CTX_MAX ?? 0);
function ctxMaxFor(model: string, observed: number): number {
  if (CTX_MAX_ENV > 0) return CTX_MAX_ENV;
  const base = /opus|sonnet/i.test(model) ? 1_000_000 : 200_000; // 1M beta for opus/sonnet
  return Math.max(base, Math.ceil(observed / 100_000) * 100_000); // never exceed 100%
}
function prettyModel(m: string): string {
  if (!m || m === "<synthetic>") return "";
  const mm = m.match(/(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/i);
  if (!mm) return m;
  const fam = mm[1][0].toUpperCase() + mm[1].slice(1);
  return mm[3] !== undefined ? `${fam} ${mm[2]}.${mm[3]}` : `${fam} ${mm[2]}`;
}
function modelFamily(m: string): string {
  const mm = m.match(/(opus|sonnet|haiku|fable)/i);
  return mm ? mm[1][0].toUpperCase() + mm[1].slice(1) : "";
}
function modelColor(m: string): number {
  if (/opus/i.test(m)) return 170;
  if (/sonnet/i.test(m)) return 39;
  if (/haiku/i.test(m)) return 78;
  if (/fable/i.test(m)) return 213;
  return 245;
}
function ctxColor(pct: number): number {
  return pct >= 0.85 ? 196 : pct >= 0.6 ? 214 : 46; // green / orange / red
}
/** Compact inline cluster: context % (colored) · model family · thinking. */
function ctxModelSuffix(ss: SessionSummary): string {
  const parts: string[] = [];
  if (ss.bgShells > 0) parts.push(`${fg(45)}⚙${ss.bgShells}${RESET}`);
  else if (ss.bg) parts.push(`${fg(45)}⚙${RESET}`);
  if (ss.ctxTokens > 0) {
    const pct = ss.ctxTokens / ctxMaxFor(ss.model, ss.ctxTokens);
    parts.push(`${fg(ctxColor(pct))}${Math.round(pct * 100)}%${RESET}`);
  }
  const fam = modelFamily(ss.model);
  if (fam) parts.push(`${fg(modelColor(ss.model))}${fam}${RESET}`);
  let s = parts.join(` ${DIM}·${RESET} `);
  if (ss.thinking) s += `${DIM} 🧠${RESET}`;
  return s;
}

interface FolderGroup { full: string; sessions: SessionSummary[]; }

/** Group sessions by cwd; most-recently-active folder first, newest within. */
function groupByFolder(sessions: SessionSummary[]): FolderGroup[] {
  const map = new Map<string, SessionSummary[]>();
  for (const s of sessions) {
    const key = s.cwd || "?";
    let arr = map.get(key);
    if (!arr) {
      arr = [];
      map.set(key, arr);
    }
    arr.push(s);
  }
  const groups = [...map.entries()].map(([full, ss]) => ({ full, sessions: ss }));
  for (const g of groups) g.sessions.sort((a, b) => b.lastTs - a.lastTs);
  groups.sort((a, b) => b.sessions[0].lastTs - a.sessions[0].lastTs);
  return groups;
}

/** Sessions for the detail/transcript views: shown window, grouped + flattened. */
function detailSessions(s: InstanceState): { groups: FolderGroup[]; flat: SessionSummary[] } {
  const groups = groupByFolder(s.sessions);
  return { groups, flat: groups.flatMap((g) => g.sessions) };
}

/** One session line: flash marker + state badge + name, age right-aligned. */
function sessionRow(ss: SessionSummary, w: number, frame: number, now: number, indent: number): string {
  const age = now - ss.lastTs;
  const state = ss.state;
  const v = visual(state);
  const glyph = state === "aktiv" ? SPINNER[frame % SPINNER.length] : v.glyph;
  const badge = `${fg(v.color)}${glyph} ${stateLabel(state).padEnd(7)}${RESET}`;
  const name = ss.title
    ? `${BOLD}${ss.title}${RESET}`
    : ss.cwd ? `${DIM}~${dirName(ss.cwd)}${RESET}` : `${DIM}${t("untitled")}${RESET}`;
  const flashing = isFlashing(ss.sessionId, now);
  const blink = flashing && Math.floor(frame / 2) % 2 === 0;
  const mark = blink ? `${fg(231)}▌${RESET}` : flashing ? `${fg(v.color)}▌${RESET}` : " ";
  const suffix = ctxModelSuffix(ss);
  const right = `${suffix ? suffix + "  " : ""}${DIM}${timeAgo(age)}${RESET}`;
  const body = spread(`${badge} ${name}`, right, w - indent - 2);
  return `${" ".repeat(indent)}${mark} ${body}`;
}

const SESS_CAP = 26;

function sessionLines(s: InstanceState, w: number, frame: number, now: number): string[] {
  const out: string[] = [];
  const accent = s.def.color;
  const shown = s.sessions;
  if (!shown.length) {
    out.push(`${DIM}${t("noSessions")}${RESET}`);
    return out;
  }
  const liveN = shown.filter((x) => x.live).length;
  const workN = shown.filter((x) => x.working).length;
  const staleN = shown.length - liveN;
  const groups = groupByFolder(shown);
  out.push(
    `${fg(accent)}▸${RESET} ${BOLD}${liveN} ${t("running")}${RESET} ${DIM}(${workN} ${t("active")})${RESET}` +
    (staleN ? `  ${DIM}· ${staleN} ${t("recent")}${RESET}` : "") +
    `  ${DIM}·${RESET} ${fg(accent)}${groups.length} ${t("folders")}${RESET}`,
  );
  let count = 0;
  for (const g of groups) {
    if (count >= SESS_CAP) break;
    out.push(` ${fg(accent)}📁 ${dirName(g.full)}${RESET} ${DIM}(${g.sessions.length})${RESET}`);
    for (const ss of g.sessions) {
      if (count >= SESS_CAP) break;
      out.push(sessionRow(ss, w, frame, now, 3));
      count++;
    }
  }
  if (shown.length > count) out.push(`${DIM}  … +${shown.length - count} ${t("further")}${RESET}`);
  return out;
}

function cardContent(s: InstanceState, innerW: number, frame: number, now: number): string[] {
  const a = s.account;
  const lines: string[] = [];
  lines.push(spread(`👤 ${fg(s.def.color)}${BOLD}${a.login || "—"}${RESET}`, `${DIM}${a.email}${RESET}`, innerW));
  const meta = [a.role && `${DIM}${a.role}${RESET}`, a.org && `${DIM}🏢 ${a.org}${RESET}`].filter(Boolean).join(`  `);
  lines.push(`${planChip(a.plan)}  ${meta}`);
  lines.push("");
  for (const l of sessionLines(s, innerW, frame, now)) lines.push(l);
  lines.push("");
  lines.push(loadRow("5h", s.block5h, BUDGET_5H, innerW, true, s.reset5h, now));
  lines.push(loadRow("wk", s.week, BUDGET_WEEK, innerW, false, s.resetWk, now));
  return lines;
}

function boxCard(
  s: InstanceState, content: string[], innerW: number, frame: number, selected: boolean,
): string[] {
  const accent = s.def.color;
  const bcol = selected ? 231 : accent;
  const sc = STATUS_COLOR[s.status];
  const spin = s.status === "WORKING" ? SPINNER[frame % SPINNER.length] : STATUS_DOT[s.status];
  const mark = selected ? `${fg(231)}▌ ${RESET}` : "";
  const label = `${mark}${fg(accent)}${BOLD}${s.def.key}${RESET} ${fg(accent)}${s.def.label}${RESET}`;
  const badge = `${fg(sc)}${spin} ${BOLD}${s.status}${RESET}`;
  const B = (ch: string) => `${fg(bcol)}${selected ? BOLD : ""}${ch}${RESET}`;
  const top = B("╭") + rule(` ${label} `, ` ${badge} `, innerW, "─", bcol) + B("╮");
  const bottom = B("╰") + `${fg(bcol)}${"─".repeat(innerW)}${RESET}` + B("╯");
  const mids = content.map((l) => B("│") + " " + pad(l, innerW - 2) + " " + B("│"));
  return [top, ...mids, bottom];
}

function gridRow(cards: string[][], gap: number): string[] {
  const h = Math.max(...cards.map((c) => c.length));
  const rows: string[] = [];
  for (let i = 0; i < h; i++) {
    rows.push(cards.map((c) => c[i] ?? "").join(" ".repeat(gap)));
  }
  return rows;
}

function wrap(text: string, width: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && vwidth(`${cur} ${w}`) > width) {
      lines.push(cur);
      cur = w;
    } else {
      cur = cur ? `${cur} ${w}` : w;
    }
    if (lines.length >= maxLines) break;
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  return lines.length ? lines : ["—"];
}

function headerLines(states: InstanceState[], frame: number, now: number, W: number): string[] {
  const liveSess = states.reduce((a, s) => a + s.sessions.filter((x) => x.live).length, 0);
  const workingSess = states.reduce((a, s) => a + s.sessions.filter((x) => x.working).length, 0);
  const liveInst = states.filter((s) => s.running).length;
  const tok5h = states.reduce((a, s) => a + s.block5h.work, 0);
  const cost5h = states.reduce((a, s) => a + s.block5h.cost, 0);
  const clock = new Date(now).toLocaleTimeString(localeTag());
  const title = `${SPINNER[frame % SPINNER.length]} ${BOLD}${rgb(244, 114, 182)}CLAUDEPLEX${RESET} ${DIM}│${RESET} ${BOLD}MULTI-INSTANCE${RESET}`;
  const summary =
    `${fg(51)}${BOLD}${liveSess}${RESET} ${t("sessionsLive")}  ${fg(46)}●${RESET} ${workingSess} ${t("working")}  ` +
    `${DIM}│${RESET} ${liveInst}/${states.length} ${t("instances")}  ` +
    `${DIM}│${RESET} 5h ${BOLD}${formatTokens(tok5h)}${RESET} ${DIM}${t("tok")}${RESET} ${formatCost(cost5h)}  ` +
    `${DIM}│${RESET} ${fg(45)}${clock}${RESET}`;
  return [rule(`${title} `, ` ${summary}`, W, "━", 240), ""];
}

export interface UIState {
  sel: number; // selected instance index
  expanded: boolean; // detail view open
  sessSel: number; // selected session within detail
  transcript: boolean; // session transcript view open
  scroll: number; // scroll offset from bottom in transcript
  // cockpit: drive a managed agent (input → session → live stream)
  cockpit: boolean; // cockpit overlay open
  focus: string; // active tab id: a:<launchId> | w:<sessionId>
  input: string; // input-bar buffer
  cockpitArea: "input" | "list"; // which cockpit pane has focus
  listSel: number; // selection in the lower "offene Fragen" list
  pendingImages: { mediaType: string; data: string }[]; // clipboard images to send with the next message
  // new-agent picker: "wizard" = 2-pane modal (instance | folder);
  // "cwd" = single folder picker for quick-launch on a known instance
  picker: "" | "cwd" | "wizard" | "issue"; // active picker ("" = none)
  pickerInput: string; // editable path buffer
  pickerSel: number; // highlighted folder-suggestion index
  pickerInstance: string; // instance key the agent will launch into
  pickerPane: "instance" | "cwd"; // which wizard pane has focus (left | right)
  pickerInstSel: number; // highlighted index in the wizard's LEFT pane
  pickerMode: "instance" | "folder"; // wizard orientation: instance→folder | folder→instance
  // grid: which of the three regions has focus (Tab / 1-3)
  gridRegion: "cards" | "live" | "questions";
  // grid: which regions are collapsed (double-press 1/2/3 to toggle)
  collapsed: { cards: boolean; live: boolean; questions: boolean };
  closeArm: string; // sessionId armed for close-confirm in the questions list
  renaming: string; // sessionId being renamed ("" = not renaming); buffer = input
  // quick-issue flow (picker === "issue")
  issueStage: "pick" | "drafting" | "review" | "rewrite" | "creating" | "done" | "error";
  issuePane: "folder" | "desc"; // which pick-stage pane has focus
  issueFolderSel: number; // highlighted repo/folder index
  issueInput: string; // "what's the issue about?" description buffer
  issueFeedback: string; // rewrite feedback buffer
  issueDraft: string; // current draft markdown (raw)
  issueScroll: number; // scroll offset in the review modal
  issueRepo: string; // chosen repo cwd
  issueInstance: string; // instance key chosen to draft
  issueUrl: string; // created issue URL (done stage)
  issueError: string; // error message (error stage)
}

/** Sessions across all instances whose turn ended and that await input. */
export interface WaitingSession {
  def: InstanceState["def"];
  ss: SessionSummary;
}
export function waitingSessions(states: InstanceState[]): WaitingSession[] {
  return states
    .flatMap((s) => s.sessions.filter((ss) => ss.state === "wartet").map((ss) => ({ def: s.def, ss })))
    .sort((a, b) => b.ss.lastTs - a.ss.lastTs);
}

/**
 * Sessions you can act on/close in region ③: waiting for input + stale. Sessions
 * that already have a live agent are KEPT in the list (marked "offen" by the
 * renderer) so they don't vanish when you enter them — re-entering reuses the
 * existing agent via dedup.
 */
export function closeableSessions(states: InstanceState[]): WaitingSession[] {
  const list = states.flatMap((s) =>
    s.sessions.filter((ss) => ss.state === "wartet" || ss.state === "stale").map((ss) => ({ def: s.def, ss })));
  const key = (w: WaitingSession) => repoSlug(w.ss.cwd) || dirName(w.ss.cwd);
  const groupTs = new Map<string, number>();
  for (const w of list) groupTs.set(key(w), Math.max(groupTs.get(key(w)) ?? 0, w.ss.lastTs));
  return list.sort((a, b) => {
    const ka = key(a), kb = key(b);
    if (ka !== kb) return (groupTs.get(kb)! - groupTs.get(ka)!) || ka.localeCompare(kb);
    return b.ss.lastTs - a.ss.lastTs;
  });
}

/** Live tail (last 5 lines) of each actively-working session, below the grid.
 *  Tools/results are progressively indented to show the call hierarchy. */
function liveOutputBlock(states: InstanceState[], W: number, focused = false, collapsed = false): string[] {
  const active = states.flatMap((s) => s.sessions.filter((x) => x.working).map((ss) => ({ s, ss })));
  const out: string[] = [""];
  const hcol = focused ? 231 : 46;
  out.push(rule(`${BOLD}${fg(hcol)}${collapsed ? "▸" : "▾"} ② LIVE OUTPUT${RESET} `, ` ${DIM}${active.length} ${t("active")}${RESET}`, W, "━", focused ? 231 : 240));
  if (collapsed) return out;
  if (!active.length) {
    out.push(`  ${DIM}${t("noSessionGenerating")}${RESET}`);
    return out;
  }
  const CAP = 6;
  for (const { s, ss } of active.slice(0, CAP)) {
    out.push("");
    const head =
      `${fg(s.def.color)}▶ ${BOLD}${s.def.key}${RESET} ${fg(s.def.color)}${ss.title || dirName(ss.cwd)}${RESET}` +
      `  ${DIM}${dirName(ss.cwd)}${RESET}`;
    out.push(trunc(head, W));
    const segs = ss.path ? readTranscript(ss.path).slice(-5) : [];
    if (!segs.length) {
      out.push(`    ${DIM}—${RESET}`);
      continue;
    }
    for (const seg of segs) {
      let indent: number;
      let prefix: string;
      let color: string;
      if (seg.role === "tool") {
        indent = 6;
        prefix = `${fg(214)}🔧${RESET}`;
        color = DIM;
      } else if (seg.role === "result") {
        indent = 8;
        prefix = `${DIM}⎿${RESET}`;
        color = DIM;
      } else if (seg.role === "user") {
        indent = 4;
        prefix = `${fg(51)}❯${RESET}`;
        color = "";
      } else {
        indent = 4;
        prefix = `${DIM}💬${RESET}`;
        color = "";
      }
      const flat = seg.text.replace(/\s+/g, " ");
      out.push(" ".repeat(indent) + prefix + " " + trunc(`${color}${flat}${color ? RESET : ""}`, W - indent - 3));
    }
  }
  if (active.length > CAP) out.push(`${DIM}  … +${active.length - CAP} ${t("further")} ${t("active")} Sessions${RESET}`);
  return out;
}

function renderGrid(
  states: InstanceState[], frame: number, now: number, W: number, ui: UIState, height: number, registry?: AgentRegistry,
): string[] {
  const cols = W >= 2 * MIN_CARD + 6 ? 2 : 1;
  const gap = 3;
  const outer = Math.floor((W - (cols - 1) * gap) / cols);
  const innerW = outer - 2;

  const contents = states.map((s) => cardContent(s, innerW - 2, frame, now));
  const maxH = Math.max(...contents.map((c) => c.length));
  const padded = contents.map((c) => [...c, ...Array(maxH - c.length).fill("")]);
  const cards = states.map((s, i) => boxCard(s, padded[i], innerW, frame, i === ui.sel));

  const region = ui.gridRegion;
  const out = headerLines(states, frame, now, W);

  // region indicator: Tab / 1-3 switch focus between the three areas
  const chip = (num: string, label: string, on: boolean) =>
    on ? `${bg(238)}${fg(231)}${BOLD} ${num} ${label} ${RESET}` : `${DIM} ${num} ${label} ${RESET}`;
  out.push(
    `${chip("①", t("cards"), region === "cards")}  ${chip("②", "Live", region === "live")}  ` +
    `${chip("③", t("openQuestions"), region === "questions")}   ${DIM}${t("switchInstances1to3")} · 2× ▾/▸${RESET}`,
  );
  out.push("");

  if (ui.collapsed.cards) {
    const cells = states.map((s) => {
      const cnt = (st: string) => s.sessions.filter((x) => x.state === st).length;
      const a = cnt("aktiv"), m = cnt("monitor"), wt = cnt("wartet"), sl = cnt("stale");
      const bgN = s.sessions.filter((x) => x.bg || x.bgShells > 0).length;
      const ses = [a && `${fg(46)}◆${a}${RESET}`, m && `${fg(39)}◑${m}${RESET}`, wt && `${fg(220)}◐${wt}${RESET}`, sl && `${fg(245)}○${sl}${RESET}`, bgN && `${fg(45)}⚙${bgN}${RESET}`].filter(Boolean).join(" ");
      return `${fg(s.def.color)}${BOLD}${s.def.key}${RESET} ${fg(s.def.color)}${s.def.label}${RESET} ` +
        `${loadTag("5h", s.block5h.work, BUDGET_5H)} ${loadTag("wk", s.week.work, BUDGET_WEEK)}` +
        (ses ? `  ${ses}` : "");
    });
    out.push(`  ${region === "cards" ? fg(231) : DIM}▸ ① ${t("cards")}${RESET}   ${cells.join(`  ${DIM}│${RESET}  `)}`);
    out.push("");
  } else {
    for (let i = 0; i < cards.length; i += cols) {
      for (const line of gridRow(cards.slice(i, i + cols), gap)) out.push(line);
      out.push("");
    }
  }

  // ② live output
  for (const l of liveOutputBlock(states, W, region === "live", ui.collapsed.live)) out.push(l);

  // ③ waiting for input + stale — closeable sessions with last message
  const qs = closeableSessions(states);
  const qFocus = region === "questions";
  const ws = qs.filter((q) => q.ss.state === "wartet").length;
  const st = qs.length - ws;
  out.push("");
  out.push(rule(
    `${BOLD}${fg(qFocus ? 231 : 220)}${ui.collapsed.questions ? "▸" : "▾"} ③ WAITING / STALE${RESET} ${DIM}(${ws} ${stateLabel("wartet")} · ${st} stale)${RESET} `,
    qFocus ? ` ${DIM}↑/↓ ${t("select")} · ⏎ ${t("openVerb")} · e ${t("rename")} · x ${t("close")}${RESET} ` : "", W, "━", qFocus ? 231 : 240,
  ));
  if (!ui.collapsed.questions) {
  if (ui.renaming) {
    const caret = Math.floor(frame / 3) % 2 === 0 ? `${fg(231)}▏${RESET}` : " ";
    out.push(`  ${fg(213)}✎ ${t("renameLabel")}${RESET} ${ui.input}${caret}   ${DIM}${t("saveCancel")}${RESET}`);
  }
  if (!qs.length) out.push(`  ${DIM}${t("noSessions")}${RESET}`);
  const TW = 30; // title column width
  const WTW = 24; // worktree column width
  if (qs.length) {
    out.push(`  ${DIM}${pad("INST", 4)} ${pad("STATE", 7)} ${pad(t("colTitle"), TW)} ${pad("WORKTREE", WTW)} ${t("colLast")}${RESET}`);
  }
  const lsel = Math.min(Math.max(0, ui.listSel), Math.max(0, qs.length - 1));
  // group the closeable sessions by repo: a header per repo, sessions underneath
  const repoKeyOf = (w: WaitingSession) => repoSlug(w.ss.cwd) || dirName(w.ss.cwd);
  const grpCount = new Map<string, number>();
  for (const w of qs) grpCount.set(repoKeyOf(w), (grpCount.get(repoKeyOf(w)) ?? 0) + 1);
  const disp: { header?: string; count?: number; w?: WaitingSession; i?: number; spacer?: boolean }[] = [];
  let prevKey = "";
  qs.forEach((w, i) => {
    const k = repoKeyOf(w);
    if (k !== prevKey) { if (disp.length) disp.push({ spacer: true }); disp.push({ header: k, count: grpCount.get(k) }); prevKey = k; }
    disp.push({ w, i });
  });
  const qMax = Math.max(3, height - out.length - 5);
  const selDisp = Math.max(0, disp.findIndex((d) => d.i === lsel));
  const startD = Math.min(Math.max(0, selDisp - Math.floor(qMax / 2)), Math.max(0, disp.length - qMax));
  const view = disp.slice(startD, startD + qMax);
  const hiddenAbove = disp.slice(0, startD).filter((d) => d.w).length;
  if (hiddenAbove > 0) out.push(`  ${DIM}↑ ${hiddenAbove} ${t("further")}${RESET}`);
  view.forEach((d, vi) => {
    if (d.spacer) { if (vi > 0) out.push(""); return; }
    if (d.header !== undefined) {
      out.push(`  ${fg(74)}📦 ${d.header}${RESET} ${DIM}(${d.count})${RESET}`);
      return;
    }
    const w = d.w!, i = d.i!;
    const sel = qFocus && i === lsel;
    const armed = ui.closeArm === w.ss.sessionId;
    const open = !!registry?.forSession(w.ss.sessionId);
    const v = visual(w.ss.state);
    const marker = armed ? `${fg(196)}✗${RESET}` : sel ? `${fg(231)}▶${RESET}` : open ? `${fg(46)}●${RESET}` : " ";
    const inst = `${fg(w.def.color)}${pad(w.def.key, 4)}${RESET}`;
    const stateTag = open ? `${fg(46)}${pad(`✎ ${t("open")}`, 7)}${RESET}` : `${fg(v.color)}${pad(stateLabel(w.ss.state), 7)}${RESET}`;
    const titleRaw = registry?.nameOverride(w.ss.sessionId) ?? (w.ss.title || "~" + dirName(w.ss.cwd));
    const title = pad(`${sel ? `${BOLD}${fg(231)}` : fg(252)}${titleRaw}${RESET}`, TW);
    const wtCol = `${fg(108)}${pad(repoParts(w.ss.cwd).worktree, WTW)}${RESET}`;
    const last = (w.ss.activity || "").replace(/\s+/g, " ");
    const msg = armed ? `${fg(196)}${t("closeConfirm")}${RESET}` : `${DIM}${last}${RESET}`;
    out.push(trunc(`${marker} ${inst} ${stateTag} ${title} ${wtCol} ${msg}`, W));
  });
  const shown = view.filter((d) => d.w).length;
  const below = qs.length - hiddenAbove - shown;
  if (below > 0) out.push(`  ${DIM}↓ ${below} ${t("further")}${RESET}`);
  }

  out.push("");
  out.push(
    `${fg(46)}◆ ${stateLabel("aktiv")}${RESET} ${DIM}·${RESET} ${fg(39)}◑ ${stateLabel("monitor")}${RESET} ${DIM}·${RESET} ${fg(220)}◐ ${stateLabel("wartet")}${RESET} ${DIM}·${RESET} ${fg(245)}○ ${stateLabel("stale")}${RESET} ${DIM}·${RESET} ${fg(45)}⚙ background${RESET}`,
  );
  out.push(
    qFocus
      ? `${fg(231)}↑/↓${RESET}${DIM} ${t("question")}${RESET}  ${fg(231)}⏎${RESET}${DIM} ${t("answerCockpit")}${RESET}  ` +
        `${fg(231)}[x]${RESET}${DIM} ${t("closeSession")}${RESET}  ${fg(231)}Tab/1-3${RESET}${DIM} ${t("area")}${RESET}  ${DIM}[q] quit${RESET}`
      : `${fg(231)}↑/↓${RESET}${DIM} ${t("instance")}${RESET}  ${fg(231)}→/⏎${RESET}${DIM} Sessions${RESET}  ` +
        `${fg(231)}Tab/1-3${RESET}${DIM} ${t("area")}${RESET}  ${fg(231)}[c]${RESET}${DIM} Cockpit${RESET}  ${fg(231)}[i]${RESET}${DIM} Issue${RESET}  ` +
        `${fg(231)}[n]${RESET}${DIM} Agent${RESET}  ${fg(231)}[N]${RESET}${DIM} ${t("here")}${RESET}  ${fg(231)}[A]${RESET}${DIM} ${t("all")}${RESET}  ${DIM}[r/q]${RESET}`,
  );
  return out;
}

function renderDetail(states: InstanceState[], frame: number, now: number, W: number, ui: UIState): string[] {
  const s = states[ui.sel];
  const accent = s.def.color;
  const sc = STATUS_COLOR[s.status];
  const innerW = W - 2;
  const textW = innerW - 2;

  const { groups, flat } = detailSessions(s);
  const sel = Math.min(ui.sessSel, Math.max(0, flat.length - 1));

  const content: string[] = [];
  if (!flat.length) content.push(`${DIM}${t("noRealSessions")}${RESET}`);

  let idx = 0;
  for (const g of groups) {
    content.push(`${fg(accent)}📁 ${tilde(g.full) || "?"}${RESET}  ${DIM}(${g.sessions.length})${RESET}`);
    for (const ss of g.sessions) {
      const on = idx++ === sel;
      const state = ss.state;
      const v = visual(state);
      const glyph = state === "aktiv" ? SPINNER[frame % SPINNER.length] : v.glyph;
      const dot = `${fg(v.color)}${glyph}${RESET}`;
      const flashing = isFlashing(ss.sessionId, now);
      const blink = flashing && Math.floor(frame / 2) % 2 === 0;
      const marker = on
        ? `${fg(231)}▶${RESET}`
        : blink ? `${fg(231)}▌${RESET}` : flashing ? `${fg(v.color)}▌${RESET}` : " ";
      const nm = ss.cwd ? dirName(ss.cwd) : "";
      const title = ss.title
        ? `${BOLD}${fg(on ? 231 : 252)}${ss.title}${RESET}`
        : nm ? `${DIM}~${nm}${RESET}` : `${DIM}${t("untitled")}${RESET}`;
      const ago = `${DIM}${timeAgo(now - ss.lastTs)}${RESET}`;
      const tag = `${fg(v.color)}${stateLabel(state)}${RESET}`;
      content.push("  " + spread(`${marker} ${dot} ${title}`, `${tag}  ${ago}`, textW - 2));
      if (on) {
        const where = `${fg(accent)}📂${RESET} ${tilde(ss.cwd) || "?"}${ss.gitBranch ? `   ${DIM}⌥ ${ss.gitBranch}${RESET}` : ""}`;
        content.push("      " + trunc(where, textW - 6));
        const cmax = ctxMaxFor(ss.model, ss.ctxTokens);
        const cpct = ss.ctxTokens ? ss.ctxTokens / cmax : 0;
        const ctxStr = ss.ctxTokens
          ? `${fg(accent)}📊${RESET} Context ${fg(ctxColor(cpct))}${formatTokens(ss.ctxTokens)}/${formatTokens(cmax)} (${Math.round(cpct * 100)}%)${RESET}`
          : `${fg(accent)}📊${RESET} ${DIM}Context —${RESET}`;
        const mdlStr = ss.model ? `  ${DIM}·${RESET} ${fg(modelColor(ss.model))}${prettyModel(ss.model)}${RESET}` : "";
        const thinkStr = ss.thinking ? `  ${DIM}·${RESET} 🧠 ${DIM}Thinking${RESET}` : "";
        const bgStr = ss.bgShells ? `  ${DIM}·${RESET} ${fg(45)}⚙ ${ss.bgShells} bg${RESET}` : ss.bg ? `  ${DIM}·${RESET} ${fg(45)}⚙ background${RESET}` : "";
        content.push("      " + trunc(`${ctxStr}${mdlStr}${thinkStr}${bgStr}`, textW - 6));
        content.push(`      ${DIM}id ${ss.sessionId.slice(0, 8)}${RESET}`);
        const arrow = ss.working ? `${fg(sc)}${STREAM[frame % STREAM.length]}${RESET}` : `${DIM}⟩${RESET}`;
        const lines = wrap(ss.activity || "—", textW - 10, 4);
        lines.forEach((wln, wi) => {
          const lead = wi === 0 ? `${arrow} ${actIcon(ss.activityKind)}` : "    ";
          content.push("      " + trunc(`${lead} ${wln}`, textW - 6));
        });
        content.push("");
      }
    }
  }

  const label = `${fg(accent)}${BOLD}${s.def.key}${RESET} ${fg(accent)}${s.def.label}${RESET} ${DIM}· ${s.account.login} · ${s.account.plan}${RESET}`;
  const liveN = flat.filter((x) => x.live).length;
  const badge = flat.length
    ? `${fg(sc)}${BOLD}${flat.length} Session${flat.length === 1 ? "" : "s"}${RESET} ${DIM}(${liveN} live)${RESET}`
    : `${DIM}${t("none")}${RESET}`;
  const B = (ch: string) => `${fg(accent)}${ch}${RESET}`;

  const out = headerLines(states, frame, now, W);
  out.push(B("╭") + rule(` ${label} `, ` ${badge} `, innerW, "─", accent) + B("╮"));
  for (const l of content) out.push(B("│") + " " + pad(l, textW) + " " + B("│"));
  out.push(B("╰") + `${fg(accent)}${"─".repeat(innerW)}${RESET}` + B("╯"));
  out.push("");
  out.push(
    `${fg(231)}↑/↓${RESET}${DIM} Session${RESET}  ${fg(231)}→/⏎${RESET}${DIM} ${t("transcriptLast")}${RESET}  ` +
    `${fg(231)}←/Esc${RESET}${DIM} Grid${RESET}  ${DIM}[q] ${t("quit")}${RESET}`,
  );
  return out;
}

/**
 * Render a session transcript into display lines with a clear hierarchy:
 * user prompts head each turn, assistant prose is the body, tool calls are
 * indented one level and their (noisy) results another — capped short so they
 * don't flood the view. Blank lines separate turns.
 */
function transcriptDisplayLines(segs: TLine[], width: number): string[] {
  const lines: string[] = [];
  let prev = "";
  for (const seg of segs) {
    // blank line at turn boundaries (a new user prompt, or assistant resuming after tools)
    if (prev && (seg.role === "user" || (seg.role === "assistant" && prev !== "assistant"))) lines.push("");

    if (seg.role === "assistant") {
      // full markdown rendering (tables, lists, headings, inline styles) under a gutter bar
      for (const ml of renderMarkdown(seg.text, width - 4)) lines.push(`  ${fg(108)}▎${RESET} ${ml}`);
    } else if (seg.role === "user") {
      const w = wrap(seg.text, width - 3, 8);
      w.forEach((wl, i) => lines.push(`${i === 0 ? `${fg(51)}❯${RESET} ` : "  "}${fg(45)}${BOLD}${wl}${RESET}`));
    } else if (seg.role === "tool") {
      lines.push(`    ${fg(214)}🔧${RESET} ${fg(250)}${trunc(seg.text.replace(/\s+/g, " "), width - 8)}${RESET}`);
    } else {
      const w = wrap(seg.text, width - 10, 2);
      w.forEach((wl, i) => lines.push(`       ${DIM}${i === 0 ? "⎿ " : "  "}${wl}${RESET}`));
    }
    prev = seg.role;
  }
  return lines;
}

function renderTranscript(
  states: InstanceState[], frame: number, now: number, W: number, height: number, ui: UIState,
): string[] {
  const s = states[ui.sel];
  const out = headerLines(states, frame, now, W);
  const { flat } = detailSessions(s);
  const ss = flat[Math.min(ui.sessSel, Math.max(0, flat.length - 1))];
  if (!ss) {
    out.push(`${DIM}${t("noSession")}${RESET}`);
    return out;
  }
  const accent = s.def.color;
  const innerW = W - 2;
  const textW = innerW - 2;

  const allLines = transcriptDisplayLines(readTranscript(ss.path), textW);
  const pool = allLines.slice(-TRANSCRIPT_LINES);
  const vh = Math.max(3, height - 6);
  const maxScroll = Math.max(0, pool.length - vh);
  const scroll = Math.min(Math.max(0, ui.scroll), maxScroll);
  ui.scroll = scroll; // keep the loop's scroll state in sync with clamping
  const end = pool.length - scroll;
  const start = Math.max(0, end - vh);
  const view = pool.slice(start, end);

  const name = ss.title || (ss.cwd ? "~" + dirName(ss.cwd) : t("untitled"));
  const label = `${fg(accent)}${BOLD}📄 ${s.def.key}${RESET} ${BOLD}${trunc(name, 46)}${RESET}  ${DIM}${dirName(ss.cwd)}${RESET}`;
  const pos = `${DIM}${start + 1}–${end} / ${pool.length}${scroll > 0 ? " ↑" : ""}${RESET}`;
  const B = (ch: string) => `${fg(accent)}${ch}${RESET}`;
  out.push(B("╭") + rule(` ${label} `, ` ${pos} `, innerW, "─", accent) + B("╮"));
  for (const l of view) out.push(B("│") + " " + pad(l, textW) + " " + B("│"));
  for (let i = view.length; i < vh; i++) out.push(B("│") + " " + pad("", textW) + " " + B("│"));
  out.push(B("╰") + `${fg(accent)}${"─".repeat(innerW)}${RESET}` + B("╯"));
  out.push("");
  out.push(
    `${fg(231)}↑/↓${RESET}${DIM} ${t("scroll")}${RESET}  ${fg(231)}PgUp/PgDn${RESET}${DIM} ${t("pagewise")}${RESET}  ` +
    `${fg(231)}←/Esc${RESET}${DIM} ${t("back")}${RESET}  ${DIM}[q] ${t("quit")}${RESET}`,
  );
  return out;
}

const AGENT_STATE_COLOR: Record<string, number> = {
  starting: 220, ready: 46, busy: 51, dead: 240,
};

/** Render one managed-agent line (same hierarchy as the transcript view). */
function agentBodyLines(a: ManagedAgent, width: number): string[] {
  // Prefer the session transcript file — it holds the FULL resumed history and
  // the agent appends new turns there. Fall back to the in-memory buffer only
  // before the transcript exists (a brand-new agent's very first moments).
  const fileSegs = a.transcriptPath ? readTranscript(a.transcriptPath) : [];
  const segs: TLine[] = fileSegs.length
    ? fileSegs
    : a.lines.map((s) => ({ role: s.role === "system" ? "result" : s.role, text: s.text }) as TLine);
  const lines = transcriptDisplayLines(segs, width);
  if (a.pending) {
    // live streaming preview of the in-flight assistant turn
    for (const wl of wrap(a.pending, width - 5, 8)) lines.push(`  ${fg(108)}▎${RESET} ${wl}`);
  }
  return lines;
}

/**
 * A cockpit tab is either a dashboard-managed agent (you type to it directly) or
 * a monitored session that's waiting for input (typing adopts it via resume-fork
 * and sends). Adopted sessions drop out of the waiting list (matched on both the
 * original and forked id).
 */
export type CockpitTab =
  | { id: string; kind: "agent"; agent: ManagedAgent; def: InstanceState["def"] }
  | { id: string; kind: "waiting"; ss: SessionSummary; def: InstanceState["def"] };

export function cockpitTabs(states: InstanceState[], registry: AgentRegistry): CockpitTab[] {
  const agents = registry.list().filter((a) => a.state !== "dead");
  const adopted = new Set<string>();
  for (const a of agents) {
    if (a.sessionId) adopted.add(a.sessionId);
    if (a.opts.resume) adopted.add(a.opts.resume);
  }
  const defByKey = new Map(states.map((s) => [s.def.key, s.def] as const));
  const fallback = states[0]?.def;
  const agentTabs: CockpitTab[] = agents.map((a) => ({
    id: `a:${a.launchId}`, kind: "agent", agent: a, def: defByKey.get(a.opts.instanceKey) ?? fallback,
  }));
  const waitTabs: CockpitTab[] = waitingSessions(states)
    .filter((w) => !adopted.has(w.ss.sessionId))
    .map((w) => ({ id: `w:${w.ss.sessionId}`, kind: "waiting", ss: w.ss, def: w.def }));
  return [...agentTabs, ...waitTabs];
}

/** Last message of a tab (the "question" awaiting input). */
function lastMessageOf(t: CockpitTab): string {
  if (t.kind === "agent") {
    const a = t.agent;
    if (a.pending) return a.pending;
    // prefer the real last assistant message from the (resumed) transcript so the
    // list reflects the continued conversation, not just "agent starting"
    const segs = a.transcriptPath ? readTranscript(a.transcriptPath) : [];
    for (let i = segs.length - 1; i >= 0; i--) if (segs[i].role === "assistant") return segs[i].text;
    for (let i = a.lines.length - 1; i >= 0; i--) if (a.lines[i].role === "assistant") return a.lines[i].text;
    return a.lines.length ? a.lines[a.lines.length - 1].text : "";
  }
  return t.ss.activity || "";
}

function renderCockpit(
  states: InstanceState[], registry: AgentRegistry, frame: number, now: number,
  W: number, height: number, ui: UIState,
): string[] {
  const out = headerLines(states, frame, now, W);
  const innerW = W - 2;
  const textW = innerW - 2;
  const tabs = cockpitTabs(states, registry);

  // resolve a readable name for an agent: explicit rename > session title > folder > id
  const titleBySession = new Map<string, string>();
  for (const s of states) for (const ss of s.sessions) if (ss.sessionId && ss.title) titleBySession.set(ss.sessionId, ss.title);
  const agentName = (a: ManagedAgent): string =>
    registry.nameOverride(a.sessionId) || titleBySession.get(a.sessionId) ||
    (a.opts.cwd ? dirName(a.opts.cwd) : "") || a.sessionId.slice(0, 6) || "agent";

  if (!tabs.length) {
    out.push(`${DIM}${t("noAgentsWaiting")}${RESET}`);
    out.push("");
    out.push(`${fg(231)}^N${RESET}${DIM} ${t("startAgent")}${RESET}  ` +
      `${fg(231)}[A]${RESET}${DIM} ${t("startAll")}${RESET}  ${fg(231)}Esc${RESET}${DIM} ${t("back")}${RESET}`);
    return out;
  }

  let fi = tabs.findIndex((t) => t.id === ui.focus);
  if (fi < 0) { fi = 0; ui.focus = tabs[0].id; }
  const focus = tabs[fi];
  const listActive = ui.cockpitArea === "list";

  const accent = focus.def?.color ?? 45;
  const B = (ch: string) => `${fg(accent)}${ch}${RESET}`;

  // ── ACTIVE SESSION (top) — no tab bar ──
  let head: string;
  let stats = "";
  let body: string[];
  let dead = false;
  if (focus.kind === "agent") {
    const a = focus.agent;
    dead = a.state === "dead";
    head = `${fg(accent)}${BOLD}▶ ${focus.def?.key ?? ""} ${trunc(agentName(a), 42)}${RESET}` +
      `  ${DIM}${tilde(a.opts.cwd)}${RESET}` +
      (a.model ? `  ${fg(modelColor(a.model))}${prettyModel(a.model)}${RESET}` : "") +
      `  ${fg(AGENT_STATE_COLOR[a.state] ?? 245)}${a.state === "ready" ? t("waitingForInput") : a.state}${RESET}` +
      (a.error ? `  ${fg(196)}${trunc(a.error, 36)}${RESET}` : "");
    const ctxMax = ctxMaxFor(a.model, a.ctxTokens);
    const ctxPct = a.ctxTokens ? a.ctxTokens / ctxMax : 0;
    stats = [
      a.ctxTokens ? `${fg(ctxColor(ctxPct))}⊞ ${formatTokens(a.ctxTokens)}/${formatTokens(ctxMax)} ${Math.round(ctxPct * 100)}%${RESET}` : "",
      a.outTokens ? `${DIM}↓${RESET} ${formatTokens(a.outTokens)}` : "",
      a.costUsd ? `${fg(220)}${formatCost(a.costUsd)}${RESET}` : "",
    ].filter(Boolean).join(`${DIM} · ${RESET}`);
    body = agentBodyLines(a, textW);
  } else {
    const ss = focus.ss;
    head = `${fg(accent)}${BOLD}◐ ${focus.def?.key ?? ""} ${focus.def?.label ?? ""}${RESET}` +
      `  ${DIM}${tilde(ss.cwd)}${RESET}` +
      (ss.model ? `  ${fg(modelColor(ss.model))}${prettyModel(ss.model)}${RESET}` : "") +
      `  ${fg(220)}${t("waitingForInput")}${RESET}`;
    body = transcriptDisplayLines(readTranscript(ss.path), textW);
  }

  // reserve the lower "offene Fragen" list; everything else is the active box
  const listMax = Math.min(tabs.length, 8);
  const vh = Math.max(3, height - listMax - 7); // header(2)+top(1)+bottom(1)+input(1)+listrule(1)+hints(1)

  out.push(B("╭") + rule(` ${head} `, stats ? ` ${stats} ` : "", innerW, "─", accent) + B("╮"));
  const view = body.slice(-vh);
  for (const l of view) out.push(B("│") + " " + pad(l, textW) + " " + B("│"));
  for (let i = view.length; i < vh; i++) out.push(B("│") + " " + pad("", textW) + " " + B("│"));
  out.push(B("╰") + `${fg(accent)}${"─".repeat(innerW)}${RESET}` + B("╯"));

  // input bar (dim when the lower list has focus)
  const caret = Math.floor(frame / 3) % 2 === 0 ? `${fg(231)}▏${RESET}` : " ";
  const imgTag = ui.pendingImages.length ? ` ${fg(213)}📎${ui.pendingImages.length}${RESET}` : "";
  const prompt = dead
    ? `${fg(196)}✗ ${t("agentStopped")}${RESET}`
    : `${listActive ? DIM : fg(46)}❯${RESET} ${listActive ? DIM : ""}${ui.input}${RESET}${imgTag}${listActive ? "" : caret}`;
  out.push(pad(prompt, W));

  // ── OFFENE FRAGEN (lower list) — waiting sessions + agents with last message ──
  out.push(rule(
    `${BOLD}${fg(220)}◐ ${t("openQuestions").toUpperCase()}${RESET} ${DIM}(${tabs.length})${RESET} `,
    ` ${fg(231)}Tab${RESET}${DIM} ${listActive ? t("toInput") : t("toList")}${RESET} `, W, "─", listActive ? 231 : 240,
  ));
  const lsel = Math.min(Math.max(0, ui.listSel), tabs.length - 1);
  if (listActive) ui.listSel = lsel;
  const overflow = tabs.length > listMax;
  const showN = overflow ? listMax - 1 : listMax;
  tabs.slice(0, showN).forEach((t, i) => {
    const isActive = t.id === ui.focus;
    const isSel = listActive && i === lsel;
    const marker = isSel ? `${fg(231)}▶${RESET}` : isActive ? `${fg(accent)}▌${RESET}` : " ";
    let gcol: number;
    let glyph: string;
    let label: string;
    if (t.kind === "agent") {
      gcol = AGENT_STATE_COLOR[t.agent.state] ?? 245;
      glyph = t.agent.state === "busy" ? SPINNER[frame % SPINNER.length] : t.agent.state === "ready" ? "●" : "○";
      label = `${t.def?.key ?? "?"} ${agentName(t.agent)}`;
    } else {
      gcol = 220;
      glyph = "◐";
      label = `${t.def?.key ?? "?"} ${t.ss.title || dirName(t.ss.cwd)}`;
    }
    const last = lastMessageOf(t).replace(/\s+/g, " ");
    const left = `${marker} ${fg(gcol)}${glyph}${RESET} ${isSel ? BOLD : ""}${trunc(label, 24)}${RESET}`;
    out.push(trunc(left + (last ? `  ${DIM}⟩ ${last}${RESET}` : ""), W));
  });
  if (overflow) out.push(`  ${DIM}… +${tabs.length - showN} ${t("further")}${RESET}`);

  // hints depend on which area has focus
  out.push(
    listActive
      ? `${fg(231)}↑/↓${RESET}${DIM} ${t("select")}${RESET}  ${fg(231)}⏎${RESET}${DIM} ${t("openVerb")}${RESET}  ` +
        `${fg(231)}Tab${RESET}${DIM} ${t("toInput")}${RESET}  ${fg(231)}Esc${RESET}${DIM} ${t("toInput")}${RESET}`
      : `${fg(231)}⏎${RESET}${DIM} ${focus.kind === "waiting" ? t("adoptSend") : t("send")}${RESET}  ` +
        `${fg(231)}^V${RESET}${DIM} ${t("pasteImage")}${RESET}  ${fg(231)}Tab${RESET}${DIM} ${t("downQuestions")}${RESET}  ` +
        `${fg(231)}^N${RESET}${DIM} ${t("new")}${RESET}  ${fg(231)}^R${RESET}${DIM} restart${RESET}  ${fg(231)}^K${RESET}${DIM} kill${RESET}  ${fg(231)}Esc${RESET}${DIM} ${t("back")}${RESET}`,
  );
  return out;
}

/** Recent distinct working folders seen on an instance (for picker suggestions). */
export function recentCwds(states: InstanceState[], instanceKey: string): string[] {
  const st = states.find((s) => s.def.key === instanceKey);
  return [...new Set((st?.sessions ?? []).map((s) => s.cwd).filter(Boolean))];
}

/** Compact "5h 12%" / "wk 40%" load tag, heat-colored, for the wizard list. */
function loadTag(label: string, work: number, budget: number): string {
  const pct = budget ? work / budget : 0;
  return `${DIM}${label}${RESET} ${fg(heat(pct))}${String(Math.round(pct * 100)).padStart(2)}%${RESET}`;
}

/** One instance row in the wizard: identity left, plan + load + live right. */
function wizardInstanceCell(s: InstanceState, on: boolean, w: number): string {
  const mark = on ? `${fg(231)}▶${RESET}` : " ";
  const dot = `${fg(s.def.color)}●${RESET}`;
  const liveN = s.sessions.filter((x) => x.live).length;
  const name = `${on ? BOLD : ""}${fg(s.def.color)}${s.def.key}${RESET} ${on ? BOLD : ""}${s.def.label}${RESET}`;
  const left = `${mark} ${dot} ${name}`;
  const right =
    (s.account.plan ? `${planChip(s.account.plan)} ` : "") +
    `${loadTag("5h", s.block5h.work, BUDGET_5H)} ${loadTag("wk", s.week.work, BUDGET_WEEK)} ` +
    `${liveN ? fg(51) + String(liveN) + "↑" + RESET : DIM + "·" + RESET}`;
  return spread(left, right, w);
}

function clampIdx(i: number, len: number): number {
  return Math.min(Math.max(0, i), Math.max(0, len - 1));
}

/** Window a list around the selection so the selected row stays visible. */
function windowAround<T>(items: T[], sel: number, cap: number): { slice: T[]; start: number } {
  if (items.length <= cap) return { slice: items, start: 0 };
  const start = Math.min(Math.max(0, sel - Math.floor(cap / 2)), items.length - cap);
  return { slice: items.slice(start, start + cap), start };
}

/** Header(2) + windowed item cells, with ↑/↓ "more" hints, padded to `rows`. */
function paneLines(header: string, cells: string[], sel: number, rows: number, empty: string): string[] {
  const cap = Math.max(1, rows - 2);
  const { slice, start } = windowAround(cells, sel, cap);
  const out = [header, ""];
  if (!cells.length) out.push(empty);
  slice.forEach((c, i) => {
    if (i === 0 && start > 0) out.push(`${DIM}  ↑ ${start} ${t("more")}${RESET}`);
    else if (i === slice.length - 1 && start + cap < cells.length) out.push(`${DIM}  ↓ ${cells.length - start - cap} ${t("more")}${RESET}`);
    else out.push(c);
  });
  while (out.length < rows) out.push("");
  return out.slice(0, rows);
}

/** All distinct working folders across all instances (folder-first mode). */
export function wizardFolders(states: InstanceState[]): FolderUsage[] {
  return allFolders(states.map((s) => s.def));
}

/** A repo in the issue picker. */
export interface RepoFolder { cwd: string; slug: string; label: string; lastTs: number; users: FolderUsage["users"]; }

/** Issue-picker repos: folders collapsed by git remote (non-git keyed by path),
 *  most-recent representative kept. Issues are filed per repository. */
export function issueRepos(states: InstanceState[]): RepoFolder[] {
  const seen = new Set<string>();
  const out: RepoFolder[] = [];
  for (const f of wizardFolders(states)) {
    const slug = repoSlug(f.cwd);
    const key = slug || f.cwd;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ cwd: f.cwd, slug, label: slug || tilde(f.cwd), lastTs: f.lastTs, users: f.users });
  }
  return out;
}

/** Instances ordered for a folder: ones that used it first (recency), then the rest. */
export function wizardOrderedInstances(states: InstanceState[], folder?: FolderUsage): InstanceState[] {
  const used = new Map((folder?.users ?? []).map((u) => [u.key, u.lastTs] as const));
  const rank = (k: string) => (used.has(k) ? used.get(k)! : -1);
  return [...states].sort((a, b) => rank(b.def.key) - rank(a.def.key));
}

/** Word-wrap plain text to a column width (no ANSI awareness needed for input). */
function wrapText(s: string, w: number): string[] {
  if (!s) return [""];
  const out: string[] = [];
  let cur = "";
  for (const word of s.split(/\s+/)) {
    if (!cur) { cur = word; continue; }
    if (vwidth(cur + " " + word) <= w) cur += " " + word;
    else { out.push(cur); cur = word; }
  }
  if (cur) out.push(cur);
  return out.length ? out : [""];
}

/**
 * Quick-Issue modal: a centered popup over the dashboard that drives the whole
 * draft → review → create flow (stage held in ui.issueStage).
 *  - pick:     left = repos we've worked in, right = free-text description.
 *  - drafting/creating: spinner while the instance / gh runs.
 *  - review/rewrite: the drafted issue rendered as Markdown, create/rewrite/cancel.
 *  - done/error: result URL or a clear error message.
 */
function renderIssueModal(
  states: InstanceState[], registry: AgentRegistry | undefined, frame: number, now: number,
  W: number, height: number, ui: UIState,
): string[] {
  const backdrop = renderGrid(states, frame, now, W, ui, height, registry);
  const accent = 213;
  const B = (ch: string) => `${fg(accent)}${ch}${RESET}`;
  const popupW = Math.min(W - 6, 124);
  const innerW = popupW - 2;
  const textW = innerW - 2;
  const bodyRows = Math.min(Math.max(8, height - 12), 24);
  const spin = SPINNER[frame % SPINNER.length];
  const title = `${fg(accent)}${BOLD}📝 ${t("issueTitle")}${RESET}`;

  const place = (box: string[]): string[] => {
    const top = Math.max(2, Math.floor((height - box.length) / 2));
    const left = Math.max(0, Math.floor((W - popupW) / 2));
    return overlayBox(backdrop, box, top, left);
  };

  const frameBox = (rows: string[], tag: string, hint: string): string[] => {
    const box: string[] = [];
    box.push(B("╭") + rule(` ${title} `, ` ${tag} `, innerW, "─", accent) + B("╮"));
    for (let i = 0; i < bodyRows; i++) box.push(B("│") + " " + pad(rows[i] ?? "", textW) + " " + B("│"));
    box.push(B("├") + `${fg(accent)}${"─".repeat(innerW)}${RESET}` + B("┤"));
    box.push(B("│") + " " + pad(hint, textW) + " " + B("│"));
    box.push(B("╰") + `${fg(accent)}${"─".repeat(innerW)}${RESET}` + B("╯"));
    return place(box);
  };

  const centered = (mid: string[]): string[] => {
    const top = Math.max(0, Math.floor((bodyRows - mid.length) / 2));
    return [...Array(top).fill(""), ...mid];
  };

  // ── pick: repo (left) + description (right) ──
  if (ui.issueStage === "pick") {
    const folders = issueRepos(states);
    const fsel = clampIdx(ui.issueFolderSel, folders.length);
    ui.issueFolderSel = fsel;
    const focusLeft = ui.issuePane === "folder";
    const div = `${fg(accent)}│${RESET}`;
    const leftW = Math.max(30, Math.floor(textW * 0.5));
    const rightW = textW - leftW - 3;

    const folderCells = folders.map((f, i) => {
      const on = i === fsel;
      const mark = on ? `${fg(231)}▶${RESET}` : " ";
      const name = f.slug ? `${fg(74)}${f.label}${RESET}` : `${fg(74)}📁 ${tilde(f.cwd)}${RESET}`;
      const left = `${mark} ${on ? BOLD : ""}${name}`;
      return spread(left, `${DIM}${f.users.length}× · ${timeAgo(now - f.lastTs)}${RESET}`, leftW);
    });
    const leftLines = paneLines(
      `${focusLeft ? BOLD + fg(231) : DIM}${t("issueRepoHdr")}${RESET}${DIM}  ${folders.length} · ${t("uses")} · ${t("last")}${RESET}`,
      folderCells, fsel, bodyRows, `${DIM}${t("noFolderHistory")}${RESET}`,
    );

    const caret = Math.floor(frame / 3) % 2 === 0 ? `${fg(231)}▏${RESET}` : " ";
    const wrapped = wrapText(ui.issueInput, rightW - 1);
    const rightLines: string[] = [`${!focusLeft ? BOLD + fg(231) : DIM}${t("issueDescHdr")}${RESET}`, ""];
    wrapped.forEach((l, i) => {
      const last = i === wrapped.length - 1;
      rightLines.push(`${fg(252)}${l}${RESET}${!focusLeft && last ? caret : ""}`);
    });
    rightLines.push("", `${DIM}${t("issueDescHint")}${RESET}`);
    while (rightLines.length < bodyRows) rightLines.push("");

    const box: string[] = [];
    box.push(B("╭") + rule(` ${title} `, ` ${DIM}${t("issuePickTag")}${RESET} `, innerW, "─", accent) + B("╮"));
    for (let i = 0; i < bodyRows; i++) {
      box.push(B("│") + " " + pad(leftLines[i] ?? "", leftW) + " " + div + " " + pad(rightLines[i] ?? "", rightW) + " " + B("│"));
    }
    const hint = focusLeft
      ? `${fg(231)}↑/↓${RESET}${DIM} ${t("issueRepoShort")}${RESET}  ${fg(231)}Tab/→${RESET}${DIM} ${t("issueDescShort")}${RESET}  ${fg(231)}Esc${RESET}${DIM} ${t("closeShort")}${RESET}`
      : `${fg(231)}${t("type")}${RESET}${DIM} ${t("issueDescShort")}${RESET}  ${fg(231)}⏎${RESET}${DIM} ${t("issueDraftVerb")}${RESET}  ${fg(231)}Tab/←${RESET}${DIM} ${t("issueRepoShort")}${RESET}  ${fg(231)}Esc${RESET}`;
    box.push(B("├") + `${fg(accent)}${"─".repeat(innerW)}${RESET}` + B("┤"));
    box.push(B("│") + " " + pad(hint, textW) + " " + B("│"));
    box.push(B("╰") + `${fg(accent)}${"─".repeat(innerW)}${RESET}` + B("╯"));
    return place(box);
  }

  // ── drafting / creating: spinner ──
  if (ui.issueStage === "drafting" || ui.issueStage === "creating") {
    const label = ui.issueStage === "drafting"
      ? `${t("issueDrafting")} ${fg(accent)}${ui.issueInstance || "?"}${RESET}${DIM} …${RESET}`
      : `${t("issueCreating")}`;
    const mid = [
      center(`${fg(accent)}${spin}${RESET}  ${label}`, textW),
      "",
      center(`${DIM}${tilde(ui.issueRepo)}${RESET}`, textW),
    ];
    return frameBox(centered(mid), t("issueWorking"), `${fg(231)}Esc${RESET}${DIM} ${t("cancel")}${RESET}`);
  }

  // ── review / rewrite: the drafted issue as Markdown ──
  if (ui.issueStage === "review" || ui.issueStage === "rewrite") {
    const isRewrite = ui.issueStage === "rewrite";
    const md = renderMarkdown(ui.issueDraft, textW - 2);
    const viewRows = isRewrite ? Math.max(3, bodyRows - 3) : bodyRows;
    const maxScroll = Math.max(0, md.length - viewRows);
    const scroll = Math.min(Math.max(0, ui.issueScroll), maxScroll);
    ui.issueScroll = scroll;
    const rows: string[] = md.slice(scroll, scroll + viewRows).map((l) => `  ${l}`);
    while (rows.length < viewRows) rows.push("");
    if (isRewrite) {
      const caret = Math.floor(frame / 3) % 2 === 0 ? `${fg(231)}▏${RESET}` : " ";
      rows.push(`${fg(accent)}${"─".repeat(textW)}${RESET}`);
      rows.push(`${BOLD}${fg(231)}${t("issueRewriteHdr")}${RESET}`);
      rows.push(`${fg(46)}❯${RESET} ${fg(252)}${trunc(ui.issueFeedback, textW - 4)}${RESET}${caret}`);
    }
    const tag = `${DIM}${scroll > 0 ? "↑ " : ""}${scroll < maxScroll ? "↓ " : ""}${tilde(ui.issueRepo)}${RESET}`;
    const hint = isRewrite
      ? `${fg(231)}⏎${RESET}${DIM} ${t("issueRedraft")}${RESET}  ${fg(231)}Esc${RESET}${DIM} ${t("back")}${RESET}`
      : `${fg(231)}⏎${RESET}${DIM} ${t("issueCreate")}${RESET}  ${fg(231)}r${RESET}${DIM} ${t("issueRewrite")}${RESET}  ${fg(231)}↑/↓${RESET}${DIM} ${t("scroll")}${RESET}  ${fg(231)}Esc${RESET}${DIM} ${t("cancel")}${RESET}`;
    return frameBox(rows, tag, hint);
  }

  // ── done ──
  if (ui.issueStage === "done") {
    const mid = [
      center(`${fg(46)}✓ ${t("issueCreated")}${RESET}`, textW),
      "",
      ...wrapText(ui.issueUrl, textW - 4).map((l) => center(`${fg(45)}${l}${RESET}`, textW)),
    ];
    return frameBox(centered(mid), `${DIM}${tilde(ui.issueRepo)}${RESET}`, `${fg(231)}Esc${RESET}${DIM} ${t("closeShort")}${RESET}`);
  }

  // ── error ──
  const emid = [
    center(`${fg(196)}✗ ${t("issueErr")}${RESET}`, textW),
    "",
    ...wrapText(ui.issueError, textW - 4).map((l) => center(`${fg(252)}${l}${RESET}`, textW)),
  ];
  return frameBox(centered(emid), `${DIM}${tilde(ui.issueRepo)}${RESET}`, `${fg(231)}r${RESET}${DIM} ${t("issueRetry")}${RESET}  ${fg(231)}Esc${RESET}${DIM} ${t("closeShort")}${RESET}`);
}

/**
 * New-agent wizard, rendered as a centered POPUP over the dashboard (not a full
 * page). Two panes with two orientations (^T toggles):
 *  - instance→folder: pick a cloud (with 5h/weekly load), then a working folder
 *    (suggestions span the instance's full project history).
 *  - folder→instance: pick a folder you've worked in, then which cloud runs there
 *    (the ones that used it are marked ✓; any other can be chosen to override).
 */
function renderWizard(
  states: InstanceState[], registry: AgentRegistry | undefined, frame: number, now: number,
  W: number, height: number, ui: UIState,
): string[] {
  const backdrop = renderGrid(states, frame, now, W, ui, height, registry);
  const accent = 45;
  const folderMode = ui.pickerMode === "folder";
  const focusLeft = ui.pickerPane === "instance";
  const popupW = Math.min(W - 6, 124);
  const innerW = popupW - 2;
  const textW = innerW - 2;
  const B = (ch: string) => `${fg(accent)}${ch}${RESET}`;
  const div = `${fg(accent)}│${RESET}`;
  const leftW = Math.max(34, Math.min(textW - 24, Math.floor(textW * (folderMode ? 0.56 : 0.62))));
  const rightW = textW - leftW - 3;
  const bodyRows = Math.min(Math.max(8, height - 12), 24);

  let leftLines: string[];
  let rightLines: string[];

  if (!folderMode) {
    // ── instance → folder ──
    const instSel = clampIdx(ui.pickerInstSel, states.length);
    ui.pickerInstSel = instSel;
    const def = states.find((s) => s.def.key === ui.pickerInstance)?.def ?? states[instSel]?.def;
    const instCells = states.map((s, i) => wizardInstanceCell(s, i === instSel, leftW));
    leftLines = paneLines(
      `${focusLeft ? BOLD + fg(231) : DIM}${t("instance").toUpperCase()}${RESET}${DIM}  Plan · 5h · wk · live${RESET}`,
      instCells, instSel, bodyRows, `${DIM}${t("noInstances")}${RESET}`,
    );

    const history = def
      ? [...new Set([...recentCwds(states, def.key), ...instanceFolders(def.configDir).map((f) => f.cwd)])]
      : recentCwds(states, ui.pickerInstance);
    const sugg = dirSuggestions(ui.pickerInput, history, 60);
    const valid = isDir(ui.pickerInput);
    const caret = Math.floor(frame / 3) % 2 === 0 ? `${fg(231)}▏${RESET}` : " ";
    const pcol = valid ? fg(252) : fg(196);
    const rsel = clampIdx(ui.pickerSel, sugg.length);
    ui.pickerSel = rsel;
    const suggCells = sugg.map((sg, i) => {
      const on = !focusLeft && i === rsel;
      const rl = repoLabel(sg);
      return `${on ? `${fg(231)}▶${RESET}` : " "} ${on ? BOLD : ""}${tilde(sg)}${RESET}${rl ? `  ${DIM}${rl}${RESET}` : ""}`;
    });
    // header band: path field + validity, then the windowed suggestion list
    const rHdr = `${!focusLeft ? BOLD + fg(231) : DIM}WORKING-FOLDER${RESET}${DIM}  ${sugg.length} ${t("fromHistory")}${RESET}`;
    const fieldRows = [
      `${fg(46)}❯${RESET} ${pcol}${trunc(ui.pickerInput, rightW - 2)}${RESET}${focusLeft ? "" : caret}`,
      valid ? `${DIM}✓ ${t("folderExists")}${RESET}` : `${fg(196)}✗ ${t("existsShort")}${RESET}`,
      "",
    ];
    const listCap = Math.max(1, bodyRows - 2 - fieldRows.length);
    const win = windowAround(suggCells, rsel, listCap);
    rightLines = [rHdr, ...fieldRows];
    if (!sugg.length) rightLines.push(`${DIM}${t("emptyFolders")}${RESET}`);
    win.slice.forEach((c, i) => {
      if (i === 0 && win.start > 0) rightLines.push(`${DIM}  ↑ ${win.start} ${t("more")}${RESET}`);
      else if (i === win.slice.length - 1 && win.start + listCap < suggCells.length) rightLines.push(`${DIM}  ↓ ${suggCells.length - win.start - listCap} ${t("more")}${RESET}`);
      else rightLines.push(c);
    });
    while (rightLines.length < bodyRows) rightLines.push("");
    rightLines = rightLines.slice(0, bodyRows);
  } else {
    // ── folder → instance ──
    const folders = wizardFolders(states);
    const fsel = clampIdx(ui.pickerInstSel, folders.length);
    ui.pickerInstSel = fsel;
    const folder = folders[fsel];
    const folderCells = folders.map((f, i) => {
      const mark = i === fsel ? `${fg(231)}▶${RESET}` : " ";
      const rl = repoLabel(f.cwd);
      const name = rl ? `${fg(74)}${rl}${RESET}` : `${fg(74)}📁 ${tilde(f.cwd)}${RESET}`;
      const left = `${mark} ${i === fsel ? BOLD : ""}${name}`;
      return spread(left, `${DIM}${f.users.length}× · ${timeAgo(now - f.lastTs)}${RESET}`, leftW);
    });
    leftLines = paneLines(
      `${focusLeft ? BOLD + fg(231) : DIM}${t("folders").toUpperCase()}${RESET}${DIM}  ${folders.length} · ${t("uses")} · ${t("last")}${RESET}`,
      folderCells, fsel, bodyRows, `${DIM}${t("noFolderHistory")}${RESET}`,
    );

    const ordered = wizardOrderedInstances(states, folder);
    const usedTs = new Map((folder?.users ?? []).map((u) => [u.key, u.lastTs] as const));
    const isel = clampIdx(ui.pickerSel, ordered.length);
    ui.pickerSel = isel;
    const instCells = ordered.map((s, i) => {
      const on = !focusLeft && i === isel;
      const dot = `${fg(s.def.color)}●${RESET}`;
      const used = usedTs.has(s.def.key);
      const tag = used ? `${fg(46)}✓ ${timeAgo(now - usedTs.get(s.def.key)!)}${RESET}` : `${DIM}${t("override")}${RESET}`;
      const name = `${on ? BOLD : ""}${fg(s.def.color)}${s.def.key}${RESET} ${on ? BOLD : ""}${s.def.label}${RESET}`;
      return spread(`${on ? `${fg(231)}▶${RESET}` : " "} ${dot} ${name}`, tag, rightW);
    });
    rightLines = paneLines(
      `${!focusLeft ? BOLD + fg(231) : DIM}${t("instance").toUpperCase()}${RESET}${DIM}  ${t("usedThisFolder")}${RESET}`,
      instCells, isel, bodyRows, `${DIM}—${RESET}`,
    );
  }

  // ── assemble the popup box ──
  const title = `${fg(accent)}${BOLD}🚀 ${t("newAgent")}${RESET}`;
  const modeTag = `${DIM}${folderMode ? t("modeFolderToInstance") : t("modeInstanceToFolder")} · ^T ${t("switches")}${RESET}`;
  const box: string[] = [];
  box.push(B("╭") + rule(` ${title} `, ` ${modeTag} `, innerW, "─", accent) + B("╮"));
  for (let i = 0; i < bodyRows; i++) {
    box.push(B("│") + " " + pad(leftLines[i] ?? "", leftW) + " " + div + " " + pad(rightLines[i] ?? "", rightW) + " " + B("│"));
  }
  const hint = focusLeft
    ? `${fg(231)}↑/↓${RESET}${DIM} ${folderMode ? t("folder") : t("instance")}${RESET}  ${fg(231)}Tab/→/⏎${RESET}${DIM} ${folderMode ? t("instance") : t("folder")}${RESET}  ${fg(231)}^T${RESET}${DIM} ${t("mode")}${RESET}  ${fg(231)}Esc${RESET}${DIM} ${t("closeShort")}${RESET}`
    : folderMode
      ? `${fg(231)}↑/↓${RESET}${DIM} ${t("instance")}${RESET}  ${fg(231)}⏎${RESET}${DIM} ${t("startHere")}${RESET}  ${fg(231)}Tab/←${RESET}${DIM} ${t("folder")}${RESET}  ${fg(231)}^T${RESET}${DIM} ${t("mode")}${RESET}  ${fg(231)}Esc${RESET}`
      : `${fg(231)}${t("type")}${RESET}${DIM} ${t("filter")}${RESET}  ${fg(231)}↑/↓${RESET}${DIM} ${t("folder")}${RESET}  ${fg(231)}→${RESET}${DIM} ${t("adoptShort")}${RESET}  ${fg(231)}⏎${RESET}${DIM} ${t("start")}${RESET}  ${fg(231)}Tab/←${RESET}${DIM} ${t("instance")}${RESET}  ${fg(231)}Esc${RESET}`;
  box.push(B("├") + `${fg(accent)}${"─".repeat(innerW)}${RESET}` + B("┤"));
  box.push(B("│") + " " + pad(hint, textW) + " " + B("│"));
  box.push(B("╰") + `${fg(accent)}${"─".repeat(innerW)}${RESET}` + B("╯"));

  const top = Math.max(2, Math.floor((height - box.length) / 2));
  const left = Math.max(0, Math.floor((W - popupW) / 2));
  return overlayBox(backdrop, box, top, left);
}

/** Working-folder picker shown before a fresh agent launches. */
function renderPicker(
  states: InstanceState[], frame: number, now: number, W: number, height: number, ui: UIState,
): string[] {
  const out = headerLines(states, frame, now, W);
  const def = states.find((s) => s.def.key === ui.pickerInstance)?.def;
  const accent = def?.color ?? 45;
  const innerW = W - 2;
  const textW = innerW - 2;
  const recents = recentCwds(states, ui.pickerInstance);
  const sugg = dirSuggestions(ui.pickerInput, recents);
  const valid = isDir(ui.pickerInput);
  const B = (ch: string) => `${fg(accent)}${ch}${RESET}`;

  const title = `${fg(accent)}${BOLD}📂 ${t("workingFolder")}${RESET} ${DIM}· Agent → ${def?.key ?? ""} ${def?.label ?? ""}${RESET}`;
  out.push(B("╭") + rule(` ${title} `, "", innerW, "─", accent) + B("╮"));

  const caret = Math.floor(frame / 3) % 2 === 0 ? `${fg(231)}▏${RESET}` : " ";
  const pcol = valid ? fg(252) : fg(196);
  out.push(B("│") + " " + pad(`${fg(46)}❯${RESET} ${pcol}${ui.pickerInput}${RESET}${caret}`, textW) + " " + B("│"));
  out.push(B("│") + " " + pad(valid ? `${DIM}✓ ${t("folderExists")}${RESET}` : `${fg(196)}✗ ${t("folderMissing")}${RESET}`, textW) + " " + B("│"));
  out.push(B("│") + " " + pad(`${DIM}${recents.length ? t("recentFirst") : t("typePath")}${RESET}`, textW) + " " + B("│"));

  const sel = Math.min(Math.max(0, ui.pickerSel), Math.max(0, sugg.length - 1));
  ui.pickerSel = sel;
  const room = Math.max(3, height - out.length - 4);
  if (!sugg.length) {
    out.push(B("│") + " " + pad(`${DIM}${t("noSuggestions")}${RESET}`, textW) + " " + B("│"));
  }
  for (const [i, s] of sugg.slice(0, room).entries()) {
    const on = i === sel;
    const mark = on ? `${fg(231)}▶${RESET}` : " ";
    const line = on ? `${mark} ${BOLD}${tilde(s)}${RESET}` : `${mark} ${tilde(s)}`;
    out.push(B("│") + " " + pad(line, textW) + " " + B("│"));
  }
  out.push(B("╰") + `${fg(accent)}${"─".repeat(innerW)}${RESET}` + B("╯"));
  out.push("");
  out.push(
    `${fg(231)}↑/↓${RESET}${DIM} ${t("select")}${RESET}  ${fg(231)}Tab/→${RESET}${DIM} ${t("takeover")}${RESET}  ` +
    `${fg(231)}⏎${RESET}${DIM} ${t("startHere")}${RESET}  ${fg(231)}Esc${RESET}${DIM} ${t("cancel")}${RESET}`,
  );
  return out;
}

/** Pink CLAUDEPLEX wordmark, shown on the first-run empty state. */
const BANNER = [
  " ▄████╗██╗      █████╗ ██╗   ██╗██████╗ ███████╗██████╗ ██╗     ███████╗██╗  ██╗",
  "██╔═══╝██║     ██╔══██╗██║   ██║██╔══██╗██╔════╝██╔══██╗██║     ██╔════╝╚██╗██╔╝",
  "██║    ██║     ███████║██║   ██║██║  ██║█████╗  ██████╔╝██║     █████╗   ╚███╔╝ ",
  "██║    ██║     ██╔══██║██║   ██║██║  ██║██╔══╝  ██╔═══╝ ██║     ██╔══╝   ██╔██╗ ",
  "╚█████╗███████╗██║  ██║╚██████╔╝██████╔╝███████╗██║     ███████╗███████╗██║  ██╗",
  " ╚════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝╚═╝     ╚══════╝╚══════╝╚═╝  ╚═╝",
];

/** First-run / zero-account screen: pink wordmark + how to get going. */
function renderEmpty(W: number, height: number): string[] {
  const pink = rgb(244, 114, 182);
  const out: string[] = ["", "", ""];
  const bw = Math.max(...BANNER.map(vwidth));
  const margin = " ".repeat(Math.max(0, Math.floor((W - bw) / 2)));
  for (const l of BANNER) out.push(margin + pink + l + RESET);
  out.push("");
  out.push(center(`${DIM}one terminal · every Claude · multiplexed${RESET}`, W));
  out.push("");
  out.push(center(`${fg(252)}No Claude Code accounts found on this machine.${RESET}`, W));
  out.push(center(`${DIM}Install Claude Code and sign in with ${RESET}${fg(45)}claude${RESET}${DIM}, then press ${RESET}${fg(231)}r${RESET}${DIM}.${RESET}`, W));
  out.push("");
  out.push(center(`${DIM}Running several accounts? Give each its own ${RESET}${fg(45)}CLAUDE_CONFIG_DIR${RESET}${DIM} (e.g. ~/.claude-work).${RESET}`, W));
  out.push(center(`${DIM}Claudeplex auto-discovers every ${RESET}${fg(45)}~/.claude*${RESET}${DIM} config dir.${RESET}`, W));
  out.push("");
  out.push(center(`${fg(231)}[r]${RESET}${DIM} rescan${RESET}   ${fg(231)}[q]${RESET}${DIM} quit${RESET}`, W));
  while (out.length < height - 1) out.push("");
  return out;
}

export function render(
  states: InstanceState[], frame: number, now: number, width: number, ui?: UIState, height = 40,
  registry?: AgentRegistry,
): string[] {
  const W = Math.max(MIN_CARD + 4, width - 2); // reserve a right gutter so cards never overflow
  if (!states.length) return renderEmpty(W, height).map((l) => trunc(l, W));
  const state: UIState = ui ?? {
    sel: -1, expanded: false, sessSel: 0, transcript: false, scroll: 0,
    cockpit: false, focus: "", input: "", cockpitArea: "input", listSel: 0, pendingImages: [],
    picker: "", pickerInput: "", pickerSel: 0, pickerInstance: "", pickerPane: "instance", pickerInstSel: 0,
    pickerMode: "instance", gridRegion: "cards", collapsed: { cards: false, live: false, questions: false }, closeArm: "", renaming: "",
    issueStage: "pick", issuePane: "folder", issueFolderSel: 0, issueInput: "", issueFeedback: "",
    issueDraft: "", issueScroll: 0, issueRepo: "", issueInstance: "", issueUrl: "", issueError: "",
  };
  let out: string[];
  if (state.picker === "issue") out = renderIssueModal(states, registry, frame, now, W, height, state);
  else if (state.picker === "wizard") out = renderWizard(states, registry, frame, now, W, height, state);
  else if (state.picker === "cwd") out = renderPicker(states, frame, now, W, height, state);
  else if (state.cockpit && registry) out = renderCockpit(states, registry, frame, now, W, height, state);
  else if (state.expanded && state.transcript) out = renderTranscript(states, frame, now, W, height, state);
  else if (state.expanded) out = renderDetail(states, frame, now, W, state);
  else out = renderGrid(states, frame, now, W, state, height, registry);
  return out.map((l) => trunc(l, W));
}
