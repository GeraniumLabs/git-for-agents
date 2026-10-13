// Attachments: files agents post alongside their work (screenshots, builds,
// logs, documents), hung off a change, a task or the project as a whole.
// They are called attachments, not artifacts, because Artifacts is where
// Loom keeps git. The bytes live in the project's R2 bucket; the coordinator
// keeps one row per file.
//
// Loom serves attachments from its own origin, where people are signed in, so
// nothing an agent uploads may run there: every response is sandboxed, and
// only types a browser shows without running code (images, video, audio, PDF,
// plain text) open inline. Everything else, SVG and HTML included, downloads.

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const PROJECT_ATTACHMENT_BYTES = 2 * 1024 * 1024 * 1024;

export type AttachmentKind = "image" | "video" | "audio" | "pdf" | "text" | "file";

/** Types an attachment may have, by extension. Anything not listed is a build or binary: application/octet-stream. */
const BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
  pdf: "application/pdf",
  txt: "text/plain", log: "text/plain", md: "text/markdown", markdown: "text/markdown", csv: "text/csv", tsv: "text/tab-separated-values",
  json: "application/json", xml: "application/xml", yaml: "application/yaml", yml: "application/yaml", html: "text/html", htm: "text/html",
  diff: "text/x-diff", patch: "text/x-diff",
  zip: "application/zip", gz: "application/gzip", tgz: "application/gzip", tar: "application/x-tar", wasm: "application/wasm",
};
const ALLOWED = new Set([...Object.values(BY_EXT), "application/octet-stream"]);

/** Shown inline as they are: a browser renders these without running anything. */
const INLINE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "video/mp4", "video/webm", "video/quicktime", "audio/mpeg", "audio/wav", "audio/ogg", "application/pdf"]);
/** Readable as text in the browser, served as text/plain so nothing interprets them. */
const AS_TEXT = new Set(["text/plain", "text/markdown", "text/csv", "text/tab-separated-values", "application/json", "application/yaml", "text/x-diff"]);

export class AttachmentError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** A file name safe to store and to put in a header: no directories, no control characters, at most 120 characters. */
export function cleanName(raw: unknown): string {
  if (typeof raw !== "string") throw new AttachmentError(400, "name is required, e.g. \"screenshot.png\"");
  const base = raw.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f"]/g, "").trim();
  if (!base || base === "." || base === "..") throw new AttachmentError(400, "name is required, e.g. \"screenshot.png\"");
  if (base.length <= 120) return base;
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 && base.length - dot <= 12 ? base.slice(dot) : "";
  return base.slice(0, 120 - ext.length) + ext;
}

/** The stored type: the one given if Loom accepts it, else what the extension says, else a binary. */
export function typeOf(name: string, given?: string | null): string {
  const declared = (given ?? "").split(";")[0].trim().toLowerCase();
  if (declared && declared !== "application/octet-stream") {
    const t = declared === "image/jpg" ? "image/jpeg" : declared;
    if (!ALLOWED.has(t)) throw new AttachmentError(415, `attachments can't be ${t}; use an image, video, audio, PDF, text, JSON, an archive, or application/octet-stream for a build`);
    return t;
  }
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return BY_EXT[ext] ?? "application/octet-stream";
}

export function kindOf(type: string): AttachmentKind {
  if (type.startsWith("image/") && type !== "image/svg+xml") return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (type === "application/pdf") return "pdf";
  if (AS_TEXT.has(type)) return "text";
  return "file";
}

/** The bytes of an upload sent as JSON: text, or base64 (a data: URL is fine too). */
export function bytesOf(body: { text?: unknown; base64?: unknown; content?: unknown }): Uint8Array {
  if (typeof body.text === "string") return new TextEncoder().encode(body.text);
  const b64 = typeof body.base64 === "string" ? body.base64 : typeof body.content === "string" ? body.content : null;
  if (b64 === null) throw new AttachmentError(400, "send the file as text (for logs, Markdown, JSON) or base64 (for anything else), or POST the raw bytes with ?name=");
  const clean = b64.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  if (clean.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 4) throw tooBig(Math.floor(clean.length * 3 / 4));
  let bin: string;
  try { bin = atob(clean); } catch { throw new AttachmentError(400, "base64 isn't valid base64"); }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const tooBig = (n: number) => new AttachmentError(413, `attachments are at most ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB; this one is ${(n / 1024 / 1024).toFixed(1)} MB`);

export function checkSize(n: number, used: number) {
  if (n === 0) throw new AttachmentError(400, "the file is empty");
  if (n > MAX_ATTACHMENT_BYTES) throw tooBig(n);
  if (used + n > PROJECT_ATTACHMENT_BYTES) throw new AttachmentError(413, `this project's attachments would pass ${PROJECT_ATTACHMENT_BYTES / 1024 ** 3} GB; ask an owner to remove old ones`);
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Headers for serving an attachment from Loom's own origin. */
export function serveHeaders(a: { name: string; content_type: string; size: number; sha256?: string | null }, opts: { download?: boolean } = {}): Headers {
  const type = a.content_type;
  const inline = !opts.download && (INLINE.has(type) || AS_TEXT.has(type));
  const h = new Headers({
    "content-type": AS_TEXT.has(type) ? "text/plain; charset=utf-8" : INLINE.has(type) ? type : "application/octet-stream",
    "content-length": String(a.size),
    "content-disposition": `${inline ? "inline" : "attachment"}; filename="${a.name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(a.name)}`,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
    // An attachment never changes. Shared caches never keep one, since a public project can turn private.
    "cache-control": "private, max-age=31536000, immutable",
  });
  if (a.sha256) h.set("etag", `"${a.sha256}"`);
  return h;
}
