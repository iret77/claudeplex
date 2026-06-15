/**
 * Runs the real PAI statusline script (~/.claude/PAI/statusline-command.sh) for
 * a given instance and caches its multi-line ANSI output. The script reads a
 * Claude-Code session JSON on stdin; we synthesize one from what the dashboard
 * already knows (cwd, model, context, usage) and pin CLAUDE_CONFIG_DIR so the
 * right login's PAI state is shown. Heavy (network + caches) → run async, every
 * TTL ms at most, and render the last cached frame in between.
 *
 * We always pass a non-empty `version` so the script never falls back to
 * spawning `claude --version`.
 */
import { join } from "node:path";
import { homedir } from "node:os";

const SCRIPT = join(homedir(), ".claude", "PAI", "statusline-command.sh");
const TTL = 8000;

export interface SLInput {
  configDir: string;
  cwd: string;
  model: string;
  ctxTokens: number;
  ctxMax: number;
  ctxPct: number;
  usage5hPct: number;
  usage5hResetMs: number;
  usage7dPct: number;
  usage7dResetMs: number;
  width: number;
}

interface Entry {
  lines: string[];
  ts: number;
  running: boolean;
}

const cache = new Map<string, Entry>();

/** Last cached statusline lines for an instance key (empty until first run). */
export function statuslineLines(key: string): string[] {
  return cache.get(key)?.lines ?? [];
}

/** Kick off a refresh if stale and not already running (self-throttling). */
export function refreshStatusline(key: string, inp: SLInput): void {
  const now = Date.now();
  const c = cache.get(key);
  if (c?.running) return;
  if (c && now - c.ts < TTL) return;
  cache.set(key, { lines: c?.lines ?? [], ts: now, running: true });

  const json = JSON.stringify({
    workspace: { current_dir: inp.cwd },
    cwd: inp.cwd,
    session_id: "dashboard",
    model: { display_name: inp.model || "Claude" },
    version: "2.1.177", // non-empty → script never spawns `claude --version`
    context_window: {
      context_window_size: Math.max(1, inp.ctxMax),
      used_percentage: Math.round(inp.ctxPct),
      total_input_tokens: inp.ctxTokens,
    },
    rate_limits: {
      five_hour: { used_percentage: inp.usage5hPct, resets_at: Math.floor(inp.usage5hResetMs / 1000) },
      seven_day: { used_percentage: inp.usage7dPct, resets_at: Math.floor(inp.usage7dResetMs / 1000) },
    },
  });

  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  delete env.CLAUDECODE;
  env.CLAUDE_CONFIG_DIR = inp.configDir;
  env.COLUMNS = String(Math.max(40, inp.width));
  env.PAI_STATUSLINE_MAX_WIDTH = "0"; // size to the dashboard width

  let proc;
  try {
    proc = Bun.spawn(["bash", SCRIPT], {
      cwd: inp.cwd,
      env,
      stdin: "pipe", // write + end below to guarantee EOF (the script does `cat`)
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (e) {
    cache.set(key, { lines: [`statusline: ${String(e)}`], ts: now, running: false });
    return;
  }

  // feed the synthesized session JSON and close stdin so `input=$(cat)` returns
  try {
    proc.stdin.write(json);
    proc.stdin.end();
  } catch {
    /* ignore */
  }

  const child = proc;
  let done = false;
  // safety net: never let a hung script pin the cache in "running" forever
  const killer = setTimeout(() => {
    if (done) return;
    done = true;
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    cache.set(key, { lines: ["statusline: timeout (>12s)"], ts: Date.now(), running: false });
  }, 12000);

  (async () => {
    let out = "";
    let err = "";
    try {
      out = await new Response(child.stdout as ReadableStream<Uint8Array>).text();
    } catch {
      /* ignore */
    }
    try {
      err = await new Response(child.stderr as ReadableStream<Uint8Array>).text();
    } catch {
      /* ignore */
    }
    if (done) return; // timed out already
    done = true;
    clearTimeout(killer);
    const lines = out.replace(/\r/g, "").replace(/\n+$/, "").split("\n");
    cache.set(key, {
      lines: out.trim()
        ? lines
        : [`statusline: keine Ausgabe${err.trim() ? " — " + err.trim().split("\n").slice(-1)[0] : ""}`],
      ts: Date.now(),
      running: false,
    });
  })();
}
