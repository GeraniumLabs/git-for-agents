#!/usr/bin/env node
// A local stand-in for Cloudflare Artifacts, for development and tests.
// It keeps bare git repositories on disk, mints repo-scoped tokens in the
// same art_v1_<secret>?expires=<unix> format, and serves real git smart HTTP
// through `git http-backend`, so agents use their normal git client against it.
//
//   node shim/artifacts-shim.mjs [--port 8790] [--data .shim-data]

import { createServer } from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const run = promisify(execFile);
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const PORT = Number(arg("port", process.env.SHIM_PORT ?? 8790));
const DATA = resolve(arg("data", ".shim-data"));
const NAMESPACE = "loom";
const REPOS = join(DATA, "repos");
const TOKENS_FILE = join(DATA, "tokens.json");
mkdirSync(REPOS, { recursive: true });

/** token secret -> { repo, scope, expires } */
const tokens = existsSync(TOKENS_FILE) ? JSON.parse(readFileSync(TOKENS_FILE, "utf8")) : {};
const saveTokens = () => writeFileSync(TOKENS_FILE, JSON.stringify(tokens));

const base = () => `http://127.0.0.1:${PORT}`;
const remote = (name) => `${base()}/git/${NAMESPACE}/${name}.git`;
const repoDir = (name) => join(REPOS, `${name}.git`);
const validName = (n) => typeof n === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(n);

function mint(repo, scope = "write", ttl = 86400) {
  const secret = `art_v1_${randomBytes(20).toString("hex")}`;
  const expires = Math.floor(Date.now() / 1000) + ttl;
  tokens[secret] = { repo, scope, expires };
  saveTokens();
  return { id: secret.slice(-12), plaintext: `${secret}?expires=${expires}`, scope, expiresAt: new Date(expires * 1000).toISOString() };
}

const git = (dir, ...args) => run("git", args, { cwd: dir, maxBuffer: 64 * 1024 * 1024 });

async function info(name) {
  if (!existsSync(repoDir(name))) return null;
  return { name, remote: remote(name), defaultBranch: "main" };
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const s = Buffer.concat(chunks).toString();
  return s ? JSON.parse(s) : {};
}

async function api(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean); // repos[/name[/op]]
  const [, name, op] = parts;
  if (req.method === "GET" && !name) {
    const { readdirSync } = await import("node:fs");
    return send(res, 200, { repos: readdirSync(REPOS).map((d) => ({ name: d.replace(/\.git$/, "") })) });
  }
  if (req.method === "POST" && !name) {
    const body = await readBody(req);
    if (!validName(body.name)) return send(res, 400, { error: "INVALID_REPO_NAME" });
    if (existsSync(repoDir(body.name))) return send(res, 409, { error: "ALREADY_EXISTS" });
    mkdirSync(repoDir(body.name), { recursive: true });
    await git(repoDir(body.name), "init", "--bare", "-q", "-b", "main");
    await git(repoDir(body.name), "config", "http.receivepack", "true");
    return send(res, 200, { ...(await info(body.name)), token: mint(body.name).plaintext });
  }
  if (!validName(name) || !existsSync(repoDir(name))) return send(res, 404, { error: "NOT_FOUND" });
  const dir = repoDir(name);

  if (req.method === "GET" && !op) return send(res, 200, await info(name));
  if (req.method === "DELETE" && !op) {
    rmSync(dir, { recursive: true, force: true });
    return send(res, 200, { deleted: true });
  }
  if (req.method === "POST" && op === "fork") {
    const body = await readBody(req);
    if (!validName(body.name)) return send(res, 400, { error: "INVALID_REPO_NAME" });
    if (existsSync(repoDir(body.name))) return send(res, 409, { error: "ALREADY_EXISTS" });
    await run("git", ["clone", "-q", "--bare", "--single-branch", "--branch", "main", dir, repoDir(body.name)]);
    await git(repoDir(body.name), "config", "http.receivepack", "true");
    return send(res, 200, { ...(await info(body.name)), token: mint(body.name).plaintext });
  }
  if (req.method === "POST" && op === "tokens") {
    const body = await readBody(req);
    return send(res, 200, mint(name, body.scope ?? "write", body.ttl ?? 86400));
  }
  if (req.method === "GET" && op === "file") {
    try {
      const { stdout } = await git(dir, "show", `${url.searchParams.get("ref")}:${url.searchParams.get("path")}`);
      return send(res, 200, { content: stdout });
    } catch {
      return send(res, 404, { error: "NOT_FOUND" });
    }
  }
  if (req.method === "GET" && op === "log") {
    try {
      const { stdout } = await git(dir, "log", `-n${url.searchParams.get("limit") ?? 50}`, "--first-parent", "--format=%H%x00%P%x00%an%x00%ae%x00%ct%x00%B%x1e", url.searchParams.get("ref") ?? "HEAD");
      const commits = stdout.split("\x1e").map((s) => s.trim()).filter(Boolean).map((rec) => {
        const [hash, parents, an, ae, ct, msg] = rec.split("\x00");
        return { hash, parents: parents ? parents.split(" ") : [], author: { name: an, email: ae }, committedAt: Number(ct), message: (msg ?? "").trim() };
      });
      return send(res, 200, commits);
    } catch {
      return send(res, 200, []);
    }
  }
  send(res, 404, { error: "no such route" });
}

function authorize(req, repo, write) {
  const h = req.headers.authorization ?? "";
  let secret = "";
  if (/^Bearer /i.test(h)) secret = h.slice(7).trim();
  else if (/^Basic /i.test(h)) secret = Buffer.from(h.slice(6), "base64").toString().split(":").slice(1).join(":");
  secret = secret.split("?expires=")[0];
  const t = tokens[secret];
  if (!t || t.repo !== repo || t.expires < Date.now() / 1000) return false;
  return !write || t.scope === "write";
}

function gitHttp(req, res, url) {
  const m = url.pathname.match(new RegExp(`^/git/${NAMESPACE}/([^/]+)\\.git(/.*)$`));
  if (!m || !existsSync(repoDir(m[1]))) return send(res, 404, { error: "NOT_FOUND" });
  const write = url.searchParams.get("service") === "git-receive-pack" || m[2].endsWith("git-receive-pack");
  if (!authorize(req, m[1], write)) {
    res.writeHead(401, { "www-authenticate": 'Basic realm="artifacts"' });
    return res.end("unauthorized");
  }
  const child = spawn("git", ["http-backend"], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: REPOS,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: `/${m[1]}.git${m[2]}`,
      REQUEST_METHOD: req.method,
      QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: req.headers["content-type"] ?? "",
      HTTP_CONTENT_ENCODING: req.headers["content-encoding"] ?? "",
      GIT_PROTOCOL: req.headers["git-protocol"] ?? "",
      REMOTE_USER: "agent",
      REMOTE_ADDR: "127.0.0.1",
    },
  });
  req.pipe(child.stdin);
  let buf = Buffer.alloc(0);
  let headersDone = false;
  child.stdout.on("data", (chunk) => {
    if (headersDone) return res.write(chunk);
    buf = Buffer.concat([buf, chunk]);
    const idx = buf.indexOf("\r\n\r\n");
    if (idx === -1) return;
    const head = buf.subarray(0, idx).toString().split("\r\n");
    let status = 200;
    const headers = {};
    for (const line of head) {
      const [k, ...v] = line.split(":");
      if (k.toLowerCase() === "status") status = parseInt(v.join(":"));
      else headers[k] = v.join(":").trim();
    }
    res.writeHead(status, headers);
    headersDone = true;
    res.write(buf.subarray(idx + 4));
  });
  child.stderr.on("data", (d) => process.stderr.write(d));
  child.on("close", () => {
    res.end();
    if (write && req.method === "POST") announcePush(m[1]).catch((e) => console.error("push event", e.message));
  });
}

/**
 * Like an Artifacts event subscription: after a push, POST a
 * cf.artifacts.repo.pushed message to the Worker's dev endpoint, or to
 * LOOM_EVENTS_URL ("off" for none).
 */
const EVENTS_URL = process.env.LOOM_EVENTS_URL === "off" ? null : process.env.LOOM_EVENTS_URL ?? "http://127.0.0.1:8787/api/dev/artifacts-events";
const lastHead = new Map();
async function announcePush(repo) {
  if (!EVENTS_URL) return;
  const after = (await run("git", ["--git-dir", repoDir(repo), "rev-parse", "refs/heads/main"]).catch(() => ({ stdout: "" }))).stdout.trim();
  if (!after || lastHead.get(repo) === after) return;
  const before = lastHead.get(repo) ?? null;
  lastHead.set(repo, after);
  const message = { type: "cf.artifacts.repo.pushed", source: { type: "artifacts.repo", namespace: NAMESPACE, repoName: repo }, payload: { ref: "refs/heads/main", before, after } };
  await fetch(EVENTS_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify([message]) });
}

/**
 * Local stand-in for the CheckRunner container: unpack the tar the Worker
 * sends into a temp directory and run the project's check command there.
 * This runs agents' code on your machine, as a local CI runner would.
 */
async function runCheck(req, res) {
  const command = decodeURIComponent(req.headers["x-command"] ?? "");
  const timeout = Number(req.headers["x-timeout"] ?? 300) * 1000;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const dir = join(DATA, "checks", randomBytes(6).toString("hex"));
  mkdirSync(dir, { recursive: true });
  try {
    await new Promise((ok, fail) => {
      const t = spawn("tar", ["-x", "-C", dir]);
      t.on("close", (code) => (code === 0 ? ok() : fail(new Error(`tar exited ${code}`))));
      t.stdin.end(Buffer.concat(chunks));
    });
    const result = await new Promise((ok) => {
      const child = spawn("sh", ["-c", command], { cwd: dir, env: { ...process.env, CI: "1" } });
      let output = "";
      child.stdout.on("data", (d) => (output += d));
      child.stderr.on("data", (d) => (output += d));
      const timer = setTimeout(() => { output += `\ntimed out after ${timeout / 1000}s`; child.kill("SIGKILL"); }, timeout);
      child.on("close", (code) => { clearTimeout(timer); ok({ exitCode: code ?? 124, output }); });
    });
    send(res, 200, result);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A stand-in for the Messages API, for Loom's review agent in local
// development: it approves, unless the diff contains LOOM-TEST-BUG, which it
// asks to fix in a blocking comment on that line.
// A stand-in for the two Stripe calls Loom makes (Checkout and the billing
// portal). Tests then post signed webhooks to Loom themselves.
async function stripeStandIn(req, res, url) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  if (!/^Bearer sk_test_/.test(req.headers.authorization ?? "")) return send(res, 401, { error: { message: "Invalid API Key provided" } });
  const id = randomBytes(6).toString("hex");
  if (url.pathname === "/stripe/v1/checkout/sessions") {
    return send(res, 200, { id: `cs_test_${id}`, url: `${base()}/stripe/pay/cs_test_${id}?login=${encodeURIComponent(params.get("client_reference_id") ?? "")}&success=${encodeURIComponent(params.get("success_url") ?? "")}`, mode: params.get("mode") });
  }
  if (url.pathname === "/stripe/v1/billing_portal/sessions") {
    return send(res, 200, { id: `bps_${id}`, url: `${base()}/stripe/portal/${params.get("customer")}?return=${encodeURIComponent(params.get("return_url") ?? "")}` });
  }
  send(res, 404, { error: { message: "no such Stripe route in the shim" } });
}

async function reviewStandIn(req, res) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const prompt = String(body.messages?.[0]?.content ?? "");
  // Loom numbers each diff line by its line in the new file.
  let file = null, bug = null;
  for (const l of prompt.split("\n")) {
    const f = l.match(/^\+\+\+ b\/(.+)$/);
    const n = l.match(/^\s*(\d+) [+ ]/);
    if (f) file = f[1];
    else if (file && n && !bug && l.includes("LOOM-TEST-BUG")) bug = { path: file, line: Number(n[1]), body: "This line is marked as a bug; fix it before it lands.", blocking: true };
  }
  const review = bug ? { verdict: "request_changes", summary: "One blocking problem.", comments: [bug] } : { verdict: "approve", summary: "Does what the task asks.", comments: [] };
  send(res, 200, { id: "msg_standin", type: "message", role: "assistant", model: body.model, stop_reason: "end_turn", stop_sequence: null,
    content: [{ type: "text", text: JSON.stringify(review) }], usage: { input_tokens: prompt.length, output_tokens: 20 } });
}

createServer((req, res) => {
  const url = new URL(req.url, base());
  const done = (e) => {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: String(e) });
  };
  try {
    if (url.pathname.startsWith("/git/")) return gitHttp(req, res, url);
    if (url.pathname.startsWith("/repos")) return api(req, res, url).catch(done);
    if (url.pathname === "/checks/run" && req.method === "POST") return runCheck(req, res).catch(done);
    if (url.pathname === "/anthropic/v1/messages" && req.method === "POST") return reviewStandIn(req, res).catch(done);
    if (url.pathname.startsWith("/stripe/v1/") && req.method === "POST") return stripeStandIn(req, res, url).catch(done);
    send(res, 200, { service: "artifacts-shim", repos: REPOS });
  } catch (e) {
    done(e);
  }
}).listen(PORT, "127.0.0.1", () => console.log(`artifacts shim on ${base()} (data: ${DATA})`));
