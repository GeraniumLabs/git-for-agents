#!/usr/bin/env node
// Real Claude agents working one Loom project at the same time. Each agent
// talks to Loom only through its MCP endpoint (POST /mcp/<project>), exactly
// as any MCP-capable agent would. Needs ANTHROPIC_API_KEY (or an `ant auth login` profile).
//
//   LOOM_URL=http://127.0.0.1:8787 LOOM_ADMIN_TOKEN=dev-admin \
//     node demo/claude-swarm.mjs [--project name] [--builders 3] [--reviewers 2]
//       [--contest] [--model claude-opus-5-5] [--effort medium] [--budget 5]
//       [--max-turns 60] [--check]
//
// Without --project it creates a fresh project seeded from the todo service
// and a backlog of overlapping tasks. --contest makes the search task a
// contest: three attempts, and the agents vote on which one lands.
// --budget stops every agent once the run has spent that many dollars.
// --check connects each agent over MCP and lists its tools without calling
// Claude, to test the setup for free.

import Anthropic from "@anthropic-ai/sdk";
import { Loom } from "./client.mjs";

const BASE = process.env.LOOM_URL ?? "http://127.0.0.1:8787";
const ADMIN = process.env.LOOM_ADMIN_TOKEN ?? "dev-admin";
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes(`--${n}`);
const MODEL = arg("model", process.env.CLAUDE_MODEL ?? "claude-opus-5-5");
const EFFORT = arg("effort", "medium");
const BUILDERS = Number(arg("builders", 3));
const REVIEWERS = Number(arg("reviewers", 2));
const MAX_TURNS = Number(arg("max-turns", 60));
const BUDGET = Number(arg("budget", 10));
const CONTEST = flag("contest");
const CHECK = flag("check");
/** Tool results longer than this are cut, so one big read can't bloat every later turn. */
const MAX_RESULT = 20_000;

/** Dollars per million tokens. Cache writes cost 1.25x input; reads are the cache-read rate. */
const PRICES = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
};

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
function spent() {
  const p = PRICES[MODEL] ?? PRICES["claude-opus-5-5"];
  return (usage.input * p.input + usage.cacheWrite * p.input * 1.25 + usage.cacheRead * p.cacheRead + usage.output * p.output) / 1e6;
}
function count(u) {
  usage.calls++;
  usage.input += u.input_tokens ?? 0;
  usage.output += u.output_tokens ?? 0;
  usage.cacheRead += u.cache_read_input_tokens ?? 0;
  usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
}

let client;

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
  if (CHECK) { log(agent.name, `connected over MCP; ${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`); return; }
  const system = `You are ${agent.name}, a ${agent.role} agent on the Loom project "${project}", working alongside other agents at the same time. Your agent id is ${agent.id}.

${init.instructions}

${goal}

How to work here:
- Work autonomously. Keep each file edit minimal and focused on your task.
- Always declare intent before editing. Read the memory it returns: decisions and notes other agents left about these files. Follow them, and confirm or dispute a note with rate_note once you have relied on it.
- If a tool reports a collision forecast, message the other agent and agree who does what.
- When main moves under you (workspace.stale) or your change conflicts, sync and resolve by keeping both agents' intent.
- When you submit, put what you planned, tested and decided in the context. If you learned something the next agent on these files should know (a convention, a trap), add it to context.notes; it becomes the project's when your change lands.
- Your approvals and votes are weighed by how your earlier ones turned out (my_track_record shows yours). Approve only what you have read closely.
- When you have nothing left to do, reply with a one-line summary and stop.`;

  const messages = [{ role: "user", content: "Begin." }];
  const toolDefs = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (spent() >= BUDGET) { log(agent.name, `stopping: the run has spent $${spent().toFixed(2)} of its $${BUDGET} budget`); return; }
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: EFFORT },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      // Every turn resends the system prompt, the ~40 tool definitions and the
      // conversation so far; caching reprices all of that at the cache-read rate.
      cache_control: { type: "ephemeral" },
      system,
      tools: toolDefs,
      messages,
    });
    count(response.usage ?? {});
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "refusal") { log(agent.name, "declined to continue"); return; }
    for (const b of response.content) if (b.type === "text" && b.text.trim()) log(agent.name, b.text.trim().split("\n")[0].slice(0, 160));
    if (response.stop_reason !== "tool_use") return;

    const calls = response.content.filter((b) => b.type === "tool_use");
    const results = await Promise.all(calls.map(async (call) => {
      log(agent.name, `→ ${call.name} ${JSON.stringify(call.input).slice(0, 100)}`);
      try {
        const r = await mcp.rpc("tools/call", { name: call.name, arguments: call.input });
        return { type: "tool_result", tool_use_id: call.id, content: cap(r.content.map((c) => c.text).join("\n")), is_error: !!r.isError };
      } catch (e) {
        return { type: "tool_result", tool_use_id: call.id, content: String(e.message ?? e), is_error: true };
      }
    }));
    messages.push({ role: "user", content: results });
  }
  log(agent.name, `stopped after ${MAX_TURNS} turns`);
}

const cap = (text) => text.length <= MAX_RESULT ? text : `${text.slice(0, MAX_RESULT)}\n[cut at ${MAX_RESULT} characters; read a narrower range or a single file]`;

async function main() {
  if (!CHECK) client = new Anthropic();
  const log = (who, msg) => console.log(`${new Date().toISOString().slice(11, 19)}  ${who.padEnd(6)} ${msg}`);
  let project = arg("project");
  const admin = new Loom(BASE, project ?? "", ADMIN);
  if (!project) {
    const { SEED } = await import("./seed.mjs");
    project = `claude-${Date.now().toString(36).slice(-5)}`;
    admin.project = project;
    await admin.createProject({ name: project, description: "A tiny todo service, built by Claude agents", files: SEED, requiredApprovals: REVIEWERS ? 1 : 0 });
    await admin.req("POST", "/settings", { approvalMode: "weighted" }).catch(() => {});
    for (const [title, desc] of BACKLOG) await admin.createTask(title, desc);
    if (CONTEST) {
      const t = await admin.req("POST", "/tasks", { title: "Search todos by title", description: "GET ?q=text returns the todos whose title contains text, ignoring case.", attempts: 3 });
      console.log(`contest: task #${t.id}, 3 attempts; the agents vote on which lands`);
    }
  }
  console.log(`project ${project}: watch at ${BASE}/?project=${project}`);

  const names = ["ada", "bex", "cyd", "dax", "eli", "fay", "gus", "hal"];
  const agents = [];
  for (let i = 0; i < BUILDERS; i++) agents.push(await admin.addAgent(names[i], "builder"));
  for (let i = 0; i < REVIEWERS; i++) agents.push(await admin.addAgent(["rex", "rio", "ria"][i], "reviewer"));

  const builderGoal = "Your job: claim an unclaimed task (status open), complete it, submit it with your working context, and see it through review and merge. Then take another open task. A task with several attempts is a contest: claim it like any task and you get your own attempt; do your best version, independently. Stop when no open tasks remain and your changes are merged.";
  const reviewerGoal = "Your job: review changes with status 'review'. Read each with get_change. Approve when the patch does what the task asks and stays within declared intent; otherwise request changes with specific comments. When a contest is ready (contest.ready, or listed by me), call compare_attempts, read every attempt, and vote for the one that best does what the task asks, with a reason. Use wait_for_events to wait for new work. Stop when every task is merged.";
  await Promise.all(agents.map((a) => runAgent(project, a, a.role === "reviewer" ? reviewerGoal : builderGoal, log).catch((e) => log(a.name, `error: ${e.message}`))));

  if (CHECK) return;
  const s = await admin.state();
  console.log(`\nDone. merged ${s.changes.filter((c) => c.status === "merged").length} changes; main v${s.project.mainVersion}.`);
  console.log(`${usage.calls} model calls on ${MODEL} at effort ${EFFORT}: ${usage.input} input, ${usage.cacheWrite} cache-write, ${usage.cacheRead} cache-read and ${usage.output} output tokens, about $${spent().toFixed(2)}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
