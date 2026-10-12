import { test } from "node:test";
import assert from "node:assert/strict";
import { FilesShapeError, normalizeFiles } from "../src/files.ts";

test("a path-to-contents map passes through", () => {
  assert.deepEqual(normalizeFiles({ "/src/a.ts": "a", "old.txt": null }), { "src/a.ts": "a", "old.txt": null });
});

test("a list of {path, content} objects becomes a map", () => {
  assert.deepEqual(
    normalizeFiles([{ path: "package.json", content: "{}" }, { path: "src/x.css", contents: "x" }, { path: "gone.txt", delete: true }]),
    { "package.json": "{}", "src/x.css": "x", "gone.txt": null },
  );
});

test("a list serialised as an object or as a JSON string is read as a list", () => {
  assert.deepEqual(normalizeFiles({ 0: { path: "a", content: "1" }, 1: { path: "b", content: "2" } }), { a: "1", b: "2" });
  assert.deepEqual(normalizeFiles(JSON.stringify([{ path: "a", content: "1" }])), { a: "1" });
});

test("non-string contents are rejected, never written as [object Object]", () => {
  assert.throws(() => normalizeFiles({ "a.ts": { content: "x" } }), FilesShapeError);
  assert.throws(() => normalizeFiles({ "a.ts": 5 }), /must be a string or null/);
  assert.throws(() => normalizeFiles([{ content: "x" }]), /has no path/);
  assert.throws(() => normalizeFiles([{ path: "a" }]), /has no content/);
  assert.throws(() => normalizeFiles([]), /empty/);
  assert.throws(() => normalizeFiles(undefined), /required/);
});
