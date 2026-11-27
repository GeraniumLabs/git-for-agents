// "git login": a git credential helper backed by an agent key, so plain git
// (fetch, pull, push, branch, anything) works against a project's repositories
// without a token on every command.
//
// Git asks the helper for a credential whenever it talks to the Artifacts host.
// The helper posts git's own request (protocol, host, path) to Mergery with the
// key in $MERGERY_KEY (or the older $LOOM_KEY) or `git config mergery.key`, and Mergery answers with a
// fresh, short-lived Artifacts token for that one repository, in git's
// credential format. The token is minted per call, so nothing expires on disk;
// the key is what's stored, and revoking it in Settings ends the login.
//
// Rights follow Mergery's rules: main is read-only (only the merge queue
// writes it), a workspace is writable by the agent that holds it, and every
// other workspace in the project is readable.

/** The fields git sends a helper: `key=value` lines. */
export function parseCredentialRequest(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

/** The repository a credential request is about: the last path segment, without `.git`. */
export function repoOf(fields: Record<string, string>): string | null {
  const path = fields.path ?? (fields.url ? new URL(fields.url).pathname : "");
  const seg = path.replace(/\/+$/, "").split("/").pop() ?? "";
  const repo = seg.replace(/\.git$/, "");
  return /^[a-z0-9][a-z0-9-]{0,80}$/.test(repo) ? repo : null;
}

/**
 * Which projects a repository could belong to, most likely first. A project's
 * main repository is named after it; a task's workspace is `<project>-t<task>-<id>`.
 */
export function projectCandidates(repo: string): string[] {
  const m = /^(.+)-t\d+-[a-z0-9]+$/.exec(repo);
  return m ? [m[1], repo] : [repo];
}

/** A credential in git's helper format. Git (2.41+) drops it after `password_expiry_utc`. */
export function formatCredential(c: { password: string; expiresAt: string }): string {
  return `username=x\npassword=${c.password}\npassword_expiry_utc=${Math.floor(Date.parse(c.expiresAt) / 1000)}\n`;
}

/**
 * The helper, inline in git config: `get` asks Mergery; `store` is a no-op,
 * since nothing is kept; `erase` (git's sign that a push was refused) says
 * why pushes are refused. An error's reason goes to stderr.
 */
export function helperCommand(origin: string): string {
  return `!f(){ if test "$1" = erase; then echo "mergery: refused. Main is written only by the merge queue, and a workspace only by the agent holding its task; claim a task and push to its workspace." >&2; return 0; fi; test "$1" = get || return 0; k="\${MERGERY_KEY:-\${LOOM_KEY:-$(git config mergery.key)}}"; a="\${MERGERY_AGENT:-$LOOM_AGENT}"; out=$(curl -s --fail-with-body -X POST -H "Authorization: Bearer $k" \${a:+-H "X-Loom-Agent: $a"} --data-binary @- ${origin}/api/git/credential) && printf '%s\\n' "$out" || { printf 'mergery: %s\\n' "\${out:-could not reach ${origin}}" >&2; return 1; }; }; f`;
}

/**
 * One-time setup for a host: Mergery's helper alone answers for it (the empty
 * entry drops any keychain or store helper, which would hand back an expired
 * token), with the repository path so Mergery knows which one, and sent up
 * front where git supports it.
 */
export function loginCommands(origin: string, remote: string): string {
  const host = new URL(remote).origin;
  const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return [
    // First, and chained with &&, so a missing key stops the setup before it changes anything.
    `git config --global mergery.key "\${MERGERY_KEY:?put your agent key in MERGERY_KEY first}"`,
    `git config --global --replace-all credential.${host}.helper ""`,
    `git config --global --add credential.${host}.helper ${sq(helperCommand(origin))}`,
    `git config --global credential.${host}.useHttpPath true`,
    `git config --global http.${host}.proactiveAuth basic`,
  ].join(" &&\n");
}
