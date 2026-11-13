#!/usr/bin/env node
// Load test: N simulated agents work on one project at once, through the same
// HTTP API real agents use. Each claims a task, declares its intent, edits
// through the API, submits, and waits on its event stream (long-poll), syncing
// and re-applying its edit when main moves under it. A pool of reviewers
// approves whatever reaches review. Prints where time goes.
//
//   LOOM_URL=http://127.0.0.1:8787 node demo/load.mjs --agents 200 [--share 0.3] [--reviewers 5] [--private]
//     [--repo-files 5000 --repo-mb 50]   a bigger codebase: filler files besides the ones agents edit
//     [--json bench/results/run.json --label "local, 200 agents"]   save the numbers for the benchmark page
//
// Numbers from `wrangler dev` are only indicative; production Durable Objects
// and Artifacts behave differently.

import { Loom, sleep } from "./client.mjs";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const BASE = process.env.LOOM_URL ?? "http://127.0.0.1:8787";
const ADMIN = process.env.LOOM_ADMIN_TOKEN ?? "dev-admin";
const N = Number(arg("agents", 100));
const SHARE = Number(arg("share", 0.3)); // fraction of agents editing a shared file
const REVIEWERS = Number(arg("reviewers", Math.max(2, Math.ceil(N / 40))));
const RAMP = Number(arg("ramp", 10)); // seconds over which agents start
const AREAS = ["api", "auth", "billing", "db", "jobs", "search", "ui", "util"];
const FILES_PER_AREA = 5;
const SLOTS = 60;
const PROJECT = arg("project", `load-${N}-${Date.now().toString(36).slice(-4)}`);
const REPO_FILES = Number(arg("repo-files", 0));
const REPO_MB = Number(arg("repo-mb", 0));
const JSON_OUT = arg("json", null);
const LABEL = arg("label", null);

// A codebase with a few shared files per area, each with many independent slots.
function seed() {
  const files = { "README.md": "# load test\n" };
  for (const a of AREAS) {
    for (let f = 0; f < FILES_PER_AREA; f++) {
      let s = `// ${a}/mod${f}.js\n`;
      for (let i = 0; i < SLOTS; i++) s += `\n// slot ${i}\nexport const s${i} = 0;\n`;
      files[`src/${a}/mod${f}.js`] = s;
    }
  }
  // Filler, so the repository is as big as asked: many files, about REPO_MB in all.
  if (REPO_FILES) {
    const each = Math.max(64, Math.floor((REPO_MB * 1024 * 1024) / REPO_FILES));
    for (let i = 0; i < REPO_FILES; i++) {
      const lines = [`// lib/pkg${i % 50}/f${i}.js`];
      while (lines.join("\n").length < each) lines.push(`export function f${i}_${lines.length}(x) { return x + ${lines.length}; }`);
      files[`lib/pkg${i % 50}/f${i}.js`] = lines.join("\n") + "\n";
    }
  }
  return files;
}

// ── measurement ─────────────────────────────────────────────────────────
const lat = {};
const errors = {};
const counts = { conflicts: 0, syncs: 0, stale: 0, retries: 0, busy: 0 };
async function timed(label, fn) {
  const t = performance.now();
  try {
    return await fn();
  } catch (e) {
    // 409 is backpressure ("being merged right now", "held by"), and the caller retries.
    if (e.status === 409) counts.busy++;
    else errors[label] = (errors[label] ?? 0) + 1;
    throw e;
  } finally {
    (lat[label] ??= []).push(performance.now() - t);
  }
}
const pct = (xs, p) => {
  if (!xs?.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const fmt = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);

// ── one simulated agent ─────────────────────────────────────────────────
async function agent(admin, k, key, taskId, done) {
  const me = admin.as(key.key);
  const area = AREAS[k % AREAS.length];
  const shared = (k * 7919) % 100 < SHARE * 100;
  const path = shared ? `src/${area}/mod${k % FILES_PER_AREA}.js` : `src/${area}/agent${k}.js`;
  const slot = Math.floor(k / (AREAS.length * FILES_PER_AREA)) % SLOTS;
  const edit = (s) => (shared ? s.replace(`export const s${slot} = 0;`, `export const s${slot} = ${k + 1};`) : `export const owner = "agent${k}";\n`);
  const t0 = performance.now();

  const claim = await withRetry(() => timed("claim", () => me.claim(taskId)));
  await withRetry(() => timed("intent", () => me.intent(taskId, [path], `agent ${k} edits ${path}`)));
  const current = shared ? await timed("read", () => me.read(path, claim.workspace.name)) : "";
  await withRetry(() => timed("commit", () => me.write(claim.workspace.name, { [path]: edit(current) }, `agent ${k}`)));
  const change = await withRetry(() => timed("submit", () => me.submit(taskId, `agent ${k}`, `edit ${path}`, { plan: ["one edit"] })));
  const submitted = performance.now();

  // Wait on my own event stream, as a real agent should.
  let cursor = (await timed("events", () => me.events(0, 0))).cursor;
  for (;;) {
    const { events, cursor: next } = await timed("events", () => me.req("GET", `/events?after=${cursor}&wait=20&agent=${key.id}&mine=${process.env.ALL_EVENTS ? 0 : 1}`));
    cursor = next;
    for (const e of events) {
      if (e.change_id === change.id && e.type === "change.merged") {
        done.push({ k, total: performance.now() - t0, toMerge: performance.now() - submitted });
        return;
      }
      const mine = e.to_agent === key.id;
      if (mine && (e.type === "change.conflict" || e.type === "workspace.stale")) {
        if (e.type === "change.conflict") counts.conflicts++; else counts.stale++;
        await resolve(me, taskId, path, edit);
      }
    }
  }
}

async function resolve(me, taskId, path, edit) {
  for (let i = 0; i < 5; i++) {
    try {
      counts.syncs++;
      const r = await timed("sync", () => me.sync(taskId));
      if (r.status !== "conflict") return;
      const main = await me.read(path);
      await timed("sync", () => me.sync(taskId, { [path]: edit(main) }));
      return;
    } catch (e) {
      if (e.status !== 409) throw e;
      counts.retries++;
      await sleep(200 + Math.random() * 400);
    }
  }
}

async function withRetry(fn) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= 4 || (e.status && e.status < 500 && e.status !== 409 && e.status !== 429)) throw e;
      counts.retries++;
      await sleep(300 * 2 ** i);
    }
  }
}

async function reviewer(admin, key, stop, index) {
  const me = admin.as(key.key);
  let cursor = 0;
  const seen = new Set();
  while (!stop.value) {
    const { events, cursor: next } = await timed("events", () => me.req("GET", `/events?after=${cursor}&wait=10&agent=${key.id}&mine=1`)).catch(() => ({ events: [], cursor }));
    cursor = next;
    for (const e of events) {
      if (!["review.requested", "change.updated"].includes(e.type) || !e.change_id) continue;
      if (e.change_id % REVIEWERS !== index) continue; // one reviewer per change
      const k = `${e.change_id}:${e.seq}`;
      if (seen.has(k)) continue;
      seen.add(k);
      // Retry once: a dropped connection shouldn't strand a change in review.
      timed("review", () => me.review(e.change_id, "approve", "ok"))
        .catch(() => sleep(1000).then(() => timed("review", () => me.review(e.change_id, "approve", "ok")))).catch(() => {});
    }
  }
}

async function main() {
  const admin = new Loom(BASE, PROJECT, ADMIN);
  console.log(`project ${PROJECT}: ${N} agents, ${REVIEWERS} reviewers, ${Math.round(SHARE * 100)}% on shared files. Watch: ${BASE}/?project=${PROJECT}`);
  const files = seed();
  const created = performance.now();
  if (REPO_FILES > 2000) {
    // A big seed goes in as a first commit through a workspace, in batches, like an import would.
    const base = Object.fromEntries(Object.entries(files).filter(([p]) => !p.startsWith("lib/")));
    await admin.createProject({ name: PROJECT, description: `Load test with ${N} agents`, files: base, requiredApprovals: 0, visibility: process.argv.includes("--private") ? "private" : "public" });
    const t = await admin.createTask("Seed the codebase", "");
    const ws = (await admin.claim(t.id)).workspace.name;
    const lib = Object.entries(files).filter(([p]) => p.startsWith("lib/"));
    for (let i = 0; i < lib.length; i += 1000) await admin.write(ws, Object.fromEntries(lib.slice(i, i + 1000)), `seed ${i}`);
    const ch = await admin.submit(t.id, t.title, "seed", {});
    for (let i = 0; i < 600 && (await admin.change(ch.id)).status !== "merged"; i++) await sleep(500);
    await admin.req("POST", "/settings", { requiredApprovals: 1 });
  } else {
    await admin.createProject({ name: PROJECT, description: `Load test with ${N} agents`, files, requiredApprovals: 1, visibility: process.argv.includes("--private") ? "private" : "public" });
  }
  const seeded = performance.now() - created;
  const repoBytes = Object.values(files).reduce((n, f) => n + f.length, 0);
  console.log(`repository: ${Object.keys(files).length} files, ${(repoBytes / 1024 / 1024).toFixed(1)} MB, seeded in ${fmt(seeded)}`);

  const keys = [];
  for (let i = 0; i < N; i += 25) {
    keys.push(...(await Promise.all(Array.from({ length: Math.min(25, N - i) }, (_, j) => admin.addAgent(`a${i + j}`)))));
  }
  const reviewers = await Promise.all(Array.from({ length: REVIEWERS }, (_, i) => admin.addAgent(`rev${i}`, "reviewer")));
  const tasks = [];
  for (let i = 0; i < N; i += 25) {
    tasks.push(...(await Promise.all(Array.from({ length: Math.min(25, N - i) }, (_, j) => admin.createTask(`Task ${i + j}`, `Edit for agent ${i + j}`)))));
  }

  const stop = { value: false };
  const revs = reviewers.map((r, i) => reviewer(admin, r, stop, i));
  const done = [];
  const failed = [];
  const start = performance.now();
  const ticker = setInterval(() => {
    const s = ((performance.now() - start) / 1000).toFixed(0);
    process.stdout.write(`\r${s}s  merged ${done.length}/${N}  conflicts ${counts.conflicts}  stale ${counts.stale}  errors ${Object.values(errors).reduce((a, b) => a + b, 0)}   `);
  }, 1000);
  await Promise.all(keys.map(async (key, k) => {
    await sleep((RAMP * 1000 * k) / N);
    try { await agent(admin, k, key, tasks[k].id, done); } catch (e) { failed.push({ k, error: e.message }); }
  }));
  clearInterval(ticker);
  stop.value = true;
  const wall = (performance.now() - start) / 1000;
  await Promise.race([Promise.all(revs), sleep(12000)]);

  console.log(`\n\n${done.length}/${N} merged in ${wall.toFixed(1)}s  (${((done.length / wall) * 3600).toFixed(0)} merges/hour)`);
  console.log(`conflicts routed ${counts.conflicts}, stale advisories ${counts.stale}, syncs ${counts.syncs}, busy replies ${counts.busy}, retries ${counts.retries}`);
  console.log(`submit → merged: p50 ${fmt(pct(done.map((d) => d.toMerge), 50))}  p95 ${fmt(pct(done.map((d) => d.toMerge), 95))}  max ${fmt(Math.max(0, ...done.map((d) => d.toMerge)))}`);
  console.log("\nrequest latency           p50      p95      max     n");
  for (const [label, xs] of Object.entries(lat)) {
    console.log(`  ${label.padEnd(20)} ${fmt(pct(xs, 50)).padStart(7)}  ${fmt(pct(xs, 95)).padStart(7)}  ${fmt(Math.max(...xs)).padStart(7)}  ${String(xs.length).padStart(5)}`);
  }
  if (Object.keys(errors).length) console.log("errors:", errors);
  if (failed.length) console.log(`${failed.length} agents failed, e.g.`, failed.slice(0, 3));
  if (JSON_OUT) {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    const summary = (xs) => ({ p50: Math.round(pct(xs, 50)), p95: Math.round(pct(xs, 95)), max: Math.round(Math.max(0, ...xs)), n: xs.length });
    const result = {
      label: LABEL ?? `${N} agents`, at: new Date().toISOString(), target: /127\.0\.0\.1|localhost/.test(BASE) ? "local wrangler dev" : "production",
      agents: N, reviewers: REVIEWERS, shared: SHARE, repo: { files: Object.keys(files).length, mb: Math.round((repoBytes / 1024 / 1024) * 10) / 10, seededMs: Math.round(seeded) },
      merged: done.length, failed: failed.length, wallSeconds: Math.round(wall * 10) / 10, mergesPerHour: Math.round((done.length / wall) * 3600),
      submitToMerged: summary(done.map((d) => d.toMerge)), requests: Object.fromEntries(Object.entries(lat).map(([k, xs]) => [k, summary(xs)])),
      conflicts: counts.conflicts, syncs: counts.syncs, retries: counts.retries, errors,
    };
    mkdirSync(dirname(JSON_OUT), { recursive: true });
    writeFileSync(JSON_OUT, JSON.stringify(result, null, 2));
    console.log(`saved ${JSON_OUT}`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
