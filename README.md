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
| Tribal knowledge | **Memory**: every human answer, directive, objection and ruling is a *decision* tied to the files it covers; earlier changes keep their reasons | An agent starting on a file learns what was decided and tried there, and who to ask, before it writes code. |

## Agents collaborate, humans steer

Keeping agents out of each other's way is only half the job. Loom also gives them ways to work *together*, and gives people a seat at the table:

**Between agents**
- **Proposals**: when a collision is forecast, an agent proposes a *split* ("I keep `src/db.js`, you keep `src/routes/`") or an *order* ("you land first, I'll rebase after"). When the other agent accepts, Loom enforces it: intents are rewritten, or the merge queue holds the second change until the first lands.
- **Threads** anchored to a task, a change, or a file and line, so reviews are conversations rather than one-shot verdicts.
- **Contracts**: an agent publishes an interface ("`db.overdue(now)` returns …") others can build against before its code lands.
- **Subtasks**: an agent can split its task and hand pieces to other agents.
- **Consults**: when memory shows that an agent who worked on these files is still around, the newcomer can ask them in one call (`consult_agent`). Loom suggests a consult at most once per pair of agents per file, so memory doesn't turn into chatter. If the earlier agent is gone, its saved plan and decisions answer instead.
- **Review routing**: Loom remembers which agent wrote or reviewed each file, and each function, class and export inside it (parsed from the diff for JS/TS, Python, Go and Rust). After submitting, an agent gets `suggestedReviewers`, ranked by how much of the change they already know: the same functions first, then the same files, then the same folder. Recent work counts more, as do agents who are around now, and agents who already have open reviews count less. The agent asks them with `request_review`, or omits names to let Loom pick. Reviewer agents are a class of their own. They still see every review request, and they fill in when no builder knows the code. A request nobody answers shows up as *Stuck*.
- **Disputes**: when two agents disagree and talking hasn't settled it (a review one thinks is wrong, a rejected proposal), either opens a dispute and each states a position. jev rules if the humans' guidance and earlier decisions settle it, a person if not. The ruling is binding and becomes a decision. On a change, a ruling for the author dismisses the other side's request for changes.

**Memory**
- **Decisions**: human answers to agents' questions, broadcast directives, human requests for changes, dispute rulings and notes humans record directly all land in one log, tagged with the files they cover. Humans can retire a decision that no longer holds.
- **Recall on intent**: `declare_intent` returns the decisions that apply to those paths, earlier finished changes there (summary, the author's recorded decisions, objections from reviews), and which of those authors is still around.
- **Delegation with memory**: claiming or being handed a task returns related earlier tasks, either named by a human (`related`) or similar in wording, with what they did and the decisions along the way.
- **Precedent**: asking the humans returns earlier decisions that may already answer the question. jev answers a repeated question by citing the earlier decision, so people decide once.

**Humans in the loop**
- **Ask a human**: an agent asks a question, optionally blocking its task. The question shows up in the dashboard's *Needs a human* inbox, and the answer unblocks the agent.
- **Steering**: humans send directives to one agent or all of them, pause and resume agents (a paused agent can still talk but can't change code), reassign tasks with their workspace and context, and freeze main.
- **Protected paths**: changes touching e.g. `package.json` or `migrations/**` can't merge without a human's approval, however many agents approved.
- **Same tools as agents**: humans review, comment and approve in the dashboard, or claim a task and work in its workspace with plain git.
- **Line comments**: in a change, click any line of the patch to comment on it. Comments go out with the review and show under their lines for the author and other reviewers.
- **My work**: a person takes a task (or adds one and takes it), gets a clone and push command for its workspace, declares the files they'll touch, and submits for review. People go through the same intents, reviews, conflict routing and merge queue as agents.
- **Read the code your way**: the dashboard's **Code** view browses main, and any change's files, in the browser. **Download zip** gets a snapshot. **Check out locally** gives a read-only `git clone` command, with a token valid for an hour, plus a `git diff` against main, so a person can review an agent's change in their own editor. Agents can ask a person for review by name (`request_review`). The request lands under *Needs a person*.

**jev: a stand-in for the humans**

People can't answer every question a swarm asks. jev is a delegate they brief to decide some things for them, backed by [TypeSafe](https://docs.typesafe.ai)'s Jev model. Jev doesn't write text; it returns typed judgments with probabilities. So jev never makes up an answer. It acts in only two ways:
- **Questions**: when an agent asks the humans and lists its options, jev uses a Jev *Choice* to pick the option the humans' written guidance points to. Two Jev *Noul* checks run alongside it: does the guidance actually settle this, and is it high-stakes?
- **Protected changes**: jev approves a change to paths it has been trusted with only after Jev's Noul checks pass. The diff must follow the guidance, do only what its summary says, and add no risk (dependencies, scripts, secrets, deleted data).
- **Disputes**: jev uses a Jev Choice between the two positions, judged against the guidance and earlier decisions, with the same "settled?" and "high-stakes?" checks.
- **Precedent**: a question asked before is answered with the earlier decision. A Jev Choice also matches new wording to earlier decisions.

The humans set what jev may handle in the dashboard (**Delegate…**): whether it answers questions, which topics, house rules (`pattern => answer`) that apply first, which protected paths it may approve, and how confident Jev must be for each. Below the threshold, outside its scope, or without Jev connected, jev passes the item to a person and says why in the *Needs a human* inbox.

![a human steering the swarm](docs/human-in-the-loop.png)

Agents can use plain `git clone` / `git push` against their workspace remote, or do everything through the HTTP API or the built-in **MCP server** (`POST /mcp/<project>`), so any MCP-capable agent can join with one URL and a key.

![dashboard](docs/dashboard.png)

## Hundreds of agents

At swarm scale the dashboard stops showing agents and shows the work. Agents are just users: you find one by searching, and you don't watch them while they work.

- **Home** shows what needs a person, what is stuck (unanswered proposals, unresolved conflicts, an agent gone quiet holding a task, a review nobody answered), health tiles, merge flow, the merge queue and where the work is. Agent-to-agent chatter (collision forecasts, consults) leaves the *Notable* feed once there are more than 20 agents.
- **Contribution grids** in the GitHub style, for the project and for each agent: commits, changes and reviews. A project older than a week gets a year of days. A younger one gets small squares, so the grid shows something on day one.
- **Search** finds agents, tasks, changes and files. An agent's **profile** has its grid, the code it knows, its open review requests and how quickly it answers them, plus controls to pause it, direct it, or reassign its work.

![150 agents](docs/scale-home.png)
![review routing](docs/review-routing.png)

Under the hood:
- Agents long-poll a scoped event stream (`mine=1`), so each wakes only for its own events and for steering.
- The merge queue lands up to 8 changes per push.
- The dashboard reads one `/overview` summary over its WebSocket, at most once a second.

`demo/load.mjs` drives N simulated agents through the real API. Results on one laptop with `wrangler dev`, where one local `workerd` thread does all the git work:

| agents | merged | wall time | merges/hour | submit to merged (p50) |
|---|---|---|---|---|
| 150 | 150/150 | 48s | 11,200 | 17s |
| 200 (before the scale work) | 200/200 | 229s | 3,100 | 122s |
| 200 (after) | 200/200 | 71s | 10,200 | 25s |
| 300 | 300/300 | 155s | 7,000 | 61s |
| 500 | 491/500 | ~13 min | ~2,300 | n/a |

At 500 agents the local dev proxy started dropping connections ("Network connection lost"). Nine approvals never arrived, and those changes sat in review. Loom reported them as *Stuck*. On Cloudflare, each Worker request runs in its own isolate, and only the coordinator's bookkeeping is single-threaded.

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

Open http://127.0.0.1:8787 and watch. In about a minute six builders, a reviewer and a scripted human lead (jo) build a todo service together. Along the way you'll see:
- collision forecasts, and one agent proposing "you land first" to another;
- a published contract;
- jev answering agents' blocking questions within the brief jo gave it, and passing on what it can't settle;
- a conflict routed to the right agent and resolved;
- eli disputing rex's objection to a version bump, and the ruling (by jev, or jo when Jev isn't connected) enforced;
- dax asking a question jo already answered, and jev answering with the earlier decision;
- fen starting on files ada changed, getting ada's decisions and reasons from memory, and consulting ada, who is still around;
- the docs change approved by jev (or by jo when Jev isn't connected).

All six changes land on main. Without a TypeSafe key, jev uses only its house rules and passes the rest to jo. To use Jev, run the Worker with `npx wrangler dev --env local --var TYPESAFE_API_KEY:<key>`. To steer it yourself, create a human key (`POST /api/projects/<p>/agents {"name":"you","role":"human"}` with the admin token) and click **Sign in** on the dashboard. Set `PACE=2` to slow it down for a demo, or `PACE=0` to run it as a test.

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

Tools: `loom_status`, `whoami`, `create_task`, `claim_task`, `declare_intent`, `release_intent`, `list_files`, `read_file`, `write_files`, `submit_change`, `get_change`, `review_change`, `update_change`, `sync_workspace`, `send_message`, `ask_human`, `start_discussion`, `reply_thread`, `list_threads`, `propose`, `answer_proposal`, `publish_contract`, `wait_for_events`, `task_context`, `recall_decisions`, `consult_agent`, `open_dispute`, `state_position`.

**git**: `claim_task` returns ready-to-run commands, for example:

```sh
git -c http.extraHeader="Authorization: Bearer <workspace token>" clone <workspace remote> work
```

## HTTP API

All routes are under `/api/projects/<project>`. Writes need `Authorization: Bearer <agent key>`.

| Method & path | What it does |
|---|---|
| `GET /state` | Everything: agents, tasks, live intents, changes, recent events |
| `GET /events?after=<seq>&wait=<s>&agent=<id>&mine=1` | Long-poll the event stream (`mine=1`: only what concerns that agent); `GET /ws` for a WebSocket |
| `GET /tasks?status=` | List tasks |
| `POST /tasks` `{title, description, dependsOn, related}` | Add a task (`related`: earlier tasks whose history its agent should get) |
| `POST /tasks/:id/claim` | Get a workspace fork + tokens (or take over a stalled task, with its context) |
| `POST /intents` `{taskId, paths, description}` | Declare what you'll touch; returns overlaps, pending changes, and memory (decisions, earlier changes, who to consult) |
| `POST /workspaces/:name/commit` `{files, message}` | Commit to your workspace without a git client |
| `POST /changes` `{taskId, title, summary, context}` | Submit your workspace for review and merge |
| `POST /changes/:id/reviews` `{verdict, body, comments}` | `approve`, `request_changes` or `comment` |
| `GET /changes/:id/reviewers` | Who knows this code, ranked with reasons, and who has been asked |
| `POST /changes/:id/reviewers` `{reviewers?, count?, note?}` | Ask agents to review (named, or the best-placed few) |
| `POST /checkout` `{workspace?, change?}` | Read-only clone command for main, a workspace or a change (token valid for an hour) |
| `GET /files?change=&workspace=&path=` | List files, or read one, on main, a workspace or a change |
| `GET /archive?change=&workspace=` | Download main, a workspace or a change as a zip |
| `GET /overview` | Health, what needs a person, stuck work, queue, areas: the dashboard's one read |
| `GET /search?q=&state=` | Find agents, tasks, changes and files |
| `GET /agents/:id` | An agent's profile: work, code it knows, review queue, activity |
| `GET /activity?agent=&range=year\|recent` | Commits, changes and reviews per day (or per few minutes) for the grids |
| `POST /questions/answer` `{threads, body}` | *Human:* answer every copy of the same question at once |
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
| `POST /tasks/:id/assign` `{agent, note, related?}` | *Human:* hand a task (and its workspace) to someone else, optionally naming earlier tasks it should remember |
| `POST /freeze`, `POST /unfreeze` | *Human:* hold or release the merge queue |
| `POST /protect` `{paths}` | *Human:* paths that need a human approval to merge |
| `GET /delegate`, `POST /delegate` `{enabled, guidance, questions, approvals, disputes, rules}` | *Human:* read or set jev's brief |
| `GET /decisions?paths=&q=` | Decisions on record, optionally those relevant to paths or a question |
| `POST /decisions` `{decision, question?, paths}`, `POST /decisions/:id/retire` | *Human:* record a decision, or retire one |
| `GET /tasks/:id/memory` | Related earlier tasks and the decisions that apply |
| `POST /consults` `{agent, question, path?, changeId?}` | Ask an agent who worked on something before |
| `POST /disputes` `{with, question, position, changeId?, taskId?}` | Open a dispute with another agent |
| `POST /disputes/:id/position` `{position}` | State your side |
| `POST /disputes/:id/rule` `{for, note?}` | *Human:* rule (jev rules too, within its brief) |

## Limits and next steps

- Merges hold both trees in Worker memory, so this suits repos up to tens of MB. Bigger repos would move merging to Sandbox containers.
- The intent overlap check is path-based. Review routing already knows functions and classes, so symbol-level intents are the obvious next step.
- Commits and merges run git in the coordinator Durable Object. With hundreds of agents, the next step is to move that CPU work into stateless Workers.
- Artifacts event subscriptions (`pushed`) could replace the explicit `submit` and `update` calls.

## License

MIT
