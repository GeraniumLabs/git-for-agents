const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const PALETTE = ["#f38020", "#2b6cb0", "#2f8f5b", "#9f50c8", "#c53030", "#0f8b8d", "#b7791f", "#d53f8c"];

let project = new URLSearchParams(location.search).get("project");
let state = null;
let files = [];
let lastSeq = 0;

const color = (agentId) => {
  const i = state?.agents.findIndex((a) => a.id === agentId) ?? -1;
  return i < 0 ? "#888" : PALETTE[i % PALETTE.length];
};
const name = (agentId) => state?.agents.find((a) => a.id === agentId)?.name ?? agentId ?? "loom";
const ago = (ts) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};
const api = (p) => fetch(`/api/projects/${project}${p}`).then((r) => r.json());

// ── signing in as a human ────────────────────────────────────────────────
let me = null;
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};
const keyName = () => `loom-key:${project}`;
async function act(method, path, body) {
  const res = await fetch(`/api/projects/${project}${path}`, {
    method,
    headers: { authorization: `Bearer ${store.get(keyName())}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { toast(data.error ?? `HTTP ${res.status}`); throw new Error(data.error); }
  return data;
}
function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}
async function signIn(key) {
  if (key) store.set(keyName(), key);
  if (!store.get(keyName())) { me = null; renderMe(); return; }
  try { me = (await act("GET", "/me")).agent; } catch { me = null; store.set(keyName(), null); }
  renderMe();
  if (state) render(false);
}
const isHuman = () => me?.role === "human";
function renderMe() {
  $("#me").innerHTML = me
    ? `<span class="who-me">${esc(me.name)} <span class="role">${me.role}</span></span><button id="signout" class="ghost">Sign out</button>`
    : `<button id="signin">Sign in</button>`;
  if (me) $("#signout").onclick = () => { store.set(keyName(), null); signIn(); };
  else $("#signin").onclick = () => { const k = prompt("Your Loom key for this project (humans get one from the project admin):"); if (k) signIn(k.trim()); };
  $("#controls").hidden = !isHuman();
}

async function boot() {
  const projects = await fetch("/api/projects").then((r) => r.json());
  if (!project) project = projects[0]?.name;
  if (project && !projects.some((p) => p.name === project)) projects.push({ name: project });
  $("#project").innerHTML = projects.map((p) => `<option ${p.name === project ? "selected" : ""}>${esc(p.name)}</option>`).join("");
  $("#project").onchange = (e) => (location.search = `?project=${e.target.value}`);
  if (!project) {
    $("main").innerHTML = `<p class="empty">No projects yet. Create one with <code>POST /api/projects</code> or run <code>npm run demo</code>.</p>`;
    return;
  }
  connect();
  signIn();
}

function connect() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/projects/${project}/ws`);
  ws.onopen = () => { $("#live").className = "live on"; $("#live").textContent = "live"; };
  ws.onclose = () => { $("#live").className = "live off"; $("#live").textContent = "reconnecting"; setTimeout(connect, 1500); };
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.kind === "state") {
      state = msg.state;
      lastSeq = state.events.at(-1)?.seq ?? 0;
      render(true);
      refreshFiles();
    } else if (msg.kind === "event") {
      onEvent(msg.event, ws);
    }
  };
}

let refreshTimer;
function onEvent(e, ws) {
  if (e.seq <= lastSeq) return;
  lastSeq = e.seq;
  state.events.push(e);
  prependEvent(e, true);
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => ws.send("state"), 150);
  if (e.type === "change.merged") refreshFiles();
}

async function refreshFiles() {
  try { files = (await api("/files")).files ?? []; } catch { files = []; }
  renderTerritory();
}

function render(full) {
  renderInbox();
  renderControls();
  renderStats();
  renderAgents();
  renderBoard();
  renderChanges();
  renderTerritory();
  if (full) {
    $("#feed").innerHTML = "";
    for (const e of state.events) prependEvent(e, false);
  }
}

function renderStats() {
  const c = state.changes;
  const merged = c.filter((x) => x.status === "merged").length;
  const conflicts = state.events.filter((e) => e.type === "change.conflict" || e.type === "workspace.conflict").length;
  const forecasts = state.events.filter((e) => e.type === "collision.forecast").length;
  const active = state.agents.filter((a) => Date.now() - a.last_seen < 5 * 60_000).length;
  const stat = (v, l) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`;
  $("#stats").innerHTML =
    stat(`${active}/${state.agents.length}`, "agents active") +
    stat(state.tasks.filter((t) => t.status !== "merged").length, "open tasks") +
    stat(state.intents.length, "live intents") +
    stat(forecasts, "collisions forecast") +
    stat(`${merged}`, "changes merged") +
    stat(conflicts, "conflicts routed") +
    stat(`<span class="mono">${(state.project.mainHead ?? "").slice(0, 7)}</span>`, `main · v${state.project.mainVersion}`);
}

function renderAgents() {
  $("#agents").innerHTML = state.agents.map((a) => {
    const task = state.tasks.find((t) => t.assignee === a.id && t.status !== "merged");
    const ctl = isHuman() && a.role !== "human" ? `<button class="mini" data-agent="${a.id}" data-op="${a.paused ? "resume" : "pause"}">${a.paused ? "Resume" : "Pause"}</button>` : "";
    return `<li class="card agent ${a.paused ? "paused" : ""}"><span class="dot" style="background:${color(a.id)}"></span>
      <div class="grow"><div><b>${esc(a.name)}</b><span class="role">${a.id === "delegate" ? "delegate" : a.role}</span>${a.paused ? `<span class="role bad">paused</span>` : ""}</div>
      <div class="meta">${task ? `#${task.id} ${esc(task.title)}` : a.role === "reviewer" ? "reviewing" : a.id === "delegate" ? (state.delegate?.enabled ? "standing in for the humans" : "off") : a.role === "human" ? "steering" : "idle"} · ${ago(a.last_seen)}</div></div>${ctl}</li>`;
  }).join("") || `<li class="empty">No agents yet.</li>`;
  for (const b of document.querySelectorAll("[data-agent]")) b.onclick = async () => {
    const reason = b.dataset.op === "pause" ? prompt("Why pause this agent? (they will see this)") : undefined;
    if (b.dataset.op === "pause" && reason === null) return;
    await act("POST", `/agents/${b.dataset.agent}/${b.dataset.op}`, { reason });
  };
}

function matches(pattern, file) {
  if (pattern.endsWith("/")) return file.startsWith(pattern);
  if (/[*?[{]/.test(pattern)) {
    const re = "^" + pattern.replace(/[.+^$()|\\]/g, "\\$&").replace(/\*\*\/?/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*") + "$";
    return new RegExp(re).test(file);
  }
  return file === pattern || file.startsWith(pattern + "/");
}

function renderTerritory() {
  if (!state) return;
  const all = [...new Set([...files, ...state.intents.flatMap((i) => i.paths.filter((p) => !/[*?[{]/.test(p) && !p.endsWith("/")))])].sort();
  $("#territory").innerHTML = all.map((f) => {
    const owners = [...new Set(state.intents.filter((i) => i.paths.some((p) => matches(p, f))).map((i) => i.agent_id))];
    return `<div class="file ${owners.length > 1 ? "hot" : ""}"><span class="name mono" title="${esc(f)}">${esc(f)}</span>
      <span class="chips">${owners.map((o) => `<span class="chip" style="background:${color(o)}">${esc(name(o))}</span>`).join("")}</span></div>`;
  }).join("") || `<div class="empty">No files yet.</div>`;
}

function renderBoard() {
  const lanes = [["open", "Open"], ["claimed", "In progress"], ["in_review", "In review"], ["conflict", "Conflict"], ["merged", "Merged"]];
  $("#board").innerHTML = lanes.map(([k, label]) => {
    const tasks = state.tasks.filter((t) => t.status === k || (k === "claimed" && t.status === "blocked"));
    const builders = state.agents.filter((a) => a.role !== "reviewer");
    return `<div class="lane"><h3>${label} · ${tasks.length}</h3>${tasks.map((t) => `<div class="task" style="border-left:3px solid ${t.assignee ? color(t.assignee) : "var(--line)"}">
      #${t.id} ${esc(t.title)}${t.parent ? ` <span class="role">sub of #${t.parent}</span>` : ""}
      <div class="who">${t.assignee ? esc(name(t.assignee)) : t.depends_on.length ? `waits on #${t.depends_on.join(", #")}` : "unclaimed"}${t.waits_for ? ` · lands after #${t.waits_for}` : ""}</div>
      ${t.status === "blocked" ? `<div class="why">Blocked: waiting on a human</div>` : ""}
      ${isHuman() && t.status !== "merged" ? `<select class="mini" data-assign="${t.id}"><option value="">Assign…</option>${builders.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join("")}<option value="__none">Unassign</option></select>` : ""}</div>`).join("")}</div>`;
  }).join("");
  for (const sel of document.querySelectorAll("[data-assign]")) sel.onchange = async () => {
    if (!sel.value) return;
    const note = prompt("Note for the agent taking it (optional):") ?? "";
    await act("POST", `/tasks/${sel.dataset.assign}/assign`, { agent: sel.value === "__none" ? null : sel.value, note });
  };
}

function renderChanges() {
  const order = { merging: 0, queued: 1, conflict: 2, review: 3, changes_requested: 4, merged: 5 };
  const changes = [...state.changes].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || b.id - a.id);
  $("#changes").innerHTML = changes.map((c) => {
    const reviews = state.reviews.filter((r) => r.change_id === c.id);
    const conflicts = c.status === "conflict" && c.conflicts ? c.conflicts.map((x) => `<div class="why"><b>${esc(x.path)}</b>: ${x.hunks.length} conflicting hunk(s) with ${x.causedBy.map((y) => `#${y.change} “${esc(y.title)}” by ${esc(y.agentName)}`).join(", ") || "main"}. Routed to ${esc(name(c.agent_id))}.</div>`).join("") : "";
    const undeclared = c.undeclared.length ? `<div class="warn">Touched outside declared intent: ${c.undeclared.map(esc).join(", ")}</div>` : "";
    return `<div class="card change" data-id="${c.id}">
      <div class="top"><span><b>#${c.id}</b> ${esc(c.title)} <span style="color:${color(c.agent_id)}">· ${esc(name(c.agent_id))}</span></span><span class="pill ${c.status}">${c.status.replace("_", " ")}</span></div>
      <div class="files mono">${c.files.map((f) => `${f.status === "added" ? "+" : f.status === "deleted" ? "−" : "~"}${esc(f.path)}`).join("  ")}</div>
      ${reviews.length ? `<div class="files">${reviews.map((r) => `${r.verdict === "approve" ? "✓" : r.verdict === "request_changes" ? "✗" : "💬"} ${esc(name(r.reviewer))}`).join("  ")}</div>` : ""}
      ${conflicts}${undeclared}</div>`;
  }).join("") || `<p class="empty">No changes yet.</p>`;
  for (const el of document.querySelectorAll(".change")) el.onclick = () => showChange(Number(el.dataset.id));
}

function describe(e) {
  const d = e.data ?? {};
  const who = `<b style="color:${color(e.actor)}">${esc(name(e.actor))}</b>`;
  const to = e.to_agent ? `<b style="color:${color(e.to_agent)}">${esc(name(e.to_agent))}</b>` : "";
  switch (e.type) {
    case "project.created": return ["", `Project created, main at <span class="mono">${(d.commit ?? "").slice(0, 7)}</span>`];
    case "agent.joined": return ["", `${who} joined as ${d.role}`];
    case "task.created": return ["", `${who} created task #${e.task_id} “${esc(d.title)}”`];
    case "task.claimed": return ["", `${who} ${d.resumed ? "took over" : "claimed"} task #${e.task_id} in workspace <span class="mono">${esc(d.workspace)}</span>`];
    case "task.reassigned": return ["stale", `Task #${e.task_id} reassigned: ${esc(d.reason)}`];
    case "intent.declared": return ["", `${who} intends to touch <span class="mono">${d.paths.map(esc).join(", ")}</span>${d.description ? `: ${esc(d.description)}` : ""}`];
    case "collision.forecast": return ["collision", `Collision forecast: ${who} and ${to} both plan to touch <span class="mono">${d.paths.map(esc).join(", ")}</span>. Both notified before any code was written.`];
    case "intent.released": return ["", `${who} released an intent`];
    case "workspace.committed": return ["", `${who} committed to their workspace: ${esc(d.message)}`];
    case "change.submitted": return ["review", `${who} submitted change #${e.change_id} (${d.files.length} files)${d.undeclared?.length ? `, ${d.undeclared.length} outside intent` : ""}`];
    case "change.updated": return ["review", `Change #${e.change_id} updated${d.reason ? `: ${esc(d.reason)}` : ""}`];
    case "review.requested": return ["review", `Review requested on #${e.change_id}`];
    case "review.submitted": return ["review", `${who} ${d.verdict === "approve" ? "approved" : d.verdict === "request_changes" ? "requested changes on" : "commented on"} #${e.change_id}${d.body ? `: “${esc(d.body.slice(0, 140))}”` : ""}`];
    case "change.queued": return ["", `#${e.change_id} entered the merge queue (position ${d.position})`];
    case "merge.started": return ["", `Merging #${e.change_id}…`];
    case "change.merged": return ["merged", `${who}'s change #${e.change_id} landed on main <span class="mono">${(d.commit ?? "").slice(0, 7)}</span> (v${d.version})`];
    case "workspace.conflict": return ["conflict", `Syncing ${to}'s workspace hit a conflict in ${d.conflicts.map((c) => `<span class="mono">${esc(c.path)}</span>${c.causedBy.length ? ` (with ${esc(c.causedBy.join(", "))})` : ""}`).join(", ")}. Hunks sent back for resolution.`];
    case "merge.retry": return ["stale", `Merge of #${e.change_id} will retry: ${esc(d.error)}`];
    case "change.conflict": return ["conflict", `#${e.change_id} conflicts in ${d.conflicts.map((c) => `<span class="mono">${esc(c.path)}</span>${c.causedBy.length ? ` (with ${esc(c.causedBy.join(", "))})` : ""}`).join(", ")}. Routed to ${to}.`];
    case "workspace.stale": return ["stale", `Main moved under ${to}: <span class="mono">${d.paths.map(esc).join(", ")}</span> changed. Told to sync now.`];
    case "workspace.synced": return ["merged", `${who} synced main into their workspace${d.resolved?.length ? `, resolving ${d.resolved.map(esc).join(", ")}` : ""}`];
    case "question.asked": return ["question", `${who} asks ${d.audience === "humans" ? "the humans" : to || "everyone"}${d.blocking ? " (blocking)" : ""}: “${esc(d.body)}”`];
    case "question.answered": return ["merged", `${who} answered ${to}: “${esc(d.answer)}”${d.unblocked ? ". Task unblocked." : ""}`];
    case "thread.opened": return ["message", `${who} started a discussion${d.path ? ` on <span class="mono">${esc(d.path)}${d.line ? `:${d.line}` : ""}</span>` : ""}: “${esc(d.body)}”`];
    case "thread.reply": return ["message", `${who} replied in thread #${d.thread}: “${esc(d.body)}”`];
    case "thread.reply.notify": return null;
    case "thread.resolved": return ["", `${who} resolved thread #${d.thread}`];
    case "contract.published": return ["message", `${who} published a contract: <b>${esc(d.title ?? "")}</b>`];
    case "proposal.made": return ["collision", `${who} proposed to ${to}: ${esc(d.summary)}`];
    case "proposal.accepted": return ["merged", `${who} accepted: ${esc(d.summary)}`];
    case "proposal.rejected": return ["stale", `${who} rejected: ${esc(d.summary)}${d.reason ? ` (“${esc(d.reason)}”)` : ""}`];
    case "directive": return ["directive", `Directive from ${who}${to ? ` to ${to}` : " to all agents"}: “${esc(d.body)}”`];
    case "agent.paused": return ["directive", `${who} paused ${to}: ${esc(d.reason)}`];
    case "agent.resumed": return ["directive", `${who} resumed ${to}`];
    case "main.frozen": return ["directive", `${who} froze main${d.reason ? `: ${esc(d.reason)}` : ""}. The merge queue is holding.`];
    case "main.unfrozen": return ["directive", `${who} unfroze main`];
    case "task.assigned": return ["directive", `${who} assigned task #${e.task_id} to ${to || "nobody"}${d.note ? `: “${esc(d.note)}”` : ""}`];
    case "task.unassigned": return null;
    case "task.unblocked": return ["", `Task #${e.task_id} may now land (after #${d.after})`];
    case "paths.protected": return ["directive", `${who} protected <span class="mono">${d.paths.map(esc).join(", ") || "nothing"}</span>: changes there need a human approval`];
    case "approval.needs_human": return ["question", `#${e.change_id} touches protected <span class="mono">${d.paths.map(esc).join(", ")}</span> and needs a human approval`];
    case "delegate.configured": return ["directive", `${who} ${d.enabled ? `set ${esc(d.name)}'s brief: may ${[d.questions?.enabled && "answer questions", d.approvals?.enabled && `approve ${(d.approvals.paths ?? []).map(esc).join(", ") || "nothing"}`].filter(Boolean).join(" and ") || "do nothing yet"}` : `turned ${esc(d.name)} off`}`];
    case "delegate.decided": return ["merged", `${who} ${d.kind === "question" ? `answered for the humans${d.thread ? ` in thread #${d.thread}` : ""}` : `approved #${e.change_id} for the humans`} (${d.via === "jev" ? "Jev's judgment" : "house rule"}): “${esc(d.decision)}”`];
    case "delegate.escalated": return ["question", `${who} handed ${d.thread ? `question #${d.thread}` : `#${e.change_id}`} to a person: ${esc(d.reason)}`];
    case "message": return ["message", `${who}${to ? ` → ${to}` : " → everyone"}: “${esc(d.body)}”`];
    default: return ["", `${esc(e.type)} ${esc(JSON.stringify(d)).slice(0, 120)}`];
  }
}

function prependEvent(e, isNew) {
  const described = describe(e);
  if (!described) return;
  const [cls, html] = described;
  const li = document.createElement("li");
  li.className = `ev ${cls} ${isNew ? "new" : ""}`;
  li.innerHTML = `<time>${new Date(e.ts).toLocaleTimeString()}</time>${html}`;
  $("#feed").prepend(li);
  while ($("#feed").children.length > 300) $("#feed").lastChild.remove();
}

async function showChange(id) {
  const c = await api(`/changes/${id}`);
  const patch = esc(c.patch).split("\n").map((l) => l.startsWith("+") ? `<span class="add">${l}</span>` : l.startsWith("-") ? `<span class="del">${l}</span>` : l.startsWith("@@") ? `<span class="hunk">${l}</span>` : l).join("\n");
  $("#detail-body").innerHTML = `
    <h3>#${c.id} ${esc(c.title)} <span class="pill ${c.status}">${c.status}</span></h3>
    <p>By <b>${esc(c.agentName)}</b> for task #${c.task.id} “${esc(c.task.title)}”.</p>
    ${c.summary ? `<p>${esc(c.summary)}</p>` : ""}
    ${c.intents.length ? `<h2>Declared intent</h2>${c.intents.map((i) => `<div class="mono">${i.paths.map(esc).join(", ")}</div><div>${esc(i.description)}</div>`).join("")}` : ""}
    ${c.context?.context && Object.keys(c.context.context).length ? `<h2>Agent context</h2><pre class="diff">${esc(JSON.stringify(c.context.context, null, 2))}</pre>` : ""}
    ${c.reviews.length ? `<h2>Reviews</h2>${c.reviews.map((r) => `<div class="card"><b>${esc(name(r.reviewer))}</b> ${r.verdict}: ${esc(r.body)}${r.comments.map((x) => `<div class="mono">${esc(x.path)}${x.line ? `:${x.line}` : ""} ${esc(x.body)}</div>`).join("")}</div>`).join("")}` : ""}
    <h2>Patch</h2><pre class="diff">${patch}</pre>
    ${me && c.status !== "merged" && me.id !== c.agent_id ? `<h2>Your review</h2><textarea id="rv-body" rows="3" placeholder="Comment (optional)"></textarea>
      <div class="row"><button data-verdict="approve">Approve</button><button data-verdict="request_changes" class="ghost">Request changes</button><button data-verdict="comment" class="ghost">Comment</button></div>` : ""}`;
  for (const b of document.querySelectorAll("[data-verdict]")) b.onclick = async () => {
    await act("POST", `/changes/${id}/reviews`, { verdict: b.dataset.verdict, body: $("#rv-body").value });
    $("#detail").close();
  };
  $("#detail").showModal();
}

// ── what needs a human ──────────────────────────────────────────────────
function needsHuman() {
  const items = [];
  for (const t of state.threads ?? []) {
    if (t.kind === "question" && t.status === "open" && (t.to_agent === "humans" || t.to_agent === me?.id)) items.push({ type: "question", t });
    if (t.kind === "proposal" && t.status === "open") items.push({ type: "proposal", t });
  }
  const askedHuman = new Set(state.events.filter((e) => e.type === "approval.needs_human").map((e) => e.change_id));
  for (const c of state.changes) if (c.status === "review" && askedHuman.has(c.id)) items.push({ type: "approval", c });
  return items;
}

function renderInbox() {
  const items = needsHuman();
  const discussions = (state.threads ?? []).filter((t) => t.kind === "discussion" || t.kind === "contract").slice(0, 6);
  $("#inbox-count").textContent = items.length ? `${items.length} waiting` : "nothing waiting";
  const box = (inner, cls = "") => `<div class="card inbox ${cls}">${inner}</div>`;
  const posts = (t) => t.posts.map((p) => `<div class="post"><b style="color:${color(p.author)}">${esc(p.authorName)}</b> ${esc(p.body)}</div>`).join("");
  const replyBox = (t, label = "Reply") => me ? `<div class="row"><input data-reply="${t.id}" placeholder="${label}…"><button data-send="${t.id}">Send</button></div>` : "";
  $("#inbox").innerHTML = items.map((it) => {
    if (it.type === "question") {
      const opts = it.t.options ? `<div class="opts">${Object.entries(it.t.options).map(([k, v]) => me ? `<button class="ghost mini" data-pick="${it.t.id}" data-opt="${esc(k)}" title="${esc(v)}">${esc(k)}</button>` : `<span class="pill" title="${esc(v)}">${esc(k)}</span>`).join("")}</div>` : "";
      return box(`<div class="kicker">Question${it.t.blocking ? " · blocking task #" + it.t.task_id : ""}</div>${posts(it.t)}${opts}${escalation(it.t.escalated)}${replyBox(it.t, "Answer")}`, "q");
    }
    if (it.type === "proposal") return box(`<div class="kicker">Proposal between agents</div>${posts(it.t)}<div class="meta">Waiting on ${esc(name(it.t.to_agent))}</div>`);
    const why = state.events.filter((e) => e.type === "delegate.escalated" && e.change_id === it.c.id).at(-1)?.data.reason;
    return box(`<div class="kicker">Needs a human approval</div><div><b>#${it.c.id}</b> ${esc(it.c.title)} · ${esc(name(it.c.agent_id))}</div><div class="files mono">${it.c.files.map((f) => esc(f.path)).join("  ")}</div>${escalation(why)}${me ? `<div class="row"><button data-open="${it.c.id}">Review</button></div>` : ""}`, "q");
  }).join("") + (discussions.length ? `<h2>Discussions &amp; contracts</h2>` + discussions.map((t) => box(`<div class="kicker">${t.kind === "contract" ? "Contract" : "Discussion"}${t.path ? ` · <span class="mono">${esc(t.path)}${t.line ? ":" + t.line : ""}</span>` : ""}${t.task_id ? ` · task #${t.task_id}` : ""} · ${t.status}</div>${t.kind === "contract" ? `<div class="mono"><b>${esc(t.title)}</b></div>` : ""}${posts(t)}${replyBox(t)}`)).join("") : "")
    || `<p class="empty">Nothing needs a human right now.</p>`;
  for (const b of document.querySelectorAll("[data-send]")) b.onclick = async () => {
    const input = document.querySelector(`[data-reply="${b.dataset.send}"]`);
    if (!input.value.trim()) return;
    await act("POST", `/threads/${b.dataset.send}/posts`, { body: input.value.trim() });
    input.value = "";
  };
  for (const b of document.querySelectorAll("[data-open]")) b.onclick = () => showChange(Number(b.dataset.open));
  for (const b of document.querySelectorAll("[data-pick]")) b.onclick = () => act("POST", `/threads/${b.dataset.pick}/posts`, { body: `Go with “${b.dataset.opt}”.` });
}
const escalation = (reason) => reason && state.delegate?.enabled ? `<div class="warn">${esc(state.delegate.name)} passed this to you: ${esc(reason)}</div>` : "";

// ── jev: what the humans let their stand-in decide ──────────────────────
const jevForm = $("#jev-form");
const field = (n) => jevForm.elements.namedItem(n);
const listOf = (v) => v.split(",").map((x) => x.trim()).filter(Boolean);
function fillJev() {
  const d = state.delegate;
  $("#jev-title").textContent = d.name;
  $("#jev-status").textContent = d.jevConnected ? "Jev is connected." : "Jev isn't connected (no TYPESAFE_API_KEY), so only house rules apply.";
  field("enabled").checked = d.enabled;
  field("name").value = d.name;
  field("guidance").value = d.guidance;
  field("q_enabled").checked = d.questions.enabled;
  field("q_topics").value = d.questions.topics.join(", ");
  field("q_conf").value = d.questions.minConfidence;
  field("rules").value = d.rules.map((r) => `${r.pattern} => ${r.answer}`).join("\n");
  field("a_enabled").checked = d.approvals.enabled;
  field("a_paths").value = d.approvals.paths.join(", ");
  field("a_review").checked = d.approvals.requireAgentReview;
  field("a_conf").value = d.approvals.minConfidence;
  showConf();
}
function showConf() {
  $("#q_conf_out").textContent = `${Math.round(field("q_conf").value * 100)}%`;
  $("#a_conf_out").textContent = `${Math.round(field("a_conf").value * 100)}%`;
}
jevForm.oninput = showConf;
$("#jev-open").onclick = () => { fillJev(); $("#jev").showModal(); };
$("#jev").onclose = async () => {
  if ($("#jev").returnValue !== "save") return;
  await act("POST", "/delegate", {
    enabled: field("enabled").checked,
    name: field("name").value.trim() || "jev",
    guidance: field("guidance").value.trim(),
    questions: { enabled: field("q_enabled").checked, topics: listOf(field("q_topics").value), minConfidence: Number(field("q_conf").value) },
    approvals: { enabled: field("a_enabled").checked, paths: listOf(field("a_paths").value), requireAgentReview: field("a_review").checked, minConfidence: Number(field("a_conf").value) },
    rules: field("rules").value.split("\n").map((l) => l.split("=>")).filter((p) => p.length === 2 && p[0].trim() && p[1].trim()).map(([pattern, answer]) => ({ pattern: pattern.trim(), answer: answer.trim() })),
  });
  toast(`Saved ${field("name").value.trim() || "jev"}'s brief`);
};

function renderControls() {
  if (!isHuman()) return;
  const frozen = state.project.frozen;
  $("#freeze").textContent = frozen ? "Unfreeze main" : "Freeze main";
  $("#freeze").className = frozen ? "bad" : "ghost";
  const sel = $("#dir-to");
  const current = sel.value;
  sel.innerHTML = `<option value="">All agents</option>` + state.agents.filter((a) => a.role !== "human").map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join("");
  sel.value = current;
  if (document.activeElement !== $("#protect-paths")) $("#protect-paths").value = (state.project.protectedPaths ?? []).join(", ");
}

$("#dir-send").onclick = async () => {
  const body = $("#dir-body").value.trim();
  if (!body) return;
  await act("POST", "/directives", { to: $("#dir-to").value || undefined, body });
  $("#dir-body").value = "";
};
$("#freeze").onclick = async () => {
  if (state.project.frozen) await act("POST", "/unfreeze", {});
  else await act("POST", "/freeze", { reason: prompt("Why freeze main?") ?? "" });
};
$("#protect-save").onclick = async () => {
  await act("POST", "/protect", { paths: $("#protect-paths").value.split(",").map((p) => p.trim()).filter(Boolean) });
  toast("Protected paths saved");
};

setInterval(() => state && renderAgents(), 10_000);
boot();
