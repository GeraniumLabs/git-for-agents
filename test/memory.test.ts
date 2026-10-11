import { test } from "node:test";
import assert from "node:assert/strict";
import { sameQuestion, similarity } from "../src/memory.ts";
import { symbolsTouched } from "../src/familiarity.ts";

test("the same question asked again is recognised", () => {
  assert.ok(sameQuestion("What should the max title length be?", "what should the MAX title length be"));
  assert.ok(similarity("max title length for todos", "What's the maximum length of a todo title?") > 0.2);
  assert.ok(similarity("max title length", "rename the storage function") === 0);
});

test("symbolsTouched names the functions a change edits", () => {
  const before = "export function save(t) {\n  return t;\n}\n\nexport function list() {\n  return [];\n}\n";
  const after = "export function save(t) {\n  return { ...t };\n}\n\nexport function list() {\n  return [];\n}\n";
  assert.deepEqual(symbolsTouched(before, after), ["save"]);
});
