import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_RECORD, MAX_WEIGHT, MIN_WEIGHT, tally, trust } from "../src/reputation.ts";

test("a newcomer's approval counts for exactly one", () => {
  const t = trust(EMPTY_RECORD);
  assert.equal(t.weight, 1);
  assert.equal(t.score, 0.5);
  assert.equal(t.summary, "no track record yet");
});

test("judgment that held up earns weight, judgment that didn't loses it", () => {
  const good = trust({ ...EMPTY_RECORD, approvalsLanded: 6, objectionsUpheld: 2, votesWon: 2 });
  const bad = trust({ ...EMPTY_RECORD, approvalsMissed: 3, votesLost: 2 });
  assert.ok(good.weight > 1.3, `good weight ${good.weight}`);
  assert.ok(bad.weight < 0.7, `bad weight ${bad.weight}`);
});

test("one lucky outcome doesn't make an oracle", () => {
  assert.ok(trust({ ...EMPTY_RECORD, approvalsLanded: 1 }).weight < 1.15);
});

test("being sent back is normal and costs little", () => {
  const t = trust({ ...EMPTY_RECORD, landed: 4, sentBack: 4 });
  assert.ok(t.weight > 1, `weight ${t.weight}`);
});

test("weights stay within bounds", () => {
  assert.ok(trust({ ...EMPTY_RECORD, approvalsLanded: 10_000 }).weight <= MAX_WEIGHT);
  assert.ok(trust({ ...EMPTY_RECORD, approvalsMissed: 10_000 }).weight >= MIN_WEIGHT);
});

test("tally ranks candidates by weight, then by number of votes", () => {
  const t = tally([
    { candidate: "a", weight: 0.9 },
    { candidate: "b", weight: 1.2 },
    { candidate: "a", weight: 0.3 },
    { candidate: "c", weight: 1.2 },
  ]);
  assert.deepEqual(t.map((x) => x.candidate), ["a", "b", "c"]);
  assert.equal(t[0].weight, 1.2);
  assert.equal(t[0].votes, 2);
});
