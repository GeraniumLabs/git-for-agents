#!/usr/bin/env node
// A runner for a Mergery project: waits for work an agent could pick up, and
// starts an agent for it. Mergery doesn't run agents; this does, on any machine
// with Node 20 and the agent CLI you use.
//
//   MERGERY_PROJECT=my-app MERGERY_KEY=... node recipes/runner.mjs
//
// MERGERY_KEY is an agent key for the project (trade a join code for one:
// POST /api/projects/<project>/join {"code", "name"}). Optional:
//   MERGERY_URL=…       a Mergery other than https://mergery.dev
//   MERGERY_MAX=2       agents running at once (each gets its own name under the key: runner-1, runner-2, …)
//   MERGERY_RUN='…'     the command that starts one, run by sh with MERGERY_PROMPT, MERGERY_MCP_CONFIG and MERGERY_AGENT set.
//                       Default: claude -p "$MERGERY_PROMPT" --mcp-config "$MERGERY_MCP_CONFIG" --allowedTools mcp__mergery
//   --once              check once, start what's needed, wait for those agents, and exit (for cron)
// The older LOOM_* names still work.

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const env = (name) => process.env[`MERGERY_${name}`] || process.env[`LOOM_${name}`];
const SERVER = env("URL") || "https://mergery.dev", PROJECT = env("PROJECT"), KEY = env("KEY");
if (!PROJECT || !KEY) {
  console.error("set MERGERY_PROJECT and MERGERY_KEY (and MERGERY_URL for a Mergery other than mergery.dev)");
  process.exit(1);
}
const MAX = Math.max(1, Number(env("MAX") ?? 2));
const RUN = env("RUN") ?? 'claude -p "$MERGERY_PROMPT" --mcp-config "$MERGERY_MCP_CONFIG" --allowedTools mcp__mergery';
const once = process.argv.includes("--once");
const base = SERVER.replace(/\/$/, "");
const dir = mkdtempSync(join(tmpdir(), "mergery-runner-"));
const running = new Map(); // agent name -> child

/** One MCP config per agent name, so each run is its own agent under the key. */
function mcpConfig(agent) {
  const file = join(dir, `${agent}.json`);
  writeFileSync(file, JSON.stringify({ mcpServers: { mergery: { type: "http", url: `${base}/mcp/${PROJECT}`, headers: { Authorization: `Bearer ${KEY}`, "X-Loom-Agent": agent } } } }), { mode: 0o600 });
  return file;
}

/** What the agent's command sees, under both names, so a LOOM_RUN written for the old names keeps working. */
function runEnv(prompt, config, agent) {
  const v = { PROMPT: prompt, MCP_CONFIG: config, AGENT: agent };
  return { ...process.env, ...Object.fromEntries(Object.entries(v).flatMap(([k, x]) => [[`MERGERY_${k}`, x], [`LOOM_${k}`, x]])) };
}

function start(prompt) {
  const agent = Array.from({ length: MAX }, (_, i) => `runner-${i + 1}`).find((n) => !running.has(n));
  if (!agent) return false;
  console.log(`${new Date().toISOString()} starting ${agent}`);
  const child = spawn("sh", ["-c", RUN], { stdio: "inherit", env: runEnv(prompt, mcpConfig(agent), agent) });
  running.set(agent, child);
  child.on("exit", (code) => { running.delete(agent); console.log(`${new Date().toISOString()} ${agent} finished (${code})`); });
  return true;
}

async function work(known, wait) {
  const q = new URLSearchParams({ wait: String(wait), ...(known !== null ? { known } : {}) });
  const res = await fetch(`${base}/api/projects/${PROJECT}/work?${q}`, { headers: { authorization: `Bearer ${KEY}` } });
  if (!res.ok) throw new Error(`GET /work: ${res.status} ${await res.text()}`);
  return res.json();
}

let known = null;
for (;;) {
  let w;
  try {
    w = await work(known, once ? 0 : 25);
  } catch (e) {
    console.error(String(e?.message ?? e));
    if (once) process.exit(1);
    await new Promise((r) => setTimeout(r, 30_000));
    continue;
  }
  // The first look starts agents for everything waiting; after that, only for what's new.
  const waiting = known === null ? w.items.length : w.newCount;
  known = w.known;
  for (let i = 0; i < Math.min(waiting, MAX); i++) if (!start(w.prompt)) break;
  if (once) break;
}
if (once) await Promise.all([...running.values()].map((c) => new Promise((r) => c.on("exit", r))));
