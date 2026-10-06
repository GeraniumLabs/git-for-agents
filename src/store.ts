// RepoStore: the slice of Cloudflare Artifacts that Loom uses.
// In production it is backed by the Artifacts Workers binding. In local
// development it is backed by shim/artifacts-shim.mjs, which mimics the same
// calls over HTTP and serves real git smart HTTP from bare repositories.

export interface RepoRef {
  name: string;
  remote: string;
  defaultBranch: string;
}

export interface CommitInfo {
  hash: string;
  message: string;
  author: { name: string; email: string };
  parents: string[];
  committedAt: number;
}

export interface RepoStore {
  create(name: string, description?: string): Promise<RepoRef & { token: string }>;
  fork(source: string, name: string, description?: string): Promise<RepoRef & { token: string }>;
  info(name: string): Promise<RepoRef | null>;
  token(name: string, scope: "read" | "write", ttlSeconds: number): Promise<string>;
  readFile(name: string, ref: string, path: string): Promise<string | null>;
  log(name: string, ref: string, limit?: number): Promise<CommitInfo[]>;
  delete(name: string): Promise<boolean>;
}

/** Artifacts tokens look like art_v1_<secret>?expires=<unix>; git wants only the secret. */
export function tokenSecret(token: string): string {
  return token.split("?expires=")[0];
}

export class ArtifactsStore implements RepoStore {
  constructor(private artifacts: Artifacts) {}

  async create(name: string, description?: string) {
    const r = await this.artifacts.create(name, { description, setDefaultBranch: "main" });
    return { name: r.name, remote: r.remote, defaultBranch: r.defaultBranch, token: r.token };
  }

  async fork(source: string, name: string, description?: string) {
    using repo = await this.artifacts.get(source);
    const r = await repo.fork(name, { description, defaultBranchOnly: true });
    // A fork is created asynchronously; wait until it can be opened.
    for (let i = 0; i < 40; i++) {
      try {
        using forked = await this.artifacts.get(name);
        await forked.info();
        break;
      } catch (e: any) {
        if (e?.code !== "FORK_IN_PROGRESS" && e?.code !== "CREATE_IN_PROGRESS") throw e;
        await new Promise((res) => setTimeout(res, 250));
      }
    }
    return { name: r.name, remote: r.remote, defaultBranch: r.defaultBranch, token: r.token };
  }

  async info(name: string) {
    try {
      using repo = await this.artifacts.get(name);
      const i = await repo.info();
      return { name: i.name, remote: i.remote, defaultBranch: i.defaultBranch };
    } catch (e: any) {
      if (e?.code === "NOT_FOUND") return null;
      throw e;
    }
  }

  async token(name: string, scope: "read" | "write", ttlSeconds: number) {
    using repo = await this.artifacts.get(name);
    const t = await repo.createToken(scope, ttlSeconds);
    return t.plaintext;
  }

  async readFile(name: string, ref: string, path: string) {
    using repo = await this.artifacts.get(name);
    const blob = await repo.readFile({ ref, path });
    return blob ? await blob.text() : null;
  }

  async log(name: string, ref: string, limit = 50) {
    using repo = await this.artifacts.get(name);
    const commits = await repo.log({ ref, limit });
    return commits.map((c) => ({
      hash: c.hash,
      message: c.message,
      author: c.author,
      parents: c.parents,
      committedAt: c.committedAt,
    }));
  }

  async delete(name: string) {
    return this.artifacts.delete(name);
  }
}

export class ShimStore implements RepoStore {
  constructor(private base: string) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.base + path, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404) return null as T;
    if (!res.ok) throw new Error(`artifacts shim ${method} ${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  create(name: string, description?: string) {
    return this.call<RepoRef & { token: string }>("POST", "/repos", { name, description });
  }
  fork(source: string, name: string, description?: string) {
    return this.call<RepoRef & { token: string }>("POST", `/repos/${source}/fork`, { name, description });
  }
  info(name: string) {
    return this.call<RepoRef | null>("GET", `/repos/${name}`);
  }
  async token(name: string, scope: "read" | "write", ttlSeconds: number) {
    const r = await this.call<{ plaintext: string }>("POST", `/repos/${name}/tokens`, { scope, ttl: ttlSeconds });
    return r.plaintext;
  }
  async readFile(name: string, ref: string, path: string) {
    const r = await this.call<{ content: string } | null>(
      "GET",
      `/repos/${name}/file?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}`,
    );
    return r ? r.content : null;
  }
  async log(name: string, ref: string, limit = 50) {
    return (await this.call<CommitInfo[]>("GET", `/repos/${name}/log?ref=${encodeURIComponent(ref)}&limit=${limit}`)) ?? [];
  }
  async delete(name: string) {
    const r = await this.call<{ deleted: boolean }>("DELETE", `/repos/${name}`);
    return !!r?.deleted;
  }
}

export interface StoreEnv {
  ARTIFACTS?: Artifacts;
  ARTIFACTS_SHIM_URL?: string;
}

export function makeStore(env: StoreEnv): RepoStore {
  if (env.ARTIFACTS) return new ArtifactsStore(env.ARTIFACTS);
  if (env.ARTIFACTS_SHIM_URL) return new ShimStore(env.ARTIFACTS_SHIM_URL);
  throw new Error("No Artifacts binding and no ARTIFACTS_SHIM_URL configured");
}
