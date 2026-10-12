import type { ProjectCoordinator } from "./coordinator";
import type { CheckRunner } from "./checks";

export interface Env {
  ARTIFACTS?: Artifacts;
  ARTIFACTS_SHIM_URL?: string;
  LOOM_ADMIN_TOKEN?: string;
  /** Seals the keys people save in a project's Settings. Falls back to LOOM_ADMIN_TOKEN. */
  LOOM_SECRET_KEY?: string;
  /** A server-wide Claude key for Jev, used when a project has none of its own. */
  ANTHROPIC_API_KEY?: string;
  /** GitHub OAuth app for people signing in. */
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** GitHub logins (comma-separated) who own every project. */
  LOOM_OWNERS?: string;
  /** Comma-separated public projects to show first-time visitors, the first one opening by default. */
  LOOM_SHOWCASE?: string;
  /** GitHub logins allowed to create projects; unset or "*" lets anyone signed in. */
  LOOM_CREATORS?: string;
  /** "1" in local development: /auth/dev?login=x signs in without GitHub. */
  LOOM_DEV_LOGIN?: string;
  TYPESAFE_API_KEY?: string;
  TYPESAFE_URL?: string;
  PROJECT: DurableObjectNamespace<ProjectCoordinator>;
  /** Containers that run each project's checks. Absent in local development, where the shim runs them. */
  CHECKS?: DurableObjectNamespace<CheckRunner>;
  CONTEXT: R2Bucket;
  ASSETS: Fetcher;
}
