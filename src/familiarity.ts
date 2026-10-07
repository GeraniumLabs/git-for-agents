// Who knows this code? Loom records, per agent, which files and which
// functions, classes and exports it wrote or reviewed, and ranks reviewers for
// a change by how much of it they already know.

import { diffIndices } from "node-diff3";

const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "function", "else", "do", "try", "with", "new", "typeof", "await"]);

// Declarations in the languages agents most often write. A line can declare
// at most one name; the first pattern that matches wins.
const DECLS: RegExp[] = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/, // js/ts function
  /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, // js/ts/py class
  /^\s*(?:export\s+)?(?:declare\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/, // ts types
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/, // arrow fn
  /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, // exported binding
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, // python
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, // go
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, // rust fn
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|trait|impl)\s+(?:<[^>]*>\s*)?([A-Za-z_]\w*)/, // rust types
  /^\s+(?:(?:public|private|protected|static|readonly|override|async|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\([^;]*\)\s*(?::\s*[^{;=]+)?\{\s*$/, // class method
];

function declared(line: string): string | null {
  for (const re of DECLS) {
    const m = re.exec(line);
    if (m && !KEYWORDS.has(m[1])) return m[1];
  }
  return null;
}

const indent = (line: string) => line.length - line.trimStart().length;

/** The innermost declaration enclosing line i: the nearest one above at no deeper indent. */
function enclosing(lines: string[], i: number): string | null {
  const at = Math.min(i, lines.length - 1);
  if (at < 0) return null;
  let depth = lines[at].trim() ? indent(lines[at]) : Infinity;
  for (let k = at; k >= 0; k--) {
    const l = lines[k];
    if (!l.trim()) continue;
    const name = declared(l);
    if (name && indent(l) <= depth) return name;
    if (k < at) depth = Math.min(depth, indent(l));
    if (depth === 0 && !name) return null; // left every enclosing block
  }
  return null;
}

/** Names of the functions, classes and exports a change to one file touches. */
export function symbolsTouched(before: string | null, after: string | null): string[] {
  const split = (s: string | null) => (s ? s.replace(/\n$/, "").split("\n") : []);
  const a = split(before), b = split(after);
  const names = new Set<string>();
  for (const c of diffIndices(a, b)) {
    const [bStart, bLen] = c.buffer2;
    for (let k = bStart; k < bStart + bLen; k++) {
      const n = declared(b[k]) ?? enclosing(b, k);
      if (n) names.add(n);
    }
    if (!bLen) {
      // A pure deletion: name what it was deleted from (or what was deleted).
      for (let k = c.buffer1[0]; k < c.buffer1[0] + c.buffer1[1]; k++) {
        const n = declared(a[k]) ?? enclosing(a, k);
        if (n) names.add(n);
      }
    }
    if (names.size > 40) break;
  }
  return [...names];
}

export const folderOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

export interface Candidate {
  agent: string;
  name: string;
  role: string;
  score: number;
  reasons: string[];
  openReviews: number;
  present: boolean;
}
