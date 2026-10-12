// Data residency: a project can keep its data in the EU.
//
// It is chosen once, when the project is created, because none of the three
// places Loom keeps a project's data can move it later:
//   - its repositories live in an Artifacts namespace created with jurisdiction "eu",
//   - its coordinator is a Durable Object in the EU jurisdiction,
//   - its change context and patches are in an R2 bucket created in the EU.
// The registry (project names, visibility and where each project lives) stays global.

import type { Env } from "./env";

export type Jurisdiction = "eu";

export const REGIONS: Record<Jurisdiction, string> = { eu: "the European Union" };

/** Whether this server is set up to keep a project's data in the EU. */
export function euAvailable(env: Env): boolean {
  return !!((env.ARTIFACTS_EU || env.ARTIFACTS_SHIM_URL) && env.CONTEXT_EU);
}

export function regions(env: Env): Jurisdiction[] {
  return euAvailable(env) ? ["eu"] : [];
}

/** The jurisdiction a create request asks for: null for none, or an error message. */
export function parseJurisdiction(env: Env, x: unknown): Jurisdiction | null | { error: string; status: number } {
  if (x === undefined || x === null || x === "" || x === "global") return null;
  if (x !== "eu") return { error: 'jurisdiction is "eu" or left out', status: 400 };
  if (!euAvailable(env)) return { error: "this server isn't set up to keep data in the EU", status: 503 };
  return "eu";
}

export function projectNamespace(env: Env, j: Jurisdiction | null) {
  // workerd has no jurisdictions, so local development keeps EU projects with the rest.
  return j && !env.ARTIFACTS_SHIM_URL ? env.PROJECT.jurisdiction(j) : env.PROJECT;
}

export function contextBucket(env: Env, j: Jurisdiction | null): R2Bucket {
  if (!j) return env.CONTEXT;
  if (!env.CONTEXT_EU) throw new Error("this project keeps its data in the EU, but the Worker has no CONTEXT_EU bucket");
  return env.CONTEXT_EU;
}

export function artifactsNamespace(env: Env, j: Jurisdiction | null): string {
  return j ? env.ARTIFACTS_EU_NAMESPACE ?? "loom-eu" : env.ARTIFACTS_NAMESPACE ?? "loom";
}
