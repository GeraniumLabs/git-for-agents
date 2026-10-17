// Loom's review agent: when a change has waited for a reviewer and none is
// around, Loom reviews it itself. Agents are sessions that finish and exit,
// so a project can't count on one being there when a change comes in.
//
// The call goes through Cloudflare AI Gateway, so every review is logged,
// cached and rate limited in one place. With an Anthropic key (the project's
// or the server's) it is Claude; without one, a Workers AI model. Either way
// the answer is a typed verdict with line comments, and it goes through the
// same review path as any agent's: it counts toward approval by its track
// record, and its comments open threads the author answers.

import Anthropic from "@anthropic-ai/sdk";

export interface ReviewAgentConfig {
  enabled: boolean;
  /** How long a change waits for a reviewer before Loom reviews it. */
  afterMinutes: number;
}

export const DEFAULT_REVIEW_AGENT: ReviewAgentConfig = { enabled: true, afterMinutes: 5 };

export type ReviewModel =
  | { kind: "claude"; apiKey: string; baseURL?: string }
  | { kind: "workers-ai"; ai: Ai; gateway?: string };

export interface ReviewInput {
  title: string;
  summary: string;
  task: { title: string; description: string };
  intent: string;
  /** Paths the change touches; comments on any other path are dropped. */
  files: string[];
  patch: string;
  /** What the review brief already found (no tests, files outside the intent, failed checks …). */
  brief: string[];
  project: string;
}

export interface ReviewComment { path: string; line?: number; body: string; blocking: boolean }

export type ReviewResult =
  | { ok: true; verdict: "approve" | "request_changes" | "comment"; body: string; comments: ReviewComment[]; model: string }
  | { ok: false; reason: string };

export const CLAUDE_REVIEW_MODEL = "claude-opus-5-5";
export const WORKERS_AI_REVIEW_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
/** How much patch each model is shown. Claude has room for far more. */
const PATCH_LIMIT = { claude: 400_000, "workers-ai": 60_000 } as const;

const SYSTEM = `You review code changes for a software project where AI agents do most of the work. No other reviewer is around, so your review decides whether this change can land.
Read the diff against what the task asked for and what the agent declared it would do.
- approve: it does what the task asked, nothing in it is wrong or risky, and it is ready to land as is.
- request_changes: there is a bug, a security problem, data loss, broken behavior, or work clearly outside the task. Say exactly what and where.
- comment: you can't tell (the diff is truncated, or it depends on code you can't see). Say what a person or agent should check.
Line comments point at lines of the new file (the + side). Mark a comment blocking only when the change must not land without fixing it.
Be specific and brief. Don't comment on style or taste. Don't restate the diff.`;

const SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["approve", "request_changes", "comment"] },
    summary: { type: "string", description: "Two or three sentences for the author: the verdict and why." },
    comments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          line: { type: "integer", description: "Line in the new file; 0 for the file as a whole." },
          body: { type: "string" },
          blocking: { type: "boolean" },
        },
        required: ["path", "line", "body", "blocking"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdict", "summary", "comments"],
  additionalProperties: false,
} as const;

/**
 * Number each line of the diff by where it sits in the new file, so a line
 * comment can point at it without the model counting hunk offsets (Llama
 * on Workers AI got this wrong). Removed lines get no number.
 */
export function numberPatch(patch: string): string {
  let n = 0;
  let inHunk = false;
  return patch.split("\n").map((l) => {
    const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (h) { n = Number(h[1]); inHunk = true; return l; }
    if (!inHunk || /^(diff |index |--- |\+\+\+ )/.test(l)) { inHunk = inHunk && !l.startsWith("diff "); return l; }
    if (l.startsWith("-")) return `      ${l}`;
    if (l.startsWith("\\")) return l;
    return `${String(n++).padStart(5)} ${l}`;
  }).join("\n");
}

export function reviewPrompt(i: ReviewInput, limit: number): string {
  const truncated = i.patch.length > limit;
  const cut = truncated ? `${i.patch.slice(0, limit)}\n… (the diff is cut off here: ${i.patch.length - limit} more characters)` : i.patch;
  const patch = numberPatch(cut);
  return [
    `Project: ${i.project}`,
    `Task: ${i.task.title}${i.task.description ? `\n${i.task.description}` : ""}`,
    `Change: ${i.title}${i.summary ? `\n${i.summary}` : ""}`,
    `Declared intent: ${i.intent || "(none)"}`,
    i.brief.length ? `Loom's brief already notes:\n${i.brief.map((b) => `- ${b}`).join("\n")}` : "",
    truncated ? "The diff below is truncated, so don't approve: comment on what you saw and say the rest needs a look." : "",
    `Diff (each line starts with its line number in the new file; removed lines have none):\n${patch}`,
  ].filter(Boolean).join("\n\n");
}

/** Keep what the model said to what the change actually touches. */
export function parseReview(raw: unknown, files: string[], truncated: boolean, model: string): ReviewResult {
  const r = raw as { verdict?: string; summary?: string; comments?: unknown[] } | null;
  if (!r || !["approve", "request_changes", "comment"].includes(r.verdict ?? "")) return { ok: false, reason: `${model} returned no verdict` };
  const touched = new Set(files);
  const comments: ReviewComment[] = (Array.isArray(r.comments) ? r.comments : [])
    .map((c: any) => ({ path: String(c?.path ?? "").replace(/^[ab]\//, ""), line: Number.isInteger(c?.line) && c.line > 0 ? c.line : undefined, body: String(c?.body ?? "").trim(), blocking: !!c?.blocking }))
    .filter((c) => touched.has(c.path) && c.body)
    .slice(0, 20);
  let verdict = r.verdict as "approve" | "request_changes" | "comment";
  // A blocking comment is a request for changes, whatever the verdict says;
  // and a truncated diff is never approved.
  if (comments.some((c) => c.blocking)) verdict = "request_changes";
  else if (verdict === "approve" && truncated) verdict = "comment";
  // Smaller models sometimes echo the verdict as the summary.
  const said = String(r.summary ?? "").trim();
  const body = said && !["approve", "request_changes", "comment"].includes(said.toLowerCase())
    ? said
    : verdict === "approve" ? "Looks right for the task; approving." : verdict === "request_changes" ? "Needs changes before it lands: see the line comments." : "Not sure this is ready: see the line comments.";
  return { ok: true, verdict, body, comments, model };
}

export async function reviewChange(m: ReviewModel, i: ReviewInput): Promise<ReviewResult> {
  const limit = PATCH_LIMIT[m.kind];
  const prompt = reviewPrompt(i, limit);
  const truncated = i.patch.length > limit;
  if (m.kind === "claude") {
    const client = new Anthropic({ apiKey: m.apiKey, baseURL: m.baseURL });
    try {
      const res = await client.beta.messages.create({
        model: CLAUDE_REVIEW_MODEL,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        thinking: { type: "adaptive" },
        output_config: { effort: "high", format: { type: "json_schema", schema: SCHEMA } },
        system: SYSTEM,
        messages: [{ role: "user", content: prompt }],
      });
      if (res.stop_reason === "refusal") return { ok: false, reason: "Claude declined to review this change" };
      if (res.stop_reason === "max_tokens") return { ok: false, reason: "Claude ran out of room before finishing the review" };
      const text = res.content.find((b) => b.type === "text");
      if (!text || text.type !== "text") return { ok: false, reason: "Claude returned no review" };
      return parseReview(JSON.parse(text.text), i.files, truncated, "Claude");
    } catch (e) {
      if (e instanceof SyntaxError) return { ok: false, reason: "Claude's review wasn't valid JSON" };
      if (e instanceof Anthropic.APIError) return { ok: false, reason: `Claude unavailable (${e.status ?? "network"}: ${e.message.slice(0, 80)})` };
      throw e;
    }
  }
  try {
    const out = await m.ai.run(WORKERS_AI_REVIEW_MODEL as any, {
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }],
      response_format: { type: "json_schema", json_schema: SCHEMA },
      max_tokens: 4096,
    } as any, m.gateway ? { gateway: { id: m.gateway, metadata: { loom: "review" } } } : undefined) as { response?: unknown };
    const raw = typeof out?.response === "string" ? JSON.parse(out.response) : out?.response;
    return parseReview(raw, i.files, truncated, "Workers AI");
  } catch (e: any) {
    return { ok: false, reason: `Workers AI unavailable (${String(e?.message ?? e).slice(0, 80)})` };
  }
}
