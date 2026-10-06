#!/usr/bin/env node
// Real Claude agents working one Loom project at the same time. Each agent
// talks to Loom only through its MCP endpoint (POST /mcp/<project>), exactly
// as any MCP-capable agent would. Needs ANTHROPIC_API_KEY (or an `ant auth login` profile).
//
//   LOOM_URL=http://127.0.0.1:8787 LOOM_ADMIN_TOKEN=dev-admin \
//     node demo/claude-swarm.mjs [--project name] [--builders 3] [--reviewers 1]
//
// Without --project it creates a fresh project seeded from demo/swarm.mjs's
// todo service and a backlog of overlapping tasks.

import Anthropic from "@anthropic-ai/sdk";
import { Loom } from "./client.mjs";

const BASE = process.env.LOOM_URL ?? "http://127.0.0.1:8787";
const ADMIN = process.env.LOOM_ADMIN_TOKEN ?? "dev-admin";
const MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-5-5";
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const BUILDERS = Number(arg("builders", 3));
const REVIEWERS = Number(arg("reviewers", 1));
const MAX_TURNS = Number(arg("max-turns", 60));

const client = new Anthropic();

const BACKLOG = [
  ["Add due dates and an overdue filter", "Todos get an optional ISO `due` date. GET with ?overdue=1 returns only overdue, not-done todos."],
  ["Validate new todos", "POST must reject bodies without a non-empty string title (max 200 chars) with a 400 and an error message."],
  ["Rename db.save to db.put and trim titles", "Rename the storage function save() to put() and update callers. Trim whitespace from titles when storing."],
  ["Add tags to todos", "Todos can carry an array of string tags. GET ?tag=x filters by tag."],
  ["Document the API in the README", "Add an API section to README.md describing every endpoint and field."],
];

class McpSession {
  constructor(project, key) {
    this.url = `${BASE}/mcp/${project}`;
    this.key = key;
    this.id = 0;
  }
  async rpc(method, params) {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { authorization: `Bearer ${this.key}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
    });
    const msg = await res.json();
    if (msg.error) throw new Error(msg.error.message);
    return msg.result;
  }
}

async function runAgent(project, agent, goal, log) {
  const mcp = new McpSession(project, agent.key);
  const init = await mcp.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-swarm", version: "0.1.0" } });
  const { tools } = await mcp.rpc("tools/list");
  const system = `You are ${agent.name}, a ${agent.role} agent on the Loom project "${project}", working alongside other agents at the same time. Your agent id is ${agent.id}.

${init.instructions}

${goal}

Work autonomously. Keep each file edit minimal and focused on your task. Always declare intent before editing. If a tool reports a collision forecast, message the other agent and agree who does what. When main moves under you (workspace.stale) or your change conflicts, sync and resolve by keeping both agents' intent. When you have nothing left to do, reply with a one-line summary and stop.`;

  const messages = [{ role: "user", content: "Begin." }];
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: "medium" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system,
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
      messages,
    });
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "refusal") { log(agent.name, "declined to continue"); return; }
    for (const b of response.content) if (b.type === "text" && b.text.trim()) log(agent.name, b.text.trim().split("\n")[0].slice(0, 160));
    if (response.stop_reason !== "tool_use") return;

    const calls = response.content.filter((b) => b.type === "tool_use");
    const results = await Promise.all(calls.map(async (call) => {
      log(agent.name, `→ ${call.name} ${JSON.stringify(call.input).slice(0, 100)}`);
      try {
        const r = await mcp.rpc("tools/call", { name: call.name, arguments: call.input });
        return { type: "tool_result", tool_use_id: call.id, content: r.content.map((c) => c.text).join("\n").slice(0, 60_000), is_error: !!r.isError };
      } catch (e) {
        return { type: "tool_result", tool_use_id: call.id, content: String(e.message ?? e), is_error: true };
      }
    }));
    messages.push({ role: "user", content: results });
  }
  log(agent.name, `stopped after ${MAX_TURNS} turns`);
}

async function main() {
  const log = (who, msg) => console.log(`${new Date().toISOString().slice(11, 19)}  ${who.padEnd(6)} ${msg}`);
  let project = arg("project");
  const admin = new Loom(BASE, project ?? "", ADMIN);
  if (!project) {
    const { SEED } = await import("./seed.mjs");
    project = `claude-${Date.now().toString(36).slice(-5)}`;
    admin.project = project;
    await admin.createProject({ name: project, description: "A tiny todo service, built by Claude agents", files: SEED, requiredApprovals: REVIEWERS ? 1 : 0 });
    for (const [title, desc] of BACKLOG) await admin.createTask(title, desc);
  }
  console.log(`project ${project}: watch at ${BASE}/?project=${project}`);

  const names = ["ada", "bex", "cyd", "dax", "eli", "fay", "gus", "hal"];
  const agents = [];
  for (let i = 0; i < BUILDERS; i++) agents.push(await admin.addAgent(names[i], "builder"));
  for (let i = 0; i < REVIEWERS; i++) agents.push(await admin.addAgent(["rex", "rio", "ria"][i], "reviewer"));

  const builderGoal = "Your job: claim an unclaimed task (status open), complete it, submit it with your working context, and see it through review and merge. Then take another open task. Stop when no open tasks remain and your changes are merged.";
  const reviewerGoal = "Your job: review changes with status 'review'. Read each with get_change. Approve when the patch does what the task asks and stays within declared intent; otherwise request changes with specific comments. Use wait_for_events to wait for new work. Stop when every task is merged.";
  await Promise.all(agents.map((a) => runAgent(project, a, a.role === "reviewer" ? reviewerGoal : builderGoal, log).catch((e) => log(a.name, `error: ${e.message}`))));

  const s = await admin.state();
  console.log(`\nDone. merged ${s.changes.filter((c) => c.status === "merged").length}/${s.tasks.length} tasks; main v${s.project.mainVersion}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
