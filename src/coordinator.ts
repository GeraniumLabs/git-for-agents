// ProjectCoordinator: one Durable Object per project. It is the single place
// where agents meet: it hands out isolated workspaces (Artifacts forks),
// tracks what every agent intends to touch, runs review, and serializes merges
// into main through a queue. Main is only ever written by this object.

import { DurableObject } from "cloudflare:workers";
import { Workspace, diffFlat, unifiedDiff, type FileConflict, type FileChange, type Remote } from "./gitops";
import { anyOverlap, matches, normalizePattern } from "./paths";
import { makeStore, type RepoStore } from "./store";
import type { Env } from "./env";
import { DEFAULT_DELEGATE, decideApproval, decideQuestion, normalizeOptions, type DelegateConfig } from "./delegate";

const TOKEN_TTL = 6 * 3600;
const DELEGATE_ID = "delegate";
const MERGE_IDENTITY = { name: "Loom merge queue", email: "merge-queue@loom.dev" };

export type Role = "builder" | "reviewer" | "human";

export interface Agent {
  id: string;
  name: string;
  role: Role;
  paused?: string | null;
}

export interface LoomEvent {
  seq: number;
  ts: number;
  type: string;
  actor: string | null;
  task_id: number | null;
  change_id: number | null;
  to_agent: string | null;
  data: any;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const json = (data: unknown, status = 200) => Response.json(data, { status });

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomId(bytes = 12): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export class ProjectCoordinator extends DurableObject<Env> {
  private sql: SqlStorage;
  private store: RepoStore;
  private waiters = new Set<() => void>();
  private merging = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.store = makeStore(env);
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  private migrate() {
    this.migrateTables();
    for (const ddl of [
      "ALTER TABLE agents ADD COLUMN paused TEXT",
      "ALTER TABLE threads ADD COLUMN terms TEXT",
      "ALTER TABLE tasks ADD COLUMN waits_for INTEGER",
      "ALTER TABLE tasks ADD COLUMN parent INTEGER",
      "ALTER TABLE threads ADD COLUMN escalated TEXT",
      "ALTER TABLE threads ADD COLUMN options TEXT",
    ]) {
      try { this.sql.exec(ddl); } catch {}
    }
  }

  private migrateTables() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE, created_at INTEGER, last_seen INTEGER);
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT,
        status TEXT NOT NULL DEFAULT 'open', assignee TEXT, workspace TEXT,
        depends_on TEXT DEFAULT '[]', created_by TEXT, created_at INTEGER, updated_at INTEGER);
      CREATE TABLE IF NOT EXISTS workspaces (
        name TEXT PRIMARY KEY, task_id INTEGER, agent_id TEXT, remote TEXT,
        base_commit TEXT, base_version INTEGER, status TEXT DEFAULT 'active', created_at INTEGER);
      CREATE TABLE IF NOT EXISTS intents (
        id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, task_id INTEGER,
        paths TEXT NOT NULL, description TEXT, created_at INTEGER, released_at INTEGER);
      CREATE TABLE IF NOT EXISTS changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER, agent_id TEXT, workspace TEXT,
        title TEXT, summary TEXT, head TEXT, base TEXT, base_version INTEGER,
        status TEXT NOT NULL, files TEXT DEFAULT '[]', undeclared TEXT DEFAULT '[]',
        conflicts TEXT, merged_commit TEXT, merged_version INTEGER,
        created_at INTEGER, updated_at INTEGER);
      CREATE TABLE IF NOT EXISTS reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT, change_id INTEGER, reviewer TEXT,
        verdict TEXT, body TEXT, comments TEXT DEFAULT '[]', head TEXT, created_at INTEGER);
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, type TEXT, actor TEXT,
        task_id INTEGER, change_id INTEGER, to_agent TEXT, data TEXT);
      CREATE TABLE IF NOT EXISTS projects (name TEXT PRIMARY KEY, description TEXT, created_at INTEGER);
      CREATE TABLE IF NOT EXISTS threads (
        id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL DEFAULT 'discussion',
        task_id INTEGER, change_id INTEGER, path TEXT, line INTEGER, title TEXT,
        created_by TEXT, to_agent TEXT, blocking INTEGER DEFAULT 0, prev_task_status TEXT,
        status TEXT NOT NULL DEFAULT 'open', created_at INTEGER, updated_at INTEGER);
      CREATE TABLE IF NOT EXISTS posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id INTEGER, author TEXT, body TEXT, created_at INTEGER);
    `);
  }

  // ── small helpers ────────────────────────────────────────────────────────

  private meta(key: string): string | null {
    const row = this.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray()[0];
    return row ? (row.value as string) : null;
  }
  private setMeta(key: string, value: string) {
    this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", key, value);
  }
  private get project(): string {
    const p = this.meta("project");
    if (!p) throw new HttpError(404, "project not found");
    return p;
  }
  private get mainRepo(): string {
    return this.meta("main_repo")!;
  }
  private get mainVersion(): number {
    return Number(this.meta("main_version") ?? "0");
  }
  private get protectedPaths(): string[] {
    return JSON.parse(this.meta("protected_paths") ?? "[]");
  }
  private get requiredApprovals(): number {
    return Number(this.meta("required_approvals") ?? "1");
  }

  private emit(type: string, e: { actor?: string | null; task?: number | null; change?: number | null; to?: string | null; data?: any }) {
    const ts = Date.now();
    const row = this.sql
      .exec(
        "INSERT INTO events (ts, type, actor, task_id, change_id, to_agent, data) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING seq",
        ts, type, e.actor ?? null, e.task ?? null, e.change ?? null, e.to ?? null, JSON.stringify(e.data ?? {}),
      )
      .one();
    const event: LoomEvent = { seq: row.seq as number, ts, type, actor: e.actor ?? null, task_id: e.task ?? null, change_id: e.change ?? null, to_agent: e.to ?? null, data: e.data ?? {} };
    const msg = JSON.stringify({ kind: "event", event });
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(msg); } catch {}
    }
    for (const wake of this.waiters) wake();
    this.waiters.clear();
    if (["question.asked", "approval.needs_human", "review.submitted"].includes(type) && e.actor !== DELEGATE_ID) {
      this.ctx.waitUntil(this.delegateOn(event).catch((err) => console.error("delegate", err)));
    }
    return event;
  }

  private rowsToEvents(rows: Record<string, SqlStorageValue>[]): LoomEvent[] {
    return rows.map((r) => ({ ...(r as any), data: JSON.parse(r.data as string) }));
  }

  private agentName(id: string | null): string | null {
    if (!id) return null;
    const r = this.sql.exec("SELECT name FROM agents WHERE id = ?", id).toArray()[0];
    return r ? (r.name as string) : id;
  }

  private async authenticate(req: Request): Promise<Agent | "admin"> {
    const header = req.headers.get("authorization") ?? "";
    const key = header.replace(/^Bearer\s+/i, "");
    if (!key) throw new HttpError(401, "missing bearer token");
    if (this.env.LOOM_ADMIN_TOKEN && key === this.env.LOOM_ADMIN_TOKEN) return "admin";
    const hash = await sha256(key);
    const row = this.sql.exec("SELECT id, name, role, paused FROM agents WHERE key_hash = ?", hash).toArray()[0];
    if (!row) throw new HttpError(401, "unknown agent key");
    this.sql.exec("UPDATE agents SET last_seen = ? WHERE id = ?", Date.now(), row.id);
    return { id: row.id as string, name: row.name as string, role: row.role as Role, paused: (row.paused as string | null) ?? null };
  }

  private remote(repo: string, token: string): Remote {
    return { url: this.remoteUrl(repo), token };
  }
  private remoteUrl(repo: string): string {
    return this.meta(`remote:${repo}`) ?? "";
  }
  /** Short-lived tokens for Loom's own git operations, reused while fresh. */
  private tokens = new Map<string, { token: string; until: number }>();
  private async token(repo: string, scope: "read" | "write"): Promise<string> {
    const key = `${repo}:${scope}`;
    const hit = this.tokens.get(key);
    if (hit && hit.until > Date.now()) return hit.token;
    const token = await this.store.token(repo, scope, 3600);
    this.tokens.set(key, { token, until: Date.now() + 50 * 60_000 });
    return token;
  }

  private async mainRemote(scope: "read" | "write"): Promise<Remote> {
    return this.remote(this.mainRepo, await this.token(this.mainRepo, scope));
  }

  private task(id: number) {
    const t = this.sql.exec("SELECT * FROM tasks WHERE id = ?", id).toArray()[0];
    if (!t) throw new HttpError(404, `task ${id} not found`);
    return { ...t, depends_on: JSON.parse(t.depends_on as string) } as any;
  }
  private change(id: number) {
    const c = this.sql.exec("SELECT * FROM changes WHERE id = ?", id).toArray()[0];
    if (!c) throw new HttpError(404, `change ${id} not found`);
    return {
      ...c,
      files: JSON.parse(c.files as string),
      undeclared: JSON.parse(c.undeclared as string),
      conflicts: c.conflicts ? JSON.parse(c.conflicts as string) : null,
    } as any;
  }
  private activeIntents(excludeAgent?: string) {
    return this.sql
      .exec("SELECT * FROM intents WHERE released_at IS NULL")
      .toArray()
      .filter((r) => r.agent_id !== excludeAgent)
      .map((r) => ({ ...r, paths: JSON.parse(r.paths as string) })) as any[];
  }

  // ── HTTP entry point (called by the Worker) ──────────────────────────────

  async fetch(req: Request): Promise<Response> {
    try {
      return await this.route(req);
    } catch (e: any) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: String(e?.message ?? e) }, 500);
    }
  }

  private async route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean); // after /api/projects/:name
    const [a, b, c] = parts;
    const m = req.method;
    const body = m === "POST" || m === "PUT" ? await req.json<any>().catch(() => ({})) : {};

    // Registry (singleton instance)
    if (a === "registry") {
      if (m === "GET") return json(this.sql.exec("SELECT * FROM projects ORDER BY created_at").toArray());
      this.sql.exec("INSERT OR REPLACE INTO projects VALUES (?, ?, ?)", body.name, body.description ?? "", Date.now());
      return json({ ok: true });
    }

    if (a === "init" && m === "POST") return json(await this.init(body));
    if (a === "ws") return this.acceptSocket(req);

    // Reads are open so the dashboard can render without a key.
    if (m === "GET") {
      if (a === "state") return json(this.state());
      if (a === "events") return json(await this.events(Number(url.searchParams.get("after") ?? 0), Number(url.searchParams.get("wait") ?? 0), url.searchParams.get("agent")));
      if (a === "tasks" && b && c === "context") return json(await this.handoff(Number(b)));
      if (a === "changes" && b) return json(await this.changeDetail(Number(b)));
      if (a === "files") return json(await this.readFiles(url.searchParams));
      if (a === "delegate") return json(this.delegateConfig);
      if (a === "threads" && b) return json(this.thread(Number(b)));
      if (a === "threads") return json(this.threads(url.searchParams));
    }

    const who = await this.authenticate(req);
    const actor: Agent = who === "admin" ? { id: "admin", name: "admin", role: "human" } : who;

    if (a === "agents" && !b && m === "POST") {
      if (who !== "admin") throw new HttpError(403, "only an admin can add agents");
      return json(await this.addAgent(body.name, body.role ?? "builder"));
    }
    if (a === "settings" && m === "POST") {
      if (who !== "admin") throw new HttpError(403, "only an admin can change settings");
      if (body.requiredApprovals !== undefined) this.setMeta("required_approvals", String(body.requiredApprovals));
      if (body.protectedPaths !== undefined) this.setMeta("protected_paths", JSON.stringify(body.protectedPaths));
      return json({ requiredApprovals: this.requiredApprovals, protectedPaths: this.protectedPaths });
    }
    if (a === "me") return json({ agent: actor, mainFrozen: this.meta("frozen"), inbox: this.inbox(actor.id) });

    // Human controls. Humans (and the admin) steer; agents can't.
    if (["directives", "pause", "resume", "freeze", "unfreeze", "assign", "protect", "delegate"].includes(c ?? a)) {
      if (actor.role !== "human") throw new HttpError(403, "only humans can steer agents");
      if (a === "directives") return json(this.directive(actor, body));
      if (a === "agents" && b && c === "pause") return json(this.pause(actor, b, body.reason));
      if (a === "agents" && b && c === "resume") return json(this.resume(actor, b));
      if (a === "freeze") return json(this.freeze(actor, body.reason));
      if (a === "unfreeze") return json(await this.unfreeze(actor));
      if (a === "tasks" && b && c === "assign") return json(this.assign(actor, Number(b), body.agent ?? null, body.note));
      if (a === "protect") return json(this.protect(actor, body.paths ?? []));
      if (a === "delegate") return json(await this.configureDelegate(actor, body));
    }
    // A paused agent can still read, talk and answer, but not change code.
    const talking = a === "threads" || a === "messages" || a === "proposals";
    if (actor.paused && !talking) throw new HttpError(423, `you are paused: ${actor.paused}. Wait for a human to resume you; you can still post in threads.`);
    if (a === "tasks" && !b && m === "POST") return json(this.createTask(actor, body));
    if (a === "tasks" && b && c === "claim") return json(await this.claim(actor, Number(b)));
    if (a === "tasks" && b && c === "release") return json(this.releaseTask(actor, Number(b), body.reason));
    if (a === "intents" && !b && m === "POST") return json(this.declareIntent(actor, body));
    if (a === "intents" && b && m === "DELETE") return json(this.releaseIntent(actor, Number(b)));
    if (a === "workspaces" && b && c === "commit") return json(await this.commitToWorkspace(actor, b, body));
    if (a === "changes" && !b && m === "POST") return json(await this.submitChange(actor, body));
    if (a === "changes" && b && c === "reviews") return json(await this.review(actor, Number(b), body));
    if (a === "changes" && b && c === "update") return json(await this.updateChange(actor, Number(b), body));
    if (a === "changes" && b && c === "sync") return json(await this.sync(actor, { changeId: Number(b) }, body.resolutions));
    if (a === "tasks" && b && c === "sync") return json(await this.sync(actor, { taskId: Number(b) }, body.resolutions));
    if (a === "messages" && m === "POST") return json(this.message(actor, body));
    if (a === "threads" && !b && m === "POST") return json(this.openThread(actor, body));
    if (a === "proposals" && !b && m === "POST") return json(this.propose(actor, body));
    if (a === "proposals" && b && c === "accept") return json(this.settle(actor, Number(b), true, body.body));
    if (a === "proposals" && b && c === "reject") return json(this.settle(actor, Number(b), false, body.body));
    if (a === "threads" && b && c === "posts") return json(this.post(actor, Number(b), body.body));
    if (a === "threads" && b && c === "resolve") return json(this.resolveThread(actor, Number(b), body.body));
    throw new HttpError(404, `no route ${m} ${url.pathname}`);
  }

  // ── project setup ────────────────────────────────────────────────────────

  private async init(body: { name: string; description?: string; files?: Record<string, string>; requiredApprovals?: number }) {
    if (this.meta("project")) throw new HttpError(409, "project already exists");
    const name = body.name;
    const repo = `${name}`;
    const created = await this.store.create(repo, body.description);
    this.setMeta("project", name);
    this.setMeta("description", body.description ?? "");
    this.setMeta("main_repo", repo);
    this.setMeta(`remote:${repo}`, created.remote);
    this.setMeta("main_version", "0");
    this.setMeta("required_approvals", String(body.requiredApprovals ?? 1));
    const files = body.files ?? { "README.md": `# ${name}\n\n${body.description ?? ""}\n` };
    const w = await Workspace.open({ url: created.remote, token: created.token });
    const commit = await w.commitFiles(null, files, "Initial commit", MERGE_IDENTITY);
    await w.push({ url: created.remote, token: created.token }, commit);
    this.setMeta("main_head", commit);
    this.emit("project.created", { data: { name, commit } });
    return { name, remote: created.remote, head: commit };
  }

  private async addAgent(name: string, role: Role) {
    const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomId(2)}`;
    const key = `loom_${randomId(20)}`;
    this.sql.exec("INSERT INTO agents (id, name, role, key_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)", id, name, role, await sha256(key), Date.now(), Date.now());
    this.emit("agent.joined", { actor: id, data: { name, role } });
    return { id, name, role, key };
  }

  // ── tasks and workspaces ─────────────────────────────────────────────────

  private createTask(actor: Agent, body: { title: string; description?: string; dependsOn?: number[]; parent?: number }) {
    if (!body.title) throw new HttpError(400, "title is required");
    if (body.parent) this.task(body.parent);
    const now = Date.now();
    const row = this.sql
      .exec("INSERT INTO tasks (title, description, depends_on, parent, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
        body.title, body.description ?? "", JSON.stringify(body.dependsOn ?? []), body.parent ?? null, actor.id, now, now)
      .one();
    const id = row.id as number;
    this.emit("task.created", { actor: actor.id, task: id, data: { title: body.title, parent: body.parent ?? null } });
    return this.task(id);
  }

  private async claim(actor: Agent, taskId: number) {
    const task = this.task(taskId);
    if (task.assignee && task.assignee !== actor.id) {
      const holder = this.sql.exec("SELECT last_seen FROM agents WHERE id = ?", task.assignee).toArray()[0];
      const stale = !holder || Date.now() - (holder.last_seen as number) > 10 * 60_000;
      if (!stale) throw new HttpError(409, `task ${taskId} is held by ${this.agentName(task.assignee)}`);
      this.emit("task.reassigned", { actor: actor.id, task: taskId, data: { from: task.assignee, reason: "previous agent went quiet" } });
    }
    for (const dep of task.depends_on as number[]) {
      if (this.task(dep).status !== "merged") throw new HttpError(409, `task ${taskId} waits on task ${dep}`);
    }

    // Reuse the task's workspace if it has one (a handoff), else fork main.
    let ws = task.workspace as string | null;
    let resumed = !!ws;
    if (!ws) {
      ws = `${this.project}-t${taskId}-${randomId(3)}`;
      const forked = await this.store.fork(this.mainRepo, ws, `Workspace for task ${taskId}: ${task.title}`);
      this.setMeta(`remote:${ws}`, forked.remote);
      const head = this.meta("main_head");
      this.sql.exec("INSERT INTO workspaces (name, task_id, agent_id, remote, base_commit, base_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ws, taskId, actor.id, forked.remote, head, this.mainVersion, Date.now());
    } else {
      this.sql.exec("UPDATE workspaces SET agent_id = ? WHERE name = ?", actor.id, ws);
    }
    this.sql.exec("UPDATE tasks SET assignee = ?, workspace = ?, status = CASE WHEN status = 'open' THEN 'claimed' ELSE status END, updated_at = ? WHERE id = ?",
      actor.id, ws, Date.now(), taskId);
    // Move the previous holder's intents to the new holder.
    this.sql.exec("UPDATE intents SET agent_id = ? WHERE task_id = ? AND released_at IS NULL", actor.id, taskId);

    const [wsToken, mainToken] = await Promise.all([
      this.store.token(ws, "write", TOKEN_TTL),
      this.store.token(this.mainRepo, "read", TOKEN_TTL),
    ]);
    this.emit("task.claimed", { actor: actor.id, task: taskId, data: { workspace: ws, resumed } });
    return {
      task: this.task(taskId),
      workspace: { name: ws, remote: this.remoteUrl(ws), token: wsToken },
      main: { name: this.mainRepo, remote: this.remoteUrl(this.mainRepo), token: mainToken, note: "read-only: only the merge queue writes main" },
      git: {
        clone: `git -c http.extraHeader="Authorization: Bearer ${wsToken}" clone ${this.remoteUrl(ws)} work`,
        pullMain: `git -c http.extraHeader="Authorization: Bearer ${mainToken}" pull --no-rebase ${this.remoteUrl(this.mainRepo)} main`,
      },
      context: resumed ? await this.handoff(taskId) : null,
    };
  }

  private releaseTask(actor: Agent, taskId: number, reason?: string) {
    this.sql.exec("UPDATE tasks SET assignee = NULL, status = CASE WHEN status = 'claimed' THEN 'open' ELSE status END, updated_at = ? WHERE id = ? AND assignee = ?", Date.now(), taskId, actor.id);
    this.emit("task.released", { actor: actor.id, task: taskId, data: { reason: reason ?? "" } });
    return this.task(taskId);
  }

  // ── intents: say what you'll touch before you touch it ──────────────────

  private declareIntent(actor: Agent, body: { taskId?: number; paths: string[]; description?: string }) {
    const paths = (body.paths ?? []).map(normalizePattern).filter(Boolean);
    if (!paths.length) throw new HttpError(400, "paths is required");
    const row = this.sql
      .exec("INSERT INTO intents (agent_id, task_id, paths, description, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id",
        actor.id, body.taskId ?? null, JSON.stringify(paths), body.description ?? "", Date.now())
      .one();
    const id = row.id as number;
    const overlaps = this.activeIntents(actor.id)
      .map((i) => ({ intent: i.id, agent: i.agent_id, agentName: this.agentName(i.agent_id), task: i.task_id, description: i.description, paths: anyOverlap(paths, i.paths) }))
      .filter((o) => o.paths.length);
    this.emit("intent.declared", { actor: actor.id, task: body.taskId, data: { intent: id, paths, description: body.description ?? "" } });
    for (const o of overlaps) {
      // Tell both sides, so they can split the work or agree on an order.
      this.emit("collision.forecast", {
        actor: actor.id, task: body.taskId, to: o.agent,
        data: { paths: o.paths, mine: { agent: actor.id, task: body.taskId, description: body.description }, theirs: { agent: o.agent, task: o.task, description: o.description } },
      });
    }
    // In-flight changes that already touch these paths are also worth knowing about.
    const pending = this.sql.exec("SELECT id, agent_id, title, files FROM changes WHERE status IN ('review','queued','merging','conflict','changes_requested')").toArray()
      .map((c) => ({ change: c.id, agent: c.agent_id, title: c.title, files: (JSON.parse(c.files as string) as FileChange[]).map((f) => f.path).filter((f) => paths.some((p) => matches(p, f))) }))
      .filter((c) => c.files.length && c.agent !== actor.id);
    return { intent: id, paths, overlaps, pendingChanges: pending, advice: overlaps.length || pending.length ? "Another agent is working in these paths. Message them (send_message) to split the work, or narrow your intent." : "Clear: no one else has declared these paths." };
  }

  private releaseIntent(actor: Agent, id: number) {
    this.sql.exec("UPDATE intents SET released_at = ? WHERE id = ? AND (agent_id = ? OR ? = 'admin')", Date.now(), id, actor.id, actor.id);
    this.emit("intent.released", { actor: actor.id, data: { intent: id } });
    return { ok: true };
  }

  // ── workspace writes over the API (for agents without a git client) ─────

  private workspaceFor(actor: Agent, name: string) {
    const ws = this.sql.exec("SELECT * FROM workspaces WHERE name = ?", name).toArray()[0];
    if (!ws) throw new HttpError(404, `workspace ${name} not found`);
    if (ws.agent_id !== actor.id && actor.id !== "admin") throw new HttpError(403, "this workspace belongs to another agent");
    return ws as any;
  }

  private async commitToWorkspace(actor: Agent, name: string, body: { files: Record<string, string | null>; message: string }) {
    const ws = this.workspaceFor(actor, name);
    if (!body.files || !Object.keys(body.files).length) throw new HttpError(400, "files is required");
    const remote = this.remote(name, await this.token(name, "write"));
    const w = await Workspace.open(remote);
    const parent = await w.head();
    const commit = await w.commitFiles(parent, body.files, body.message || "Update files", { name: actor.name, email: `${actor.id}@agents.loom.dev` });
    await w.push(remote, commit);
    this.emit("workspace.committed", { actor: actor.id, task: ws.task_id, data: { workspace: name, commit, files: Object.keys(body.files), message: body.message } });
    return { commit, files: Object.keys(body.files) };
  }

  private async readFiles(q: URLSearchParams) {
    const repo = q.get("workspace") ?? this.mainRepo;
    const ref = q.get("ref") ?? "main";
    const path = q.get("path");
    if (path) {
      const content = await this.store.readFile(repo, ref, path);
      if (content === null) throw new HttpError(404, `${path} not found at ${ref}`);
      return { repo, ref, path, content };
    }
    const w = await Workspace.open(this.remote(repo, await this.token(repo, "read")));
    const flat = await w.flatten(await w.head());
    return { repo, ref, files: [...flat.keys()].sort() };
  }

  // ── changes: the agent-native pull request ───────────────────────────────

  private async submitChange(actor: Agent, body: { taskId: number; title?: string; summary?: string; context?: any }) {
    const task = this.task(body.taskId);
    if (task.assignee !== actor.id) throw new HttpError(403, `task ${body.taskId} is not assigned to you`);
    const wsRow = this.sql.exec("SELECT * FROM workspaces WHERE name = ?", task.workspace).toArray()[0] as any;
    const analysis = await this.analyze(task.workspace);
    if (!analysis.files.length) throw new HttpError(400, "the workspace has no changes against main");

    const undeclared = this.undeclared(body.taskId, analysis.files);

    const now = Date.now();
    const existing = this.sql.exec("SELECT id FROM changes WHERE task_id = ? AND status NOT IN ('merged','abandoned')", body.taskId).toArray()[0];
    if (existing) return this.updateChange(actor, existing.id as number, body);

    const status = this.requiredApprovals > 0 || this.guardedFiles(analysis.files).length ? "review" : "queued";
    const row = this.sql
      .exec(`INSERT INTO changes (task_id, agent_id, workspace, title, summary, head, base, base_version, status, files, undeclared, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        body.taskId, actor.id, task.workspace, body.title ?? task.title, body.summary ?? "", analysis.head, analysis.base, wsRow.base_version,
        status, JSON.stringify(analysis.files), JSON.stringify(undeclared), now, now)
      .one();
    const id = row.id as number;
    await this.saveContext(id, actor, body, analysis.patch);
    this.sql.exec("UPDATE tasks SET status = 'in_review', updated_at = ? WHERE id = ?", now, body.taskId);
    this.emit("change.submitted", { actor: actor.id, task: body.taskId, change: id, data: { title: body.title ?? task.title, files: analysis.files, undeclared, status } });
    if (status === "review") this.requestReview(id, actor.id);
    else await this.enqueue(id);
    return this.change(id);
  }

  private async updateChange(actor: Agent, id: number, body: { summary?: string; context?: any; title?: string }) {
    const ch = this.change(id);
    if (ch.agent_id !== actor.id) throw new HttpError(403, "not your change");
    if (ch.status === "merged" || ch.status === "merging") throw new HttpError(409, `change ${id} is ${ch.status}`);
    const analysis = await this.analyze(ch.workspace);
    // The merge queue may have taken the change while we were analyzing.
    if (["merged", "merging"].includes(this.change(id).status)) throw new HttpError(409, `change ${id} was merged meanwhile`);
    const status = this.requiredApprovals > 0 || this.guardedFiles(analysis.files).length ? "review" : "queued";
    this.sql.exec("UPDATE changes SET head = ?, base = ?, files = ?, undeclared = ?, status = ?, summary = COALESCE(?, summary), conflicts = NULL, updated_at = ? WHERE id = ?",
      analysis.head, analysis.base, JSON.stringify(analysis.files), JSON.stringify(this.undeclared(ch.task_id, analysis.files)), status, body.summary ?? null, Date.now(), id);
    await this.saveContext(id, actor, { ...body, summary: body.summary ?? ch.summary }, analysis.patch);
    this.emit("change.updated", { actor: actor.id, task: ch.task_id, change: id, data: { head: analysis.head, files: analysis.files } });
    if (status === "review") this.requestReview(id, actor.id);
    else await this.enqueue(id);
    return this.change(id);
  }

  private guardedFiles(files: FileChange[]): string[] {
    const prot = this.protectedPaths;
    return files.map((f) => f.path).filter((f) => prot.some((p) => matches(p, f)));
  }

  /** Files a change touches that its task never declared an intent for. */
  private undeclared(taskId: number, files: FileChange[]): string[] {
    const declared = this.sql.exec("SELECT paths FROM intents WHERE task_id = ?", taskId).toArray().flatMap((r) => JSON.parse(r.paths as string) as string[]);
    return files.map((f) => f.path).filter((f) => !declared.some((p) => matches(p, f)));
  }

  private requestReview(id: number, author: string) {
    const reviewers = this.sql.exec("SELECT id FROM agents WHERE role = 'reviewer' AND id != ?", author).toArray();
    this.emit("review.requested", { actor: author, change: id, task: this.change(id).task_id, data: { reviewers: reviewers.map((r) => r.id) } });
    const ch = this.change(id);
    const guarded = this.guardedFiles(ch.files);
    if (guarded.length) this.emit("approval.needs_human", { change: id, task: ch.task_id, data: { paths: guarded, reason: "touches protected paths; a human must approve" } });
  }

  /** Head, merge base, changed files and patch of a workspace against main. */
  private async analyze(wsName: string) {
    const w = await Workspace.open(await this.mainRemote("read"));
    const main = (await w.head())!;
    const head = await w.fetchFrom("ws", this.remote(wsName, await this.token(wsName, "read")));
    const base = (await w.mergeBase(main, head)) ?? main;
    // What would land: main versus main-with-this-change-merged. This stays
    // right after the workspace has merged main into itself, where a plain
    // base..head diff can pick up other agents' work.
    const merged = await w.merge(main, head);
    const B = merged.tree ? await w.flatten(main) : await w.flatten(base);
    const H = merged.tree ? await w.flattenTree(merged.tree) : await w.flatten(head);
    const files = diffFlat(B, H);
    let patch = "";
    for (const f of files) {
      const before = B.get(f.path), after = H.get(f.path);
      patch += unifiedDiff(f.path, before ? await w.readText(before.oid) : null, after ? await w.readText(after.oid) : null);
    }
    return { head, base, files, patch };
  }

  private async saveContext(id: number, actor: Agent, body: { summary?: string; context?: any }, patch: string) {
    const key = `${this.project}/changes/${id}`;
    await this.env.CONTEXT.put(`${key}/patch.diff`, patch);
    await this.env.CONTEXT.put(`${key}/context.json`, JSON.stringify({ agent: actor, summary: body.summary ?? "", context: body.context ?? {}, savedAt: new Date().toISOString() }, null, 2));
  }

  private async changeDetail(id: number) {
    const ch = this.change(id);
    const key = `${this.project}/changes/${id}`;
    const [patch, ctx] = await Promise.all([this.env.CONTEXT.get(`${key}/patch.diff`), this.env.CONTEXT.get(`${key}/context.json`)]);
    const reviews = this.sql.exec("SELECT * FROM reviews WHERE change_id = ? ORDER BY id", id).toArray().map((r) => ({ ...r, comments: JSON.parse(r.comments as string) }));
    const intents = this.sql.exec("SELECT * FROM intents WHERE task_id = ?", ch.task_id).toArray().map((r) => ({ ...r, paths: JSON.parse(r.paths as string) }));
    return { ...ch, agentName: this.agentName(ch.agent_id), task: this.task(ch.task_id), intents, reviews, patch: patch ? await patch.text() : "", context: ctx ? await ctx.json() : null };
  }

  private async review(actor: Agent, id: number, body: { verdict: "approve" | "request_changes" | "comment"; body?: string; comments?: { path: string; line?: number; body: string }[] }) {
    const ch = this.change(id);
    if (!["approve", "request_changes", "comment"].includes(body.verdict)) throw new HttpError(400, "verdict must be approve, request_changes or comment");
    if (ch.agent_id === actor.id) throw new HttpError(403, "agents cannot review their own change");
    this.sql.exec("INSERT INTO reviews (change_id, reviewer, verdict, body, comments, head, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id, actor.id, body.verdict, body.body ?? "", JSON.stringify(body.comments ?? []), ch.head, Date.now());
    this.emit("review.submitted", { actor: actor.id, change: id, task: ch.task_id, to: ch.agent_id, data: { verdict: body.verdict, body: body.body ?? "", comments: body.comments ?? [] } });
    if (body.verdict === "request_changes") {
      this.sql.exec("UPDATE changes SET status = 'changes_requested', updated_at = ? WHERE id = ?", Date.now(), id);
    } else if (body.verdict === "approve" && ch.status === "review") {
      const approvers = this.sql.exec("SELECT DISTINCT r.reviewer, a.role FROM reviews r LEFT JOIN agents a ON a.id = r.reviewer WHERE r.change_id = ? AND r.verdict = 'approve' AND r.head = ?", id, ch.head).toArray();
      const humanOk = approvers.some((r) => r.role === "human" || r.reviewer === "admin");
      const guarded = this.guardedFiles(ch.files);
      if (approvers.length >= this.requiredApprovals && (humanOk || !guarded.length)) await this.enqueue(id);

    }
    return this.change(id);
  }

  // ── merge queue ──────────────────────────────────────────────────────────

  private async enqueue(id: number) {
    this.sql.exec("UPDATE changes SET status = 'queued', updated_at = ? WHERE id = ?", Date.now(), id);
    const position = this.sql.exec("SELECT COUNT(*) AS n FROM changes WHERE status IN ('queued','merging') AND id <= ?", id).one().n;
    this.emit("change.queued", { change: id, task: this.change(id).task_id, data: { position } });
    await this.ctx.storage.setAlarm(Date.now());
  }

  async alarm() {
    if (this.merging || this.meta("frozen")) return;
    this.merging = true;
    try {
      for (;;) {
        // A change whose task agreed to land after another task waits its turn.
        const next = this.sql.exec(`SELECT c.id FROM changes c JOIN tasks t ON t.id = c.task_id
          WHERE c.status = 'queued' AND (t.waits_for IS NULL OR EXISTS (SELECT 1 FROM tasks w WHERE w.id = t.waits_for AND w.status = 'merged'))
          ORDER BY c.updated_at, c.id LIMIT 1`).toArray()[0];
        if (!next) break;
        const before = this.sql.exec("SELECT status FROM changes WHERE id = ?", next.id).one().status;
        await this.mergeOne(next.id as number);
        // A failed attempt goes back to 'queued' with a delay; leave it to the next alarm.
        if (before === "queued" && this.sql.exec("SELECT status FROM changes WHERE id = ?", next.id).one().status === "queued") break;
      }
    } finally {
      this.merging = false;
    }
  }

  private async mergeOne(id: number) {
    const ch = this.change(id);
    this.sql.exec("UPDATE changes SET status = 'merging', updated_at = ? WHERE id = ?", Date.now(), id);
    this.emit("merge.started", { change: id, task: ch.task_id, data: {} });
    try {
      const mainW = await this.mainRemote("write");
      const w = await Workspace.open(mainW);
      const main = (await w.head())!;
      const head = await w.fetchFrom("ws", this.remote(ch.workspace, await this.token(ch.workspace, "read")));
      if (head !== ch.head) {
        // The agent pushed after review. Approval covered a different commit.
        this.sql.exec("UPDATE changes SET status = 'review', head = ?, updated_at = ? WHERE id = ?", head, Date.now(), id);
        this.emit("change.updated", { change: id, task: ch.task_id, data: { head, reason: "workspace moved after approval; review again" } });
        this.requestReview(id, ch.agent_id);
        return;
      }
      let commit: string;
      if (await w.isAncestor(head, main)) {
        commit = main;
      } else if (await w.isAncestor(main, head)) {
        commit = head;
        await w.push(mainW, commit);
      } else {
        const result = await w.merge(main, head);
        if (!result.tree) return this.recordConflict(ch, result.conflicts);
        commit = await w.commit(result.tree, [main, head], `Merge change #${id}: ${ch.title}\n\nTask #${ch.task_id}, by ${this.agentName(ch.agent_id)}.\n\n${ch.summary ?? ""}`.trim(), MERGE_IDENTITY);
        await w.push(mainW, commit);
      }
      const landed = await w.changes(main, commit);
      const version = commit === main ? this.mainVersion : this.mainVersion + 1;
      this.setMeta("main_version", String(version));
      this.setMeta("main_head", commit);
      const now = Date.now();
      this.sql.exec("UPDATE changes SET status = 'merged', merged_commit = ?, merged_version = ?, updated_at = ? WHERE id = ?", commit, version, now, id);
      this.sql.exec("UPDATE tasks SET status = 'merged', updated_at = ? WHERE id = ?", now, ch.task_id);
      this.sql.exec("UPDATE intents SET released_at = ? WHERE task_id = ? AND released_at IS NULL", now, ch.task_id);
      this.sql.exec("UPDATE workspaces SET status = 'merged' WHERE name = ?", ch.workspace);
      this.emit("change.merged", { actor: ch.agent_id, change: id, task: ch.task_id, data: { commit, version, files: landed } });
      this.adviseStale(id, landed.map((f) => f.path));
      for (const w of this.sql.exec("SELECT id FROM tasks WHERE waits_for = ?", ch.task_id).toArray()) {
        this.emit("task.unblocked", { task: w.id as number, data: { after: ch.task_id } });
      }
    } catch (e: any) {
      console.error("merge failed", e);
      this.sql.exec("UPDATE changes SET status = 'queued', updated_at = ? WHERE id = ?", Date.now() + 5000, id);
      this.emit("merge.retry", { change: id, task: ch.task_id, data: { error: String(e?.message ?? e) } });
      await this.ctx.storage.setAlarm(Date.now() + 5000);
    }
  }

  /** Main moved: tell every other active agent whose work touches what landed. */
  private adviseStale(mergedChange: number, paths: string[]) {
    const intents = this.activeIntents();
    const notified = new Set<string>();
    for (const i of intents) {
      const hit = paths.filter((p) => i.paths.some((pat: string) => matches(pat, p)));
      if (!hit.length || notified.has(i.agent_id)) continue;
      notified.add(i.agent_id);
      this.emit("workspace.stale", { to: i.agent_id, task: i.task_id, change: mergedChange, data: { paths: hit, advice: "Main changed files you are working on. Call sync_workspace to merge main into your workspace now, while the gap is small." } });
    }
  }

  /** Attach to each conflict the merged changes (since `sinceVersion`) that touched the same file. */
  private explain(conflicts: FileConflict[], sinceVersion: number) {
    const causes = this.sql.exec("SELECT id, task_id, agent_id, title, summary, files FROM changes WHERE status = 'merged' AND merged_version > ?", sinceVersion).toArray();
    return conflicts.map((c) => ({
      ...c,
      causedBy: causes
        .filter((x) => (JSON.parse(x.files as string) as FileChange[]).some((f) => f.path === c.path))
        .map((x) => ({ change: x.id as number, task: x.task_id, agent: x.agent_id, agentName: this.agentName(x.agent_id as string), title: x.title, summary: x.summary })),
    }));
  }

  private recordConflict(ch: any, conflicts: FileConflict[]) {
    const explained = this.explain(conflicts, ch.base_version ?? 0);
    this.sql.exec("UPDATE changes SET status = 'conflict', conflicts = ?, updated_at = ? WHERE id = ?", JSON.stringify(explained), Date.now(), ch.id);
    this.sql.exec("UPDATE tasks SET status = 'conflict', updated_at = ? WHERE id = ?", Date.now(), ch.task_id);
    this.emit("change.conflict", {
      change: ch.id, task: ch.task_id, to: ch.agent_id,
      data: { conflicts: explained.map((c) => ({ path: c.path, kind: c.kind, hunks: c.hunks.length, causedBy: c.causedBy.map((x) => `#${x.change} ${x.title} (${x.agentName})`) })), advice: "Call sync_workspace to see the conflicting hunks, then call it again with resolutions." },
    });
  }

  /**
   * Merge main into a task's workspace. Without resolutions this reports
   * conflicts (with base/ours/theirs hunks and the change that caused each).
   * With resolutions, it writes the merge commit to the workspace and, if the
   * task has a change in flight, puts it back in line.
   */
  private async sync(actor: Agent, target: { taskId?: number; changeId?: number }, resolutions?: Record<string, string | null>) {
    const open = target.taskId ? this.sql.exec("SELECT id FROM changes WHERE task_id = ? AND status NOT IN ('merged','abandoned')", target.taskId).toArray()[0] : undefined;
    const ch = target.changeId ? this.change(target.changeId) : open ? this.change(open.id as number) : null;
    if (ch?.status === "merging") throw new HttpError(409, "this change is being merged right now; wait for the result");
    const taskId = ch?.task_id ?? target.taskId!;
    const task = this.task(taskId);
    if (task.assignee !== actor.id && actor.id !== "admin") throw new HttpError(403, "not your task");
    if (!task.workspace) throw new HttpError(400, "task has no workspace yet; claim it first");
    const wsRow = this.sql.exec("SELECT * FROM workspaces WHERE name = ?", task.workspace).one() as any;
    const wsRemote = this.remote(task.workspace, await this.token(task.workspace, "write"));
    const w = await Workspace.open(wsRemote);
    const ours = (await w.head())!;
    const main = await w.fetchFrom("main", await this.mainRemote("read"));
    if (await w.isAncestor(main, ours)) return { status: "up-to-date", head: ours };
    const result = await w.merge(ours, main, resolutions ?? {});
    if (!result.tree) {
      const conflicts = this.explain(result.conflicts, wsRow.base_version ?? 0);
      if (!resolutions) {
        this.emit("workspace.conflict", {
          actor: actor.id, task: taskId, change: ch?.id ?? null, to: task.assignee,
          data: { conflicts: conflicts.map((c) => ({ path: c.path, kind: c.kind, hunks: c.hunks.length, causedBy: c.causedBy.map((x) => `#${x.change} ${x.title} (${x.agentName})`) })) },
        });
      }
      return {
        status: "conflict",
        conflicts,
        instructions: "For each path, write the full merged file content and call again with resolutions: { path: content }. Use null to delete a file.",
      };
    }
    const author = actor.id === "admin" ? { name: "admin", email: "admin@loom.dev" } : { name: actor.name, email: `${actor.id}@agents.loom.dev` };
    const commit = await w.commit(result.tree, [ours, main], `Merge main into workspace${resolutions ? " (conflicts resolved)" : ""}`, author);
    await w.push(wsRemote, commit);
    this.sql.exec("UPDATE workspaces SET base_commit = ?, base_version = ? WHERE name = ?", main, this.mainVersion, task.workspace);
    this.emit("workspace.synced", { actor: actor.id, change: ch?.id ?? null, task: taskId, data: { commit, resolved: Object.keys(resolutions ?? {}) } });
    if (ch && !["merged", "merging"].includes(this.change(ch.id).status)) {
      this.sql.exec("UPDATE changes SET base_version = ? WHERE id = ?", this.mainVersion, ch.id);
      this.sql.exec("UPDATE tasks SET status = 'in_review' WHERE id = ?", taskId);
      const owner = actor.id === "admin" ? { id: ch.agent_id, name: this.agentName(ch.agent_id)!, role: "builder" as Role } : actor;
      await this.updateChange(owner, ch.id, { summary: ch.summary });
    }
    return { status: "synced", head: commit, change: ch ? this.change(ch.id) : null };
  }

  // ── steering: how humans intervene ───────────────────────────────────────

  private directive(actor: Agent, body: { to?: string; body: string; taskId?: number }) {
    if (!body.body) throw new HttpError(400, "body is required");
    const e = this.emit("directive", { actor: actor.id, to: body.to ?? null, task: body.taskId ?? null, data: { body: body.body, from: actor.name } });
    return { seq: e.seq };
  }

  private pause(actor: Agent, agentId: string, reason?: string) {
    const why = `${reason || "paused"} (by ${actor.name})`;
    this.sql.exec("UPDATE agents SET paused = ? WHERE id = ?", why, agentId);
    this.emit("agent.paused", { actor: actor.id, to: agentId, data: { reason: why } });
    return { ok: true };
  }

  private resume(actor: Agent, agentId: string) {
    this.sql.exec("UPDATE agents SET paused = NULL WHERE id = ?", agentId);
    this.emit("agent.resumed", { actor: actor.id, to: agentId, data: {} });
    return { ok: true };
  }

  private freeze(actor: Agent, reason?: string) {
    this.setMeta("frozen", `${reason || "frozen"} (by ${actor.name})`);
    this.emit("main.frozen", { actor: actor.id, data: { reason: reason ?? "" } });
    return { frozen: true };
  }

  private async unfreeze(actor: Agent) {
    this.sql.exec("DELETE FROM meta WHERE key = 'frozen'");
    this.emit("main.unfrozen", { actor: actor.id, data: {} });
    await this.ctx.storage.setAlarm(Date.now());
    return { frozen: false };
  }

  /** Hand a task to a specific agent (or to nobody). The workspace and context go with it. */
  private assign(actor: Agent, taskId: number, agentId: string | null, note?: string) {
    const task = this.task(taskId);
    this.sql.exec("UPDATE tasks SET assignee = ?, status = CASE WHEN ? IS NULL AND status = 'claimed' THEN 'open' ELSE status END, updated_at = ? WHERE id = ?", agentId, agentId, Date.now(), taskId);
    if (task.workspace) this.sql.exec("UPDATE workspaces SET agent_id = ? WHERE name = ?", agentId, task.workspace);
    this.sql.exec("UPDATE intents SET agent_id = ? WHERE task_id = ? AND released_at IS NULL", agentId, taskId);
    this.sql.exec("UPDATE changes SET agent_id = ? WHERE task_id = ? AND status NOT IN ('merged','abandoned')", agentId, taskId);
    this.emit("task.assigned", { actor: actor.id, task: taskId, to: agentId, data: { from: task.assignee, to: agentId, note: note ?? "" } });
    if (task.assignee && task.assignee !== agentId) this.emit("task.unassigned", { actor: actor.id, task: taskId, to: task.assignee, data: { note: note ?? "" } });
    return this.task(taskId);
  }

  private protect(actor: Agent, paths: string[]) {
    this.setMeta("protected_paths", JSON.stringify(paths.map(normalizePattern)));
    this.emit("paths.protected", { actor: actor.id, data: { paths: this.protectedPaths } });
    return { protectedPaths: this.protectedPaths };
  }

  // ── jev: the humans' delegate ────────────────────────────────────────────

  private get delegateConfig(): DelegateConfig {
    const raw = this.meta("delegate");
    if (!raw) return DEFAULT_DELEGATE;
    const cfg = JSON.parse(raw);
    return { ...DEFAULT_DELEGATE, ...cfg, questions: { ...DEFAULT_DELEGATE.questions, ...cfg.questions }, approvals: { ...DEFAULT_DELEGATE.approvals, ...cfg.approvals } };
  }

  private delegateActor(): Agent {
    return { id: DELEGATE_ID, name: this.delegateConfig.name, role: "human" };
  }

  private async configureDelegate(actor: Agent, body: Partial<DelegateConfig>) {
    if (actor.id === DELEGATE_ID) throw new HttpError(403, "the delegate can't change its own brief");
    const cfg: DelegateConfig = { ...this.delegateConfig, ...body };
    cfg.questions = { ...this.delegateConfig.questions, ...(body.questions ?? {}) };
    cfg.approvals = { ...this.delegateConfig.approvals, ...(body.approvals ?? {}) };
    this.setMeta("delegate", JSON.stringify(cfg));
    // jev is a member like any other, so its decisions are attributed to it.
    this.sql.exec("INSERT OR IGNORE INTO agents (id, name, role, key_hash, created_at, last_seen) VALUES (?, ?, 'human', ?, ?, ?)",
      DELEGATE_ID, cfg.name, `delegate:${randomId(16)}`, Date.now(), Date.now());
    this.sql.exec("UPDATE agents SET name = ? WHERE id = ?", cfg.name, DELEGATE_ID);
    this.emit("delegate.configured", { actor: actor.id, data: { enabled: cfg.enabled, name: cfg.name, questions: cfg.questions, approvals: cfg.approvals, rules: cfg.rules.length } });
    return cfg;
  }

  /** Let jev act on an event if its brief covers it; otherwise say why a human is needed. */
  private async delegateOn(e: LoomEvent) {
    const cfg = this.delegateConfig;
    if (!cfg.enabled) return;
    const jev = this.delegateActor();
    this.sql.exec("UPDATE agents SET last_seen = ? WHERE id = ?", Date.now(), DELEGATE_ID);

    if (e.type === "question.asked" && e.data.audience === "humans") {
      const t = this.thread(e.data.thread);
      if (t.status !== "open") return;
      const task = t.task_id ? this.task(t.task_id) : null;
      const v = await decideQuestion(cfg, {
        question: e.data.body,
        options: t.options,
        task: task ? `#${task.id} ${task.title}: ${task.description ?? ""}` : "",
      }, this.judge);
      if (this.thread(t.id).status !== "open") return; // a human got there first
      if (v.act) {
        this.post(jev, t.id, v.answer);
        this.emit("delegate.decided", { actor: DELEGATE_ID, task: t.task_id, data: { thread: t.id, kind: "question", via: v.via, decision: v.answer, scores: v.scores ?? null } });
      } else this.escalate(t.id, null, t.task_id, v.reason, v.scores);
      return;
    }

    const changeId = e.change_id;
    if (!changeId) return;
    if (e.type === "review.submitted" && e.data.verdict !== "approve") return;
    const ch = this.change(changeId);
    if (ch.status !== "review") return;
    const guarded = this.guardedFiles(ch.files);
    if (!guarded.length) return;
    const reviews = this.sql.exec("SELECT r.reviewer, r.verdict, a.role FROM reviews r LEFT JOIN agents a ON a.id = r.reviewer WHERE r.change_id = ? AND r.head = ?", changeId, ch.head).toArray();
    if (reviews.some((r) => r.reviewer === DELEGATE_ID)) return;
    if (reviews.some((r) => r.verdict === "request_changes")) return;
    const agentApprovals = reviews.filter((r) => r.verdict === "approve" && r.role !== "human").length;
    const detail = await this.changeDetail(changeId);
    const v = await decideApproval(cfg, {
      guarded, agentApprovals, undeclared: ch.undeclared,
      title: ch.title, summary: ch.summary ?? "",
      intent: detail.intents.map((i: any) => `${i.description} (${i.paths.join(", ")})`).join("; "),
      patch: detail.patch,
    }, this.judge);
    if (this.change(changeId).head !== ch.head || this.change(changeId).status !== "review") return; // moved on meanwhile
    if (v.act) {
      await this.review(jev, changeId, { verdict: "approve", body: v.answer });
      this.emit("delegate.decided", { actor: DELEGATE_ID, change: changeId, task: ch.task_id, data: { kind: "approval", via: v.via, decision: v.answer, scores: v.scores ?? null } });
    } else if (v.reason !== "waiting for an agent review first") {
      this.escalate(null, changeId, ch.task_id, v.reason, v.scores);
    }
  }

  private escalated = new Set<string>();
  private get judge() {
    return { apiKey: this.env.TYPESAFE_API_KEY, url: this.env.TYPESAFE_URL };
  }

  private escalate(threadId: number | null, changeId: number | null, taskId: number | null, reason: string, scores?: Record<string, number>) {
    const key = `${threadId}:${changeId}:${changeId ? this.change(changeId).head : ""}`;
    if (this.escalated.has(key)) return;
    this.escalated.add(key);
    if (threadId) this.sql.exec("UPDATE threads SET escalated = ? WHERE id = ?", reason, threadId);
    this.emit("delegate.escalated", { actor: DELEGATE_ID, task: taskId, change: changeId, data: { thread: threadId, reason, scores: scores ?? null } });
  }

  // ── proposals: agents settle overlaps between themselves ────────────────

  /**
   * Propose how to resolve an overlap with another agent's task.
   *   split: each side keeps only the paths listed for it (intents are rewritten)
   *   order: one task lands first; the other's change waits in the queue for it
   */
  private propose(actor: Agent, body: { taskId: number; theirTaskId: number; kind: "split" | "order"; mine?: string[]; theirs?: string[]; first?: "me" | "you"; body?: string }) {
    const mine = this.task(body.taskId), theirs = this.task(body.theirTaskId);
    if (mine.assignee !== actor.id && actor.role !== "human") throw new HttpError(403, `task ${body.taskId} is not yours`);
    if (!["split", "order"].includes(body.kind)) throw new HttpError(400, "kind must be split or order");
    if (body.kind === "split" && (!body.mine?.length || !body.theirs?.length)) throw new HttpError(400, "a split needs mine and theirs paths");
    const terms = { kind: body.kind, taskId: body.taskId, theirTaskId: body.theirTaskId, mine: body.mine ?? [], theirs: body.theirs ?? [], first: body.first ?? "me" };
    const summary = body.kind === "split"
      ? `Split: task #${mine.id} keeps ${terms.mine.join(", ")}; task #${theirs.id} keeps ${terms.theirs.join(", ")}`
      : `Order: task #${terms.first === "me" ? mine.id : theirs.id} lands first, then #${terms.first === "me" ? theirs.id : mine.id}`;
    const t = this.openThread(actor, { silent: true, kind: "discussion", taskId: body.taskId, title: summary, body: body.body ? `${summary}\n\n${body.body}` : summary, to: theirs.assignee ?? undefined });
    this.sql.exec("UPDATE threads SET kind = 'proposal', terms = ? WHERE id = ?", JSON.stringify(terms), t.id);
    this.emit("proposal.made", { actor: actor.id, to: theirs.assignee, task: body.taskId, data: { thread: t.id, summary, terms } });
    return this.thread(t.id);
  }

  private settle(actor: Agent, threadId: number, accept: boolean, text?: string) {
    const t = this.thread(threadId);
    if (t.kind !== "proposal" || t.status !== "open") throw new HttpError(409, "not an open proposal");
    const terms = JSON.parse(t.terms);
    const other = this.task(terms.theirTaskId);
    if (other.assignee !== actor.id && actor.role !== "human") throw new HttpError(403, "only the other task's agent (or a human) can answer this proposal");
    if (text) this.post(actor, threadId, text);
    this.sql.exec("UPDATE threads SET status = ?, updated_at = ? WHERE id = ?", accept ? "accepted" : "rejected", Date.now(), threadId);
    if (accept) {
      const now = Date.now();
      if (terms.kind === "split") {
        for (const [taskId, paths] of [[terms.taskId, terms.mine], [terms.theirTaskId, terms.theirs]] as [number, string[]][]) {
          const owner = this.task(taskId).assignee;
          this.sql.exec("UPDATE intents SET released_at = ? WHERE task_id = ? AND released_at IS NULL", now, taskId);
          this.sql.exec("INSERT INTO intents (agent_id, task_id, paths, description, created_at) VALUES (?, ?, ?, ?, ?)",
            owner, taskId, JSON.stringify(paths.map(normalizePattern)), `agreed split (proposal #${threadId})`, now);
        }
      } else {
        const [first, second] = terms.first === "me" ? [terms.taskId, terms.theirTaskId] : [terms.theirTaskId, terms.taskId];
        this.sql.exec("UPDATE tasks SET waits_for = ? WHERE id = ?", first, second);
      }
    }
    this.emit(accept ? "proposal.accepted" : "proposal.rejected", { actor: actor.id, to: t.created_by, task: terms.taskId, data: { thread: threadId, summary: t.title, reason: text ?? "" } });
    return this.thread(threadId);
  }

  // ── threads: discussions and questions, for agents and humans alike ────

  /**
   * Open a thread anchored to a task, a change, or a file and line. kind
   * "question" with to = "humans" (or an agent id) asks for an answer; a
   * blocking question parks the task until someone answers.
   */
  private openThread(actor: Agent, body: { silent?: boolean; kind?: "discussion" | "question" | "contract"; taskId?: number; changeId?: number; path?: string; line?: number; title?: string; body: string; to?: string; blocking?: boolean; options?: unknown }) {
    if (!body.body) throw new HttpError(400, "body is required");
    const kind = body.kind ?? "discussion";
    const taskId = body.taskId ?? (body.changeId ? this.change(body.changeId).task_id : null);
    const now = Date.now();
    const blocking = kind === "question" && !!body.blocking && !!taskId;
    const prev = blocking ? this.task(taskId!).status : null;
    const options = kind === "question" ? normalizeOptions(body.options) : null;
    const row = this.sql
      .exec(`INSERT INTO threads (kind, task_id, change_id, path, line, title, created_by, to_agent, blocking, prev_task_status, options, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        kind, taskId, body.changeId ?? null, body.path ?? null, body.line ?? null, body.title ?? body.body.split("\n")[0].slice(0, 80),
        actor.id, body.to ?? null, blocking ? 1 : 0, prev, options ? JSON.stringify(options) : null, now, now)
      .one();
    const id = row.id as number;
    this.sql.exec("INSERT INTO posts (thread_id, author, body, created_at) VALUES (?, ?, ?, ?)", id, actor.id, body.body, now);
    if (blocking) this.sql.exec("UPDATE tasks SET status = 'blocked', updated_at = ? WHERE id = ?", now, taskId);
    const to = body.to && body.to !== "humans" ? body.to : null;
    if (!body.silent) this.emit(kind === "question" ? "question.asked" : kind === "contract" ? "contract.published" : "thread.opened", {
      actor: actor.id, task: taskId, change: body.changeId ?? null, to,
      data: { thread: id, title: body.title ?? null, body: body.body, path: body.path ?? null, line: body.line ?? null, audience: body.to ?? "everyone", blocking, options },
    });
    return this.thread(id);
  }

  private post(actor: Agent, threadId: number, text: string) {
    if (!text) throw new HttpError(400, "body is required");
    const t = this.thread(threadId);
    this.sql.exec("INSERT INTO posts (thread_id, author, body, created_at) VALUES (?, ?, ?, ?)", threadId, actor.id, text, Date.now());
    this.sql.exec("UPDATE threads SET updated_at = ? WHERE id = ?", Date.now(), threadId);
    // Everyone already in the thread hears about the reply.
    const participants = new Set<string>([t.created_by, ...t.posts.map((p: any) => p.author)]);
    participants.delete(actor.id);
    this.emit("thread.reply", { actor: actor.id, task: t.task_id, change: t.change_id, data: { thread: threadId, body: text, participants: [...participants] } });
    for (const p of participants) this.emit("thread.reply.notify", { actor: actor.id, to: p, task: t.task_id, data: { thread: threadId, body: text } });
    // An answer from someone other than the asker settles a question.
    if (t.kind === "question" && t.status === "open" && actor.id !== t.created_by) this.answer(t, actor, text);
    return this.thread(threadId);
  }

  private answer(t: any, actor: Agent, text: string) {
    this.sql.exec("UPDATE threads SET status = 'answered', updated_at = ? WHERE id = ?", Date.now(), t.id);
    if (t.blocking && t.task_id) {
      this.sql.exec("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND status = 'blocked'", t.prev_task_status ?? "claimed", Date.now(), t.task_id);
    }
    this.emit("question.answered", { actor: actor.id, to: t.created_by, task: t.task_id, data: { thread: t.id, question: t.title, answer: text, unblocked: !!t.blocking } });
  }

  private resolveThread(actor: Agent, threadId: number, text?: string) {
    const t = this.thread(threadId);
    if (text) this.post(actor, threadId, text);
    if (t.kind === "question" && t.status === "open" && !text) this.answer(t, actor, "(closed without an answer)");
    this.sql.exec("UPDATE threads SET status = 'resolved', updated_at = ? WHERE id = ?", Date.now(), threadId);
    this.emit("thread.resolved", { actor: actor.id, task: t.task_id, data: { thread: threadId } });
    return this.thread(threadId);
  }

  private thread(id: number) {
    const t = this.sql.exec("SELECT * FROM threads WHERE id = ?", id).toArray()[0];
    if (!t) throw new HttpError(404, `thread ${id} not found`);
    const posts = this.sql.exec("SELECT * FROM posts WHERE thread_id = ? ORDER BY id", id).toArray().map((p) => ({ ...p, authorName: this.agentName(p.author as string) }));
    return { ...t, blocking: !!t.blocking, options: t.options ? JSON.parse(t.options as string) : null, createdByName: this.agentName(t.created_by as string), posts } as any;
  }

  private threads(q: URLSearchParams) {
    const where: string[] = [];
    const args: SqlStorageValue[] = [];
    for (const [param, col] of [["task", "task_id"], ["change", "change_id"], ["path", "path"], ["status", "status"], ["kind", "kind"]] as const) {
      const v = q.get(param);
      if (v !== null) { where.push(`${col} = ?`); args.push(param === "task" || param === "change" ? Number(v) : v); }
    }
    const rows = this.sql.exec(`SELECT id FROM threads ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY updated_at DESC LIMIT 100`, ...args).toArray();
    return rows.map((r) => this.thread(r.id as number));
  }

  // ── messages, events, state ─────────────────────────────────────────────

  private message(actor: Agent, body: { to?: string; taskId?: number; body: string }) {
    if (!body.body) throw new HttpError(400, "body is required");
    const e = this.emit("message", { actor: actor.id, to: body.to ?? null, task: body.taskId ?? null, data: { body: body.body, from: actor.name } });
    return { seq: e.seq };
  }

  private inbox(agentId: string) {
    return this.rowsToEvents(this.sql.exec("SELECT * FROM events WHERE to_agent = ? ORDER BY seq DESC LIMIT 20", agentId).toArray());
  }

  private async events(after: number, wait: number, agent: string | null) {
    const read = () =>
      this.rowsToEvents(this.sql.exec("SELECT * FROM events WHERE seq > ? AND (? IS NULL OR to_agent IS NULL OR to_agent = ?) ORDER BY seq LIMIT 200", after, agent, agent).toArray());
    let rows = read();
    if (!rows.length && wait > 0) {
      await new Promise<void>((res) => {
        const t = setTimeout(res, Math.min(wait, 25) * 1000);
        this.waiters.add(() => { clearTimeout(t); res(); });
      });
      rows = read();
    }
    return { events: rows, cursor: rows.length ? rows[rows.length - 1].seq : after };
  }

  private async handoff(taskId: number) {
    const task = this.task(taskId);
    const changes = this.sql.exec("SELECT id FROM changes WHERE task_id = ? ORDER BY id", taskId).toArray();
    return {
      task,
      intents: this.sql.exec("SELECT * FROM intents WHERE task_id = ? ORDER BY id", taskId).toArray().map((r) => ({ ...r, paths: JSON.parse(r.paths as string) })),
      changes: await Promise.all(changes.map((c) => this.changeDetail(c.id as number))),
      history: this.rowsToEvents(this.sql.exec("SELECT * FROM events WHERE task_id = ? ORDER BY seq", taskId).toArray()),
    };
  }

  private state() {
    const agents = this.sql.exec("SELECT id, name, role, paused, created_at, last_seen FROM agents ORDER BY created_at").toArray();
    const tasks = this.sql.exec("SELECT * FROM tasks ORDER BY id").toArray().map((t) => ({ ...t, depends_on: JSON.parse(t.depends_on as string) }));
    const changes = this.sql.exec("SELECT * FROM changes ORDER BY id").toArray().map((c) => ({ ...c, files: JSON.parse(c.files as string), undeclared: JSON.parse(c.undeclared as string), conflicts: c.conflicts ? JSON.parse(c.conflicts as string) : null }));
    const reviews = this.sql.exec("SELECT id, change_id, reviewer, verdict, body, created_at FROM reviews ORDER BY id").toArray();
    const events = this.rowsToEvents(this.sql.exec("SELECT * FROM events ORDER BY seq DESC LIMIT 150").toArray()).reverse();
    return {
      delegate: { ...this.delegateConfig, id: DELEGATE_ID, jevConnected: !!this.env.TYPESAFE_API_KEY },
      project: { name: this.project, description: this.meta("description"), frozen: this.meta("frozen"), protectedPaths: this.protectedPaths, mainHead: this.meta("main_head"), mainVersion: this.mainVersion, requiredApprovals: this.requiredApprovals, remote: this.remoteUrl(this.mainRepo) },
      agents, tasks, intents: this.activeIntents(), changes, reviews, events,
      threads: this.sql.exec("SELECT id FROM threads WHERE status = 'open' OR updated_at > ? ORDER BY updated_at DESC LIMIT 50", Date.now() - 3600_000).toArray().map((r) => this.thread(r.id as number)),
    };
  }

  private acceptSocket(req: Request): Response {
    if (req.headers.get("upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].send(JSON.stringify({ kind: "state", state: this.state() }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
    if (msg === "state") ws.send(JSON.stringify({ kind: "state", state: this.state() }));
  }
}
