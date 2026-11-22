// Trust (github.com/GeraniumLabs/Trust) as an optional add-on: a second,
// provenance-first copy of a project's notes and decisions. Mergery's own
// notes stay the source of truth and keep working without it. Trust adds
// sources pinned to the commit an agent saw, staleness when those files
// change, and a judge that spots duplicates and contradictions.
//
// Everything here fails open: a slow or broken Trust never blocks or fails a
// Mergery request. The coordinator calls it from waitUntil, one call at a time.

export interface TrustSource { uri: string; hash?: string; kind?: string }

/** What the coordinator keeps for us: the space, its sealed admin token, and which Trust entry mirrors which note. */
export interface TrustStore {
  space(): Promise<{ id: string; adminToken: string } | null>;
  saveSpace(id: string, adminToken: string): Promise<void>;
  entryFor(local: string): string | null;
  link(local: string, entry: string): void;
}

export interface TrustOptions {
  url: string;
  /** Create the project's space on first use (the server's Trust). Off when the project connected its own space. */
  canCreate?: boolean;
  project: string;
  store: TrustStore;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export const TRUST_SCOPE = "project";
const SUPERVISOR = "mergery";

export class TrustLink {
  private sessions = new Map<string, { token: string; id: string; expires: number }>();
  private readonly f: typeof fetch;

  constructor(private o: TrustOptions) {
    this.f = o.fetch ?? fetch.bind(globalThis);
  }

  private async call(token: string | null, method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.o.timeoutMs ?? 5000);
    try {
      const r = await this.f(`${this.o.url.replace(/\/$/, "")}${path}`, {
        method,
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal,
      });
      const data = await r.json().catch(() => ({}));
      return { status: r.status, data };
    } finally {
      clearTimeout(timer);
    }
  }

  /** The project's space, created on first use. */
  async space(): Promise<{ id: string; adminToken: string }> {
    const have = await this.o.store.space();
    if (have) return have;
    if (!this.o.canCreate) throw new Error("no Trust space is connected");
    const r = await this.call(null, "POST", "/api/spaces", {
      name: `mergery/${this.o.project}`,
      scopes: [{ id: TRUST_SCOPE, label: this.o.project, kind: "project" }],
    });
    if (r.status !== 200 || !r.data?.space || !r.data?.adminToken) throw new Error(`Trust didn't create a space (HTTP ${r.status}: ${r.data?.error ?? "no detail"})`);
    await this.o.store.saveSpace(r.data.space, r.data.adminToken);
    return { id: r.data.space, adminToken: r.data.adminToken };
  }

  /** A session token for this agent, started lazily and renewed before it expires. */
  private async session(agent: string, fresh = false): Promise<{ token: string; id: string }> {
    const cached = this.sessions.get(agent);
    if (!fresh && cached && cached.expires > Date.now() + 60_000) return cached;
    const sp = await this.space();
    const r = await this.call(sp.adminToken, "POST", `/api/spaces/${sp.id}/sessions`, { scope: TRUST_SCOPE, agent, supervisor: SUPERVISOR });
    if (r.status !== 200 || !r.data?.token) throw new Error(`Trust didn't start a session for ${agent} (HTTP ${r.status}: ${r.data?.error ?? "no detail"})`);
    const s = { token: r.data.token as string, id: r.data.id as string, expires: Number(r.data.token_expires_at) || Date.now() + 3_600_000 };
    this.sessions.set(agent, s);
    return s;
  }

  /** As an agent, with one retry on a fresh session if the token was refused. */
  private async asAgent(agent: string, method: string, path: string, body: Record<string, unknown>) {
    const sp = await this.space();
    let s = await this.session(agent);
    let r = await this.call(s.token, method, `/api/spaces/${sp.id}${path}`, { ...body, session: s.id });
    if (r.status === 401) {
      s = await this.session(agent, true);
      r = await this.call(s.token, method, `/api/spaces/${sp.id}${path}`, { ...body, session: s.id });
    }
    return r;
  }

  private async asAdmin(method: string, path: string, body: Record<string, unknown>) {
    const sp = await this.space();
    return this.call(sp.adminToken, method, `/api/spaces/${sp.id}${path}`, body);
  }

  /** Mirror a note or decision. `local` is Mergery's id for it ("note:12", "decision:4"); written once. */
  async remember(local: string, agent: string, m: { title: string; body: string; kind: string; sources: TrustSource[]; derivation: "observed" | "stated" }) {
    if (this.o.store.entryFor(local)) return null;
    const r = await this.asAgent(agent, "POST", "/remember", { scope: TRUST_SCOPE, ...m });
    if (r.status !== 200 || !r.data?.id) throw new Error(`Trust didn't keep ${local} (HTTP ${r.status}: ${r.data?.error ?? "no detail"})`);
    this.o.store.link(local, r.data.id);
    return r.data;
  }

  /** Retract the mirror of a retired note. A note Trust never saw is nothing to do. */
  async retract(local: string, agent: string, reason: string) {
    const entry = this.o.store.entryFor(local);
    if (!entry) return null;
    const r = await this.asAgent(agent, "POST", "/retract", { scope: TRUST_SCOPE, entry, reason });
    if (r.status !== 200) throw new Error(`Trust didn't retract ${local} (HTTP ${r.status}: ${r.data?.error ?? "no detail"})`);
    return r.data;
  }

  /** A merge: record it against the author's session, then flag memories whose files it changed. */
  async merged(agent: string, commit: string, title: string, paths: string[]) {
    const s = await this.session(agent);
    await this.asAdmin("POST", "/changes", { session: s.id, ref: commit, title });
    const flagged: string[] = [];
    for (const uri of paths) {
      const r = await this.asAdmin("POST", "/source-changed", { scope: TRUST_SCOPE, uri, hash: commit });
      if (r.status === 200 && Array.isArray(r.data?.flagged)) flagged.push(...r.data.flagged);
    }
    return { flagged };
  }
}

/** A one-line title for a note: its first sentence, cut short. */
export function titleFor(text: string): string {
  const first = text.trim().split(/(?<=[.!?])\s|\n/)[0] ?? "";
  return first.length > 100 ? `${first.slice(0, 97)}…` : first;
}

/** Note paths as Trust sources, pinned to the commit main was at when the note was written. */
export function sourcesFor(paths: string[], commit: string | null): TrustSource[] {
  return paths.map((uri) => ({ uri, kind: "file", ...(commit ? { hash: commit } : {}) }));
}

/** "https://trust.example/api/spaces/abc123" -> its server and space id, or null. */
export function parseSpaceUrl(raw: string): { base: string; space: string } | null {
  const m = String(raw ?? "").trim().match(/^(https?:\/\/[^/\s]+)\/api\/spaces\/([A-Za-z0-9-]{1,64})\/?$/);
  return m ? { base: m[1], space: m[2] } : null;
}

/**
 * Check a space URL and admin key someone pasted, and make sure the space has the project scope
 * Mergery writes to. Throws a message fit to show them.
 */
export async function checkSpace(base: string, space: string, key: string, project: string, f: typeof fetch = fetch.bind(globalThis)) {
  const headers = { "content-type": "application/json", authorization: `Bearer ${key}` };
  let r: Response;
  try {
    r = await f(`${base}/api/spaces/${space}`, { headers, signal: AbortSignal.timeout(8000) });
  } catch (e: any) {
    throw new Error(`couldn't reach Trust at ${base} (${String(e?.message ?? e).slice(0, 120)})`);
  }
  const info: any = await r.json().catch(() => ({}));
  if (r.status === 401 || r.status === 403) throw new Error("Trust refused that key; it must be the space's admin key");
  if (!r.ok || !Array.isArray(info.scopes)) throw new Error(`Trust didn't answer for that space (HTTP ${r.status}${info.error ? `: ${info.error}` : ""})`);
  if (!info.scopes.some((x: any) => x.id === TRUST_SCOPE)) {
    const add = await f(`${base}/api/spaces/${space}/scopes`, { method: "POST", headers, body: JSON.stringify({ id: TRUST_SCOPE, label: project, kind: "project" }) });
    if (!add.ok) throw new Error(`Trust didn't add a "${TRUST_SCOPE}" scope to that space (HTTP ${add.status})`);
  }
  return { name: (info.name as string) ?? null, persistent: !!info.persistent };
}
