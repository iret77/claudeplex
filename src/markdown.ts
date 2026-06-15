/**
 * Minimal Markdown -> ANSI renderer for the transcript and live views. Handles
 * the things that actually show up in Claude output and read badly as raw text:
 * tables (aligned box tables), headings, bullet/numbered lists, block quotes,
 * fenced code, horizontal rules, and inline **bold** / *italic* / `code`.
 *
 * Output is an array of styled, width-bounded lines. Pure module.
 */
import { RESET, BOLD, DIM, ITAL, fg, vwidth, pad, trunc } from "./ui.ts";

const CODE = 180; // inline code / fences
const H = 81; // headings
const RULE = 240;
const BULLET = 250;

/** Apply inline styling. Code spans are protected first so their content is raw. */
export function inline(s: string): string {
  const codes: string[] = [];
  let t = s.replace(/`([^`]+)`/g, (_m, c) => {
    codes.push(c);
    return "\x00" + (codes.length - 1) + "\x00";
  });
  t = t
    .replace(/\*\*([^*]+)\*\*/g, (_m, b) => `${BOLD}${b}${RESET}`)
    .replace(/__([^_]+)__/g, (_m, b) => `${BOLD}${b}${RESET}`)
    .replace(/(^|[^*])\*([^*\n]+)\*/g, (_m, p, i) => `${p}${ITAL}${i}${RESET}`)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, (_m, txt) => `${fg(H)}${txt}${RESET}`);
  t = t.replace(/\x00(\d+)\x00/g, (_m, n) => `${fg(CODE)}${codes[Number(n)]}${RESET}`);
  return t;
}

/** Word-wrap raw text to a visible width (ANSI-unaware input). */
function wrapRaw(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [""];
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && vwidth(`${cur} ${w}`) > width) {
      lines.push(cur);
      cur = w;
    } else {
      cur = cur ? `${cur} ${w}` : w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

const SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function renderTable(rows: string[][], width: number): string[] {
  const cols = Math.max(...rows.map((r) => r.length));
  const norm = rows.map((r) => {
    const c = [...r];
    while (c.length < cols) c.push("");
    return c;
  });
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) {
    widths[c] = Math.min(40, Math.max(...norm.map((r) => vwidth(r[c])), 3));
  }
  const overhead = cols * 3 + 1;
  let total = widths.reduce((a, b) => a + b, 0) + overhead;
  while (total > width && Math.max(...widths) > 6) {
    const i = widths.indexOf(Math.max(...widths));
    widths[i]--;
    total--;
  }
  const C = (ch: string) => `${fg(RULE)}${ch}${RESET}`;
  const bar = (l: string, m: string, r: string) =>
    C(l) + widths.map((w) => C("-".repeat(w + 2))).join(C(m)) + C(r);
  const hline = (l: string, m: string, r: string) =>
    C(l) + widths.map((w) => C("─".repeat(w + 2))).join(C(m)) + C(r);
  const row = (cells: string[], header: boolean) =>
    C("│") +
    cells
      .map((cell, c) => " " + pad(header ? `${BOLD}${inline(cell)}${RESET}` : inline(cell), widths[c]) + " ")
      .join(C("│")) +
    C("│");

  void bar;
  const out = [hline("┌", "┬", "┐"), row(norm[0], true), hline("├", "┼", "┤")];
  for (const r of norm.slice(1)) out.push(row(r, false));
  out.push(hline("└", "┴", "┘"));
  return out;
}

export function renderMarkdown(md: string, width: number): string[] {
  const src = md.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  const W = Math.max(8, width);

  for (let i = 0; i < src.length; i++) {
    const line = src[i];
    const t = line.trim();

    // fenced code block
    if (/^```/.test(t)) {
      i++;
      while (i < src.length && !/^```/.test(src[i].trim())) {
        out.push(`${fg(RULE)}▏${RESET} ${fg(CODE)}${trunc(src[i].replace(/\t/g, "  "), W - 2)}${RESET}`);
        i++;
      }
      continue;
    }

    // table: a pipe line followed by a separator line
    if (t.includes("|") && i + 1 < src.length && SEP.test(src[i + 1])) {
      const rows: string[][] = [splitRow(line)];
      i += 2;
      while (i < src.length && src[i].includes("|") && src[i].trim()) {
        rows.push(splitRow(src[i]));
        i++;
      }
      i--;
      for (const l of renderTable(rows, W)) out.push(l);
      continue;
    }

    // heading
    const h = t.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lvl = h[1].length;
      out.push(`${fg(H)}${BOLD}${lvl <= 2 ? "▍ " : ""}${inline(h[2])}${RESET}`);
      continue;
    }

    // horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
      out.push(`${fg(RULE)}${"─".repeat(W)}${RESET}`);
      continue;
    }

    // block quote
    const q = line.match(/^\s*>\s?(.*)$/);
    if (q) {
      for (const wl of wrapRaw(q[1], W - 2)) out.push(`${fg(RULE)}▎${RESET} ${DIM}${inline(wl)}${RESET}`);
      continue;
    }

    // bullet / numbered list
    const b = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
    if (b) {
      const indent = b[1].length;
      const marker = /\d/.test(b[2]) ? `${fg(BULLET)}${b[2]}${RESET}` : `${fg(BULLET)}•${RESET}`;
      const wrapped = wrapRaw(b[3], W - indent - 3);
      wrapped.forEach((wl, k) => {
        const lead = k === 0 ? `${" ".repeat(indent)}${marker} ` : `${" ".repeat(indent + 2)}`;
        out.push(lead + inline(wl));
      });
      continue;
    }

    if (!t) {
      out.push("");
      continue;
    }

    for (const wl of wrapRaw(line, W)) out.push(inline(wl));
  }

  while (out.length && out[0] === "") out.shift();
  while (out.length && out[out.length - 1] === "") out.pop();
  return out;
}
