// deputy: a stand-in for the project's humans, backed by a decision model:
// Cloudflare's Clef on Workers AI, or TypeSafe's Jev (https://docs.typesafe.ai)
// with a key. Neither writes text; they return typed judgments with
// probabilities. So the deputy never invents an answer: it picks one of
// the options an agent offered, or judges a protected change against the
// humans' written guidance, and acts only when the model is confident enough.
// Everything else goes to a person, with the reason.
//
// People decide what the deputy may handle (its scopes, thresholds, house rules and
// guidance). Code owns the workflow; the model answers narrow questions inside it.

import Anthropic from "@anthropic-ai/sdk";
import { matches } from "./paths";
import { sameQuestion, type Decision } from "./memory";

export interface DelegateConfig {
  enabled: boolean;
  name: string;
  /** Principles and preferences the deputy judges by, written by the humans. */
  guidance: string;
  questions: {
    enabled: boolean;
    /** Only questions mentioning one of these words; empty means any topic. */
    topics: string[];
    /** How sure the model must be (0-1) before the deputy picks an option. */
    minConfidence: number;
  };
  approvals: {
    enabled: boolean;
    /** Protected paths the deputy may approve on the humans' behalf. */
    paths: string[];
    /** Also require at least one approving agent review first. */
    requireAgentReview: boolean;
    /** How sure the model must be (0-1) that the change follows the guidance. */
    minConfidence: number;
  };
  disputes: {
    enabled: boolean;
    /** How sure the model must be (0-1) before the deputy rules between two agents. */
    minConfidence: number;
  };
  /** Canned answers: when a question matches `pattern` (a regex), answer with `answer`. */
  rules: { pattern: string; answer: string }[];
}

export const DEFAULT_DELEGATE: DelegateConfig = {
  enabled: false,
  name: "deputy",
  guidance: "",
  questions: { enabled: true, topics: [], minConfidence: 0.85 },
  approvals: { enabled: false, paths: [], requireAgentReview: true, minConfidence: 0.9 },
  disputes: { enabled: true, minConfidence: 0.85 },
  rules: [],
};

export interface Judge {
  apiKey?: string;
  url?: string;
  /** Workers AI, for Clef. */
  ai?: Ai;
  /** The deputy's judge: TypeSafe's System One, Cloudflare's Clef (same API, on Workers AI), or Claude with the same questions. */
  provider?: "typesafe" | "clef" | "anthropic";
}

/** The model behind a judge, by the name people know it by. */
export function judgeName(judge: Judge): string {
  return judge.provider === "anthropic" ? "Claude" : judge.provider === "clef" ? "Clef" : "Jev";
}

export type Verdict =
  | { act: true; answer: string; via: "rule" | "model" | "precedent"; model?: string; scores?: Record<string, number>; option?: string; decision?: number }
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

/** Decide whether the deputy can settle a question, and how: house rules, then precedent, then the model. */
export async function decideQuestion(
  cfg: DelegateConfig,
  q: { question: string; options: Record<string, string> | null; task: string; precedents: Decision[] },
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
  // The same question, already answered by a person: no model needed.
  const same = q.precedents.find((d) => d.kind === "answer" && sameQuestion(d.question, q.question));
  if (same) return { act: true, answer: cite(same), via: "precedent", decision: same.id };

  if (!judge.provider) {
    return { act: false, reason: q.options ? "no house rule or earlier decision covers it (no decision model is connected: add a key in Settings)" : "no house rule or earlier decision covers it" };
  }
  const precedents = q.precedents.slice(0, 12);
  if (!q.options && !precedents.length) return { act: false, reason: `no house rule or earlier decision covers it, and the question offers no options for ${cfg.name} to pick from` };
  if (q.options && !precedents.length && !cfg.guidance.trim()) return { act: false, reason: `no house rule or earlier decision covers it, and the humans haven't written guidance for ${cfg.name} yet` };

  const min = cfg.questions.minConfidence;
  const questions: Record<string, Question> = {
    high_stakes: {
      type: "noul",
      instructions: "Is `question` a high-stakes decision?",
      criteria: { true: "Hard to undo, or about security, money, legal matters, user data, or the product's direction", false: "A routine, reversible engineering decision" },
    },
  };
  if (precedents.length) {
    questions.precedent = {
      type: "choice",
      instructions: "The human leads have already made the decisions in `decisions`. Which one of them answers `question`, so the agent can act on it without asking again?",
      criteria: { ...Object.fromEntries(precedents.map((d) => [`d${d.id}`, `${d.question ? `Asked: ${d.question} ` : ""}Decided: ${d.decision}`])), none: "None of these decisions answers the question" },
    };
  }
  if (q.options && cfg.guidance.trim()) {
    questions.pick = {
      type: "choice",
      instructions: "An agent asked the project's human leads `question` and offered `options`. Which option would the human leads pick, going by their written `guidance`?",
      criteria: q.options,
    };
    questions.settled = {
      type: "noul",
      instructions: "Does `guidance` settle `question`, so the human leads wouldn't need to think about it?",
      criteria: { true: "The guidance clearly covers this decision", false: "The guidance is silent, ambiguous or conflicting on this decision" },
    };
  }
  const res = await systemOne(judge, {
    guidance: cfg.guidance,
    task: q.task,
    question: q.question,
    ...(q.options ? { options: q.options } : {}),
    ...(precedents.length ? { decisions: precedents.map((d) => ({ id: `d${d.id}`, asked: d.question, decided: d.decision, by: d.byName, paths: d.paths })) } : {}),
  }, questions);
  if (!res.ok) return { act: false, reason: res.reason };
  const a = res.answers as Record<string, any>;
  const M = judgeName(judge);
  const stakes = a.high_stakes.noul as number;
  const scores: Record<string, number> = { highStakes: stakes };
  if (stakes >= 0.5) return { act: false, reason: `${M} judges this high-stakes (${pct(stakes)})`, scores };

  if (a.precedent) {
    scores.precedent = a.precedent.confidence;
    const d = precedents.find((p) => `d${p.id}` === a.precedent.choice);
    if (d && a.precedent.confidence >= min) {
      return { act: true, answer: `${cite(d)} ${M} is ${pct(a.precedent.confidence)} sure that decision covers this.`, via: "precedent", model: M, decision: d.id, scores };
    }
  }
  if (!a.pick) {
    return { act: false, reason: a.precedent?.choice !== "none" ? `${M} isn't sure an earlier decision covers this (${pct(a.precedent.confidence)}, needs ${pct(min)})` : "no earlier decision covers it, and the question offers no options to pick from", scores };
  }
  const pick = a.pick, settled = a.settled.noul as number;
  Object.assign(scores, { confidence: pick.confidence, settled });
  if (settled < min) return { act: false, reason: `${M} isn't sure the guidance covers this (${pct(settled)}, needs ${pct(min)})`, scores };
  if (pick.confidence < min) return { act: false, reason: `${M} leans to “${pick.choice}” but is only ${pct(pick.confidence)} sure (needs ${pct(min)})`, scores };
  const why = q.options![pick.choice] && q.options![pick.choice] !== pick.choice ? ` (${q.options![pick.choice]})` : "";
  return {
    act: true,
    answer: `Go with “${pick.choice}”${why}. I picked it from your options going by the team's guidance; ${M} is ${pct(pick.confidence)} sure. Ask again if it doesn't fit.`,
    via: "model", model: M,
    option: pick.choice,
    scores,
  };
}

const cite = (d: Decision) => `Already decided (decision #${d.id}, by ${d.byName ?? d.by}): “${d.decision.replace(/[.\s]+$/, "")}.”`;

/** Decide whether the deputy can rule between two agents' positions. */
export async function decideDispute(
  cfg: DelegateConfig,
  d: { question: string; positions: Record<string, string>; task: string; precedents: Decision[] },
  judge: Judge,
): Promise<Verdict> {
  if (!cfg.enabled) return { act: false, reason: `${cfg.name} is off` };
  if (!cfg.disputes.enabled) return { act: false, reason: `${cfg.name} isn't allowed to settle disputes` };
  if (!judge.provider) return { act: false, reason: "no decision model is connected (add a key in Settings), so a person has to rule" };
  if (!cfg.guidance.trim() && !d.precedents.length) return { act: false, reason: `the humans haven't written guidance for ${cfg.name}, and nothing earlier was decided here` };
  const min = cfg.disputes.minConfidence;
  const res = await systemOne(judge, {
    guidance: cfg.guidance || "(none written)",
    decisions: d.precedents.slice(0, 12).map((p) => ({ asked: p.question, decided: p.decision, by: p.byName })),
    task: d.task,
    dispute: d.question,
    positions: d.positions,
  }, {
    ruling: {
      type: "choice",
      instructions: "Two agents disagree about `dispute`; their positions are in `positions`. Which position do the human leads' `guidance` and earlier `decisions` support?",
      criteria: d.positions,
    },
    settled: {
      type: "noul",
      instructions: "Do `guidance` and `decisions` settle `dispute`, so the human leads wouldn't need to think about it?",
      criteria: { true: "They clearly favor one position", false: "They are silent, ambiguous or conflicting on this" },
    },
    high_stakes: {
      type: "noul",
      instructions: "Is `dispute` a high-stakes decision?",
      criteria: { true: "Hard to undo, or about security, money, legal matters, user data, or the product's direction", false: "A routine, reversible engineering decision" },
    },
  });
  if (!res.ok) return { act: false, reason: res.reason };
  const M = judgeName(judge);
  const ruling = res.answers.ruling, settled = res.answers.settled.noul, stakes = res.answers.high_stakes.noul;
  const scores = { confidence: ruling.confidence, settled, highStakes: stakes };
  if (stakes >= 0.5) return { act: false, reason: `${M} judges this high-stakes (${pct(stakes)})`, scores };
  if (settled < min) return { act: false, reason: `${M} isn't sure the guidance settles this (${pct(settled)}, needs ${pct(min)})`, scores };
  if (ruling.confidence < min) return { act: false, reason: `${M} leans to ${ruling.choice} but is only ${pct(ruling.confidence)} sure (needs ${pct(min)})`, scores };
  return { act: true, option: ruling.choice, answer: `The team's guidance supports ${ruling.choice}'s position; ${M} is ${pct(ruling.confidence)} sure.`, via: "model", model: M, scores };
}

/** Decide whether the deputy can approve a change that touches protected paths. */
export async function decideApproval(
  cfg: DelegateConfig,
  c: { guarded: string[]; agentApprovals: number; undeclared: string[]; title: string; summary: string; intent: string; patch: string },
  judge: Judge,
): Promise<Verdict> {
  if (!cfg.enabled) return { act: false, reason: `${cfg.name} is off` };
  if (!cfg.approvals.enabled) return { act: false, reason: `${cfg.name} isn't allowed to approve protected changes` };
  // Let the agent reviewers weigh in first, so a person isn't pulled in for a change they'll send back anyway.
  if (cfg.approvals.requireAgentReview && c.agentApprovals < 1) return { act: false, reason: "waiting for an agent review first" };
  const outside = c.guarded.filter((f) => !cfg.approvals.paths.some((p) => matches(p, f)));
  if (outside.length) return { act: false, reason: `${outside.join(", ")} is outside the paths ${cfg.name} may approve` };
  if (c.undeclared.length) return { act: false, reason: `the change touches files outside its declared intent (${c.undeclared.join(", ")})` };
  if (!judge.provider) return { act: false, reason: "no decision model is connected (add a key in Settings), so a person has to look" };

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
  const M = judgeName(judge);
  const follows = res.answers.follows_guidance.noul, honest = res.answers.does_what_it_says.noul, risky = res.answers.risky.noul;
  const scores = { followsGuidance: follows, doesWhatItSays: honest, risky };
  if (risky >= 1 - min) return { act: false, reason: `${M} flags the diff as risky (${pct(risky)})`, scores };
  if (follows < min) return { act: false, reason: `${M} isn't sure it follows the guidance (${pct(follows)}, needs ${pct(min)})`, scores };
  if (honest < min) return { act: false, reason: `${M} isn't sure the diff only does what it says (${pct(honest)}, needs ${pct(min)})`, scores };
  return {
    act: true,
    answer: `Approved for the humans: ${c.guarded.join(", ")} is in my scope, and ${M} judges the diff consistent with the guidance (${pct(follows)}), true to its summary (${pct(honest)}) and low-risk (${pct(1 - risky)}).`,
    via: "model", model: M,
    scores,
  };
}

/** The part of a unified diff that touches the protected files, capped for the model. */
function protectedDiff(patch: string, files: string[]): string {
  const parts = patch.split(/^(?=--- )/m).filter((p) => files.some((f) => p.includes(` a/${f}`) || p.includes(` b/${f}`)));
  return (parts.join("") || patch).slice(0, 12_000);
}

// ── optional uses of the decision model outside the deputy ──────────────
// Each is a project setting, off by default; any failure falls back to what
// Loom does without a model.

/** Rank reviewer candidates by how well placed each is to review a change. Probabilities by candidate id, or null. */
export async function rankReviewers(
  judge: Judge,
  c: { title: string; summary: string; files: string[]; intent: string },
  candidates: { agent: string; name: string; reasons: string[]; openReviews: number; present: boolean }[],
): Promise<{ probabilities: Record<string, number>; model: string } | null> {
  if (!judge.provider || candidates.length < 2) return null;
  const keys = candidates.map((_, i) => `r${i}`);
  const res = await systemOne(judge, {
    change: { title: c.title, summary: c.summary, files: c.files.slice(0, 50), intent: c.intent },
  }, {
    best: {
      type: "choice",
      instructions: "Which reviewer is best placed to review `change`: the one who knows the code it touches and the reasoning behind it, and who can get to it soon?",
      criteria: Object.fromEntries(candidates.map((x, i) => [keys[i], `${x.name}: ${x.reasons.join("; ") || "no history with these files"}; ${x.openReviews} open review${x.openReviews === 1 ? "" : "s"}; ${x.present ? "around now" : "not around now"}`])),
    },
  });
  if (!res.ok) return null;
  const a = res.answers.best;
  // Jev and Clef give a probability per option; Claude gives only its pick.
  const probs = a.probabilities && Object.keys(a.probabilities).length > 1 ? a.probabilities : { [a.choice]: a.confidence };
  return { probabilities: Object.fromEntries(candidates.map((x, i) => [x.agent, Number(probs[keys[i]] ?? 0)])), model: judgeName(judge) };
}

/** How likely a change's diff does what its agent declared it would, and nothing else. */
export async function checkIntent(
  judge: Judge,
  c: { title: string; summary: string; intent: string; patch: string },
): Promise<{ score: number; model: string } | null> {
  if (!judge.provider || !c.intent.trim()) return null;
  const res = await systemOne(judge, {
    change: { title: c.title, summary: c.summary, intent: c.intent, diff: c.patch.slice(0, 12_000) },
  }, {
    on_intent: {
      type: "noul",
      instructions: "Does `change.diff` do what the agent declared in `change.intent`, and nothing beyond it?",
      criteria: { true: "Every edit serves the declared intent", false: "The diff does something the intent doesn't describe, or doesn't do what it declared" },
    },
  });
  if (!res.ok) return null;
  return { score: res.answers.on_intent.noul, model: judgeName(judge) };
}

// ── TypeSafe System One API ──────────────────────────────────────────────

type Question = { type: "noul" | "choice"; instructions: string; criteria: Record<string, string> };
type Answer = { type: "noul"; noul: number } | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number };
type Answers<Q> = { [K in keyof Q]: Q[K] extends { type: "choice" } ? Extract<Answer, { type: "choice" }> : Extract<Answer, { type: "noul" }> };

async function systemOne<Q extends Record<string, Question>>(
  judge: Judge,
  state: unknown,
  questions: Q,
): Promise<{ ok: true; answers: Answers<Q> } | { ok: false; reason: string }> {
  if (judge.provider === "anthropic") return claudeOne(judge, state, questions);
  if (judge.provider === "clef") return clefOne(judge, state, questions);
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
      if (!res.ok) return { ok: false, reason: `Jev (TypeSafe) unavailable (HTTP ${res.status})` };
      const out = (await res.json()) as { answers?: Answers<Q> };
      if (!out.answers || Object.keys(questions).some((k) => !(k in out.answers!))) return { ok: false, reason: "Jev (TypeSafe) returned an incomplete answer" };
      return { ok: true, answers: out.answers };
    } catch (e: any) {
      if (attempt < 2) continue;
      return { ok: false, reason: `Jev (TypeSafe) unavailable (${String(e?.message ?? e).slice(0, 80)})` };
    }
  }
}

// ── the same questions, judged by Clef on Workers AI ─────────────────────
// Cloudflare's decision model takes System One requests as they are and
// answers with the same per-option probabilities, so no key is needed.

const CLEF_MODEL = "@cf/cloudflare/clef";

async function clefOne<Q extends Record<string, Question>>(
  judge: Judge,
  state: unknown,
  questions: Q,
): Promise<{ ok: true; answers: Answers<Q> } | { ok: false; reason: string }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const out = (await (judge.ai as any).run(CLEF_MODEL, { model: "clef", state, questions })) as { answers?: Answers<Q>; result?: { answers?: Answers<Q> } };
      const answers = out?.answers ?? out?.result?.answers;
      if (!answers || Object.keys(questions).some((k) => !(k in answers))) return { ok: false, reason: "Clef returned an incomplete answer" };
      return { ok: true, answers };
    } catch (e: any) {
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      return { ok: false, reason: `Clef unavailable (${String(e?.message ?? e).slice(0, 80)})` };
    }
  }
}

// ── the same questions, judged by Claude ─────────────────────────────────
// For a project that brings an Anthropic key instead of a TypeSafe one.
// Each yes/no question comes back as the probability its "true" criterion
// holds; each choice as one option key with a confidence. Structured
// output keeps the reply to exactly that shape.

const JUDGE_MODEL = "claude-opus-5-5";
const JUDGE_SYSTEM = `You are a decision model judging on behalf of a software project's human leads so their agents don't wait on them for routine calls.
You get the situation as JSON and a set of questions about it. Answer every question.
- For a yes/no question, give the probability (0 to 1) that its "true" criterion holds.
- For a choice question, give the key of the option you pick and your confidence (0 to 1) that the leads would pick it.
Be calibrated. Low numbers are useful: the leads would rather be asked than have you guess.`;

async function claudeOne<Q extends Record<string, Question>>(
  judge: Judge,
  state: unknown,
  questions: Q,
): Promise<{ ok: true; answers: Answers<Q> } | { ok: false; reason: string }> {
  const properties: Record<string, unknown> = {};
  for (const [k, q] of Object.entries(questions)) {
    properties[k] = q.type === "noul"
      ? { type: "object", properties: { probability: { type: "number" } }, required: ["probability"], additionalProperties: false }
      : { type: "object", properties: { choice: { type: "string", enum: Object.keys(q.criteria) }, confidence: { type: "number" } }, required: ["choice", "confidence"], additionalProperties: false };
  }
  const client = new Anthropic({ apiKey: judge.apiKey });
  try {
    const res = await client.beta.messages.create({
      model: JUDGE_MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: JUDGE_SYSTEM,
      output_config: { format: { type: "json_schema", schema: { type: "object", properties, required: Object.keys(questions), additionalProperties: false } } },
      messages: [{ role: "user", content: `Situation:\n${JSON.stringify(state, null, 2)}\n\nQuestions:\n${JSON.stringify(questions, null, 2)}` }],
    });
    if (res.stop_reason === "refusal") return { ok: false, reason: "Claude declined to judge this" };
    const text = res.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") return { ok: false, reason: "Claude returned no answer" };
    const raw = JSON.parse(text.text) as Record<string, any>;
    const answers: Record<string, Answer> = {};
    const clamp = (n: unknown) => Math.max(0, Math.min(1, Number(n) || 0));
    for (const [k, q] of Object.entries(questions)) {
      const a = raw[k];
      if (!a) return { ok: false, reason: "Claude returned an incomplete answer" };
      answers[k] = q.type === "noul"
        ? { type: "noul", noul: clamp(a.probability) }
        : { type: "choice", choice: String(a.choice), confidence: clamp(a.confidence), probabilities: { [String(a.choice)]: clamp(a.confidence) } };
    }
    return { ok: true, answers: answers as Answers<Q> };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return { ok: false, reason: "Claude unavailable: the Anthropic key in Settings was rejected" };
    if (e instanceof Anthropic.RateLimitError) return { ok: false, reason: "Claude is rate limited" };
    if (e instanceof Anthropic.APIError) return { ok: false, reason: `Claude unavailable (HTTP ${e.status})` };
    return { ok: false, reason: `Claude unavailable (${String((e as any)?.message ?? e).slice(0, 80)})` };
  }
}
