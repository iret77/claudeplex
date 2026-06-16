/**
 * An instance is one isolated Claude Code account, identified by its
 * CLAUDE_CONFIG_DIR. Claudeplex never writes to these dirs — it only reads
 * sessions, usage and account metadata.
 *
 * The live list is built at startup by `discoverInstances()` (see discover.ts),
 * which scans the filesystem, running processes and $CLAUDE_CONFIG_DIR. This
 * seed is only the fallback when discovery finds nothing; keep it empty so the
 * tool ships with zero machine-specific configuration. Pin labels/colors via
 * the optional overrides file instead (see discover.ts).
 */
export interface InstanceDef {
  /** short key shown in the UI, e.g. "c1" */
  key: string;
  /** short human label shown in the UI */
  label: string;
  /** accent color (256-color code; unused under the Lumen grey ramp) */
  color: number;
  /** data dir (sessions/projects) — for the default account this is ~/.claude */
  configDir: string;
  /**
   * Path to the .claude.json holding the oauthAccount. Usually
   * <configDir>/.claude.json, but the DEFAULT account keeps it at ~/.claude.json
   * (in $HOME) while its data lives in ~/.claude.
   */
  accountFile?: string;
  /**
   * The default account (no CLAUDE_CONFIG_DIR). Spawns must NOT set
   * CLAUDE_CONFIG_DIR — setting it to ~/.claude makes claude look for
   * ~/.claude/.claude.json (absent) and lose the login.
   */
  isDefault?: boolean;
}

export const INSTANCES: InstanceDef[] = [];

/**
 * Soft token budget used only to draw the load bar as a percentage.
 * Real Max plan caps are not exposed by the API, so this is an *estimate* of how
 * many tokens a heavy 5-hour window / week looks like. Override via env if you
 * want the bar calibrated differently.
 */
export const BUDGET_5H = Number(process.env.CD_BUDGET_5H ?? 20_000_000);
export const BUDGET_WEEK = Number(process.env.CD_BUDGET_WEEK ?? 300_000_000);
