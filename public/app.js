// Loom dashboard. People don't watch agents here: the page is about the work,
// what needs a person, and what is stuck. Agents are found by search.

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const PALETTE = ["#f38020", "#2b6cb0", "#2f8f5b", "#9f50c8", "#c53030", "#0f8b8d", "#b7791f", "#d53f8c"];

let project = new URLSearchParams(location.search).get("project");
let state = null; // the overview
let lastSeq = 0;
const names = {};
const recent = []; // every event since the page opened, for the "Everything" view

// An agent keeps its color wherever it appears, however many agents there are.
const color = (id) => {
  if (!id) return "#888";
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
};
const name = (id) => names[id] ?? (id ? String(id).replace(/-[0-9a-f]{4}$/, "") : "loom");
const who = (id) => `<a class="who" data-agent="${esc(id)}" style="color:${color(id)}">${esc(name(id))}</a>`;
const ago = (ts) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
};
const dur = (ms) => (ms < 1000 ? "now" : ago(Date.now() - ms));
const keyQuery = () => { const k = store.get(keyName()); return k ? `&key=${encodeURIComponent(k)}` : ""; };
const keyHeader = () => { const k = store.get(keyName()); return k ? { authorization: `Bearer ${k}` } : {}; };
const api = (p) => fetch(`/api/projects/${project}${p}`, { headers: keyHeader() }).then((r) => r.json());

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
    headers: { ...(store.get(keyName()) ? { authorization: `Bearer ${store.get(keyName())}` } : {}), "content-type": "application/json" },
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
// People sign in with GitHub (a session cookie). A pasted key still works,
// for agents' keys and for scripts.
let user = null, auth = { github: false, dev: false }, notMember = false;
async function loadUser() {
  try { auth = await fetch("/auth/me", { cache: "no-store" }).then((r) => r.json()); user = auth.user; } catch { user = null; }
}
async function signIn(key) {
  if (key) store.set(keyName(), key);
  notMember = false;
  me = null;
  if (store.get(keyName()) || user) {
    const res = await fetch(`/api/projects/${project}/me`, { headers: store.get(keyName()) ? { authorization: `Bearer ${store.get(keyName())}` } : {} });
    if (res.ok) me = (await res.json()).agent;
    else if (store.get(keyName())) store.set(keyName(), null);
    else notMember = res.status === 403;
  }
  renderMe();
  if (state) render();
}
const isHuman = () => me?.role === "human";
const isOwner = () => !!me?.owner;
const githubUrl = () => `/auth/github?return=${encodeURIComponent(location.pathname + location.search)}`;
function renderMe() {
  const face = user?.avatar ? `<img class="avatar" src="${esc(user.avatar)}" alt="">` : "";
  $("#me").innerHTML = me
    ? `<span class="who-me">${face}${esc(me.name)} <span class="role">${me.owner ? "owner" : me.role === "human" ? "member" : me.role}</span></span><button id="signout" class="ghost">Sign out</button>`
    : user
      ? `<span class="who-me">${face}${esc(user.login)} <span class="role">not a member</span></span><button id="signout" class="ghost">Sign out</button>`
      : `<button id="signin">Sign in</button>`;
  if ($("#signout")) $("#signout").onclick = async () => {
    // Sign out everywhere on this site: the GitHub session and any key pasted for any project.
    try { for (const k of Object.keys(localStorage)) if (k.startsWith("loom-key:")) localStorage.removeItem(k); } catch {}
    await fetch("/auth/logout", { method: "POST", cache: "no-store" }).catch(() => {});
    location.reload();
  };
  else $("#signin").onclick = () => showSignIn();
  $("#controls").hidden = !isHuman();
  $("#work-open").hidden = !me;
}

/** Sign in with GitHub; or, if already signed in but not a member, say who can add you. */
async function showSignIn(why = "") {
  const ghButton = auth.github ? `<a class="button" href="${githubUrl()}">Sign in with GitHub</a>` : `<p class="meta">GitHub sign-in isn't set up on this server yet. <a href="/auth/setup">Set it up</a> (one click, needs the admin token once).</p>`;
  const dev = auth.dev ? `<div class="row"><input id="si-dev" placeholder="Any GitHub login (local development)"><button class="ghost" id="si-dev-go">Sign in locally</button></div>` : "";
  const owners = user && notMember ? (await api("/members").catch(() => [])).filter((p) => p.owner).map((p) => p.login) : [];
  $("#detail-body").innerHTML = `
    <h3>Sign in to ${esc(project)}</h3>
    ${why ? `<p>${esc(why)}</p>` : ""}
    ${user && notMember
      ? `<p>You're signed in as <b>${esc(user.login)}</b>, but you aren't a member of ${esc(project)} yet. ${owners.length ? `Ask ${owners.map(esc).join(" or ")} to add you in Settings.` : "Ask one of its owners to add you in Settings."}</p>`
      : `<p class="meta">People sign in with GitHub. Your answers, reviews and decisions carry your name.</p><div class="row">${ghButton}</div>${dev}`}
    <details class="alt"><summary>Use a key instead</summary>
      <p class="meta">For a Loom key someone made for you. Agents use these.</p>
      <div class="row"><input id="si-key" type="password" placeholder="Loom key for this project" autocomplete="off"><button class="ghost" id="si-go">Sign in</button></div>
    </details>`;
  const done = async () => { await signIn(); if (me) { $("#detail").close(); toast(`Signed in as ${me.name}`); } else toast("That key didn't work for this project"); };
  $("#si-go").onclick = () => { const k = $("#si-key").value.trim(); if (k) { store.set(keyName(), k); done(); } };
  if ($("#si-dev-go")) $("#si-dev-go").onclick = () => { const l = $("#si-dev").value.trim(); if (l) location.href = `/auth/dev?login=${encodeURIComponent(l)}&return=${encodeURIComponent(location.pathname + location.search)}`; };
  if (!$("#detail").open) $("#detail").showModal();
}

async function boot() {
  await loadUser();
  const projects = await fetch("/api/projects").then((r) => r.json());
  if (!project) project = projects.at(-1)?.name;
  if (project && !projects.some((p) => p.name === project)) projects.push({ name: project });
  $("#project").innerHTML = projects.map((p) => `<option value="${esc(p.name)}" ${p.name === project ? "selected" : ""}>${p.private ? "🔒 " : ""}${esc(p.name)}</option>`).join("");
  $("#project").onchange = (e) => (location.search = `?project=${e.target.value}`);
  if (!project) {
    $("main").innerHTML = `<p class="empty">No projects yet. <button id="np-empty">Create a project</button></p>`;
    $("#np-empty").onclick = () => showNewProject();
    renderMe();
    return;
  }
  // A private project answers 404 to anyone who can't read it.
  const probe = await fetch(`/api/projects/${project}/delegate`, { headers: keyHeader() });
  if (probe.status === 404) {
    $("main").innerHTML = `<p class="empty">${esc(project)} doesn't exist, or it's private. ${user ? "Ask one of its owners to add you." : `<button id="private-signin">Sign in</button>`}</p>`;
    if ($("#private-signin")) $("#private-signin").onclick = () => showSignIn("Private projects are visible only to their members.");
    renderMe();
    return;
  }
  connect();
  signIn();
}

function connect() {
  const key = store.get(keyName());
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/projects/${project}/ws${key ? `?key=${encodeURIComponent(key)}` : ""}`);
  ws.onopen = () => { $("#live").className = "live on"; $("#live").textContent = "live"; ws.send("overview"); };
  ws.onclose = () => { $("#live").className = "live off"; $("#live").textContent = "reconnecting"; setTimeout(connect, 1500); };
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.kind === "overview") {
      const first = !state;
      state = msg.overview;
      Object.assign(names, state.names);
      if (first) { lastSeq = state.lastSeq; for (const e of [...state.notable].reverse()) recent.push(e); }
      render();
    } else if (msg.kind === "event") onEvent(msg.event, ws);
  };
}

// With hundreds of agents events arrive constantly: refresh the overview at most once a second.
let refreshTimer = null;
function onEvent(e, ws) {
  if (e.seq <= lastSeq) return;
  lastSeq = e.seq;
  if (e.type === "agent.joined" && e.actor) names[e.actor] = e.data?.name ?? names[e.actor];
  recent.push(e);
  if (recent.length > 2000) recent.splice(0, recent.length - 2000);
  if (showAll || isNotable(e)) addEvent(e, true);
  if (!refreshTimer) refreshTimer = setTimeout(() => { refreshTimer = null; ws.send("overview"); }, 1000);
}

// The project's grid changes slowly: redraw it every half minute, not on every event.
let gridAt = 0;
function render() {
  if (Date.now() - gridAt > 30_000) { gridAt = Date.now(); renderGrid($("#contrib")); }
  renderControls();
  renderHealth();
  renderAttention();
  renderStuck();
  renderDiscussions();
  renderFlow();
  renderContests();
  renderQueue();
  renderAreas();
  renderDecisions();
  renderNotes();
  renderFeed();
}

// ── health: is the work moving? ─────────────────────────────────────────
const STATES = [
  ["working", "working", "ok"], ["waiting", "waiting on a person", "warn"], ["conflict", "in conflict", "bad"],
  ["quiet", "quiet holding a task", "bad"], ["paused", "paused", "warn"], ["idle", "idle", ""], ["away", "away", ""],
];
function renderHealth() {
  const h = state.health;
  const t = h.tasks;
  const open = (t.open ?? 0), active = (t.claimed ?? 0) + (t.blocked ?? 0) + (t.conflict ?? 0), review = (t.in_review ?? 0) + (t.queued ?? 0), merged = t.merged ?? 0;
  const total = open + active + review + merged || 1;
  const seg = (n, cls, label) => n ? `<span class="seg-${cls}" style="flex:${n}" title="${n} ${label}"></span>` : "";
  $("#health").innerHTML = `
    <div class="tile wide">
      <b>${h.agents.total}</b><span>agents</span>
      <div class="states">${STATES.filter(([k]) => h.agents.byState[k]).map(([k, label, cls]) => `<button class="state ${cls}" data-state="${k}">${h.agents.byState[k]} ${label}</button>`).join("") || `<span class="meta">none yet</span>`}</div>
    </div>
    <div class="tile wide">
      <b>${merged}<small>/${total === 1 && !merged ? 0 : total}</small></b><span>tasks landed</span>
      <div class="bar">${seg(merged, "ok", "landed")}${seg(review, "info", "in review or queued")}${seg(active, "warn", "in progress")}${seg(open, "muted", "open")}</div>
      <div class="meta">${open} open · ${active} in progress · ${review} in review or queued</div>
    </div>
    <div class="tile"><b>${h.queue.depth}</b><span>in the merge queue${h.queue.depth ? ` · oldest ${dur(h.queue.oldestWaitMs)}` : ""}</span></div>
    <div class="tile"><b>${h.mergedLastHour}</b><span>merged in the last hour</span></div>
    <div class="tile"><b class="${h.conflictRate > 0.2 ? "bad" : ""}">${Math.round(h.conflictRate * 100)}%</b><span>conflict rate · ${h.conflictsLastHour} this hour</span></div>
    <div class="tile"><b class="mono">${(state.project.mainHead ?? "").slice(0, 7)}</b><span>main · v${state.project.mainVersion}${state.project.frozen ? ` · <b class="bad">frozen</b>` : ""}</span></div>`;
  for (const b of document.querySelectorAll("[data-state]")) b.onclick = () => showDirectory(b.dataset.state);
}

// ── what needs a person ─────────────────────────────────────────────────
const signInToAct = (verb) => `<div class="row"><button class="ghost mini" data-signin>Sign in to ${verb}</button></div>`;
const escalation = (reason) => reason && state.delegate?.enabled ? `<div class="warn">${esc(state.delegate.name)} passed this to you: ${esc(reason)}</div>` : "";
function renderAttention() {
  const items = state.attention.filter((i) => i.kind !== "stuck");
  $("#attention-count").textContent = items.length ? `${items.length} waiting` : "nothing waiting";
  $("#attention-panel").classList.toggle("hot", items.length > 0);
  const box = (inner, cls = "") => `<div class="card inbox ${cls}">${inner}</div>`;
  $("#attention").innerHTML = items.map((it) => {
    if (it.kind === "question") {
      const many = it.threads.length > 1;
      const askers = it.askers.slice(0, 3).map(who).join(", ") + (it.askers.length > 3 ? ` and ${it.askers.length - 3} more` : "");
      const opts = it.options ? `<div class="opts">${Object.entries(it.options).map(([k, v]) => me ? `<button class="ghost mini" data-answer="${it.threads.join(",")}" data-opt="${esc(k)}" title="${esc(v)}">${esc(k)}</button>` : `<span class="pill" title="${esc(v)}">${esc(k)}</span>`).join("")}</div>` : "";
      return box(`<div class="kicker">Question · asked by ${many ? `${it.threads.length} agents` : "1 agent"}${it.blocking ? ` · ${it.blocking} blocked` : ""} · ${ago(it.since)}</div>
        <div class="q">${esc(it.question)}</div><div class="meta">${askers}</div>${opts}${escalation(it.escalated)}
        ${me ? `<div class="row"><input data-answer-text="${it.threads.join(",")}" placeholder="Answer${many ? ` all ${it.threads.length}` : ""}…"><button data-answer-send="${it.threads.join(",")}">Send</button></div>` : signInToAct("answer")}`, "q");
    }
    if (it.kind === "dispute") {
      const sides = it.parties.map((p) => `<div class="side">${who(p)} ${it.positions[p] ? esc(it.positions[p]) : `<i class="meta">hasn't stated a position yet</i>`}${me && it.positions[p] ? ` <button class="mini" data-rule="${it.thread}" data-for="${esc(p)}">Rule for ${esc(name(p))}</button>` : ""}</div>`).join("");
      return box(`<div class="kicker">Dispute${it.change ? ` · change #${it.change}` : ""} · ${ago(it.since)}</div><div class="q">${esc(it.question)}</div>${sides}${escalation(it.escalated)}${me ? "" : signInToAct("rule on it")}`, "q");
    }
    if (it.kind === "review") {
      return box(`<div class="kicker">Review asked of ${it.reviewer === me?.id ? "you" : esc(name(it.reviewer))} · ${ago(it.since)}</div><div><a data-change="${it.change}">#${it.change} ${esc(it.title)}</a> · ${who(it.agent)}</div>${it.reason ? `<div class="meta">${esc(it.reason)}</div>` : ""}${me ? `<div class="row"><button data-change="${it.change}">Review</button></div>` : signInToAct("review")}`, "q");
    }
    return box(`<div class="kicker">Approval · touches protected paths · ${ago(it.since)}</div><div><a data-change="${it.change}">#${it.change} ${esc(it.title)}</a> · ${who(it.agent)}</div><div class="files mono">${it.files.map(esc).join("  ")}</div>${escalation(it.escalated)}${me ? `<div class="row"><button data-change="${it.change}">Review</button></div>` : signInToAct("approve")}`, "q");
  }).join("") || `<p class="empty">Nothing needs a person right now.</p>`;
  wire($("#attention"));
}

function renderStuck() {
  const items = state.attention.filter((i) => i.kind === "stuck");
  $("#stuck").innerHTML = items.slice(0, 12).map((it) => `<div class="card stuck"><div class="kicker">${esc(it.reason)} · ${ago(it.since)}</div>
    <div>${it.change ? `<a data-change="${it.change}">${esc(it.detail)}</a>` : esc(it.detail)}${it.agent ? ` · ${who(it.agent)}` : ""}</div></div>`).join("")
    + (items.length > 12 ? `<p class="meta">and ${items.length - 12} more</p>` : "")
    || `<p class="empty">Nothing is stuck.</p>`;
  wire($("#stuck"));
}

function renderDiscussions() {
  const posts = (t) => t.posts.slice(-3).map((p) => `<div class="post">${who(p.author)} ${esc(p.body)}</div>`).join("");
  $("#discussions").innerHTML = state.discussions.map((t) => `<div class="card inbox"><div class="kicker">${t.kind === "contract" ? "Contract" : t.title?.startsWith("Consult:") ? `Consult · ${esc(name(t.created_by))} asks ${esc(name(t.to_agent))}` : "Discussion"}${t.path ? ` · <span class="mono">${esc(t.path)}${t.line ? ":" + t.line : ""}</span>` : ""}${t.task_id ? ` · task #${t.task_id}` : ""}</div>${t.kind === "contract" ? `<div class="mono"><b>${esc(t.title)}</b></div>` : ""}${posts(t)}
    ${me ? `<div class="row"><input data-reply="${t.id}" placeholder="Reply…"><button data-send="${t.id}">Send</button></div>` : signInToAct("reply")}</div>`).join("")
    || `<p class="empty">No open discussions.</p>`;
  wire($("#discussions"));
}

// One place to hook up links and buttons inside rendered HTML.
function wire(root) {
  for (const b of root.querySelectorAll("[data-signin]")) b.onclick = () => showSignIn("Answering, reviewing and replying are signed with your name, so sign in first.");
  for (const a of root.querySelectorAll("[data-agent]")) a.onclick = (e) => { e.preventDefault(); showAgent(a.dataset.agent); };
  for (const a of root.querySelectorAll("[data-change]")) a.onclick = (e) => { e.preventDefault(); showChange(Number(a.dataset.change)); };
  for (const a of root.querySelectorAll("[data-contest]")) a.onclick = (e) => { e.preventDefault(); showContest(Number(a.dataset.contest)); };
  for (const b of root.querySelectorAll("[data-send]")) b.onclick = async () => {
    const input = root.querySelector(`[data-reply="${b.dataset.send}"]`);
    if (!input.value.trim()) return;
    await act("POST", `/threads/${b.dataset.send}/posts`, { body: input.value.trim() });
    input.value = "";
  };
  const answer = (ids, body) => act("POST", "/questions/answer", { threads: ids.split(",").map(Number), body });
  for (const b of root.querySelectorAll("[data-answer]")) b.onclick = () => answer(b.dataset.answer, `Go with “${b.dataset.opt}”.`);
  for (const b of root.querySelectorAll("[data-answer-send]")) b.onclick = async () => {
    const input = root.querySelector(`[data-answer-text="${b.dataset.answerSend}"]`);
    if (input.value.trim()) await answer(b.dataset.answerSend, input.value.trim());
  };
  for (const b of root.querySelectorAll("[data-rule]")) b.onclick = async () => {
    const note = prompt(`Ruling for ${name(b.dataset.for)}. Add a reason the agents will see (optional):`);
    if (note === null) return;
    await act("POST", `/disputes/${b.dataset.rule}/rule`, { for: b.dataset.for, note: note.trim() || undefined });
  };
}

// ── flow: merges and conflicts per minute ───────────────────────────────
function renderFlow() {
  const { merged, conflict } = state.health.series;
  const W = 300, H = 70, n = merged.length, bw = W / n;
  const max = Math.max(4, ...merged, ...conflict);
  const y = (v) => Math.max(v ? 2 : 0, (v / max) * (H - 4));
  const label = (i) => { const m = n - i; return m === 1 ? "this minute" : `${m} minutes ago`; };
  const bars = merged.map((v, i) => {
    const hm = y(v), hc = y(conflict[i]);
    return `<g><title>${label(i)}: ${v} merged, ${conflict[i]} conflicts</title>
      <rect x="${i * bw}" y="0" width="${bw}" height="${H}" fill="transparent"/>
      ${hm ? `<rect x="${i * bw + 1}" y="${H - hm}" width="${Math.max(1, bw / 2 - 1.5)}" height="${hm}" rx="1.5" class="m-ok"/>` : ""}
      ${hc ? `<rect x="${i * bw + bw / 2 + 0.5}" y="${H - hc}" width="${Math.max(1, bw / 2 - 1.5)}" height="${hc}" rx="1.5" class="m-bad"/>` : ""}</g>`;
  }).join("");
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  $("#flow").innerHTML = `<div class="legend"><span><i class="m-ok"></i>merged ${sum(merged)}</span><span><i class="m-bad"></i>conflicts ${sum(conflict)}</span><span class="meta">peak ${Math.max(...merged)}/min</span></div>
    <svg viewBox="0 0 ${W} ${H + 1}" preserveAspectRatio="none" class="chart" role="img" aria-label="Merges and conflicts per minute over the last 30 minutes">${bars}<line x1="0" x2="${W}" y1="${H + 0.5}" y2="${H + 0.5}" class="axis"/></svg>
    <div class="axis-labels"><span>30m ago</span><span>now</span></div>`;
}

function renderQueue() {
  $("#queue-count").textContent = state.health.queue.depth ? `${state.health.queue.depth} waiting` : "empty";
  const row = (c, right) => `<div class="qrow"><a data-change="${c.id}">#${c.id}</a> <span class="grow ellipsis">${esc(c.title)}</span> ${who(c.agent)} <span class="meta">${right}</span></div>`;
  $("#queue").innerHTML = `<div class="card">${state.queue.map((c) => row(c, c.status === "merging" ? "merging…" : `waiting ${dur(c.waitingMs)}`)).join("") || `<p class="empty">Nothing queued.</p>`}
    ${state.recentlyMerged.length ? `<div class="kicker" style="margin-top:8px">Recently landed</div>${state.recentlyMerged.map((c) => row(c, `v${c.version} · ${ago(c.at)}`)).join("")}` : ""}</div>`;
  wire($("#queue"));
}

function renderAreas() {
  const areas = state.areas;
  const max = Math.max(1, ...areas.map((a) => a.agents + a.inFlight));
  $("#areas").innerHTML = areas.length ? `<table class="areas"><thead><tr><th>Folder</th><th title="agents with live intents or changes here">Agents</th><th title="changes in review, queued or in conflict">In flight</th><th title="merged in the last hour">Landed</th><th title="conflicts in the last hour">Conflicts</th></tr></thead><tbody>
    ${areas.map((a) => `<tr><td><a class="mono" data-find="${esc(a.path)}">${esc(a.path)}</a><div class="heat"><span style="width:${((a.agents + a.inFlight) / max) * 100}%"></span></div></td><td>${a.agents || ""}</td><td>${a.inFlight || ""}</td><td>${a.mergedLastHour || ""}</td><td class="${a.conflictsLastHour ? "bad" : ""}">${a.conflictsLastHour || ""}</td></tr>`).join("")}
    </tbody></table>` : `<p class="empty">No work in progress.</p>`;
  for (const a of $("#areas").querySelectorAll("[data-find]")) a.onclick = () => { $("#search").value = a.dataset.find; runSearch(); $("#search").focus(); };
}

// ── contests: several attempts at one task, weighted votes pick one ─────
function renderContests() {
  const list = state.contests ?? [];
  $("#contests-wrap").hidden = !list.length;
  $("#contests").innerHTML = list.map((c) => `<div class="card contest">
    <div class="qrow"><b class="grow ellipsis">#${c.id} ${esc(c.title)}</b><span class="pill ${c.status === "open" ? "review" : "merged"}">${c.status === "open" ? plural(c.votes, ["vote", "votes"]) : "decided"}</span></div>
    ${c.attempts.map((a) => `<div class="qrow">${a.agent ? who(a.agent) : `<span class="meta">unclaimed</span>`} <span class="grow">${a.change ? `<a data-change="${a.change}">#${a.change}</a> <span class="meta">${esc(a.status)}</span>` : `<span class="meta">${a.agent ? "working…" : ""}</span>`}</span>
      ${a.change ? `<span class="votebar" title="${a.weight} of ${c.quorum} vote weight needed"><span style="width:${Math.min(100, (a.weight / c.quorum) * 100)}%"></span></span><span class="meta">${a.weight}</span>` : ""}${c.winner && a.change === c.winner ? ` <span class="pill merged">won</span>` : ""}</div>`).join("")}
    <div class="row"><button class="ghost mini" data-contest="${c.id}">Compare attempts</button></div></div>`).join("");
  wire($("#contests"));
}

async function showContest(id) {
  const v = await api(`/contests/${id}`);
  if (v.error) return toast(v.error);
  const k = v.contest, open = k.status === "open";
  const col = (a) => {
    const c = a.change;
    const tested = c?.context?.tested ? [].concat(c.context.tested).join("; ") : "";
    return `<div class="card attempt${c && c.id === k.winner ? " won" : ""}${c?.status === "closed" ? " lost" : ""}">
      <div class="kicker">${a.agent ? who(a.agent) : "unclaimed"} · ${c ? `<a data-change="${c.id}">#${c.id}</a> <span class="pill ${c.status}">${c.id === k.winner ? "won" : c.status}</span>` : esc(a.status)}</div>
      ${c ? `<p>${esc(c.summary)}</p>
        <div class="meta"><span class="add">+${c.added}</span> <span class="del">−${c.removed}</span> · ${c.files.map((f) => `<span class="mono">${esc(f)}</span>`).join(", ")}</div>
        ${tested ? `<div class="meta">Tested: ${esc(tested)}</div>` : ""}
        ${c.undeclared?.length ? `<div class="warn">Touches ${c.undeclared.map(esc).join(", ")} outside its declared intent</div>` : ""}
        <div class="votes"><b>${c.votes.weight}</b> vote weight · ${plural(c.votes.votes, ["vote", "votes"])}</div>
        ${isHuman() && open ? `<div class="row"><button class="mini" data-pick="${c.id}">Pick this one</button></div>` : ""}
        <details><summary>Patch</summary>${diffView(c.patch, [], false)}</details>` : `<p class="meta">${a.agent ? "Still working on it." : "Nobody has claimed this attempt."}</p>`}
    </div>`;
  };
  $("#detail-body").innerHTML = `
    <h3>Contest #${k.id}: ${esc(k.title)} <span class="pill ${open ? "review" : "merged"}">${open ? "voting" : "decided"}</span></h3>
    ${k.description ? `<p class="meta">${esc(k.description)}</p>` : ""}
    <p>${open ? `${k.attempts} agents attempt this task independently. The others compare the attempts and vote; each vote counts by the voter's track record. An attempt wins with ${k.quorum} vote weight and a clear lead${isHuman() ? ", or when you pick it" : ""}.` : `Decided: <a data-change="${k.winner}">#${k.winner}</a> lands. The other attempts were closed; their context is kept, and why the winner won is on record as a decision.`}</p>
    <div class="attempts">${v.attempts.map(col).join("")}</div>
    <h2>Votes</h2>
    ${v.votes.map((x) => `<div class="qrow">${who(x.voter)} <span class="pill" title="what this agent's vote counts for, from its track record">${x.weight}×</span> for <a data-change="${x.change}">#${x.change}</a> <span class="grow">“${esc(x.reason)}”</span></div>`).join("") || `<p class="empty">No votes yet.</p>`}`;
  wire($("#detail-body"));
  for (const b of $("#detail-body").querySelectorAll("[data-pick]")) b.onclick = async () => {
    const note = prompt("Why this one? The agents will see it, and it goes on record. (optional)");
    if (note === null) return;
    await act("POST", `/contests/${id}/pick`, { changeId: Number(b.dataset.pick), note: note.trim() || undefined });
    showContest(id);
  };
  if (!$("#detail").open) $("#detail").showModal();
}

// ── notes: what agents learned, for the agents after them ──────────────
function renderNotes() {
  const list = state.notes ?? [];
  $("#notes-count").textContent = list.length ? `${list.length} recent` : "";
  $("#notes").innerHTML = list.map((n) => `<li class="card decision"><div class="kicker">${esc(n.kind)} #${n.id} · ${who(n.by)}${n.paths.length ? ` · <span class="mono">${n.paths.map(esc).join(", ")}</span>` : " · whole project"}${n.change ? ` · from <a data-change="${n.change}">#${n.change}</a>` : ""}</div>
    <div>${esc(n.text)}</div>
    <div class="meta">${n.confirmed ? `confirmed by ${n.confirmed}` : "not confirmed yet"}${n.disputed ? ` · disputed by ${n.disputed}${n.disputes.length ? `: ${n.disputes.map((d) => `${esc(d.by)}: “${esc(d.comment)}”`).join("; ")}` : ""}` : ""}</div>
    ${isHuman() ? `<button class="ghost mini" data-note-retire="${n.id}">Retire</button>` : ""}</li>`).join("")
    || `<li class="empty">Agents leave notes (remember, or notes in a change's context) about what they learned. The next agent on those files gets them.</li>`;
  wire($("#notes"));
  for (const b of document.querySelectorAll("[data-note-retire]")) b.onclick = () => act("POST", `/notes/${b.dataset.noteRetire}/retire`, {});
}

// ── decisions ───────────────────────────────────────────────────────────
const KIND = { answer: "Answer", directive: "Directive", review: "Review", ruling: "Ruling", note: "Note", contest: "Contest" };
function renderDecisions() {
  const list = state.decisions ?? [];
  $("#decisions-count").textContent = list.length ? `${list.length} on record` : "";
  $("#decision-add").hidden = !isHuman();
  $("#decisions").innerHTML = list.map((d) => `<li class="card decision"><div class="kicker">${KIND[d.kind] ?? d.kind} #${d.id} · ${esc(d.byName ?? d.by)}${d.paths.length ? ` · <span class="mono">${d.paths.map(esc).join(", ")}</span>` : " · whole project"}</div>${d.question ? `<div class="meta">${esc(d.question)}</div>` : ""}<div>${esc(d.decision)}</div>${isHuman() ? `<button class="ghost mini" data-retire="${d.id}">Retire</button>` : ""}</li>`).join("")
    || `<li class="empty">Nothing decided yet. Answers, directives, objections and rulings land here, and agents get them when they work on the same files.</li>`;
  for (const b of document.querySelectorAll("[data-retire]")) b.onclick = () => act("POST", `/decisions/${b.dataset.retire}/retire`, {});
}
$("#decision-save").onclick = async () => {
  const decision = $("#decision-text").value.trim();
  if (!decision) return;
  await act("POST", "/decisions", { decision, paths: $("#decision-paths").value.split(",").map((p) => p.trim()).filter(Boolean) });
  $("#decision-text").value = "";
  $("#decision-paths").value = "";
};

// ── activity: notable by default, everything on request ────────────────
const NOTABLE = new Set(["change.conflict", "checks.failed", "dispute.opened", "dispute.ruled", "delegate.escalated", "delegate.decided", "directive", "main.frozen", "main.unfrozen",
  "agent.paused", "agent.resumed", "decision.recorded", "settings.key_saved", "settings.key_removed", "member.added", "member.removed", "project.visibility", "question.asked", "question.answered", "consult.requested", "merge.retry", "task.reassigned", "task.assigned",
  "paths.protected", "proposal.made", "proposal.accepted", "proposal.rejected", "collision.forecast", "memory.recalled", "contract.published",
  "contest.ready", "contest.decided", "note.added"]);
// Agent-to-agent chatter: notable in a small swarm, noise in a big one.
const CHATTER = new Set(["collision.forecast", "memory.recalled", "consult.requested", "task.assigned"]);
const isNotable = (e) => NOTABLE.has(e.type) && !(CHATTER.has(e.type) && (state.health?.agents.total ?? 0) > 20);
let showAll = false;
let feedFilter = "";
$("#feed-notable").onclick = () => { showAll = false; $("#feed-notable").className = "on"; $("#feed-all").className = ""; renderFeed(); };
$("#feed-all").onclick = () => { showAll = true; $("#feed-all").className = "on"; $("#feed-notable").className = ""; renderFeed(); };
$("#feed-filter").oninput = (e) => { feedFilter = e.target.value.trim().toLowerCase(); renderFeed(); };
let fedSeq = -1;
function renderFeed() {
  // Re-render only when the view changes; new events are added as they arrive.
  const key = `${showAll}|${feedFilter}`;
  if (renderFeed.key === key && fedSeq >= 0) return;
  renderFeed.key = key;
  $("#feed").innerHTML = "";
  const pool = showAll ? recent : recent.filter(isNotable);
  for (const e of pool.slice(-300)) addEvent(e, false);
  fedSeq = lastSeq;
}
function addEvent(e, isNew) {
  const described = describe(e);
  if (!described) return;
  const [cls, html] = described;
  if (feedFilter && !(`${html} #${e.change_id ?? ""} #${e.task_id ?? ""}`.toLowerCase().includes(feedFilter))) return;
  const li = document.createElement("li");
  li.className = `ev ${cls} ${isNew ? "new" : ""}`;
  li.innerHTML = `<time>${new Date(e.ts).toLocaleTimeString()}</time>${html}`;
  wire(li);
  $("#feed").prepend(li);
  while ($("#feed").children.length > 300) $("#feed").lastChild.remove();
}

// ── finding agents, tasks, changes and files ────────────────────────────
let searchTimer;
$("#search").oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 150); };
$("#search").onkeydown = (e) => { if (e.key === "Escape") { $("#search").value = ""; $("#search-results").hidden = true; } };
document.addEventListener("click", (e) => { if (!e.target.closest(".finder")) $("#search-results").hidden = true; });
async function runSearch() {
  const q = $("#search").value.trim();
  if (!q) { $("#search-results").hidden = true; return; }
  const r = await api(`/search?q=${encodeURIComponent(q)}&limit=8`);
  for (const a of r.agents) names[a.id] = a.name;
  const section = (title, rows) => rows ? `<div class="kicker">${title}</div>${rows}` : "";
  $("#search-results").innerHTML =
    section(`Agents${r.total > r.agents.length ? ` (${r.total}, showing ${r.agents.length})` : ""}`, r.agents.map((a) => `<a class="hit" data-agent="${esc(a.id)}"><span class="dot ${a.state}"></span><b>${esc(a.name)}</b> <span class="meta">${a.state}${a.task ? ` · #${a.task.id} ${esc(a.task.title)}` : ""}</span></a>`).join(""))
    + section("Tasks", r.tasks.map((t) => `<a class="hit" ${t.assignee ? `data-agent="${esc(t.assignee)}"` : ""}>#${t.id} ${esc(t.title)} <span class="meta">${t.status}${t.assigneeName ? ` · ${esc(t.assigneeName)}` : ""}</span></a>`).join(""))
    + section("Changes", r.changes.map((c) => `<a class="hit" data-change="${c.id}">#${c.id} ${esc(c.title)} <span class="meta">${c.status} · ${esc(c.agentName)}</span></a>`).join(""))
    || `<p class="empty">Nothing matches “${esc(q)}”.</p>`;
  $("#search-results").hidden = false;
  wire($("#search-results"));
  for (const a of $("#search-results").querySelectorAll("a")) a.addEventListener("click", () => ($("#search-results").hidden = true));
}

async function showDirectory(st) {
  const r = await api(`/search?state=${encodeURIComponent(st)}&limit=200`);
  for (const a of r.agents) names[a.id] = a.name;
  $("#detail-body").innerHTML = `<h3>${r.total} agent${r.total === 1 ? "" : "s"} ${esc((STATES.find(([k]) => k === st) ?? [, st])[1])}</h3>
    <table class="dir"><thead><tr><th>Agent</th><th>Task</th><th>Last seen</th></tr></thead><tbody>
    ${r.agents.map((a) => `<tr><td>${who(a.id)}</td><td>${a.task ? `#${a.task.id} ${esc(a.task.title)}` : `<span class="meta">none</span>`}</td><td>${ago(a.lastSeen)} ago</td></tr>`).join("")}</tbody></table>
    ${r.total > r.agents.length ? `<p class="meta">Showing ${r.agents.length} of ${r.total}. Search to narrow it down.</p>` : ""}`;
  wire($("#detail-body"));
  if (!$("#detail").open) $("#detail").showModal();
}

async function showAgent(id) {
  const p = await api(`/agents/${encodeURIComponent(id)}`);
  if (p.error) return toast(p.error);
  const a = p.agent;
  names[a.id] = a.name;
  const ctl = isHuman() && a.role !== "human" ? `<div class="row">
      <button data-op="${a.state === "paused" ? "resume" : "pause"}" class="${a.state === "paused" ? "" : "ghost"}">${a.state === "paused" ? "Resume" : "Pause"}</button>
      <input id="dm-body" placeholder="Directive to ${esc(a.name)} only"><button id="dm-send" class="ghost">Send</button></div>` : "";
  $("#detail-body").innerHTML = `
    <h3><span class="dot ${a.state}"></span> ${esc(a.name)} <span class="role">${a.role}</span> <span class="pill">${a.state}</span></h3>
    <p class="meta">Last active ${ago(a.lastSeen)} ago${a.task ? ` · working on #${a.task.id} ${esc(a.task.title)} (${a.task.status})` : ""}</p>
    ${p.trust ? `<div class="card"><div class="qrow"><b class="grow">Track record</b><span class="pill" title="what this agent's approvals and contest votes count for">${p.trust.weight}× vote</span></div><div class="meta">${esc(p.trust.summary)}</div></div>` : ""}
    ${ctl}
    <div id="agent-grid" class="card contrib-card"></div>
    ${p.knows.length ? `<h2>Knows</h2><div class="knows">${p.knows.map((k) => `<div><span class="mono">${esc(k.path)}</span> <span class="meta">${[k.wrote && `wrote ×${k.wrote}`, k.reviewed && `reviewed ×${k.reviewed}`].filter(Boolean).join(", ")}${k.symbols.length ? ` · ${k.symbols.slice(0, 6).map(esc).join(", ")}${k.symbols.length > 6 ? "…" : ""}` : ""}</span></div>`).join("")}</div>` : ""}
    ${p.reviewQueue.length || p.reviewStats.approved + p.reviewStats.changesRequested ? `<h2>Reviews <small>${p.reviewStats.approved} approved · ${p.reviewStats.changesRequested} sent back${p.reviewStats.medianResponseMs != null ? ` · answers requests in ${dur(p.reviewStats.medianResponseMs)} (median)` : ""}</small></h2>
      ${p.reviewQueue.map((r) => `<div class="qrow"><a data-change="${r.change_id}">#${r.change_id}</a> <span class="grow ellipsis">${esc(r.title)}</span><span class="meta">asked by ${esc(r.requestedByName)} ${ago(r.created_at)} ago · ${esc(r.reason ?? "")}</span></div>`).join("")}` : ""}
    ${p.intents.length ? `<h2>Declared intents</h2>${p.intents.map((i) => `<div><span class="mono">${i.paths.map(esc).join(", ")}</span> ${esc(i.description)}</div>`).join("")}` : ""}
    ${p.changes.length ? `<h2>Changes</h2>${p.changes.map((c) => `<div class="qrow"><a data-change="${c.id}">#${c.id}</a> <span class="grow ellipsis">${esc(c.title)}</span><span class="pill ${c.status}">${c.status}</span></div>`).join("")}` : ""}
    ${p.tasks.length && isHuman() ? `<h2>Tasks</h2>${p.tasks.map((t) => `<div class="qrow">#${t.id} <span class="grow ellipsis">${esc(t.title)}</span><span class="meta">${t.status}</span>${t.status !== "merged" ? `<button class="ghost mini" data-reassign="${t.id}">Reassign…</button>` : ""}</div>`).join("")}` : ""}
    ${p.threads.length ? `<h2>Conversations</h2>${p.threads.map((t) => `<div class="post"><span class="meta">${t.kind} · ${t.status}</span> ${esc(t.title)}</div>`).join("")}` : ""}
    <h2>Recent activity</h2><ol class="feed">${p.events.map((e) => { const d = describe(e); return d ? `<li class="ev ${d[0]}"><time>${new Date(e.ts).toLocaleTimeString()}</time>${d[1]}</li>` : ""; }).join("")}</ol>`;
  wire($("#detail-body"));
  renderGrid($("#agent-grid"), a.id);
  for (const b of $("#detail-body").querySelectorAll("[data-op]")) b.onclick = async () => {
    const reason = b.dataset.op === "pause" ? prompt(`Why pause ${a.name}? (they will see this)`) : undefined;
    if (b.dataset.op === "pause" && reason === null) return;
    await act("POST", `/agents/${a.id}/${b.dataset.op}`, { reason });
    showAgent(a.id);
  };
  if ($("#dm-send")) $("#dm-send").onclick = async () => {
    if (!$("#dm-body").value.trim()) return;
    await act("POST", "/directives", { to: a.id, body: $("#dm-body").value.trim() });
    $("#dm-body").value = "";
    toast(`Sent to ${a.name}`);
  };
  for (const b of $("#detail-body").querySelectorAll("[data-reassign]")) b.onclick = async () => {
    const to = prompt("Hand this task, with its workspace and context, to which agent? (name or id; blank to put it back on the board)");
    if (to === null) return;
    let target = null;
    if (to.trim()) {
      const r = await api(`/search?q=${encodeURIComponent(to.trim())}&limit=1`);
      target = r.agents[0]?.id;
      if (!target) return toast(`No agent “${to}”`);
    }
    await act("POST", `/tasks/${b.dataset.reassign}/assign`, { agent: target, note: `Reassigned from ${a.name}` });
    showAgent(a.id);
  };
  if (!$("#detail").open) $("#detail").showModal();
}

// ── contribution grid, in the GitHub style ──────────────────────────────
// Seven rows of squares, oldest at the top left, shaded by how much happened.
// A project older than a week gets GitHub's year of days; a younger one gets
// squares a few minutes wide, so the grid has something to show on day one.
const KINDS = { all: "All", commits: "Commits", changes: "Changes", reviews: "Reviews" };
const PER = { commits: ["commit", "commits"], changes: ["change", "changes"], reviews: ["review", "reviews"] };
const plural = (n, [one, many]) => `${n} ${n === 1 ? one : many}`;
const unitName = (ms) => ms >= 86400_000 ? "day" : ms >= 3600_000 ? `${ms / 3600_000} hour${ms > 3600_000 ? "s" : ""}` : ms >= 60_000 ? `${ms / 60_000} minute${ms > 60_000 ? "s" : ""}` : `${ms / 1000} seconds`;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function gridHtml(act, kind) {
  const count = (c) => kind === "all" ? c.commits + c.changes + c.reviews : c[kind];
  const vals = act.cells.map(count);
  const max = Math.max(0, ...vals);
  const level = (v) => (v ? Math.max(1, Math.ceil((v / max) * 4)) : 0);
  const year = act.range === "year";
  const S = 11, G = 3, top = 16, left = year ? 28 : 4;
  const cols = Math.ceil(act.cells.length / 7);
  const w = left + cols * (S + G), h = top + 7 * (S + G);
  const when = (t) => year
    ? new Date(t).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
    : `${new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  let cells = "", labels = "";
  act.cells.forEach((c, i) => {
    const col = Math.floor(i / 7), row = i % 7;
    const t = act.start + i * act.bucketMs;
    if (t > act.now) return;
    const v = vals[i];
    const parts = Object.keys(PER).filter((k) => c[k] && (kind === "all" || kind === k)).map((k) => plural(c[k], PER[k]));
    const tip = `${parts.length ? parts.join(", ") : `No ${kind === "all" ? "contributions" : KINDS[kind].toLowerCase()}`} ${year ? "on" : "at"} ${when(t)}`;
    cells += `<rect x="${left + col * (S + G)}" y="${top + row * (S + G)}" width="${S}" height="${S}" rx="2" class="gc g${level(v)}"><title>${esc(tip)}</title></rect>`;
  });
  // Column labels: months for a year, clock times for a young project.
  let last = "";
  for (let col = 0; col < cols; col++) {
    const t = act.start + col * 7 * act.bucketMs;
    const label = year ? MONTHS[new Date(t).getMonth()] : new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (label !== last && (year || col % 6 === 0)) {
      if (year || col < cols - 3) labels += `<text x="${left + col * (S + G)}" y="10">${label}</text>`;
      last = label;
    }
  }
  if (year) for (const r of [1, 3, 5]) labels += `<text x="0" y="${top + r * (S + G) + 9}">${DAYS[r]}</text>`;
  const total = vals.reduce((a, b) => a + b, 0);
  const sums = Object.fromEntries(Object.keys(PER).map((k) => [k, act.cells.reduce((a, c) => a + c[k], 0)]));
  const all = sums.commits + sums.changes + sums.reviews || 1;
  const span = year ? "in the last year" : `in the last ${dur(act.now - act.start)}`;
  return `
    <div class="grid-head"><b>${total.toLocaleString()}</b> ${kind === "all" ? "contributions" : KINDS[kind].toLowerCase()} ${span}
      <span class="seg" role="tablist">${Object.entries(KINDS).map(([k, l]) => `<button data-kind="${k}" class="${k === kind ? "on" : ""}" role="tab">${l}</button>`).join("")}</span></div>
    <div class="grid-scroll"><svg class="contrib" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${total} contributions ${span}">${labels}${cells}</svg></div>
    <div class="grid-foot">
      <span class="meta">${Object.keys(PER).map((k) => `${KINDS[k]} ${Math.round((sums[k] / all) * 100)}%`).join(" · ")}${year ? "" : ` · each square is ${unitName(act.bucketMs)}`}</span>
      <span class="legend meta">Less ${[0, 1, 2, 3, 4].map((l) => `<i class="gc g${l}"></i>`).join("")} More</span>
    </div>`;
}

/** Render a contribution grid into el, for one agent or (no agent) the whole project. */
async function renderGrid(el, agent, kind = "all") {
  const act = await api(`/activity${agent ? `?agent=${encodeURIComponent(agent)}` : ""}`);
  if (act.error) return;
  el.innerHTML = gridHtml(act, el.dataset.kind ?? kind);
  wireGrid(el, act);
}
function wireGrid(el, data) {
  for (const b of el.querySelectorAll("[data-kind]")) b.onclick = () => { el.dataset.kind = b.dataset.kind; el.innerHTML = gridHtml(data, b.dataset.kind); wireGrid(el, data); };
  const sc = el.querySelector(".grid-scroll");
  sc.scrollLeft = sc.scrollWidth;
}

// ── history: what was committed and pushed, and how it reached main ─────
function historyHtml(h, isMain, landed = false) {
  if (h.error) return `<p class="meta">${esc(h.error)}</p>`;
  if (!h.commits.length) return `<p class="meta">${isMain ? "No commits yet." : "Nothing committed on top of main yet."}</p>`;
  const row = (c) => {
    const [subject, ...rest] = c.message.split("\n");
    const by = c.agent ? `<a class="who" data-agent="${esc(c.agent)}" style="color:${color(c.agent)}">${esc(c.author)}</a>` : esc(c.author);
    const kind = c.merge ? `<span class="pill merged">merge</span>` : c.change ? `<span class="pill merged">landed</span>` : "";
    return `<details class="commit"><summary><span class="mono sha">${c.oid.slice(0, 7)}</span> ${kind} <span class="grow ellipsis">${esc(subject)}</span>
        ${c.change ? `<a data-change="${c.change.id}">#${c.change.id}</a>` : ""} <span class="meta">${by} · ${ago(c.at)} ago · ${c.fileCount} file${c.fileCount === 1 ? "" : "s"}</span></summary>
      ${rest.join("\n").trim() ? `<pre class="msg">${esc(rest.join("\n").trim())}</pre>` : ""}
      <div class="files mono">${c.files.map((f) => `<span class="fs ${f.status}">${f.status === "added" ? "+" : f.status === "deleted" ? "−" : "~"} ${esc(f.path)}</span>`).join("")}${c.fileCount > c.files.length ? ` …` : ""}</div>
      ${c.parents.length > 1 ? `<div class="meta">parents ${c.parents.map((p) => p.slice(0, 7)).join(" + ")}: main as it was, and the change's own commits</div>` : ""}</details>`;
  };
  return `<p class="meta">${isMain
    ? "Main only moves through the merge queue. Each approved change lands as a merge commit (or a fast-forward), so the commits its author pushed stay in history underneath it."
    : landed ? "How this change landed: the merge queue's commit on main, and underneath it the commits its author pushed to their workspace."
    : "What was committed to this workspace on top of main: by API (write_files) or a plain git push. The merge queue lands these on main once the change is approved."}</p>
    <div class="commits">${h.commits.map(row).join("")}</div>`;
}

// ── code: browse, download and check out, for people ──────────────────
async function showClone(box, target) {
  if (!me) { box.innerHTML = `<p class="meta">Sign in to get a clone command; it carries a read-only token for an hour.</p>`; return; }
  const r = await act("POST", "/checkout", target);
  if (!r || r.error) return;
  box.innerHTML = `<pre class="diff copy">${esc(r.clone)}${r.compare ? `\n${esc(r.compare)}` : ""}</pre><p class="meta">${esc(r.note)} <button class="ghost mini" id="copy-clone">Copy</button></p>`;
  $("#copy-clone").onclick = () => navigator.clipboard?.writeText(r.clone + (r.compare ? `\n${r.compare}` : "")).then(() => toast("Copied"));
}
async function showCode(target = {}) {
  const q = target.change ? `change=${target.change}` : target.workspace ? `workspace=${encodeURIComponent(target.workspace)}` : "";
  const list = await api(`/files?${q}`);
  if (list.error) return toast(list.error);
  $("#detail-body").innerHTML = `
    <h3>Code <small class="meta">${esc(target.label ?? `main · v${state.project.mainVersion}`)}</small></h3>
    <div class="row code-row"><a class="button ghost mini" href="/api/projects/${project}/archive?${q}${keyQuery()}" download>Download zip</a><button class="ghost mini" id="code-clone">Clone with git</button>${target.change ? `<button class="ghost mini" data-change="${target.change}">Back to the change</button>` : ""}</div>
    <div id="code-clone-box"></div>
    <span class="seg" role="tablist"><button id="tab-files" class="on" role="tab">Files</button><button id="tab-history" role="tab">History</button></span>
    <div id="history" hidden></div>
    <div class="code-view">
      <div class="tree"><input id="tree-filter" placeholder="Filter ${list.files.length} files"><ol id="tree"></ol></div>
      <pre id="file" class="diff"><span class="meta">Pick a file.</span></pre>
    </div>`;
  const draw = (f) => { $("#tree").innerHTML = list.files.filter((p) => p.toLowerCase().includes(f)).slice(0, 500).map((p) => `<li><a data-path="${esc(p)}">${esc(p)}</a></li>`).join(""); };
  draw("");
  $("#tree-filter").oninput = (e) => draw(e.target.value.trim().toLowerCase());
  $("#tree").onclick = async (e) => {
    const a = e.target.closest("[data-path]");
    if (!a) return;
    for (const x of $("#tree").querySelectorAll(".on")) x.classList.remove("on");
    a.classList.add("on");
    const f = await api(`/files?${q}&path=${encodeURIComponent(a.dataset.path)}`);
    $("#file").textContent = f.error ?? f.content;
  };
  $("#tab-files").onclick = () => { $("#tab-files").className = "on"; $("#tab-history").className = ""; $("#history").hidden = true; $(".code-view").hidden = false; };
  $("#tab-history").onclick = async () => {
    $("#tab-history").className = "on"; $("#tab-files").className = ""; $(".code-view").hidden = true; $("#history").hidden = false;
    $("#history").innerHTML = `<p class="meta">Reading history…</p>`;
    $("#history").innerHTML = historyHtml(await api(`/commits?${q}`), !target.change && !target.workspace);
    wire($("#history"));
  };
  $("#code-clone").onclick = () => showClone($("#code-clone-box"), target.change ? { change: target.change } : target.workspace ? { workspace: target.workspace } : {});
  wire($("#detail-body"));
  if (!$("#detail").open) $("#detail").showModal();
}
$("#code-open").onclick = () => showCode();

// ── connect an agent: the Loom skill, ready to copy ──────────────────────
async function showSkill(joinCode) {
  const text = await fetch(`/api/projects/${project}/skill${joinCode ? `?code=${encodeURIComponent(joinCode.code)}` : ""}`, { headers: keyHeader() }).then((r) => r.text());
  const codes = isOwner() ? await api("/join-codes").catch(() => []) : [];
  const save = `mkdir -p .claude/skills/loom-${project} && curl -s "${location.origin}/api/projects/${project}/skill${joinCode ? `?code=${encodeURIComponent(joinCode.code)}` : ""}" > .claude/skills/loom-${project}/SKILL.md`;
  $("#detail-body").innerHTML = `
    <h3>Connect an agent</h3>
    ${joinCode ? `<div class="card"><b>This skill carries a join code</b> <span class="role">${esc(joinCode.role)}</span><p class="meta">Any agent you give it registers itself once and saves its own key, up to ${joinCode.maxUses} agents until ${new Date(joinCode.expiresAt).toLocaleString()}. The code is shown only now; revoke it below to stop new agents joining.</p></div>`
      : `<p class="meta">Give an agent this skill. It covers how to work here and how to check back for new work, which matters because agents come and go. ${isOwner() ? "To let agents register themselves, create a join code: the skill then carries it, and each agent trades it for its own key." : "Each agent needs its own key or a join code from an owner."}</p>`}
    <div class="row code-row"><button id="skill-copy">Copy skill</button><button class="ghost" id="skill-copy-cmd">Copy install command</button></div>
    <pre class="diff copy">${esc(save)}</pre>
    ${isOwner() ? `<h2>Let agents register themselves</h2>
    <div class="row"><select id="jc-role"><option value="builder">builders</option><option value="reviewer">reviewers</option></select><input id="jc-max" type="number" min="1" max="10000" value="50" title="How many agents may join with it"><span class="meta">agents, for</span><input id="jc-hours" type="number" min="1" max="2160" value="72" title="Hours until it expires"><span class="meta">hours</span><button id="jc-go">Create join code</button></div>
    ${codes.map((c) => `<div class="qrow"><span class="grow">#${c.id} ${esc(c.label ?? "")} <span class="role">${esc(c.role)}</span> <span class="meta">${c.uses}/${c.maxUses} joined${c.agents.length ? `: ${c.agents.map((a) => esc(a.name)).join(", ")}` : ""} · ${c.revoked ? "revoked" : c.live ? `until ${new Date(c.expiresAt).toLocaleDateString()}` : "expired or used up"}</span></span>${c.live ? `<button class="ghost mini" data-jc-revoke="${c.id}">Revoke</button>` : ""}</div>`).join("")}` : ""}
    <h2>Create a key</h2>
    ${isOwner() ? `<div class="row"><input id="mk-name" placeholder="Agent name, e.g. builder-7"><select id="mk-role"><option value="builder">builder</option><option value="reviewer">reviewer</option></select><button class="ghost" id="mk-go">Create</button></div>
    <div id="mk-out"></div>` : `<p class="meta">${me ? "Only the project's owners can create agent keys." : "Sign in as one of the project's owners to create agent keys."} People don't need keys: they sign in with GitHub and are added in Settings.</p>`}
    <h2>The skill</h2>
    <pre class="diff copy skill">${esc(text)}</pre>`;
  if ($("#mk-go")) $("#mk-go").onclick = async () => {
    const n = $("#mk-name").value.trim();
    if (!n) return;
    try {
      const k = await act("POST", "/agents", { name: n, role: $("#mk-role").value });
      $("#mk-out").innerHTML = keyBox(k, project);
      wireCopy($("#mk-out"));
    } catch {}
  };
  if ($("#jc-go")) $("#jc-go").onclick = async () => {
    try {
      const code = await act("POST", "/join-codes", { role: $("#jc-role").value, maxUses: Number($("#jc-max").value), expiresInHours: Number($("#jc-hours").value) });
      showSkill(code);
    } catch {}
  };
  for (const b of $("#detail-body").querySelectorAll("[data-jc-revoke]")) b.onclick = async () => {
    if (!confirm("Revoke this join code? Agents that already joined keep their keys.")) return;
    try { await act("DELETE", `/join-codes/${b.dataset.jcRevoke}`); } catch { return; }
    showSkill(joinCode);
  };
  $("#skill-copy").onclick = () => navigator.clipboard?.writeText(text).then(() => toast("Skill copied"));
  $("#skill-copy-cmd").onclick = () => navigator.clipboard?.writeText(save).then(() => toast("Command copied"));
  if (!$("#detail").open) $("#detail").showModal();
}
$("#skill-open").onclick = () => showSkill();

// ── new projects ────────────────────────────────────────────────────────
const keyBox = (k, proj) => `<div class="card"><b>Key for ${esc(k.name)}</b> <span class="role">${k.role}</span>
  <pre class="diff copy">export LOOM_KEY=${esc(k.key)}</pre>
  <p class="meta">Shown once: Loom keeps only its hash. Give it to the agent with the skill from <b>Connect an agent</b>; it works only on ${esc(proj)}.</p>
  <button class="ghost mini" data-copy="${esc(k.key)}">Copy key</button></div>`;
function wireCopy(root) { for (const b of root.querySelectorAll("[data-copy]")) b.onclick = () => navigator.clipboard?.writeText(b.dataset.copy).then(() => toast("Copied")); }

function showNewProject() {
  if (!user) return showSignIn("Sign in with GitHub to create a project. You'll own it.");
  $("#detail-body").innerHTML = `
    <h3>New project</h3>
    <p class="meta">A project is one repository with its own agents, people, tasks and merge queue. You'll be its owner, signed in as <b>${esc(user.login)}</b>.</p>
    <label>Name <input id="np-name" placeholder="lowercase-with-dashes" pattern="[a-z0-9-]+"></label>
    <label>Description <input id="np-desc" placeholder="What is being built"></label>
    <label class="check"><input id="np-review" type="checkbox" checked> Changes need one approval before they merge</label>
    <label class="check"><input type="radio" name="np-vis" value="public" checked> Public: anyone can see the work; only members act</label>
    <label class="check"><input type="radio" name="np-vis" value="private"> Private: only members and the project's agents can see it</label>
    <div class="row"><button id="np-create">Create project</button></div>`;
  $("#np-create").onclick = async () => {
    const name = $("#np-name").value.trim();
    if (!/^[a-z0-9-]+$/.test(name)) return toast("Name: lowercase letters, digits and dashes");
    const res = await fetch("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, description: $("#np-desc").value.trim(), requiredApprovals: $("#np-review").checked ? 1 : 0, visibility: $('input[name="np-vis"]:checked').value }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return toast(data.error ?? `HTTP ${res.status}`);
    location.search = `?project=${name}`;
  };
  if (!$("#detail").open) $("#detail").showModal();
}
$("#np-open").onclick = () => showNewProject();

// ── settings: keys people bring for this project ────────────────────────
async function showSettings() {
  if (!isHuman()) return showSignIn("Settings hold this project's people and keys, so only its members can see them.");
  let s, people;
  try { [s, people] = await Promise.all([act("GET", "/settings/keys"), act("GET", "/members")]); } catch { return; }
  const vis = state?.project?.visibility ?? "public";
  const when = (t) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  $("#detail-body").innerHTML = `
    <h3>Settings · ${esc(project)}</h3>
    <h2>Visibility</h2>
    <p class="meta">${vis === "private" ? "<b>Private.</b> Only members, owners and the project's agents can see it; to everyone else it doesn't exist." : "<b>Public.</b> Anyone can see the work. Only members can act on it."}</p>
    ${isOwner() ? `<div class="row"><button class="ghost" id="vis-toggle">Make it ${vis === "private" ? "public" : "private"}</button></div>` : ""}
    <h2>Approvals</h2>
    <p class="meta">${state?.project?.approvalMode === "count" ? "<b>Counted.</b> Every approval counts for one." : "<b>Weighted by track record.</b> An agent's approval counts for more when its earlier approvals and votes held up, and for less when they didn't. A newcomer's counts for one; a person's always does."} A change needs ${state?.project?.requiredApprovals ?? 1}.</p>
    ${isOwner() ? `<div class="row"><button class="ghost" id="mode-toggle">${state?.project?.approvalMode === "count" ? "Weigh approvals by track record" : "Count every approval as one"}</button></div>` : ""}
    <h2>Checks</h2>
    <p class="meta">${state?.project?.checks ? `Before anything lands, the merge queue runs <span class="mono">${esc(state.project.checks.command)}</span> on main with the change in it, in a container. A change that fails goes back to its author with the output, like a conflict.` : "No checks yet. Set a command (for example <span class=\"mono\">npm ci && npm test</span>) and the merge queue runs it on main with each change before main moves."}</p>
    ${isOwner() ? `<div class="row"><input id="checks-cmd" class="mono grow" placeholder="npm ci && npm test" value="${esc(state?.project?.checks?.command ?? "")}"><button class="ghost" id="checks-save">Save</button></div>` : ""}
    <h2>People</h2>
    <p class="meta">People sign in with GitHub. Members can answer agents, review, steer and manage keys; owners can also add people and create agent keys.</p>
    ${people.map((p) => `<div class="qrow"><span class="grow">${esc(p.login)}</span><span class="role">${p.owner ? "owner" : "member"}</span><span class="meta">${p.lastSeen ? `seen ${ago(p.lastSeen)}` : "hasn't signed in yet"}</span>${isOwner() && p.id !== me.id ? `<button class="ghost mini" data-member-remove="${p.id}">Remove</button>` : ""}</div>`).join("")}
    ${isOwner() ? `<div class="row"><input id="mem-login" placeholder="GitHub login, e.g. octocat"><label class="check"><input id="mem-owner" type="checkbox"> Owner</label><button class="ghost" id="mem-add">Add</button></div>` : ""}
    <h2>Keys</h2>
    <p class="meta">Bring your own keys for this project. Loom encrypts them before storing and never shows them again; you'll only see the last four characters. ${s.jevUses ? `Jev judges with <b>${esc(s.jevUses)}</b>.` : "Jev has no key yet, so it applies only house rules and earlier decisions."}</p>
    ${s.canSave ? "" : `<p class="warn">This server can't store keys yet: set the <span class="mono">LOOM_SECRET_KEY</span> Worker secret.</p>`}
    ${s.keys.map((k) => `<div class="card key-card">
      <div class="row"><b class="grow">${esc(k.label)}</b>${k.saved ? `<span class="pill mono">…${esc(k.saved.last4)}</span>` : k.serverKey ? `<span class="pill">server key</span>` : `<span class="pill">not set</span>`}</div>
      <div class="meta">${esc(k.uses)}${k.saved ? ` Saved by ${esc(k.saved.setByName)} on ${when(k.saved.setAt)}.` : k.serverKey ? " The server has one; a project key takes its place." : ""}</div>
      ${k.saved && !k.saved.readable ? `<div class="warn">The secret that sealed this key is gone, so it can't be read. Save it again.</div>` : ""}
      <div class="row"><input type="password" autocomplete="off" data-key-input="${k.kind}" placeholder="${esc(k.hint)}"><button data-key-save="${k.kind}" ${s.canSave ? "" : "disabled"}>${k.saved ? "Replace" : "Save"}</button>${k.saved ? `<button class="ghost" data-key-remove="${k.kind}">Remove</button>` : ""}</div>
    </div>`).join("")}`;
  for (const b of $("#detail-body").querySelectorAll("[data-key-save]")) b.onclick = async () => {
    const input = $(`[data-key-input="${b.dataset.keySave}"]`);
    if (!input.value.trim()) return;
    try { await act("PUT", `/settings/keys/${b.dataset.keySave}`, { value: input.value.trim() }); } catch { return; }
    toast("Key saved");
    showSettings();
  };
  if ($("#vis-toggle")) $("#vis-toggle").onclick = async () => {
    const to = vis === "private" ? "public" : "private";
    if (!confirm(to === "private" ? "Make this project private? Only members and its agents will see it." : "Make this project public? Anyone will be able to see its work.")) return;
    try { const r = await act("POST", "/settings", { visibility: to }); state.project.visibility = r.visibility; } catch { return; }
    toast(`${project} is now ${to}`);
    showSettings();
  };
  if ($("#mode-toggle")) $("#mode-toggle").onclick = async () => {
    try { const r = await act("POST", "/settings", { approvalMode: state.project.approvalMode === "count" ? "weighted" : "count" }); state.project.approvalMode = r.approvalMode; } catch { return; }
    showSettings();
  };
  if ($("#checks-save")) $("#checks-save").onclick = async () => {
    try { const r = await act("POST", "/settings", { checks: { command: $("#checks-cmd").value } }); state.project.checks = r.checks; } catch { return; }
    toast(state.project.checks ? "Checks saved" : "Checks turned off");
    showSettings();
  };
  if ($("#mem-add")) $("#mem-add").onclick = async () => {
    const login = $("#mem-login").value.trim();
    if (!login) return;
    try { await act("POST", "/members", { login, owner: $("#mem-owner").checked }); } catch { return; }
    toast(`Added ${login}. They sign in with GitHub.`);
    showSettings();
  };
  for (const b of $("#detail-body").querySelectorAll("[data-member-remove]")) b.onclick = async () => {
    if (!confirm("Remove this person from the project?")) return;
    try { await act("DELETE", `/members/${b.dataset.memberRemove}`); } catch { return; }
    showSettings();
  };
  for (const b of $("#detail-body").querySelectorAll("[data-key-remove]")) b.onclick = async () => {
    if (!confirm("Remove this key? Jev falls back to the server's key, or to house rules only.")) return;
    try { await act("DELETE", `/settings/keys/${b.dataset.keyRemove}`); } catch { return; }
    toast("Key removed");
    showSettings();
  };
  if (!$("#detail").open) $("#detail").showModal();
}
$("#settings-open").onclick = () => showSettings();

// ── my work: people claim tasks, push with git, and submit like agents ───
async function showWork(note = "") {
  if (!me) return toast("Sign in first");
  const [p, open] = await Promise.all([api(`/agents/${encodeURIComponent(me.id)}`), api("/tasks?status=open&limit=30")]);
  const mine = (p.tasks ?? []).filter((t) => !["merged", "abandoned"].includes(t.status));
  const ready = open.filter((t) => !t.depends_on.length);
  $("#detail-body").innerHTML = `
    <h3>My work</h3>
    <p class="meta">You work like an agent does: take a task, clone its workspace, push your commits, submit. Reviews, conflicts and the merge queue treat you the same.</p>
    ${note}
    <h2>Your tasks</h2>
    ${mine.length ? mine.map((t) => `<div class="card work"><div class="qrow">#${t.id} <span class="grow ellipsis">${esc(t.title)}</span><span class="meta">${t.status}</span></div>
      <div class="row"><button class="ghost mini" data-push="${t.id}">Clone and push</button><button class="ghost mini" data-submit="${t.id}">Submit for review</button><button class="ghost mini" data-release="${t.id}">Release</button></div>
      <div id="work-${t.id}"></div></div>`).join("") : `<p class="meta">None yet.</p>`}
    <h2>Open tasks <small>${ready.length} ready</small></h2>
    ${ready.length ? ready.map((t) => `<div class="qrow">#${t.id} <span class="grow ellipsis">${esc(t.title)}</span><button class="mini" data-take="${t.id}">Take it</button></div>`).join("") : `<p class="meta">Nothing open.</p>`}
    <h2>New task</h2>
    <input id="nt-title" placeholder="Title" style="width:100%"><textarea id="nt-desc" rows="2" placeholder="What needs doing" style="width:100%;margin-top:6px"></textarea>
    <div class="row"><button class="ghost" id="nt-add">Add to the board</button><button id="nt-take">Add and take it</button></div>`;
  const pushInfo = (r) => `<pre class="diff copy">${esc(r.git.clone)}\ncd work\n# edit, commit, then:\ngit -c http.extraHeader="Authorization: Bearer ${esc(r.workspace.token)}" push origin HEAD:main</pre><p class="meta">The workspace is yours alone; main changes only through the merge queue.</p>
    <div class="row"><input data-intent="${r.task.id}" placeholder="Files you'll touch, e.g. src/db.js, docs/**" style="flex:1"><button class="ghost mini" data-declare="${r.task.id}">Declare</button></div>
    <p class="meta">Declaring warns agents headed for the same files, and tells you what was already decided about them.</p>`;
  $("#detail-body").onclick = async (e) => {
    const b = e.target.closest("[data-declare]");
    if (!b) return;
    const paths = listOf($(`[data-intent="${b.dataset.declare}"]`).value);
    if (!paths.length) return;
    const r = await act("POST", "/intents", { taskId: Number(b.dataset.declare), paths, description: `${me.name} works on ${paths.join(", ")}` });
    b.outerHTML = `<span class="meta">Declared. ${esc([r.advice].flat().filter(Boolean).join(" "))}</span>`;
  };
  for (const b of $("#detail-body").querySelectorAll("[data-take]")) b.onclick = async () => {
    const r = await act("POST", `/tasks/${b.dataset.take}/claim`);
    showWork(`<div class="card"><b>Task #${r.task.id} is yours.</b>${pushInfo(r)}</div>`);
  };
  for (const b of $("#detail-body").querySelectorAll("[data-push]")) b.onclick = async () => {
    const r = await act("POST", `/tasks/${b.dataset.push}/claim`);
    $(`#work-${b.dataset.push}`).innerHTML = pushInfo(r);
  };
  for (const b of $("#detail-body").querySelectorAll("[data-submit]")) b.onclick = () => {
    const box = $(`#work-${b.dataset.submit}`);
    box.innerHTML = `<input placeholder="Summary of the change" style="width:100%"><div class="row"><button class="mini">Submit</button></div>`;
    box.querySelector("button").onclick = async () => {
      const ch = await act("POST", "/changes", { taskId: Number(b.dataset.submit), summary: box.querySelector("input").value.trim() });
      toast(`Submitted #${ch.id}`);
      showChange(ch.id);
    };
  };
  for (const b of $("#detail-body").querySelectorAll("[data-release]")) b.onclick = async () => {
    await act("POST", `/tasks/${b.dataset.release}/release`, { reason: `${me.name} released it` });
    showWork();
  };
  const addTask = async (take) => {
    const title = $("#nt-title").value.trim();
    if (!title) return;
    const t = await act("POST", "/tasks", { title, description: $("#nt-desc").value.trim() });
    if (!take) return showWork(`<p class="meta">Added #${t.id}.</p>`);
    const r = await act("POST", `/tasks/${t.id}/claim`);
    showWork(`<div class="card"><b>Task #${t.id} is yours.</b>${pushInfo(r)}</div>`);
  };
  $("#nt-add").onclick = () => addTask(false);
  $("#nt-take").onclick = () => addTask(true);
  if (!$("#detail").open) $("#detail").showModal();
}
$("#work-open").onclick = () => showWork();

// ── steering ────────────────────────────────────────────────────────────
function renderControls() {
  if (!isHuman()) return;
  const frozen = state.project.frozen;
  $("#freeze").textContent = frozen ? "Unfreeze main" : "Freeze main";
  $("#freeze").className = frozen ? "bad" : "ghost";
  if (document.activeElement !== $("#protect-paths")) $("#protect-paths").value = (state.project.protectedPaths ?? []).join(", ");
}
$("#dir-send").onclick = async () => {
  const body = $("#dir-body").value.trim();
  if (!body) return;
  await act("POST", "/directives", { body });
  $("#dir-body").value = "";
};
$("#dir-to").title = "Directives here go to every agent; open an agent (search) to send one to it alone.";
$("#freeze").onclick = async () => {
  if (state.project.frozen) await act("POST", "/unfreeze", {});
  else await act("POST", "/freeze", { reason: prompt("Why freeze main?") ?? "" });
};
$("#protect-save").onclick = async () => {
  await act("POST", "/protect", { paths: $("#protect-paths").value.split(",").map((p) => p.trim()).filter(Boolean) });
  toast("Protected paths saved");
};

setInterval(() => state && renderHealth(), 15_000);

// ── event descriptions ───────────────────────────────────────────────────

function describe(e) {
  const d = e.data ?? {};
  const who = e.actor ? `<a class="who" data-agent="${esc(e.actor)}" style="color:${color(e.actor)}">${esc(name(e.actor))}</a>` : "<b>loom</b>";
  const to = e.to_agent ? `<a class="who" data-agent="${esc(e.to_agent)}" style="color:${color(e.to_agent)}">${esc(name(e.to_agent))}</a>` : "";
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
    case "review.assigned": return ["review", `${who} asked ${to} to review #${e.change_id}${d.reason ? ` (${esc(d.reason)})` : ""}${d.note ? `: “${esc(d.note.slice(0, 140))}”` : ""}`];
    case "review.accepted": return ["review", `${who} accepted the review of #${e.change_id}`];
    case "review.declined": return ["review", `${who} declined to review #${e.change_id}${d.reason ? `: “${esc(d.reason)}”` : ""}`];
    case "review.rerouted": return ["review", `Review of #${e.change_id} rerouted: ${esc(d.why)}${d.toName ? `; asked ${esc(d.toName)}` : "; nobody else knows this code, so it waits for the reviewer pool"}`];
    case "review.requested": return ["review", `Review requested on #${e.change_id}`];
    case "review.submitted": return ["review", `${who} ${d.verdict === "approve" ? "approved" : d.verdict === "request_changes" ? "requested changes on" : "commented on"} #${e.change_id}${d.body ? `: “${esc(d.body.slice(0, 140))}”` : ""}`];
    case "change.queued": return ["", `#${e.change_id} entered the merge queue (position ${d.position})`];
    case "merge.started": return ["", `Merging #${e.change_id}…`];
    case "change.merged": return ["merged", `${who}'s change #${e.change_id} landed on main <span class="mono">${(d.commit ?? "").slice(0, 7)}</span> (v${d.version})`];
    case "workspace.conflict": return ["conflict", `Syncing ${to}'s workspace hit a conflict in ${d.conflicts.map((c) => `<span class="mono">${esc(c.path)}</span>${c.causedBy.length ? ` (with ${esc(c.causedBy.join(", "))})` : ""}`).join(", ")}. Hunks sent back for resolution.`];
    case "merge.retry": return ["stale", `Merge of #${e.change_id} will retry: ${esc(d.error)}`];
    case "checks.started": return ["", `Running the checks on main with ${d.changes.map((x) => `#${x}`).join(", ")}: <span class="mono">${esc(d.command)}</span>`];
    case "checks.passed": return ["merged", `Checks passed with #${e.change_id} (${Math.round(d.ms / 100) / 10}s)`];
    case "checks.failed": return ["conflict", `#${e.change_id} fails the checks on main${d.alongside ? ` after ${esc(d.alongside.join(", "))}` : ""} (exit ${d.exitCode}). Sent back to ${to}.`];
    case "checks.ran": return ["", `${who} ran the checks on task #${e.task_id}: ${d.ok ? "pass" : "fail"}`];
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
    case "project.visibility": return ["directive", `${who} made the project ${esc(d.visibility)}`];
    case "member.added": return ["directive", `${who} added ${esc(d.login)} to the project${d.owner ? " as an owner" : ""}`];
    case "member.removed": return ["directive", `${who} removed ${esc(d.login)} from the project`];
    case "settings.key_saved": return ["directive", `${who} saved a ${esc(d.label)} key for the project (…${esc(d.last4)})`];
    case "settings.key_removed": return ["directive", `${who} removed the project's ${esc(d.label)} key`];
    case "delegate.configured": return ["directive", `${who} ${d.enabled ? `set ${esc(d.name)}'s brief: may ${[d.questions?.enabled && "answer questions", d.approvals?.enabled && `approve ${(d.approvals.paths ?? []).map(esc).join(", ") || "nothing"}`].filter(Boolean).join(" and ") || "do nothing yet"}` : `turned ${esc(d.name)} off`}`];
    case "delegate.decided": return ["merged", `${who} ${d.kind === "question" ? `answered for the humans${d.thread ? ` in thread #${d.thread}` : ""}` : d.kind === "dispute" ? `settled dispute #${d.thread}` : `approved #${e.change_id} for the humans`} (${d.via === "jev" ? "Jev's judgment" : d.via === "precedent" ? `earlier decision${d.precedent ? ` #${d.precedent}` : ""}` : "house rule"}): “${esc(d.decision)}”`];
    case "decision.recorded": return ["directive", `Decision #${d.decision} recorded (${esc(d.kind)}, by ${who})${d.paths.length ? ` for <span class="mono">${d.paths.map(esc).join(", ")}</span>` : ""}: “${esc(d.text.slice(0, 140))}”`];
    case "decision.retired": return ["", `${who} retired decision #${d.decision}`];
    case "memory.recalled": return ["message", `${who} recalled ${[d.decisions.length && `${d.decisions.length} decision${d.decisions.length > 1 ? "s" : ""}`, d.notes?.length && `${d.notes.length} note${d.notes.length > 1 ? "s" : ""}`, d.efforts.length && `${d.efforts.length} earlier change${d.efforts.length > 1 ? "s" : ""}`].filter(Boolean).join(" and ")} on <span class="mono">${d.paths.map(esc).join(", ")}</span>${d.consult.length ? `; ${d.consult.map(name).map(esc).join(", ")} worked there and ${d.consult.length > 1 ? "are" : "is"} still around` : ""}`];
    case "consult.requested": return ["message", `${who} consults ${to}${d.path ? ` about <span class="mono">${esc(d.path)}</span>` : ""}: “${esc(d.question)}”`];
    case "dispute.opened": return ["collision", `${who} opened a dispute with ${to}: “${esc(d.question)}”`];
    case "dispute.position": return ["collision", `${who} stated a position in dispute #${d.thread}: “${esc(d.position)}”`];
    case "dispute.ruled": return ["merged", `${who} ruled on dispute #${d.thread}: ${esc(d.ruling)}${d.enforced ? `. ${esc(d.enforced)}` : ""}`];
    case "dispute.ready": case "dispute.ruled.notify": return null;
    case "delegate.escalated": return ["question", `${who} handed ${d.thread ? `${d.kind === "dispute" ? "dispute" : "question"} #${d.thread}` : `#${e.change_id}`} to a person: ${esc(d.reason)}`];
    case "contest.ready": return ["review", `Contest #${e.task_id} “${esc(d.title)}”: ${d.attempts.length} attempts are in (${d.attempts.map((a) => `#${a.change} by ${esc(a.agentName)}`).join(", ")}). <a data-contest="${e.task_id}">Compare</a>`];
    case "contest.voted": return ["review", `${who} voted for #${e.change_id} in contest #${e.task_id} (counts ${d.weight}×): “${esc(d.reason)}”`];
    case "contest.decided": return ["merged", `Contest #${e.task_id} decided: #${d.winner} lands (${esc(d.why)})${d.losers.length ? `; ${d.losers.map((l) => `#${l}`).join(", ")} closed` : ""}. <a data-contest="${e.task_id}">See the attempts</a>`];
    case "change.closed": return ["stale", `#${e.change_id} closed: ${esc(d.reason)}`];
    case "note.added": return ["message", `${who} left a ${esc(d.kind)} note${d.paths.length ? ` on <span class="mono">${d.paths.map(esc).join(", ")}</span>` : ""}: “${esc(d.text.slice(0, 160))}”`];
    case "note.rated": return ["message", `${who} ${d.agree ? "confirmed" : "disputed"} note #${d.note}${d.comment ? `: “${esc(d.comment)}”` : ""}`];
    case "note.retired": return ["", `${who} retired note #${d.note}`];
    case "message": return ["message", `${who}${to ? ` → ${to}` : " → everyone"}: “${esc(d.body)}”`];
    default: return ["", `${esc(e.type)} ${esc(JSON.stringify(d)).slice(0, 120)}`];
  }
}



// Where a review request stands: did the reviewer get it, agree, and deliver?
function requestState(r) {
  const due = r.deadline ? ` · rerouted in ${Math.max(1, Math.ceil((r.deadline - Date.now()) / 60_000))}m` : "";
  const [label, cls] = {
    open: [r.seen_at ? `seen, no answer${due}` : `not picked up yet${due}`, "review"],
    accepted: [`accepted, reviewing${due}`, "queued"],
    declined: ["declined", "abandoned"],
    expired: ["no answer, asked someone else", "conflict"],
    done: ["reviewed", "merged"],
  }[r.status] ?? [r.status, ""];
  return `<span class="pill ${cls}">${label}</span>`;
}

/** A patch as rows with new-file line numbers, review comments under their lines. */
function diffView(patchText, comments, clickable) {
  let path = null, line = 0;
  const rows = [], shown = new Set();
  const at = (p, n) => comments.filter((x) => x.path === p && x.line === n);
  for (const l of patchText.split("\n")) {
    if (l.startsWith("+++ ")) { path = l.slice(4).replace(/^b\//, ""); rows.push(`<div class="dl file">${esc(path === "/dev/null" ? "(deleted)" : path)}</div>`); continue; }
    if (l.startsWith("--- ")) continue;
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
    if (h) { line = Number(h[1]); rows.push(`<div class="dl hunk"><span class="ln"></span><code>${esc(l)}</code></div>`); continue; }
    if (!l && !path) continue;
    const kind = l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : "ctx";
    const n = kind === "del" ? null : line;
    if (n) shown.add(`${path}:${n}`);
    rows.push(`<div class="dl ${kind}${clickable && n ? " can" : ""}" ${n ? `data-path="${esc(path)}" data-line="${n}"` : ""}><span class="ln">${n ?? ""}</span><code>${esc(l)}</code></div>`);
    if (n) for (const x of at(path, n)) rows.push(`<div class="dc ${x.verdict}"><a class="who" data-agent="${esc(x.reviewer)}">${esc(name(x.reviewer))}</a> ${esc(x.body)}</div>`);
    if (kind !== "del") line++;
  }
  // Comments on lines the patch doesn't show.
  const rest = comments.filter((x) => !shown.has(`${x.path}:${x.line}`));
  return `<div class="diffview">${rows.join("")}</div>${rest.length ? `<div class="meta">${rest.map((x) => `<div class="dc">${esc(name(x.reviewer))} on <span class="mono">${esc(x.path)}${x.line ? `:${x.line}` : ""}</span>: ${esc(x.body)}</div>`).join("")}</div>` : ""}`;
}

async function showChange(id) {
  const [c, rv] = await Promise.all([api(`/changes/${id}`), api(`/changes/${id}/reviewers`)]);
  const inReview = ["review", "changes_requested"].includes(c.status);
  const asked = new Set(rv.requested.filter((r) => r.status === "open").map((r) => r.reviewer));
  const reviewers = `${rv.requested.length ? `<h2>Review requests</h2>${rv.requested.map((r) => `<div class="qrow"><a class="who" data-agent="${r.reviewer}">${esc(r.reviewerName)}</a> <span class="grow meta">${r.reason?.startsWith("asked by") ? esc(r.reason) : `${esc(r.reason ?? "")} · asked by ${esc(r.requestedByName)}`}</span>${requestState(r)}</div>`).join("")}` : ""}
    ${inReview && rv.candidates.length ? `<h2>Who knows this code</h2>${rv.candidates.map((k) => `<div class="qrow"><span class="dot ${k.present ? "working" : "away"}"></span><a class="who" data-agent="${k.agent}">${esc(k.name)}</a> <span class="role">${k.role}</span> <span class="grow meta ellipsis">${k.reasons.map(esc).join(" · ")}${k.openReviews ? ` · ${k.openReviews} open` : ""}</span>${isHuman() && !asked.has(k.agent) ? `<button class="ghost mini" data-ask="${k.agent}">Ask</button>` : ""}</div>`).join("")}` : ""}`;
  const canReview = me && !["merged", "abandoned"].includes(c.status) && me.id !== c.agent_id;
  const patch = diffView(c.patch, c.reviews.flatMap((r) => r.comments.map((x) => ({ ...x, reviewer: r.reviewer, verdict: r.verdict }))), canReview);
  $("#detail-body").innerHTML = `
    <h3>#${c.id} ${esc(c.title)} <span class="pill ${c.status}">${c.status}</span></h3>
    <p>By <b>${esc(c.agentName)}</b> for task #${c.task.id} “${esc(c.task.title)}”.</p>
    ${c.contest ? `<div class="card">One of the attempts in contest #${c.contest}. <button class="ghost mini" data-contest="${c.contest}">Compare attempts</button></div>` : ""}
    ${c.approval && inReview ? `<p class="meta">Approval weight ${c.approval.weight} of ${c.approval.needed} needed${c.approval.approvers.length ? `: ${c.approval.approvers.map((a) => `${esc(a.name)} ${a.weight}×`).join(", ")}` : ""}${c.approval.humanNeeded ? ". Touches protected paths, so it also needs a person." : ""}</p>` : ""}
    <div class="row code-row"><button class="ghost mini" data-browse="${c.id}">Browse files</button><a class="button ghost mini" href="/api/projects/${project}/archive?change=${c.id}${keyQuery()}" download>Download zip</a><button class="ghost mini" data-clone="${c.id}">Check out locally</button></div>
    <div id="clone-box"></div>
    ${c.summary ? `<p>${esc(c.summary)}</p>` : ""}
    ${c.checks ? `<h2>Checks <span class="pill ${c.checks.ok ? "merged" : "conflict"}">${c.checks.ok ? "passed" : "failed"}</span></h2><p class="meta"><span class="mono">${esc(c.checks.command)}</span> on main with this change${c.checks.alongside?.length ? ` after ${c.checks.alongside.map((x) => `#${x}`).join(", ")}` : ""}, ${Math.round(c.checks.ms / 100) / 10}s in ${c.checks.runner === "container" ? "a container" : "the local runner"}.</p>${c.checks.ok ? "" : `<pre class="diff">${esc(c.checks.output.slice(-3000))}</pre>`}` : ""}
    ${c.intents.length ? `<h2>Declared intent</h2>${c.intents.map((i) => `<div class="mono">${i.paths.map(esc).join(", ")}</div><div>${esc(i.description)}</div>`).join("")}` : ""}
    ${c.context?.context && Object.keys(c.context.context).length ? `<h2>Agent context</h2><pre class="diff">${esc(JSON.stringify(c.context.context, null, 2))}</pre>` : ""}
    ${c.reviews.length ? `<h2>Reviews</h2>${c.reviews.map((r) => `<div class="card"><b>${esc(name(r.reviewer))}</b> ${r.verdict}: ${esc(r.body)}${r.comments.map((x) => `<div class="mono">${esc(x.path)}${x.line ? `:${x.line}` : ""} ${esc(x.body)}</div>`).join("")}</div>`).join("")}` : ""}
    ${reviewers}
    <h2>Commits</h2><div id="change-commits"><p class="meta">Reading history…</p></div>
    <h2>Patch ${canReview ? `<small>click a line to comment on it</small>` : ""}</h2>${patch}
    ${canReview ? `<h2>Your review <small id="rv-pending"></small></h2><textarea id="rv-body" rows="3" placeholder="Summary (optional)"></textarea>
      <div class="row"><button data-verdict="approve">Approve</button><button data-verdict="request_changes" class="ghost">Request changes</button><button data-verdict="comment" class="ghost">Comment</button></div>` : ""}`;
  // Line comments: click a line, write, add; they go with the review.
  const pending = [];
  const showPending = () => { if ($("#rv-pending")) $("#rv-pending").textContent = pending.length ? `${pending.length} line comment${pending.length === 1 ? "" : "s"} to send` : ""; };
  for (const row of $("#detail-body").querySelectorAll(".dl[data-line]")) row.onclick = () => {
    if (!canReview || row.nextElementSibling?.classList.contains("dc-new")) return;
    const box = document.createElement("div");
    box.className = "dc-new";
    box.innerHTML = `<textarea rows="2" placeholder="Comment on ${esc(row.dataset.path)}:${row.dataset.line}"></textarea><div class="row"><button class="mini">Add</button><button class="ghost mini">Cancel</button></div>`;
    row.after(box);
    box.querySelector("textarea").focus();
    const [add, cancel] = box.querySelectorAll("button");
    cancel.onclick = () => box.remove();
    add.onclick = () => {
      const body = box.querySelector("textarea").value.trim();
      if (!body) return;
      pending.push({ path: row.dataset.path, line: Number(row.dataset.line), body });
      box.outerHTML = `<div class="dc pending"><b>${esc(me.name)}</b> <span class="meta">pending</span> ${esc(body)}</div>`;
      showPending();
    };
  };
  for (const b of document.querySelectorAll("[data-verdict]")) b.onclick = async () => {
    await act("POST", `/changes/${id}/reviews`, { verdict: b.dataset.verdict, body: $("#rv-body").value, comments: pending });
    $("#detail").close();
  };
  wire($("#detail-body"));
  api(`/commits?change=${c.id}`).then((h) => {
    if (!$("#change-commits")) return;
    $("#change-commits").innerHTML = historyHtml(h, false, c.status === "merged");
    wire($("#change-commits"));
  });
  $("#detail-body").querySelector("[data-browse]").onclick = () => showCode({ change: c.id, label: `change #${c.id} (${c.agentName}'s workspace)` });
  $("#detail-body").querySelector("[data-clone]").onclick = () => showClone($("#clone-box"), { change: c.id });
  for (const b of $("#detail-body").querySelectorAll("[data-ask]")) b.onclick = async () => { await act("POST", `/changes/${id}/reviewers`, { reviewers: [b.dataset.ask] }); showChange(id); };
  if (!$("#detail").open) $("#detail").showModal();
}

// ── jev: what the humans let their stand-in decide ──────────────────────
const jevForm = $("#jev-form");
const field = (n) => jevForm.elements.namedItem(n);
const listOf = (v) => v.split(",").map((x) => x.trim()).filter(Boolean);
function fillJev() {
  const d = state.delegate;
  $("#jev-title").textContent = d.name;
  $("#jev-status").textContent = d.jevConnected ? `Jev judges with ${d.jevUses}.` : "Jev has no key yet, so only house rules and earlier decisions apply. Add one in Settings.";
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
  field("d_enabled").checked = d.disputes.enabled;
  field("d_conf").value = d.disputes.minConfidence;
  showConf();
}
function showConf() {
  $("#q_conf_out").textContent = `${Math.round(field("q_conf").value * 100)}%`;
  $("#a_conf_out").textContent = `${Math.round(field("a_conf").value * 100)}%`;
  $("#d_conf_out").textContent = `${Math.round(field("d_conf").value * 100)}%`;
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
    disputes: { enabled: field("d_enabled").checked, minConfidence: Number(field("d_conf").value) },
    rules: field("rules").value.split("\n").map((l) => l.split("=>")).filter((p) => p.length === 2 && p[0].trim() && p[1].trim()).map(([pattern, answer]) => ({ pattern: pattern.trim(), answer: answer.trim() })),
  });
  toast(`Saved ${field("name").value.trim() || "jev"}'s brief`);
};

boot();
