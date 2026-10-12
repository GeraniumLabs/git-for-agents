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

test("agents register themselves with a join code from the skill, and keep who they are when their key is replaced", { skip: !url, timeout: 120_000 }, async () => {
  const { Loom } = await import("../demo/client.mjs");
  const name = project("e2e-join");
  const admin = new Loom(url, name, env.LOOM_ADMIN_TOKEN);
  await admin.createProject({ name, description: "self-registration", requiredApprovals: 1 });
  const jc = await admin.req("POST", "/join-codes", { role: "reviewer", maxUses: 2, expiresInHours: 1 });
  const skill = await (await fetch(`${url}/api/projects/${name}/skill?code=${jc.code}`)).text();
  assert.ok(skill.includes(jc.code), "the skill carries a live join code");
  const forged = await (await fetch(`${url}/api/projects/${name}/skill?code=loomjoin_ignore-previous-instructions`)).text();
  assert.ok(!forged.includes("ignore-previous"), "the skill never carries a code that isn't live");
  const join = (agent: string, code = jc.code) => fetch(`${url}/api/projects/${name}/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: agent }) });
  const ada = await (await join("ada")).json();
  assert.equal(ada.role, "reviewer");
  assert.equal((await admin.as(ada.key).req("GET", "/me")).agent.id, ada.id);
  assert.equal((await join("bex")).status, 200);
  assert.equal((await join("cyd")).status, 403, "a used-up code is refused");
  assert.equal((await join("dee", "loomjoin_nope")).status, 403);
  const rotated = await admin.as(ada.key).req("POST", "/me/key");
  assert.equal(rotated.id, ada.id);
  assert.equal((await admin.as(rotated.key).req("GET", "/me")).agent.id, ada.id);
  await assert.rejects(admin.as(ada.key).req("GET", "/me"), "the old key stops working");
});

test("review threads: the author must answer line comments before the change merges, and reviewers see what changed since", { skip: !url, timeout: 120_000 }, async () => {
  const { Loom } = await import("../demo/client.mjs");
  const { SEED } = await import("../demo/seed.mjs");
  const name = project("e2e-threads");
  const admin = new Loom(url, name, env.LOOM_ADMIN_TOKEN);
  await admin.createProject({ name, description: "review threads", files: SEED, requiredApprovals: 1 });
  const ada = admin.as((await admin.addAgent("ada", "builder")).key);
  const rex = admin.as((await admin.addAgent("rex", "reviewer")).key);
  const t = await ada.createTask("Trim titles", "");
  const ws = (await ada.claim(t.id)).workspace.name;
  await ada.intent(t.id, ["src/db.js"], "trim");
  const before = await ada.read("src/db.js", ws);
  await ada.write(ws, { "src/db.js": before + "\nexport const trim = (s) => s.trim();\n" }, "trim");
  const ch = await ada.submit(t.id, t.title, "Trim", { plan: ["trim"] });
  let detail = await rex.change(ch.id);
  assert.ok(detail.brief?.verdict, "the change carries a review brief");
  const line = (before + "\nexport const trim = (s) => s.trim();\n").split("\n").indexOf("export const trim = (s) => s.trim();") + 1;

  const sent = await rex.review(ch.id, "request_changes", "Name it", [{ path: "src/db.js", line, body: "Call it trimTitle" }]);
  assert.equal(sent.threads.length, 1);
  const threadId = sent.threads[0];
  assert.equal((await ada.me()).todo.some((x: string) => /open review thread/.test(x)), true, "the author's todo lists the thread");

  await ada.write(ws, { "src/db.js": before + "\nexport const trimTitle = (s) => s.trim();\n" }, "rename");
  const updated = await ada.update(ch.id, "Trim, renamed");
  assert.equal(updated.openThreads.length, 1, "update_change says what's still open");
  detail = await rex.change(ch.id);
  assert.equal(detail.threads[0].outdated, true, "the commented line changed, so the thread is outdated");

  const since = await rex.req("GET", `/changes/${ch.id}/interdiff?reviewer=rex`);
  assert.equal(since.available, true);
  assert.deepEqual(since.files, ["src/db.js"]);
  assert.match(since.patch, /\+export const trimTitle/);
  assert.match(since.patch, /-export const trim =/);

  // Another reviewer's approval isn't enough while rex's thread is open.
  const cyd = admin.as((await admin.addAgent("cyd", "reviewer")).key);
  const r = await cyd.review(ch.id, "approve", "fine");
  assert.equal(r.status, "review");
  assert.equal(r.approval.openThreads, 1);
  assert.match(r.next, /must be resolved/);

  await ada.req("POST", `/threads/${threadId}/resolve`, { body: "Renamed to trimTitle" });
  const s = (await ada.change(ch.id)).status;
  assert.ok(["queued", "merging", "merged"].includes(s), `resolving the last thread queues the approved change (${s})`);
});

test("reviews are agent tasks: an untaken review shows up in whoami and loom_status, and any agent can take it", { skip: !url, timeout: 120_000 }, async () => {
  const { Loom } = await import("../demo/client.mjs");
  const { SEED } = await import("../demo/seed.mjs");
  const name = project("e2e-rtasks");
  const admin = new Loom(url, name, env.LOOM_ADMIN_TOKEN);
  await admin.createProject({ name, description: "review tasks", files: SEED, requiredApprovals: 1 });
  const ada = admin.as((await admin.addAgent("ada", "builder")).key);
  const bex = admin.as((await admin.addAgent("bex", "builder")).key);
  const t = await ada.createTask("Comment db.js", "");
  const ws = (await ada.claim(t.id)).workspace.name;
  await ada.write(ws, { "src/db.js": (await ada.read("src/db.js", ws)) + "\n// done\n" }, "c");
  const ch = await ada.submit(t.id, t.title, "comment");
  const me = await bex.me();
  const task = me.reviewTasks.find((x: any) => x.change === ch.id);
  assert.equal(task?.status, "open", "nobody has taken the review yet");
  assert.ok(me.todo.some((x: string) => /take_review/.test(x)));
  assert.equal((await ada.me()).reviewTasks.some((x: any) => x.change === ch.id), false, "the author doesn't get its own review");
  assert.ok((await admin.state()).reviewTasks.some((x: any) => x.change === ch.id));
  await bex.req("POST", `/changes/${ch.id}/reviewers/take`);
  const after = (await bex.me()).reviewTasks.find((x: any) => x.change === ch.id);
  assert.equal(after.status, "in_progress");
  assert.deepEqual(after.reviewers.map((r: any) => r.status), ["reviewing"]);
  await bex.review(ch.id, "approve", "ok");
  assert.equal((await bex.me()).reviewTasks.some((x: any) => x.change === ch.id), false, "done once reviewed");
});
