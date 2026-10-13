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

test("a review no other agent can take is stuck right away, and stops being stuck once someone could take it", { skip: !url, timeout: 120_000 }, async () => {
  const { Loom } = await import("../demo/client.mjs");
  const { SEED } = await import("../demo/seed.mjs");
  const name = project("e2e-rstuck");
  const admin = new Loom(url, name, env.LOOM_ADMIN_TOKEN);
  await admin.createProject({ name, description: "lonely review", files: SEED, requiredApprovals: 1 });
  const ada = admin.as((await admin.addAgent("ada", "builder")).key);
  const t = await ada.createTask("Comment db.js", "");
  const ws = (await ada.claim(t.id)).workspace.name;
  await ada.write(ws, { "src/db.js": (await ada.read("src/db.js", ws)) + "\n// done\n" }, "c");
  const ch = await ada.submit(t.id, t.title, "comment");
  const stuck = async () => (await admin.req("GET", "/overview")).attention.filter((i: any) => i.kind === "stuck" && i.change === ch.id);
  const alone = await stuck();
  assert.equal(alone.length, 1, "the only agent is the author, so nobody can take the review");
  assert.equal(alone[0].reason, "no other agent to review it");
  assert.equal(alone[0].action, "review");
  await admin.addAgent("bex", "builder");
  assert.deepEqual(await stuck(), [], "bex could take it, so it isn't stuck yet");
});

test("questions for people: similar ones share a card, each agent has a limit, and a default wins when nobody answers in time", { skip: !url, timeout: 150_000 }, async () => {
  const { Loom, sleep } = await import("../demo/client.mjs");
  const name = project("e2e-questions");
  const admin = new Loom(url, name, env.LOOM_ADMIN_TOKEN);
  await admin.createProject({ name, description: "questions for people", requiredApprovals: 1 });
  const rules = await admin.req("POST", "/settings", { questions: { maxOpen: 2, deadlineMinutes: 1 } });
  assert.deepEqual(rules.questions, { maxOpen: 2, deadlineMinutes: 1 });
  await assert.rejects(admin.req("POST", "/settings", { questions: { deadlineMinutes: 0 } }));
  const ada = admin.as((await admin.addAgent("ada")).key);
  const bex = admin.as((await admin.addAgent("bex")).key);
  const ask = (who: any, body: string, extra = {}) => who.req("POST", "/threads", { kind: "question", to: "humans", body, ...extra });

  const q1 = await ask(ada, "Should we use SQLite or Postgres for the todo store?", { default: "Use SQLite" });
  await ask(bex, "Which database should the todo store use: SQLite or Postgres?");
  await ask(ada, "Can I add a dependency on lodash?");
  await assert.rejects(ask(ada, "Can I add a dependency on dayjs?"), /open questions/, "a third open question is refused");
  assert.equal((await ada.req("GET", "/me")).questions.open, 2);

  const cards = (await admin.req("GET", "/overview")).attention.filter((i: any) => i.kind === "question");
  assert.equal(cards.length, 2, "the two database questions share one card");
  const db = cards.find((c: any) => c.threads.length === 2);
  assert.ok(db, "one card answers both agents");
  assert.equal(db.default, "Use SQLite");

  // Nobody answers: after the deadline ada goes ahead with its default.
  let t: any;
  for (let i = 0; i < 100 && t?.status !== "answered"; i++) { await sleep(1000); t = await admin.req("GET", `/threads/${q1.id}`); }
  assert.equal(t.status, "answered");
  assert.match(t.posts.at(-1).body, /goes ahead with its default: Use SQLite/);
  const answered = (await ada.req("GET", "/me")).inbox.find((e: any) => e.type === "question.answered");
  assert.equal(answered.data.defaulted, true);
  assert.equal((await ada.req("GET", "/me")).questions.open, 1, "an answered question frees a slot");
  assert.ok((await admin.req("GET", "/overview")).health.people.defaultedLastHour >= 1);
});

test("decision model options: off by default, owners turn them on, and without a model reviews still route", { skip: !url, timeout: 120_000 }, async () => {
  const { Loom } = await import("../demo/client.mjs");
  const { SEED } = await import("../demo/seed.mjs");
  const name = project("e2e-model");
  const admin = new Loom(url, name, env.LOOM_ADMIN_TOKEN);
  await admin.createProject({ name, description: "model options", files: SEED, requiredApprovals: 1 });
  assert.deepEqual((await admin.req("GET", "/overview")).project.model, { reviewers: false, intent: false });
  const on = await admin.req("POST", "/settings", { model: { reviewers: true, intent: true, other: true } });
  assert.deepEqual(on.model, { reviewers: true, intent: true });
  assert.deepEqual((await admin.req("POST", "/settings", { model: { intent: false } })).model, { reviewers: true, intent: false });
  await admin.req("POST", "/settings", { model: { intent: true } });

  const ada = admin.as((await admin.addAgent("ada", "builder")).key);
  await admin.addAgent("rex", "reviewer");
  const t = await ada.createTask("Comment db.js", "");
  const ws = (await ada.claim(t.id)).workspace.name;
  await ada.req("POST", "/intents", { taskId: t.id, paths: ["src/db.js"], description: "add a comment" });
  await ada.write(ws, { "src/db.js": (await ada.read("src/db.js", ws)) + "\n// done\n" }, "c");
  const ch = await ada.submit(t.id, t.title, "comment");
  const asked = await ada.req("POST", `/changes/${ch.id}/reviewers`, { count: 1 });
  assert.equal(asked.requested.length, 1, "the familiarity ranking still picks a reviewer");
  const detail = await admin.req("GET", `/changes/${ch.id}`);
  assert.equal(detail.intent_check, null, "no model here, so no intent judgment");
});

test("stand-ins: a person's own agent watches what needs them, hears by webhook, and acts only within the rights it was given", { skip: !url, timeout: 120_000 }, async () => {
  const { Loom, sleep } = await import("../demo/client.mjs");
  const { createServer } = await import("node:http");
  const { createHmac } = await import("node:crypto");
  const name = project("e2e-standin");
  const admin = new Loom(url, name, env.LOOM_ADMIN_TOKEN);
  await admin.createProject({ name, description: "stand-ins", requiredApprovals: 1 });
  await admin.req("POST", "/members", { login: "jo" });

  const got: { body: string; sig: string }[] = [];
  const server = createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { got.push({ body: b, sig: String(req.headers["x-loom-signature"] ?? "") }); res.end("ok"); }); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  try {
    await assert.rejects(admin.req("POST", "/standins", { for: "jo", name: "x", scopes: ["everything"] }), /unknown scope/);
    const si = await admin.req("POST", "/standins", { for: "jo", name: "jo-assistant", scopes: ["answer"], webhook: `http://127.0.0.1:${port}/hook` });
    assert.ok(si.key.startsWith("loomstand_") && si.webhookSecret, "key and secret are shown once");
    const watcher = await admin.req("POST", "/standins", { for: "jo", name: "jo-pager", scopes: [] });
    const helper = admin.as(si.key), pager = admin.as(watcher.key);

    const info = await helper.req("GET", "/standins/me");
    assert.equal(info.actsFor.name, "jo");
    assert.deepEqual(Object.keys(info.can), ["answer"]);
    const first = await pager.req("GET", "/attention");
    assert.equal(first.items.length, 0);

    // The feed holds until something needs a person.
    const ada = admin.as((await admin.addAgent("ada")).key);
    const waiting = pager.req("GET", `/attention?known=${first.known}&wait=20`);
    await sleep(500);
    const q = await ada.req("POST", "/threads", { kind: "question", to: "humans", body: "May I rename the todos table?", default: "Keep the name" });
    const feed = await waiting;
    const item = feed.items.find((i: any) => i.kind === "question");
    assert.ok(item?.new, "the question arrives as new");
    assert.match(item.text, /ada asks: May I rename the todos table\?/);
    assert.deepEqual(item.youCan, { scope: "answer", allowed: false }, "the watch-only key can't answer");
    assert.equal((await helper.req("GET", "/attention")).items[0].youCan.allowed, true);

    // The webhook hears about it once, signed.
    for (let i = 0; i < 40 && !got.length; i++) await sleep(250);
    assert.equal(got.length, 1);
    assert.equal(got[0].sig, `sha256=${createHmac("sha256", si.webhookSecret).update(got[0].body).digest("hex")}`);
    assert.equal(JSON.parse(got[0].body).items[0].key, item.key);

    // Rights: watching can't answer; answering can't review, freeze or touch settings.
    await assert.rejects(pager.req("POST", "/questions/answer", { threads: [q.id], body: "no" }), /"answer" right/);
    await assert.rejects(helper.req("POST", "/freeze", { reason: "x" }), /"freeze" right/);
    await assert.rejects(helper.req("POST", "/settings", { requiredApprovals: 0 }), /stand-in key can't/);
    await assert.rejects(helper.req("POST", "/standins", { name: "y", scopes: ["freeze"] }), /stand-in key can't/);
    await helper.req("POST", "/questions/answer", { threads: [q.id], body: "Yes, rename it to tasks" });
    const t = await admin.req("GET", `/threads/${q.id}`);
    assert.equal(t.status, "answered");
    const acted = (await admin.req("GET", "/events?after=0")).events.find((e: any) => e.type === "standin.acted");
    assert.equal(acted.data.name, "jo-assistant");
    assert.match(acted.data.action, /POST \/questions\/answer/);

    await admin.req("DELETE", `/standins/${si.id}`);
    await assert.rejects(helper.req("GET", "/attention"), /401/);
  } finally {
    server.close();
  }
});

test("a plain git push to a workspace updates its change, through Artifacts push events", { skip: !url, timeout: 120_000 }, async () => {
  const { Loom, sleep } = await import("../demo/client.mjs");
  const name = project("e2e-push");
  const admin = new Loom(url, name, env.LOOM_ADMIN_TOKEN);
  await admin.createProject({ name, description: "push events", requiredApprovals: 1 });
  const ada = admin.as((await admin.addAgent("ada", "builder")).key);
  const t = await ada.createTask("Say hello", "");
  const claim = await ada.claim(t.id);
  await ada.intent(t.id, ["hello.txt"], "hello");
  await ada.write(claim.workspace.name, { "hello.txt": "hello\n" }, "v1");
  const ch = await ada.submit(t.id, t.title, "hello", {});

  // A real git client, as an agent with a shell would push.
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(`${tmpdir()}/loom-push-`);
  const git = (...a: string[]) => run("git", ["-c", `http.extraHeader=Authorization: Bearer ${claim.workspace.token}`, "-c", "user.name=ada", "-c", "user.email=ada@example.com", ...a], { cwd: dir });
  await git("clone", claim.workspace.remote, ".");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(`${dir}/hello.txt`, "hello, world\n");
  await git("commit", "-am", "v2");
  await git("push", "origin", "HEAD:main");
  const head = (await git("rev-parse", "HEAD")).stdout.trim();

  let detail: any;
  for (let i = 0; i < 40; i++) {
    detail = await ada.change(ch.id);
    if (detail.head === head) break;
    await sleep(250);
  }
  assert.equal(detail.head, head, "the change follows the push");
  const events = (await admin.req("GET", "/events?after=0")).events;
  assert.ok(events.some((e: any) => e.type === "workspace.pushed" && e.data.head === head));
  assert.ok(events.some((e: any) => e.type === "change.updated" && e.data.via === "push"));
  // Loom's own commit (v1, over the API) was not announced as a push.
  assert.equal(events.filter((e: any) => e.type === "workspace.pushed").length, 1);
});

test("a project created in the EU says so, and its name can't be reused elsewhere", { skip: !url, timeout: 120_000 }, async () => {
  const { Loom } = await import("../demo/client.mjs");
  const name = project("e2e-eu");
  const admin = new Loom(url, name, env.LOOM_ADMIN_TOKEN);
  await assert.rejects(admin.createProject({ name, jurisdiction: "mars" }), /400/);
  await admin.createProject({ name, description: "kept in the EU", jurisdiction: "eu", requiredApprovals: 0 });
  assert.equal((await admin.state()).project.jurisdiction, "eu");
  assert.equal((await admin.req("GET", "/api/projects")).find((p: any) => p.name === name)?.jurisdiction, "eu");
  await assert.rejects(admin.createProject({ name }), /409/);

  // The whole loop works there: claim, commit, submit, merge.
  const ada = admin.as((await admin.addAgent("ada", "builder")).key);
  const t = await ada.createTask("Add a file", "");
  const ws = (await ada.claim(t.id)).workspace.name;
  await ada.write(ws, { "eu.txt": "bonjour\n" }, "add");
  const ch = await ada.submit(t.id, t.title, "add a file", {});
  for (let i = 0; i < 40 && (await ada.change(ch.id)).status !== "merged"; i++) await new Promise((r) => setTimeout(r, 250));
  assert.equal((await ada.change(ch.id)).status, "merged");
  assert.equal(await admin.read("eu.txt"), "bonjour\n");
});
