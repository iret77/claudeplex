/**
 * Transcript parser tests — against a fixture that mirrors the real on-disk
 * schema (assistant text/thinking/tool_use parts, string + array user content,
 * bookkeeping types to ignore, and a torn final line).
 */
import { test, expect } from "bun:test";
import { join } from "node:path";
import { parseTranscript, lastAssistantText, totalUsage, stripHookJson } from "../src/transcript.ts";

const jsonl = await Bun.file(join(import.meta.dir, "fixtures", "transcript.jsonl")).text();
const turns = parseTranscript(jsonl);

test("ignores bookkeeping types and tolerates a torn final line", () => {
  // 1 user + 3 assistant turns (tool_result-only user line is dropped as empty)
  expect(turns.map((t) => t.role)).toEqual(["user", "assistant", "assistant", "assistant"]);
});

test("concatenates text parts and captures thinking + tools", () => {
  expect(lastAssistantText(turns)).toBe("Ich liste die Dateien.");
  const textTurn = turns[2];
  expect(textTurn.text).toBe("2+2 ist 4."); // two text parts joined
  expect(turns[1].thinking).toBe("Simple arithmetic.");
  expect(turns[3].tools).toEqual([{ name: "Bash", input: { command: "ls" } }]);
});

test("strips a trailing PAI session-naming hook payload, keeps real content", () => {
  const withHook = 'Here is the answer.\n\n{"tab_title": "X", "session_name": "Y", "mode": "MINIMAL"}';
  expect(stripHookJson(withHook)).toBe("Here is the answer.");
  // glued directly to content with no preceding newline
  expect(stripHookJson('LOCATOR_OK{"tab_title": "X", "session_name": "Y"}')).toBe("LOCATOR_OK");
  // pretty-printed / multi-line hook payload
  const multiline = 'The real answer.\n\n{\n  "mode": "MINIMAL",\n  "tab_title": "X",\n  "session_name": "Y"\n}';
  expect(stripHookJson(multiline)).toBe("The real answer.");
  // PREPENDED hook payload (observed in NATIVE mode)
  const leading = '{"tab_title":"X","mode":"NATIVE","session_name":"Y"}\n\nThe real answer.';
  expect(stripHookJson(leading)).toBe("The real answer.");
  // leaves legitimate trailing JSON (no tab_title/session_name) untouched
  const realJson = 'Use this config:\n{"port": 8080}';
  expect(stripHookJson(realJson)).toBe(realJson);
  // no-op when there is no trailing object
  expect(stripHookJson("plain text")).toBe("plain text");
});

test("sums token usage across assistant turns", () => {
  const u = totalUsage(turns);
  expect(u.output).toBe(33); // 10 + 8 + 15
  expect(u.input).toBe(420); // 100 + 120 + 200
  expect(u.cacheRead).toBe(110); // 50 + 60 + 0
});
