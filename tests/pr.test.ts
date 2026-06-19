/**
 * Pure-function tests for the PR-review module: gh-list parsing and the
 * analysis-verdict parser (JSON extraction + freeform fallback).
 */
import { test, expect } from "bun:test";
import { parsePrList, parseAnalysis } from "../src/pr.ts";

test("parsePrList parses the REST pulls array (user.login, head.ref, draft)", () => {
  const json = JSON.stringify([
    {
      number: 7, title: "Fix race", user: { login: "octocat" },
      head: { ref: "fix/race" }, base: { ref: "main" },
      draft: false, updated_at: "2026-06-16T10:00:00Z",
      html_url: "https://github.com/o/r/pull/7",
    },
  ]);
  const prs = parsePrList(json);
  expect(prs).toHaveLength(1);
  expect(prs[0].number).toBe(7);
  expect(prs[0].author).toBe("octocat");
  expect(prs[0].headRefName).toBe("fix/race");
  expect(prs[0].baseRefName).toBe("main");
  expect(prs[0].isDraft).toBe(false);
  expect(prs[0].url).toBe("https://github.com/o/r/pull/7");
  // list endpoint omits these → safe defaults
  expect(prs[0].additions).toBe(0);
  expect(prs[0].mergeable).toBe("UNKNOWN");
});

test("parsePrList maps REST mergeable boolean/null to a string", () => {
  const mk = (m: unknown) => parsePrList(JSON.stringify([{ number: 1, mergeable: m }]))[0].mergeable;
  expect(mk(true)).toBe("MERGEABLE");
  expect(mk(false)).toBe("CONFLICTING");
  expect(mk(null)).toBe("UNKNOWN");
});

test("parsePrList returns empty array for empty/malformed json", () => {
  expect(parsePrList("[]")).toEqual([]);
  expect(parsePrList("not json")).toEqual([]);
  expect(parsePrList("")).toEqual([]);
  expect(parsePrList("{}")).toEqual([]); // not an array
});

const VERDICT = {
  riskLevel: "high",
  mergeRecommendation: "changes-requested",
  summary: "Touches auth.",
  findings: [
    { category: "security", severity: "high", title: "Token logged", detail: "leaks", location: "src/a.ts:10" },
  ],
  report: "# Review\nDetails…",
};

test("parseAnalysis parses a bare JSON verdict object", () => {
  const a = parseAnalysis(JSON.stringify(VERDICT));
  expect(a.riskLevel).toBe("high");
  expect(a.mergeRecommendation).toBe("changes-requested");
  expect(a.findings).toHaveLength(1);
  expect(a.findings[0].category).toBe("security");
  expect(a.findings[0].location).toBe("src/a.ts:10");
  expect(a.report).toContain("# Review");
});

test("parseAnalysis parses a verdict wrapped in a ```json fence with prose around it", () => {
  const raw = "Here is the analysis:\n\n```json\n" + JSON.stringify(VERDICT) + "\n```\n\nDone.";
  const a = parseAnalysis(raw);
  expect(a.riskLevel).toBe("high");
  expect(a.findings).toHaveLength(1);
});

test("parseAnalysis falls back to a freeform report when no JSON is present", () => {
  const a = parseAnalysis("Just some markdown, no json here.");
  expect(a.riskLevel).toBe("medium");
  expect(a.mergeRecommendation).toBe("needs-review");
  expect(a.findings).toEqual([]);
  expect(a.report).toBe("Just some markdown, no json here.");
});

test("parseAnalysis falls back when the JSON is malformed", () => {
  const a = parseAnalysis("{ riskLevel: high, oops }");
  expect(a.riskLevel).toBe("medium");
  expect(a.report).toContain("oops");
});

test("parseAnalysis clamps unknown enum values to safe defaults", () => {
  const a = parseAnalysis(JSON.stringify({ riskLevel: "catastrophic", mergeRecommendation: "yolo", report: "x" }));
  expect(a.riskLevel).toBe("medium");
  expect(a.mergeRecommendation).toBe("needs-review");
});
