// Artifacts event subscriptions: Loom hears about every push to a workspace.
//
// When an agent claims a task, Loom forks main into a workspace repo and
// subscribes a Queue to that repo's `pushed` events. The Worker's queue
// handler hands each push to the project's coordinator, which refreshes the
// task's open change. So a plain `git push` is enough: the change, its
// review and the merge queue follow it without a call to update_change.
//
// Subscriptions are per repository (source `artifacts.repo`), created over the
// REST API because wrangler can't yet name a repo, and deleted with the
// workspace. Without CF_ACCOUNT_ID, CF_EVENTS_TOKEN and
// ARTIFACTS_EVENTS_QUEUE_ID, Loom skips them and agents call update_change.

import type { Env } from "./env";

export interface Push {
  repo: string;
  ref: string | null;
  before: string | null;
  after: string | null;
  commits: number | null;
}

/** A workspace repo is `<project>-t<task>-<hex>`. */
const WORKSPACE = /^([a-z0-9][a-z0-9-]*)-t(\d+)-[0-9a-f]+$/;

export function projectOfWorkspace(repo: string): string | null {
  return repo.match(WORKSPACE)?.[1] ?? null;
}

/**
 * The push in an Artifacts event message, or null for any other event.
 * Delivered messages carry the qualified type `cf.artifacts.repo.pushed`.
 */
export function pushOf(msg: any): Push | null {
  if (!msg || typeof msg !== "object") return null;
  const type = String(msg.type ?? "");
  if (type !== "cf.artifacts.repo.pushed" && type !== "pushed") return null;
  const src = msg.source ?? {};
  const p = msg.payload ?? {};
  const repo = src.repoName ?? src.repo_name ?? p.repoName ?? p.repo ?? null;
  if (typeof repo !== "string") return null;
  const str = (x: unknown) => (typeof x === "string" ? x : null);
  return {
    repo,
    ref: str(p.ref),
    before: str(p.before),
    after: str(p.after ?? p.head),
    commits: Array.isArray(p.commits) ? p.commits.length : typeof p.commits === "number" ? p.commits : null,
  };
}

export function eventsEnabled(env: Env): boolean {
  return !!(env.CF_ACCOUNT_ID && env.CF_EVENTS_TOKEN && env.ARTIFACTS_EVENTS_QUEUE_ID);
}

async function api(env: Env, method: string, path: string, body?: unknown) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/event_subscriptions/subscriptions${path}`, {
    method,
    headers: { authorization: `Bearer ${env.CF_EVENTS_TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json<any>().catch(() => ({}));
  if (!res.ok || data?.success === false) throw new Error(`event subscription ${method}: ${res.status} ${JSON.stringify(data?.errors ?? data)}`);
  return data?.result;
}

/** Subscribe the events queue to a repo's pushes. Returns the subscription id, or null when Loom isn't set up for events. */
export async function subscribePushes(env: Env, namespace: string, repo: string): Promise<string | null> {
  if (!eventsEnabled(env)) return null;
  const r = await api(env, "POST", "", {
    name: `loom-${repo}`.slice(0, 63),
    enabled: true,
    source: { type: "artifacts.repo", namespace, repo_name: repo },
    destination: { type: "queues.queue", queue_id: env.ARTIFACTS_EVENTS_QUEUE_ID },
    events: ["pushed"],
  });
  return r?.id ?? null;
}

export async function unsubscribe(env: Env, id: string): Promise<void> {
  if (!eventsEnabled(env)) return;
  await api(env, "DELETE", `/${id}`);
}
