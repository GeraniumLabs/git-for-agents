// Plans, and paying for one with Stripe. Anyone signed in gets the free plan;
// Loom Pro lifts its limits. A plan belongs to a person (their GitHub login),
// and a project takes the plan of the person who created it. Without Stripe
// configured there are no plans: the LOOM_* limits apply to everyone.
//
// Stripe is called over its REST API (form-encoded), so the Worker needs no
// SDK. Its webhooks are verified with the endpoint's signing secret.

import type { Env } from "./env";

export type PlanName = "free" | "pro";

/**
 * Loom's mark on its Checkout sessions and subscriptions. A Stripe account
 * can sell other things too, and its webhooks then carry their events as
 * well; Loom acts only on events that carry this.
 */
export const APP = "loom";
/** A project's plan: its creator's, or "unlimited" for the server's owners and the admin. */
export type ProjectPlan = PlanName | "unlimited";

export interface Limits {
  /** Projects one person may own. */
  projects: number;
  /** Agents one project may hold. */
  agents: number;
  /** Minutes of checks one project may run a day (UTC). */
  checkMinutes: number;
}

export const PLANS: Record<PlanName, Limits & { name: string; price: string }> = {
  free: { name: "Free", price: "$0", projects: 1, agents: 25, checkMinutes: 30 },
  pro: { name: "Loom Pro", price: "$10 a month", projects: 10, agents: 300, checkMinutes: 300 },
};

/** The limits when the server takes no payments: LOOM_* settings, 0 meaning no limit. */
export function serverLimits(env: Env): Limits {
  const n = (v: string | undefined, d: number) => (v === undefined || v === "" ? d : Number(v));
  return { projects: n(env.LOOM_PROJECTS_PER_PERSON, 5), agents: n(env.LOOM_MAX_AGENTS, 300), checkMinutes: n(env.LOOM_CHECK_MINUTES_PER_DAY, 120) };
}

/** A project's limits: from its plan when the server takes payments, else the server's. Projects made before plans keep the server's. */
export function projectLimits(env: Env, plan: string | null): Limits {
  if (!billingOn(env) || !plan) return serverLimits(env);
  if (plan === "unlimited") return { projects: 0, agents: 0, checkMinutes: 0 };
  return PLANS[plan as PlanName] ?? PLANS.free;
}

export const billingOn = (env: Env) => !!(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET);

/** A person's plan as the registry keeps it. */
export interface PlanRow {
  login: string;
  plan: PlanName;
  status: string | null;
  customer: string | null;
  subscription: string | null;
  renews: number | null;
}

/** Subscription statuses that keep Pro. past_due keeps it while Stripe retries the card. */
export const PAID = new Set(["active", "trialing", "past_due"]);

/** Form-encode nested params the way Stripe expects: a[b][0]=c. */
export function form(params: Record<string, unknown>, prefix = ""): string {
  const out: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") out.push(form(v as Record<string, unknown>, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out.filter(Boolean).join("&");
}

export async function stripe<T = any>(env: Env, method: "GET" | "POST", path: string, params: Record<string, unknown> = {}): Promise<T> {
  const base = env.STRIPE_API_URL ?? "https://api.stripe.com";
  const body = form(params);
  const res = await fetch(`${base}/v1/${path}${method === "GET" && body ? `?${body}` : ""}`, {
    method,
    headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "content-type": "application/x-www-form-urlencoded", "stripe-version": "2024-06-20" },
    body: method === "POST" ? body : undefined,
  });
  const data = await res.json<any>().catch(() => ({}));
  if (!res.ok) throw new Error(`Stripe: ${data?.error?.message ?? `HTTP ${res.status}`}`);
  return data as T;
}

/** A Checkout page for Loom Pro. The login rides along so the webhook knows whose plan it is. */
export async function checkoutSession(env: Env, login: string, customer: string | null, origin: string, back: string): Promise<string> {
  const price = env.STRIPE_PRICE_ID
    ? { price: env.STRIPE_PRICE_ID, quantity: 1 }
    : { price_data: { currency: "usd", unit_amount: 1000, recurring: { interval: "month" }, product_data: { name: "Loom Pro" } }, quantity: 1 };
  const s = await stripe<{ url: string }>(env, "POST", "checkout/sessions", {
    mode: "subscription",
    line_items: { 0: price },
    client_reference_id: login,
    ...(customer ? { customer } : {}),
    metadata: { app: APP, login },
    subscription_data: { metadata: { app: APP, login } },
    allow_promotion_codes: "true",
    success_url: `${origin}${back}${back.includes("?") ? "&" : "?"}billing=done`,
    cancel_url: `${origin}${back}`,
  });
  return s.url;
}

/** Stripe's own page for changing the card, seeing invoices or cancelling. */
export async function portalSession(env: Env, customer: string, returnUrl: string): Promise<string> {
  return (await stripe<{ url: string }>(env, "POST", "billing_portal/sessions", { customer, return_url: returnUrl, configuration: env.STRIPE_PORTAL_CONFIGURATION })).url;
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

export async function signStripe(secret: string, t: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`)));
}

/** Check a Stripe-Signature header (t=…,v1=…) against the body, within five minutes. */
export async function verifyStripe(secret: string, header: string | null, body: string, now = Date.now()): Promise<boolean> {
  if (!header) return false;
  const parts = header.split(",").map((p) => p.split("="));
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || !sigs.length || Math.abs(now / 1000 - t) > 300) return false;
  const want = await signStripe(secret, t, body);
  // Constant-time compare.
  return sigs.some((s) => s.length === want.length && [...s].reduce((d, c, i) => d | (c.charCodeAt(0) ^ want.charCodeAt(i)), 0) === 0);
}

/** When the subscription renews. Newer API versions keep the period on each item, not the subscription. */
function periodEnd(o: any): number | null {
  const t = o.current_period_end ?? o.items?.data?.[0]?.current_period_end;
  return typeof t === "number" ? t * 1000 : null;
}

/**
 * What a webhook event means for a person's plan, or null for events Loom
 * ignores. Checkout completing makes them Pro; a subscription changing or
 * ending sets the plan from its status.
 */
export function planUpdate(event: any): (PlanRow & { at: number }) | null {
  const o = event?.data?.object ?? {};
  if (event?.type === "checkout.session.completed" && o.mode === "subscription") {
    if (o.metadata?.app !== APP) return null;
    const login = String(o.metadata?.login ?? o.client_reference_id ?? "").toLowerCase();
    if (!login) return null;
    return { login, plan: "pro", status: "active", customer: o.customer ?? null, subscription: o.subscription ?? null, renews: null, at: Number(event.created ?? 0) };
  }
  if (["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"].includes(event?.type)) {
    if (o.metadata?.app !== APP) return null;
    const login = String(o.metadata?.login ?? "").toLowerCase();
    if (!login) return null;
    const status = event.type === "customer.subscription.deleted" ? "canceled" : String(o.status ?? "");
    return { login, plan: PAID.has(status) ? "pro" : "free", status, customer: o.customer ?? null, subscription: o.id ?? null, renews: periodEnd(o), at: Number(event.created ?? 0) };
  }
  return null;
}
