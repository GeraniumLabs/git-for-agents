import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { buildMap, findSymbol, mapView, outline, resolveImport, searchMap } from "../src/codemap";

test("an outline finds declarations, what's exported and imports, across languages", () => {
  const ts = outline("src/a.ts", `import { b } from "./b";\nexport function trimTitle(t: string) {}\nfunction inner() {}\nexport class Store {\n  get(id: string) {\n  }\n}\nexport interface Row { id: string }\nexport const LIMIT = 3;\n`);
  assert.deepEqual(ts.symbols.map((s) => [s.name, s.kind, s.line, s.exported]), [["trimTitle", "function", 2, true], ["inner", "function", 3, false], ["Store", "class", 4, true], ["get", "method", 5, false], ["Row", "type", 8, true], ["LIMIT", "const", 9, true]]);
  assert.deepEqual(ts.imports, ["./b"]);
  const py = outline("app/db.py", "from app.models import Row\nimport os\n\nclass Repo:\n    def get(self):\n        pass\n\ndef _private():\n    pass\n");
  assert.deepEqual(py.symbols.map((s) => [s.name, s.exported]), [["Repo", true], ["get", false], ["_private", false]]);
  assert.deepEqual(py.imports, ["app.models", "os"]);
  const go = outline("main.go", 'package main\n\nimport (\n\t"fmt"\n\t"example.com/x/store"\n)\n\nfunc Serve() {}\nfunc helper() {}\ntype Server struct {}\n');
  assert.deepEqual(go.symbols.map((s) => [s.name, s.exported]), [["Serve", true], ["helper", false], ["Server", true]]);
  assert.deepEqual(go.imports, ["fmt", "example.com/x/store"]);
});

test("relative imports resolve to files in the map, .js specifiers to .ts sources", () => {
  const paths = new Set(["src/a.ts", "src/lib/index.ts", "app/models.py"]);
  assert.equal(resolveImport("src/b.ts", "./a.js", paths), "src/a.ts");
  assert.equal(resolveImport("src/x/y.ts", "../lib", paths), "src/lib/index.ts");
  assert.equal(resolveImport("app/db.py", "app.models", paths), "app/models.py");
  assert.equal(resolveImport("src/b.ts", "react", paths), null);
});

test("on Loom's own source: search, find a symbol, and a folder view", () => {
  const files = readdirSync("src").filter((f) => f.endsWith(".ts")).map((f) => ({ path: `src/${f}`, text: readFileSync(`src/${f}`, "utf8") }));
  const map = buildMap("abc", files);
  const top = searchMap(map, "mask secrets")[0];
  assert.equal(top.path, "src/mask.ts", JSON.stringify(searchMap(map, "mask secrets").slice(0, 3)));
  assert.ok(top.why.some((w) => w.includes("maskSecrets")));
  const sym = findSymbol(map, "maskSecrets");
  assert.deepEqual(sym.defs.map((d) => d.path), ["src/mask.ts"]);
  assert.ok(sym.usedIn.some((u) => u.path === "src/checks.ts" && u.imports.includes("src/mask.ts")));
  assert.ok(map.files.find((f) => f.path === "src/mask.ts")!.importedBy.includes("src/checks.ts"));
  const root = mapView({ ...map, files: map.files.map((f) => ({ ...f })) }, "");
  assert.deepEqual(root.folders.map((f) => f.path), ["src"]);
  const src = mapView(map, "src");
  assert.ok(src.files.find((f: any) => f.path === "src/codemap.ts").exports.some((e: string) => e.startsWith("searchMap()")));
});
