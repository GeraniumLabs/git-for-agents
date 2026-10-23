// Runners: whatever starts agents for a project (a GitHub Action, a cron job,
// a Claude Code routine, a workflow tool). Loom doesn't run agents itself; it
// says when there is work an agent could pick up, and lets the runner start one.
//
// Two ways to hear it: GET /work, which long-polls like the attention feed, and
// webhooks an owner adds (POST /hooks). A webhook can ask for "work" (new items
// on the work list, each sent once while it stays open) and for any event
// types ("change.merged", or "*" for all). A webhook pointed at GitHub's
// repository_dispatch API is sent in that shape, so a workflow can start on it.

/** What a hook may subscribe to: the work list, or event types. */
export function validHookEvents(x: unknown): string[] {
  const list = x == null ? ["work"] : x;
  if (!Array.isArray(list) || !list.length || list.length > 50) throw new Error('events is a list: "work" (new work for agents), event types like "change.merged", or "*" for every event');
  const bad = list.filter((e) => typeof e !== "string" || !(e === "work" || e === "*" || /^[a-z_]+\.[a-z_]+$/.test(e)));
  if (bad.length) throw new Error(`unknown events ${bad.join(", ")}: use "work", an event type like "change.merged", or "*"`);
  return [...new Set(list as string[])];
}

/** GitHub's "create a repository dispatch event" endpoint, which wants {event_type, client_payload}. */
export function isGitHubDispatch(url: string): boolean {
  return /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/dispatches$/.test(url);
}

/** A webhook's body: Loom's own shape, or GitHub's repository_dispatch shape (at most 10 payload keys). */
export function hookBody(url: string, kind: "work" | "events", payload: { project: string; dashboard: string; mcp: string; work?: unknown[]; events?: unknown[] }) {
  if (isGitHubDispatch(url)) return { event_type: `loom.${kind}`, client_payload: { kind, ...payload } };
  return { kind, ...payload };
}

/** What a runner tells the agent it starts: where it is, and how to find and finish one piece of work. */
export function runnerPrompt(origin: string, project: string): string {
  return `You are a runner agent for the Loom project "${project}" (${origin}/?project=${project}). Loom is where the code lives; you reach it through the "loom" MCP server.

1. Call whoami and do anything on its todo first (directives, review requests, changes sent back to you).
2. Call list_work. Take the first item you can finish in this session:
   - review: take_review, get_change (read its brief first), then review_change with a verdict.
   - contest: compare_attempts, then vote for the attempt that should land, with a reason.
   - fix: the author is away. task_context the task, claim_task it, fix what the change was sent back for, and update_change.
   - task: claim_task, declare_intent for the paths you'll touch, do the work (run_checks if the project has checks), then submit_change with your context.
3. When it's done, take the next item if you have time. Before you stop, release_task anything you won't finish and decline reviews you won't do, so the next runner can pick them up.`;
}
