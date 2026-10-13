import { handleMcp } from "./mcp";
import { USER_HEADER, handleAuth, isAdmin, sessionUser, type User } from "./auth";
import type { Env } from "./env";
import { parseJurisdiction, projectNamespace, type Jurisdiction } from "./residency";
import { projectOfWorkspace, pushOf } from "./events";

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

function mayCreate(env: Env, user: User): boolean {
  const list = (env.LOOM_CREATORS ?? "*").split(",").map((l) => l.trim().toLowerCase()).filter(Boolean);
  const owners = (env.LOOM_OWNERS ?? "").split(",").map((l) => l.trim().toLowerCase());
  return list.includes("*") || list.includes(user.login.toLowerCase()) || owners.includes(user.login.toLowerCase());
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/api/projects" && req.method === "GET") {
      // Private projects are listed only to people (or keys) who can read them.
      const all = await registry(env).fetch("https://do/registry").then((r) => r.json<{ name: string; private: boolean; jurisdiction: Jurisdiction | null }[]>());
      for (const p of all) located.set(p.name, p.jurisdiction ?? null);
      const user = await sessionUser(env, req);
      const headers: Record<string, string> = {};
      if (req.headers.get("authorization")) headers.authorization = req.headers.get("authorization")!;
      if (user) headers[USER_HEADER] = JSON.stringify(user);
      const seen = await Promise.all(all.map(async (p) => !p.private || (await (await coordinator(env, p.name)).fetch("https://do/visible", { headers }).then((r) => r.json<{ visible: boolean }>()).catch(() => ({ visible: false }))).visible));
      return Response.json(all.filter((_, i) => seen[i]).map((p) => ({ ...p, jurisdiction: p.jurisdiction ?? null })));
    }

    const auth = await handleAuth(env, req, (p, init) => registry(env).fetch(`https://do${p}`, init));
    if (auth) return auth;

    if (path === "/api/projects" && req.method === "POST") {
      // People create projects signed in with GitHub and own them; the admin token still works for scripts.
      const admin = await isAdmin(env, req);
      const user = admin ? null : await sessionUser(env, req);
      if (!admin && !user) return Response.json({ error: "sign in with GitHub to create a project" }, { status: 401 });
      if (user && !mayCreate(env, user)) return Response.json({ error: `${user.login} can't create projects on this server` }, { status: 403 });
      const body = await req.json<any>();
      if (!PROJECT_NAME.test(body.name ?? "")) return Response.json({ error: "name must be lowercase letters, digits and dashes" }, { status: 400 });
      const jurisdiction = parseJurisdiction(env, body.jurisdiction);
      if (jurisdiction && typeof jurisdiction === "object") return Response.json({ error: jurisdiction.error }, { status: jurisdiction.status });
      // Names are unique across jurisdictions: a project in the EU and one elsewhere can't share one.
      if ((await locate(env, body.name)).exists) return Response.json({ error: "project already exists" }, { status: 409 });
      const ns = projectNamespace(env, jurisdiction);
      const res = await ns.get(ns.idFromName(body.name)).fetch("https://do/init", { method: "POST", body: JSON.stringify({ ...body, jurisdiction, owner: user ?? undefined }) });
      if (res.ok) {
        await registry(env).fetch("https://do/registry", { method: "POST", body: JSON.stringify({ name: body.name, description: body.description, private: body.visibility === "private", jurisdiction }) });
        located.set(body.name, jurisdiction);
      }
      return res;
    }

    let m = path.match(/^\/api\/projects\/([a-z0-9-]+)\/(.*)$/);
    if (m && /^(init|registry|visible|artifacts-event)\b/.test(m[2])) return Response.json({ error: "not found" }, { status: 404 });
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
