#!/usr/bin/env node
// Code review with agents, scripted: three changes waiting on review, each
// with a different brief, and a review that goes back and forth in threads.
//
//   LOOM_URL=http://127.0.0.1:8787 LOOM_ADMIN_TOKEN=dev-admin node demo/review.mjs [project]
//
// ada adds due dates with tests. rex asks for two fixes in line comments; ada
// fixes one and resolves it, and answers the other in its thread. bex, at the
// same time, adds rate limiting in the routes and reaches into db.js, which it
// never declared and ada is working on, without tests: the brief says a person
// should look. cyd's README fix is left to the agents.

import { Loom } from "./client.mjs";
import { SEED } from "./seed.mjs";

const BASE = process.env.LOOM_URL ?? "http://127.0.0.1:8787";
const ADMIN = process.env.LOOM_ADMIN_TOKEN ?? "dev-admin";
const PROJECT = process.argv[2] ?? `review-${Date.now().toString(36).slice(-5)}`;
const log = (who, msg) => console.log(`${new Date().toISOString().slice(11, 19)}  ${who.padEnd(5)} ${msg}`);
const lineOf = (text, needle) => text.split("\n").findIndex((l) => l.includes(needle)) + 1;

async function main() {
  const admin = new Loom(BASE, PROJECT, ADMIN);
  await admin.createProject({ name: PROJECT, description: "Code review with agents: briefs, threads, and what changed since", files: SEED, requiredApprovals: 1 });
  console.log(`project ${PROJECT}: watch at ${BASE}/?project=${PROJECT}`);
  const add = async (name, role) => admin.as((await admin.addAgent(name, role)).key);
  const [ada, bex, cyd, rex] = [await add("ada", "builder"), await add("bex", "builder"), await add("cyd", "builder"), await add("rex", "reviewer")];

  // ada: due dates, with tests.
  const t1 = await ada.createTask("Add due dates to todos", "Optional ISO due date; list overdue ones.");
  const ws1 = (await ada.claim(t1.id)).workspace.name;
  await ada.intent(t1.id, ["src/db.js", "test/"], "due dates in the store, with tests");
  const db = SEED["src/db.js"]
    .replace("const record = { id, title: todo.title, done: false };", "const record = { id, title: todo.title, done: false, due: todo.due };")
    .concat(`
export function overdue(now) {
  return list().filter((t) => !t.done && t.due && t.due < now);
}
`);
  const test1 = `import { test } from "node:test";
import assert from "node:assert/strict";
import { save, overdue } from "../src/db.js";

test("overdue lists open todos past their due date", () => {
  save({ title: "late", due: "2026-01-01" });
  save({ title: "later", due: "2999-01-01" });
  assert.deepEqual(overdue("2026-06-01").map((t) => t.title), ["late"]);
});
`;
  await ada.write(ws1, { "src/db.js": db, "test/db.test.js": test1 }, "Due dates and overdue()");
  const c1 = await ada.submit(t1.id, "Add due dates to todos", "Todos take an optional ISO due date; overdue(now) lists open ones past it.", { plan: ["store due on save", "overdue(now) in db.js", "test it"], tested: ["node --test test/db.test.js"] });
  log("ada", `submitted #${c1.id}`);

  const r1 = await rex.review(c1.id, "request_changes", "Two things before this lands.", [
    { path: "src/db.js", line: lineOf(db, "due: todo.due"), body: "Store null when there's no due date, so every record has the key (we decided optional fields are null, not missing)." },
    { path: "src/db.js", line: lineOf(db, "t.due < now"), body: "Comparing strings works for ISO dates, but say so: add a comment, or compare Date values." },
  ]);
  log("rex", `requested changes on #${c1.id} with ${r1.threads.length} threads`);

  const db2 = db.replace("due: todo.due };", "due: todo.due ?? null };");
  await ada.write(ws1, { "src/db.js": db2 }, "Store null for a missing due date");
  await ada.update(c1.id, "Todos take an optional ISO due date (null when absent); overdue(now) lists open ones past it.");
  await ada.req("POST", `/threads/${r1.threads[0]}/resolve`, { body: "Done: due is null when absent." });
  await ada.req("POST", `/threads/${r1.threads[1]}/posts`, { body: "ISO strings compare correctly by design, and the API only accepts ISO dates, so I'd rather not convert. I'll add the comment if you still want it." });
  log("ada", `fixed one thread, answered the other`);

  // bex: rate limiting, reaching into db.js (ada's file) and no tests.
  const t2 = await bex.createTask("Rate limit writes", "At most 30 writes a minute per client.");
  const ws2 = (await bex.claim(t2.id)).workspace.name;
  await bex.intent(t2.id, ["src/routes/"], "rate limit in the routes");
  const routes = SEED["src/routes/todos.js"].replace(`  if (req.method === "POST") {
    const body = req.body;`, `  if (req.method === "POST") {
    if (!allow(req.headers?.["x-client"] ?? "anon")) return json({ error: "slow down" }, 429);
    const body = req.body;`).concat(`
const hits = new Map();
function allow(client, now = Date.now()) {
  const recent = (hits.get(client) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(client, recent);
  return recent.length <= 30;
}
`);
  const bexDb = SEED["src/db.js"].replace("export function list() {", "export function count() {\n  return todos.size;\n}\n\nexport function list() {");
  await bex.write(ws2, { "src/routes/todos.js": routes, "src/db.js": bexDb }, "Rate limit POST");
  const c2 = await bex.submit(t2.id, "Rate limit writes", "POST is limited to 30 a minute per client.", { plan: ["sliding window per client in the route"], tested: ["by hand"] });
  log("bex", `submitted #${c2.id}`);

  // cyd: a README fix.
  const t3 = await cyd.createTask("Document the API", "");
  const ws3 = (await cyd.claim(t3.id)).workspace.name;
  await cyd.intent(t3.id, ["README.md"], "API docs");
  await cyd.write(ws3, { "README.md": SEED["README.md"] + "\n## API\n\n- `GET /` lists todos\n- `POST /` adds one\n- `PATCH /?id=` completes one\n" }, "Document the API");
  const c3 = await cyd.submit(t3.id, "Document the API", "The three routes, in the README.", { tested: ["read it"] });
  log("cyd", `submitted #${c3.id}`);

  for (const c of [c1, c2, c3]) {
    const d = await admin.change(c.id);
    log("brief", `#${c.id} ${d.brief.verdict}`);
  }
  console.log(`Done. Review them at ${BASE}/?project=${PROJECT}#change/${c1.id}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
