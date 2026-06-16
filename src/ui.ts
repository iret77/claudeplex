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

/* ── Truecolor token plumbing (Lumen theme system) ───────────────────────────
 * The theme layer (theme.ts) speaks in 24-bit RGB triples and surfaces (a
 * top→bottom gradient pair). These low-level helpers stay theme-agnostic: they
 * take concrete RGB values, so the same math serves every theme. */

/** A 24-bit color as an [r,g,b] triple, each channel 0–255. */
export type RGB = readonly [number, number, number];
/** A color with alpha — flattened against a surface before it hits the wire. */
export interface Alpha { rgb: RGB; a: number; }

const clamp255 = (n: number) => (n < 0 ? 0 : n > 255 ? 255 : Math.round(n));

/** Parse "#rrggbb" (or "rrggbb") into an RGB triple. */
export function hex(s: string): RGB {
  const h = s.replace(/^#/, "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Linear blend between two colors; t=0 → a, t=1 → b. */
export function lerp(a: RGB, b: RGB, t: number): RGB {
  return [clamp255(a[0] + (b[0] - a[0]) * t), clamp255(a[1] + (b[1] - a[1]) * t), clamp255(a[2] + (b[2] - a[2]) * t)];
}
export const lighten = (c: RGB, amt: number): RGB => lerp(c, [255, 255, 255], amt);
export const darken = (c: RGB, amt: number): RGB => lerp(c, [0, 0, 0], amt);

/** Flatten an alpha color over an opaque backdrop into a concrete RGB. */
export function flatten(over: RGB, c: Alpha): RGB {
  return [
    clamp255(c.rgb[0] * c.a + over[0] * (1 - c.a)),
    clamp255(c.rgb[1] * c.a + over[1] * (1 - c.a)),
    clamp255(c.rgb[2] * c.a + over[2] * (1 - c.a)),
  ];
}

/** Truecolor foreground / background SGR from an RGB triple. */
export const tfg = (c: RGB) => `\x1b[38;2;${c[0]};${c[1]};${c[2]}m`;
export const tbg = (c: RGB) => `\x1b[48;2;${c[0]};${c[1]};${c[2]}m`;

/** A surface is a vertical gradient: lighter at the top (light from above). */
export interface Surface { top: RGB; btm: RGB; }
/**
 * Colour of surface row `i` of `n` (0 = top edge, n-1 = bottom). One-row
 * surfaces collapse to the top colour. This is what gives boxes their
 * "light from above" depth.
 */
export function gradientRow(s: Surface, i: number, n: number): RGB {
  if (n <= 1) return s.top;
  return lerp(s.top, s.btm, i / (n - 1));
}

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
export function rule(left: string, right: string, width: number, ch: string, color: RGB): string {
  const lw = vwidth(left);
  const rw = vwidth(right);
  const fill = Math.max(0, width - lw - rw);
  return left + tfg(color) + ch.repeat(fill) + RESET + right;
}

const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

/** Smooth horizontal meter with fractional final cell (truecolor fill + track). */
export function meter(pct: number, width: number, fill: RGB, track: RGB): string {
  const p = Math.max(0, Math.min(1, pct));
  const exact = p * width;
  let full = Math.floor(exact);
  let frac = Math.round((exact - full) * 8);
  if (frac === 8) {
    full++;
    frac = 0;
  }
  let s = tfg(fill) + "█".repeat(Math.min(full, width));
  let used = Math.min(full, width);
  if (used < width && frac > 0) {
    s += EIGHTHS[frac];
    used++;
  }
  s += `${tfg(track)}${"░".repeat(Math.max(0, width - used))}${RESET}`;
  return s;
}

/** Heat color for a 0..1 load ratio: ok → warn → err, blended in truecolor. */
export function heat(pct: number, ok: RGB, warn: RGB, err: RGB): RGB {
  const p = Math.max(0, Math.min(1, pct));
  return p < 0.5 ? lerp(ok, warn, p / 0.5) : lerp(warn, err, (p - 0.5) / 0.5);
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

/**
 * Curated, monochrome Unicode icon set — replaces the emoji that drifted box
 * borders (variable East-Asian width) and clashed with the Lumen look. Every
 * glyph here is verified single-cell by the width logic above, so it never
 * shifts a frame. Colour comes only from theme tokens, never the glyph itself.
 */
export const ICONS = {
  // session state
  active: "◆",
  monitor: "◑",
  waiting: "◐",
  idle: "○",
  // selection / disclosure markers
  collapsed: "▸",
  expanded: "▾",
  cursor: "▶",
  bar: "▌",
  caret: "▏",
  // prompts / transcript flow
  prompt: "❯",
  stream: "⟩",
  tool: "·",
  result: "⎿",
  gutter: "▎",
  text: "▪",
  // entities
  account: "◈",
  org: "⌂",
  folder: "▤",
  repo: "▣",
  file: "▦",
  branch: "⎇",
  context: "◫",
  host: "◇",
  // status / meta
  background: "⊙",
  thinking: "✦",
  attach: "❏",
  rename: "✎",
  newAgent: "✦",
  issue: "❖",
  ok: "✓",
  fail: "✗",
  refresh: "↻",
} as const;
