import { test } from "node:test";
import assert from "node:assert/strict";
import { PLANS, form, planUpdate, projectLimits, signStripe, verifyStripe } from "../src/billing";

test("Stripe params are form-encoded with nested keys", () => {
  assert.equal(form({ mode: "subscription", line_items: { 0: { price: "p_1", quantity: 1 } }, skip: undefined }),
    "mode=subscription&line_items%5B0%5D%5Bprice%5D=p_1&line_items%5B0%5D%5Bquantity%5D=1");
});

test("a webhook is accepted only with a fresh, matching signature", async () => {
  const body = '{"type":"x"}', t = Math.floor(Date.now() / 1000);
  const v1 = await signStripe("whsec_a", t, body);
  assert.equal(await verifyStripe("whsec_a", `t=${t},v1=${v1}`, body), true);
  assert.equal(await verifyStripe("whsec_b", `t=${t},v1=${v1}`, body), false);
  assert.equal(await verifyStripe("whsec_a", `t=${t},v1=${v1}`, body + " "), false);
  assert.equal(await verifyStripe("whsec_a", `t=${t - 600},v1=${await signStripe("whsec_a", t - 600, body)}`, body), false);
  assert.equal(await verifyStripe("whsec_a", null, body), false);
});

test("checkout makes a person Pro; a subscription's status keeps or ends it", () => {
  assert.deepEqual(planUpdate({ type: "checkout.session.completed", created: 5, data: { object: { mode: "subscription", client_reference_id: "Mia", metadata: { app: "loom" }, customer: "cus_1", subscription: "sub_1" } } }),
    { login: "mia", plan: "pro", status: "active", customer: "cus_1", subscription: "sub_1", renews: null, at: 5 });
  const sub = (type: string, status: string) => planUpdate({ type, created: 6, data: { object: { id: "sub_1", status, customer: "cus_1", metadata: { app: "loom", login: "mia" }, current_period_end: 100 } } });
  assert.equal(sub("customer.subscription.updated", "past_due")!.plan, "pro");
  assert.equal(sub("customer.subscription.updated", "unpaid")!.plan, "free");
  assert.equal(sub("customer.subscription.deleted", "active")!.plan, "free");
  assert.equal(sub("customer.subscription.updated", "active")!.renews, 100_000);
  assert.equal(planUpdate({ type: "invoice.paid", data: { object: {} } }), null);
  // Other products on the same Stripe account send their events too.
  assert.equal(planUpdate({ type: "checkout.session.completed", data: { object: { mode: "subscription", client_reference_id: "uid123", customer: "cus_9" } } }), null);
  assert.equal(planUpdate({ type: "customer.subscription.updated", data: { object: { id: "sub_9", status: "active", metadata: { login: "mia", app: "lifesheet" } } } }), null);
});

test("a project's limits come from its plan only when the server takes payments", () => {
  const paid = { STRIPE_SECRET_KEY: "sk", STRIPE_WEBHOOK_SECRET: "wh" } as any;
  assert.deepEqual(projectLimits(paid, "free"), PLANS.free);
  assert.equal(projectLimits(paid, "pro").checkMinutes, 300);
  assert.equal(projectLimits(paid, "unlimited").agents, 0);
  assert.equal(projectLimits(paid, null).agents, 300, "projects from before plans keep the server's limits");
  assert.equal(projectLimits({ LOOM_MAX_AGENTS: "7" } as any, "free").agents, 7, "no Stripe, no plans");
});

test("a real subscription event from the Stripe sandbox (API 2026-08-26) reads as Pro, with its renewal date from the item", async () => {
  const { readFileSync } = await import("node:fs");
  const event = JSON.parse(readFileSync(new URL("./fixtures/stripe-subscription-created.json", import.meta.url), "utf8"));
  assert.deepEqual(planUpdate(event), { login: "sandboxtester", plan: "pro", status: "active", customer: "cus_VSS50pRCKHimXQ", subscription: "sub_1URXBsCHuPUumNxypXtj3wOr", renews: 1794920304000, at: 1792241906 });
  const canceled = { ...event, type: "customer.subscription.deleted", created: 1792241928, data: { object: { ...event.data.object, status: "canceled" } } };
  assert.equal(planUpdate(canceled)!.plan, "free");
});
