// Checks: run a project's test command against the code that would land.
//
// On Cloudflare, each run happens in a container started by the CheckRunner
// Durable Object (one per project), so agents' code never runs in the Worker.
// In local development the Artifacts shim runs the command in a temp
// directory instead.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

export interface CheckResult {
  ok: boolean;
  exitCode: number;
  /** The end of stdout and stderr together, which is where test runners put the failures. */
  output: string;
  ms: number;
  /** "container" or "local". */
  runner: string;
  /** The command that ran. */
  command: string;
}

/** How much output to keep: the tail, where failures and summaries are. */
const OUTPUT_TAIL = 8000;
const tail = (s: string) => (s.length > OUTPUT_TAIL ? `…\n${s.slice(-OUTPUT_TAIL)}` : s);

/** Run `command` over `files` and report. */
export async function runCheck(env: Env, project: string, files: Map<string, { bytes: Uint8Array; mode: string }>, command: string, timeoutSec: number): Promise<CheckResult> {
  const archive = tar(files);
  const started = Date.now();
  if (env.CHECKS) {
    const r = await env.CHECKS.getByName(project).run(archive, command, timeoutSec * 1000);
    return { ...r, output: tail(r.output), ms: Date.now() - started, runner: "container", command };
  }
  if (env.ARTIFACTS_SHIM_URL) {
    const res = await fetch(`${env.ARTIFACTS_SHIM_URL}/checks/run`, {
      method: "POST",
      headers: { "x-command": encodeURIComponent(command), "x-timeout": String(timeoutSec) },
      body: archive,
    });
    if (!res.ok) throw new Error(`local check runner: ${res.status} ${await res.text()}`);
    const r = (await res.json()) as { exitCode: number; output: string };
    return { ok: r.exitCode === 0, exitCode: r.exitCode, output: tail(r.output), ms: Date.now() - started, runner: "local", command };
  }
  throw new Error("no check runner: deploy with the CHECKS container binding, or run the Artifacts shim locally");
}

/** One container per project. Runs are serialized by the coordinator's merge queue; each gets a fresh directory. */
export class CheckRunner extends DurableObject<Env> {
  async run(archive: Uint8Array, command: string, timeoutMs: number): Promise<{ ok: boolean; exitCode: number; output: string }> {
    const c = this.ctx.container;
    if (!c) throw new Error("the CHECKS Durable Object has no container configured");
    if (!c.running) {
      // Installing dependencies needs the network; the code runs isolated in this container.
      c.start({ image: c.images.checks, enableInternet: true, instance: "standard-1" });
      await c.setInactivityTimeout(10 * 60_000);
    }
    const dir = `/work/${crypto.randomUUID()}`;
    // The container takes a moment to accept commands after it starts.
    let unpacked: ExecOutput | null = null;
    for (let i = 0; i < 30 && !unpacked; i++) {
      try {
        const p = await c.exec(["sh", "-c", `mkdir -p ${dir} && tar -x -C ${dir}`], { stdin: new Blob([archive]).stream(), stderr: "combined" });
        unpacked = await p.output();
      } catch (e) {
        if (i === 29) throw e;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    if (unpacked!.exitCode !== 0) return { ok: false, exitCode: unpacked!.exitCode, output: `unpacking the code failed:\n${new TextDecoder().decode(unpacked!.stdout)}` };
    const abort = AbortSignal.timeout(timeoutMs);
    try {
      const p = await c.exec(["sh", "-c", command], { cwd: dir, stderr: "combined", signal: abort, env: { CI: "1", HOME: "/root" } });
      const out = await p.output();
      return { ok: out.exitCode === 0, exitCode: out.exitCode, output: new TextDecoder().decode(out.stdout) };
    } catch (e: any) {
      if (abort.aborted) return { ok: false, exitCode: 124, output: `timed out after ${Math.round(timeoutMs / 1000)}s` };
      throw e;
    } finally {
      this.ctx.waitUntil(c.exec(["rm", "-rf", dir]).then((p) => p.exitCode).catch(() => {}));
    }
  }
}

// ── a minimal ustar writer: enough to ship a repository's files ─────────────

const enc = new TextEncoder();

export function tar(files: Map<string, { bytes: Uint8Array; mode: string }>): Uint8Array {
  const blocks: Uint8Array[] = [];
  let size = 0;
  for (const [path, { bytes, mode }] of files) {
    if (mode === "160000") continue; // submodules have no content here
    const symlink = mode === "120000";
    const header = new Uint8Array(512);
    const name = enc.encode(path);
    let prefix: Uint8Array = new Uint8Array(0), short: Uint8Array = name;
    if (name.length > 100) {
      // ustar splits long paths at a slash: up to 155 bytes of prefix, 100 of name.
      const cut = path.lastIndexOf("/", 155);
      if (cut < 0 || enc.encode(path.slice(cut + 1)).length > 100) continue;
      prefix = enc.encode(path.slice(0, cut));
      short = enc.encode(path.slice(cut + 1));
    }
    header.set(short, 0);
    field(header, 100, 8, symlink ? "777" : mode === "100755" ? "755" : "644");
    field(header, 108, 8, "0");
    field(header, 116, 8, "0");
    field(header, 124, 12, (symlink ? 0 : bytes.length).toString(8));
    field(header, 136, 12, "0");
    header.fill(0x20, 148, 156);
    header[156] = symlink ? 0x32 : 0x30;
    if (symlink) header.set(bytes.subarray(0, 100), 157);
    header.set(enc.encode("ustar\u000000"), 257);
    header.set(prefix, 345);
    let sum = 0;
    for (const b of header) sum += b;
    field(header, 148, 7, sum.toString(8));
    blocks.push(header);
    size += 512;
    if (!symlink && bytes.length) {
      const padded = new Uint8Array(Math.ceil(bytes.length / 512) * 512);
      padded.set(bytes);
      blocks.push(padded);
      size += padded.length;
    }
  }
  const out = new Uint8Array(size + 1024);
  let at = 0;
  for (const b of blocks) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

function field(header: Uint8Array, at: number, len: number, octal: string) {
  header.set(enc.encode(octal.padStart(len - 1, "0")), at);
}
