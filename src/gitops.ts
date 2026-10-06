// Git operations that run inside the Worker, on an in-memory filesystem.
// Loom does its own three-way merge (tree walk + diff3 per file) so that
// conflicts come back as structured data an agent can act on, instead of
// conflict markers in a working tree.

import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { diff3Merge, diffIndices } from "node-diff3";
import { MemoryFS } from "./memfs";
import { tokenSecret } from "./store";

const DIR = "/repo";
const enc = new TextEncoder();
const dec = new TextDecoder();

export interface Remote {
  url: string;
  token: string;
}

export interface Identity {
  name: string;
  email: string;
}

type Entry = { oid: string; mode: string };
type FlatTree = Map<string, Entry>;

export interface ConflictHunk {
  /** 1-based line in the merge base where the hunk starts. */
  baseLine: number;
  base: string[];
  ours: string[];
  theirs: string[];
}

export interface FileConflict {
  path: string;
  kind: "content" | "modify-delete" | "add-add" | "binary";
  hunks: ConflictHunk[];
  base: string | null;
  ours: string | null;
  theirs: string | null;
}

export interface FileChange {
  path: string;
  status: "added" | "modified" | "deleted";
}

function auth(token: string) {
  return () => ({ username: "x", password: tokenSecret(token) });
}

export class Workspace {
  fs = new MemoryFS();
  private constructor() {}

  /** Clone the default branch of `origin` without a checkout. */
  static async open(origin: Remote, branch = "main"): Promise<Workspace> {
    const w = new Workspace();
    await w.fs.mkdir(DIR);
    await git.init({ fs: w.fs, dir: DIR, defaultBranch: branch });
    await git.addRemote({ fs: w.fs, dir: DIR, remote: "origin", url: origin.url });
    try {
      await git.fetch({ fs: w.fs, http, dir: DIR, remote: "origin", ref: branch, singleBranch: true, tags: false, onAuth: auth(origin.token) });
      const head = await git.resolveRef({ fs: w.fs, dir: DIR, ref: `refs/remotes/origin/${branch}` });
      await git.writeRef({ fs: w.fs, dir: DIR, ref: `refs/heads/${branch}`, value: head, force: true });
    } catch (e: any) {
      // An empty repository has no branch to fetch yet.
      if (!/Could not find|NotFoundError|empty/i.test(String(e?.message ?? e))) throw e;
    }
    return w;
  }

  async head(branch = "main"): Promise<string | null> {
    try {
      return await git.resolveRef({ fs: this.fs, dir: DIR, ref: `refs/heads/${branch}` });
    } catch {
      return null;
    }
  }

  /** Fetch `branch` from another remote; returns the fetched commit. */
  async fetchFrom(name: string, remote: Remote, branch = "main"): Promise<string> {
    await git.addRemote({ fs: this.fs, dir: DIR, remote: name, url: remote.url, force: true });
    await git.fetch({ fs: this.fs, http, dir: DIR, remote: name, ref: branch, singleBranch: true, tags: false, onAuth: auth(remote.token) });
    return git.resolveRef({ fs: this.fs, dir: DIR, ref: `refs/remotes/${name}/${branch}` });
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    if (ancestor === descendant) return true;
    return git.isDescendent({ fs: this.fs, dir: DIR, oid: descendant, ancestor, depth: -1 });
  }

  async mergeBase(a: string, b: string): Promise<string | null> {
    const bases = await git.findMergeBase({ fs: this.fs, dir: DIR, oids: [a, b] });
    return bases[0] ?? null;
  }

  async flatten(commit: string | null): Promise<FlatTree> {
    const out: FlatTree = new Map();
    if (!commit) return out;
    const { commit: c } = await git.readCommit({ fs: this.fs, dir: DIR, oid: commit });
    const walk = async (treeOid: string, prefix: string) => {
      const { tree } = await git.readTree({ fs: this.fs, dir: DIR, oid: treeOid });
      for (const e of tree) {
        const p = prefix + e.path;
        if (e.type === "tree") await walk(e.oid, p + "/");
        else out.set(p, { oid: e.oid, mode: e.mode });
      }
    };
    await walk(c.tree, "");
    return out;
  }

  async readText(oid: string): Promise<string> {
    const { blob } = await git.readBlob({ fs: this.fs, dir: DIR, oid });
    return dec.decode(blob);
  }

  async readBytes(oid: string): Promise<Uint8Array> {
    return (await git.readBlob({ fs: this.fs, dir: DIR, oid })).blob;
  }

  async writeText(text: string): Promise<string> {
    return git.writeBlob({ fs: this.fs, dir: DIR, blob: enc.encode(text) });
  }

  /** Build nested git trees from a flat path map; returns the root tree oid. */
  async writeFlat(flat: FlatTree): Promise<string> {
    type Dir = { files: Map<string, Entry>; dirs: Map<string, Dir> };
    const root: Dir = { files: new Map(), dirs: new Map() };
    for (const [path, entry] of flat) {
      const parts = path.split("/");
      let d = root;
      for (const part of parts.slice(0, -1)) {
        if (!d.dirs.has(part)) d.dirs.set(part, { files: new Map(), dirs: new Map() });
        d = d.dirs.get(part)!;
      }
      d.files.set(parts[parts.length - 1], entry);
    }
    const write = async (d: Dir): Promise<string> => {
      const tree: { mode: string; path: string; oid: string; type: "blob" | "tree" | "commit" }[] = [];
      for (const [name, sub] of d.dirs) tree.push({ mode: "040000", path: name, oid: await write(sub), type: "tree" });
      for (const [name, e] of d.files) tree.push({ mode: e.mode, path: name, oid: e.oid, type: e.mode === "160000" ? "commit" : "blob" });
      return git.writeTree({ fs: this.fs, dir: DIR, tree });
    };
    return write(root);
  }

  async commit(tree: string, parents: string[], message: string, author: Identity): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const who = { name: author.name, email: author.email, timestamp: now, timezoneOffset: 0 };
    return git.writeCommit({ fs: this.fs, dir: DIR, commit: { tree, parent: parents, author: who, committer: who, message } });
  }

  /** Push `commit` to `branch` on a remote. Rejected unless it fast-forwards. */
  async push(remote: Remote, commit: string, branch = "main"): Promise<void> {
    await git.writeRef({ fs: this.fs, dir: DIR, ref: `refs/heads/loom-push`, value: commit, force: true });
    const res = await git.push({
      fs: this.fs,
      http,
      dir: DIR,
      url: remote.url,
      ref: "loom-push",
      remoteRef: branch,
      onAuth: auth(remote.token),
    });
    if (!res.ok) throw new Error(`push rejected: ${JSON.stringify(res.refs)}`);
  }

  async changes(from: string | null, to: string): Promise<FileChange[]> {
    return diffFlat(await this.flatten(from), await this.flatten(to));
  }

  /**
   * Three-way merge of two commits. Returns the merged tree, or the list of
   * conflicts when the two sides touched the same lines.
   */
  async merge(ours: string, theirs: string, resolutions: Record<string, string | null> = {}) {
    const base = await this.mergeBase(ours, theirs);
    const [B, O, T] = await Promise.all([this.flatten(base), this.flatten(ours), this.flatten(theirs)]);
    const merged: FlatTree = new Map();
    const conflicts: FileConflict[] = [];
    const paths = new Set([...B.keys(), ...O.keys(), ...T.keys()]);

    for (const path of paths) {
      const b = B.get(path), o = O.get(path), t = T.get(path);
      const same = (x?: Entry, y?: Entry) => x?.oid === y?.oid && x?.mode === y?.mode;
      if (path in resolutions) {
        const text = resolutions[path];
        if (text !== null) merged.set(path, { oid: await this.writeText(text), mode: (o ?? t ?? b)!.mode });
        continue;
      }
      if (same(o, t)) { if (o) merged.set(path, o); continue; }
      if (same(b, o)) { if (t) merged.set(path, t); continue; }
      if (same(b, t)) { if (o) merged.set(path, o); continue; }

      // Both sides changed this path, differently.
      const text = async (e?: Entry) => (e ? await this.readText(e.oid) : null);
      const [bt, ot, tt] = await Promise.all([text(b), text(o), text(t)]);
      if (!o || !t) {
        conflicts.push({ path, kind: "modify-delete", hunks: [], base: bt, ours: ot, theirs: tt });
        continue;
      }
      if ([bt, ot, tt].some((s) => s !== null && s.includes("\u0000"))) {
        conflicts.push({ path, kind: "binary", hunks: [], base: null, ours: null, theirs: null });
        continue;
      }
      const result = mergeText(bt ?? "", ot!, tt!);
      if (result.hunks.length) {
        conflicts.push({ path, kind: b ? "content" : "add-add", hunks: result.hunks, base: bt, ours: ot, theirs: tt });
      } else {
        merged.set(path, { oid: await this.writeText(result.text), mode: o.mode });
      }
    }
    if (conflicts.length) return { base, conflicts, tree: null };
    return { base, conflicts, tree: await this.writeFlat(merged) };
  }

  /** Apply file writes (null deletes) on top of `parent` and commit. */
  async commitFiles(parent: string | null, files: Record<string, string | null>, message: string, author: Identity) {
    const flat = await this.flatten(parent);
    for (const [path, content] of Object.entries(files)) {
      const p = path.replace(/^\/+/, "");
      if (content === null) flat.delete(p);
      else flat.set(p, { oid: await this.writeText(content), mode: flat.get(p)?.mode ?? "100644" });
    }
    const tree = await this.writeFlat(flat);
    return this.commit(tree, parent ? [parent] : [], message, author);
  }
}

export function diffFlat(a: FlatTree, b: FlatTree): FileChange[] {
  const out: FileChange[] = [];
  for (const [p, e] of b) {
    const prev = a.get(p);
    if (!prev) out.push({ path: p, status: "added" });
    else if (prev.oid !== e.oid || prev.mode !== e.mode) out.push({ path: p, status: "modified" });
  }
  for (const p of a.keys()) if (!b.has(p)) out.push({ path: p, status: "deleted" });
  return out.sort((x, y) => x.path.localeCompare(y.path));
}

/** Line-based diff3. Returns merged text, or the conflicting hunks. */
export function mergeText(base: string, ours: string, theirs: string): { text: string; hunks: ConflictHunk[] } {
  const split = (s: string) => (s === "" ? [] : s.split(/(?<=\n)/));
  const regions = diff3Merge(split(ours), split(base), split(theirs), { excludeFalseConflicts: true });
  const hunks: ConflictHunk[] = [];
  let text = "";
  for (const r of regions) {
    if (r.ok) text += r.ok.join("");
    else if (r.conflict) {
      hunks.push({ baseLine: r.conflict.oIndex + 1, base: r.conflict.o, ours: r.conflict.a, theirs: r.conflict.b });
    }
  }
  return { text, hunks };
}

/** A unified diff for one file, with three lines of context. */
export function unifiedDiff(path: string, before: string | null, after: string | null): string {
  const split = (s: string | null) => (s ? s.replace(/\n$/, "").split("\n") : []);
  const a = split(before), b = split(after);
  const header = `--- ${before === null ? "/dev/null" : "a/" + path}\n+++ ${after === null ? "/dev/null" : "b/" + path}\n`;
  const chunks = diffIndices(a, b);
  if (!chunks.length) return "";
  const CTX = 3;
  let out = header;
  let i = 0;
  while (i < chunks.length) {
    // Group chunks whose context windows touch.
    let j = i;
    while (j + 1 < chunks.length && chunks[j + 1].buffer1[0] - (chunks[j].buffer1[0] + chunks[j].buffer1[1]) <= CTX * 2) j++;
    const aStart = Math.max(0, chunks[i].buffer1[0] - CTX);
    const aEnd = Math.min(a.length, chunks[j].buffer1[0] + chunks[j].buffer1[1] + CTX);
    const bStart = Math.max(0, chunks[i].buffer2[0] - CTX);
    let lines: string[] = [];
    let ai = aStart;
    let bLen = 0;
    for (let k = i; k <= j; k++) {
      const c = chunks[k];
      for (; ai < c.buffer1[0]; ai++, bLen++) lines.push(" " + a[ai]);
      for (const l of c.buffer1Content) lines.push("-" + l);
      for (const l of c.buffer2Content) lines.push("+" + l);
      bLen += c.buffer2[1];
      ai = c.buffer1[0] + c.buffer1[1];
    }
    for (; ai < aEnd; ai++, bLen++) lines.push(" " + a[ai]);
    const aLen = aEnd - aStart;
    out += `@@ -${aLen ? aStart + 1 : aStart},${aLen} +${bLen ? bStart + 1 : bStart},${bLen} @@\n` + lines.join("\n") + "\n";
    i = j + 1;
  }
  return out;
}
