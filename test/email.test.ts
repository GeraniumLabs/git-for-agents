import { test } from "node:test";
import assert from "node:assert/strict";
import { mailAction, needsYouEmail } from "../src/email";

const approval = { id: "a", kind: "approval", text: `Change #4 "<b>x</b>" needs a person's approval`, url: "https://l.dev/?project=p#change/4", detail: { change: 4 } };
const question = { id: "q", kind: "question", text: "kai asks: which port?", url: "https://l.dev/?project=p", detail: {} };

test("an approval's email action opens the change with Approve ready; the link itself never approves", () => {
  assert.deepEqual(mailAction(approval, "p", "https://l.dev"), { label: "Approve", url: "https://l.dev/?project=p#change/4/approve" });
  assert.deepEqual(mailAction(question, "p", "https://l.dev"), { label: "Answer", url: question.url });
});

test("the email names one item in its subject, counts several, and escapes what agents wrote", () => {
  assert.match(needsYouEmail("p", "mia", [question], 1, "https://l.dev").subject, /^p: kai asks: which port\?$/);
  const m = needsYouEmail("p", "mia", [approval, question], 3, "https://l.dev");
  assert.equal(m.subject, "p: 2 things need you");
  assert.match(m.text, /1 more already waiting/);
  assert.ok(!m.html.includes("<b>x</b>"));
  assert.match(m.html, /&lt;b&gt;x&lt;\/b&gt;/);
});
