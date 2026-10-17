import { handleMcp } from "./mcp";
import { USER_HEADER, githubGrant, handleAuth, isAdmin, sessionUser, type User } from "./auth";
import type { Env } from "./env";
import { parseJurisdiction, projectNamespace, type Jurisdiction } from "./residency";
import { projectOfWorkspace, pushOf } from "./events";
import { MAX_ATTACHMENT_BYTES, tooBig } from "./attachments";

import { AGENT_HEADER, DIRECTIVES_HEADER } from "./coordinator";
export { ProjectCoordinator } from "./coordinator";
export { CheckRunner } from "./checks";

const PROJECT_NAME = /^[a-z0-9][a-z0-9-]{1,40}$/;

function registry(env: Env) {
  return env.PROJECT.get(env.PROJECT.idFromName("__registry"));
}

/** Where each project's coordinator lives. A project never moves, so this isolate keeps what it learns. */
const located = new Map<string, Jurisdiction | null>();

async function locate(env: Env, name: string): Promise<{ exists: boolean; jurisdiction: Jurisdiction | null }> {
  if (located.has(name)) return { exists: true, jurisdiction: located.get(name)! };
  const r = await registry(env).fetch(`https://do/registry/where?name=${encodeURIComponent(name)}`).then((r) => r.json<{ exists: boolean; jurisdiction: Jurisdiction | null }>());
  if (r.exists) located.set(name, r.jurisdiction ?? null);
  return r;
}

async function coordinator(env: Env, name: string) {
  const ns = projectNamespace(env, (await locate(env, name)).jurisdiction);
  return ns.get(ns.idFromName(name));
}

/** Hand Artifacts events to the coordinator of the project whose workspace they are about. */
async function deliverEvent(env: Env, msg: unknown) {
  const push = pushOf(msg);
  const project = push && projectOfWorkspace(push.repo);
  if (!push || !project || !(await locate(env, project)).exists) return;
  const res = await (await coordinator(env, project)).fetch("https://do/artifacts-event", { method: "POST", body: JSON.stringify(push) });
  if (res.status >= 500) throw new Error(`push to ${push.repo}: ${res.status} ${await res.text()}`);
}

/**
 * Forward to a project's coordinator, rewriting the path to what follows the
 * project name. The signed-in person, if any, rides along in x-loom-user; a
 * client can never set that header itself.
 */
async function forward(env: Env, req: Request, project: string, rest: string): Promise<Response> {
  const url = new URL(req.url);
  url.pathname = "/" + rest;
  const out = new Request(url, req);
  out.headers.delete(USER_HEADER);
  const user = await sessionUser(env, req);
  if (user) out.headers.set(USER_HEADER, JSON.stringify(user));
  return (await coordinator(env, project)).fetch(out);
}

const logins = (v: string | undefined) => (v ?? "").split(",").map((l) => l.trim().toLowerCase()).filter(Boolean);

/**
 * Whether a person may create a project, and if not, why. LOOM_CREATORS
 * (unset or "*": anyone) lists who may; the admin can let more people in from
 * the waitlist, which everyone else joins by trying. Past the owners of the
 * server, each person owns at most LOOM_PROJECTS_PER_PERSON projects.
 */
async function mayCreate(env: Env, user: User): Promise<{ ok: true } | { ok: false; error: string }> {
  const login = user.login.toLowerCase();
  if (logins(env.LOOM_OWNERS).includes(login)) return { ok: true };
  const list = logins(env.LOOM_CREATORS ?? "*");
  const r = await registry(env).fetch(`https://do/registry/creator?login=${encodeURIComponent(login)}`).then((r) => r.json<{ approved: boolean; owns: number }>());
  if (!list.includes("*") && !list.includes(login) && !r.approved) {
    await registry(env).fetch("https://do/registry/waitlist", { method: "POST", body: JSON.stringify({ login, name: user.name }) });
    return { ok: false, error: `Loom is invite-only for now. You're on the waitlist as ${user.login}, and you'll be able to create projects once you're let in. You can still join projects you're added to.` };
  }
  const cap = Number(env.LOOM_PROJECTS_PER_PERSON ?? 5);
  if (cap > 0 && r.owns >= cap) return { ok: false, error: `You own ${r.owns} projects, the most this server allows each person. Delete one in its Settings to make room.` };
  return { ok: true };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/api/projects" && req.method === "GET") {
      // Private projects are listed only to people (or keys) who can read them.
      const listed = await registry(env).fetch("https://do/registry").then((r) => r.json<{ name: string; private: boolean; hidden: boolean; jurisdiction: Jurisdiction | null }[]>());
      for (const p of listed) located.set(p.name, p.jurisdiction ?? null);
      // Hidden projects (tests, demos) still open by name; they just aren't listed, except to the admin.
      const admin = await isAdmin(env, req);
      const all = listed.filter((p) => admin || !p.hidden).map(({ hidden, ...p }) => (admin ? { ...p, hidden } : p));
      const user = await sessionUser(env, req);
      const headers: Record<string, string> = {};
      if (req.headers.get("authorization")) headers.authorization = req.headers.get("authorization")!;
      if (user) headers[USER_HEADER] = JSON.stringify(user);
      const seen = await Promise.all(all.map(async (p) => !p.private || (await (await coordinator(env, p.name)).fetch("https://do/visible", { headers }).then((r) => r.json<{ visible: boolean }>()).catch(() => ({ visible: false }))).visible));
      return Response.json(all.filter((_, i) => seen[i]).map((p) => ({ ...p, jurisdiction: p.jurisdiction ?? null })));
    }

    // The admin: who may create projects, who's waiting, and which projects are listed.
    const adm = path.match(/^\/api\/admin\/(waitlist|creators|projects)(?:\/([a-z0-9-]+))?$/);
    if (adm) {
      if (!(await isAdmin(env, req))) return Response.json({ error: "admin token required" }, { status: 401 });
      const [, what, name] = adm;
      if (what === "waitlist" && req.method === "GET") return registry(env).fetch("https://do/registry/waitlist");
      if (what === "creators") {
        if (req.method === "GET") return registry(env).fetch("https://do/registry/creators");
        if (req.method === "POST" || req.method === "DELETE") {
          const body = req.method === "POST" ? await req.json<{ login?: string }>() : { login: name };
          return registry(env).fetch(`https://do/registry/creators?login=${encodeURIComponent(body.login ?? "")}`, { method: req.method, body: JSON.stringify({ login: body.login, by: "admin" }) });
        }
      }
      if (what === "projects" && name && req.method === "PUT") {
        const body = await req.json<{ hidden?: boolean }>();
        if (!(await locate(env, name)).exists) return Response.json({ error: "no such project" }, { status: 404 });
        return registry(env).fetch("https://do/registry/hidden", { method: "PUT", body: JSON.stringify({ name, hidden: !!body.hidden }) });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    }

    const auth = await handleAuth(env, req, (p, init) => registry(env).fetch(`https://do${p}`, init));
    if (auth) return auth;

    if (path === "/api/projects" && req.method === "POST") {
      // People create projects signed in with GitHub and own them; the admin token still works for scripts.
      const admin = await isAdmin(env, req);
      const user = admin ? null : await sessionUser(env, req);
      if (!admin && !user) return Response.json({ error: "sign in with GitHub to create a project" }, { status: 401 });
      if (user) {
        const may = await mayCreate(env, user);
        if (!may.ok) return Response.json({ error: may.error }, { status: 403 });
      }
      const body = await req.json<any>();
      if (!PROJECT_NAME.test(body.name ?? "")) return Response.json({ error: "name must be lowercase letters, digits and dashes" }, { status: 400 });
      // An import without a token reads the person's repositories with the GitHub access they granted, if any.
      if (body.import && !body.import.token && user) body.import.token = (await githubGrant(env, req, user)) ?? undefined;
      const jurisdiction = parseJurisdiction(env, body.jurisdiction);
      if (jurisdiction && typeof jurisdiction === "object") return Response.json({ error: jurisdiction.error }, { status: jurisdiction.status });
      // Names are unique across jurisdictions: a project in the EU and one elsewhere can't share one.
      if ((await locate(env, body.name)).exists) return Response.json({ error: "project already exists" }, { status: 409 });
      const ns = projectNamespace(env, jurisdiction);
      const res = await ns.get(ns.idFromName(body.name)).fetch("https://do/init", { method: "POST", body: JSON.stringify({ ...body, jurisdiction, owner: user ?? undefined }) });
      if (res.ok) {
        await registry(env).fetch("https://do/registry", { method: "POST", body: JSON.stringify({ name: body.name, description: body.description, private: body.visibility === "private", jurisdiction, owner: user?.login ?? null }) });
        located.set(body.name, jurisdiction);
      }
      return res;
    }

    // Deleting a project: its coordinator removes everything it holds, then this isolate forgets where it lived.
    const del = req.method === "DELETE" && path.match(/^\/api\/projects\/([a-z0-9-]+)$/);
    if (del) {
      if (!(await locate(env, del[1])).exists) return Response.json({ error: "no such project" }, { status: 404 });
      const res = await forward(env, req, del[1], "project");
      if (res.ok) located.delete(del[1]);
      return res;
    }

    let m = path.match(/^\/api\/projects\/([a-z0-9-]+)\/(.*)$/);
    if (m && /^(init|registry|visible|artifacts-event|project)\b/.test(m[2])) return Response.json({ error: "not found" }, { status: 404 });
    // Turn away an oversized attachment before its bytes travel on to the coordinator.
    if (m && m[2] === "attachments" && req.method === "POST" && Number(req.headers.get("content-length") ?? 0) > MAX_ATTACHMENT_BYTES) {
      return Response.json({ error: tooBig(Number(req.headers.get("content-length"))).message }, { status: 413, headers: { connection: "close" } });
    }
    if (m && m[2] === "import/issues" && req.method === "POST") {
      const user = await sessionUser(env, req);
      const body = await req.json<any>().catch(() => ({}));
      if (!body.token && user) body.token = (await githubGrant(env, req, user)) ?? undefined;
      return forward(env, new Request(req, { body: JSON.stringify(body) }), m[1], m[2]);
    }
    if (m) return forward(env, req, m[1], m[2]);

    m = path.match(/^\/mcp\/([a-z0-9-]+)$/);
    if (m) {
      const project = m[1];
      const auth = req.headers.get("authorization") ?? "";
      // Which agent under the key: per tool call (as), else per connection (header or ?as=).
      const named = req.headers.get(AGENT_HEADER) ?? url.searchParams.get("as");
      return handleMcp(req, (as) => {
        // The last response's unacknowledged directives, shown with the tool's result.
        let directives: { seq: number; from: string; body: string }[] = [];
        const call = async (method: string, p: string, body?: unknown) => {
          const who = as ?? named;
          const res = await (await coordinator(env, project)).fetch(`https://do${p}`, {
            method,
            headers: { authorization: auth, "content-type": "application/json", ...(who ? { [AGENT_HEADER]: who } : {}) },
            body: body === undefined ? undefined : JSON.stringify(body),
          });
          const pending = res.headers.get(DIRECTIVES_HEADER);
          directives = pending ? JSON.parse(decodeURIComponent(pending)) : [];
          const data = await res.json<any>();
          if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
          return data;
        };
        return Object.assign(call, { directives: () => directives });
      });
    }

    // Local development: the Artifacts shim posts push events here, shaped like the queue's messages.
    if (path === "/api/dev/artifacts-events" && req.method === "POST" && env.LOOM_DEV_LOGIN === "1") {
      for (const msg of await req.json<unknown[]>()) await deliverEvent(env, msg);
      return Response.json({ ok: true });
    }

    return env.ASSETS.fetch(req);
  },

  /** Artifacts event subscriptions arrive on a Queue (see events.ts). */
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      try {
        await deliverEvent(env, msg.body);
        msg.ack();
      } catch (e) {
        console.error("artifacts event", e);
        msg.retry();
      }
    }
  },
} satisfies ExportedHandler<Env>;
