// File writes from agents. The canonical shape is a map of path to full
// contents (null deletes the file). Some agents send a list of
// {path, content} objects instead, so both are accepted; anything else is
// rejected with a message naming the expected shape, so a stray object is
// never written to the repository as "[object Object]".

export type FileWrites = Record<string, string | null>;

const SHAPE = 'files must be an object mapping each path to its full contents, e.g. {"src/app.ts": "...", "old.txt": null} (null deletes); a list of {path, content} objects also works';

export class FilesShapeError extends Error {}

const CONTENT_KEYS = ["content", "contents", "text", "data"] as const;

function fromEntry(e: unknown, i: number): [string, string | null] {
  if (!e || typeof e !== "object" || Array.isArray(e)) throw new FilesShapeError(`files[${i}] is not a {path, content} object. ${SHAPE}`);
  const o = e as Record<string, unknown>;
  const path = o.path ?? o.name ?? o.file;
  if (typeof path !== "string" || !path.trim()) throw new FilesShapeError(`files[${i}] has no path. ${SHAPE}`);
  if (o.delete === true || o.deleted === true) return [path, null];
  const key = CONTENT_KEYS.find((k) => k in o);
  if (!key) throw new FilesShapeError(`files[${i}] (${path}) has no content. ${SHAPE}`);
  return [path, o[key] as string | null];
}

export function normalizeFiles(input: unknown): FileWrites {
  if (input == null) throw new FilesShapeError(`files is required. ${SHAPE}`);
  // Some MCP clients send object arguments as a JSON string.
  if (typeof input === "string") {
    try { input = JSON.parse(input); } catch { throw new FilesShapeError(`files is a string that is not JSON. ${SHAPE}`); }
    if (typeof input === "string") throw new FilesShapeError(`files is a string. ${SHAPE}`);
    return normalizeFiles(input);
  }
  let entries: [string, unknown][];
  if (Array.isArray(input)) entries = input.map(fromEntry);
  else if (typeof input === "object") {
    const o = input as Record<string, unknown>;
    const keys = Object.keys(o);
    // A list that was serialised as an object: {"0": {path, content}, ...}.
    const listLike = keys.length > 0 && keys.every((k) => /^\d+$/.test(k) && o[k] !== null && typeof o[k] === "object");
    entries = listLike ? Object.values(o).map(fromEntry) : Object.entries(o);
  }
  else throw new FilesShapeError(`files is a ${typeof input}. ${SHAPE}`);
  if (!entries.length) throw new FilesShapeError(`files is empty. ${SHAPE}`);
  const out: FileWrites = {};
  for (const [rawPath, content] of entries) {
    const path = rawPath.trim().replace(/^\.?\/+/, "");
    if (!path) throw new FilesShapeError(`a file has an empty path. ${SHAPE}`);
    if (content !== null && typeof content !== "string") throw new FilesShapeError(`${path}: contents must be a string or null, not ${Array.isArray(content) ? "an array" : typeof content}. ${SHAPE}`);
    if (path in out) throw new FilesShapeError(`${path} appears more than once`);
    out[path] = content;
  }
  return out;
}
