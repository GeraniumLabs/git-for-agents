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
  /** The GitHub app's name in its URL, for its install link, when the app came from secrets rather than /auth/setup. */
  GITHUB_APP_SLUG?: string;
  /** GitHub logins (comma-separated) who own every project. */
  LOOM_OWNERS?: string;
  /** Comma-separated public projects to show first-time visitors, the first one opening by default. */
  LOOM_SHOWCASE?: string;
  /** GitHub logins allowed to create projects; unset or "*" lets anyone signed in. */
  LOOM_CREATORS?: string;
  /** Projects one person (not an owner of the server) may create. Default 5; 0 means no limit. */
  LOOM_PROJECTS_PER_PERSON?: string;
  /** Agents one project may hold. Default 300; 0 means no limit. */
  LOOM_MAX_AGENTS?: string;
  /** Minutes of checks one project may run a day (UTC). Default 120; 0 means no limit. Past it, the merge queue waits for the next day. */
  LOOM_CHECK_MINUTES_PER_DAY?: string;
  /** Stripe: with both set, people get the free plan and can pay for Loom Pro (src/billing.ts). */
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  /** A Stripe price for Loom Pro; without one, Checkout uses $10 a month. */
  STRIPE_PRICE_ID?: string;
  /** Tests point this at a stand-in. Defaults to https://api.stripe.com. */
  STRIPE_API_URL?: string;
  /** "1" in local development: /auth/dev?login=x signs in without GitHub. */
  LOOM_DEV_LOGIN?: string;
  /** Workers AI, for Clef: the deputy's judge when no TypeSafe or Anthropic key is set. Absent in local development. */
  AI?: Ai;
  /** The AI Gateway that Loom's review agent calls models through. Default "default". */
  LOOM_AI_GATEWAY?: string;
  /** Local development and tests: an Anthropic-compatible stand-in for the review agent (the shim serves one). */
  LOOM_REVIEW_MODEL_URL?: string;
  /** Cloudflare Email Service: emails people when something needs them. Needs LOOM_EMAIL_FROM on a domain onboarded to Email Service. */
  EMAIL?: SendEmail;
  /** The address Loom sends from, e.g. loom@example.com. */
  LOOM_EMAIL_FROM?: string;
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
