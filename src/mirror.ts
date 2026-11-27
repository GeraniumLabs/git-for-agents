// Sending a project's main out to another git host, GitHub above all: once
// (an export), or after every landing (a mirror). Mergery stays the home of
// the code; the copy is an outlet and is never read back. Pushing needs a
// token that can write to that one repository, kept sealed in the project.

import { githubRepo } from "./importer";

export interface MirrorConfig {
  /** Where main goes, as a git URL. */
  url: string;
  /** The branch it lands on there. */
  branch: string;
  /** Push after every landing, not only when someone asks. */
  auto: boolean;
  setBy: string;
  setAt: number;
}

export interface MirrorRun {
  url: string;
  branch: string;
  /** main's commit that was sent, or that was already there. */
  commit: string | null;
  /** What the branch there pointed at before. */
  before: string | null;
  ok: boolean;
  /** Nothing moved: the copy already had this commit. */
  upToDate?: boolean;
  forced?: boolean;
  /** The copy has commits Mergery doesn't, so nothing was pushed. */
  diverged?: boolean;
  error?: string;
  /** Who asked; null for the mirror keeping up by itself. */
  by: string | null;
  at: number;
}

/**
 * The git URL to push to, from what someone typed: a GitHub URL, `owner/repo`,
 * or any https git URL. Plain http only to this machine, for local development.
 */
export function mirrorUrl(raw: string): string {
  const s = String(raw ?? "").trim();
  if (!s) throw new Error("say where to push: a GitHub repository like owner/repo, or its https URL");
  if (/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(s)) return `https://github.com/${s.replace(/\.git$/, "")}.git`;
  const ssh = s.match(/^git@github\.com:([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/);
  if (ssh) return `https://github.com/${ssh[1]}/${ssh[2]}.git`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error("that isn't a repository address; use owner/repo or the https URL you'd git clone");
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && ["127.0.0.1", "localhost"].includes(u.hostname))) {
    throw new Error("push over https (the URL you'd git clone)");
  }
  if (u.username || u.password) throw new Error("leave credentials out of the URL; give the token separately");
  const gh = githubRepo(u.toString());
  return gh ? `https://github.com/${gh.owner}/${gh.repo}.git` : u.toString();
}

/** owner/repo for a GitHub URL, else the URL: how the copy is named to people. */
export function mirrorName(url: string): string {
  const gh = githubRepo(url);
  return gh ? `${gh.owner}/${gh.repo}` : url;
}

/** A branch name git accepts and that can't reach outside refs/heads. */
export function mirrorBranch(raw: unknown): string {
  const b = typeof raw === "string" && raw.trim() ? raw.trim() : "main";
  if (!/^[A-Za-z0-9._\/-]{1,100}$/.test(b) || b.includes("..") || b.startsWith("/") || b.endsWith("/") || b.endsWith(".lock") || b.startsWith("-")) {
    throw new Error(`${b} isn't a branch name git accepts`);
  }
  return b;
}

/** Whether a string looks like a whole token, not a fragment or a URL pasted by mistake. */
export function plausibleToken(raw: unknown): string {
  const t = typeof raw === "string" ? raw.trim() : "";
  if (t.length < 8 || /\s/.test(t) || /^https?:/i.test(t)) throw new Error("paste the whole token");
  return t;
}

/** A plain reason a push failed, from what git said. */
export function pushError(url: string, e: any): string {
  const msg = String(e?.message ?? e);
  const name = mirrorName(url);
  const gh = !!githubRepo(url);
  if (/401|403|auth|permission|denied/i.test(msg)) {
    return gh
      ? `GitHub won't let this token push to ${name}. Use a fine-grained token with Contents: read and write on that repository (or a classic token with repo), from an account that can push there`
      : `${name} won't let this token push`;
  }
  if (/404|not found|Repository not found/i.test(msg)) {
    return gh ? `GitHub can't find ${name}, or the token can't see it. Create the repository on GitHub first (empty is fine)` : `nothing to push to at ${name}`;
  }
  if (/protected branch|GH006|pre-receive hook declined/i.test(msg)) return `${name} turned the push away: the branch is protected there. Allow this token to push to it, or mirror to another branch`;
  return `couldn't push to ${name}: ${msg.slice(0, 300)}`;
}
