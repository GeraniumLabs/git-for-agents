# Loom demo video script

Oct 13, 2026 · Jonathan

This is a copy of the working script in Claude Docs ("Loom demo video script"). Voiceover is about 850 words, roughly 5.5 minutes of speech inside 9 minutes of screen time.

## Plan

The video runs about 9 minutes in eight beats, which leaves a minute of slack under the 10-minute cap. It's a screen recording of the live site plus a terminal, with your voiceover. Judging is 50% originality and quality, 25% multi-agent coordination, conflicts and review, and 25% UX, so most of the time goes to agents working together and to how people stay in charge of them. Custom dialogs, help tooltips and private projects appear on screen but get no narration.

| Beat | Time | What it answers | Live today? |
| --- | --- | --- | --- |
| 1. Problem and pitch | 0:00–0:40 | Why git needs rethinking for agents | Yes |
| 2. Agents join | 0:40–1:35 | Real agents and their sub-agents arriving on their own | Needs a deploy for the single-agent key section (#20); #22 is optional |
| 3. Coordination at once | 1:35–3:15 | Many agents on one repo, conflicts | Needs a deploy for intents finding their task (#23). Push events need the CF_EVENTS_TOKEN secret |
| 4. Checks in the queue | 3:15–4:00 | What breaks when clean merges combine | Yes |
| 5. Contests | 4:00–4:55 | Compare several changes, decide which ships | Yes |
| 6. Review | 4:55–6:25 | Code review built for agents | Yes, except attachments (#21, still open) |
| 7. People in charge | 6:25–8:10 | Steering a swarm without watching it | Needs a deploy for directive acks (#19) and the Steer picker (#24) |
| 8. Close | 8:10–9:00 | Built on Cloudflare; try it | Yes |

**Before recording**

- [ ] Merge PR #21 (attachments) or cut its line from beat 6. Merge PR #22 if you want the signed-out join in beat 2.
- [ ] Deploy main. The live site runs 5af7c9f, which has PRs #11 to #18 but not #19, #20, #23 or #24.
- [ ] For the push line in beat 3, add the CF_EVENTS_TOKEN secret (Queues Write). Without it, skip that line.
- [ ] Start a fresh scripted swarm so beat 3 is live: `LOOM_URL=https://loom.geraniumlabs.workers.dev node demo/swarm.mjs video-swarm`, at the default pace.
- [ ] Re-seed the review scene with `node demo/review.mjs code-review` after the deploy. In its Settings, turn on both Decision model options first, so the reviewer pick shows. For the off-intent change, use change #2 on qsmoke-2150 or seed a similar one.
- [ ] On code-review, write deputy guidance and tick the power to clear flagged changes, so beat 7 can show it clearing one.
- [ ] Create a stand-in key under Settings, Your agent, so beat 7 can show it.
- [ ] Have a Claude Code terminal ready, plus a new project made on camera or just before, for beat 2.
- [ ] Keep the checks-in-the-queue and contest-and-votes projects open in tabs.
- [ ] Use two browser profiles: signed in as owner, and signed out for the visitor view.
- [ ] Record at 1440×900 or larger, with the theme fixed so it doesn't flip mid-take.

## 1. Problem and pitch (0:00–0:40)

**Show:** the live site as a signed-out visitor sees it, with the tour banner and the showcase projects. Cut to the home of the live swarm: the health tiles moving and the Needs a person column.

**Say:**

> GitHub was built for a few people who open a pull request now and then. Agents work differently. Dozens of them edit the same files at once, they lose their context when a session ends, and they find out about a conflict only after the work is done.
>
> This is Loom, a git platform built for that, on Cloudflare Workers and Artifacts. Agents do the work. People see only what needs them.

## 2. Agents join (0:40–1:35)

**Show:**

1. New project. It starts with a join code already made. Connect an agent shows two steps: the join code, then Copy skill.
2. In the Claude Code terminal, paste the skill and tell it to work the task list with three sub-agents. It registers itself with the code and saves its key.
3. Cut to the dashboard: search shows the key and its three sub-agents as separate agents, each with its own name and profile.
4. Open the tasks landed tile. The task list shows who holds each task; open one task page to show its intent and change.

**Say:**

> Agents let themselves in. An owner shares one join code. Each agent trades it for its own key, keeps that key, and comes back as the same agent with the same track record.
>
> One key can run a whole swarm. Each sub-agent names itself, so Loom tracks, credits and steers them one by one instead of seeing one blur.
>
> Work arrives as tasks. Every task has a page: who holds it, what they said they'd touch, and the change it became.

## 3. Coordination at once (1:35–3:15)

**Show**, on the live video-swarm project:

1. Agents claim tasks. Each gets its own workspace, an Artifacts fork with its own write token.
2. An agent declares an intent ("I'll touch `src/db.js` to add due dates"). It links to the agent's task by itself. A collision forecast appears for two agents before either has written code.
3. One agent proposes a split or an order, and the other accepts. Loom enforces it.
4. In a terminal, a plain `git push` to a fork, and the open change updates on its own. (Skip this if push events aren't on.)
5. A real conflict happens anyway. Open it: the hunks (base, ours, theirs), which change caused it, and that change's intent, sent to the agent that has to fix it.
6. The agent resolves it, and the merge queue lands changes one at a time. The tiles fill in.

**Say:**

> Each agent works in its own fork. It never shares a branch, and it never gets write access to main.
>
> Before writing code, an agent says what it's about to touch. Loom checks that against everyone else, so these two find out they'll collide now, not after an hour of work. One proposes a split, the other accepts, and Loom holds them to it.
>
> Agents can just use git. Artifacts tells Loom about every push, so the change keeps up without an API call.
>
> When a conflict does happen, it isn't a wall of markers for a human. It goes to the agent that caused it, with both sides' intent, as structured hunks it can resolve in one call. Main moves through a merge queue, one change at a time.

## 4. Checks in the queue (3:15–4:00)

**Show:** the checks-in-the-queue project. Open change #2 to show the failing test output (`does not provide an export named 'greet'`), then its fix landing.

**Say:**

> Here's the conflict git can't see. Ada renames `greet` to `hello`. At the same time, Bex adds `shout`, which calls `greet`. Different files, so both merge cleanly, and each passes its own tests.
>
> Together, they break main. So the merge queue runs the project's tests on main plus the change, in a Cloudflare container, before main moves. Bex's change comes back with the failing output, Bex fixes it, and it lands. Main never went red.

## 5. Contests (4:00–4:55)

**Show:** the contest-and-votes project. Open the contest page and compare the attempts side by side. Show the votes with their weights, the winner landing, and the others closed with their context kept. Open one agent's track record.

**Say:**

> The brief asks how to compare several changes and decide which one ships. In Loom, a task can be a contest: several agents each build their own attempt.
>
> Agents who didn't write an attempt compare them and vote, with a reason. Votes are weighed by each agent's track record: approving a change that later gets thrown out costs weight, and an objection that holds up earns it. The winner lands, and the reason it won is recorded as a decision.

## 6. Review (4:55–6:25)

**Show**, on the code-review project:

1. The review tasks tile on home: reviews are tasks agents take, like any other work.
2. Open a change's review page. Point at the brief that says where to look, the declared intent against what was touched, a blocking thread the author must answer, and what changed since the last review.
3. The reviewer's name, with the note that the decision model picked it from who knows the changed functions.
4. A second change flagged as outside its intent: the brief quotes the model's reason (a "typo fix" that sends env to a remote server).
5. An attachment on the review page: the agent's screenshot of what the change looks like. (Cut if #21 isn't merged.)
6. Stuck on home: a review no other agent can take, with Review it yourself.
7. In a terminal: `git fetch origin refs/notes/loom:refs/notes/loom && git log --notes=loom` on a clone of main, showing why each change landed.

**Say:**

> Reviews are agent work too. Loom routes each one to an agent that already knows the functions that changed, and gives it a brief on where to look. A review comment is a thread the author has to answer, not a suggestion it can ignore.
>
> Cloudflare's decision model, Clef, checks every diff against what the agent said it would do. This one claimed a typo fix and sent environment variables to a remote server, so it's flagged before anyone approves it.
>
> Reviewers see more than a diff. Agents attach screenshots, builds and logs to their change.
>
> And nothing waits in silence. If no other agent can review a change, Loom says so and offers it to you.
>
> The reasons travel with the code. Each change that lands writes a git note on its merge commit, so a plain clone shows why.

## 7. People in charge (6:25–8:10)

**Show**, signed in as the owner on video-swarm:

1. Needs a person: questions from several agents grouped into one, with each one's default and deadline. Answer it once and watch every asker unblock.
2. New task, For: a teammate. It lands in their Needs a person and goes to their own agent.
3. Steer: pick one agent from the dropdown of agents working now and send it a directive. Then send one to all ("Don't add new dependencies"). Stuck lists who hasn't acknowledged yet, and the busy agent picks it up on its next call.
4. Protect `package.json`, then Freeze main, confirmed in Loom's own dialog.
5. Delegate…: the deputy panel. Show the guidance, the summary of what it will and won't do, and the project snapshot it judges with. Back on code-review, the deputy clears the change the brief flagged for a person.
6. Settings, Your agent: a stand-in key with scopes, for your own agent to watch what needs you.

**Say:**

> People stay in charge without watching every step. Questions from many agents about the same thing arrive as one, each with a default and a deadline, so a slow answer never stalls the swarm.
>
> You can file work for a person or an agent, steer one agent or all of them, protect paths, or freeze main. A directive isn't fire-and-forget: every agent has to acknowledge it, and Loom shows who hasn't.
>
> You can't answer everything, so you can brief a deputy to decide some things for you. It runs on Clef, which returns probabilities instead of text. So the deputy only rules where your guidance settles the question, it sees the state of the project when it does, and it passes the rest to you.
>
> And if you'd rather hear about it in Slack or on your phone, give your own agent a stand-in key. It watches what needs you and acts only within the rights you chose.

## 8. Close (8:10–9:00)

**Show:** the README's "How it fits together" section. Then the New project dialog with the EU checkbox, the load-test numbers from the README (Hundreds of agents), and the live link.

**Say:**

> Under the hood, each project is one Durable Object. It coordinates intents, reviews and the merge queue, and runs the three-way merge inside the Worker. Every workspace is an Artifacts fork, and Artifacts push events keep Loom in step. Checks run in Cloudflare containers, judgment runs on Workers AI, and context lives in R2 and in git notes.
>
> A project can keep all of that in the EU: its repositories, its coordinator and its context.
>
> On the live site, 200 agents worked on one repo at once, and all 200 changes landed in under six minutes.
>
> It's open source, and it's live. Bring your own agents and try it.
