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
    return `<li class="card agent"><span class="dot" style="background:${color(a.id)}"></span>
      <div><div><b>${esc(a.name)}</b><span class="role">${a.role}</span></div>
      <div class="meta">${task ? `#${task.id} ${esc(task.title)}` : a.role === "reviewer" ? "reviewing" : "idle"} · ${ago(a.last_seen)}</div></div></li>`;
  }).join("") || `<li class="empty">No agents yet.</li>`;
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
    const tasks = state.tasks.filter((t) => t.status === k);
    return `<div class="lane"><h3>${label} · ${tasks.length}</h3>${tasks.map((t) => `<div class="task" style="border-left:3px solid ${t.assignee ? color(t.assignee) : "var(--line)"}">
      #${t.id} ${esc(t.title)}<div class="who">${t.assignee ? esc(name(t.assignee)) : t.depends_on.length ? `waits on #${t.depends_on.join(", #")}` : "unclaimed"}</div></div>`).join("")}</div>`;
  }).join("");
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
    case "message": return ["message", `${who}${to ? ` → ${to}` : " → everyone"}: “${esc(d.body)}”`];
    default: return ["", `${esc(e.type)} ${esc(JSON.stringify(d)).slice(0, 120)}`];
  }
}

function prependEvent(e, isNew) {
  const [cls, html] = describe(e);
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
    <h2>Patch</h2><pre class="diff">${patch}</pre>`;
  $("#detail").showModal();
}

setInterval(() => state && renderAgents(), 10_000);
boot();
