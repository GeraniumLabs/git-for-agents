import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mirrorBranch, mirrorName, mirrorUrl, plausibleToken, pushError } from "../src/mirror.ts";

const run = promisify(execFile);

test("mirrorUrl takes owner/repo, GitHub URLs and ssh addresses, and gives an https git URL", () => {
  assert.equal(mirrorUrl("GeraniumLabs/git-for-agents"), "https://github.com/GeraniumLabs/git-for-agents.git");
  assert.equal(mirrorUrl("https://github.com/a/b"), "https://github.com/a/b.git");
  assert.equal(mirrorUrl("https://github.com/a/b.git/"), "https://github.com/a/b.git");
  assert.equal(mirrorUrl("git@github.com:a/b.git"), "https://github.com/a/b.git");
  assert.equal(mirrorUrl("https://gitlab.com/a/b.git"), "https://gitlab.com/a/b.git");
  assert.equal(mirrorUrl("http://127.0.0.1:8790/git/loom/x.git"), "http://127.0.0.1:8790/git/loom/x.git");
  assert.throws(() => mirrorUrl(""), /say where to push/);
  assert.throws(() => mirrorUrl("http://example.com/a/b.git"), /https/);
  assert.throws(() => mirrorUrl("https://me:secret@github.com/a/b"), /credentials/);
});

test("mirrorName names GitHub copies by owner/repo", () => {
  assert.equal(mirrorName("https://github.com/a/b.git"), "a/b");
  assert.equal(mirrorName("https://gitlab.com/a/b.git"), "https://gitlab.com/a/b.git");
});

test("mirrorBranch keeps to names git accepts", () => {
  assert.equal(mirrorBranch(undefined), "main");
  assert.equal(mirrorBranch(" mergery/main "), "mergery/main");
  for (const bad of ["../x", "a..b", "-x", "x/", "x.lock", "a b", "refs~1"]) assert.throws(() => mirrorBranch(bad), /isn't a branch name/, bad);
});

test("plausibleToken turns away fragments and pasted URLs", () => {
  assert.equal(plausibleToken(" github_pat_abcdefgh "), "github_pat_abcdefgh");
  assert.throws(() => plausibleToken("abc"), /whole token/);
  assert.throws(() => plausibleToken("https://github.com/a/b"), /whole token/);
});

test("pushError says what to fix", () => {
  assert.match(pushError("https://github.com/a/b.git", new Error("HTTP Error: 403 Forbidden")), /Contents: read and write/);
  assert.match(pushError("https://github.com/a/b.git", new Error("HTTP Error: 404 Not Found")), /Create the repository on GitHub first/);
  assert.match(pushError("https://github.com/a/b.git", new Error("remote: error: GH006: Protected branch update failed")), /protected/);
});

// Against git servers: the Artifacts shim stands in for both Mergery's own repository and GitHub.
// Runs when the shim is up (npm run shim), or LOOM_E2E_SHIM says where it is.
const shim = process.env.LOOM_E2E_SHIM ?? "http://127.0.0.1:8790";
const shimUp = await fetch(`${shim}/repos`, { method: "OPTIONS" }).then(() => true, () => false);

test("main goes out with its whole history, then only what's new; a copy pushed to directly is left alone unless forced", { skip: !shimUp, timeout: 120_000 }, async () => {
  const { Workspace, DivergedError, HISTORY } = await import("../src/gitops.ts");
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const tag = Date.now().toString(36).slice(-5);
  const repo = async (name: string) => fetch(`${shim}/repos`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: `${name}-${tag}` }) }).then((r) => r.json());
  const home = await repo("mirror-home"), copy = await repo("mirror-copy");
  const withAuth = (r: any) => r.remote.replace("://", `://x:${String(r.token).split("?expires=")[0]}@`);
  const dir = await mkdtemp(join(tmpdir(), "loom-mirror-"));
  const g = (cwd: string, ...args: string[]) => run("git", ["-C", cwd, "-c", "user.name=ann", "-c", "user.email=ann@example.com", ...args], { maxBuffer: 1 << 24 });
  await g(dir, "init", "-q", "-b", "main");
  await writeFile(join(dir, "a.txt"), "0\n");
  await g(dir, "add", ".");
  await g(dir, "commit", "-qm", "c0");
  // A side branch from the very start, merged in at the end: its commits are past a workspace's shallow edge.
  await g(dir, "checkout", "-q", "-b", "side");
  await writeFile(join(dir, "side.txt"), "side\n");
  await g(dir, "add", ".");
  await g(dir, "commit", "-qm", "side work");
  await g(dir, "checkout", "-q", "main");
  for (let i = 1; i <= HISTORY + 20; i++) await g(dir, "commit", "-q", "--allow-empty", "-m", `c${i}`);
  await g(dir, "merge", "-q", "--no-ff", "-m", "merge side", "side");
  const total = HISTORY + 20 + 3;
  await g(dir, "push", "-q", withAuth(home), "main");

  // The first push: the copy is empty, so everything goes.
  let w = await Workspace.open({ url: home.remote, token: home.token });
  const head = (await w.head())!;
  const first = await w.pushOut(copy.remote, copy.token, head);
  assert.deepEqual(first, { before: null, pushed: true, forced: false });
  const out = await mkdtemp(join(tmpdir(), "loom-mirror-out-"));
  await run("git", ["clone", "-q", withAuth(copy), out]);
  assert.equal((await g(out, "rev-parse", "HEAD")).stdout.trim(), head);
  assert.equal(Number((await g(out, "rev-list", "--count", "HEAD")).stdout.trim()), total, "the whole history went, past the shallow edge");
  assert.equal((await g(out, "fsck", "--no-progress")).stderr.includes("missing"), false);

  // Nothing new: nothing moves.
  assert.deepEqual(await w.pushOut(copy.remote, copy.token, head), { before: head, pushed: false, forced: false });

  // Main moves on: only that goes.
  await writeFile(join(dir, "a.txt"), "1\n");
  await g(dir, "commit", "-qam", "next");
  await g(dir, "push", "-q", withAuth(home), "main");
  w = await Workspace.open({ url: home.remote, token: home.token });
  const next = (await w.head())!;
  assert.deepEqual(await w.pushOut(copy.remote, copy.token, next), { before: head, pushed: true, forced: false });
  assert.equal(await Workspace.remoteHead(copy.remote, copy.token), next);

  // Someone pushes to the copy directly: Mergery won't throw their commit away unless told to.
  await g(out, "pull", "-q", "--ff-only");
  await writeFile(join(out, "theirs.txt"), "pushed on GitHub\n");
  await g(out, "add", ".");
  await g(out, "commit", "-qm", "theirs");
  await g(out, "push", "-q", "origin", "main");
  const theirs = (await g(out, "rev-parse", "HEAD")).stdout.trim();
  await writeFile(join(dir, "a.txt"), "2\n");
  await g(dir, "commit", "-qam", "after");
  await g(dir, "push", "-q", withAuth(home), "main");
  w = await Workspace.open({ url: home.remote, token: home.token });
  const after = (await w.head())!;
  await assert.rejects(w.pushOut(copy.remote, copy.token, after), (e: any) => e instanceof DivergedError && e.theirs === theirs);
  assert.equal(await Workspace.remoteHead(copy.remote, copy.token), theirs, "the copy is untouched");
  assert.deepEqual(await w.pushOut(copy.remote, copy.token, after, "main", true), { before: theirs, pushed: true, forced: true });
  assert.equal(await Workspace.remoteHead(copy.remote, copy.token), after);

  // Another branch on the copy, and a token that can't push.
  assert.deepEqual(await w.pushOut(copy.remote, copy.token, after, "mergery/main"), { before: null, pushed: true, forced: false });
  await assert.rejects(Workspace.remoteHead(copy.remote, "art_v1_nope"), /401|403|auth/i);
});
