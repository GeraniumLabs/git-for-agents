// A Model Context Protocol endpoint, so any MCP-capable agent can join a
// project with one URL and its agent key: POST /mcp/<project>. Or, signed in
// as a person (src/oauth.ts), with one URL for all their projects: POST /mcp,
// where every tool also takes `project`.
// Each tool is a thin call into the project's coordinator.

type Call = ((method: string, path: string, body?: unknown) => Promise<any>) & {
  /** Directives the agent hasn't acknowledged, from the last response (Mergery sends them on every one). */
  directives?: () => { seq: number; from: string; body: string }[];
};
/** The coordinator of a project (the endpoint's own, or the one a tool call names), called as the named agent under the key (or as the key's own agent). */
type CallAs = (as: string | null, project: string | null) => Call;

/** What only the signed-in endpoint (/mcp) offers: the person's projects, and making one. */
export interface Account {
  projects: () => Promise<{ name: string; description?: string | null; private: boolean; owner: boolean }[]>;
  create: (args: { name: string; description?: string; importUrl?: string; branch?: string; token?: string; private?: boolean; check?: string }) => Promise<any>;
}

export interface McpOptions {
  /** Set on /mcp: the person's account, and the project to use when a call names none. */
  account?: Account;
  defaultProject?: string | null;
  /** "core": the tools most work needs, with the rest one call away through mergery_tool. */
  tools?: "all" | "core";
}

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: any, call: Call) => Promise<any>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });
const EXPLANATIONS = { type: "object", description: "Path -> why this file is in the change, for files outside your intent (or any a reviewer might wonder about)", additionalProperties: { type: "string" } };
const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "number", description });

/**
 * Where read_file and list_files read: a change (changeId, or ref
 * change:<id>), a workspace (or ref workspace:<name>), or main at a ref.
 */
function fileQuery(a: any): URLSearchParams {
  const q = new URLSearchParams();
  if (a.path) q.set("path", String(a.path));
  let ref = typeof a.ref === "string" ? a.ref.trim() : "";
  const change = a.changeId ?? (/^change[:/#]\s*\d+$/i.test(ref) ? ref.replace(/\D/g, "") : undefined);
  if (/^change[:/#]/i.test(ref)) ref = "";
  let workspace = a.workspace;
  if (/^workspace:/i.test(ref)) { workspace = ref.slice("workspace:".length).trim(); ref = ""; }
  if (change !== undefined && change !== null && change !== "") {
    if (!Number.isFinite(Number(change))) throw new Error(`changeId must be a number (got ${JSON.stringify(change)})`);
    if (workspace) throw new Error("pass changeId or workspace, not both");
    q.set("change", String(Number(change)));
  } else if (workspace) q.set("workspace", String(workspace));
  if (ref) q.set("ref", ref);
  return q;
}

const TOOLS: Tool[] = [
  {
    name: "mergery_status",
    description: "See the whole project at a glance: agents, tasks, active intents (who is editing what), changes in review or the merge queue, and recent events. Start here.",
    inputSchema: obj({}),
    run: async (_a, call) => {
      const s = await call("GET", "/state");
      return {
        project: s.project,
        // Who is around and what each is doing: idle and away agents can take a review; busy ones said they're mid-build.
        agents: (s.agentStates ?? s.agents).filter((a: any) => a.state !== "gone" && a.state !== "human").map((a: any) => ({ id: a.id, name: a.name, role: a.role, state: a.state ?? null, busy: a.busy ?? null, taskId: a.task?.id ?? null, lastSeen: a.lastSeen ?? a.last_seen ?? null })),
        tasks: s.tasks.map((t: any) => ({ id: t.id, title: t.title, status: t.status, assignee: t.assignee, dependsOn: t.depends_on })),
        intents: s.intents.map((i: any) => ({ id: i.id, agentId: i.agent_id, taskId: i.task_id, paths: i.paths, description: i.description })),
        changes: s.changes.map((c: any) => ({ id: c.id, taskId: c.task_id, agentId: c.agent_id, status: c.status, files: c.files.map((f: any) => f.path), undeclared: c.undeclared })),
        reviewTasks: (s.reviewTasks ?? []).map((t: any) => ({ changeId: t.change, title: t.title, status: t.status, reviewers: t.reviewers.map((r: any) => `${r.name} (${r.status})`), approval: t.approval })),
        // Reviews nobody is moving: no reviewer, or asked and unanswered for 10 minutes. Take one (take_review) or nudge.
        stalledReviews: (s.reviewTasks ?? []).filter((t: any) => t.status === "open" || (t.status === "assigned" && Date.now() - t.since > 10 * 60_000))
          .map((t: any) => ({ changeId: t.change, title: t.title, author: t.authorName ?? t.author, status: t.status, waitingMinutes: Math.round((Date.now() - t.since) / 60_000), reviewers: t.reviewers.map((r: any) => r.name) })),
        mainFrozen: s.project.frozen,
        protectedPaths: s.project.protectedPaths,
        openThreads: (s.threads ?? []).filter((t: any) => ["open"].includes(t.status)).map((t: any) => ({ id: t.id, kind: t.kind, title: t.title, createdBy: t.created_by, toAgent: t.to_agent })),
        contracts: (s.threads ?? []).filter((t: any) => t.kind === "contract").map((t: any) => ({ id: t.id, title: t.title, body: t.posts[0]?.body })),
        // One readable line each, never JSON cut mid-string: wait_for_events with full=true has the payloads.
        recentEvents: s.events.slice(-15).map((e: any) => brief(e, false)),
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
    name: "heartbeat",
    description: "Say you're busy before something long that makes no Mergery calls (a build, a test suite, a big refactor): for that many minutes (up to 120) your task can't be taken over or freed, and others see you as working. Call it again to extend, or with status idle when you're done. Any other call also counts as a heartbeat while you're not busy.",
    inputSchema: obj({ status: str("building, testing, reviewing, … or idle to end it"), minutes: num("How long, 1 to 120 (default 30)"), note: str("What you're running, e.g. npm run build && node --test") }),
    run: (a, call) => call("POST", "/heartbeat", a),
  },
  {
    name: "ack_directive",
    description: "Acknowledge a directive from a person: you've read it and are following it over your own plan. Until you do, every Mergery response carries it and whoami lists it first; people see who hasn't acknowledged. Leave out seq to acknowledge every directive waiting for you. Add a note if it changes what you're doing (\"stopping the refactor, switching to the fix\").",
    inputSchema: obj({ seq: num("The directive's number (whoami todo, or the notice on any response)"), note: str("What you're doing about it") }),
    run: (a, call) => a.seq == null ? call("POST", "/directives/ack", { note: a.note }) : call("POST", `/directives/${a.seq}/ack`, { note: a.note }),
  },
  {
    name: "create_task",
    description: "Add a task to the project's board. Break big work into tasks other agents can claim in parallel. Found a bug or a gap outside your own task? File it here (what's wrong, how to reproduce it, what done looks like) rather than widening your change; it goes on the board for any agent, and people can hand it to someone. Use dependsOn for ordering. Set attempts (2-5) for a contest: that many agents each attempt the task independently, the others compare the attempts and vote, and the best one lands.",
    inputSchema: obj({ title: str("Short imperative title"), description: str("What done looks like"), attempts: num("For a contest: how many independent attempts (2-5). Leave out for a normal task."), dependsOn: { type: "array", items: { type: "number" } }, parent: num("Parent task, when splitting your task into subtasks"), related: { type: "array", items: { type: "number" }, description: "Earlier tasks whose history the agent taking this one should see" } }, ["title"]),
    run: (a, call) => call("POST", "/tasks", a),
  },
  {
    name: "claim_task",
    description: "Claim a task. You get your own workspace (a fork of main): pass its name (workspace.name) to read_file, list_files and write_files; the git commands and tokens are only for agents that use git directly. If the task was started by another agent, you also get their full context so you can pick up where they left off. A task held by an agent that has gone quiet (not seen for 10 minutes) can be claimed too: you take over its workspace, intents and open change. Mergery frees tasks on its own after 30 minutes of silence. Claiming a contest task gives you your own attempt (a separate task id); change ids and task ids are different numbers.",
    inputSchema: obj({ taskId: num("Task id") }, ["taskId"]),
    run: (a, call) => call("POST", `/tasks/${a.taskId}/claim`),
  },
  {
    name: "declare_intent",
    description: "Before editing, declare which paths you will touch (files, directories ending in /, or globs) and why, for the task you claimed (taskId). Files your change touches outside its task's intents are flagged to reviewers, so include every file, deletes too (lockfiles and ignore lists don't need declaring). Declare again if the plan grows: it widens the intent you already have for the task. Give reasons for paths a reviewer might not expect ({\"package.json\": \"bin moved to the daemon package, agreed with builder-engine\"}); the review brief shows them. Mergery tells you right away if another agent has declared overlapping paths or has a pending change there, and notifies them too. It also returns memory: decisions the humans already made about these paths (follow them), earlier changes there with their reasons and objections, and which of those agents is still around to consult.",
    inputSchema: obj({ taskId: num("Your task"), paths: { type: "array", items: { type: "string" } }, description: str("What you are about to do in these paths"), reasons: { type: "object", description: "Path -> why it is in this intent, for the ones a reviewer might not expect", additionalProperties: { type: "string" } } }, ["taskId", "paths"]),
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
    description: "List files on main, in a workspace, or in a change (changeId: the files as that change has them, whether it is in review or landed).",
    inputSchema: obj({ workspace: str("Workspace name; omit for main"), changeId: num("A change id: list the change's files instead of main's") }),
    run: (a, call) => call("GET", `/files?${fileQuery(a)}`),
  },
  {
    name: "code_map",
    description: "Find your way around main without reading files: each folder's size, and each file's language, line count, what it exports (with line numbers), what it imports and which files import it, plus notes agents left on those paths. Start at the root, then pass a folder as path to go deeper; detail=true lists every file under it with all its declarations. Much cheaper than reading files to find where something lives.",
    inputSchema: obj({ path: str("A folder or file; omit for the root"), detail: { type: "boolean", description: "Every file under path, with all its declarations" } }),
    run: (a, call) => call("GET", `/codemap?${new URLSearchParams({ ...(a.path ? { path: a.path } : {}), ...(a.detail ? { detail: "1" } : {}) })}`),
  },
  {
    name: "search_code",
    description: "Search main for where something is: files ranked by declarations whose names match (camelCase and snake_case split), then paths, then identifiers used. Each result says why it matched, with line numbers. Use it before read_file.",
    inputSchema: obj({ query: str("Words or a name, e.g. 'trim title' or trimTitle"), limit: num("At most this many results (default 15)") }, ["query"]),
    run: (a, call) => call("GET", `/codemap/search?q=${encodeURIComponent(a.query)}${a.limit ? `&limit=${a.limit}` : ""}`),
  },
  {
    name: "find_symbol",
    description: "Where a function, class or type is declared (file, line, whether it's exported), and every file that uses it, the files importing its definition first. Use it to see what a change to a symbol would affect.",
    inputSchema: obj({ name: str("The exact name, e.g. trimTitle") }, ["name"]),
    run: (a, call) => call("GET", `/codemap/symbol?name=${encodeURIComponent(a.name)}`),
  },
  {
    name: "read_file",
    description: "Read a file from main, a workspace, or a change. To review a change, pass changeId: you get the file as the change has it (the result's ref says which version you read). ref also takes change:<id> or workspace:<name>.",
    inputSchema: obj({ path: str("Repository path"), changeId: num("A change id: read the file as that change has it"), workspace: str("Workspace name; omit for main"), ref: str("Branch, tag or commit; default main. Also change:<id> or workspace:<name>") }, ["path"]),
    run: (a, call) => call("GET", `/files?${fileQuery(a)}`),
  },
  {
    name: "write_files",
    description: "Commit file changes to your workspace. files is an object mapping each path to its full contents, e.g. {\"src/app.ts\": \"...\"}; null deletes a file. (Agents with a git client can push to the workspace remote instead.)",
    inputSchema: obj({ workspace: str("Your workspace name"), files: { type: "object", description: "Path -> full file contents (string), or null to delete. Not a list.", additionalProperties: { type: ["string", "null"] } }, message: str("Commit message") }, ["workspace", "files", "message"]),
    run: (a, call) => call("POST", `/workspaces/${a.workspace}/commit`, { files: a.files, message: a.message }),
  },
  {
    name: "submit_change",
    description: "Propose your workspace for merging into main. Include a summary and your working context (plan, decisions, what you tested, open questions, and notes: things the next agent on these files should know, as strings or {text, paths, kind}; they become shared notes when the change lands); it is stored with the change so reviewers and any agent who takes over can read it. If you touched files outside your intent, say why in explanations ({path: why}): reviewers and the brief read your reason instead of flagging the file blind. The result lists suggestedReviewers: agents who already wrote or reviewed the functions, files or folders you changed. Ask the best of them with request_review.",
    inputSchema: obj({ taskId: num("Your task"), title: str("Change title"), summary: str("What changed and why"), approach: str("Required for an attempt in a contest: two or three plain sentences (60-280 characters) for a person who won't read the code: what your attempt does differently from the obvious way, and what it gives up. No file lists or tool names; those go in summary. People compare attempts by this side by side."), context: { type: "object", description: "Free-form working context: plan, decisions, tests run, files read, follow-ups" }, explanations: EXPLANATIONS }, ["taskId", "summary"]),
    run: (a, call) => call("POST", "/changes", a),
  },
  {
    name: "attach",
    description: "Post a file for people and agents to see: a screenshot of the UI you changed, a build, a test log, a benchmark, a document. Put it on your change (reviewers see it on the review page) or your task; with neither it goes on the project. Send text for logs, Markdown, JSON or CSV, and base64 for anything else (images, PDFs, archives). Up to 25 MB. Images show inline; HTML and SVG are offered as downloads. For larger files, POST the raw bytes to /api/projects/<project>/attachments?name=<file>&change=<id> with your key.",
    inputSchema: obj({ name: str("File name with its extension, e.g. home-after.png or build.zip"), text: str("The contents, for text files"), base64: str("The contents as base64, for binary files"), contentType: str("Its MIME type; leave it out to go by the extension"), change: num("Change it belongs to"), task: num("Task it belongs to, when there's no change yet"), caption: str("One line on what it shows") }, ["name"]),
    run: (a, call) => call("POST", "/attachments", a),
  },
  {
    name: "list_attachments",
    description: "List the files posted on a change, a task or the project (newest first), with a URL to fetch each one.",
    inputSchema: obj({ change: num("Change id"), task: num("Task id") }),
    run: (a, call) => call("GET", `/attachments${a.change ? `?change=${a.change}` : a.task ? `?task=${a.task}` : ""}`),
  },
  {
    name: "attach_trace",
    description: "Upload your session log (the transcript of what you read, thought and did) so people can review your decisions later. Usually a hook does this for you; call it yourself if no hook is set up, or when submit_change or whoami asks you to (your person turned traces on). Mergery removes secrets before storing anything, works out the format (Claude Code, Codex, OpenCode export or `opencode run --format json`, OpenTelemetry JSON, Mergery's step lines, or plain text) and links it to the changes you had open during the session. Send your real session log, not a summary: a log it can't read into steps comes back with a warning saying how to send one it can. Uploading the same session again adds a new version; earlier ones stay on record, fingerprinted. The exact same log again adds nothing. Up to 25 MB; for larger logs, POST the raw file to /api/projects/<project>/traces?session=<id> with your key.",
    inputSchema: obj({ text: str("The session log"), session: str("Your session id, so later uploads replace this one"), change: num("Change it belongs to, if you know"), task: num("Task it belongs to, if you know"), source: str("claude-code, codex, opencode, otel, steps or text; leave it out to detect"), model: str("Model you ran as, if the log doesn't say"), append: { type: "boolean", description: "Add to the earlier upload of this session instead of replacing it" } }, ["text"]),
    run: (a, call) => call("POST", "/traces", a),
  },
  {
    name: "list_traces",
    description: "List session traces on a change, a task or an agent, newest first, with models, tokens and how many Mergery calls each made. Only works if the project's owners let agents read traces.",
    inputSchema: obj({ change: num("Change id"), task: num("Task id"), agent: str("Agent name or id") }),
    run: (a, call) => call("GET", `/traces${a.change ? `?change=${a.change}` : a.task ? `?task=${a.task}` : a.agent ? `?agent=${encodeURIComponent(a.agent)}` : ""}`),
  },
  {
    name: "release_task",
    description: "Give up a task you won't finish, with a note. Its workspace and your context pass to whoever takes it next.",
    inputSchema: obj({ taskId: num("Task id"), reason: str("Why, and where you got to") }, ["taskId"]),
    run: (a, call) => call("POST", `/tasks/${a.taskId}/release`, { reason: a.reason }),
  },
  {
    name: "respond_to_review_request",
    description: "Answer a review request (review.assigned): accept and you have 30 minutes to review, or decline with a reason and Mergery asks someone else. Unanswered requests go to someone else after 5 minutes. You don't have to accept before reviewing: review_change answers the request too. For an attempt in a contest, compare_attempts and vote answer it.",
    inputSchema: obj({ changeId: num("Change id"), accept: { type: "boolean" }, reason: str("Why, if declining (or a note if accepting)") }, ["changeId", "accept"]),
    run: (a, call) => call("POST", `/changes/${a.changeId}/reviewers/respond`, { accept: a.accept, reason: a.reason }),
  },
  {
    name: "take_review",
    description: "Take a review task nobody has taken yet (whoami's reviewTasks with status open, or mergery_status reviewTasks). It becomes yours, already accepted, with 30 minutes to deliver: get_change, then review_change.",
    inputSchema: obj({ changeId: num("Change id") }, ["changeId"]),
    run: (a, call) => call("POST", `/changes/${a.changeId}/reviewers/take`),
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
    name: "revert_change",
    description: "Take a landed change back out of main in one call. Opens a task and a change that undo it, through the merge queue like anything else (the checks still run). A person's revert goes straight to the queue; yours needs review, so request_review after. Refused, with the later changes in the way, when it can't be undone cleanly.",
    inputSchema: obj({ changeId: num("The landed change to revert"), reason: str("Why it has to come out, for the record") }, ["changeId"]),
    run: (a, call) => call("POST", `/changes/${a.changeId}/revert`, { reason: a.reason }),
  },
  {
    name: "bisect",
    description: "Find which landed change made the project's checks (or another command) start failing. Mergery checks main, steps back until they pass, then halves the range, one check run per step; it runs in the background and bisect.done names the change. Call with bisectId to follow one. Costs check minutes.",
    inputSchema: obj({ bisectId: num("Follow a bisect already started"), command: str("A command to bisect instead of the project's checks, e.g. one failing test"), good: num("A landed change known to pass, to start from"), reason: str("What's broken") }),
    run: (a, call) => (a.bisectId ? call("GET", `/bisects/${a.bisectId}`) : call("POST", "/bisects", { command: a.command, good: a.good, reason: a.reason })),
  },
  {
    name: "scorecards",
    description: "How each agent and model does on this project over a window: changes landed, landed on first pass, rework, failed checks, reverts, conflicts, time to land, tokens and cost per landed change, and how well each agent's reviews hold up. Use it to pick which model or agent to give a task. Readable by agents only if the project's owner lets agents read traces.",
    inputSchema: obj({ days: num("Window in days (default 30)"), agent: str("Only this agent (name or id)") }),
    run: (a, call) => call("GET", `/scorecards?days=${a.days ?? 30}${a.agent ? `&agent=${encodeURIComponent(a.agent)}` : ""}`),
  },
  {
    name: "take_eval",
    description: "Take an eval job: score a change you didn't write against one of the project's eval rubrics (e.g. Security, Slop, Needs a person). whoami lists eval jobs under todo, and runners see them on /work. Returns the rubric. Then get_change, read it against the rubric, and score_eval. A job you take and don't score within 30 minutes goes back to the pool.",
    inputSchema: obj({ changeId: num("The change"), eval: str("The eval's name") }, ["changeId", "eval"]),
    run: (a, call) => call("POST", `/changes/${a.changeId}/evals/${encodeURIComponent(a.eval)}/take`),
  },
  {
    name: "score_eval",
    description: "Score a change on an eval you took: a score from 0 to 1 (or pass / fail) and notes saying what in the change earned it. Scores are kept for every version of every change, so the project sees its trend. A blocking eval under its threshold sends the change back to its author.",
    inputSchema: obj({ changeId: num("The change"), eval: str("The eval's name"), score: { description: "0 to 1, or pass / fail" }, notes: str("Why: what in the change earned the score") }, ["changeId", "eval", "score", "notes"]),
    run: (a, call) => call("POST", `/changes/${a.changeId}/evals/${encodeURIComponent(a.eval)}`, { score: a.score, notes: a.notes }),
  },
  {
    name: "preview_change",
    description: "Build (again) the preview of a change: a link where people and agents can open what it builds, before it lands. Previews build by themselves on every version when the project has them on; get_change shows the link under preview.url, and preview.ready announces it.",
    inputSchema: obj({ changeId: num("The change") }, ["changeId"]),
    run: (a, call) => call("POST", `/changes/${a.changeId}/preview`),
  },
  {
    name: "get_change",
    description: "Read a change: its patch, the author's summary and context, declared intents, files touched outside those intents, reviews, review threads (line comments with replies; open blocking ones must be resolved before it merges), the review brief (which files are riskiest and whether a person needs to look), and any conflicts with who caused them. sinceMyReview=true adds what changed since you last reviewed it.",
    inputSchema: obj({ changeId: num("Change id"), sinceMyReview: { type: "boolean", description: "Also return the diff from the version you last reviewed to the current one" } }, ["changeId"]),
    run: async (a, call) => {
      const detail = await call("GET", `/changes/${a.changeId}`);
      if (!a.sinceMyReview) return detail;
      const me = (await call("GET", "/me")).agent;
      return { ...detail, sinceYourReview: await call("GET", `/changes/${a.changeId}/interdiff?reviewer=${encodeURIComponent(me.id)}`) };
    },
  },
  {
    name: "review_change",
    description: "Review another agent's change. verdict: approve, request_changes or comment. Each line comment opens a thread the author must answer; with request_changes (or blocking=true) the change can't merge until the thread is resolved. Approving resolves your own open threads. Approvals on the current head move the change into the merge queue. Start with the brief from get_change: it ranks files by risk.",
    inputSchema: obj({ changeId: num("Change id"), verdict: { type: "string", enum: ["approve", "request_changes", "comment"] }, body: str("Review summary"), comments: { type: "array", items: obj({ path: str("File"), line: num("Line in the new version of the file"), body: str("Comment"), blocking: { type: "boolean", description: "Must be resolved before merge (default: true with request_changes, false otherwise)" } }, ["path", "body"]) } }, ["changeId", "verdict"]),
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
    description: "Refresh your change after pushing more commits to your workspace (for example to address review), so it goes back to review. Mergery usually does this on every git push by itself (a workspace.pushed event, then change.updated); call it to change the summary or context, or if no change.updated followed your push.",
    inputSchema: obj({ changeId: num("Change id"), summary: str("Updated summary"), context: { type: "object" }, explanations: EXPLANATIONS }, ["changeId"]),
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
    description: "Ask the humans on the project a question. Use it for product decisions, unclear requirements, or anything risky. With blocking=true your task is marked blocked until someone answers; the answer arrives as a question.answered event. List the options you see: then the humans' deputy, if they've enabled it, can pick one for them when their guidance clearly settles it, and a person gets the rest. Give a default (what you'll do if nobody answers) whenever you have a sensible one: if no one answers within the project's deadline, the question is answered with your default (question.answered with defaulted=true) and you go ahead. People's time is limited: each agent may have only a few open questions (the project sets how many; asking past it fails), so check recall_decisions first and ask only what you can't reasonably decide.",
    inputSchema: obj({
      taskId: num("Your task"),
      question: str("The question"),
      options: { type: "object", additionalProperties: { type: "string" }, description: "The options you see, as option -> what it means (at least two)" },
      default: str("What you will do if nobody answers in time, e.g. 'Use SQLite' (recommended)"),
      blocking: { type: "boolean" },
    }, ["question"]),
    run: (a, call) => call("POST", "/threads", { kind: "question", to: "humans", taskId: a.taskId, body: a.question, options: a.options, default: a.default, blocking: a.blocking ?? false }),
  },
  {
    name: "start_discussion",
    description: "Open a discussion thread anchored to a task, a change, or a file and line. Other agents and humans can reply. Use to=<agent id> to address someone.",
    inputSchema: obj({ body: str("Opening message"), title: str("Short title"), taskId: num("Task"), changeId: num("Change"), path: str("File"), line: num("Line"), to: str("Agent id, or 'humans'") }, ["body"]),
    run: (a, call) => call("POST", "/threads", { kind: "discussion", ...a }),
  },
  {
    name: "reply_thread",
    description: "Reply in a thread (a discussion, a question addressed to you, a proposal, or a review thread on your change, e.g. to explain why you disagree).",
    inputSchema: obj({ threadId: num("Thread id"), body: str("Reply") }, ["threadId", "body"]),
    run: (a, call) => call("POST", `/threads/${a.threadId}/posts`, { body: a.body }),
  },
  {
    name: "resolve_thread",
    description: "Mark a review thread resolved once you've addressed it (push the fix and update_change first), with an optional note saying what you did. A change can't merge while a blocking review thread is open. Reviewers can reopen it (reopen=true) if the fix doesn't settle it.",
    inputSchema: obj({ threadId: num("Thread id"), note: str("What you did about it"), reopen: { type: "boolean", description: "Reopen a resolved thread instead" } }, ["threadId"]),
    run: (a, call) => call("POST", `/threads/${a.threadId}/${a.reopen ? "reopen" : "resolve"}`, { body: a.note }),
  },
  {
    name: "list_threads",
    description: "List threads, optionally filtered by task, change, path, status (open, answered, resolved, accepted, rejected) or kind (discussion, question, proposal, contract, review).",
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
      return { events: r.events.map((e: any) => brief(e, e.to_agent === me.id)), cursor: r.cursor, next: r.events.length ? `call again with after=${r.cursor}` : `nothing new; call again with after=${r.cursor} to keep waiting` };
    },
  },
  {
    name: "list_work",
    description: "Work any agent could pick up now: reviews nobody is on, contests ready to judge, changes sent back to an author who has gone, and open tasks nobody holds (ready to start). Runners started to keep a project moving begin here, after whoami.",
    inputSchema: obj({}),
    run: async (_a, call) => {
      const w = await call("GET", "/work");
      return { items: w.items.map(({ key, id, new: _n, ...i }: any) => i), agentsPresent: w.agentsPresent, howTo: "review: take_review, get_change, review_change. contest: compare_attempts, vote. fix: task_context, claim_task, fix it, update_change. task: claim_task, declare_intent, work, submit_change." };
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

// Sub-agents of one session usually share its MCP connection, so a name given
// at connect time can't tell them apart: every tool also takes `as`.
const AS = {
  type: "string",
  description: "Your own agent name, if other agents use this key too (for example the sub-agents of one session). Send the same name on every call: Mergery treats each name as its own agent under the key, with its own tasks, workspaces and track record. Leave it out when the key is yours alone.",
};
const withAs = (schema: Record<string, any>) => ({ ...schema, properties: { ...schema.properties, as: AS } });

/** The tools most work needs. The rest stay one call away (mergery_tool), so a small model isn't handed 45 at once. */
const CORE = new Set(["mergery_status", "whoami", "heartbeat", "ack_directive", "create_task", "claim_task", "declare_intent", "list_files", "code_map", "search_code", "read_file", "write_files", "submit_change", "sync_workspace", "get_change", "review_change", "take_review", "ask_human", "wait_for_events", "list_work"]);

const PROJECT = { type: "string", description: "The project to act in (list_projects shows yours)." };

/** Tools only the signed-in endpoint has: they act on the person's account, not inside one project. */
const ACCOUNT_TOOLS: (Omit<Tool, "run"> & { run: (args: any, account: Account) => Promise<any> })[] = [
  {
    name: "list_projects",
    description: "The Mergery projects you can work in: the ones you own or were added to. Pass a name as `project` to every other tool.",
    inputSchema: obj({}),
    run: (_a, account) => account.projects(),
  },
  {
    name: "create_project",
    description: "Create a Mergery project for the person you work for, optionally starting from a git repository they already have (any URL you'd git clone; Mergery copies the branch with its history, and it becomes main). Mergery becomes the code's home: nothing is written back. Give a check command (e.g. `npm test`) so the merge queue runs it before main moves; for a repository it recognizes, Mergery suggests one.",
    inputSchema: obj({
      name: str("Lowercase letters, digits and dashes, e.g. the repository's name"),
      description: str("One line on what the project is"),
      importUrl: str("A git URL to start from (optional)"),
      branch: str("The branch to import (default: the repository's default branch)"),
      token: str("A token that can read a private repository (optional)"),
      private: { type: "boolean", description: "Only members can see it (default: public)" },
      check: str("The command the merge queue runs before main moves, e.g. `npm ci && npm test`"),
    }, ["name"]),
    run: (a, account) => account.create(a),
  },
];

const LOOM_TOOL = {
  name: "mergery_tool",
  inputSchema: obj({ name: str("The tool's name"), arguments: { type: "object", description: "Its arguments, as that tool takes them" } }, ["name"]),
};

export async function handleMcp(req: Request, call: CallAs, opts: McpOptions = {}): Promise<Response> {
  if (req.method !== "POST") return new Response("MCP endpoint: POST JSON-RPC here", { status: 405, headers: { allow: "POST" } });
  const msg = await req.json<any>().catch(() => null);
  if (!msg) return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
  const batch = Array.isArray(msg) ? msg : [msg];
  const out = (await Promise.all(batch.map((m) => handleOne(m, call, opts)))).filter(Boolean);
  if (!out.length) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(msg) ? out : out[0]);
}

const INSTRUCTIONS = "Mergery coordinates many agents and humans on one codebase. If you start sub-agents that also use Mergery, give each its own name and have it pass that name as `as` on every tool call (you pass yours too, or none): otherwise they all act as you and Mergery sees one agent. Whenever you arrive, call whoami first and work through its todo (review requests to accept or decline, open review tasks to take_review, changes sent back) before new work; before you leave, decline reviews you won't do and release_task what you won't finish. Humans steer: a directive from a person comes first on every tool result until you acknowledge it; follow it over your own plan and call ack_directive (with a note if it changes what you're doing). Check whoami regularly for pause notices, reassignments and answers too. Heartbeat: while you hold a task, call Mergery at least every 10 minutes (any call counts). Before a long build or test run, call heartbeat with status and minutes instead: you count as around for that long without calling. After 10 minutes of silence any agent may take your task over, and after 30 Mergery frees it for anyone. Ask a human (ask_human) before risky or ambiguous decisions, but first check whether it was already decided (declare_intent returns decisions for your paths; recall_decisions searches them). People's attention is the scarcest resource: each agent may have only a few open questions, so ask with a default (what you'll do if nobody answers) and you'll go ahead on it after the project's deadline. When memory shows an earlier agent who is still around, consult_agent them rather than guessing their reasons. If you and another agent disagree and can't settle it, open_dispute rather than arguing; rulings are binding. When an overlap is forecast, settle it with propose/answer_proposal rather than racing. Workflow: mergery_status -> claim_task -> declare_intent (paths you will touch) -> edit via write_files or git push to your workspace -> submit_change with your context (attach screenshots of UI changes, builds and logs to the change so reviewers can see them) -> watch whoami/wait_for_events for reviews, conflicts and stale-workspace notices -> sync_workspace when told main moved under you. Reviews: after submit_change, ask agents who know the code with request_review (suggest_reviewers shows who and why). When you get a review.assigned event, get_change (read its brief first) then review_change; line comments become threads the author must resolve_thread or reply_thread to before the change merges; reviewer agents also pick up any review.requested. Checks: when the project has a check command, run_checks before you submit; the merge queue runs the same checks on main with your change and sends it back (checks.failed) if they fail. Contests: a task with several attempts gives each claimer its own attempt; when contest.ready arrives (or whoami lists it), compare_attempts and vote for the one that should land, with a reason. Your approvals and votes count by your track record (my_track_record), so approve only what you have read. Memory: declare_intent and recall return notes other agents left; follow them and rate_note the ones you relied on. When you learn something the next agent on these files should know, remember it, or put it in your submit context as notes. Results: every tool returns structuredContent as well as text, with camelCase keys; a reference to another record is <kind>Id (agentId, taskId, changeId), the same names the tools take. Errors carry structuredContent.error {code, status, message}.";

const ACCOUNT_INSTRUCTIONS = "You're signed in to Mergery as the person you work for, and you act as their agent. Call list_projects first, and pass `project` on every other tool call. To bring a repository the person already has, create_project with importUrl. ";

async function handleOne(m: any, call: CallAs, opts: McpOptions): Promise<any> {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: m.id, result });
  if (m.id === undefined) return null; // notification
  const account = opts.account;
  const core = opts.tools === "core";
  const shown = core ? TOOLS.filter((t) => CORE.has(t.name)) : TOOLS;
  const hidden = core ? TOOLS.filter((t) => !CORE.has(t.name)) : [];
  const schema = (s: Record<string, any>): Record<string, any> => {
    const out: Record<string, any> = withAs(s);
    if (!account) return out;
    // A default project (from ?project=) makes `project` optional.
    return { ...out, properties: { ...out.properties, project: PROJECT }, required: opts.defaultProject ? out.required : [...(out.required ?? []), "project"] };
  };
  switch (m.method) {
    case "initialize":
      return reply({
        protocolVersion: m.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "mergery", version: "0.1.0" },
        instructions: (account ? ACCOUNT_INSTRUCTIONS : "") + INSTRUCTIONS + (core ? " Only the core tools are listed; call any other Mergery tool named here through mergery_tool." : ""),
      });
    case "ping":
      return reply({});
    case "tools/list": {
      const tools: { name: string; description: string; inputSchema: Record<string, any> }[] = shown.map(({ name, description, inputSchema }) => ({ name, description, inputSchema: schema(inputSchema) }));
      if (hidden.length) {
        tools.push({
          name: LOOM_TOOL.name,
          description: `Call any other Mergery tool by name, with the arguments it takes (\`as\`${account ? " and `project`" : ""} go in arguments too). They are:\n${hidden.map((t) => `- ${t.name}: ${t.description.split(/(?<=\.)\s/)[0]}`).join("\n")}`,
          inputSchema: LOOM_TOOL.inputSchema,
        });
      }
      if (account) tools.unshift(...ACCOUNT_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })));
      return reply({ tools });
    }
    case "tools/call": {
      let name = m.params?.name;
      let args = m.params?.arguments ?? {};
      // Agents set up before the rename still call loom_status and loom_tool.
      if (name === "loom_status") name = "mergery_status";
      if (name === LOOM_TOOL.name || name === "loom_tool") {
        name = args.name;
        args = args.arguments ?? {};
      }
      const own = account && ACCOUNT_TOOLS.find((t) => t.name === name);
      if (own) {
        try {
          const result = canonical(await own.run(args, account!));
          return reply({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }], ...structured(result) });
        } catch (e: any) {
          return reply({ content: [{ type: "text", text: String(e?.message ?? e) }], isError: true });
        }
      }
      const tool = TOOLS.find((t) => t.name === name);
      let c: Call | null = null;
      if (!tool) return { jsonrpc: "2.0", id: m.id, error: { code: -32602, message: `unknown tool ${name}` } };
      try {
        const { as, project, ...rest } = args;
        const where = account ? (typeof project === "string" && project.trim() ? project.trim().toLowerCase() : opts.defaultProject ?? null) : null;
        if (account && !where) throw new Error("say which project: pass `project` (list_projects shows yours)");
        c = call(typeof as === "string" && as.trim() ? as.trim() : null, where);
        const result = canonical(await tool.run(rest, c));
        return reply({ content: [...notice(c), { type: "text", text: JSON.stringify(result, null, 2) }, ...ignored(tool, rest)], ...structured(result) });
      } catch (e: any) {
        return reply({ content: [...notice(c), { type: "text", text: String(e?.message ?? e) }, ...ignored(tool, args)], isError: true, structuredContent: { error: errorOf(e) } });
      }
    }
    default:
      return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } };
  }
}

/**
 * One shape for every tool's results: camelCase keys throughout, so a field
 * reads the same in mergery_status, get_change, whoami and task_context
 * (agentId, taskId, changeId, createdAt), and matches the tools' own
 * arguments. What agents wrote themselves (a change's context) and maps keyed
 * by file path keep their keys as they are.
 */
const KEEP_KEYS = new Set(["context", "symbols", "knownBy", "redactionKinds", "arguments", "input", "metadata"]);
const SNAKE = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;
const camel = (k: string) => k.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
export function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    const key = SNAKE.test(k) ? camel(k) : k;
    // A snake_case and a camelCase copy of one field: keep the camelCase one.
    if (key !== k && key in (v as Record<string, unknown>)) continue;
    out[key] = KEEP_KEYS.has(key) ? x : canonical(x);
  }
  return out;
}

/**
 * The result as structured content too, so a client can read it without
 * parsing the text a second time. MCP wants an object there, so a list is
 * wrapped as {items}.
 */
function structured(result: unknown) {
  if (Array.isArray(result)) return { structuredContent: { items: result } };
  if (result && typeof result === "object") return { structuredContent: result as Record<string, unknown> };
  return {};
}

const ERROR_CODES: Record<number, string> = { 400: "INVALID", 401: "UNAUTHORIZED", 402: "PLAN_LIMIT", 403: "FORBIDDEN", 404: "NOT_FOUND", 409: "CONFLICT", 410: "GONE", 413: "TOO_LARGE", 422: "INVALID", 423: "LOCKED", 429: "RATE_LIMITED" };

/** An error an agent can branch on: a stable code and the HTTP status, with the message as it was. */
function errorOf(e: any): { code: string; status: number | null; message: string } {
  const status = typeof e?.status === "number" ? e.status : null;
  const message = String(e?.message ?? e);
  const code = status ? ERROR_CODES[status] ?? (status >= 500 ? "SERVER_ERROR" : "ERROR") : /not found|^no (project|workspace|agent|task|change)\b/i.test(message) ? "NOT_FOUND" : "INVALID";
  return { code, status, message };
}

/** Arguments the tool doesn't take: said out loud, so a typo or a wrong guess (changeId on a tool without one) isn't silently ignored. */
function ignored(tool: Tool, args: Record<string, unknown>) {
  const known = new Set([...Object.keys((tool.inputSchema.properties as Record<string, unknown>) ?? {}), "as", "project"]);
  const extra = Object.keys(args ?? {}).filter((k) => !known.has(k) && args[k] !== undefined);
  if (!extra.length) return [];
  return [{ type: "text", text: `Note: ${tool.name} ignored ${extra.map((k) => `\`${k}\``).join(", ")}; it takes ${[...known].filter((k) => k !== "project").map((k) => `\`${k}\``).join(", ")}.` }];
}

/**
 * A directive the agent hasn't acknowledged rides on every tool result, first,
 * so an agent busy with its own work sees it whatever it called.
 */
function notice(c: Call | null) {
  const pending = c?.directives?.() ?? [];
  if (!pending.length) return [];
  const lines = pending.map((d) => `#${d.seq} from ${d.from}: "${d.body}"`);
  return [{ type: "text", text: `NEW DIRECTIVE${pending.length > 1 ? "S" : ""} from people on this project. Follow ${pending.length > 1 ? "them" : "it"} over your own plan, then call ack_directive${pending.length > 1 ? " (no seq acknowledges all)" : ` with seq ${pending[0].seq}`}:\n${lines.join("\n")}` }];
}

/** One line per event: who did what, to which task or change, and the gist. */
function brief(e: { seq: number; type: string; actor: string | null; task_id: number | null; change_id: number | null; to_agent: string | null; data: any }, forYou = true) {
  const d = e.data ?? {};
  const gist = d.advice ?? d.reason ?? d.body ?? d.message ?? d.text ?? d.summary ?? d.question ?? d.why ?? d.title ?? "";
  const extra = [d.verdict && `verdict ${d.verdict}`, d.winner && `winner #${d.winner}`, d.files && `${d.files.length} files`, d.paths && `paths ${[].concat(d.paths).slice(0, 4).join(", ")}`].filter(Boolean).join("; ");
  const where = [e.task_id != null && `task #${e.task_id}`, e.change_id != null && `change #${e.change_id}`].filter(Boolean).join(", ");
  const text = [extra, typeof gist === "string" ? gist : JSON.stringify(gist)].filter(Boolean).join(": ");
  return `${e.seq} ${e.type}${where ? ` (${where})` : ""}${e.actor ? ` by ${d.actorName ?? e.actor}` : ""}${e.to_agent ? ` to ${forYou ? "you" : e.to_agent}` : ""}${text ? `: ${text.length > 240 ? `${text.slice(0, 239)}…` : text}` : ""}`;
}
