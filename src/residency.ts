// Where a project's data lives, and where its coordinator runs.
//
// Residency is chosen once, when the project is created, because none of the
// three places Mergery keeps a project's data can move it later:
//   - its repositories live in an Artifacts namespace created in that jurisdiction,
//   - its coordinator is a Durable Object in that jurisdiction,
//   - its change context and patches are in an R2 bucket created there.
// Cloudflare has two jurisdictions: "eu" (the European Union) and "fedramp"
// (US, FedRAMP-authorized data centers). A server offers one only when it has
// that jurisdiction's Artifacts namespace and R2 bucket.
//
// Placement is a hint, not a guarantee: it asks Cloudflare to start the
// coordinator, which does the project's git work, near where the agents run
// (say, Asia-Pacific when they run in Singapore), instead of near whoever
// made the project. It also can't move later.
//
// The registry (project names, visibility and where each project lives) stays global.

import type { Env } from "./env";

export type Jurisdiction = "eu" | "fedramp";

export const REGIONS: Record<Jurisdiction, string> = { eu: "the European Union", fedramp: "the US, in FedRAMP data centers" };

/** Durable Object location hints, as Cloudflare names them. */
export const PLACEMENTS = {
  wnam: "Western North America",
  enam: "Eastern North America",
  sam: "South America",
  weur: "Western Europe",
  eeur: "Eastern Europe",
  apac: "Asia-Pacific",
  oc: "Oceania",
  afr: "Africa",
  me: "the Middle East",
} as const;
export type Placement = keyof typeof PLACEMENTS;

function artifactsFor(env: Env, j: Jurisdiction): Artifacts | undefined {
  return j === "eu" ? env.ARTIFACTS_EU : env.ARTIFACTS_FEDRAMP;
}

function bucketFor(env: Env, j: Jurisdiction): R2Bucket | undefined {
  return j === "eu" ? env.CONTEXT_EU : env.CONTEXT_FEDRAMP;
}

/** Whether this server is set up to keep a project's data in a jurisdiction. */
export function available(env: Env, j: Jurisdiction): boolean {
  return !!((artifactsFor(env, j) || env.ARTIFACTS_SHIM_URL) && bucketFor(env, j));
}

/** @deprecated use available(env, "eu") */
export function euAvailable(env: Env): boolean {
  return available(env, "eu");
}

export function regions(env: Env): Jurisdiction[] {
  return (Object.keys(REGIONS) as Jurisdiction[]).filter((j) => available(env, j));
}

/** The jurisdiction a create request asks for: null for none, or an error message. */
export function parseJurisdiction(env: Env, x: unknown): Jurisdiction | null | { error: string; status: number } {
  if (x === undefined || x === null || x === "" || x === "global") return null;
  if (x !== "eu" && x !== "fedramp") return { error: 'jurisdiction is "eu", "fedramp" or left out', status: 400 };
  if (!available(env, x)) return { error: `this server isn't set up to keep data in ${REGIONS[x]}`, status: 503 };
  return x;
}

/** The placement a create request asks for: null for automatic, or an error message. */
export function parsePlacement(x: unknown): Placement | null | { error: string; status: number } {
  if (x === undefined || x === null || x === "" || x === "auto") return null;
  if (typeof x === "string" && x in PLACEMENTS) return x as Placement;
  return { error: `placement is one of ${Object.keys(PLACEMENTS).join(", ")}, or left out`, status: 400 };
}

export function projectNamespace(env: Env, j: Jurisdiction | null) {
  // workerd has no jurisdictions, so local development keeps these projects with the rest.
  return j && !env.ARTIFACTS_SHIM_URL ? env.PROJECT.jurisdiction(j) : env.PROJECT;
}

export function contextBucket(env: Env, j: Jurisdiction | null): R2Bucket {
  if (!j) return env.CONTEXT;
  const b = bucketFor(env, j);
  if (!b) throw new Error(`this project keeps its data in ${REGIONS[j]}, but the Worker has no CONTEXT_${j.toUpperCase()} bucket`);
  return b;
}

export function artifactsNamespace(env: Env, j: Jurisdiction | null): string {
  if (j === "eu") return env.ARTIFACTS_EU_NAMESPACE ?? "loom-eu";
  if (j === "fedramp") return env.ARTIFACTS_FEDRAMP_NAMESPACE ?? "loom-fedramp";
  return env.ARTIFACTS_NAMESPACE ?? "loom";
}

export function isJurisdiction(x: unknown): x is Jurisdiction {
  return x === "eu" || x === "fedramp";
}
