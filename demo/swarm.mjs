#!/usr/bin/env node
// A scripted swarm: five agents and a reviewer work on one small codebase at
// the same time, through Loom. No LLM needed, so it is repeatable; it runs
// the same API an LLM agent uses over MCP. Watch it in the dashboard.
//
//   LOOM_URL=http://127.0.0.1:8787 LOOM_ADMIN_TOKEN=dev-admin node demo/swarm.mjs [project]
//
// Set PACE=0 to run as fast as possible (for tests), PACE=1.5 to slow down.
//
// A human ("jo", scripted) takes part too: protects package.json and
// README.md, sets a ground rule, and briefs jev, the humans' delegate, to
// answer questions, settle disputes and approve docs changes within that
// brief. jev settles what its house rules, earlier decisions or TypeSafe's Jev
// model (with TYPESAFE_API_KEY set on the Worker) can settle confidently; jo
// gets the rest, with jev's reason.
//
// Memory: every human answer, directive and ruling becomes a decision. dax
// asks a question jo already answered and gets the earlier decision back; fen
// starts on files ada changed, sees what ada did and why, and consults ada.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Loom, sleep } from "./client.mjs";
import { SEED } from "./seed.mjs";

const BASE = process.env.LOOM_URL ?? "http://127.0.0.1:8787";
const ADMIN = process.env.LOOM_ADMIN_TOKEN ?? "dev-admin";
const PACE = Number(process.env.PACE ?? 1);
const PROJECT = process.argv[2] ?? `todo-${Date.now().toString(36).slice(-5)}`;
const pause = (s) => sleep(s * 1000 * PACE);
const log = (who, msg) => console.log(`${new Date().toISOString().slice(11, 19)}  ${who.padEnd(5)} ${msg}`);

// Each agent's work is a set of edits expressed as functions of the current
// file, the way an LLM agent re-applies its intent on top of a newer main.
const replace = (from, to) => (s) => (s.includes(to) ? s : s.replace(from, to));
const append = (text) => (s) => (s.includes(text.trim()) ? s : s + text);
const insertAfter = (anchor, text) => (s) => (s.includes(text) ? s : s.replace(anchor, anchor + text));

const PLANS = [
  {
    agent: "ada", task: "Add due dates and an overdue filter",
    consultAnswer: "Yes, same convention: optional fields are null when absent, never undefined, so every record has the key and JSON output stays stable. overdue() relies on that (it checks t.due).",
    paths: ["src/db.js", "src/routes/todos.js"],
    intent: "Store an optional due date on each todo; GET ?overdue=1 returns overdue items",
    useGit: true,
    contract: { title: "db.overdue(now = Date.now())", body: "Returns todos that are not done and whose `due` (ISO 8601 string) is before `now`. Todos without `due` are never overdue." },
    edits: {
      "src/db.js": [
        replace("done: false }", "done: false, due: todo.due ?? null }"),
        append(`
export function overdue(now = Date.now()) {
  return list().filter((t) => !t.done && t.due && Date.parse(t.due) < now);
}
`),
      ],
      "src/routes/todos.js": [replace("    return json(db.list());", '    return json(url.searchParams.get("overdue") ? db.overdue() : db.list());')],
    },
    context: { plan: ["add due to record", "add overdue() query", "wire ?overdue=1"], decisions: ["due is an ISO string; null when absent"], tested: ["manual: GET ?overdue=1 with past date"] },
  },
  {
    agent: "bex", task: "Validate new todos",
    question: "What should the maximum title length be?",
    options: { "200": "200 characters: room for a sentence, still fits one line in the UI", "1000": "1000 characters: allows short notes in the title", "none": "No limit" },
    paths: ["src/util/validate.js", "src/routes/todos.js"],
    intent: "Reject POST bodies without a non-empty title (400)",
    edits: {
      "src/util/validate.js": [() => `export function validateTodo(body) {
  if (!body || typeof body.title !== "string") return "title is required";
  if (!body.title.trim()) return "title must not be empty";
  if (body.title.length > 200) return "title is too long";
  return null;
}
`],
      "src/routes/todos.js": [
        insertAfter('import * as db from "../db.js";\n', 'import { validateTodo } from "../util/validate.js";\n'),
        insertAfter('  if (req.method === "POST") {\n', "    const problem = validateTodo(req.body);\n    if (problem) return json({ error: problem }, 400);\n"),
      ],
    },
    context: { plan: ["new validate.js", "call it first thing in POST"], decisions: ["max title length 200"], tested: ["empty title -> 400", "missing body -> 400"] },
  },
  {
    agent: "cyd", task: "Rename db.save to db.put and trim titles",
    proposeOrderWith: "ada",
    paths: ["src/db.js", "src/routes/todos.js"],
    intent: "Rename save() to put() everywhere; trim titles on write",
    edits: {
      "src/db.js": [replace("export function save(todo)", "export function put(todo)"), replace("title: todo.title,", "title: todo.title.trim(),")],
      "src/routes/todos.js": [replace("db.save(body)", "db.put(body)")],
    },
    context: { plan: ["rename in db.js", "update the only caller"], decisions: ["no alias for save(): nothing else calls it"], tested: ["grep for save( shows no callers"] },
  },
  {
    agent: "eli", task: "Document the API in the README",
    paths: ["README.md"],
    intent: "Describe the endpoints",
    sneaky: true,
    dispute: {
      question: "Should the change that documents the API also bump the package version?",
      position: "Documenting the API is a user-visible milestone, so 0.2.0 belongs with it. A separate task just for the bump is overhead.",
    },
    edits: {
      "README.md": [append(`
## API

- \`GET /\` lists todos. \`GET /?overdue=1\` lists overdue ones.
- \`POST /\` with \`{ "title": "...", "due": "2026-10-14" }\` creates one.
- \`PATCH /?id=1\` marks one done.
`)],
      "package.json": [replace('"version": "0.1.0"', '"version": "0.2.0"')],
    },
    context: { plan: ["write API section"], tested: [] },
  },
];

const TEST_PLAN = {
  agent: "dax", task: "Test the validator", dependsOnAgent: "bex",
  questions: [
    { q: "Which test runner should I use, node:test or vitest?", options: { "node:test": "Built into Node, no new dependency", vitest: "Nicer output and watch mode, adds a dev dependency" } },
    { q: "What should the maximum title length be?", options: { "200": "200 characters", "1000": "1000 characters", none: "No limit" } },
  ],
  paths: ["test/"],
  intent: "Unit tests for validateTodo",
  edits: {
    "test/validate.test.js": [() => `import { test } from "node:test";
import assert from "node:assert/strict";
import { validateTodo } from "../src/util/validate.js";

test("requires a title", () => assert.equal(validateTodo({}), "title is required"));
test("rejects blank titles", () => assert.equal(validateTodo({ title: "  " }), "title must not be empty"));
test("accepts a title", () => assert.equal(validateTodo({ title: "ship it" }), null));
`],
  },
  context: { plan: ["three cases"], tested: ["node --test test/"] },
};

// A second wave: fen starts after ada's work has landed, on the same files.
// Loom's memory tells fen what ada did and why, and that ada is still around.
const FOLLOW_PLAN = {
  agent: "fen", task: "Add a priority level and a priority filter", dependsOnAgent: "ada",
  paths: ["src/db.js", "src/routes/todos.js"],
  intent: "Store an optional priority on each todo; GET ?priority=high filters by it",
  consult: { agent: "ada", path: "src/db.js", question: "You added `due` to the record in src/db.js. Should `priority` follow the same convention, null when absent rather than undefined?" },
  edits: {
    "src/db.js": [
      replace("due: todo.due ?? null }", "due: todo.due ?? null, priority: todo.priority ?? null }"),
      append(`
export function byPriority(priority) {
  return list().filter((t) => t.priority === priority);
}
`),
    ],
    "src/routes/todos.js": [
      insertAfter('  if (req.method === "GET") {\n', '    if (url.searchParams.get("priority")) return json(db.byPriority(url.searchParams.get("priority")));\n'),
    ],
  },
  context: { plan: ["add priority to record", "byPriority() query", "wire ?priority="], decisions: ["priority is null when absent, like due (confirmed with ada)"], tested: ["GET ?priority=high"] },
};

async function apply(loom, workspace, edits, onMain) {
  const files = {};
  for (const [path, fns] of Object.entries(edits)) {
    let content = "";
    try { content = await loom.read(path, onMain ? undefined : workspace); } catch {}
    for (const fn of fns) content = fn(content);
    files[path] = content;
  }
  return files;
}

async function waitFor(loom, pred, label, timeout = 120) {
  for (let i = 0; i < timeout * 4; i++) {
    const s = await loom.state();
    const v = pred(s);
    if (v) return v;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function builder(admin, keys, plan, taskId) {
  const me = admin.as(keys[plan.agent].key);
  const id = keys[plan.agent].id;
  await pause(Math.random() * 2);
  let claim;
  for (;;) {
    try { claim = await me.claim(taskId); break; }
    catch (e) {
      if (e.status !== 409) throw e;
      if (!builder.waiting[plan.agent]) log(plan.agent, `waiting: ${e.message.split(": ").pop()}`);
      builder.waiting[plan.agent] = true;
      await pause(3);
      if (PACE === 0) await sleep(200);
    }
  }
  log(plan.agent, `claimed #${taskId} → workspace ${claim.workspace.name}`);
  for (const r of claim.memory?.related ?? []) log(plan.agent, `memory: related earlier task #${r.task} “${r.title}” by ${r.agentName} (${r.status}, ${r.why})`);
  await pause(1);

  const intent = await me.intent(taskId, plan.paths, plan.intent);
  const mem = intent.memory;
  for (const d of mem.decisions.filter((d) => d.paths.length)) log(plan.agent, `memory: decision #${d.id} by ${d.byName} applies: “${d.decision}”`);
  for (const e of mem.pastEfforts) log(plan.agent, `memory: ${e.agentName}'s change #${e.change} “${e.title}” touched ${e.files.join(", ")}${e.decisions.length ? `; decided: ${e.decisions.join("; ")}` : ""}`);
  const hint = plan.consult && mem.consult.find((c) => c.agentName === plan.consult.agent);
  if (hint) {
    const { thread } = await me.req("POST", "/consults", { agent: hint.agent, question: plan.consult.question, path: plan.consult.path, changeId: hint.change, taskId });
    log(plan.agent, `consulting ${hint.agentName}, who is still around: ${plan.consult.question}`);
    for (;;) {
      const t = await me.req("GET", `/threads/${thread.id}`);
      const answer = t.posts.find((p) => p.author === hint.agent);
      if (answer) { log(plan.agent, `${hint.agentName} replied: “${answer.body}”`); break; }
      await pause(1);
    }
  }
  for (const o of intent.overlaps) {
    log(plan.agent, `collision forecast with ${o.agentName} on ${o.paths.join(", ")}`);
    if (plan.proposeOrderWith && o.agentName === plan.proposeOrderWith) {
      await me.req("POST", "/proposals", { taskId, theirTaskId: o.task, kind: "order", first: "you", body: `We both edit the record line in src/db.js. You land first; I'll rebase my rename on top of yours.` });
      log(plan.agent, `proposed to ${o.agentName}: you land first, I'll follow`);
    } else {
      await me.message(o.agent, `I'm about to edit ${o.paths.join(", ")} for “${plan.task}”. I'll keep to my part (${plan.intent.toLowerCase()}); shout if that collides with yours.`, taskId);
    }
  }
  if (plan.contract) {
    await me.req("POST", "/threads", { kind: "contract", taskId, path: "src/db.js", title: plan.contract.title, body: plan.contract.body });
    log(plan.agent, `published contract: ${plan.contract.title}`);
  }
  for (const { q: text, options } of plan.questions ?? (plan.question ? [{ q: plan.question, options: plan.options }] : [])) {
    const q = await me.req("POST", "/threads", { kind: "question", to: "humans", taskId, body: text, options, blocking: true });
    log(plan.agent, `asked the humans (blocking): ${text}`);
    for (;;) {
      const t = await me.req("GET", `/threads/${q.id}`);
      if (t.status !== "open") { log(plan.agent, `got an answer from ${t.posts.at(-1).authorName}: “${t.posts.at(-1).body}”`); break; }
      await pause(1);
    }
  }
  await pause(2 + Math.random() * 2);

  // Write the change, either with a real git client or through the API.
  const files = await apply(me, claim.workspace.name, plan.edits);
  if (plan.useGit) {
    const dir = mkdtempSync(join(tmpdir(), `loom-${plan.agent}-`));
    const auth = ["-c", `http.extraHeader=Authorization: Bearer ${claim.workspace.token}`];
    execFileSync("git", [...auth, "clone", "-q", claim.workspace.remote, dir]);
    for (const [p, c] of Object.entries(files)) {
      execFileSync("mkdir", ["-p", join(dir, p, "..")]);
      writeFileSync(join(dir, p), c);
    }
    execFileSync("git", ["-C", dir, "add", "-A"]);
    execFileSync("git", ["-C", dir, "-c", `user.name=${plan.agent}`, "-c", `user.email=${id}@agents.loom.dev`, "commit", "-qm", plan.task]);
    execFileSync("git", ["-C", dir, ...auth, "push", "-q", "origin", "main"]);
    rmSync(dir, { recursive: true, force: true });
    log(plan.agent, `pushed with git: ${Object.keys(files).join(", ")}`);
  } else {
    await me.write(claim.workspace.name, files, plan.task);
    log(plan.agent, `committed: ${Object.keys(files).join(", ")}`);
  }
  await pause(1);

  let change = await me.submit(taskId, plan.task, plan.intent, plan.context);
  log(plan.agent, `submitted change #${change.id}${change.undeclared.length ? ` (outside intent: ${change.undeclared.join(", ")})` : ""}`);
  // Ask a peer who already knows this code to review it, alongside the reviewer.
  const peer = (change.suggestedReviewers ?? []).find((c) => c.role === "builder" && c.score > 0);
  if (peer) {
    await me.req("POST", `/changes/${change.id}/reviewers`, { reviewers: [peer.agent], note: "You know this code; does my change fit how you built it?" });
    log(plan.agent, `asked ${peer.name} to review #${change.id} (${peer.name} ${peer.reasons[0]})`);
  }

  // React to what the platform tells us until the change lands.
  let handledReviews = 0;
  for (;;) {
    const s = await me.state();
    const c = s.changes.find((x) => x.id === change.id);
    if (c.status === "merged") { log(plan.agent, `#${c.id} merged ✓`); return; }
    const stale = s.events.find((e) => e.type === "workspace.stale" && e.to_agent === id && e.seq > (builder.seen[id] ?? 0));
    if (c.status === "conflict" || (stale && ["review", "changes_requested"].includes(c.status))) {
      if (stale) builder.seen[id] = stale.seq;
      let r;
      try { r = await me.sync(taskId); } catch (e) { if (e.status === 409) { await pause(1); continue; } throw e; }
      if (r.status === "conflict") {
        log(plan.agent, `conflict in ${r.conflicts.map((x) => `${x.path} (with ${x.causedBy.map((y) => y.agentName).join(", ") || "main"})`).join(", ")}; re-applying my edits on top of main`);
        await pause(2);
        const resolved = await apply(me, null, Object.fromEntries(r.conflicts.map((x) => [x.path, plan.edits[x.path]])), true);
        try { await me.sync(taskId, resolved); } catch (e) { if (e.status === 409) continue; throw e; }
        log(plan.agent, `resolved and resubmitted`);
      } else if (r.status === "synced") log(plan.agent, `synced main into workspace (clean)`);
    } else if (c.status === "changes_requested") {
      const detail = await me.change(c.id);
      const fresh = detail.reviews.filter((r) => r.verdict === "request_changes").slice(handledReviews);
      if (fresh.length) {
        handledReviews += fresh.length;
        log(plan.agent, `review asks: “${fresh.at(-1).body}”`);
        await pause(2);
        const objector = fresh.find((r) => s.agents.find((a) => a.id === r.reviewer)?.role === "reviewer");
        if (plan.dispute && objector && !builder.disputed[plan.agent]) {
          builder.disputed[plan.agent] = true;
          const d = await me.req("POST", "/disputes", { with: objector.reviewer, changeId: c.id, question: plan.dispute.question, position: plan.dispute.position });
          log(plan.agent, `disagrees with ${s.agents.find((a) => a.id === objector.reviewer).name}; opened a dispute: ${plan.dispute.question}`);
          let t;
          for (;;) {
            t = await me.req("GET", `/threads/${d.id}`);
            if (t.status !== "open") break;
            await pause(1);
          }
          const ruling = t.posts.at(-1);
          log(plan.agent, `dispute ruled by ${ruling.authorName}: “${ruling.body.split("\n")[0]}”`);
          if (ruling.body.includes(`${plan.agent}'s position`)) continue;
          log(plan.agent, "lost the dispute; dropping the version bump");
        }
        // Put back every file we touched outside our declared intent.
        const revert = {};
        for (const path of c.undeclared) revert[path] = await me.read(path).catch(() => null);
        if (Object.keys(revert).length) await me.write(claim.workspace.name, revert, "Revert edits outside declared intent");
        await me.update(c.id, plan.intent + " (review addressed)").catch((e) => { if (e.status !== 409) throw e; });
        log(plan.agent, `addressed review, back in review`);
      }
    }
    await pause(1);
  }
}
builder.seen = {};

// Builders review when a peer asks them to: they know the code they wrote.
async function peerDesk(admin, keys, done) {
  const peers = Object.entries(keys);
  const cursors = {};
  while (!done.value) {
    for (const [name, k] of peers) {
      const me = admin.as(k.key);
      const r = await me.req("GET", `/events?after=${cursors[name] ?? 0}&agent=${k.id}&mine=1`).catch(() => null);
      if (!r) continue;
      cursors[name] = r.cursor;
      for (const e of r.events.filter((e) => e.type === "review.assigned" && e.to_agent === k.id)) {
        const c = await me.change(e.change_id);
        if (!["review", "changes_requested"].includes(c.status)) continue;
        await me.req("POST", `/changes/${c.id}/reviewers/respond`, { accept: true }).catch(() => {});
        log(name, `accepted the review of #${c.id}`);
        await pause(1);
        await me.review(c.id, "approve", `Fits how I built it (${e.data.reason}).`).catch(() => {});
        log(name, `approved #${c.id} on request: ${e.data.reason}`);
      }
    }
    await pause(1);
  }
}

builder.waiting = {};
builder.disputed = {};

async function reviewer(admin, key, done) {
  const me = admin.as(key);
  const seen = new Set();
  const myId = (await me.me()).agent.id;
  while (!done.value) {
    const s = await me.state();
    for (const t of (s.threads ?? []).filter((t) => t.kind === "dispute" && t.status === "open")) {
      const terms = JSON.parse(t.terms);
      if (!terms.parties.includes(myId) || terms.positions[myId]) continue;
      await pause(2);
      await me.req("POST", `/disputes/${t.id}/position`, { position: "A docs change shouldn't touch package.json: edits outside a change's declared intent need their own task, and version bumps happen at release time." });
      log("rex", `stated a position in dispute #${t.id}`);
    }
    for (const c of s.changes.filter((x) => x.status === "review")) {
      const k = `${c.id}:${c.head}`;
      if (seen.has(k)) continue;
      seen.add(k);
      await pause(2);
      const d = await me.change(c.id);
      if (d.undeclared.length) {
        await me.review(c.id, "request_changes", `You changed ${d.undeclared.join(", ")} without declaring it. Revert it or explain why the task needs it.`, d.undeclared.map((p) => ({ path: p, body: "outside the declared intent" })));
        log("rex", `requested changes on #${c.id}: undeclared ${d.undeclared.join(", ")}`);
      } else {
        await me.review(c.id, "approve", `Diff matches the declared intent (${d.intents.flatMap((i) => i.paths).join(", ")}).`);
        log("rex", `approved #${c.id}`);
      }
    }
    await pause(1);
  }
}

/** Agents accept proposals and answer consults addressed to them (an LLM agent would think about them). */
async function proposalDesk(admin, keys, done) {
  const byId = Object.fromEntries(Object.values(keys).map((k) => [k.id, k]));
  const answered = new Set();
  while (!done.value) {
    const asks = await admin.req("GET", "/threads?kind=discussion&status=open");
    for (const t of asks.filter((t) => t.title.startsWith("Consult:") && byId[t.to_agent])) {
      if (answered.has(t.id) || t.posts.some((p) => p.author === t.to_agent)) continue;
      answered.add(t.id);
      const who = byId[t.to_agent];
      const plan = [...PLANS, TEST_PLAN, FOLLOW_PLAN].find((p) => p.agent === who.name);
      await pause(2);
      await admin.as(who.key).req("POST", `/threads/${t.id}/posts`, { body: plan?.consultAnswer ?? "I don't remember more than what's in my change's context; go by that." });
      log(who.name, `answered a consult from ${t.createdByName}`);
    }
    const threads = await admin.req("GET", "/threads?kind=proposal&status=open");
    for (const t of threads) {
      if (answered.has(t.id) || !byId[t.to_agent]) continue;
      answered.add(t.id);
      await pause(2);
      await admin.as(byId[t.to_agent].key).req("POST", `/proposals/${t.id}/accept`, { body: "Agreed. I'll go first." });
      log(byId[t.to_agent].name, `accepted proposal: ${t.title}`);
    }
    await pause(1);
  }
}

/** A human tech lead: sets rules, briefs jev, and takes what jev hands back. */
async function human(admin, key, done) {
  const me = admin.as(key);
  await me.req("POST", "/protect", { paths: ["package.json", "README.md"] });
  log("jo", "protected package.json and README.md: changes there need a human");
  await me.req("POST", "/directives", { body: "Keep each change to its task. Ask before adding dependencies or changing package.json." });
  log("jo", "sent a directive to all agents");
  await me.req("POST", "/delegate", {
    enabled: true,
    guidance: "Keep things simple and dependency-free. Validation should be strict but practical: a todo title is one line, so cap it at 200 characters. Versions change at release time, never in feature changes. Documentation-only changes are welcome.",
    questions: { enabled: true, topics: [], minConfidence: 0.85 },
    approvals: { enabled: true, paths: ["README.md", "docs/**"], requireAgentReview: true, minConfidence: 0.9 },
    rules: [{ pattern: "test runner|node:test|vitest|jest", answer: "Use node:test. It's built in, and we don't add dependencies for tests." }],
  });
  log("jo", "briefed jev: answer questions, approve README and docs changes, escalate the rest");
  const handled = new Set();
  while (!done.value) {
    const s = await me.state();
    // jo only picks up what jev handed back.
    for (const t of (s.threads ?? []).filter((t) => t.kind === "question" && t.status === "open" && t.to_agent === "humans" && t.escalated)) {
      if (handled.has(`q${t.id}`)) continue;
      handled.add(`q${t.id}`);
      log("jo", `jev passed ${t.created_by}'s question on: ${t.escalated}`);
      await pause(4);
      await me.req("POST", `/threads/${t.id}/posts`, { body: "200 is right. Return the error message in the response body so the UI can show it." });
      log("jo", `answered ${t.created_by}'s question`);
    }
    for (const t of (s.threads ?? []).filter((t) => t.kind === "dispute" && t.status === "open" && t.escalated)) {
      if (handled.has(`d${t.id}`)) continue;
      handled.add(`d${t.id}`);
      const terms = JSON.parse(t.terms);
      const reviewerSide = terms.parties.find((p) => s.agents.find((a) => a.id === p)?.role === "reviewer");
      log("jo", `jev passed dispute #${t.id} on: ${t.escalated}`);
      await pause(4);
      await me.req("POST", `/disputes/${t.id}/rule`, { for: reviewerSide, note: "Versions change at release time, as decided earlier." });
      log("jo", `ruled on dispute #${t.id}`);
    }
    const escalated = new Set(s.events.filter((e) => e.type === "delegate.escalated" && e.change_id).map((e) => e.change_id));
    const needs = new Set(s.events.filter((e) => e.type === "approval.needs_human").map((e) => e.change_id));
    const touches = (c, p) => c.files.some((f) => f.path === p);
    for (const c of s.changes.filter((c) => c.status === "review" && needs.has(c.id))) {
      const k = `c${c.id}:${c.head}`;
      if (handled.has(k)) continue;
      if (touches(c, "package.json")) {
        // rex and eli's dispute settles this; if the change still bumps the version after it, jo sends it back.
        const ruled = (s.threads ?? []).some((t) => t.kind === "dispute" && t.change_id === c.id && t.status === "ruled");
        if (!ruled && !escalated.has(c.id)) continue;
        handled.add(k);
        await pause(3);
        await me.review(c.id, "request_changes", "Version bumps happen at release time, not in feature changes. Please drop the package.json edit.", [{ path: "package.json", body: "revert this" }]);
        log("jo", `requested changes on #${c.id}: no version bumps in feature changes`);
        continue;
      }
      if (escalated.has(c.id) && s.reviews.some((r) => r.change_id === c.id && r.verdict === "approve")) {
        handled.add(k);
        await pause(3);
        await me.review(c.id, "approve", "Docs look good.");
        log("jo", `approved #${c.id} after jev passed it on`);
      }
    }
    await pause(1);
  }
}

async function main() {
  const admin = new Loom(BASE, PROJECT, ADMIN);
  await admin.createProject({ name: PROJECT, description: "A tiny todo service, built by a swarm", files: SEED, requiredApprovals: 1 });
  console.log(`project ${PROJECT}: open ${BASE}/?project=${PROJECT}`);
  await pause(3);

  const keys = {};
  for (const name of ["ada", "bex", "cyd", "dax", "eli", "fen"]) keys[name] = await admin.addAgent(name);
  keys.rex = await admin.addAgent("rex", "reviewer");
  const jo = await admin.addAgent("jo", "human");
  const tasks = {};
  for (const p of PLANS) tasks[p.agent] = (await admin.createTask(p.task, p.intent)).id;
  tasks.dax = (await admin.createTask(TEST_PLAN.task, TEST_PLAN.intent, [tasks.bex])).id;
  tasks.fen = (await admin.createTask(FOLLOW_PLAN.task, FOLLOW_PLAN.intent, [tasks.ada])).id;

  const done = { value: false };
  const rev = reviewer(admin, keys.rex.key, done);
  const lead = human(admin, jo.key, done);
  const desk = proposalDesk(admin, keys, done);
  const peers = peerDesk(admin, Object.fromEntries(["ada", "bex", "cyd", "dax", "eli", "fen"].map((n) => [n, keys[n]])), done);
  await Promise.all([...PLANS, TEST_PLAN, FOLLOW_PLAN].map((p) => builder(admin, keys, p, tasks[p.agent])));
  done.value = true;
  await Promise.all([rev, lead, desk, peers]);

  const s = await admin.state();
  console.log(`\nAll ${s.changes.length} changes merged. main is v${s.project.mainVersion} at ${s.project.mainHead.slice(0, 7)}.`);
  console.log(`collisions forecast: ${s.events.filter((e) => e.type === "collision.forecast").length}, conflicts routed: ${s.events.filter((e) => e.type === "change.conflict").length}`);
  console.log("\nsrc/db.js on main:\n" + (await admin.read("src/db.js")));
  console.log("src/routes/todos.js on main:\n" + (await admin.read("src/routes/todos.js")));
}

main().catch((e) => { console.error(e); process.exit(1); });
