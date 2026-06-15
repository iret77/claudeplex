/**
 * Instance auto-discovery: find Claude Code CLI accounts (CLAUDE_CONFIG_DIR) on
 * this machine WITHOUT relying on shell aliases. Sources, unioned + deduped:
 *   1. Filesystem scan of $HOME/.claude and $HOME/.claude-* (top level only)
 *   2. Live processes (CLAUDE_CONFIG_DIR=… in `ps`) — catches non-standard paths
 *   3. $CLAUDE_CONFIG_DIR from the environment, if set
 *
 * Labels/colors are derived from each account's oauthAccount metadata; an
 * optional overrides file (~/.config/claudeplex/instances.json) can pin
 * key/label/color/order or hide an instance. Falls back to the built-in seed.
 */
import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { INSTANCES, type InstanceDef } from "./instances.ts";
import { getRunningConfigDirs } from "./collect.ts";

const HOME = homedir();

/** Accent palette — extends the original hand-picked instance colors. */
const PALETTE = [81, 213, 156, 215, 117, 222, 175, 114, 209, 147];

/** Config-dir names that look like ours but are NOT real accounts. */
const EXCLUDE = /(?:^|[.-])(?:mem|backup|backups|bak|old|tmp|temp|observer)$/i;

export interface InstanceOverride {
  /** absolute config dir this override applies to */
  configDir?: string;
  key?: string;
  label?: string;
  color?: number;
  order?: number;
  hide?: boolean;
}

/** True if the config dir holds its own OAuth login (a real, distinct account). */
function hasAccount(dir: string): boolean {
  try {
    return !!JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8")).oauthAccount;
  } catch {
    return false;
  }
}

/** A real account config dir has the account file and/or the session stores. */
function isConfigDir(dir: string): boolean {
  try {
    if (!statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  return (
    existsSync(join(dir, ".claude.json")) ||
    existsSync(join(dir, "projects")) ||
    existsSync(join(dir, "sessions"))
  );
}

/** Trim corporate suffixes + lowercase to a compact label. */
function shortLabel(s: string): string {
  return s
    .replace(/\b(inc|gmbh|ltd|llc|corp)\b\.?/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 16);
}

/**
 * Label from the account's oauthAccount. Prefer a real org name, but personal
 * Max accounts use "<email>'s Organization" — for those the email local-part is
 * the cleaner label. Falls back to "" (caller uses the dir suffix).
 */
function accountLabel(dir: string): string {
  try {
    const o = JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8"));
    const acc = o.oauthAccount ?? {};
    const org: string = acc.organizationName ?? "";
    const email: string = acc.emailAddress ?? acc.email ?? "";
    const personalOrg = /@|['’]s\b/.test(org); // "<email>'s Organization"
    if (org && !personalOrg) return shortLabel(org);
    if (email) return email.split("@")[0];
    if (org) return shortLabel(org);
  } catch {
    /* unreadable / logged out */
  }
  return "";
}

/** ".claude-work" → "work"; ".claude" → "main". */
function suffixLabel(name: string): string {
  const m = name.match(/^\.claude-(.+)$/);
  return m ? m[1] : name === ".claude" ? "main" : name.replace(/^\./, "");
}

function loadOverrides(): InstanceOverride[] {
  const p = join(HOME, ".config", "claudeplex", "instances.json");
  try {
    const arr = JSON.parse(readFileSync(p, "utf8"));
    if (Array.isArray(arr)) return arr as InstanceOverride[];
  } catch {
    /* no overrides file */
  }
  return [];
}

export function discoverInstances(): InstanceDef[] {
  const dirs = new Set<string>();

  // 1. filesystem scan of $HOME top level
  try {
    for (const name of readdirSync(HOME)) {
      if (name !== ".claude" && !name.startsWith(".claude-")) continue;
      if (EXCLUDE.test(name)) continue;
      const full = join(HOME, name);
      if (!isConfigDir(full)) continue;
      // the bare default dir (~/.claude) is only a real instance if it has its
      // own login; otherwise it's just the fallback config dir (noisy "main").
      if (name === ".claude" && !hasAccount(full)) continue;
      dirs.add(full);
    }
  } catch {
    /* $HOME unreadable — unlikely */
  }

  // 2. live processes — catches config dirs outside $HOME
  for (const dir of getRunningConfigDirs().keys()) {
    if (isConfigDir(dir)) dirs.add(dir);
  }

  // 3. explicit env
  const envDir = process.env.CLAUDE_CONFIG_DIR;
  if (envDir && isConfigDir(envDir)) dirs.add(envDir);

  if (dirs.size === 0) return INSTANCES; // nothing found → built-in seed

  const overrides = loadOverrides();
  const ovByDir = new Map(overrides.filter((o) => o.configDir).map((o) => [o.configDir!, o]));

  // stable order by path so colors/keys don't reshuffle between runs
  const sorted = [...dirs].sort((a, b) => a.localeCompare(b));

  const defs: InstanceDef[] = [];
  let i = 0;
  for (const dir of sorted) {
    const ov = ovByDir.get(dir);
    if (ov?.hide) continue;
    const base = dir.split("/").pop() ?? dir;
    const label = ov?.label || accountLabel(dir) || suffixLabel(base);
    defs.push({
      key: ov?.key || `c${i + 1}`,
      label,
      color: ov?.color ?? PALETTE[i % PALETTE.length],
      configDir: dir,
    });
    i++;
  }

  // explicit ordering from overrides, if any
  if (overrides.some((o) => typeof o.order === "number")) {
    const ord = (d: InstanceDef) => ovByDir.get(d.configDir)?.order ?? 999;
    defs.sort((a, b) => ord(a) - ord(b));
  }

  return defs.length ? defs : INSTANCES;
}
