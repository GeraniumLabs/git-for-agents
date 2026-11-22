import { test } from "node:test";
import assert from "node:assert/strict";
import { TrustLink, sourcesFor, titleFor, type TrustStore } from "../src/trust.ts";

// A stand-in for Trust's HTTP API: just enough to check what the add-on sends.
function fakeTrust() {
  const calls: { method: string; path: string; auth: string; body: any }[] = [];
  let n = 0;
  const revoked = new Set<string>();
  const state = { down: false };
  const f = (async (url: string, init: any) => {
    if (state.down) throw new Error("connect ECONNREFUSED");
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    const auth = (init.headers.authorization as string).replace("Bearer ", "");
    calls.push({ method: init.method, path, auth, body });
    const ok = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
    if (path === "/api/spaces") return auth === "boot" ? ok({ space: "sp1", adminToken: "adm" }) : new Response('{"error":"no"}', { status: 401 });
    if (path.endsWith("/sessions")) { n++; return ok({ id: `s${n}`, token: `agt${n}`, token_expires_at: Date.now() + 3_600_000 }); }
    if (revoked.has(auth)) return new Response('{"error":"expired"}', { status: 401 });
    if (path.endsWith("/remember")) return ok({ id: `e${calls.length}` });
    if (path.endsWith("/retract")) return ok({ retracted: [body.entry] });
    if (path.endsWith("/changes")) return ok({ id: "ch-1" });
    if (path.endsWith("/source-changed")) return ok({ flagged: body.uri === "src/a.ts" ? ["e9"] : [] });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { f, calls, revoked, state };
}

function memoryStore(): TrustStore & { saved: number } {
  let space: { id: string; adminToken: string } | null = null;
  const links = new Map<string, string>();
  return {
    saved: 0,
    async space() { return space; },
    async saveSpace(id, adminToken) { space = { id, adminToken }; this.saved++; },
    entryFor: (l) => links.get(l) ?? null,
    link: (l, e) => void links.set(l, e),
  };
}

test("creates the project's space once and keeps its admin token", async () => {
  const t = fakeTrust(), store = memoryStore();
  const link = new TrustLink({ url: "http://trust.test", bootstrap: "boot", project: "demo", store, fetch: t.f });
  await link.remember("note:1", "agent-a", { title: "x", body: "x", kind: "fact", sources: [], derivation: "observed" });
  await link.remember("note:2", "agent-a", { title: "y", body: "y", kind: "fact", sources: [], derivation: "observed" });
  assert.equal(store.saved, 1);
  const create = t.calls.filter((c) => c.path === "/api/spaces");
  assert.equal(create.length, 1);
  assert.equal(create[0].auth, "boot");
  assert.deepEqual(create[0].body.scopes, [{ id: "project", label: "demo", kind: "project" }]);
  // One session per agent, reused; sessions are started with the admin token, writes use the agent's.
  assert.equal(t.calls.filter((c) => c.path.endsWith("/sessions")).length, 1);
  assert.ok(t.calls.filter((c) => c.path.endsWith("/remember")).every((c) => c.auth === "agt1" && c.body.session === "s1"));
});

test("a note is mirrored once, and retiring it retracts the same entry", async () => {
  const t = fakeTrust(), store = memoryStore();
  const link = new TrustLink({ url: "http://trust.test", bootstrap: "boot", project: "demo", store, fetch: t.f });
  await link.remember("note:7", "agent-a", { title: "t", body: "b", kind: "fact", sources: sourcesFor(["src/a.ts"], "abc123"), derivation: "observed" });
  assert.equal(await link.remember("note:7", "agent-a", { title: "t", body: "b", kind: "fact", sources: [], derivation: "observed" }), null);
  const sent = t.calls.find((c) => c.path.endsWith("/remember"))!;
  assert.deepEqual(sent.body.sources, [{ uri: "src/a.ts", kind: "file", hash: "abc123" }]);
  const entry = store.entryFor("note:7");
  await link.retract("note:7", "person", "retired");
  assert.equal(t.calls.at(-1)!.body.entry, entry);
  // A note Trust never saw (written before the add-on was on) is nothing to retract.
  const before = t.calls.length;
  assert.equal(await link.retract("note:99", "person", "retired"), null);
  assert.equal(t.calls.length, before);
});

test("a refused agent token gets one fresh session and a retry", async () => {
  const t = fakeTrust(), store = memoryStore();
  const link = new TrustLink({ url: "http://trust.test", bootstrap: "boot", project: "demo", store, fetch: t.f });
  await link.remember("note:1", "agent-a", { title: "a", body: "a", kind: "fact", sources: [], derivation: "observed" });
  t.revoked.add("agt1");
  await link.remember("note:2", "agent-a", { title: "b", body: "b", kind: "fact", sources: [], derivation: "observed" });
  assert.equal(t.calls.at(-1)!.auth, "agt2");
  assert.ok(store.entryFor("note:2"));
});

test("a merge records the change and flags memories on each changed file", async () => {
  const t = fakeTrust(), store = memoryStore();
  const link = new TrustLink({ url: "http://trust.test", bootstrap: "boot", project: "demo", store, fetch: t.f });
  const out = await link.merged("agent-a", "def456", "#3 Fix rounding", ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(out.flagged, ["e9"]);
  const change = t.calls.find((c) => c.path.endsWith("/changes"))!;
  assert.equal(change.auth, "adm");
  assert.deepEqual(change.body, { session: "s1", ref: "def456", title: "#3 Fix rounding" });
  const watched = t.calls.filter((c) => c.path.endsWith("/source-changed")).map((c) => c.body);
  assert.deepEqual(watched, [{ scope: "project", uri: "src/a.ts", hash: "def456" }, { scope: "project", uri: "src/b.ts", hash: "def456" }]);
});

test("failures surface as errors for the caller to log, never as partial state", async () => {
  const t = fakeTrust(), store = memoryStore();
  const bad = new TrustLink({ url: "http://trust.test", bootstrap: "wrong", project: "demo", store, fetch: t.f });
  await assert.rejects(bad.remember("note:1", "a", { title: "a", body: "a", kind: "fact", sources: [], derivation: "observed" }), /didn't create a space \(HTTP 401/);
  assert.equal(await store.space(), null);
  t.state.down = true;
  const link = new TrustLink({ url: "http://trust.test", bootstrap: "boot", project: "demo", store, fetch: t.f });
  await assert.rejects(link.remember("note:1", "a", { title: "a", body: "a", kind: "fact", sources: [], derivation: "observed" }), /ECONNREFUSED/);
  assert.equal(store.entryFor("note:1"), null);
});

test("titles are the first sentence, cut short", () => {
  assert.equal(titleFor("Totals round half-even. Not half-up."), "Totals round half-even.");
  assert.equal(titleFor("x".repeat(150)).length, 98);
  assert.deepEqual(sourcesFor(["a"], null), [{ uri: "a", kind: "file" }]);
});

test("a pasted space URL is split into its server and space", async () => {
  const { parseSpaceUrl } = await import("../src/trust.ts");
  assert.deepEqual(parseSpaceUrl(" https://trust.example.dev/api/spaces/ab12cd34ef56/ "), { base: "https://trust.example.dev", space: "ab12cd34ef56" });
  assert.equal(parseSpaceUrl("https://trust.example.dev/demo/ab12"), null);
  assert.equal(parseSpaceUrl("trust.example.dev/api/spaces/x"), null);
});

test("checking a space refuses a wrong key and adds the project scope when it's missing", async () => {
  const { checkSpace } = await import("../src/trust.ts");
  const seen: string[] = [];
  const f = (async (url: string, init: any = {}) => {
    seen.push(`${init.method ?? "GET"} ${new URL(url).pathname}`);
    if (init.headers.authorization !== "Bearer good") return new Response('{"error":"no"}', { status: 401 });
    if ((init.method ?? "GET") === "GET") return new Response(JSON.stringify({ name: "x", persistent: true, scopes: [{ id: "other" }] }));
    return new Response("{}");
  }) as unknown as typeof fetch;
  await assert.rejects(checkSpace("https://t", "s1", "bad", "demo", f), /refused that key/);
  assert.deepEqual(await checkSpace("https://t", "s1", "good", "demo", f), { name: "x", persistent: true });
  assert.equal(seen.at(-1), "POST /api/spaces/s1/scopes");
});
