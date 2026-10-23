#!/usr/bin/env node
// Set up your own Loom on Cloudflare in one command:
//
//   npm run setup -- --owner <your GitHub login>
//
// It checks you're signed in to Cloudflare and Docker is running, creates the
// R2 buckets and the push-events queue, deploys, sets the two secrets Loom
// needs (generated here), and tells you where to go next. Safe to run again:
// what exists is left alone, and secrets the Worker has are kept unless you pass --new-secrets.
//
//   --owner <login>   GitHub logins who own every project (comma-separated)
//   --new-secrets     generate LOOM_SECRET_KEY and LOOM_ADMIN_TOKEN again
//   --dry-run         print what it would run, and run nothing

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const value = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const dry = flag("--dry-run");
const TOKEN_FILE = ".loom-admin-token";

const ok = (m) => console.log(`✓ ${m}`);
const step = (m) => console.log(`\n${m}`);
const fail = (m, fix) => { console.error(`✗ ${m}${fix ? `\n  ${fix}` : ""}`); process.exit(1); };

function run(cmd, cmdArgs, { input, quiet = false, allowFail = false } = {}) {
  if (dry) { console.log(`  $ ${cmd} ${cmdArgs.join(" ")}`); return { ok: true, out: "" }; }
  const r = spawnSync(cmd, cmdArgs, { input, encoding: "utf8", stdio: [input ? "pipe" : "inherit", "pipe", "pipe"] });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (!quiet) process.stdout.write(r.stdout ?? "");
  if (r.status !== 0 && !allowFail) fail(`${cmd} ${cmdArgs.join(" ")} failed`, out.trim().split("\n").slice(-5).join("\n  "));
  return { ok: r.status === 0, out };
}
const wrangler = (a, o) => run("npx", ["wrangler", ...a], o);

step("Checking what you need");
const who = wrangler(["whoami"], { quiet: true, allowFail: true });
if (!dry && (!who.ok || /not authenticated|You are not logged in/i.test(who.out))) fail("not signed in to Cloudflare", "run: npx wrangler login");
ok("signed in to Cloudflare");
if (!dry && spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0) fail("Docker isn't running", "Loom builds the image its checks run in; start Docker and run this again");
ok("Docker is running");
console.log("  Loom needs the Workers Paid plan (Artifacts and Containers).");

step("Storage and the push-events queue");
for (const [what, cmd] of [
  ["R2 bucket loom-context", ["r2", "bucket", "create", "loom-context"]],
  ["R2 bucket loom-context-eu (EU)", ["r2", "bucket", "create", "loom-context-eu", "--jurisdiction", "eu"]],
  ["queue loom-artifacts-events", ["queues", "create", "loom-artifacts-events"]],
]) {
  const r = wrangler(cmd, { quiet: true, allowFail: true });
  if (r.ok || /already exists|already taken|10004|11009/i.test(r.out)) ok(what);
  else fail(`couldn't create ${what}`, r.out.trim().split("\n").slice(-3).join("\n  "));
}
console.log("  EU projects also need the loom-eu Artifacts namespace created with jurisdiction \"eu\" before anything is pushed to it (docs/guide.md, Data residency).");

step("Deploying (this builds the checks image, so the first time takes a few minutes)");
const deployed = wrangler(["deploy"], { quiet: false });
const url = deployed.out.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/)?.[0] ?? "https://<your worker>";
ok(`deployed to ${url}`);

step("Secrets");
const secrets = {};
// Never replace a secret the Worker already has unless asked: a new LOOM_SECRET_KEY signs everyone out
// and makes the keys people saved in Settings unreadable.
const listed = wrangler(["secret", "list"], { quiet: true, allowFail: true }).out;
const existing = new Set([...listed.matchAll(/"name":\s*"([A-Z_]+)"/g)].map((m) => m[1]));
const fresh = flag("--new-secrets");
if (fresh || !existing.has("LOOM_SECRET_KEY")) secrets.LOOM_SECRET_KEY = randomBytes(32).toString("base64url");
if (fresh || !existing.has("LOOM_ADMIN_TOKEN")) secrets.LOOM_ADMIN_TOKEN = `loomadmin_${randomBytes(24).toString("base64url")}`;
const owner = value("--owner");
if (owner) secrets.LOOM_OWNERS = owner.toLowerCase();
if (Object.keys(secrets).length) {
  wrangler(["secret", "bulk"], { input: JSON.stringify(secrets), quiet: true });
  if (secrets.LOOM_ADMIN_TOKEN && !dry) writeFileSync(TOKEN_FILE, `${secrets.LOOM_ADMIN_TOKEN}\n`, { mode: 0o600 });
  ok(`set ${Object.keys(secrets).join(", ")}`);
} else ok("kept the secrets the Worker already has");
if (!owner) console.log("  No --owner given: nobody owns every project. Run again with --owner <your GitHub login> to be one.");

console.log(`
Loom is up at ${url}

Next:
  1. Set up GitHub sign-in: open ${url}/auth/setup and give it the admin token once.
     ${existsSync(TOKEN_FILE) || dry ? `The admin token is in ${TOKEN_FILE} (keep it out of git; it's in .gitignore).` : "Use the admin token you set before."}
  2. Sign in, paste a git URL to bring a repository, and connect your agent:
       claude mcp add --transport http loom ${url}/mcp
  3. Check everything with: npm run doctor -- ${url}

Optional, in docs/guide.md: email (Cloudflare Email Service), push events (CF_EVENTS_TOKEN),
payments (Stripe), and who may create projects (LOOM_CREATORS).`);
