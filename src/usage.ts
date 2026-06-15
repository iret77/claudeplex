/**
 * Token accounting + rough cost estimation, derived from the `message.usage`
 * blocks Claude Code writes into each session .jsonl. There is no rate-limit
 * percentage in the logs, so "load" is expressed as token throughput inside
 * rolling time windows (5h block + today + 7 days).
 */

export interface UsageEntry {
  ts: number; // epoch ms
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  model: string;
}

export interface WindowTotals {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  total: number; // sum of all four (raw throughput)
  work: number; // input + output + cacheCreate — the "load" signal (excludes cheap cache reads)
  cost: number; // USD estimate
  messages: number;
}

// USD per 1M tokens. Fallback = sonnet tier.
const PRICING: Record<string, { in: number; out: number; cw: number; cr: number }> = {
  opus: { in: 15, out: 75, cw: 18.75, cr: 1.5 },
  sonnet: { in: 3, out: 15, cw: 3.75, cr: 0.3 },
  haiku: { in: 0.8, out: 4, cw: 1.0, cr: 0.08 },
};

function tier(model: string): keyof typeof PRICING {
  const m = model.toLowerCase();
  if (m.includes("opus")) return "opus";
  if (m.includes("haiku")) return "haiku";
  return "sonnet";
}

export function entryCost(e: UsageEntry): number {
  const p = PRICING[tier(e.model)];
  return (
    (e.input * p.in + e.output * p.out + e.cacheCreate * p.cw + e.cacheRead * p.cr) /
    1_000_000
  );
}

export function emptyTotals(): WindowTotals {
  return {
    input: 0, output: 0, cacheCreate: 0, cacheRead: 0,
    total: 0, work: 0, cost: 0, messages: 0,
  };
}

export function addEntry(t: WindowTotals, e: UsageEntry): void {
  t.input += e.input;
  t.output += e.output;
  t.cacheCreate += e.cacheCreate;
  t.cacheRead += e.cacheRead;
  t.total += e.input + e.output + e.cacheCreate + e.cacheRead;
  t.work += e.input + e.output + e.cacheCreate;
  t.cost += entryCost(e);
  t.messages += 1;
}

/** Start of the current rolling 5-hour billing-style block, aligned to the hour. */
export function fiveHourWindowStart(now: number): number {
  return now - 5 * 60 * 60 * 1000;
}

export function startOfToday(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function weekWindowStart(now: number): number {
  return now - 7 * 24 * 60 * 60 * 1000;
}

export function bucketEntries(entries: UsageEntry[], now: number): {
  block5h: WindowTotals;
  today: WindowTotals;
  week: WindowTotals;
} {
  const s5 = fiveHourWindowStart(now);
  const sToday = startOfToday(now);
  const sWeek = weekWindowStart(now);
  const block5h = emptyTotals();
  const today = emptyTotals();
  const week = emptyTotals();
  for (const e of entries) {
    if (e.ts >= sWeek) addEntry(week, e);
    if (e.ts >= sToday) addEntry(today, e);
    if (e.ts >= s5) addEntry(block5h, e);
  }
  return { block5h, today, week };
}

/**
 * Reset time of the current usage block, ccusage-style: a block starts at the
 * first activity (floored to the hour) and lasts `windowMs`; a >window gap or
 * elapsing the window starts a new block. Returns the epoch ms when the active
 * block resets, or 0 if no block is currently active (fully reset).
 */
export function blockResetAt(timestamps: number[], windowMs: number, now: number): number {
  if (!timestamps.length) return 0;
  const sorted = [...timestamps].sort((a, b) => a - b);
  const floorHour = (t: number) => t - (t % 3_600_000);
  let blockStart = floorHour(sorted[0]);
  let prev = sorted[0];
  for (const ts of sorted) {
    if (ts - blockStart >= windowMs || ts - prev >= windowMs) blockStart = floorHour(ts);
    prev = ts;
  }
  const reset = blockStart + windowMs;
  return reset > now ? reset : 0;
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return "0m";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm ? `${h}h${rm}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d${rh}h` : `${d}d`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + "B";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

export function formatCost(n: number): string {
  if (n >= 100) return "$" + n.toFixed(0);
  return "$" + n.toFixed(2);
}
