import type { ProjectCoordinator } from "./coordinator";

export interface Env {
  ARTIFACTS?: Artifacts;
  ARTIFACTS_SHIM_URL?: string;
  LOOM_ADMIN_TOKEN?: string;
  PROJECT: DurableObjectNamespace<ProjectCoordinator>;
  CONTEXT: R2Bucket;
  ASSETS: Fetcher;
}
