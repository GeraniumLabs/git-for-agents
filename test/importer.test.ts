import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { githubRepo, issueTask, openIssues, sourceUrl } from "../src/importer";

test("import URLs: https only, no credentials, GitHub normalized to its clone URL", () => {
  assert.equal(sourceUrl("https://github.com/acme/widgets"), "https://github.com/acme/widgets.git");
  assert.equal(sourceUrl(" https://github.com/acme/widgets.git/ "), "https://github.com/acme/widgets.git");
  assert.equal(sourceUrl("https://gitlab.com/acme/widgets.git"), "https://gitlab.com/acme/widgets.git");
  assert.throws(() => sourceUrl("git@github.com:acme/widgets.git"), /isn't a URL|https/);
  assert.throws(() => sourceUrl("http://example.com/x.git"), /https/);
  assert.throws(() => sourceUrl("https://me:secret@github.com/acme/widgets"), /credentials/);
  assert.deepEqual(githubRepo("https://github.com/acme/widgets.git"), { owner: "acme", repo: "widgets" });
  assert.equal(githubRepo("https://gitlab.com/acme/widgets"), null);
});

test("an issue becomes a task that links back and remembers where it came from", () => {
  const t = issueTask({ owner: "acme", repo: "widgets" }, { number: 7, title: "Crash on save", body: "Steps…", url: "https://github.com/acme/widgets/issues/7", author: "ann", labels: ["bug"] });
  assert.equal(t.title, "Crash on save");
  assert.equal(t.source, "github:acme/widgets#7");
  assert.match(t.description, /^Steps…\n\nImported from acme\/widgets#7 \(https:\/\/github.com\/acme\/widgets\/issues\/7\), opened by @ann; labels: bug\.$/);
});

test("open issues are paged, and pull requests are left out", async () => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(`${req.url} ${req.headers.authorization ?? ""}`);
    const page = Number(new URL(req.url!, "http://x").searchParams.get("page"));
    const rows = page === 1
      ? Array.from({ length: 100 }, (_, i) => (i % 10 === 0 ? { number: i + 1, title: `PR ${i + 1}`, pull_request: {} } : { number: i + 1, title: `Issue ${i + 1}`, body: null, html_url: `https://github.com/a/b/issues/${i + 1}`, user: { login: "u" }, labels: [{ name: "x" }] }))
      : [{ number: 101, title: "Last", body: "b", html_url: "h", user: null, labels: [] }];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(rows));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const api = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const all = await openIssues({ owner: "a", repo: "b" }, { api, token: "tok" });
    assert.equal(all.length, 91);
    assert.equal(all.at(-1)!.title, "Last");
    assert.ok(all.every((i) => !i.title.startsWith("PR")));
    assert.match(seen[0], /\/repos\/a\/b\/issues\?state=open.*page=1 Bearer tok/);
    assert.equal((await openIssues({ owner: "a", repo: "b" }, { api, limit: 5 })).length, 5);
  } finally {
    server.close();
  }
});
