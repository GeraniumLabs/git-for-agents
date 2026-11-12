// The code map: what's in main without reading it. Each file's language,
// size, the functions, classes and types it declares (and which it exports),
// and what it imports, plus who imports it. Agents ask for it over MCP instead
// of reading files one by one to find their way, which is most of the tokens
// a new agent spends on a codebase. Built with regular expressions, not a
// parser: good enough to navigate by, and it works for any language.

export interface MapSymbol { name: string; kind: "function" | "class" | "type" | "const" | "method"; line: number; exported: boolean }
export interface MapFile { path: string; lang: string; lines: number; bytes: number; symbols: MapSymbol[]; imports: string[]; importedBy: string[]; words: string[] }
export interface CodeMap { head: string; builtAt: number; files: MapFile[]; skipped: number }

const LANGS: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", go: "go", rs: "rust", rb: "ruby", java: "java", kt: "kotlin", swift: "swift", c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp",
  php: "php", sh: "shell", sql: "sql", md: "markdown", json: "json", toml: "toml", yaml: "yaml", yml: "yaml", css: "css", html: "html", vue: "vue", svelte: "svelte",
};
/** Paths a map leaves out: dependencies, builds and lockfiles. */
export const SKIP = /(^|\/)(node_modules|vendor|dist|build|out|target|\.git|\.next|coverage|__pycache__)\/|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|poetry\.lock)$|\.min\.(js|css)$/;
export const MAX_FILE_BYTES = 256 * 1024;

export const langOf = (path: string) => LANGS[path.split(".").pop()?.toLowerCase() ?? ""] ?? "other";

type Rule = { re: RegExp; kind: MapSymbol["kind"]; exported?: (line: string, name: string) => boolean };
const jsExported = (l: string) => /^\s*export\b/.test(l);
const RULES: Record<string, Rule[]> = {
  js: [
    { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/, kind: "function", exported: jsExported },
    { re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class", exported: jsExported },
    { re: /^\s*(?:export\s+)?(?:declare\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/, kind: "type", exported: jsExported },
    { re: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/, kind: "function", exported: jsExported },
    { re: /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, kind: "const", exported: () => true },
    { re: /^\s{2,}(?:(?:public|private|protected|static|readonly|override|async|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\([^;]*\)\s*(?::\s*[^{;=]+)?\{\s*$/, kind: "method", exported: () => false },
  ],
  python: [
    { re: /^(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: "function", exported: (_l, n) => !n.startsWith("_") },
    { re: /^class\s+([A-Za-z_]\w*)/, kind: "class", exported: (_l, n) => !n.startsWith("_") },
    { re: /^\s+(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: "method", exported: () => false },
  ],
  go: [
    { re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: "function", exported: (_l, n) => /^[A-Z]/.test(n) },
    { re: /^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/, kind: "type", exported: (_l, n) => /^[A-Z]/.test(n) },
  ],
  rust: [
    { re: /^\s*(pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, kind: "function" },
    { re: /^\s*(pub(?:\([^)]*\))?\s+)?(?:struct|trait|enum)\s+([A-Za-z_]\w*)/, kind: "type" },
  ],
  other: [
    { re: /^\s*(?:public\s+|private\s+|protected\s+|internal\s+)?(?:static\s+)?(?:final\s+)?(?:abstract\s+)?(?:class|interface|struct|enum|object|module)\s+([A-Za-z_]\w*)/, kind: "class", exported: (l) => !/\bprivate\b/.test(l) },
    { re: /^\s*def\s+([A-Za-z_]\w*[?!]?)/, kind: "function", exported: () => true },
  ],
};
const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "function", "constructor", "else", "do", "try", "with"]);

const IMPORTS: RegExp[] = [
  /^\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/, /\brequire\(\s*['"]([^'"]+)['"]\s*\)/, /^\s*export\s+[^'"]*\s+from\s+['"]([^'"]+)['"]/, /\bimport\(\s*['"]([^'"]+)['"]\s*\)/,
  /^\s*from\s+([\w.]+)\s+import\b/, /^\s*import\s+([\w.]+)\s*$/, /^\s*use\s+([\w:]+)/, /^\s*"([\w./-]+)"\s*$/,
];

/** One file's outline: its declarations and imports. */
export function outline(path: string, text: string): Omit<MapFile, "importedBy"> {
  const lang = langOf(path);
  const rules = lang === "typescript" || lang === "javascript" || lang === "vue" || lang === "svelte" ? RULES.js : RULES[lang] ?? RULES.other;
  const lines = text.split("\n");
  const symbols: MapSymbol[] = [];
  const imports = new Set<string>();
  let inGoImport = false;
  for (let i = 0; i < lines.length && symbols.length < 300; i++) {
    const l = lines[i];
    if (l.length > 400) continue;
    for (const r of rules) {
      const m = r.re.exec(l);
      if (!m) continue;
      const name = lang === "rust" ? m[2] : m[1];
      if (!name || KEYWORDS.has(name)) continue;
      symbols.push({ name, kind: r.kind, line: i + 1, exported: lang === "rust" ? !!m[1] : r.exported ? r.exported(l, name) : false });
      break;
    }
    if (lang === "go") { if (/^import\s*\($/.test(l)) inGoImport = true; else if (inGoImport && /^\)/.test(l)) inGoImport = false; }
    if (lang === "markdown" || lang === "json") continue;
    for (const re of IMPORTS) {
      if (re === IMPORTS[7] && !inGoImport) continue;
      const m = re.exec(l);
      if (m) imports.add(m[1]);
    }
  }
  // The identifiers it uses, for search: distinct words of three characters or more.
  const words = new Set<string>();
  for (const w of text.match(/[A-Za-z_][A-Za-z0-9_]{2,40}/g) ?? []) { words.add(w); if (words.size >= 600) break; }
  return { path, lang, lines: lines.length, bytes: text.length, symbols, imports: [...imports].slice(0, 100), words: [...words] };
}

/** A relative import as a repository path, when it names a file in the map. */
export function resolveImport(from: string, spec: string, paths: Set<string>): string | null {
  if (!spec.startsWith(".")) {
    // Python-style dotted modules: pkg.mod → pkg/mod.py
    if (/^[\w.]+$/.test(spec) && spec.includes(".")) { const p = `${spec.replace(/\./g, "/")}.py`; if (paths.has(p)) return p; }
    return null;
  }
  const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")).split("/") : [];
  for (const part of spec.split("/")) { if (part === "..") dir.pop(); else if (part !== ".") dir.push(part); }
  const base = dir.join("/");
  for (const cand of [base, ...["ts", "tsx", "js", "jsx", "mjs", "cjs", "py"].map((e) => `${base}.${e}`), ...["ts", "tsx", "js", "mjs"].map((e) => `${base}/index.${e}`), base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx")]) {
    if (paths.has(cand)) return cand;
  }
  return null;
}

export function buildMap(head: string, files: { path: string; text: string }[], skipped = 0): CodeMap {
  const outs = files.map((f) => outline(f.path, f.text));
  const paths = new Set(outs.map((o) => o.path));
  const importedBy = new Map<string, Set<string>>();
  for (const o of outs) {
    o.imports = o.imports.map((spec) => resolveImport(o.path, spec, paths) ?? spec);
    for (const i of o.imports) if (paths.has(i)) { const s = importedBy.get(i) ?? new Set(); s.add(o.path); importedBy.set(i, s); }
  }
  return { head, builtAt: Date.now(), skipped, files: outs.map((o) => ({ ...o, importedBy: [...(importedBy.get(o.path) ?? [])].sort() })) };
}

/** Split camelCase, snake_case and paths into lowercase terms. */
export const terms = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2);

/** Files ranked for a query: symbol names count most, then paths, then the identifiers a file uses. Each hit says why. */
export function searchMap(map: CodeMap, query: string, limit = 15) {
  const q = terms(query);
  if (!q.length) return [];
  const exact = query.trim();
  const hits = map.files.map((f) => {
    let score = 0;
    const why: string[] = [];
    for (const s of f.symbols) {
      if (s.name === exact) { score += 20; why.push(`${s.kind} ${s.name} (line ${s.line})`); continue; }
      const st = terms(s.name);
      const n = q.filter((t) => st.some((x) => x === t || (t.length >= 4 && x.startsWith(t)))).length;
      if (n) { score += (4 * n) / q.length * (s.exported ? 1.5 : 1); if (why.length < 4) why.push(`${s.kind} ${s.name} (line ${s.line})`); }
    }
    const pt = terms(f.path);
    const inPath = q.filter((t) => pt.some((x) => x === t || (t.length >= 4 && x.startsWith(t)))).length;
    if (inPath) { score += (3 * inPath) / q.length; why.push("path"); }
    const words = new Set(f.words.flatMap(terms));
    const used = q.filter((t) => words.has(t)).length;
    if (used) score += used / q.length;
    return { path: f.path, score: Math.round(score * 100) / 100, why, lines: f.lines, importedBy: f.importedBy.length };
  }).filter((h) => h.score > 0);
  // Files many others import break ties: they're where things are defined.
  return hits.sort((a, b) => b.score - a.score || b.importedBy - a.importedBy).slice(0, limit);
}

/** Where a symbol is declared, and the files that use it. */
export function findSymbol(map: CodeMap, name: string) {
  const defs = map.files.flatMap((f) => f.symbols.filter((s) => s.name === name).map((s) => ({ path: f.path, line: s.line, kind: s.kind, exported: s.exported })));
  const defPaths = new Set(defs.map((d) => d.path));
  const usedIn = map.files.filter((f) => !defPaths.has(f.path) && f.words.includes(name)).map((f) => ({ path: f.path, imports: f.imports.filter((i) => defPaths.has(i)) }));
  usedIn.sort((a, b) => b.imports.length - a.imports.length || a.path.localeCompare(b.path));
  return { name, defs, usedIn: usedIn.slice(0, 50), moreUses: Math.max(0, usedIn.length - 50) };
}

/** The map under a folder, compact: folders with their size, and files with what they export. */
export function mapView(map: CodeMap, prefix = "", detail = false) {
  const pre = prefix.replace(/^\/+|\/+$/g, "");
  const under = map.files.filter((f) => !pre || f.path === pre || f.path.startsWith(`${pre}/`));
  const folders = new Map<string, { files: number; lines: number }>();
  const files: any[] = [];
  for (const f of under) {
    const rest = pre && f.path !== pre ? f.path.slice(pre.length + 1) : f.path === pre ? f.path.split("/").pop()! : f.path;
    if (rest.includes("/") && !detail) {
      const dir = `${pre ? `${pre}/` : ""}${rest.split("/")[0]}`;
      const d = folders.get(dir) ?? { files: 0, lines: 0 };
      d.files++; d.lines += f.lines; folders.set(dir, d);
      continue;
    }
    files.push({
      path: f.path, lang: f.lang, lines: f.lines,
      exports: f.symbols.filter((s) => s.exported).map((s) => `${s.kind === "function" ? `${s.name}()` : s.name}:${s.line}`).slice(0, 40),
      ...(detail || under.length <= 8 ? { symbols: f.symbols.filter((s) => !s.exported).map((s) => `${s.name}:${s.line}`).slice(0, 60) } : {}),
      imports: f.imports.slice(0, 20), importedBy: f.importedBy.slice(0, 20),
    });
  }
  return { head: map.head, path: pre || "/", folders: [...folders].map(([path, d]) => ({ path, ...d })).sort((a, b) => b.lines - a.lines), files };
}
