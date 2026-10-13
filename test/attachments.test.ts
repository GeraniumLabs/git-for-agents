import { test } from "node:test";
import assert from "node:assert/strict";
import { AttachmentError, MAX_ATTACHMENT_BYTES, bytesOf, checkSize, cleanName, kindOf, serveHeaders, typeOf } from "../src/attachments.ts";

test("names lose their directories and control characters", () => {
  assert.equal(cleanName("../../etc/passwd"), "passwd");
  assert.equal(cleanName("C:\\shots\\home\u0007.png"), "home.png");
  assert.equal(cleanName("x".repeat(200) + ".png").length, 120);
  assert.ok(cleanName("x".repeat(200) + ".png").endsWith(".png"));
  assert.throws(() => cleanName(""), AttachmentError);
  assert.throws(() => cleanName(".."), AttachmentError);
  assert.throws(() => cleanName(undefined), /name is required/);
});

test("the type comes from what was sent, else the extension, else a binary", () => {
  assert.equal(typeOf("a.png"), "image/png");
  assert.equal(typeOf("a.bin", "image/jpg"), "image/jpeg");
  assert.equal(typeOf("build.tar.gz"), "application/gzip");
  assert.equal(typeOf("loom-linux-x64"), "application/octet-stream");
  assert.equal(typeOf("a.png", "application/octet-stream"), "image/png");
  assert.throws(() => typeOf("a.js", "text/javascript"), (e: any) => e.status === 415);
});

test("only types a browser shows without running code preview inline", () => {
  assert.equal(kindOf("image/png"), "image");
  assert.equal(kindOf("image/svg+xml"), "file");
  assert.equal(kindOf("text/html"), "file");
  assert.equal(kindOf("application/json"), "text");
  const svg = serveHeaders({ name: "x.svg", content_type: "image/svg+xml", size: 3 });
  assert.match(svg.get("content-disposition")!, /^attachment/);
  assert.equal(svg.get("content-type"), "application/octet-stream");
  const html = serveHeaders({ name: "r.html", content_type: "text/html", size: 3 });
  assert.match(html.get("content-disposition")!, /^attachment/);
  assert.match(html.get("cache-control")!, /^private/);
  assert.match(html.get("content-security-policy")!, /sandbox/);
  const log = serveHeaders({ name: "test.log", content_type: "text/plain", size: 3 });
  assert.equal(log.get("content-type"), "text/plain; charset=utf-8");
  assert.match(log.get("content-disposition")!, /^inline/);
  assert.match(serveHeaders({ name: "a.png", content_type: "image/png", size: 3 }, { download: true }).get("content-disposition")!, /^attachment/);
});

test("uploads arrive as text or base64, and are bounded", () => {
  assert.deepEqual([...bytesOf({ text: "hi" })], [104, 105]);
  assert.deepEqual([...bytesOf({ base64: "data:image/png;base64,aGk=" })], [104, 105]);
  assert.throws(() => bytesOf({}), /text .* or base64/);
  assert.throws(() => bytesOf({ base64: "!!!" }), /valid base64/);
  assert.throws(() => checkSize(0, 0), /empty/);
  assert.throws(() => checkSize(MAX_ATTACHMENT_BYTES + 1, 0), (e: any) => e.status === 413);
  assert.throws(() => checkSize(10, 2 * 1024 ** 3), /2 GB/);
});
