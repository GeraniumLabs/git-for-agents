import { test } from "node:test";
import assert from "node:assert/strict";
import { githubGrant, grantCookie } from "../src/auth.ts";

const env = { LOOM_SECRET_KEY: "test-secret" } as any;
const ann = { id: "github:ann", login: "ann", name: "Ann", avatar: "" };
const bo = { id: "github:bo", login: "bo", name: "Bo", avatar: "" };
const req = (cookie?: string) => new Request("https://loom.example/api/projects", { headers: cookie ? { cookie } : {} });

test("a granted GitHub token reaches only the person who granted it, sealed and briefly", async () => {
  const header = await grantCookie(env, req(), ann, "ghu_secret");
  assert.match(header, /^loom_gh=.*; Path=\/; HttpOnly; SameSite=Lax; Max-Age=900; Secure$/);
  assert.ok(!header.includes("ghu_secret"), "the token is sealed, not in the clear");
  const cookie = header.split(";")[0];
  assert.equal(await githubGrant(env, req(cookie), ann), "ghu_secret");
  assert.equal(await githubGrant(env, req(cookie), bo), null, "someone else's session can't use it");
  assert.equal(await githubGrant({ LOOM_SECRET_KEY: "other" } as any, req(cookie), ann), null, "a different server secret can't open it");
  assert.equal(await githubGrant(env, req(), ann), null);
  assert.equal(await githubGrant(env, req("loom_gh=garbage"), ann), null);
});
