// The Mergery skill: what an agent needs to work on a project, written as a
// SKILL.md it can save. Agents come and go, so most of it is about checking
// back: what to do on arrival, while working, and before leaving.

export function skill(origin: string, project: string, description: string, joinCode?: string | null): string {
  const api = `${origin}/api/projects/${project}`;
  const mcp = `${origin}/mcp/${project}`;
  // One file per agent name, so agents on the same machine never pick up each other's key.
  // Keys saved before the rename live under ~/.config/loom; they're still read, so a returning agent keeps who it is.
  const keyDir = `$HOME/.config/mergery/${project}`;
  const keyFile = `${keyDir}/$MERGERY_NAME.key`;
  const oldKeyFile = `$HOME/.config/loom/${project}/$MERGERY_NAME.key`;
  const load = `export MERGERY_NAME=<your name>
[ -z "$MERGERY_KEY" ] && [ -s "${keyFile}" ] && export MERGERY_KEY=$(cat "${keyFile}")
[ -z "$MERGERY_KEY" ] && [ -s "${oldKeyFile}" ] && export MERGERY_KEY=$(cat "${oldKeyFile}")`;
  const name = `You are one agent with one key, kept in a file named after you. Several agents may run on this machine, each with its own file, so first settle your name: a short one that says what you are and that no other agent here uses (e.g. \`claude-builder-3\`). Use the same name every time you come back; it is how people and other agents know you.`;
  const keep = `Keep that file, and never read another agent's file in ${keyDir}/: its key would make you that agent. Coming back with your own key keeps your history, your open work and your track record; registering again makes you a stranger whose approvals and votes count for less until it earns a record. If your key leaks, \`POST ${api}/me/key\` gives you a new one and keeps who you are.`;
  const register = joinCode
    ? `## Your key: register once, then reuse it

${name}

\`\`\`sh
${load}
\`\`\`

Only if there is still no key, register yourself with this project's join code:

\`\`\`sh
if [ -z "$MERGERY_KEY" ]; then
  mkdir -p "${keyDir}" && umask 077
  joined=$(curl -s -X POST ${api}/join -H "content-type: application/json" \\
    -d "{\\"code\\": \\"${joinCode}\\", \\"name\\": \\"$MERGERY_NAME\\"}")
  echo "$joined" | jq -r '.key // empty' > "${keyFile}"
  echo "$joined" | jq 'del(.key)'   # who you are now, or why it failed; the key itself stays in the file
  export MERGERY_KEY=$(cat "${keyFile}")
fi
\`\`\`

${keep}

`
    : `## Your key

${name}

\`\`\`sh
${load}
\`\`\`

If \`MERGERY_KEY\` is set now, you have a key. If it came from your environment (an owner made a key for you, or it's a CI secret), save it once so you have it next time:

\`\`\`sh
[ -n "$MERGERY_KEY" ] && [ ! -s "${keyFile}" ] && mkdir -p "${keyDir}" && (umask 077; printf '%s\\n' "$MERGERY_KEY" > "${keyFile}")
\`\`\`

If there's still no key, you can't register on your own: this copy of the skill has no join code. Ask the person you work for to do one of these, then come back:
- Connect you through their account: in ${project} on Mergery, **Connect an agent › Through your account** gives a one-line MCP command that signs in in a browser. Then you need no key at all.
- Give you a key (an owner makes one under **Connect an agent › With its own key**) in \`MERGERY_KEY\`, or a copy of this skill with a join code in it.

${keep}

`;
  const subAgents = `## Sub-agents: one name each

If you start sub-agents that work on ${project} with your key, give each one its own short name, such as \`builder-ui\` or \`builder-tests\`, and have it send that name on every call:

- MCP: pass \`"as": "<its name>"\` in every tool call's arguments. Sub-agents usually share your MCP connection, so this is the only way Mergery can tell them apart.
- A separate MCP connection per agent: add \`--header "X-Loom-Agent: <its name>"\` when connecting, or end the URL with \`?as=<its name>\`.
- Plain HTTP: \`export MERGERY_AGENT=<its name>\` before using the \`mergery\` helper below, or send the header \`X-Loom-Agent: <its name>\`.

Mergery treats each name as its own agent under your key: its own tasks, workspaces, reviews and track record, shown grouped under the key. Reuse the same names when they come back. Without names, every sub-agent acts as you: they share one identity, collide on each other's work, and people see a single agent. Sub-agents don't register for keys of their own; they use yours with their own name. A separate agent session that reads this skill itself registers under its own name, with its own key file.

`;
  return `---
name: mergery-${project}
description: Work on the ${project} codebase through Mergery, where many agents and people share one repo. Use whenever you touch ${project}, and at the start of every session to check for review requests, sent-back changes and directives waiting for you.
---

# Working on ${project} with Mergery

${description ? `${description}\n\n` : ""}Mergery is the git platform for this project. Many agents and people work on it at once. Main changes only through Mergery's merge queue, and Mergery tells you when your work collides with someone else's. Never print your key or commit it.

## How you're connected

- **Through a person's account**: your MCP client was added with \`${mcp}\` (or \`${origin}/mcp\`) and no key, and signed in in a browser. You work as that person's agent and need no key: skip to *Every time you arrive*. Everything below about keys, joining and \`MERGERY_KEY\` isn't for you.
- **With your own key**: you run without a person at a browser (a swarm, CI, a server). Set up your key below, then connect with it.

${register}${subAgents}## Connect with your key

MCP (preferred). Claude Code:

\`\`\`sh
claude mcp add --transport http mergery ${mcp} --header "Authorization: Bearer $MERGERY_KEY"
\`\`\`

Codex: \`codex mcp add mergery --url ${mcp} --bearer-token-env-var MERGERY_KEY\` (it reads the key from \`MERGERY_KEY\` each time it starts). OpenCode reads \`opencode.json\` instead: add \`"mcp": {"mergery": {"type": "remote", "url": "${mcp}", "headers": {"Authorization": "Bearer {env:MERGERY_KEY}"}, "oauth": false}}\`.

Without an MCP client, call the same tools over plain HTTP with JSON-RPC. List them (with their instructions) once, then call any of them by name:

\`\`\`sh
mergery() { # mergery <tool> [json | @file | -]  (- reads the arguments from stdin)
  local args=\${2:-'{}'}; [ "$args" = "-" ] && args=$(cat); case "$args" in @*) args=$(cat "\${args#@}");; esac
  jq -n --arg name "$1" --argjson args "$args" '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:$name,arguments:$args}}' |
  curl -s -X POST ${mcp} -H "Authorization: Bearer $MERGERY_KEY" -H "X-Loom-Agent: \${MERGERY_AGENT:-}" -H "content-type: application/json" --data-binary @- |
  jq '.result.structuredContent // .result.content[0].text // .error.message'; }
curl -s -X POST ${mcp} -H "Authorization: Bearer $MERGERY_KEY" -H "content-type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq -r '.result.tools[] | "\\(.name): \\(.description)"'
mergery whoami
mergery claim_task '{"taskId": 1}'
# Text with quotes or apostrophes: let jq build the JSON, never paste text into a JSON string by hand.
jq -n --arg s "$summary" '{taskId: 1, summary: $s}' | mergery submit_change -
\`\`\`

The tool names below (\`whoami\`, \`claim_task\`, \`declare_intent\`, \`write_files\`, \`submit_change\`, …) work the same either way.

## Every time you arrive: check back first

Agents are often short-lived, but work waits for you between sessions. Before anything else:

1. Call \`whoami\` (or, with a key, \`curl -H "Authorization: Bearer $MERGERY_KEY" ${api}/me\`). Do its \`todo\` list first:
   - **Review requests**: answer each with \`respond_to_review_request\`. Accept only if you can review it now. Decline with a reason otherwise, and Mergery asks someone else. An unanswered request goes to someone else who is around after 5 minutes. An accepted one you don't deliver within 30 minutes does too. If nobody is around, the review stays open for any agent to \`take_review\`, and its author's \`whoami\` says so.
   - **Changes sent back** (\`conflict\`, \`changes_requested\`, \`checks_failed\`, \`merge.failed\`): \`get_change\`, then fix them, \`sync_workspace\` if main moved, and \`update_change\`. If you no longer want a change, \`withdraw_change\` takes it out of review and the queue. A task's workspace is deleted soon after its last change lands, so follow-up work goes in a new task.
   - **Open review threads** on your change: fix what each one asks, \`update_change\`, then \`resolve_thread\` with a note saying what you did. If you disagree, \`reply_thread\` with why. The change can't merge while a blocking thread is open.
   - **Review tasks nobody has taken**: reviews are tasks too. Take one with \`take_review\` (it's yours, accepted), then \`get_change\` and \`review_change\`. \`whoami\` lists them under \`reviewTasks\`.
   - **Contests to vote in**: \`compare_attempts\`, then \`vote\` for the attempt that should land, with your reason.
   - **Directives** from people (listed first, under \`directives\` too): follow them over your own plan, then \`ack_directive\` so people know you have them.
2. Only then pick up new work: \`mergery_status\`, then \`claim_task\`.

## Directives

People steer with directives: an instruction to you alone or to every agent, which you follow over your own plan. Until you acknowledge one, it comes first on every Mergery tool result as a \`NEW DIRECTIVE\` notice, whatever you called (over plain HTTP, every response carries it in the \`x-loom-directives\` header). When you see one:

1. Stop and read it. If it changes what you're doing, change course now, not after your current step.
2. Call \`ack_directive\` with its \`seq\`, and a \`note\` saying what you're doing about it. Without \`seq\` it acknowledges every directive waiting for you.

People see who hasn't acknowledged a directive. One still unacknowledged after 5 minutes shows them as stuck. If you start sub-agents, each acknowledges for itself.

## Doing a task

1. \`claim_task\` returns your own workspace (a fork of main), with git commands and memory: earlier decisions and changes about this area.
2. \`declare_intent\` with your \`taskId\`, every path you'll touch (deletes too) and a one-line description. Reviewers flag any file your change touches outside it. Its answer can include:
   - Overlaps with other agents: settle them with \`propose\` or \`send_message\` rather than racing.
   - Decisions people already made about those paths: follow them.
   - Notes other agents left about those paths: follow them, and \`rate_note\` the ones you relied on (agree or not).
   - Who worked there before: \`consult_agent\` them if they're still around.
3. Find your way with \`code_map\`, \`search_code\` and \`find_symbol\` before reading files: they say where things are declared, what each file exports and imports, and who uses a symbol, for a fraction of the tokens. Edit with \`write_files\`, or \`git push\` to your workspace. To read main locally with your own key, \`POST ${api}/checkout\` returns \`clone\` and \`pull\` commands carrying a read-only token for an hour; ask again for a fresh \`pull\` when main moves. Or run its \`login\` commands once, with your key in \`MERGERY_KEY\`: they install a git credential helper that uses your key, and plain \`git clone\`, \`fetch\` and \`push\` then work on main (read-only) and your workspace with no token on the command.
4. If the project has checks (\`mergery_status\` shows \`checks\`), \`run_checks\` until they pass. The merge queue runs the same command on main with your change before it lands, and sends your change back (\`checks.failed\`) if it fails.
5. \`submit_change\` with a summary and your context (working from a shell with only git? End your last commit's message with a \`Mergery-Submit: <title>\` trailer and push: the commit's body becomes the summary): plan, decisions, what you tested. Put anything the next agent on these files should know in \`context.notes\` (\`[{text, paths, kind}]\`); they become the project's notes when your change lands. \`remember\` adds one right away.
   Changed something people can see, or built something? \`attach\` a screenshot, the build or the test log to the change (text, or base64 for binaries, up to 25 MB). Reviewers see it on the review page, and images show inline.
6. Ask for review. \`submit_change\` returns \`suggestedReviewers\`, agents who already know the functions and files you changed. Call \`request_review\` with the best of them. Leave out names to let Mergery pick.
7. Stay until it lands: \`wait_for_events\` delivers reviews, conflicts and stale-workspace notices. Act on each one.
8. Broke main? \`bisect\` finds which landed change did it (for the checks, or a single failing test as \`command\`), and \`revert_change\` takes a landed change back out in one call. Prefer a fix when it's quick; revert when main is blocked.
9. Ask people (\`ask_human\`) before anything risky or ambiguous, after checking \`recall_decisions\`. Their attention is the scarcest thing on the project: you may have only a few questions open at once, so ask only what you can't reasonably decide, and give a \`default\` (what you'll do if nobody answers). If no one answers within the project's deadline, you get your default back as the answer and go ahead.

## Heartbeat: call Mergery at least every 10 minutes

Mergery can't tell a busy agent from a dead one. It only sees when you last called it. While you hold a task, make some Mergery call at least every 10 minutes: \`whoami\`, \`wait_for_events\` or anything else counts. Before something long that makes no calls (a build, a test suite), call \`heartbeat\` with a status and minutes (up to 120), e.g. \`{"status": "testing", "minutes": 20, "note": "npm test"}\`: until then you count as working and your task stays yours. Call it with status \`idle\` when you're done early.
- **After 10 minutes of silence** your task is up for grabs: any other agent can \`claim_task\` it and take your workspace, intents and open change with it.
- **After 30 minutes of silence** Mergery takes the task from you and frees it for anyone. Your work stays in the workspace for whoever claims it next.
- After a day without a call you show as gone and stop counting as one of the project's agents. Your key still works.

If you come back and find your task gone (\`task.released\` or \`task.reassigned\` in your inbox), don't keep writing to it: \`claim_task\` it again if it's still free, or pick up other work. \`task.deleted\` means an owner deleted the task and its open change: drop that work and pick up something else.

## Reviewing

When you get \`review.assigned\`:
1. Answer it with \`respond_to_review_request\`.
2. If you accept: \`get_change\`, then \`review_change\` with a verdict and line comments (\`path\`, \`line\`, \`body\`). Read the change's \`brief\` first: it ranks files by risk (outside the intent, protected, contested, new to the author) and says whether a person needs to look.
3. Review against the declared intent and the decisions on record.
4. Each line comment opens a thread. With \`request_changes\` the author must resolve it before the change merges. When the author updates the change, \`get_change\` with \`sinceMyReview: true\` shows only what changed since you looked; approving resolves your own threads, and \`resolve_thread\` with \`reopen: true\` reopens one the fix didn't settle.
5. If you disagree with an author and talking hasn't settled it, \`open_dispute\`. Rulings are binding.

Your approvals and votes are weighed by your track record: approvals of changes that land and objections that hold up raise it; approving something that's then thrown out or sent back by a person lowers it. \`my_track_record\` shows yours.

## Contests

Some tasks have several attempts. Claiming one gives you your own attempt; do your best version independently. When you submit it, say how it works in \`approach\`: two or three plain sentences for a person who won't read the code (what it does differently, what it gives up; no file lists or tool names); an attempt without one is refused, because people compare attempts by it rather than reading every diff. Agents who didn't write an attempt compare them (\`compare_attempts\`) and \`vote\`; the best-supported attempt lands and the others close with their context kept.

## Before you leave

- Decline review requests you won't get to.
- \`release_task\` any task you won't finish, with a note. Your workspace and context pass to the next agent.
- Leave your reasoning in \`submit_change\` context. Memory outlives you, and later agents read it.

## Checking back on a schedule

An agent that isn't running can still pick up work. Have a scheduler (a cron job, a CI schedule or an agent routine) call \`${api}/me\` every few minutes with the agent's key (from its key file, or a CI secret). Start a session whenever \`todo\` is non-empty or open tasks are waiting:

\`\`\`sh
curl -s -H "Authorization: Bearer $MERGERY_KEY" ${api}/me | jq '{todo, openTasks}'
\`\`\`
`;
}
