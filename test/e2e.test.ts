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
  assert.ok(skill.includes(`~/.config/loom/${name}/$LOOM_NAME.key`), "each agent keeps its key in its own file, so agents on one machine don't share one");
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

test("sub-agents sharing one key each get their own identity, grouped under the key", { skip: !url, timeout: 120_000 }, async () => {
  const { Loom } = await import("../demo/client.mjs");
  const name = project("e2e-subagents");
  const admin = new Loom(url, name, env.LOOM_ADMIN_TOKEN);
  await admin.createProject({ name, description: "one key, many agents", requiredApprovals: 1 });
  const key = await admin.addAgent("builders", "builder");
  // Sub-agents share one MCP connection, so each names itself on every call.
  const mcp = async (tool: string, args: Record<string, unknown> = {}, headers: Record<string, string> = {}) => {
    const res = await fetch(`${url}/mcp/${name}`, { method: "POST", headers: { authorization: `Bearer ${key.key}`, "content-type": "application/json", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }) });
    const r = (await res.json()).result;
    if (r.isError) throw new Error(r.content[0].text);
    return JSON.parse(r.content[0].text);
  };
  const list = await (await fetch(`${url}/mcp/${name}`, { method: "POST", headers: { authorization: `Bearer ${key.key}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).json();
  assert.ok(list.result.tools.every((t: any) => t.inputSchema.properties.as), "every tool takes as");

  const lead = await mcp("whoami");
  assert.equal(lead.agent.id, key.id, "without a name the key is its own agent");
  const ui = await mcp("whoami", { as: "builder-ui" });
  const api = await mcp("whoami", { as: "builder-api" });
  assert.notEqual(ui.agent.id, key.id);
  assert.notEqual(ui.agent.id, api.agent.id);
  assert.equal(ui.agent.under.id, key.id);
  assert.equal((await mcp("whoami", { as: "Builder-UI" })).agent.id, ui.agent.id, "the same name is the same agent");
  assert.equal((await mcp("whoami", {}, { "x-loom-agent": "builder-api" })).agent.id, api.agent.id, "or name it once per connection");
  assert.equal((await admin.as(key.key).req("GET", "/me", undefined)).agent.id, key.id);

  const t1 = await mcp("create_task", { title: "Calendar view", as: "builder-ui" });
  const t2 = await mcp("create_task", { title: "Events API", as: "builder-api" });
  const ws1 = (await mcp("claim_task", { taskId: t1.id, as: "builder-ui" })).workspace.name;
  await mcp("claim_task", { taskId: t2.id, as: "builder-api" });
  await assert.rejects(mcp("write_files", { workspace: ws1, files: { "x.txt": "x" }, message: "x", as: "builder-api" }), /belongs to builder-ui/, "siblings don't share workspaces");

  const profile = await admin.req("GET", `/agents/${key.id}`);
  assert.deepEqual(profile.underKey.map((a: any) => a.name).sort(), ["builder-api", "builder-ui"]);
  assert.equal((await admin.req("GET", "/search?state=working&limit=50")).agents.length, 2, "two agents at work, not one");
  // The Steer dropdown lists present agents, sub-agents included, and can aim a directive at one.
  const present = (await admin.req("GET", "/search?state=present&limit=200")).agents;
  for (const n of ["builder-api", "builder-ui"]) assert.equal(present.find((a: any) => a.name === n)?.under?.id, key.id, `${n} is listed under its key`);
  assert.ok(present.every((a: any) => a.state !== "human"), "people aren't directive targets");
  const uiRow = present.find((a: any) => a.name === "builder-ui");
  assert.equal((await admin.req("POST", "/directives", { to: uiRow.id, body: "UI only" })).awaitingAck, 1, "a directive to one sub-agent goes to it alone");

  await admin.req("POST", `/agents/${key.id}/pause`, { reason: "hold on" });
  await assert.rejects(mcp("create_task", { title: "more", as: "builder-ui" }), /paused/, "pausing the key pauses everyone under it");
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

test("filing a task for someone: people assign, agents file open tasks, a person hears it under Needs a person", { skip: !url, timeout: 120_000 }, async () => {
  const { Loom } = await import("../demo/client.mjs");
  const name = project("e2e-file");
  const admin = new Loom(url, name, env.LOOM_ADMIN_TOKEN);
  await admin.createProject({ name, description: "issues", requiredApprovals: 1 });
  await admin.req("POST", "/members", { login: "jo" });
  const ada = admin.as((await admin.addAgent("ada")).key);
  const kai = admin.as((await admin.addAgent("kai")).key);

  // Agents file open tasks; only people choose who works on what.
  await assert.rejects(ada.req("POST", "/tasks", { title: "Fix the crash", assignee: "kai" }), /only people assign/);
  const open = await ada.req("POST", "/tasks", { title: "Fix the crash", description: "Steps: ..." });
  assert.equal(open.assignee, null);
  await assert.rejects(admin.req("POST", "/tasks", { title: "x", assignee: "nobody-here" }), /nobody called/);

  // Given to an agent: its todo says to claim it, and nobody else can take it.
  const forKai = await admin.req("POST", "/tasks", { title: "Handle empty titles", assignee: "kai" });
  assert.equal(forKai.assignee, (await kai.req("GET", "/me")).agent.id);
  assert.ok((await kai.req("GET", "/me")).todo.some((t: string) => t.includes(`#${forKai.id}`) && /assigned to you: claim_task/.test(t)));
  await assert.rejects(ada.req("POST", `/tasks/${forKai.id}/claim`), /assigned to kai/);

  // Given to a person: it waits under Needs a person, with a link to the task.
  const forJo = await admin.req("POST", "/tasks", { title: "Decide the export format", assignee: "jo" });
  const feed = await admin.req("GET", "/attention");
  const item = feed.items.find((i: any) => i.kind === "task");
  assert.equal(item.detail.task, forJo.id);
  assert.match(item.text, /gave jo task #\d+ "Decide the export format"/);
  assert.match(item.url, new RegExp(`#task/${forJo.id}$`));

  // Back on the board, any agent can take it, and the item goes away.
  await admin.req("POST", `/tasks/${forJo.id}/assign`, { agent: null });
  assert.ok(!(await admin.req("GET", "/attention")).items.some((i: any) => i.kind === "task"));
  await ada.req("POST", `/tasks/${forJo.id}/claim`);
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

test("agents attach files to a change; they show on the change and task, and stay private in a private project", { skip: !url, timeout: 120_000 }, async () => {
  const { Loom } = await import("../demo/client.mjs");
  const { SEED } = await import("../demo/seed.mjs");
  const name = project("e2e-attach");
  const admin = new Loom(url, name, env.LOOM_ADMIN_TOKEN);
  await admin.createProject({ name, description: "attachments", files: SEED, requiredApprovals: 1 });
  const ada = admin.as((await admin.addAgent("ada", "builder")).key);
  const t = await ada.createTask("Restyle", "");
  const ws = (await ada.claim(t.id)).workspace.name;
  await ada.write(ws, { "src/db.js": (await ada.read("src/db.js", ws)) + "\n// v1\n" }, "v1");
  const ch = await ada.submit(t.id, t.title, "Restyle", {});
  const base = `${url}/api/projects/${name}`;
  const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  const shot = await (await fetch(`${base}/attachments?name=after.png&change=${ch.id}`, { method: "POST", headers: { authorization: `Bearer ${ada.key}`, "content-type": "image/png" }, body: bytes })).json();
  assert.equal(shot.kind, "image");
  const log = await ada.req("POST", "/attachments", { name: "test.log", text: "ok\n", task: t.id });
  assert.equal(log.task, t.id);
  const page = await fetch(`${base}/attachments/${shot.id}/raw`);
  assert.equal(page.headers.get("content-type"), "image/png");
  assert.deepEqual(new Uint8Array(await page.arrayBuffer()), bytes);
  assert.deepEqual((await ada.change(ch.id)).attachments.map((a: any) => a.name), ["after.png"]);
  assert.deepEqual((await (await fetch(`${base}/tasks/${t.id}`)).json()).attachments.map((a: any) => a.name), ["test.log", "after.png"]);
  const html = await ada.req("POST", "/attachments", { name: "report.html", text: "<script>alert(1)</script>" });
  assert.match((await fetch(`${base}/attachments/${html.id}/raw`)).headers.get("content-disposition")!, /^attachment/);
  await admin.req("POST", "/settings", { visibility: "private" });
  assert.equal((await fetch(`${base}/attachments/${shot.id}/raw`)).status, 404);
  assert.equal((await fetch(`${base}/attachments/${shot.id}/raw?key=${ada.key}`)).status, 200);
});

test("a directive reaches busy agents on every call until they acknowledge it, and people see who hasn't", { skip: !url, timeout: 120_000 }, async () => {
  const { Loom } = await import("../demo/client.mjs");
  const name = project("e2e-directive");
  const admin = new Loom(url, name, env.LOOM_ADMIN_TOKEN);
  await admin.createProject({ name, description: "directives", requiredApprovals: 1 });
  const ada = await admin.addAgent("ada", "builder");
  const bo = await admin.addAgent("bo", "builder");
  const mcp = async (key: string, tool: string, args: Record<string, unknown> = {}) => {
    const res = await fetch(`${url}/mcp/${name}`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }) });
    return (await res.json()).result.content.map((c: any) => c.text) as string[];
  };
  assert.equal((await mcp(ada.key, "list_files")).length, 1, "no notice before a directive");
  const sent = await admin.req("POST", "/directives", { body: "Don't add new dependencies" });
  assert.equal(sent.awaitingAck, 2);
  // Whatever a busy agent calls, the directive comes first.
  const out = await mcp(ada.key, "list_files");
  assert.match(out[0], /NEW DIRECTIVE/);
  assert.match(out[0], /Don't add new dependencies/);
  const me = await admin.as(ada.key).req("GET", "/me");
  assert.match(me.todo[0], /Directive #\d+ .*ack_directive/);
  assert.equal(me.directives[0].seq, sent.seq);
  // Plain HTTP carries it in a header.
  const raw = await fetch(`${url}/api/projects/${name}/files`, { headers: { authorization: `Bearer ${bo.key}` } });
  assert.equal(JSON.parse(decodeURIComponent(raw.headers.get("x-loom-directives")!))[0].seq, sent.seq);

  const ack = await mcp(ada.key, "ack_directive", { seq: sent.seq, note: "no new deps" });
  assert.doesNotMatch(ack[0], /NEW DIRECTIVE/);
  assert.deepEqual(JSON.parse(ack[0]).acked, [sent.seq]);
  assert.equal((await mcp(ada.key, "list_files")).length, 1, "the notice stops once acknowledged");
  assert.equal((await admin.as(ada.key).req("GET", "/me")).directives.length, 0);
  const acks = await admin.req("GET", `/directives/${sent.seq}/acks`);
  assert.deepEqual(acks.map((a: any) => [a.name, a.acked]).sort(), [["ada", true], ["bo", false]]);
  // A directive to one agent isn't the others'.
  const solo = await admin.req("POST", "/directives", { to: bo.id, body: "Pause the refactor" });
  await assert.rejects(admin.as(ada.key).req("POST", `/directives/${solo.seq}/ack`, {}), /wasn't sent to you/);
  assert.deepEqual((await admin.as(bo.key).req("POST", "/directives/ack", {})).acked, [sent.seq, solo.seq], "no seq acknowledges all");
});

test("an intent declared without its task still counts for that task's change", { skip: !url, timeout: 120_000 }, async () => {
  const { Loom } = await import("../demo/client.mjs");
  const { SEED } = await import("../demo/seed.mjs");
  const name = project("e2e-intent");
  const admin = new Loom(url, name, env.LOOM_ADMIN_TOKEN);
  await admin.createProject({ name, description: "intents find their task", files: SEED, requiredApprovals: 1 });
  const ada = admin.as((await admin.addAgent("ada", "builder")).key);
  // Declared before claiming: no task yet, so the change adopts it.
  const early = await ada.req("POST", "/intents", { paths: ["src/db.js"], description: "trim titles" });
  const t1 = await ada.createTask("Trim titles", "");
  const ws1 = (await ada.claim(t1.id)).workspace.name;
  await ada.write(ws1, { "src/db.js": (await ada.read("src/db.js", ws1)) + "\n// trim\n" }, "trim");
  const ch1 = await ada.submit(t1.id, t1.title, "Trim", {});
  assert.deepEqual((await ada.change(ch1.id)).undeclared, []);
  assert.deepEqual((await ada.req("GET", `/tasks/${t1.id}`)).intents.map((i: any) => i.id), [early.intent]);
  // Holding two tasks, the agent must say which; task_id counts as taskId.
  const t2 = await ada.createTask("Docs", "");
  await ada.claim(t2.id);
  await assert.rejects(ada.req("POST", "/intents", { paths: ["README.md"] }), /pass taskId: you \(ada\) hold 2 tasks/);
  const snake = await ada.req("POST", "/intents", { task_id: t2.id, paths: ["README.md"] });
  assert.deepEqual((await ada.req("GET", `/tasks/${t2.id}`)).intents.map((i: any) => i.id), [snake.intent]);
});

test("contest attempts don't flag each other for a person; flagged attempts are one card to pick from", { skip: !url, timeout: 120_000 }, async () => {
  const { Loom } = await import("../demo/client.mjs");
  const { SEED } = await import("../demo/seed.mjs");
  const name = project("e2e-contest-card");
  const admin = new Loom(url, name, env.LOOM_ADMIN_TOKEN);
  await admin.createProject({ name, description: "contest attempts in Needs a person", files: SEED, requiredApprovals: 1 });
  const files = ["src/db.js", "src/routes/todos.js", "src/server.js"];
  const contest = await admin.req("POST", "/tasks", { title: "Log every request", description: "", attempts: 3 });
  const changes: number[] = [];
  for (const who of ["kai", "lou", "mo"]) {
    const a = admin.as((await admin.addAgent(who, "builder")).key);
    const claim = await a.claim(contest.id);
    const ws = claim.workspace.name;
    await a.intent(claim.task.id, files, "log requests");
    const edits: Record<string, string> = {};
    for (const f of files) edits[f] = (await a.read(f, ws)) + `\n// ${who}\n`;
    await a.write(ws, edits, who);
    await assert.rejects(a.submit(claim.task.id, `Logging by ${who}`, "log"), /explain your approach/, "an attempt has to say how it works");
    await assert.rejects(a.submit(claim.task.id, `Logging by ${who}`, "log", { approach: "x ".repeat(200) }), /two or three plain sentences/, "an approach is short enough to read at a glance");
    changes.push((await a.submit(claim.task.id, `Logging by ${who}`, "log", { approach: `${who} logs each request with a one-line comment in every file it touches.` })).id);
  }
  const view = await admin.req("GET", `/contests/${contest.id}`);
  assert.ok(view.attempts.every((a: any) => /logs each request/.test(a.change.approach)), "the comparison leads with each attempt's approach");
  const reasons = async (id: number) => (await admin.change(id)).brief.reasons.map((r: any) => r.kind);
  for (const id of changes) assert.ok(!(await reasons(id)).includes("contested"), "sibling attempts aren't other agents on the same files");
  const needs = async () => (await admin.req("GET", "/overview")).attention;
  let attention = await needs();
  assert.ok(!attention.some((i: any) => i.kind === "contest" || i.kind === "brief"), "nothing for a person from the attempts alone");
  // An agent outside the contest on the same files does flag them: one card, the decision is which attempt lands.
  const zed = admin.as((await admin.addAgent("zed", "builder")).key);
  const other = await zed.createTask("Rename routes", "");
  await zed.claim(other.id);
  await zed.intent(other.id, files, "rename");
  attention = await needs();
  const card = attention.find((i: any) => i.kind === "contest");
  assert.equal(card?.contest, contest.id);
  assert.deepEqual(card.changes.map((x: any) => x.change).sort(), [...changes].sort());
  assert.ok(!attention.some((i: any) => i.kind === "brief" && changes.includes(i.change)), "no separate review card per attempt");
});

test("a project imported from a git URL keeps its history, lands its branch as main, and work merges on top", { skip: !url, timeout: 120_000 }, async () => {
  const { Loom } = await import("../demo/client.mjs");
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const shim = process.env.LOOM_E2E_SHIM ?? "http://127.0.0.1:8790";
  // The source: a private repository on another git server (the shim), with history on a branch called trunk.
  const srcName = project("e2e-src");
  const src = await fetch(`${shim}/repos`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: srcName }) }).then((r) => r.json());
  const token = String(src.token).split("?expires=")[0];
  const dir = await mkdtemp(join(tmpdir(), "loom-src-"));
  const g = (...args: string[]) => run("git", ["-C", dir, "-c", "user.name=ann", "-c", "user.email=ann@example.com", ...args]);
  await g("init", "-q", "-b", "trunk");
  await run("sh", ["-c", `printf 'one\\n' > ${dir}/notes.txt`]);
  await g("add", ".");
  await g("commit", "-qm", "first");
  await run("sh", ["-c", `printf 'two\\n' >> ${dir}/notes.txt`]);
  await g("commit", "-qam", "second");
  // main stays one commit behind, so importing trunk is visibly a choice of branch.
  await g("push", "-q", src.remote.replace("://", `://x:${token}@`), "trunk:trunk", "trunk~1:refs/heads/main");

  const name = project("e2e-import");
  const admin = new Loom(url, name, env.LOOM_ADMIN_TOKEN);
  await assert.rejects(admin.createProject({ name, import: { url: src.remote, branch: "trunk" } }), /needs a token/, "a private source without a token says so");
  const made = await admin.createProject({ name, import: { url: src.remote, branch: "trunk", token } });
  assert.deepEqual(made.importedFrom, { url: src.remote, branch: "trunk" });
  const history = await admin.req("GET", "/commits");
  assert.deepEqual(history.commits.map((c: any) => c.message), ["second", "first"], "the history came along");

  const ada = admin.as((await admin.addAgent("ada", "builder")).key);
  const t = await ada.createTask("Add a third line", "");
  const ws = (await ada.claim(t.id)).workspace.name;
  await ada.intent(t.id, ["notes.txt"], "append");
  await ada.write(ws, { "notes.txt": (await ada.read("notes.txt", ws)) + "three\n" }, "third");
  const ch = await ada.submit(t.id, "Third line", "append a line", { plan: ["append"], tested: ["read it back"] });
  await admin.review(ch.id, "approve", "ok");
  for (let i = 0; i < 60 && (await admin.change(ch.id)).status !== "merged"; i++) await new Promise((r) => setTimeout(r, 500));
  assert.equal((await admin.change(ch.id)).status, "merged");
  assert.equal(await admin.read("notes.txt"), "one\ntwo\nthree\n");
});

test("a merge whose base is older than the history a workspace fetches still finds it", { skip: !url, timeout: 120_000 }, async () => {
  const { Workspace, HISTORY } = await import("../src/gitops.ts");
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const shim = process.env.LOOM_E2E_SHIM ?? "http://127.0.0.1:8790";
  const repo = await fetch(`${shim}/repos`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: project("e2e-deep") }) }).then((r) => r.json());
  const dir = await mkdtemp(join(tmpdir(), "loom-deep-"));
  const g = (...args: string[]) => run("git", ["-C", dir, "-c", "user.name=ann", "-c", "user.email=ann@example.com", ...args], { maxBuffer: 1 << 24 });
  await g("init", "-q", "-b", "main");
  await writeFile(join(dir, "log.txt"), "0\n");
  await writeFile(join(dir, "other.txt"), "x\n");
  await g("add", ".");
  await g("commit", "-qm", "c0");
  await g("branch", "old");
  // main moves on by more than a workspace fetches.
  for (let i = 1; i <= HISTORY + 30; i++) await g("commit", "-q", "--allow-empty", "-m", `c${i}`);
  await g("checkout", "-q", "old");
  await writeFile(join(dir, "other.txt"), "y\n");
  await g("commit", "-qam", "edit other");
  const remote = repo.remote.replace("://", `://x:${String(repo.token).split("?expires=")[0]}@`);
  await g("push", "-q", remote, "main", "old");
  const w = await Workspace.open({ url: repo.remote, token: repo.token });
  const main = (await w.head())!;
  const old = await w.fetchFrom("ws", { url: repo.remote, token: repo.token }, "old");
  const merged = await w.merge(main, old);
  assert.ok(merged.base, "the merge base was found by fetching further back");
  assert.deepEqual(merged.conflicts, [], "a clean merge, not an add/add conflict from a missing base");
});

test("an owner deletes a project: its repositories, attachments and listing go, and the name can be used again", { skip: !url, timeout: 120_000 }, async () => {
  const { Loom } = await import("../demo/client.mjs");
  const { SEED } = await import("../demo/seed.mjs");
  const shim = process.env.LOOM_E2E_SHIM ?? "http://127.0.0.1:8790";
  const name = project("e2e-delete");
  const admin = new Loom(url, name, env.LOOM_ADMIN_TOKEN);
  await admin.createProject({ name, description: "to be deleted", files: SEED, requiredApprovals: 1 });
  const ada = admin.as((await admin.addAgent("ada", "builder")).key);
  const t = await ada.createTask("Restyle", "");
  const ws = (await ada.claim(t.id)).workspace.name;
  await ada.write(ws, { "src/db.js": (await ada.read("src/db.js", ws)) + "\n// v1\n" }, "v1");
  const ch = await ada.submit(t.id, t.title, "Restyle", {});
  const shot = await ada.req("POST", "/attachments", { name: "test.log", text: "ok\n", change: ch.id });
  const repos = async () => (await (await fetch(`${shim}/repos`)).json()).repos.map((r: any) => r.name).filter((r: string) => r === name || r.startsWith(`${name}-`));
  assert.equal((await repos()).length, 2, "main and ada's workspace");

  await assert.rejects(ada.req("DELETE", `/api/projects/${name}?confirm=${name}`), /403/, "an agent can't delete it");
  await assert.rejects(admin.req("DELETE", `/api/projects/${name}?confirm=nope`), /400.*confirm/, "the name has to be typed back");
  await assert.rejects(admin.req("DELETE", `/api/projects/${name}/project?confirm=${name}`), /404/, "only through DELETE /api/projects/<name>");
  assert.equal((await fetch(`${url}/api/projects/${name}/attachments/${shot.id}/raw`)).status, 200, "still there after the refusals");

  const gone = await admin.req("DELETE", `/api/projects/${name}?confirm=${name}`);
  assert.deepEqual([gone.deleted, gone.repos], [name, 2]);
  assert.ok(gone.objects >= 2, "the change context and the attachment");
  assert.deepEqual(await repos(), []);
  assert.ok(!(await admin.req("GET", "/api/projects")).some((p: any) => p.name === name));
  assert.equal((await fetch(`${url}/api/projects/${name}/state`)).status, 404);
  assert.equal((await fetch(`${url}/api/projects/${name}/attachments/${shot.id}/raw`)).status, 404);
  await assert.rejects(ada.createTask("After", ""), /404/, "the agent's key is gone with it");
  await assert.rejects(admin.req("DELETE", `/api/projects/${name}?confirm=${name}`), /404/);

  await admin.createProject({ name, description: "the name again" });
  const fresh = await (await fetch(`${url}/api/projects/${name}/state`)).json();
  assert.equal(fresh.project.description, "the name again");
  assert.equal(fresh.tasks?.length ?? 0, 0);
  assert.equal((await repos()).length, 1);
});

test("a write with no message is committed under the task's title, not a generic one", { skip: !url, timeout: 60_000 }, async () => {
  const { Loom } = await import("../demo/client.mjs");
  const { SEED } = await import("../demo/seed.mjs");
  const name = project("e2e-commitmsg");
  const admin = new Loom(url, name, env.LOOM_ADMIN_TOKEN);
  await admin.createProject({ name, description: "commit messages", files: SEED });
  const ada = admin.as((await admin.addAgent("ada", "builder")).key);
  const t = await ada.createTask("Add a health route", "");
  const ws = (await ada.claim(t.id)).workspace.name;
  await ada.write(ws, { "health.txt": "ok" });
  const log = await admin.req("GET", `/commits?workspace=${ws}&limit=1`);
  assert.equal(log.commits[0].message.split("\n")[0], `Add a health route (task #${t.id})`);
});

test("with no reviewer around, Loom's review agent reviews the change: an approval lands it, a blocking comment sends it back", { skip: !url, timeout: 120_000 }, async () => {
  const { Loom } = await import("../demo/client.mjs");
  const { SEED } = await import("../demo/seed.mjs");
  const name = project("e2e-reviewagent");
  const admin = new Loom(url, name, env.LOOM_ADMIN_TOKEN);
  await admin.createProject({ name, description: "review agent", files: SEED, requiredApprovals: 1 });
  const settings = await admin.req("POST", "/settings", { reviewAgent: { afterMinutes: 0 } });
  assert.deepEqual(settings.reviewAgent, { enabled: true, afterMinutes: 0 }, "on by default");
  const ada = admin.as((await admin.addAgent("ada", "builder")).key);
  const until = async (id: number, ok: (c: any) => boolean) => {
    for (let i = 0; i < 60; i++) {
      const c = await admin.change(id);
      if (ok(c)) return c;
      await new Promise((r) => setTimeout(r, 500));
    }
    return admin.change(id);
  };
  const land = async (title: string, line: string) => {
    const t = await ada.createTask(title, "");
    const ws = (await ada.claim(t.id)).workspace.name;
    await ada.intent(t.id, ["src/db.js"], title);
    await ada.write(ws, { "src/db.js": (await ada.read("src/db.js", ws)) + `\n${line}\n` }, title);
    return ada.submit(t.id, title, "", { plan: [title] });
  };

  const good = await land("Add a trim helper", "export const trim = (s) => s.trim();");
  const merged = await until(good.id, (c) => c.status === "merged");
  assert.equal(merged.status, "merged", "the review agent's approval lands it");
  assert.equal(merged.reviews[0].reviewer, "loom-reviewer");
  assert.match(merged.reviews[0].body, /Loom's review agent/);

  const bad = await land("Add a broken helper", "export const broken = () => null; // LOOM-TEST-BUG");
  const sent = await until(bad.id, (c) => c.status === "changes_requested");
  assert.equal(sent.status, "changes_requested", "a blocking comment sends it back");
  const thread = sent.threads.find((t: any) => t.created_by === "loom-reviewer");
  assert.equal(thread.path, "src/db.js");
  assert.ok(thread.blocking);

  // Off in Settings: the next change waits for a person or an agent.
  assert.equal((await admin.req("POST", "/settings", { reviewAgent: { enabled: false } })).reviewAgent.enabled, false);
  const waits = await land("Add another helper", "export const two = 2;");
  await new Promise((r) => setTimeout(r, 4000));
  const still = await admin.change(waits.id);
  assert.equal(still.status, "review");
  assert.equal(still.reviews.length, 0);
});

test("a change doesn't merge while an agent who took its review is still reviewing, and a merged change can't be reviewed", { skip: !url, timeout: 120_000 }, async () => {
  const { Loom } = await import("../demo/client.mjs");
  const { SEED } = await import("../demo/seed.mjs");
  const name = project("e2e-reviewhold");
  const admin = new Loom(url, name, env.LOOM_ADMIN_TOKEN);
  await admin.createProject({ name, description: "review hold", files: SEED, requiredApprovals: 1 });
  await admin.req("POST", "/settings", { reviewAgent: { enabled: false } });
  const ada = admin.as((await admin.addAgent("ada", "builder")).key);
  const rex = admin.as((await admin.addAgent("rex", "reviewer")).key);
  const ivy = admin.as((await admin.addAgent("ivy", "reviewer")).key);
  const t = await ada.createTask("Trim titles", "");
  const ws = (await ada.claim(t.id)).workspace.name;
  await ada.intent(t.id, ["src/db.js"], "trim");
  await ada.write(ws, { "src/db.js": (await ada.read("src/db.js", ws)) + "\nexport const trim = (s) => s.trim();\n" }, "trim");
  const ch = await ada.submit(t.id, t.title, "Trim", { plan: ["trim"] });

  await ivy.req("POST", `/changes/${ch.id}/reviewers/take`);
  const approved = await rex.req("POST", `/changes/${ch.id}/reviews`, { verdict: "approve", body: "fine" });
  assert.equal(approved.status, "review", "held while ivy is reviewing");
  assert.match(approved.next, /ivy/);
  assert.deepEqual((await admin.change(ch.id)).approval.reviewing, ["ivy"]);

  await ivy.req("POST", `/changes/${ch.id}/reviews`, { verdict: "comment", body: "nothing to add" });
  let c = await admin.change(ch.id);
  for (let i = 0; i < 40 && c.status !== "merged"; i++) { await new Promise((r) => setTimeout(r, 500)); c = await admin.change(ch.id); }
  assert.equal(c.status, "merged", "lands once ivy is done");

  await assert.rejects(rex.req("POST", `/changes/${ch.id}/reviews`, { verdict: "request_changes", body: "too late" }), /merged/);
  assert.equal((await admin.change(ch.id)).status, "merged", "a late review doesn't rewrite it");
});

test("a person who turns on email hears when something needs them, once, with a link to approve it", { skip: !url, timeout: 120_000 }, async () => {
  const { Loom } = await import("../demo/client.mjs");
  const { SEED } = await import("../demo/seed.mjs");
  const name = project("e2e-email");
  const admin = new Loom(url, name, env.LOOM_ADMIN_TOKEN);
  await admin.createProject({ name, description: "email", files: SEED, requiredApprovals: 1 });
  await admin.req("POST", "/settings", { protectedPaths: ["src/db.js"], reviewAgent: { enabled: false } });
  await admin.req("POST", "/members", { login: "mia" });
  const signin = await fetch(`${url}/auth/dev?login=mia`, { redirect: "manual" });
  const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0];
  const mia = (method: string, path: string, body?: unknown) => fetch(`${url}/api/projects/${name}${path}`, { method, headers: { cookie, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, ...(await r.json()) }));

  assert.equal((await admin.req("POST", "/me/email", { email: "a@b.co" }).catch((e: Error) => e.message)).toString().includes("403"), true);
  assert.equal((await mia("POST", "/me/email", { email: "not an address" })).status, 400);
  const on = await mia("POST", "/me/email", { email: "mia@example.com" });
  assert.equal(on.email, "mia@example.com");
  assert.equal(on.sending, true);
  assert.equal((await mia("POST", "/me/email/test", {})).sent, true);

  const ada = admin.as((await admin.addAgent("ada", "builder")).key);
  const t = await ada.createTask("Trim titles", "");
  const ws = (await ada.claim(t.id)).workspace.name;
  await ada.intent(t.id, ["src/db.js"], "trim");
  await ada.write(ws, { "src/db.js": (await ada.read("src/db.js", ws)) + "\n// trim\n" }, "trim");
  await ada.submit(t.id, t.title, "Trim", { plan: ["trim"], tested: ["by hand"] });
  let sent = null;
  for (let i = 0; i < 20 && !sent; i++) { await new Promise((r) => setTimeout(r, 500)); sent = (await mia("GET", "/me/email")).lastSent; }
  assert.ok(sent, "an email went out for the protected change");

  const off = await mia("POST", "/me/email", { email: null });
  assert.equal(off.email, null);
});

test("a project created from a repository Loom recognizes gets a suggested check, and says once that main has no tests", { skip: !url, timeout: 60_000 }, async () => {
  const { Loom } = await import("../demo/client.mjs");
  const name = project("e2e-nochecks");
  const admin = new Loom(url, name, env.LOOM_ADMIN_TOKEN);
  await admin.createProject({ name, description: "no checks", files: { "package.json": '{"scripts":{"test":"node --test"}}', "src/a.js": "export const a = 1;\n" }, requiredApprovals: 1 });
  const ov = await admin.req("GET", "/overview");
  assert.equal(ov.project.checks, null);
  assert.equal(ov.project.suggestedCheck, "npm install && npm test");
  assert.equal(ov.project.mainTests, 0);
  const ada = admin.as((await admin.addAgent("ada", "builder")).key);
  const t = await ada.createTask("Add b", "export b from a.js");
  const ws = (await ada.claim(t.id)).workspace.name;
  await ada.intent(t.id, ["src/a.js"], "");
  await ada.write(ws, { "src/a.js": "export const a = 1;\nexport const b = 2;\n" });
  const ch = await ada.submit(t.id, t.title, "b", {});
  const detail = await ada.change(ch.id);
  assert.ok(!detail.brief.reasons.some((r: any) => r.kind === "tests"), "no per-change tests warning when main has none");
  await admin.req("POST", "/settings", { checks: { command: "npm test" } });
  assert.equal((await admin.req("GET", "/overview")).project.suggestedCheck, null);
});

test("creating projects is invite-only: others join the waitlist until the admin lets them in, and hidden projects aren't listed", { skip: !url, timeout: 60_000 }, async () => {
  const login = `zed${Date.now().toString(36).slice(-5)}`;
  const cookie = ((await fetch(`${url}/auth/dev?login=${login}`, { redirect: "manual" })).headers.get("set-cookie") ?? "").split(";")[0];
  const create = (name: string) => fetch(`${url}/api/projects`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name, description: "x" }) });
  const admin = (method: string, path: string, body?: unknown) => fetch(`${url}/api/admin/${path}`, { method, headers: { authorization: `Bearer ${env.LOOM_ADMIN_TOKEN}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
  const name = project("e2e-invite");
  const refused = await create(name);
  assert.equal(refused.status, 403);
  assert.match((await refused.json()).error, /waitlist/);
  assert.ok((await admin("GET", "waitlist")).some((w: any) => w.login === login));
  await admin("POST", "creators", { login });
  assert.ok(!(await admin("GET", "waitlist")).some((w: any) => w.login === login));
  assert.equal((await create(name)).status, 200);

  const listed = async (auth: boolean) => (await fetch(`${url}/api/projects`, { headers: auth ? { authorization: `Bearer ${env.LOOM_ADMIN_TOKEN}` } : {} }).then((r) => r.json())).map((p: any) => p.name);
  assert.ok((await listed(false)).includes(name));
  await admin("PUT", `projects/${name}`, { hidden: true });
  assert.ok(!(await listed(false)).includes(name));
  assert.ok((await listed(true)).includes(name));
  assert.equal((await fetch(`${url}/api/projects/${name}/overview`)).status, 200, "a hidden project still opens by name");
  await admin("DELETE", `creators/${login}`);
});

test("anyone on the free plan gets one project; paying through Stripe lifts the limits on their projects", { skip: !url, timeout: 60_000 }, async () => {
  const { signStripe } = await import("../src/billing.ts");
  const login = `pay${Date.now().toString(36).slice(-5)}`;
  const cookie = ((await fetch(`${url}/auth/dev?login=${login}`, { redirect: "manual" })).headers.get("set-cookie") ?? "").split(";")[0];
  const as = (method: string, path: string, body?: unknown) => fetch(`${url}${path}`, { method, headers: { cookie, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  // This server is invite-only too: let them in first.
  await fetch(`${url}/api/admin/creators`, { method: "POST", headers: { authorization: `Bearer ${env.LOOM_ADMIN_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ login }) });
  const webhook = async (event: unknown) => {
    const body = JSON.stringify(event), t = Math.floor(Date.now() / 1000);
    return fetch(`${url}/api/stripe/webhook`, { method: "POST", headers: { "stripe-signature": `t=${t},v1=${await signStripe("whsec_local", t, body)}` }, body });
  };

  const b = await (await as("GET", "/api/billing")).json();
  assert.equal(b.plan, "free");
  const first = project("e2e-pay");
  assert.equal((await as("POST", "/api/projects", { name: first, description: "x" })).status, 200);
  const second = await as("POST", "/api/projects", { name: project("e2e-pay2"), description: "x" });
  assert.equal(second.status, 403);
  assert.match((await second.json()).error, /free plan has 1 project/);

  const co = await (await as("POST", "/api/billing/checkout", { back: `/?project=${first}` })).json();
  assert.match(co.url, /\/stripe\/pay\/cs_test_/);
  assert.match(decodeURIComponent(co.url), new RegExp(`login=${login}.*billing=done`));

  assert.equal((await fetch(`${url}/api/stripe/webhook`, { method: "POST", headers: { "stripe-signature": "t=1,v1=00" }, body: "{}" })).status, 400);
  const created = Math.floor(Date.now() / 1000);
  await webhook({ type: "checkout.session.completed", created, data: { object: { mode: "subscription", client_reference_id: login, metadata: { app: "loom", login }, customer: "cus_e2e", subscription: "sub_e2e" } } });
  const pro = await (await as("GET", "/api/billing")).json();
  assert.equal(pro.plan, "pro");
  assert.equal(pro.manage, true);
  assert.match((await (await as("POST", "/api/billing/portal", {})).json()).url, /\/stripe\/portal\/cus_e2e/);
  assert.equal((await as("POST", "/api/projects", { name: project("e2e-pay3"), description: "x" })).status, 200);
  const ov = await (await as("GET", `/api/projects/${first}/overview`)).json();
  assert.equal(ov.project.limits.checkMinutes, 300, "the project they already had moved to Pro's limits");

  // An older event arriving late doesn't undo a newer one; cancelling does end it.
  await webhook({ type: "customer.subscription.updated", created: created - 10, data: { object: { id: "sub_e2e", status: "incomplete", customer: "cus_e2e", metadata: { app: "loom", login } } } });
  assert.equal((await (await as("GET", "/api/billing")).json()).plan, "pro");
  await webhook({ type: "customer.subscription.deleted", created: created + 10, data: { object: { id: "sub_e2e", status: "canceled", customer: "cus_e2e", metadata: { app: "loom", login } } } });
  assert.equal((await (await as("GET", "/api/billing")).json()).plan, "free");
  assert.equal((await (await as("GET", `/api/projects/${first}/overview`)).json()).project.limits.checkMinutes, 30);
});

test("an organization: people invited once are members of all its projects, its owners own them, and it has its own plan", { skip: !url, timeout: 90_000 }, async () => {
  const { signStripe } = await import("../src/billing.ts");
  const tag = Date.now().toString(36).slice(-5);
  const [alice, bob, carol] = [`ali${tag}`, `bob${tag}`, `car${tag}`];
  const signIn = async (login: string) => ((await fetch(`${url}/auth/dev?login=${login}`, { redirect: "manual" })).headers.get("set-cookie") ?? "").split(";")[0];
  const cookies: Record<string, string> = { [alice]: await signIn(alice), [bob]: await signIn(bob), [carol]: await signIn(carol) };
  const as = (who: string) => (method: string, path: string, body?: unknown) => fetch(`${url}${path}`, { method, headers: { cookie: cookies[who], "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const [A, B, C] = [as(alice), as(bob), as(carol)];
  await fetch(`${url}/api/admin/creators`, { method: "POST", headers: { authorization: `Bearer ${env.LOOM_ADMIN_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ login: alice }) });
  const meIn = async (who: typeof A, p: string) => { const r = await who("GET", `/api/projects/${p}/me`); return r.ok ? (await r.json()).agent : null; };

  const slug = `acme-${tag}`;
  assert.equal((await A("POST", "/api/orgs", { slug, name: "Acme" })).status, 200);
  assert.equal((await A("POST", "/api/orgs", { slug, name: "Again" })).status, 409, "a slug is taken once");
  const mine = project("e2e-own");
  assert.equal((await A("POST", "/api/projects", { name: mine, description: "x", visibility: "private" })).status, 200);
  const shared = project("e2e-org");
  const made = await A("POST", "/api/projects", { name: shared, description: "x", visibility: "private", org: slug });
  assert.equal(made.status, 200, await made.clone().text());
  assert.equal((await B("POST", "/api/projects", { name: project("e2e-x"), org: slug })).status, 403, "only the org's owners create projects in it");
  assert.equal(await meIn(B, shared), null, "bob isn't in yet");
  const outside = await (await B("GET", `/api/orgs/${slug}`)).json();
  assert.equal(outside.role, null);
  assert.equal(outside.members, undefined, "people outside an org don't see who's in it or what it owns");

  // Added by login: a member of the org's project, not an owner, and not of alice's own project.
  assert.equal((await A("POST", `/api/orgs/${slug}/members`, { login: bob })).status, 200);
  assert.equal((await meIn(B, shared))?.owner, false);
  assert.equal(await meIn(B, mine), null);
  assert.equal((await B("POST", `/api/orgs/${slug}/members`, { login: carol })).status, 403, "members don't add people");

  // An invite link: anyone can see what it's for; carol joins with it.
  const inv = await (await A("POST", `/api/orgs/${slug}/invites`, { role: "member" })).json();
  assert.match(inv.url, /\?invite=[a-f0-9]+$/);
  assert.equal((await (await fetch(`${url}/api/invites/${inv.code}`)).json()).name, "Acme");
  const joined = await (await C("POST", `/api/invites/${inv.code}/accept`, {})).json();
  assert.equal(joined.joined, true);
  assert.ok(await meIn(C, shared), "carol is a member of the org's project");
  const acct = await (await C("GET", "/api/account")).json();
  assert.equal(acct.orgs[0].slug, slug);

  // Owners of the org own its projects; leaving the org takes people out of them.
  await A("POST", `/api/orgs/${slug}/members`, { login: bob, role: "owner" });
  assert.equal((await meIn(B, shared))?.owner, true);
  assert.equal((await C("DELETE", `/api/orgs/${slug}/members/${carol}`, {})).status, 200, "anyone can leave");
  assert.equal(await meIn(C, shared), null);
  await A("DELETE", `/api/orgs/${slug}/invites/${inv.code}`, {});
  assert.equal((await fetch(`${url}/api/invites/${inv.code}`)).status, 404, "a withdrawn link stops working");
  assert.equal((await A("DELETE", `/api/orgs/${slug}/members/${alice}`, {})).status, 200, "alice can leave while bob owns it too");
  assert.equal((await B("DELETE", `/api/orgs/${slug}/members/${bob}`, {})).status, 409, "the last owner can't leave");
  await B("POST", `/api/orgs/${slug}/members`, { login: alice, role: "owner" });

  // Moving alice's own project in brings the org's people; moving it out takes them away again.
  assert.equal((await A("POST", `/api/projects/${mine}/org`, { org: slug })).status, 200);
  assert.equal((await meIn(B, mine))?.owner, true);
  assert.equal((await (await A("GET", `/api/projects/${mine}/overview`)).json()).project.org, slug);
  assert.equal((await A("POST", `/api/projects/${mine}/org`, { org: null })).status, 200);
  assert.equal(await meIn(B, mine), null);

  // The org's own plan: free has one project (it has one), and paying lifts its projects' limits.
  const capped = await A("POST", "/api/projects", { name: project("e2e-org2"), org: slug });
  assert.equal(capped.status, 403);
  assert.match((await capped.json()).error, new RegExp(`${slug} has 1`));
  const b = await (await A("GET", `/api/billing?org=${slug}`)).json();
  assert.equal(b.plan, "free");
  assert.equal(b.role, "owner");
  const co = await (await A("POST", "/api/billing/checkout", { org: slug, back: "/" })).json();
  assert.match(co.url, /\/stripe\/pay\/cs_test_/);
  const body = JSON.stringify({ type: "checkout.session.completed", created: Math.floor(Date.now() / 1000), data: { object: { mode: "subscription", metadata: { app: "loom", login: alice, account: `org:${slug}` }, customer: "cus_org", subscription: "sub_org" } } });
  const t = Math.floor(Date.now() / 1000);
  await fetch(`${url}/api/stripe/webhook`, { method: "POST", headers: { "stripe-signature": `t=${t},v1=${await signStripe("whsec_local", t, body)}` }, body });
  assert.equal((await (await A("GET", `/api/billing?org=${slug}`)).json()).plan, "pro");
  assert.equal((await (await A("GET", "/api/billing")).json()).plan, "free", "alice's own plan is untouched");
  assert.equal((await (await A("GET", `/api/projects/${shared}/overview`)).json()).project.limits.checkMinutes, 300);
  assert.equal((await A("POST", "/api/projects", { name: project("e2e-org3"), org: slug })).status, 200);

  // Where Loom emails a person lives on their account.
  assert.equal((await B("POST", "/api/account/email", { email: "bob@example.com" })).status, 200);
  assert.equal((await (await B("GET", "/api/account")).json()).email, "bob@example.com");
  assert.equal((await B("POST", "/api/account/email", { email: "nope" })).status, 400);
});
