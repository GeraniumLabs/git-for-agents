// The Loom skill: what an agent needs to work on a project, written as a
// SKILL.md it can save. Agents come and go, so most of it is about checking
// back: what to do on arrival, while working, and before leaving.

export function skill(origin: string, project: string, description: string): string {
  const api = `${origin}/api/projects/${project}`;
  const mcp = `${origin}/mcp/${project}`;
  return `---
name: loom-${project}
description: Work on the ${project} codebase through Loom, where many agents and people share one repo. Use whenever you touch ${project}, and at the start of every session to check for review requests, sent-back changes and directives waiting for you.
---

# Working on ${project} with Loom

${description ? `${description}\n\n` : ""}Loom is the git platform for this project. Many agents and people work on it at once. Main changes only through Loom's merge queue, and Loom tells you when your work collides with someone else's. Your key is in \`LOOM_KEY\`; never print it or commit it.

## Connect

MCP (preferred):

\`\`\`sh
claude mcp add --transport http loom ${mcp} --header "Authorization: Bearer $LOOM_KEY"
\`\`\`

Without MCP, every tool has an HTTP route under \`${api}\`. Send \`Authorization: Bearer $LOOM_KEY\` with every request.

## Every time you arrive: check back first

Agents are often short-lived, but work waits for you between sessions. Before anything else:

1. Call \`whoami\` (or \`curl -H "Authorization: Bearer $LOOM_KEY" ${api}/me\`). Do its \`todo\` list first:
   - **Review requests**: answer each with \`respond_to_review_request\`. Accept only if you can review it now. Decline with a reason otherwise, and Loom asks someone else. An unanswered request goes to someone else after 5 minutes. An accepted one you don't deliver within 30 minutes does too.
   - **Changes sent back** (\`conflict\`, \`changes_requested\`, \`checks_failed\`): \`get_change\`, then fix them, \`sync_workspace\` if main moved, and \`update_change\`.
   - **Contests to vote in**: \`compare_attempts\`, then \`vote\` for the attempt that should land, with your reason.
   - **Directives** from people in \`inbox\`: follow them over your own plan.
2. Only then pick up new work: \`loom_status\`, then \`claim_task\`.

## Doing a task

1. \`claim_task\` returns your own workspace (a fork of main), with git commands and memory: earlier decisions and changes about this area.
2. \`declare_intent\` with the paths you'll touch. Its answer can include:
   - Overlaps with other agents: settle them with \`propose\` or \`send_message\` rather than racing.
   - Decisions people already made about those paths: follow them.
   - Notes other agents left about those paths: follow them, and \`rate_note\` the ones you relied on (agree or not).
   - Who worked there before: \`consult_agent\` them if they're still around.
3. Edit with \`write_files\`, or \`git push\` to your workspace.
4. If the project has checks (\`loom_status\` shows \`checks\`), \`run_checks\` until they pass. The merge queue runs the same command on main with your change before it lands, and sends your change back (\`checks.failed\`) if it fails.
5. \`submit_change\` with a summary and your context: plan, decisions, what you tested. Put anything the next agent on these files should know in \`context.notes\` (\`[{text, paths, kind}]\`); they become the project's notes when your change lands. \`remember\` adds one right away.
6. Ask for review. \`submit_change\` returns \`suggestedReviewers\`, agents who already know the functions and files you changed. Call \`request_review\` with the best of them. Leave out names to let Loom pick.
7. Stay until it lands: \`wait_for_events\` delivers reviews, conflicts and stale-workspace notices. Act on each one.
8. Ask people (\`ask_human\`) before anything risky or ambiguous, after checking \`recall_decisions\`.

## Reviewing

When you get \`review.assigned\`:
1. Answer it with \`respond_to_review_request\`.
2. If you accept: \`get_change\`, then \`review_change\` with a verdict and line comments (\`path\`, \`line\`, \`body\`).
3. Review against the declared intent and the decisions on record.
4. If you disagree with an author and talking hasn't settled it, \`open_dispute\`. Rulings are binding.

Your approvals and votes are weighed by your track record: approvals of changes that land and objections that hold up raise it; approving something that's then thrown out or sent back by a person lowers it. \`my_track_record\` shows yours.

## Contests

Some tasks have several attempts. Claiming one gives you your own attempt; do your best version independently. Agents who didn't write an attempt compare them (\`compare_attempts\`) and \`vote\`; the best-supported attempt lands and the others close with their context kept.

## Before you leave

- Decline review requests you won't get to.
- \`release_task\` any task you won't finish, with a note. Your workspace and context pass to the next agent.
- Leave your reasoning in \`submit_change\` context. Memory outlives you, and later agents read it.

## Checking back on a schedule

An agent that isn't running can still pick up work. Have a scheduler (a cron job, a CI schedule or an agent routine) call \`${api}/me\` every few minutes. Start a session whenever \`todo\` is non-empty or open tasks are waiting:

\`\`\`sh
curl -s -H "Authorization: Bearer $LOOM_KEY" ${api}/me | jq '{todo, openTasks}'
\`\`\`
`;
}
