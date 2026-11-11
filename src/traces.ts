// Session traces: what an agent saw, thought and did in the session that
// produced a change, kept with the change so people can review its decisions
// after the fact.
//
// An agent (or the hook or runner around it) uploads its session log. Loom
// removes secrets first, so the unredacted text is never stored, then reads
// the log into a list of steps it can index and link to Loom's own events.
// The redacted log itself goes to R2, so nothing in it is lost.
//
// Formats read: Claude Code transcripts and Codex session logs (one JSON
// object per line), and OpenTelemetry spans that follow the GenAI
// conventions. Anything else is kept as plain text, with no steps.

import { billingOn } from "./billing";
import type { Env } from "./env";

export const MAX_TRACE_BYTES = 25 * 1024 * 1024;

export type TraceSource = "claude-code" | "codex" | "otel" | "text";
export const TRACE_SOURCES: TraceSource[] = ["claude-code", "codex", "otel", "text"];

export type StepKind = "prompt" | "thought" | "message" | "tool_call" | "tool_result" | "error";

export interface Step {
  seq: number;
  ts: number | null;
  kind: StepKind;
  /** The tool called, as the agent named it. */
  tool?: string;
  /** Set when the call was to Loom: the Loom tool's own name, e.g. declare_intent. */
  loomCall?: string;
  /** The text, the call's arguments or its result, cut to PREVIEW characters. */
  preview: string;
  /** Paths the step read or wrote. */
  files: string[];
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  error?: boolean;
}

export interface ParsedTrace {
  source: TraceSource;
  sessionId: string | null;
  models: string[];
  startedAt: number | null;
  endedAt: number | null;
  tokensIn: number;
  tokensOut: number;
  /** Only when the log reports it. */
  costUsd: number | null;
  steps: Step[];
}

/** How much of each step's text the index keeps; the whole text stays in the stored log. */
export const PREVIEW = 600;

const cut = (s: string, n = PREVIEW) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const asText = (v: unknown): string => {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : x?.text ?? (x?.type === "image" ? "[image]" : JSON.stringify(x)))).join("\n");
  return JSON.stringify(v);
};
const time = (v: unknown): number | null => {
  if (typeof v === "number") return v > 1e14 ? Math.round(v / 1e6) : v; // nanoseconds from OpenTelemetry
  if (typeof v === "string") {
    if (/^\d+$/.test(v)) return time(Number(v));
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
};

// ── redaction ────────────────────────────────────────────────────────────

const SECRET_PATTERNS: [string, RegExp][] = [
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ["openai-key", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g],
  ["aws-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["slack-token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ["stripe-key", /\b(?:sk|rk|whsec)_(?:live|test)?_?[A-Za-z0-9]{16,}/g],
  ["google-key", /\bAIza[0-9A-Za-z_-]{35}/g],
  ["loom-key", /\bloom(?:stand)?_[A-Za-z0-9]{16,}/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
];
/** user:password@ in a URL. */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/"'\\]+:[^\s@/"'\\]+@/gi;
/** Authorization: Bearer <token>. */
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/g;
/** API_KEY=..., "password": "...", token: ... — the value goes, the name stays. Never crosses a quote, so JSON stays valid. */
const ASSIGNED = /\b([A-Za-z0-9_]*(?:api[_-]?key|secret|token|password|passwd|access[_-]?key|credentials?)[A-Za-z0-9_]*)(\\?["']?\s*[:=]\s*\\?["']?)([^\s"'\\,;(){}[\]]{8,})/gi;

export interface Redaction {
  text: string;
  count: number;
  kinds: Record<string, number>;
}

/**
 * Replace secrets with [redacted:<kind>]. `literals` are exact values to
 * remove (a project's join codes, say); `patterns` are an owner's own regular
 * expressions. Replacements contain no quotes or backslashes, so a JSON log
 * stays valid JSON.
 */
export function redact(text: string, opts: { literals?: string[]; patterns?: string[] } = {}): Redaction {
  const kinds: Record<string, number> = {};
  const hit = (kind: string) => (kinds[kind] = (kinds[kind] ?? 0) + 1);
  let out = text;
  for (const [kind, re] of SECRET_PATTERNS) out = out.replace(re, () => (hit(kind), `[redacted:${kind}]`));
  out = out.replace(URL_CREDENTIALS, (_m, scheme) => (hit("url-credentials"), `${scheme}[redacted:url-credentials]@`));
  out = out.replace(BEARER, (_m, pre) => (hit("bearer"), `${pre}[redacted:bearer]`));
  out = out.replace(ASSIGNED, (m, name, sep, value) => (value.startsWith("[redacted") ? m : (hit("assigned"), `${name}${sep}[redacted:assigned]`)));
  for (const lit of opts.literals ?? []) {
    if (!lit || lit.length < 6) continue;
    const pieces = out.split(lit);
    if (pieces.length < 2) continue;
    out = pieces.join("[redacted:project-secret]");
    kinds["project-secret"] = (kinds["project-secret"] ?? 0) + pieces.length - 1;
  }
  for (const p of opts.patterns ?? []) {
    let re: RegExp;
    try { re = new RegExp(p, "g"); } catch { continue; }
    out = out.replace(re, (m) => (m ? (hit("owner-rule"), "[redacted:owner-rule]") : m));
  }
  for (const k of Object.keys(kinds)) if (kinds[k] <= 0) delete kinds[k];
  return { text: out, count: Object.values(kinds).reduce((a, b) => a + b, 0), kinds };
}

/** An owner's pattern must compile and must not match the empty string (it would match everywhere). */
export function checkPattern(p: string): string | null {
  if (typeof p !== "string" || !p || p.length > 200) return "a pattern is 1 to 200 characters";
  try {
    const re = new RegExp(p);
    if (re.test("")) return `"${p}" matches empty text`;
  } catch (e: any) {
    return `"${p}" isn't a valid regular expression: ${e.message}`;
  }
  return null;
}

// ── reading the formats ──────────────────────────────────────────────────

const jsonLines = (text: string): any[] => {
  const out: any[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* a cut-off last line, or prose */ }
  }
  return out;
};

/** Which format a log is in, from its first lines. */
export function detectSource(text: string): TraceSource {
  const head = text.slice(0, 20_000).trimStart();
  if (head.startsWith("{") && /"resourceSpans"\s*:/.test(head)) return "otel";
  const lines = jsonLines(head).slice(0, 20);
  if (lines.some((l) => ["session_meta", "response_item", "event_msg", "turn_context"].includes(l?.type) && l.payload)) return "codex";
  if (lines.some((l) => ["user", "assistant", "summary", "system"].includes(l?.type) && (l.message || l.sessionId || l.summary))) return "claude-code";
  return "text";
}

/** A call to Loom: the server's name has "loom" in it, e.g. mcp__loom__declare_intent or loom.declare_intent. */
export function loomCallOf(tool: string, args: any): string | undefined {
  const parts = tool.split(/__|\./);
  if (parts.length < 2) return undefined;
  const name = parts[parts.length - 1];
  if (!/loom/i.test(parts.slice(0, -1).join("_"))) return undefined;
  if (name === "loom_tool") return typeof args?.tool === "string" ? args.tool : typeof args?.name === "string" ? args.name : name;
  return name;
}

/** Paths a tool call names: file_path, path, paths, Loom's write_files list or map, and apply_patch headers. */
export function filesOf(args: any): string[] {
  const out = new Set<string>();
  const add = (p: unknown) => { if (typeof p === "string" && p && p.length < 400 && !p.includes("\n")) out.add(p); };
  if (typeof args === "string") {
    for (const m of args.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) add(m[1].trim());
    return [...out];
  }
  if (!args || typeof args !== "object") return [];
  add(args.file_path); add(args.path); add(args.notebook_path);
  if (Array.isArray(args.paths)) args.paths.forEach(add);
  const files = args.files;
  if (Array.isArray(files)) files.forEach((f: any) => add(typeof f === "string" ? f : f?.path));
  else if (files && typeof files === "object") Object.keys(files).forEach(add);
  if (typeof args.input === "string") filesOf(args.input).forEach(add);
  if (Array.isArray(args.command)) filesOf(args.command.join(" ")).forEach(add);
  return [...out];
}

class Builder {
  steps: Step[] = [];
  models = new Set<string>();
  tokensIn = 0;
  tokensOut = 0;
  cost: number | null = null;
  first: number | null = null;
  last: number | null = null;
  sessionId: string | null = null;
  constructor(private keepThoughts: boolean) {}
  seen(ts: number | null) {
    if (ts === null) return;
    if (this.first === null || ts < this.first) this.first = ts;
    if (this.last === null || ts > this.last) this.last = ts;
  }
  add(s: Omit<Step, "seq" | "files"> & { files?: string[] }) {
    if (s.kind === "thought" && !this.keepThoughts) return;
    if (!s.preview && s.kind !== "tool_call") return;
    this.seen(s.ts);
    this.steps.push({ ...s, seq: this.steps.length + 1, preview: cut(s.preview), files: s.files ?? [] });
  }
  done(source: TraceSource): ParsedTrace {
    return { source, sessionId: this.sessionId, models: [...this.models], startedAt: this.first, endedAt: this.last, tokensIn: this.tokensIn, tokensOut: this.tokensOut, costUsd: this.cost, steps: this.steps };
  }
}

function parseClaudeCode(text: string, keepThoughts: boolean): ParsedTrace {
  const b = new Builder(keepThoughts);
  const tools = new Map<string, string>(); // tool_use id → tool name
  const counted = new Set<string>();
  for (const l of jsonLines(text)) {
    if (!l || typeof l !== "object") continue;
    b.sessionId ??= l.sessionId ?? null;
    const ts = time(l.timestamp);
    if (typeof l.costUSD === "number") b.cost = (b.cost ?? 0) + l.costUSD;
    const msg = l.message;
    if (!msg) continue;
    const model = typeof msg.model === "string" && msg.model !== "<synthetic>" ? msg.model : undefined;
    if (model) b.models.add(model);
    // Claude Code writes one line per content block, each repeating the message's usage: count it once per message.
    const u = msg.usage && !(msg.id && counted.has(msg.id)) ? msg.usage : null;
    if (msg.id && u) counted.add(msg.id);
    const tokensIn: number | undefined = u ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : undefined;
    const tokensOut: number | undefined = u ? u.output_tokens ?? 0 : undefined;
    b.tokensIn += tokensIn ?? 0;
    b.tokensOut += tokensOut ?? 0;
    const content = typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : Array.isArray(msg.content) ? msg.content : [];
    let usageGiven = false;
    const usage = () => (usageGiven ? {} : ((usageGiven = true), { tokensIn, tokensOut }));
    for (const c of content) {
      if (!c || typeof c !== "object") continue;
      if (c.type === "text") {
        const user = l.type === "user" || msg.role === "user";
        b.add({ ts, kind: user ? "prompt" : "message", preview: asText(c.text), model, ...(user ? {} : usage()) });
      } else if (c.type === "thinking" || c.type === "redacted_thinking") {
        b.add({ ts, kind: "thought", preview: asText(c.thinking ?? "[redacted thinking]"), model, ...usage() });
      } else if (c.type === "tool_use") {
        const name = String(c.name ?? "tool");
        if (c.id) tools.set(c.id, name);
        b.add({ ts, kind: "tool_call", tool: name, loomCall: loomCallOf(name, c.input), preview: asText(c.input), files: filesOf(c.input), model, ...usage() });
      } else if (c.type === "tool_result") {
        const name = tools.get(c.tool_use_id);
        b.add({ ts, kind: c.is_error ? "error" : "tool_result", tool: name, loomCall: name ? loomCallOf(name, null) : undefined, preview: asText(c.content), error: !!c.is_error });
      }
    }
  }
  return b.done("claude-code");
}

function parseCodex(text: string, keepThoughts: boolean): ParsedTrace {
  const b = new Builder(keepThoughts);
  const calls = new Map<string, string>();
  let model: string | undefined;
  let lastTotal = { in: 0, out: 0 };
  for (const l of jsonLines(text)) {
    const p = l?.payload;
    if (!p || typeof p !== "object") continue;
    const ts = time(l.timestamp);
    b.seen(ts);
    if (l.type === "session_meta") {
      b.sessionId ??= p.id ?? p.session_id ?? null;
      if (typeof p.model === "string") { model = p.model; b.models.add(p.model); }
      continue;
    }
    if (l.type === "turn_context") {
      if (typeof p.model === "string") { model = p.model; b.models.add(p.model); }
      continue;
    }
    if (l.type === "event_msg") {
      // token_count carries running totals; keep the latest.
      const t = p.type === "token_count" ? p.info?.total_token_usage : null;
      if (t) {
        lastTotal = { in: (t.input_tokens ?? 0), out: (t.output_tokens ?? 0) + (t.reasoning_output_tokens ?? 0) };
        b.tokensIn = lastTotal.in;
        b.tokensOut = lastTotal.out;
      }
      continue;
    }
    if (l.type !== "response_item") continue;
    if (p.type === "message") {
      const user = p.role === "user";
      const body = asText(p.content);
      // Codex repeats its own instructions and environment as user messages; they aren't the person's prompt.
      if (user && /^<(user_instructions|environment_context)>/.test(body.trim())) continue;
      b.add({ ts, kind: user ? "prompt" : "message", preview: body, model: user ? undefined : model });
    } else if (p.type === "reasoning") {
      b.add({ ts, kind: "thought", preview: asText((p.summary ?? []).map((s: any) => s?.text ?? "")) || "[reasoning]", model });
    } else if (p.type === "function_call" || p.type === "custom_tool_call" || p.type === "local_shell_call") {
      const name = String(p.name ?? (p.type === "local_shell_call" ? "shell" : "tool"));
      let args: any = p.arguments ?? p.input ?? p.action;
      if (typeof args === "string") { try { args = JSON.parse(args); } catch { /* apply_patch takes raw text */ } }
      if (p.call_id) calls.set(p.call_id, name);
      b.add({ ts, kind: "tool_call", tool: name, loomCall: loomCallOf(name, args), preview: asText(args), files: filesOf(args), model });
    } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
      const name = calls.get(p.call_id);
      const out = typeof p.output === "string" ? p.output : asText(p.output?.content ?? p.output);
      const failed = /"exit_code"\s*:\s*[1-9]/.test(out) || p.output?.success === false;
      b.add({ ts, kind: failed ? "error" : "tool_result", tool: name, loomCall: name ? loomCallOf(name, null) : undefined, preview: out, error: failed });
    }
  }
  return b.done("codex");
}

function parseOtel(text: string, keepThoughts: boolean): ParsedTrace {
  const b = new Builder(keepThoughts);
  let doc: any;
  try { doc = JSON.parse(text); } catch { return parseText(text); }
  const spans: any[] = [];
  for (const rs of doc.resourceSpans ?? []) for (const ss of rs.scopeSpans ?? rs.instrumentationLibrarySpans ?? []) spans.push(...(ss.spans ?? []));
  spans.sort((x, y) => (time(x.startTimeUnixNano) ?? 0) - (time(y.startTimeUnixNano) ?? 0));
  const val = (v: any) => v?.stringValue ?? (v?.intValue !== undefined ? Number(v.intValue) : v?.doubleValue ?? v?.boolValue ?? (v?.arrayValue ? v.arrayValue.values?.map(val) : undefined));
  for (const s of spans) {
    const at: Record<string, any> = {};
    for (const kv of s.attributes ?? []) at[kv.key] = val(kv.value);
    b.sessionId ??= at["session.id"] ?? at["gen_ai.conversation.id"] ?? s.traceId ?? null;
    const ts = time(s.startTimeUnixNano);
    b.seen(time(s.endTimeUnixNano));
    const model = at["gen_ai.response.model"] ?? at["gen_ai.request.model"];
    if (model) b.models.add(model);
    const tin = Number(at["gen_ai.usage.input_tokens"] ?? 0) || undefined;
    const tout = Number(at["gen_ai.usage.output_tokens"] ?? 0) || undefined;
    if (tin) b.tokensIn += tin;
    if (tout) b.tokensOut += tout;
    const op = at["gen_ai.operation.name"];
    const failed = s.status?.code === 2 || s.status?.code === "STATUS_CODE_ERROR";
    if (op === "execute_tool" || at["gen_ai.tool.name"]) {
      const name = String(at["gen_ai.tool.name"] ?? s.name ?? "tool");
      let args: any = at["gen_ai.tool.call.arguments"] ?? at["gen_ai.tool.arguments"];
      if (typeof args === "string") { try { args = JSON.parse(args); } catch { /* keep as text */ } }
      b.add({ ts, kind: failed ? "error" : "tool_call", tool: name, loomCall: loomCallOf(name, args), preview: asText(args ?? s.name), files: filesOf(args), model, error: failed });
      const result = at["gen_ai.tool.call.result"];
      if (result !== undefined) b.add({ ts: time(s.endTimeUnixNano), kind: "tool_result", tool: name, loomCall: loomCallOf(name, null), preview: asText(result) });
    } else if (model || op) {
      const out = at["gen_ai.completion"] ?? at["gen_ai.output.messages"] ?? s.name;
      b.add({ ts, kind: failed ? "error" : "message", preview: asText(out), model, tokensIn: tin, tokensOut: tout, error: failed });
    }
  }
  return b.done("otel");
}

function parseText(text: string): ParsedTrace {
  return { source: "text", sessionId: null, models: [], startedAt: null, endedAt: null, tokensIn: 0, tokensOut: 0, costUsd: null, steps: [] };
}

/** Read a (redacted) log into steps. */
export function parseTrace(text: string, source: TraceSource = detectSource(text), keepThoughts = true): ParsedTrace {
  if (source === "claude-code") return parseClaudeCode(text, keepThoughts);
  if (source === "codex") return parseCodex(text, keepThoughts);
  if (source === "otel") return parseOtel(text, keepThoughts);
  return parseText(text);
}

/**
 * Take the model's own reasoning out of the stored log too, when a project
 * keeps no thoughts: thinking blocks from Claude Code, reasoning items from Codex.
 */
export function dropThoughts(text: string, source: TraceSource): string {
  if (source !== "claude-code" && source !== "codex") return text;
  return text.split("\n").flatMap((line) => {
    const t = line.trim();
    if (!t) return [line];
    let l: any;
    try { l = JSON.parse(t); } catch { return [line]; }
    if (source === "codex") return l?.type === "response_item" && l.payload?.type === "reasoning" ? [] : [line];
    const c = l?.message?.content;
    if (!Array.isArray(c) || !c.some((x: any) => x?.type === "thinking" || x?.type === "redacted_thinking")) return [line];
    l.message.content = c.filter((x: any) => x?.type !== "thinking" && x?.type !== "redacted_thinking");
    return [JSON.stringify(l)];
  }).join("\n");
}

// ── limits ───────────────────────────────────────────────────────────────

export interface TraceLimits {
  /** Bytes of traces one project may hold; 0 is no limit. */
  bytes: number;
  /** Days a trace is kept; 0 is forever. */
  days: number;
}

const GB = 1024 ** 3;
export const TRACE_PLANS: Record<string, TraceLimits> = {
  free: { bytes: 0.2 * GB, days: 30 },
  pro: { bytes: 5 * GB, days: 365 },
  unlimited: { bytes: 0, days: 0 },
};

/** A project's trace limits: from its plan when the server takes payments, else LOOM_TRACE_BYTES and LOOM_TRACE_DAYS. */
export function traceLimits(env: Env, plan: string | null): TraceLimits {
  if (billingOn(env) && plan) return TRACE_PLANS[plan] ?? TRACE_PLANS.free;
  const n = (v: string | undefined, d: number) => (v === undefined || v === "" ? d : Number(v));
  return { bytes: n(env.LOOM_TRACE_BYTES, 2 * GB), days: n(env.LOOM_TRACE_DAYS, 90) };
}

// ── storage ──────────────────────────────────────────────────────────────
//
// A trace's log and its steps live in R2, gzipped, one object each; the
// project's coordinator keeps only a small summary row per trace. Agent logs
// compress about tenfold, and a Durable Object holds at most 10 GB, which
// thousands of agents' steps would fill in weeks.

export const traceKeys = (project: string, id: number) => ({ log: `${project}/traces/${id}/log.gz`, steps: `${project}/traces/${id}/steps.json.gz` });

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
export const gzip = (text: string) => pipe(new TextEncoder().encode(text), new CompressionStream("gzip"));
export const gunzip = async (bytes: Uint8Array) => new TextDecoder().decode(await pipe(bytes, new DecompressionStream("gzip")));
