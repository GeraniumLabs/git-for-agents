// ProjectCoordinator: one Durable Object per project. It is the single place
// where agents meet: it hands out isolated workspaces (Artifacts forks),
// tracks what every agent intends to touch, runs review, and serializes merges
// into main through a queue. Main is only ever written by this object.

import { DurableObject } from "cloudflare:workers";
import { Workspace, diffFlat, unifiedDiff, type FileConflict, type FileChange, type Remote } from "./gitops";
import { anyOverlap, matches, normalizePattern } from "./paths";
import { makeStore, type RepoStore } from "./store";
import type { Env } from "./env";
import { rankReviewers, checkIntent, DEFAULT_DELEGATE, decideApproval, decideDispute, decideFlagged, decideQuestion, normalizeOptions, type DelegateConfig, type Judge, type ProjectContext } from "./delegate";
import { PRESENT_MS, sameQuestion, similarity, type Decision } from "./memory";
import { folderOf, symbolsTouched, type Candidate } from "./familiarity";
import { zip } from "./zip";
import { runCheck, type CheckResult } from "./checks";
import { EMPTY_RECORD, tally, trust, type TrackRecord } from "./reputation";
import { skill } from "./skill";
import { buildBrief, fileStats, isTest } from "./brief";
import { USER_HEADER, sameSecret, type User } from "./auth";
import { KEY_KINDS, isKeyKind, seal, sealer, unseal, type KeyKind } from "./secrets";
import { SCOPES, isScope, itemKey, itemScope, itemText, scopeFor, shortKey, signBody, standinSkill, validWebhook, type Scope } from "./standin";

const TOKEN_TTL = 6 * 3600;
const DELEGATE_ID = "delegate";
const MERGE_IDENTITY = { name: "Loom merge queue", email: "merge-queue@loom.dev" };
/** Project-wide events every agent hears about, whatever it is working on. */
const STEERING = new Set(["directive", "main.frozen", "main.unfrozen", "paths.protected", "delegate.configured"]);
/** Events a person might care about, shown on the overview instead of the full stream. */
const NOTABLE = ["change.conflict", "change.off_intent", "dispute.opened", "dispute.ruled", "delegate.escalated", "delegate.decided", "directive", "main.frozen", "main.unfrozen",
  "agent.paused", "agent.resumed", "decision.recorded", "question.asked", "question.answered", "consult.requested", "merge.retry", "task.reassigned", "task.assigned",
  "paths.protected", "proposal.made", "proposal.accepted", "proposal.rejected", "collision.forecast", "memory.recalled", "contract.published", "standin.acted"];
/** Events that can put something in front of a person; stand-in webhooks are checked after them. */
const NEEDS_PERSON = new Set(["question.asked", "dispute.opened", "dispute.ready", "delegate.escalated", "approval.needs_human", "review.requested", "change.submitted", "change.updated", "change.conflict", "merge.retry", "proposal.made"]);
/** Most queued changes merged together in one pass of the queue. */
const CHATTER = new Set(["collision.forecast", "memory.recalled", "consult.requested", "task.assigned"]);
const CHATTER_LIMIT = 20;
const since = (ms: number) => (ms < 3600_000 ? `${Math.max(1, Math.round(ms / 60_000))}m` : ms < 86400_000 ? `${Math.round(ms / 3600_000)}h` : `${Math.round(ms / 86400_000)}d`);
const ACCEPT_MS = 5 * 60_000; // to accept or decline a review request
const REVIEW_MS = 30 * 60_000; // to deliver an accepted review
const MERGE_BATCH = 8;
/** How long a workspace outlives the change that landed (or closed) it, before its Artifacts repo is deleted. */
const WORKSPACE_GRACE_MS = 10 * 60_000;

export type Role = "builder" | "reviewer" | "human";

/** Both sides of every file a change touches, at one of its heads. */
interface Snapshot {
  before: Record<string, string | null>;
  after: Record<string, string | null>;
}

export interface Agent {
  id: string;
  name: string;
  role: Role;
  paused?: string | null;
  /** People only: "github:<login>", and whether they own the project. */
  identity?: string | null;
  owner?: boolean;
  /** Set when a person's own agent is acting for them with a stand-in key. */
  standin?: { id: string; name: string; scopes: Scope[] };
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

/** Two questions to people whose words overlap this much show as one card. */
const SIMILAR_QUESTION = 0.6;

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
      "ALTER TABLE review_requests ADD COLUMN seen_at INTEGER",
      "ALTER TABLE review_requests ADD COLUMN answered_at INTEGER",
      "ALTER TABLE review_requests ADD COLUMN deadline INTEGER",
      "ALTER TABLE agents ADD COLUMN identity TEXT",
      "ALTER TABLE agents ADD COLUMN owner INTEGER DEFAULT 0",
      "ALTER TABLE projects ADD COLUMN private INTEGER DEFAULT 0",
      "ALTER TABLE workspaces ADD COLUMN done_at INTEGER",
      "ALTER TABLE tasks ADD COLUMN attempts INTEGER",
      "ALTER TABLE tasks ADD COLUMN attempt INTEGER DEFAULT 0",
      "ALTER TABLE tasks ADD COLUMN winner INTEGER",
      "ALTER TABLE tasks ADD COLUMN contest_status TEXT",
      "ALTER TABLE reviews ADD COLUMN vote INTEGER DEFAULT 0",
      "ALTER TABLE changes ADD COLUMN checks TEXT",
      "ALTER TABLE agents ADD COLUMN joined_via INTEGER",
      "ALTER TABLE threads ADD COLUMN head TEXT",
      "ALTER TABLE threads ADD COLUMN line_text TEXT",
      "ALTER TABLE threads ADD COLUMN outdated INTEGER DEFAULT 0",
      "ALTER TABLE threads ADD COLUMN resolved_by TEXT",
      "ALTER TABLE threads ADD COLUMN default_answer TEXT",
      "ALTER TABLE threads ADD COLUMN deadline INTEGER",
      "ALTER TABLE changes ADD COLUMN intent_check TEXT",
      "UPDATE agents SET name = 'deputy' WHERE id = 'delegate' AND name = 'jev'",
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
      CREATE TABLE IF NOT EXISTS project_keys (
        kind TEXT PRIMARY KEY, ct TEXT NOT NULL, iv TEXT NOT NULL, sealed_by TEXT NOT NULL,
        last4 TEXT, set_by TEXT, set_at INTEGER);
      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, by TEXT, kind TEXT NOT NULL DEFAULT 'fact', text TEXT NOT NULL,
        paths TEXT DEFAULT '[]', task_id INTEGER, change_id INTEGER, created_at INTEGER, retired_at INTEGER, retired_by TEXT);
      CREATE TABLE IF NOT EXISTS join_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, code_hash TEXT NOT NULL UNIQUE, label TEXT, role TEXT NOT NULL,
        max_uses INTEGER, uses INTEGER DEFAULT 0, expires_at INTEGER, created_by TEXT, created_at INTEGER, revoked_at INTEGER);
      CREATE TABLE IF NOT EXISTS note_votes (
        note_id INTEGER, agent TEXT, agree INTEGER, comment TEXT, created_at INTEGER,
        PRIMARY KEY (note_id, agent));
      CREATE TABLE IF NOT EXISTS contest_votes (
        contest INTEGER, voter TEXT, change_id INTEGER, reason TEXT, created_at INTEGER,
        PRIMARY KEY (contest, voter));
      CREATE TABLE IF NOT EXISTS standins (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, person TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL DEFAULT '[]',
        webhook TEXT, webhook_secret TEXT, seen TEXT DEFAULT '[]', last_delivery TEXT, created_by TEXT, created_at INTEGER, last_used INTEGER, revoked_at INTEGER);
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
  private get isPrivate(): boolean {
    return this.meta("visibility") === "private";
  }

  /** Whether this request may read the project: always for a public one; for a private one, members, owners and agents. */
  private async canRead(req: Request): Promise<boolean> {
    if (!this.isPrivate) return true;
    // Browsers can't set headers on a WebSocket, so the dashboard passes a pasted key as ?key=.
    const key = new URL(req.url).searchParams.get("key");
    const probe = key && !req.headers.get("authorization") ? new Request(req.url, { headers: { ...Object.fromEntries(req.headers), authorization: `Bearer ${key}` } }) : req;
    try {
      await this.authenticate(probe);
      return true;
    } catch {
      return false;
    }
  }

  private async setVisibility(actor: Agent, visibility: string) {
    if (visibility !== "public" && visibility !== "private") throw new HttpError(400, "visibility is public or private");
    if (visibility === (this.isPrivate ? "private" : "public")) return;
    this.setMeta("visibility", visibility);
    await this.env.PROJECT.get(this.env.PROJECT.idFromName("__registry")).fetch("https://do/registry/visibility", { method: "PUT", body: JSON.stringify({ name: this.project, private: visibility === "private" }) });
    this.emit("project.visibility", { actor: actor.id, data: { visibility } });
  }

  /** The project's check command (e.g. `npm ci && npm test`), run before anything lands. Empty: no checks. */
  private get checks(): { command: string; timeoutSec: number } | null {
    const command = this.meta("checks_command");
    return command ? { command, timeoutSec: Number(this.meta("checks_timeout") ?? "600") } : null;
  }

  private setChecks(body: { command?: string | null; timeoutSec?: number } | null) {
    const command = body?.command?.trim() ?? "";
    if (command.length > 2000) throw new HttpError(400, "checks.command is too long");
    if (command && !this.env.CHECKS && !this.env.ARTIFACTS_SHIM_URL) throw new HttpError(409, "this server has no check runner yet: it needs the CHECKS container binding");
    this.setMeta("checks_command", command);
    if (body?.timeoutSec !== undefined) {
      const t = Number(body.timeoutSec);
      if (!(t >= 10 && t <= 1800)) throw new HttpError(400, "checks.timeoutSec is between 10 and 1800");
      this.setMeta("checks_timeout", String(t));
    }
  }

  /** How much agents may ask of people: open questions per agent (0 = no limit), and how long a question with a default waits. */
  /** Optional uses of the decision model beyond the deputy, each off by default. */
  private get modelOptions(): { reviewers: boolean; intent: boolean } {
    const o = JSON.parse(this.meta("model_options") ?? "{}");
    return { reviewers: !!o.reviewers, intent: !!o.intent };
  }

  private get questionRules(): { maxOpen: number; deadlineMinutes: number } {
    return { maxOpen: Number(this.meta("questions_max_open") ?? "3"), deadlineMinutes: Number(this.meta("questions_deadline_min") ?? "30") };
  }

  private setQuestionRules(body: { maxOpen?: number; deadlineMinutes?: number }) {
    if (body.maxOpen !== undefined) {
      const n = Number(body.maxOpen);
      if (!(Number.isInteger(n) && n >= 0 && n <= 100)) throw new HttpError(400, "questions.maxOpen is a whole number from 0 (no limit) to 100");
      this.setMeta("questions_max_open", String(n));
    }
    if (body.deadlineMinutes !== undefined) {
      const n = Number(body.deadlineMinutes);
      if (!(n >= 1 && n <= 7 * 24 * 60)) throw new HttpError(400, "questions.deadlineMinutes is between 1 and 10080 (a week)");
      this.setMeta("questions_deadline_min", String(n));
    }
  }

  private get requiredApprovals(): number {
    return Number(this.meta("required_approvals") ?? "1");
  }

  /** Whether open blocking review threads hold a change out of the merge queue (on unless an owner turns it off). */
  private get threadsMustResolve(): boolean {
    return this.meta("resolve_threads") !== "off";
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
    if (["question.asked", "approval.needs_human", "review.submitted", "dispute.ready", "change.submitted", "change.updated"].includes(type) && e.actor !== DELEGATE_ID) {
      // Stand-ins hear about it after the deputy had its chance to handle it.
      this.ctx.waitUntil(this.delegateOn(event).catch((err) => console.error("delegate", err)).finally(() => NEEDS_PERSON.has(type) && this.notifySoon()));
    } else if (NEEDS_PERSON.has(type)) this.notifySoon();
    return event;
  }

  private rowsToEvents(rows: Record<string, SqlStorageValue>[]): LoomEvent[] {
    return rows.map((r) => ({ ...(r as any), data: JSON.parse(r.data as string) }));
  }

  private agentName(id: string | null): string | null {
    if (!id) return null;
    if (id === "votes") return "the agents' vote";
    const r = this.sql.exec("SELECT name FROM agents WHERE id = ?", id).toArray()[0];
    return r ? (r.name as string) : id;
  }

  /** Server-wide owners (LOOM_OWNERS, GitHub logins) own every project. */
  private siteOwner(identity: string): boolean {
    return (this.env.LOOM_OWNERS ?? "").split(",").map((l) => `github:${l.trim().toLowerCase()}`).includes(identity);
  }

  /** A person signed in with GitHub, by their membership in this project. */
  private async member(user: User): Promise<Agent> {
    let row = this.sql.exec("SELECT id, name, role, paused, identity, owner FROM agents WHERE identity = ?", user.id).toArray()[0];
    if (!row && this.siteOwner(user.id)) {
      await this.addPerson(user.login, user.id, true, null);
      row = this.sql.exec("SELECT id, name, role, paused, identity, owner FROM agents WHERE identity = ?", user.id).toArray()[0];
    }
    if (!row) throw new HttpError(403, `${user.login} isn't a member of ${this.project}; ask one of its owners to add you`);
    this.sql.exec("UPDATE agents SET last_seen = ? WHERE id = ?", Date.now(), row.id);
    return { id: row.id as string, name: row.name as string, role: row.role as Role, paused: null, identity: user.id, owner: !!row.owner || this.siteOwner(user.id) };
  }

  private async authenticate(req: Request): Promise<Agent | "admin"> {
    const header = req.headers.get("authorization") ?? "";
    const key = header.replace(/^Bearer\s+/i, "");
    if (!key) {
      const user = req.headers.get(USER_HEADER);
      if (user) return this.member(JSON.parse(user));
      throw new HttpError(401, "sign in, or send an agent key as a bearer token");
    }
    if (await sameSecret(key, this.env.LOOM_ADMIN_TOKEN)) return "admin";
    const hash = await sha256(key);
    const row = this.sql.exec("SELECT id, name, role, paused, identity, owner FROM agents WHERE key_hash = ?", hash).toArray()[0];
    if (!row) return this.standinFor(hash);
    this.sql.exec("UPDATE agents SET last_seen = ? WHERE id = ?", Date.now(), row.id);
    return { id: row.id as string, name: row.name as string, role: row.role as Role, paused: (row.paused as string | null) ?? null, identity: (row.identity as string | null) ?? null, owner: !!row.owner };
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
      checks: c.checks ? JSON.parse(c.checks as string) : null,
      intent_check: c.intent_check ? JSON.parse(c.intent_check as string) : null,
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
      const res = await this.route(req);
      // What a stand-in did is on record as the person's, through it.
      const acted = this.standinActs.get(req);
      if (acted && res.ok) this.emit("standin.acted", { actor: acted.person, data: { standin: acted.id, name: acted.name, action: acted.action } });
      return res;
    } catch (e: any) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: String(e?.message ?? e) }, 500);
    }
  }

  private async route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean); // after /api/projects/:name
    const [a, b, c, d] = parts;
    const m = req.method;
    const body = m === "POST" || m === "PUT" ? await req.json<any>().catch(() => ({})) : {};
    // Where links in webhooks point; the Durable Object only learns its origin from requests.
    if (url.hostname !== "do" && this.meta("project") && this.meta("origin") !== url.origin) this.setMeta("origin", url.origin);

    // Registry (singleton instance)
    if (a === "registry" && b === "github") {
      // The GitHub app Loom created for itself (sign-in), sealed like project keys.
      if (m === "GET") {
        const row = this.meta("github_app");
        const plain = row ? await unseal(this.env, "__github", JSON.parse(row)) : null;
        return json(plain ? JSON.parse(plain) : null);
      }
      const sealed = await seal(this.env, "__github", JSON.stringify(body));
      this.setMeta("github_app", JSON.stringify({ ct: sealed.ct, iv: sealed.iv, sealed_by: sealed.by }));
      return json({ ok: true });
    }
    if (a === "registry") {
      if (m === "GET") return json(this.sql.exec("SELECT name, description, created_at, private FROM projects ORDER BY created_at").toArray().map((p) => ({ ...p, private: !!p.private })));
      if (b === "visibility") {
        this.sql.exec("UPDATE projects SET private = ? WHERE name = ?", body.private ? 1 : 0, body.name);
        return json({ ok: true });
      }
      this.sql.exec("INSERT OR REPLACE INTO projects (name, description, created_at, private) VALUES (?, ?, ?, ?)", body.name, body.description ?? "", Date.now(), body.private ? 1 : 0);
      return json({ ok: true });
    }

    if (a === "init" && m === "POST") return json(await this.init(body));

    // A private project shows nothing, not even that it exists, to anyone
    // who isn't a member, an owner or one of its agents.
    if (a === "visible") return json({ visible: await this.canRead(req) });
    if (this.isPrivate && (a === "ws" || m === "GET") && !(await this.canRead(req))) {
      throw new HttpError(404, `no project ${this.project ?? ""}; if it's private, sign in as one of its members`);
    }
    if (a === "ws") return this.acceptSocket(req);

    // Reads are open so the dashboard can render without a key.
    if (m === "GET") {
      if (a === "state") return json(this.state());
      if (a === "overview") return json(this.overview());
      if (a === "search") return json(this.search(url.searchParams));
      if (a === "agents" && b && c === "trust") return json(this.trustOf(this.profile(b).agent.id));
      if (a === "agents" && b) return json(this.profile(b));
      if (a === "events") return json(await this.events(Number(url.searchParams.get("after") ?? 0), Number(url.searchParams.get("wait") ?? 0), url.searchParams.get("agent"), url.searchParams.get("mine") === "1"));
      if (a === "tasks" && !b) return json(this.listTasks(url.searchParams));
      if (a === "tasks" && b && c === "context") return json(await this.handoff(Number(b)));
      if (a === "tasks" && b && !c) return json(this.taskView(Number(b)));
      if (a === "changes" && b && c === "reviewers") return json({ candidates: this.reviewerCandidates(Number(b), Number(url.searchParams.get("limit") ?? 5)), requested: this.reviewRequests(Number(b)) });
      if (a === "changes" && b && c === "interdiff") return json(await this.interdiff(Number(b), url.searchParams));
      if (a === "changes" && b) return json(await this.changeDetail(Number(b)));
      if (a === "review-tasks") return json(this.reviewTasks(url.searchParams.get("for") ? this.resolveAgent(url.searchParams.get("for")!) : undefined));
      if (a === "reviews") return json(await this.reviewQueue(url.searchParams.get("for") ? this.resolveAgent(url.searchParams.get("for")!) : null));
      if (a === "activity") return json(this.activity(url.searchParams.get("agent"), url.searchParams.get("range")));
      if (a === "files") return json(await this.readFiles(url.searchParams));
      if (a === "archive") return await this.archive(url.searchParams);
      if (a === "commits") return json(await this.commits(url.searchParams));
      if (a === "skill") return new Response(skill(url.origin, this.project, this.meta("description") ?? "", await this.liveJoinCode(url.searchParams.get("code"))), { headers: { "content-type": "text/markdown; charset=utf-8" } });
      if (a === "delegate" && b === "context") return json(this.projectContext());
      if (a === "delegate") return json(this.delegateConfig);
      if (a === "members") return json(this.members());
      if (a === "threads" && b) return json(this.thread(Number(b)));
      if (a === "threads") return json(this.threads(url.searchParams));
      if (a === "decisions") return json(this.listDecisions(url.searchParams));
      if (a === "tasks" && b && c === "memory") return json(await this.taskMemory(Number(b)));
      if (a === "contests" && b) return json(await this.contest(Number(b)));
      if (a === "notes" && !b) return json(this.listNotes(url.searchParams));
    }

    // Agents register themselves with a join code an owner shared.
    if (a === "join" && m === "POST") return json(await this.join(body, url.origin));
    if (a === "standin-skill" && m === "GET") {
      // Fetched with a stand-in key, the skill names the person and the key's rights.
      const by = req.headers.get("authorization") ? await this.authenticate(req).catch(() => null) : null;
      const si = by && by !== "admin" && by.standin ? by : null;
      return new Response(standinSkill(url.origin, this.project, si?.name ?? null, si?.standin?.scopes ?? null), { headers: { "content-type": "text/markdown; charset=utf-8" } });
    }

    const who = await this.authenticate(req);
    const actor: Agent = who === "admin" ? { id: "admin", name: "admin", role: "human", owner: true } : who;
    const ownerOnly = (what: string) => { if (!actor.owner) throw new HttpError(403, `only the project's owners can ${what}`); };

    // A stand-in reaches only what its person allowed, and never settings, people or keys.
    if (actor.standin) {
      const need = scopeFor(m, parts);
      if (!need) throw new HttpError(403, `a stand-in key can't ${m} /${parts.join("/")}; ask ${actor.name} to do it in Loom`);
      if (need !== "watch" && !actor.standin.scopes.includes(need)) throw new HttpError(403, `this stand-in key doesn't have the "${need}" right (${SCOPES[need].toLowerCase()}); ${actor.name} can grant it in Settings`);
      if (need !== "watch") this.standinActs.set(req, { id: actor.standin.id, name: actor.standin.name, person: actor.id, action: `${m} /${parts.join("/")}` });
    }
    if (a === "attention" && m === "GET") return json(await this.attentionFeed(actor, url.searchParams.get("known"), Number(url.searchParams.get("wait") ?? 0), url.origin));
    if (a === "standins") {
      if (b === "me" && m === "GET") {
        if (!actor.standin) throw new HttpError(400, "this isn't a stand-in key");
        return json(this.standinInfo(actor, url.origin));
      }
      if (actor.role !== "human" || actor.standin) throw new HttpError(403, "only people make stand-ins, for themselves");
      if (m === "GET" && !b) return json(this.standins(actor));
      if (m === "POST" && !b) return json(await this.createStandin(actor, body, url.origin));
      if (m === "POST" && b && c === "test") return json(await this.testStandin(actor, b, url.origin));
      if (m === "POST" && b && !c) return json(await this.updateStandin(actor, b, body));
      if (m === "DELETE" && b) return json(this.revokeStandin(actor, b));
    }

    if (a === "join-codes") {
      ownerOnly("manage join codes");
      if (m === "GET") return json(this.joinCodes());
      if (m === "POST") return json(await this.createJoinCode(actor, body));
      if (m === "DELETE" && b) return json(this.revokeJoinCode(actor, Number(b)));
    }
    // A new key for the same agent: its id, history and track record stay.
    if (a === "me" && b === "key" && m === "POST") return json(await this.rotateKey(actor, actor.id));
    if (a === "agents" && b && c === "key" && m === "POST") {
      ownerOnly("replace another agent's key");
      return json(await this.rotateKey(actor, this.profile(b).agent.id));
    }
    if (a === "agents" && !b && m === "POST") {
      ownerOnly("add agents");
      if (body.role === "human" && who !== "admin") throw new HttpError(400, "add people by their GitHub login under members");
      return json(await this.addAgent(body.name, body.role ?? "builder", actor.id === "admin" ? null : actor.id));
    }
    if (a === "members") {
      ownerOnly("change who's in the project");
      if (m === "POST") return json(await this.addMember(actor, body.login, !!body.owner));
      if (m === "DELETE" && b) return json(this.removeMember(actor, b));
    }
    if (a === "settings" && b === "keys") {
      if (actor.role !== "human") throw new HttpError(403, "only people can manage the project's keys");
      if (m === "GET" && !c) return json(this.keySettings());
      if (!c || !isKeyKind(c)) throw new HttpError(404, `no key kind ${c ?? ""}; use ${Object.keys(KEY_KINDS).join(" or ")}`);
      if (m === "PUT") return json(await this.saveKey(actor, c, body.value));
      if (m === "DELETE") return json(this.removeKey(actor, c));
    }
    if (a === "settings" && m === "POST") {
      ownerOnly("change settings");
      if (body.requiredApprovals !== undefined) this.setMeta("required_approvals", String(body.requiredApprovals));
      if (body.protectedPaths !== undefined) this.setMeta("protected_paths", JSON.stringify(body.protectedPaths));
      if (body.visibility !== undefined) await this.setVisibility(actor, body.visibility);
      if (body.checks !== undefined) this.setChecks(body.checks);
      if (body.resolveThreads !== undefined) this.setMeta("resolve_threads", body.resolveThreads ? "on" : "off");
      if (body.questions !== undefined) this.setQuestionRules(body.questions ?? {});
      if (body.model !== undefined) this.setMeta("model_options", JSON.stringify({ ...this.modelOptions, ...Object.fromEntries(Object.entries(body.model ?? {}).filter(([k]) => k === "reviewers" || k === "intent").map(([k, v]) => [k, !!v])) }));
      if (body.approvalMode !== undefined) {
        if (!["weighted", "count"].includes(body.approvalMode)) throw new HttpError(400, "approvalMode is weighted or count");
        this.setMeta("approval_mode", body.approvalMode);
      }
      return json({ requiredApprovals: this.requiredApprovals, protectedPaths: this.protectedPaths, visibility: this.isPrivate ? "private" : "public", approvalMode: this.approvalMode, checks: this.checks, resolveThreads: this.threadsMustResolve, questions: this.questionRules, model: this.modelOptions });
    }
    if (a === "checkout" && m === "POST") return json(await this.checkout(actor, body));
    if (a === "me") return json(this.me(actor));

    // Human controls. Humans (and the admin) steer; agents can't.
    const ruling = a === "disputes" && c === "rule";
    const deciding = a === "decisions" && m === "POST";
    const picking = a === "contests" && c === "pick";
    if (["directives", "pause", "resume", "freeze", "unfreeze", "assign", "protect", "delegate"].includes(c ?? a) || ruling || deciding || picking) {
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
      if (picking) return json(await this.pick(actor, Number(b), body));
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
    if (a === "changes" && b && c === "reviewers" && d === "respond" && m === "POST") return json(this.respondToReview(actor, Number(b), body));
    if (a === "changes" && b && c === "reviewers" && d === "take" && m === "POST") return json(this.takeReview(actor, Number(b)));
    if (a === "changes" && b && c === "reviewers" && m === "POST") return json(await this.requestReviewers(actor, Number(b), body));
    if (a === "changes" && b && c === "reviews") return json(await this.review(actor, Number(b), body));
    if (a === "changes" && b && c === "update") return json(await this.updateChange(actor, Number(b), body));
    if (a === "changes" && b && c === "sync") return json(await this.sync(actor, { changeId: Number(b) }, body.resolutions));
    if (a === "tasks" && b && c === "checks" && m === "POST") return json(await this.checkWorkspace(actor, Number(b)));
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
    if (a === "threads" && b && c === "resolve") {
      const t = this.resolveThread(actor, Number(b), body.body);
      // The last open thread on an approved change lets it into the queue.
      if (t.kind === "review" && t.change_id) await this.maybeEnqueue(t.change_id as number);
      return json(this.thread(Number(b)));
    }
    if (a === "threads" && b && c === "reopen") return json(this.reopenThread(actor, Number(b), body.body));
    if (a === "consults" && !b && m === "POST") return json(this.consult(actor, body));
    if (a === "questions" && b === "answer" && m === "POST") return json(this.answerGroup(actor, body.threads ?? [], body.body, !!body.goAhead));
    if (a === "disputes" && !b && m === "POST") return json(this.openDispute(actor, body));
    if (a === "disputes" && b && c === "position") return json(this.statePosition(actor, Number(b), body.position));
    if (a === "contests" && b && c === "votes" && m === "POST") return json(await this.vote(actor, Number(b), body));
    if (a === "notes" && !b && m === "POST") return json(this.remember(actor, body));
    if (a === "notes" && b && c === "votes" && m === "POST") return json(this.rateNote(actor, Number(b), body));
    if (a === "notes" && b && c === "retire" && m === "POST") return json(this.retireNote(actor, Number(b)));
    throw new HttpError(404, `no route ${m} ${url.pathname}`);
  }

  // ── project setup ────────────────────────────────────────────────────────

  private async init(body: { name: string; description?: string; files?: Record<string, string>; requiredApprovals?: number; owner?: User; visibility?: string; checks?: { command?: string; timeoutSec?: number } }) {
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
    this.setMeta("visibility", body.visibility === "private" ? "private" : "public");
    if (body.checks) this.setChecks(body.checks);
    const files = body.files ?? { "README.md": `# ${name}\n\n${body.description ?? ""}\n` };
    const w = await Workspace.open({ url: created.remote, token: created.token });
    const commit = await w.commitFiles(null, files, "Initial commit", MERGE_IDENTITY);
    await w.push({ url: created.remote, token: created.token }, commit);
    this.setMeta("main_head", commit);
    this.emit("project.created", { data: { name, commit, owner: body.owner?.login ?? null } });
    if (body.owner) await this.addPerson(body.owner.login, body.owner.id, true, null);
    return { name, remote: created.remote, head: commit };
  }

  private async addAgent(name: string, role: Role, by: string | null = null) {
    if (!name?.trim()) throw new HttpError(400, "name is required");
    const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomId(2)}`;
    const key = `loom_${randomId(20)}`;
    this.sql.exec("INSERT INTO agents (id, name, role, key_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)", id, name, role, await sha256(key), Date.now(), Date.now());
    this.emit("agent.joined", { actor: id, data: { name, role, by } });
    return { id, name, role, key };
  }

  // ── join codes: agents register themselves ──────────────────────────────

  private async createJoinCode(actor: Agent, body: { label?: string; role?: string; maxUses?: number; expiresInHours?: number }) {
    const role = body.role ?? "builder";
    if (!["builder", "reviewer"].includes(role)) throw new HttpError(400, "role is builder or reviewer");
    const maxUses = body.maxUses === undefined ? 50 : Number(body.maxUses);
    if (!(maxUses >= 1 && maxUses <= 10_000)) throw new HttpError(400, "maxUses is between 1 and 10000");
    const hours = body.expiresInHours === undefined ? 72 : Number(body.expiresInHours);
    if (!(hours > 0 && hours <= 24 * 90)) throw new HttpError(400, "expiresInHours is between 0 and 2160 (90 days)");
    const code = `loomjoin_${randomId(16)}`;
    const expiresAt = Date.now() + hours * 3_600_000;
    const r = this.sql.exec("INSERT INTO join_codes (code_hash, label, role, max_uses, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
      await sha256(code), body.label?.trim() || null, role, maxUses, expiresAt, actor.id, Date.now()).one();
    this.emit("join_code.created", { actor: actor.id, data: { id: r.id, label: body.label ?? null, role, maxUses, expiresAt } });
    return { id: r.id, code, label: body.label ?? null, role, maxUses, expiresAt, howToJoin: `POST /api/projects/${this.project}/join {"code": "<this code>", "name": "<agent name>"} returns the agent's own key. Shown once: Loom keeps only its hash.` };
  }

  /** The code itself if it is a live join code of this project, so the skill never carries anything else someone put in a link. */
  private async liveJoinCode(code: string | null) {
    if (!code || !/^loomjoin_[A-Za-z0-9_-]{8,64}$/.test(code)) return null;
    const r = this.sql.exec("SELECT revoked_at, expires_at, uses, max_uses FROM join_codes WHERE code_hash = ?", await sha256(code)).toArray()[0];
    return r && !r.revoked_at && (r.expires_at as number) > Date.now() && (r.uses as number) < (r.max_uses as number) ? code : null;
  }

  private joinCodes() {
    return this.sql.exec("SELECT id, label, role, max_uses, uses, expires_at, created_by, created_at, revoked_at FROM join_codes ORDER BY id DESC").toArray()
      .map((r) => ({ id: r.id, label: r.label, role: r.role, maxUses: r.max_uses, uses: r.uses, expiresAt: r.expires_at, createdBy: this.agentName(r.created_by as string), createdAt: r.created_at, revoked: !!r.revoked_at,
        live: !r.revoked_at && (r.expires_at as number) > Date.now() && (r.uses as number) < (r.max_uses as number),
        agents: this.sql.exec("SELECT id, name FROM agents WHERE joined_via = ? ORDER BY created_at", r.id).toArray() }));
  }

  private revokeJoinCode(actor: Agent, id: number) {
    this.sql.exec("UPDATE join_codes SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", Date.now(), id);
    this.emit("join_code.revoked", { actor: actor.id, data: { id } });
    return { id, revoked: true };
  }

  /** An agent trades a join code for its own key. Each agent that joins is a newcomer: its approvals and votes count 1 until it has a record. */
  private async join(body: { code?: string; name?: string }, origin: string) {
    if (!body.code || !body.name?.trim()) throw new HttpError(400, "send {code, name}: the join code an owner gave you, and a name for this agent");
    if (body.name.length > 40) throw new HttpError(400, "name is 40 characters at most");
    const row = this.sql.exec("SELECT * FROM join_codes WHERE code_hash = ?", await sha256(body.code)).toArray()[0];
    // One message for every bad code, so a guesser learns nothing.
    if (!row || row.revoked_at || (row.expires_at as number) <= Date.now() || (row.uses as number) >= (row.max_uses as number)) {
      throw new HttpError(403, "this join code is not valid: it may have expired, been used up or revoked. Ask the project's owner for a new one");
    }
    this.sql.exec("UPDATE join_codes SET uses = uses + 1 WHERE id = ?", row.id);
    const agent = await this.addAgent(body.name.trim(), row.role as Role, `join code #${row.id}`);
    this.sql.exec("UPDATE agents SET joined_via = ? WHERE id = ?", row.id, agent.id);
    return {
      ...agent,
      next: "Keep this key: it is shown once and it is this agent from now on. Reuse it whenever this agent comes back, so it keeps its history and track record.",
      mcp: `${origin}/mcp/${this.project}`,
      skill: `${origin}/api/projects/${this.project}/skill`,
    };
  }

  /** Replace an agent's key, for a leak or a lost key. The agent keeps its id, history and track record; the old key stops working. */
  private async rotateKey(actor: Agent, agentId: string) {
    const row = this.sql.exec("SELECT id, name, role FROM agents WHERE id = ?", agentId).toArray()[0];
    if (!row) throw new HttpError(404, `agent ${agentId} not found`);
    if (row.role === "human") throw new HttpError(400, "people sign in with GitHub; they have no key");
    const key = `loom_${randomId(20)}`;
    this.sql.exec("UPDATE agents SET key_hash = ? WHERE id = ?", await sha256(key), agentId);
    this.emit("agent.key_rotated", { actor: actor.id, to: agentId, data: { by: actor.name } });
    return { id: row.id, name: row.name, role: row.role, key };
  }

  // ── people: GitHub sign-in, owners and members ───────────────────────────

  /** A person's row. They sign in with GitHub, so the key is random and never handed out. */
  private async addPerson(login: string, identity: string, owner: boolean, by: string | null) {
    const id = `${login.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomId(2)}`;
    this.sql.exec("INSERT INTO agents (id, name, role, key_hash, created_at, last_seen, identity, owner) VALUES (?, ?, 'human', ?, ?, ?, ?, ?)",
      id, login, await sha256(`person_${randomId(20)}`), Date.now(), 0, identity, owner ? 1 : 0);
    this.emit("member.added", { actor: by ?? id, to: id, data: { login, owner } });
    return id;
  }

  private members() {
    return this.sql.exec("SELECT id, name, identity, owner, last_seen FROM agents WHERE role = 'human' AND identity IS NOT NULL ORDER BY owner DESC, name").toArray()
      .map((r) => ({ id: r.id, login: r.name, owner: !!r.owner, lastSeen: r.last_seen || null }));
  }

  private async addMember(actor: Agent, login: unknown, owner: boolean) {
    const l = String(login ?? "").trim().replace(/^@/, "");
    if (!/^[a-z0-9](?:[a-z0-9-]{0,38})$/i.test(l)) throw new HttpError(400, "give a GitHub login, e.g. octocat");
    const identity = `github:${l.toLowerCase()}`;
    const row = this.sql.exec("SELECT id FROM agents WHERE identity = ?", identity).toArray()[0];
    if (row) this.sql.exec("UPDATE agents SET owner = ? WHERE id = ?", owner ? 1 : 0, row.id);
    else await this.addPerson(l, identity, owner, actor.id);
    return this.members();
  }

  private removeMember(actor: Agent, id: string) {
    const row = this.sql.exec("SELECT id, name, owner FROM agents WHERE id = ? AND identity IS NOT NULL", id).toArray()[0];
    if (!row) throw new HttpError(404, `no member ${id}`);
    if (row.owner && (this.sql.exec("SELECT COUNT(*) AS n FROM agents WHERE owner = 1").one().n as number) <= 1) throw new HttpError(409, "a project needs at least one owner");
    this.sql.exec("UPDATE agents SET identity = NULL, owner = 0, paused = 'removed from the project' WHERE id = ?", id);
    this.sql.exec("UPDATE standins SET revoked_at = ? WHERE person = ? AND revoked_at IS NULL", Date.now(), id);
    this.emit("member.removed", { actor: actor.id, to: id, data: { login: row.name } });
    return this.members();
  }

  // ── tasks and workspaces ─────────────────────────────────────────────────

  private createTask(actor: Agent, body: { title: string; description?: string; dependsOn?: number[]; parent?: number; related?: number[]; attempts?: number }) {
    if (!body.title) throw new HttpError(400, "title is required");
    if (body.parent) this.task(body.parent);
    const attempts = Math.floor(Number(body.attempts ?? 1));
    if (attempts > 5) throw new HttpError(400, "attempts is between 2 and 5");
    const now = Date.now();
    const row = this.sql
      .exec("INSERT INTO tasks (title, description, depends_on, parent, related, created_by, created_at, updated_at, attempts, contest_status, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
        body.title, body.description ?? "", JSON.stringify(body.dependsOn ?? []), body.parent ?? null, JSON.stringify(body.related ?? []), actor.id, now, now,
        attempts > 1 ? attempts : null, attempts > 1 ? "open" : null, attempts > 1 ? "contest" : "open")
      .one();
    const id = row.id as number;
    this.emit("task.created", { actor: actor.id, task: id, data: { title: body.title, parent: body.parent ?? null, attempts: attempts > 1 ? attempts : null } });
    // A contest: the same task, attempted independently by several agents. Each attempt is a task of its own.
    for (let k = 1; attempts > 1 && k <= attempts; k++) {
      const child = this.sql.exec("INSERT INTO tasks (title, description, depends_on, parent, related, created_by, created_at, updated_at, attempt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1) RETURNING id",
        `${body.title} (attempt ${k} of ${attempts})`,
        `${body.description ?? ""}\n\nThis is one of ${attempts} independent attempts at task #${id}. Solve it your own way; don't copy or wait for the other attempts. The agents vote on which attempt lands, weighted by their track records, and the rest are closed with their context kept.`.trim(),
        JSON.stringify(body.dependsOn ?? []), id, JSON.stringify(body.related ?? []), actor.id, now, now).one();
      this.emit("task.created", { actor: actor.id, task: child.id as number, data: { title: `${body.title} (attempt ${k} of ${attempts})`, parent: id, attempt: true } });
    }
    return { ...this.task(id), attemptTasks: attempts > 1 ? this.contestAttempts(id).map((t) => t.id) : undefined };
  }

  private async claim(actor: Agent, taskId: number) {
    let task = this.task(taskId);
    if (task.attempts) {
      // Claiming a contest claims one of its open attempts.
      if (task.contest_status !== "open") throw new HttpError(409, `contest ${taskId} is decided`);
      const mine = this.contestAttempts(taskId).find((t) => t.assignee === actor.id);
      const open = mine ?? this.contestAttempts(taskId).find((t) => !t.assignee && t.status === "open");
      if (!open) throw new HttpError(409, `every attempt at task ${taskId} is taken; compare_attempts and vote instead`);
      taskId = open.id as number;
      task = this.task(taskId);
    }
    if (task.attempt && this.contestAttempts(task.parent).some((t) => t.assignee === actor.id && t.id !== taskId)) throw new HttpError(409, `you already hold an attempt at task ${task.parent}; one attempt per agent`);
    if (task.status === "closed") throw new HttpError(409, `task ${taskId} was closed`);
    if (task.status === "merged") throw new HttpError(409, `task ${taskId} already landed; create a new task for follow-up work`);
    if (task.assignee && task.assignee !== actor.id) {
      const holder = this.sql.exec("SELECT last_seen FROM agents WHERE id = ?", task.assignee).toArray()[0];
      const stale = !holder || Date.now() - (holder.last_seen as number) > 10 * 60_000;
      if (!stale) throw new HttpError(409, `task ${taskId} is held by ${this.agentName(task.assignee)}`);
      this.emit("task.reassigned", { actor: actor.id, task: taskId, data: { from: task.assignee, reason: "previous agent went quiet" } });
    }
    for (const dep of task.depends_on as number[]) {
      if (this.task(dep).status !== "merged") throw new HttpError(409, `task ${taskId} waits on task ${dep}`);
    }

    // Hold the task before the first await, so two agents claiming at once can't both get it.
    this.sql.exec("UPDATE tasks SET assignee = ?, updated_at = ? WHERE id = ?", actor.id, Date.now(), taskId);

    // Reuse the task's workspace if it has one (a handoff), else fork main.
    let ws = task.workspace as string | null;
    let resumed = !!ws;
    if (!ws) {
      ws = `${this.project}-t${taskId}-${randomId(3)}`;
      const forked = await this.store.fork(this.mainRepo, ws, `Workspace for task ${taskId}: ${task.title}`).catch((e) => {
        this.sql.exec("UPDATE tasks SET assignee = ? WHERE id = ? AND assignee = ?", task.assignee ?? null, taskId, actor.id);
        throw e;
      });
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
    // Attempts at the same contest overlap by design; that isn't a collision.
    const siblings = new Set<number>(body.taskId && this.task(body.taskId).attempt ? this.contestAttempts(this.task(body.taskId).parent).map((t) => t.id as number) : []);
    const overlaps = this.activeIntents(actor.id)
      .filter((i) => !siblings.has(i.task_id))
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
    const pending = this.sql.exec("SELECT id, agent_id, title, files FROM changes WHERE status IN ('review','queued','merging','conflict','changes_requested','checks_failed')").toArray()
      .map((c) => ({ change: c.id, agent: c.agent_id, title: c.title, files: (JSON.parse(c.files as string) as FileChange[]).map((f) => f.path).filter((f) => paths.some((p) => matches(p, f))) }))
      .filter((c) => c.files.length && c.agent !== actor.id && !siblings.has(this.change(c.change as number).task_id));
    const memory = await this.recall(actor, paths, body.taskId ?? null, body.description ?? "");
    const advice = [
      overlaps.length || pending.length ? "Another agent is working in these paths. Message them (send_message) to split the work, or narrow your intent." : "Clear: no one else has declared these paths.",
      memory.decisions.length ? `The humans already decided ${memory.decisions.length} thing(s) here: follow them rather than asking again.` : "",
      memory.notes.length ? `Agents left ${memory.notes.length} note(s) about these paths: read them, and rate_note the ones you can confirm or refute.` : "",
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
    if (ws.agent_id !== actor.id && actor.id !== "admin") throw new HttpError(403, `workspace ${ws.name} belongs to ${this.agentName(ws.agent_id as string)}; you are calling as ${actor.name} (check your key)`);
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

  /**
   * main, a named workspace, or the workspace behind a change. A merged
   * change is read from main at the commit that landed it (`at`), because its
   * workspace is deleted once it has landed.
   */
  private repoFor(q: { workspace?: string | null; change?: string | number | null }): { repo: string; label: string; at: string | null } {
    if (q.change) {
      const ch = this.change(Number(q.change));
      if (ch.status === "merged" && ch.merged_commit) return { repo: this.mainRepo, label: `change-${ch.id}`, at: ch.merged_commit };
      this.liveWorkspace(ch.workspace);
      return { repo: ch.workspace, label: `change-${ch.id}`, at: null };
    }
    if (q.workspace && q.workspace !== this.mainRepo) {
      this.liveWorkspace(q.workspace);
      return { repo: q.workspace, label: q.workspace, at: null };
    }
    return { repo: this.mainRepo, label: "main", at: null };
  }

  private liveWorkspace(name: string) {
    const ws = this.sql.exec("SELECT status FROM workspaces WHERE name = ?", name).toArray()[0];
    if (!ws) throw new HttpError(404, `no workspace ${name}`);
    if (ws.status === "deleted") throw new HttpError(410, `workspace ${name} was deleted after its work landed or was closed; read main instead`);
  }

  /**
   * A read-only clone of main, an agent's workspace, or a change, for anyone on
   * the project: people review locally with their own tools. Writing still goes
   * through a claimed task's workspace, and main only through the merge queue.
   */
  private async checkout(actor: Agent, body: { workspace?: string; change?: number }) {
    const { repo, label, at } = this.repoFor(body);
    const ttl = 3600;
    const token = await this.store.token(repo, "read", ttl);
    const remote = this.remoteUrl(repo);
    const dir = `${this.project}-${label}`;
    return {
      repo, remote, token, expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
      clone: `git -c http.extraHeader="Authorization: Bearer ${token}" clone ${remote} ${dir}${at ? ` && git -C ${dir} checkout --detach ${at}` : ""}`,
      ...(at ? { compare: `cd ${dir} && git diff ${at}^1 ${at}` } : {}),
      ...(repo !== this.mainRepo ? { compare: `cd ${dir} && git -c http.extraHeader="Authorization: Bearer ${await this.store.token(this.mainRepo, "read", ttl)}" fetch ${this.remoteUrl(this.mainRepo)} main:loom-main && git diff loom-main...HEAD` } : {}),
      note: "Read-only, valid for an hour. To change code, claim a task: its workspace is yours to push to.",
    };
  }

  /**
   * History. For main: every commit, with merges linked to the change they
   * landed. For a change or workspace: the commits it adds on top of main,
   * which is what its agent (or person) committed and pushed.
   */
  private async commits(q: URLSearchParams) {
    let { repo } = this.repoFor({ workspace: q.get("workspace"), change: q.get("change") });
    const limit = Math.min(200, Number(q.get("limit") ?? 50));
    // A merged change: read it from main, from its landing commit down to main as it was.
    const landedChange = q.get("change") ? this.change(Number(q.get("change"))) : null;
    const merged = landedChange?.status === "merged" && landedChange.merged_commit ? landedChange : null;
    if (merged) repo = this.mainRepo;
    const w = await Workspace.open(this.remote(repo, await this.token(repo, "read")));
    let head = await w.head();
    if (!head) return { repo, commits: [] };
    let mainHead: string | null = null;
    if (merged) {
      head = merged.merged_commit as string;
      const top = (await w.log(head, 1))[0];
      mainHead = top.parents.length > 1 ? top.parents[0] : (merged.base as string);
    } else if (repo !== this.mainRepo) mainHead = await w.fetchFrom("loom-main", await this.mainRemote("read"));
    const byCommit = new Map(this.sql.exec("SELECT id, title, merged_commit FROM changes WHERE merged_commit IS NOT NULL").toArray().map((c) => [c.merged_commit as string, c]));
    const agentByEmail = (email: string) => {
      const m = /^(.+)@agents\.loom\.dev$/.exec(email);
      return m ? m[1] : null;
    };
    const out = [];
    for (const c of await w.log(head, limit)) {
      if (mainHead && (await w.isAncestor(c.oid, mainHead))) break;
      const parent = c.parents[0] ?? null;
      const files = await w.changes(parent, c.oid);
      const landed = byCommit.get(c.oid);
      const agent = agentByEmail(c.author.email);
      out.push({
        oid: c.oid, message: c.message.trim(), at: c.author.at, parents: c.parents,
        author: agent ? this.agentName(agent) ?? c.author.name : c.author.name, agent, merge: c.parents.length > 1,
        change: landed ? { id: landed.id, title: landed.title } : null,
        files: files.slice(0, 30), fileCount: files.length,
      });
    }
    return { repo, head, base: mainHead, commits: out };
  }

  /** The files of main, a workspace or a change as a zip. */
  private async archive(q: URLSearchParams) {
    const { repo, label, at } = this.repoFor({ workspace: q.get("workspace"), change: q.get("change") });
    const w = await Workspace.open(this.remote(repo, await this.token(repo, "read")));
    const flat = await w.flatten(at ?? (await w.head()));
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
    const { repo, at } = this.repoFor({ workspace: q.get("workspace"), change: q.get("change") });
    const ref = at ?? q.get("ref") ?? "main";
    const path = q.get("path");
    if (path && at) {
      // A landed change: read the file as main had it at that commit.
      const w = await Workspace.open(this.remote(repo, await this.token(repo, "read")));
      const e = (await w.flatten(at)).get(path);
      if (!e) throw new HttpError(404, `${path} not found at ${ref}`);
      return { repo, ref, path, content: await w.readText(e.oid) };
    }
    if (path) {
      const content = await this.store.readFile(repo, ref, path);
      if (content === null) throw new HttpError(404, `${path} not found at ${ref}`);
      return { repo, ref, path, content };
    }
    const w = await Workspace.open(this.remote(repo, await this.token(repo, "read")));
    const flat = await w.flatten(at ?? (await w.head()));
    return { repo, ref, files: [...flat.keys()].sort() };
  }

  // ── changes: the agent-native pull request ───────────────────────────────

  private async submitChange(actor: Agent, body: { taskId: number; title?: string; summary?: string; context?: any }) {
    const task = this.task(body.taskId);
    if (task.assignee !== actor.id) throw new HttpError(403, `task ${body.taskId} is assigned to ${task.assignee ? this.agentName(task.assignee as string) : "nobody"}, not to you (${actor.name}); claim it first`);
    const wsRow = this.sql.exec("SELECT * FROM workspaces WHERE name = ?", task.workspace).toArray()[0] as any;
    const analysis = await this.analyze(task.workspace);
    if (!analysis.files.length) throw new HttpError(400, "the workspace has no changes against main");

    const undeclared = this.undeclared(body.taskId, analysis.files);

    const now = Date.now();
    const existing = this.sql.exec("SELECT id FROM changes WHERE task_id = ? AND status NOT IN ('merged','abandoned')", body.taskId).toArray()[0];
    if (existing) return this.updateChange(actor, existing.id as number, body);

    const status = this.requiredApprovals > 0 || this.guardedFiles(analysis.files).length || this.openContest(body.taskId) ? "review" : "queued";
    const row = this.sql
      .exec(`INSERT INTO changes (task_id, agent_id, workspace, title, summary, head, base, base_version, status, files, undeclared, symbols, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        body.taskId, actor.id, task.workspace, body.title ?? task.title, body.summary ?? "", analysis.head, analysis.base, wsRow.base_version,
        status, JSON.stringify(analysis.files), JSON.stringify(undeclared), JSON.stringify(analysis.symbols), now, now)
      .one();
    const id = row.id as number;
    await this.saveContext(id, actor, body, analysis.patch, analysis.head, analysis.snapshot);
    await this.checkChangeIntent(id, analysis.patch);
    this.sql.exec("UPDATE tasks SET status = 'in_review', updated_at = ? WHERE id = ?", now, body.taskId);
    this.emit("change.submitted", { actor: actor.id, task: body.taskId, change: id, data: { title: body.title ?? task.title, files: analysis.files, undeclared, status } });
    if (status === "review") this.requestReview(id, actor.id);
    else await this.enqueue(id);
    const contest = this.openContest(body.taskId);
    if (contest) this.contestEntered(contest.id as number);
    // Who already knows this code, so the author can ask them to review it.
    return { ...this.change(id), suggestedReviewers: status === "review" ? await this.rankedCandidates(id, 3) : [] };
  }

  private async updateChange(actor: Agent, id: number, body: { summary?: string; context?: any; title?: string }) {
    const ch = this.change(id);
    if (ch.agent_id !== actor.id) throw new HttpError(403, `change ${id} is ${this.agentName(ch.agent_id as string)}'s, not yours (${actor.name})`);
    if (ch.status === "merged" || ch.status === "merging") throw new HttpError(409, `change ${id} is ${ch.status}`);
    const analysis = await this.analyze(ch.workspace);
    // The merge queue may have taken the change while we were analyzing.
    if (["merged", "merging"].includes(this.change(id).status)) throw new HttpError(409, `change ${id} was merged meanwhile`);
    const status = this.requiredApprovals > 0 || this.guardedFiles(analysis.files).length || this.openContest(ch.task_id) ? "review" : "queued";
    this.sql.exec("UPDATE changes SET head = ?, base = ?, files = ?, undeclared = ?, symbols = ?, status = ?, summary = COALESCE(?, summary), conflicts = NULL, updated_at = ? WHERE id = ?",
      analysis.head, analysis.base, JSON.stringify(analysis.files), JSON.stringify(this.undeclared(ch.task_id, analysis.files)), JSON.stringify(analysis.symbols), status, body.summary ?? null, Date.now(), id);
    // An update (or a sync) without new context keeps what the author said
    // at submit; new context is merged over it, key by key.
    const prev = (await (await this.env.CONTEXT.get(`${this.project}/changes/${id}/context.json`))?.json<{ context?: Record<string, unknown> }>())?.context ?? {};
    const context = body.context && typeof body.context === "object" ? { ...prev, ...body.context } : prev;
    await this.saveContext(id, actor, { ...body, context, summary: body.summary ?? ch.summary }, analysis.patch, analysis.head, analysis.snapshot);
    await this.checkChangeIntent(id, analysis.patch);
    const outdated = this.markOutdated(id, analysis.snapshot);
    this.emit("change.updated", { actor: actor.id, task: ch.task_id, change: id, data: { head: analysis.head, files: analysis.files, ...(outdated.length ? { outdatedThreads: outdated } : {}) } });
    if (status === "review") this.requestReview(id, actor.id);
    else await this.enqueue(id);
    const contest = this.openContest(ch.task_id);
    if (contest) await this.settleContest(contest.id as number);
    return { ...this.change(id), openThreads: this.openThreadList(id) };
  }

  /** An attempt came in: once two are in, everyone who can vote hears about it. */
  private contestEntered(contestId: number) {
    const entries = this.contestEntries(contestId);
    const live = entries.filter((e) => e.change && e.change.status !== "closed");
    if (live.length < 2) return;
    const task = this.task(contestId);
    this.emit("contest.ready", { task: contestId, data: { title: task.title, attempts: live.map((e) => ({ change: e.change.id, agent: e.change.agent_id, agentName: this.agentName(e.change.agent_id) })), waitingOn: entries.filter((e) => !e.change && e.task.assignee).map((e) => this.agentName(e.task.assignee as string)), advice: "compare_attempts, then vote for the one that should land" } });
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
    // Both sides of every changed file, kept per head so a reviewer can see
    // what changed since they last looked.
    const snapshot: Snapshot = { before: {}, after: {} };
    for (const f of files) {
      const before = B.get(f.path), after = H.get(f.path);
      const a = before ? await w.readText(before.oid) : null, b = after ? await w.readText(after.oid) : null;
      patch += unifiedDiff(f.path, a, b);
      snapshot.before[f.path] = a;
      snapshot.after[f.path] = b;
      const names = symbolsTouched(a, b);
      if (names.length) symbols[f.path] = names;
    }
    return { head, base, files, patch, symbols, snapshot };
  }

  private async saveContext(id: number, actor: Agent, body: { summary?: string; context?: any }, patch: string, head?: string, snapshot?: Snapshot) {
    const key = `${this.project}/changes/${id}`;
    await this.env.CONTEXT.put(`${key}/patch.diff`, patch);
    if (head && snapshot) await this.env.CONTEXT.put(`${key}/heads/${head}.json`, JSON.stringify(snapshot));
    await this.env.CONTEXT.put(`${key}/context.json`, JSON.stringify({ agent: actor, summary: body.summary ?? "", context: body.context ?? {}, savedAt: new Date().toISOString() }, null, 2));
  }

  private async changeDetail(id: number) {
    const ch = this.change(id);
    const key = `${this.project}/changes/${id}`;
    const [patch, ctx] = await Promise.all([this.env.CONTEXT.get(`${key}/patch.diff`), this.env.CONTEXT.get(`${key}/context.json`)]);
    const reviews = this.sql.exec("SELECT * FROM reviews WHERE change_id = ? ORDER BY id", id).toArray().map((r) => ({ ...r, comments: JSON.parse(r.comments as string) }));
    const intents = this.sql.exec("SELECT * FROM intents WHERE task_id = ?", ch.task_id).toArray().map((r) => ({ ...r, paths: JSON.parse(r.paths as string) }));
    const task = this.task(ch.task_id);
    const text = patch ? await patch.text() : "";
    return {
      ...ch, agentName: this.agentName(ch.agent_id), task, intents, reviews, approval: this.approval(id), contest: task.attempt ? task.parent : null,
      patch: text, context: ctx ? await ctx.json() : null,
      threads: this.reviewThreads(id), brief: this.briefFor(ch, text),
      reviewedHeads: this.sql.exec("SELECT reviewer, head, MAX(created_at) AS at FROM reviews WHERE change_id = ? AND COALESCE(vote, 0) = 0 GROUP BY reviewer, head ORDER BY at", id).toArray(),
    };
  }

  // ── review threads, the brief, and what changed since a review ──────────

  /** A change's line comments as threads: replies, resolved or not, outdated once the line changed. */
  private reviewThreads(changeId: number) {
    return this.sql.exec("SELECT id FROM threads WHERE kind = 'review' AND change_id = ? ORDER BY id", changeId).toArray()
      .map((r) => { const t = this.thread(r.id as number); return { ...t, outdated: !!t.outdated, resolvedByName: this.agentName(t.resolved_by) }; });
  }

  /** Open blocking threads, as an author agent needs them: where, what, and what to call. */
  private openThreadList(changeId: number) {
    return this.reviewThreads(changeId).filter((t) => t.status === "open" && t.blocking)
      .map((t) => ({ thread: t.id, path: t.path, line: t.line, by: t.createdByName, says: t.posts.at(-1)?.body, outdated: t.outdated, advice: "fix it, then resolve_thread (or reply_thread if you disagree)" }));
  }

  /** An agent's id from its id or name (the name itself when nobody has it). */
  private resolveAgent(idOrName: string): string {
    return (this.sql.exec("SELECT id FROM agents WHERE id = ? OR name = ?", idOrName, idOrName).toArray()[0]?.id as string) ?? idOrName;
  }

  private openBlockingThreads(changeId: number): number {
    return this.sql.exec("SELECT COUNT(*) AS n FROM threads WHERE kind = 'review' AND change_id = ? AND status = 'open' AND blocking = 1", changeId).one().n as number;
  }

  private async snapshotOf(changeId: number, head: string): Promise<Snapshot | null> {
    const o = await this.env.CONTEXT.get(`${this.project}/changes/${changeId}/heads/${head}.json`);
    return o ? await o.json<Snapshot>() : null;
  }

  /** Threads whose line no longer reads as it did when the comment was written. */
  private markOutdated(changeId: number, snap: Snapshot): number[] {
    const out: number[] = [];
    for (const t of this.sql.exec("SELECT id, path, line, line_text FROM threads WHERE kind = 'review' AND change_id = ? AND status = 'open' AND COALESCE(outdated, 0) = 0", changeId).toArray()) {
      if (!t.path) continue;
      const now = snap.after[t.path as string];
      const line = now == null || !t.line ? null : now.split("\n")[(t.line as number) - 1] ?? null;
      if (!((t.path as string) in snap.after) || (t.line && line !== t.line_text)) {
        this.sql.exec("UPDATE threads SET outdated = 1 WHERE id = ?", t.id);
        out.push(t.id as number);
      }
    }
    return out;
  }

  /** Where a reviewer should look, and whether a person needs to. */
  private briefFor(ch: any, patch: string) {
    const files: FileChange[] = ch.files;
    const paths = files.map((f) => f.path);
    const stats = fileStats(patch);
    const statOf = new Map(stats.map((s) => [s.path, s]));
    const knownBy: Record<string, string[]> = {};
    const authorKnows: string[] = [];
    if (paths.length) {
      const rows = this.sql.exec(`SELECT agent_id, path FROM familiarity WHERE kind = 'wrote' AND symbol = '' AND path IN (${paths.map(() => "?").join(",")}) ORDER BY n DESC`, ...paths).toArray();
      for (const r of rows) {
        if (r.agent_id === ch.agent_id) authorKnows.push(r.path as string);
        else (knownBy[r.path as string] ??= []).push(this.agentName(r.agent_id as string) ?? (r.agent_id as string));
      }
    }
    const brief = buildBrief({
      author: this.agentName(ch.agent_id) ?? ch.agent_id,
      files: paths.map((p) => statOf.get(p) ?? { path: p, added: 0, removed: 0 }),
      undeclared: ch.undeclared, guarded: this.guardedFiles(files),
      checks: ch.checks, checksConfigured: !!this.checks,
      othersIntents: this.activeIntents(ch.agent_id).map((i) => ({ paths: i.paths, agent: this.agentName(i.agent_id) ?? i.agent_id })),
      knownBy, authorKnows,
      sentBack: this.sql.exec("SELECT COUNT(*) AS n FROM reviews WHERE change_id = ? AND verdict = 'request_changes'", ch.id).one().n as number,
      openThreads: this.openBlockingThreads(ch.id),
      intentCheck: ch.intent_check?.head === ch.head ? ch.intent_check : null,
    });
    // The deputy cleared it for the humans at this commit (never protected paths or failing checks).
    if (brief.needsPerson && !brief.reasons.some((r) => r.kind === "protected" || (r.kind === "checks" && ch.checks && !ch.checks.ok))
      && this.sql.exec("SELECT 1 FROM reviews WHERE change_id = ? AND reviewer = ? AND head = ? AND verdict = 'approve'", ch.id, DELEGATE_ID, ch.head).toArray().length) {
      brief.needsPerson = false;
      brief.verdict = `${this.delegateConfig.name} cleared this for the humans; agents can review the rest. It was flagged: ${brief.verdict.replace(/^Needs a person:?\s*/, "")}`;
    }
    return brief;
  }

  /**
   * What changed in a change between two of its heads: by default from the
   * last head this reviewer reviewed to the current one.
   */
  private async interdiff(id: number, q: URLSearchParams) {
    const ch = this.change(id);
    let from = q.get("from");
    const reviewer = q.get("reviewer");
    if (!from && reviewer) {
      const r = this.sql.exec("SELECT head FROM reviews WHERE change_id = ? AND reviewer = ? AND COALESCE(vote, 0) = 0 ORDER BY id DESC LIMIT 1", id, this.resolveAgent(reviewer)).toArray()[0];
      from = (r?.head as string) ?? null;
    }
    const to = (q.get("to") ?? ch.head) as string;
    if (!from) return { available: false, why: "nothing to compare with: no earlier review of this change by that reviewer" };
    if (from === to) return { available: true, from, to, files: [], patch: "", note: "Nothing changed since that review." };
    const [a, b] = await Promise.all([this.snapshotOf(id, from), this.snapshotOf(id, to)]);
    if (!a || !b) return { available: false, from, to, why: "Loom didn't keep that version of the change (it predates per-version history)" };
    let patch = "";
    const files: string[] = [];
    for (const path of [...new Set([...Object.keys(a.after), ...Object.keys(b.after)])].sort()) {
      // A file the change no longer touches reads as main has it now.
      const was = path in a.after ? a.after[path] : (b.before[path] ?? null);
      const now = path in b.after ? b.after[path] : (a.before[path] ?? null);
      if (was === now) continue;
      const d = unifiedDiff(path, was, now);
      if (d) { patch += d; files.push(path); }
    }
    return { available: true, from, to, files, patch };
  }

  /** Changes waiting on review, riskiest first: the review inbox. */
  private async reviewQueue(actor: string | null) {
    const rows = this.sql.exec("SELECT id FROM changes WHERE status IN ('review','changes_requested') ORDER BY updated_at DESC LIMIT 60").toArray();
    const out = await Promise.all(rows.map(async (r) => {
      const ch = this.change(r.id as number);
      const patch = await (await this.env.CONTEXT.get(`${this.project}/changes/${ch.id}/patch.diff`))?.text() ?? "";
      const brief = this.briefFor(ch, patch);
      const asked = actor ? this.sql.exec("SELECT status FROM review_requests WHERE change_id = ? AND reviewer = ? AND status IN ('open','accepted')", ch.id, actor).toArray()[0] : null;
      const mine = actor ? this.sql.exec("SELECT verdict, head FROM reviews WHERE change_id = ? AND reviewer = ? ORDER BY id DESC LIMIT 1", ch.id, actor).toArray()[0] : null;
      return {
        id: ch.id, title: ch.title, status: ch.status, agent: ch.agent_id, agentName: this.agentName(ch.agent_id), updated_at: ch.updated_at,
        files: (ch.files as FileChange[]).length, ...this.patchStats(patch),
        needsPerson: brief.needsPerson, verdict: brief.verdict, score: brief.score, reasons: brief.reasons.filter((x) => x.kind !== "ok").map((x) => x.text),
        approval: this.approval(ch.id), openThreads: this.openBlockingThreads(ch.id),
        reviewers: this.sql.exec("SELECT reviewer, status FROM review_requests WHERE change_id = ? AND status IN ('open','accepted')", ch.id).toArray().map((x) => ({ agent: x.reviewer as string, name: this.agentName(x.reviewer as string), status: x.status === "accepted" ? "reviewing" : "asked" })),
        askedOfYou: !!asked, yourReview: mine ? { verdict: mine.verdict, current: mine.head === ch.head } : null,
      };
    }));
    return out.sort((x, y) => Number(y.askedOfYou) - Number(x.askedOfYou) || Number(y.needsPerson) - Number(x.needsPerson) || y.score - x.score);
  }

  private async review(actor: Agent, id: number, body: { verdict: "approve" | "request_changes" | "comment"; body?: string; comments?: { path: string; line?: number; body: string; blocking?: boolean }[] }) {
    const ch = this.change(id);
    if (!["approve", "request_changes", "comment"].includes(body.verdict)) throw new HttpError(400, "verdict must be approve, request_changes or comment");
    if (ch.agent_id === actor.id) throw new HttpError(403, "agents cannot review their own change");
    const comments = (body.comments ?? []).filter((x) => x && x.path && x.body);
    this.sql.exec("INSERT INTO reviews (change_id, reviewer, verdict, body, comments, head, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id, actor.id, body.verdict, body.body ?? "", JSON.stringify(comments), ch.head, Date.now());
    // Each line comment opens a thread the author answers. Comments that come
    // with a request for changes must be resolved before the change merges.
    const snap = comments.length ? await this.snapshotOf(id, ch.head) : null;
    const threads = comments.map((x) => {
      const t = this.openThread(actor, { silent: true, kind: "review", changeId: id, path: x.path, line: x.line, body: x.body, to: ch.agent_id });
      const lineText = x.line ? snap?.after[x.path]?.split("\n")[x.line - 1] ?? null : null;
      this.sql.exec("UPDATE threads SET head = ?, line_text = ?, blocking = ? WHERE id = ?", ch.head, lineText, (x.blocking ?? body.verdict === "request_changes") ? 1 : 0, t.id);
      return t.id as number;
    });
    // Approving settles the approver's own open threads.
    if (body.verdict === "approve") {
      for (const t of this.sql.exec("SELECT id FROM threads WHERE kind = 'review' AND change_id = ? AND created_by = ? AND status = 'open'", id, actor.id).toArray()) {
        this.sql.exec("UPDATE threads SET status = 'resolved', resolved_by = ?, updated_at = ? WHERE id = ?", actor.id, Date.now(), t.id);
      }
    }
    this.emit("review.submitted", { actor: actor.id, change: id, task: ch.task_id, to: ch.agent_id, data: { verdict: body.verdict, body: body.body ?? "", comments, threads } });
    this.sql.exec("UPDATE review_requests SET status = 'done', done_at = ? WHERE change_id = ? AND reviewer = ? AND status IN ('open','accepted')", Date.now(), id, actor.id);
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
    const now = this.change(id);
    const approval = this.approval(id);
    const next = now.status === "queued" || now.status === "merging" ? "In the merge queue; it lands on its own."
      : now.status === "changes_requested" ? "Sent back to the author."
      : this.openContest(now.task_id) ? "An attempt in an open contest: it lands only if it wins (compare_attempts, then vote)."
      : approval.humanNeeded ? `Waiting for a person to approve: it touches protected paths (${approval.guarded.join(", ")}).`
      : approval.openThreads && approval.weight >= approval.needed ? `Approved, but ${approval.openThreads} review thread${approval.openThreads === 1 ? "" : "s"} must be resolved before it merges.`
      : `Waiting for more approval: ${approval.weight} of ${approval.needed} needed.`;
    return { recorded: { change: id, verdict: body.verdict, atHead: ch.head }, id, status: now.status, approval, threads, next };
  }

  /** Queue a change once it has enough approval weight (a human's approval, if it touches protected paths). */
  private async maybeEnqueue(id: number) {
    const ch = this.change(id);
    if (ch.status !== "review") return;
    const contest = this.openContest(ch.task_id);
    if (contest) return this.settleContest(contest.id as number);
    if (this.approval(id).ok) await this.enqueue(id);
  }

  // ── track records: how each agent's work and judgment turned out ─────────

  private get approvalMode(): "weighted" | "count" {
    return this.meta("approval_mode") === "count" ? "count" : "weighted";
  }

  private trackRecord(agent: string): TrackRecord {
    const n = (sql: string, ...args: SqlStorageValue[]) => this.sql.exec(sql, ...args).one().n as number;
    const humanObjection = `EXISTS (SELECT 1 FROM reviews h JOIN agents p ON p.id = h.reviewer WHERE h.change_id = r.change_id AND h.verdict = 'request_changes' AND p.role = 'human' AND h.head = r.head AND h.id > r.id)`;
    return {
      ...EMPTY_RECORD,
      landed: n("SELECT COUNT(*) AS n FROM changes WHERE agent_id = ? AND status = 'merged'", agent),
      firstPass: n("SELECT COUNT(*) AS n FROM changes c WHERE c.agent_id = ? AND c.status = 'merged' AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.change_id = c.id AND r.verdict = 'request_changes')", agent),
      closed: n("SELECT COUNT(*) AS n FROM changes WHERE agent_id = ? AND status = 'closed'", agent),
      sentBack: n("SELECT COUNT(*) AS n FROM reviews r JOIN changes c ON c.id = r.change_id WHERE c.agent_id = ? AND r.verdict = 'request_changes'", agent),
      conflicts: n("SELECT COUNT(*) AS n FROM events WHERE type = 'change.conflict' AND to_agent = ?", agent),
      approvalsLanded: n(`SELECT COUNT(DISTINCT r.change_id) AS n FROM reviews r JOIN changes c ON c.id = r.change_id WHERE r.reviewer = ? AND r.verdict = 'approve' AND COALESCE(r.vote, 0) = 0 AND c.status = 'merged' AND NOT ${humanObjection}`, agent),
      approvalsMissed: n(`SELECT COUNT(DISTINCT r.change_id) AS n FROM reviews r JOIN changes c ON c.id = r.change_id WHERE r.reviewer = ? AND r.verdict = 'approve' AND COALESCE(r.vote, 0) = 0 AND (c.status = 'closed' OR ${humanObjection})`, agent),
      objectionsUpheld: n("SELECT COUNT(*) AS n FROM reviews r JOIN changes c ON c.id = r.change_id WHERE r.reviewer = ? AND r.verdict = 'request_changes' AND (c.head != r.head OR c.status = 'closed')", agent),
      objectionsOverruled: n("SELECT COUNT(*) AS n FROM reviews r JOIN changes c ON c.id = r.change_id WHERE r.reviewer = ? AND r.verdict = 'request_changes' AND c.status = 'merged' AND c.head = r.head", agent),
      votesWon: n("SELECT COUNT(*) AS n FROM contest_votes v JOIN tasks t ON t.id = v.contest WHERE v.voter = ? AND t.winner IS NOT NULL AND v.change_id = t.winner", agent),
      votesLost: n("SELECT COUNT(*) AS n FROM contest_votes v JOIN tasks t ON t.id = v.contest WHERE v.voter = ? AND t.winner IS NOT NULL AND v.change_id != t.winner", agent),
    };
  }

  /** What an approval or vote by this agent counts for. People always count for 1. */
  private weightOf(agent: string): number {
    if (this.approvalMode === "count" || agent === "admin" || agent === DELEGATE_ID) return 1;
    const role = this.sql.exec("SELECT role FROM agents WHERE id = ?", agent).toArray()[0]?.role;
    if (role === "human") return 1;
    return trust(this.trackRecord(agent)).weight;
  }

  /** Where a change stands on approvals: who approved its current commit, what each counts for, and what's still needed. */
  private approval(id: number) {
    const ch = this.change(id);
    const rows = this.sql.exec("SELECT DISTINCT r.reviewer, a.role FROM reviews r LEFT JOIN agents a ON a.id = r.reviewer WHERE r.change_id = ? AND r.verdict = 'approve' AND r.head = ?", id, ch.head).toArray();
    const approvers = rows.map((r) => ({ agent: r.reviewer as string, name: this.agentName(r.reviewer as string), human: r.role === "human" || r.reviewer === "admin", weight: this.weightOf(r.reviewer as string) }));
    const weight = Math.round(approvers.reduce((sum, a) => sum + a.weight, 0) * 100) / 100;
    const needed = this.requiredApprovals;
    const guarded = this.guardedFiles(ch.files);
    const humanNeeded = guarded.length > 0 && !approvers.some((a) => a.human);
    const openThreads = this.threadsMustResolve ? this.openBlockingThreads(id) : 0;
    return { mode: this.approvalMode, needed, weight, approvers, humanNeeded, guarded, openThreads, ok: weight >= needed && !humanNeeded && !openThreads };
  }

  /** A person-readable track record and the weight it earns. */
  private trustOf(agent: string) {
    const record = this.trackRecord(agent);
    return { ...trust(record), record };
  }

  // ── contests: several agents attempt one task, the best attempt lands ────

  /** The open contest a task is an attempt in, if any. */
  private openContest(taskId: number) {
    const t = this.sql.exec("SELECT p.* FROM tasks c JOIN tasks p ON p.id = c.parent WHERE c.id = ? AND c.attempt = 1 AND p.contest_status = 'open'", taskId).toArray()[0];
    return t ?? null;
  }

  private contestAttempts(contestId: number) {
    return this.sql.exec("SELECT * FROM tasks WHERE parent = ? AND attempt = 1 ORDER BY id", contestId).toArray();
  }

  /** The live change of each attempt that has one. */
  private contestEntries(contestId: number) {
    return this.contestAttempts(contestId).map((t) => {
      const c = this.sql.exec("SELECT id FROM changes WHERE task_id = ? ORDER BY id DESC LIMIT 1", t.id).toArray()[0];
      return { task: t, change: c ? this.change(c.id as number) : null };
    });
  }

  private patchStats(patch: string) {
    let added = 0, removed = 0;
    for (const line of patch.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) added++;
      else if (line.startsWith("-") && !line.startsWith("---")) removed++;
    }
    return { added, removed };
  }

  /** Everything needed to compare a contest's attempts side by side and vote. */
  /** A contest by its own id or by one of its attempts'. */
  private contestId(id: number): number {
    const t = this.task(id);
    return t.attempt ? (t.parent as number) : id;
  }

  private async contest(contestId: number) {
    contestId = this.contestId(contestId);
    const task = this.task(contestId);
    if (!task.attempts) throw new HttpError(404, `task ${contestId} is not a contest; create one with attempts`);
    const entries = this.contestEntries(contestId);
    const votes = this.sql.exec("SELECT * FROM contest_votes WHERE contest = ? ORDER BY created_at", contestId).toArray()
      .map((v) => ({ voter: v.voter as string, voterName: this.agentName(v.voter as string), change: v.change_id as number, reason: v.reason as string, weight: this.weightOf(v.voter as string), at: v.created_at }));
    const live = new Set(entries.filter((e) => e.change && e.change.status !== "closed").map((e) => e.change!.id as number));
    const standings = tally(votes.filter((v) => live.has(v.change)).map((v) => ({ candidate: v.change, weight: v.weight })));
    const everyVote = tally(votes.map((v) => ({ candidate: v.change, weight: v.weight })));
    const attempts = await Promise.all(entries.map(async (e) => {
      const ch = e.change;
      let detail: any = null;
      if (ch) {
        const key = `${this.project}/changes/${ch.id}`;
        const [patch, ctx] = await Promise.all([this.env.CONTEXT.get(`${key}/patch.diff`), this.env.CONTEXT.get(`${key}/context.json`)]);
        const text = patch ? await patch.text() : "";
        const saved = ctx ? ((await ctx.json()) as any) : null;
        const reviews = this.sql.exec("SELECT reviewer, verdict, body, vote FROM reviews WHERE change_id = ? AND head = ? ORDER BY id", ch.id, ch.head).toArray()
          .map((r) => ({ by: this.agentName(r.reviewer as string), verdict: r.verdict, body: r.body, vote: !!r.vote }));
        detail = {
          id: ch.id, status: ch.status, title: ch.title, summary: ch.summary, files: (ch.files as FileChange[]).map((f) => f.path), undeclared: ch.undeclared,
          ...this.patchStats(text), patch: text.length > 40_000 ? `${text.slice(0, 40_000)}\n… (truncated; get_change for all of it)` : text,
          context: saved?.context ?? null, reviews, votes: everyVote.find((s) => s.candidate === ch.id) ?? { weight: 0, votes: 0 },
          checks: ch.checks, brief: this.briefFor(ch, text), openThreads: this.openBlockingThreads(ch.id),
        };
      }
      const who = this.agentName((e.task.assignee ?? ch?.agent_id ?? null) as string | null);
      return { attempt: ch ? `change #${ch.id} by ${who} (attempt task #${e.task.id})` : `attempt task #${e.task.id}: ${e.task.assignee ? `${who} is working on it` : "not claimed yet"}`, task: e.task.id, title: e.task.title, status: e.task.status, agent: e.task.assignee ?? ch?.agent_id ?? null, agentName: this.agentName((e.task.assignee ?? ch?.agent_id ?? null) as string | null), change: detail };
    }));
    return {
      contest: { id: task.id, title: task.title, description: task.description, status: task.contest_status, winner: task.winner ?? null, attempts: task.attempts, quorum: this.contestQuorum },
      attempts, votes, standings,
      howToVote: task.contest_status === "open" ? "Compare the attempts, then call vote with the change you think should land and why. Authors of attempts can't vote. The attempt with the most vote weight wins once every attempt being worked on is in and the leader has at least the quorum." : null,
    };
  }

  /** Vote weight the leading attempt needs: two ordinary votes, or more if the project asks for more approvals. */
  /** Open contests, and ones decided in the last hour, for the dashboard. */
  private contestSummaries() {
    const rows = this.sql.exec("SELECT id FROM tasks WHERE attempts IS NOT NULL AND (contest_status = 'open' OR updated_at > ?) ORDER BY id DESC LIMIT 6", Date.now() - 3600_000).toArray();
    return rows.map((r) => {
      const t = this.task(r.id as number);
      const entries = this.contestEntries(t.id);
      const votes = this.sql.exec("SELECT voter, change_id FROM contest_votes WHERE contest = ?", t.id).toArray();
      const standings = tally(votes.map((v) => ({ candidate: v.change_id as number, weight: this.weightOf(v.voter as string) })));
      return {
        id: t.id, title: t.title, status: t.contest_status, winner: t.winner ?? null, quorum: this.contestQuorum,
        attempts: entries.map((e) => ({ task: e.task.id, agent: (e.task.assignee ?? e.change?.agent_id ?? null) as string | null, change: e.change?.id ?? null, status: e.change?.status ?? e.task.status, weight: standings.find((s) => s.candidate === e.change?.id)?.weight ?? 0 })),
        votes: votes.length,
      };
    });
  }

  private get contestQuorum(): number {
    return Math.max(2, this.requiredApprovals);
  }

  private async vote(actor: Agent, contestId: number, body: { changeId: number; reason?: string }) {
    contestId = this.contestId(contestId);
    const task = this.task(contestId);
    if (!task.attempts) throw new HttpError(404, `task ${contestId} is not a contest`);
    if (task.contest_status !== "open") throw new HttpError(409, `contest ${contestId} is already decided`);
    if (!body.reason?.trim()) throw new HttpError(400, "say why: reason is required, and it is kept as the record of why this attempt won");
    const entries = this.contestEntries(contestId);
    const entry = entries.find((e) => e.change?.id === Number(body.changeId));
    if (!entry || entry.change.status === "closed") throw new HttpError(400, `change ${body.changeId} is not a live attempt in contest ${contestId}`);
    if (entries.some((e) => e.task.assignee === actor.id || e.change?.agent_id === actor.id)) throw new HttpError(403, "authors of an attempt can't vote in its contest");
    const ch = entry.change;
    this.sql.exec("INSERT OR REPLACE INTO contest_votes (contest, voter, change_id, reason, created_at) VALUES (?, ?, ?, ?, ?)", contestId, actor.id, ch.id, body.reason, Date.now());
    // A vote for an attempt is also an approval of it, at the commit the voter saw.
    this.sql.exec("DELETE FROM reviews WHERE vote = 1 AND reviewer = ? AND change_id IN (SELECT c.id FROM changes c JOIN tasks t ON t.id = c.task_id WHERE t.parent = ?)", actor.id, contestId);
    this.sql.exec("INSERT INTO reviews (change_id, reviewer, verdict, body, comments, head, created_at, vote) VALUES (?, ?, 'approve', ?, '[]', ?, ?, 1)", ch.id, actor.id, `Voted for this attempt: ${body.reason}`, ch.head, Date.now());
    // Comparing the attempts is the review: the voter's review requests on every attempt are answered.
    this.sql.exec("UPDATE review_requests SET status = 'done', done_at = ? WHERE reviewer = ? AND status IN ('open','accepted') AND change_id IN (SELECT c.id FROM changes c JOIN tasks t ON t.id = c.task_id WHERE t.parent = ?)", Date.now(), actor.id, contestId);
    this.emit("contest.voted", { actor: actor.id, task: contestId, change: ch.id, data: { change: ch.id, reason: body.reason, weight: this.weightOf(actor.id) } });
    await this.settleContest(contestId);
    // The vote's outcome, without every patch again (compare_attempts has those).
    const view = await this.contest(contestId);
    const decided = view.contest.status === "decided";
    return {
      voted: { change: ch.id, weight: this.weightOf(actor.id) },
      contest: view.contest, standings: view.standings,
      next: decided ? `Decided: change #${view.contest.winner} wins and goes to the merge queue.` : `Open: the leader needs ${view.contest.quorum} vote weight and a clear lead once every attempt is in. You can change your vote until then.`,
    };
  }

  /** Decide a contest when the votes are in: every attempt being worked on has a change, and the leader has the quorum and a clear lead. */
  private async settleContest(contestId: number) {
    const task = this.task(contestId);
    if (task.contest_status !== "open") return;
    const entries = this.contestEntries(contestId);
    const live = entries.filter((e) => e.change && ["review", "changes_requested"].includes(e.change.status));
    const working = entries.filter((e) => !e.change && e.task.assignee && this.isPresent(e.task.assignee as string));
    if (live.length < 2 || working.length) return;
    const ids = new Set(live.map((e) => e.change.id as number));
    const votes = this.sql.exec("SELECT voter, change_id FROM contest_votes WHERE contest = ?", contestId).toArray()
      .filter((v) => ids.has(v.change_id as number))
      .map((v) => ({ candidate: v.change_id as number, weight: this.weightOf(v.voter as string) }));
    const [first, second] = tally(votes);
    if (!first || first.weight < this.contestQuorum || (second && second.weight >= first.weight)) return;
    await this.decideContest(contestId, first.candidate, null, `won the vote, ${first.weight} to ${second?.weight ?? 0}`);
  }

  /** A person picks the attempt that lands, whatever the votes say. */
  private async pick(actor: Agent, contestId: number, body: { changeId: number; note?: string }) {
    contestId = this.contestId(contestId);
    const task = this.task(contestId);
    if (task.contest_status !== "open") throw new HttpError(409, `contest ${contestId} is not open`);
    const entry = this.contestEntries(contestId).find((e) => e.change?.id === Number(body.changeId) && e.change.status !== "closed");
    if (!entry) throw new HttpError(400, `change ${body.changeId} is not a live attempt in contest ${contestId}`);
    // A person's pick is their approval of it.
    this.sql.exec("INSERT INTO reviews (change_id, reviewer, verdict, body, comments, head, created_at, vote) VALUES (?, ?, 'approve', ?, '[]', ?, ?, 1)", entry.change.id, actor.id, `Picked as the attempt to land${body.note ? `: ${body.note}` : ""}`, entry.change.head, Date.now());
    await this.decideContest(contestId, entry.change.id, actor, body.note || `picked by ${actor.name}`);
    return this.contest(contestId);
  }

  private async decideContest(contestId: number, winner: number, by: Agent | null, why: string) {
    const task = this.task(contestId);
    const now = Date.now();
    this.sql.exec("UPDATE tasks SET winner = ?, contest_status = 'decided', status = 'in_review', updated_at = ? WHERE id = ?", winner, now, contestId);
    const entries = this.contestEntries(contestId);
    const won = this.change(winner);
    const reasons = this.sql.exec("SELECT voter, reason FROM contest_votes WHERE contest = ? AND change_id = ?", contestId, winner).toArray()
      .map((v) => `${this.agentName(v.voter as string)}: ${v.reason}`);
    const losers: number[] = [];
    for (const e of entries) {
      if (e.task.id === won.task_id) continue;
      this.sql.exec("UPDATE tasks SET status = 'closed', assignee = NULL, updated_at = ? WHERE id = ?", now, e.task.id);
      this.sql.exec("UPDATE intents SET released_at = ? WHERE task_id = ? AND released_at IS NULL", now, e.task.id);
      if (e.task.workspace) this.sql.exec("UPDATE workspaces SET status = 'closed', done_at = ? WHERE name = ? AND status = 'active'", now, e.task.workspace);
      if (e.change && e.change.status !== "closed") {
        this.sql.exec("UPDATE changes SET status = 'closed', updated_at = ? WHERE id = ?", now, e.change.id);
        this.sql.exec("UPDATE review_requests SET status = 'done', done_at = ? WHERE change_id = ? AND status IN ('open','accepted')", now, e.change.id);
        losers.push(e.change.id as number);
        this.emit("change.closed", { change: e.change.id, task: e.task.id as number, to: e.change.agent_id, data: { reason: `another attempt (#${winner} by ${this.agentName(won.agent_id)}) was chosen for task #${contestId}`, winner } });
      }
    }
    // Why this attempt won is memory: the next agent on these files learns it.
    this.recordDecision("contest", by ?? { id: "votes", name: "the agents' vote", role: "human" }, {
      question: `Which attempt at task #${contestId} "${task.title}" should land?`,
      decision: `Change #${winner} by ${this.agentName(won.agent_id)} (${why}).${reasons.length ? ` Reasons: ${reasons.join(" | ")}` : ""}${losers.length ? ` Closed: ${losers.map((l) => `#${l}`).join(", ")}.` : ""}`,
      paths: (won.files as FileChange[]).map((f) => f.path), task: contestId, change: winner,
    });
    this.emit("contest.decided", { actor: by?.id ?? null, task: contestId, change: winner, data: { winner, by: by?.name ?? "votes", why, losers } });
    await this.maybeEnqueue(winner);
  }

  // ── merge queue ──────────────────────────────────────────────────────────

  private async enqueue(id: number) {
    this.sql.exec("UPDATE changes SET status = 'queued', updated_at = ? WHERE id = ?", Date.now(), id);
    const position = this.sql.exec("SELECT COUNT(*) AS n FROM changes WHERE status IN ('queued','merging') AND id <= ?", id).one().n;
    this.emit("change.queued", { change: id, task: this.change(id).task_id, data: { position } });
    await this.ctx.storage.setAlarm(Date.now());
  }

  async alarm() {
    const nextDeadline = Math.min(this.sweepReviewRequests() ?? Infinity, this.sweepQuestions() ?? Infinity);
    if (nextDeadline < Infinity) await this.ctx.storage.setAlarm(Math.max(nextDeadline, Date.now() + 1000));
    await this.sweepWorkspaces();
    // Work that stopped moving needs no event to need a person.
    this.notifySoon();
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
    const deadline = this.sql.exec("SELECT MIN(deadline) AS t FROM review_requests WHERE status IN ('open','accepted') AND deadline IS NOT NULL").one().t as number | null;
    const done = this.sql.exec("SELECT MIN(done_at) AS t FROM workspaces WHERE status IN ('merged','closed') AND done_at IS NOT NULL").one().t as number | null;
    const asked = this.sql.exec("SELECT MIN(deadline) AS t FROM threads WHERE kind = 'question' AND status = 'open' AND deadline IS NOT NULL").one().t as number | null;
    const next = Math.min(retry ?? Infinity, deadline ?? Infinity, asked ?? Infinity, done != null ? done + WORKSPACE_GRACE_MS : Infinity);
    if (next < Infinity) await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 100));
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
    let landed: { ch: any; before: string; commit: string }[] = [];
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
          commit = await w.commit(result.tree, [tip, head], this.mergeMessage(ch), MERGE_IDENTITY);
        }
        landed.push({ ch, before: tip, commit });
        tip = commit;
      } catch (e: any) {
        await this.retryMerge([id], e);
      }
    }
    if (!landed.length) return;
    if (this.checks && tip !== main) {
      try {
        ({ landed, tip } = await this.checkBatch(w, main, landed));
      } catch (e: any) {
        // The runner itself failed (not the tests): try again shortly.
        return this.retryMerge(landed.map((l) => l.ch.id), e);
      }
      if (!landed.length) return;
    }
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
      this.sql.exec("UPDATE tasks SET status = 'merged', updated_at = ? WHERE winner = ?", t, ch.id);
      this.sql.exec("UPDATE intents SET released_at = ? WHERE task_id = ? AND released_at IS NULL", t, ch.task_id);
      this.sql.exec("UPDATE workspaces SET status = 'merged', done_at = ? WHERE name = ?", t, ch.workspace);
      this.setMeta("main_version", String(version));
      this.setMeta("main_head", commit);
      this.emit("change.merged", { actor: ch.agent_id, change: ch.id, task: ch.task_id, data: { commit, version, files, batch: landed.length } });
      this.learn(ch.agent_id, "wrote", files, ch.symbols ?? {});
      await this.notesFromContext(ch).catch((e) => console.error("notes", e));
      this.sql.exec("UPDATE review_requests SET status = 'done', done_at = ? WHERE change_id = ? AND status IN ('open','accepted')", Date.now(), ch.id);
      this.adviseStale(ch.id, files.map((f) => f.path));
      for (const r of this.sql.exec("SELECT id FROM tasks WHERE waits_for = ?", ch.task_id).toArray()) {
        this.emit("task.unblocked", { task: r.id as number, data: { after: ch.task_id } });
      }
    }
    // Why each change landed travels with the repository, as git notes on main.
    const notes = landed.filter((l) => l.commit !== l.before).map(({ ch, commit }) => ({ id: ch.id as number, oid: commit }));
    this.notesChain = this.notesChain.then(() => this.writeGitNotes(notes)).catch((e) => console.error("git notes", e));
    this.ctx.waitUntil(this.notesChain);
  }

  private notesChain: Promise<void> = Promise.resolve();

  private mergeMessage(ch: any) {
    return `Merge change #${ch.id}: ${ch.title}\n\nTask #${ch.task_id}, by ${this.agentName(ch.agent_id)}.\n\n${ch.summary ?? ""}`.trim();
  }

  // ── checks: the project's tests run on what would land, before main moves ──

  private async checkCommit(w: Workspace, commit: string): Promise<CheckResult> {
    const flat = await w.flatten(commit);
    const files = new Map<string, { bytes: Uint8Array; mode: string }>();
    for (const [path, { oid, mode }] of flat) files.set(path, { bytes: await w.readBytes(oid), mode });
    const { command, timeoutSec } = this.checks!;
    return runCheck(this.env, this.project, files, command, timeoutSec);
  }

  /**
   * Run the checks on the whole batch as it would land. If they pass, it all
   * lands. If not, go one change at a time on top of what already passed, so
   * a change that breaks main only together with another is caught, and the
   * rest still land.
   */
  private async checkBatch(w: Workspace, main: string, landed: { ch: any; before: string; commit: string }[]) {
    const ids = landed.map((l) => l.ch.id as number);
    this.emit("checks.started", { data: { changes: ids, command: this.checks!.command } });
    const whole = await this.checkCommit(w, landed[landed.length - 1].commit);
    if (whole.ok) {
      for (const l of landed) this.recordChecks(l.ch, whole, l.commit);
      return { landed, tip: landed[landed.length - 1].commit };
    }
    if (landed.length === 1) {
      this.checksFailed(landed[0].ch, whole);
      return { landed: [], tip: main };
    }
    const kept: typeof landed = [];
    let tip = main;
    for (const { ch } of landed) {
      let commit: string;
      if (await w.isAncestor(ch.head, tip)) commit = tip;
      else if (await w.isAncestor(tip, ch.head)) commit = ch.head;
      else {
        const result = await w.merge(tip, ch.head);
        if (!result.tree) { this.recordConflict(ch, result.conflicts); continue; }
        commit = await w.commit(result.tree, [tip, ch.head], this.mergeMessage(ch), MERGE_IDENTITY);
      }
      const r = await this.checkCommit(w, commit);
      if (!r.ok) { this.checksFailed(ch, r, kept.map((k) => k.ch.id as number)); continue; }
      this.recordChecks(ch, r, commit);
      kept.push({ ch, before: tip, commit });
      tip = commit;
    }
    return { landed: kept, tip };
  }

  private recordChecks(ch: any, r: CheckResult, commit: string) {
    this.sql.exec("UPDATE changes SET checks = ? WHERE id = ?", JSON.stringify({ ...r, commit, at: Date.now() }), ch.id);
    this.emit("checks.passed", { change: ch.id, task: ch.task_id, data: { command: r.command, ms: r.ms } });
  }

  /** The tests failed with this change on main: back to its author, like a conflict. */
  private checksFailed(ch: any, r: CheckResult, alongside: number[] = []) {
    this.sql.exec("UPDATE changes SET status = 'checks_failed', checks = ?, updated_at = ? WHERE id = ?", JSON.stringify({ ...r, at: Date.now(), alongside }), Date.now(), ch.id);
    this.emit("checks.failed", {
      change: ch.id, task: ch.task_id, to: ch.agent_id,
      data: {
        command: r.command, exitCode: r.exitCode, output: r.output.slice(-1500),
        alongside: alongside.length ? alongside.map((id) => `#${id} ${this.change(id).title}`) : undefined,
        advice: `The project's checks fail with your change on main${alongside.length ? ` (after ${alongside.map((id) => `#${id}`).join(", ")}, which land first)` : ""}. sync_workspace, fix it, run_checks to see it pass, then update_change.`,
      },
    });
  }

  /** Run the checks on what would land from a task's workspace: main with the workspace merged in. */
  private async checkWorkspace(actor: Agent, taskId: number) {
    const task = this.task(taskId);
    if (task.assignee !== actor.id && actor.id !== "admin") throw new HttpError(403, `task ${taskId} is assigned to ${task.assignee ? this.agentName(task.assignee as string) : "nobody"}, not to you (${actor.name})`);
    if (!this.checks) throw new HttpError(409, "this project has no check command; an owner sets one in Settings");
    if (!task.workspace) throw new HttpError(409, `task ${taskId} has no workspace yet; claim it first`);
    const w = await Workspace.open(await this.mainRemote("read"));
    const main = (await w.head())!;
    const head = await w.fetchFrom("ws", this.remote(task.workspace as string, await this.token(task.workspace as string, "read")));
    const merged = await w.isAncestor(main, head) ? null : await w.merge(main, head);
    let commit = head, note = "Ran on your workspace, which already includes main.";
    if (merged?.tree) {
      commit = await w.commit(merged.tree, [main, head], "checks", MERGE_IDENTITY);
      note = "Ran on main with your workspace merged in: what would land.";
    } else if (merged) note = "Your workspace conflicts with main, so this ran on your workspace alone; sync_workspace before you submit.";
    const r = await this.checkCommit(w, commit);
    this.emit("checks.ran", { actor: actor.id, task: taskId, data: { ok: r.ok, command: r.command, ms: r.ms } });
    return { ...r, note };
  }

  /** The record of a landed change, as a git note: what, why, who reviewed it, and what was decided. */
  private async gitNote(id: number): Promise<string> {
    const ch = this.change(id);
    const task = this.task(ch.task_id);
    const ctx = await this.env.CONTEXT.get(`${this.project}/changes/${id}/context.json`);
    const saved = ctx ? ((await ctx.json()) as any) : null;
    const clip = (v: unknown, n = 600) => {
      const t = typeof v === "string" ? v : JSON.stringify(v);
      return t.length > n ? `${t.slice(0, n)}…` : t;
    };
    const lines = [`Loom change #${id}: ${ch.title}`, `Task #${task.id}: ${task.title}`, `Author: ${this.agentName(ch.agent_id)}`];
    if (ch.summary) lines.push("", ch.summary);
    const context = saved?.context && typeof saved.context === "object" ? saved.context : {};
    for (const [k, v] of Object.entries(context).slice(0, 8)) lines.push(`${k}: ${clip(v)}`);
    const reviews = this.sql.exec("SELECT reviewer, verdict, body FROM reviews WHERE change_id = ? AND verdict != 'comment' ORDER BY id", id).toArray();
    if (reviews.length) {
      lines.push("", "Reviews:");
      for (const r of reviews) lines.push(`- ${this.agentName(r.reviewer as string)} ${r.verdict === "approve" ? "approved" : "requested changes"}${r.body ? `: ${clip((r.body as string).split("\n")[0], 200)}` : ""}`);
    }
    const decisions = this.decisionRows("change_id = ? OR task_id = ?", id, ch.task_id);
    if (decisions.length) {
      lines.push("", "Decisions:");
      for (const d of decisions.slice(0, 6)) lines.push(`- ${d.byName ?? d.by}: ${clip(d.decision, 300)}`);
    }
    if (task.attempt) lines.push("", `Won contest #${task.parent} over the other attempts.`);
    return lines.join("\n").slice(0, 6000);
  }

  private async writeGitNotes(landed: { id: number; oid: string }[]) {
    if (!landed.length) return;
    const notes = await Promise.all(landed.map(async (l) => ({ oid: l.oid, text: await this.gitNote(l.id) })));
    const remote = await this.mainRemote("write");
    const w = await Workspace.open(remote);
    await w.addNotes(remote, notes, MERGE_IDENTITY);
  }

  /**
   * Delete the Artifacts repos of workspaces whose change landed (or was
   * closed) a while ago. Main keeps every commit, so nothing is lost; until
   * then the agent can still read its workspace.
   */
  private async sweepWorkspaces() {
    const due = this.sql.exec("SELECT name FROM workspaces WHERE status IN ('merged','closed') AND done_at < ? LIMIT 10", Date.now() - WORKSPACE_GRACE_MS).toArray();
    for (const r of due) {
      const name = r.name as string;
      try {
        await this.store.delete(name);
      } catch (e) {
        console.error("deleting workspace", name, e);
        continue;
      }
      this.sql.exec("UPDATE workspaces SET status = 'deleted' WHERE name = ?", name);
      this.tokens.delete(`${name}:read`);
      this.tokens.delete(`${name}:write`);
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

  // ── the deputy: the humans' delegate ────────────────────────────────────────────

  private get delegateConfig(): DelegateConfig {
    const raw = this.meta("delegate");
    if (!raw) return DEFAULT_DELEGATE;
    const cfg = JSON.parse(raw);
    // Projects briefed before the rename still have the old default name.
    if (cfg.name === "jev") cfg.name = DEFAULT_DELEGATE.name;
    return { ...DEFAULT_DELEGATE, ...cfg, questions: { ...DEFAULT_DELEGATE.questions, ...cfg.questions }, approvals: { ...DEFAULT_DELEGATE.approvals, ...cfg.approvals }, disputes: { ...DEFAULT_DELEGATE.disputes, ...cfg.disputes }, flagged: { ...DEFAULT_DELEGATE.flagged, ...cfg.flagged } };
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
    cfg.flagged = { ...this.delegateConfig.flagged, ...(body.flagged ?? {}) };
    this.setMeta("delegate", JSON.stringify(cfg));
    // The deputy is a member like any other, so its decisions are attributed to it.
    this.sql.exec("INSERT OR IGNORE INTO agents (id, name, role, key_hash, created_at, last_seen) VALUES (?, ?, 'human', ?, ?, ?)",
      DELEGATE_ID, cfg.name, `delegate:${randomId(16)}`, Date.now(), Date.now());
    this.sql.exec("UPDATE agents SET name = ? WHERE id = ?", cfg.name, DELEGATE_ID);
    this.emit("delegate.configured", { actor: actor.id, data: { enabled: cfg.enabled, name: cfg.name, questions: cfg.questions, approvals: cfg.approvals, disputes: cfg.disputes, flagged: cfg.flagged, rules: cfg.rules.length } });
    return cfg;
  }

  /** Let the deputy act on an event if its brief covers it; otherwise say why a human is needed. */
  private async delegateOn(e: LoomEvent) {
    const cfg = this.delegateConfig;
    if (!cfg.enabled) return;
    const deputy = this.delegateActor();
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
        project: this.projectContext(),
      }, await this.judge());
      if (this.thread(t.id).status !== "open") return; // a human got there first
      if (v.act) {
        // House rules and precedents are already on record; a fresh pick by the model becomes a decision.
        this.citing = true;
        try { this.post(deputy, t.id, v.answer); } finally { this.citing = false; }
        if (v.via === "model" && v.option) {
          const meaning = t.options?.[v.option];
          this.recordDecision("answer", deputy, { question: e.data.body, decision: meaning && meaning !== v.option ? `${v.option}: ${meaning}` : v.option, paths: this.threadPaths(t), task: t.task_id, change: t.change_id, thread: t.id });
        }
        this.emit("delegate.decided", { actor: DELEGATE_ID, task: t.task_id, data: { thread: t.id, kind: "question", via: v.via, model: v.act ? v.model ?? null : null, decision: v.answer, precedent: v.decision ?? null, scores: v.scores ?? null } });
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
        project: this.projectContext(),
      }, await this.judge());
      if (this.thread(t.id).status !== "open") return;
      if (v.act && v.option && names[v.option]) {
        this.ruleDispute(deputy, t.id, names[v.option], v.answer);
        this.emit("delegate.decided", { actor: DELEGATE_ID, task: t.task_id, change: terms.changeId, data: { thread: t.id, kind: "dispute", via: v.via, model: v.act ? v.model ?? null : null, decision: `Ruled for ${v.option}. ${v.answer}`, scores: v.scores ?? null } });
      } else this.escalate(t.id, null, t.task_id, v.act ? "the model's ruling didn't match either party" : v.reason, v.scores);
      return;
    }

    const changeId = e.change_id;
    if (!changeId) return;
    if (e.type === "review.submitted" && e.data.verdict !== "approve") return;
    const ch = this.change(changeId);
    if (ch.status !== "review") return;
    const guarded = this.guardedFiles(ch.files);
    const reviews = this.sql.exec("SELECT r.reviewer, r.verdict, a.role FROM reviews r LEFT JOIN agents a ON a.id = r.reviewer WHERE r.change_id = ? AND r.head = ?", changeId, ch.head).toArray();
    if (reviews.some((r) => r.reviewer === DELEGATE_ID)) return;
    if (reviews.some((r) => r.verdict === "request_changes")) return;
    const agentApprovals = reviews.filter((r) => r.verdict === "approve" && r.role !== "human").length;
    if (!guarded.length) return this.deputyOnFlagged(cfg, deputy, ch, agentApprovals);
    if (e.type !== "approval.needs_human" && e.type !== "review.submitted") return;
    const detail = await this.changeDetail(changeId);
    const v = await decideApproval(cfg, {
      guarded, agentApprovals, undeclared: ch.undeclared,
      title: ch.title, summary: ch.summary ?? "",
      intent: detail.intents.map((i: any) => `${i.description} (${i.paths.join(", ")})`).join("; "),
      patch: detail.patch, project: this.projectContext(),
    }, await this.judge());
    if (this.change(changeId).head !== ch.head || this.change(changeId).status !== "review") return; // moved on meanwhile
    if (v.act) {
      await this.review(deputy, changeId, { verdict: "approve", body: v.answer });
      this.emit("delegate.decided", { actor: DELEGATE_ID, change: changeId, task: ch.task_id, data: { kind: "approval", via: v.via, model: v.act ? v.model ?? null : null, decision: v.answer, scores: v.scores ?? null } });
    } else if (v.reason !== "waiting for an agent review first") {
      this.escalate(null, changeId, ch.task_id, v.reason, v.scores);
    }
  }

  /** A change its brief flagged for a person (but not for protected paths): clear it if the deputy's brief allows. */
  private async deputyOnFlagged(cfg: DelegateConfig, deputy: Agent, ch: any, agentApprovals: number) {
    if (!cfg.flagged.enabled || (ch.checks && !ch.checks.ok)) return;
    const detail = await this.changeDetail(ch.id);
    if (!detail.brief.needsPerson) return;
    const v = await decideFlagged(cfg, {
      reasons: detail.brief.reasons.filter((x: any) => x.kind !== "ok" && x.kind !== "threads").map((x: any) => x.text),
      agentApprovals, title: ch.title, summary: ch.summary ?? "",
      intent: detail.intents.map((i: any) => `${i.description} (${i.paths.join(", ")})`).join("; "),
      patch: detail.patch, project: this.projectContext(),
    }, await this.judge());
    if (this.change(ch.id).head !== ch.head || this.change(ch.id).status !== "review") return; // moved on meanwhile
    if (v.act) {
      await this.review(deputy, ch.id, { verdict: "approve", body: v.answer });
      this.emit("delegate.decided", { actor: DELEGATE_ID, change: ch.id, task: ch.task_id, data: { kind: "flagged", via: v.via, model: v.model ?? null, decision: v.answer, scores: v.scores ?? null } });
    } else if (v.reason !== "waiting for an agent review first") {
      this.escalate(null, ch.id, ch.task_id, v.reason, v.scores, "flagged");
    }
  }

  /** Where the project stands, for the deputy's model: guidance like "early on" or "while it's a few agents" needs it. */
  private projectContext(): ProjectContext {
    const merged = this.sql.exec("SELECT title, files FROM changes WHERE status = 'merged' ORDER BY updated_at DESC LIMIT 500").toArray();
    const tests = new Set<string>();
    for (const r of merged) for (const f of JSON.parse(r.files as string) as FileChange[]) if (isTest(f.path)) tests.add(f.path);
    const first = this.sql.exec("SELECT MIN(ts) AS t FROM events").one().t as number | null;
    const agents = this.agentStates().filter((a) => a.id !== DELEGATE_ID);
    const n = (sql: string) => this.sql.exec(sql).one().n as number;
    return {
      concept: (this.meta("description") ?? "").slice(0, 1000),
      age_days: first ? Math.floor((Date.now() - first) / 86_400_000) : 0,
      agents: {
        total: agents.filter((a) => a.role !== "human").length,
        working_now: agents.filter((a) => a.state === "working" || a.state === "waiting" || a.state === "conflict").length,
        people: agents.filter((a) => a.role === "human").length,
      },
      main: { merged_changes: n("SELECT COUNT(*) AS n FROM changes WHERE status = 'merged'"), version: this.mainVersion, test_files: tests.size },
      in_flight: {
        open_tasks: n("SELECT COUNT(*) AS n FROM tasks WHERE status NOT IN ('merged','closed','abandoned')"),
        changes_in_review: n("SELECT COUNT(*) AS n FROM changes WHERE status IN ('review','changes_requested')"),
      },
      recently_merged: merged.slice(0, 8).map((r) => String(r.title ?? "")),
      protected_paths: this.protectedPaths,
    };
  }

  private escalated = new Set<string>();
  // ── keys people bring: the deputy's judge, by the project's key or the server's ──

  private keyCache = new Map<KeyKind, string | null>();
  private async projectKey(kind: KeyKind): Promise<string | null> {
    if (this.keyCache.has(kind)) return this.keyCache.get(kind)!;
    const row = this.sql.exec("SELECT ct, iv, sealed_by FROM project_keys WHERE kind = ?", kind).toArray()[0] as any;
    const key = row ? await unseal(this.env, this.project, row) : null;
    this.keyCache.set(kind, key);
    return key;
  }

  /** The deputy's judge: the project's own keys first, then the server's; TypeSafe before Claude. With no key, Clef on Workers AI. */
  private async judge(): Promise<Judge> {
    const jev = (await this.projectKey("jev")) ?? this.env.TYPESAFE_API_KEY;
    if (jev) return { provider: "typesafe", apiKey: jev, url: this.env.TYPESAFE_URL };
    const claude = (await this.projectKey("anthropic")) ?? this.env.ANTHROPIC_API_KEY;
    if (claude) return { provider: "anthropic", apiKey: claude };
    if (this.env.AI) return { provider: "clef", ai: this.env.AI };
    return {};
  }

  /** Where the deputy's judge comes from, without decrypting anything. */
  private jevSource(): string | null {
    const saved = new Set(this.sql.exec("SELECT kind FROM project_keys").toArray().map((r) => r.kind as string));
    if (saved.has("jev")) return "Jev, with the project's TypeSafe key";
    if (this.env.TYPESAFE_API_KEY) return "Jev, with the server's TypeSafe key";
    if (saved.has("anthropic")) return "Claude, with the project's Anthropic key";
    if (this.env.ANTHROPIC_API_KEY) return "Claude, with the server's Anthropic key";
    if (this.env.AI) return "Clef, Cloudflare's decision model on Workers AI (no key needed)";
    return null;
  }

  private keySettings() {
    const rows = new Map(this.sql.exec("SELECT kind, last4, set_by, set_at, sealed_by FROM project_keys").toArray().map((r) => [r.kind as string, r]));
    const server = { jev: !!this.env.TYPESAFE_API_KEY, anthropic: !!this.env.ANTHROPIC_API_KEY };
    return {
      canSave: !!sealer(this.env),
      jevUses: this.jevSource(),
      keys: (Object.keys(KEY_KINDS) as KeyKind[]).map((kind) => {
        const r = rows.get(kind);
        return {
          kind, ...KEY_KINDS[kind],
          saved: r ? { last4: r.last4, setBy: r.set_by, setByName: this.agentName(r.set_by as string) ?? r.set_by, setAt: r.set_at, readable: !!this.env[r.sealed_by === "secret" ? "LOOM_SECRET_KEY" : "LOOM_ADMIN_TOKEN"] } : null,
          serverKey: server[kind],
        };
      }),
    };
  }

  private async saveKey(actor: Agent, kind: KeyKind, value: unknown) {
    const key = typeof value === "string" ? value.trim() : "";
    if (key.length < 8 || /\s/.test(key)) throw new HttpError(400, "paste the whole key");
    let sealed;
    try { sealed = await seal(this.env, this.project, key); } catch (e: any) { throw new HttpError(503, e.message); }
    this.sql.exec(`INSERT OR REPLACE INTO project_keys (kind, ct, iv, sealed_by, last4, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      kind, sealed.ct, sealed.iv, sealed.by, key.slice(-4), actor.id, Date.now());
    this.keyCache.delete(kind);
    this.emit("settings.key_saved", { actor: actor.id, data: { kind, label: KEY_KINDS[kind].label, last4: key.slice(-4) } });
    return this.keySettings();
  }

  private removeKey(actor: Agent, kind: KeyKind) {
    this.sql.exec("DELETE FROM project_keys WHERE kind = ?", kind);
    this.keyCache.delete(kind);
    this.emit("settings.key_removed", { actor: actor.id, data: { kind, label: KEY_KINDS[kind].label } });
    return this.keySettings();
  }

  private escalate(threadId: number | null, changeId: number | null, taskId: number | null, reason: string, scores?: Record<string, number>, kind = "approval") {
    const key = `${threadId}:${changeId}:${changeId ? this.change(changeId).head : ""}`;
    if (this.escalated.has(key)) return;
    this.escalated.add(key);
    if (threadId) this.sql.exec("UPDATE threads SET escalated = ? WHERE id = ?", reason, threadId);
    this.emit("delegate.escalated", { actor: DELEGATE_ID, task: taskId, change: changeId, data: { thread: threadId, kind: threadId ? this.thread(threadId).kind : kind, reason, scores: scores ?? null } });
  }

  // ── stand-ins: a person's own agent, acting for them within limits ──────

  /** Which agent action is a stand-in's, by request, so it can be put on record once it succeeds. */
  private standinActs = new WeakMap<Request, { id: string; name: string; person: string; action: string }>();

  private standinFor(hash: string): Agent {
    const s = this.sql.exec("SELECT id, name, person, scopes FROM standins WHERE key_hash = ? AND revoked_at IS NULL", hash).toArray()[0];
    if (!s) throw new HttpError(401, "unknown agent key");
    this.sql.exec("UPDATE standins SET last_used = ? WHERE id = ?", Date.now(), s.id);
    return this.standinActor(s);
  }

  /** The person a stand-in acts for, carrying the stand-in's rights. */
  private standinActor(s: Record<string, SqlStorageValue>): Agent {
    const p = this.sql.exec("SELECT id, name, role, paused, identity FROM agents WHERE id = ?", s.person).toArray()[0];
    if (!p || p.role !== "human" || p.paused) throw new HttpError(401, "the person this stand-in acts for is no longer in the project");
    return { id: p.id as string, name: p.name as string, role: "human", paused: null, identity: (p.identity as string | null) ?? null, owner: false, standin: { id: s.id as string, name: s.name as string, scopes: JSON.parse(s.scopes as string) } };
  }

  private parseScopes(x: unknown): Scope[] {
    if (!Array.isArray(x)) throw new HttpError(400, `scopes is a list: any of ${Object.keys(SCOPES).join(", ")}, or [] to only watch`);
    const bad = x.filter((s) => typeof s !== "string" || !isScope(s));
    if (bad.length) throw new HttpError(400, `unknown scope ${bad.join(", ")}; use ${Object.keys(SCOPES).join(", ")}`);
    return [...new Set(x as Scope[])];
  }

  private webhookUrl(x: unknown): string | null {
    try { return validWebhook(x); } catch (e: any) { throw new HttpError(400, e.message); }
  }

  private async sealWebhookSecret(): Promise<{ secret: string; sealed: string }> {
    if (!sealer(this.env)) throw new HttpError(503, "set LOOM_SECRET_KEY on the Worker before adding webhooks");
    const secret = `whsec_${randomId(24)}`;
    const s = await seal(this.env, this.project, secret);
    return { secret, sealed: JSON.stringify({ ct: s.ct, iv: s.iv, sealed_by: s.by }) };
  }

  private standinRow(id: string, actor: Agent) {
    const r = this.sql.exec("SELECT * FROM standins WHERE id = ?", id).toArray()[0];
    if (!r) throw new HttpError(404, `no stand-in ${id}`);
    if (r.person !== actor.id && !actor.owner) throw new HttpError(403, "that stand-in acts for someone else");
    return r;
  }

  private standinView(r: Record<string, SqlStorageValue>) {
    return { id: r.id, name: r.name, for: r.person, forName: this.agentName(r.person as string), scopes: JSON.parse(r.scopes as string), webhook: r.webhook ?? null,
      lastDelivery: r.last_delivery ? JSON.parse(r.last_delivery as string) : null, createdAt: r.created_at, lastUsed: r.last_used, revoked: !!r.revoked_at };
  }

  private standins(actor: Agent) {
    const rows = this.sql.exec(`SELECT * FROM standins WHERE (person = ? OR ?) ORDER BY revoked_at IS NOT NULL, created_at DESC`, actor.id, actor.owner ? 1 : 0).toArray();
    return { scopes: SCOPES, standins: rows.map((r) => this.standinView(r)) };
  }

  private async createStandin(actor: Agent, body: { name?: string; scopes?: unknown; webhook?: unknown; for?: string }, origin: string) {
    // People make stand-ins for themselves; the admin token (scripts) names the person.
    let person = actor.id;
    if (actor.id === "admin") {
      if (!body.for) throw new HttpError(400, "with the admin token, say whom it acts for: for = a person's login or id");
      person = this.resolveAgent(body.for);
      if (this.sql.exec("SELECT role FROM agents WHERE id = ?", person).toArray()[0]?.role !== "human") throw new HttpError(400, `${body.for} isn't a person`);
    }
    const name = (body.name ?? "").trim().slice(0, 60);
    if (!name) throw new HttpError(400, "name the agent that will hold it, e.g. my-assistant");
    const scopes = this.parseScopes(body.scopes ?? []);
    const live = this.sql.exec("SELECT COUNT(*) AS n FROM standins WHERE person = ? AND revoked_at IS NULL", person).one().n as number;
    if (live >= 10) throw new HttpError(409, "10 live stand-ins already; revoke one first");
    const webhook = this.webhookUrl(body.webhook ?? null);
    const hook = webhook ? await this.sealWebhookSecret() : null;
    const id = `si_${randomId(6)}`;
    const key = `loomstand_${randomId(24)}`;
    // Items already waiting count as seen, so a new webhook doesn't start with a flood.
    const seen = webhook ? this.attention(this.agentStates()).map((i) => shortKey(itemKey(i))) : [];
    this.sql.exec("INSERT INTO standins (id, name, person, key_hash, scopes, webhook, webhook_secret, seen, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id, name, person, await sha256(key), JSON.stringify(scopes), webhook, hook?.sealed ?? null, JSON.stringify(seen), actor.id, Date.now());
    this.emit("standin.created", { actor: actor.id, to: person, data: { standin: id, name, scopes, webhook: !!webhook } });
    return {
      ...this.standinView(this.sql.exec("SELECT * FROM standins WHERE id = ?", id).one()),
      key, webhookSecret: hook?.secret ?? null,
      skill: `${origin}/api/projects/${this.project}/standin-skill`,
      howTo: `Give your agent the skill and this key as LOOM_STANDIN_KEY. Shown once: Loom keeps only its hash.${hook ? " Check webhook deliveries with the secret: x-loom-signature is sha256=<hex HMAC-SHA256 of the body>." : ""}`,
    };
  }

  private async updateStandin(actor: Agent, id: string, body: { scopes?: unknown; webhook?: unknown; name?: string }) {
    const r = this.standinRow(id, actor);
    if (r.revoked_at) throw new HttpError(409, "that stand-in was revoked; make a new one");
    let webhookSecret: string | null = null;
    if (body.scopes !== undefined) this.sql.exec("UPDATE standins SET scopes = ? WHERE id = ?", JSON.stringify(this.parseScopes(body.scopes)), id);
    if (body.name?.trim()) this.sql.exec("UPDATE standins SET name = ? WHERE id = ?", body.name.trim().slice(0, 60), id);
    if (body.webhook !== undefined) {
      const webhook = this.webhookUrl(body.webhook);
      const hook = webhook && webhook !== r.webhook ? await this.sealWebhookSecret() : null;
      if (!webhook) this.sql.exec("UPDATE standins SET webhook = NULL, webhook_secret = NULL WHERE id = ?", id);
      else if (hook) {
        this.sql.exec("UPDATE standins SET webhook = ?, webhook_secret = ?, seen = ? WHERE id = ?", webhook, hook.sealed, JSON.stringify(this.attention(this.agentStates()).map((i) => shortKey(itemKey(i)))), id);
        webhookSecret = hook.secret;
      }
    }
    const view = this.standinView(this.sql.exec("SELECT * FROM standins WHERE id = ?", id).one());
    this.emit("standin.updated", { actor: actor.id, to: r.person as string, data: { standin: id, name: view.name, scopes: view.scopes, webhook: !!view.webhook } });
    return { ...view, webhookSecret };
  }

  private revokeStandin(actor: Agent, id: string) {
    const r = this.standinRow(id, actor);
    this.sql.exec("UPDATE standins SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?", Date.now(), id);
    this.emit("standin.revoked", { actor: actor.id, to: r.person as string, data: { standin: id, name: r.name } });
    return this.standins(actor);
  }

  private standinInfo(actor: Agent, origin: string) {
    const r = this.sql.exec("SELECT * FROM standins WHERE id = ?", actor.standin!.id).one();
    return {
      standin: { id: r.id, name: r.name }, actsFor: { id: actor.id, name: actor.name },
      can: Object.fromEntries(actor.standin!.scopes.map((s) => [s, SCOPES[s]])),
      cannot: Object.fromEntries(Object.entries(SCOPES).filter(([s]) => !actor.standin!.scopes.includes(s as Scope))),
      webhook: !!r.webhook, dashboard: `${origin}/?project=${this.project}`, feed: `${origin}/api/projects/${this.project}/attention`,
      skill: `${origin}/api/projects/${this.project}/standin-skill`,
    };
  }

  /** Whether the deputy gets the first go at what this event raised (so nobody is told about it yet). */
  private deputyTakes(type: string): boolean {
    const d = this.delegateConfig;
    if (!d.enabled) return false;
    return (type === "question.asked" && d.questions.enabled) || (type === "dispute.ready" && d.disputes.enabled) || (type === "approval.needs_human" && d.approvals.enabled);
  }

  private feedItem(i: any, actor: Agent, origin: string) {
    const key = itemKey(i);
    const scope = itemScope(i);
    return {
      key, id: shortKey(key), kind: i.kind, text: itemText(i, (id) => this.agentName(id)), since: i.since,
      url: `${origin}/?project=${this.project}${i.change ? `#change/${i.change}` : ""}`,
      youCan: scope ? { scope, allowed: !actor.standin || actor.standin.scopes.includes(scope) } : null,
      detail: i,
    };
  }

  /**
   * What needs a person now. known is the last answer's known; items not in it
   * are marked new. With wait (seconds, up to 25), holds until something new
   * needs a person or time runs out.
   */
  private async attentionFeed(actor: Agent, known: string | null, wait: number, origin: string) {
    const seen = new Set((known ?? "").split(/[.,\s]/).filter(Boolean));
    const read = () => this.attention(this.agentStates()).map((i) => ({ ...this.feedItem(i, actor, origin), new: !seen.has(shortKey(itemKey(i))) }));
    let items = read();
    const until = Date.now() + Math.min(Math.max(wait, 0), 25) * 1000;
    while (known !== null && !items.some((i) => i.new) && Date.now() < until) {
      await new Promise<void>((done) => {
        const w = { wants: (e: LoomEvent) => NEEDS_PERSON.has(e.type) && !this.deputyTakes(e.type), wake: () => { clearTimeout(t); setTimeout(done, 300); } };
        const t = setTimeout(() => { this.waiters.delete(w); done(); }, until - Date.now());
        this.waiters.add(w);
      });
      items = read();
    }
    return { items, known: items.map((i) => i.id).join("."), newCount: items.filter((i) => i.new).length };
  }

  private notifyPending = false;
  /** Check stand-in webhooks shortly, once for a burst of events. */
  private notifySoon() {
    if (this.notifyPending) return;
    if (!this.sql.exec("SELECT 1 FROM standins WHERE webhook IS NOT NULL AND revoked_at IS NULL LIMIT 1").toArray().length) return;
    this.notifyPending = true;
    this.ctx.waitUntil(new Promise((r) => setTimeout(r, 1500))
      .then(() => { this.notifyPending = false; return this.notifyWatchers(); })
      .catch((err) => console.error("stand-in webhook", err)));
  }

  /** POST what newly needs a person to each stand-in's webhook. Each item goes once while it stays open. */
  private async notifyWatchers() {
    const hooks = this.sql.exec("SELECT * FROM standins WHERE webhook IS NOT NULL AND revoked_at IS NULL").toArray();
    if (!hooks.length) return;
    const origin = this.meta("origin") ?? "";
    const all = this.attention(this.agentStates());
    for (const h of hooks) {
      let actor: Agent;
      try { actor = this.standinActor(h); } catch { continue; }
      const items = all.map((i) => this.feedItem(i, actor, origin));
      const seen = new Set(JSON.parse((h.seen as string) ?? "[]"));
      const fresh = items.filter((i) => !seen.has(i.id));
      this.sql.exec("UPDATE standins SET seen = ? WHERE id = ?", JSON.stringify(items.map((i) => i.id)), h.id);
      if (fresh.length) await this.deliver(h, fresh.map((i) => ({ ...i, new: true })), origin);
    }
    // Stuck work needs no event to need a person, so look again in a while.
    await this.armAlarm(Date.now() + 5 * 60_000);
  }

  private async deliver(h: Record<string, SqlStorageValue>, items: any[], origin: string) {
    const secret = h.webhook_secret ? await unseal(this.env, this.project, JSON.parse(h.webhook_secret as string)) : null;
    const body = JSON.stringify({ project: this.project, standin: { id: h.id, name: h.name }, actsFor: this.agentName(h.person as string), dashboard: `${origin}/?project=${this.project}`, items });
    let result: { at: number; status: number | null; error?: string };
    try {
      const res = await fetch(h.webhook as string, {
        method: "POST", signal: AbortSignal.timeout(10_000),
        headers: { "content-type": "application/json", "user-agent": "loom", "x-loom-event": "needs-person", ...(secret ? { "x-loom-signature": `sha256=${await signBody(secret, body)}` } : {}) },
        body,
      });
      result = { at: Date.now(), status: res.status, ...(res.ok ? {} : { error: (await res.text().catch(() => "")).slice(0, 200) }) };
    } catch (e: any) {
      result = { at: Date.now(), status: null, error: String(e?.message ?? e).slice(0, 200) };
    }
    this.sql.exec("UPDATE standins SET last_delivery = ? WHERE id = ?", JSON.stringify({ ...result, items: items.length }), h.id);
    return result;
  }

  private async testStandin(actor: Agent, id: string, origin: string) {
    const r = this.standinRow(id, actor);
    if (!r.webhook) throw new HttpError(400, "that stand-in has no webhook");
    const item = { key: "test", id: shortKey("test"), kind: "test", text: `Test from Loom: ${r.name} will hear here when something on ${this.project} needs ${this.agentName(r.person as string)}.`, since: Date.now(), url: `${origin}/?project=${this.project}`, youCan: null, detail: {}, new: true };
    return this.deliver(r, [item], origin);
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
      project: { name: this.project, description: this.meta("description"), frozen: this.meta("frozen"), protectedPaths: this.protectedPaths, mainHead: this.meta("main_head"), mainVersion: this.mainVersion, requiredApprovals: this.requiredApprovals, approvalMode: this.approvalMode, resolveThreads: this.threadsMustResolve, checks: this.checks, questions: this.questionRules, model: this.modelOptions, visibility: this.isPrivate ? "private" : "public" },
      delegate: { ...this.delegateConfig, id: DELEGATE_ID, jevConnected: !!this.jevSource(), jevUses: this.jevSource() },
      health: {
        agents: { total: agents.filter((a) => a.state !== "human").length, byState },
        tasks: taskCounts, changes: changeCounts,
        reviewTasks: this.reviewTasks().reduce((n: Record<string, number>, t) => ({ ...n, [t.status]: (n[t.status] ?? 0) + 1 }), { open: 0, assigned: 0, in_progress: 0 }),
        queue: { depth: queued.length, oldestWaitMs: queued.length ? now - Math.min(...queued.slice(0, 50).map((q) => waitedFor(q.id as number))) : 0 },
        mergedLastHour: mergedHour, conflictsLastHour: conflictsHour,
        conflictRate: mergedHour + conflictsHour ? conflictsHour / (mergedHour + conflictsHour) : 0,
        people: this.peopleLoad(now),
        series,
      },
      attention: this.attention(agents),
      areas: this.areas(),
      queue: queued.slice(0, 12).map((q) => ({ id: q.id, title: q.title, agent: q.agent_id, agentName: this.agentName(q.agent_id as string), status: q.status, waitingMs: now - waitedFor(q.id as number) })),
      recentlyMerged: this.sql.exec("SELECT id, title, agent_id, merged_version, updated_at FROM changes WHERE status = 'merged' ORDER BY updated_at DESC LIMIT 8").toArray()
        .map((c) => ({ id: c.id, title: c.title, agent: c.agent_id, agentName: this.agentName(c.agent_id as string), version: c.merged_version, at: c.updated_at })),
      decisions: this.decisionRows("retired_at IS NULL ORDER BY id DESC LIMIT 30"),
      contests: this.contestSummaries(),
      notes: this.noteRows("retired_at IS NULL ORDER BY id DESC LIMIT 12"),
      discussions: this.sql.exec("SELECT id FROM threads WHERE kind IN ('discussion','contract') AND status = 'open' ORDER BY updated_at DESC LIMIT 6").toArray().map((r) => this.thread(r.id as number)),
      notable: this.notable(agents.length),
      names: Object.fromEntries(this.sql.exec("SELECT id, name FROM agents WHERE id IN (SELECT DISTINCT actor FROM events WHERE seq > (SELECT COALESCE(MAX(seq), 0) - 400 FROM events) UNION SELECT DISTINCT to_agent FROM events WHERE seq > (SELECT COALESCE(MAX(seq), 0) - 400 FROM events)) OR role = 'human'").toArray().map((r) => [r.id, r.name])),
      lastSeq: (this.sql.exec("SELECT MAX(seq) AS s FROM events").one().s as number) ?? 0,
    };
  }

  /** How much the swarm is asking of people: questions waiting, asked and answered in the last hour, and how many went ahead on a default. */
  private peopleLoad(now: number) {
    const hour = now - 3600_000;
    const asked = this.sql.exec("SELECT COUNT(*) AS n FROM events WHERE type = 'question.asked' AND ts > ? AND json_extract(data, '$.audience') = 'humans'", hour).one().n as number;
    const answered = this.sql.exec("SELECT json_extract(data, '$.defaulted') AS d, COUNT(*) AS n FROM events WHERE type = 'question.answered' AND ts > ? GROUP BY d", hour).toArray();
    const waiting = this.sql.exec("SELECT COUNT(*) AS n, MIN(created_at) AS t FROM threads WHERE kind = 'question' AND to_agent = 'humans' AND status = 'open'").one();
    return {
      waiting: waiting.n as number, oldestMs: waiting.t ? now - (waiting.t as number) : 0,
      askedLastHour: asked,
      answeredLastHour: answered.filter((r) => !r.d).reduce((n, r) => n + (r.n as number), 0),
      defaultedLastHour: answered.filter((r) => r.d).reduce((n, r) => n + (r.n as number), 0),
      rules: this.questionRules,
    };
  }

  /** What needs a person, then what is stuck. Similar questions are grouped. */
  private attention(agents: ReturnType<ProjectCoordinator["agentStates"]>) {
    const now = Date.now();
    const items: any[] = [];
    const open = this.sql.exec("SELECT id FROM threads WHERE status = 'open' AND kind IN ('question','dispute','proposal') ORDER BY created_at").toArray().map((r) => this.thread(r.id as number));
    // Similar questions are one card: agents ask the same thing in different words.
    const groups: any[] = [];
    for (const t of open.filter((t) => t.kind === "question" && t.to_agent === "humans")) {
      const q = (t.posts[0]?.body ?? t.title) as string;
      let g = groups.find((g) => sameQuestion(g.question, q) || similarity(g.question, q) >= SIMILAR_QUESTION);
      if (!g) groups.push(g = { kind: "question", question: q, options: t.options, threads: [], askers: [], blocking: 0, defaults: 0, deadline: null, default: null, escalated: t.escalated, since: t.created_at });
      g.threads.push(t.id);
      g.askers.push(t.created_by);
      if (t.blocking) g.blocking++;
      if (t.default_answer) {
        g.defaults++;
        if (!g.deadline || t.deadline < g.deadline) { g.deadline = t.deadline; g.default = t.default_answer; }
      }
      g.escalated = g.escalated ?? t.escalated;
    }
    // The questions holding up the most agents come first.
    groups.sort((a, b) => b.blocking - a.blocking || b.threads.length - a.threads.length || a.since - b.since);
    items.push(...groups);
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
    // Changes whose review brief says a person should look (protected paths are listed above).
    const listed = new Set(items.filter((i) => i.kind === "approval").map((i) => i.change));
    for (const r of this.sql.exec("SELECT id FROM changes WHERE status = 'review' ORDER BY updated_at DESC LIMIT 30").toArray()) {
      if (listed.has(r.id)) continue;
      const c = this.change(r.id as number);
      const brief = this.briefFor(c, "");
      if (!brief.needsPerson || brief.reasons.some((x) => x.kind === "protected")) continue;
      const why = this.sql.exec("SELECT data FROM events WHERE type = 'delegate.escalated' AND change_id = ? ORDER BY seq DESC LIMIT 1", c.id).toArray()[0];
      items.push({ kind: "brief", change: c.id, title: c.title, agent: c.agent_id, reasons: brief.reasons.filter((x) => x.kind !== "ok" && x.kind !== "threads").map((x) => x.text), escalated: why ? JSON.parse(why.data as string).reason : null, since: c.updated_at });
    }
    // Reviews an agent asked a person for.
    for (const r of this.sql.exec(`SELECT r.change_id, r.reviewer, r.requested_by, r.reason, r.created_at, c.title FROM review_requests r
                                   JOIN changes c ON c.id = r.change_id JOIN agents a ON a.id = r.reviewer
                                   WHERE r.status IN ('open','accepted') AND a.role = 'human' AND c.status IN ('review','changes_requested') LIMIT 50`).toArray()) {
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
    for (const c of this.sql.exec(`SELECT c.id, c.title, c.agent_id, c.updated_at, (SELECT GROUP_CONCAT(reviewer) FROM review_requests r WHERE r.change_id = c.id AND r.status IN ('open','accepted')) AS asked
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
    const rank: Record<string, number> = { dispute: 0, question: 1, approval: 2, brief: 2, review: 2, stuck: 3 };
    // Stable sort: questions keep their own order (most blocked first).
    return items.sort((a, b) => rank[a.kind] - rank[b.kind] || (a.kind === "question" ? 0 : a.since - b.since));
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
    for (const c of this.sql.exec("SELECT files, agent_id FROM changes WHERE status IN ('review','queued','merging','conflict','changes_requested','checks_failed')").toArray()) {
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
    // Someone who declined or let a request lapse isn't asked again for this change.
    for (const r of this.sql.exec("SELECT reviewer FROM review_requests WHERE change_id = ? AND status IN ('declined','expired')", id).toArray()) reviewed.add(r.reviewer as string);
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
    const load = new Map(this.sql.exec("SELECT reviewer, COUNT(*) AS n FROM review_requests WHERE status IN ('open','accepted') GROUP BY reviewer").toArray().map((r) => [r.reviewer as string, r.n as number]));
    const people = new Map(this.sql.exec("SELECT id, name, role, paused, last_seen FROM agents").toArray().map((a) => [a.id as string, a]));
    const present = (a: any) => a && now - ((a.last_seen as number) ?? 0) < PRESENT_MS;
    const out: Candidate[] = [];
    for (const [agent, s] of scores) {
      const a = people.get(agent);
      if (!a || a.paused || a.role === "human" || agent === DELEGATE_ID) continue;
      const open = load.get(agent) ?? 0;
      // Fold a folder's many small reasons into one line.
      const reasons = [...new Map(s.reasons.sort((x, y) => y.w - x.w).map((r) => [r.text, r])).values()].slice(0, 3).map((r) => r.text);
      // Agents come and go: knowledge counts for less when its owner isn't around to use it.
      if (!present(a)) reasons.push(`last seen ${since(now - ((a.last_seen as number) ?? 0))} ago`);
      // Reviewers whose judgment has held up are asked first.
      const weight = this.weightOf(agent);
      if (Math.abs(weight - 1) >= 0.15) reasons.push(`track record counts ${weight}x`);
      out.push({ agent, name: a.name as string, role: a.role as string, score: Math.round((s.score * weight * (present(a) ? 1 : 0.35)) / (1 + 0.5 * open) * 100) / 100, reasons, openReviews: open, present: present(a) });
    }
    out.sort((x, y) => y.score - x.score);
    if (out.length < limit) {
      for (const a of people.values()) {
        if (a.role !== "reviewer" || a.paused || a.id === ch.agent_id || reviewed.has(a.id as string) || out.some((c) => c.agent === a.id)) continue;
        const open = load.get(a.id as string) ?? 0;
        out.push({ agent: a.id as string, name: a.name as string, role: "reviewer", score: 0, reasons: [`on the reviewer rota, ${open} open review${open === 1 ? "" : "s"}`], openReviews: open, present: present(a) });
      }
      out.sort((x, y) => y.score - x.score || Number(y.present) - Number(x.present) || x.openReviews - y.openReviews);
    }
    return out.slice(0, limit);
  }

  /**
   * The best-placed reviewers. With the project's "model picks reviewers"
   * option on, the decision model reorders the top few by who is best placed;
   * otherwise (or if it fails) the familiarity score decides.
   */
  private async rankedCandidates(id: number, limit: number): Promise<Candidate[]> {
    const pool = this.reviewerCandidates(id, Math.max(limit, 6));
    if (!this.modelOptions.reviewers || pool.length < 2) return pool.slice(0, limit);
    const ch = this.change(id);
    const intent = this.sql.exec("SELECT description, paths FROM intents WHERE task_id = ?", ch.task_id).toArray().map((i) => `${i.description} (${JSON.parse(i.paths as string).join(", ")})`).join("; ");
    const ranked = await rankReviewers(await this.judge(), { title: ch.title, summary: ch.summary ?? "", files: (ch.files as FileChange[]).map((f) => f.path), intent }, pool);
    if (!ranked) return pool.slice(0, limit);
    const p = ranked.probabilities;
    return pool
      .map((c) => ({ ...c, reasons: [...c.reasons, `${ranked.model} rates them ${Math.round((p[c.agent] ?? 0) * 100)}% best placed`] }))
      .sort((x, y) => (p[y.agent] ?? 0) - (p[x.agent] ?? 0) || y.score - x.score)
      .slice(0, limit);
  }

  /** With the project's "model checks intent" option on, judge whether the diff does what its task declared. */
  private async checkChangeIntent(id: number, patch: string) {
    if (!this.modelOptions.intent) return;
    const ch = this.change(id);
    const intent = this.sql.exec("SELECT description, paths FROM intents WHERE task_id = ?", ch.task_id).toArray().map((i) => `${i.description || "(no description)"} (${JSON.parse(i.paths as string).join(", ")})`).join("; ");
    const v = await checkIntent(await this.judge(), { title: ch.title, summary: ch.summary ?? "", intent, patch }).catch(() => null);
    if (!v) return;
    this.sql.exec("UPDATE changes SET intent_check = ? WHERE id = ?", JSON.stringify({ ...v, head: ch.head, at: Date.now() }), id);
    if (v.score < 0.5) this.emit("change.off_intent", { change: id, task: ch.task_id, to: ch.agent_id, data: { score: v.score, model: v.model, intent } });
  }

  private reviewRequests(id: number): any[] {
    return this.sql.exec("SELECT * FROM review_requests WHERE change_id = ? ORDER BY created_at", id).toArray()
      .map((r) => ({ ...r, reviewerName: this.agentName(r.reviewer as string), requestedByName: this.agentName(r.requested_by as string) }));
  }

  /** Ask specific agents to review a change: named ones, or the best-placed few. */
  private async requestReviewers(actor: Agent, id: number, body: { reviewers?: string[]; count?: number; note?: string }) {
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
      const open = new Set(this.reviewRequests(id).map((r) => r.reviewer as string));
      picked = (await this.rankedCandidates(id, want + open.size)).filter((c) => !open.has(c.agent)).slice(0, want).map((c) => ({ agent: c.agent, reason: c.reasons[0] }));
    }
    for (const p of picked) this.assignReviewer(id, p.agent, actor.id, p.reason, body.note);
    return { requested: this.reviewRequests(id) };
  }

  private assignReviewer(id: number, reviewer: string, by: string, reason: string, note?: string) {
    const ch = this.change(id);
    const now = Date.now();
    // People answer from the dashboard on their own time: no deadline for them.
    const human = this.sql.exec("SELECT role FROM agents WHERE id = ?", reviewer).toArray()[0]?.role === "human";
    const deadline = human ? null : now + ACCEPT_MS;
    const fresh = this.sql.exec(`INSERT INTO review_requests (change_id, reviewer, requested_by, reason, status, created_at, deadline) VALUES (?, ?, ?, ?, 'open', ?, ?)
                   ON CONFLICT (change_id, reviewer) DO UPDATE SET status = 'open', reason = excluded.reason, created_at = excluded.created_at, deadline = excluded.deadline,
                     seen_at = NULL, answered_at = NULL WHERE status NOT IN ('open','accepted')
                   RETURNING change_id`, id, reviewer, by, reason, now, deadline).toArray().length;
    if (!fresh) return;
    this.emit("review.assigned", { actor: by, change: id, task: ch.task_id, to: reviewer, data: {
      title: ch.title, reason, note: note ?? "", files: (ch.files as FileChange[]).map((f) => f.path),
      respond: human ? "" : `Accept or decline within ${ACCEPT_MS / 60_000} minutes (respond_to_review_request). If you don't answer, someone else is asked.`,
    } });
    if (deadline) void this.armAlarm(deadline);
  }

  /** Wake for whichever comes first: a queued merge retry or a review request deadline. */
  private async armAlarm(at: number) {
    const current = await this.ctx.storage.getAlarm();
    if (!current || current > at) await this.ctx.storage.setAlarm(at);
  }

  /** A reviewer says yes (and has REVIEW_MS to deliver) or no (and someone else is asked). */
  private respondToReview(actor: Agent, id: number, body: { accept: boolean; reason?: string }) {
    const r = this.sql.exec("SELECT * FROM review_requests WHERE change_id = ? AND reviewer = ?", id, actor.id).toArray()[0];
    if (!r) throw new HttpError(404, `you weren't asked to review change ${id}`);
    if (!["open", "accepted"].includes(r.status as string)) throw new HttpError(409, `this request is ${r.status}`);
    const ch = this.change(id);
    const now = Date.now();
    if (body.accept) {
      this.sql.exec("UPDATE review_requests SET status = 'accepted', answered_at = ?, seen_at = COALESCE(seen_at, ?), deadline = ? WHERE change_id = ? AND reviewer = ?", now, now, now + REVIEW_MS, id, actor.id);
      this.emit("review.accepted", { actor: actor.id, change: id, task: ch.task_id, to: ch.agent_id, data: { note: body.reason ?? "" } });
      void this.armAlarm(now + REVIEW_MS);
    } else {
      this.sql.exec("UPDATE review_requests SET status = 'declined', answered_at = ?, seen_at = COALESCE(seen_at, ?) WHERE change_id = ? AND reviewer = ?", now, now, id, actor.id);
      this.emit("review.declined", { actor: actor.id, change: id, task: ch.task_id, to: ch.agent_id, data: { reason: body.reason ?? "" } });
      this.reroute(id, `${actor.name} declined${body.reason ? `: ${body.reason}` : ""}`);
    }
    return { requested: this.reviewRequests(id) };
  }

  /**
   * Reviews as agent tasks: one per change waiting on review. Each is asked
   * of someone (assigned), being done (in_progress), or open for any agent to
   * take. With an agent: the ones it may do (not its own, not done already).
   */
  private reviewTasks(forAgent?: string) {
    const rows = this.sql.exec("SELECT id, task_id, title, agent_id, head, updated_at FROM changes WHERE status = 'review' ORDER BY updated_at").toArray();
    const out = [];
    for (const c of rows) {
      if (this.openContest(c.task_id as number)) continue; // contests are decided by votes
      const approval = this.approval(c.id as number);
      if (approval.ok) continue;
      const reviewers = this.sql.exec("SELECT reviewer, status FROM review_requests WHERE change_id = ? AND status IN ('open','accepted')", c.id).toArray()
        .map((r) => ({ agent: r.reviewer as string, name: this.agentName(r.reviewer as string), status: r.status === "accepted" ? "reviewing" : "asked" }));
      const task = {
        kind: "review", change: c.id as number, title: `Review #${c.id}: ${c.title}`, author: c.agent_id as string, authorName: this.agentName(c.agent_id as string),
        status: reviewers.some((r) => r.status === "reviewing") ? "in_progress" : reviewers.length ? "assigned" : "open",
        reviewers, approval: `${approval.weight} of ${approval.needed}`, needsPerson: approval.humanNeeded, since: c.updated_at as number,
      };
      if (forAgent) {
        if (task.author === forAgent) continue;
        if (this.sql.exec("SELECT 1 FROM reviews WHERE change_id = ? AND reviewer = ? AND head = ?", c.id, forAgent, c.head).toArray().length) continue;
        if (task.status !== "open" && !reviewers.some((r) => r.agent === forAgent)) continue;
      }
      out.push(task);
    }
    return out;
  }

  /** Take an open review task: it becomes yours, accepted, with the usual time to deliver. */
  private takeReview(actor: Agent, id: number) {
    const ch = this.change(id);
    if (ch.agent_id === actor.id) throw new HttpError(403, "agents cannot review their own change");
    if (!["review", "changes_requested"].includes(ch.status)) throw new HttpError(409, `change ${id} is ${ch.status}, not in review`);
    this.assignReviewer(id, actor.id, actor.id, "took it from the open review tasks");
    if (actor.role !== "human") this.respondToReview(actor, id, { accept: true, reason: "took it" });
    return { taken: id, requested: this.reviewRequests(id), next: "get_change (start with its brief), then review_change" };
  }

  /** Ask the next best-placed agent, preferring ones who are around now. */
  private reroute(id: number, why: string) {
    const ch = this.change(id);
    if (!["review", "changes_requested"].includes(ch.status)) return;
    const asked = new Set(this.reviewRequests(id).map((r) => r.reviewer as string));
    const next = this.reviewerCandidates(id, 10).filter((c) => !asked.has(c.agent)).sort((x, y) => Number(y.present) - Number(x.present) || y.score - x.score)[0];
    this.emit("review.rerouted", { change: id, task: ch.task_id, to: ch.agent_id, data: { why, to: next?.agent ?? null, toName: next?.name ?? null } });
    if (next) this.assignReviewer(id, next.agent, "loom", `${next.reasons[0]} (${why})`);
  }

  /** Requests nobody accepted in time, or accepted and never delivered, go to someone else. */
  private sweepReviewRequests() {
    const now = Date.now();
    for (const r of this.sql.exec("SELECT * FROM review_requests WHERE status IN ('open','accepted') AND deadline IS NOT NULL AND deadline <= ?", now).toArray()) {
      this.sql.exec("UPDATE review_requests SET status = 'expired' WHERE change_id = ? AND reviewer = ?", r.change_id, r.reviewer);
      const who = this.agentName(r.reviewer as string);
      this.reroute(r.change_id as number, r.status === "open" ? `${who} didn't answer` : `${who} accepted but didn't review in time`);
    }
    return this.sql.exec("SELECT MIN(deadline) AS t FROM review_requests WHERE status IN ('open','accepted') AND deadline IS NOT NULL").one().t as number | null;
  }

  /** Questions with a default that nobody answered in time: the asker goes ahead with its default. */
  private sweepQuestions() {
    const now = Date.now();
    for (const r of this.sql.exec("SELECT id FROM threads WHERE kind = 'question' AND status = 'open' AND deadline IS NOT NULL AND deadline <= ?", now).toArray()) {
      const t = this.thread(r.id as number);
      const asker: Agent = { id: t.created_by, name: this.agentName(t.created_by) ?? t.created_by, role: "builder" };
      const text = `No one answered in time, so ${asker.name} goes ahead with its default: ${t.default_answer}`;
      this.sql.exec("INSERT INTO posts (thread_id, author, body, created_at) VALUES (?, ?, ?, ?)", t.id, asker.id, text, now);
      this.answer(t, asker, t.default_answer, true);
    }
    return this.sql.exec("SELECT MIN(deadline) AS t FROM threads WHERE kind = 'question' AND status = 'open' AND deadline IS NOT NULL").one().t as number | null;
  }

  /** Mark review requests delivered once the reviewer has actually received them. */
  private markSeen(agent: string, events: LoomEvent[]) {
    for (const e of events) {
      if (e.type === "review.assigned" && e.to_agent === agent && e.change_id) {
        this.sql.exec("UPDATE review_requests SET seen_at = COALESCE(seen_at, ?) WHERE change_id = ? AND reviewer = ?", Date.now(), e.change_id, agent);
      }
    }
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
      reviewQueue: this.sql.exec("SELECT r.change_id, r.reason, r.created_at, r.requested_by, c.title, c.status FROM review_requests r JOIN changes c ON c.id = r.change_id WHERE r.reviewer = ? AND r.status IN ('open','accepted') ORDER BY r.created_at LIMIT 20", a.id).toArray()
        .map((r) => ({ ...r, requestedByName: this.agentName(r.requested_by as string) })),
      reviewTasks: this.reviewTasks(a.id).filter((t) => t.reviewers.some((r) => r.agent === a.id)),
      reviewStats: this.reviewStats(a.id),
      trust: a.role === "human" ? null : this.trustOf(a.id),
      knows: this.knows(a.id),
    };
  }

  /** Answer several agents' copies of the same question at once: one decision, every asker unblocked. */
  /** One answer for a group of similar questions; or, with goAhead, let each asker go ahead with its own default now. */
  private answerGroup(actor: Agent, threads: number[], text: string, goAhead = false) {
    if (!text && !goAhead) throw new HttpError(400, "body is required");
    let open = threads.map((id) => this.thread(id)).filter((t) => t.kind === "question" && t.status === "open");
    if (goAhead) open = open.filter((t) => t.default_answer);
    open.forEach((t, i) => {
      this.citing = !goAhead && i > 0;
      try { this.post(actor, t.id, goAhead ? `Go ahead with your default: ${t.default_answer}` : text); } finally { this.citing = false; }
    });
    return { answered: open.map((t) => t.id) };
  }

  // ── memory: what the humans decided, and what earlier agents tried ──────

  /** Set while the deputy cites an earlier decision, so the citation isn't recorded as a new one. */
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
    const notes = this.relevantNotes(paths, text, 8);
    if (decisions.some((d) => d.paths.length) || pastEfforts.length || notes.length) {
      this.emit("memory.recalled", {
        actor: actor.id, task: taskId,
        data: { paths, decisions: decisions.map((d) => d.id), notes: notes.map((n) => n.id), efforts: pastEfforts.map((e) => e.change), consult: consult.map((c) => c.agent) },
      });
    }
    return { decisions, notes, pastEfforts, consult };
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
    return { related, decisions: this.relevantDecisions(files, about), notes: this.relevantNotes(files, about, 8) };
  }

  // ── notes: what agents learned, left for the agents who come after ──────

  private static NOTE_KINDS = ["fact", "gotcha", "convention", "howto"];

  private remember(actor: Agent, body: { text?: string; kind?: string; paths?: string[]; taskId?: number; changeId?: number }, quiet = false) {
    const text = body.text?.trim();
    if (!text) throw new HttpError(400, "text is required");
    if (text.length > 2000) throw new HttpError(400, "keep a note to one statement (2000 characters at most)");
    const kind = ProjectCoordinator.NOTE_KINDS.includes(body.kind ?? "") ? body.kind! : "fact";
    const paths = (body.paths ?? []).map(normalizePattern).filter(Boolean);
    // The same thing said again confirms the earlier note rather than adding a copy.
    const twin = this.noteRows("retired_at IS NULL ORDER BY id DESC LIMIT 500").find((n) => sameQuestion(n.text, text) || similarity(n.text, text) >= 0.8);
    if (twin) {
      if (twin.by !== actor.id) this.rateNote(actor, twin.id, { agree: true, comment: "said the same" });
      return { ...this.noteRows("id = ?", twin.id)[0], duplicateOf: twin.id };
    }
    const row = this.sql.exec("INSERT INTO notes (by, kind, text, paths, task_id, change_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
      actor.id, kind, text, JSON.stringify(paths), body.taskId ?? null, body.changeId ?? null, Date.now()).one();
    const id = row.id as number;
    if (!quiet) this.emit("note.added", { actor: actor.id, task: body.taskId ?? null, change: body.changeId ?? null, data: { note: id, kind, text, paths } });
    return this.noteRows("id = ?", id)[0];
  }

  private rateNote(actor: Agent, id: number, body: { agree?: boolean; comment?: string }) {
    const n = this.noteRows("id = ?", id)[0];
    if (!n) throw new HttpError(404, `no note ${id}`);
    if (n.by === actor.id) throw new HttpError(400, "you can't rate your own note; retire it if it's wrong");
    this.sql.exec("INSERT OR REPLACE INTO note_votes (note_id, agent, agree, comment, created_at) VALUES (?, ?, ?, ?, ?)", id, actor.id, body.agree === false ? 0 : 1, body.comment ?? "", Date.now());
    this.emit("note.rated", { actor: actor.id, to: n.by, data: { note: id, agree: body.agree !== false, comment: body.comment ?? "" } });
    return this.noteRows("id = ?", id)[0];
  }

  private retireNote(actor: Agent, id: number) {
    const n = this.noteRows("id = ?", id)[0];
    if (!n) throw new HttpError(404, `no note ${id}`);
    if (n.by !== actor.id && actor.role !== "human") throw new HttpError(403, "only its author or a person can retire a note; rate_note to dispute it");
    this.sql.exec("UPDATE notes SET retired_at = ?, retired_by = ? WHERE id = ?", Date.now(), actor.id, id);
    this.emit("note.retired", { actor: actor.id, data: { note: id } });
    return { ok: true };
  }

  /** Notes with their standing: confirmations and disputes, each weighed by the rater's track record. */
  private noteRows(where: string, ...args: SqlStorageValue[]) {
    const rows = this.sql.exec(`SELECT * FROM notes WHERE ${where}`, ...args).toArray();
    return rows.map((r) => {
      const votes = this.sql.exec("SELECT agent, agree, comment FROM note_votes WHERE note_id = ?", r.id).toArray();
      let standing = 0;
      for (const v of votes) standing += (v.agree ? 1 : -1) * this.weightOf(v.agent as string);
      return {
        id: r.id as number, kind: r.kind as string, text: r.text as string, paths: JSON.parse(r.paths as string) as string[],
        by: r.by as string, byName: this.agentName(r.by as string), task: r.task_id as number | null, change: r.change_id as number | null,
        createdAt: r.created_at as number, retired: !!r.retired_at,
        confirmed: votes.filter((v) => v.agree).length, disputed: votes.filter((v) => !v.agree).length,
        disputes: votes.filter((v) => !v.agree && v.comment).map((v) => ({ by: this.agentName(v.agent as string), comment: v.comment as string })),
        standing: Math.round(standing * 100) / 100,
      };
    });
  }

  /**
   * Notes that bear on these paths or this question, best first. A note is
   * ranked by how well it matches, how its raters judged it, and its author's
   * track record. Notes more agents dispute than confirm aren't handed out.
   */
  private relevantNotes(paths: string[], text = "", limit = 10) {
    const all = this.noteRows("retired_at IS NULL ORDER BY id DESC LIMIT 500");
    return all
      .map((n) => {
        const onPaths = n.paths.length > 0 && paths.length > 0 && anyOverlap(n.paths, paths).length > 0;
        const match = (onPaths ? 2 : 0) + (n.paths.length === 0 ? 0.4 : 0) + (text ? similarity(text, n.text) * 3 : 0);
        return { n, match, score: match * (0.5 + this.weightOf(n.by) / 2) + 0.5 * n.standing };
      })
      .filter((x) => x.match >= 0.4 && x.n.standing > -1)
      .sort((a, b) => b.score - a.score || b.n.id - a.n.id)
      .slice(0, limit)
      .map((x) => x.n);
  }

  private listNotes(q: URLSearchParams) {
    const paths = (q.get("paths") ?? "").split(",").map((p) => p.trim()).filter(Boolean);
    const text = q.get("q") ?? "";
    if (!paths.length && !text) return this.noteRows("retired_at IS NULL ORDER BY id DESC LIMIT 100");
    return this.relevantNotes(paths, text, 30);
  }

  /** When a change lands, the notes its author left in its context become the project's. */
  private async notesFromContext(ch: any) {
    const ctx = await this.env.CONTEXT.get(`${this.project}/changes/${ch.id}/context.json`);
    const saved = ctx ? ((await ctx.json()) as any) : null;
    const raw = saved?.context?.notes;
    if (!Array.isArray(raw)) return;
    const author = { id: ch.agent_id as string, name: this.agentName(ch.agent_id) ?? ch.agent_id, role: "builder" as Role };
    const files = (ch.files as FileChange[]).map((f) => f.path);
    for (const item of raw.slice(0, 10)) {
      const note = typeof item === "string" ? { text: item } : item;
      if (!note?.text) continue;
      try {
        this.remember(author, { text: String(note.text), kind: note.kind, paths: Array.isArray(note.paths) && note.paths.length ? note.paths : files, taskId: ch.task_id, changeId: ch.id });
      } catch {}
    }
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
   * Open a dispute with another agent. Each side states a position; the deputy rules
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
  private openThread(actor: Agent, body: { silent?: boolean; kind?: "discussion" | "question" | "contract" | "review"; taskId?: number; changeId?: number; path?: string; line?: number; title?: string; body: string; to?: string; blocking?: boolean; options?: unknown; default?: string }) {
    if (!body.body) throw new HttpError(400, "body is required");
    const kind = body.kind ?? "discussion";
    const toHumans = kind === "question" && body.to === "humans";
    const rules = this.questionRules;
    if (toHumans && actor.role !== "human" && actor.id !== "admin" && rules.maxOpen > 0) {
      const open = this.sql.exec("SELECT COUNT(*) AS n FROM threads WHERE kind = 'question' AND to_agent = 'humans' AND status = 'open' AND created_by = ?", actor.id).one().n as number;
      if (open >= rules.maxOpen) {
        throw new HttpError(429, `You already have ${open} open question${open === 1 ? "" : "s"} for people, and this project allows ${rules.maxOpen}. Wait for those answers, check recall_decisions, or decide yourself and note why in your change context.`);
      }
    }
    const fallback = toHumans && typeof body.default === "string" && body.default.trim() ? body.default.trim().slice(0, 2000) : null;
    const deadline = fallback ? Date.now() + rules.deadlineMinutes * 60_000 : null;
    const taskId = body.taskId ?? (body.changeId ? this.change(body.changeId).task_id : null);
    const now = Date.now();
    const blocking = kind === "question" && !!body.blocking && !!taskId;
    const prev = blocking ? this.task(taskId!).status : null;
    const options = kind === "question" ? normalizeOptions(body.options) : null;
    const row = this.sql
      .exec(`INSERT INTO threads (kind, task_id, change_id, path, line, title, created_by, to_agent, blocking, prev_task_status, options, default_answer, deadline, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        kind, taskId, body.changeId ?? null, body.path ?? null, body.line ?? null, body.title ?? body.body.split("\n")[0].slice(0, 80),
        actor.id, body.to ?? null, blocking ? 1 : 0, prev, options ? JSON.stringify(options) : null, fallback, deadline, now, now)
      .one();
    const id = row.id as number;
    this.sql.exec("INSERT INTO posts (thread_id, author, body, created_at) VALUES (?, ?, ?, ?)", id, actor.id, body.body, now);
    if (blocking) this.sql.exec("UPDATE tasks SET status = 'blocked', updated_at = ? WHERE id = ?", now, taskId);
    const to = body.to && body.to !== "humans" ? body.to : null;
    if (!body.silent) this.emit(kind === "question" ? "question.asked" : kind === "contract" ? "contract.published" : "thread.opened", {
      actor: actor.id, task: taskId, change: body.changeId ?? null, to,
      data: { thread: id, title: body.title ?? null, body: body.body, path: body.path ?? null, line: body.line ?? null, audience: body.to ?? "everyone", blocking, options, default: fallback, deadline },
    });
    if (deadline) void this.armAlarm(deadline);
    return this.thread(id);
  }

  private post(actor: Agent, threadId: number, text: string) {
    if (!text) throw new HttpError(400, "body is required");
    const t = this.thread(threadId);
    this.sql.exec("INSERT INTO posts (thread_id, author, body, created_at) VALUES (?, ?, ?, ?)", threadId, actor.id, text, Date.now());
    this.sql.exec("UPDATE threads SET updated_at = ? WHERE id = ?", Date.now(), threadId);
    // Everyone already in the thread hears about the reply.
    const participants = new Set<string>([t.created_by, ...t.posts.map((p: any) => p.author)]);
    if (t.kind === "review" && t.to_agent && t.to_agent !== "humans") participants.add(t.to_agent);
    participants.delete(actor.id);
    this.emit("thread.reply", { actor: actor.id, task: t.task_id, change: t.change_id, data: { thread: threadId, body: text, participants: [...participants] } });
    for (const p of participants) this.emit("thread.reply.notify", { actor: actor.id, to: p, task: t.task_id, change: t.change_id, data: { thread: threadId, body: text, ...(t.kind === "review" ? { path: t.path, line: t.line } : {}) } });
    // An answer from someone other than the asker settles a question.
    if (t.kind === "question" && t.status === "open" && actor.id !== t.created_by) this.answer(t, actor, text);
    return this.thread(threadId);
  }

  private answer(t: any, actor: Agent, text: string, defaulted = false) {
    this.sql.exec("UPDATE threads SET status = 'answered', updated_at = ? WHERE id = ?", Date.now(), t.id);
    if (t.to_agent === "humans" && (actor.role === "human" || actor.id === "admin") && !this.citing) {
      this.recordDecision("answer", actor, { question: t.posts[0]?.body ?? t.title, decision: text, paths: this.threadPaths(t), task: t.task_id, change: t.change_id, thread: t.id });
    }
    if (t.blocking && t.task_id) {
      this.sql.exec("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND status = 'blocked'", t.prev_task_status ?? "claimed", Date.now(), t.task_id);
    }
    this.emit("question.answered", { actor: actor.id, to: t.created_by, task: t.task_id, data: { thread: t.id, question: t.title, answer: text, unblocked: !!t.blocking, defaulted } });
  }

  private resolveThread(actor: Agent, threadId: number, text?: string) {
    const t = this.thread(threadId);
    if (text) this.post(actor, threadId, text);
    if (t.kind === "question" && t.status === "open" && !text) this.answer(t, actor, "(closed without an answer)");
    this.sql.exec("UPDATE threads SET status = 'resolved', resolved_by = ?, updated_at = ? WHERE id = ?", actor.id, Date.now(), threadId);
    this.emit("thread.resolved", { actor: actor.id, task: t.task_id, change: t.change_id, to: t.kind === "review" && t.created_by !== actor.id ? t.created_by : null, data: { thread: threadId, path: t.path, line: t.line } });
    return this.thread(threadId);
  }

  /** Reopen a resolved review thread, when the fix didn't settle it. */
  private reopenThread(actor: Agent, threadId: number, text?: string) {
    const t = this.thread(threadId);
    if (t.kind !== "review") throw new HttpError(400, "only review threads can be reopened");
    if (text) this.post(actor, threadId, text);
    this.sql.exec("UPDATE threads SET status = 'open', resolved_by = NULL, updated_at = ? WHERE id = ?", Date.now(), threadId);
    this.emit("thread.reopened", { actor: actor.id, task: t.task_id, change: t.change_id, to: t.to_agent, data: { thread: threadId, body: text ?? "", path: t.path, line: t.line } });
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

  /**
   * Everything waiting for an agent, for one that checks back after hours away:
   * review requests, its tasks and changes, and what was addressed to it.
   */
  /** Open contests with at least two attempts in, where this agent may vote and hasn't. */
  private contestsToVote(actor: Agent) {
    if (actor.role === "human") return [];
    return this.sql.exec(`SELECT p.id, p.title, (SELECT COUNT(*) FROM changes c JOIN tasks t ON t.id = c.task_id WHERE t.parent = p.id AND c.status IN ('review','changes_requested')) AS ready
        FROM tasks p WHERE p.contest_status = 'open'
          AND NOT EXISTS (SELECT 1 FROM contest_votes v WHERE v.contest = p.id AND v.voter = ?)
          AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.parent = p.id AND t.attempt = 1 AND t.assignee = ?)
          AND NOT EXISTS (SELECT 1 FROM changes c JOIN tasks t ON t.id = c.task_id WHERE t.parent = p.id AND c.agent_id = ?)`, actor.id, actor.id, actor.id).toArray()
      .filter((r) => (r.ready as number) >= 2).map((r) => ({ id: r.id as number, title: r.title as string, ready: r.ready as number }));
  }

  private me(actor: Agent) {
    const reviewRequests = this.sql.exec(`SELECT r.change_id, r.status, r.reason, r.created_at, r.deadline, c.title FROM review_requests r JOIN changes c ON c.id = r.change_id
                                          WHERE r.reviewer = ? AND r.status IN ('open','accepted') ORDER BY r.created_at`, actor.id).toArray();
    const now = Date.now();
    for (const r of reviewRequests) this.sql.exec("UPDATE review_requests SET seen_at = COALESCE(seen_at, ?) WHERE change_id = ? AND reviewer = ?", now, r.change_id, actor.id);
    const tasks = this.sql.exec("SELECT id, title, status FROM tasks WHERE assignee = ? AND status NOT IN ('merged','abandoned')", actor.id).toArray();
    const changes = this.sql.exec("SELECT id, task_id, title, status FROM changes WHERE agent_id = ? AND status NOT IN ('merged','abandoned') ORDER BY id DESC LIMIT 20", actor.id).toArray();
    const submitted = new Set(changes.map((c) => c.task_id));
    const todo = [
      ...reviewRequests.map((r) => r.status === "open" ? `Answer the review request on #${r.change_id} (respond_to_review_request), then review it` : `Review #${r.change_id}: you accepted it`),
      ...changes.filter((c) => ["conflict", "changes_requested", "checks_failed"].includes(c.status as string)).map((c) => `Your change #${c.id} is ${c.status}: get_change, then fix and update_change`),
      ...changes.map((c) => ({ c, n: this.openBlockingThreads(c.id as number) })).filter((x) => x.n).map(({ c, n }) => `Your change #${c.id} has ${n} open review thread${n === 1 ? "" : "s"}: fix each and resolve_thread it, or reply_thread if you disagree (get_change lists them)`),
      ...tasks.filter((t) => !submitted.has(t.id)).map((t) => `Your task #${t.id} has no change yet: finish it and submit_change`),
      ...this.contestsToVote(actor).map((c) => `Contest #${c.id} "${c.title}" has ${c.ready} attempts in: compare_attempts, then vote`),
    ];
    const reviewTasks = this.reviewTasks(actor.id);
    const untaken = reviewTasks.filter((t) => t.status === "open");
    if (untaken.length && actor.role !== "human") todo.push(`${untaken.length} review task${untaken.length === 1 ? "" : "s"} nobody has taken (${untaken.slice(0, 3).map((t) => `#${t.change}`).join(", ")}${untaken.length > 3 ? ", …" : ""}): take_review one, then get_change and review_change`);
    return {
      agent: actor, mainFrozen: this.meta("frozen"), todo, reviewRequests, reviewTasks, tasks, changes,
      openTasks: this.sql.exec("SELECT COUNT(*) AS n FROM tasks WHERE status = 'open'").one().n,
      // How many questions for people this agent has open, against the project's limit.
      questions: { open: this.sql.exec("SELECT COUNT(*) AS n FROM threads WHERE kind = 'question' AND to_agent = 'humans' AND status = 'open' AND created_by = ?", actor.id).one().n, ...this.questionRules },
      inbox: this.inbox(actor.id),
    };
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
    if (agent) this.markSeen(agent, res.events);
    if (!res.events.length && wait > 0) {
      await new Promise<void>((done) => {
        const w = { wants, wake: () => { clearTimeout(t); done(); } };
        const t = setTimeout(() => { this.waiters.delete(w); done(); }, Math.min(wait, 25) * 1000);
        this.waiters.add(w);
      });
      res = read();
      if (agent) this.markSeen(agent, res.events);
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
    for (const r of this.sql.exec("SELECT change_id FROM review_requests WHERE reviewer = ? AND status IN ('open','accepted')", agent).toArray()) changes.add(r.change_id as number);
    // Changes it reviewed: it hears whether they landed.
    for (const r of this.sql.exec("SELECT DISTINCT change_id FROM reviews WHERE reviewer = ?", agent).toArray()) changes.add(r.change_id as number);
    // Contests it has an attempt in or voted in: it hears the votes and the result.
    for (const r of this.sql.exec("SELECT parent FROM tasks WHERE assignee = ? AND attempt = 1 UNION SELECT contest FROM contest_votes WHERE voter = ?", agent, agent).toArray()) tasks.add(r.parent as number);
    return (e) => {
      if (e.to_agent) return e.to_agent === agent;
      if (STEERING.has(e.type)) return true;
      if (role === "reviewer" && (e.type === "review.requested" || e.type === "change.updated" || e.type === "contest.ready" || e.type === "contest.decided")) return true;
      return (e.task_id !== null && tasks.has(e.task_id)) || (e.change_id !== null && changes.has(e.change_id));
    };
  }

  /**
   * Tasks for the dashboard's list: newest first, filtered by status or by
   * stage (the groups the health bar shows), each with who holds it, what it
   * declared it would touch and the change it submitted.
   */
  private listTasks(q: URLSearchParams) {
    const STAGES: Record<string, string[]> = { open: ["open"], active: ["claimed", "blocked", "conflict"], review: ["in_review", "queued"], landed: ["merged"], closed: ["closed", "abandoned"] };
    const statuses = q.get("stage") ? STAGES[q.get("stage")!] ?? [] : q.get("status") ? [q.get("status")!] : null;
    const text = (q.get("q") ?? "").trim().toLowerCase();
    const where = [
      statuses ? `t.status IN (${statuses.map(() => "?").join(",") || "NULL"})` : "1",
      text ? "(lower(t.title) LIKE ? OR t.id = ?)" : "1",
    ].join(" AND ");
    const args: SqlStorageValue[] = [...(statuses ?? []), ...(text ? [`%${text}%`, Number(text.replace(/^#/, "")) || -1] : [])];
    const rows = this.sql.exec(`SELECT t.id, t.title, t.description, t.status, t.assignee, t.depends_on, t.parent, t.attempts, t.created_by, t.updated_at FROM tasks t WHERE ${where} ORDER BY t.id DESC LIMIT ?`,
      ...args, Math.min(200, Number(q.get("limit") ?? 50))).toArray();
    return rows.map((t) => {
      const intent = this.sql.exec("SELECT paths, description, released_at FROM intents WHERE task_id = ? ORDER BY id DESC LIMIT 1", t.id).toArray()[0];
      const change = this.sql.exec("SELECT id, title, status FROM changes WHERE task_id = ? ORDER BY id DESC LIMIT 1", t.id).toArray()[0];
      return {
        ...t, depends_on: JSON.parse(t.depends_on as string), assigneeName: this.agentName(t.assignee as string),
        intent: intent ? { paths: JSON.parse(intent.paths as string), description: intent.description, live: intent.released_at === null } : null,
        change: change ?? null,
      };
    });
  }

  /** One task on its own: who holds it, its intents, changes, conversations and history. */
  private taskView(taskId: number) {
    const task = this.task(taskId);
    const names = (ids: (string | null)[]) => Object.fromEntries(ids.filter(Boolean).map((id) => [id, this.agentName(id)]));
    const intents = this.sql.exec("SELECT * FROM intents WHERE task_id = ? ORDER BY id DESC", taskId).toArray().map((r) => ({ ...r, paths: JSON.parse(r.paths as string) }));
    const changes = this.sql.exec("SELECT c.id, c.title, c.status, c.agent_id, c.files, c.created_at, c.updated_at FROM changes c WHERE c.task_id = ? ORDER BY c.id DESC", taskId).toArray()
      .map((c) => ({ ...c, files: (JSON.parse(c.files as string) as FileChange[]).map((f) => f.path) }));
    const events = this.rowsToEvents(this.sql.exec("SELECT * FROM events WHERE task_id = ? OR change_id IN (SELECT id FROM changes WHERE task_id = ?) ORDER BY seq DESC LIMIT 80", taskId, taskId).toArray());
    return {
      task: { ...task, workspace: undefined },
      names: names([task.assignee, task.created_by, ...intents.map((i: any) => i.agent_id as string), ...changes.map((c: any) => c.agent_id as string), ...events.map((e) => e.actor)]),
      dependsOn: task.depends_on.map((id: number) => this.sql.exec("SELECT id, title, status FROM tasks WHERE id = ?", id).toArray()[0]).filter(Boolean),
      waitsFor: task.waits_for ? this.sql.exec("SELECT id, title, status FROM tasks WHERE id = ?", task.waits_for).toArray()[0] ?? null : null,
      parent: task.parent ? this.sql.exec("SELECT id, title, status, attempts FROM tasks WHERE id = ?", task.parent).toArray()[0] ?? null : null,
      subtasks: this.sql.exec("SELECT id, title, status, assignee FROM tasks WHERE parent = ? ORDER BY id", taskId).toArray(),
      intents, changes,
      threads: this.sql.exec("SELECT id FROM threads WHERE task_id = ? ORDER BY updated_at DESC LIMIT 20", taskId).toArray().map((r) => this.thread(r.id as number)),
      decisions: this.decisionRows("task_id = ? ORDER BY id DESC LIMIT 20", taskId),
      events,
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
      delegate: { ...this.delegateConfig, id: DELEGATE_ID, jevConnected: !!this.jevSource(), jevUses: this.jevSource() },
      project: { name: this.project, description: this.meta("description"), frozen: this.meta("frozen"), protectedPaths: this.protectedPaths, mainHead: this.meta("main_head"), mainVersion: this.mainVersion, requiredApprovals: this.requiredApprovals, checks: this.checks, visibility: this.isPrivate ? "private" : "public", remote: this.remoteUrl(this.mainRepo) },
      agents, tasks, reviewTasks: this.reviewTasks(), intents: this.activeIntents(), changes, reviews, events,
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

