import { test } from "node:test";
import assert from "node:assert/strict";
import { contextOf } from "../src/changecontext";

test("a string context becomes notes instead of one key per character", () => {
  assert.deepEqual(contextOf("placeholder"), { notes: "placeholder" });
  assert.deepEqual({ ...contextOf("ab"), ...contextOf({ plan: "x" }) }, { notes: "ab", plan: "x" });
});

test("objects pass through; empty values become empty", () => {
  assert.deepEqual(contextOf({ plan: ["a"] }), { plan: ["a"] });
  assert.deepEqual(contextOf(undefined), {});
  assert.deepEqual(contextOf("  "), {});
});
