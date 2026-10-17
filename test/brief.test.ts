import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBrief, fileStats, suggestCheck, type BriefInput } from "../src/brief.ts";
import { unifiedDiff } from "../src/gitops.ts";

const base: BriefInput = {
  author: "ada", files: [], undeclared: [], guarded: [], checks: null, checksConfigured: false,
  othersIntents: [], knownBy: {}, authorKnows: [], sentBack: 0, openThreads: 0,
};
const f = (path: string, added = 3, removed = 1) => ({ path, added, removed });

test("a small change with tests, inside its intent, is left to the agents", () => {
  const b = buildBrief({ ...base, files: [f("src/db.js"), f("test/db.test.js")], checks: { ok: true }, checksConfigured: true });
  assert.equal(b.needsPerson, false);
  assert.match(b.verdict, /^Agents can review this/);
});

test("protected paths and failing checks always ask for a person", () => {
  assert.equal(buildBrief({ ...base, files: [f("src/auth.js"), f("test/a.test.js")], guarded: ["src/auth.js"] }).needsPerson, true);
  const failing = buildBrief({ ...base, files: [f("src/db.js"), f("test/a.test.js")], checks: { ok: false } });
  assert.equal(failing.needsPerson, true);
  assert.match(failing.verdict, /checks fail/);
});

test("files are ranked riskiest first, each with the reasons", () => {
  const b = buildBrief({
    ...base, files: [f("README.md"), f("src/db.js"), f("src/api.js")], undeclared: ["src/api.js"],
    othersIntents: [{ paths: ["src/api.js"], agent: "bex" }], knownBy: { "src/db.js": ["cyd"] },
  });
  assert.deepEqual(b.files.map((x) => x.path), ["src/api.js", "src/db.js", "README.md"]);
  assert.deepEqual(b.files[0].flags.map((x) => x.kind), ["outside", "contested"]);
  assert.match(b.files[1].flags[0].text, /first time ada touches it; cyd knows it/);
  assert.ok(b.reasons.some((r) => r.kind === "tests"), "code without tests is called out");
  assert.equal(b.needsPerson, true, `score ${b.score}`);
});

test("an author who already wrote a file isn't new to it", () => {
  const b = buildBrief({ ...base, files: [f("src/db.js")], knownBy: { "src/db.js": ["cyd"] }, authorKnows: ["src/db.js"] });
  assert.deepEqual(b.files[0].flags, []);
});

test("line counts per file come from the patch, including added and deleted files", () => {
  const patch = unifiedDiff("a.js", "one\ntwo\n", "one\nTWO\nthree\n") + unifiedDiff("new.js", null, "x\n") + unifiedDiff("gone.js", "y\nz\n", null);
  assert.deepEqual(fileStats(patch), [{ path: "a.js", added: 2, removed: 1 }, { path: "new.js", added: 1, removed: 0 }, { path: "gone.js", added: 0, removed: 2 }]);
});

test("when main has no tests, a change without tests isn't flagged for it", () => {
  const files = [f("src/a.ts"), f("src/b.ts")];
  assert.ok(buildBrief({ ...base, files }).reasons.some((r) => r.kind === "tests"));
  const b = buildBrief({ ...base, files, mainHasTests: false });
  assert.ok(!b.reasons.some((r) => r.kind === "tests"));
  assert.equal(b.score, 0);
});

test("a check command is suggested only for what the checks image runs as is", async () => {
  const repo = (files: Record<string, string>) => [new Set(Object.keys(files)), async (p: string) => files[p] ?? null] as const;
  assert.equal(await suggestCheck(...repo({ "package.json": '{"scripts":{"test":"node --test"}}', "package-lock.json": "{}" })), "npm ci && npm test");
  assert.equal(await suggestCheck(...repo({ "package.json": '{"scripts":{"test":"vitest"}}' })), "npm install && npm test");
  assert.equal(await suggestCheck(...repo({ "package.json": '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}' })), null);
  assert.equal(await suggestCheck(...repo({ "Makefile": "build:\n\tcc x.c\ntest: build\n\t./t\n" })), "make test");
  assert.equal(await suggestCheck(...repo({ "pyproject.toml": "" })), null);
});
