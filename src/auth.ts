// People sign in with GitHub; agents keep their keys.
// A session is a signed cookie (HMAC-SHA256 with LOOM_SECRET_KEY, else
// LOOM_ADMIN_TOKEN), so the Worker needs no session store. The Worker checks
// it and passes the person on to a project as the x-loom-user header, which it
// always strips from incoming requests first.

import type { Env } from "./env";

export interface User {
  /** Stable identity: "github:<lowercase login>". */
  id: string;
  login: string;
  name: string;
  avatar: string;
}

const SESSION = "loom_session";
const STATE = "loom_oauth";
const SESSION_DAYS = 30;
export const USER_HEADER = "x-loom-user";

const enc = new TextEncoder();
const b64url = (u: Uint8Array) => btoa(String.fromCharCode(...u)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

function signingSecret(env: Env): string | undefined {
  return env.LOOM_SECRET_KEY ?? env.LOOM_ADMIN_TOKEN;
}

async function hmac(env: Env, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(`loom-session:${signingSecret(env)}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data))));
}

async function signed(env: Env, payload: object): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  return `${body}.${await hmac(env, body)}`;
}

async function verified<T>(env: Env, token: string | undefined): Promise<T | null> {
  if (!token || !signingSecret(env)) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig || (await hmac(env, body)) !== sig) return null;
  try {
    const data = JSON.parse(new TextDecoder().decode(unb64url(body)));
    return data.exp && data.exp > Date.now() ? (data as T) : null;
  } catch {
    return null;
  }
}

function cookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
}

function setCookie(req: Request, name: string, value: string, maxAge: number): string {
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

/** The signed-in person, if the request carries a valid session. */
export async function sessionUser(env: Env, req: Request): Promise<User | null> {
  const s = await verified<User & { exp: number }>(env, cookie(req, SESSION));
  return s ? { id: s.id, login: s.login, name: s.name, avatar: s.avatar } : null;
}

const githubReady = (env: Env) => !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
const devLogin = (env: Env) => env.LOOM_DEV_LOGIN === "1";

const safeReturn = (r: string | null) => (r && r.startsWith("/") && !r.startsWith("//") ? r : "/");

async function startSession(env: Env, req: Request, user: User, to: string): Promise<Response> {
  const token = await signed(env, { ...user, exp: Date.now() + SESSION_DAYS * 86400_000 });
  const headers = new Headers({ location: to });
  headers.append("set-cookie", setCookie(req, SESSION, token, SESSION_DAYS * 86400));
  headers.append("set-cookie", setCookie(req, STATE, "", 0));
  return new Response(null, { status: 302, headers });
}

/** /auth/* routes, or null when the path isn't one. */
export async function handleAuth(env: Env, req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (!path.startsWith("/auth/")) return null;

  if (path === "/auth/me") {
    return Response.json({ user: await sessionUser(env, req), github: githubReady(env), dev: devLogin(env) });
  }

  if (path === "/auth/logout" && req.method === "POST") {
    return new Response(null, { status: 204, headers: { "set-cookie": setCookie(req, SESSION, "", 0) } });
  }

  if (!signingSecret(env)) return Response.json({ error: "set LOOM_SECRET_KEY on the Worker first" }, { status: 503 });

  // Local development only: sign in as anyone, no GitHub app needed.
  if (path === "/auth/dev" && devLogin(env)) {
    const login = (url.searchParams.get("login") ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "");
    if (!login) return Response.json({ error: "add ?login=" }, { status: 400 });
    return startSession(env, req, { id: `github:${login}`, login, name: login, avatar: "" }, safeReturn(url.searchParams.get("return")));
  }

  if (path === "/auth/github") {
    if (!githubReady(env)) return Response.json({ error: "GitHub sign-in isn't set up: set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET" }, { status: 503 });
    const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
    const state = await signed(env, { nonce, to: safeReturn(url.searchParams.get("return")), exp: Date.now() + 10 * 60_000 });
    const go = new URL("https://github.com/login/oauth/authorize");
    go.searchParams.set("client_id", env.GITHUB_CLIENT_ID!);
    go.searchParams.set("redirect_uri", `${url.origin}/auth/github/callback`);
    go.searchParams.set("scope", "read:user");
    go.searchParams.set("state", nonce);
    go.searchParams.set("allow_signup", "true");
    return new Response(null, { status: 302, headers: { location: go.toString(), "set-cookie": setCookie(req, STATE, state, 600) } });
  }

  if (path === "/auth/github/callback") {
    const state = await verified<{ nonce: string; to: string }>(env, cookie(req, STATE));
    const code = url.searchParams.get("code");
    if (!state || !code || url.searchParams.get("state") !== state.nonce) return Response.json({ error: "sign-in expired or was tampered with; try again" }, { status: 400 });
    const tok = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: `${url.origin}/auth/github/callback` }),
    }).then((r) => r.json<any>());
    if (!tok.access_token) return Response.json({ error: `GitHub refused the sign-in (${tok.error ?? "no token"})` }, { status: 400 });
    const gh = await fetch("https://api.github.com/user", {
      headers: { authorization: `Bearer ${tok.access_token}`, accept: "application/vnd.github+json", "user-agent": "loom" },
    }).then((r) => r.json<any>());
    if (!gh.login) return Response.json({ error: "couldn't read your GitHub profile" }, { status: 400 });
    const login = String(gh.login).toLowerCase();
    return startSession(env, req, { id: `github:${login}`, login: gh.login, name: gh.name || gh.login, avatar: gh.avatar_url ?? "" }, state.to);
  }

  return Response.json({ error: "not found" }, { status: 404 });
}
