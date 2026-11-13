import { test } from "node:test";
import assert from "node:assert/strict";
import { GONE_MS, RELEASE_MS, canTakeOver, nextRelease, releaseNow, type Holding } from "../src/presence.ts";

const now = 10 * GONE_MS;
const h = (taskStatus: string, quietMs: number, more: Partial<Holding> = {}): Holding => ({ taskStatus, changeStatus: null, lastSeen: now - quietMs, paused: false, ...more });

test("a claimed task stays with an agent that keeps calling", () => {
  assert.equal(releaseNow(h("claimed", RELEASE_MS - 1), now), null);
});

test("a claimed or blocked task goes back to the open list once its agent has been quiet for 30 minutes", () => {
  assert.equal(releaseNow(h("claimed", RELEASE_MS), now), "open");
  assert.equal(releaseNow(h("blocked", RELEASE_MS + 1), now), "open");
});

test("a task with a change that needs its author keeps its status, so whoever claims it takes the change over", () => {
  assert.equal(releaseNow(h("conflict", RELEASE_MS), now), "conflict");
  assert.equal(releaseNow(h("in_review", RELEASE_MS, { changeStatus: "changes_requested" }), now), "in_review");
  assert.equal(releaseNow(h("in_review", RELEASE_MS, { changeStatus: "checks_failed" }), now), "in_review");
});

test("a change waiting on reviewers or the queue doesn't need its author, so the task stays put", () => {
  assert.equal(releaseNow(h("in_review", GONE_MS * 2, { changeStatus: "review" }), now), null);
  assert.equal(releaseNow(h("in_review", GONE_MS * 2, { changeStatus: "queued" }), now), null);
});

test("a paused agent keeps its task: a person decided that", () => {
  assert.equal(releaseNow(h("claimed", GONE_MS * 2, { paused: true }), now), null);
});

test("a person's assignment waits a day for the agent to show up", () => {
  assert.equal(releaseNow(h("open", RELEASE_MS * 4), now), null);
  assert.equal(releaseNow(h("open", GONE_MS), now), "open");
});

test("the alarm comes back for the next holding to come due, and never for one that won't", () => {
  const hs = [h("claimed", 5 * 60_000), h("in_review", 0, { changeStatus: "review" }), h("claimed", 20 * 60_000, { paused: true }), h("open", 60_000)];
  assert.equal(nextRelease(hs, now), now - 5 * 60_000 + RELEASE_MS);
  assert.equal(nextRelease([h("in_review", 0, { changeStatus: "review" })], now), null);
  // Already due: released by this sweep, not a reason to wake again right away.
  assert.equal(nextRelease([h("claimed", RELEASE_MS + 1)], now), null);
});

test("another agent can take over a quiet holder's task, but not a live one's, nor a person's assignment the same day", () => {
  const quiet = 10 * 60_000;
  assert.equal(canTakeOver("claimed", now - 60_000, now, quiet), false);
  assert.equal(canTakeOver("claimed", now - quiet - 1, now, quiet), true);
  assert.equal(canTakeOver("open", now - quiet - 1, now, quiet), false);
  assert.equal(canTakeOver("open", now - GONE_MS - 1, now, quiet), true);
  assert.equal(canTakeOver("claimed", null, now, quiet), true);
});
