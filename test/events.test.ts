import { test } from "node:test";
import assert from "node:assert/strict";
import { projectOfWorkspace, pushOf } from "../src/events";

test("a push event names the workspace repo, the ref and the new head", () => {
  const p = pushOf({ type: "cf.artifacts.repo.pushed", source: { type: "artifacts.repo", namespace: "loom", repoName: "todo-swarm-t12-a1b2c3" }, payload: { ref: "refs/heads/main", before: "aaa", after: "bbb", commits: [{}, {}] } });
  assert.deepEqual(p, { repo: "todo-swarm-t12-a1b2c3", ref: "refs/heads/main", before: "aaa", after: "bbb", commits: 2 });
});

test("other Artifacts events are not pushes", () => {
  assert.equal(pushOf({ type: "cf.artifacts.repo.cloned", source: { repoName: "x-t1-ab" } }), null);
  assert.equal(pushOf({ type: "cf.artifacts.repo.forked", payload: {} }), null);
  assert.equal(pushOf("nope"), null);
});

test("the project is read off a workspace name, dashes and all", () => {
  assert.equal(projectOfWorkspace("todo-swarm-t12-a1b2c3"), "todo-swarm");
  assert.equal(projectOfWorkspace("a-t2-team-t7-0f0f0f"), "a-t2-team");
  assert.equal(projectOfWorkspace("todo-swarm"), null, "main is not a workspace");
});
