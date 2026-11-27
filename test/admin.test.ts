import { test } from "node:test";
import assert from "node:assert/strict";
import { adminReport, pool, type ProjectUsage, type RegistryDump } from "../src/admin";

const DAY = 86_400_000;
const now = Date.UTC(2026, 10, 27, 12);
const usage = (over: Partial<ProjectUsage>): ProjectUsage => ({
  project: "x", plan: "free", visibility: "public", importedFrom: null, people: [], agents: 0, agentsActive7d: 0, tasks: 0,
  changes: {}, changesTotal: 0, changes7d: 0, merged7d: 0, reviews: 0, events: 0, mainVersion: 0,
  traces: { count: 0, bytes: 0, tokens: 0, costUsd: 0 }, attachments: { count: 0, bytes: 0 }, checkMinutes30d: 0, lastActivity: null, daily: {}, ...over,
});
const reg: RegistryDump = {
  signins: [{ login: "ada", name: "Ada L", avatar: "https://a/u?v=4", first_at: now - 2 * DAY, last_at: now - DAY, count: 3 }],
  projects: [
    { name: "calc", created_at: now - 40 * DAY, private: false, jurisdiction: null, owner: "ada", hidden: false, org: null },
    { name: "demo-1", created_at: now - 3 * DAY, private: false, jurisdiction: null, owner: "jonathanherr", hidden: true, org: null },
    { name: "acme-app", created_at: now - 5 * DAY, private: true, jurisdiction: "eu", owner: "bob", hidden: false, org: "acme" },
  ],
  plans: [{ login: "ada", plan: "pro", status: "active", renews: null, updated_at: now - 10 * DAY }, { login: "org:acme", plan: "pro", status: "active", renews: null, updated_at: now }],
  waitlist: [{ login: "cy", name: "Cy", asked_at: now - DAY, asks: 1 }],
  creators: [],
  orgs: [{ slug: "acme", name: "Acme", created_by: "bob", created_at: now - 6 * DAY }],
  orgMembers: [{ org: "acme", login: "bob", role: "owner", added_at: now - 6 * DAY }],
  emails: [{ login: "ada", email: "ada@example.com", updated_at: now - 20 * DAY }],
};

test("admin report: people from sign-ins and older records, usage by owner", () => {
  const u = new Map<string, ProjectUsage | { error: string }>([
    ["calc", usage({ people: [{ login: "ada", owner: true, joined: now - 40 * DAY, lastSeen: now - 3600_000 }, { login: "dee", owner: false, joined: now - 4 * DAY, lastSeen: null }], agents: 2, agentsActive7d: 1, changesTotal: 5, changes: { merged: 4, open: 1 }, merged7d: 2, traces: { count: 3, bytes: 1000, tokens: 50, costUsd: 0.1 }, attachments: { count: 1, bytes: 24 }, lastActivity: now - 3600_000, daily: { "2026-11-26": { events: 9, merged: 2 } } })],
    ["demo-1", usage({ agents: 6, changesTotal: 6 })],
    ["acme-app", { error: "HTTP 500" }],
  ]);
  const r = adminReport(reg, u, now);
  const ada = r.people.find((p) => p.login === "ada")!;
  // The project she made 40 days ago is earlier than her first recorded sign-in.
  assert.equal(ada.firstSeen, now - 40 * DAY);
  assert.equal(ada.firstSeenEstimated, false);
  assert.equal(ada.signIns, 3);
  assert.equal(ada.plan, "pro");
  assert.equal(ada.email, "ada@example.com");
  assert.deepEqual(ada.owns, ["calc"]);
  assert.equal(ada.usage.changes, 5);
  assert.equal(ada.usage.storageBytes, 1024);
  assert.equal(ada.lastActive, now - 3600_000);
  const dee = r.people.find((p) => p.login === "dee")!;
  assert.deepEqual(dee.memberOf, ["calc"]);
  assert.equal(dee.firstSeenEstimated, true);
  assert.equal(r.people.find((p) => p.login === "cy")!.waitlisted, true);
  assert.deepEqual(r.people.find((p) => p.login === "bob")!.orgs, ["acme"]);
  // Hidden projects stay out of the totals; org projects don't count toward a person.
  assert.equal(r.totals.projects, 2);
  assert.equal(r.totals.hiddenProjects, 1);
  assert.equal(r.totals.agents, 2);
  assert.equal(r.totals.pro, 1);
  assert.equal(r.totals.proOrgs, 1);
  assert.equal(r.totals.unreachable, 1);
  assert.equal(r.people.find((p) => p.login === "bob")!.usage.projects, 0);
  assert.equal(r.projects.find((p) => p.name === "acme-app")!.error, "HTTP 500");
  assert.equal(r.signupsByDay.length, 30);
  assert.equal(r.activityByDay.find((d) => d.day === "2026-11-26")!.merged, 2);
  assert.equal(r.totals.signups7d, 4); // dee, cy, bob, jonathanherr (ada was first seen 40 days ago)
  assert.equal(r.people[0].firstSeen! >= r.people.at(-1)!.firstSeen!, true);
});

test("pool runs everything, a few at a time", async () => {
  let running = 0, most = 0;
  const out = await pool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => { running++; most = Math.max(most, running); await new Promise((r) => setTimeout(r, 5)); running--; return n * 2; });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14]);
  assert.equal(most, 3);
});
