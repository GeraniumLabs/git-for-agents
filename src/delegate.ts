// jev: a stand-in for the project's humans, backed by TypeSafe's Jev model
// (https://docs.typesafe.ai). Jev doesn't write text; it returns typed
// judgments with probabilities. So jev never invents an answer: it picks one of
// the options an agent offered, or judges a protected change against the
// humans' written guidance, and acts only when Jev is confident enough.
// Everything else goes to a person, with the reason.
//
// People decide what jev may handle (its scopes, thresholds, house rules and
// guidance). Code owns the workflow; Jev answers narrow questions inside it.

import { matches } from "./paths";

export interface DelegateConfig {
  enabled: boolean;
  name: string;
  /** Principles and preferences jev judges by, written by the humans. */
  guidance: string;
  questions: {
    enabled: boolean;
    /** Only questions mentioning one of these words; empty means any topic. */
    topics: string[];
    /** How sure Jev must be (0-1) before jev picks an option. */
    minConfidence: number;
  };
  approvals: {
    enabled: boolean;
    /** Protected paths jev may approve on the humans' behalf. */
    paths: string[];
    /** Also require at least one approving agent review first. */
    requireAgentReview: boolean;
    /** How sure Jev must be (0-1) that the change follows the guidance. */
    minConfidence: number;
  };
  /** Canned answers: when a question matches `pattern` (a regex), answer with `answer`. */
  rules: { pattern: string; answer: string }[];
}

export const DEFAULT_DELEGATE: DelegateConfig = {
  enabled: false,
  name: "jev",
  guidance: "",
  questions: { enabled: true, topics: [], minConfidence: 0.85 },
  approvals: { enabled: false, paths: [], requireAgentReview: true, minConfidence: 0.9 },
  rules: [],
};

export interface Judge {
  apiKey?: string;
  url?: string;
}

export type Verdict =
  | { act: true; answer: string; via: "rule" | "jev"; scores?: Record<string, number> }
  | { act: false; reason: string; scores?: Record<string, number> };

/** Turn an agent's options (a list, or option → description) into Choice criteria. */
export function normalizeOptions(raw: unknown): Record<string, string> | null {
  if (Array.isArray(raw)) {
    const opts = raw.map((o) => String(o).trim()).filter(Boolean);
    return opts.length >= 2 ? Object.fromEntries(opts.map((o) => [o, o])) : null;
  }
  if (raw && typeof raw === "object") {
    const entries = Object.entries(raw as Record<string, unknown>).filter(([k]) => k.trim());
    return entries.length >= 2 ? Object.fromEntries(entries.map(([k, v]) => [k, v ? String(v) : k])) : null;
  }
  return null;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Decide whether jev can settle a question, and how. */
export async function decideQuestion(
  cfg: DelegateConfig,
  q: { question: string; options: Record<string, string> | null; task: string },
  judge: Judge,
): Promise<Verdict> {
  if (!cfg.enabled) return { act: false, reason: `${cfg.name} is off` };
  if (!cfg.questions.enabled) return { act: false, reason: `${cfg.name} isn't allowed to answer questions` };
  const text = q.question.toLowerCase();
  if (cfg.questions.topics.length && !cfg.questions.topics.some((t) => text.includes(t.toLowerCase()))) {
    return { act: false, reason: `outside ${cfg.name}'s topics (${cfg.questions.topics.join(", ")})` };
  }
  for (const r of cfg.rules) {
    try {
      if (new RegExp(r.pattern, "i").test(q.question)) return { act: true, answer: r.answer, via: "rule" };
    } catch {}
  }
  if (!q.options) return { act: false, reason: `no house rule covers it, and the question offers no options for ${cfg.name} to pick from` };
  if (!judge.apiKey) return { act: false, reason: "no house rule covers it (Jev isn't connected: set TYPESAFE_API_KEY)" };
  if (!cfg.guidance.trim()) return { act: false, reason: `no house rule covers it, and the humans haven't written guidance for ${cfg.name} yet` };

  const min = cfg.questions.minConfidence;
  const res = await systemOne(judge, {
    guidance: cfg.guidance,
    task: q.task,
    question: q.question,
    options: q.options,
  }, {
    pick: {
      type: "choice",
      instructions: "An agent asked the project's human leads `question` and offered `options`. Which option would the human leads pick, going by their written `guidance`?",
      criteria: q.options,
    },
    settled: {
      type: "noul",
      instructions: "Does `guidance` settle `question`, so the human leads wouldn't need to think about it?",
      criteria: { true: "The guidance clearly covers this decision", false: "The guidance is silent, ambiguous or conflicting on this decision" },
    },
    high_stakes: {
      type: "noul",
      instructions: "Is `question` a high-stakes decision?",
      criteria: { true: "Hard to undo, or about security, money, legal matters, user data, or the product's direction", false: "A routine, reversible engineering decision" },
    },
  });
  if (!res.ok) return { act: false, reason: res.reason };
  const pick = res.answers.pick, settled = res.answers.settled.noul, stakes = res.answers.high_stakes.noul;
  const scores = { confidence: pick.confidence, settled, highStakes: stakes };
  if (stakes >= 0.5) return { act: false, reason: `Jev judges this high-stakes (${pct(stakes)})`, scores };
  if (settled < min) return { act: false, reason: `Jev isn't sure the guidance covers this (${pct(settled)}, needs ${pct(min)})`, scores };
  if (pick.confidence < min) return { act: false, reason: `Jev leans to “${pick.choice}” but is only ${pct(pick.confidence)} sure (needs ${pct(min)})`, scores };
  const why = q.options[pick.choice] && q.options[pick.choice] !== pick.choice ? ` (${q.options[pick.choice]})` : "";
  return {
    act: true,
    answer: `Go with “${pick.choice}”${why}. I picked it from your options going by the team's guidance; Jev is ${pct(pick.confidence)} sure. Ask again if it doesn't fit.`,
    via: "jev",
    scores,
  };
}

/** Decide whether jev can approve a change that touches protected paths. */
export async function decideApproval(
  cfg: DelegateConfig,
  c: { guarded: string[]; agentApprovals: number; undeclared: string[]; title: string; summary: string; intent: string; patch: string },
  judge: Judge,
): Promise<Verdict> {
  if (!cfg.enabled) return { act: false, reason: `${cfg.name} is off` };
  if (!cfg.approvals.enabled) return { act: false, reason: `${cfg.name} isn't allowed to approve protected changes` };
  const outside = c.guarded.filter((f) => !cfg.approvals.paths.some((p) => matches(p, f)));
  if (outside.length) return { act: false, reason: `${outside.join(", ")} is outside the paths ${cfg.name} may approve` };
  if (c.undeclared.length) return { act: false, reason: `the change touches files outside its declared intent (${c.undeclared.join(", ")})` };
  if (cfg.approvals.requireAgentReview && c.agentApprovals < 1) return { act: false, reason: "waiting for an agent review first" };
  if (!judge.apiKey) return { act: false, reason: "Jev isn't connected (set TYPESAFE_API_KEY), so a person has to look" };

  const min = cfg.approvals.minConfidence;
  const res = await systemOne(judge, {
    guidance: cfg.guidance || "(none written)",
    change: { title: c.title, summary: c.summary, intent: c.intent, protected_files: c.guarded, diff: protectedDiff(c.patch, c.guarded) },
  }, {
    follows_guidance: {
      type: "noul",
      instructions: "Is `change.diff` consistent with the human leads' `guidance`?",
      criteria: { true: "Nothing in the diff goes against the guidance", false: "Some part of the diff goes against the guidance, or the guidance would forbid it" },
    },
    does_what_it_says: {
      type: "noul",
      instructions: "Does `change.diff` do only what `change.summary` and `change.intent` describe?",
      criteria: { true: "Every edit in the diff serves the stated purpose", false: "The diff contains edits the summary and intent don't explain" },
    },
    risky: {
      type: "noul",
      instructions: "Does `change.diff` add risk to the project?",
      criteria: { true: "Adds or upgrades dependencies, adds install or run scripts, weakens checks, touches secrets, or deletes data", false: "None of these" },
    },
  });
  if (!res.ok) return { act: false, reason: res.reason };
  const follows = res.answers.follows_guidance.noul, honest = res.answers.does_what_it_says.noul, risky = res.answers.risky.noul;
  const scores = { followsGuidance: follows, doesWhatItSays: honest, risky };
  if (risky >= 1 - min) return { act: false, reason: `Jev flags the diff as risky (${pct(risky)})`, scores };
  if (follows < min) return { act: false, reason: `Jev isn't sure it follows the guidance (${pct(follows)}, needs ${pct(min)})`, scores };
  if (honest < min) return { act: false, reason: `Jev isn't sure the diff only does what it says (${pct(honest)}, needs ${pct(min)})`, scores };
  return {
    act: true,
    answer: `Approved for the humans: ${c.guarded.join(", ")} is in my scope, and Jev judges the diff consistent with the guidance (${pct(follows)}), true to its summary (${pct(honest)}) and low-risk (${pct(1 - risky)}).`,
    via: "jev",
    scores,
  };
}

/** The part of a unified diff that touches the protected files, capped for the model. */
function protectedDiff(patch: string, files: string[]): string {
  const parts = patch.split(/^(?=--- )/m).filter((p) => files.some((f) => p.includes(` a/${f}`) || p.includes(` b/${f}`)));
  return (parts.join("") || patch).slice(0, 12_000);
}

// ── TypeSafe System One API ──────────────────────────────────────────────

type Answer = { type: "noul"; noul: number } | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number };
type Answers<Q> = { [K in keyof Q]: Q[K] extends { type: "choice" } ? Extract<Answer, { type: "choice" }> : Extract<Answer, { type: "noul" }> };

async function systemOne<Q extends Record<string, { type: "noul" | "choice"; instructions: string; criteria: Record<string, string> }>>(
  judge: Judge,
  state: unknown,
  questions: Q,
): Promise<{ ok: true; answers: Answers<Q> } | { ok: false; reason: string }> {
  const url = judge.url ?? "https://api.typesafe.ai/v1/systemone";
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${judge.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "jev-latest", state, questions }),
      });
      if ((res.status === 429 || res.status === 529 || res.status >= 500) && attempt < 2) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      if (!res.ok) return { ok: false, reason: `Jev unavailable (HTTP ${res.status})` };
      const out = (await res.json()) as { answers?: Answers<Q> };
      if (!out.answers || Object.keys(questions).some((k) => !(k in out.answers!))) return { ok: false, reason: "Jev returned an incomplete answer" };
      return { ok: true, answers: out.answers };
    } catch (e: any) {
      if (attempt < 2) continue;
      return { ok: false, reason: `Jev unavailable (${String(e?.message ?? e).slice(0, 80)})` };
    }
  }
}
