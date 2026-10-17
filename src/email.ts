// The email a person gets when something on a project needs them. Each item
// links to its card; a change that waits on a person's approval also gets an
// Approve link, which opens the change with its Approve button ready. The
// approval itself is a press on the page, never the link: mail scanners open
// links before the person does.

export interface MailItem {
  id: string;
  kind: string;
  text: string;
  url: string;
  detail: any;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The one action an item asks for, as a label and a link. */
export function mailAction(i: MailItem, project: string, origin: string): { label: string; url: string } {
  const change = i.detail?.change;
  if (change && (i.kind === "approval" || i.kind === "brief")) return { label: "Approve", url: `${origin}/?project=${encodeURIComponent(project)}#change/${change}/approve` };
  if (i.kind === "review") return { label: "Review", url: i.url };
  if (i.kind === "question") return { label: "Answer", url: i.url };
  if (i.kind === "dispute" || i.kind === "contest") return { label: "Decide", url: i.url };
  return { label: "Open", url: i.url };
}

export function needsYouEmail(project: string, person: string, fresh: MailItem[], open: number, origin: string) {
  const subject = fresh.length === 1
    ? `${project}: ${fresh[0].text.length > 90 ? `${fresh[0].text.slice(0, 87)}…` : fresh[0].text}`
    : `${project}: ${fresh.length} things need you`;
  const dashboard = `${origin}/?project=${encodeURIComponent(project)}`;
  const more = open > fresh.length ? `${open - fresh.length} more already waiting. ` : "";
  const why = `You get this because you turned on email for ${project} in Loom's Settings. Turn it off there.`;
  const rows = fresh.map((i) => ({ i, a: mailAction(i, project, origin) }));
  const text = [
    `Hi ${person}, agents on ${project} need you:`,
    "",
    ...rows.flatMap(({ i, a }) => [`- ${i.text}`, `  ${a.label}: ${a.url}${a.url !== i.url ? `\n  Open: ${i.url}` : ""}`]),
    "",
    `${more}Everything that needs a person: ${dashboard}`,
    "",
    why,
  ].join("\n");
  const html = `<div style="font:14px/1.5 -apple-system,Segoe UI,sans-serif;color:#1f2328;max-width:560px">
<p>Hi ${esc(person)}, agents on <b>${esc(project)}</b> need you:</p>
${rows.map(({ i, a }) => `<div style="border:1px solid #d0d7de;border-radius:8px;padding:12px;margin:8px 0">
<div>${esc(i.text)}</div>
<div style="margin-top:8px"><a href="${esc(a.url)}" style="display:inline-block;background:#1f6feb;color:#fff;text-decoration:none;padding:6px 12px;border-radius:6px">${esc(a.label)}</a>${a.url !== i.url ? ` &nbsp;<a href="${esc(i.url)}">Open</a>` : ""}</div>
</div>`).join("\n")}
<p>${esc(more)}<a href="${esc(dashboard)}">Everything that needs a person</a></p>
<p style="color:#656d76;font-size:12px">${esc(why)}</p>
</div>`;
  return { subject, text, html };
}
