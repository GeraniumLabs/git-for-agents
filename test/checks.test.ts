import { test } from "node:test";
import assert from "node:assert/strict";
import { maskSecrets } from "../src/mask";

test("check output never shows a secret: plain, base64 or URL-encoded, longest first", () => {
  const out = maskSecrets("tok=abc/def+1 b64=" + btoa("abc/def+1") + " url=" + encodeURIComponent("abc/def+1") + " short=xy", { TOKEN: "abc/def+1", SHORT: "xy" });
  assert.equal(out, "tok=[secret TOKEN] b64=[secret TOKEN] url=[secret TOKEN] short=xy");
  assert.equal(maskSecrets("pre-abcdef-post", { A: "abcd", B: "abcdef" }), "pre-[secret B]-post");
});
