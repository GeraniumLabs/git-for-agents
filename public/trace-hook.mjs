#!/usr/bin/env node
// Uploads an agent's session log to Mergery, so reviewers can see what was asked
// and why the agent did what it did. Optional: nothing is uploaded unless you
// install it. Works with Claude Code, Codex and OpenCode, and sends any other
// agent's log by hand.
//
// Turn it on for one repository (run in the repository's root). Mergery's
// "Connect an agent" page gives you this line with a trace key filled in:
//
//   mkdir -p ~/.loom && curl -fsS https://<mergery>/trace-hook.mjs -o ~/.loom/trace-hook.mjs \
//     && node ~/.loom/trace-hook.mjs --install https://<mergery> <project> <trace key> --for claude-code
//
// The key is saved in ~/.loom/traces/<project>.json, readable only by you; it
// never goes in the repository. Then, by agent:
//
//   claude-code  a SessionEnd hook in .claude/settings.local.json (your personal
//                settings for the repository; --global uses ~/.claude/settings.json
//                and sends every session on this machine). Uploads when a session ends.
//   codex        `notify` in ~/.codex/config.toml, for sessions in this repository.
//                Codex reports each finished turn; the session uploads once it has
//                been idle for 5 minutes (LOOM_TRACE_IDLE_SECONDS).
//   opencode     a plugin in ~/.config/opencode/plugins/loom-trace.js, for sessions
//                in this repository. Uploads once a session has been idle for 5 minutes.
//
// Turn it off (in the same repository):
//
//   node ~/.loom/trace-hook.mjs --uninstall <project> [--for <agent>] [--global]
//
// Or revoke the key in Mergery. Any other agent, by hand, after installing:
//
//   node ~/.loom/trace-hook.mjs --project <project> --file <session log> [--session <id>] [--change 12]
//
// Without --project it reads LOOM_URL, LOOM_PROJECT and LOOM_KEY (a trace key
// or an agent key). LOOM_AGENT, if set, uploads as that named agent under the
// key, which is what recipes/runner.mjs sets for each agent it starts. Mergery
// removes secrets before storing anything, and uploading the same session
// again adds a new version.
//
// Hooks never fail the agent's session: problems are printed and it exits 0.

import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MAX = 25 * 1024 * 1024;
const HOME = join(homedir(), ".loom");
const SCRIPT = join(HOME, "trace-hook.mjs");
const AGENTS = ["claude-code", "codex", "opencode"];
const IDLE = Math.max(0, Number(process.env.LOOM_TRACE_IDLE_SECONDS ?? 300)) * 1000;
const CODEX_CONFIG = join(homedir(), ".codex", "config.toml");
const OPENCODE_PLUGIN = join(homedir(), ".config", "opencode", "plugins", "loom-trace.js");
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
function readJson(file, fallback = {}) {
  if (!existsSync(file)) return fallback;
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { throw new Error(`${file} isn't valid JSON; fix it and run this again`); }
}

// ── saved keys: one file per project, one entry per repository and agent ──
function loadConfig(project) {
  const cfg = readJson(configPath(project), null);
  if (!cfg) return null;
  // Written by an earlier version: one key, Claude Code only.
  if (!cfg.repos) cfg.repos = cfg.key ? [{ path: null, for: "claude-code", key: cfg.key, agent: cfg.agent }] : [];
  return cfg;
}
function saveConfig(cfg) {
  const file = configPath(cfg.project);
  if (!cfg.repos.length) return rmSync(file, { force: true });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ url: cfg.url, project: cfg.project, repos: cfg.repos }, null, 2) + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
}
function allConfigs() {
  const dir = join(HOME, "traces");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => { try { return loadConfig(f.slice(0, -5)); } catch { return null; } }).filter(Boolean);
}
const inside = (dir, root) => !!root && (dir === root || dir.startsWith(root.endsWith(sep) ? root : root + sep));
/** The saved key for a session of this agent in this directory: the deepest repository that holds it. */
function entryFor(agent, dir) {
  let best = null;
  for (const cfg of allConfigs()) for (const r of cfg.repos) {
    if (r.for === agent && inside(resolve(dir), r.path) && (!best || r.path.length > best.r.path.length)) best = { cfg, r };
  }
  return best;
}

// ── Claude Code: a SessionEnd hook in the repository's settings ──────────
function claudeSettingsPath() {
  return flag("global") ? join(homedir(), ".claude", "settings.json") : resolve(".claude", "settings.local.json");
}
const ours = (project) => (h) => typeof h?.command === "string" && h.command.includes("trace-hook.mjs") && h.command.includes(`--project ${project}`);
function withoutClaudeHook(settings, project) {
  const groups = (settings.hooks?.SessionEnd ?? []).map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !ours(project)(h)) })).filter((g) => g.hooks.length);
  const hooks = { ...(settings.hooks ?? {}), SessionEnd: groups };
  if (!groups.length) delete hooks.SessionEnd;
  return { ...settings, hooks };
}
function installClaude(project) {
  const file = claudeSettingsPath();
  const settings = withoutClaudeHook(readJson(file), project);
  settings.hooks.SessionEnd = [...(settings.hooks.SessionEnd ?? []), { hooks: [{ type: "command", command: `node "${SCRIPT}" --project ${project}` }] }];
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  return file;
}
function uninstallClaude(project) {
  const file = claudeSettingsPath();
  if (!existsSync(file)) return;
  const settings = withoutClaudeHook(readJson(file), project);
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
}

// ── Codex: `notify` in ~/.codex/config.toml ─────────────────────────────
const NOTIFY_LINE = () => `notify = ["node", ${JSON.stringify(SCRIPT)}, "--codex-notify"] # Mergery session traces`;
function installCodex() {
  const text = existsSync(CODEX_CONFIG) ? readFileSync(CODEX_CONFIG, "utf8") : "";
  // notify is a top-level key: only lines before the first [table] count.
  const top = text.split(/^\s*\[/m)[0];
  const current = top.match(/^\s*notify\s*=.*$/m)?.[0];
  if (current?.includes("trace-hook.mjs")) return CODEX_CONFIG;
  if (current) throw new Error(`~/.codex/config.toml already has a notify program (${current.trim()}). Codex runs only one: have yours also run  node "${SCRIPT}" --codex-notify "$1"  with the JSON it's given, then run this again with --for codex --skip-config.`);
  mkdirSync(dirname(CODEX_CONFIG), { recursive: true });
  writeFileSync(CODEX_CONFIG, `${NOTIFY_LINE()}\n${text}`);
  return CODEX_CONFIG;
}
function uninstallCodex() {
  if (!existsSync(CODEX_CONFIG)) return;
  const text = readFileSync(CODEX_CONFIG, "utf8");
  writeFileSync(CODEX_CONFIG, text.split("\n").filter((l) => !(/^\s*notify\s*=/.test(l) && l.includes("trace-hook.mjs"))).join("\n"));
}
/** The rollout file Codex writes for a session: named after its id, or the newest one written lately. */
function codexRollout(thread) {
  const root = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
  const files = [];
  const walk = (d, depth) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) files.push(p);
    }
  };
  walk(root, 0);
  const named = thread && files.find((f) => f.includes(thread));
  if (named) return named;
  const recent = files.map((f) => [f, statSync(f).mtimeMs]).filter(([, t]) => Date.now() - t < 10 * 60_000).sort((a, b) => b[1] - a[1]);
  return recent[0]?.[0] ?? null;
}
/** Codex finished a turn: note it, and upload once the session has been quiet for a while. */
function codexNotify() {
  let event;
  try { event = JSON.parse(process.argv[process.argv.length - 1]); } catch { return; }
  if (event?.type !== "agent-turn-complete") return;
  const hit = entryFor("codex", event.cwd ?? process.cwd());
  if (!hit) return;
  const thread = String(event["thread-id"] ?? "latest");
  const file = codexRollout(event["thread-id"]);
  if (!file) return console.error("mergery trace: couldn't find this Codex session's log");
  const pending = join(HOME, "pending", `${thread.replace(/[^\w.-]/g, "_")}.json`);
  const at = Date.now();
  mkdirSync(dirname(pending), { recursive: true });
  writeFileSync(pending, JSON.stringify({ project: hit.cfg.project, repo: hit.r.path, file, thread: event["thread-id"] ?? null, at }));
  const child = spawn(process.execPath, [SCRIPT, "--flush", pending, String(at)], { detached: true, stdio: "ignore", env: process.env });
  child.unref();
}
async function flush() {
  const pending = arg("flush"), at = Number(process.argv[process.argv.indexOf("--flush") + 2]);
  await new Promise((r) => setTimeout(r, IDLE));
  const p = readJson(pending, null);
  if (!p || p.at !== at) return; // a later turn will upload instead
  rmSync(pending, { force: true });
  const cfg = loadConfig(p.project);
  const r = cfg?.repos.find((x) => x.for === "codex" && x.path === p.repo);
  if (!r) return;
  await upload({ url: cfg.url, project: cfg.project, key: r.key, agent: r.agent }, readFileSync(p.file), { session: p.thread, source: "codex", runner: "codex notify" });
}

// ── OpenCode: a plugin that reads the session through OpenCode's own client ──
const OPENCODE_SOURCE = `// Mergery session traces for OpenCode, installed by ~/.loom/trace-hook.mjs.
// For repositories where you turned traces on; remove with --uninstall.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

const IDLE = Math.max(0, Number(process.env.LOOM_TRACE_IDLE_SECONDS ?? 300)) * 1000;
const inside = (dir, root) => !!root && (dir === root || dir.startsWith(root.endsWith(sep) ? root : root + sep));
function entryFor(dir) {
  const d = join(homedir(), ".loom", "traces");
  let best = null;
  if (!existsSync(d)) return null;
  for (const f of readdirSync(d)) {
    if (!f.endsWith(".json")) continue;
    let cfg; try { cfg = JSON.parse(readFileSync(join(d, f), "utf8")); } catch { continue; }
    for (const r of cfg.repos ?? []) if (r.for === "opencode" && inside(resolve(dir), r.path) && (!best || r.path.length > best.r.path.length)) best = { cfg, r };
  }
  return best;
}

export const LoomTrace = async ({ client, directory }) => {
  const timers = new Map();
  const send = async (id) => {
    const hit = entryFor(directory);
    if (!hit) return;
    try {
      const info = (await client.session.get({ path: { id } })).data;
      const messages = (await client.session.messages({ path: { id } })).data;
      const q = new URLSearchParams({ session: id, source: "opencode", runner: "opencode session.idle" });
      const headers = { authorization: "Bearer " + hit.r.key, "content-type": "application/x-ndjson" };
      if (hit.r.agent) headers["x-loom-agent"] = hit.r.agent;
      const res = await fetch(hit.cfg.url + "/api/projects/" + hit.cfg.project + "/traces?" + q, { method: "POST", headers, body: JSON.stringify({ info, messages }) });
      if (!res.ok) console.error("mergery trace: " + res.status + " " + ((await res.json().catch(() => ({}))).error ?? ""));
    } catch (e) { console.error("mergery trace: " + e.message); }
  };
  return {
    event: async ({ event }) => {
      if (event?.type !== "session.idle") return;
      const id = event.properties?.sessionID;
      if (!id) return;
      clearTimeout(timers.get(id));
      timers.set(id, setTimeout(() => { timers.delete(id); send(id); }, IDLE));
    },
  };
};
`;
function installOpencode() {
  mkdirSync(dirname(OPENCODE_PLUGIN), { recursive: true });
  writeFileSync(OPENCODE_PLUGIN, OPENCODE_SOURCE);
  return OPENCODE_PLUGIN;
}

// ── installing and removing ─────────────────────────────────────────────
function install() {
  const i = process.argv.indexOf("--install");
  const [url, project, key] = process.argv.slice(i + 1, i + 4);
  const agent = arg("for") ?? "claude-code";
  if (!url || !project || !key || key.startsWith("--")) throw new Error("usage: --install <mergery url> <project> <trace key> [--for claude-code|codex|opencode] [--agent <name>] [--global]");
  if (!AGENTS.includes(agent)) throw new Error(`--for is one of ${AGENTS.join(", ")}; any other agent can send its log with --file`);
  mkdirSync(join(HOME, "traces"), { recursive: true });
  const self = fileURLToPath(import.meta.url);
  if (resolve(self) !== resolve(SCRIPT)) copyFileSync(self, SCRIPT);
  const repo = agent === "claude-code" && flag("global") ? null : process.cwd();
  let where;
  if (agent === "claude-code") where = installClaude(project);
  else if (agent === "codex") where = flag("skip-config") ? "(your own notify program)" : installCodex();
  else where = installOpencode();
  const cfg = loadConfig(project) ?? { url: url.replace(/\/$/, ""), project, repos: [] };
  cfg.url = url.replace(/\/$/, "");
  cfg.repos = cfg.repos.filter((r) => !(r.for === agent && r.path === repo));
  cfg.repos.push({ path: repo, for: agent, key, ...(arg("agent") ? { agent: arg("agent") } : {}) });
  saveConfig(cfg);
  const when = agent === "claude-code" ? "when they end" : `once they've been idle for ${Math.round(IDLE / 60000)} minutes`;
  console.log(`mergery trace: on. ${agent} sessions ${repo ? `in ${repo}` : "on this machine"} upload to ${project} ${when}.`);
  console.log(`  hook: ${where}\n  key:  ${configPath(project)}`);
  console.log(`  turn off: node "${SCRIPT}" --uninstall ${project} --for ${agent}${flag("global") ? " --global" : ""}`);
}

function uninstall() {
  const i = process.argv.indexOf("--uninstall");
  const project = process.argv[i + 1];
  if (!project || project.startsWith("--")) throw new Error("usage: --uninstall <project> [--for claude-code|codex|opencode] [--global]");
  const only = arg("for");
  const repo = flag("global") ? null : process.cwd();
  const cfg = loadConfig(project);
  if (!only || only === "claude-code") uninstallClaude(project);
  if (cfg) {
    cfg.repos = cfg.repos.filter((r) => !((!only || r.for === only) && r.path === repo));
    saveConfig(cfg);
  }
  // The Codex and OpenCode hooks serve every repository: remove them once none uses them.
  const left = allConfigs().flatMap((c) => c.repos);
  if (!left.some((r) => r.for === "codex")) uninstallCodex();
  if (!left.some((r) => r.for === "opencode")) rmSync(OPENCODE_PLUGIN, { force: true });
  console.log(`mergery trace: off for ${project}${only ? ` (${only})` : ""} in ${repo ?? "your global settings"}. Revoke the key in Mergery too if you won't turn it back on.`);
}

// ── uploading ───────────────────────────────────────────────────────────
async function upload(to, body, params) {
  if (body.length > MAX) return console.error(`mergery trace: the log is ${(body.length / 1024 / 1024).toFixed(1)} MB; Mergery takes up to 25 MB`);
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null));
  const headers = { authorization: `Bearer ${to.key}`, "content-type": "application/x-ndjson" };
  if (to.agent) headers["x-loom-agent"] = to.agent;
  const res = await fetch(`${to.url.replace(/\/$/, "")}/api/projects/${to.project}/traces?${q}`, { method: "POST", headers, body });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) return console.error(`mergery trace: ${res.status} ${out.error ?? ""}`);
  console.error(`mergery trace: uploaded as trace #${out.id} (${out.steps} steps${out.change ? `, change #${out.change}` : ""}${out.redactions ? `, ${out.redactions} secrets removed` : ""})`);
}

async function hookUpload() {
  let to = { url: process.env.LOOM_URL, project: process.env.LOOM_PROJECT, key: process.env.LOOM_KEY, agent: process.env.LOOM_AGENT };
  const hook = arg("file") ? {} : await readStdin();
  if (arg("project")) {
    const cfg = loadConfig(arg("project"));
    if (!cfg) return console.error(`mergery trace: no saved key for ${arg("project")}; run --install again`);
    const dir = resolve(hook.cwd ?? process.cwd());
    const kind = arg("file") ? null : "claude-code";
    const r = cfg.repos.filter((x) => (!kind || x.for === kind) && (x.path === null || inside(dir, x.path))).sort((a, b) => (b.path?.length ?? 0) - (a.path?.length ?? 0))[0] ?? cfg.repos[0];
    if (!r) return console.error(`mergery trace: no saved key for ${arg("project")}; run --install again`);
    to = { url: cfg.url, project: cfg.project, key: r.key, agent: process.env.LOOM_AGENT || r.agent };
  }
  if (!to.url || !to.project || !to.key) return console.error("mergery trace: set LOOM_URL, LOOM_PROJECT and LOOM_KEY to upload session traces, or run --install");
  const file = arg("file") ?? hook.transcript_path;
  if (!file) return console.error("mergery trace: no transcript; pass --file <log>");
  if (statSync(file).size > MAX) return console.error(`mergery trace: ${file} is ${(statSync(file).size / 1024 / 1024).toFixed(1)} MB; Mergery takes up to 25 MB`);
  await upload(to, readFileSync(file), {
    session: arg("session") ?? hook.session_id,
    change: arg("change"),
    task: arg("task"),
    source: arg("source") ?? (hook.transcript_path ? "claude-code" : undefined),
    runner: hook.hook_event_name ? `claude-code ${hook.hook_event_name}` : "trace-hook",
  });
}

async function main() {
  if (flag("install")) return install();
  if (flag("uninstall")) return uninstall();
  if (flag("codex-notify")) return codexNotify();
  if (flag("flush")) return flush();
  return hookUpload();
}

main().catch((e) => { console.error(`mergery trace: ${e.message}`); if (flag("install") || flag("uninstall")) process.exitCode = 1; }).finally(() => process.exit(process.exitCode ?? 0));
