/**
 * Lenient extraction + parsing of the JSON object a Claude instance emits as its
 * final triage/analysis message. Models routinely (a) wrap the object in prose or
 * a ```json fence, (b) put LITERAL newlines/tabs inside long string values (e.g. a
 * multi-line Markdown `report`), which strict JSON.parse rejects, and (c) get cut
 * off mid-object when a turn ends early. Each of those would otherwise fall back to
 * dumping the whole raw blob into the UI as an unreadable JSON wall. This module
 * repairs the common cases so the structured fields render properly.
 *
 * Electron port of repo-root src/jsonish.ts — pure string logic, no runtime deps,
 * so it is identical to the CLI source.
 */

/** Balanced `{…}` slice starting at `start`, ignoring braces inside string literals.
 *  If unterminated (truncated output) the partial tail is returned for closeBalanced(). */
function balancedFrom(text: string, start: number): string {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return text.slice(start); // unterminated
}

/**
 * Return the first balanced top-level `{…}` object in `raw`, ignoring braces that
 * appear inside string literals, and tolerating prose before/after the object. ""
 * if there is no `{` at all. NOTE: this picks the FIRST `{` — prose containing
 * braces (e.g. a CSS snippet `{ @apply … }`) will fool it; parseJsonish() scans all
 * candidates and is what callers should use to actually parse.
 */
export function extractJsonObject(raw: string): string {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const text = fence ? fence[1] : raw;
  const start = text.indexOf("{");
  return start < 0 ? "" : balancedFrom(text, start);
}

/** Escape raw control chars that appear INSIDE string literals (real newlines/tabs
 *  in long values) so strict JSON.parse accepts them. Leaves structure untouched. */
function escapeControlInStrings(s: string): string {
  let out = "", inStr = false, esc = false;
  for (const c of s) {
    if (inStr) {
      if (esc) { out += c; esc = false; continue; }
      if (c === "\\") { out += c; esc = true; continue; }
      if (c === '"') { out += c; inStr = false; continue; }
      if (c === "\n") { out += "\\n"; continue; }
      if (c === "\r") { out += "\\r"; continue; }
      if (c === "\t") { out += "\\t"; continue; }
      out += c;
    } else {
      out += c;
      if (c === '"') inStr = true;
    }
  }
  return out;
}

/** Close any string/array/object left open by truncated output, dropping a dangling
 *  trailing comma, so a cut-off object still parses into whatever arrived. */
function closeBalanced(s: string): string {
  let inStr = false, esc = false;
  const stack: string[] = [];
  for (const c of s) {
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") stack.push("}");
    else if (c === "[") stack.push("]");
    else if (c === "}" || c === "]") stack.pop();
  }
  let out = s;
  if (inStr) out += '"';
  // a trailing comma before an appended closer is invalid — strip it first
  out = out.replace(/,\s*$/, "");
  while (stack.length) out += stack.pop();
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** Try strict → control-char-escaped → truncation-closed parse of one `{…}` slice. */
function tryParseObject(obj: string): Record<string, unknown> | null {
  const escaped = escapeControlInStrings(obj);
  for (const candidate of [obj, escaped, closeBalanced(escaped)]) {
    try {
      const v = JSON.parse(candidate);
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      /* try the next, more aggressive, repair */
    }
  }
  return null;
}

/**
 * Parse the model's JSON object as forgivingly as possible. Models routinely wrap
 * the object in prose that ITSELF contains braces (e.g. a CSS snippet
 * `.md-view table { @apply … }` or a code example), so a first-`{` extraction grabs
 * the wrong span. We therefore try EVERY `{` position, parse the balanced slice
 * there (with control-char + truncation repairs), and keep the object with the most
 * keys — the real triage object (type/priority/summary/findings/report) dwarfs any
 * stray brace group in the prose. Returns null if nothing usable was recovered.
 */
export function parseJsonish(raw: string): Record<string, unknown> | null {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const text = fence ? fence[1] : raw;
  let best: Record<string, unknown> | null = null;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    const parsed = tryParseObject(balancedFrom(text, i));
    if (parsed && (!best || Object.keys(parsed).length > Object.keys(best).length)) best = parsed;
  }
  return best;
}
