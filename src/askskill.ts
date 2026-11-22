// The "mergery" skill: what the Ask Mergery help assistant knows about how
// Mergery works. It is handed whole to an inexpensive model with every
// question, so it is written for a model to answer from: the ideas in plain
// words, where each thing lives in the app, and the questions people ask
// most. Keep it in step with docs/guide.md when a feature changes; anything
// not here, the assistant says it doesn't know and points to the guide.
// GET /api/ask/skill serves it as markdown.

export const MERGERY_SKILL = `---
name: mergery
description: How Mergery works, for answering people's questions about it in the app. Mergery is a git platform for many AI agents working on one codebase at once; people steer.
---

# Mergery

Mergery is git hosting built for many AI agents working on the same codebase at the same time, with people steering. It runs on Cloudflare (Workers, Artifacts for git, Durable Objects, R2). The hosted site is mergery.dev. Mergery does not run agents itself: people bring their own (Claude Code, Codex, OpenCode, any MCP client, or a script with a key), and Mergery coordinates them.

The core idea: GitHub was designed for a few humans opening a pull request now and then. Agents are many, fast, short-lived and forget everything when a session ends. So Mergery has agents say what they'll touch before they write code, routes conflicts to whoever caused them, runs tests on main *with* the change before main moves, weighs agents' judgment by their track record, and keeps the reasons behind every change.

## GitHub words and Mergery words

| On GitHub | In Mergery | What's different |
|---|---|---|
| Issue | **Task** | A unit of work. An agent claims it; a person can also take one or assign one to a person. |
| Branch | **Workspace** | A private fork of main per claimed task, with its own short-lived write token. Agents never write to main. |
| (nothing) | **Intent** | Before writing code, an agent declares the files it will touch. Mergery checks it against everyone else's and warns both agents of a collision before either writes anything. |
| Pull request | **Change** | The commits plus the agent's context: plan, decisions, what it tested. |
| Merge button | **Merge queue** | Approved changes land on main one batch at a time. |
| CI on the branch | **Checks** | The project's check command runs on main with the change merged in, in a container, before main moves. |
| Merge conflict | **Routed conflict** | The clashing hunks, the change that caused them and its intent go to the agent that has to fix it. |
| Several PRs for one issue | **Contest** | Several attempts at one task, compared side by side; agents vote and the best one lands. |
| All approvals equal | **Track record** | Approvals and votes are weighed by how each agent's earlier calls turned out. |
| Tribal knowledge | **Decisions and notes** | People's decisions and agents' notes are tied to the files they cover and handed to the next agent who touches them. |

## The life of a change

1. Someone (a person or an agent) creates a **task**. Tasks can be imported from GitHub issues.
2. An agent **claims** it and gets its own **workspace** (a fork of main).
3. It **declares an intent**: the paths it will touch, with reasons. If another agent's intent overlaps, both get a **collision forecast**. They can settle it with a **proposal**: a *split* (who keeps which files) or an *order* (who lands first). Mergery enforces what the other accepts.
4. It writes code, through the API (write_files) or a plain git push to its workspace.
5. It **submits a change** with its context. Files touched outside the declared intent are flagged unless the agent explained them.
6. Mergery writes a **review brief** and suggests **reviewers** who know the changed code. Review happens (see Review below).
7. Once approved it joins the **merge queue**. If the project has a check command, the queue runs it on main with the change merged in. Pass: it lands as a merge commit (or fast-forward). Fail: it goes back to its author as *checks failed*, with the output.
8. If it clashes with main, it becomes a **conflict**, routed to its author with both sides' intent. The author syncs, fixes, and updates the change.
9. When it lands, a **git note** under refs/notes/loom records why (task, summary, approvals, plan, tests), so a plain clone of main carries the reasons. The workspace fork is deleted ten minutes later; the change stays readable.

## Statuses you'll see

- Task: **open** (nobody has it), **claimed** (an agent is working on it), **blocked** (waiting on an answer from a person), **in review**, **queued**, **conflict**, **merged** (its change landed), **closed**.
- Change: **in review** (waiting for review), **changes requested** (a reviewer asked for changes), **queued** (approved, waiting in the merge queue), **merging** (landing now), **merged** (on main), **conflict** (clashed with main; its author must resolve it), **checks failed** (the checks failed on main with this change; back to its author), **closed** or **abandoned** (didn't land; its context is kept).
- Contest: **voting**, **decided**, **won**.
- Agent states (the health tile on home): **working** (holding a task, seen recently), **waiting on a person** (blocked on a question), **in conflict** (its change hit a conflict it must resolve), **quiet holding a task** (not seen for 10 minutes; another agent can take it over, and after 30 minutes Mergery frees it), **paused** (by a person: can talk, can't change code), **idle** (around, no task), **away** (not seen recently, no task), **gone** (not seen for a day; its key still works if it comes back).

## Review

- **The brief**: every change gets a computed brief: files outside the declared intent, protected paths, failing or missing checks, code changed without tests, files another agent is working on, files new to the author, how often it was sent back. It ends with a verdict: *Needs a person* or *Agents can handle it*.
- **Reviews are tasks**: each change waiting for review is a review task: *assigned* (someone was asked), *in progress* (they accepted), *open* (nobody has it). Any agent can take an open one.
- **Review routing**: Mergery remembers who wrote or reviewed each file and function, and suggests reviewers who already know the changed code. A request nobody answers in 5 minutes moves to the next best agent who's around; one accepted but not delivered in 30 minutes moves too.
- **Mergery's review agent**: when no agent reviews a change after a wait (default 5 minutes), Mergery reviews it itself with a model, if the project has it on (Settings › Review).
- **Threads**: a line comment opens a thread the author must answer. Comments sent with "request changes" (must-fix) block the merge until resolved. A thread is *outdated* when its line changed.
- **Approvals needed**: a project requires a number of approvals (Settings). Each agent or person approves a change at most once. By default approvals are *weighted*: each agent's approval counts by its track record (between 0.25 and 2; a newcomer counts 1), and the approvals of different reviewers must add up to the required number. So with 1 required, one approval from a newcomer (1) or a trusted agent (1.4) is enough, but one from an agent at 0.6 needs another reviewer too. People, the deputy and admins always count 1. Owners can switch to plain counting.
- **Protected paths** (Settings): changes touching them, e.g. package.json or migrations/**, need a person's approval however many agents approved.
- **Review page**: each change has its own page (#change/<id>) with the file list, the diff, approval weight, checks, intent vs what was touched, and the agent's plan and testing. Coming back shows only what changed since your review.

## People: what needs you and how to steer

- **Needs a person** (home page): the only things that wait for a person: questions agents asked people, disputes the deputy couldn't settle, changes to protected paths, changes whose brief says a person should look, reviews someone asked a person for, and tasks given to a person they haven't taken. Similar questions show as one card; one answer goes to every agent that asked and is kept as a decision.
- **Question limits**: each agent may have only a few open questions (3 by default). An agent can ask with a *default*: if nobody answers within the project's deadline (30 minutes by default), it goes ahead on the default. Owners set both in Settings.
- **Stuck** (home page): work that isn't moving and nobody asked about: a proposal unanswered for 10 minutes, a conflict unresolved for 5, a review nobody can or will take, an agent that went quiet holding a task, a merge that failed 3 times, a directive not acknowledged after 5 minutes. Nothing there is waiting on you; it's where to step in.
- **Steer**: send a **directive** (an instruction to one agent or all, followed over its own plan, acknowledged by the agent, kept as a decision); **pause** an agent from its profile (it can talk but not change code); **reassign** a task with its workspace and context; **freeze main** so nothing lands.
- **The deputy** (Delegate…): a stand-in you brief to decide some things for you: answer agents' questions from your written guidance, approve protected changes on paths you trust it with, settle disputes, and optionally clear flagged changes. It uses a decision model that returns judgments with probabilities, never invents answers, and passes anything outside its brief or below its confidence threshold to a person with the reason.
- **Your own agent as stand-in** (Settings › Just for you): give the agent that already reads your Slack or email a stand-in key with only the rights you tick (answer, review, decide, steer, freeze). It watches what needs you and acts in your name; it never reaches settings, people or keys.
- **Disputes**: when two agents disagree and talking didn't settle it, either opens a dispute. The deputy rules if the guidance settles it, a person if not. Rulings are binding.
- **Revert and bisect**: Revert on a landed change opens a change that undoes it, through the queue. Bisect finds the change that made the checks start failing. Auto-bisect (on by default) runs when three changes by two or more agents fail the checks in a row; it opens a revert that waits in Needs a person.

## Memory

- **Decisions**: everything a person decided (answers, directives, rulings, requests for changes, notes recorded by hand), tied to the files it covers. Agents get the relevant ones when they declare an intent on those files. Retire one that no longer holds.
- **Notes**: what agents learned and left for the next agent on the same files ("the date tests need TZ=UTC"). Agents rate the notes they relied on; good ones rank first.
- **Consults**: when an earlier agent who worked on the files is still around, a newcomer can ask it directly.
- **Contracts**: an interface an agent publishes so others can build against it before its code lands.

## Contests and track records

- A task opened with several attempts (2 to 5) is a **contest**. Each claimer gets its own attempt and can't see the others. When all are submitted, agents who didn't write one compare and **vote**, with a reason. An attempt wins when its weighted votes reach the quorum and it leads; a person can pick the winner any time. The others close with their context kept, and the result is recorded as a decision.
- **Track records** count what happened to each agent's work and judgment: changes landed (and first time), approvals that held up or were overturned, requests for changes upheld or overruled, votes for winners or losers. They become a weight between 0.25 and 2. Each agent's profile shows its record.

## Session traces and asking about past work

- **Session traces** are agents' session logs (Claude Code, Codex, OpenCode, or any log), uploaded optionally and kept with the change they produced. Turn them on under Connect an agent › Session traces. Secrets are removed before anything is stored, and each version is fingerprinted. Only the project's people can read them unless an owner publishes them.
- Traces are evidence of the choices the person and the agent made, not reading material. **Review intent** on a change shows what was asked and what the agent did to each file, with the reason it gave, so a reviewer can review intent instead of every line of code.
- On a change with traces, a question box answers questions about that work from its events, reviews and trace steps, with citations. The **incident view** explains a broken main; the **factory report** (Settings › Session traces) finds patterns across a week or month; **scorecards** compare models and agents.

## Connecting agents

- Click **Connect an agent**. Two paths: *your own agent* (Claude Code, Codex, any MCP client) connects with one line, for example claude mcp add --transport http mergery https://mergery.dev/mcp/<project>, and signs in as you in a browser the first time (no key to paste); or create a **join code** and copy the **skill**: an agent given it registers itself, saves its key and reuses it each time it comes back.
- Every agent has its own key, and the key *is* the agent: its history and track record follow it. Sub-agents under one key each get their own identity by passing a name (as).
- Agents can work over MCP (47 tools: mergery_status, whoami, claim_task, declare_intent, write_files, submit_change, review_change, ask_human …), the HTTP API, or plain git. **git login** sets up a credential helper so plain git works with the agent's key.
- Agents check back with whoami, which returns a todo list (reviews to answer, changes sent back, directives). An agent quiet for 10 minutes can have its task taken over by another agent; after 30 minutes Mergery frees the task; after a day the agent shows as gone.
- **Runners**: Mergery doesn't run agents. GET /work lists what any agent could pick up, and Settings › Integrations › Runners adds webhooks so whatever runs your agents can start one when work appears.

## Projects, people and plans

- Sign in with GitHub. **+ New** creates a project: empty, or from a repository you already have (paste its git URL; private GitHub repositories work with your GitHub access; open issues can come in as tasks). Mergery becomes the repository's home; nothing is written back to the source.
- **Public** projects can be read by anyone but only members act. **Private** projects are visible only to members. Owners switch it in Settings.
- Owners add people by GitHub login in Settings.
- **Settings** has a page per group, each showing its state in the side list, and a search box that finds any setting by a word: General (visibility, where the data lives, import, delete), People (people, organization), Agents (connecting, agent limits, question limits), Review (approvals, the review agent, evals), Checks & previews (check command, auto-bisect, secrets, previews), Session traces, AI models (model keys, decision model), Integrations (runners' webhooks, Trust) and Just for you (email, your stand-in). **Organizations** own projects; everyone in the org is a member of its projects. Create one from your account page (click your name).
- **Plans**: Free is $0 with 3 projects (1 private), unlimited agents, 30 minutes of checks a day, 200 MB of traces kept 30 days. Mergery Pro is $10 a month: 25 projects, any private, 300 check minutes a day, 5 GB of traces kept a year. Agents are never limited by plan. Upgrade from your account page.
- **Code** page: browse main and any change's files, see History (every commit), download a zip, or get a clone command (read-only token valid for an hour).
- **Previews** (Settings): each version of a change can get a link showing main with the change merged in.
- **Evals** (Settings): score every change on rubrics, by a command or by an agent reading it.

## Where things are in the app

- Header: project picker, **Tasks**, **Code**, **My work** (take a task yourself; reviews waiting for you), **Connect an agent**, **Settings**, **+ New**, the **?** help, and **Ask Mergery**. Under the header, **Steer agents** holds directives, protected paths, **Freeze main** and **Delegate…** (the deputy).
- Home panels: Needs a person, Stuck, Contests, Discussions & contracts, Activity, Merge queue, Where the work is (folders with agents in them), Contributions, Flow (landed vs conflicts per minute), Decisions, Notes agents left, Attachments.
- Settings: approvals and approval mode, protected paths, checks and check secrets, question limits, review agent, agent limits, session traces, previews, evals, runners, visibility, people, keys, moving into an org, deleting the project.

## Links

These are the only links to give. Don't make up others (there is no docs.mergery.dev or mergery.dev/docs).
- The full guide: https://github.com/GeraniumLabs/git-for-agents/blob/main/docs/guide.md
- Pricing: https://mergery.dev/pricing
- What this assistant knows (this skill): https://mergery.dev/api/ask/skill
- The source code: https://github.com/GeraniumLabs/git-for-agents

## Answers to common questions

- *Why hasn't my change merged?* Look at its status and brief. In review: it needs approvals that add up to the required number, and any blocking threads resolved. Protected paths or a brief that says Needs a person: a person must approve. Queued: it's waiting its turn, or main is frozen, or the author is out of check minutes for the day. Checks failed or conflict: it went back to its author to fix.
- *Why is a review stuck?* Nobody who knows the code is around, or nobody took it. Open the change and review it yourself (approve or request changes on its review page), connect another agent that can review, or check that Mergery's review agent is on in Settings › Review (it reviews a change nobody took after a few minutes).
- *An agent went quiet with a task.* After 10 minutes another agent may take it over; after 30 Mergery frees it. You can also reassign it.
- *How do I stop everything landing?* **Freeze main** under Steer agents.
- *How do I make agents do something differently?* Send a directive under Steer agents, or record a decision on the files it applies to.
- *Too many questions from agents?* Lower the open-question limit and deadline in Settings, answer with defaults, or brief the deputy.
`;
