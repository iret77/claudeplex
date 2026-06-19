/**
 * Transcript parser: read a Claude Code session `.jsonl` and pull out the
 * conversation turns + token usage.
 *
 * This is the authoritative content channel for a PTY-driven INTERACTIVE
 * session: we inject prompts over the terminal, but the clean structured
 * answer (assistant text, tool calls, usage) is read from the session
 * transcript Claude writes to disk — not scraped from the ANSI screen. The
 * file lives at <configDir>/projects/<mangled-cwd>/<sessionId>.jsonl and is
 * appended to as the conversation grows.
 *
 * Lines are one JSON object each. We care about `type:"assistant"` and
 * `type:"user"`; the many bookkeeping types (agent-name, mode, attachment,
 * file-history-snapshot, …) are ignored.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

export interface ToolCall {
  name: string;
  input: unknown;
}

export interface TranscriptTurn {
  role: "user" | "assistant";
  /** concatenated text parts (the visible answer) */
  text: string;
  /** concatenated thinking parts, if any */
  thinking: string;
  /** tool_use parts on this turn */
  tools: ToolCall[];
  /** assistant-turn token usage, if present */
  usage?: TokenUsage;
  /** model id reported on the turn */
  model?: string;
}

/**
 * Strip a trailing PAI session-naming hook payload from assistant text. Some
 * setups make the model append a JSON object like
 * {"tab_title":"…","session_name":"…","mode":"…"} after the real answer; it's
 * machine bookkeeping, not content. Conservative: only removes a trailing JSON
 * object that actually carries tab_title/session_name.
 */
export function stripHookJson(text: string): string {
  // the payload may be prepended OR appended, compact or pretty-printed. Find it
  // by a signature key, walk back to its opening brace, then brace-count to its
  // real close, and excise exactly that span wherever it sits.
  const keyIdx = Math.max(text.lastIndexOf('"tab_title"'), text.lastIndexOf('"session_name"'));
  if (keyIdx < 0) return text;
  const open = text.lastIndexOf("{", keyIdx);
  if (open < 0) return text;
  let depth = 0;
  let close = -1;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) {
      close = i;
      break;
    }
  }
  if (close < 0) return text;
  try {
    const o = JSON.parse(text.slice(open, close + 1));
    if (!o || typeof o !== "object" || !("tab_title" in o || "session_name" in o)) return text;
  } catch {
    return text; // not a clean object — leave the text untouched
  }
  return (text.slice(0, open) + text.slice(close + 1)).trim();
}

function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
}

function readUsage(u: any): TokenUsage | undefined {
  if (!u || typeof u !== "object") return undefined;
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheCreate: u.cache_creation_input_tokens ?? 0,
  };
}

/** Pull text / thinking / tool_use out of a message `content` (array or string). */
function readContent(content: any): { text: string; thinking: string; tools: ToolCall[] } {
  if (typeof content === "string") return { text: content, thinking: "", tools: [] };
  const text: string[] = [];
  const thinking: string[] = [];
  const tools: ToolCall[] = [];
  if (Array.isArray(content)) {
    for (const p of content) {
      if (!p || typeof p !== "object") continue;
      if (p.type === "text" && typeof p.text === "string") text.push(p.text);
      else if (p.type === "thinking" && typeof p.thinking === "string") thinking.push(p.thinking);
      else if (p.type === "tool_use") tools.push({ name: p.name ?? "", input: p.input });
    }
  }
  return { text: stripHookJson(text.join("")), thinking: thinking.join(""), tools };
}

/** Parse a full transcript (`.jsonl` contents) into ordered conversation turns. */
export function parseTranscript(jsonl: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const line of jsonl.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let o: any;
    try {
      o = JSON.parse(s);
    } catch {
      continue; // tolerate a torn final line while the file is being appended
    }
    if (o?.type !== "assistant" && o?.type !== "user") continue;
    const msg = o.message;
    if (!msg) continue;
    const { text, thinking, tools } = readContent(msg.content);
    // skip empty user echoes with no payload
    if (o.type === "user" && !text && tools.length === 0) continue;
    turns.push({
      role: o.type,
      text,
      thinking,
      tools,
      usage: o.type === "assistant" ? readUsage(msg.usage) : undefined,
      model: typeof msg.model === "string" ? msg.model : undefined,
    });
  }
  return turns;
}

/** The text of the last assistant turn (the final answer) — "" if none. */
export function lastAssistantText(turns: TranscriptTurn[]): string {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === "assistant" && turns[i].text) return turns[i].text;
  }
  return "";
}

/** Text of the first non-empty user turn, with reminder-ish tags stripped. */
export function firstUserText(turns: TranscriptTurn[]): string {
  const u = turns.find((t) => t.role === "user" && t.text.trim());
  return u ? u.text.replace(/<\/?[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "";
}

/**
 * Find the transcript file for a session we just launched, disambiguating it
 * from PAI hook / sub-agent sessions (satisfaction classifiers, title
 * generators, …) that also drop transcripts into the same project dir.
 *
 * We pick the NEW file whose first user turn matches the prompt we injected;
 * ties break to the shortest first-user-turn — the main session's first turn
 * IS our prompt, whereas a classifier embeds it inside a longer meta-prompt.
 * Returns "" until a matching file with assistant output exists.
 */
export function locateSessionFile(projectsDir: string, before: Set<string>, prompt: string): string {
  if (!existsSync(projectsDir)) return "";
  const snip = prompt.replace(/\s+/g, " ").trim().slice(0, 40);
  let best = "";
  let bestLen = Infinity;
  for (const f of readdirSync(projectsDir)) {
    if (!f.endsWith(".jsonl") || before.has(f)) continue;
    let turns: TranscriptTurn[];
    try {
      turns = parseTranscript(readFileSync(join(projectsDir, f), "utf8"));
    } catch {
      continue;
    }
    if (!turns.some((t) => t.role === "assistant" && t.text)) continue; // sidecars excluded
    const u = firstUserText(turns);
    if (snip && !u.includes(snip)) continue; // not our prompt
    if (u.length < bestLen) {
      best = join(projectsDir, f);
      bestLen = u.length;
    }
  }
  return best;
}

/** Sum token usage across all assistant turns. */
export function totalUsage(turns: TranscriptTurn[]): TokenUsage {
  const t = emptyUsage();
  for (const turn of turns) {
    if (!turn.usage) continue;
    t.input += turn.usage.input;
    t.output += turn.usage.output;
    t.cacheRead += turn.usage.cacheRead;
    t.cacheCreate += turn.usage.cacheCreate;
  }
  return t;
}
