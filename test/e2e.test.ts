// End to end: the scripted demos against a running Loom. Skipped unless
// LOOM_E2E_URL is set, e.g. with `npm run shim` and `npm run dev` running:
//   LOOM_E2E_URL=http://127.0.0.1:8787 npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const url = process.env.LOOM_E2E_URL;
const run = promisify(execFile);
const env = { ...process.env, LOOM_URL: url, LOOM_ADMIN_TOKEN: process.env.LOOM_ADMIN_TOKEN ?? "dev-admin", PACE: "0" };
const project = (p: string) => `${p}-${Date.now().toString(36).slice(-5)}`;

test("six agents and a reviewer build the todo service; every change lands", { skip: !url, timeout: 300_000 }, async () => {
  const { stdout } = await run("node", ["demo/swarm.mjs", project("e2e-swarm")], { env, maxBuffer: 1 << 24 });
  assert.match(stdout, /All 6 changes merged/);
});

test("a contest is decided by weighted votes, the winner lands and leaves a note", { skip: !url, timeout: 300_000 }, async () => {
  const { stdout } = await run("node", ["demo/contest.mjs", project("e2e-contest")], { env, maxBuffer: 1 << 24 });
  assert.match(stdout, /contest decided: #\d+ wins/);
  assert.match(stdout, /memory: note #\d+ by kai/);
  assert.match(stdout, /Done\. main is v4/);
});

test("updating a change without new context keeps the context it was submitted with", { skip: !url, timeout: 120_000 }, async () => {
  const { Loom } = await import("../demo/client.mjs");
  const { SEED } = await import("../demo/seed.mjs");
  const name = project("e2e-ctx");
  const admin = new Loom(url, name, env.LOOM_ADMIN_TOKEN);
  await admin.createProject({ name, description: "context survives updates", files: SEED, requiredApprovals: 1 });
  const ada = admin.as((await admin.addAgent("ada", "builder")).key);
  const t = await ada.createTask("Trim titles", "");
  const ws = (await ada.claim(t.id)).workspace.name;
  await ada.intent(t.id, ["src/db.js"], "trim");
  await ada.write(ws, { "src/db.js": (await ada.read("src/db.js", ws)) + "\n// v1\n" }, "v1");
  const ch = await ada.submit(t.id, t.title, "Trim", { plan: ["trim in db.js"], tested: ["by hand"] });
  await ada.write(ws, { "src/db.js": (await ada.read("src/db.js", ws)) + "// v2\n" }, "v2");
  await ada.update(ch.id, "Trim, v2");
  let detail = await ada.change(ch.id);
  assert.deepEqual(detail.context.context.plan, ["trim in db.js"]);
  await ada.req("POST", `/changes/${ch.id}/update`, { context: { tested: ["v2 by hand"] } });
  detail = await ada.change(ch.id);
  assert.deepEqual(detail.context.context, { plan: ["trim in db.js"], tested: ["v2 by hand"] });
});

test("the merge queue runs the project's tests: two clean merges that break main together are caught", { skip: !url, timeout: 300_000 }, async () => {
  const { stdout } = await run("node", ["demo/checks.mjs", project("e2e-checks")], { env, maxBuffer: 1 << 24 });
  assert.match(stdout, /fails the tests on main/);
  assert.match(stdout, /does not provide an export named 'greet'/);
  assert.match(stdout, /Done\. main is v2/);
});
