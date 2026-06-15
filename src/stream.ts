/**
 * Stream-JSON protocol: frame the messages we WRITE to a headless `claude -p
 * --input-format stream-json` agent, and parse the events it emits on stdout
 * with `--output-format stream-json --include-partial-messages`.
 *
 * Everything protocol-shaped lives here so that, if the real CLI shapes differ
 * from what the docs describe, the fix is one place — not scattered through the
 * agent/render layers. Pure module: no IO, fully unit-testable.
 *
 * Documented input shape (Anthropic Messages-API aligned, newline-delimited):
 *   {"type":"user","message":{"role":"user","content":"<text>"}}
 * Some community wrappers accept the flatter {"type":"user","content":"<text>"}.
 * We emit the full shape; ALT_USER_LINE is kept as a documented fallback.
 */

/** The canonical user-message line written to the agent's stdin (incl. \n). */
export function userLine(text: string, images?: { mediaType: string; data: string }[]): string {
  if (!images?.length) {
    return JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";
  }
  // images present → Messages-API content array with base64 image blocks
  const content: any[] = [];
  if (text.trim()) content.push({ type: "text", text });
  for (const img of images) {
    content.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } });
  }
  return JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
}

/** Fallback framing if the canonical shape is rejected by the CLI. */
export function altUserLine(text: string): string {
  return JSON.stringify({ type: "user", content: text }) + "\n";
}

export type EventKind =
  | "init"
  | "delta" // streaming assistant text fragment
  | "assistant" // full assistant message (text + tool_use)
  | "result" // turn finished
  | "user" // echoed user / tool_result (noise — usually ignored)
  | "error"
  | "other";

export interface ParsedEvent {
  kind: EventKind;
  sessionId?: string;
  /** delta: the text fragment */
  text?: string;
  /** assistant: text blocks joined */
  assistantText?: string;
  /** assistant: tool_use call summaries */
  tools?: { name: string; summary: string }[];
  /** assistant: latest model id / usage snapshot */
  model?: string;
  ctxTokens?: number;
  thinking?: boolean;
  /** result: was the turn an error */
  isError?: boolean;
  resultText?: string;
  /** result: per-turn token usage + cumulative session cost */
  inTokens?: number;
  outTokens?: number;
  costUsd?: number;
  raw: any;
}

function clip(s: string, n = 80): string {
  const flat = String(s).replace(/\s+/g, " ").trim();
  return [...flat].length > n ? [...flat].slice(0, n - 1).join("") + "…" : flat;
}

/** Best-effort one-line summary of a tool_use input (matches the monitor's style). */
export function toolSummary(name: string, input: any): string {
  if (!input || typeof input !== "object") return name;
  const arg =
    input.command ?? input.file_path ?? input.path ?? input.pattern ??
    input.query ?? input.prompt ?? input.description ?? "";
  return arg ? `${name}: ${clip(String(arg), 60)}` : name;
}

/** Parse one NDJSON line from the agent's stdout into a typed event. */
export function parseEvent(line: string): ParsedEvent | null {
  let o: any;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object") return null;
  const sessionId: string | undefined = o.session_id ?? o.sessionId;

  // init / system
  if (o.type === "system") {
    return { kind: "init", sessionId, model: o.model, raw: o };
  }

  // streaming partial text delta
  if (o.type === "stream_event") {
    const ev = o.event;
    if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
      return { kind: "delta", sessionId, text: ev.delta.text ?? "", raw: o };
    }
    if (ev?.type === "content_block_delta" && ev.delta?.type === "thinking_delta") {
      return { kind: "delta", sessionId, text: "", thinking: true, raw: o };
    }
    return { kind: "other", sessionId, raw: o };
  }

  // full assistant message
  if (o.type === "assistant" && o.message) {
    const content = o.message.content;
    let text = "";
    let thinking = false;
    const tools: { name: string; summary: string }[] = [];
    if (Array.isArray(content)) {
      for (const p of content) {
        if (p?.type === "text" && typeof p.text === "string" && p.text.trim()) {
          text += (text ? "\n" : "") + p.text;
        } else if (p?.type === "tool_use" && p.name) {
          tools.push({ name: p.name, summary: toolSummary(p.name, p.input) });
        } else if (p?.type === "thinking") {
          thinking = true;
        }
      }
    } else if (typeof content === "string") {
      text = content;
    }
    const u = o.message.usage;
    const ctxTokens = u
      ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
      : undefined;
    return {
      kind: "assistant",
      sessionId,
      assistantText: text,
      tools,
      model: o.message.model,
      ctxTokens,
      thinking,
      raw: o,
    };
  }

  // turn finished
  if (o.type === "result") {
    const u = o.usage;
    return {
      kind: "result",
      sessionId,
      isError: o.is_error === true || /error/i.test(o.subtype ?? ""),
      resultText: typeof o.result === "string" ? o.result : "",
      inTokens: u?.input_tokens,
      outTokens: u?.output_tokens,
      ctxTokens: u
        ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
        : undefined,
      costUsd: typeof o.total_cost_usd === "number" ? o.total_cost_usd : undefined,
      raw: o,
    };
  }

  if (o.type === "user") return { kind: "user", sessionId, raw: o };

  return { kind: "other", sessionId, raw: o };
}
