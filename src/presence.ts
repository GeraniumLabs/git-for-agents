// Agents die without saying so: a laptop closes, a session runs out, a runner
// is killed. Loom only sees them stop calling. This decides when a task an
// agent holds is let go so another agent can pick it up, and when an agent
// that hasn't been seen for a long time stops counting as one of the project's.

/** An agent silent this long while holding a task loses it: the task goes back to the open list. */
export const RELEASE_MS = 30 * 60_000;
/** An agent silent this long is gone: it no longer counts toward the project's agents, and tasks a person assigned it are freed. */
export const GONE_MS = 24 * 3600_000;

/** A task and the agent holding it, as the sweep sees them. */
export type Holding = {
  taskStatus: string;
  /** The task's open change, if it has one. */
  changeStatus: string | null;
  lastSeen: number;
  paused: boolean;
};

/** Change states that wait on the author, not on reviewers or the merge queue. */
const NEEDS_AUTHOR = new Set(["changes_requested", "conflict", "checks_failed"]);

/**
 * When a holding becomes releasable, and the status the task goes back to.
 * null when it never does on its own: the agent is paused (a person decided
 * that), or its change only waits on reviewers or the queue, which need no author.
 */
export function releaseRule(h: Holding): { after: number; status: string } | null {
  if (h.paused) return null;
  switch (h.taskStatus) {
    // Assigned by a person and never claimed: the agent may not have started yet, so give it a day.
    case "open": return { after: GONE_MS, status: "open" };
    // Nothing submitted: the work so far stays in the task's workspace for whoever claims it next.
    case "claimed": case "blocked": return { after: RELEASE_MS, status: "open" };
    // A change exists and needs fixing: keep the task's status, let anyone claim it and take the change over.
    case "conflict": return { after: RELEASE_MS, status: "conflict" };
    case "in_review": return h.changeStatus && NEEDS_AUTHOR.has(h.changeStatus) ? { after: RELEASE_MS, status: "in_review" } : null;
    default: return null;
  }
}

/** The status to release a task to now, or null if its holder still has time. */
export function releaseNow(h: Holding, now: number): string | null {
  const r = releaseRule(h);
  return r && now - h.lastSeen >= r.after ? r.status : null;
}

/** The next time any of these holdings comes due, for the alarm; null if none ever will. */
export function nextRelease(hs: Holding[], now: number): number | null {
  let next = Infinity;
  for (const h of hs) {
    const r = releaseRule(h);
    if (r && h.lastSeen + r.after > now) next = Math.min(next, h.lastSeen + r.after);
  }
  return next < Infinity ? next : null;
}

/** Can another agent take this task from its holder right now? Once the holder has gone quiet, yes. */
export function canTakeOver(taskStatus: string, lastSeen: number | null, now: number, quietMs: number): boolean {
  if (lastSeen == null) return true;
  // A person's assignment holds for a day; a claimed task for as long as the holder keeps calling.
  return now - lastSeen > (taskStatus === "open" ? GONE_MS : quietMs);
}
