// ProjectCoordinator: one Durable Object per project. It is the single place
// where agents meet: it hands out isolated workspaces (Artifacts forks),
// tracks what every agent intends to touch, runs review, and serializes merges
// into main through a queue. Main is only ever written by this object.

import { DurableObject } from "cloudflare:workers";
import { Workspace, diffFlat, unifiedDiff, type FileConflict, type FileChange, type Remote } from "./gitops";
import { anyOverlap, matches, normalizePattern } from "./paths";
import { makeStore, type RepoStore } from "./store";
import type { Env } from "./env";
import { DEFAULT_DELEGATE, decideApproval, decideDispute, decideQuestion, normalizeOptions, type DelegateConfig } from "./delegate";
import { PRESENT_MS, sameQuestion, similarity, type Decision } from "./memory";
import { folderOf, symbolsTouched, type Candidate } from "./familiarity";
import { zip } from "./zip";

const TOKEN_TTL = 6 * 3600;
const DELEGATE_ID = "delegate";
const MERGE_IDENTITY = { name: "Loom merge queue", email: "merge-queue@loom.dev" };
/** Project-wide events every agent hears about, whatever it is working on. */
const STEERING = new Set(["directive", "main.frozen", "main.unfrozen", "paths.protected", "delegate.configured"]);
/** Events a person might care about, shown on the overview instead of the full stream. */
const NOTABLE = ["change.conflict", "dispute.opened", "dispute.ruled", "delegate.escalated", "delegate.decided", "directive", "main.frozen", "main.unfrozen",
  "agent.paused", "agent.resumed", "decision.recorded", "question.asked", "question.answered", "consult.requested", "merge.retry", "task.reassigned", "task.assigned",
  "paths.protected", "proposal.made", "proposal.accepted", "proposal.rejected", "collision.forecast", "memory.recalled", "contract.published"];
/** Most queued changes merged together in one pass of the queue. */
const CHATTER = new Set(["collision.forecast", "memory.recalled", "consult.requested", "task.assigned"]);
const CHATTER_LIMIT = 20;
const MERGE_BATCH = 8;

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
  /** Long-polls waiting for events; each is woken only by events it would receive. */
  private waiters = new Set<{ wants: (e: LoomEvent) => boolean; wake: () => void }>();
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
      "ALTER TABLE tasks ADD COLUMN related TEXT",
      "ALTER TABLE changes ADD COLUMN symbols TEXT",
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
      CREATE TABLE IF NOT EXISTS decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, question TEXT, decision TEXT NOT NULL,
        by TEXT, paths TEXT DEFAULT '[]', task_id INTEGER, change_id INTEGER, thread_id INTEGER,
        created_at INTEGER, retired_at INTEGER);
      CREATE TABLE IF NOT EXISTS consult_hints (a TEXT, b TEXT, path TEXT, PRIMARY KEY (a, b, path));
      CREATE TABLE IF NOT EXISTS familiarity (
        agent_id TEXT, path TEXT, symbol TEXT, kind TEXT, n INTEGER, last_at INTEGER,
        PRIMARY KEY (agent_id, path, symbol, kind));
      CREATE INDEX IF NOT EXISTS familiarity_path ON familiarity (path);
      CREATE TABLE IF NOT EXISTS review_requests (
        change_id INTEGER, reviewer TEXT, requested_by TEXT, reason TEXT, status TEXT, created_at INTEGER, done_at INTEGER,
        PRIMARY KEY (change_id, reviewer));
      CREATE INDEX IF NOT EXISTS review_requests_open ON review_requests (status, reviewer);
      CREATE INDEX IF NOT EXISTS events_actor ON events (actor, ts);
      CREATE INDEX IF NOT EXISTS events_ts ON events (ts);
      CREATE INDEX IF NOT EXISTS events_to ON events (to_agent, seq);
      CREATE INDEX IF NOT EXISTS events_type ON events (type, seq);
      CREATE INDEX IF NOT EXISTS events_change ON events (change_id, type);
      CREATE INDEX IF NOT EXISTS changes_status ON changes (status);
      CREATE INDEX IF NOT EXISTS changes_task ON changes (task_id);
      CREATE INDEX IF NOT EXISTS tasks_assignee ON tasks (assignee);
      CREATE INDEX IF NOT EXISTS intents_live ON intents (released_at, task_id);
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
    for (const w of this.waiters) {
      if (w.wants(event)) { this.waiters.delete(w); w.wake(); }
    }
    if (["question.asked", "approval.needs_human", "review.submitted", "dispute.ready"].includes(type) && e.actor !== DELEGATE_ID) {
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
    return { ...t, depends_on: JSON.parse(t.depends_on as string), related: JSON.parse((t.related as string) ?? "[]") } as any;
  }
  private change(id: number) {
    const c = this.sql.exec("SELECT * FROM changes WHERE id = ?", id).toArray()[0];
    if (!c) throw new HttpError(404, `change ${id} not found`);
    return {
      ...c,
      files: JSON.parse(c.files as string),
      undeclared: JSON.parse(c.undeclared as string),
      conflicts: c.conflicts ? JSON.parse(c.conflicts as string) : null,
      symbols: c.symbols ? JSON.parse(c.symbols as string) : {},
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
      if (a === "overview") return json(this.overview());
      if (a === "search") return json(this.search(url.searchParams));
      if (a === "agents" && b) return json(this.profile(b));
      if (a === "events") return json(await this.events(Number(url.searchParams.get("after") ?? 0), Number(url.searchParams.get("wait") ?? 0), url.searchParams.get("agent"), url.searchParams.get("mine") === "1"));
      if (a === "tasks" && b && c === "context") return json(await this.handoff(Number(b)));
      if (a === "changes" && b && c === "reviewers") return json({ candidates: this.reviewerCandidates(Number(b), Number(url.searchParams.get("limit") ?? 5)), requested: this.reviewRequests(Number(b)) });
      if (a === "changes" && b) return json(await this.changeDetail(Number(b)));
      if (a === "activity") return json(this.activity(url.searchParams.get("agent"), url.searchParams.get("range")));
      if (a === "files") return json(await this.readFiles(url.searchParams));
      if (a === "archive") return await this.archive(url.searchParams);
      if (a === "delegate") return json(this.delegateConfig);
      if (a === "threads" && b) return json(this.thread(Number(b)));
      if (a === "threads") return json(this.threads(url.searchParams));
      if (a === "decisions") return json(this.listDecisions(url.searchParams));
      if (a === "tasks" && b && c === "memory") return json(await this.taskMemory(Number(b)));
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
    if (a === "checkout" && m === "POST") return json(await this.checkout(actor, body));
    if (a === "me") return json({ agent: actor, mainFrozen: this.meta("frozen"), inbox: this.inbox(actor.id) });

    // Human controls. Humans (and the admin) steer; agents can't.
    const ruling = a === "disputes" && c === "rule";
    const deciding = a === "decisions" && m === "POST";
    if (["directives", "pause", "resume", "freeze", "unfreeze", "assign", "protect", "delegate"].includes(c ?? a) || ruling || deciding) {
      if (actor.role !== "human") throw new HttpError(403, "only humans can steer agents");
      if (a === "directives") return json(this.directive(actor, body));
      if (a === "agents" && b && c === "pause") return json(this.pause(actor, b, body.reason));
      if (a === "agents" && b && c === "resume") return json(this.resume(actor, b));
      if (a === "freeze") return json(this.freeze(actor, body.reason));
      if (a === "unfreeze") return json(await this.unfreeze(actor));
      if (a === "tasks" && b && c === "assign") return json(this.assign(actor, Number(b), body.agent ?? null, body.note, body.related));
      if (a === "protect") return json(this.protect(actor, body.paths ?? []));
      if (a === "delegate") return json(await this.configureDelegate(actor, body));
      if (ruling) return json(this.ruleDispute(actor, Number(b), body.for, body.note));
      if (a === "decisions" && !b) return json(this.recordDecision("note", actor, { question: body.question ?? "", decision: body.decision, paths: body.paths ?? [], task: body.taskId ?? null }));
      if (a === "decisions" && b && c === "retire") return json(this.retireDecision(actor, Number(b)));
    }
    // A paused agent can still read, talk and answer, but not change code.
    const talking = ["threads", "messages", "proposals", "consults", "disputes"].includes(a);
    if (actor.paused && !talking) throw new HttpError(423, `you are paused: ${actor.paused}. Wait for a human to resume you; you can still post in threads.`);
    if (a === "tasks" && !b && m === "POST") return json(this.createTask(actor, body));
    if (a === "tasks" && b && c === "claim") return json(await this.claim(actor, Number(b)));
    if (a === "tasks" && b && c === "release") return json(this.releaseTask(actor, Number(b), body.reason));
    if (a === "intents" && !b && m === "POST") return json(await this.declareIntent(actor, body));
    if (a === "intents" && b && m === "DELETE") return json(this.releaseIntent(actor, Number(b)));
    if (a === "workspaces" && b && c === "commit") return json(await this.commitToWorkspace(actor, b, body));
    if (a === "changes" && !b && m === "POST") return json(await this.submitChange(actor, body));
    if (a === "changes" && b && c === "reviewers" && m === "POST") return json(this.requestReviewers(actor, Number(b), body));
    if (a === "changes" && b && c === "reviews") return json(await this.review(actor, Number(b), body));
    if (a === "changes" && b && c === "update") return json(await this.updateChange(actor, Number(b), body));
    if (a === "changes" && b && c === "sync") return json(await this.sync(actor, { changeId: Number(b) }, body.resolutions));
    if (a === "tasks" && b && c === "sync") return json(await this.sync(actor, { taskId: Number(b) }, body.resolutions));
    if (a === "messages" && m === "POST") return json(this.message(actor, body));
    if (a === "threads" && !b && m === "POST") {
      const t = this.openThread(actor, body);
      // Before anyone answers: what the humans already decided that may cover it.
      if (t.kind === "question" && t.to_agent === "humans") return json({ ...t, precedents: this.relevantDecisions(this.threadPaths(t), body.body, 5) });
      return json(t);
    }
    if (a === "proposals" && !b && m === "POST") return json(this.propose(actor, body));
    if (a === "proposals" && b && c === "accept") return json(this.settle(actor, Number(b), true, body.body));
    if (a === "proposals" && b && c === "reject") return json(this.settle(actor, Number(b), false, body.body));
    if (a === "threads" && b && c === "posts") return json(this.post(actor, Number(b), body.body));
    if (a === "threads" && b && c === "resolve") return json(this.resolveThread(actor, Number(b), body.body));
    if (a === "consults" && !b && m === "POST") return json(this.consult(actor, body));
    if (a === "questions" && b === "answer" && m === "POST") return json(this.answerGroup(actor, body.threads ?? [], body.body));
    if (a === "disputes" && !b && m === "POST") return json(this.openDispute(actor, body));
    if (a === "disputes" && b && c === "position") return json(this.statePosition(actor, Number(b), body.position));
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

  private createTask(actor: Agent, body: { title: string; description?: string; dependsOn?: number[]; parent?: number; related?: number[] }) {
    if (!body.title) throw new HttpError(400, "title is required");
    if (body.parent) this.task(body.parent);
    const now = Date.now();
    const row = this.sql
      .exec("INSERT INTO tasks (title, description, depends_on, parent, related, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
        body.title, body.description ?? "", JSON.stringify(body.dependsOn ?? []), body.parent ?? null, JSON.stringify(body.related ?? []), actor.id, now, now)
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
      memory: await this.taskMemory(taskId, actor.id),
    };
  }

  private releaseTask(actor: Agent, taskId: number, reason?: string) {
    this.sql.exec("UPDATE tasks SET assignee = NULL, status = CASE WHEN status = 'claimed' THEN 'open' ELSE status END, updated_at = ? WHERE id = ? AND assignee = ?", Date.now(), taskId, actor.id);
    this.emit("task.released", { actor: actor.id, task: taskId, data: { reason: reason ?? "" } });
    return this.task(taskId);
  }

  // ── intents: say what you'll touch before you touch it ──────────────────

  private async declareIntent(actor: Agent, body: { taskId?: number; paths: string[]; description?: string }) {
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
    const memory = await this.recall(actor, paths, body.taskId ?? null, body.description ?? "");
    const advice = [
      overlaps.length || pending.length ? "Another agent is working in these paths. Message them (send_message) to split the work, or narrow your intent." : "Clear: no one else has declared these paths.",
      memory.decisions.length ? `The humans already decided ${memory.decisions.length} thing(s) here: follow them rather than asking again.` : "",
      memory.consult.length ? `${memory.consult.map((c) => c.agentName).join(", ")} worked on these files before and is still around: consult them (consult_agent) if their reasons matter to you.` : "",
    ].filter(Boolean).join(" ");
    return { intent: id, paths, overlaps, pendingChanges: pending, memory, advice };
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

  /** main, a named workspace, or the workspace behind a change. */
  private repoFor(q: { workspace?: string | null; change?: string | number | null }): { repo: string; label: string } {
    if (q.change) {
      const ch = this.change(Number(q.change));
      return { repo: ch.workspace, label: `change-${ch.id}` };
    }
    if (q.workspace && q.workspace !== this.mainRepo) {
      if (!this.sql.exec("SELECT 1 FROM workspaces WHERE name = ?", q.workspace).toArray().length) throw new HttpError(404, `no workspace ${q.workspace}`);
      return { repo: q.workspace, label: q.workspace };
    }
    return { repo: this.mainRepo, label: "main" };
  }

  /**
   * A read-only clone of main, an agent's workspace, or a change, for anyone on
   * the project: people review locally with their own tools. Writing still goes
   * through a claimed task's workspace, and main only through the merge queue.
   */
  private async checkout(actor: Agent, body: { workspace?: string; change?: number }) {
    const { repo, label } = this.repoFor(body);
    const ttl = 3600;
    const token = await this.store.token(repo, "read", ttl);
    const remote = this.remoteUrl(repo);
    const dir = `${this.project}-${label}`;
    return {
      repo, remote, token, expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
      clone: `git -c http.extraHeader="Authorization: Bearer ${token}" clone ${remote} ${dir}`,
      ...(repo !== this.mainRepo ? { compare: `cd ${dir} && git -c http.extraHeader="Authorization: Bearer ${await this.store.token(this.mainRepo, "read", ttl)}" fetch ${this.remoteUrl(this.mainRepo)} main:loom-main && git diff loom-main...HEAD` } : {}),
      note: "Read-only, valid for an hour. To change code, claim a task: its workspace is yours to push to.",
    };
  }

  /** The files of main, a workspace or a change as a zip. */
  private async archive(q: URLSearchParams) {
    const { repo, label } = this.repoFor({ workspace: q.get("workspace"), change: q.get("change") });
    const w = await Workspace.open(this.remote(repo, await this.token(repo, "read")));
    const flat = await w.flatten(await w.head());
    const files: { path: string; data: Uint8Array }[] = [];
    let size = 0;
    for (const [path, e] of flat) {
      const data = await w.readBytes(e.oid);
      size += data.length;
      if (size > 64 * 1024 * 1024) throw new HttpError(413, "too big to zip here; clone it with git instead");
      files.push({ path: `${this.project}-${label}/${path}`, data });
    }
    return new Response(zip(files), { headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${this.project}-${label}.zip"` } });
  }

  private async readFiles(q: URLSearchParams) {
    const repo = this.repoFor({ workspace: q.get("workspace"), change: q.get("change") }).repo;
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
      .exec(`INSERT INTO changes (task_id, agent_id, workspace, title, summary, head, base, base_version, status, files, undeclared, symbols, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        body.taskId, actor.id, task.workspace, body.title ?? task.title, body.summary ?? "", analysis.head, analysis.base, wsRow.base_version,
        status, JSON.stringify(analysis.files), JSON.stringify(undeclared), JSON.stringify(analysis.symbols), now, now)
      .one();
    const id = row.id as number;
    await this.saveContext(id, actor, body, analysis.patch);
    this.sql.exec("UPDATE tasks SET status = 'in_review', updated_at = ? WHERE id = ?", now, body.taskId);
    this.emit("change.submitted", { actor: actor.id, task: body.taskId, change: id, data: { title: body.title ?? task.title, files: analysis.files, undeclared, status } });
    if (status === "review") this.requestReview(id, actor.id);
    else await this.enqueue(id);
    // Who already knows this code, so the author can ask them to review it.
    return { ...this.change(id), suggestedReviewers: status === "review" ? this.reviewerCandidates(id, 3) : [] };
  }

  private async updateChange(actor: Agent, id: number, body: { summary?: string; context?: any; title?: string }) {
    const ch = this.change(id);
    if (ch.agent_id !== actor.id) throw new HttpError(403, "not your change");
    if (ch.status === "merged" || ch.status === "merging") throw new HttpError(409, `change ${id} is ${ch.status}`);
    const analysis = await this.analyze(ch.workspace);
    // The merge queue may have taken the change while we were analyzing.
    if (["merged", "merging"].includes(this.change(id).status)) throw new HttpError(409, `change ${id} was merged meanwhile`);
    const status = this.requiredApprovals > 0 || this.guardedFiles(analysis.files).length ? "review" : "queued";
    this.sql.exec("UPDATE changes SET head = ?, base = ?, files = ?, undeclared = ?, symbols = ?, status = ?, summary = COALESCE(?, summary), conflicts = NULL, updated_at = ? WHERE id = ?",
      analysis.head, analysis.base, JSON.stringify(analysis.files), JSON.stringify(this.undeclared(ch.task_id, analysis.files)), JSON.stringify(analysis.symbols), status, body.summary ?? null, Date.now(), id);
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
    const symbols: Record<string, string[]> = {};
    for (const f of files) {
      const before = B.get(f.path), after = H.get(f.path);
      const a = before ? await w.readText(before.oid) : null, b = after ? await w.readText(after.oid) : null;
      patch += unifiedDiff(f.path, a, b);
      const names = symbolsTouched(a, b);
      if (names.length) symbols[f.path] = names;
    }
    return { head, base, files, patch, symbols };
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
    this.sql.exec("UPDATE review_requests SET status = 'done', done_at = ? WHERE change_id = ? AND reviewer = ? AND status = 'open'", Date.now(), id, actor.id);
    if (body.verdict !== "comment") this.learn(actor.id, "reviewed", ch.files, ch.symbols);
    if (body.verdict === "request_changes") {
      this.sql.exec("UPDATE changes SET status = 'changes_requested', updated_at = ? WHERE id = ?", Date.now(), id);
      if (actor.role === "human" && body.body) {
        const paths = body.comments?.length ? [...new Set(body.comments.map((x) => x.path))] : (ch.files as FileChange[]).map((f) => f.path);
        this.recordDecision("review", actor, { question: `Change #${id}: ${ch.title}`, decision: body.body, paths, task: ch.task_id, change: id });
      }
    } else if (body.verdict === "approve" && ch.status === "review") {
      await this.maybeEnqueue(id);
    }
    return this.change(id);
  }

  /** Queue a change once it has enough approvals (a human's, if it touches protected paths). */
  private async maybeEnqueue(id: number) {
    const ch = this.change(id);
    if (ch.status !== "review") return;
    const approvers = this.sql.exec("SELECT DISTINCT r.reviewer, a.role FROM reviews r LEFT JOIN agents a ON a.id = r.reviewer WHERE r.change_id = ? AND r.verdict = 'approve' AND r.head = ?", id, ch.head).toArray();
    const humanOk = approvers.some((r) => r.role === "human" || r.reviewer === "admin");
    const guarded = this.guardedFiles(ch.files);
    if (approvers.length >= this.requiredApprovals && (humanOk || !guarded.length)) await this.enqueue(id);
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
        const ids = this.sql.exec(`SELECT c.id FROM changes c JOIN tasks t ON t.id = c.task_id
          WHERE c.status = 'queued' AND c.updated_at <= ? AND (t.waits_for IS NULL OR EXISTS (SELECT 1 FROM tasks w WHERE w.id = t.waits_for AND w.status = 'merged'))
          ORDER BY c.updated_at, c.id LIMIT ?`, Date.now(), MERGE_BATCH).toArray().map((r) => r.id as number);
        if (!ids.length) break;
        await this.mergeBatch(ids);
        if (this.meta("frozen")) break;
      }
    } finally {
      this.merging = false;
    }
    // Retries wait a little; make sure someone comes back for them.
    const retry = this.sql.exec("SELECT MIN(updated_at) AS t FROM changes WHERE status = 'queued'").one().t as number | null;
    if (retry) await this.ctx.storage.setAlarm(Math.max(retry, Date.now() + 100));
  }

  /**
   * Merge a batch of queued changes into main in one pass: fetch main once,
   * fold each change in on top of the previous one (a commit per change, so
   * history stays per change), and push once. A change that conflicts with
   * main or with an earlier change in the batch is routed back to its agent;
   * the rest still land. With many agents this is what keeps the queue moving:
   * the cost of a pass is mostly fetching and pushing main.
   */
  private async mergeBatch(ids: number[]) {
    const now = () => Date.now();
    for (const id of ids) {
      this.sql.exec("UPDATE changes SET status = 'merging', updated_at = ? WHERE id = ?", now(), id);
      this.emit("merge.started", { change: id, task: this.change(id).task_id, data: { batch: ids.length } });
    }
    const landed: { ch: any; before: string; commit: string }[] = [];
    let w: Workspace, mainW: Remote, main: string;
    try {
      mainW = await this.mainRemote("write");
      w = await Workspace.open(mainW);
      main = (await w.head())!;
    } catch (e: any) {
      return this.retryMerge(ids, e);
    }
    let tip = main;
    for (const id of ids) {
      const ch = this.change(id);
      try {
        const head = await w.fetchFrom(`ws${id}`, this.remote(ch.workspace, await this.token(ch.workspace, "read")));
        if (head !== ch.head) {
          // The agent pushed after review. Approval covered a different commit.
          this.sql.exec("UPDATE changes SET status = 'review', head = ?, updated_at = ? WHERE id = ?", head, now(), id);
          this.emit("change.updated", { change: id, task: ch.task_id, data: { head, reason: "workspace moved after approval; review again" } });
          this.requestReview(id, ch.agent_id);
          continue;
        }
        let commit: string;
        if (await w.isAncestor(head, tip)) commit = tip;
        else if (await w.isAncestor(tip, head)) commit = head;
        else {
          const result = await w.merge(tip, head);
          if (!result.tree) { this.recordConflict(ch, result.conflicts); continue; }
          commit = await w.commit(result.tree, [tip, head], `Merge change #${id}: ${ch.title}\n\nTask #${ch.task_id}, by ${this.agentName(ch.agent_id)}.\n\n${ch.summary ?? ""}`.trim(), MERGE_IDENTITY);
        }
        landed.push({ ch, before: tip, commit });
        tip = commit;
      } catch (e: any) {
        await this.retryMerge([id], e);
      }
    }
    if (!landed.length) return;
    try {
      if (tip !== main) await w.push(mainW, tip);
    } catch (e: any) {
      return this.retryMerge(landed.map((l) => l.ch.id), e);
    }
    let version = this.mainVersion;
    for (const { ch, before, commit } of landed) {
      const files = await w.changes(before, commit);
      if (commit !== before) version++;
      const t = now();
      this.sql.exec("UPDATE changes SET status = 'merged', merged_commit = ?, merged_version = ?, updated_at = ? WHERE id = ?", commit, version, t, ch.id);
      this.sql.exec("UPDATE tasks SET status = 'merged', updated_at = ? WHERE id = ?", t, ch.task_id);
      this.sql.exec("UPDATE intents SET released_at = ? WHERE task_id = ? AND released_at IS NULL", t, ch.task_id);
      this.sql.exec("UPDATE workspaces SET status = 'merged' WHERE name = ?", ch.workspace);
      this.setMeta("main_version", String(version));
      this.setMeta("main_head", commit);
      this.emit("change.merged", { actor: ch.agent_id, change: ch.id, task: ch.task_id, data: { commit, version, files, batch: landed.length } });
      this.learn(ch.agent_id, "wrote", files, ch.symbols ?? {});
      this.sql.exec("UPDATE review_requests SET status = 'done', done_at = ? WHERE change_id = ? AND status = 'open'", Date.now(), ch.id);
      this.adviseStale(ch.id, files.map((f) => f.path));
      for (const r of this.sql.exec("SELECT id FROM tasks WHERE waits_for = ?", ch.task_id).toArray()) {
        this.emit("task.unblocked", { task: r.id as number, data: { after: ch.task_id } });
      }
    }
  }

  private async retryMerge(ids: number[], e: any) {
    console.error("merge failed", e);
    for (const id of ids) {
      this.sql.exec("UPDATE changes SET status = 'queued', updated_at = ? WHERE id = ?", Date.now() + 5000, id);
      this.emit("merge.retry", { change: id, task: this.change(id).task_id, data: { error: String(e?.message ?? e) } });
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
    if (!body.to) this.recordDecision("directive", actor, { question: "", decision: body.body, paths: [], task: body.taskId ?? null });
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
  private assign(actor: Agent, taskId: number, agentId: string | null, note?: string, related?: number[]) {
    const task = this.task(taskId);
    if (related?.length) this.sql.exec("UPDATE tasks SET related = ? WHERE id = ?", JSON.stringify([...new Set([...task.related, ...related])]), taskId);
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
    return { ...DEFAULT_DELEGATE, ...cfg, questions: { ...DEFAULT_DELEGATE.questions, ...cfg.questions }, approvals: { ...DEFAULT_DELEGATE.approvals, ...cfg.approvals }, disputes: { ...DEFAULT_DELEGATE.disputes, ...cfg.disputes } };
  }

  private delegateActor(): Agent {
    return { id: DELEGATE_ID, name: this.delegateConfig.name, role: "human" };
  }

  private async configureDelegate(actor: Agent, body: Partial<DelegateConfig>) {
    if (actor.id === DELEGATE_ID) throw new HttpError(403, "the delegate can't change its own brief");
    const cfg: DelegateConfig = { ...this.delegateConfig, ...body };
    cfg.questions = { ...this.delegateConfig.questions, ...(body.questions ?? {}) };
    cfg.approvals = { ...this.delegateConfig.approvals, ...(body.approvals ?? {}) };
    cfg.disputes = { ...this.delegateConfig.disputes, ...(body.disputes ?? {}) };
    this.setMeta("delegate", JSON.stringify(cfg));
    // jev is a member like any other, so its decisions are attributed to it.
    this.sql.exec("INSERT OR IGNORE INTO agents (id, name, role, key_hash, created_at, last_seen) VALUES (?, ?, 'human', ?, ?, ?)",
      DELEGATE_ID, cfg.name, `delegate:${randomId(16)}`, Date.now(), Date.now());
    this.sql.exec("UPDATE agents SET name = ? WHERE id = ?", cfg.name, DELEGATE_ID);
    this.emit("delegate.configured", { actor: actor.id, data: { enabled: cfg.enabled, name: cfg.name, questions: cfg.questions, approvals: cfg.approvals, disputes: cfg.disputes, rules: cfg.rules.length } });
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
        precedents: this.relevantDecisions(this.threadPaths(t), e.data.body),
      }, this.judge);
      if (this.thread(t.id).status !== "open") return; // a human got there first
      if (v.act) {
        // House rules and precedents are already on record; a fresh pick by Jev becomes a decision.
        this.citing = true;
        try { this.post(jev, t.id, v.answer); } finally { this.citing = false; }
        if (v.via === "jev" && v.option) {
          const meaning = t.options?.[v.option];
          this.recordDecision("answer", jev, { question: e.data.body, decision: meaning && meaning !== v.option ? `${v.option}: ${meaning}` : v.option, paths: this.threadPaths(t), task: t.task_id, change: t.change_id, thread: t.id });
        }
        this.emit("delegate.decided", { actor: DELEGATE_ID, task: t.task_id, data: { thread: t.id, kind: "question", via: v.via, decision: v.answer, precedent: v.decision ?? null, scores: v.scores ?? null } });
      } else this.escalate(t.id, null, t.task_id, v.reason, v.scores);
      return;
    }

    if (e.type === "dispute.ready") {
      const t = this.thread(e.data.thread);
      if (t.status !== "open") return;
      const terms = JSON.parse(t.terms);
      const names: Record<string, string> = Object.fromEntries(terms.parties.map((p: string) => [this.agentName(p) ?? p, p]));
      const task = terms.taskId ? this.task(terms.taskId) : null;
      const v = await decideDispute(cfg, {
        question: terms.question,
        positions: Object.fromEntries(Object.entries(names).map(([n, id]) => [n, terms.positions[id]])),
        task: task ? `#${task.id} ${task.title}: ${task.description ?? ""}` : "",
        precedents: this.relevantDecisions(this.threadPaths(t), terms.question),
      }, this.judge);
      if (this.thread(t.id).status !== "open") return;
      if (v.act && v.option && names[v.option]) {
        this.ruleDispute(jev, t.id, names[v.option], v.answer);
        this.emit("delegate.decided", { actor: DELEGATE_ID, task: t.task_id, change: terms.changeId, data: { thread: t.id, kind: "dispute", via: v.via, decision: `Ruled for ${v.option}. ${v.answer}`, scores: v.scores ?? null } });
      } else this.escalate(t.id, null, t.task_id, v.act ? "Jev's ruling didn't match either party" : v.reason, v.scores);
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
    this.emit("delegate.escalated", { actor: DELEGATE_ID, task: taskId, change: changeId, data: { thread: threadId, kind: threadId ? this.thread(threadId).kind : "approval", reason, scores: scores ?? null } });
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

  // ── overview: what a person looks at, whether there are 5 agents or 1000 ──
  //
  // People don't watch agents. The overview is about the work: what needs a
  // person, what is stuck, how the work is flowing, and where in the codebase
  // it is happening. Agents are found by search when someone needs one.

  /** What each agent is doing, derived from what it holds. */
  private agentStates(where = "", ...args: SqlStorageValue[]) {
    const now = Date.now();
    return this.sql.exec(`SELECT a.id, a.name, a.role, a.paused, a.last_seen,
        (SELECT t.id FROM tasks t WHERE t.assignee = a.id AND t.status != 'merged' ORDER BY t.updated_at DESC LIMIT 1) AS task_id,
        (SELECT t.status FROM tasks t WHERE t.assignee = a.id AND t.status != 'merged' ORDER BY t.updated_at DESC LIMIT 1) AS task_status,
        (SELECT t.title FROM tasks t WHERE t.assignee = a.id AND t.status != 'merged' ORDER BY t.updated_at DESC LIMIT 1) AS task_title
      FROM agents a ${where}`, ...args).toArray().map((r) => {
      const quiet = now - (r.last_seen as number) > PRESENT_MS;
      const st = r.task_status as string | null;
      const state = r.paused ? "paused"
        : r.role === "human" || r.id === DELEGATE_ID ? "human"
        : st === "blocked" ? "waiting"
        : st === "conflict" ? "conflict"
        : st && quiet ? "quiet"
        : st ? "working"
        : quiet ? "away" : "idle";
      return { id: r.id as string, name: r.name as string, role: r.role as string, state, lastSeen: r.last_seen as number, task: r.task_id ? { id: r.task_id as number, title: r.task_title as string, status: st } : null };
    });
  }

  // Agent-to-agent chatter is worth watching in a small swarm and noise in a big one.
  private notable(agentCount: number) {
    const types = agentCount > CHATTER_LIMIT ? NOTABLE.filter((t) => !CHATTER.has(t)) : NOTABLE;
    return this.rowsToEvents(this.sql.exec(`SELECT * FROM events WHERE type IN (${types.map(() => "?").join(",")}) ORDER BY seq DESC LIMIT 60`, ...types).toArray());
  }

  private overview() {
    const now = Date.now();
    const agents = this.agentStates();
    const byState: Record<string, number> = {};
    for (const a of agents) if (a.state !== "human") byState[a.state] = (byState[a.state] ?? 0) + 1;
    const taskCounts = Object.fromEntries(this.sql.exec("SELECT status, COUNT(*) AS n FROM tasks GROUP BY status").toArray().map((r) => [r.status, r.n]));
    const changeCounts = Object.fromEntries(this.sql.exec("SELECT status, COUNT(*) AS n FROM changes GROUP BY status").toArray().map((r) => [r.status, r.n]));

    // Flow over the last 30 minutes, per minute.
    const since = now - 30 * 60_000;
    const minute = (ts: number) => Math.floor((ts - since) / 60_000);
    const series = { merged: Array(30).fill(0), conflict: Array(30).fill(0), question: Array(30).fill(0), submitted: Array(30).fill(0) };
    const keyOf: Record<string, keyof typeof series> = { "change.merged": "merged", "change.conflict": "conflict", "question.asked": "question", "change.submitted": "submitted" };
    for (const r of this.sql.exec("SELECT type, ts FROM events WHERE ts > ? AND type IN ('change.merged','change.conflict','question.asked','change.submitted')", since).toArray()) {
      const i = minute(r.ts as number);
      if (i >= 0 && i < 30) series[keyOf[r.type as string]][i]++;
    }
    const lastHour = (type: string) => this.sql.exec("SELECT COUNT(*) AS n FROM events WHERE type = ? AND ts > ?", type, now - 3600_000).one().n as number;
    const mergedHour = lastHour("change.merged"), conflictsHour = lastHour("change.conflict");
    const queued = this.sql.exec("SELECT c.id, c.title, c.agent_id, c.status, c.updated_at, c.task_id FROM changes c WHERE c.status IN ('queued','merging') ORDER BY c.status DESC, c.updated_at, c.id").toArray();
    const waitedFor = (id: number) => (this.sql.exec("SELECT MAX(ts) AS t FROM events WHERE change_id = ? AND type = 'change.queued'", id).one().t as number) ?? now;

    return {
      project: { name: this.project, description: this.meta("description"), frozen: this.meta("frozen"), protectedPaths: this.protectedPaths, mainHead: this.meta("main_head"), mainVersion: this.mainVersion, requiredApprovals: this.requiredApprovals },
      delegate: { ...this.delegateConfig, id: DELEGATE_ID, jevConnected: !!this.env.TYPESAFE_API_KEY },
      health: {
        agents: { total: agents.filter((a) => a.state !== "human").length, byState },
        tasks: taskCounts, changes: changeCounts,
        queue: { depth: queued.length, oldestWaitMs: queued.length ? now - Math.min(...queued.slice(0, 50).map((q) => waitedFor(q.id as number))) : 0 },
        mergedLastHour: mergedHour, conflictsLastHour: conflictsHour,
        conflictRate: mergedHour + conflictsHour ? conflictsHour / (mergedHour + conflictsHour) : 0,
        series,
      },
      attention: this.attention(agents),
      areas: this.areas(),
      queue: queued.slice(0, 12).map((q) => ({ id: q.id, title: q.title, agent: q.agent_id, agentName: this.agentName(q.agent_id as string), status: q.status, waitingMs: now - waitedFor(q.id as number) })),
      recentlyMerged: this.sql.exec("SELECT id, title, agent_id, merged_version, updated_at FROM changes WHERE status = 'merged' ORDER BY updated_at DESC LIMIT 8").toArray()
        .map((c) => ({ id: c.id, title: c.title, agent: c.agent_id, agentName: this.agentName(c.agent_id as string), version: c.merged_version, at: c.updated_at })),
      decisions: this.decisionRows("retired_at IS NULL ORDER BY id DESC LIMIT 30"),
      discussions: this.sql.exec("SELECT id FROM threads WHERE kind IN ('discussion','contract') AND status = 'open' ORDER BY updated_at DESC LIMIT 6").toArray().map((r) => this.thread(r.id as number)),
      notable: this.notable(agents.length),
      names: Object.fromEntries(this.sql.exec("SELECT id, name FROM agents WHERE id IN (SELECT DISTINCT actor FROM events WHERE seq > (SELECT COALESCE(MAX(seq), 0) - 400 FROM events) UNION SELECT DISTINCT to_agent FROM events WHERE seq > (SELECT COALESCE(MAX(seq), 0) - 400 FROM events)) OR role = 'human'").toArray().map((r) => [r.id, r.name])),
      lastSeq: (this.sql.exec("SELECT MAX(seq) AS s FROM events").one().s as number) ?? 0,
    };
  }

  /** What needs a person, then what is stuck. Similar questions are grouped. */
  private attention(agents: ReturnType<ProjectCoordinator["agentStates"]>) {
    const now = Date.now();
    const items: any[] = [];
    const open = this.sql.exec("SELECT id FROM threads WHERE status = 'open' AND kind IN ('question','dispute','proposal') ORDER BY created_at").toArray().map((r) => this.thread(r.id as number));
    const groups = new Map<string, any>();
    for (const t of open.filter((t) => t.kind === "question" && t.to_agent === "humans")) {
      const q = (t.posts[0]?.body ?? t.title) as string;
      const key = q.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const g = groups.get(key) ?? { kind: "question", question: q, options: t.options, threads: [], askers: [], blocking: 0, escalated: t.escalated, since: t.created_at };
      g.threads.push(t.id);
      g.askers.push(t.created_by);
      if (t.blocking) g.blocking++;
      g.escalated = g.escalated ?? t.escalated;
      groups.set(key, g);
    }
    items.push(...groups.values());
    for (const t of open.filter((t) => t.kind === "dispute")) {
      const terms = JSON.parse(t.terms);
      items.push({ kind: "dispute", thread: t.id, question: terms.question, parties: terms.parties, positions: terms.positions, change: terms.changeId, escalated: t.escalated, since: t.created_at });
    }
    const asked = new Set(this.sql.exec("SELECT DISTINCT change_id FROM events WHERE type = 'approval.needs_human'").toArray().map((r) => r.change_id));
    for (const c of this.sql.exec("SELECT id, title, agent_id, files, updated_at FROM changes WHERE status = 'review'").toArray()) {
      if (!asked.has(c.id)) continue;
      const files = (JSON.parse(c.files as string) as FileChange[]).map((f) => f.path);
      if (!this.guardedFiles(files.map((path) => ({ path } as FileChange))).length) continue;
      const why = this.sql.exec("SELECT data FROM events WHERE type = 'delegate.escalated' AND change_id = ? ORDER BY seq DESC LIMIT 1", c.id).toArray()[0];
      items.push({ kind: "approval", change: c.id, title: c.title, agent: c.agent_id, files, escalated: why ? JSON.parse(why.data as string).reason : null, since: c.updated_at });
    }
    // Reviews an agent asked a person for.
    for (const r of this.sql.exec(`SELECT r.change_id, r.reviewer, r.requested_by, r.reason, r.created_at, c.title FROM review_requests r
                                   JOIN changes c ON c.id = r.change_id JOIN agents a ON a.id = r.reviewer
                                   WHERE r.status = 'open' AND a.role = 'human' AND c.status IN ('review','changes_requested') LIMIT 50`).toArray()) {
      items.push({ kind: "review", change: r.change_id, title: r.title, agent: r.requested_by, reviewer: r.reviewer, reason: r.reason, since: r.created_at });
    }
    // Stuck: nobody asked for a person, but work isn't moving.
    for (const t of open.filter((t) => t.kind === "proposal" && now - t.created_at > 10 * 60_000)) {
      items.push({ kind: "stuck", reason: "proposal unanswered", detail: t.title, agent: t.to_agent, thread: t.id, since: t.created_at });
    }
    for (const c of this.sql.exec("SELECT id, title, agent_id, updated_at FROM changes WHERE status = 'conflict' AND updated_at < ?", now - 5 * 60_000).toArray()) {
      items.push({ kind: "stuck", reason: "conflict not resolved", detail: `#${c.id} ${c.title}`, agent: c.agent_id, change: c.id, since: c.updated_at });
    }
    // A change waiting on review that nobody has reviewed: say who was asked, if anyone.
    for (const c of this.sql.exec(`SELECT c.id, c.title, c.agent_id, c.updated_at, (SELECT GROUP_CONCAT(reviewer) FROM review_requests r WHERE r.change_id = c.id AND r.status = 'open') AS asked
                                   FROM changes c WHERE c.status = 'review' AND c.updated_at < ? AND NOT EXISTS (SELECT 1 FROM reviews v WHERE v.change_id = c.id AND v.head = c.head) LIMIT 50`, now - 10 * 60_000).toArray()) {
      const asked = c.asked ? (c.asked as string).split(",").map((r) => this.agentName(r)).join(", ") : null;
      items.push({ kind: "stuck", reason: asked ? `review requested from ${asked}, no answer` : "waiting for review, nobody asked", detail: `#${c.id} ${c.title}`, agent: c.agent_id, change: c.id, since: c.updated_at });
    }
    for (const a of agents.filter((a) => a.state === "quiet" || (a.state === "paused" && a.task))) {
      items.push({ kind: "stuck", reason: a.state === "paused" ? "paused while holding a task" : "agent went quiet holding a task", detail: `#${a.task!.id} ${a.task!.title}`, agent: a.id, task: a.task!.id, since: a.lastSeen });
    }
    for (const r of this.sql.exec("SELECT change_id, COUNT(*) AS n, MIN(ts) AS t FROM events WHERE type = 'merge.retry' AND change_id IN (SELECT id FROM changes WHERE status = 'queued') GROUP BY change_id HAVING n >= 3").toArray()) {
      items.push({ kind: "stuck", reason: `merge failed ${r.n} times`, detail: `#${r.change_id}`, change: r.change_id, since: r.t });
    }
    const rank: Record<string, number> = { dispute: 0, question: 1, approval: 2, stuck: 3 };
    return items.sort((a, b) => rank[a.kind] - rank[b.kind] || a.since - b.since);
  }

  /** Where in the codebase work is happening: folders with live intents, changes in flight, recent merges and conflicts. */
  private areas() {
    const now = Date.now();
    const folder = (p: string) => {
      const parts = p.replace(/\*.*$/, "").split("/").filter(Boolean);
      return parts.length <= 1 ? "(root)" : parts.slice(0, Math.min(2, parts.length - 1)).join("/") + "/";
    };
    const areas = new Map<string, { path: string; agents: Set<string>; intents: number; inFlight: number; merged: number; conflicts: number }>();
    const get = (p: string, isFolder = false) => {
      const k = isFolder ? p : folder(p);
      if (!areas.has(k)) areas.set(k, { path: k, agents: new Set(), intents: 0, inFlight: 0, merged: 0, conflicts: 0 });
      return areas.get(k)!;
    };
    for (const i of this.activeIntents()) for (const p of new Set((i.paths as string[]).map(folder))) { const a = get(p, true); a.intents++; a.agents.add(i.agent_id); }
    for (const c of this.sql.exec("SELECT files, agent_id FROM changes WHERE status IN ('review','queued','merging','conflict','changes_requested')").toArray()) {
      for (const f of new Set((JSON.parse(c.files as string) as FileChange[]).map((f) => f.path))) { const a = get(f); a.inFlight++; a.agents.add(c.agent_id as string); }
    }
    for (const r of this.sql.exec("SELECT type, data FROM events WHERE ts > ? AND type IN ('change.merged','change.conflict')", now - 3600_000).toArray()) {
      const d = JSON.parse(r.data as string);
      const paths = r.type === "change.merged" ? (d.files ?? []).map((f: any) => f.path) : (d.conflicts ?? []).map((c: any) => c.path);
      for (const p of new Set(paths as string[])) { const a = get(p); if (r.type === "change.merged") a.merged++; else a.conflicts++; }
    }
    return [...areas.values()]
      .map((a) => ({ path: a.path, agents: a.agents.size, intents: a.intents, inFlight: a.inFlight, mergedLastHour: a.merged, conflictsLastHour: a.conflicts }))
      .sort((a, b) => b.agents + b.inFlight + b.conflictsLastHour * 2 - (a.agents + a.inFlight + a.conflictsLastHour * 2) || a.path.localeCompare(b.path))
      .slice(0, 24);
  }

  /** Find agents, tasks, changes and files by name, title, path or number. */
  private search(q: URLSearchParams) {
    const text = (q.get("q") ?? "").trim();
    const state = q.get("state");
    const limit = Math.min(Number(q.get("limit") ?? 20), 200);
    const like = `%${text.toLowerCase()}%`;
    const num = Number(text.replace(/^#/, ""));
    let agents = this.agentStates(
      text ? "WHERE lower(a.name) LIKE ? OR lower(a.id) LIKE ? OR a.id IN (SELECT assignee FROM tasks WHERE lower(title) LIKE ? OR id = ?) OR a.id IN (SELECT agent_id FROM intents WHERE released_at IS NULL AND lower(paths) LIKE ?) OR a.id IN (SELECT agent_id FROM changes WHERE id = ?)" : "",
      ...(text ? [like, like, like, num || -1, like, num || -1] : []),
    ).filter((a) => a.state !== "human" || !state);
    if (state) agents = agents.filter((a) => a.state === state);
    const total = agents.length;
    const tasks = text ? this.sql.exec("SELECT id, title, status, assignee FROM tasks WHERE lower(title) LIKE ? OR id = ? ORDER BY updated_at DESC LIMIT 8", like, num || -1).toArray().map((t) => ({ ...t, assigneeName: this.agentName(t.assignee as string) })) : [];
    const changes = text ? this.sql.exec("SELECT id, title, status, agent_id FROM changes WHERE lower(title) LIKE ? OR id = ? OR lower(files) LIKE ? ORDER BY updated_at DESC LIMIT 8", like, num || -1, like).toArray().map((c) => ({ ...c, agentName: this.agentName(c.agent_id as string) })) : [];
    return { agents: agents.slice(0, limit), total, tasks, changes };
  }

  /** One agent, when someone needs to track it down. */
  // ── reviewers: who already knows this code ─────────────────────────────

  /** Note that an agent wrote or reviewed these files and symbols. */
  private learn(agent: string, kind: "wrote" | "reviewed", files: FileChange[], symbols: Record<string, string[]>) {
    const now = Date.now();
    for (const f of files) {
      for (const sym of ["", ...(symbols[f.path] ?? [])]) {
        this.sql.exec(`INSERT INTO familiarity (agent_id, path, symbol, kind, n, last_at) VALUES (?, ?, ?, ?, 1, ?)
                       ON CONFLICT (agent_id, path, symbol, kind) DO UPDATE SET n = n + 1, last_at = excluded.last_at`, agent, f.path, sym, kind, now);
      }
    }
  }

  /**
   * Rank agents to review a change by what of it they already know: the same
   * functions and classes first, then the same files, then the same folder.
   * Recent knowledge counts more, present agents more, busy reviewers less.
   * Reviewer-class agents fill any gap, least busy first.
   */
  private reviewerCandidates(id: number, limit = 5): Candidate[] {
    const ch = this.change(id);
    const files = (ch.files as FileChange[]).map((f) => f.path);
    const symbols: Record<string, string[]> = ch.symbols ?? {};
    const folders = [...new Set(files.map(folderOf).filter(Boolean))];
    const reviewed = new Set(this.sql.exec("SELECT reviewer FROM reviews WHERE change_id = ? AND head = ?", id, ch.head).toArray().map((r) => r.reviewer as string));
    const now = Date.now();
    const scores = new Map<string, { score: number; reasons: { w: number; text: string }[] }>();
    const add = (agent: string, w: number, text: string) => {
      if (agent === ch.agent_id || reviewed.has(agent)) return;
      const s = scores.get(agent) ?? { score: 0, reasons: [] };
      s.score += w;
      s.reasons.push({ w, text });
      scores.set(agent, s);
    };
    const recency = (t: number) => 1 / (1 + (now - t) / (7 * 86400_000));
    const where = [...files.map(() => "path = ?"), ...folders.map(() => "path LIKE ?")].join(" OR ");
    const rows = where ? this.sql.exec(`SELECT * FROM familiarity WHERE ${where} LIMIT 5000`, ...files, ...folders.map((f) => `${f}/%`)).toArray() : [];
    for (const r of rows) {
      const path = r.path as string, sym = r.symbol as string, wrote = r.kind === "wrote";
      const n = Math.min(3, r.n as number) * recency(r.last_at as number);
      if (files.includes(path)) {
        if (sym && symbols[path]?.includes(sym)) add(r.agent_id as string, (wrote ? 5 : 3) * n, `${wrote ? "wrote" : "reviewed"} ${sym} in ${path}`);
        else if (!sym) add(r.agent_id as string, (wrote ? 3 : 2) * n, `${wrote ? "wrote" : "reviewed"} ${path}`);
      } else if (!sym) {
        const folder = folders.filter((f) => path.startsWith(`${f}/`)).sort((x, y) => y.length - x.length)[0] ?? folderOf(path);
        add(r.agent_id as string, (wrote ? 0.6 : 0.4) * n, `${wrote ? "worked" : "reviewed"} in ${folder}/`);
      }
    }
    const load = new Map(this.sql.exec("SELECT reviewer, COUNT(*) AS n FROM review_requests WHERE status = 'open' GROUP BY reviewer").toArray().map((r) => [r.reviewer as string, r.n as number]));
    const people = new Map(this.sql.exec("SELECT id, name, role, paused, last_seen FROM agents").toArray().map((a) => [a.id as string, a]));
    const present = (a: any) => a && now - ((a.last_seen as number) ?? 0) < PRESENT_MS;
    const out: Candidate[] = [];
    for (const [agent, s] of scores) {
      const a = people.get(agent);
      if (!a || a.paused || a.role === "human" || agent === DELEGATE_ID) continue;
      const open = load.get(agent) ?? 0;
      // Fold a folder's many small reasons into one line.
      const reasons = [...new Map(s.reasons.sort((x, y) => y.w - x.w).map((r) => [r.text, r])).values()].slice(0, 3).map((r) => r.text);
      out.push({ agent, name: a.name as string, role: a.role as string, score: Math.round((s.score * (present(a) ? 1.3 : 1)) / (1 + 0.5 * open) * 100) / 100, reasons, openReviews: open, present: present(a) });
    }
    out.sort((x, y) => y.score - x.score);
    if (out.length < limit) {
      for (const a of people.values()) {
        if (a.role !== "reviewer" || a.paused || a.id === ch.agent_id || reviewed.has(a.id as string) || out.some((c) => c.agent === a.id)) continue;
        const open = load.get(a.id as string) ?? 0;
        out.push({ agent: a.id as string, name: a.name as string, role: "reviewer", score: 0, reasons: [`on the reviewer rota, ${open} open review${open === 1 ? "" : "s"}`], openReviews: open, present: present(a) });
      }
      out.sort((x, y) => y.score - x.score || x.openReviews - y.openReviews || Number(y.present) - Number(x.present));
    }
    return out.slice(0, limit);
  }

  private reviewRequests(id: number): any[] {
    return this.sql.exec("SELECT * FROM review_requests WHERE change_id = ? ORDER BY created_at", id).toArray()
      .map((r) => ({ ...r, reviewerName: this.agentName(r.reviewer as string), requestedByName: this.agentName(r.requested_by as string) }));
  }

  /** Ask specific agents to review a change: named ones, or the best-placed few. */
  private requestReviewers(actor: Agent, id: number, body: { reviewers?: string[]; count?: number; note?: string }) {
    const ch = this.change(id);
    if (ch.agent_id !== actor.id && actor.role !== "human" && actor.id !== "admin") throw new HttpError(403, "only the author or a human can request reviewers");
    if (!["review", "changes_requested"].includes(ch.status)) throw new HttpError(409, `change ${id} is ${ch.status}, not in review`);
    let picked: { agent: string; reason: string }[];
    if (body.reviewers?.length) {
      const known = this.reviewerCandidates(id, 50);
      picked = body.reviewers.map((r) => {
        const a = this.sql.exec("SELECT id FROM agents WHERE id = ? OR name = ?", r, r).toArray()[0];
        if (!a) throw new HttpError(404, `no agent ${r}`);
        if (a.id === ch.agent_id) throw new HttpError(400, "agents cannot review their own change");
        return { agent: a.id as string, reason: known.find((c) => c.agent === a.id)?.reasons[0] ?? `asked by ${actor.name}` };
      });
    } else {
      const want = Math.max(1, Math.min(5, body.count ?? Math.max(1, this.requiredApprovals)));
      const open = new Set(this.reviewRequests(id).filter((r) => r.status === "open").map((r) => r.reviewer as string));
      picked = this.reviewerCandidates(id, want + open.size).filter((c) => !open.has(c.agent)).slice(0, want).map((c) => ({ agent: c.agent, reason: c.reasons[0] }));
    }
    for (const p of picked) this.assignReviewer(id, p.agent, actor.id, p.reason, body.note);
    return { requested: this.reviewRequests(id) };
  }

  private assignReviewer(id: number, reviewer: string, by: string, reason: string, note?: string) {
    const ch = this.change(id);
    const fresh = this.sql.exec(`INSERT INTO review_requests (change_id, reviewer, requested_by, reason, status, created_at) VALUES (?, ?, ?, ?, 'open', ?)
                   ON CONFLICT (change_id, reviewer) DO UPDATE SET status = 'open', reason = excluded.reason, created_at = excluded.created_at WHERE status != 'open'
                   RETURNING change_id`, id, reviewer, by, reason, Date.now()).toArray().length;
    if (fresh) this.emit("review.assigned", { actor: by, change: id, task: ch.task_id, to: reviewer, data: { title: ch.title, reason, note: note ?? "", files: (ch.files as FileChange[]).map((f) => f.path) } });
  }

  // ── contribution activity, for the grids ───────────────────────────────

  /** Commits, changes and reviews per time bucket: a year of days, or finer for a young project. */
  private activity(agent: string | null, range: string | null) {
    const now = Date.now();
    const types = { "workspace.committed": "commits", "change.submitted": "changes", "review.submitted": "reviews" } as const;
    const id = agent ? this.sql.exec("SELECT id FROM agents WHERE id = ? OR name = ?", agent, agent).toArray()[0]?.id as string : null;
    if (agent && !id) throw new HttpError(404, `no agent ${agent}`);
    const first = (this.sql.exec(`SELECT MIN(ts) AS t FROM events WHERE type IN ('workspace.committed','change.submitted','review.submitted')${id ? " AND actor = ?" : ""}`, ...(id ? [id] : [])).one().t as number) ?? now;
    const year = range === "year" || (range !== "recent" && now - first > 7 * 86400_000);
    let start: number, bucketMs: number, n: number;
    if (year) {
      // GitHub's layout: 53 week columns ending this week, Sunday at the top.
      bucketMs = 86400_000;
      const today = new Date(now); today.setHours(0, 0, 0, 0);
      start = today.getTime() - (52 * 7 + today.getDay()) * bucketMs;
      n = 53 * 7;
    } else {
      // Pick the smallest tidy square size that fits the project's life in 26 columns.
      n = 26 * 7;
      const span = Math.max(now - first, 5 * 60_000);
      const NICE = [2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400].map((s) => s * 1000);
      bucketMs = NICE.find((b) => b * n >= span * 1.1) ?? 86400_000;
      start = Math.floor((now - bucketMs * (n - 1)) / bucketMs) * bucketMs;
    }
    const cells = Array.from({ length: n }, () => ({ commits: 0, changes: 0, reviews: 0 }));
    const rows = this.sql.exec(`SELECT CAST((ts - ?) / ? AS INTEGER) AS b, type, COUNT(*) AS n FROM events
                                WHERE ts >= ? AND type IN ('workspace.committed','change.submitted','review.submitted')${id ? " AND actor = ?" : ""} GROUP BY b, type`,
      start, bucketMs, start, ...(id ? [id] : [])).toArray();
    for (const r of rows) {
      const c = cells[r.b as number];
      if (c) c[types[r.type as keyof typeof types]] += r.n as number;
    }
    return { range: year ? "year" : "recent", start, bucketMs, now, agent: id, cells };
  }

  /** What an agent has reviewed, and how fast it answers review requests. */
  private reviewStats(id: string) {
    const v = this.sql.exec("SELECT verdict, COUNT(*) AS n FROM reviews WHERE reviewer = ? GROUP BY verdict", id).toArray();
    const waits = this.sql.exec("SELECT done_at - created_at AS w FROM review_requests WHERE reviewer = ? AND status = 'done' AND done_at IS NOT NULL ORDER BY w", id).toArray().map((r) => r.w as number);
    const by = Object.fromEntries(v.map((r) => [r.verdict, r.n]));
    return { approved: by.approve ?? 0, changesRequested: by.request_changes ?? 0, comments: by.comment ?? 0, answered: waits.length, medianResponseMs: waits.length ? waits[Math.floor(waits.length / 2)] : null };
  }

  /** The code an agent knows best: files it wrote or reviewed, with the symbols it touched. */
  private knows(id: string) {
    const rows = this.sql.exec("SELECT path, symbol, kind, n, last_at FROM familiarity WHERE agent_id = ? ORDER BY last_at DESC LIMIT 400", id).toArray();
    const byPath = new Map<string, { path: string; wrote: number; reviewed: number; symbols: string[]; last: number }>();
    for (const r of rows) {
      const k = byPath.get(r.path as string) ?? { path: r.path as string, wrote: 0, reviewed: 0, symbols: [], last: 0 };
      if (!r.symbol) k[r.kind === "wrote" ? "wrote" : "reviewed"] += r.n as number;
      else if (!k.symbols.includes(r.symbol as string)) k.symbols.push(r.symbol as string);
      k.last = Math.max(k.last, r.last_at as number);
      byPath.set(k.path, k);
    }
    return [...byPath.values()].sort((x, y) => y.wrote * 2 + y.reviewed - (x.wrote * 2 + x.reviewed) || y.last - x.last).slice(0, 12);
  }

  private profile(id: string) {
    const a = this.agentStates("WHERE a.id = ? OR a.name = ?", id, id)[0];
    if (!a) throw new HttpError(404, `no agent ${id}`);
    return {
      agent: a,
      tasks: this.sql.exec("SELECT id, title, status, updated_at FROM tasks WHERE assignee = ? OR id IN (SELECT task_id FROM changes WHERE agent_id = ?) ORDER BY updated_at DESC LIMIT 20", a.id, a.id).toArray(),
      intents: this.activeIntents().filter((i) => i.agent_id === a.id),
      changes: this.sql.exec("SELECT id, title, status, files, updated_at FROM changes WHERE agent_id = ? ORDER BY id DESC LIMIT 20", a.id).toArray().map((c) => ({ ...c, files: (JSON.parse(c.files as string) as FileChange[]).map((f) => f.path) })),
      threads: this.sql.exec("SELECT id FROM threads WHERE created_by = ? OR to_agent = ? ORDER BY updated_at DESC LIMIT 10", a.id, a.id).toArray().map((r) => this.thread(r.id as number)),
      events: this.rowsToEvents(this.sql.exec("SELECT * FROM events WHERE actor = ? OR to_agent = ? ORDER BY seq DESC LIMIT 60", a.id, a.id).toArray()),
      reviewQueue: this.sql.exec("SELECT r.change_id, r.reason, r.created_at, r.requested_by, c.title, c.status FROM review_requests r JOIN changes c ON c.id = r.change_id WHERE r.reviewer = ? AND r.status = 'open' ORDER BY r.created_at LIMIT 20", a.id).toArray()
        .map((r) => ({ ...r, requestedByName: this.agentName(r.requested_by as string) })),
      reviewStats: this.reviewStats(a.id),
      knows: this.knows(a.id),
    };
  }

  /** Answer several agents' copies of the same question at once: one decision, every asker unblocked. */
  private answerGroup(actor: Agent, threads: number[], text: string) {
    if (!text) throw new HttpError(400, "body is required");
    const open = threads.map((id) => this.thread(id)).filter((t) => t.kind === "question" && t.status === "open");
    open.forEach((t, i) => {
      this.citing = i > 0;
      try { this.post(actor, t.id, text); } finally { this.citing = false; }
    });
    return { answered: open.map((t) => t.id) };
  }

  // ── memory: what the humans decided, and what earlier agents tried ──────

  /** Set while jev cites an earlier decision, so the citation isn't recorded as a new one. */
  private citing = false;

  private decisionRows(where: string, ...args: SqlStorageValue[]): Decision[] {
    return this.sql.exec(`SELECT * FROM decisions WHERE ${where}`, ...args).toArray()
      .map((r) => ({ ...r, paths: JSON.parse(r.paths as string), byName: this.agentName(r.by as string) })) as any;
  }

  private recordDecision(kind: Decision["kind"], actor: Agent, d: { question: string; decision: string; paths: string[]; task?: number | null; change?: number | null; thread?: number | null }) {
    if (!d.decision?.trim()) throw new HttpError(400, "decision is required");
    const paths = d.paths.map(normalizePattern).filter(Boolean);
    const row = this.sql.exec("INSERT INTO decisions (kind, question, decision, by, paths, task_id, change_id, thread_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
      kind, d.question, d.decision, actor.id, JSON.stringify(paths), d.task ?? null, d.change ?? null, d.thread ?? null, Date.now()).one();
    const id = row.id as number;
    this.emit("decision.recorded", { actor: actor.id, task: d.task ?? null, change: d.change ?? null, data: { decision: id, kind, question: d.question, text: d.decision, paths } });
    return this.decisionRows("id = ?", id)[0];
  }

  private retireDecision(actor: Agent, id: number) {
    this.sql.exec("UPDATE decisions SET retired_at = ? WHERE id = ?", Date.now(), id);
    this.emit("decision.retired", { actor: actor.id, data: { decision: id } });
    return { ok: true };
  }

  /** Decisions that bear on these paths (or the whole project), most relevant first. */
  private relevantDecisions(paths: string[], text = "", limit = 12): Decision[] {
    const all = this.decisionRows("retired_at IS NULL ORDER BY id DESC LIMIT 300");
    const scored = all
      .map((d) => {
        const onPaths = d.paths.length > 0 && paths.length > 0 && anyOverlap(d.paths, paths).length > 0;
        const projectWide = d.paths.length === 0;
        const sim = text ? (sameQuestion(text, d.question) ? 1 : Math.max(similarity(text, d.question), similarity(text, `${d.question} ${d.decision}`))) : 0;
        return { d, score: (onPaths ? 2 : 0) + (projectWide ? 0.5 : 0) + sim * 2 };
      })
      .filter((x) => x.score >= 0.5);
    return scored.sort((a, b) => b.score - a.score || b.d.id - a.d.id).slice(0, limit).map((x) => x.d);
  }

  private listDecisions(q: URLSearchParams) {
    const paths = (q.get("paths") ?? "").split(",").map((p) => p.trim()).filter(Boolean);
    const text = q.get("q") ?? "";
    if (!paths.length && !text) return this.decisionRows("retired_at IS NULL ORDER BY id DESC LIMIT 100");
    return this.relevantDecisions(paths, text, 30);
  }

  /** Paths a thread is about: its anchor, or else what its task declared. */
  private threadPaths(t: any): string[] {
    if (t.path) return [t.path];
    if (t.change_id) return (this.change(t.change_id).files as FileChange[]).map((f) => f.path);
    if (t.task_id) return this.sql.exec("SELECT paths FROM intents WHERE task_id = ?", t.task_id).toArray().flatMap((r) => JSON.parse(r.paths as string) as string[]);
    return [];
  }

  private isPresent(agentId: string | null): boolean {
    if (!agentId) return false;
    const a = this.sql.exec("SELECT last_seen, paused, role FROM agents WHERE id = ?", agentId).toArray()[0];
    return !!a && a.role !== "human" && !a.paused && Date.now() - (a.last_seen as number) < PRESENT_MS;
  }

  /** What an earlier change on these files did, why, and what people objected to. */
  private async effort(changeRow: Record<string, SqlStorageValue>, paths: string[]) {
    const id = changeRow.id as number;
    const ctx = await this.env.CONTEXT.get(`${this.project}/changes/${id}/context.json`);
    const saved = ctx ? ((await ctx.json()) as any) : null;
    const files = (JSON.parse(changeRow.files as string) as FileChange[]).map((f) => f.path);
    const objections = this.sql.exec("SELECT reviewer, body FROM reviews WHERE change_id = ? AND verdict = 'request_changes' AND body != '' ORDER BY id", id).toArray()
      .map((r) => ({ by: this.agentName(r.reviewer as string), body: r.body }));
    const agent = changeRow.agent_id as string;
    return {
      change: id, task: changeRow.task_id, title: changeRow.title, status: changeRow.status,
      agent, agentName: this.agentName(agent), present: this.isPresent(agent),
      files: files.filter((f) => paths.length === 0 || paths.some((p) => matches(p, f))),
      summary: changeRow.summary ?? "",
      decisions: saved?.context?.decisions ?? [],
      objections,
    };
  }

  /**
   * Memory for an agent about to work on some paths: decisions that apply,
   * earlier changes there, and who of those agents is still around to ask.
   */
  private async recall(actor: Agent, paths: string[], taskId: number | null, text: string) {
    const decisions = this.relevantDecisions(paths, text);
    // Finished work only: changes still in flight show up as overlaps instead.
    const rows = this.sql.exec("SELECT * FROM changes WHERE task_id IS NOT ? AND status IN ('merged','abandoned') ORDER BY id DESC LIMIT 200", taskId).toArray()
      .filter((c) => (JSON.parse(c.files as string) as FileChange[]).some((f) => paths.some((p) => matches(p, f.path))))
      .slice(0, 5);
    const pastEfforts = await Promise.all(rows.map((c) => this.effort(c, paths)));
    // Suggest a consult once per pair of agents and file, so memory doesn't turn into noise.
    const consult: { agent: string; agentName: string | null; change: number; files: string[] }[] = [];
    for (const e of pastEfforts) {
      if (!e.present || e.agent === actor.id || consult.some((c) => c.agent === e.agent)) continue;
      const fresh = e.files.filter((f) => this.sql.exec("INSERT OR IGNORE INTO consult_hints (a, b, path) VALUES (?, ?, ?) RETURNING a", actor.id, e.agent, f).toArray().length > 0);
      if (fresh.length) consult.push({ agent: e.agent, agentName: e.agentName, change: e.change, files: fresh });
    }
    if (decisions.some((d) => d.paths.length) || pastEfforts.length) {
      this.emit("memory.recalled", {
        actor: actor.id, task: taskId,
        data: { paths, decisions: decisions.map((d) => d.id), efforts: pastEfforts.map((e) => e.change), consult: consult.map((c) => c.agent) },
      });
    }
    return { decisions, pastEfforts, consult };
  }

  /**
   * Memory for a task being claimed or handed over: earlier tasks like it
   * (named by a human, or similar in wording), what they did, and what was
   * decided along the way.
   */
  private async taskMemory(taskId: number, forAgent?: string) {
    const task = this.task(taskId);
    const about = `${task.title} ${task.description ?? ""}`;
    const others = this.sql.exec("SELECT id, title, description FROM tasks WHERE id != ? AND id IN (SELECT task_id FROM changes)", taskId).toArray();
    const named = new Set<number>(task.related);
    const similar = others
      .map((t) => ({ id: t.id as number, score: similarity(about, `${t.title} ${t.description ?? ""}`) }))
      .filter((t) => t.score >= 0.2 && !named.has(t.id))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    const related = await Promise.all([...named, ...similar.map((t) => t.id)].map(async (id) => {
      const t = this.task(id);
      const changes = this.sql.exec("SELECT * FROM changes WHERE task_id = ? ORDER BY id", id).toArray();
      const efforts = await Promise.all(changes.map((c) => this.effort(c, [])));
      const holder = (t.assignee ?? changes.at(-1)?.agent_id ?? null) as string | null;
      return {
        task: id, title: t.title, status: t.status, why: named.has(id) ? "named by a human" : "similar wording",
        agent: holder, agentName: this.agentName(holder), present: holder !== forAgent && this.isPresent(holder),
        changes: efforts,
      };
    }));
    const files = related.flatMap((r) => r.changes.flatMap((c) => c.files));
    return { related, decisions: this.relevantDecisions(files, about) };
  }

  /** Ask an agent who worked on something before. Opens a thread they're notified about. */
  private consult(actor: Agent, body: { agent: string; question: string; path?: string; changeId?: number; taskId?: number }) {
    if (!body.agent || !body.question) throw new HttpError(400, "agent and question are required");
    const other = this.sql.exec("SELECT id, name FROM agents WHERE id = ? OR name = ?", body.agent, body.agent).toArray()[0];
    if (!other) throw new HttpError(404, `no agent ${body.agent}`);
    const t = this.openThread(actor, {
      silent: true, kind: "discussion", taskId: body.taskId, changeId: body.changeId, path: body.path,
      title: `Consult: ${body.question.split("\n")[0].slice(0, 70)}`, body: body.question, to: other.id as string,
    });
    this.emit("consult.requested", {
      actor: actor.id, to: other.id as string, task: body.taskId ?? null, change: body.changeId ?? null,
      data: { thread: t.id, question: body.question, path: body.path ?? null, present: this.isPresent(other.id as string) },
    });
    return { thread: t, present: this.isPresent(other.id as string), note: this.isPresent(other.id as string) ? "They're active; their reply arrives as a thread.reply event." : "They haven't been active lately; their saved context (task_context) may answer you sooner." };
  }

  // ── disputes: when agents can't settle it themselves ───────────────────

  /**
   * Open a dispute with another agent. Each side states a position; jev rules
   * if the humans' guidance and earlier decisions settle it, a person if not.
   * A ruling becomes a decision, and on a change it is enforced: a ruling for
   * the author dismisses the other side's request for changes.
   */
  private openDispute(actor: Agent, body: { with: string; question: string; position: string; theirPosition?: string; taskId?: number; changeId?: number }) {
    if (!body.with || !body.question || !body.position) throw new HttpError(400, "with, question and position are required");
    const other = this.sql.exec("SELECT id, name FROM agents WHERE id = ? OR name = ?", body.with, body.with).toArray()[0];
    if (!other || other.id === actor.id) throw new HttpError(400, "dispute with another agent");
    const taskId = body.taskId ?? (body.changeId ? this.change(body.changeId).task_id : null);
    const positions: Record<string, string> = { [actor.id]: body.position };
    if (body.theirPosition) positions[other.id as string] = body.theirPosition;
    const t = this.openThread(actor, {
      silent: true, kind: "discussion", taskId: taskId ?? undefined, changeId: body.changeId,
      title: `Dispute: ${body.question.split("\n")[0].slice(0, 70)}`,
      body: `${body.question}\n\n${actor.name}: ${body.position}${body.theirPosition ? `\n${other.name} (as ${actor.name} understands it): ${body.theirPosition}` : ""}`,
      to: "humans",
    });
    const terms = { question: body.question, parties: [actor.id, other.id], positions, changeId: body.changeId ?? null, taskId };
    this.sql.exec("UPDATE threads SET kind = 'dispute', terms = ? WHERE id = ?", JSON.stringify(terms), t.id);
    this.emit("dispute.opened", { actor: actor.id, to: other.id as string, task: taskId, change: body.changeId ?? null, data: { thread: t.id, question: body.question, position: body.position, with: other.id } });
    this.disputeReady(t.id);
    return this.thread(t.id);
  }

  private statePosition(actor: Agent, threadId: number, position: string) {
    const t = this.thread(threadId);
    if (t.kind !== "dispute" || t.status !== "open") throw new HttpError(409, "not an open dispute");
    const terms = JSON.parse(t.terms);
    if (!terms.parties.includes(actor.id)) throw new HttpError(403, "only the two parties state positions");
    if (!position) throw new HttpError(400, "position is required");
    terms.positions[actor.id] = position;
    this.sql.exec("UPDATE threads SET terms = ?, updated_at = ? WHERE id = ?", JSON.stringify(terms), Date.now(), threadId);
    this.sql.exec("INSERT INTO posts (thread_id, author, body, created_at) VALUES (?, ?, ?, ?)", threadId, actor.id, `My position: ${position}`, Date.now());
    this.emit("dispute.position", { actor: actor.id, task: terms.taskId, change: terms.changeId, data: { thread: threadId, position } });
    this.disputeReady(threadId);
    return this.thread(threadId);
  }

  private disputeReady(threadId: number) {
    const t = this.thread(threadId);
    const terms = JSON.parse(t.terms);
    if (terms.parties.every((p: string) => terms.positions[p])) {
      this.emit("dispute.ready", { task: terms.taskId, change: terms.changeId, data: { thread: threadId } });
    }
  }

  private ruleDispute(actor: Agent, threadId: number, winner: string, note?: string) {
    const t = this.thread(threadId);
    if (t.kind !== "dispute" || t.status !== "open") throw new HttpError(409, "not an open dispute");
    const terms = JSON.parse(t.terms);
    const win = terms.parties.find((p: string) => p === winner || this.agentName(p) === winner);
    if (!win) throw new HttpError(400, `rule for one of: ${terms.parties.map((p: string) => this.agentName(p)).join(", ")}`);
    if (!terms.positions[win]) throw new HttpError(409, `${this.agentName(win)} hasn't stated a position yet`);
    const lose = terms.parties.find((p: string) => p !== win);
    const text = `${this.agentName(win)}'s position: ${terms.positions[win]}`;
    this.sql.exec("INSERT INTO posts (thread_id, author, body, created_at) VALUES (?, ?, ?, ?)", threadId, actor.id, `Ruling: ${text}${note ? `\n${note}` : ""}`, Date.now());
    this.sql.exec("UPDATE threads SET status = 'ruled', updated_at = ? WHERE id = ?", Date.now(), threadId);
    const decision = this.recordDecision("ruling", actor, { question: terms.question, decision: text + (note ? ` (${note})` : ""), paths: this.threadPaths(t), task: terms.taskId, change: terms.changeId, thread: threadId });
    // Enforce it on the change: a ruling for the author lifts the loser's objection.
    let enforced = "";
    if (terms.changeId) {
      const ch = this.change(terms.changeId);
      if (ch.agent_id === win) {
        const n = this.sql.exec("UPDATE reviews SET verdict = 'dismissed' WHERE change_id = ? AND reviewer = ? AND verdict = 'request_changes' AND head = ? RETURNING id", ch.id, lose, ch.head).toArray().length;
        const stillBlocked = this.sql.exec("SELECT 1 FROM reviews WHERE change_id = ? AND verdict = 'request_changes' AND head = ?", ch.id, ch.head).toArray().length > 0;
        if (n && ch.status === "changes_requested" && !stillBlocked) {
          this.sql.exec("UPDATE changes SET status = 'review', updated_at = ? WHERE id = ?", Date.now(), ch.id);
          enforced = `${this.agentName(lose)}'s request for changes on #${ch.id} is dismissed; the change is back in review.`;
          this.ctx.waitUntil(this.maybeEnqueue(ch.id));
        }
      } else {
        enforced = `#${ch.id} needs ${this.agentName(win)}'s requested changes before it can land.`;
      }
    }
    const data = { thread: threadId, winner: win, loser: lose, ruling: text, note: note ?? "", enforced, decision: decision.id };
    this.emit("dispute.ruled", { actor: actor.id, task: terms.taskId, change: terms.changeId, data });
    for (const p of terms.parties) this.emit("dispute.ruled.notify", { actor: actor.id, to: p, task: terms.taskId, change: terms.changeId, data });
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
    if (t.to_agent === "humans" && (actor.role === "human" || actor.id === "admin") && !this.citing) {
      this.recordDecision("answer", actor, { question: t.posts[0]?.body ?? t.title, decision: text, paths: this.threadPaths(t), task: t.task_id, change: t.change_id, thread: t.id });
    }
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

  /**
   * Events after a cursor, optionally waiting for one. With an agent, events
   * addressed to someone else are left out; with mine, so are project-wide
   * events that aren't about the agent's own tasks and changes (directives and
   * other steering always come through, and reviewers also get review
   * requests). With hundreds of agents, mine keeps each agent's stream, and
   * the wakeups behind it, proportional to its own work.
   */
  private async events(after: number, wait: number, agent: string | null, mine = false) {
    const wants = this.eventFilter(agent, mine);
    const read = () => {
      const out: LoomEvent[] = [];
      let cursor = after;
      for (;;) {
        const rows = this.rowsToEvents(this.sql.exec("SELECT * FROM events WHERE seq > ? AND (? IS NULL OR to_agent IS NULL OR to_agent = ?) ORDER BY seq LIMIT 500", cursor, agent, agent).toArray());
        if (!rows.length) break;
        cursor = rows[rows.length - 1].seq;
        out.push(...rows.filter(wants));
        if (out.length >= 200 || rows.length < 500) break;
      }
      return { events: out.slice(0, 200), cursor: out.length > 200 ? out[199].seq : cursor };
    };
    let res = read();
    if (!res.events.length && wait > 0) {
      await new Promise<void>((done) => {
        const w = { wants, wake: () => { clearTimeout(t); done(); } };
        const t = setTimeout(() => { this.waiters.delete(w); done(); }, Math.min(wait, 25) * 1000);
        this.waiters.add(w);
      });
      res = read();
    }
    return res;
  }

  private eventFilter(agent: string | null, mine: boolean): (e: LoomEvent) => boolean {
    if (!agent) return () => true;
    if (!mine) return (e) => !e.to_agent || e.to_agent === agent;
    const role = this.sql.exec("SELECT role FROM agents WHERE id = ?", agent).toArray()[0]?.role;
    const tasks = new Set(this.sql.exec("SELECT id FROM tasks WHERE assignee = ?", agent).toArray().map((r) => r.id as number));
    const changes = new Set(this.sql.exec("SELECT id FROM changes WHERE agent_id = ?", agent).toArray().map((r) => r.id as number));
    // Changes this agent was asked to review: it hears when they're updated or merged.
    for (const r of this.sql.exec("SELECT change_id FROM review_requests WHERE reviewer = ? AND status = 'open'", agent).toArray()) changes.add(r.change_id as number);
    return (e) => {
      if (e.to_agent) return e.to_agent === agent;
      if (STEERING.has(e.type)) return true;
      if (role === "reviewer" && (e.type === "review.requested" || e.type === "change.updated")) return true;
      return (e.task_id !== null && tasks.has(e.task_id)) || (e.change_id !== null && changes.has(e.change_id));
    };
  }

  private async handoff(taskId: number) {
    const task = this.task(taskId);
    const changes = this.sql.exec("SELECT id FROM changes WHERE task_id = ? ORDER BY id", taskId).toArray();
    return {
      task,
      intents: this.sql.exec("SELECT * FROM intents WHERE task_id = ? ORDER BY id", taskId).toArray().map((r) => ({ ...r, paths: JSON.parse(r.paths as string) })),
      changes: await Promise.all(changes.map((c) => this.changeDetail(c.id as number))),
      history: this.rowsToEvents(this.sql.exec("SELECT * FROM events WHERE task_id = ? ORDER BY seq", taskId).toArray()),
      memory: await this.taskMemory(taskId),
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
      decisions: this.decisionRows("retired_at IS NULL ORDER BY id DESC LIMIT 40"),
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
    if (msg === "overview") ws.send(JSON.stringify({ kind: "overview", overview: this.overview() }));
  }
}
