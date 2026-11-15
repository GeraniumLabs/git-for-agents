import { test } from "node:test";
import assert from "node:assert/strict";
import { formatCredential, helperCommand, loginCommands, parseCredentialRequest, projectCandidates, repoOf } from "../src/gitlogin";

test("git's credential request gives the repository", () => {
  const f = parseCredentialRequest("protocol=https\nhost=acct.artifacts.cloudflare.net\npath=git/loom/todo-t3-ab1.git\n\n");
  assert.equal(f.host, "acct.artifacts.cloudflare.net");
  assert.equal(repoOf(f), "todo-t3-ab1");
  assert.equal(repoOf({ path: "git/loom/todo" }), "todo");
  assert.equal(repoOf({ url: "https://h/git/loom/todo.git" }), "todo");
  assert.equal(repoOf({}), null);
  assert.equal(repoOf({ path: "git/loom/../x;rm.git" }), null);
});

test("a workspace names its project; main is named after it", () => {
  assert.deepEqual(projectCandidates("todo-swarm-t12-x9k"), ["todo-swarm", "todo-swarm-t12-x9k"]);
  assert.deepEqual(projectCandidates("todo-swarm"), ["todo-swarm"]);
});

test("the credential is in git's format with an expiry", () => {
  assert.equal(formatCredential({ password: "s3cret", expiresAt: "2026-11-15T18:00:00.000Z" }), "username=x\npassword=s3cret\npassword_expiry_utc=1794765600\n");
});

test("login commands scope the helper to the Artifacts host", () => {
  const c = loginCommands("https://mergery.dev", "https://acct.artifacts.cloudflare.net/git/loom/todo.git");
  assert.match(c, /credential\.https:\/\/acct\.artifacts\.cloudflare\.net\.helper ""/);
  assert.match(c, /useHttpPath true/);
  assert.ok(c.includes(helperCommand("https://mergery.dev").replace(/'/g, `'\\''`)));
});
