import { test } from "node:test";
import assert from "node:assert/strict";
import { anyOverlap, matches, normalizePattern } from "../src/paths.ts";

test("patterns match files, folders and globs", () => {
  assert.ok(matches("src/db.js", "src/db.js"));
  assert.ok(matches("src/", "src/routes/todos.js"));
  assert.ok(matches("src/**/*.test.ts", "src/a/b/c.test.ts"));
  assert.ok(!matches("src/db.js", "src/db.json"));
});

test("intents overlap when their paths can touch the same file", () => {
  assert.deepEqual(anyOverlap(["src/db.js"], ["src/"]).length > 0, true);
  assert.equal(anyOverlap(["docs/"], ["src/"]).length, 0);
});

test("leading ./ and / are dropped", () => {
  assert.equal(normalizePattern("./src/a.ts"), "src/a.ts");
  assert.equal(normalizePattern("/src/a.ts"), "src/a.ts");
});
