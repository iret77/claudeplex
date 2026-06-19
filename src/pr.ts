/**
 * PR-Review: list a repo's open PRs (gh), analyze a chosen PR against the real
 * code with a free Claude instance, and act on the result (review / approve /
 * request-changes / merge). Mirrors issue.ts and reuses its headless `claude -p`
 * one-shot to run the analysis. Every helper resolves to a typed `{ error }`
 * instead of throwing into the render loop.
 */
import type { InstanceDef } from "./instances.ts";
import { pickFreeInstance, runHeadlessOneShot, isError, type OneShotProgress } from "./issue.ts";

export { pickFreeInstance };

export interface PullRequest {
  number: number;
  title: string;
  author: string; // login (flattened from gh's author.login)
  headRefName: string;
  baseRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  isDraft: boolean;
  mergeable: string; // MERGEABLE | CONFLICTING | UNKNOWN
  updatedAt: string;
  url: string;
}

export type RiskLevel = "low" | "medium" | "high";
export type MergeRec = "merge" | "changes-requested" | "do-not-merge" | "needs-review";
export type FindingCategory = "bug" | "security" | "breaking" | "tests" | "perf" | "style";

export interface Finding {
  category: FindingCategory;
  severity: "low" | "medium" | "high";
  title: string;
  detail: string;
  location?: string;
}

export interface PrAnalysis {
  pr: PullRequest;
  riskLevel: RiskLevel;
  mergeRecommendation: MergeRec;
  summary: string;
  findings: Finding[];
  report: string; // markdown — always set (fallback = whole output)
  raw: string;
}

export interface PrError {
  error: string;
}

export function isPrError<T extends object>(r: T | PrError): r is PrError {
  return (r as PrError).error !== undefined;
}

export type ReviewEvent = "approve" | "comment" | "request-changes";
export type MergeMethod = "squash" | "merge" | "rebase";

// ─────────────────────────── pure parsers ───────────────────────────

/**
 * Parse the REST `GET /repos/{owner}/{repo}/pulls` array into PullRequest[];
 * [] on empty/garbage. The list endpoint omits additions/deletions/changed_files
 * and mergeable (those live on the single-PR GET), so those default to 0/UNKNOWN.
 */
export function parsePrList(stdout: string): PullRequest[] {
  let arr: unknown;
  try {
    arr = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr.map((p) => {
    const o = p as Record<string, unknown>;
    const user = o.user as { login?: string } | undefined;
    const head = o.head as { ref?: string } | undefined;
    const base = o.base as { ref?: string } | undefined;
    const mergeable = o.mergeable; // boolean | null (null/absent in the list endpoint)
    return {
      number: Number(o.number) || 0,
      title: String(o.title ?? ""),
      author: user?.login ?? "",
      headRefName: head?.ref ?? "",
      baseRefName: base?.ref ?? "",
      additions: Number(o.additions) || 0,
      deletions: Number(o.deletions) || 0,
      changedFiles: Number(o.changed_files) || 0,
      isDraft: Boolean(o.draft),
      mergeable: mergeable == null ? "UNKNOWN" : mergeable ? "MERGEABLE" : "CONFLICTING",
      updatedAt: String(o.updated_at ?? ""),
      url: String(o.html_url ?? ""),
    };
  });
}

const RISK: RiskLevel[] = ["low", "medium", "high"];
const RECS: MergeRec[] = ["merge", "changes-requested", "do-not-merge", "needs-review"];

/** Extract the JSON verdict object from a raw instance output; "" if none. */
function extractJsonObject(raw: string): string {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1] : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  return start >= 0 && end > start ? candidate.slice(start, end + 1) : "";
}

/**
 * Parse the instance's analysis output into everything-but-`pr`. `report` is
 * always populated; falls back to a freeform report when JSON parsing fails.
 */
export function parseAnalysis(raw: string): Omit<PrAnalysis, "pr"> {
  const fallback: Omit<PrAnalysis, "pr"> = {
    riskLevel: "medium",
    mergeRecommendation: "needs-review",
    summary: "",
    findings: [],
    report: raw.trim(),
    raw,
  };
  const objText = extractJsonObject(raw);
  if (!objText) return fallback;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(objText) as Record<string, unknown>;
  } catch {
    return fallback;
  }
  const riskLevel = RISK.includes(o.riskLevel as RiskLevel) ? (o.riskLevel as RiskLevel) : "medium";
  const mergeRecommendation = RECS.includes(o.mergeRecommendation as MergeRec)
    ? (o.mergeRecommendation as MergeRec)
    : "needs-review";
  const findings = Array.isArray(o.findings)
    ? (o.findings as Record<string, unknown>[]).map((f) => ({
        category: String(f.category ?? "bug") as FindingCategory,
        severity: String(f.severity ?? "medium") as Finding["severity"],
        title: String(f.title ?? ""),
        detail: String(f.detail ?? ""),
        location: f.location ? String(f.location) : undefined,
      }))
    : [];
  const report = typeof o.report === "string" && o.report.trim() ? o.report : raw.trim();
  return {
    riskLevel,
    mergeRecommendation,
    summary: String(o.summary ?? ""),
    findings,
    report,
    raw,
  };
}

// ─────────────────────────── gh + analysis ───────────────────────────

/** Map a non-zero gh exit into a typed, human-readable error. */
function ghError(out: string, err: string, code: number): PrError {
  const msg = err.trim() || out.trim();
  if (/rate limit/i.test(msg)) {
    return { error: "GitHub API rate limit exceeded — wait a moment and retry" };
  }
  if (/not.*log|gh auth login|authentication/i.test(msg)) {
    return { error: "gh is not authenticated — run `gh auth login`" };
  }
  if (/not a git repository|no.*remote|could not determine/i.test(msg)) {
    return { error: "no GitHub repository resolved for this folder (missing git remote?)" };
  }
  return { error: msg.split("\n").slice(-2).join(" ").trim() || `gh exited ${code}` };
}

/**
 * List open PRs for the repo at `cwd` via the REST API (`gh api`). REST is used
 * over `gh pr list` (which goes through GraphQL) because the GraphQL endpoint has
 * a far smaller rate-limit quota. [] when none.
 */
export async function listPRs(cwd: string): Promise<PullRequest[] | PrError> {
  let proc: import("bun").Subprocess<"ignore", "pipe", "pipe">;
  try {
    // query string in the path keeps the method GET (request params would flip it to POST);
    // {owner}/{repo} are substituted by gh from the repo in `cwd`.
    proc = Bun.spawn(
      ["gh", "api", "repos/{owner}/{repo}/pulls?state=open&per_page=50&sort=updated&direction=desc"],
      { cwd, env: process.env as Record<string, string>, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
  } catch {
    return { error: "gh CLI not found — install GitHub CLI and run `gh auth login`" };
  }
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) return ghError(out, err, code);
  return parsePrList(out);
}

/** The structured-analysis prompt sent to the free instance. */
export function analyzePrompt(pr: PullRequest): string {
  return [
    `You are reviewing GitHub pull request #${pr.number} ("${pr.title}") in THIS repository (your current working directory).`,
    "",
    `Read the PR yourself: run \`gh pr diff ${pr.number}\` for the diff and \`gh api repos/{owner}/{repo}/pulls/${pr.number}\` for metadata (both use the REST API — prefer REST / \`gh api\` over GraphQL, its quota is small), and read the ACTUAL code in this repo that the PR touches. Do not invent file names.`,
    "",
    "Assess risk and mergeability against the existing codebase: correctness/bugs, security, breaking changes, test coverage, performance, and conflicts with the base branch.",
    "",
    "When done, output EXACTLY ONE JSON object as your final message and NOTHING else after it. Schema:",
    "{",
    '  "riskLevel": "low" | "medium" | "high",',
    '  "mergeRecommendation": "merge" | "changes-requested" | "do-not-merge" | "needs-review",',
    '  "summary": "<2-4 sentence verdict>",',
    '  "findings": [ { "category": "bug"|"security"|"breaking"|"tests"|"perf"|"style", "severity": "low"|"medium"|"high", "title": "<short>", "detail": "<why it matters>", "location": "<relative/path.ts:line>" } ],',
    '  "report": "<full Markdown report: Summary, Risks, Mergeability, Recommendation>"',
    "}",
    "",
    'Ground every finding in code you actually read. If the PR is trivial, return an empty findings array and riskLevel "low".',
  ].join("\n");
}

/**
 * Analyze a PR on the given instance via a headless `claude -p` one-shot, with
 * the repo as cwd so the instance can run gh and read real code. `onProgress`
 * is accepted for UI compatibility; the headless path returns only the final
 * result, so it is not called incrementally.
 */
export async function analyzePR(
  def: InstanceDef,
  cwd: string,
  pr: PullRequest,
  onProgress?: (p: OneShotProgress) => void,
): Promise<PrAnalysis | PrError> {
  void onProgress;
  const r = await runHeadlessOneShot(def, cwd, analyzePrompt(pr));
  if (isError(r)) return r;
  const raw = r.text.trim();
  if (!raw) return { error: "the instance returned an empty analysis" };
  return { pr, ...parseAnalysis(raw) };
}

const REVIEW_EVENT: Record<ReviewEvent, string> = {
  approve: "APPROVE",
  comment: "COMMENT",
  "request-changes": "REQUEST_CHANGES",
};

/**
 * Post a PR-level review via the REST API (`POST …/pulls/{n}/reviews`). REST is
 * used over `gh pr review` (GraphQL) to avoid the small GraphQL rate-limit quota.
 */
export async function reviewPR(
  cwd: string,
  n: number,
  event: ReviewEvent,
  body?: string,
): Promise<{ ok: true } | PrError> {
  const payload: Record<string, string> = { event: REVIEW_EVENT[event] };
  // COMMENT / REQUEST_CHANGES require a non-empty body
  if (body) payload.body = body;
  else if (event !== "approve") payload.body = "(no comment)";
  let proc: import("bun").Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = Bun.spawn(["gh", "api", "-X", "POST", `repos/{owner}/{repo}/pulls/${n}/reviews`, "--input", "-"], {
      cwd,
      env: process.env as Record<string, string>,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    return { error: "gh CLI not found — install GitHub CLI and run `gh auth login`" };
  }
  try {
    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
  } catch {
    /* pipe closed early — exit code/stderr below carries the reason */
  }
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) return ghError(out, err, code);
  return { ok: true };
}

/**
 * Merge a PR via the REST API (`PUT …/pulls/{n}/merge`, default squash). REST is
 * used over `gh pr merge` (GraphQL) to avoid the small GraphQL rate-limit quota.
 */
export async function mergePR(
  cwd: string,
  n: number,
  method: MergeMethod = "squash",
): Promise<{ ok: true } | PrError> {
  let proc: import("bun").Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(
      ["gh", "api", "-X", "PUT", `repos/{owner}/{repo}/pulls/${n}/merge`, "-f", `merge_method=${method}`],
      { cwd, env: process.env as Record<string, string>, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
  } catch {
    return { error: "gh CLI not found — install GitHub CLI and run `gh auth login`" };
  }
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) return ghError(out, err, code);
  return { ok: true };
}
