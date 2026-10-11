#!/usr/bin/env node
// Checks in the merge queue, scripted: two changes that each pass the tests
// and merge cleanly, but break main together.
//
//   LOOM_URL=http://127.0.0.1:8787 LOOM_ADMIN_TOKEN=dev-admin node demo/checks.mjs [project]
//
// ada renames greet() to hello() and updates every caller. bex, at the same
// time, adds shout(), which calls greet(). The files don't overlap, so git
// merges them cleanly, and each passes `node --test` on its own. Loom runs the
// tests on main with both changes before main moves: ada's lands, bex's fails
// on top of it and goes back to bex with the output. bex fixes it and lands.

import { Loom, sleep } from "./client.mjs";

const BASE = process.env.LOOM_URL ?? "http://127.0.0.1:8787";
const ADMIN = process.env.LOOM_ADMIN_TOKEN ?? "dev-admin";
const PROJECT = process.argv[2] ?? `checks-${Date.now().toString(36).slice(-5)}`;
const log = (who, msg) => console.log(`${new Date().toISOString().slice(11, 19)}  ${who.padEnd(5)} ${msg}`);

const FILES = {
  "README.md": "# greeter\n\nA tiny library, tested with `node --test`.\n",
  "package.json": JSON.stringify({ name: "greeter", type: "module", scripts: { test: "node --test" } }, null, 2) + "\n",
  "lib.js": 'export function greet(name) {\n  return `hello ${name}`;\n}\n',
  "lib.test.js": 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { greet } from "./lib.js";\n\ntest("greet", () => assert.equal(greet("ada"), "hello ada"));\n',
};

async function waitFor(what, check, seconds = 180) {
  for (let i = 0; i < seconds * 2; i++) {
    const v = await check();
    if (v) return v;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function main() {
  const admin = new Loom(BASE, PROJECT, ADMIN);
  await admin.createProject({ name: PROJECT, description: "Checks in the merge queue: two clean merges that break main together", files: FILES, requiredApprovals: 1, checks: { command: "node --test", timeoutSec: 120 } });
  console.log(`project ${PROJECT}: watch at ${BASE}/?project=${PROJECT}`);
  const add = async (name, role) => admin.as((await admin.addAgent(name, role)).key);
  const [ada, bex, rex] = [await add("ada", "builder"), await add("bex", "builder"), await add("rex", "reviewer")];

  const t1 = await ada.createTask("Rename greet to hello", "hello() reads better at call sites. Update every caller.");
  const t2 = await bex.createTask("Add shout()", "shout(name) returns the greeting in capitals.");

  // Both agents work at the same time, on different files.
  const ws1 = (await ada.claim(t1.id)).workspace.name;
  const ws2 = (await bex.claim(t2.id)).workspace.name;
  await ada.intent(t1.id, ["lib.js", "lib.test.js"], "rename greet to hello");
  await bex.intent(t2.id, ["shout.js", "shout.test.js"], "add shout()");
  await ada.write(ws1, {
    "lib.js": (await ada.read("lib.js", ws1)).replace("greet(name)", "hello(name)"),
    "lib.test.js": (await ada.read("lib.test.js", ws1)).replaceAll("greet", "hello"),
  }, "Rename greet to hello");
  await bex.write(ws2, {
    "shout.js": 'import { greet } from "./lib.js";\n\nexport const shout = (name) => greet(name).toUpperCase();\n',
    "shout.test.js": 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { shout } from "./shout.js";\n\ntest("shout", () => assert.equal(shout("bex"), "HELLO BEX"));\n',
  }, "Add shout()");

  for (const [agent, name, task] of [[ada, "ada", t1], [bex, "bex", t2]]) {
    const r = await agent.req("POST", `/tasks/${task.id}/checks`);
    log(name, `run_checks on its own change: ${r.ok ? "pass" : "FAIL"} (${r.runner}, ${r.ms} ms)`);
  }
  const c1 = await ada.submit(t1.id, t1.title, "Rename greet() to hello() and update the test", { tested: ["node --test passes"] });
  const c2 = await bex.submit(t2.id, t2.title, "Add shout() on top of greet()", { tested: ["node --test passes"] });
  log("ada", `submitted #${c1.id}`);
  log("bex", `submitted #${c2.id}`);
  await rex.review(c1.id, "approve", "Rename is complete: lib.js and its test.");
  await rex.review(c2.id, "approve", "Small and tested.");
  log("rex", `approved #${c1.id} and #${c2.id}: both merge cleanly`);

  const failed = await waitFor(`#${c2.id} to be checked`, async () => {
    const [a, b] = [await admin.change(c1.id), await admin.change(c2.id)];
    return a.status === "merged" && b.status === "checks_failed" && b;
  });
  log("loom", `#${c1.id} landed; #${c2.id} merges cleanly but fails the tests on main with #${c1.id}, so it goes back to bex:`);
  for (const line of failed.checks.output.split("\n").filter((l) => /not ok|SyntaxError|does not provide|error/i.test(l)).slice(0, 3)) console.log(`         ${line.trim()}`);

  const sync = await bex.req("POST", `/tasks/${t2.id}/sync`, {});
  log("bex", `synced with main (${sync.conflicts?.length ? "conflicts" : "clean"}); greet is hello now`);
  await bex.write(ws2, { "shout.js": (await bex.read("shout.js", ws2)).replaceAll("greet", "hello") }, "Use hello()");
  const again = await bex.req("POST", `/tasks/${t2.id}/checks`);
  log("bex", `run_checks: ${again.ok ? "pass" : "FAIL"}`);
  await bex.update(c2.id, "Add shout() on top of hello()");
  await rex.review(c2.id, "approve", "Fixed for the rename.");
  await waitFor(`#${c2.id} to land`, async () => (await admin.change(c2.id)).status === "merged");
  log("bex", `#${c2.id} landed; main passes its tests`);
  const s = await admin.state();
  console.log(`\nDone. main is v${s.project.mainVersion}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
