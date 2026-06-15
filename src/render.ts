import type { InstanceState, SessionSummary, Status } from "./collect.ts";
import { readTranscript, type TLine } from "./collect.ts";
import { BUDGET_5H, BUDGET_WEEK } from "./instances.ts";
import { formatCost, formatDuration, formatTokens, type WindowTotals } from "./usage.ts";
import {
  RESET, BOLD, DIM, fg, bg, vwidth, pad, trunc, rule, meter, heat,
} from "./ui.ts";
import { isFlashing, type SessState } from "./tracker.ts";
import type { AgentRegistry } from "./agents.ts";
import type { ManagedAgent, AgentLine } from "./agent.ts";
import { dirSuggestions, expandTilde, isDir } from "./paths.ts";
import { renderMarkdown } from "./markdown.ts";
import { statuslineLines } from "./statusline.ts";
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
  const badge = `${fg(v.color)}${glyph} ${state.padEnd(7)}${RESET}`;
  const name = ss.title
    ? `${BOLD}${ss.title}${RESET}`
    : ss.cwd ? `${DIM}~${dirName(ss.cwd)}${RESET}` : `${DIM}(ohne Titel)${RESET}`;
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
    out.push(`${DIM}keine Sessions${RESET}`);
    return out;
  }
  const liveN = shown.filter((x) => x.live).length;
  const workN = shown.filter((x) => x.working).length;
  const staleN = shown.length - liveN;
  const groups = groupByFolder(shown);
  out.push(
    `${fg(accent)}▸${RESET} ${BOLD}${liveN} laufend${RESET} ${DIM}(${workN} aktiv)${RESET}` +
    (staleN ? `  ${DIM}· ${staleN} zuletzt${RESET}` : "") +
    `  ${DIM}·${RESET} ${fg(accent)}${groups.length} Ordner${RESET}`,
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
  if (shown.length > count) out.push(`${DIM}  … +${shown.length - count} weitere${RESET}`);
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
  const clock = new Date(now).toLocaleTimeString("de-DE");
  const title = `${SPINNER[frame % SPINNER.length]} ${BOLD}${fg(45)}CLAUDE CODE${RESET} ${DIM}│${RESET} ${BOLD}MULTI-INSTANCE${RESET}`;
  const summary =
    `${fg(51)}${BOLD}${liveSess}${RESET} Sessions live  ${fg(46)}●${RESET} ${workingSess} working  ` +
    `${DIM}│${RESET} ${liveInst}/${states.length} Instanzen  ` +
    `${DIM}│${RESET} 5h ${BOLD}${formatTokens(tok5h)}${RESET} ${DIM}tok${RESET} ${formatCost(cost5h)}  ` +
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
  // working-folder picker (shown before a fresh agent launches)
  picker: "" | "cwd"; // active picker ("" = none)
  pickerInput: string; // editable path buffer
  pickerSel: number; // highlighted suggestion index
  pickerInstance: string; // instance key the agent will launch into
  // intake overview: PAI statusline + waiting sessions with direct intake
  intake: boolean;
  // grid: which of the three regions has focus (Tab / 1-3)
  gridRegion: "cards" | "live" | "questions";
  closeArm: string; // sessionId armed for close-confirm in the questions list
  renaming: string; // sessionId being renamed ("" = not renaming); buffer = input
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
  return states
    .flatMap((s) =>
      s.sessions.filter((ss) => ss.state === "wartet" || ss.state === "stale").map((ss) => ({ def: s.def, ss })))
    .sort((a, b) =>
      a.ss.state === b.ss.state ? b.ss.lastTs - a.ss.lastTs : a.ss.state === "wartet" ? -1 : 1);
}

/** Live tail (last 5 lines) of each actively-working session, below the grid.
 *  Tools/results are progressively indented to show the call hierarchy. */
function liveOutputBlock(states: InstanceState[], W: number, focused = false): string[] {
  const active = states.flatMap((s) => s.sessions.filter((x) => x.working).map((ss) => ({ s, ss })));
  const out: string[] = [""];
  const hcol = focused ? 231 : 46;
  out.push(rule(`${BOLD}${fg(hcol)}② LIVE OUTPUT${RESET} `, ` ${DIM}${active.length} aktiv${RESET}`, W, "━", focused ? 231 : 240));
  if (!active.length) {
    out.push(`  ${DIM}keine Session generiert gerade${RESET}`);
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
  if (active.length > CAP) out.push(`${DIM}  … +${active.length - CAP} weitere aktive Sessions${RESET}`);
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
    `${chip("①", "Karten", region === "cards")}  ${chip("②", "Live", region === "live")}  ` +
    `${chip("③", "Offene Fragen", region === "questions")}   ${DIM}Tab / 1-3 wechseln${RESET}`,
  );
  out.push("");

  for (let i = 0; i < cards.length; i += cols) {
    for (const line of gridRow(cards.slice(i, i + cols), gap)) out.push(line);
    out.push("");
  }

  // ② live output
  for (const l of liveOutputBlock(states, W, region === "live")) out.push(l);

  // ③ waiting for input + stale — closeable sessions with last message
  const qs = closeableSessions(states);
  const qFocus = region === "questions";
  const ws = qs.filter((q) => q.ss.state === "wartet").length;
  const st = qs.length - ws;
  out.push("");
  out.push(rule(
    `${BOLD}${fg(qFocus ? 231 : 220)}③ WAITING / STALE${RESET} ${DIM}(${ws} wartet · ${st} stale)${RESET} `,
    qFocus ? ` ${DIM}↑/↓ wählen · ⏎ öffnen · e umbenennen · x schließen${RESET} ` : "", W, "━", qFocus ? 231 : 240,
  ));
  if (ui.renaming) {
    const caret = Math.floor(frame / 3) % 2 === 0 ? `${fg(231)}▏${RESET}` : " ";
    out.push(`  ${fg(213)}✎ Umbenennen:${RESET} ${ui.input}${caret}   ${DIM}⏎ speichern · Esc abbrechen${RESET}`);
  }
  if (!qs.length) out.push(`  ${DIM}keine Sessions${RESET}`);
  const TW = 24; // title column width
  const PW = 28; // path column width
  if (qs.length) {
    // header aligned with the marker(1)+space prefix
    out.push(`  ${DIM}${pad("INST", 4)} ${pad("STATE", 7)} ${pad("TITEL", TW)} ${pad("PFAD", PW)} LETZTE NACHRICHT${RESET}`);
  }
  const lsel = Math.min(Math.max(0, ui.listSel), Math.max(0, qs.length - 1));
  // autoscale: show as many rows as fit the terminal (reserve ↑/↓ + blank + legend + hints)
  const qMax = Math.max(3, height - out.length - 5);
  // window the list so the selection stays visible when it overflows
  const start = Math.min(Math.max(0, lsel - qMax + 1), Math.max(0, qs.length - qMax));
  if (start > 0) out.push(`  ${DIM}↑ ${start} weitere${RESET}`);
  qs.slice(start, start + qMax).forEach((w, idx) => {
    const i = start + idx;
    const sel = qFocus && i === lsel;
    const armed = ui.closeArm === w.ss.sessionId;
    const open = !!registry?.forSession(w.ss.sessionId);
    const v = visual(w.ss.state);
    const marker = armed ? `${fg(196)}✗${RESET}` : sel ? `${fg(231)}▶${RESET}` : open ? `${fg(46)}●${RESET}` : " ";
    const inst = `${fg(w.def.color)}${pad(w.def.key, 4)}${RESET}`;
    const stateTag = open ? `${fg(46)}${pad("✎ offen", 7)}${RESET}` : `${fg(v.color)}${pad(w.ss.state, 7)}${RESET}`;
    const titleRaw = registry?.nameOverride(w.ss.sessionId) ?? (w.ss.title || "~" + dirName(w.ss.cwd));
    const title = pad(`${sel ? `${BOLD}${fg(231)}` : fg(252)}${titleRaw}${RESET}`, TW);
    const path = `${DIM}${pad(pathCol(w.ss.cwd, PW), PW)}${RESET}`;
    const last = (w.ss.activity || "").replace(/\s+/g, " ");
    const msg = armed
      ? `${fg(196)}schließen? [x] bestätigen · andere Taste = abbrechen${RESET}`
      : `${DIM}${last}${RESET}`;
    out.push(trunc(`${marker} ${inst} ${stateTag} ${title} ${path} ${msg}`, W));
  });
  const below = qs.length - (start + Math.min(qMax, qs.length - start));
  if (below > 0) out.push(`  ${DIM}↓ ${below} weitere${RESET}`);

  out.push("");
  out.push(
    `${fg(46)}◆ aktiv${RESET} ${DIM}·${RESET} ${fg(39)}◑ monitor${RESET} ${DIM}·${RESET} ${fg(220)}◐ wartet${RESET} ${DIM}·${RESET} ${fg(245)}○ stale${RESET}`,
  );
  out.push(
    qFocus
      ? `${fg(231)}↑/↓${RESET}${DIM} Frage${RESET}  ${fg(231)}⏎${RESET}${DIM} antworten → Cockpit${RESET}  ` +
        `${fg(231)}[x]${RESET}${DIM} Session schließen${RESET}  ${fg(231)}Tab/1-3${RESET}${DIM} Bereich${RESET}  ${DIM}[q] quit${RESET}`
      : `${fg(231)}↑/↓${RESET}${DIM} Instanz${RESET}  ${fg(231)}→/⏎${RESET}${DIM} Sessions${RESET}  ` +
        `${fg(231)}Tab/1-3${RESET}${DIM} Bereich${RESET}  ${fg(231)}[c]${RESET}${DIM} Cockpit${RESET}  ${fg(231)}[p]${RESET}${DIM} Intake${RESET}  ` +
        `${fg(231)}[n]${RESET}${DIM} Agent${RESET}  ${fg(231)}[A]${RESET}${DIM} alle 4${RESET}  ${DIM}[r/q]${RESET}`,
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
  if (!flat.length) content.push(`${DIM}keine echten Sessions auf dieser Instanz${RESET}`);

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
        : nm ? `${DIM}~${nm}${RESET}` : `${DIM}(ohne Titel)${RESET}`;
      const ago = `${DIM}${timeAgo(now - ss.lastTs)}${RESET}`;
      const tag = `${fg(v.color)}${state}${RESET}`;
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
        content.push("      " + trunc(`${ctxStr}${mdlStr}${thinkStr}`, textW - 6));
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
    : `${DIM}keine${RESET}`;
  const B = (ch: string) => `${fg(accent)}${ch}${RESET}`;

  const out = headerLines(states, frame, now, W);
  out.push(B("╭") + rule(` ${label} `, ` ${badge} `, innerW, "─", accent) + B("╮"));
  for (const l of content) out.push(B("│") + " " + pad(l, textW) + " " + B("│"));
  out.push(B("╰") + `${fg(accent)}${"─".repeat(innerW)}${RESET}` + B("╯"));
  out.push("");
  out.push(
    `${fg(231)}↑/↓${RESET}${DIM} Session${RESET}  ${fg(231)}→/⏎${RESET}${DIM} Transcript (letzte 200 Zeilen)${RESET}  ` +
    `${fg(231)}←/Esc${RESET}${DIM} Grid${RESET}  ${DIM}[q] beenden${RESET}`,
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
    out.push(`${DIM}keine Session${RESET}`);
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

  const name = ss.title || (ss.cwd ? "~" + dirName(ss.cwd) : "(ohne Titel)");
  const label = `${fg(accent)}${BOLD}📄 ${s.def.key}${RESET} ${BOLD}${trunc(name, 46)}${RESET}  ${DIM}${dirName(ss.cwd)}${RESET}`;
  const pos = `${DIM}${start + 1}–${end} / ${pool.length}${scroll > 0 ? " ↑" : ""}${RESET}`;
  const B = (ch: string) => `${fg(accent)}${ch}${RESET}`;
  out.push(B("╭") + rule(` ${label} `, ` ${pos} `, innerW, "─", accent) + B("╮"));
  for (const l of view) out.push(B("│") + " " + pad(l, textW) + " " + B("│"));
  for (let i = view.length; i < vh; i++) out.push(B("│") + " " + pad("", textW) + " " + B("│"));
  out.push(B("╰") + `${fg(accent)}${"─".repeat(innerW)}${RESET}` + B("╯"));
  out.push("");
  out.push(
    `${fg(231)}↑/↓${RESET}${DIM} scrollen${RESET}  ${fg(231)}PgUp/PgDn${RESET}${DIM} seitenweise${RESET}  ` +
    `${fg(231)}←/Esc${RESET}${DIM} zurück${RESET}  ${DIM}[q] beenden${RESET}`,
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
    out.push(`${DIM}keine Agents und keine wartenden Sessions.${RESET}`);
    out.push("");
    out.push(`${fg(231)}[n]${RESET}${DIM} Agent starten${RESET}  ` +
      `${fg(231)}[A]${RESET}${DIM} alle 4 starten${RESET}  ${fg(231)}Esc${RESET}${DIM} zurück${RESET}`);
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
      `  ${fg(AGENT_STATE_COLOR[a.state] ?? 245)}${a.state === "ready" ? "wartet auf Eingabe" : a.state}${RESET}` +
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
      `  ${fg(220)}wartet auf Eingabe${RESET}`;
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
    ? `${fg(196)}✗ Agent beendet${RESET}`
    : `${listActive ? DIM : fg(46)}❯${RESET} ${listActive ? DIM : ""}${ui.input}${RESET}${imgTag}${listActive ? "" : caret}`;
  out.push(pad(prompt, W));

  // ── OFFENE FRAGEN (lower list) — waiting sessions + agents with last message ──
  out.push(rule(
    `${BOLD}${fg(220)}◐ OFFENE FRAGEN${RESET} ${DIM}(${tabs.length})${RESET} `,
    ` ${fg(231)}Tab${RESET}${DIM} ${listActive ? "→ Eingabe" : "→ Liste"}${RESET} `, W, "─", listActive ? 231 : 240,
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
  if (overflow) out.push(`  ${DIM}… +${tabs.length - showN} weitere${RESET}`);

  // hints depend on which area has focus
  out.push(
    listActive
      ? `${fg(231)}↑/↓${RESET}${DIM} wählen${RESET}  ${fg(231)}⏎${RESET}${DIM} öffnen${RESET}  ` +
        `${fg(231)}Tab${RESET}${DIM} → Eingabe${RESET}  ${fg(231)}Esc${RESET}${DIM} → Eingabe${RESET}`
      : `${fg(231)}⏎${RESET}${DIM} ${focus.kind === "waiting" ? "übernehmen & senden" : "senden"}${RESET}  ` +
        `${fg(231)}^V${RESET}${DIM} Bild einfügen${RESET}  ${fg(231)}Tab${RESET}${DIM} ↓ Fragen${RESET}  ` +
        `${fg(231)}^N${RESET}${DIM} neu${RESET}  ${fg(231)}^R${RESET}${DIM} restart${RESET}  ${fg(231)}^K${RESET}${DIM} kill${RESET}  ${fg(231)}Esc${RESET}${DIM} zurück${RESET}`,
  );
  return out;
}

/** Recent distinct working folders seen on an instance (for picker suggestions). */
export function recentCwds(states: InstanceState[], instanceKey: string): string[] {
  const st = states.find((s) => s.def.key === instanceKey);
  return [...new Set((st?.sessions ?? []).map((s) => s.cwd).filter(Boolean))];
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

  const title = `${fg(accent)}${BOLD}📂 Working-Folder${RESET} ${DIM}· Agent → ${def?.key ?? ""} ${def?.label ?? ""}${RESET}`;
  out.push(B("╭") + rule(` ${title} `, "", innerW, "─", accent) + B("╮"));

  const caret = Math.floor(frame / 3) % 2 === 0 ? `${fg(231)}▏${RESET}` : " ";
  const pcol = valid ? fg(252) : fg(196);
  out.push(B("│") + " " + pad(`${fg(46)}❯${RESET} ${pcol}${ui.pickerInput}${RESET}${caret}`, textW) + " " + B("│"));
  out.push(B("│") + " " + pad(valid ? `${DIM}✓ Ordner existiert${RESET}` : `${fg(196)}✗ Ordner existiert nicht${RESET}`, textW) + " " + B("│"));
  out.push(B("│") + " " + pad(`${DIM}${recents.length ? "zuletzt benutzt zuerst · Tippen filtert Unterordner" : "Pfad tippen, Tab vervollständigt"}${RESET}`, textW) + " " + B("│"));

  const sel = Math.min(Math.max(0, ui.pickerSel), Math.max(0, sugg.length - 1));
  ui.pickerSel = sel;
  const room = Math.max(3, height - out.length - 4);
  if (!sugg.length) {
    out.push(B("│") + " " + pad(`${DIM}keine Vorschläge${RESET}`, textW) + " " + B("│"));
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
    `${fg(231)}↑/↓${RESET}${DIM} wählen${RESET}  ${fg(231)}Tab/→${RESET}${DIM} übernehmen${RESET}  ` +
    `${fg(231)}⏎${RESET}${DIM} hier starten${RESET}  ${fg(231)}Esc${RESET}${DIM} abbrechen${RESET}`,
  );
  return out;
}

/** Intake overview: real PAI statusline (selected instance) + waiting sessions. */
function renderIntake(
  states: InstanceState[], frame: number, now: number, W: number, height: number, ui: UIState,
): string[] {
  const s = states[Math.min(Math.max(0, ui.sel), states.length - 1)];
  const out: string[] = [];
  out.push(rule(
    `${SPINNER[frame % SPINNER.length]} ${BOLD}${fg(45)}INTAKE${RESET} ${DIM}│${RESET} ${fg(s.def.color)}${BOLD}${s.def.key} ${s.def.label}${RESET} `,
    ` ${DIM}PAI Statusline${RESET} `, W, "━", 240,
  ));
  const sl = statuslineLines(s.def.key);
  if (sl.length) for (const l of sl) out.push(l);
  else out.push(`${DIM}  Statusline lädt … (↑/↓ wechselt Instanz)${RESET}`);
  out.push("");

  const waiting = waitingSessions(states);
  out.push(rule(
    `${BOLD}${fg(220)}◐ WARTET AUF DICH${RESET} `,
    ` ${DIM}${waiting.length} Session${waiting.length === 1 ? "" : "s"}${RESET} `, W, "─", 240,
  ));
  if (!waiting.length) out.push(`  ${DIM}keine Session wartet gerade auf Input${RESET}`);
  waiting.slice(0, 9).forEach((w, i) => {
    const ss = w.ss;
    const num = `${bg(238)}${fg(231)}${BOLD} ${i + 1} ${RESET}`;
    const name = ss.title ? `${BOLD}${ss.title}${RESET}` : `${DIM}~${dirName(ss.cwd)}${RESET}`;
    const right = `${fg(w.def.color)}${w.def.key}${RESET}  ${DIM}${dirName(ss.cwd)} · ${timeAgo(now - ss.lastTs)}${RESET}`;
    out.push("  " + spread(`${num} ${name}`, right, W - 4));
    if (ss.activity) out.push("      " + trunc(`${DIM}⟩ ${ss.activity}${RESET}`, W - 8));
  });
  if (waiting.length > 9) out.push(`  ${DIM}… +${waiting.length - 9} weitere${RESET}`);
  out.push("");
  out.push(
    `${fg(231)}1–9${RESET}${DIM} Session übernehmen → Cockpit${RESET}  ` +
    `${fg(231)}↑/↓${RESET}${DIM} Instanz (Statusline)${RESET}  ${fg(231)}Esc${RESET}${DIM} zurück${RESET}`,
  );
  return out;
}

export function render(
  states: InstanceState[], frame: number, now: number, width: number, ui?: UIState, height = 40,
  registry?: AgentRegistry,
): string[] {
  const W = Math.max(MIN_CARD + 4, width - 2); // reserve a right gutter so cards never overflow
  const state: UIState = ui ?? {
    sel: -1, expanded: false, sessSel: 0, transcript: false, scroll: 0,
    cockpit: false, focus: "", input: "", cockpitArea: "input", listSel: 0, pendingImages: [],
    picker: "", pickerInput: "", pickerSel: 0, pickerInstance: "", intake: false,
    gridRegion: "cards", closeArm: "", renaming: "",
  };
  let out: string[];
  if (state.intake) out = renderIntake(states, frame, now, W, height, state);
  else if (state.picker === "cwd") out = renderPicker(states, frame, now, W, height, state);
  else if (state.cockpit && registry) out = renderCockpit(states, registry, frame, now, W, height, state);
  else if (state.expanded && state.transcript) out = renderTranscript(states, frame, now, W, height, state);
  else if (state.expanded) out = renderDetail(states, frame, now, W, state);
  else out = renderGrid(states, frame, now, W, state, height, registry);
  return out.map((l) => trunc(l, W));
}
