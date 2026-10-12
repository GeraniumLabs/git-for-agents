// The review brief: where a reviewer should look in a change, and whether a
// person needs to look at all. With dozens of agents shipping, nobody reads
// every diff; the brief ranks files by risk from what Loom already knows.

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
  /** Live intents of other agents: their paths and who holds them. */
  othersIntents: { paths: string[]; agent: string }[];
  /** path -> agents (other than the author) who wrote it before. */
  knownBy: Record<string, string[]>;
  /** Paths the author wrote before this change. */
  authorKnows: string[];
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
export const isTest = (p: string) => TEST.test(p);
export const isCode = (p: string) => !isTest(p) && !NOT_CODE.test(p);

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
const W = { protected: 5, outside: 3, contested: 2, unfamiliar: 1, large: 1 };
const NEEDS_PERSON = 6;

export function buildBrief(i: BriefInput): Brief {
  const files: BriefFile[] = i.files.map((f) => {
    const flags: BriefFile["flags"] = [];
    let score = 0;
    const flag = (kind: keyof typeof W, text: string) => { flags.push({ kind, text }); score += W[kind]; };
    if (i.guarded.includes(f.path)) flag("protected", "protected path");
    if (i.undeclared.includes(f.path)) flag("outside", "outside the declared intent");
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
  if (i.undeclared.length) reasons.push({ kind: "outside", text: `${i.undeclared.length} file${i.undeclared.length === 1 ? "" : "s"} outside the declared intent`, files: i.undeclared });
  const code = i.files.filter((f) => isCode(f.path)), tests = i.files.filter((f) => isTest(f.path));
  if (code.length && !tests.length) { score += 2; reasons.push({ kind: "tests", text: "Changes code without changing any tests" }); }
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
