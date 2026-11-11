import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPattern, detectSource, dropThoughts, filesOf, loomCallOf, parseTrace, redact, traceLimits } from "../src/traces.ts";

const line = (o: unknown) => JSON.stringify(o);

const claudeCode = [
  line({ type: "summary", summary: "Add due dates" }),
  line({ type: "user", sessionId: "s-1", timestamp: "2026-11-11T10:00:00Z", message: { role: "user", content: "Add due dates to todos" } }),
  line({ type: "assistant", sessionId: "s-1", timestamp: "2026-11-11T10:00:05Z", message: { id: "m1", role: "assistant", model: "claude-opus-5-5", usage: { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 50 }, content: [{ type: "thinking", thinking: "I should declare an intent on src/todo.ts first." }] } }),
  // The same message continues on the next line with the same usage: counted once.
  line({ type: "assistant", sessionId: "s-1", timestamp: "2026-11-11T10:00:06Z", message: { id: "m1", role: "assistant", model: "claude-opus-5-5", usage: { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 50 }, content: [{ type: "tool_use", id: "t1", name: "mcp__loom__declare_intent", input: { paths: ["src/todo.ts"], description: "due dates" } }] } }),
  line({ type: "user", sessionId: "s-1", timestamp: "2026-11-11T10:00:07Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "intent #4 declared" }] } }),
  line({ type: "assistant", sessionId: "s-1", timestamp: "2026-11-11T10:01:00Z", message: { id: "m2", role: "assistant", model: "claude-opus-5-5", usage: { input_tokens: 10, output_tokens: 20 }, content: [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: "src/todo.ts", old_string: "a", new_string: "b" } }] } }),
  line({ type: "user", sessionId: "s-1", timestamp: "2026-11-11T10:01:01Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", is_error: true, content: "old_string not found" }] } }),
  '{"type":"assistant","message":{"cut off',
].join("\n");

test("Claude Code transcripts become steps, with Loom calls and files picked out", () => {
  assert.equal(detectSource(claudeCode), "claude-code");
  const t = parseTrace(claudeCode);
  assert.equal(t.sessionId, "s-1");
  assert.deepEqual(t.models, ["claude-opus-5-5"]);
  assert.equal(t.tokensIn, 1010, "a message's usage counts once, cache reads included");
  assert.equal(t.tokensOut, 70);
  assert.deepEqual(t.steps.map((s) => s.kind), ["prompt", "thought", "tool_call", "tool_result", "tool_call", "error"]);
  const intent = t.steps[2];
  assert.equal(intent.loomCall, "declare_intent");
  assert.deepEqual(intent.files, ["src/todo.ts"]);
  assert.equal(t.steps[3].loomCall, "declare_intent", "the result is tied to its call");
  assert.equal(t.steps[4].loomCall, undefined, "Edit isn't a Loom call");
  assert.equal(t.steps[5].error, true);
  assert.equal(t.startedAt, Date.parse("2026-11-11T10:00:00Z"));
  assert.equal(t.endedAt, Date.parse("2026-11-11T10:01:01Z"));
});

test("a project that keeps no thoughts drops them from the steps and the stored log", () => {
  assert.ok(!parseTrace(claudeCode, "claude-code", false).steps.some((s) => s.kind === "thought"));
  const stored = dropThoughts(claudeCode, "claude-code");
  assert.ok(!stored.includes("I should declare"));
  assert.ok(stored.includes("mcp__loom__declare_intent"), "the rest of the log stays");
});

const codex = [
  line({ timestamp: "2026-11-11T09:00:00Z", type: "session_meta", payload: { id: "cx-9", cwd: "/w" } }),
  line({ timestamp: "2026-11-11T09:00:00Z", type: "turn_context", payload: { model: "gpt-6-codex" } }),
  line({ timestamp: "2026-11-11T09:00:01Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>cwd</environment_context>" }] } }),
  line({ timestamp: "2026-11-11T09:00:02Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "fix the flaky test" }] } }),
  line({ timestamp: "2026-11-11T09:00:03Z", type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "Look at the test first" }] } }),
  line({ timestamp: "2026-11-11T09:00:04Z", type: "response_item", payload: { type: "function_call", name: "loom__submit_change", call_id: "c1", arguments: JSON.stringify({ title: "Fix flake" }) } }),
  line({ timestamp: "2026-11-11T09:00:05Z", type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "change #7" } }),
  line({ timestamp: "2026-11-11T09:00:06Z", type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", call_id: "c2", input: "*** Begin Patch\n*** Update File: test/a.test.ts\n@@\n*** End Patch" } }),
  line({ timestamp: "2026-11-11T09:00:07Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 500, output_tokens: 40, reasoning_output_tokens: 10 } } } }),
].join("\n");

test("Codex session logs become steps; its own context messages aren't prompts", () => {
  assert.equal(detectSource(codex), "codex");
  const t = parseTrace(codex);
  assert.equal(t.sessionId, "cx-9");
  assert.deepEqual(t.models, ["gpt-6-codex"]);
  assert.deepEqual(t.steps.map((s) => s.kind), ["prompt", "thought", "tool_call", "tool_result", "tool_call"]);
  assert.equal(t.steps[2].loomCall, "submit_change");
  assert.deepEqual(t.steps[4].files, ["test/a.test.ts"]);
  assert.equal(t.tokensIn, 500);
  assert.equal(t.tokensOut, 50);
  assert.ok(!dropThoughts(codex, "codex").includes("Look at the test first"));
});

test("OpenTelemetry GenAI spans become model and tool steps", () => {
  const ns = (iso: string) => String(Date.parse(iso) * 1e6);
  const attr = (key: string, v: string | number) => ({ key, value: typeof v === "number" ? { intValue: String(v) } : { stringValue: v } });
  const otel = JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [
    { name: "execute_tool loom.review_change", startTimeUnixNano: ns("2026-11-11T08:00:02Z"), endTimeUnixNano: ns("2026-11-11T08:00:03Z"), attributes: [attr("gen_ai.operation.name", "execute_tool"), attr("gen_ai.tool.name", "loom.review_change"), attr("gen_ai.tool.call.arguments", JSON.stringify({ changeId: 3 }))] },
    { name: "chat", startTimeUnixNano: ns("2026-11-11T08:00:00Z"), endTimeUnixNano: ns("2026-11-11T08:00:01Z"), attributes: [attr("gen_ai.operation.name", "chat"), attr("gen_ai.request.model", "m-1"), attr("gen_ai.usage.input_tokens", 30), attr("gen_ai.usage.output_tokens", 7)] },
  ] }] }] });
  assert.equal(detectSource(otel), "otel");
  const t = parseTrace(otel);
  assert.deepEqual(t.steps.map((s) => s.kind), ["message", "tool_call"], "in time order");
  assert.equal(t.steps[1].loomCall, "review_change");
  assert.equal(t.tokensIn, 30);
  assert.equal(t.startedAt, Date.parse("2026-11-11T08:00:00Z"));
});

test("anything else is kept as text with no steps", () => {
  assert.equal(detectSource("I fixed the bug.\nDone."), "text");
  assert.equal(parseTrace("I fixed the bug.").steps.length, 0);
});

test("secrets are redacted and JSON stays valid", () => {
  const log = line({ content: "export ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123 and ghp_abcdefghijklmnopqrstuvwxyz0123456789 at https://bob:hunter22@db.example.com/x, password: \"correct-horse\", Authorization: Bearer abcdefghijklmnopqrstuvwx, loom_ABCDEFGHIJKLMNOPQRST" });
  const r = redact(log);
  assert.doesNotThrow(() => JSON.parse(r.text));
  for (const secret of ["sk-ant-api03", "ghp_abc", "hunter22", "correct-horse", "Bearer abcdefgh", "loom_ABCD"]) assert.ok(!r.text.includes(secret), `${secret} is gone`);
  assert.ok(r.text.includes("ANTHROPIC_API_KEY="), "the name stays, only the value goes");
  assert.ok(r.count >= 6);
  assert.equal(r.kinds["github-token"], 1);
});

test("a project's own keys and an owner's patterns are redacted too", () => {
  const r = redact("key one: zzSECRETVALUEzz, twice zzSECRETVALUEzz, and employee 12345-678", { literals: ["zzSECRETVALUEzz", "abc"], patterns: ["\\d{5}-\\d{3}"] });
  assert.ok(!r.text.includes("zzSECRETVALUEzz"));
  assert.equal(r.kinds["project-secret"], 2);
  assert.equal(r.kinds["owner-rule"], 1);
  assert.equal(redact("nothing here").count, 0);
});

test("owner patterns must compile and can't match empty text", () => {
  assert.equal(checkPattern("ACME-[0-9]+"), null);
  assert.match(checkPattern("(")!, /valid/);
  assert.match(checkPattern("x*")!, /empty/);
});

test("Loom calls are recognized by the server name, including through loom_tool", () => {
  assert.equal(loomCallOf("mcp__loom__vote", {}), "vote");
  assert.equal(loomCallOf("mcp__my-loom__loom_tool", { tool: "open_dispute" }), "open_dispute");
  assert.equal(loomCallOf("mcp__github__create_issue", {}), undefined);
  assert.equal(loomCallOf("declare_intent", {}), undefined, "no server named, so not counted");
  assert.deepEqual(filesOf({ files: { "a.ts": "x", "b.ts": "y" } }).sort(), ["a.ts", "b.ts"]);
  assert.deepEqual(filesOf({ files: [{ path: "c.ts", content: "" }] }), ["c.ts"]);
});

test("limits come from the plan when the server takes payments", () => {
  const paid = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x" } as any;
  assert.equal(traceLimits(paid, "free").days, 30);
  assert.equal(traceLimits(paid, "pro").days, 365);
  assert.equal(traceLimits(paid, "unlimited").bytes, 0);
  assert.equal(traceLimits({} as any, "free").days, 90, "no payments: the server's own settings");
  assert.equal(traceLimits({ LOOM_TRACE_DAYS: "0" } as any, null).days, 0);
});
