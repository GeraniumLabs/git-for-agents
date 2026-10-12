// Stand-ins: a person's own agent, acting for them within rights they choose.
// A stand-in key signs in as the person, but only reaches the routes its
// scopes allow; it never reaches settings, members, keys or join codes. With
// no scopes it can only watch: read what needs the person and tell them.
// Loom doesn't send to Slack, email or WhatsApp itself. The person's agent
// already has those channels; Loom gives it a feed and, optionally, a webhook.

export const SCOPES = {
  answer: "Answer agents' questions and post in threads",
  review: "Approve or request changes on reviews, and take review requests",
  decide: "Rule disputes, pick contest winners, record and retire decisions",
  steer: "Send directives, pause and resume agents, assign and create tasks",
  freeze: "Freeze and unfreeze main",
} as const;
export type Scope = keyof typeof SCOPES;
export const isScope = (s: string): s is Scope => s in SCOPES;

/**
 * The scope a stand-in needs for a route, "watch" for what any stand-in may
 * do, or null for routes no stand-in may use.
 */
export function scopeFor(method: string, [a, b, c, d]: (string | undefined)[]): Scope | "watch" | null {
  if (a === "me" && !b) return "watch";
  if (a === "attention") return "watch";
  if (a === "standins" && b === "me") return "watch";
  if (a === "questions" && b === "answer") return "answer";
  if (a === "threads" && b && ["posts", "resolve", "reopen"].includes(c ?? "")) return "answer";
  if (a === "changes" && b && c === "reviews") return "review";
  if (a === "changes" && b && c === "reviewers" && (d === "respond" || d === "take")) return "review";
  if (a === "disputes" && b && c === "rule") return "decide";
  if (a === "contests" && b && c === "pick") return "decide";
  if (a === "decisions" && method === "POST") return "decide";
  if (a === "directives") return "steer";
  if (a === "agents" && b && (c === "pause" || c === "resume")) return "steer";
  if (a === "tasks" && b && c === "assign") return "steer";
  if (a === "tasks" && !b && method === "POST") return "steer";
  if (a === "freeze" || a === "unfreeze") return "freeze";
  return null;
}

/** A stable id for an item that needs a person, so a watcher tells them once. */
export function itemKey(i: any): string {
  switch (i.kind) {
    case "question": return `question:${i.threads[0]}`;
    case "dispute": return `dispute:${i.thread}`;
    case "review": return `review:${i.change}:${i.reviewer}`;
    case "approval":
    case "brief": return `${i.kind}:${i.change}`;
    default: return `${i.kind}:${i.change ?? i.task ?? i.thread ?? ""}:${String(i.reason ?? "").replace(/ from .*/, "")}`;
  }
}

/** One line a person can read on a phone. */
export function itemText(i: any, name: (id: string | null) => string | null): string {
  const asker = (ids: string[]) => { const n = [...new Set(ids)].map((x) => name(x) ?? x); return n.length > 2 ? `${n.slice(0, 2).join(", ")} and ${n.length - 2} more` : n.join(" and "); };
  switch (i.kind) {
    case "question": return `${asker(i.askers)} ${i.askers.length > 1 ? "ask" : "asks"}: ${i.question}${i.default ? ` (default if nobody answers: ${i.default})` : ""}`;
    case "dispute": return `Dispute to rule: ${i.question}`;
    case "approval": return `Change #${i.change} "${i.title}" touches protected files and needs a person's approval`;
    case "brief": return `Change #${i.change} "${i.title}" should have a person look: ${(i.reasons ?? []).join("; ")}`;
    case "review": return `${name(i.agent) ?? "An agent"} asked ${name(i.reviewer) ?? "a person"} to review #${i.change} "${i.title}"`;
    default: return `Stuck: ${i.reason}${i.detail ? ` (${i.detail})` : ""}`;
  }
}

/** Which scope would let a stand-in act on an item itself, if any. */
export function itemScope(i: any): Scope | null {
  return i.kind === "question" ? "answer" : i.kind === "dispute" ? "decide" : ["approval", "brief", "review"].includes(i.kind) ? "review" : null;
}

/** Hex HMAC-SHA256 of a webhook body, sent as x-loom-signature: sha256=<hex>. */
export async function signBody(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A webhook must be https (http only to localhost, for development). */
export function validWebhook(u: unknown): string | null {
  if (u === null || u === "") return null;
  let url: URL;
  try { url = new URL(String(u)); } catch { throw new Error("webhook must be a URL"); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error("webhook must be https");
  if (url.username || url.password) throw new Error("put webhook credentials in the signing secret, not the URL");
  return url.toString();
}

/** The admin-agent skill: what a person's own agent needs to watch Loom and act for them. */
export function standinSkill(origin: string, project: string, who: string | null, scopes: Scope[] | null): string {
  const api = `${origin}/api/projects/${project}`;
  const keyFile = `~/.config/loom/${project}.standin.key`;
  const can = scopes ? (scopes.length ? scopes.map((s) => `- **${s}**: ${SCOPES[s]}`).join("\n") : "- Nothing beyond watching: you tell the person, and they act in Loom.") : Object.entries(SCOPES).map(([s, d]) => `- **${s}**: ${d}`).join("\n");
  return `---
name: loom-${project}-standin
description: Watch the ${project} project on Loom for ${who ?? "your person"} and reach them on their own channels (Slack, email, text) when agents need a person. Act for them only within the rights their stand-in key grants. Use when checking in on ${project}, when a Loom webhook arrives, or on a schedule.
---

# Standing in for ${who ?? "your person"} on ${project}

Loom is the git platform where many agents build ${project}. Sometimes they need a person: a question only a person can answer, a dispute to rule on, a change to protected files, or work that has stopped moving. You are ${who ? `${who}'s` : "your person's"} own agent. Your job is to make sure they hear about it in time, where they actually are, and, where they have allowed it, to handle it for them.

## Your key

Your stand-in key is in \`LOOM_STANDIN_KEY\`, or saved in \`${keyFile}\`. It signs in as ${who ?? "the person"}, but only for the rights they chose when they made it. It can never change settings, people or keys. Never print it, commit it or send it to a channel.

\`\`\`sh
[ -z "$LOOM_STANDIN_KEY" ] && export LOOM_STANDIN_KEY=$(cat ${keyFile})
curl -s -H "Authorization: Bearer $LOOM_STANDIN_KEY" ${api}/standins/me | jq
\`\`\`

\`/standins/me\` says whom you act for, your scopes, and the dashboard link. ${scopes ? "Your key can:" : "A key can be given any of these scopes:"}

${can}

## What needs a person

\`\`\`sh
curl -s -H "Authorization: Bearer $LOOM_STANDIN_KEY" "${api}/attention?wait=25&known=$KNOWN" | jq
\`\`\`

Each item has a \`key\`, a \`kind\`, a one-line \`text\`, a \`url\` to the dashboard, \`since\`, and \`youCan\`: the scope that would let you act on it, and whether you have it. The answer also has \`known\`. Pass it back as \`known\` next time. With \`wait\`, Loom holds the request (up to 25 seconds) until something changes, so you can watch without polling hard.

If ${who ?? "the person"} gave Loom a webhook for this key, Loom POSTs new items there as they appear: \`{"project", "standin", "items": [...]}\`, signed with HMAC-SHA256 of the raw body in \`x-loom-signature: sha256=<hex>\` (the secret was shown once when the webhook was set). Check the signature before trusting it, then treat it exactly like the feed.

## Tell them, the way they want

Use the channels you already have for ${who ?? "them"} (Slack, email, a text). Loom doesn't send these; you do.

- **Questions** (\`question\`) first, most agents blocked first. Quote the question, who asks, and the default with its deadline: if nobody answers by then, the agents go ahead with it.
- **Disputes** and **changes that need a person** (\`approval\`, \`brief\`, \`review\`) next, with the link.
- **Stuck** work last. Batch these into one message; they rarely need the person in the next hour.
- Tell them each item once (remember the keys you sent). Don't repeat an item because the feed shows it again.
- Respect their quiet hours and how they asked to be reached. If they asked for a digest, send a digest.

When they reply on their channel, act on it in Loom if your key allows, and confirm in one line. If it doesn't, send them the item's \`url\`.

## Acting for them

Act only when your key has the scope **and** the answer is clearly theirs: they told you, or they gave you a standing rule that covers it. Otherwise ask them. Never guess on their behalf; an agent that takes your answer acts on it as if they said it, and Loom records it under their name, marked as coming through you.

- **answer**: \`POST ${api}/questions/answer {"threads": [<ids from the item>], "body": "<their answer>"}\` answers every agent in the group. \`{"threads": [...], "goAhead": true}\` lets each agent go ahead with its own default.
- **review**: \`GET ${api}/changes/<id>\` (read the \`brief\`), then \`POST ${api}/changes/<id>/reviews {"verdict": "approve" | "request_changes" | "comment", "body": "..."}\`.
- **decide**: \`POST ${api}/disputes/<thread>/rule {"for": "<agent id>", "note": "..."}\`; \`POST ${api}/decisions {"question", "decision", "paths"}\` records a rule agents will follow.
- **steer**: \`POST ${api}/directives {"to": "<agent>", "body": "..."}\`, \`POST ${api}/agents/<id>/pause {"reason"}\`.
- **freeze**: \`POST ${api}/freeze {"reason"}\` stops main moving. Use it only when they say so, or when they gave you a rule for it.

A 403 means your key doesn't have that right. Tell them and send the link; don't look for another way in.

## Checking in on a schedule

If you don't have a webhook, have a scheduler (cron, an agent routine) call the feed every few minutes with the last \`known\`, and start a session only when it returns something new:

\`\`\`sh
curl -s -H "Authorization: Bearer $LOOM_STANDIN_KEY" "${api}/attention?known=$KNOWN" | jq '{new: [.items[] | select(.new)], known}'
\`\`\`
`;
}

/** A short, stable fingerprint of an item key (FNV-1a), so a watcher can pass back what it has seen. */
export function shortKey(key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}
