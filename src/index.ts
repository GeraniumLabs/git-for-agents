import { handleMcp } from "./mcp";
import { USER_HEADER, githubGrant, handleAuth, isAdmin, sessionUser, type User } from "./auth";
import type { Env } from "./env";
import { parseJurisdiction, projectNamespace, type Jurisdiction } from "./residency";
import { projectOfWorkspace, pushOf } from "./events";
import { MAX_ATTACHMENT_BYTES, tooBig } from "./attachments";

import { AGENT_HEADER, DIRECTIVES_HEADER } from "./coordinator";
import { PLANS, billingOn, checkoutSession, planUpdate, portalSession, serverLimits, verifyStripe, type PlanRow, type ProjectPlan } from "./billing";
export { ProjectCoordinator } from "./coordinator";
export { CheckRunner } from "./checks";

const PROJECT_NAME = /^[a-z0-9][a-z0-9-]{1,40}$/;

async function planOf(env: Env, login: string) {
  return registry(env).fetch(`https://do/registry/plan?login=${encodeURIComponent(login.toLowerCase())}`).then((r) => r.json<PlanRow & { owned: { name: string; jurisdiction: Jurisdiction | null }[] }>());
}

/** A plan changed: record it, then tell each project the person owns, so its limits follow. */
async function applyPlan(env: Env, u: PlanRow & { at: number }) {
  const r = await registry(env).fetch("https://do/registry/plan", { method: "POST", body: JSON.stringify(u) }).then((r) => r.json<{ applied: boolean; owned?: { name: string }[] }>());
  if (!r.applied || logins(env.LOOM_OWNERS).includes(u.login)) return;
  for (const p of r.owned ?? []) await (await coordinator(env, p.name)).fetch("https://do/plan", { method: "POST", body: JSON.stringify({ plan: u.plan }) });
}

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
async function mayCreate(env: Env, user: User): Promise<{ ok: true; plan: ProjectPlan } | { ok: false; error: string }> {
  const login = user.login.toLowerCase();
  if (logins(env.LOOM_OWNERS).includes(login)) return { ok: true, plan: "unlimited" };
  const list = logins(env.LOOM_CREATORS ?? "*");
  const r = await registry(env).fetch(`https://do/registry/creator?login=${encodeURIComponent(login)}`).then((r) => r.json<{ approved: boolean; owns: number }>());
  if (!list.includes("*") && !list.includes(login) && !r.approved) {
    await registry(env).fetch("https://do/registry/waitlist", { method: "POST", body: JSON.stringify({ login, name: user.name }) });
    return { ok: false, error: `Loom is invite-only for now. You're on the waitlist as ${user.login}, and you'll be able to create projects once you're let in. You can still join projects you're added to.` };
  }
  if (!billingOn(env)) {
    const cap = serverLimits(env).projects;
    if (cap > 0 && r.owns >= cap) return { ok: false, error: `You own ${r.owns} projects, the most this server allows each person. Delete one in its Settings to make room.` };
    return { ok: true, plan: "free" };
  }
  const plan = (await planOf(env, login)).plan;
  const cap = PLANS[plan].projects;
  if (r.owns >= cap) return { ok: false, error: plan === "free"
    ? `The free plan has ${cap} project${cap === 1 ? "" : "s"}, and you have ${r.owns}. Loom Pro (${PLANS.pro.price}) gives you ${PLANS.pro.projects}: upgrade under Billing, or delete one in its Settings.`
    : `You own ${r.owns} projects, the most Loom Pro allows. Delete one in its Settings to make room.` };
  return { ok: true, plan };
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

    // Billing: a person's plan, Checkout to upgrade, Stripe's portal to manage it, and Stripe's webhook.
    if (path === "/api/stripe/webhook" && req.method === "POST") {
      if (!billingOn(env)) return Response.json({ error: "billing is off" }, { status: 404 });
      const raw = await req.text();
      if (!(await verifyStripe(env.STRIPE_WEBHOOK_SECRET!, req.headers.get("stripe-signature"), raw))) return Response.json({ error: "bad signature" }, { status: 400 });
      const u = planUpdate(JSON.parse(raw));
      if (u) await applyPlan(env, u);
      return Response.json({ received: true });
    }
    if (path.startsWith("/api/billing")) {
      const user = await sessionUser(env, req);
      if (path === "/api/billing" && req.method === "GET") {
        if (!billingOn(env)) return Response.json({ enabled: false });
        if (!user) return Response.json({ enabled: true, plans: PLANS });
        const p = await planOf(env, user.login);
        const unlimited = logins(env.LOOM_OWNERS).includes(user.login.toLowerCase());
        return Response.json({ enabled: true, plans: PLANS, plan: unlimited ? "unlimited" : p.plan, status: p.status, renews: p.renews, projects: p.owned.length, manage: !!p.customer });
      }
      if (!billingOn(env)) return Response.json({ error: "this server takes no payments" }, { status: 404 });
      if (!user) return Response.json({ error: "sign in with GitHub first" }, { status: 401 });
      const p = await planOf(env, user.login);
      const back = (await req.json<{ back?: string }>().catch(() => ({} as { back?: string }))).back;
      const ret = typeof back === "string" && back.startsWith("/") && !back.startsWith("//") ? back : "/";
      try {
        if (path === "/api/billing/checkout" && req.method === "POST") {
          if (p.plan === "pro") return Response.json({ error: "you're already on Loom Pro" }, { status: 409 });
          return Response.json({ url: await checkoutSession(env, user.login.toLowerCase(), p.customer, url.origin, ret) });
        }
        if (path === "/api/billing/portal" && req.method === "POST") {
          if (!p.customer) return Response.json({ error: "you have no billing account yet" }, { status: 404 });
          return Response.json({ url: await portalSession(env, p.customer, `${url.origin}${ret}`) });
        }
      } catch (e: any) {
        return Response.json({ error: String(e?.message ?? e) }, { status: 502 });
      }
      return Response.json({ error: "not found" }, { status: 404 });
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
      let plan: ProjectPlan = "unlimited";
      if (user) {
        const may = await mayCreate(env, user);
        if (!may.ok) return Response.json({ error: may.error }, { status: 403 });
        plan = may.plan;
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
      const res = await ns.get(ns.idFromName(body.name)).fetch("https://do/init", { method: "POST", body: JSON.stringify({ ...body, jurisdiction, owner: user ?? undefined, plan }) });
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
