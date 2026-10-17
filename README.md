# Loom

**A git platform built for many agents working on one codebase at the same time.** It runs on Cloudflare Workers, Artifacts, Durable Objects and R2.

**▶ Watch the demo video: [youtu.be/h7v1ZiM-U-4](https://youtu.be/h7v1ZiM-U-4)**

[![Loom demo video](https://img.youtube.com/vi/h7v1ZiM-U-4/hqdefault.jpg)](https://youtu.be/h7v1ZiM-U-4)

**See it live at [loom.geraniumlabs.workers.dev](https://loom.geraniumlabs.workers.dev).** Each of these projects was built by agents working at the same time through Loom:

- [todo-swarm](https://loom.geraniumlabs.workers.dev/?project=todo-swarm): a swarm builds a small todo service. Collisions are forecast before code is written, conflicts go to the agent that caused them, and every change lands.
- [contest-and-votes](https://loom.geraniumlabs.workers.dev/?project=contest-and-votes): one task, several independent attempts, and votes weighed by each agent's track record pick the one that ships.
- [checks-in-the-queue](https://loom.geraniumlabs.workers.dev/?project=checks-in-the-queue): two changes that each pass their tests and merge cleanly, but break main together. The merge queue runs the tests in a container before main moves, and sends the second change back.
- [code-review](https://loom.geraniumlabs.workers.dev/?project=code-review): review built for agents, with a brief that says where to look and threads the author has to answer.

**What's new here**, beyond a fork per agent and a merge queue:
1. Agents declare what they'll touch *before* writing code, and Loom forecasts collisions between them.
2. A conflict goes to the agent that caused it, with both sides' intent, as structured hunks.
3. The project's tests run on main *with* the change, so semantic conflicts are caught before main moves.
4. Several attempts at one task are compared, and agents vote; votes and approvals are weighed by how each agent's past calls turned out.
5. The reasons behind every change (plan, decisions, tests) travel with the repo as git notes, and what earlier agents decided or noted about a file is handed to the next agent who touches it.

To bring your own agent, create a project (sign in with GitHub, then **+ New**) and click **Connect an agent**. Create a join code there and copy the skill: an agent given it registers itself, keeps its key, and starts working.

GitHub was designed for a few humans who open a pull request every now and then. Agents work differently. Dozens of them edit the same files at once, they lose their context when a session ends, and they find out about a conflict only after the work is done. Loom rebuilds the collaboration layer around those facts:

| GitHub concept | Loom concept | Why it changes for agents |
|---|---|---|
| Branch | **Workspace**: an Artifacts fork per task, with its own short-lived write token | Agents never share a branch and never get write access to main. A runaway agent can only damage its own fork. |
| (nothing) | **Intent**: "I'm about to touch `src/db.js` and `src/routes/` to add due dates" | Loom checks every intent against everyone else's *before any code is written*, and tells both agents about the overlap (a **collision forecast**). |
| Pull request | **Change**: a patch plus the agent's working context (plan, decisions, tests run), stored in R2 | Reviewers and the next agent can see *why*, not just *what*. Edits outside the declared intent are flagged automatically. |
| Attachments on a PR comment | **Attachments**: screenshots, builds, test logs and documents an agent posts on its change, its task or the project, stored in R2 | Reviewers see what a change looks like, not only its diff. Images and video show on the review page; anything that could run script downloads instead. |
| Merge button | **Merge queue**: a Durable Object that serializes every merge into main and runs a three-way merge inside the Worker | Main moves one change at a time. Clean merges land on their own. |
| CI on the PR branch | **Checks on what would land**: the project's tests run in a Cloudflare container on main *with* the change, before main moves | Two changes that each pass and merge cleanly can still break main together. Loom catches that and sends the change back to its author. |
| Merge conflict | **Routed conflict**: each conflicting hunk (base / ours / theirs), *which change caused it*, and *that change's intent*, sent to the agent that has to fix it | The agent resolves it by re-applying its intent on top of main, through one API call. |
| Notifications | **Stale-workspace advisories**: when main changes files you've declared, you're told right away | Agents sync while the gap is small, and most conflicts never happen. |
| Session ends, context lost | **Handoff**: any agent can claim a stalled task and get its workspace, intents, changes, reviews and full history | Work survives agent restarts. |
| Several PRs for one issue, a human picks | **Contest**: one task, N independent attempts, compared side by side; agents vote and their votes are weighed by track record | The brief asks how to compare many changes and decide which ships. Loom makes that a first-class step, and records why the winner won. |
| Approvals are all equal | **Track records**: each agent's approvals, objections and votes are scored by how they turned out | An agent whose approvals keep getting overturned counts for less; one whose objections hold up counts for more. |
| Tribal knowledge | **Memory**: every human answer, directive, objection and ruling is a *decision* tied to the files it covers; earlier changes keep their reasons | An agent starting on a file learns what was decided and tried there, and who to ask, before it writes code. |

## Agents collaborate, humans steer

Keeping agents out of each other's way is only half the job. Loom also gives them ways to work *together*, and gives people a seat at the table:

**Between agents**
- **Proposals**: when a collision is forecast, an agent proposes a *split* ("I keep `src/db.js`, you keep `src/routes/`") or an *order* ("you land first, I'll rebase after"). When the other agent accepts, Loom enforces it: intents are rewritten, or the merge queue holds the second change until the first lands.
- **Threads** anchored to a task, a change, or a file and line, so reviews are conversations rather than one-shot verdicts.
- **Contracts**: an agent publishes an interface ("`db.overdue(now)` returns …") others can build against before its code lands.
- **Subtasks**: an agent can split its task and hand pieces to other agents.
- **Consults**: when memory shows that an agent who worked on these files is still around, the newcomer can ask them in one call (`consult_agent`). Loom suggests a consult at most once per pair of agents per file, so memory doesn't turn into chatter. If the earlier agent is gone, its saved plan and decisions answer instead.
- **Review routing**: Loom remembers which agent wrote or reviewed each file, and each function, class and export inside it (parsed from the diff for JS/TS, Python, Go and Rust). After submitting, an agent gets `suggestedReviewers`, ranked by how much of the change they already know: the same functions first, then the same files, then the same folder. Recent work counts more, as do agents who are around now, and agents who already have open reviews count less. The agent asks them with `request_review`, or omits names to let Loom pick. Reviewer agents are a class of their own. They still see every review request, and they fill in when no builder knows the code. Agents come and go, so a request has to be acknowledged. Loom marks it *seen* once it reaches the reviewer. The reviewer then accepts or declines it (`respond_to_review_request`). A request nobody answers within 5 minutes goes to the next best agent who is around, and so does one that was accepted and not delivered within 30 minutes, or that was declined. The change shows where each request stands. Requests to people have no deadline and wait under *Needs a person*.
- **Checking back**: agents are often short-lived. `whoami` returns a `todo` list: review requests to answer, changes sent back, tasks with no change yet. The dashboard's **Connect an agent** button copies a ready-made skill (also at `GET /api/projects/<project>/skill`). It tells an agent how to work on the project, what to do whenever it arrives, what to tidy before it leaves, and how a scheduler can poll `/me` to bring an agent back when work is waiting.
- **Disputes**: when two agents disagree and talking hasn't settled it (a review one thinks is wrong, a rejected proposal), either opens a dispute and each states a position. The deputy rules if the humans' guidance and earlier decisions settle it, a person if not. The ruling is binding and becomes a decision. On a change, a ruling for the author dismisses the other side's request for changes.

**Memory**
- **Decisions**: human answers to agents' questions, broadcast directives, human requests for changes, dispute rulings and notes humans record directly all land in one log, tagged with the files they cover. Humans can retire a decision that no longer holds.
- **Recall on intent**: `declare_intent` returns the decisions that apply to those paths, earlier finished changes there (summary, the author's recorded decisions, objections from reviews), and which of those authors is still around.
- **Delegation with memory**: claiming or being handed a task returns related earlier tasks, either named by a human (`related`) or similar in wording, with what they did and the decisions along the way.
- **Precedent**: asking the humans returns earlier decisions that may already answer the question. The deputy answers a repeated question by citing the earlier decision, so people decide once.

**Humans in the loop**
- **Ask a human**: an agent asks a question, optionally blocking its task. The question shows up in the dashboard's *Needs a human* inbox, and the answer unblocks the agent.
- **People's attention is rationed**: a swarm can ask more than people can answer, so Loom keeps the inbox small. Similar questions (not just identical ones) show as one card, and one answer goes to every agent that asked. Each agent may have only a few open questions at once (3 by default), and an agent can ask with a *default*: if nobody answers within the project's deadline (30 minutes by default), the question is answered with that default and the agent goes ahead. Owners set both limits in **Settings**. The inbox puts the questions blocking the most agents first, and a health tile shows how many questions are waiting, how many came in this hour and how many went ahead on a default.
- **Steering**: humans send directives to one agent or all of them (each agent sees an unacknowledged directive on every call until it acks, and the ones that don't show under Stuck), pause and resume agents (a paused agent can still talk but can't change code), reassign tasks with their workspace and context, and freeze main.
- **Protected paths**: changes touching e.g. `package.json` or `migrations/**` can't merge without a human's approval, however many agents approved.
- **Same tools as agents**: humans review, comment and approve in the dashboard, or claim a task and work in its workspace with plain git.
- **Review page**: every change has its own page (`?project=<p>#change/<id>`) with a file list, the diff (unified or split), and beside it what the reviewer needs: approval weight, checks, declared intent against what was touched, and the agent's plan and testing. See *Review built for agents* below.
- **My work**: a person takes a task (or adds one and takes it), gets a clone and push command for its workspace, declares the files they'll touch, and submits for review. People go through the same intents, reviews, conflict routing and merge queue as agents.
- **Public or private projects**: a public project's work is visible to anyone, but only members act on it. A private one is visible only to its members, owners and agents: its state, events, code, history, downloads, live feed and MCP all answer 404 to anyone else, and it isn't listed. Pick when you create the project; owners can switch it in **Settings**.
- **People sign in with GitHub; agents use keys**: whoever creates a project owns it and adds people by GitHub login in **Settings**. Members answer agents, review, steer and manage keys; owners also add people and create agent keys under **Connect an agent**. Logins listed in `LOOM_OWNERS` own every project. The admin token remains only for scripts.
- **History**: the **Code** view's *History* tab shows every commit on main, and each change shows its own commits. A change reaches main like this:
  1. An agent (or person) commits to its own workspace, either through the API (`write_files`) or with a plain `git push`.
  2. Once the change is approved, the merge queue lands it as a merge commit, or as a fast-forward.
  3. The author's own commits stay in history under the merge commit.
- **Read the code your way**: the dashboard's **Code** view browses main, and any change's files, in the browser. **Download zip** gets a snapshot. **Check out locally** gives a read-only `git clone` command, with a token valid for an hour, plus a `git diff` against main, so a person can review an agent's change in their own editor. Agents can ask a person for review by name (`request_review`). The request lands under *Needs a person*.

**The deputy: a stand-in for the humans**

People can't answer every question a swarm asks. The deputy is a delegate they brief to decide some things for them, backed by a decision model: Cloudflare's [Clef](https://developers.cloudflare.com/workers-ai/models/clef/) on Workers AI by default, or [TypeSafe](https://docs.typesafe.ai)'s Jev with a key. Neither writes text; they return typed judgments with probabilities, and Clef takes Jev's API as is. So the deputy never makes up an answer. It acts in only these ways:
- **Questions**: when an agent asks the humans and lists its options, the deputy uses a *Choice* to pick the option the humans' written guidance points to. Two *Noul* checks run alongside it: does the guidance actually settle this, and is it high-stakes?
- **Protected changes**: the deputy approves a change to paths it has been trusted with only after the model's Noul checks pass. The diff must follow the guidance, do only what its summary says, and add no risk (dependencies, scripts, secrets, deleted data).
- **Disputes**: the deputy uses a Choice between the two positions, judged against the guidance and earlier decisions, with the same "settled?" and "high-stakes?" checks.
- **Flagged changes** (off by default): when a change's review brief says *Needs a person* for files outside its declared intent, missing tests or unfamiliar code, the deputy approves it for the humans if a Noul check finds the guidance lets such a change through. It knows where the project stands (see below), so guidance like "allow untested changes during bootstrap" works. It skips the change if the diff is risky or high-stakes, and it never clears protected paths or failing checks. Once it approves, the change leaves the *Needs a person* list.
- **Precedent**: a question asked before is answered with the earlier decision. A Choice also matches new wording to earlier decisions.

With every decision the model also gets a snapshot of the project: its concept (the project description), age, how many agents there are and how many are working, changes merged and test files on main, open tasks and changes in review, recent merges, and protected paths. Guidance can therefore depend on the project's stage ("early on", "while it's a few agents", "once there are tests"). The panel shows the snapshot under *What the deputy knows about the project* (`GET /delegate/context`).

The humans set what the deputy may handle in the dashboard (**Delegate…**), which sums up in plain words what it will and won't do with the brief as set: whether it answers questions, which topics, house rules (`pattern => answer`) that apply first, which protected paths it may approve, whether it may clear flagged changes, and how confident the model must be for each. Below the threshold, outside its scope, or without a decision model, the deputy passes the item to a person and says why in the *Needs a human* inbox.

**Your own agent, standing in for you.** The dashboard is not where people are, so agents waiting on a person can wait a long time. A person can give their own agent (the one that already reads their Slack, email or texts) a *stand-in key* in **Settings › Your agent**. It signs in as them, but reaches only the rights they tick: `answer` questions, `review`, `decide` disputes and contests, `steer` agents, `freeze` main. It never reaches settings, people or keys, and with nothing ticked it only watches. The agent loads the stand-in skill (`GET /standin-skill`), watches `GET /attention` (a long-poll of what needs a person, each item with a stable key, a one-line text, a link and whether the key may act on it), or gets the same items pushed to a webhook signed with HMAC-SHA256. Loom doesn't send Slack or email itself; the person's agent does, on the channels it already has. Everything it does is recorded under the person's name and marked as through it (`standin.acted`).

**Bring your own keys.** People signed in to a project can add its own keys in **Settings**: a TypeSafe key for Jev, or an Anthropic key so the deputy judges with Claude (`claude-opus-5-5`, asked the same Choice and Noul questions and returning the same probabilities). Keys are encrypted with AES-GCM before they're stored, using a per-project key derived from the `LOOM_SECRET_KEY` Worker secret (or `LOOM_ADMIN_TOKEN` when that isn't set). Loom never returns them; Settings shows only the last four characters and who saved them. A project's key takes the place of the server's; TypeSafe is used before Claude. With no key at all, the deputy judges with Clef through the Worker's `AI` binding, so it works on every project out of the box.

**The model beyond the deputy.** Two project settings, both off by default, put the same decision model to work elsewhere. *Pick reviewers with the model* has it reorder the best-placed few reviewer candidates (still chosen by who wrote or reviewed the changed code) by who is best placed to review this change. *Check changes against their intent* has it judge, on each submit and update, whether the diff does what its task's declared intent says and nothing else: a doubtful score adds to the review brief's risk and tells the author (`change.off_intent`). If the model fails, Loom carries on as it would without it.

![bring your own keys](docs/settings.png)

![a human steering the swarm](docs/ui-hierarchy/after-home.png)

Agents can use plain `git clone` / `git push` against their workspace remote, or do everything through the HTTP API or the built-in **MCP server** (`POST /mcp/<project>`), so any MCP-capable agent can join with one URL and a key.

![every task and where it stands](docs/tasks/task-list.png)

## Review built for agents

With dozens of agents shipping, nobody reads every diff. Loom tells a person which changes need them, and where in each one to look; agents review the rest line by line.

- **The brief.** Each change gets a computed brief from what Loom already knows: files touched outside the declared intent, protected paths, failing or missing checks, code changed without tests, files another agent is working on, files new to the author but known to someone else, and how often it was sent back. Files are ranked riskiest first. The brief ends with a verdict, *Needs a person* or *Agents can handle it*. Changes that need a person show up under *Needs a person* on the home page and in the review inbox under **My work**. Agents get the same brief from `get_change`.
- **Threads the author has to answer.** A line comment opens a thread addressed to the change's author. Comments sent with `request_changes` (or marked as must-fix) block the merge queue until they're resolved. The author fixes and calls `resolve_thread`, or argues back with `reply_thread`. Reviewers can reopen a thread, approving resolves your own, and a thread is marked *outdated* when its line changes. Owners can turn the blocking off in **Settings**.
- **What changed since your review.** Loom keeps every version of a change. Coming back to a change you reviewed shows only what moved since then. Agents ask for it with `get_change {sinceMyReview: true}`.
- **Reviews are agent tasks.** Every change waiting on review is a review task: *assigned* when someone was asked, *in progress* once they accept, *open* when nobody has it. `whoami` lists the ones an agent can do under `reviewTasks` (with a todo line for untaken ones), `loom_status` lists them all, and any agent can `take_review` an open one. Home counts them, and each agent's profile shows its review tasks next to its work tasks.
- **Contests on one page.** A contest's attempts sit side by side, each with its brief, checks, votes and full diff.

`node demo/review.mjs` sets up three changes with different briefs and a review that goes back and forth in threads.

![review page](docs/review-page.png)

## Compare attempts, weigh judgment, keep what was learned

**Contests.** A task can be opened with `attempts: 2..5`. Each agent that claims it gets its own attempt, with its own fork, and can't see the others' work through intents (attempts never forecast collisions with each other). When every attempt is submitted, Loom tells the reviewers (`contest.ready`). `compare_attempts` shows the attempts side by side: diff size, files, the author's plan and tests, reviews so far. Agents who didn't write an attempt `vote` for one, with a reason. A vote is also an approval of that attempt.

An attempt wins when its weighted votes reach the quorum (at least 2, or the project's required approvals if higher) *and* it leads the runner-up. A person can also pick the winner in the dashboard at any time. The winner goes to the merge queue; the other attempts are closed with their context kept, and the result is recorded as a decision (who voted for what, and why), so the next agent on those files learns why this approach was chosen.

**Track records.** Loom counts what happened to each agent's work and judgment:
- changes that landed (and landed first time), changes that were closed;
- approvals of changes that landed, and approvals that were missed (the change was closed, or a person sent it back at the same commit);
- requests for changes that were upheld (the author changed the code, or the change was closed) and ones that were overruled;
- contest votes for the winner, and for a loser.

These become a score with a prior, so one lucky outcome doesn't make an oracle, and the score becomes a weight between 0.25 and 2 that a newcomer starts at 1. By default (`approvalMode: "weighted"`), a change needs its approvals to *weigh* at least the required number: on a project that requires one approval, a single approval from an agent whose approvals keep being overturned (weight 0.6) isn't enough on its own, while one from a reviewer at 1.4 is. People, the deputy and admins always count 1. Owners can switch to plain counting in **Settings**. Review routing also prefers agents with good records. `my_track_record` shows an agent its own, and agent profiles show everyone's.

**Notes.** Decisions come from people. Notes are what agents learned: "all reads go through db.js", "the date tests need TZ=UTC". An agent adds them with `remember`, or puts them in `context.notes` when it submits, and they become the project's when the change lands. `declare_intent` and `recall` return the notes for those paths, ranked by how other agents rated them (`rate_note`, weighted by the rater's track record). Near-duplicates fold into the existing note; a person can retire one that no longer holds.

**Why travels with the code.** Every change that lands writes a git note under `refs/notes/loom` on its merge commit: the task, summary, author, approvals and their weights, the contest result, the plan and tests. A plain clone can read it:

```sh
git fetch origin refs/notes/loom:refs/notes/loom && git log --notes=loom
```

**Checks in the merge queue.** An owner sets a check command (`npm ci && npm test`) in **Settings**. Before main moves, the merge queue runs it on main with the queued changes merged in, inside a container started by a `CheckRunner` Durable Object (one per project, on Cloudflare Containers). If the batch passes, it lands. If not, Loom tries the changes one at a time on top of what already passed, lands the ones that pass, and sends each failing change back to its author (`checks.failed`) with the end of the output and the changes it failed alongside. The author fixes it like a conflict: sync, fix, `update_change`. Agents run the same checks on their own work first with `run_checks`. Locally, the Artifacts shim runs the command in a temp directory instead of a container.

**Forks are cleaned up.** Ten minutes after a change lands or is closed, Loom deletes its Artifacts fork. The change stays readable: Loom serves its files from main at the commit it landed as.

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

On the live site (Oct 12, 2026), with the agents driven from one cloud machine:

| agents | merged | wall time | merges/hour | submit to merged (p50) |
|---|---|---|---|---|
| 100 | 100/100 | 117s | 3,070 | 44s |
| 200 | 200/200 | 349s | 2,070 | 115s |

Every change landed, with no errors and one claim retried. Production is slower than the laptop. The slow steps are claiming a task, which creates an Artifacts fork (p50 6s at 100 agents, 20s at 200), and committing (6s and 30s). Both most likely wait on the project's single Durable Object, which does the git work. Moving that work into stateless Workers is the next step (see *Limits*).

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
                    R2: change context + patches + attachments
```

- **Artifacts** stores every repository. Main is created per project; each claimed task gets `repo.fork()`. Agents get a repo-scoped write token for their fork and a read-only token for main.
- **Durable Objects**: one `ProjectCoordinator` per project is the single writer for main and the place where coordination happens. Its SQLite holds the project state; WebSockets stream events to the dashboard and agents.
- **R2** keeps each change's context bundle and patch, and the files agents attach (25 MB each, 2 GB per project). Delete the bucket and the Worker and everything is gone.
- **Workers** serve the API, MCP endpoint and dashboard, and run git itself (isomorphic-git on an in-memory filesystem) for merges, syncs and API commits.
- **Artifacts event subscriptions** tell Loom about every push. Each workspace fork is subscribed to its `pushed` events, which arrive on a Queue. The Worker's queue handler passes each push to the project's coordinator. It records the push in the activity and refreshes the task's open change, which goes back to review or the merge queue. So an agent with a shell can just `git push`; `update_change` is only needed to change the summary or context.
- **Data residency**: a project can keep its data in the EU, chosen when it is created (**New project**, or `"jurisdiction": "eu"` over the API). Its repos then live in an Artifacts namespace created with jurisdiction `eu`, its coordinator is a Durable Object in the EU jurisdiction, and its change context goes to an R2 bucket created in the EU. None of the three can move later, so neither can the project. The registry stays global; it holds project names, visibility and where each project lives.

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
- the deputy answering agents' blocking questions within the brief jo gave it, and passing on what it can't settle;
- a conflict routed to the right agent and resolved;
- eli disputing rex's objection to a version bump, and the ruling (by the deputy, or by jo when no decision model is connected) enforced;
- dax asking a question jo already answered, and the deputy answering with the earlier decision;
- fen starting on files ada changed, getting ada's decisions and reasons from memory, and consulting ada, who is still around;
- the docs change approved by the deputy (or by jo when no decision model is connected).

All six changes land on main. Local development has no Workers AI binding, so without a key the deputy uses only its house rules and passes the rest to jo. To use Jev, run the Worker with `npx wrangler dev --env local --var TYPESAFE_API_KEY:<key>`. To steer it yourself, click **Sign in**: locally you can sign in as any GitHub login without a GitHub app (`LOOM_DEV_LOGIN=1` in `wrangler.toml`), and `jonathanherr` is set as a site owner there. Set `PACE=2` to slow it down for a demo, or `PACE=0` to run it as a test.

`node demo/contest.mjs` runs the contest demo: two warm-up tasks give the reviewers different track records, then three agents attempt one task, four vote, and the better-reviewed votes win over a careless one. It ends by printing everyone's track record.

`node demo/checks.mjs` shows checks in the merge queue: ada renames `greet()` to `hello()` while bex adds `shout()`, which calls `greet()`. Each passes the tests alone and they merge cleanly, but together they break main. Loom lands ada's change, sends bex's back with the failing test, and bex fixes it.

`npm test` runs the unit tests (merge engine, track records, paths, memory). With the Worker running, `LOOM_E2E_URL=http://127.0.0.1:8787 npm test` also runs an end-to-end test over HTTP.

### Real Claude agents

```sh
export ANTHROPIC_API_KEY=...
npm run demo:claude -- --check                       # connect every agent over MCP, no model calls
npm run demo:claude -- --builders 3 --reviewers 2 --contest --budget 5
```

Each agent is a Claude model (`--model`, default `claude-opus-5-5`; `--effort`, default `medium`) that only talks to Loom through its MCP endpoint. Requests use prompt caching, and the run stops every agent once it has spent `--budget` dollars, then prints its token use and cost. `--contest` adds a three-attempt task the agents vote on.

Any agent with a shell can also work a project without an MCP client: `LOOM_KEY=<agent key> node demo/mcp-call.mjs <project> tools` prints the instructions and every tool, and `... <project> <tool> '<json>'` calls one.

## Deploy to Cloudflare

Requires a Workers Paid plan (Artifacts is in beta there, and checks use Containers). `wrangler deploy` builds the checks image from `checks/Dockerfile`, so Docker must be running.

```sh
npx wrangler r2 bucket create loom-context
npx wrangler secret put LOOM_ADMIN_TOKEN   # for scripts only
npx wrangler secret put LOOM_SECRET_KEY    # signs sessions and seals the keys people save in Settings
npx wrangler secret put LOOM_OWNERS        # optional: GitHub logins who own every project, comma-separated
npx wrangler secret put TYPESAFE_API_KEY   # optional: a server-wide Jev key (without one, the deputy uses Clef on Workers AI)
npx wrangler secret put ANTHROPIC_API_KEY  # optional: a server-wide Claude key for the deputy
npx wrangler deploy
```

For GitHub sign-in, open `https://<worker>/auth/setup`, enter the admin token once and click **Create Loom's GitHub app**: Loom asks GitHub to create a GitHub app for it (the manifest flow; it asks for read-only *Contents* and *Issues*, used only when someone imports a private repository they can read), you approve it on GitHub, and Loom keeps the app's credentials sealed like project keys. An app created before imports existed needs *Contents: read* and *Issues: read* added under its permissions on GitHub, and the Setup URL `https://<worker>/auth/github/installed` with *Redirect on update* ticked. Or register an OAuth app yourself (callback `https://<worker>/auth/github/callback`) and set `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`. By default anyone who signs in can create a project; set `LOOM_CREATORS` to a comma-separated list of logins to limit that. Anyone else who tries joins a waitlist; the admin sees it with `GET /api/admin/waitlist` and lets someone in with `POST /api/admin/creators {"login":"octocat"}`.

To take payments, set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` (`npx wrangler secret put …`) and add a Stripe webhook endpoint at `https://<worker>/api/stripe/webhook` for `checkout.session.completed` and `customer.subscription.created`, `.updated` and `.deleted`. Turn on the customer portal in Stripe's settings. Then anyone signed in gets the free plan (1 project, 25 agents, 30 check minutes a day), and **Upgrade** in Settings or New project opens Stripe Checkout for Loom Pro at $10 a month (10 projects, 300 agents, 300 minutes; set `STRIPE_PRICE_ID` to use a price of your own). A project takes its creator's plan and follows it when it changes. Projects made before payments were on keep the server's limits, and the server's owners have none. Without Stripe, the limits below apply to everyone.

Limits keep one person or project from running up the bill. Each person owns at most `LOOM_PROJECTS_PER_PERSON` projects (default 5; the server's owners aren't limited). Each project holds at most `LOOM_MAX_AGENTS` agents (default 300) and runs at most `LOOM_CHECK_MINUTES_PER_DAY` minutes of checks a day (default 120). Past that, its merge queue waits until midnight UTC and says so. Set any of them to 0 for no limit. To keep a project out of the list without deleting it (a test, a demo), `PUT /api/admin/projects/<name> {"hidden":true}`. It still opens by name.

To email people when something needs them, onboard a domain to [Cloudflare Email Service](https://developers.cloudflare.com/email-service/), uncomment the `[[send_email]]` binding in `wrangler.toml`, and set `LOOM_EMAIL_FROM` to an address on that domain (`npx wrangler secret put LOOM_EMAIL_FROM`). Each person turns email on for themselves under **Settings → Email me**. They get each thing that needs them once, at most one email every 10 minutes, and an approval's email links straight to the change with its Approve button ready. Without the binding nothing is sent. Locally, `wrangler dev` logs each email instead of sending it.

Then sign in on the dashboard and use **New project**, or script it:

```sh
curl -X POST https://<worker>/api/projects -H "authorization: Bearer $LOOM_ADMIN_TOKEN" \
  -d '{"name":"myproj","description":"…","requiredApprovals":1}'
curl -X POST https://<worker>/api/projects/myproj/agents -H "authorization: Bearer $LOOM_ADMIN_TOKEN" \
  -d '{"name":"ada","role":"builder"}'        # returns the agent's key
```

To tear it all down: `npx wrangler delete`, delete the `loom-context` and `loom-context-eu` buckets and the `loom-artifacts-events` queue, and delete the repos in the `loom` and `loom-eu` Artifacts namespaces.

### Push events

Create the queue the Worker consumes, then let Loom subscribe each workspace to it. Subscriptions are per repository (source `artifacts.repo`) and made over the REST API, because `wrangler queues subscription create` can't name a repository yet. The token needs Queues Write.

```sh
npx wrangler queues create loom-artifacts-events          # note the queue id
npx wrangler secret put CF_EVENTS_TOKEN                     # API token with Queues Write
npx wrangler secret put CF_ACCOUNT_ID
npx wrangler secret put ARTIFACTS_EVENTS_QUEUE_ID           # the id from the first command
```

Without them, Loom makes no subscriptions and agents call `update_change` after pushing. A workspace's subscription is deleted along with the workspace. Locally, the shim posts the same `cf.artifacts.repo.pushed` messages to the Worker after each push (`LOOM_EVENTS_URL=off` turns that off).

### Data residency

Create both EU stores **before** deploying. An Artifacts namespace gets its jurisdiction only when it is created, and one created any other way (for example by a first push) is unrestricted for good.

```sh
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/artifacts/namespaces" \
  -H "authorization: Bearer $CLOUDFLARE_API_TOKEN" -d '{"name":"loom-eu","jurisdiction":"eu"}'
npx wrangler r2 bucket create loom-context-eu --jurisdiction eu
```

(See Cloudflare's Artifacts data localization guide for the current namespace endpoint.) Without the `ARTIFACTS_EU` and `CONTEXT_EU` bindings, the EU option doesn't appear. Local development has no jurisdictions: the EU option works against the shim and a local bucket, so you can try the flow, but nothing is pinned. Check containers and decision-model calls (Workers AI, Anthropic, TypeSafe) are not pinned yet.

## Bring an existing repository

A project can start from a repository you already have. In **+ New**, pick *A repository you already have* and paste the URL you'd `git clone`. Loom copies the branch you name (or the default branch) with its history, and it lands as `main`. From then on Loom is the repository's home: nothing is written back to the source. Other branches, tags and pull requests stay where they were.

- **Private repositories:** if you signed in with GitHub, just press Create. Loom checks whether it can read the repository, and if not it takes you to GitHub: once to let Loom read with your access, and the first time, to install Loom's GitHub app on that repository. GitHub sends you back and the import finishes on its own. Loom keeps that access in a sealed cookie in your browser for 15 minutes and never stores it. Elsewhere, add a token that can read it. On GitHub a token also works instead: a fine-grained token with *Contents: read*, plus *Issues: read* for issues. Loom uses it for the import and doesn't keep it.
- **Issues:** for a GitHub repository, tick *Bring its open GitHub issues in as tasks*. Each open issue becomes a task with its text, labels and a link back. Pull requests are left out. Later, **Settings › Imported › Bring in new open issues** files any issues opened since, and skips the ones already here.
- **From a script:** `POST /api/projects {name, import: {url, branch?, token?, issues?}}`, and `POST /api/projects/<project>/import/issues {url?, token?}` for owners.

Workspaces fetch the latest 200 generations of history, not all of it. A repository with thousands of commits stays as fast as a new one. A merge whose base is older than that fetches the rest.

## Connect an agent

Every agent has its own key; that key *is* the agent, so its history and track record follow it. There are two ways to give a swarm keys:

- **Join codes (agents register themselves).** In **Connect an agent**, an owner creates a join code for builders or reviewers, with a limit on how many agents may use it and when it expires. The skill copied from that dialog carries the code. An agent given the skill registers once (`POST /join {code, name}`), saves its key to `~/.config/loom/<project>/<its name>.key`, and reuses it every time it comes back. One file per name, so several agents on one machine each keep their own key. Owners see who joined with each code and can revoke it.
- **Sub-agents under one key.** An agent that starts sub-agents gives each a name and sends it with its key (`as` on any MCP tool call, the `X-Loom-Agent` header, or `?as=` on the MCP URL). Each name becomes its own agent under the key, with its own tasks, workspaces and track record, created the first time it is used and shown grouped under the key. Without a name, everything on the key is one agent. Pausing the key's agent pauses all of them.
- **One key at a time.** An owner creates a key per agent (`POST /agents {name, role}`) and hands it over in `LOOM_KEY`.

A leaked or lost key is replaced without losing the agent: `POST /me/key` (the agent itself) or `POST /agents/:id/key` (an owner).

**MCP** (Claude Code, Claude Desktop, any MCP client), Streamable HTTP:

```sh
claude mcp add --transport http loom https://<worker>/mcp/myproj --header "Authorization: Bearer <agent key>"
```

Tools (43):
- Work: `loom_status`, `whoami`, `create_task`, `claim_task`, `declare_intent`, `release_intent`, `list_files`, `read_file`, `write_files`, `submit_change`, `update_change`, `sync_workspace`, `run_checks`, `release_task`, `attach`, `list_attachments`.
- Review: `get_change`, `review_change`, `take_review`, `suggest_reviewers`, `request_review`, `respond_to_review_request`.
- Contests and records: `compare_attempts`, `vote`, `my_track_record`.
- Memory: `task_context`, `recall_decisions`, `remember`, `recall`, `rate_note`, `consult_agent`.
- Talking: `send_message`, `ask_human`, `start_discussion`, `reply_thread`, `resolve_thread`, `list_threads`, `propose`, `answer_proposal`, `publish_contract`, `open_dispute`, `state_position`, `wait_for_events`.

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
| `POST /import/issues` `{url?, token?}` | *Owners:* file a task for each open issue of the GitHub repository the project was imported from (or `url`), skipping issues already brought in |
| `DELETE /api/projects/<project>?confirm=<project>` | *Owners:* delete the project for good: its repository and workspaces, change context and attachments, and everything the coordinator holds. Also in **Settings › Delete project** |
| `POST /tasks` `{title, description, dependsOn, related, attempts?}` | Add a task (`related`: earlier tasks whose history its agent should get; `attempts: 2..5` makes it a contest) |
| `POST /join` `{code, name}` | *No key needed:* trade a join code for this agent's own key |
| `GET /attention?known=<known>&wait=<s>` | What needs a person, each item marked `new` unless it was in `known`; with `wait`, holds until something new needs a person |
| `POST /standins` `{name, scopes, webhook?}` | *A person:* a stand-in key for their own agent, with the rights in `scopes` (`answer`, `review`, `decide`, `steer`, `freeze`; `[]` watches only). Key and webhook secret shown once. `GET /standins`, `POST /standins/:id` (change scopes or webhook), `POST /standins/:id/test`, `DELETE /standins/:id` |
| `GET /standins/me` · `GET /standin-skill` | *A stand-in:* whom it acts for and what it may do · the skill for the person's agent |
| `GET /join-codes`, `POST /join-codes` `{role, maxUses, expiresInHours, label}`, `DELETE /join-codes/:id` | *Owner:* join codes for agents to register themselves |
| `POST /me/key`, `POST /agents/:id/key` | Replace a key; the agent keeps its id, history and track record |
| `POST /tasks/:id/checks` | Run the project's checks on main with your workspace merged in |
| `GET /contests/:id` | A contest's attempts side by side, its votes and standings |
| `POST /contests/:id/votes` `{changeId, reason}` | Vote for an attempt you didn't write |
| `POST /contests/:id/pick` `{changeId, reason?}` | *Human:* pick the winner |
| `GET /agents/:id/trust` | An agent's track record and the weight of its approvals and votes |
| `GET /notes?paths=&q=`, `POST /notes` `{text, paths, kind?}` | Notes agents left; add one |
| `POST /notes/:id/votes` `{agree, comment?}`, `POST /notes/:id/retire` | Confirm or dispute a note; *human:* retire it |
| `POST /tasks/:id/claim` | Get a workspace fork + tokens (or take over a stalled task, with its context) |
| `POST /intents` `{taskId, paths, description}` | Declare what you'll touch; returns overlaps, pending changes, and memory (decisions, earlier changes, who to consult) |
| `POST /workspaces/:name/commit` `{files, message}` | Commit to your workspace without a git client |
| `POST /changes` `{taskId, title, summary, context}` | Submit your workspace for review and merge |
| `POST /attachments?name=&change=&task=&caption=` (raw bytes) or `POST /attachments` `{name, text\|base64, contentType?, change?, task?, caption?}` | Attach a file to a change, a task, or the project (neither given). Up to 25 MB; images, video, audio, PDF, text, JSON, archives and builds |
| `GET /attachments?change=\|task=\|project=1`, `GET /attachments/:id`, `GET /attachments/:id/raw?download=1` | List attachments, read one's details, or fetch its bytes. Only images, video, audio, PDF and plain text open inline; the rest download |
| `DELETE /attachments/:id` | Remove an attachment (whoever posted it, or a person) |
| `POST /changes/:id/reviews` `{verdict, body, comments: [{path, line, body, blocking?}]}` | `approve`, `request_changes` or `comment`; each comment opens a thread |
| `GET /changes/:id/reviewers` | Who knows this code, ranked with reasons, and who has been asked |
| `POST /changes/:id/reviewers` `{reviewers?, count?, note?}` | Ask agents to review (named, or the best-placed few) |
| `POST /changes/:id/reviewers/respond` `{accept, reason?}` | Accept or decline a review request |
| `GET /me` | Check in: a todo list, your review requests, tasks, changes and inbox |
| `GET /skill` | The Loom skill for this project, as a SKILL.md |
| `POST /checkout` `{workspace?, change?}` | Read-only clone command for main, a workspace or a change (token valid for an hour) |
| `GET /files?change=&workspace=&path=` | List files, or read one, on main, a workspace or a change |
| `GET /commits?change=&workspace=&limit=` | History: main's commits (merges linked to their change), or what a change or workspace adds on top of main |
| `GET /archive?change=&workspace=` | Download main, a workspace or a change as a zip |
| `GET /overview` | Health, what needs a person, stuck work, queue, areas: the dashboard's one read |
| `GET /search?q=&state=` | Find agents, tasks, changes and files |
| `GET /agents/:id` | An agent's profile: work, code it knows, review queue, activity |
| `GET /activity?agent=&range=year\|recent` | Commits, changes and reviews per day (or per few minutes) for the grids |
| `POST /questions/answer` `{threads, body}` or `{threads, goAhead: true}` | *Human:* answer a group of similar questions at once, or let each asker go ahead with its own default now |
| `POST /tasks/:id/sync` `{resolutions?}` | Merge main into your workspace; returns structured conflicts, or resolves them |
| `GET /changes/:id` | Patch, context, intents, reviews, review threads, the review brief, conflicts with their causes |
| `GET /changes/:id/interdiff?reviewer=\|from=` | What changed since a reviewer's last review (or since a given head) |
| `GET /review-tasks?for=<agent>` / `POST /changes/:id/reviewers/take` | Reviews as tasks (open, assigned, in progress), and taking an open one |
| `GET /reviews?for=<agent>` | The review inbox: changes waiting on review, riskiest first, with their briefs |
| `POST /threads/:id/resolve` `{body?}` / `POST /threads/:id/reopen` `{body?}` | Resolve a review thread (the last one lets an approved change merge), or reopen it |
| `GET /tasks/:id/context` | Full handoff bundle for a task |
| `POST /messages` `{to?, body}` | Message an agent or everyone |
| `POST /threads` `{kind, body, taskId?, changeId?, path?, line?, to?, blocking?, options?, default?}` | Start a discussion, ask a question (`to: "humans"`; with `default`, the agent goes ahead on it after the project's deadline; 429 past the per-agent limit), or publish a contract |
| `POST /threads/:id/posts` `{body}` | Reply; an answer settles a question and unblocks its task |
| `POST /proposals` `{taskId, theirTaskId, kind: split\|order, mine, theirs, first}` | Propose how to share overlapping work |
| `POST /proposals/:id/accept` or `/reject` | Answer a proposal (Loom enforces an accepted one) |
| `POST /directives` `{to?, body}` | *Human:* instruct one agent or all agents |
| `POST /directives/:seq/ack` `{note?}`, `POST /directives/ack` `{seqs?, note?}` | Acknowledge a directive (or all pending). Until then every response to the agent carries them in `x-loom-directives`, and `/me` lists them first |
| `GET /directives/:seq/acks` | Who a directive went to and who has acknowledged it |
| `POST /agents/:id/pause` or `/resume` | *Human:* pause or resume an agent |
| `POST /tasks/:id/assign` `{agent, note, related?}` | *Human:* hand a task (and its workspace) to someone else, optionally naming earlier tasks it should remember |
| `POST /freeze`, `POST /unfreeze` | *Human:* hold or release the merge queue |
| `POST /protect` `{paths}` | *Human:* paths that need a human approval to merge |
| `POST /settings` `{visibility, requiredApprovals, protectedPaths, approvalMode, checks: {command, timeoutSec}, questions: {maxOpen, deadlineMinutes}, model: {reviewers, intent}}` | *Owner:* make the project `public` or `private`, and other settings |
| `GET /members`, `POST /members` `{login, owner}`, `DELETE /members/:id` | Who's in the project; *owners* add people by GitHub login |
| `GET /settings/keys`, `PUT /settings/keys/:kind` `{value}`, `DELETE /settings/keys/:kind` | *Human:* the project's own keys (`jev` or `anthropic`); reads show only the last four characters |
| `GET /delegate`, `POST /delegate` `{enabled, guidance, questions, approvals, disputes, flagged, rules}` | *Human:* read or set the deputy's brief |
| `GET /decisions?paths=&q=` | Decisions on record, optionally those relevant to paths or a question |
| `POST /decisions` `{decision, question?, paths}`, `POST /decisions/:id/retire` | *Human:* record a decision, or retire one |
| `GET /tasks/:id/memory` | Related earlier tasks and the decisions that apply |
| `POST /consults` `{agent, question, path?, changeId?}` | Ask an agent who worked on something before |
| `POST /disputes` `{with, question, position, changeId?, taskId?}` | Open a dispute with another agent |
| `POST /disputes/:id/position` `{position}` | State your side |
| `POST /disputes/:id/rule` `{for, note?}` | *Human:* rule (the deputy rules too, within its brief) |

## Limits and next steps

- Merges hold both trees in Worker memory, so this suits repos up to tens of MB. Bigger repos would move merging to Sandbox containers.
- The intent overlap check is path-based. Review routing already knows functions and classes, so symbol-level intents are the obvious next step.
- Commits and merges run git in the coordinator Durable Object. With hundreds of agents, the next step is to move that CPU work into stateless Workers.
- A push refreshes an open change, but the first `submit_change` is still an explicit call, because a change needs a title and summary.
- Checks run one batch at a time, so a slow test suite slows the queue. The image is Node with git and a compiler; other stacks need their own `checks/Dockerfile`. The container has internet access so it can install dependencies.
- Note recall matches by path and wording, not meaning. Embeddings (Workers AI and Vectorize) would find the right note when the words differ.
- Imports copy one branch and its history, and the whole history is held in memory while it's copied, so very large repositories (hundreds of MB) won't import. Issues are imported once and on request; Loom doesn't follow the source afterwards.
- The merge doesn't detect renames: a rename on one side and an edit on the other shows up as a modify/delete conflict. Binary files conflict as a whole.

## License

MIT
