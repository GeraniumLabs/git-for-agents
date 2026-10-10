import type { ProjectCoordinator } from "./coordinator";

export interface Env {
  ARTIFACTS?: Artifacts;
  ARTIFACTS_SHIM_URL?: string;
  LOOM_ADMIN_TOKEN?: string;
  /** Seals the keys people save in a project's Settings. Falls back to LOOM_ADMIN_TOKEN. */
  LOOM_SECRET_KEY?: string;
  /** A server-wide Claude key for Jev, used when a project has none of its own. */
  ANTHROPIC_API_KEY?: string;
  TYPESAFE_API_KEY?: string;
  TYPESAFE_URL?: string;
  PROJECT: DurableObjectNamespace<ProjectCoordinator>;
  CONTEXT: R2Bucket;
  ASSETS: Fetcher;
}
