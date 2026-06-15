/**
 * Quick-Issue: draft a clean, English, code-grounded GitHub issue with a free
 * Claude instance, then create it via the logged-in `gh` CLI after the user
 * confirms.
 *
 *   pickFreeInstance → draftIssue (headless `claude -p`) → [user confirms]
 *   → createIssue (`gh issue create`).
 *
 * Everything here is best-effort and never throws into the render loop: the
 * draft/create helpers resolve to a typed `{ error }` instead.
 */
import type { InstanceState } from "./collect.ts";
import type { InstanceDef } from "./instances.ts";
import type { AgentRegistry } from "./agents.ts";

export interface IssueDraft {
  title: string;
  body: string; // markdown, WITHOUT the leading "# Title" line
  raw: string; // the full markdown the instance produced
}

export interface IssueError {
  error: string;
}

export function isError<T extends object>(r: T | IssueError): r is IssueError {
  return (r as IssueError).error !== undefined;
}

/**
 * Pick the freest idle instance to write the issue: prefer instances with no
 * live dashboard agent and that aren't actively WORKING, lowest 5h load first.
 * Falls back to the globally least-loaded instance.
 */
export function pickFreeInstance(
  states: InstanceState[],
  registry?: AgentRegistry,
): InstanceState | undefined {
  if (!states.length) return undefined;
  const load = (s: InstanceState) => s.block5h.work;
  const free = states.filter(
    (s) => s.status !== "WORKING" && (registry?.byInstance(s.def.key).length ?? 0) === 0,
  );
  const pool = free.length ? free : states;
  return [...pool].sort((a, b) => load(a) - load(b))[0];
}

/** The English-issue, code-grounded draft prompt sent to the instance. */
export function issueDraftPrompt(description: string, prior?: { draft: string; feedback: string }): string {
  const base = [
    "You are drafting a GitHub issue for THIS repository (your current working directory).",
    "",
    "Task: inspect the actual code in this repo and write ONE clean, well-structured GitHub issue.",
    "",
    "Hard requirements:",
    "- Write the issue in ENGLISH, regardless of the language of the request below.",
    "- Ground it in the real code: reference concrete files (relative paths), functions, types or line ranges you actually verified by reading the code. Do not invent file names.",
    "- Structure the body with clear Markdown sections (e.g. Summary, Context / affected code, Proposed change / acceptance criteria). Keep it concise and actionable.",
    "- The VERY FIRST line of your output must be the issue title as a single Markdown H1: `# <title>`.",
    "- After the title line, output the issue body as Markdown.",
    "- Output ONLY the issue Markdown. No preamble, no explanations, no code fences around the whole thing. Do NOT create the issue and do NOT run gh.",
    "",
    `Request (may be in any language): ${description.trim()}`,
  ];
  if (prior) {
    base.push(
      "",
      "You previously produced this draft:",
      "----",
      prior.draft.trim(),
      "----",
      `Revise it according to this feedback: ${prior.feedback.trim()}`,
      "Output the full revised issue Markdown (title H1 first), nothing else.",
    );
  }
  return base.join("\n");
}

/** Build a scrubbed env that pins the instance login and avoids nesting. */
function childEnv(def: InstanceDef): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  delete env.ANTHROPIC_API_KEY; // force subscription OAuth, not an API key
  delete env.CLAUDECODE; // don't look like a nested claude session
  delete env.CLAUDE_CODE_ENTRYPOINT;
  env.CLAUDE_CONFIG_DIR = def.configDir; // the correct login
  return env;
}

/** Split a draft into a title (first `# ` line) and the body below it. */
export function splitDraft(md: string): { title: string; body: string } {
  const lines = md.replace(/\r/g, "").split("\n");
  let title = "";
  let i = 0;
  for (; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    const m = l.match(/^#\s+(.*)$/);
    title = m ? m[1].trim() : l.replace(/^#+\s*/, "").trim();
    i++;
    break;
  }
  const body = lines.slice(i).join("\n").replace(/^\n+/, "").trimEnd();
  return { title, body };
}

/** Pull the issue markdown out of a `claude -p --output-format json` payload. */
function extractResult(stdout: string): string {
  try {
    const o = JSON.parse(stdout);
    if (typeof o?.result === "string") return o.result.trim();
    if (typeof o?.text === "string") return o.text.trim();
  } catch {
    /* not JSON — fall through to raw */
  }
  return stdout.trim();
}

/**
 * Draft the issue on the given instance via a headless `claude -p` one-shot,
 * with the repo as cwd so the instance can read the real code.
 */
export async function draftIssue(
  def: InstanceDef,
  cwd: string,
  description: string,
  prior?: { draft: string; feedback: string },
): Promise<IssueDraft | IssueError> {
  const prompt = issueDraftPrompt(description, prior);
  let proc: import("bun").Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(
      ["claude", "-p", prompt, "--output-format", "json", "--dangerously-skip-permissions"],
      { cwd, env: childEnv(def), stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
  } catch (e) {
    return { error: `could not start claude: ${String(e)}` };
  }
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    const tail = err.trim().split("\n").slice(-3).join(" ").trim();
    return { error: `claude exited ${code}${tail ? `: ${tail}` : ""}` };
  }
  const raw = extractResult(out);
  if (!raw) return { error: "the instance returned an empty draft" };
  const { title, body } = splitDraft(raw);
  if (!title) return { error: "draft had no title line" };
  return { title, body, raw };
}

/**
 * Create the issue via the logged-in `gh` CLI, run from the repo so gh resolves
 * the repository from the git remote. Returns the issue URL or a typed error.
 */
export async function createIssue(
  cwd: string,
  title: string,
  body: string,
): Promise<{ url: string } | IssueError> {
  let proc: import("bun").Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = Bun.spawn(
      ["gh", "issue", "create", "--title", title, "--body-file", "-"],
      { cwd, env: process.env as Record<string, string>, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
  } catch {
    return { error: "gh CLI not found — install GitHub CLI and run `gh auth login`" };
  }
  try {
    proc.stdin.write(body || title);
    proc.stdin.end();
  } catch {
    /* pipe closed early — exit code/stderr below carries the reason */
  }
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    const msg = err.trim() || out.trim();
    if (/not.*log|gh auth login|authentication/i.test(msg)) {
      return { error: "gh is not authenticated — run `gh auth login`" };
    }
    if (/not a git repository|no.*remote|could not determine/i.test(msg)) {
      return { error: "no GitHub repository resolved for this folder (missing git remote?)" };
    }
    return { error: msg.split("\n").slice(-2).join(" ").trim() || `gh exited ${code}` };
  }
  const url = (out.match(/https?:\/\/\S+/) ?? [out.trim()])[0];
  return { url };
}
