#!/usr/bin/env node
// Contests, track records and notes, scripted so it is repeatable.
//
//   LOOM_URL=http://127.0.0.1:8787 LOOM_ADMIN_TOKEN=dev-admin node demo/contest.mjs [project]
//
// 1. Track records. Two reviewers build different records: rex's objections
//    hold up and his approvals land; ivy approves a change that jo, the human
//    lead, then sends back. Loom weighs each agent's approvals and votes by
//    how its earlier ones turned out.
// 2. A contest. One task, three independent attempts (kai, lou, mo). The
//    other agents compare them side by side and vote. ivy votes for the
//    sloppy attempt, rex and sam for the careful one. The votes are weighed,
//    the winner lands, the others are closed, and why it won is recorded.
// 3. Notes. kai leaves a note in its change's context. When kai's change
//    lands, the note becomes the project's; the next agent to declare intent
//    on that file gets it, and confirms it.
//
// Set PACE=0 to run as fast as possible.

import { Loom, sleep } from "./client.mjs";
import { SEED } from "./seed.mjs";

const BASE = process.env.LOOM_URL ?? "http://127.0.0.1:8787";
const ADMIN = process.env.LOOM_ADMIN_TOKEN ?? "dev-admin";
const PACE = Number(process.env.PACE ?? 1);
const PROJECT = process.argv[2] ?? `contest-${Date.now().toString(36).slice(-5)}`;
const pause = (s) => sleep(s * 1000 * PACE);
const log = (who, msg) => console.log(`${new Date().toISOString().slice(11, 19)}  ${who.padEnd(5)} ${msg}`);

const admin = new Loom(BASE, PROJECT, ADMIN);

async function waitFor(what, check, seconds = 60) {
  for (let i = 0; i < seconds * 4; i++) {
    const v = await check();
    if (v) return v;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const merged = (agent, changeId) => waitFor(`change #${changeId} to land`, async () => (await agent.change(changeId)).status === "merged");

/** Claim, edit and submit a task; returns the change. */
async function build(agent, name, taskId, edit, summary, context = {}) {
  const claim = await agent.claim(taskId);
  const ws = claim.workspace.name;
  const task = claim.task;
  await agent.intent(task.id, Object.keys(edit), summary);
  const files = {};
  for (const [path, fn] of Object.entries(edit)) files[path] = fn(await agent.read(path, ws));
  await agent.write(ws, files, summary);
  const ch = await agent.submit(task.id, task.title, summary, context);
  log(name, `submitted #${ch.id} for task #${task.id}`);
  return ch;
}

async function main() {
  await admin.createProject({ name: PROJECT, description: "A tiny todo service: contests, track records and notes", files: SEED, requiredApprovals: 1 });
  console.log(`project ${PROJECT}: watch at ${BASE}/?project=${PROJECT}`);
  const add = async (name, role) => admin.as((await admin.addAgent(name, role)).key);
  const jo = await add("jo", "human");
  const [kai, lou, mo, nia] = await Promise.all(["kai", "lou", "mo", "nia"].map((n) => add(n, "builder")));
  const [rex, ivy, sam] = await Promise.all(["rex", "ivy", "sam"].map((n) => add(n, "reviewer")));
  const ids = Object.fromEntries((await admin.state()).agents.map((a) => [a.name, a.id]));

  // ── 1. track records ────────────────────────────────────────────────────
  log("jo", "two warm-up tasks, so the reviewers have a track record");
  const t1 = await jo.createTask("Add a count endpoint", "GET ?count=1 returns the number of todos");
  const c1 = await build(lou, "lou", t1.id, {
    "src/routes/todos.js": (s) => s.replace("    return json(db.list());", '    if (url.searchParams.get("count")) return json(db.list().length);\n    return json(db.list());'),
  }, "Add ?count=1");
  await rex.review(c1.id, "request_changes", "Return an object, {count: n}, like every other response; a bare number breaks the client's JSON handling.");
  log("rex", `requested changes on #${c1.id}: return {count: n}`);
  await ivy.review(c1.id, "approve", "Looks fine.");
  log("ivy", `approved #${c1.id} anyway, without reading it closely`);
  await jo.review(c1.id, "request_changes", "Agree with rex: responses are always objects.");
  log("jo", `sent #${c1.id} back too`);
  await pause(1);
  const ws1 = (await lou.claim(t1.id)).workspace.name;
  await lou.write(ws1, { "src/routes/todos.js": (await lou.read("src/routes/todos.js", ws1)).replace("json(db.list().length)", "json({ count: db.list().length })") }, "Return {count}");
  await lou.update(c1.id, "Add ?count=1, returning {count: n}");
  await rex.review(c1.id, "approve", "Good.");
  await merged(lou, c1.id);
  log("lou", `#${c1.id} landed`);

  const t2 = await jo.createTask("Trim titles", "Store titles without surrounding whitespace");
  const c2 = await build(nia, "nia", t2.id, { "src/db.js": (s) => s.replace("title: todo.title,", "title: String(todo.title).trim(),") }, "Trim titles when saving");
  await rex.review(c2.id, "approve", "Correct, and String() guards non-strings.");
  await merged(nia, c2.id);
  log("nia", `#${c2.id} landed`);

  for (const name of ["rex", "ivy", "sam"]) {
    const t = await admin.req("GET", `/agents/${ids[name]}/trust`);
    log(name, `track record: ${t.summary}; approvals and votes count ${t.weight}x`);
  }
  await pause(2);

  // ── 2. a contest ────────────────────────────────────────────────────────
  const c = await jo.req("POST", "/tasks", { title: "Search todos by title", description: "GET ?q=text returns the todos whose title contains text, ignoring case. Keep data access in db.js.", attempts: 3 });
  log("jo", `opened a contest: task #${c.id}, 3 attempts (#${c.attemptTasks.join(", #")})`);
  await pause(1);

  const [a1, a2, a3] = await Promise.all([
    build(kai, "kai", c.id, {
      "src/db.js": (s) => s + `
export function search(text) {
  const needle = String(text).toLowerCase();
  return list().filter((t) => t.title.toLowerCase().includes(needle));
}
`,
      "src/routes/todos.js": (s) => s.replace("    return json(db.list());", '    const q = url.searchParams.get("q");\n    if (q) return json(db.search(q));\n    return json(db.list());'),
    }, "Search in db.search(), case-insensitive, wired to ?q=", {
      plan: ["db.search(text) next to list()", "route ?q= to it"],
      tested: ["?q=MILK finds 'milk'", "empty result is []"],
      notes: [{ text: "All reads of todos go through db.js (list, overdue, search): routes never touch the Map directly.", paths: ["src/db.js", "src/routes/"], kind: "convention" }],
    }),
    build(lou, "lou", c.id, {
      "src/routes/todos.js": (s) => s.replace("    return json(db.list());", '    const q = url.searchParams.get("q");\n    return json(q ? db.list().filter((t) => t.title.toLowerCase().includes(q.toLowerCase())) : db.list());'),
    }, "Filter by ?q= in the route", { tested: ["?q=milk"] }),
    build(mo, "mo", c.id, {
      "src/routes/todos.js": (s) => s.replace("    return json(db.list());", '    if (url.searchParams.get("q")) return json(db.list().filter((t) => t.title.includes(url.searchParams.get("q"))));\n    return json(db.list());'),
    }, "Quick ?q= filter", {}),
  ]);
  await pause(2);

  const view = await rex.req("GET", `/contests/${c.id}`);
  for (const at of view.attempts) log("rex", `compares #${at.change.id} by ${at.agentName}: +${at.change.added} -${at.change.removed}, ${at.change.files.join(", ")}`);
  await ivy.req("POST", `/contests/${c.id}/votes`, { changeId: a3.id, reason: "Smallest diff." });
  log("ivy", `votes for #${a3.id} (mo): smallest diff`);
  await pause(1);
  await sam.req("POST", `/contests/${c.id}/votes`, { changeId: a2.id, reason: "Simple and case-insensitive." });
  log("sam", `votes for #${a2.id} (lou): simple and case-insensitive`);
  await pause(1);
  let standings = (await jo.req("GET", `/contests/${c.id}`)).standings;
  log("loom", `standings: ${standings.map((s) => `#${s.candidate} ${s.weight}`).join(", ")}; no attempt has the quorum of ${(await jo.req("GET", `/contests/${c.id}`)).contest.quorum} yet`);
  const r = await rex.req("POST", `/contests/${c.id}/votes`, { changeId: a1.id, reason: "Case-insensitive like the task asks, and keeps data access in db.js as the description says; #" + a3.id + " is case-sensitive." });
  log("rex", `votes for #${a1.id} (kai): follows the task and the db.js convention`);
  standings = r.standings;
  log("loom", `standings: ${standings.map((s) => `#${s.candidate} ${s.weight}`).join(", ")}`);
  if (r.contest.status !== "decided") {
    await nia.req("POST", `/contests/${c.id}/votes`, { changeId: a1.id, reason: "Same reasons as rex: db.search is reusable." });
    log("nia", `votes for #${a1.id} (kai) too`);
  }
  const decided = await waitFor("the contest to be decided", async () => {
    const v = await jo.req("GET", `/contests/${c.id}`);
    return v.contest.status === "decided" && v;
  });
  log("loom", `contest decided: #${decided.contest.winner} wins; the other attempts are closed with their context kept`);
  await merged(kai, decided.contest.winner);
  log("kai", `#${decided.contest.winner} landed`);

  // ── 3. notes ────────────────────────────────────────────────────────────
  await pause(1);
  const t4 = await jo.createTask("Add a done filter", "GET ?done=1 returns only completed todos");
  const claim = await nia.claim(t4.id);
  const intent = await nia.intent(t4.id, ["src/db.js", "src/routes/todos.js"], "Add a done filter");
  for (const n of intent.memory.notes) log("nia", `memory: note #${n.id} by ${n.byName} (${n.kind}): “${n.text}”`);
  for (const d of intent.memory.decisions.filter((d) => d.kind === "contest")) log("nia", `memory: ${d.decision.slice(0, 140)}…`);
  if (intent.memory.notes[0]) {
    await nia.req("POST", `/notes/${intent.memory.notes[0].id}/votes`, { agree: true, comment: "Followed it: db.done() next to db.search()." });
    log("nia", `confirms note #${intent.memory.notes[0].id}`);
  }
  const ws = claim.workspace.name;
  await nia.write(ws, {
    "src/db.js": (await nia.read("src/db.js", ws)) + "\nexport function done() {\n  return list().filter((t) => t.done);\n}\n",
    "src/routes/todos.js": (await nia.read("src/routes/todos.js", ws)).replace('    const q = url.searchParams.get("q");', '    if (url.searchParams.get("done")) return json(db.done());\n    const q = url.searchParams.get("q");'),
  }, "Add ?done=1");
  const c4 = await nia.submit(t4.id, t4.title, "Add db.done() and ?done=1", { tested: ["?done=1"] });
  await rex.review(c4.id, "approve", "Follows the db.js convention.");
  await merged(nia, c4.id);
  log("nia", `#${c4.id} landed`);

  console.log("\nTrack records now:");
  for (const name of ["kai", "lou", "mo", "nia", "rex", "ivy", "sam"]) {
    const t = await admin.req("GET", `/agents/${ids[name]}/trust`);
    console.log(`  ${name.padEnd(4)} ${String(t.weight).padEnd(5)} ${t.summary}`);
  }
  const s = await admin.state();
  console.log(`\nDone. main is v${s.project.mainVersion}. Why each change landed is in git notes: git fetch origin refs/notes/loom:refs/notes/loom && git log --notes=loom`);
}

main().catch((e) => { console.error(e); process.exit(1); });
