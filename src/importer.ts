// Bringing an existing repository into Loom: where it comes from, and its
// open GitHub issues as tasks. Loom becomes the repository's home; the source
// is read once and never written back.

export interface ImportSource {
  /** An https git URL, e.g. https://github.com/owner/repo(.git). */
  url: string;
  /** The branch to import; the source's default branch when omitted. It lands as main. */
  branch?: string;
  /** For private repositories: a token with read access. Used for the import only, never stored. */
  token?: string;
  /** Also bring in the repository's open GitHub issues as tasks. */
  issues?: boolean;
}

export interface GitHubRepo {
  owner: string;
  repo: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  url: string;
  author: string | null;
  labels: string[];
}

/** Checks an import URL and normalizes it to something git can fetch. */
export function sourceUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error("the import URL isn't a URL; use the https address you'd git clone");
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && ["127.0.0.1", "localhost"].includes(u.hostname))) {
    throw new Error("import from an https URL (the one you'd git clone)");
  }
  if (u.username || u.password) throw new Error("leave credentials out of the URL; pass a token separately");
  const gh = githubRepo(u.toString());
  return gh ? `https://github.com/${gh.owner}/${gh.repo}.git` : u.toString();
}

/** owner/repo when the URL points at a GitHub repository. */
export function githubRepo(url: string): GitHubRepo | null {
  const m = url.trim().match(/^https:\/\/(?:www\.)?github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** The task Loom files for an issue. */
export function issueTask(gh: GitHubRepo, i: Issue): { title: string; description: string; source: string } {
  const body = i.body.length > 8000 ? `${i.body.slice(0, 8000)}\n\n…(cut; the rest is on GitHub)` : i.body;
  const by = [i.author ? `opened by @${i.author}` : null, i.labels.length ? `labels: ${i.labels.join(", ")}` : null].filter(Boolean).join("; ");
  return {
    title: i.title.slice(0, 300),
    description: `${body.trim()}\n\nImported from ${gh.owner}/${gh.repo}#${i.number} (${i.url})${by ? `, ${by}` : ""}.`.trim(),
    source: `github:${gh.owner}/${gh.repo}#${i.number}`,
  };
}

/**
 * A repository's open issues, oldest first, without pull requests (GitHub
 * lists those as issues too). Stops after `limit`.
 */
export async function openIssues(gh: GitHubRepo, opts: { token?: string; api?: string; limit?: number } = {}): Promise<Issue[]> {
  const api = (opts.api ?? "https://api.github.com").replace(/\/$/, "");
  const limit = opts.limit ?? 500;
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "loom-import", "x-github-api-version": "2022-11-28" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const out: Issue[] = [];
  for (let page = 1; out.length < limit && page <= 20; page++) {
    const res = await fetch(`${api}/repos/${gh.owner}/${gh.repo}/issues?state=open&sort=created&direction=asc&per_page=100&page=${page}`, { headers });
    if (res.status === 404) throw new Error(`GitHub can't find ${gh.owner}/${gh.repo}${opts.token ? "" : "; if it's private, add a token"}`);
    if (res.status === 401) throw new Error("GitHub rejected the token");
    if (res.status === 403 || res.status === 429) throw new Error(`GitHub refused to list issues (${res.status}${res.headers.get("x-ratelimit-remaining") === "0" ? ", rate limit reached; add a token" : ""})`);
    if (!res.ok) throw new Error(`GitHub returned ${res.status} listing issues`);
    const rows = await res.json<any[]>();
    for (const r of rows) {
      if (r.pull_request) continue;
      out.push({
        number: r.number,
        title: String(r.title ?? `Issue ${r.number}`),
        body: String(r.body ?? ""),
        url: String(r.html_url ?? `https://github.com/${gh.owner}/${gh.repo}/issues/${r.number}`),
        author: r.user?.login ?? null,
        labels: (r.labels ?? []).map((l: any) => (typeof l === "string" ? l : l?.name)).filter(Boolean),
      });
      if (out.length >= limit) break;
    }
    if (rows.length < 100) break;
  }
  return out;
}
