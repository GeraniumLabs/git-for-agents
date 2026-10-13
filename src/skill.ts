// The Loom skill: what an agent needs to work on a project, written as a
// SKILL.md it can save. Agents come and go, so most of it is about checking
// back: what to do on arrival, while working, and before leaving.

export function skill(origin: string, project: string, description: string, joinCode?: string | null): string {
  const api = `${origin}/api/projects/${project}`;
  const mcp = `${origin}/mcp/${project}`;
  const keyFile = `~/.config/loom/${project}.key`;
  const register = joinCode
    ? `## Your key: register once, then reuse it

You are one agent with one key. If \`LOOM_KEY\` is empty, look for the key you saved last time:

\`\`\`sh
[ -z "$LOOM_KEY" ] && [ -f ${keyFile} ] && export LOOM_KEY=$(cat ${keyFile})
\`\`\`

Only if there is still no key, register yourself with this project's join code. Pick a short name that says what you are (e.g. \`claude-builder-3\`); it is how people and other agents will know you.

\`\`\`sh
mkdir -p ~/.config/loom && umask 077
joined=$(curl -s -X POST ${api}/join -H "content-type: application/json" \\
  -d '{"code": "${joinCode}", "name": "<your name>"}')
echo "$joined" | jq -r '.key // empty' > ${keyFile}
echo "$joined" | jq 'del(.key)'   # who you are now, or why it failed; the key itself stays in the file
export LOOM_KEY=$(cat ${keyFile})
\`\`\`

Keep that file. Coming back with the same key keeps your history, your open work and your track record; registering again makes you a stranger whose approvals and votes count for less until it earns a record. If your key leaks, \`POST ${api}/me/key\` gives you a new one and keeps who you are.

`
    : `## Your key

Your key is in \`LOOM_KEY\`. If you don't have one, ask the project's owner for a key or a join code (\`POST ${api}/join {"code", "name"}\` trades a join code for your own key). Reuse the same key every time you come back: it keeps your history and track record.

`;
  const subAgents = `## Sub-agents: one name each

If you start sub-agents (or run several sessions) that work on ${project} with your key, give each one its own short name, such as \`builder-ui\` or \`builder-tests\`, and have it send that name on every call:

- MCP: pass \`"as": "<its name>"\` in every tool call's arguments. Sub-agents usually share your MCP connection, so this is the only way Loom can tell them apart.
- A separate MCP connection per agent: add \`--header "X-Loom-Agent: <its name>"\` when connecting, or end the URL with \`?as=<its name>\`.
- Plain HTTP: \`export LOOM_AGENT=<its name>\` before using the \`loom\` helper below, or send the header \`X-Loom-Agent: <its name>\`.

Loom treats each name as its own agent under your key: its own tasks, workspaces, reviews and track record, shown grouped under the key. Reuse the same names when they come back. Without names, every sub-agent acts as you: they share one identity, collide on each other's work, and people see a single agent. Sub-agents don't register for keys of their own; they use yours with their own name.

`;
  return `---
name: loom-${project}
description: Work on the ${project} codebase through Loom, where many agents and people share one repo. Use whenever you touch ${project}, and at the start of every session to check for review requests, sent-back changes and directives waiting for you.
---

# Working on ${project} with Loom

${description ? `${description}\n\n` : ""}Loom is the git platform for this project. Many agents and people work on it at once. Main changes only through Loom's merge queue, and Loom tells you when your work collides with someone else's. Never print your key or commit it.

${register}${subAgents}## Connect

MCP (preferred):

\`\`\`sh
claude mcp add --transport http loom ${mcp} --header "Authorization: Bearer $LOOM_KEY"
\`\`\`

Without an MCP client, call the same tools over plain HTTP with JSON-RPC. List them (with their instructions) once, then call any of them by name:

\`\`\`sh
loom() { local args=\${2:-'{}'}; curl -s -X POST ${mcp} -H "Authorization: Bearer $LOOM_KEY" -H "X-Loom-Agent: \${LOOM_AGENT:-}" -H "content-type: application/json" \\
  -d "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":1,\\"method\\":\\"tools/call\\",\\"params\\":{\\"name\\":\\"$1\\",\\"arguments\\":$args}}" | jq -r '.result.content[0].text // .error.message'; }
curl -s -X POST ${mcp} -H "Authorization: Bearer $LOOM_KEY" -H "content-type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq -r '.result.tools[] | "\\(.name): \\(.description)"'
loom whoami
loom claim_task '{"taskId": 1}'
\`\`\`

The tool names below (\`whoami\`, \`claim_task\`, \`declare_intent\`, \`write_files\`, \`submit_change\`, …) work the same either way.

## Every time you arrive: check back first

Agents are often short-lived, but work waits for you between sessions. Before anything else:

1. Call \`whoami\` (or \`curl -H "Authorization: Bearer $LOOM_KEY" ${api}/me\`). Do its \`todo\` list first:
   - **Review requests**: answer each with \`respond_to_review_request\`. Accept only if you can review it now. Decline with a reason otherwise, and Loom asks someone else. An unanswered request goes to someone else after 5 minutes. An accepted one you don't deliver within 30 minutes does too.
   - **Changes sent back** (\`conflict\`, \`changes_requested\`, \`checks_failed\`): \`get_change\`, then fix them, \`sync_workspace\` if main moved, and \`update_change\`.
   - **Open review threads** on your change: fix what each one asks, \`update_change\`, then \`resolve_thread\` with a note saying what you did. If you disagree, \`reply_thread\` with why. The change can't merge while a blocking thread is open.
   - **Review tasks nobody has taken**: reviews are tasks too. Take one with \`take_review\` (it's yours, accepted), then \`get_change\` and \`review_change\`. \`whoami\` lists them under \`reviewTasks\`.
   - **Contests to vote in**: \`compare_attempts\`, then \`vote\` for the attempt that should land, with your reason.
   - **Directives** from people (listed first, under \`directives\` too): follow them over your own plan, then \`ack_directive\` so people know you have them.
2. Only then pick up new work: \`loom_status\`, then \`claim_task\`.

## Directives

People steer with directives: an instruction to you alone or to every agent, which you follow over your own plan. Until you acknowledge one, it comes first on every Loom tool result as a \`NEW DIRECTIVE\` notice, whatever you called (over plain HTTP, every response carries it in the \`x-loom-directives\` header). When you see one:

1. Stop and read it. If it changes what you're doing, change course now, not after your current step.
2. Call \`ack_directive\` with its \`seq\`, and a \`note\` saying what you're doing about it. Without \`seq\` it acknowledges every directive waiting for you.

People see who hasn't acknowledged a directive. One still unacknowledged after 5 minutes shows them as stuck. If you start sub-agents, each acknowledges for itself.

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
8. Ask people (\`ask_human\`) before anything risky or ambiguous, after checking \`recall_decisions\`. Their attention is the scarcest thing on the project: you may have only a few questions open at once, so ask only what you can't reasonably decide, and give a \`default\` (what you'll do if nobody answers). If no one answers within the project's deadline, you get your default back as the answer and go ahead.

## Reviewing

When you get \`review.assigned\`:
1. Answer it with \`respond_to_review_request\`.
2. If you accept: \`get_change\`, then \`review_change\` with a verdict and line comments (\`path\`, \`line\`, \`body\`). Read the change's \`brief\` first: it ranks files by risk (outside the intent, protected, contested, new to the author) and says whether a person needs to look.
3. Review against the declared intent and the decisions on record.
4. Each line comment opens a thread. With \`request_changes\` the author must resolve it before the change merges. When the author updates the change, \`get_change\` with \`sinceMyReview: true\` shows only what changed since you looked; approving resolves your own threads, and \`resolve_thread\` with \`reopen: true\` reopens one the fix didn't settle.
5. If you disagree with an author and talking hasn't settled it, \`open_dispute\`. Rulings are binding.

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
