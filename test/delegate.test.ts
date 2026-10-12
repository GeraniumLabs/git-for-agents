import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_DELEGATE, decideFlagged, type DelegateConfig } from "../src/delegate.ts";

// A stand-in for the decision model: answers each yes/no question with the given probability.
function judgeSaying(answers: Record<string, number>) {
  const seen: any[] = [];
  globalThis.fetch = (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    seen.push(body);
    return new Response(JSON.stringify({ answers: Object.fromEntries(Object.keys(body.questions).map((k) => [k, { type: "noul", noul: answers[k] ?? 0 }])) }));
  }) as any;
  return { judge: { provider: "typesafe" as const, apiKey: "test", url: "http://judge.test" }, seen };
}

const cfg = (over: Partial<DelegateConfig["flagged"]> = {}, rest: Partial<DelegateConfig> = {}): DelegateConfig => ({
  ...DEFAULT_DELEGATE, enabled: true, guidance: "Approve changes outside the declared intent while tests aren't feasible, very early during bootstrap.",
  flagged: { ...DEFAULT_DELEGATE.flagged, enabled: true, ...over }, ...rest,
});
const change = {
  reasons: ["2 files outside the declared intent", "Changes code without changing any tests"],
  agentApprovals: 1, title: "Scaffold the CLI", summary: "", intent: "src/cli.ts", patch: "--- a/src/cli.ts\n+++ b/src/cli.ts\n+x\n",
  project: {
    concept: "A CLI for tidying photo libraries", age_days: 0, agents: { total: 4, working_now: 3, people: 1 },
    main: { merged_changes: 3, version: 3, test_files: 0 }, in_flight: { open_tasks: 6, changes_in_review: 2 },
    recently_merged: ["Scaffold the repo"], protected_paths: [],
  },
};

test("the deputy clears a flagged change the guidance allows, and the model sees where the project stands", async () => {
  const { judge, seen } = judgeSaying({ allowed: 0.95, risky: 0.02, high_stakes: 0.1 });
  const v = await decideFlagged(cfg(), change, judge);
  assert.equal(v.act, true);
  assert.deepEqual(seen[0].state.project, change.project);
  assert.deepEqual(seen[0].state.change.flagged_because, change.reasons);
});

test("the deputy hands a flagged change to a person when unsure, risky or high-stakes", async () => {
  assert.equal((await decideFlagged(cfg(), change, judgeSaying({ allowed: 0.6, risky: 0, high_stakes: 0 }).judge)).act, false);
  assert.equal((await decideFlagged(cfg(), change, judgeSaying({ allowed: 0.99, risky: 0.5, high_stakes: 0 }).judge)).act, false);
  assert.equal((await decideFlagged(cfg(), change, judgeSaying({ allowed: 0.99, risky: 0, high_stakes: 0.7 }).judge)).act, false);
});

test("the deputy doesn't judge flagged changes when off, not allowed, unguided or before an agent review", async () => {
  const { judge, seen } = judgeSaying({ allowed: 1 });
  const reasons = [
    await decideFlagged(cfg({}, { enabled: false }), change, judge),
    await decideFlagged(cfg({ enabled: false }), change, judge),
    await decideFlagged(cfg({}, { guidance: " " }), change, judge),
    await decideFlagged(cfg(), { ...change, agentApprovals: 0 }, judge),
  ].map((v) => (v.act ? "acted" : v.reason));
  assert.deepEqual(reasons, ["deputy is off", "deputy isn't allowed to clear changes flagged for a person", "the humans haven't written guidance for deputy yet", "waiting for an agent review first"]);
  assert.equal(seen.length, 0);
  assert.equal((await decideFlagged(cfg({ requireAgentReview: false }), { ...change, agentApprovals: 0 }, judgeSaying({ allowed: 0.9, risky: 0, high_stakes: 0 }).judge)).act, true);
});
