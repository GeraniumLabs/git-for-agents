// Track records: Loom remembers how each agent's work and judgment turned
// out, and weighs its approvals and votes by that. Pure helpers; the
// coordinator counts the outcomes from its tables.

/** What happened to an agent's changes, reviews and votes. */
export interface TrackRecord {
  /** Changes it wrote that landed on main. */
  landed: number;
  /** Of those, how many landed without ever being sent back. */
  firstPass: number;
  /** Changes it wrote that were closed without landing (lost a contest, abandoned). */
  closed: number;
  /** Times reviewers sent its changes back. */
  sentBack: number;
  /** Times its changes conflicted in the merge queue. */
  conflicts: number;
  /** Changes it approved that landed. */
  approvalsLanded: number;
  /** Changes it approved that were then closed, or that a person sent back at the same commit. */
  approvalsMissed: number;
  /** Requests for changes after which the author changed the code, or the change was closed. */
  objectionsUpheld: number;
  /** Requests for changes the change landed over, unchanged (overruled by a ruling or by other reviewers). */
  objectionsOverruled: number;
  /** Contest votes for the attempt that won, and for one that lost. */
  votesWon: number;
  votesLost: number;
}

export const EMPTY_RECORD: TrackRecord = {
  landed: 0, firstPass: 0, closed: 0, sentBack: 0, conflicts: 0,
  approvalsLanded: 0, approvalsMissed: 0, objectionsUpheld: 0, objectionsOverruled: 0, votesWon: 0, votesLost: 0,
};

export interface Trust {
  /** 0..1: the share of good outcomes, pulled toward 0.5 while there are few of them. */
  score: number;
  /** How many outcomes the score rests on. */
  outcomes: number;
  /** What one approval or vote by this agent counts for. A newcomer's counts for 1. */
  weight: number;
  /** A line a person can read. */
  summary: string;
}

/** Prior: every agent starts as if it had 2 good and 2 bad outcomes, so a lucky first change doesn't make it an oracle. */
const PRIOR = 2;
/** Outcomes at which the record counts for half of what it can. */
const HALF_CONFIDENCE = 5;
export const MIN_WEIGHT = 0.25;
export const MAX_WEIGHT = 2;

/**
 * Good outcomes are work that landed and judgment that held up. Bad ones are
 * work that was thrown away and judgment that didn't. Being sent back or
 * conflicting is normal on a busy project, so each counts for a quarter.
 */
export function trust(r: TrackRecord): Trust {
  const good = r.landed + r.firstPass * 0.5 + r.approvalsLanded + r.objectionsUpheld + r.votesWon;
  const bad = r.closed + 0.25 * (r.sentBack + r.conflicts) + r.approvalsMissed * 1.5 + r.objectionsOverruled + r.votesLost;
  const outcomes = good + bad;
  const score = (good + PRIOR) / (outcomes + 2 * PRIOR);
  const confidence = outcomes / (outcomes + HALF_CONFIDENCE);
  const weight = clamp(1 + (score - 0.5) * 2 * confidence, MIN_WEIGHT, MAX_WEIGHT);
  return { score: round(score), outcomes: round(outcomes), weight: round(weight), summary: describe(r) };
}

function describe(r: TrackRecord): string {
  const parts: string[] = [];
  if (r.landed || r.closed) parts.push(`${r.landed} landed${r.firstPass ? ` (${r.firstPass} first time)` : ""}${r.closed ? `, ${r.closed} closed` : ""}`);
  if (r.approvalsLanded || r.approvalsMissed) parts.push(`approvals ${r.approvalsLanded} held up${r.approvalsMissed ? `, ${r.approvalsMissed} missed` : ""}`);
  if (r.objectionsUpheld || r.objectionsOverruled) parts.push(`objections ${r.objectionsUpheld} upheld${r.objectionsOverruled ? `, ${r.objectionsOverruled} overruled` : ""}`);
  if (r.votesWon || r.votesLost) parts.push(`votes ${r.votesWon} for the winner, ${r.votesLost} not`);
  return parts.length ? parts.join("; ") : "no track record yet";
}

/** Weighted tally of votes for each candidate. Returns candidates best first. */
export function tally<C>(votes: { candidate: C; weight: number }[]): { candidate: C; weight: number; votes: number }[] {
  const by = new Map<C, { candidate: C; weight: number; votes: number }>();
  for (const v of votes) {
    const t = by.get(v.candidate) ?? { candidate: v.candidate, weight: 0, votes: 0 };
    t.weight = round(t.weight + v.weight);
    t.votes++;
    by.set(v.candidate, t);
  }
  return [...by.values()].sort((a, b) => b.weight - a.weight || b.votes - a.votes);
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const round = (x: number) => Math.round(x * 100) / 100;
