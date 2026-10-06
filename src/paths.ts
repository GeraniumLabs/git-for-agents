// Path patterns used by intents. A pattern is a repository path ("src/a.ts"),
// a directory ("src/auth/"), or a glob ("src/**/*.test.ts").

const GLOB = /[*?[{]/;

export function normalizePattern(p: string): string {
  return p.trim().replace(/^\.?\/+/, "");
}

function staticPrefix(p: string): string {
  const i = p.search(GLOB);
  return i === -1 ? p : p.slice(0, i);
}

export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      re += "(" + glob.slice(i + 1, end).split(",").map(escape).join("|") + ")";
      i = end;
    } else re += escape(c);
  }
  return new RegExp("^" + re + "$");
}

function escape(s: string) {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/** Does a concrete file path fall under a pattern? */
export function matches(pattern: string, file: string): boolean {
  pattern = normalizePattern(pattern);
  if (pattern === "" || pattern === "**") return true;
  if (pattern.endsWith("/")) return file.startsWith(pattern);
  if (GLOB.test(pattern)) return globToRegExp(pattern).test(file);
  return file === pattern || file.startsWith(pattern + "/");
}

/** Could two patterns ever name the same file? Conservative for two globs. */
export function overlaps(a: string, b: string): boolean {
  a = normalizePattern(a);
  b = normalizePattern(b);
  const ga = GLOB.test(a) || a.endsWith("/"), gb = GLOB.test(b) || b.endsWith("/");
  if (!ga && !gb) return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
  if (!ga) return matches(b, a);
  if (!gb) return matches(a, b);
  const pa = staticPrefix(a), pb = staticPrefix(b);
  return pa.startsWith(pb) || pb.startsWith(pa);
}

export function anyOverlap(as: string[], bs: string[]): string[] {
  const hits = new Set<string>();
  for (const a of as) for (const b of bs) if (overlaps(a, b)) hits.add(GLOB.test(a) ? b : a);
  return [...hits];
}
