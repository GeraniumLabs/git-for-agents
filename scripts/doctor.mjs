#!/usr/bin/env node
// Check a running Loom: npm run doctor -- https://loom.example.dev
// With the admin token (LOOM_ADMIN_TOKEN, or .loom-admin-token from setup) it
// also checks what the server has set up. It changes nothing.

import { existsSync, readFileSync } from "node:fs";

const base = (process.argv[2] ?? process.env.LOOM_URL ?? "").replace(/\/$/, "");
if (!base) { console.error("usage: npm run doctor -- https://<your loom>"); process.exit(1); }
const admin = process.env.LOOM_ADMIN_TOKEN ?? (existsSync(".loom-admin-token") ? readFileSync(".loom-admin-token", "utf8").trim() : "");
let problems = 0;
const line = (good, what, fix) => {
  console.log(`${good === null ? "·" : good ? "✓" : "✗"} ${what}${!good && fix ? `\n    ${fix}` : ""}`);
  if (good === false) problems++;
};
const get = async (path, headers = {}) => {
  try { const r = await fetch(`${base}${path}`, { headers }); return { status: r.status, headers: r.headers, json: await r.json().catch(() => null) }; }
  catch (e) { return { status: 0, error: String(e?.message ?? e) }; }
};

const projects = await get("/api/projects");
line(projects.status === 200, `Loom answers at ${base}`, projects.error ?? `GET /api/projects returned ${projects.status}`);
if (projects.status !== 200) process.exit(1);
console.log(`    ${projects.json.length} project${projects.json.length === 1 ? "" : "s"} listed`);

const me = await get("/auth/me");
line(!!me.json?.github, "GitHub sign-in is set up", `open ${base}/auth/setup and give it the admin token once`);
line(!!me.json?.githubInstall, "people can import private GitHub repositories", "the GitHub app from /auth/setup does this; an OAuth app needs GITHUB_APP_SLUG for its install link");

const as = await get("/.well-known/oauth-authorization-server");
line(as.status === 200 && !!as.json?.registration_endpoint, "MCP clients can sign in (one-line connect)", "is this server running the latest Loom?");
const mcp = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => null);
line(mcp?.status === 401 && /resource_metadata/.test(mcp.headers.get("www-authenticate") ?? ""), "/mcp asks unsigned clients to sign in");

if (!admin) {
  line(null, "server settings: pass the admin token (LOOM_ADMIN_TOKEN) to check them");
} else {
  const h = await get("/api/health", { authorization: `Bearer ${admin}` });
  if (!h.json || h.json.secretKey === undefined) line(false, "the admin token works", "check LOOM_ADMIN_TOKEN, or .loom-admin-token from setup");
  else {
    const c = h.json;
    line(c.secretKey, "LOOM_SECRET_KEY is set (sessions, sealed keys)", "npx wrangler secret put LOOM_SECRET_KEY");
    line(c.artifacts, "Artifacts is bound (the git repositories)", "check the [[artifacts]] binding in wrangler.toml; Artifacts needs Workers Paid");
    line(c.checks, "checks can run (Containers)", "check the [[containers]] section; Docker must run during wrangler deploy");
    line(c.workersAi, "Workers AI is bound (the deputy and the review agent)", "keep the [ai] binding in wrangler.toml");
    line(c.owners > 0, `${c.owners} owner${c.owners === 1 ? "" : "s"} of every project`, "npm run setup -- --owner <your GitHub login>");
    line(null, `who may create projects: ${c.creators}${c.creators === "anyone signed in" ? " (set LOOM_CREATORS to limit it)" : ""}`);
    line(c.pushEvents ? true : null, `push events ${c.pushEvents ? "on: a plain git push updates its change" : "off: agents call update_change after a push (optional; docs/guide.md, Push events)"}`);
    line(c.email ? true : null, `email ${c.email ? "on" : "off (optional; docs/guide.md)"}`);
    line(c.payments ? true : null, `payments ${c.payments ? "on (Stripe)" : "off: the LOOM_* limits apply to everyone"}`);
    line(c.eu ? true : null, `EU data residency ${c.eu ? "available" : "off"}`);
  }
}
console.log(problems ? `\n${problems} thing${problems === 1 ? "" : "s"} to fix.` : "\nAll good.");
process.exit(problems ? 1 : 0);
