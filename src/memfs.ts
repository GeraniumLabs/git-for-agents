// A small in-memory filesystem with the promise API isomorphic-git expects.
// Workers have no disk, so every git operation runs against one of these.

type Node = { kind: "file"; data: Uint8Array; mode: number; mtime: number } | { kind: "dir"; mtime: number } | { kind: "link"; target: string; mtime: number };

function fsError(code: string, path: string): Error {
  const e = new Error(`${code}: ${path}`) as Error & { code: string };
  e.code = code;
  return e;
}

function norm(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return "/" + parts.join("/");
}

function parent(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

class Stats {
  constructor(private node: Node, public size: number) {}
  get mode() {
    return this.node.kind === "file" ? this.node.mode : this.node.kind === "dir" ? 0o40755 : 0o120000;
  }
  get mtimeMs() {
    return this.node.mtime;
  }
  get ctimeMs() {
    return this.node.mtime;
  }
  get mtime() {
    return new Date(this.node.mtime);
  }
  get ctime() {
    return new Date(this.node.mtime);
  }
  uid = 1;
  gid = 1;
  dev = 1;
  ino = 1;
  isFile() {
    return this.node.kind === "file";
  }
  isDirectory() {
    return this.node.kind === "dir";
  }
  isSymbolicLink() {
    return this.node.kind === "link";
  }
}

export class MemoryFS {
  private nodes = new Map<string, Node>([["/", { kind: "dir", mtime: Date.now() }]]);
  promises = {
    readFile: this.readFile.bind(this),
    writeFile: this.writeFile.bind(this),
    unlink: this.unlink.bind(this),
    readdir: this.readdir.bind(this),
    mkdir: this.mkdir.bind(this),
    rmdir: this.rmdir.bind(this),
    stat: this.stat.bind(this),
    lstat: this.lstat.bind(this),
    readlink: this.readlink.bind(this),
    symlink: this.symlink.bind(this),
    chmod: this.chmod.bind(this),
  };

  async readFile(path: string, opts?: { encoding?: string } | string): Promise<any> {
    const node = this.nodes.get(norm(path));
    if (!node) throw fsError("ENOENT", path);
    if (node.kind !== "file") throw fsError("EISDIR", path);
    const enc = typeof opts === "string" ? opts : opts?.encoding;
    return enc === "utf8" || enc === "utf-8" ? new TextDecoder().decode(node.data) : node.data;
  }

  async writeFile(path: string, data: Uint8Array | string, opts?: { mode?: number } | string): Promise<void> {
    const p = norm(path);
    const dir = this.nodes.get(parent(p));
    if (!dir) throw fsError("ENOENT", path);
    if (dir.kind !== "dir") throw fsError("ENOTDIR", path);
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
    const mode = (typeof opts === "object" && opts?.mode) || 0o100644;
    this.nodes.set(p, { kind: "file", data: bytes, mode, mtime: Date.now() });
  }

  async unlink(path: string): Promise<void> {
    const p = norm(path);
    const node = this.nodes.get(p);
    if (!node) throw fsError("ENOENT", path);
    if (node.kind === "dir") throw fsError("EISDIR", path);
    this.nodes.delete(p);
  }

  async readdir(path: string): Promise<string[]> {
    const p = norm(path);
    const node = this.nodes.get(p);
    if (!node) throw fsError("ENOENT", path);
    if (node.kind !== "dir") throw fsError("ENOTDIR", path);
    const prefix = p === "/" ? "/" : p + "/";
    const out: string[] = [];
    for (const key of this.nodes.keys()) {
      if (key !== p && key.startsWith(prefix) && !key.slice(prefix.length).includes("/")) out.push(key.slice(prefix.length));
    }
    return out;
  }

  async mkdir(path: string): Promise<void> {
    const p = norm(path);
    if (this.nodes.has(p)) throw fsError("EEXIST", path);
    const dir = this.nodes.get(parent(p));
    if (!dir) throw fsError("ENOENT", path);
    if (dir.kind !== "dir") throw fsError("ENOTDIR", path);
    this.nodes.set(p, { kind: "dir", mtime: Date.now() });
  }

  async rmdir(path: string): Promise<void> {
    const p = norm(path);
    const node = this.nodes.get(p);
    if (!node) throw fsError("ENOENT", path);
    if (node.kind !== "dir") throw fsError("ENOTDIR", path);
    if ((await this.readdir(p)).length) throw fsError("ENOTEMPTY", path);
    this.nodes.delete(p);
  }

  async lstat(path: string): Promise<Stats> {
    const node = this.nodes.get(norm(path));
    if (!node) throw fsError("ENOENT", path);
    return new Stats(node, node.kind === "file" ? node.data.byteLength : 0);
  }

  async stat(path: string): Promise<Stats> {
    let p = norm(path);
    for (let hops = 0; hops < 8; hops++) {
      const node = this.nodes.get(p);
      if (!node) throw fsError("ENOENT", path);
      if (node.kind !== "link") return new Stats(node, node.kind === "file" ? node.data.byteLength : 0);
      p = norm(node.target.startsWith("/") ? node.target : parent(p) + "/" + node.target);
    }
    throw fsError("ELOOP", path);
  }

  async readlink(path: string): Promise<string> {
    const node = this.nodes.get(norm(path));
    if (!node) throw fsError("ENOENT", path);
    if (node.kind !== "link") throw fsError("EINVAL", path);
    return node.target;
  }

  async symlink(target: string, path: string): Promise<void> {
    this.nodes.set(norm(path), { kind: "link", target, mtime: Date.now() });
  }

  async chmod(path: string, mode: number): Promise<void> {
    const node = this.nodes.get(norm(path));
    if (!node) throw fsError("ENOENT", path);
    if (node.kind === "file") node.mode = mode;
  }
}
