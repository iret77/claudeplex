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
  /** accent color (256-color code) */
  color: number;
  /** absolute path to CLAUDE_CONFIG_DIR */
  configDir: string;
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
