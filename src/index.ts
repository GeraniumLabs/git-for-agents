import { handleMcp } from "./mcp";
import type { Env } from "./env";

export { ProjectCoordinator } from "./coordinator";

const PROJECT_NAME = /^[a-z0-9][a-z0-9-]{1,40}$/;

function coordinator(env: Env, name: string) {
  return env.PROJECT.get(env.PROJECT.idFromName(name));
}

/** Forward to a project's coordinator, rewriting the path to what follows the project name. */
function forward(env: Env, req: Request, project: string, rest: string): Promise<Response> {
  const url = new URL(req.url);
  url.pathname = "/" + rest;
  return coordinator(env, project).fetch(new Request(url, req));
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/api/projects" && req.method === "GET") {
      return coordinator(env, "__registry").fetch("https://do/registry");
    }

    if (path === "/api/projects" && req.method === "POST") {
      if (!env.LOOM_ADMIN_TOKEN || req.headers.get("authorization") !== `Bearer ${env.LOOM_ADMIN_TOKEN}`) {
        return Response.json({ error: "admin token required" }, { status: 401 });
      }
      const body = await req.json<any>();
      if (!PROJECT_NAME.test(body.name ?? "")) return Response.json({ error: "name must be lowercase letters, digits and dashes" }, { status: 400 });
      const res = await coordinator(env, body.name).fetch("https://do/init", { method: "POST", body: JSON.stringify(body) });
      if (res.ok) {
        await coordinator(env, "__registry").fetch("https://do/registry", { method: "POST", body: JSON.stringify({ name: body.name, description: body.description }) });
      }
      return res;
    }

    let m = path.match(/^\/api\/projects\/([a-z0-9-]+)\/(.*)$/);
    if (m && /^(init|registry)\b/.test(m[2])) return Response.json({ error: "not found" }, { status: 404 });
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
