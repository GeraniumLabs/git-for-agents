import { test } from "node:test";
import assert from "node:assert/strict";
import { numberPatch, parseReview, reviewPrompt } from "../src/reviewer";

const input = { title: "Trim titles", summary: "", task: { title: "Trim titles", description: "Strip spaces" }, intent: "trim (src/db.js)", files: ["src/db.js"], patch: "x".repeat(100), brief: [], project: "p" };

test("comments on files the change doesn't touch are dropped, and a/ b/ prefixes are stripped", () => {
  const r = parseReview({ verdict: "comment", summary: "s", comments: [{ path: "b/src/db.js", line: 3, body: "hm", blocking: false }, { path: "other.js", line: 1, body: "no", blocking: false }] }, ["src/db.js"], false, "m");
  assert.ok(r.ok);
  assert.deepEqual(r.comments, [{ path: "src/db.js", line: 3, body: "hm", blocking: false }]);
});

test("a blocking comment makes it a request for changes; a truncated diff is never approved", () => {
  const blocking = parseReview({ verdict: "approve", summary: "", comments: [{ path: "src/db.js", line: 0, body: "bug", blocking: true }] }, ["src/db.js"], false, "m");
  assert.ok(blocking.ok && blocking.verdict === "request_changes");
  assert.equal(blocking.ok && blocking.comments[0].line, undefined, "line 0 means the whole file");
  const cut = parseReview({ verdict: "approve", summary: "", comments: [] }, ["src/db.js"], true, "m");
  assert.ok(cut.ok && cut.verdict === "comment");
});

test("no verdict is a failure, not an approval", () => {
  assert.equal(parseReview({ summary: "looks fine" }, [], false, "m").ok, false);
  assert.equal(parseReview(null, [], false, "m").ok, false);
});

test("the prompt carries the task and says when the diff is cut off", () => {
  const p = reviewPrompt(input, 10);
  assert.match(p, /Strip spaces/);
  assert.match(p, /truncated, so don't approve/);
  assert.doesNotMatch(reviewPrompt(input, 1000), /truncated/);
});

test("diff lines carry their line number in the new file; removed lines don't", () => {
  const patch = ["diff --git a/f.js b/f.js", "--- a/f.js", "+++ b/f.js", "@@ -3,3 +3,3 @@", " keep", "-old", "+new", " tail"].join("\n");
  assert.deepEqual(numberPatch(patch).split("\n").slice(4), ["    3  keep", "      -old", "    4 +new", "    5  tail"]);
});

test("a summary that only repeats the verdict is replaced with a sentence", () => {
  const r = parseReview({ verdict: "approve", summary: "approve", comments: [] }, [], false, "m");
  assert.ok(r.ok && r.body === "Looks right for the task; approving.");
});
