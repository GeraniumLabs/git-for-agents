// The review brief: where a reviewer should look in a change, and whether a
// person needs to look at all. With dozens of agents shipping, nobody reads
// every diff; the brief ranks files by risk from what Mergery already knows.

import { matches } from "./paths";

export interface FileStat {
  path: string;
  added: number;
  removed: number;
}

export interface BriefInput {
  author: string;
  files: FileStat[];
  /** Files touched outside the task's declared intent. */
  undeclared: string[];
  /** Files under protected paths. */
  guarded: string[];
  checks: { ok: boolean } | null;
  checksConfigured: boolean;
  /** Whether main has any tests. Without them, a change without tests is the norm, said once on the project instead. */
  mainHasTests?: boolean;
  /** Live intents of other agents: their paths and who holds them. */
  othersIntents: { paths: string[]; agent: string }[];
  /** path -> agents (other than the author) who wrote it before. */
  knownBy: Record<string, string[]>;
  /** Paths the author wrote before this change. */
  authorKnows: string[];
  /** Why a file is in the change, in the author's words (submit_change explanations, or intent reasons). */
  explained?: Record<string, string>;
  /** Times the change was sent back. */
  sentBack: number;
  /** Open review threads that must be resolved before merge. */
  openThreads: number;
  /** The decision model's judgment of whether the diff does what its intent declared, if the project asks for one. */
  intentCheck?: { score: number; model: string } | null;
}

export interface BriefFile extends FileStat {
  score: number;
  flags: { kind: string; text: string }[];
}

export interface Brief {
  needsPerson: boolean;
  verdict: string;
  score: number;
  reasons: { kind: string; text: string; files?: string[] }[];
  files: BriefFile[];
}

const TEST = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$/i;
const NOT_CODE = /\.(md|txt|json|ya?ml|toml|lock|png|jpe?g|gif|svg|css|html?)$/i;
/**
 * Files a change touches as a side effect, not as its substance: lockfiles,
 * ignore lists, OS litter. Installing a package rewrites the lockfile whatever
 * the task, so these never make a change look risky, never count as other
 * agents' territory, and never pick its reviewers.
 */
const HOUSEKEEPING = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|deno\.lock|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|Gemfile\.lock|composer\.lock|go\.sum|flake\.lock|mix\.lock|pubspec\.lock|Package\.resolved|\.gitignore|\.gitattributes|\.dockerignore|\.npmignore|\.prettierignore|\.eslintignore|\.DS_Store|Thumbs\.db)$/;
export const isHousekeeping = (p: string) => HOUSEKEEPING.test(p);
export const isTest = (p: string) => TEST.test(p);
export const isCode = (p: string) => !isTest(p) && !NOT_CODE.test(p);
export const countTests = (paths: Iterable<string> | Map<string, unknown>) => [...(paths instanceof Map ? paths.keys() : paths)].filter(isTest).length;

/** Lines added and removed per file, from a unified diff. */
export function fileStats(patch: string): FileStat[] {
  const out: FileStat[] = [];
  let cur: FileStat | null = null;
  let minus: string | null = null;
  for (const l of patch.split("\n")) {
    if (l.startsWith("--- ")) { minus = l.slice(4).replace(/^a\//, ""); continue; }
    if (l.startsWith("+++ ")) {
      const plus = l.slice(4).replace(/^b\//, "");
      cur = { path: plus === "/dev/null" ? minus ?? plus : plus, added: 0, removed: 0 };
      out.push(cur);
      continue;
    }
    if (!cur || l.startsWith("@@")) continue;
    if (l.startsWith("+")) cur.added++;
    else if (l.startsWith("-")) cur.removed++;
  }
  return out;
}

// What each signal adds to a file's risk. A person is asked for at NEEDS_PERSON.
const W = { protected: 5, outside: 3, explained: 1, contested: 2, unfamiliar: 1, large: 1 };
const NEEDS_PERSON = 6;

export function buildBrief(i: BriefInput): Brief {
  const files: BriefFile[] = i.files.map((f) => {
    const flags: BriefFile["flags"] = [];
    let score = 0;
    const flag = (kind: keyof typeof W, text: string) => { flags.push({ kind, text }); score += W[kind]; };
    if (i.guarded.includes(f.path)) flag("protected", "protected path");
    if (isHousekeeping(f.path)) {
      flags.push({ kind: "housekeeping", text: "lockfile or ignore list: not weighed" });
      return { ...f, score, flags };
    }
    const why = i.explained?.[f.path];
    // Outside the intent but explained by its author: a reviewer reads the reason instead of guessing at it.
    if (i.undeclared.includes(f.path)) why ? flag("explained", `outside the declared intent; the author says: ${why}`) : flag("outside", "outside the declared intent");
    else if (why) flags.push({ kind: "why", text: `the author says: ${why}` });
    const others = [...new Set(i.othersIntents.filter((x) => x.paths.some((p) => matches(p, f.path))).map((x) => x.agent))];
    if (others.length) flag("contested", `${others.join(", ")} ${others.length === 1 ? "is" : "are"} also working here`);
    const knowers = i.knownBy[f.path] ?? [];
    if (knowers.length && !i.authorKnows.includes(f.path)) flag("unfamiliar", `first time ${i.author} touches it; ${knowers.slice(0, 2).join(", ")} know${knowers.length === 1 ? "s" : ""} it`);
    if (f.added + f.removed > 150) flag("large", `${f.added + f.removed} lines changed`);
    return { ...f, score, flags };
  }).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  const reasons: Brief["reasons"] = [];
  let score = files.reduce((s, f) => s + f.score, 0);
  const of = (kind: string) => files.filter((f) => f.flags.some((x) => x.kind === kind)).map((f) => f.path);
  if (i.guarded.length) reasons.push({ kind: "protected", text: "Touches protected paths", files: i.guarded });
  if (i.checks && !i.checks.ok) { score += 5; reasons.push({ kind: "checks", text: "Checks fail" }); }
  else if (!i.checks && i.checksConfigured) { score += 1; reasons.push({ kind: "checks", text: "Checks haven't run on it yet" }); }
  else if (i.checks?.ok) reasons.push({ kind: "ok", text: "Checks pass" });
  const outside = i.undeclared.filter((p) => !isHousekeeping(p)), chores = i.undeclared.filter(isHousekeeping);
  const unexplained = outside.filter((p) => !i.explained?.[p]), explainedOutside = outside.filter((p) => i.explained?.[p]);
  if (unexplained.length) reasons.push({ kind: "outside", text: `${unexplained.length} file${unexplained.length === 1 ? "" : "s"} outside the declared intent, unexplained`, files: unexplained });
  if (explainedOutside.length) reasons.push({ kind: "explained", text: `${explainedOutside.length} file${explainedOutside.length === 1 ? "" : "s"} outside the declared intent, with the author's reason`, files: explainedOutside });
  if (chores.length) reasons.push({ kind: "ok", text: `${chores.join(", ")} changed too (outside the intent, but lockfiles and ignore lists aren't weighed)`, files: chores });
  const code = i.files.filter((f) => isCode(f.path)), tests = i.files.filter((f) => isTest(f.path));
  if (code.length && !tests.length && i.mainHasTests !== false) { score += 2; reasons.push({ kind: "tests", text: "Changes code without changing any tests" }); }
  else if (tests.length) reasons.push({ kind: "ok", text: `Changes ${tests.length} test file${tests.length === 1 ? "" : "s"}` });
  const contested = of("contested");
  if (contested.length) reasons.push({ kind: "contested", text: "Other agents are working on the same files", files: contested });
  const unfamiliar = of("unfamiliar");
  if (unfamiliar.length) reasons.push({ kind: "unfamiliar", text: `The author is new to ${unfamiliar.length === 1 ? "this file" : "these files"}`, files: unfamiliar });
  if (i.intentCheck) {
    const p = Math.round(i.intentCheck.score * 100);
    if (i.intentCheck.score < 0.5) { score += 3; reasons.push({ kind: "intent", text: `${i.intentCheck.model} doubts the diff does what its intent declared (${p}%)` }); }
    else if (i.intentCheck.score < 0.85) { score += 1; reasons.push({ kind: "intent", text: `${i.intentCheck.model} isn't sure the diff sticks to its declared intent (${p}%)` }); }
    else reasons.push({ kind: "ok", text: `${i.intentCheck.model} finds the diff matches its declared intent (${p}%)` });
  }
  if (i.sentBack >= 2) { score += 1; reasons.push({ kind: "churn", text: `Sent back ${i.sentBack} times` }); }
  if (i.openThreads) reasons.push({ kind: "threads", text: `${i.openThreads} open thread${i.openThreads === 1 ? "" : "s"} must be resolved before it merges` });

  const needsPerson = i.guarded.length > 0 || !!(i.checks && !i.checks.ok) || score >= NEEDS_PERSON;
  const top = reasons.filter((r) => r.kind !== "ok" && r.kind !== "threads").slice(0, 2).map((r) => r.text.charAt(0).toLowerCase() + r.text.slice(1));
  const verdict = needsPerson
    ? `Needs a person${top.length ? `: ${top.join("; ")}` : ""}.`
    : top.length ? `Agents can review this; worth a look: ${top.join("; ")}.` : "Agents can review this. Nothing stands out.";
  return { needsPerson, verdict, score, reasons, files };
}

/**
 * A check command to suggest for a repository, from what's in it. Only ones
 * the checks image can run as is (Node and make); anything else is left to
 * the person.
 */
/**
 * Each check runs on a fresh copy of the code, with no node_modules. A Node
 * project's check command that never installs fails on its first tool
 * ("tsc: not found"), which looks like the change's fault. So when the
 * command has no install step and package.json has dependencies, install
 * first (dev dependencies included: builds and tests need them).
 */
export function withInstall(command: string, files: { has(path: string): boolean }, packageJson: string | null): { command: string; added: string | null } {
  if (!packageJson || /\b(npm (ci|install|i)|pnpm|yarn|bun (install|i)|node_modules)\b/.test(command)) return { command, added: null };
  let pkg: any;
  try { pkg = JSON.parse(packageJson); } catch { return { command, added: null }; }
  const deps = Object.keys(pkg?.dependencies ?? {}).length + Object.keys(pkg?.devDependencies ?? {}).length;
  if (!deps || !/\b(npm|node)\b/.test(command)) return { command, added: null };
  const install = files.has("package-lock.json") || files.has("npm-shrinkwrap.json") ? "npm ci --include=dev" : "npm install --include=dev";
  return { command: `${install} && ${command}`, added: install };
}

/**
 * Why a check failed, when the output says it wasn't the code under test:
 * the setup (nothing installed) or a package.json without the script.
 */
export function checkHint(output: string, exitCode: number, touched: string[]): { blame: "project" | "change"; hint: string } | null {
  const missing = output.match(/Missing script: "?([\w:.-]+)"?/);
  if (missing) {
    return touched.includes("package.json")
      ? { blame: "change", hint: `npm found no "${missing[1]}" script in package.json as this change leaves it. Check that the file still has its "scripts" key (an edit that wrote only part of the file drops it).` }
      : { blame: "project", hint: `package.json has no "${missing[1]}" script, so the project's check command can't run; an owner fixes the command in Settings.` };
  }
  const notFound = output.match(/(?:sh: \d+: )?([\w.-]+): (?:command )?not found/);
  if (exitCode === 127 && notFound) return { blame: "project", hint: `\`${notFound[1]}\` isn't installed where the check ran. Each check starts from a fresh copy of the code with nothing installed, so the check command has to install dependencies first (for example \`npm ci && npm test\`); an owner sets it in Settings.` };
  return null;
}

export async function suggestCheck(paths: Set<string>, read: (path: string) => Promise<string | null>): Promise<string | null> {
  if (paths.has("package.json")) {
    try {
      const test = JSON.parse((await read("package.json")) ?? "{}")?.scripts?.test;
      if (typeof test === "string" && test.trim() && !/no test specified/.test(test)) return paths.has("package-lock.json") ? "npm ci && npm test" : "npm install && npm test";
    } catch {}
  }
  for (const m of ["Makefile", "makefile"]) {
    if (paths.has(m) && /^test\s*:/m.test((await read(m)) ?? "")) return "make test";
  }
  return null;
}
