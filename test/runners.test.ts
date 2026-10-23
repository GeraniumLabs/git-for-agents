import { test } from "node:test";
import assert from "node:assert/strict";
import { hookBody, isGitHubDispatch, runnerPrompt, validHookEvents } from "../src/runners.ts";

test("a hook asks for work by default, or for event types", () => {
  assert.deepEqual(validHookEvents(undefined), ["work"]);
  assert.deepEqual(validHookEvents(["work", "change.merged", "change.merged"]), ["work", "change.merged"]);
  assert.deepEqual(validHookEvents(["*"]), ["*"]);
  assert.throws(() => validHookEvents([]), /events is a list/);
  assert.throws(() => validHookEvents(["merged!"]), /unknown events/);
});

test("a hook to GitHub's dispatch API is sent as a repository_dispatch event", () => {
  const gh = "https://api.github.com/repos/GeraniumLabs/runner/dispatches";
  assert.ok(isGitHubDispatch(gh));
  assert.ok(!isGitHubDispatch("https://api.github.com/repos/a/b/issues"));
  const payload = { project: "p", dashboard: "d", mcp: "m", work: [{ kind: "task" }] };
  const body = hookBody(gh, "work", payload) as any;
  assert.equal(body.event_type, "loom.work");
  assert.equal(body.client_payload.project, "p");
  assert.ok(Object.keys(body.client_payload).length <= 10, "GitHub allows at most 10 payload keys");
  assert.deepEqual(hookBody("https://example.com/hook", "work", payload), { kind: "work", ...payload });
});

test("the runner prompt says how to find and finish one piece of work", () => {
  const p = runnerPrompt("https://loom.dev", "app");
  assert.match(p, /whoami/);
  assert.match(p, /list_work/);
  assert.match(p, /release_task/);
});
