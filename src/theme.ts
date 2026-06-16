/**
 * Lumen theme register. Six fully-specified token sets, switchable live (the
 * `p` quick-picker) and persisted to the shared config. Three of them share the
 * "Lume" base (surfaces, text ramp, translucent borders) and differ only by
 * accent — Atelier (default), Petrol, Lagoon — exactly as in byte5ai/omadia-ui's
 * lume.css. Three are full palettes with their own surfaces: a Monochrome+accent,
 * Tokyo Night and Catppuccin.
 *
 * The renderer never hardcodes a colour again: it reads semantic tokens off the
 * active theme. Surfaces are gradient pairs (lighter top, darker bottom — light
 * from above); borders/glow are alpha colours flattened against whichever
 * surface they sit on. All the colour MATH lives in ui.ts; this module is just
 * the data plus the active-theme state machine.
 */
import { hex, lerp, lighten, darken, type RGB, type Surface, type Alpha } from "./ui.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

export interface Theme {
  /** internal key (CD_THEME / config value), e.g. "atelier" */
  name: string;
  /** display label for the picker, e.g. "Lume Atelier" */
  label: string;
  // surfaces — each a top→bottom gradient (light from above)
  page: Surface; // the canvas behind everything
  surface: Surface; // default card body
  raised: Surface; // raised cards / popups
  sunken: Surface; // transcript & input wells
  // text ramp, brightest → dimmest
  text: RGB;
  text2: RGB;
  text3: RGB;
  textDim: RGB;
  // borders — alpha over the surface they enclose (flatten() at render time)
  borderTop: Alpha; // upper edge (light)
  borderBtm: Alpha; // lower edge (dark)
  borderSubtleTop: Alpha;
  borderSubtleBtm: Alpha;
  // semantic state — text-only, never a background pill
  success: RGB; // active / ok
  warning: RGB; // waiting
  error: RGB;
  errorEdge: RGB;
  loading: RGB; // spinner dim
  loadingHi: RGB; // spinner bright
  // accent (+ two lighter shades, + translucent subtle/glow)
  accent: RGB;
  accentHi: RGB;
  accentHi2: RGB;
  accentSubtle: Alpha; // accent @ .18
  accentGlow: Alpha; // accent @ .30
  // grey ramp anchors — instances are told apart by position here, not by hue
  rampHi: RGB;
  rampLo: RGB;
}

const alpha = (rgb: RGB, a: number): Alpha => ({ rgb, a });
const WHITE: RGB = [255, 255, 255];
const BLACK: RGB = [0, 0, 0];

/** Tokens shared by every Lume theme — only the accent changes between them. */
type LumeBase = Omit<Theme, "name" | "label" | "accent" | "accentHi" | "accentHi2" | "accentSubtle" | "accentGlow">;

const LUME_BASE: LumeBase = {
  page: { top: hex("232631"), btm: hex("1b1d24") },
  surface: { top: hex("2a2d38"), btm: hex("23262f") },
  raised: { top: hex("303440"), btm: hex("292c37") },
  sunken: { top: hex("1d1f26"), btm: hex("16181e") },
  text: hex("eeeff3"),
  text2: hex("b6b9c3"),
  text3: hex("888b95"),
  textDim: hex("525561"),
  borderTop: alpha(WHITE, 0.1),
  borderBtm: alpha(BLACK, 0.5),
  borderSubtleTop: alpha(WHITE, 0.06),
  borderSubtleBtm: alpha(BLACK, 0.4),
  success: hex("88c499"),
  warning: hex("d6b468"),
  error: hex("e08577"),
  errorEdge: hex("c5685a"),
  loading: hex("3e414c"),
  loadingHi: hex("525561"),
  rampHi: hex("b6b9c3"),
  rampLo: hex("6b6e79"),
};

function lume(name: string, label: string, accent: string, hi: string, hi2: string): Theme {
  const a = hex(accent);
  return {
    name,
    label,
    ...LUME_BASE,
    accent: a,
    accentHi: hex(hi),
    accentHi2: hex(hi2),
    accentSubtle: alpha(a, 0.18),
    accentGlow: alpha(a, 0.3),
  };
}

interface FullOpts {
  base: string;
  surface: string;
  border: string;
  text: [string, string, string];
  accent: string;
  ok?: string;
  warn?: string;
  err?: string;
}

/** Build a full palette: surfaces are derived as gentle light-from-above
 *  gradients off the flat base/surface colours the palette specifies. */
function full(name: string, label: string, o: FullOpts): Theme {
  const base = hex(o.base);
  const surf = hex(o.surface);
  const bord = hex(o.border);
  const [t1, t2, t3] = [hex(o.text[0]), hex(o.text[1]), hex(o.text[2])];
  const accent = hex(o.accent);
  const err = hex(o.err ?? "e08577");
  return {
    name,
    label,
    page: { top: lighten(base, 0.04), btm: darken(base, 0.04) },
    surface: { top: lighten(surf, 0.05), btm: darken(surf, 0.04) },
    raised: { top: lighten(surf, 0.1), btm: darken(surf, 0.01) },
    sunken: { top: darken(base, 0.1), btm: darken(base, 0.2) },
    text: t1,
    text2: t2,
    text3: t3,
    textDim: lerp(t3, base, 0.45),
    borderTop: alpha(lighten(bord, 0.1), 1),
    borderBtm: alpha(darken(bord, 0.18), 1),
    borderSubtleTop: alpha(bord, 1),
    borderSubtleBtm: alpha(darken(bord, 0.3), 1),
    success: hex(o.ok ?? "88c499"),
    warning: hex(o.warn ?? "d6b468"),
    error: err,
    errorEdge: darken(err, 0.12),
    loading: lerp(t3, base, 0.3),
    loadingHi: t3,
    accent,
    accentHi: lighten(accent, 0.14),
    accentHi2: lighten(accent, 0.28),
    accentSubtle: alpha(accent, 0.18),
    accentGlow: alpha(accent, 0.3),
    rampHi: t2,
    rampLo: lerp(t3, base, 0.25),
  };
}

export const THEMES: Theme[] = [
  lume("atelier", "Lume Atelier", "e0a26b", "e5b080", "ebbe93"),
  lume("petrol", "Lume Petrol", "52b0e2", "74c0e8", "90cfee"),
  lume("lagoon", "Lume Lagoon", "6fc8d6", "88d2de", "a1dce6"),
  full("mono", "Monochrom + Akzent", {
    base: "0d0f13", surface: "161922", border: "272b36",
    text: ["e6e8ee", "8b93a3", "565d6b"], accent: "5ec8e6",
  }),
  full("tokyo", "Tokyo Night", {
    base: "1a1b26", surface: "24283b", border: "2f334d",
    text: ["c0caf5", "9aa5ce", "565f89"], accent: "7aa2f7",
    ok: "9ece6a", warn: "e0af68", err: "f7768e",
  }),
  full("catppuccin", "Catppuccin", {
    base: "1e1e2e", surface: "313244", border: "45475a",
    text: ["cdd6f4", "a6adc8", "6c7086"], accent: "cba6f7",
    ok: "a6e3a1", warn: "fab387", err: "f38ba8",
  }),
];

/* ── active-theme state + persistence (shares the i18n config file) ───────── */

const CONFIG_DIR = join(homedir(), ".config", "claude-dashboard");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

let current: Theme = THEMES[0];

function readConfig(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

function byName(n?: string | null): Theme | undefined {
  return n ? THEMES.find((t) => t.name === n) : undefined;
}

function persist(name: string): void {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    const cfg = readConfig();
    cfg.theme = name;
    writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n");
  } catch {
    /* read-only home — keep the in-memory choice */
  }
}

/**
 * Resolve the active theme at startup. Precedence: CD_THEME env (non-persisted
 * override, always wins) > persisted config > Atelier default.
 */
export function loadTheme(): Theme {
  current = byName(process.env.CD_THEME) ?? byName(readConfig().theme as string) ?? THEMES[0];
  return current;
}

export function getTheme(): Theme {
  return current;
}

/** Switch to a theme by name and persist the choice. */
export function setTheme(name: string): Theme {
  const th = byName(name);
  if (th) {
    current = th;
    persist(th.name);
  }
  return current;
}

/** Switch live WITHOUT persisting — used while scrubbing the picker for preview. */
export function previewTheme(name: string): void {
  const th = byName(name);
  if (th) current = th;
}

/** Index of the active theme in THEMES (for the picker's initial selection). */
export function themeIndex(): number {
  return Math.max(0, THEMES.findIndex((t) => t.name === current.name));
}

/**
 * Grey-ramp shade for instance `i` of `n`. Instances are distinguished by their
 * position in this neutral ramp (plus their key/label), not by a rainbow hue —
 * the accent is reserved for selection and emphasis.
 */
export function instanceShade(i: number, n: number): RGB {
  if (n <= 1) return current.rampHi;
  return lerp(current.rampHi, current.rampLo, i / Math.max(1, n - 1));
}
