// Keys people bring for a project (Jev, Claude), encrypted at rest.
// AES-GCM with a per-project key derived (HKDF) from the LOOM_SECRET_KEY
// Worker secret, or from LOOM_ADMIN_TOKEN when that isn't set. Each row
// records which one sealed it, so adding LOOM_SECRET_KEY later doesn't
// strand keys saved before it. Plaintext never leaves the Durable Object.

import type { Env } from "./env";

export const KEY_KINDS = {
  jev: { label: "Jev (TypeSafe)", hint: "TypeSafe System One API key", uses: "Jev answers questions, settles disputes and approves protected changes with TypeSafe's judge." },
  anthropic: { label: "Claude (Anthropic)", hint: "Anthropic API key, sk-ant-…", uses: "Jev judges with Claude when there is no TypeSafe key." },
} as const;
export type KeyKind = keyof typeof KEY_KINDS;
export const isKeyKind = (k: string): k is KeyKind => k in KEY_KINDS;

type Sealer = "secret" | "admin";

function material(env: Env, by: Sealer): string | undefined {
  return by === "secret" ? env.LOOM_SECRET_KEY : env.LOOM_ADMIN_TOKEN;
}

/** Which Worker secret seals new keys, or null when neither is set. */
export function sealer(env: Env): Sealer | null {
  return env.LOOM_SECRET_KEY ? "secret" : env.LOOM_ADMIN_TOKEN ? "admin" : null;
}

async function aesKey(secret: string, project: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("loom-project-keys-v1"), info: new TextEncoder().encode(project) },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
}

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function seal(env: Env, project: string, plaintext: string): Promise<{ ct: string; iv: string; by: Sealer }> {
  const by = sealer(env);
  if (!by) throw new Error("set LOOM_SECRET_KEY on the Worker before saving keys");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(material(env, by)!, project), new TextEncoder().encode(plaintext));
  return { ct: b64(new Uint8Array(ct)), iv: b64(iv), by };
}

/** The plaintext, or null when the secret that sealed it is gone or changed. */
export async function unseal(env: Env, project: string, row: { ct: string; iv: string; sealed_by: string }): Promise<string | null> {
  const secret = material(env, row.sealed_by as Sealer);
  if (!secret) return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(row.iv) }, await aesKey(secret, project), unb64(row.ct));
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}
