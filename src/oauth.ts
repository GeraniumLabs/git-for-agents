// Sign-in for MCP clients, so connecting an agent is one line:
//   claude mcp add --transport http loom https://<loom>/mcp
// Loom is its own OAuth 2.1 authorization server, as the MCP spec describes:
// a client finds it from the 401 on /mcp (protected resource metadata),
// registers itself (dynamic client registration), sends the person here to
// sign in with GitHub and allow it, and trades the code for a token (PKCE).
//
// Nothing is stored. A client id, a code and each token are signed payloads,
// each signed for its own purpose, so one can never pass as another or as a
// session. A code is good for five minutes and only with its PKCE verifier.
//
// The token is the person's. In a project, the client acts as an agent of
// theirs (named after the client, or `as`), grouped under them; the person
// has to be a member, and it can do what any agent in the project can.

import { devLogin, escHtml, page, sessionUser, signed, signingSecret, verified, type User } from "./auth";
import type { Env } from "./env";

const CLIENT = "loom-oauth-client";
const CODE = "loom-oauth-code";
const ASK = "loom-oauth-ask";
const ACCESS = "loom-oauth-access";
const REFRESH = "loom-oauth-refresh";
const ACCESS_DAYS = 30;
const REFRESH_DAYS = 180;
const CODE_MINUTES = 5;

interface Client { name: string; redirects: string[]; exp: number }
interface Code { user: User; client: string; name: string; redirect: string; challenge: string; exp: number }
export interface McpGrant { user: User; client: string; exp: number }

const enc = new TextEncoder();
const b64url = (u: Uint8Array) => btoa(String.fromCharCode(...u)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** The name a client's agents go by: what it called itself, cut to an agent name's length. */
export function agentNameOf(client: string): string {
  return client.replace(/[^\w .-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 40) || "MCP agent";
}

/** Redirects a client may register: https anywhere, http only back to this machine. */
function okRedirect(u: unknown): u is string {
  if (typeof u !== "string" || u.length > 500) return false;
  try {
    const url = new URL(u);
    if (url.hash) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

/** The 401 an MCP client gets before it signs in: it says where to learn how. */
export function signInFirst(req: Request): Response {
  const url = new URL(req.url);
  return Response.json({ error: "sign in: connect this MCP client to Loom (it will open a browser), or send an agent key as a bearer token" }, {
    status: 401,
    headers: { "www-authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource${url.pathname}"` },
  });
}

/** The person behind a bearer token, if it is an MCP sign-in token Loom issued. */
export async function mcpGrant(env: Env, req: Request): Promise<McpGrant | null> {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  // Agent keys and the admin token are opaque strings; only Loom's signed tokens have a dot.
  if (!token.includes(".")) return null;
  return verified<McpGrant>(env, token, ACCESS);
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store", "access-control-allow-origin": "*" } });
const oauthError = (error: string, description: string, status = 400) => json({ error, error_description: description }, status);

async function tokens(env: Env, user: User, client: string) {
  const now = Date.now();
  return {
    access_token: await signed(env, { user, client, exp: now + ACCESS_DAYS * 86400_000 } satisfies McpGrant, ACCESS),
    token_type: "Bearer",
    expires_in: ACCESS_DAYS * 86400,
    refresh_token: await signed(env, { user, client, exp: now + REFRESH_DAYS * 86400_000 }, REFRESH),
    scope: "loom",
  };
}

async function sha256url(s: string) {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s))));
}

/** The consent page's request, carried through the form signed so nobody can swap the redirect. */
interface Ask { client: string; name: string; redirect: string; challenge: string; state: string | null; user: string; exp: number }

/** /.well-known/oauth-* and /oauth/* routes, or null when the path isn't one. */
export async function handleOAuth(env: Env, req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;
  const origin = url.origin;

  if (req.method === "OPTIONS" && (path.startsWith("/.well-known/oauth-") || path === "/oauth/token" || path === "/oauth/register")) {
    return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type, authorization, mcp-protocol-version" } });
  }

  // RFC 9728: which resource this is and who signs people in for it. /mcp and /mcp/<project> alike.
  if (path === "/.well-known/oauth-protected-resource" || path.startsWith("/.well-known/oauth-protected-resource/")) {
    const rest = path.slice("/.well-known/oauth-protected-resource".length);
    const resource = /^\/mcp(\/[a-z0-9-]+)?$/.test(rest) ? `${origin}${rest}` : `${origin}/mcp`;
    return json({ resource, authorization_servers: [origin], bearer_methods_supported: ["header"], resource_name: "Loom", scopes_supported: ["loom"] });
  }

  // RFC 8414: how to sign in.
  if (path === "/.well-known/oauth-authorization-server" || path.startsWith("/.well-known/oauth-authorization-server/") || path === "/.well-known/openid-configuration") {
    return json({
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["loom"],
    });
  }

  if (!path.startsWith("/oauth/")) return null;
  if (!signingSecret(env)) return oauthError("server_error", "set LOOM_SECRET_KEY on the Worker first", 503);

  // RFC 7591: a client registers itself. Its id is its registration, signed.
  if (path === "/oauth/register" && req.method === "POST") {
    const body = await req.json<any>().catch(() => null);
    const redirects: unknown[] = Array.isArray(body?.redirect_uris) ? body.redirect_uris : [];
    if (!redirects.length || redirects.length > 10 || !redirects.every(okRedirect)) {
      return oauthError("invalid_redirect_uri", "redirect_uris must be https URLs, or http URLs on localhost");
    }
    const name = typeof body?.client_name === "string" && body.client_name.trim() ? body.client_name.trim().slice(0, 80) : "MCP client";
    const client_id = await signed(env, { name, redirects, exp: Date.now() + 10 * 365 * 86400_000 } satisfies Client, CLIENT);
    return json({
      client_id, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: name, redirect_uris: redirects,
      token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
    }, 201);
  }

  if (path === "/oauth/authorize" && req.method === "GET") {
    const p = url.searchParams;
    const client = await verified<Client>(env, p.get("client_id") ?? undefined, CLIENT);
    const redirect = p.get("redirect_uri") ?? client?.redirects[0] ?? "";
    // Without a known client and one of its redirects, there is nowhere safe to send an error.
    if (!client) return page("Unknown app", `<p>This app hasn't registered with Loom. Try connecting it again.</p>`);
    if (!client.redirects.includes(redirect)) return page("Unknown return address", `<p>${escHtml(client.name)} asked to come back to an address it didn't register.</p>`);
    const back = (q: Record<string, string>) => {
      const to = new URL(redirect);
      for (const [k, v] of Object.entries(q)) to.searchParams.set(k, v);
      if (p.get("state")) to.searchParams.set("state", p.get("state")!);
      return new Response(null, { status: 302, headers: { location: to.toString() } });
    };
    if (p.get("response_type") !== "code") return back({ error: "unsupported_response_type", error_description: "only response_type=code" });
    if (!p.get("code_challenge") || p.get("code_challenge_method") !== "S256") return back({ error: "invalid_request", error_description: "PKCE with S256 is required" });

    const user = await sessionUser(env, req);
    const here = `${path}?${p.toString()}`;
    if (!user) {
      const dev = devLogin(env)
        ? `<form method="get" action="/auth/dev"><input type="hidden" name="return" value="${escHtml(here)}"><label>Local sign-in as <input name="login" placeholder="a GitHub login" required></label> <button>Sign in</button></form>`
        : "";
      return page(`Connect ${escHtml(client.name)} to Loom`, `<p>Sign in first. Then you'll choose whether <b>${escHtml(client.name)}</b> may work on Loom for you.</p>
<p><a class="button" href="/auth/github?return=${encodeURIComponent(here)}">Sign in with GitHub</a></p>${dev}`);
    }
    const ask = await signed(env, { client: p.get("client_id")!, name: client.name, redirect, challenge: p.get("code_challenge")!, state: p.get("state"), user: user.id, exp: Date.now() + 15 * 60_000 } satisfies Ask, ASK);
    return page(`Connect ${escHtml(client.name)} to Loom`, `<p>Signed in as <b>${escHtml(user.login)}</b>.</p>
<p><b>${escHtml(client.name)}</b> will work as your agent in the Loom projects you're a member of: claim tasks, write to its own workspaces, submit and review changes, and create projects for you. It can't change settings, people or keys.</p>
<p>It goes back to <code>${escHtml(new URL(redirect).origin)}</code>.</p>
<form method="post" action="/oauth/authorize"><input type="hidden" name="ask" value="${escHtml(ask)}">
<p><button name="allow" value="1">Allow</button> <button name="allow" value="0" class="secondary">Cancel</button></p></form>`);
  }

  if (path === "/oauth/authorize" && req.method === "POST") {
    const form = await req.formData();
    const ask = await verified<Ask>(env, String(form.get("ask") ?? ""), ASK);
    const user = await sessionUser(env, req);
    if (!ask || !user || ask.user !== user.id) return page("That took too long", `<p>Go back to your agent and connect again.</p>`);
    const to = new URL(ask.redirect);
    if (ask.state) to.searchParams.set("state", ask.state);
    if (form.get("allow") !== "1") {
      to.searchParams.set("error", "access_denied");
      return new Response(null, { status: 302, headers: { location: to.toString() } });
    }
    const code = await signed(env, { user, client: ask.client, name: ask.name, redirect: ask.redirect, challenge: ask.challenge, exp: Date.now() + CODE_MINUTES * 60_000 } satisfies Code, CODE);
    to.searchParams.set("code", code);
    return new Response(null, { status: 302, headers: { location: to.toString() } });
  }

  if (path === "/oauth/token" && req.method === "POST") {
    const type = req.headers.get("content-type") ?? "";
    const p: Record<string, string> = type.includes("application/json")
      ? await req.json<Record<string, string>>().catch(() => ({}))
      : Object.fromEntries([...new URLSearchParams(await req.text())]);
    if (p.grant_type === "authorization_code") {
      const code = await verified<Code>(env, p.code, CODE);
      if (!code) return oauthError("invalid_grant", "the code is invalid or expired");
      if (p.client_id && p.client_id !== code.client) return oauthError("invalid_grant", "the code was issued to another client");
      if (p.redirect_uri && p.redirect_uri !== code.redirect) return oauthError("invalid_grant", "redirect_uri doesn't match");
      if (!p.code_verifier || (await sha256url(p.code_verifier)) !== code.challenge) return oauthError("invalid_grant", "code_verifier doesn't match");
      return json(await tokens(env, code.user, code.name));
    }
    if (p.grant_type === "refresh_token") {
      const r = await verified<McpGrant>(env, p.refresh_token, REFRESH);
      if (!r) return oauthError("invalid_grant", "the refresh token is invalid or expired");
      return json(await tokens(env, r.user, r.client));
    }
    return oauthError("unsupported_grant_type", "use authorization_code or refresh_token");
  }

  return json({ error: "not found" }, 404);
}
