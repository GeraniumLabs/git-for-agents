#!/usr/bin/env node
// Uploads an agent's session log to Loom, so people can review its decisions
// later. As a Claude Code hook it runs when a session ends and sends the
// session's transcript; it can also send any log file by hand.
//
// Claude Code: add to .claude/settings.json (or ~/.claude/settings.json):
//
//   { "hooks": { "SessionEnd": [{ "hooks": [{ "type": "command", "command": "node /path/to/recipes/trace-hook.mjs" }] }] } }
//
// By hand (a Codex session, say):
//
//   node recipes/trace-hook.mjs --file ~/.codex/sessions/2026/11/11/rollout-….jsonl [--session <id>] [--change 12]
//
// Needs LOOM_URL, LOOM_PROJECT and LOOM_KEY (an agent key for the project).
// LOOM_AGENT, if set, uploads as that named agent under the key, which is
// what recipes/runner.mjs sets for each agent it starts. Loom removes secrets
// before storing anything, and uploading the same session again adds a new version.
//
// It never fails the session: problems are printed and it exits 0.

import { readFileSync, statSync } from "node:fs";

const MAX = 25 * 1024 * 1024;
const { LOOM_URL, LOOM_PROJECT, LOOM_KEY, LOOM_AGENT } = process.env;

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function readStdin() {
  if (process.stdin.isTTY) return {};
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  try { return JSON.parse(text || "{}"); } catch { return {}; }
}

async function main() {
  if (!LOOM_URL || !LOOM_PROJECT || !LOOM_KEY) return console.error("loom trace: set LOOM_URL, LOOM_PROJECT and LOOM_KEY to upload session traces");
  const hook = arg("file") ? {} : await readStdin();
  const file = arg("file") ?? hook.transcript_path;
  if (!file) return console.error("loom trace: no transcript; pass --file <log>");
  const size = statSync(file).size;
  if (size > MAX) return console.error(`loom trace: ${file} is ${(size / 1024 / 1024).toFixed(1)} MB; Loom takes up to 25 MB`);

  const q = new URLSearchParams();
  const session = arg("session") ?? hook.session_id;
  if (session) q.set("session", session);
  if (arg("change")) q.set("change", arg("change"));
  if (arg("task")) q.set("task", arg("task"));
  if (arg("source")) q.set("source", arg("source"));
  else if (hook.transcript_path) q.set("source", "claude-code");
  q.set("runner", hook.hook_event_name ? `claude-code ${hook.hook_event_name}` : "trace-hook");

  const headers = { authorization: `Bearer ${LOOM_KEY}`, "content-type": "application/x-ndjson" };
  if (LOOM_AGENT) headers["x-loom-agent"] = LOOM_AGENT;
  const res = await fetch(`${LOOM_URL.replace(/\/$/, "")}/api/projects/${LOOM_PROJECT}/traces?${q}`, { method: "POST", headers, body: readFileSync(file) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return console.error(`loom trace: ${res.status} ${body.error ?? ""}`);
  console.error(`loom trace: uploaded as trace #${body.id} (${body.steps} steps${body.change ? `, change #${body.change}` : ""}${body.redactions ? `, ${body.redactions} secrets removed` : ""})`);
}

main().catch((e) => console.error(`loom trace: ${e.message}`)).finally(() => process.exit(0));
