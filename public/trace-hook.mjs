#!/usr/bin/env node
// Uploads an agent's session log to Loom, so reviewers can see what was asked
// and why the agent did what it did. Optional: nothing is uploaded unless you
// install it. As a Claude Code hook it runs when a session ends and sends that
// session's transcript; it can also send any log file by hand.
//
// Turn it on for one repository (run in the repository's root). Loom's
// "Connect an agent" page gives you this line with a trace key filled in:
//
//   mkdir -p ~/.loom && curl -fsS https://<loom>/trace-hook.mjs -o ~/.loom/trace-hook.mjs \
//     && node ~/.loom/trace-hook.mjs --install https://<loom> <project> <trace key>
//
// That saves the key in ~/.loom/traces/<project>.json (readable only by you)
// and adds a SessionEnd hook to .claude/settings.local.json, your personal
// settings for the repository; the key itself never goes in the repository. Add --global to use ~/.claude/settings.json instead, which
// sends every Claude Code session on this machine to the project. Turn it off:
//
//   node ~/.loom/trace-hook.mjs --uninstall <project> [--global]
//
// Or revoke the key in Loom. By hand (a Codex session, say):
//
//   node trace-hook.mjs --file ~/.codex/sessions/2026/11/11/rollout-….jsonl [--session <id>] [--change 12]
//
// Without --project it reads LOOM_URL, LOOM_PROJECT and LOOM_KEY (a trace key
// or an agent key). LOOM_AGENT, if set, uploads as that named agent under the
// key, which is what recipes/runner.mjs sets for each agent it starts. Loom
// removes secrets before storing anything, and uploading the same session
// again adds a new version.
//
// The hook never fails the session: problems are printed and it exits 0.

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX = 25 * 1024 * 1024;
const HOME = join(homedir(), ".loom");
const SCRIPT = join(HOME, "trace-hook.mjs");
const configPath = (project) => join(HOME, "traces", `${project}.json`);

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const flag = (name) => process.argv.includes(`--${name}`);

async function readStdin() {
  if (process.stdin.isTTY) return {};
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  try { return JSON.parse(text || "{}"); } catch { return {}; }
}

// ── installing and removing the hook ────────────────────────────────────
function settingsPath() {
  return flag("global") ? join(homedir(), ".claude", "settings.json") : resolve(".claude", "settings.local.json");
}
function readJson(file) {
  if (!existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { throw new Error(`${file} isn't valid JSON; fix it and run this again`); }
}
const ours = (project) => (h) => typeof h?.command === "string" && h.command.includes("trace-hook.mjs") && h.command.includes(`--project ${project}`);
/** Settings with this project's hook taken out of SessionEnd. */
function withoutHook(settings, project) {
  const groups = (settings.hooks?.SessionEnd ?? []).map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !ours(project)(h)) })).filter((g) => g.hooks.length);
  const hooks = { ...(settings.hooks ?? {}), SessionEnd: groups };
  if (!groups.length) delete hooks.SessionEnd;
  return { ...settings, hooks };
}

function install() {
  const i = process.argv.indexOf("--install");
  const [url, project, key] = process.argv.slice(i + 1, i + 4);
  if (!url || !project || !key || key.startsWith("--")) throw new Error("usage: --install <loom url> <project> <trace key> [--agent <name>] [--global]");
  mkdirSync(join(HOME, "traces"), { recursive: true });
  const self = fileURLToPath(import.meta.url);
  if (resolve(self) !== resolve(SCRIPT)) copyFileSync(self, SCRIPT);
  const cfg = configPath(project);
  writeFileSync(cfg, JSON.stringify({ url: url.replace(/\/$/, ""), project, key, ...(arg("agent") ? { agent: arg("agent") } : {}) }, null, 2) + "\n", { mode: 0o600 });
  chmodSync(cfg, 0o600);
  const file = settingsPath();
  const settings = withoutHook(readJson(file), project);
  const command = `node "${SCRIPT}" --project ${project}`;
  settings.hooks.SessionEnd = [...(settings.hooks.SessionEnd ?? []), { hooks: [{ type: "command", command }] }];
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  console.log(`loom trace: on. Claude Code sessions ${flag("global") ? "on this machine" : `in ${process.cwd()}`} upload to ${project} when they end.`);
  console.log(`  hook: ${file}\n  key:  ${cfg}`);
  console.log(`  turn off: node "${SCRIPT}" --uninstall ${project}${flag("global") ? " --global" : ""}`);
}

function uninstall() {
  const i = process.argv.indexOf("--uninstall");
  const project = process.argv[i + 1];
  if (!project || project.startsWith("--")) throw new Error("usage: --uninstall <project> [--global]");
  const file = settingsPath();
  if (existsSync(file)) {
    const settings = withoutHook(readJson(file), project);
    if (!Object.keys(settings.hooks).length) delete settings.hooks;
    writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  }
  rmSync(configPath(project), { force: true });
  console.log(`loom trace: off for ${project}. Removed the hook from ${file} and the saved key. Revoke the key in Loom too if you won't turn it back on.`);
}

// ── uploading ───────────────────────────────────────────────────────────
async function upload() {
  let { LOOM_URL, LOOM_PROJECT, LOOM_KEY, LOOM_AGENT } = process.env;
  if (arg("project")) {
    const file = configPath(arg("project"));
    if (!existsSync(file)) return console.error(`loom trace: no saved key for ${arg("project")}; run --install again`);
    const cfg = JSON.parse(readFileSync(file, "utf8"));
    LOOM_URL = cfg.url; LOOM_PROJECT = cfg.project; LOOM_KEY = cfg.key; LOOM_AGENT = LOOM_AGENT || cfg.agent;
  }
  if (!LOOM_URL || !LOOM_PROJECT || !LOOM_KEY) return console.error("loom trace: set LOOM_URL, LOOM_PROJECT and LOOM_KEY to upload session traces, or run --install");
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

async function main() {
  if (flag("install")) return install();
  if (flag("uninstall")) return uninstall();
  return upload();
}

main().catch((e) => { console.error(`loom trace: ${e.message}`); if (flag("install") || flag("uninstall")) process.exitCode = 1; }).finally(() => process.exit(process.exitCode ?? 0));
