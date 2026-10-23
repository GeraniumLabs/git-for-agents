#!/usr/bin/env node
// A runner for a Loom project: waits for work an agent could pick up, and
// starts an agent for it. Loom doesn't run agents; this does, on any machine
// with Node 20 and the agent CLI you use.
//
//   LOOM_URL=https://loom.example.dev LOOM_PROJECT=my-app LOOM_KEY=... node recipes/runner.mjs
//
// LOOM_KEY is an agent key for the project (trade a join code for one:
// POST /api/projects/<project>/join {"code", "name"}). Optional:
//   LOOM_MAX=2       agents running at once (each gets its own name under the key: runner-1, runner-2, …)
//   LOOM_RUN='…'     the command that starts one, run by sh with LOOM_PROMPT, LOOM_MCP_CONFIG and LOOM_AGENT set.
//                    Default: claude -p "$LOOM_PROMPT" --mcp-config "$LOOM_MCP_CONFIG" --allowedTools mcp__loom
//   --once           check once, start what's needed, wait for those agents, and exit (for cron)

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { LOOM_URL, LOOM_PROJECT, LOOM_KEY } = process.env;
if (!LOOM_URL || !LOOM_PROJECT || !LOOM_KEY) {
  console.error("set LOOM_URL, LOOM_PROJECT and LOOM_KEY");
  process.exit(1);
}
const MAX = Math.max(1, Number(process.env.LOOM_MAX ?? 2));
const RUN = process.env.LOOM_RUN ?? 'claude -p "$LOOM_PROMPT" --mcp-config "$LOOM_MCP_CONFIG" --allowedTools mcp__loom';
const once = process.argv.includes("--once");
const base = LOOM_URL.replace(/\/$/, "");
const dir = mkdtempSync(join(tmpdir(), "loom-runner-"));
const running = new Map(); // agent name -> child

/** One MCP config per agent name, so each run is its own agent under the key. */
function mcpConfig(agent) {
  const file = join(dir, `${agent}.json`);
  writeFileSync(file, JSON.stringify({ mcpServers: { loom: { type: "http", url: `${base}/mcp/${LOOM_PROJECT}`, headers: { Authorization: `Bearer ${LOOM_KEY}`, "X-Loom-Agent": agent } } } }), { mode: 0o600 });
  return file;
}

function start(prompt) {
  const agent = Array.from({ length: MAX }, (_, i) => `runner-${i + 1}`).find((n) => !running.has(n));
  if (!agent) return false;
  console.log(`${new Date().toISOString()} starting ${agent}`);
  const child = spawn("sh", ["-c", RUN], { stdio: "inherit", env: { ...process.env, LOOM_PROMPT: prompt, LOOM_MCP_CONFIG: mcpConfig(agent), LOOM_AGENT: agent } });
  running.set(agent, child);
  child.on("exit", (code) => { running.delete(agent); console.log(`${new Date().toISOString()} ${agent} finished (${code})`); });
  return true;
}

async function work(known, wait) {
  const q = new URLSearchParams({ wait: String(wait), ...(known !== null ? { known } : {}) });
  const res = await fetch(`${base}/api/projects/${LOOM_PROJECT}/work?${q}`, { headers: { authorization: `Bearer ${LOOM_KEY}` } });
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
