import { test } from "node:test";
import assert from "node:assert/strict";
import { askPrompt, factoryReport, failureSignature, parseAnswer, type ReportTrace } from "../src/analysis";
import type { Step } from "../src/traces";

const step = (seq: number, s: Partial<Step>): Step => ({ seq, ts: seq, kind: "tool_call", preview: "", files: [], ...s });

test("answers keep only citations that name a real source", () => {
  const sources = [{ ref: "T1.4", text: "ada edited src/db.js" }, { ref: "E9", text: "change.merged" }];
  const r = parseAnswer({ answer: "ada changed it [T1.4], see also [X5] and [E9].", citations: ["T1.4", "Z1"] }, sources)!;
  assert.deepEqual(r.citations.map((c) => c.ref), ["T1.4", "E9"]);
  assert.equal(parseAnswer({ answer: "  " }, sources), null);
  const p = askPrompt("why?", "change #1", [{ ref: "A1", text: "x".repeat(50) }, { ref: "A2", text: "y".repeat(50) }], 70);
  assert.equal(p.used, 1);
  assert.ok(p.truncated);
});

test("check failures that differ only in numbers and paths group together", () => {
  assert.equal(failureSignature("ok 1\nError: Cannot find module '/tmp/a1/x' after 12ms"), failureSignature("ok 2\nError: Cannot find module '/tmp/b77/x' after 40ms"));
});

test("the factory report finds waste, repeated mistakes, skipped intents and thrash, and compares models", () => {
  const read = (seq: number) => step(seq, { tool: "Read", files: ["src/db.js"] });
  const traces: ReportTrace[] = [
    { id: 1, agent: "a", agentName: "ada", models: ["m-big"], tokensIn: 1000, tokensOut: 100, costUsd: 0.5, steps: [read(1), read(2), read(3), step(4, { tool: "Edit", files: ["src/db.js"] }), step(5, { loomCall: "submit_change", tool: "mcp__loom__submit_change" })] },
    { id: 2, agent: "b", agentName: "bob", models: ["m-small"], tokensIn: 200, tokensOut: 20, costUsd: null, steps: [step(1, { loomCall: "declare_intent", tool: "x" }), read(2), read(3), ...Array.from({ length: 6 }, (_, i) => step(4 + i, { tool: "Write", files: ["src/app.js"] }))] },
  ];
  const changes = [
    { id: 1, title: "one", agent: "a", agentName: "ada", status: "merged", rounds: 2, checksFailed: 1, reverted: true, models: ["m-big"] },
    { id: 2, title: "two", agent: "b", agentName: "bob", status: "merged", rounds: 0, checksFailed: 1, reverted: false, models: ["m-small"] },
  ];
  const failures = [{ change: 1, output: "Error: missing migration 12" }, { change: 2, output: "Error: missing migration 13" }];
  const r = factoryReport(0, 1, traces, changes, failures);
  const kinds = r.findings.map((f) => f.kind);
  assert.ok(r.findings.some((f) => f.kind === "waste" && f.title.startsWith("src/db.js was read 5 times")), JSON.stringify(r.findings));
  assert.ok(r.findings.some((f) => f.kind === "mistakes" && f.refs.length === 2));
  assert.ok(r.findings.some((f) => f.kind === "instructions" && /50%/.test(f.title)), "ada edited before declaring; bob didn't");
  assert.equal(kinds.filter((k) => k === "thrash").length, 2);
  const big = r.models.find((m) => m.model === "m-big")!;
  assert.deepEqual([big.sessions, big.tokens, big.landed, big.reverted, big.reworkRounds, big.tokensPerLanded], [1, 1100, 1, 1, 2, 1100]);
  assert.equal(r.agents.find((a) => a.agent === "b")!.model, "bob");
});

test("a report's summary sources: totals, then each finding, model and agent row, numbered", async () => {
  const { reportSources } = await import("../src/analysis.ts");
  const row = { sessions: 2, tokens: 300, costUsd: null, changes: 2, landed: 1, reworkRounds: 1, checksFailed: 0, reverted: 0, tokensPerLanded: 300 };
  const s = reportSources({ from: 0, to: 1, sessions: 2, changes: 2, landed: 1, findings: [{ kind: "thrash", title: "b.txt edited 7 times", detail: "d", suggest: "s", refs: [] }], models: [{ model: "m1", ...row }], agents: [{ model: "ada", agent: "a1", ...row }] });
  assert.deepEqual(s.map((x) => x.ref), ["S1", "F1", "M1", "A1"]);
  assert.match(s[1].text, /thrash.*b\.txt edited 7 times/);
  assert.match(s[3].text, /^Agent ada: 2 sessions/);
});
