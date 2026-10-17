import type { ProjectCoordinator } from "./coordinator";
import type { CheckRunner } from "./checks";

export interface Env {
  ARTIFACTS?: Artifacts;
  ARTIFACTS_SHIM_URL?: string;
  LOOM_ADMIN_TOKEN?: string;
  /** Seals the keys people save in a project's Settings. Falls back to LOOM_ADMIN_TOKEN. */
  LOOM_SECRET_KEY?: string;
  /** A server-wide Claude key for the deputy, used when a project has none of its own. */
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
  /** Workers AI, for Clef: the deputy's judge when no TypeSafe or Anthropic key is set. Absent in local development. */
  AI?: Ai;
  TYPESAFE_API_KEY?: string;
  /** Where issues are imported from; tests point it at a stand-in. Defaults to https://api.github.com. */
  GITHUB_API_URL?: string;
  TYPESAFE_URL?: string;
  PROJECT: DurableObjectNamespace<ProjectCoordinator>;
  /** Containers that run each project's checks. Absent in local development, where the shim runs them. */
  CHECKS?: DurableObjectNamespace<CheckRunner>;
  CONTEXT: R2Bucket;
  /** EU residency: an Artifacts namespace created with jurisdiction "eu", and an R2 bucket created in the EU. Both or neither. */
  ARTIFACTS_EU?: Artifacts;
  CONTEXT_EU?: R2Bucket;
  /** Artifacts namespace names, as in wrangler.toml; push subscriptions name them. Default "loom" and "loom-eu". */
  ARTIFACTS_NAMESPACE?: string;
  ARTIFACTS_EU_NAMESPACE?: string;
  /** Artifacts push events: the queue they arrive on, and an API token (Queues Write) to subscribe each workspace. */
  CF_ACCOUNT_ID?: string;
  CF_EVENTS_TOKEN?: string;
  ARTIFACTS_EVENTS_QUEUE_ID?: string;
  ASSETS: Fetcher;
}
