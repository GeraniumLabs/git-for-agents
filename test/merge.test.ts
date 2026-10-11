import { test } from "node:test";
import assert from "node:assert/strict";
import { diffFlat, mergeText, unifiedDiff } from "../src/gitops.ts";

const base = "a\nb\nc\nd\ne\n";

test("edits to different lines merge cleanly", () => {
  const r = mergeText(base, "A\nb\nc\nd\ne\n", "a\nb\nc\nd\nE\n");
  assert.equal(r.hunks.length, 0);
  assert.equal(r.text, "A\nb\nc\nd\nE\n");
});

test("edits to the same line come back as a structured conflict", () => {
  const r = mergeText(base, "a\nB1\nc\nd\ne\n", "a\nB2\nc\nd\ne\n");
  assert.equal(r.hunks.length, 1);
  const h = r.hunks[0] as any;
  assert.deepEqual([h.ours, h.theirs].map((x: any) => (Array.isArray(x) ? x.join("\n") : String(x)).trim()), ["B1", "B2"]);
});

test("diffFlat reports added, modified and deleted files", () => {
  const a = new Map([["x", { oid: "1", mode: "100644" }], ["y", { oid: "2", mode: "100644" }]]);
  const b = new Map([["x", { oid: "1", mode: "100644" }], ["y", { oid: "3", mode: "100644" }], ["z", { oid: "4", mode: "100644" }]]);
  assert.deepEqual(diffFlat(a, b), [{ path: "y", status: "modified" }, { path: "z", status: "added" }]);
  assert.deepEqual(diffFlat(b, a).find((f) => f.path === "z"), { path: "z", status: "deleted" });
});

test("unifiedDiff marks added and removed lines", () => {
  const d = unifiedDiff("f.js", "one\ntwo\n", "one\nthree\n");
  assert.match(d, /^-two$/m);
  assert.match(d, /^\+three$/m);
});
