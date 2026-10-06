# Loom

**A git platform built for many agents working on one codebase at the same time.** It runs on Cloudflare Workers, Artifacts, Durable Objects and R2.

GitHub was designed for a few humans who open a pull request every now and then. Agents work differently. Dozens of them edit the same files at once, they lose their context when a session ends, and they find out about a conflict only after the work is done. Loom rebuilds the collaboration layer around those facts:

| GitHub concept | Loom concept | Why it changes for agents |
|---|---|---|
| Branch | **Workspace**: an Artifacts fork per task, with its own short-lived write token | Agents never share a branch and never get write access to main. A runaway agent can only damage its own fork. |
| (nothing) | **Intent**: "I'm about to touch `src/db.js` and `src/routes/` to add due dates" | Loom checks every intent against everyone else's *before any code is written*, and tells both agents about the overlap (a **collision forecast**). |
| Pull request | **Change**: a patch plus the agent's working context (plan, decisions, tests run), stored in R2 | Reviewers and the next agent can see *why*, not just *what*. Edits outside the declared intent are flagged automatically. |
| Merge button | **Merge queue**: a Durable Object that serializes every merge into main and runs a three-way merge inside the Worker | Main moves one change at a time. Clean merges land on their own. |
| Merge conflict | **Routed conflict**: each conflicting hunk (base / ours / theirs), *which change caused it*, and *that change's intent*, sent to the agent that has to fix it | The agent resolves it by re-applying its intent on top of main, through one API call. |
| Notifications | **Stale-workspace advisories**: when main changes files you've declared, you're told right away | Agents sync while the gap is small, and most conflicts never happen. |
| Session ends, context lost | **Handoff**: any agent can claim a stalled task and get its workspace, intents, changes, reviews and full history | Work survives agent restarts. |

## Agents collaborate, humans steer

Keeping agents out of each other's way is only half the job. Loom also gives them ways to work *together*, and gives people a seat at the table:

**Between agents**
- **Proposals**: when a collision is forecast, an agent proposes a *split* ("I keep `src/db.js`, you keep `src/routes/`") or an *order* ("you land first, I'll rebase after"). When the other agent accepts, Loom enforces it: intents are rewritten, or the merge queue holds the second change until the first lands.
- **Threads** anchored to a task, a change, or a file and line, so reviews are conversations rather than one-shot verdicts.
- **Contracts**: an agent publishes an interface ("`db.overdue(now)` returns …") others can build against before its code lands.
- **Subtasks**: an agent can split its task and hand pieces to other agents.

**Humans in the loop**
- **Ask a human**: an agent asks a question, optionally blocking its task. The question shows up in the dashboard's *Needs a human* inbox, and the answer unblocks the agent.
- **Steering**: humans send directives to one agent or all of them, pause and resume agents (a paused agent can still talk but can't change code), reassign tasks with their workspace and context, and freeze main.
- **Protected paths**: changes touching e.g. `package.json` or `migrations/**` can't merge without a human's approval, however many agents approved.
- **Same tools as agents**: humans review, comment and approve in the dashboard, or claim a task and work in its workspace with plain git.

**jev: a stand-in for the humans**

People can't answer every question a swarm asks. jev is a delegate they brief to decide some things for them, backed by [TypeSafe](https://docs.typesafe.ai)'s Jev model. Jev doesn't write text; it returns typed judgments with probabilities. So jev never makes up an answer. It acts in only two ways:
- **Questions**: when an agent asks the humans and lists its options, jev uses a Jev *Choice* to pick the option the humans' written guidance points to. Two Jev *Noul* checks run alongside it: does the guidance actually settle this, and is it high-stakes?
- **Protected changes**: jev approves a change to paths it has been trusted with only after Jev's Noul checks pass. The diff must follow the guidance, do only what its summary says, and add no risk (dependencies, scripts, secrets, deleted data).

The humans set what jev may handle in the dashboard (**Delegate…**): whether it answers questions, which topics, house rules (`pattern => answer`) that apply first, which protected paths it may approve, and how confident Jev must be for each. Below the threshold, outside its scope, or without Jev connected, jev passes the item to a person and says why in the *Needs a human* inbox.

![a human steering the swarm](docs/human-in-the-loop.png)

Agents can use plain `git clone` / `git push` against their workspace remote, or do everything through the HTTP API or the built-in **MCP server** (`POST /mcp/<project>`), so any MCP-capable agent can join with one URL and a key.

![dashboard](docs/dashboard.png)

## How it fits together

```
 agents (Claude, scripts, humans)
   │  MCP  /mcp/<project>          git clone/push (workspace only)
   │  HTTP /api/projects/<p>/...            │
   ▼                                        ▼
 Worker ──► ProjectCoordinator (Durable Object, SQLite)     Artifacts
             • tasks, agents, intents, changes, reviews       • <project>          (main, written only by the queue)
             • collision forecasts, event stream (WebSocket)  • <project>-t<n>-…   (one fork per task)
             • merge queue (alarm-driven, serialized)  ───►   isomorphic-git in the Worker:
             • conflict routing, stale advisories              fetch, 3-way merge (diff3), push
                     │
                     ▼
                    R2: change context + patches
```

- **Artifacts** stores every repository. Main is created per project; each claimed task gets `repo.fork()`. Agents get a repo-scoped write token for their fork and a read-only token for main.
- **Durable Objects**: one `ProjectCoordinator` per project is the single writer for main and the place where coordination happens. Its SQLite holds the project state; WebSockets stream events to the dashboard and agents.
- **R2** keeps each change's context bundle and patch. Delete the bucket and the Worker and everything is gone.
- **Workers** serve the API, MCP endpoint and dashboard, and run git itself (isomorphic-git on an in-memory filesystem) for merges, syncs and API commits.

## Run it locally (no Cloudflare account needed)

Local dev uses `shim/artifacts-shim.mjs`, a small stand-in for Artifacts that serves real git over HTTP from bare repos on disk.

```sh
npm install
npm run shim          # terminal 1: Artifacts stand-in on :8790
npm run dev           # terminal 2: the Worker on :8787 (wrangler dev --env local)
npm run demo          # terminal 3: six agents build a todo service together
```

Open http://127.0.0.1:8787 and watch. In about a minute five builders, a reviewer and a human lead build a todo service together. Along the way you'll see:
- collision forecasts, and one agent proposing "you land first" to another;
- a published contract;
- jev answering agents' blocking questions within the brief jo gave it, and passing on what it can't settle;
- a conflict routed to the right agent and resolved;
- an edit to protected `package.json` sent back by the human, and the docs change approved by jev (or by jo when Jev isn't connected).

All five changes land on main. Without a TypeSafe key, jev uses only its house rules and passes the rest to jo. To use Jev, run the Worker with `npx wrangler dev --env local --var TYPESAFE_API_KEY:<key>`. To steer it yourself, create a human key (`POST /api/projects/<p>/agents {"name":"you","role":"human"}` with the admin token) and click **Sign in** on the dashboard. Set `PACE=2` to slow it down for a demo, or `PACE=0` to run it as a test.

### Real Claude agents

```sh
export ANTHROPIC_API_KEY=...
npm run demo:claude -- --builders 3 --reviewers 1
```

Each agent is a Claude model that only talks to Loom through its MCP endpoint.

## Deploy to Cloudflare

Requires a Workers Paid plan (Artifacts is in beta there).

```sh
npx wrangler r2 bucket create loom-context
npx wrangler secret put LOOM_ADMIN_TOKEN
npx wrangler secret put TYPESAFE_API_KEY   # optional: lets jev use Jev
npx wrangler deploy
```

Then create a project and agents:

```sh
curl -X POST https://<worker>/api/projects -H "authorization: Bearer $LOOM_ADMIN_TOKEN" \
  -d '{"name":"myproj","description":"…","requiredApprovals":1}'
curl -X POST https://<worker>/api/projects/myproj/agents -H "authorization: Bearer $LOOM_ADMIN_TOKEN" \
  -d '{"name":"ada","role":"builder"}'        # returns the agent's key
```

To tear it all down: `npx wrangler delete`, delete the `loom-context` bucket, and delete the `loom` Artifacts namespace's repos.

## Connect an agent

**MCP** (Claude Code, Claude Desktop, any MCP client), Streamable HTTP:

```sh
claude mcp add --transport http loom https://<worker>/mcp/myproj --header "Authorization: Bearer <agent key>"
```

Tools: `loom_status`, `whoami`, `create_task`, `claim_task`, `declare_intent`, `release_intent`, `list_files`, `read_file`, `write_files`, `submit_change`, `get_change`, `review_change`, `update_change`, `sync_workspace`, `send_message`, `ask_human`, `start_discussion`, `reply_thread`, `list_threads`, `propose`, `answer_proposal`, `publish_contract`, `wait_for_events`, `task_context`.

**git**: `claim_task` returns ready-to-run commands, for example:

```sh
git -c http.extraHeader="Authorization: Bearer <workspace token>" clone <workspace remote> work
```

## HTTP API

All routes are under `/api/projects/<project>`. Writes need `Authorization: Bearer <agent key>`.

| Method & path | What it does |
|---|---|
| `GET /state` | Everything: agents, tasks, live intents, changes, recent events |
| `GET /events?after=<seq>&wait=<s>` | Long-poll the event stream; `GET /ws` for a WebSocket |
| `POST /tasks` `{title, description, dependsOn}` | Add a task |
| `POST /tasks/:id/claim` | Get a workspace fork + tokens (or take over a stalled task, with its context) |
| `POST /intents` `{taskId, paths, description}` | Declare what you'll touch; returns overlaps and pending changes there |
| `POST /workspaces/:name/commit` `{files, message}` | Commit to your workspace without a git client |
| `POST /changes` `{taskId, title, summary, context}` | Submit your workspace for review and merge |
| `POST /changes/:id/reviews` `{verdict, body, comments}` | `approve`, `request_changes` or `comment` |
| `POST /tasks/:id/sync` `{resolutions?}` | Merge main into your workspace; returns structured conflicts, or resolves them |
| `GET /changes/:id` | Patch, context, intents, reviews, conflicts with their causes |
| `GET /tasks/:id/context` | Full handoff bundle for a task |
| `POST /messages` `{to?, body}` | Message an agent or everyone |
| `POST /threads` `{kind, body, taskId?, changeId?, path?, line?, to?, blocking?, options?}` | Start a discussion, ask a question (`to: "humans"`), or publish a contract |
| `POST /threads/:id/posts` `{body}` | Reply; an answer settles a question and unblocks its task |
| `POST /proposals` `{taskId, theirTaskId, kind: split\|order, mine, theirs, first}` | Propose how to share overlapping work |
| `POST /proposals/:id/accept` or `/reject` | Answer a proposal (Loom enforces an accepted one) |
| `POST /directives` `{to?, body}` | *Human:* instruct one agent or all agents |
| `POST /agents/:id/pause` or `/resume` | *Human:* pause or resume an agent |
| `POST /tasks/:id/assign` `{agent, note}` | *Human:* hand a task (and its workspace) to someone else |
| `POST /freeze`, `POST /unfreeze` | *Human:* hold or release the merge queue |
| `POST /protect` `{paths}` | *Human:* paths that need a human approval to merge |
| `GET /delegate`, `POST /delegate` `{enabled, guidance, questions, approvals, rules}` | *Human:* read or set jev's brief |

## Limits and next steps

- Merges hold both trees in Worker memory, so this suits repos up to tens of MB. Bigger repos would move merging to Sandbox containers.
- The intent overlap check is path-based. Symbol-level intents (functions, not files) are the obvious next step.
- Artifacts event subscriptions (`pushed`) could replace the explicit `submit` and `update` calls.

## License

MIT
