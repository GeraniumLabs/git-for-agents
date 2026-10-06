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
    description: "Your agent identity and the latest events addressed to you (collision forecasts, review verdicts, conflicts, stale-workspace notices, messages).",
    inputSchema: obj({}),
    run: (_a, call) => call("GET", "/me"),
  },
  {
    name: "create_task",
    description: "Add a task to the project's board. Break big work into tasks other agents can claim in parallel. Use dependsOn for ordering.",
    inputSchema: obj({ title: str("Short imperative title"), description: str("What done looks like"), dependsOn: { type: "array", items: { type: "number" } }, parent: num("Parent task, when splitting your task into subtasks") }, ["title"]),
    run: (a, call) => call("POST", "/tasks", a),
  },
  {
    name: "claim_task",
    description: "Claim a task. You get your own workspace (a fork of main) with a write token, plus a read token for main. If the task was started by another agent, you also get their full context so you can pick up where they left off.",
    inputSchema: obj({ taskId: num("Task id") }, ["taskId"]),
    run: (a, call) => call("POST", `/tasks/${a.taskId}/claim`),
  },
  {
    name: "declare_intent",
    description: "Before editing, declare which paths you will touch (files, directories ending in /, or globs) and why. Loom tells you right away if another agent has declared overlapping paths or has a pending change there, and notifies them too.",
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
    description: "Propose your workspace for merging into main. Include a summary and your working context (plan, decisions, what you tested, open questions); it is stored with the change so reviewers and any agent who takes over can read it.",
    inputSchema: obj({ taskId: num("Your task"), title: str("Change title"), summary: str("What changed and why"), context: { type: "object", description: "Free-form working context: plan, decisions, tests run, files read, follow-ups" } }, ["taskId", "summary"]),
    run: (a, call) => call("POST", "/changes", a),
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
    description: "Wait up to 25 seconds for new project events after a cursor (0 for all). Returns events and a new cursor.",
    inputSchema: obj({ after: num("Cursor from the last call"), wait: num("Seconds to wait, max 25") }),
    run: (a, call) => call("GET", `/events?after=${a.after ?? 0}&wait=${a.wait ?? 20}`),
  },
  {
    name: "task_context",
    description: "Everything known about a task: intents, changes with their context and reviews, and the full event history. Use it to take over a task another agent started.",
    inputSchema: obj({ taskId: num("Task id") }, ["taskId"]),
    run: (a, call) => call("GET", `/tasks/${a.taskId}/context`),
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
          "Loom coordinates many agents and humans on one codebase. Humans steer: check whoami regularly for directives, pause notices, reassignments and answers, and follow directives over your own plan. Ask a human (ask_human) before risky or ambiguous decisions. When an overlap is forecast, settle it with propose/answer_proposal rather than racing. Workflow: loom_status -> claim_task -> declare_intent (paths you will touch) -> edit via write_files or git push to your workspace -> submit_change with your context -> watch whoami/wait_for_events for reviews, conflicts and stale-workspace notices -> sync_workspace when told main moved under you. Reviewers: get_change then review_change.",
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
