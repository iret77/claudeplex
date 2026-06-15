import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The four isolated Claude Code accounts (c1–c4 in ~/.zshrc).
 * Each one runs under its own CLAUDE_CONFIG_DIR. We never write to these dirs —
 * the dashboard only reads sessions, usage and account metadata.
 */
export interface InstanceDef {
  /** shell shortcut name, e.g. "c1" */
  key: string;
  /** short human label shown in the UI */
  label: string;
  /** accent color (256-color code) */
  color: number;
  /** absolute path to CLAUDE_CONFIG_DIR */
  configDir: string;
}

const HOME = homedir();

export const INSTANCES: InstanceDef[] = [
  { key: "c1", label: "claw",         color: 81,  configDir: join(HOME, ".claude-claw") },
  { key: "c2", label: "byte5-priv",   color: 213, configDir: join(HOME, ".claude-byte5-priv") },
  { key: "c3", label: "byte5-team",   color: 156, configDir: join(HOME, ".claude-byte5-team") },
  { key: "c4", label: "byte5-omadia", color: 215, configDir: join(HOME, ".claude-byte5-omadia") },
];

/**
 * Soft token budget used only to draw the load bar as a percentage.
 * Real Max plan caps are not exposed by the API, so this is an *estimate* of how
 * many tokens a heavy 5-hour window / week looks like. Override via env if you
 * want the bar calibrated differently.
 */
export const BUDGET_5H = Number(process.env.CD_BUDGET_5H ?? 20_000_000);
export const BUDGET_WEEK = Number(process.env.CD_BUDGET_WEEK ?? 300_000_000);
