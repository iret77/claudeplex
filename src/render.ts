import type { InstanceState, SessionSummary, Status } from "./collect.ts";
import { readTranscript, allFolders, instanceFolders, type TLine, type FolderUsage } from "./collect.ts";
import { BUDGET_5H, BUDGET_WEEK } from "./instances.ts";
import { formatCost, formatDuration, formatTokens, type WindowTotals } from "./usage.ts";
import {
  RESET, BOLD, DIM, vwidth, pad, trunc, center, rule, meter, heat, overlayBox,
  tfg, tbg, flatten, gradientRow, lerp, ICONS, type RGB, type Surface,
} from "./ui.ts";
import { getTheme, instanceShade, THEMES, type Theme } from "./theme.ts";
import type { Host } from "./hosts.ts";
import { sshTarget } from "./hosts.ts";
import type { FsEntry } from "./ssh.ts";
import type { RemoteSnapshot } from "./remote.ts";
import { isFlashing, type SessState } from "./tracker.ts";
import type { AgentRegistry } from "./agents.ts";
import type { ManagedAgent, AgentLine } from "./agent.ts";
import { dirSuggestions, expandTilde, isDir } from "./paths.ts";
import { renderMarkdown } from "./markdown.ts";
import { t, stateLabel, localeTag } from "./i18n.ts";
import { repoSlug, repoLabel, repoParts } from "./git.ts";
import type { PullRequest, PrAnalysis } from "./pr.ts";
import { homedir } from "node:os";

const HOME = homedir();
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const STREAM = ["⟩  ", "⟩⟩ ", "⟩⟩⟩", " ⟩⟩", "  ⟩"];

/* ── Theme token shortcuts ────────────────────────────────────────────────────
 * The active theme is read fresh on every call (cheap — a cached object) so a
 * live theme switch takes effect on the next frame. `c(...)` returns the SGR for
 * a colour token; the named helpers below are just the common ones spelled out. */
const TH = (): Theme => getTheme();
const c = (col: RGB): string => tfg(col);
const cText = () => tfg(TH().text);
const cText2 = () => tfg(TH().text2);
const cText3 = () => tfg(TH().text3);
const cDim = () => tfg(TH().textDim);
const cOk = () => tfg(TH().success);
const cWarn = () => tfg(TH().warning);
const cErr = () => tfg(TH().error);
const cAcc = () => tfg(TH().accent);
const cAccHi = () => tfg(TH().accentHi);

/** Per-instance grey shade (set once per frame in render(), keyed by instance). */
let shadeMap = new Map<string, RGB>();
const instColor = (key: string): RGB => shadeMap.get(key) ?? TH().text2;

/**
 * Re-assert a background colour after every RESET in `s`, then terminate. Lets a
 * row carry one continuous bg even though the inner text resets fg freely. The
 * trailing RESET hands the gutter back to the page-bg compositor (see render()).
 */
function bgRow(s: string, color: RGB): string {
  const set = tbg(color);
  return set + s.split(RESET).join(RESET + set) + RESET;
}

/** Paint a box's rows with its surface gradient — lighter at the top edge. */
function surfaceBox(rows: string[], surf: Surface): string[] {
  return rows.map((r, i) => bgRow(r, gradientRow(surf, i, rows.length)));
}

/**
 * Lay one frame line onto the page canvas: page bg is set at the start and
 * re-asserted after every RESET, so gaps and the right gutter fill with the
 * page colour (the trailing \x1b[K in the draw loop carries it to the edge).
 * Surface boxes re-assert THEIR bg immediately after each reset, so they win
 * inside the box; only the truly empty cells fall through to the page.
 */
function pageWrap(line: string, page: RGB): string {
  const set = tbg(page);
  return set + line.split(RESET).join(RESET + set);
}

/**
 * A bordered, gradient-filled panel — the full-width sibling of boxCard, used by
 * the detail/transcript/cockpit views. `accent` tints all edges (focus); without
 * it the edges use the light-top / dark-bottom neutral border.
 */
function panel(
  label: string, badge: string, content: string[], innerW: number, surf: Surface, accent?: RGB,
  selRow = -1, selColor?: RGB,
): string[] {
  const tint = borderTints(surf, accent);
  const top = `${c(tint.top)}╭${RESET}` + rule(` ${label} `, badge ? ` ${badge} ` : "", innerW, "─", tint.top) + `${c(tint.top)}╮${RESET}`;
  const mids = content.map((l) => `${c(tint.mid)}│${RESET} ` + pad(l, innerW - 2) + ` ${c(tint.mid)}│${RESET}`);
  const rows = [top, ...mids, bottom(tint, innerW)];
  // Per-row background: the gradient surface, except the selected content row,
  // which gets a full-width selection bar (the mc/nc cursor).
  return rows.map((r, i) => {
    if (selColor && i - 1 === selRow) return bgRow(r, selColor);
    return bgRow(r, gradientRow(surf, i, rows.length));
  });
}
function bottom(tint: { btm: RGB }, innerW: number): string {
  return `${c(tint.btm)}╰${"─".repeat(innerW)}╯${RESET}`;
}

/** Border-edge tints, flattened against the surface they enclose. */
function borderTints(surf: Surface, accent?: RGB): { top: RGB; mid: RGB; btm: RGB } {
  const th = TH();
  if (accent) return { top: accent, mid: accent, btm: accent };
  return {
    top: flatten(surf.top, th.borderTop),
    mid: flatten(lerp(surf.top, surf.btm, 0.5), th.borderSubtleTop),
    btm: flatten(surf.btm, th.borderBtm),
  };
}

/** Status of an instance process, expressed only as a coloured glyph + word. */
function statusVisual(status: Status): { color: RGB; dot: string } {
  const th = TH();
  if (status === "WORKING") return { color: th.success, dot: "" };
  if (status === "LIVE") return { color: th.accentHi, dot: ICONS.active };
  if (status === "IDLE") return { color: th.text3, dot: ICONS.idle };
  return { color: th.textDim, dot: ICONS.tool };
}

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
  return k === "tool" ? ICONS.tool : k === "text" ? ICONS.text : k === "user" ? ICONS.prompt : ICONS.tool;
}
/** Plan badge, text-only (no background pill). Max gets the accent, others stay grey. */
function planChip(plan: string): string {
  if (!plan) return "";
  const col = /max/i.test(plan) ? TH().accentHi : TH().text3;
  return `${tfg(col)}${BOLD}${plan}${RESET}`;
}

/** Right-align `right` after `left` within `width` (space filler). */
function spread(left: string, right: string, width: number): string {
  const inner = Math.max(0, width - vwidth(right));
  return pad(left, inner) + right;
}

function statTrail(t: WindowTotals, withMsg: boolean): string {
  const sep = `${cDim()}·${RESET}`;
  return (
    `${cText3()}${formatTokens(t.work)}${RESET}` +
    (withMsg ? ` ${sep} ${cText3()}${t.messages}m${RESET}` : "") +
    ` ${sep} ${cText3()}${formatCost(t.cost)}${RESET}`
  );
}

function loadRow(
  tag: string, t: WindowTotals, budget: number, innerW: number, withMsg: boolean,
  resetAt: number, now: number,
): string {
  const pct = t.work / budget;
  const th = TH();
  const col = heat(pct, th.success, th.warning, th.error);
  const rest = resetAt > now ? ` ${cDim()}${ICONS.refresh} ${formatDuration(resetAt - now)}${RESET}` : "";
  const trail = ` ${tfg(col)}${BOLD}${String(Math.round(pct * 100)).padStart(3)}%${RESET} ${statTrail(t, withMsg)}${rest}`;
  const barW = Math.max(8, innerW - 4 - vwidth(trail));
  return `${cText3()}${tag}${RESET} ${meter(pct, barW, col, th.textDim)}${trail}`;
}

interface Vis { color: RGB; glyph: string; }
function visual(state: SessState): Vis {
  const th = TH();
  if (state === "aktiv") return { color: th.success, glyph: ICONS.active };
  if (state === "monitor") return { color: th.accentHi, glyph: ICONS.monitor };
  if (state === "wartet") return { color: th.warning, glyph: ICONS.waiting };
  return { color: th.text3, glyph: ICONS.idle };
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
/** Model family tint — kept within the single-accent palette (shades + success). */
function modelColor(m: string): RGB {
  const th = TH();
  if (/opus/i.test(m)) return th.accentHi;
  if (/sonnet/i.test(m)) return th.accent;
  if (/haiku/i.test(m)) return th.success;
  if (/fable/i.test(m)) return th.accentHi2;
  return th.text3;
}
function ctxColor(pct: number): RGB {
  const th = TH();
  return pct >= 0.85 ? th.error : pct >= 0.6 ? th.warning : th.success;
}
/** Compact inline cluster: context % (colored) · model family · thinking. */
function ctxModelSuffix(ss: SessionSummary): string {
  const parts: string[] = [];
  if (ss.bg) parts.push(`${cAcc()}${ICONS.background}${RESET}`);
  if (ss.ctxTokens > 0) {
    const pct = ss.ctxTokens / ctxMaxFor(ss.model, ss.ctxTokens);
    parts.push(`${c(ctxColor(pct))}${Math.round(pct * 100)}%${RESET}`);
  }
  const fam = modelFamily(ss.model);
  if (fam) parts.push(`${c(modelColor(ss.model))}${fam}${RESET}`);
  let s = parts.join(` ${DIM}·${RESET} `);
  if (ss.thinking) s += `${cText3()} ${ICONS.thinking}${RESET}`;
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
  const badge = `${c(v.color)}${glyph} ${stateLabel(state).padEnd(7)}${RESET}`;
  const name = ss.title
    ? `${BOLD}${ss.title}${RESET}`
    : ss.cwd ? `${DIM}~${dirName(ss.cwd)}${RESET}` : `${DIM}${t("untitled")}${RESET}`;
  const flashing = isFlashing(ss.sessionId, now);
  const blink = flashing && Math.floor(frame / 2) % 2 === 0;
  const mark = blink ? `${cText()}▌${RESET}` : flashing ? `${c(v.color)}▌${RESET}` : " ";
  const suffix = ctxModelSuffix(ss);
  const right = `${suffix ? suffix + "  " : ""}${DIM}${timeAgo(age)}${RESET}`;
  const body = spread(`${badge} ${name}`, right, w - indent - 2);
  return `${" ".repeat(indent)}${mark} ${body}`;
}

const SESS_CAP = 26;

function sessionLines(s: InstanceState, w: number, frame: number, now: number): string[] {
  const out: string[] = [];
  const accent = instColor(s.def.key);
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
    `${c(accent)}▸${RESET} ${BOLD}${liveN} ${t("running")}${RESET} ${DIM}(${workN} ${t("active")})${RESET}` +
    (staleN ? `  ${DIM}· ${staleN} ${t("recent")}${RESET}` : "") +
    `  ${DIM}·${RESET} ${c(accent)}${groups.length} ${t("folders")}${RESET}`,
  );
  let count = 0;
  for (const g of groups) {
    if (count >= SESS_CAP) break;
    out.push(` ${c(accent)}${ICONS.folder} ${dirName(g.full)}${RESET} ${DIM}(${g.sessions.length})${RESET}`);
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
  lines.push(spread(`${ICONS.account} ${c(instColor(s.def.key))}${BOLD}${a.login || "—"}${RESET}`, `${DIM}${a.email}${RESET}`, innerW));
  const meta = [a.role && `${DIM}${a.role}${RESET}`, a.org && `${DIM}${ICONS.org} ${a.org}${RESET}`].filter(Boolean).join(`  `);
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
  const th = TH();
  const inst = instColor(s.def.key);
  const surf = th.raised;
  const sv = statusVisual(s.status);
  const spin = s.status === "WORKING" ? SPINNER[frame % SPINNER.length] : sv.dot;
  const tint = borderTints(surf, selected ? th.accent : undefined);
  const mark = selected ? `${cText()}${ICONS.bar} ${RESET}` : "";
  const label = `${mark}${c(inst)}${BOLD}${s.def.key}${RESET} ${c(inst)}${s.def.label}${RESET}`;
  const badge = `${c(sv.color)}${spin}${spin ? " " : ""}${BOLD}${s.status}${RESET}`;
  const bold = selected ? BOLD : "";
  const top = `${c(tint.top)}${bold}╭${RESET}` + rule(` ${label} `, ` ${badge} `, innerW, "─", tint.top) + `${c(tint.top)}${bold}╮${RESET}`;
  const bottom = `${c(tint.btm)}${bold}╰${"─".repeat(innerW)}╯${RESET}`;
  const mids = content.map((l) => `${c(tint.mid)}${bold}│${RESET} ` + pad(l, innerW - 2) + ` ${c(tint.mid)}${bold}│${RESET}`);
  return surfaceBox([top, ...mids, bottom], surf);
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
  const sep = `${cDim()}│${RESET}`;
  const title = `${cAcc()}${SPINNER[frame % SPINNER.length]}${RESET} ${BOLD}${cAcc()}CLAUDEPLEX${RESET} ${sep} ${BOLD}${cText2()}MULTI-INSTANCE${RESET}`;
  const summary =
    `${cAccHi()}${BOLD}${liveSess}${RESET} ${cText2()}${t("sessionsLive")}${RESET}  ${cOk()}${ICONS.active}${RESET} ${cText2()}${workingSess} ${t("working")}${RESET}  ` +
    `${sep} ${cText2()}${liveInst}/${states.length} ${t("instances")}${RESET}  ` +
    `${sep} ${cText3()}5h${RESET} ${BOLD}${cText2()}${formatTokens(tok5h)}${RESET} ${cText3()}${t("tok")}${RESET} ${cText2()}${formatCost(cost5h)}${RESET}  ` +
    `${sep} ${cAcc()}${clock}${RESET}`;
  return [rule(`${title} `, ` ${summary}`, W, "━", TH().textDim), ""];
}

/** What a Commander pane is currently showing. `tree` = the Host▸Project▸Session
 *  agent tree (the Conductor's left spine); `session` = a live session detail. */
export type PaneView = "tree" | "session" | "hosts" | "drives" | "files" | "accounts" | "sessions" | "fleet";

export type PaneItemKind =
  | "up" | "host" | "project" | "drive" | "dir" | "file" | "link" | "account" | "session" | "rcserver";

/**
 * One polymorphic row in a Commander pane — a host, a drive, a dir/file, an
 * account, a session or an RC server. The renderer draws it by kind; the
 * navigation payload (host/path/accountKey/sessionId/…) tells index.ts where
 * "Enter" goes.
 */
export interface PaneItem {
  kind: PaneItemKind;
  label: string;
  meta?: string; // right-aligned secondary text (size / load / model / RAM …)
  state?: SessState; // session rows → state colour + glyph
  online?: boolean; // host rows → liveness dot
  // navigation payload (set per kind)
  host?: string;
  path?: string;
  accountKey?: string;
  sessionId?: string;
  cwd?: string;
  drive?: PaneView;
  pid?: number;
  tmux?: string; // rcserver rows → tmux session name for attach
  // tree rows (Conductor left pane):
  depth?: number; // indent level (host=0, project=1, session=2)
  badge?: string; // pre-coloured compact status badge ([WAIT] etc.)
  expandable?: boolean;
  expanded?: boolean;
  nodeId?: string; // stable id for the expand/collapse set
}

/**
 * One side of the two-pane Commander. A pane is polymorphic: depending on `view`
 * it lists hosts, drives, files, accounts, sessions or the RC fleet, and you cd
 * through the hierarchy (Enter descends, ".." ascends). `title` is the
 * breadcrumb shown in the pane header.
 */
export interface CmdPane {
  view: PaneView;
  host: string; // active host name ("" = none yet)
  path: string; // files view cwd
  accountKey: string; // sessions view: which account
  title: string;
  items: PaneItem[];
  sel: number;
  loading: boolean;
  error: string;
}

/** A fresh, empty Commander pane (starts at the hosts view). */
export function emptyPane(): CmdPane {
  return { view: "hosts", host: "", path: "", accountKey: "", title: "", items: [], sel: 0, loading: false, error: "" };
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
  picker: "" | "cwd" | "wizard" | "issue" | "pr"; // active picker ("" = none)
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
  // live theme quick-picker (p): scrub to preview, ⏎ commits, Esc restores
  themePicker: boolean;
  themeSel: number;
  // multi-host Commander — the whole app IS the commander (mc/nc). Each pane is
  // polymorphic (hosts/drives/files/accounts/sessions/fleet); you cd through it.
  commander: boolean;
  cmdHosts: Host[]; // resolved host registry (cache for the builders)
  cmdActive: 0 | 1; // which pane has focus (Tab switches)
  cmdPanes: [CmdPane, CmdPane]; // left / right panes
  cmdRemote: RemoteSnapshot | null; // fleet snapshot for the active pane's host
  fromCommander: boolean; // a full-screen view (cockpit/transcript) was opened from the Commander → Esc returns there
  cmdFeedback: string; // transient result of an action (launch/stop/copy)
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
  // pr-review flow (picker === "pr"): pick → analyze → review → act
  prStage: "pick" | "analyzing" | "review" | "action-input" | "commenting" | "merging" | "launching" | "done" | "error";
  prPane: "repo" | "list"; // which pick-stage pane has focus
  prRepoSel: number; // highlighted repo index
  prPrSel: number; // highlighted PR index
  prList: PullRequest[]; // open PRs for the selected repo
  prRepoCwd: string; // chosen repo cwd
  prInstance: string; // instance key chosen to analyze
  prAnalysis: PrAnalysis | null; // analysis result (review stage)
  prPendingAction: "comment" | "request-changes" | null; // which review the action-input feeds
  prActionInput: string; // review-body buffer (action-input stage)
  prResult: string; // success message (done stage)
  prError: string; // error message (error stage)
  prScroll: number; // scroll offset in the review modal
  prStart: number; // epoch ms when the current async stage began (elapsed timer)
  prToken: number; // bumped to cancel stale async results
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
  const hcol = focused ? TH().text : TH().success;
  out.push(rule(`${BOLD}${c(hcol)}${collapsed ? "▸" : "▾"} ② LIVE OUTPUT${RESET} `, ` ${DIM}${active.length} ${t("active")}${RESET}`, W, "━", focused ? TH().text : TH().textDim));
  if (collapsed) return out;
  if (!active.length) {
    out.push(`  ${DIM}${t("noSessionGenerating")}${RESET}`);
    return out;
  }
  const CAP = 6;
  for (const { s, ss } of active.slice(0, CAP)) {
    out.push("");
    const head =
      `${c(instColor(s.def.key))}▶ ${BOLD}${s.def.key}${RESET} ${c(instColor(s.def.key))}${ss.title || dirName(ss.cwd)}${RESET}` +
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
        prefix = `${cText3()}${ICONS.tool}${RESET}`;
        color = DIM;
      } else if (seg.role === "result") {
        indent = 8;
        prefix = `${DIM}⎿${RESET}`;
        color = DIM;
      } else if (seg.role === "user") {
        indent = 4;
        prefix = `${cAccHi()}❯${RESET}`;
        color = "";
      } else {
        indent = 4;
        prefix = `${DIM}${ICONS.text}${RESET}`;
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
    on ? `${cAccHi()}${BOLD}${num} ${label}${RESET}` : `${cText3()}${num} ${label}${RESET}`;
  out.push(
    `${chip("①", t("cards"), region === "cards")}  ${chip("②", "Live", region === "live")}  ` +
    `${chip("③", t("openQuestions"), region === "questions")}   ${DIM}${t("switchInstances1to3")} · 2× ▾/▸${RESET}`,
  );
  out.push("");

  if (ui.collapsed.cards) {
    const cells = states.map((s) => {
      const cnt = (st: string) => s.sessions.filter((x) => x.state === st).length;
      const a = cnt("aktiv"), m = cnt("monitor"), wt = cnt("wartet"), sl = cnt("stale");
      const bgN = s.sessions.filter((x) => x.bg).length;
      const ses = [a && `${cOk()}◆${a}${RESET}`, m && `${cAcc()}◑${m}${RESET}`, wt && `${cWarn()}◐${wt}${RESET}`, sl && `${cText3()}○${sl}${RESET}`, bgN && `${cAcc()}${ICONS.background}${bgN}${RESET}`].filter(Boolean).join(" ");
      return `${c(instColor(s.def.key))}${BOLD}${s.def.key}${RESET} ${c(instColor(s.def.key))}${s.def.label}${RESET} ` +
        `${loadTag("5h", s.block5h.work, BUDGET_5H)} ${loadTag("wk", s.week.work, BUDGET_WEEK)}` +
        (ses ? `  ${ses}` : "");
    });
    out.push(`  ${region === "cards" ? cText() : DIM}▸ ① ${t("cards")}${RESET}   ${cells.join(`  ${DIM}│${RESET}  `)}`);
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
    `${BOLD}${c(qFocus ? TH().text : TH().warning)}${ui.collapsed.questions ? "▸" : "▾"} ③ WAITING / STALE${RESET} ${DIM}(${ws} ${stateLabel("wartet")} · ${st} stale)${RESET} `,
    qFocus ? ` ${DIM}↑/↓ ${t("select")} · ⏎ ${t("openVerb")} · e ${t("rename")} · x ${t("close")}${RESET} ` : "", W, "━", qFocus ? TH().text : TH().textDim,
  ));
  if (!ui.collapsed.questions) {
  if (ui.renaming) {
    const caret = Math.floor(frame / 3) % 2 === 0 ? `${cText()}▏${RESET}` : " ";
    out.push(`  ${cAccHi()}✎ ${t("renameLabel")}${RESET} ${ui.input}${caret}   ${DIM}${t("saveCancel")}${RESET}`);
  }
  if (!qs.length) out.push(`  ${DIM}${t("noSessions")}${RESET}`);
  // inline-flow rows: INST STATE TIME title · worktree — message (tight, no columns)
  const clock = (ms: number) => {
    const d = new Date(ms), nd = new Date(now);
    const z = (x: number) => String(x).padStart(2, "0");
    const hm = `${z(d.getHours())}:${z(d.getMinutes())}`;
    const today = d.getFullYear() === nd.getFullYear() && d.getMonth() === nd.getMonth() && d.getDate() === nd.getDate();
    return today ? hm : `${z(d.getDate())}.${z(d.getMonth() + 1)} ${hm}`;
  };
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
      out.push(`  ${cAcc()}${ICONS.repo} ${d.header}${RESET} ${DIM}(${d.count})${RESET}`);
      return;
    }
    const w = d.w!, i = d.i!;
    const sel = qFocus && i === lsel;
    const armed = ui.closeArm === w.ss.sessionId;
    const open = !!registry?.forSession(w.ss.sessionId);
    const v = visual(w.ss.state);
    const marker = armed ? `${cErr()}✗${RESET}` : sel ? `${cText()}▶${RESET}` : open ? `${cOk()}●${RESET}` : " ";
    const inst = `${c(instColor(w.def.key))}${pad(w.def.key, 4)}${RESET}`;
    const stateTag = open ? `${cOk()}${pad(`✎ ${t("open")}`, 7)}${RESET}` : `${c(v.color)}${pad(stateLabel(w.ss.state), 7)}${RESET}`;
    const titleRaw = registry?.nameOverride(w.ss.sessionId) ?? (w.ss.title || "~" + dirName(w.ss.cwd));
    const wt = repoParts(w.ss.cwd).worktree;
    const titlePart = `${sel ? `${BOLD}${cText()}` : cText2()}${titleRaw}${RESET}${wt ? ` ${DIM}·${RESET} ${cText3()}${wt}${RESET}` : ""}`;
    const timeCol = `${DIM}${clock(w.ss.lastTs)}${RESET}`;
    const last = (w.ss.activity || "").replace(/\s+/g, " ");
    const msg = armed ? `  ${cErr()}${t("closeConfirm")}${RESET}` : last ? ` ${DIM}— ${last}${RESET}` : "";
    out.push(trunc(`${marker} ${inst} ${stateTag} ${timeCol} ${titlePart}${msg}`, W));
  });
  const shown = view.filter((d) => d.w).length;
  const below = qs.length - hiddenAbove - shown;
  if (below > 0) out.push(`  ${DIM}↓ ${below} ${t("further")}${RESET}`);
  }

  out.push("");
  out.push(
    `${cOk()}◆ ${stateLabel("aktiv")}${RESET} ${DIM}·${RESET} ${cAcc()}◑ ${stateLabel("monitor")}${RESET} ${DIM}·${RESET} ${cWarn()}◐ ${stateLabel("wartet")}${RESET} ${DIM}·${RESET} ${cText3()}○ ${stateLabel("stale")}${RESET} ${DIM}·${RESET} ${cAcc()}${ICONS.background} background${RESET}`,
  );
  out.push(
    qFocus
      ? `${cText()}↑/↓${RESET}${DIM} ${t("question")}${RESET}  ${cText()}⏎${RESET}${DIM} ${t("answerCockpit")}${RESET}  ` +
        `${cText()}[x]${RESET}${DIM} ${t("closeSession")}${RESET}  ${cText()}Tab/1-3${RESET}${DIM} ${t("area")}${RESET}  ${DIM}[q] quit${RESET}`
      : `${cText()}↑/↓${RESET}${DIM} ${t("instance")}${RESET}  ${cText()}→/⏎${RESET}${DIM} Sessions${RESET}  ` +
        `${cText()}Tab/1-3${RESET}${DIM} ${t("area")}${RESET}  ${cText()}[c]${RESET}${DIM} Cockpit${RESET}  ${cText()}[i]${RESET}${DIM} Issue${RESET}  ` +
        `${cText()}[n]${RESET}${DIM} Agent${RESET}  ${cText()}[N]${RESET}${DIM} ${t("here")}${RESET}  ${cText()}[A]${RESET}${DIM} ${t("all")}${RESET}  ${cText()}[p]${RESET}${DIM} Theme${RESET}  ${DIM}[r/q]${RESET}`,
  );
  return out;
}

function renderDetail(states: InstanceState[], frame: number, now: number, W: number, ui: UIState): string[] {
  const s = states[ui.sel];
  const accent = TH().accent;
  const sc = statusVisual(s.status).color;
  const innerW = W - 2;
  const textW = innerW - 2;

  const { groups, flat } = detailSessions(s);
  const sel = Math.min(ui.sessSel, Math.max(0, flat.length - 1));

  const content: string[] = [];
  if (!flat.length) content.push(`${DIM}${t("noRealSessions")}${RESET}`);

  let idx = 0;
  for (const g of groups) {
    content.push(`${c(accent)}${ICONS.folder} ${tilde(g.full) || "?"}${RESET}  ${DIM}(${g.sessions.length})${RESET}`);
    for (const ss of g.sessions) {
      const on = idx++ === sel;
      const state = ss.state;
      const v = visual(state);
      const glyph = state === "aktiv" ? SPINNER[frame % SPINNER.length] : v.glyph;
      const dot = `${c(v.color)}${glyph}${RESET}`;
      const flashing = isFlashing(ss.sessionId, now);
      const blink = flashing && Math.floor(frame / 2) % 2 === 0;
      const marker = on
        ? `${cText()}▶${RESET}`
        : blink ? `${cText()}▌${RESET}` : flashing ? `${c(v.color)}▌${RESET}` : " ";
      const nm = ss.cwd ? dirName(ss.cwd) : "";
      const title = ss.title
        ? `${BOLD}${c(on ? TH().text : TH().text2)}${ss.title}${RESET}`
        : nm ? `${DIM}~${nm}${RESET}` : `${DIM}${t("untitled")}${RESET}`;
      const ago = `${DIM}${timeAgo(now - ss.lastTs)}${RESET}`;
      const tag = `${c(v.color)}${stateLabel(state)}${RESET}`;
      content.push("  " + spread(`${marker} ${dot} ${title}`, `${tag}  ${ago}`, textW - 2));
      if (on) {
        const where = `${c(accent)}${ICONS.folder}${RESET} ${tilde(ss.cwd) || "?"}${ss.gitBranch ? `   ${DIM}${ICONS.branch} ${ss.gitBranch}${RESET}` : ""}`;
        content.push("      " + trunc(where, textW - 6));
        const cmax = ctxMaxFor(ss.model, ss.ctxTokens);
        const cpct = ss.ctxTokens ? ss.ctxTokens / cmax : 0;
        const ctxStr = ss.ctxTokens
          ? `${c(accent)}${ICONS.context}${RESET} Context ${c(ctxColor(cpct))}${formatTokens(ss.ctxTokens)}/${formatTokens(cmax)} (${Math.round(cpct * 100)}%)${RESET}`
          : `${c(accent)}${ICONS.context}${RESET} ${DIM}Context —${RESET}`;
        const mdlStr = ss.model ? `  ${DIM}·${RESET} ${c(modelColor(ss.model))}${prettyModel(ss.model)}${RESET}` : "";
        const thinkStr = ss.thinking ? `  ${DIM}·${RESET} ${ICONS.thinking} ${DIM}Thinking${RESET}` : "";
        const bgStr = ss.bg ? `  ${DIM}·${RESET} ${cAcc()}${ICONS.background} background${RESET}` : "";
        content.push("      " + trunc(`${ctxStr}${mdlStr}${thinkStr}${bgStr}`, textW - 6));
        content.push(`      ${DIM}id ${ss.sessionId.slice(0, 8)}${RESET}`);
        const arrow = ss.working ? `${c(sc)}${STREAM[frame % STREAM.length]}${RESET}` : `${DIM}⟩${RESET}`;
        const lines = wrap(ss.activity || "—", textW - 10, 4);
        lines.forEach((wln, wi) => {
          const lead = wi === 0 ? `${arrow} ${actIcon(ss.activityKind)}` : "    ";
          content.push("      " + trunc(`${lead} ${wln}`, textW - 6));
        });
        content.push("");
      }
    }
  }

  const label = `${c(accent)}${BOLD}${s.def.key}${RESET} ${c(accent)}${s.def.label}${RESET} ${DIM}· ${s.account.login} · ${s.account.plan}${RESET}`;
  const liveN = flat.filter((x) => x.live).length;
  const badge = flat.length
    ? `${c(sc)}${BOLD}${flat.length} Session${flat.length === 1 ? "" : "s"}${RESET} ${DIM}(${liveN} live)${RESET}`
    : `${DIM}${t("none")}${RESET}`;
  const out = headerLines(states, frame, now, W);
  for (const l of panel(label, badge, content, innerW, TH().raised, accent)) out.push(l);
  out.push("");
  out.push(
    `${cText()}↑/↓${RESET}${DIM} Session${RESET}  ${cText()}→/⏎${RESET}${DIM} ${t("transcriptLast")}${RESET}  ` +
    `${cText()}←/Esc${RESET}${DIM} Grid${RESET}  ${DIM}[q] ${t("quit")}${RESET}`,
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
      for (const ml of renderMarkdown(seg.text, width - 4)) lines.push(`  ${cText3()}▎${RESET} ${ml}`);
    } else if (seg.role === "user") {
      const w = wrap(seg.text, width - 3, 8);
      w.forEach((wl, i) => lines.push(`${i === 0 ? `${cAccHi()}❯${RESET} ` : "  "}${cAcc()}${BOLD}${wl}${RESET}`));
    } else if (seg.role === "tool") {
      lines.push(`    ${cText3()}${ICONS.tool}${RESET} ${cText2()}${trunc(seg.text.replace(/\s+/g, " "), width - 8)}${RESET}`);
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
  const accent = TH().accent;
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
  const label = `${c(accent)}${BOLD}${ICONS.file} ${s.def.key}${RESET} ${BOLD}${trunc(name, 46)}${RESET}  ${DIM}${dirName(ss.cwd)}${RESET}`;
  const pos = `${DIM}${start + 1}–${end} / ${pool.length}${scroll > 0 ? " ↑" : ""}${RESET}`;
  const body = [...view];
  for (let i = view.length; i < vh; i++) body.push("");
  for (const l of panel(label, pos, body, innerW, TH().sunken, accent)) out.push(l);
  out.push("");
  out.push(
    `${cText()}↑/↓${RESET}${DIM} ${t("scroll")}${RESET}  ${cText()}PgUp/PgDn${RESET}${DIM} ${t("pagewise")}${RESET}  ` +
    `${cText()}←/Esc${RESET}${DIM} ${t("back")}${RESET}  ${DIM}[q] ${t("quit")}${RESET}`,
  );
  return out;
}

/** Managed-agent lifecycle colour, resolved against the live theme each call. */
function agentStateColor(state: string): RGB {
  const th = TH();
  return state === "starting" ? th.warning
    : state === "ready" ? th.success
    : state === "busy" ? th.accentHi
    : th.textDim;
}

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
    for (const wl of wrap(a.pending, width - 5, 8)) lines.push(`  ${cText3()}▎${RESET} ${wl}`);
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
    out.push(`${cText()}^N${RESET}${DIM} ${t("startAgent")}${RESET}  ` +
      `${cText()}[A]${RESET}${DIM} ${t("startAll")}${RESET}  ${cText()}Esc${RESET}${DIM} ${t("back")}${RESET}`);
    return out;
  }

  let fi = tabs.findIndex((t) => t.id === ui.focus);
  if (fi < 0) { fi = 0; ui.focus = tabs[0].id; }
  const focus = tabs[fi];
  const listActive = ui.cockpitArea === "list";

  const accent = TH().accent;

  // ── ACTIVE SESSION (top) — no tab bar ──
  let head: string;
  let stats = "";
  let body: string[];
  let dead = false;
  if (focus.kind === "agent") {
    const a = focus.agent;
    dead = a.state === "dead";
    head = `${c(accent)}${BOLD}${ICONS.cursor} ${focus.def?.key ?? ""} ${trunc(agentName(a), 42)}${RESET}` +
      `  ${DIM}${tilde(a.opts.cwd)}${RESET}` +
      (a.model ? `  ${c(modelColor(a.model))}${prettyModel(a.model)}${RESET}` : "") +
      `  ${c(agentStateColor(a.state))}${a.state === "ready" ? t("waitingForInput") : a.state}${RESET}` +
      (a.error ? `  ${cErr()}${trunc(a.error, 36)}${RESET}` : "");
    const ctxMax = ctxMaxFor(a.model, a.ctxTokens);
    const ctxPct = a.ctxTokens ? a.ctxTokens / ctxMax : 0;
    stats = [
      a.ctxTokens ? `${c(ctxColor(ctxPct))}${ICONS.context} ${formatTokens(a.ctxTokens)}/${formatTokens(ctxMax)} ${Math.round(ctxPct * 100)}%${RESET}` : "",
      a.outTokens ? `${DIM}↓${RESET} ${formatTokens(a.outTokens)}` : "",
      a.costUsd ? `${cWarn()}${formatCost(a.costUsd)}${RESET}` : "",
    ].filter(Boolean).join(`${DIM} · ${RESET}`);
    body = agentBodyLines(a, textW);
  } else {
    const ss = focus.ss;
    head = `${c(accent)}${BOLD}${ICONS.waiting} ${focus.def?.key ?? ""} ${focus.def?.label ?? ""}${RESET}` +
      `  ${DIM}${tilde(ss.cwd)}${RESET}` +
      (ss.model ? `  ${c(modelColor(ss.model))}${prettyModel(ss.model)}${RESET}` : "") +
      `  ${cWarn()}${t("waitingForInput")}${RESET}`;
    body = transcriptDisplayLines(readTranscript(ss.path), textW);
  }

  // reserve the lower "offene Fragen" list; everything else is the active box
  const listMax = Math.min(tabs.length, 8);
  const vh = Math.max(3, height - listMax - 7); // header(2)+top(1)+bottom(1)+input(1)+listrule(1)+hints(1)

  const view = body.slice(-vh);
  const boxBody = [...view];
  for (let i = view.length; i < vh; i++) boxBody.push("");
  for (const l of panel(head, stats, boxBody, innerW, TH().sunken, accent)) out.push(l);

  // input bar (dim when the lower list has focus)
  const caret = Math.floor(frame / 3) % 2 === 0 ? `${cText()}▏${RESET}` : " ";
  const imgTag = ui.pendingImages.length ? ` ${cAccHi()}${ICONS.attach}${ui.pendingImages.length}${RESET}` : "";
  const prompt = dead
    ? `${cErr()}✗ ${t("agentStopped")}${RESET}`
    : `${listActive ? DIM : cOk()}❯${RESET} ${listActive ? DIM : ""}${ui.input}${RESET}${imgTag}${listActive ? "" : caret}`;
  out.push(pad(prompt, W));

  // ── OFFENE FRAGEN (lower list) — waiting sessions + agents with last message ──
  out.push(rule(
    `${BOLD}${cWarn()}◐ ${t("openQuestions").toUpperCase()}${RESET} ${DIM}(${tabs.length})${RESET} `,
    ` ${cText()}Tab${RESET}${DIM} ${listActive ? t("toInput") : t("toList")}${RESET} `, W, "─", listActive ? TH().text : TH().textDim,
  ));
  const lsel = Math.min(Math.max(0, ui.listSel), tabs.length - 1);
  if (listActive) ui.listSel = lsel;
  const overflow = tabs.length > listMax;
  const showN = overflow ? listMax - 1 : listMax;
  tabs.slice(0, showN).forEach((t, i) => {
    const isActive = t.id === ui.focus;
    const isSel = listActive && i === lsel;
    const marker = isSel ? `${cText()}▶${RESET}` : isActive ? `${c(accent)}▌${RESET}` : " ";
    let gcol: RGB;
    let glyph: string;
    let label: string;
    if (t.kind === "agent") {
      gcol = agentStateColor(t.agent.state);
      glyph = t.agent.state === "busy" ? SPINNER[frame % SPINNER.length] : t.agent.state === "ready" ? "●" : "○";
      label = `${t.def?.key ?? "?"} ${agentName(t.agent)}`;
    } else {
      gcol = TH().warning;
      glyph = ICONS.waiting;
      label = `${t.def?.key ?? "?"} ${t.ss.title || dirName(t.ss.cwd)}`;
    }
    const last = lastMessageOf(t).replace(/\s+/g, " ");
    const left = `${marker} ${c(gcol)}${glyph}${RESET} ${isSel ? BOLD : ""}${trunc(label, 24)}${RESET}`;
    out.push(trunc(left + (last ? `  ${DIM}⟩ ${last}${RESET}` : ""), W));
  });
  if (overflow) out.push(`  ${DIM}… +${tabs.length - showN} ${t("further")}${RESET}`);

  // hints depend on which area has focus
  out.push(
    listActive
      ? `${cText()}↑/↓${RESET}${DIM} ${t("select")}${RESET}  ${cText()}⏎${RESET}${DIM} ${t("openVerb")}${RESET}  ` +
        `${cText()}Tab${RESET}${DIM} ${t("toInput")}${RESET}  ${cText()}Esc${RESET}${DIM} ${t("toInput")}${RESET}`
      : `${cText()}⏎${RESET}${DIM} ${focus.kind === "waiting" ? t("adoptSend") : t("send")}${RESET}  ` +
        `${cText()}^V${RESET}${DIM} ${t("pasteImage")}${RESET}  ${cText()}Tab${RESET}${DIM} ${t("downQuestions")}${RESET}  ` +
        `${cText()}^N${RESET}${DIM} ${t("new")}${RESET}  ${cText()}^R${RESET}${DIM} restart${RESET}  ${cText()}^K${RESET}${DIM} kill${RESET}  ${cText()}Esc${RESET}${DIM} ${t("back")}${RESET}`,
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
  const th = TH();
  return `${cText3()}${label}${RESET} ${c(heat(pct, th.success, th.warning, th.error))}${String(Math.round(pct * 100)).padStart(2)}%${RESET}`;
}

/** One instance row in the wizard: identity left, plan + load + live right. */
function wizardInstanceCell(s: InstanceState, on: boolean, w: number): string {
  const mark = on ? `${cText()}▶${RESET}` : " ";
  const dot = `${c(instColor(s.def.key))}●${RESET}`;
  const liveN = s.sessions.filter((x) => x.live).length;
  const name = `${on ? BOLD : ""}${c(instColor(s.def.key))}${s.def.key}${RESET} ${on ? BOLD : ""}${s.def.label}${RESET}`;
  const left = `${mark} ${dot} ${name}`;
  const right =
    (s.account.plan ? `${planChip(s.account.plan)} ` : "") +
    `${loadTag("5h", s.block5h.work, BUDGET_5H)} ${loadTag("wk", s.week.work, BUDGET_WEEK)} ` +
    `${liveN ? cAccHi() + String(liveN) + "↑" + RESET : DIM + "·" + RESET}`;
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
  const backdrop = ui.commander
    ? renderCommander(states, frame, now, W, height, ui)
    : renderGrid(states, frame, now, W, ui, height, registry);
  const accent = TH().accentHi;
  const B = (ch: string) => `${c(accent)}${ch}${RESET}`;
  const popupW = Math.min(W - 6, 124);
  const innerW = popupW - 2;
  const textW = innerW - 2;
  const bodyRows = Math.min(Math.max(8, height - 12), 24);
  const spin = SPINNER[frame % SPINNER.length];
  const title = `${c(accent)}${BOLD}${ICONS.issue} ${t("issueTitle")}${RESET}`;

  const place = (box: string[]): string[] => {
    const top = Math.max(2, Math.floor((height - box.length) / 2));
    const left = Math.max(0, Math.floor((W - popupW) / 2));
    return overlayBox(backdrop, surfaceBox(box, TH().raised), top, left);
  };

  const frameBox = (rows: string[], tag: string, hint: string): string[] => {
    const box: string[] = [];
    box.push(B("╭") + rule(` ${title} `, ` ${tag} `, innerW, "─", accent) + B("╮"));
    for (let i = 0; i < bodyRows; i++) box.push(B("│") + " " + pad(rows[i] ?? "", textW) + " " + B("│"));
    box.push(B("├") + `${c(accent)}${"─".repeat(innerW)}${RESET}` + B("┤"));
    box.push(B("│") + " " + pad(hint, textW) + " " + B("│"));
    box.push(B("╰") + `${c(accent)}${"─".repeat(innerW)}${RESET}` + B("╯"));
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
    const div = `${c(accent)}│${RESET}`;
    const leftW = Math.max(30, Math.floor(textW * 0.5));
    const rightW = textW - leftW - 3;

    const folderCells = folders.map((f, i) => {
      const on = i === fsel;
      const mark = on ? `${cText()}▶${RESET}` : " ";
      const name = f.slug ? `${cAcc()}${f.label}${RESET}` : `${cAcc()}${ICONS.folder} ${tilde(f.cwd)}${RESET}`;
      const left = `${mark} ${on ? BOLD : ""}${name}`;
      return spread(left, `${DIM}${f.users.length}× · ${timeAgo(now - f.lastTs)}${RESET}`, leftW);
    });
    const leftLines = paneLines(
      `${focusLeft ? BOLD + cText() : DIM}${t("issueRepoHdr")}${RESET}${DIM}  ${folders.length} · ${t("uses")} · ${t("last")}${RESET}`,
      folderCells, fsel, bodyRows, `${DIM}${t("noFolderHistory")}${RESET}`,
    );

    const caret = Math.floor(frame / 3) % 2 === 0 ? `${cText()}▏${RESET}` : " ";
    const wrapped = wrapText(ui.issueInput, rightW - 1);
    const rightLines: string[] = [`${!focusLeft ? BOLD + cText() : DIM}${t("issueDescHdr")}${RESET}`, ""];
    wrapped.forEach((l, i) => {
      const last = i === wrapped.length - 1;
      rightLines.push(`${cText2()}${l}${RESET}${!focusLeft && last ? caret : ""}`);
    });
    rightLines.push("", `${DIM}${t("issueDescHint")}${RESET}`);
    while (rightLines.length < bodyRows) rightLines.push("");

    const box: string[] = [];
    box.push(B("╭") + rule(` ${title} `, ` ${DIM}${t("issuePickTag")}${RESET} `, innerW, "─", accent) + B("╮"));
    for (let i = 0; i < bodyRows; i++) {
      box.push(B("│") + " " + pad(leftLines[i] ?? "", leftW) + " " + div + " " + pad(rightLines[i] ?? "", rightW) + " " + B("│"));
    }
    const hint = focusLeft
      ? `${cText()}↑/↓${RESET}${DIM} ${t("issueRepoShort")}${RESET}  ${cText()}Tab/→${RESET}${DIM} ${t("issueDescShort")}${RESET}  ${cText()}Esc${RESET}${DIM} ${t("closeShort")}${RESET}`
      : `${cText()}${t("type")}${RESET}${DIM} ${t("issueDescShort")}${RESET}  ${cText()}⏎${RESET}${DIM} ${t("issueDraftVerb")}${RESET}  ${cText()}Tab/←${RESET}${DIM} ${t("issueRepoShort")}${RESET}  ${cText()}Esc${RESET}`;
    box.push(B("├") + `${c(accent)}${"─".repeat(innerW)}${RESET}` + B("┤"));
    box.push(B("│") + " " + pad(hint, textW) + " " + B("│"));
    box.push(B("╰") + `${c(accent)}${"─".repeat(innerW)}${RESET}` + B("╯"));
    return place(box);
  }

  // ── drafting / creating: spinner ──
  if (ui.issueStage === "drafting" || ui.issueStage === "creating") {
    const label = ui.issueStage === "drafting"
      ? `${t("issueDrafting")} ${c(accent)}${ui.issueInstance || "?"}${RESET}${DIM} …${RESET}`
      : `${t("issueCreating")}`;
    const mid = [
      center(`${c(accent)}${spin}${RESET}  ${label}`, textW),
      "",
      center(`${DIM}${tilde(ui.issueRepo)}${RESET}`, textW),
    ];
    return frameBox(centered(mid), t("issueWorking"), `${cText()}Esc${RESET}${DIM} ${t("cancel")}${RESET}`);
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
      const caret = Math.floor(frame / 3) % 2 === 0 ? `${cText()}▏${RESET}` : " ";
      rows.push(`${c(accent)}${"─".repeat(textW)}${RESET}`);
      rows.push(`${BOLD}${cText()}${t("issueRewriteHdr")}${RESET}`);
      rows.push(`${cOk()}❯${RESET} ${cText2()}${trunc(ui.issueFeedback, textW - 4)}${RESET}${caret}`);
    }
    const tag = `${DIM}${scroll > 0 ? "↑ " : ""}${scroll < maxScroll ? "↓ " : ""}${tilde(ui.issueRepo)}${RESET}`;
    const hint = isRewrite
      ? `${cText()}⏎${RESET}${DIM} ${t("issueRedraft")}${RESET}  ${cText()}Esc${RESET}${DIM} ${t("back")}${RESET}`
      : `${cText()}⏎${RESET}${DIM} ${t("issueCreate")}${RESET}  ${cText()}r${RESET}${DIM} ${t("issueRewrite")}${RESET}  ${cText()}↑/↓${RESET}${DIM} ${t("scroll")}${RESET}  ${cText()}Esc${RESET}${DIM} ${t("cancel")}${RESET}`;
    return frameBox(rows, tag, hint);
  }

  // ── done ──
  if (ui.issueStage === "done") {
    const mid = [
      center(`${cOk()}✓ ${t("issueCreated")}${RESET}`, textW),
      "",
      ...wrapText(ui.issueUrl, textW - 4).map((l) => center(`${cAcc()}${l}${RESET}`, textW)),
    ];
    return frameBox(centered(mid), `${DIM}${tilde(ui.issueRepo)}${RESET}`, `${cText()}Esc${RESET}${DIM} ${t("closeShort")}${RESET}`);
  }

  // ── error ──
  const emid = [
    center(`${cErr()}✗ ${t("issueErr")}${RESET}`, textW),
    "",
    ...wrapText(ui.issueError, textW - 4).map((l) => center(`${cText2()}${l}${RESET}`, textW)),
  ];
  return frameBox(centered(emid), `${DIM}${tilde(ui.issueRepo)}${RESET}`, `${cText()}r${RESET}${DIM} ${t("issueRetry")}${RESET}  ${cText()}Esc${RESET}${DIM} ${t("closeShort")}${RESET}`);
}

/**
 * PR-Review modal: a centered popup that drives the whole pick → analyze → act
 * flow (stage held in ui.prStage). Structural twin of renderIssueModal, skinned
 * with the same theme tokens.
 *  - pick:      left = repos we've worked in, right = that repo's open PRs.
 *  - analyzing: spinner + elapsed seconds while a free instance analyzes the PR
 *               (analyzePR is headless `claude -p` — no live token/tool stream).
 *  - review:    color-coded verdict header + findings + Markdown report; act bar.
 *  - action-input: optional review body for comment / request-changes.
 *  - commenting/merging/launching: spinner while gh / the launch runs.
 *  - done/error: result message or a clear error.
 */
function renderPrModal(
  states: InstanceState[], registry: AgentRegistry | undefined, frame: number, now: number,
  W: number, height: number, ui: UIState,
): string[] {
  const backdrop = ui.commander
    ? renderCommander(states, frame, now, W, height, ui)
    : renderGrid(states, frame, now, W, ui, height, registry);
  const accent = TH().accentHi;
  const B = (ch: string) => `${c(accent)}${ch}${RESET}`;
  const popupW = Math.min(W - 6, 124);
  const innerW = popupW - 2;
  const textW = innerW - 2;
  const bodyRows = Math.min(Math.max(8, height - 12), 24);
  const spin = SPINNER[frame % SPINNER.length];
  const title = `${c(accent)}${BOLD}${ICONS.branch} ${t("prTitle")}${RESET}`;

  const place = (box: string[]): string[] => {
    const top = Math.max(2, Math.floor((height - box.length) / 2));
    const left = Math.max(0, Math.floor((W - popupW) / 2));
    return overlayBox(backdrop, surfaceBox(box, TH().raised), top, left);
  };
  const frameBox = (rows: string[], tag: string, hint: string): string[] => {
    const box: string[] = [];
    box.push(B("╭") + rule(` ${title} `, ` ${tag} `, innerW, "─", accent) + B("╮"));
    for (let i = 0; i < bodyRows; i++) box.push(B("│") + " " + pad(rows[i] ?? "", textW) + " " + B("│"));
    box.push(B("├") + `${c(accent)}${"─".repeat(innerW)}${RESET}` + B("┤"));
    box.push(B("│") + " " + pad(hint, textW) + " " + B("│"));
    box.push(B("╰") + `${c(accent)}${"─".repeat(innerW)}${RESET}` + B("╯"));
    return place(box);
  };
  const centered = (mid: string[]): string[] => {
    const top = Math.max(0, Math.floor((bodyRows - mid.length) / 2));
    return [...Array(top).fill(""), ...mid];
  };
  const caret = Math.floor(frame / 3) % 2 === 0 ? `${cText()}▏${RESET}` : " ";
  const riskColor = (r: PrAnalysis["riskLevel"]): RGB =>
    r === "high" ? TH().error : r === "low" ? TH().success : TH().warning;
  const recColor = (r: PrAnalysis["mergeRecommendation"]): RGB =>
    r === "merge" ? TH().success : r === "do-not-merge" ? TH().error
      : r === "changes-requested" ? TH().warning : TH().text3;

  // ── pick: repo (left) + open PRs (right) ──
  if (ui.prStage === "pick") {
    const repos = issueRepos(states);
    const rsel = clampIdx(ui.prRepoSel, repos.length);
    ui.prRepoSel = rsel;
    const psel = clampIdx(ui.prPrSel, ui.prList.length);
    ui.prPrSel = psel;
    const focusLeft = ui.prPane === "repo";
    const div = `${c(accent)}│${RESET}`;
    const leftW = Math.max(28, Math.floor(textW * 0.42));
    const rightW = textW - leftW - 3;

    const repoCells = repos.map((f, i) => {
      const on = i === rsel;
      const mark = on ? `${cText()}▶${RESET}` : " ";
      const name = f.slug ? `${cAcc()}${f.label}${RESET}` : `${cAcc()}${ICONS.folder} ${tilde(f.cwd)}${RESET}`;
      return spread(`${mark} ${on ? BOLD : ""}${name}`, `${DIM}${timeAgo(now - f.lastTs)}${RESET}`, leftW);
    });
    const leftLines = paneLines(
      `${focusLeft ? BOLD + cText() : DIM}${t("prRepoHdr")}${RESET}${DIM}  ${repos.length} · ${t("last")}${RESET}`,
      repoCells, rsel, bodyRows, `${DIM}${t("noFolderHistory")}${RESET}`,
    );

    const prCells = ui.prList.map((pr, i) => {
      const on = !focusLeft && i === psel;
      const mark = on ? `${cText()}▶${RESET}` : " ";
      const draft = pr.isDraft ? `${cDim()} ✎${RESET}` : "";
      const conflict = pr.mergeable === "CONFLICTING" ? ` ${cErr()}!${RESET}` : "";
      const left = `${mark} ${on ? BOLD : ""}${cText2()}#${pr.number}${RESET} ${trunc(pr.title, Math.max(8, rightW - 22))}${draft}${conflict}`;
      // the REST list endpoint may omit diff stats; show them when present, else the base branch
      const meta = pr.changedFiles > 0
        ? `+${pr.additions}/-${pr.deletions} ${pr.changedFiles}f`
        : pr.baseRefName ? `→ ${pr.baseRefName}` : "";
      return spread(left, `${DIM}${meta}${RESET}`, rightW);
    });
    const rightLines = paneLines(
      `${!focusLeft ? BOLD + cText() : DIM}${t("prListHdr")}${RESET}${DIM}  ${ui.prList.length}${RESET}`,
      prCells, psel, bodyRows, `${DIM}${t("prNoPrs")}${RESET}`,
    );

    const box: string[] = [];
    box.push(B("╭") + rule(` ${title} `, ` ${DIM}${t("prPickTag")}${RESET} `, innerW, "─", accent) + B("╮"));
    for (let i = 0; i < bodyRows; i++) {
      box.push(B("│") + " " + pad(leftLines[i] ?? "", leftW) + " " + div + " " + pad(rightLines[i] ?? "", rightW) + " " + B("│"));
    }
    const hint = focusLeft
      ? `${cText()}↑/↓${RESET}${DIM} ${t("issueRepoShort")}${RESET}  ${cText()}Tab/→${RESET}${DIM} PR${RESET}  ${cText()}Esc${RESET}${DIM} ${t("closeShort")}${RESET}`
      : `${cText()}↑/↓${RESET}${DIM} PR${RESET}  ${cText()}⏎${RESET}${DIM} ${t("prAnalyzeVerb")}${RESET}  ${cText()}Tab/←${RESET}${DIM} ${t("issueRepoShort")}${RESET}  ${cText()}Esc${RESET}`;
    box.push(B("├") + `${c(accent)}${"─".repeat(innerW)}${RESET}` + B("┤"));
    box.push(B("│") + " " + pad(hint, textW) + " " + B("│"));
    box.push(B("╰") + `${c(accent)}${"─".repeat(innerW)}${RESET}` + B("╯"));
    return place(box);
  }

  // ── analyzing / commenting / merging / launching: spinner (+ elapsed) ──
  if (ui.prStage === "analyzing" || ui.prStage === "commenting" || ui.prStage === "merging" || ui.prStage === "launching") {
    const label =
      ui.prStage === "analyzing" ? `${t("prAnalyzing")} ${c(accent)}${ui.prInstance || "?"}${RESET}${DIM} …${RESET}`
      : ui.prStage === "commenting" ? t("prCommenting")
      : ui.prStage === "merging" ? t("prMerging")
      : t("prLaunching");
    // analyzePR is headless → no token/tool stream; show wall-clock elapsed only.
    const secs = ui.prStart ? Math.max(0, Math.round((now - ui.prStart) / 1000)) : 0;
    const mid = [
      center(`${c(accent)}${spin}${RESET}  ${label}`, textW),
      "",
      center(`${DIM}${tilde(ui.prRepoCwd)}${RESET}`, textW),
      "",
      ui.prStage === "analyzing" ? center(`${DIM}${secs}s${RESET}`, textW) : "",
    ];
    return frameBox(centered(mid), t("issueWorking"), `${cText()}Esc${RESET}${DIM} ${t("cancel")}${RESET}`);
  }

  // ── review: verdict header + findings + Markdown report ──
  if (ui.prStage === "review" && ui.prAnalysis) {
    const a = ui.prAnalysis;
    const head: string[] = [
      `${BOLD}${t("prRisk")}: ${c(riskColor(a.riskLevel))}●${RESET} ${c(riskColor(a.riskLevel))}${a.riskLevel}${RESET}   ${t("prMergeLabel")}: ${c(recColor(a.mergeRecommendation))}${a.mergeRecommendation}${RESET}`,
      `${c(accent)}${"─".repeat(textW)}${RESET}`,
    ];
    const findingLines = a.findings.length
      ? [
          `${BOLD}${cText()}${t("prFindings")} (${a.findings.length})${RESET}`,
          ...a.findings.flatMap((f) =>
            wrapText(`[${f.category}/${f.severity}] ${f.title}${f.location ? ` (${f.location})` : ""}`, textW - 4)
              .map((l, i) => (i === 0 ? "  • " : "    ") + `${cText2()}${l}${RESET}`)),
          "",
        ]
      : [];
    const body = renderMarkdown(a.report, textW - 2);
    const all = [...head, ...findingLines, ...body];
    const maxScroll = Math.max(0, all.length - bodyRows);
    const scroll = Math.min(Math.max(0, ui.prScroll), maxScroll);
    ui.prScroll = scroll;
    const rows = all.slice(scroll, scroll + bodyRows);
    while (rows.length < bodyRows) rows.push("");
    const tag = `${DIM}${scroll > 0 ? "↑ " : ""}${scroll < maxScroll ? "↓ " : ""}#${a.pr.number} ${tilde(ui.prRepoCwd)}${RESET}`;
    const hint = `${cText()}a${RESET}${DIM} ${t("prApprove")}${RESET}  ${cText()}c${RESET}${DIM} ${t("prComment")}${RESET}  ${cText()}r${RESET}${DIM} ${t("prRequestChanges")}${RESET}  ${cText()}m${RESET}${DIM} ${t("prMergeVerb")}${RESET}  ${cText()}s${RESET}${DIM} ${t("prStartSession")}${RESET}  ${cText()}↑/↓${RESET}${DIM} ${t("scroll")}${RESET}  ${cText()}Esc${RESET}`;
    return frameBox(rows, tag, hint);
  }

  // ── action-input: review body for comment / request-changes ──
  if (ui.prStage === "action-input") {
    const rows: string[] = [
      `${BOLD}${cText()}${t("prActionInputHdr")}${RESET}`,
      "",
      `${cOk()}❯${RESET} ${cText2()}${trunc(ui.prActionInput, textW - 4)}${RESET}${caret}`,
    ];
    while (rows.length < bodyRows) rows.push("");
    return frameBox(rows, `${DIM}${tilde(ui.prRepoCwd)}${RESET}`, `${cText()}⏎${RESET}${DIM} ${t("send")}${RESET}  ${cText()}Esc${RESET}${DIM} ${t("back")}${RESET}`);
  }

  // ── done ──
  if (ui.prStage === "done") {
    const mid = [center(`${cOk()}✓ ${ui.prResult}${RESET}`, textW)];
    return frameBox(centered(mid), `${DIM}${tilde(ui.prRepoCwd)}${RESET}`, `${cText()}Esc${RESET}${DIM} ${t("closeShort")}${RESET}`);
  }

  // ── error ──
  const emid = [
    center(`${cErr()}✗ ${t("prErr")}${RESET}`, textW),
    "",
    ...wrapText(ui.prError, textW - 4).map((l) => center(`${cText2()}${l}${RESET}`, textW)),
  ];
  return frameBox(centered(emid), `${DIM}${tilde(ui.prRepoCwd)}${RESET}`, `${cText()}r${RESET}${DIM} ${t("prRetry")}${RESET}  ${cText()}Esc${RESET}${DIM} ${t("closeShort")}${RESET}`);
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
  const backdrop = ui.commander
    ? renderCommander(states, frame, now, W, height, ui)
    : renderGrid(states, frame, now, W, ui, height, registry);
  const accent = TH().accent;
  const folderMode = ui.pickerMode === "folder";
  const focusLeft = ui.pickerPane === "instance";
  const popupW = Math.min(W - 6, 124);
  const innerW = popupW - 2;
  const textW = innerW - 2;
  const B = (ch: string) => `${c(accent)}${ch}${RESET}`;
  const div = `${c(accent)}│${RESET}`;
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
      `${focusLeft ? BOLD + cText() : DIM}${t("instance").toUpperCase()}${RESET}${DIM}  Plan · 5h · wk · live${RESET}`,
      instCells, instSel, bodyRows, `${DIM}${t("noInstances")}${RESET}`,
    );

    const history = def
      ? [...new Set([...recentCwds(states, def.key), ...instanceFolders(def.configDir).map((f) => f.cwd)])]
      : recentCwds(states, ui.pickerInstance);
    const sugg = dirSuggestions(ui.pickerInput, history, 60);
    const valid = isDir(ui.pickerInput);
    const caret = Math.floor(frame / 3) % 2 === 0 ? `${cText()}▏${RESET}` : " ";
    const pcol = valid ? cText2() : cErr();
    const rsel = clampIdx(ui.pickerSel, sugg.length);
    ui.pickerSel = rsel;
    const suggCells = sugg.map((sg, i) => {
      const on = !focusLeft && i === rsel;
      const rl = repoLabel(sg);
      return `${on ? `${cText()}▶${RESET}` : " "} ${on ? BOLD : ""}${tilde(sg)}${RESET}${rl ? `  ${DIM}${rl}${RESET}` : ""}`;
    });
    // header band: path field + validity, then the windowed suggestion list
    const rHdr = `${!focusLeft ? BOLD + cText() : DIM}WORKING-FOLDER${RESET}${DIM}  ${sugg.length} ${t("fromHistory")}${RESET}`;
    const fieldRows = [
      `${cOk()}❯${RESET} ${pcol}${trunc(ui.pickerInput, rightW - 2)}${RESET}${focusLeft ? "" : caret}`,
      valid ? `${DIM}✓ ${t("folderExists")}${RESET}` : `${cErr()}✗ ${t("existsShort")}${RESET}`,
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
      const mark = i === fsel ? `${cText()}▶${RESET}` : " ";
      const rl = repoLabel(f.cwd);
      const name = rl ? `${cAcc()}${rl}${RESET}` : `${cAcc()}${ICONS.folder} ${tilde(f.cwd)}${RESET}`;
      const left = `${mark} ${i === fsel ? BOLD : ""}${name}`;
      return spread(left, `${DIM}${f.users.length}× · ${timeAgo(now - f.lastTs)}${RESET}`, leftW);
    });
    leftLines = paneLines(
      `${focusLeft ? BOLD + cText() : DIM}${t("folders").toUpperCase()}${RESET}${DIM}  ${folders.length} · ${t("uses")} · ${t("last")}${RESET}`,
      folderCells, fsel, bodyRows, `${DIM}${t("noFolderHistory")}${RESET}`,
    );

    const ordered = wizardOrderedInstances(states, folder);
    const usedTs = new Map((folder?.users ?? []).map((u) => [u.key, u.lastTs] as const));
    const isel = clampIdx(ui.pickerSel, ordered.length);
    ui.pickerSel = isel;
    const instCells = ordered.map((s, i) => {
      const on = !focusLeft && i === isel;
      const dot = `${c(instColor(s.def.key))}●${RESET}`;
      const used = usedTs.has(s.def.key);
      const tag = used ? `${cOk()}✓ ${timeAgo(now - usedTs.get(s.def.key)!)}${RESET}` : `${DIM}${t("override")}${RESET}`;
      const name = `${on ? BOLD : ""}${c(instColor(s.def.key))}${s.def.key}${RESET} ${on ? BOLD : ""}${s.def.label}${RESET}`;
      return spread(`${on ? `${cText()}▶${RESET}` : " "} ${dot} ${name}`, tag, rightW);
    });
    rightLines = paneLines(
      `${!focusLeft ? BOLD + cText() : DIM}${t("instance").toUpperCase()}${RESET}${DIM}  ${t("usedThisFolder")}${RESET}`,
      instCells, isel, bodyRows, `${DIM}—${RESET}`,
    );
  }

  // ── assemble the popup box ──
  const title = `${c(accent)}${BOLD}${ICONS.newAgent} ${t("newAgent")}${RESET}`;
  const modeTag = `${DIM}${folderMode ? t("modeFolderToInstance") : t("modeInstanceToFolder")} · ^T ${t("switches")}${RESET}`;
  const box: string[] = [];
  box.push(B("╭") + rule(` ${title} `, ` ${modeTag} `, innerW, "─", accent) + B("╮"));
  for (let i = 0; i < bodyRows; i++) {
    box.push(B("│") + " " + pad(leftLines[i] ?? "", leftW) + " " + div + " " + pad(rightLines[i] ?? "", rightW) + " " + B("│"));
  }
  const hint = focusLeft
    ? `${cText()}↑/↓${RESET}${DIM} ${folderMode ? t("folder") : t("instance")}${RESET}  ${cText()}Tab/→/⏎${RESET}${DIM} ${folderMode ? t("instance") : t("folder")}${RESET}  ${cText()}^T${RESET}${DIM} ${t("mode")}${RESET}  ${cText()}Esc${RESET}${DIM} ${t("closeShort")}${RESET}`
    : folderMode
      ? `${cText()}↑/↓${RESET}${DIM} ${t("instance")}${RESET}  ${cText()}⏎${RESET}${DIM} ${t("startHere")}${RESET}  ${cText()}Tab/←${RESET}${DIM} ${t("folder")}${RESET}  ${cText()}^T${RESET}${DIM} ${t("mode")}${RESET}  ${cText()}Esc${RESET}`
      : `${cText()}${t("type")}${RESET}${DIM} ${t("filter")}${RESET}  ${cText()}↑/↓${RESET}${DIM} ${t("folder")}${RESET}  ${cText()}→${RESET}${DIM} ${t("adoptShort")}${RESET}  ${cText()}⏎${RESET}${DIM} ${t("start")}${RESET}  ${cText()}Tab/←${RESET}${DIM} ${t("instance")}${RESET}  ${cText()}Esc${RESET}`;
  box.push(B("├") + `${c(accent)}${"─".repeat(innerW)}${RESET}` + B("┤"));
  box.push(B("│") + " " + pad(hint, textW) + " " + B("│"));
  box.push(B("╰") + `${c(accent)}${"─".repeat(innerW)}${RESET}` + B("╯"));

  const top = Math.max(2, Math.floor((height - box.length) / 2));
  const left = Math.max(0, Math.floor((W - popupW) / 2));
  return overlayBox(backdrop, surfaceBox(box, TH().raised), top, left);
}

/** Compact human byte size. */
function sizeFmt(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}K`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}M`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)}G`;
}

/** Context-sensitive F1–F10 labels for the active pane's view. */
function fkeysForView(view: PaneView): [string, string][] {
  const help: [string, string] = ["1", "Help"];
  const drv: [string, string] = ["2", "Drives"];
  const menu: [string, string] = ["9", "Menu"];
  const quit: [string, string] = ["10", "Quit"];
  const theme: [string, string] = ["8", "Theme"];
  switch (view) {
    case "tree": return [help, ["2", "Waiting"], ["3", "Open"], ["4", "New"], ["5", "Issue"], ["6", "Shell"], ["7", "Restart"], theme, ["9", "Files"], quit];
    case "session": return [help, ["2", "Waiting"], ["3", "Steer"], ["4", "New"], ["5", " "], ["6", "Shell"], ["7", "Restart"], theme, ["9", "Files"], quit];
    case "files": return [help, drv, ["3", "Shell"], ["4", "Launch"], ["5", "Copy"], ["6", "Attach"], ["7", "Stop"], theme, menu, quit];
    case "sessions": return [help, drv, ["3", "Open"], ["4", "Agent"], ["5", "Issue"], ["6", "Rename"], ["7", "Close"], theme, menu, quit];
    case "accounts": return [help, drv, ["3", "Sessions"], ["4", "Agent"], ["5", "Issue"], ["6", " "], ["7", " "], theme, menu, quit];
    case "fleet": return [help, drv, ["3", "Attach"], ["4", "Launch"], ["5", " "], ["6", " "], ["7", "Stop"], theme, menu, quit];
    default: return [help, drv, ["3", "Enter"], ["4", " "], ["5", " "], ["6", " "], ["7", " "], theme, menu, quit];
  }
}

/** The classic Midnight/Norton-Commander F1–F10 function-key bar. */
function fkeyBar(W: number, keys: [string, string][]): string {
  const th = TH();
  const cellW = Math.max(7, Math.floor(W / keys.length));
  let bar = "";
  for (const [num, label] of keys) {
    const body = ` ${label}`;
    const fill = Math.max(0, cellW - num.length - vwidth(body));
    // number dim + outside, label on a raised "pill" in bright text — the mc look
    bar += `${cText3()}${num}${RESET}${tbg(th.surface.top)}${cText()}${body}${" ".repeat(fill)}${RESET}`;
  }
  return trunc(bar, W);
}

/** One-line governor bar: PSS usage vs the RAM ceiling, heat-coloured. */
function governorBar(snap: RemoteSnapshot, w: number): string {
  const th = TH();
  const g = snap.governor;
  const pct = g.ceilingMb ? g.usedMb / g.ceilingMb : 0;
  const col = heat(pct, th.success, th.warning, th.error);
  const tag = ` ${tfg(col)}${BOLD}${g.usedMb}${RESET}${cText3()}/${g.ceilingMb}MB${RESET}  ${cText3()}${snap.servers.length} srv · ~${g.roomForSessions} more${RESET}${g.overCeiling ? `  ${cErr()}${ICONS.fail} OOM${RESET}` : g.overWarn ? `  ${cWarn()}!${RESET}` : ""}`;
  const barW = Math.max(8, w - 4 - vwidth(tag));
  return `${cText3()}RAM${RESET} ${meter(pct, barW, col, th.textDim)}${tag}`;
}

/**
 * The multi-host Commander (`h`). Ebene 0 lists the network neighbourhood (every
 * SSH/Tailscale/manual host + the local machine); entering a host opens Ebene 1,
 * a file browser over SSH/SFTP with shell-out and per-project remote-control
 * control. Pure render — async listings/snapshots are fetched in index.ts and
 * parked on ui (cmdEntries / cmdRemote), mirroring the issue-flow pattern.
 */
/** Legible state word (paired with colour) for the detail header. */
function stateWord(st: SessState): string {
  return st === "aktiv" ? "WORKING" : st === "wartet" ? "WAITING" : st === "monitor" ? "MONITOR" : "IDLE";
}

/**
 * Right-pane detail for the selected tree node. For an agent: its recent
 * conversation tail (so you read what it's doing / asking without leaving the
 * tree). For a project/host: a short hint. This is the master-detail "preview".
 */
function sessionDetail(it: PaneItem | undefined, width: number, _now: number): string[] {
  if (!it || it.kind === "up") return ["", `  ${cText3()}↑/↓ select an agent on the left${RESET}`];
  if (it.kind === "project") return ["", `  ${cAcc()}${ICONS.repo} ${it.label}${RESET}`, "", `  ${cText3()}⏎ expand · F4 new agent · F9 files${RESET}`];
  if (it.kind === "host") return ["", `  ${cAcc()}${ICONS.host} ${it.label}${RESET}`, "", `  ${cText3()}⏎ expand${RESET}`];
  if (it.kind !== "session") return ["", `  ${cText3()}↑/↓ select an agent · ⏎ to open it${RESET}`];
  const v = visual(it.state ?? "stale");
  const lines: string[] = [
    `${c(v.color)}${stateWord(it.state ?? "stale")}${RESET}  ${cText2()}${it.accountKey ?? ""}${RESET}  ${cText3()}${tilde(it.cwd ?? "")}${RESET}`,
    "",
  ];
  const segs = it.path ? readTranscript(it.path).slice(-60) : [];
  if (!segs.length) lines.push(`  ${cText3()}— no transcript yet —${RESET}`);
  else for (const l of transcriptDisplayLines(segs, width)) lines.push(l);
  lines.push("", `${cText3()}⏎ steer this agent${RESET}`);
  return lines;
}

/** Glyph + colours for one polymorphic pane row. */
function paneVisual(it: PaneItem): { icon: string; color: RGB; name: RGB; nav: boolean } {
  const th = TH();
  switch (it.kind) {
    case "up": return { icon: ICONS.folder, color: th.accent, name: th.text2, nav: true };
    case "host": return { icon: ICONS.host, color: it.online === false ? th.textDim : it.online ? th.success : th.text3, name: th.text, nav: true };
    case "project": return { icon: ICONS.repo, color: th.accent, name: th.text2, nav: true };
    case "drive": return { icon: ICONS.repo, color: th.accentHi, name: th.text, nav: true };
    case "dir": return { icon: ICONS.folder, color: th.accent, name: th.text2, nav: true };
    case "link": return { icon: ICONS.branch, color: th.text3, name: th.text3, nav: true };
    case "account": return { icon: ICONS.account, color: th.accentHi, name: th.text2, nav: true };
    case "session": { const v = visual(it.state ?? "stale"); return { icon: v.glyph, color: v.color, name: th.text2, nav: true }; }
    case "rcserver": return { icon: ICONS.background, color: th.accentHi, name: th.text2, nav: true };
    default: return { icon: ICONS.file, color: th.text3, name: th.text3, nav: false };
  }
}

const PANE_COLS: Record<PaneView, [string, string]> = {
  tree: ["", ""], session: ["", ""],
  hosts: ["Host", "Address"], drives: ["Drive", ""], files: ["Name", "Size"],
  accounts: ["Account", "Load"], sessions: ["Session", "State"], fleet: ["Server", "RAM"],
};

/**
 * The whole app: a polymorphic two-pane Commander. Each pane shows one "drive"
 * (hosts/files/accounts/sessions/fleet) and is rendered uniformly from its
 * `items`; navigation/listing lives in index.ts. Header breadcrumb + Name/Size-
 * style column header per view, plus the context F-key bar.
 */
function renderCommander(
  states: InstanceState[], frame: number, now: number, W: number, height: number, ui: UIState,
): string[] {
  const th = TH();
  const active = ui.cmdPanes[ui.cmdActive];
  // ── top "who needs me" bar: the single most important glance ──
  const allSess = states.flatMap((s) => s.sessions);
  const waitN = allSess.filter((x) => x.state === "wartet").length;
  const workN = allSess.filter((x) => x.state === "aktiv").length;
  const clock = new Date(now).toLocaleTimeString(localeTag());
  const tok5h = states.reduce((a, s) => a + s.block5h.work, 0);
  const waitStr = waitN
    ? `${cWarn()}${BOLD}● ${waitN} waiting${RESET}`
    : `${cText3()}● 0 waiting${RESET}`;
  const title = `${BOLD}${cAcc()}claudeplex${RESET} ${cText3()}${ICONS.host} ${active.host || "—"}${RESET}`;
  const summary =
    `${waitStr}  ${cOk()}${workN} working${RESET}  ` +
    `${cText3()}${formatTokens(tok5h)} 5h${RESET}  ${cAcc()}${clock}${RESET}`;
  const menu = `  ${cText3()}File   Agent   Remote   View   Help${RESET}`;
  const out: string[] = [rule(`${title} `, ` ${summary} `, W, "━", th.textDim), menu, ""];
  const boxW = Math.floor((W - 1) / 2);
  const pInner = boxW - 2;
  const bodyRows = Math.max(4, height - 9);

  // selection bar colours: bright accent bar on the active pane, faint on the other
  const selActive = lerp(th.raised.top, th.accent, 0.34);
  const selIdle = lerp(th.raised.top, th.text3, 0.16);

  const renderPane = (p: CmdPane, idx: number): string[] => {
    const isActive = idx === ui.cmdActive;
    const accent = isActive ? th.accent : undefined;
    // ── session detail view: mirror the LEFT tree's selected agent (master-detail) ──
    if (p.view === "session") {
      const lp = ui.cmdPanes[0];
      const selItem = lp.items[clampIdx(lp.sel, lp.items.length)];
      const isSess = selItem?.kind === "session";
      const slabel = isSess ? `${cAcc()}${trunc(selItem.label, pInner - 2)}${RESET}` : `${cText3()}Agent${RESET}`;
      const det = sessionDetail(selItem, pInner - 2, now);
      const view = det.slice(-bodyRows);
      while (view.length < bodyRows) view.unshift(""); // newest pinned to the bottom (chat-like)
      return panel(slabel, "", view, pInner, th.sunken, accent);
    }
    const label = `${isActive ? cAcc() : cText3()}${trunc(p.title || t("cmdNetwork"), pInner - 2)}${RESET}`;
    let content: string[];
    let selRow = -1;
    if (p.loading) content = ["", `  ${cText3()}${SPINNER[frame % SPINNER.length]} ${t("cmdLoading")}${RESET}`];
    else if (p.error) content = ["", ...wrap(p.error, pInner - 4, 4).map((l) => `  ${cErr()}${l}${RESET}`)];
    else {
      const sel = clampIdx(p.sel, p.items.length);
      const cells = p.items.map((it, i) => {
        const onSel = i === sel;
        const v = paneVisual(it);
        // tree rows carry an indent + an expand caret; flat rows get a leading space
        const indent = "  ".repeat(it.depth ?? 0);
        const caret = it.expandable ? (it.expanded ? "▾" : "▸") : " ";
        const lead = `${indent}${cText3()}${caret}${RESET}`;
        // selected row → bright text on the bar; else the per-kind name colour
        const nm = onSel ? `${BOLD}${cText()}${it.label}${RESET}` : `${tfg(v.name)}${it.label}${RESET}`;
        const meta = it.badge ?? it.meta ?? ""; // builder pre-colours badge/meta
        return spread(`${lead} ${tfg(v.color)}${v.icon}${RESET} ${nm}`, meta, pInner - 2);
      });
      const cap = Math.max(1, bodyRows - 1);
      const { slice, start } = windowAround(cells, sel, cap);
      const [c1, c2] = PANE_COLS[p.view];
      const colHdr = spread(`${cText3()}${c1}${RESET}`, `${cText3()}${c2}${RESET}`, pInner - 2);
      content = [colHdr, ...slice.map((cell, i) => {
        if (i === 0 && start > 0) return `${DIM}  ↑ ${start}${RESET}`;
        if (i === slice.length - 1 && start + cap < cells.length) return `${DIM}  ↓ ${cells.length - start - cap}${RESET}`;
        return cell;
      })];
      selRow = 1 + (sel - start); // header offset + position within the window
    }
    while (content.length < bodyRows) content.push("");
    return panel(label, "", content.slice(0, bodyRows), pInner, th.raised, accent, selRow, isActive ? selActive : selIdle);
  };

  const left = renderPane(ui.cmdPanes[0], 0);
  const right = renderPane(ui.cmdPanes[1], 1);
  const rows = Math.max(left.length, right.length);
  for (let i = 0; i < rows; i++) out.push((left[i] ?? "") + " " + (right[i] ?? ""));

  const hint = active.view === "tree" || active.view === "session"
    ? `${cText3()}↑↓ move · ⏎ open/steer · → expand · ← collapse · ${cText2()}w next-waiting${RESET}${cText3()} · n new · Tab pane${RESET}`
    : `${cText3()}↑↓ move · ⏎ open · ← up · Tab pane · F9 back to agents${RESET}`;
  out.push(ui.cmdFeedback ? `  ${cAccHi()}${trunc(ui.cmdFeedback, W - 4)}${RESET}` : `  ${hint}`);
  if (ui.cmdRemote) out.push(governorBar(ui.cmdRemote, W));
  out.push(fkeyBar(W, fkeysForView(active.view)));
  return out;
}

/**
 * Live theme quick-picker (the `p` overlay). Scrubbing the list previews the
 * theme immediately — the backdrop and the popup itself re-skin as you move — so
 * the choice is made by eye. Each row carries a swatch in its own accent shades.
 */
function renderThemePicker(
  states: InstanceState[], frame: number, now: number, W: number, height: number, ui: UIState,
  registry?: AgentRegistry,
): string[] {
  const backdrop = ui.commander
    ? renderCommander(states, frame, now, W, height, ui)
    : renderGrid(states, frame, now, W, ui, height, registry);
  const th = TH();
  const popupW = Math.min(W - 6, 52);
  const innerW = popupW - 2;
  const textW = innerW - 2;
  const sel = clampIdx(ui.themeSel, THEMES.length);
  const rows = THEMES.map((tm, i) => {
    const on = i === sel;
    const mark = on ? `${cText()}${ICONS.cursor}${RESET}` : " ";
    const live = tm.name === th.name ? `${cOk()} ${ICONS.ok}${RESET}` : "";
    const name = on ? `${BOLD}${cText()}${tm.label}${RESET}` : `${cText2()}${tm.label}${RESET}`;
    const swatch = `${tfg(tm.accent)}███${RESET}${tfg(tm.accentHi)}██${RESET}${tfg(tm.success)}█${RESET}${tfg(tm.warning)}█${RESET}${tfg(tm.error)}█${RESET}`;
    return spread(`${mark} ${name}${live}`, swatch, textW);
  });
  const title = `${cAcc()}${BOLD}${ICONS.context} ${t("themeTitle")}${RESET}`;
  const content = ["", ...rows, "", `${DIM}${t("themeHint")}${RESET}`];
  const box = panel(title, "", content, innerW, th.raised, th.accent);
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
  const accent = def ? instColor(def.key) : TH().accent;
  const innerW = W - 2;
  const textW = innerW - 2;
  const recents = recentCwds(states, ui.pickerInstance);
  const sugg = dirSuggestions(ui.pickerInput, recents);
  const valid = isDir(ui.pickerInput);

  const title = `${c(accent)}${BOLD}${ICONS.folder} ${t("workingFolder")}${RESET} ${DIM}· Agent → ${def?.key ?? ""} ${def?.label ?? ""}${RESET}`;
  const caret = Math.floor(frame / 3) % 2 === 0 ? `${cText()}▏${RESET}` : " ";
  const pcol = valid ? cText2() : cErr();
  const content: string[] = [
    `${cOk()}${ICONS.prompt}${RESET} ${pcol}${ui.pickerInput}${RESET}${caret}`,
    valid ? `${cOk()}${ICONS.ok} ${t("folderExists")}${RESET}` : `${cErr()}${ICONS.fail} ${t("folderMissing")}${RESET}`,
    `${DIM}${recents.length ? t("recentFirst") : t("typePath")}${RESET}`,
  ];

  const sel = Math.min(Math.max(0, ui.pickerSel), Math.max(0, sugg.length - 1));
  ui.pickerSel = sel;
  const room = Math.max(3, height - 8);
  if (!sugg.length) content.push(`${DIM}${t("noSuggestions")}${RESET}`);
  for (const [i, s] of sugg.slice(0, room).entries()) {
    const on = i === sel;
    const mark = on ? `${cText()}${ICONS.cursor}${RESET}` : " ";
    content.push(on ? `${mark} ${BOLD}${tilde(s)}${RESET}` : `${mark} ${tilde(s)}`);
  }
  for (const l of panel(title, "", content, innerW, TH().raised, accent)) out.push(l);
  out.push("");
  out.push(
    `${cText()}↑/↓${RESET}${DIM} ${t("select")}${RESET}  ${cText()}Tab/→${RESET}${DIM} ${t("takeover")}${RESET}  ` +
    `${cText()}⏎${RESET}${DIM} ${t("startHere")}${RESET}  ${cText()}Esc${RESET}${DIM} ${t("cancel")}${RESET}`,
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
  const pink = tfg(TH().accent);
  const out: string[] = ["", "", ""];
  const bw = Math.max(...BANNER.map(vwidth));
  const margin = " ".repeat(Math.max(0, Math.floor((W - bw) / 2)));
  for (const l of BANNER) out.push(margin + pink + l + RESET);
  out.push("");
  out.push(center(`${DIM}one terminal · every Claude · multiplexed${RESET}`, W));
  out.push("");
  out.push(center(`${cText2()}No Claude Code accounts found on this machine.${RESET}`, W));
  out.push(center(`${DIM}Install Claude Code and sign in with ${RESET}${cAcc()}claude${RESET}${DIM}, then press ${RESET}${cText()}r${RESET}${DIM}.${RESET}`, W));
  out.push("");
  out.push(center(`${DIM}Running several accounts? Give each its own ${RESET}${cAcc()}CLAUDE_CONFIG_DIR${RESET}${DIM} (e.g. ~/.claude-work).${RESET}`, W));
  out.push(center(`${DIM}Claudeplex auto-discovers every ${RESET}${cAcc()}~/.claude*${RESET}${DIM} config dir.${RESET}`, W));
  out.push("");
  out.push(center(`${cText()}[r]${RESET}${DIM} rescan${RESET}   ${cText()}[q]${RESET}${DIM} quit${RESET}`, W));
  while (out.length < height - 1) out.push("");
  return out;
}

export function render(
  states: InstanceState[], frame: number, now: number, width: number, ui?: UIState, height = 40,
  registry?: AgentRegistry,
): string[] {
  const W = Math.max(MIN_CARD + 4, width - 2); // reserve a right gutter so cards never overflow
  const th = getTheme();
  // grey-ramp shade per instance, set once per frame and keyed by instance id
  shadeMap = new Map(states.map((s, i) => [s.def.key, instanceShade(i, states.length)]));
  const onPage = (lines: string[]): string[] =>
    lines.map((l, i) => pageWrap(trunc(l, W), gradientRow(th.page, i, height)));
  // the Commander browses remote hosts and needs no local accounts
  if (!states.length && !ui?.commander) return onPage(renderEmpty(W, height));
  const state: UIState = ui ?? {
    sel: -1, expanded: false, sessSel: 0, transcript: false, scroll: 0,
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
  // Overlays + full-screen views win over the Commander (the default surface).
  let out: string[];
  if (state.themePicker) out = renderThemePicker(states, frame, now, W, height, state, registry);
  else if (state.picker === "issue") out = renderIssueModal(states, registry, frame, now, W, height, state);
  else if (state.picker === "pr") out = renderPrModal(states, registry, frame, now, W, height, state);
  else if (state.picker === "wizard") out = renderWizard(states, registry, frame, now, W, height, state);
  else if (state.picker === "cwd") out = renderPicker(states, frame, now, W, height, state);
  else if (state.cockpit && registry) out = renderCockpit(states, registry, frame, now, W, height, state);
  else if (state.expanded && state.transcript) out = renderTranscript(states, frame, now, W, height, state);
  else if (state.expanded) out = renderDetail(states, frame, now, W, state);
  else if (state.commander) out = renderCommander(states, frame, now, W, height, state);
  else out = renderGrid(states, frame, now, W, state, height, registry);
  return onPage(out);
}
