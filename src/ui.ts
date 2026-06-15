/**
 * Low-level terminal text helpers: ANSI colors, visible-width math (emoji &
 * CJK aware), truncation, padding and box drawing. Keeping these correct is
 * what makes the grid borders line up and stops frame ghosting.
 */

export const RESET = "\x1b[0m";
export const BOLD = "\x1b[1m";
export const DIM = "\x1b[2m";
export const ITAL = "\x1b[3m";

export const fg = (c: number) => `\x1b[38;5;${c}m`;
export const bg = (c: number) => `\x1b[48;5;${c}m`;
export const rgb = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`;

const ANSI = /^\x1b\[[0-9;]*m/;

/**
 * Within the Misc-Symbols + Dingbats block (0x2600–0x27BF) only the
 * emoji-presentation codepoints (East-Asian-Width = Wide) take two terminal
 * cells. The rest — ✓ ✗ ❯ ✎ and most arrows/symbols — are Neutral and draw
 * as one cell. Treating the whole block as wide miscounts those by +1 each,
 * which drifts box borders left and shatters the frame. This is the precise
 * Wide subset per Unicode EAW.
 */
function isWideSymbol(cp: number): boolean {
  return (
    cp === 0x2614 || cp === 0x2615 ||
    (cp >= 0x2648 && cp <= 0x2653) ||
    cp === 0x267f ||
    cp === 0x2693 || cp === 0x26a1 ||
    (cp >= 0x26aa && cp <= 0x26ab) ||
    (cp >= 0x26bd && cp <= 0x26be) ||
    (cp >= 0x26c4 && cp <= 0x26c5) ||
    cp === 0x26ce || cp === 0x26d4 || cp === 0x26ea ||
    (cp >= 0x26f2 && cp <= 0x26f3) ||
    cp === 0x26f5 || cp === 0x26fa || cp === 0x26fd ||
    cp === 0x2705 ||
    (cp >= 0x270a && cp <= 0x270b) ||
    cp === 0x2728 || cp === 0x274c || cp === 0x274e ||
    (cp >= 0x2753 && cp <= 0x2755) ||
    cp === 0x2757 ||
    (cp >= 0x2795 && cp <= 0x2797) ||
    cp === 0x27b0 || cp === 0x27bf
  );
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    isWideSymbol(cp) || // emoji-presentation symbols in the misc/dingbats block
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f000 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/** Visible width, ignoring ANSI escapes and counting emoji/CJK as 2. */
export function vwidth(s: string): number {
  let w = 0;
  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    const m = rest.match(ANSI);
    if (m) {
      i += m[0].length;
      continue;
    }
    const cp = s.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    if (cp === 0xfe0f || cp === 0x200d) {
      i += ch.length;
      continue;
    }
    w += isWide(cp) ? 2 : 1;
    i += ch.length;
  }
  return w;
}

/** Truncate to a visible width, preserving ANSI and closing with RESET. */
export function trunc(s: string, max: number): string {
  let w = 0;
  let out = "";
  let i = 0;
  let colored = false;
  while (i < s.length) {
    const rest = s.slice(i);
    const m = rest.match(ANSI);
    if (m) {
      out += m[0];
      colored = m[0] !== RESET;
      i += m[0].length;
      continue;
    }
    const cp = s.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const cw = cp === 0xfe0f || cp === 0x200d ? 0 : isWide(cp) ? 2 : 1;
    if (w + cw > max) {
      if (w + 1 <= max) out += "…";
      break;
    }
    out += ch;
    w += cw;
    i += ch.length;
  }
  return colored ? out + RESET : out;
}

/** Pad (or truncate) to an exact visible width. */
export function pad(s: string, width: number): string {
  const t = trunc(s, width);
  const gap = width - vwidth(t);
  return gap > 0 ? t + " ".repeat(gap) : t;
}

/** Center a string within a visible width. */
export function center(s: string, width: number): string {
  const t = trunc(s, width);
  const gap = width - vwidth(t);
  if (gap <= 0) return t;
  const left = Math.floor(gap / 2);
  return " ".repeat(left) + t + " ".repeat(gap - left);
}

/**
 * A rule line: left segment + filler + right segment, filled to `width`
 * visible columns with `ch`.
 */
export function rule(left: string, right: string, width: number, ch: string, color: number): string {
  const lw = vwidth(left);
  const rw = vwidth(right);
  const fill = Math.max(0, width - lw - rw);
  return left + fg(color) + ch.repeat(fill) + RESET + right;
}

const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

/** Smooth horizontal meter with fractional final cell. */
export function meter(pct: number, width: number, color: number): string {
  const p = Math.max(0, Math.min(1, pct));
  const exact = p * width;
  let full = Math.floor(exact);
  let frac = Math.round((exact - full) * 8);
  if (frac === 8) {
    full++;
    frac = 0;
  }
  let s = fg(color) + "█".repeat(Math.min(full, width));
  let used = Math.min(full, width);
  if (used < width && frac > 0) {
    s += EIGHTHS[frac];
    used++;
  }
  s += `${DIM}${fg(238)}${"░".repeat(Math.max(0, width - used))}${RESET}`;
  return s;
}

/** Heat color for a 0..1 load ratio. */
export function heat(pct: number): number {
  if (pct >= 1) return 196; // red
  if (pct >= 0.85) return 202; // orange-red
  if (pct >= 0.6) return 214; // orange
  if (pct >= 0.35) return 220; // yellow
  return 46; // green
}

/**
 * Drop the first `n` visible columns, keeping any still-active SGR color so the
 * remainder renders correctly. ANSI escapes are zero-width.
 */
export function dropCols(s: string, n: number): string {
  let w = 0;
  let i = 0;
  let active = "";
  while (i < s.length && w < n) {
    const m = s.slice(i).match(ANSI);
    if (m) {
      active = m[0] === RESET ? "" : active + m[0];
      i += m[0].length;
      continue;
    }
    const cp = s.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    if (cp === 0xfe0f || cp === 0x200d) {
      i += ch.length;
      continue;
    }
    w += isWide(cp) ? 2 : 1;
    i += ch.length;
  }
  // absorb any escapes sitting exactly at the cut so colors carry over
  let m: RegExpMatchArray | null;
  while ((m = s.slice(i).match(ANSI))) {
    active = m[0] === RESET ? "" : active + m[0];
    i += m[0].length;
  }
  return active + s.slice(i);
}

/**
 * Composite `box` lines onto `base` at (top,left). The box is opaque: its own
 * cells (incl. spaces) overwrite the backdrop; the backdrop shows only outside.
 * Used to float a popup/modal over the dashboard instead of a full-screen page.
 */
export function overlayBox(base: string[], box: string[], top: number, left: number): string[] {
  const out = base.slice();
  while (out.length < top + box.length) out.push("");
  for (let r = 0; r < box.length; r++) {
    const row = top + r;
    const bw = vwidth(box[r]);
    const head = pad(out[row] ?? "", left); // left backdrop margin
    const tail = dropCols(out[row] ?? "", left + bw); // backdrop to the right
    out[row] = head + RESET + box[r] + RESET + tail;
  }
  return out;
}

export const ansiLen = vwidth;
