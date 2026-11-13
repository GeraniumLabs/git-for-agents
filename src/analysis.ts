// Loom analyzing what it already holds: answers to people's questions about a
// change, an incident or a session, cited to the trace steps and events they
// came from; and the factory report, which turns a week of traces and changes
// into what a team should change. Loom doesn't run agents to do this: one
// model call per question, through the same models as the review agent.

import Anthropic from "@anthropic-ai/sdk";
import { CLAUDE_REVIEW_MODEL, WORKERS_AI_REVIEW_MODEL, type ReviewModel } from "./reviewer";
import type { Step } from "./traces";

/** One thing the answer may cite: an event (E12), a trace step (T3.45), a review (R7), a bisect run (B2.1) … */
export interface Source { ref: string; text: string }

export interface Answer { ok: true; answer: string; citations: { ref: string; text: string }[]; model: string; sources: number; truncated: boolean }
export type AskResult = Answer | { ok: false; reason: string };

/** How much source text a question gets, by model. */
const SOURCE_LIMIT = { claude: 200_000, "workers-ai": 40_000 } as const;

const ASK_SYSTEM = `You answer a person's question about work AI agents did on a software project, after the fact.
You get the question and numbered sources: what agents and people did on the project (events), what agents read, thought and did in their sessions (trace steps), reviews, and check runs. Each source starts with its reference in brackets, like [E12] or [T3.45].
Answer only from the sources. Cite the references that support each claim inline, in brackets, like [T3.45]. If the sources don't say, say so plainly rather than guessing; say what's missing.
Be brief and specific: a few sentences, or a short list when the question asks for several things. Name agents and files. Don't restate the sources.`;

const ASK_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string", description: "The answer, citing sources inline like [T3.45]." },
    citations: { type: "array", items: { type: "string" }, description: "Every reference the answer relies on." },
  },
  required: ["answer", "citations"],
  additionalProperties: false,
} as const;

export function askPrompt(question: string, scope: string, sources: Source[], limit: number): { prompt: string; truncated: boolean; used: number } {
  const lines: string[] = [];
  let size = 0, used = 0;
  for (const s of sources) {
    const line = `[${s.ref}] ${s.text.replace(/\s+/g, " ").trim()}`;
    if (size + line.length > limit) break;
    lines.push(line);
    size += line.length + 1;
    used++;
  }
  return { prompt: `What this is about: ${scope}\n\nSources:\n${lines.join("\n")}\n\nQuestion: ${question}`, truncated: used < sources.length, used };
}

/** The answer's citations, kept only when they name a real source, each with what it says. */
export function parseAnswer(raw: unknown, sources: Source[]): { answer: string; citations: { ref: string; text: string }[] } | null {
  const r = raw as { answer?: unknown; citations?: unknown };
  if (!r || typeof r.answer !== "string" || !r.answer.trim()) return null;
  const byRef = new Map(sources.map((s) => [s.ref, s.text]));
  const named = new Set<string>([...(Array.isArray(r.citations) ? r.citations.map(String) : []), ...[...r.answer.matchAll(/\[([A-Z]\d+(?:\.\d+)?)\]/g)].map((m) => m[1])]);
  const citations = [...named].map((x) => x.replace(/^\[|\]$/g, "")).filter((x) => byRef.has(x)).map((ref) => ({ ref, text: byRef.get(ref)!.slice(0, 300) }));
  return { answer: r.answer.trim(), citations };
}

export async function ask(m: ReviewModel, question: string, scope: string, sources: Source[]): Promise<AskResult> {
  const { prompt, truncated, used } = askPrompt(question, scope, sources, SOURCE_LIMIT[m.kind]);
  let raw: unknown;
  let model: string;
  if (m.kind === "claude") {
    model = "Claude";
    const client = new Anthropic({ apiKey: m.apiKey, baseURL: m.baseURL });
    try {
      const res = await client.beta.messages.create({
        model: CLAUDE_REVIEW_MODEL,
        max_tokens: 4000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "medium", format: { type: "json_schema", schema: ASK_SCHEMA } },
        system: ASK_SYSTEM,
        messages: [{ role: "user", content: prompt }],
      });
      if (res.stop_reason === "refusal") return { ok: false, reason: "Claude declined to answer" };
      const text = res.content.find((b) => b.type === "text");
      if (!text || text.type !== "text") return { ok: false, reason: "Claude returned no answer" };
      raw = JSON.parse(text.text);
    } catch (e) {
      if (e instanceof SyntaxError) return { ok: false, reason: "Claude's answer wasn't valid JSON" };
      if (e instanceof Anthropic.APIError) return { ok: false, reason: `Claude unavailable (${e.status ?? "network"}: ${e.message.slice(0, 80)})` };
      throw e;
    }
  } else {
    model = "Workers AI";
    try {
      const out = await m.ai.run(WORKERS_AI_REVIEW_MODEL as any, {
        messages: [{ role: "system", content: ASK_SYSTEM }, { role: "user", content: prompt }],
        response_format: { type: "json_schema", json_schema: ASK_SCHEMA },
        max_tokens: 2048,
      } as any, m.gateway ? { gateway: { id: m.gateway, metadata: { loom: "ask" } } } : undefined) as { response?: unknown };
      raw = typeof out?.response === "string" ? JSON.parse(out.response) : out?.response;
    } catch (e: any) {
      return { ok: false, reason: `Workers AI unavailable (${String(e?.message ?? e).slice(0, 80)})` };
    }
  }
  const parsed = parseAnswer(raw, sources);
  if (!parsed) return { ok: false, reason: `${model} returned no answer` };
  return { ok: true, ...parsed, model, sources: used, truncated };
}

/** The steps of a trace worth citing: prompts, the agent's words, tool calls and errors; results only when they failed. */
export function stepSources(traceId: number, agentName: string, steps: Step[], keep?: (s: Step) => boolean): Source[] {
  return steps
    .filter((s) => (keep ? keep(s) : s.kind !== "tool_result" || s.error) && s.kind !== "context")
    .map((s) => ({
      ref: `T${traceId}.${s.seq}`,
      text: `${agentName} ${s.kind === "prompt" ? "was asked" : s.kind === "thought" ? "thought" : s.kind === "message" ? "said" : s.kind === "tool_call" ? `called ${s.loomCall ? `Loom ${s.loomCall}` : s.tool ?? "a tool"}` : s.kind === "error" || s.error ? "hit an error" : "got"}${s.files.length ? ` (${s.files.slice(0, 4).join(", ")})` : ""}: ${s.preview.slice(0, 400)}`,
    }));
}

// ── the factory report ───────────────────────────────────────────────────

export interface ReportTrace { id: number; agent: string; agentName: string; models: string[]; tokensIn: number; tokensOut: number; costUsd: number | null; steps: Step[] }
export interface ReportChange { id: number; title: string; agent: string; agentName: string; status: string; rounds: number; checksFailed: number; reverted: boolean; models: string[] }
export interface ReportFailure { change: number; output: string }

export interface Finding { kind: "waste" | "mistakes" | "instructions" | "thrash"; title: string; detail: string; suggest: string; refs: string[] }
export interface ModelRow { model: string; sessions: number; tokens: number; costUsd: number | null; changes: number; landed: number; reworkRounds: number; checksFailed: number; reverted: number; tokensPerLanded: number | null }
export interface Report { from: number; to: number; sessions: number; changes: number; landed: number; findings: Finding[]; models: ModelRow[]; agents: (ModelRow & { agent: string })[] }

const READ_TOOLS = /^(Read|View|view|read_file|cat|open_file|Grep|Glob|grep|search|list_files)$/i;
const EDIT_TOOLS = /^(Edit|MultiEdit|Write|NotebookEdit|apply_patch|patch|str_replace_based_edit_tool|edit_file|write_file|create_file)$/i;

/** One line that says what went wrong in a check's output, without the parts that change every run. */
export function failureSignature(output: string): string {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  const hit = lines.find((l) => /\b(error|Error|ERR!|failed|FAIL|assert|not ok|✗|Cannot find|does not provide|is not defined|Unexpected)\b/.test(l)) ?? lines[lines.length - 1] ?? "";
  return hit.replace(/\/[^\s:'"]+\//g, "/…/").replace(/\b\d+(\.\d+)?(ms|s)?\b/g, "N").replace(/0x[0-9a-f]+/gi, "0x…").slice(0, 160);
}

export function factoryReport(from: number, to: number, traces: ReportTrace[], changes: ReportChange[], failures: ReportFailure[]): Report {
  const findings: Finding[] = [];

  // Waste: the same files read over and over across sessions.
  const reads = new Map<string, { n: number; sessions: Set<number> }>();
  for (const t of traces) for (const s of t.steps) {
    if (s.kind !== "tool_call" || !READ_TOOLS.test(s.tool ?? "")) continue;
    for (const f of s.files) { const r = reads.get(f) ?? { n: 0, sessions: new Set() }; r.n++; r.sessions.add(t.id); reads.set(f, r); }
  }
  const hot = [...reads].filter(([, r]) => r.n >= 5 && r.sessions.size >= 2).sort((a, b) => b[1].n - a[1].n).slice(0, 5);
  for (const [f, r] of hot) findings.push({ kind: "waste", title: `${f} was read ${r.n} times in ${r.sessions.size} sessions`, detail: "Every agent rebuilds the same understanding of this file.", suggest: `Leave a note on ${f} (remember) saying what it does and what to watch for, so the next agent reads that first.`, refs: [...r.sessions].slice(0, 5).map((id) => `T${id}`) });

  // Repeated mistakes: different changes failing the checks the same way.
  const bySig = new Map<string, Set<number>>();
  for (const f of failures) { const sig = failureSignature(f.output); if (!sig) continue; const s = bySig.get(sig) ?? new Set(); s.add(f.change); bySig.set(sig, s); }
  for (const [sig, ids] of [...bySig].filter(([, ids]) => ids.size >= 2).sort((a, b) => b[1].size - a[1].size).slice(0, 5)) {
    findings.push({ kind: "mistakes", title: `${ids.size} changes failed the checks the same way`, detail: sig, suggest: "Record a project decision or a note on the files involved, so agents avoid it before they submit.", refs: [...ids].slice(0, 8).map((id) => `#${id}`) });
  }

  // Ignored instructions: sessions that worked with Loom but edited files before declaring an intent.
  const loomSessions = traces.filter((t) => t.steps.some((s) => s.loomCall));
  const skipped = loomSessions.filter((t) => {
    const firstEdit = t.steps.find((s) => s.kind === "tool_call" && (EDIT_TOOLS.test(s.tool ?? "") || s.loomCall === "write_files"));
    if (!firstEdit) return false;
    return !t.steps.some((s) => s.loomCall === "declare_intent" && s.seq < firstEdit.seq);
  });
  if (skipped.length && loomSessions.length) {
    const pct = Math.round((100 * skipped.length) / loomSessions.length);
    findings.push({ kind: "instructions", title: `Agents edited before declaring an intent in ${pct}% of sessions (${skipped.length} of ${loomSessions.length})`, detail: "Without an intent, other agents can't see the overlap coming and reviewers flag every file.", suggest: "Send a directive to every agent: declare_intent before the first edit.", refs: skipped.slice(0, 8).map((t) => `T${t.id}`) });
  }

  // Thrash: a file edited again and again in one session; changes sent back round after round.
  for (const t of traces) {
    const edits = new Map<string, number>();
    for (const s of t.steps) if (s.kind === "tool_call" && EDIT_TOOLS.test(s.tool ?? "")) for (const f of s.files) edits.set(f, (edits.get(f) ?? 0) + 1);
    const worst = [...edits].filter(([, n]) => n >= 6).sort((a, b) => b[1] - a[1])[0];
    if (worst) findings.push({ kind: "thrash", title: `${t.agentName} edited ${worst[0]} ${worst[1]} times in one session`, detail: "Many passes over one file usually means the task was unclear or too big.", suggest: "Split tasks like this one, or run it as a contest to compare approaches.", refs: [`T${t.id}`] });
  }
  const rework = changes.filter((c) => c.rounds >= 2);
  if (rework.length) findings.push({ kind: "thrash", title: `${rework.length} change${rework.length === 1 ? " was" : "s were"} sent back two or more times`, detail: rework.slice(0, 5).map((c) => `#${c.id} ${c.title} (${c.rounds} rounds)`).join("; "), suggest: "Look at what reviewers asked for each time; if it's the same thing, make it a project decision.", refs: rework.slice(0, 8).map((c) => `#${c.id}`) });

  const rows = (key: (x: { models: string[]; agent: string; agentName: string }) => string[]) => {
    const m = new Map<string, ModelRow>();
    const row = (k: string) => m.get(k) ?? (m.set(k, { model: k, sessions: 0, tokens: 0, costUsd: null, changes: 0, landed: 0, reworkRounds: 0, checksFailed: 0, reverted: 0, tokensPerLanded: null }), m.get(k)!);
    for (const t of traces) for (const k of key(t)) {
      const r = row(k);
      r.sessions++;
      r.tokens += t.tokensIn + t.tokensOut;
      if (t.costUsd != null) r.costUsd = (r.costUsd ?? 0) + t.costUsd;
    }
    for (const c of changes) for (const k of key(c)) {
      const r = row(k);
      r.changes++;
      if (c.status === "merged") r.landed++;
      r.reworkRounds += c.rounds;
      r.checksFailed += c.checksFailed;
      if (c.reverted) r.reverted++;
    }
    for (const r of m.values()) r.tokensPerLanded = r.landed && r.tokens ? Math.round(r.tokens / r.landed) : null;
    return [...m.values()].sort((a, b) => b.changes - a.changes || b.sessions - a.sessions);
  };
  return {
    from, to, sessions: traces.length, changes: changes.length, landed: changes.filter((c) => c.status === "merged").length, findings,
    models: rows((x) => (x.models.length ? x.models : ["unknown"])),
    agents: rows((x) => [x.agent]).map((r) => ({ ...r, agent: r.model, model: changes.find((c) => c.agent === r.model)?.agentName ?? traces.find((t) => t.agent === r.model)?.agentName ?? r.model })),
  };
}

// ── the report's summary: a few sentences a person reads first ───────────

export const SUMMARY_QUESTION = "In two or three sentences, what happened this period and the one thing the team should change first? Cite the findings and rows you rely on.";

/** The report as sources for its summary: each finding (F1…), model row (M1…) and agent row (A1…). */
export function reportSources(r: Report): Source[] {
  const row = (m: ModelRow) => `${m.sessions} sessions, ${m.tokens} tokens, ${m.changes} changes, ${m.landed} landed, ${m.reworkRounds} rework rounds, ${m.checksFailed} failed checks, ${m.reverted} reverted${m.tokensPerLanded != null ? `, ${m.tokensPerLanded} tokens per landed change` : ""}`;
  return [
    { ref: "S1", text: `Totals: ${r.sessions} sessions, ${r.changes} changes, ${r.landed} landed.` },
    ...r.findings.map((f, i) => ({ ref: `F${i + 1}`, text: `Finding (${f.kind}): ${f.title}. ${f.detail} Suggested: ${f.suggest}` })),
    ...r.models.map((m, i) => ({ ref: `M${i + 1}`, text: `Model ${m.model}: ${row(m)}` })),
    ...r.agents.map((m, i) => ({ ref: `A${i + 1}`, text: `Agent ${m.model}: ${row(m)}` })),
  ];
}

// ── scoring a review eval when no agent is around to ─────────────────────

const EVAL_SYSTEM = `You score one change to a software project against a rubric, as a careful reviewer would.
You get the rubric, the change's title and summary, and its diff. Score from 0 (fails the rubric) to 1 (fully meets it). Judge only what the rubric asks.
In notes, say in two or three sentences what in the change earned the score, naming files and lines.`;

const EVAL_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "number", description: "From 0 to 1." },
    notes: { type: "string", description: "What in the change earned the score." },
  },
  required: ["score", "notes"],
  additionalProperties: false,
} as const;

export interface EvalInput { rubric: string; title: string; summary: string; patch: string }
export type EvalScore = { ok: true; score: number; notes: string; model: string } | { ok: false; reason: string };

export function evalPrompt(i: EvalInput, limit: number): string {
  const patch = i.patch.length > limit ? `${i.patch.slice(0, limit)}\n… (diff cut at ${limit} characters)` : i.patch;
  return `Rubric: ${i.rubric}\n\nChange: ${i.title}\n${i.summary}\n\nDiff:\n${patch}`;
}

export function parseScore(raw: unknown): { score: number; notes: string } | null {
  const r = raw as { score?: unknown; notes?: unknown };
  const score = Number(r?.score);
  if (!r || !(score >= 0 && score <= 1) || typeof r.notes !== "string" || r.notes.trim().length < 5) return null;
  return { score: Math.round(score * 100) / 100, notes: r.notes.trim().slice(0, 4000) };
}

export async function scoreWithModel(m: ReviewModel, i: EvalInput): Promise<EvalScore> {
  const prompt = evalPrompt(i, SOURCE_LIMIT[m.kind]);
  let raw: unknown, model: string;
  try {
    if (m.kind === "claude") {
      model = "Claude";
      const client = new Anthropic({ apiKey: m.apiKey, baseURL: m.baseURL });
      const res = await client.beta.messages.create({
        model: CLAUDE_REVIEW_MODEL, max_tokens: 2000, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
        output_config: { effort: "medium", format: { type: "json_schema", schema: EVAL_SCHEMA } },
        system: EVAL_SYSTEM, messages: [{ role: "user", content: prompt }],
      });
      if (res.stop_reason === "refusal") return { ok: false, reason: "Claude declined to score it" };
      const text = res.content.find((b) => b.type === "text");
      if (!text || text.type !== "text") return { ok: false, reason: "Claude returned no score" };
      raw = JSON.parse(text.text);
    } else {
      model = "Workers AI";
      const out = await m.ai.run(WORKERS_AI_REVIEW_MODEL as any, {
        messages: [{ role: "system", content: EVAL_SYSTEM }, { role: "user", content: prompt }],
        response_format: { type: "json_schema", json_schema: EVAL_SCHEMA }, max_tokens: 1024,
      } as any, m.gateway ? { gateway: { id: m.gateway, metadata: { loom: "eval" } } } : undefined) as { response?: unknown };
      raw = typeof out?.response === "string" ? JSON.parse(out.response) : out?.response;
    }
  } catch (e: any) {
    if (e instanceof SyntaxError) return { ok: false, reason: "the model's score wasn't valid JSON" };
    return { ok: false, reason: `the model is unavailable (${String(e?.message ?? e).slice(0, 80)})` };
  }
  const parsed = parseScore(raw);
  return parsed ? { ok: true, ...parsed, model } : { ok: false, reason: `${model} returned no usable score` };
}
