// A Model Context Protocol endpoint, so any MCP-capable agent can join a
// project with one URL and its agent key: POST /mcp/<project>.
// Each tool is a thin call into the project's coordinator.

type Call = (method: string, path: string, body?: unknown) => Promise<any>;

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: any, call: Call) => Promise<any>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });
const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "number", description });

const TOOLS: Tool[] = [
  {
    name: "loom_status",
    description: "See the whole project at a glance: agents, tasks, active intents (who is editing what), changes in review or the merge queue, and recent events. Start here.",
    inputSchema: obj({}),
    run: async (_a, call) => {
      const s = await call("GET", "/state");
      return {
        project: s.project,
        agents: s.agents.map((a: any) => `${a.id} (${a.role})`),
        tasks: s.tasks.map((t: any) => ({ id: t.id, title: t.title, status: t.status, assignee: t.assignee, dependsOn: t.depends_on })),
        intents: s.intents.map((i: any) => ({ id: i.id, agent: i.agent_id, task: i.task_id, paths: i.paths, description: i.description })),
        changes: s.changes.map((c: any) => ({ id: c.id, task: c.task_id, agent: c.agent_id, status: c.status, files: c.files.map((f: any) => f.path) })),
        mainFrozen: s.project.frozen,
        protectedPaths: s.project.protectedPaths,
        openThreads: (s.threads ?? []).filter((t: any) => ["open"].includes(t.status)).map((t: any) => ({ id: t.id, kind: t.kind, title: t.title, by: t.created_by, to: t.to_agent })),
        contracts: (s.threads ?? []).filter((t: any) => t.kind === "contract").map((t: any) => ({ id: t.id, title: t.title, body: t.posts[0]?.body })),
        recentEvents: s.events.slice(-15).map((e: any) => `${e.type} ${e.actor ?? ""} ${JSON.stringify(e.data).slice(0, 140)}`),
      };
    },
  },
  {
    name: "whoami",
    description: "Check in. Your identity, a todo list of what's waiting for you (review requests to answer, changes sent back, tasks without a change), and the latest events addressed to you. Call it first whenever you come back to this project.",
    inputSchema: obj({}),
    run: (_a, call) => call("GET", "/me"),
  },
  {
    name: "create_task",
    description: "Add a task to the project's board. Break big work into tasks other agents can claim in parallel. Use dependsOn for ordering. Set attempts (2-5) for a contest: that many agents each attempt the task independently, the others compare the attempts and vote, and the best one lands.",
    inputSchema: obj({ title: str("Short imperative title"), description: str("What done looks like"), attempts: num("For a contest: how many independent attempts (2-5). Leave out for a normal task."), dependsOn: { type: "array", items: { type: "number" } }, parent: num("Parent task, when splitting your task into subtasks"), related: { type: "array", items: { type: "number" }, description: "Earlier tasks whose history the agent taking this one should see" } }, ["title"]),
    run: (a, call) => call("POST", "/tasks", a),
  },
  {
    name: "claim_task",
    description: "Claim a task. You get your own workspace (a fork of main): pass its name (workspace.name) to read_file, list_files and write_files; the git commands and tokens are only for agents that use git directly. If the task was started by another agent, you also get their full context so you can pick up where they left off. Claiming a contest task gives you your own attempt (a separate task id); change ids and task ids are different numbers.",
    inputSchema: obj({ taskId: num("Task id") }, ["taskId"]),
    run: (a, call) => call("POST", `/tasks/${a.taskId}/claim`),
  },
  {
    name: "declare_intent",
    description: "Before editing, declare which paths you will touch (files, directories ending in /, or globs) and why. Loom tells you right away if another agent has declared overlapping paths or has a pending change there, and notifies them too. It also returns memory: decisions the humans already made about these paths (follow them), earlier changes there with their reasons and objections, and which of those agents is still around to consult.",
    inputSchema: obj({ taskId: num("Your task"), paths: { type: "array", items: { type: "string" } }, description: str("What you are about to do in these paths") }, ["taskId", "paths"]),
    run: (a, call) => call("POST", "/intents", a),
  },
  {
    name: "release_intent",
    description: "Release an intent you no longer need, so others are not warned about it.",
    inputSchema: obj({ intentId: num("Intent id") }, ["intentId"]),
    run: (a, call) => call("DELETE", `/intents/${a.intentId}`),
  },
  {
    name: "list_files",
    description: "List files on main, or in a workspace.",
    inputSchema: obj({ workspace: str("Workspace name; omit for main") }),
    run: (a, call) => call("GET", `/files${a.workspace ? `?workspace=${encodeURIComponent(a.workspace)}` : ""}`),
  },
  {
    name: "read_file",
    description: "Read a file from main or from a workspace.",
    inputSchema: obj({ path: str("Repository path"), workspace: str("Workspace name; omit for main"), ref: str("Branch, tag or commit; default main") }, ["path"]),
    run: (a, call) => {
      const q = new URLSearchParams({ path: a.path });
      if (a.workspace) q.set("workspace", a.workspace);
      if (a.ref) q.set("ref", a.ref);
      return call("GET", `/files?${q}`);
    },
  },
  {
    name: "write_files",
    description: "Commit file changes to your workspace. Pass full file contents; null deletes a file. (Agents with a git client can push to the workspace remote instead.)",
    inputSchema: obj({ workspace: str("Your workspace name"), files: { type: "object", additionalProperties: { type: ["string", "null"] } }, message: str("Commit message") }, ["workspace", "files", "message"]),
    run: (a, call) => call("POST", `/workspaces/${a.workspace}/commit`, { files: a.files, message: a.message }),
  },
  {
    name: "submit_change",
    description: "Propose your workspace for merging into main. Include a summary and your working context (plan, decisions, what you tested, open questions, and notes: things the next agent on these files should know, as strings or {text, paths, kind}; they become shared notes when the change lands); it is stored with the change so reviewers and any agent who takes over can read it. The result lists suggestedReviewers: agents who already wrote or reviewed the functions, files or folders you changed. Ask the best of them with request_review.",
    inputSchema: obj({ taskId: num("Your task"), title: str("Change title"), summary: str("What changed and why"), context: { type: "object", description: "Free-form working context: plan, decisions, tests run, files read, follow-ups" } }, ["taskId", "summary"]),
    run: (a, call) => call("POST", "/changes", a),
  },
  {
    name: "release_task",
    description: "Give up a task you won't finish, with a note. Its workspace and your context pass to whoever takes it next.",
    inputSchema: obj({ taskId: num("Task id"), reason: str("Why, and where you got to") }, ["taskId"]),
    run: (a, call) => call("POST", `/tasks/${a.taskId}/release`, { reason: a.reason }),
  },
  {
    name: "respond_to_review_request",
    description: "Answer a review request (review.assigned): accept and you have 30 minutes to review, or decline with a reason and Loom asks someone else. Unanswered requests go to someone else after 5 minutes. You don't have to accept before reviewing: review_change answers the request too. For an attempt in a contest, compare_attempts and vote answer it.",
    inputSchema: obj({ changeId: num("Change id"), accept: { type: "boolean" }, reason: str("Why, if declining (or a note if accepting)") }, ["changeId", "accept"]),
    run: (a, call) => call("POST", `/changes/${a.changeId}/reviewers/respond`, { accept: a.accept, reason: a.reason }),
  },
  {
    name: "suggest_reviewers",
    description: "Who should review a change: agents ranked by how much of it they already know (they wrote or reviewed the same functions and classes, then the same files, then the same folder), favoring recent work, agents who are present, and reviewers who aren't busy. Each comes with the reasons. Reviewer agents fill any gap.",
    inputSchema: obj({ changeId: num("Change id"), limit: num("How many (default 5)") }, ["changeId"]),
    run: (a, call) => call("GET", `/changes/${a.changeId}/reviewers?limit=${a.limit ?? 5}`),
  },
  {
    name: "request_review",
    description: "Ask specific agents to review your change. Name them (ids or names, e.g. from suggest_reviewers), or omit reviewers to ask the best-placed few automatically. Each gets a review.assigned event with why they were picked and your note.",
    inputSchema: obj({ changeId: num("Change id"), reviewers: { type: "array", items: { type: "string" }, description: "Agent ids or names" }, count: num("If reviewers is omitted: how many to pick (default: the approvals required)"), note: str("What you'd like them to look at") }, ["changeId"]),
    run: (a, call) => call("POST", `/changes/${a.changeId}/reviewers`, { reviewers: a.reviewers, count: a.count, note: a.note }),
  },
  {
    name: "run_checks",
    description: "Run the project's checks (its test command, e.g. `npm test`) on what your task would land: main with your workspace merged in. The same checks run in the merge queue before anything lands, and a change that fails them is sent back to its author. Returns pass or fail, the exit code and the end of the output. Takes a while: the project's dependencies are installed each time.",
    inputSchema: obj({ taskId: num("Your task") }, ["taskId"]),
    run: (a, call) => call("POST", `/tasks/${a.taskId}/checks`),
  },
  {
    name: "get_change",
    description: "Read a change: its patch, the author's summary and context, declared intents, files touched outside those intents, reviews, and any conflicts with who caused them.",
    inputSchema: obj({ changeId: num("Change id") }, ["changeId"]),
    run: (a, call) => call("GET", `/changes/${a.changeId}`),
  },
  {
    name: "review_change",
    description: "Review another agent's change. verdict: approve, request_changes or comment. Approvals on the current head move the change into the merge queue.",
    inputSchema: obj({ changeId: num("Change id"), verdict: { type: "string", enum: ["approve", "request_changes", "comment"] }, body: str("Review summary"), comments: { type: "array", items: obj({ path: str("File"), line: num("Line"), body: str("Comment") }, ["path", "body"]) } }, ["changeId", "verdict"]),
    run: (a, call) => call("POST", `/changes/${a.changeId}/reviews`, a),
  },
  {
    name: "compare_attempts",
    description: "A contest's attempts side by side: each attempt's summary, files, lines added and removed, patch, working context, reviews and votes so far, and the standings. Use it before you vote.",
    inputSchema: obj({ taskId: num("The contest task (or any of its attempts)") }, ["taskId"]),
    run: (a, call) => call("GET", `/contests/${a.taskId}`),
  },
  {
    name: "vote",
    description: "Vote for the attempt in a contest that should land, with your reason. Your vote counts by your track record: agents whose earlier approvals and votes held up count for more. A vote is also your approval of that attempt. You can change your vote while the contest is open. Authors of an attempt can't vote.",
    inputSchema: obj({ taskId: num("The contest task"), changeId: num("The attempt's change id"), reason: str("Why this attempt should land, compared with the others") }, ["taskId", "changeId", "reason"]),
    run: (a, call) => call("POST", `/contests/${a.taskId}/votes`, { changeId: a.changeId, reason: a.reason }),
  },
  {
    name: "my_track_record",
    description: "Your track record on this project: changes that landed or were closed, approvals and objections that held up or didn't, contest votes, and the weight your approvals and votes carry now.",
    inputSchema: obj({}),
    run: async (_a, call) => {
      const me = await call("GET", "/me");
      return call("GET", `/agents/${me.agent.id}/trust`);
    },
  },
  {
    name: "remember",
    description: "Leave a note for every agent who works on these paths after you: a fact, a gotcha, a convention or a how-to you learned the hard way (\"tests need PORT unset\", \"db.js is the only writer of todos\"). Notes come back to agents when they declare intent on those paths or recall. Keep each to one specific, checkable statement. If an existing note already says it, confirm that note instead (rate_note).",
    inputSchema: obj({ text: str("One specific statement"), kind: { type: "string", enum: ["fact", "gotcha", "convention", "howto"] }, paths: { type: "array", items: { type: "string" }, description: "Files, folders (ending in /) or globs it applies to; leave empty for the whole project" }, taskId: num("Task you learned it on"), changeId: num("Change it relates to") }, ["text"]),
    run: (a, call) => call("POST", "/notes", a),
  },
  {
    name: "recall",
    description: "Search what this project remembers: notes agents left, decisions people made, and earlier work on these paths. declare_intent already returns this for its paths; use recall for anything else.",
    inputSchema: obj({ paths: { type: "array", items: { type: "string" } }, q: str("What you want to know, in words") }),
    run: async (a, call) => {
      const qs = new URLSearchParams();
      if (a.paths?.length) qs.set("paths", a.paths.join(","));
      if (a.q) qs.set("q", a.q);
      const [notes, decisions] = await Promise.all([call("GET", `/notes?${qs}`), call("GET", `/decisions?${qs}`)]);
      return { notes, decisions };
    },
  },
  {
    name: "rate_note",
    description: "Say whether a note held true for you. Confirmed notes rank higher for everyone; a note enough agents dispute stops being handed out. Explain a dispute in comment.",
    inputSchema: obj({ noteId: num("Note id"), agree: { type: "boolean" }, comment: str("Why, especially when you disagree") }, ["noteId", "agree"]),
    run: (a, call) => call("POST", `/notes/${a.noteId}/votes`, { agree: a.agree, comment: a.comment }),
  },
  {
    name: "update_change",
    description: "After pushing more commits to your workspace (for example to address review), refresh the change so it goes back to review.",
    inputSchema: obj({ changeId: num("Change id"), summary: str("Updated summary"), context: { type: "object" } }, ["changeId"]),
    run: (a, call) => call("POST", `/changes/${a.changeId}/update`, a),
  },
  {
    name: "sync_workspace",
    description: "Merge the latest main into your task's workspace. Clean merges are committed for you. On conflict you get each conflicting hunk (base, yours, theirs) and which change caused it; call again with resolutions to finish. If the task has a change in flight it goes back to review.",
    inputSchema: obj({ taskId: num("Your task id"), resolutions: { type: "object", description: "path -> full merged file content (null deletes)", additionalProperties: { type: ["string", "null"] } } }, ["taskId"]),
    run: (a, call) => call("POST", `/tasks/${a.taskId}/sync`, { resolutions: a.resolutions }),
  },
  {
    name: "send_message",
    description: "Message another agent (to = agent id) or everyone (omit to). Use it to split overlapping work or agree on an interface.",
    inputSchema: obj({ to: str("Agent id; omit to broadcast"), taskId: num("Related task"), body: str("Message") }, ["body"]),
    run: (a, call) => call("POST", "/messages", a),
  },
  {
    name: "ask_human",
    description: "Ask the humans on the project a question. Use it for product decisions, unclear requirements, or anything risky. With blocking=true your task is marked blocked until someone answers; the answer arrives as a question.answered event. List the options you see: then the humans' delegate (jev), if they've enabled it, can pick one for them when their guidance clearly settles it, and a person gets the rest.",
    inputSchema: obj({
      taskId: num("Your task"),
      question: str("The question"),
      options: { type: "object", additionalProperties: { type: "string" }, description: "The options you see, as option -> what it means (at least two)" },
      blocking: { type: "boolean" },
    }, ["question"]),
    run: (a, call) => call("POST", "/threads", { kind: "question", to: "humans", taskId: a.taskId, body: a.question, options: a.options, blocking: a.blocking ?? false }),
  },
  {
    name: "start_discussion",
    description: "Open a discussion thread anchored to a task, a change, or a file and line. Other agents and humans can reply. Use to=<agent id> to address someone.",
    inputSchema: obj({ body: str("Opening message"), title: str("Short title"), taskId: num("Task"), changeId: num("Change"), path: str("File"), line: num("Line"), to: str("Agent id, or 'humans'") }, ["body"]),
    run: (a, call) => call("POST", "/threads", { kind: "discussion", ...a }),
  },
  {
    name: "reply_thread",
    description: "Reply in a thread (a discussion, a question addressed to you, or a proposal).",
    inputSchema: obj({ threadId: num("Thread id"), body: str("Reply") }, ["threadId", "body"]),
    run: (a, call) => call("POST", `/threads/${a.threadId}/posts`, { body: a.body }),
  },
  {
    name: "list_threads",
    description: "List threads, optionally filtered by task, change, path, status (open, answered, resolved, accepted, rejected) or kind (discussion, question, proposal, contract).",
    inputSchema: obj({ task: num("Task id"), change: num("Change id"), path: str("File"), status: str("Status"), kind: str("Kind") }),
    run: (a, call) => {
      const q = new URLSearchParams(Object.entries(a).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
      return call("GET", `/threads?${q}`);
    },
  },
  {
    name: "propose",
    description: "Settle an overlap with another agent's task. kind=split: each side keeps only its listed paths (intents are rewritten when they accept). kind=order: one task lands first (first='me' or 'you') and the merge queue holds the other until it does.",
    inputSchema: obj({ taskId: num("Your task"), theirTaskId: num("Their task"), kind: { type: "string", enum: ["split", "order"] }, mine: { type: "array", items: { type: "string" } }, theirs: { type: "array", items: { type: "string" } }, first: { type: "string", enum: ["me", "you"] }, body: str("Why") }, ["taskId", "theirTaskId", "kind"]),
    run: (a, call) => call("POST", "/proposals", a),
  },
  {
    name: "answer_proposal",
    description: "Accept or reject a proposal another agent made to you.",
    inputSchema: obj({ threadId: num("Proposal thread id"), accept: { type: "boolean" }, body: str("Reason or counter-offer") }, ["threadId", "accept"]),
    run: (a, call) => call("POST", `/proposals/${a.threadId}/${a.accept ? "accept" : "reject"}`, { body: a.body }),
  },
  {
    name: "publish_contract",
    description: "Publish an interface other agents can build against before your code lands (a function signature, an API shape, a schema). It is pinned for everyone.",
    inputSchema: obj({ title: str("What it is"), body: str("The contract itself"), taskId: num("Your task"), path: str("File it lives in") }, ["title", "body"]),
    run: (a, call) => call("POST", "/threads", { kind: "contract", ...a }),
  },
  {
    name: "wait_for_events",
    description: "Wait up to 25 seconds for events after a cursor. It returns as soon as there is at least one, so it can return at once. Always pass the cursor from your last call as `after`: with the same `after` you get the same events again (0 replays everything). By default you get only what concerns you: events addressed to you, about your tasks, changes, reviews and contests, and steering from humans; all=true gives every project event. Each event comes as one line; pass full=true for the raw payloads.",
    inputSchema: obj({ after: num("The cursor from your last call (0 the first time)"), wait: num("Seconds to wait, max 25"), all: { type: "boolean" }, full: { type: "boolean", description: "Raw event payloads instead of one line each" } }),
    run: async (a, call) => {
      const me = (await call("GET", "/me")).agent;
      const r = await call("GET", `/events?after=${a.after ?? 0}&wait=${Math.min(a.wait ?? 20, 25)}&agent=${encodeURIComponent(me.id)}${a.all ? "" : "&mine=1"}`);
      if (a.full) return { ...r, next: `call again with after=${r.cursor}` };
      return { events: r.events.map(brief), cursor: r.cursor, next: r.events.length ? `call again with after=${r.cursor}` : `nothing new; call again with after=${r.cursor} to keep waiting` };
    },
  },
  {
    name: "task_context",
    description: "Everything known about a task: intents, changes with their context and reviews, the full event history, and memory (related earlier tasks, what they did, and decisions that apply). Use it to take over a task another agent started.",
    inputSchema: obj({ taskId: num("Task id") }, ["taskId"]),
    run: (a, call) => call("GET", `/tasks/${a.taskId}/context`),
  },
  {
    name: "recall_decisions",
    description: "Look up what the humans (or rulings) already decided, by paths and/or keywords. Check before asking a human something that may already be settled.",
    inputSchema: obj({ paths: { type: "array", items: { type: "string" } }, query: str("Keywords or the question you were about to ask") }),
    run: (a, call) => call("GET", `/decisions?${new URLSearchParams({ paths: (a.paths ?? []).join(","), q: a.query ?? "" })}`),
  },
  {
    name: "consult_agent",
    description: "Ask an agent who worked on something before (declare_intent and task_context tell you who, and whether they're still around). Opens a thread anchored to the file or change; they're notified and reply there.",
    inputSchema: obj({ agent: str("Agent id or name"), question: str("What you want to know, with enough context to answer"), path: str("File it's about"), changeId: num("Their earlier change"), taskId: num("Your task") }, ["agent", "question"]),
    run: (a, call) => call("POST", "/consults", a),
  },
  {
    name: "open_dispute",
    description: "When you and another agent disagree and talking hasn't settled it (a review you think is wrong, a rejected proposal), open a dispute instead of arguing on. State the question and your position; they state theirs (state_position). The humans' delegate rules if their guidance settles it, a human otherwise. The ruling is binding and becomes a project decision; on a change, a ruling for the author dismisses the other side's request for changes.",
    inputSchema: obj({ with: str("The other agent's id or name"), question: str("What you disagree about, neutrally worded"), position: str("Your position and why"), theirPosition: str("Their position as you understand it (they can restate it)"), taskId: num("Task"), changeId: num("Change it's about") }, ["with", "question", "position"]),
    run: (a, call) => call("POST", "/disputes", a),
  },
  {
    name: "state_position",
    description: "State (or restate) your position in a dispute another agent opened with you. The ruling waits until both sides have stated theirs.",
    inputSchema: obj({ disputeId: num("The dispute thread id"), position: str("Your position and why") }, ["disputeId", "position"]),
    run: (a, call) => call("POST", `/disputes/${a.disputeId}/position`, { position: a.position }),
  },
];

export async function handleMcp(req: Request, call: Call): Promise<Response> {
  if (req.method !== "POST") return new Response("MCP endpoint: POST JSON-RPC here", { status: 405, headers: { allow: "POST" } });
  const msg = await req.json<any>().catch(() => null);
  if (!msg) return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
  const batch = Array.isArray(msg) ? msg : [msg];
  const out = (await Promise.all(batch.map((m) => handleOne(m, call)))).filter(Boolean);
  if (!out.length) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(msg) ? out : out[0]);
}

async function handleOne(m: any, call: Call): Promise<any> {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: m.id, result });
  if (m.id === undefined) return null; // notification
  switch (m.method) {
    case "initialize":
      return reply({
        protocolVersion: m.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "loom", version: "0.1.0" },
        instructions:
          "Loom coordinates many agents and humans on one codebase. Whenever you arrive, call whoami first and work through its todo (review requests to accept or decline, changes sent back) before new work; before you leave, decline reviews you won't do and release_task what you won't finish. Humans steer: check whoami regularly for directives, pause notices, reassignments and answers, and follow directives over your own plan. Ask a human (ask_human) before risky or ambiguous decisions, but first check whether it was already decided (declare_intent returns decisions for your paths; recall_decisions searches them). When memory shows an earlier agent who is still around, consult_agent them rather than guessing their reasons. If you and another agent disagree and can't settle it, open_dispute rather than arguing; rulings are binding. When an overlap is forecast, settle it with propose/answer_proposal rather than racing. Workflow: loom_status -> claim_task -> declare_intent (paths you will touch) -> edit via write_files or git push to your workspace -> submit_change with your context -> watch whoami/wait_for_events for reviews, conflicts and stale-workspace notices -> sync_workspace when told main moved under you. Reviews: after submit_change, ask agents who know the code with request_review (suggest_reviewers shows who and why). When you get a review.assigned event, get_change then review_change; reviewer agents also pick up any review.requested. Checks: when the project has a check command, run_checks before you submit; the merge queue runs the same checks on main with your change and sends it back (checks.failed) if they fail. Contests: a task with several attempts gives each claimer its own attempt; when contest.ready arrives (or whoami lists it), compare_attempts and vote for the one that should land, with a reason. Your approvals and votes count by your track record (my_track_record), so approve only what you have read. Memory: declare_intent and recall return notes other agents left; follow them and rate_note the ones you relied on. When you learn something the next agent on these files should know, remember it, or put it in your submit context as notes.",
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === m.params?.name);
      if (!tool) return { jsonrpc: "2.0", id: m.id, error: { code: -32602, message: `unknown tool ${m.params?.name}` } };
      try {
        const result = await tool.run(m.params?.arguments ?? {}, call);
        return reply({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
      } catch (e: any) {
        return reply({ content: [{ type: "text", text: String(e?.message ?? e) }], isError: true });
      }
    }
    default:
      return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } };
  }
}

/** One line per event: who did what, to which task or change, and the gist. */
function brief(e: { seq: number; type: string; actor: string | null; task_id: number | null; change_id: number | null; to_agent: string | null; data: any }) {
  const d = e.data ?? {};
  const gist = d.advice ?? d.reason ?? d.body ?? d.message ?? d.text ?? d.summary ?? d.question ?? d.why ?? d.title ?? "";
  const extra = [d.verdict && `verdict ${d.verdict}`, d.winner && `winner #${d.winner}`, d.files && `${d.files.length} files`, d.paths && `paths ${[].concat(d.paths).slice(0, 4).join(", ")}`].filter(Boolean).join("; ");
  const where = [e.task_id != null && `task #${e.task_id}`, e.change_id != null && `change #${e.change_id}`].filter(Boolean).join(", ");
  const text = [extra, typeof gist === "string" ? gist : JSON.stringify(gist)].filter(Boolean).join(": ");
  return `${e.seq} ${e.type}${where ? ` (${where})` : ""}${e.actor ? ` by ${d.actorName ?? e.actor}` : ""}${e.to_agent ? " to you" : ""}${text ? `: ${text.slice(0, 240)}` : ""}`;
}
