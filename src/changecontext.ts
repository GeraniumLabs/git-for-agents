/**
 * A change's working context as an object of named parts. The tool schema asks
 * for an object, but some agents send one markdown string; that becomes
 * { notes }. Spreading a string would store one key per character.
 */
export function contextOf(v: unknown): Record<string, unknown> {
  if (v == null) return {};
  if (typeof v === "string") return v.trim() ? { notes: v } : {};
  if (Array.isArray(v)) return v.length ? { notes: v } : {};
  if (typeof v === "object") return v as Record<string, unknown>;
  return { notes: String(v) };
}
