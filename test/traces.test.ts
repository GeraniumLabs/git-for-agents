import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPattern, detectSource, dropThoughts, filesOf, intentOf, loomCallOf, parseTrace, promptOf, redact, traceLimits } from "../src/traces.ts";

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

test("logs and steps are stored gzipped and come back the same", async () => {
  const { gzip, gunzip, traceKeys } = await import("../src/traces.ts");
  const packed = await gzip(claudeCode.repeat(20));
  assert.ok(packed.byteLength < claudeCode.length * 20 / 5, "agent logs compress well");
  assert.equal(await gunzip(packed), claudeCode.repeat(20));
  assert.deepEqual(traceKeys("p", 3), { log: "p/traces/3/log.gz", steps: "p/traces/3/steps.json.gz" });
});

test("a real transcript is recognized even when its first prompt runs past 20 KB", () => {
  const big = [
    line({ type: "queue-operation", operation: "enqueue", sessionId: "s-2", timestamp: "2026-11-11T00:00:00Z" }),
    line({ type: "user", sessionId: "s-2", timestamp: "2026-11-11T00:00:01Z", message: { role: "user", content: "context ".repeat(5000) + "go" } }),
    line({ type: "assistant", sessionId: "s-2", timestamp: "2026-11-11T00:00:02Z", message: { id: "m9", role: "assistant", model: "m", content: [{ type: "text", text: "ok" }] } }),
  ].join("\n");
  assert.equal(detectSource(big), "claude-code");
  assert.equal(parseTrace(big).sessionId, "s-2");
});

test("token counts and code that reads a secret aren't redacted", () => {
  const r = redact('tokensIn: 1200, "thinkingTokens":25361, const key = env.LOOM_SECRET_KEY, max_tokens=4096, b.tokensOut = s.tokens_out');
  assert.equal(r.count, 0, r.text);
  assert.equal(redact("api_key: abcdefgh12345678").count, 1, "a real value still goes");
});

test("inline images are dropped from the stored log", () => {
  const png = "iVBORw0KGgo" + "A".repeat(4000);
  const r = redact(line({ type: "user", message: { content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: png } }] } }) + `\n<img src="data:image/png;base64,${png}">`);
  assert.equal(r.kinds.image, 2);
  assert.ok(!r.text.includes("AAAAAAAA"));
  assert.doesNotThrow(() => JSON.parse(r.text.split("\n")[0]));
});

test("harness wake-ups are context; a person's words inside them are the prompt", () => {
  assert.deepEqual(promptOf('<wake reason="mention"><message from="human" author="J">Ok what\'s next</message></wake>'), { kind: "prompt", text: "Ok what's next" });
  assert.equal(promptOf("<task-notification>\n<status>pending</status></task-notification>").kind, "context");
  assert.equal(promptOf("[Image: original 2480x1184]").kind, "context");
  assert.equal(promptOf("anything", true).kind, "context", "lines the agent marks as meta");
  assert.equal(promptOf("Add due dates to todos").kind, "prompt");
});

test("a person's words relayed by another agent count, and entities are decoded", () => {
  assert.deepEqual(promptOf('<relay><cited author="user" name="J">ok that finally works</cited><note>J says it works</note></relay>'), { kind: "prompt", text: "ok that finally works" });
  assert.equal(promptOf('<message from="human">I&#39;m &quot;here&quot;</message>').text, `I'm "here"`);
});

test("a change's intent: the person's ask, and the agent's acts on its files with the reason it gave", () => {
  const log = [
    line({ type: "user", sessionId: "s-3", timestamp: "2026-11-11T10:00:00Z", message: { role: "user", content: "Make the deploy use a user token" } }),
    line({ type: "assistant", sessionId: "s-3", timestamp: "2026-11-11T10:00:01Z", message: { id: "a1", role: "assistant", content: [{ type: "text", text: "Account tokens fail at /queues, so I'll document user tokens." }] } }),
    line({ type: "assistant", sessionId: "s-3", timestamp: "2026-11-11T10:00:02Z", message: { id: "a2", role: "assistant", content: [{ type: "tool_use", id: "e1", name: "Edit", input: { file_path: "/repo/.github/workflows/deploy.yml", old_string: "a", new_string: "b" } }] } }),
    line({ type: "user", sessionId: "s-3", timestamp: "2026-11-11T10:00:03Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "e1", content: "ok" }] } }),
    line({ type: "assistant", sessionId: "s-3", timestamp: "2026-11-11T10:00:04Z", message: { id: "a3", role: "assistant", content: [{ type: "tool_use", id: "e2", name: "Edit", input: { file_path: "/repo/.github/workflows/deploy.yml", old_string: "b", new_string: "c" } }] } }),
    line({ type: "assistant", sessionId: "s-3", timestamp: "2026-11-11T10:00:05Z", message: { id: "a4", role: "assistant", content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "npx wrangler deploy" } }] } }),
    line({ type: "user", sessionId: "s-3", timestamp: "2026-11-11T10:00:06Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "b1", is_error: true, content: "Permission for this action was denied by the auto mode classifier." }] } }),
    line({ type: "assistant", sessionId: "s-3", timestamp: "2026-11-11T10:00:07Z", message: { id: "a5", role: "assistant", content: [{ type: "tool_use", id: "x1", name: "Edit", input: { file_path: "/repo/README.md", old_string: "a", new_string: "b" } }] } }),
  ].join("\n");
  const it = intentOf(parseTrace(log).steps, { paths: [".github/workflows/deploy.yml"] });
  assert.deepEqual(it.asks.map((a) => a.text), ["Make the deploy use a user token"]);
  assert.deepEqual(it.acts.map((a) => a.kind), ["edit", "command", "refused"], "one edit per file, the deploy, its refusal; README is outside the change");
  assert.match(it.acts[0].why!, /Account tokens fail/);
  assert.equal(it.acts[0].ask, it.asks[0].seq);
  assert.deepEqual(intentOf(parseTrace(log).steps, { paths: ["other.ts"] }), { asks: [], acts: [] });
});
