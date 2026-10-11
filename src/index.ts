import { handleMcp } from "./mcp";
import { USER_HEADER, handleAuth, sessionUser, type User } from "./auth";
import type { Env } from "./env";

export { ProjectCoordinator } from "./coordinator";

const PROJECT_NAME = /^[a-z0-9][a-z0-9-]{1,40}$/;

function coordinator(env: Env, name: string) {
  return env.PROJECT.get(env.PROJECT.idFromName(name));
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
  return coordinator(env, project).fetch(out);
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
      const all = await coordinator(env, "__registry").fetch("https://do/registry").then((r) => r.json<{ name: string; private: boolean }[]>());
      const user = await sessionUser(env, req);
      const headers: Record<string, string> = {};
      if (req.headers.get("authorization")) headers.authorization = req.headers.get("authorization")!;
      if (user) headers[USER_HEADER] = JSON.stringify(user);
      const seen = await Promise.all(all.map(async (p) => !p.private || (await coordinator(env, p.name).fetch("https://do/visible", { headers }).then((r) => r.json<{ visible: boolean }>()).catch(() => ({ visible: false }))).visible));
      return Response.json(all.filter((_, i) => seen[i]));
    }

    const auth = await handleAuth(env, req, (p, init) => coordinator(env, "__registry").fetch(`https://do${p}`, init));
    if (auth) return auth;

    if (path === "/api/projects" && req.method === "POST") {
      // People create projects signed in with GitHub and own them; the admin token still works for scripts.
      const admin = !!env.LOOM_ADMIN_TOKEN && req.headers.get("authorization") === `Bearer ${env.LOOM_ADMIN_TOKEN}`;
      const user = admin ? null : await sessionUser(env, req);
      if (!admin && !user) return Response.json({ error: "sign in with GitHub to create a project" }, { status: 401 });
      if (user && !mayCreate(env, user)) return Response.json({ error: `${user.login} can't create projects on this server` }, { status: 403 });
      const body = await req.json<any>();
      if (!PROJECT_NAME.test(body.name ?? "")) return Response.json({ error: "name must be lowercase letters, digits and dashes" }, { status: 400 });
      const res = await coordinator(env, body.name).fetch("https://do/init", { method: "POST", body: JSON.stringify({ ...body, owner: user ?? undefined }) });
      if (res.ok) {
        await coordinator(env, "__registry").fetch("https://do/registry", { method: "POST", body: JSON.stringify({ name: body.name, description: body.description, private: body.visibility === "private" }) });
      }
      return res;
    }

    let m = path.match(/^\/api\/projects\/([a-z0-9-]+)\/(.*)$/);
    if (m && /^(init|registry|visible)\b/.test(m[2])) return Response.json({ error: "not found" }, { status: 404 });
    if (m) return forward(env, req, m[1], m[2]);

    m = path.match(/^\/mcp\/([a-z0-9-]+)$/);
    if (m) {
      const project = m[1];
      const auth = req.headers.get("authorization") ?? "";
      return handleMcp(req, async (method, p, body) => {
        const res = await coordinator(env, project).fetch(`https://do${p}`, {
          method,
          headers: { authorization: auth, "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const data = await res.json<any>();
        if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
        return data;
      });
    }

    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
