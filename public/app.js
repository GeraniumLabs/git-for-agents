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

// ── light / dark / follow the system ─────────────────────────────────────
const THEMES = { auto: ["◐", "Theme: follows your system"], light: ["☀", "Theme: light"], dark: ["☾", "Theme: dark"] };
function applyTheme(t) {
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  const [icon, label] = THEMES[t] ?? THEMES.auto;
  $("#theme").textContent = icon;
  $("#theme").title = `${label} (click to change)`;
  $("#theme").setAttribute("aria-label", label);
}
applyTheme(store.get("loom-theme"));
$("#theme").onclick = () => {
  const order = ["auto", "light", "dark"];
  const next = order[(order.indexOf(store.get("loom-theme") ?? "auto") + 1) % order.length];
  store.set("loom-theme", next === "auto" ? null : next);
  applyTheme(next);
};
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
// Our own confirm/prompt: a small dialog that names the action on its button.
// Resolves false/null on cancel; true (no input) or the trimmed text on OK.
// Opens above whatever dialog is already up, since every showModal stacks.
function ask({ title, body = "", ok = "OK", cancel = "Cancel", danger = false, input = null }) {
  const d = document.createElement("dialog");
  d.className = "ask";
  d.innerHTML = `<form method="dialog">
    <h3>${esc(title)}</h3>
    ${body ? `<p class="meta">${esc(body)}</p>` : ""}
    ${input ? `<label>${esc(input.label ?? "")}<textarea name="text" rows="${input.rows ?? 2}" placeholder="${esc(input.placeholder ?? "")}" ${input.required ? "required" : ""}></textarea></label>` : ""}
    <div class="ask-actions"><button value="cancel" class="ghost" formnovalidate>${esc(cancel)}</button><button value="ok" class="${danger ? "bad" : ""}">${esc(ok)}</button></div>
  </form>`;
  document.body.appendChild(d);
  const text = d.querySelector("textarea");
  if (text) text.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); d.querySelector("form").requestSubmit(d.querySelector('[value="ok"]')); } };
  return new Promise((resolve) => {
    d.onclose = () => {
      const yes = d.returnValue === "ok";
      d.remove();
      resolve(input ? (yes ? text.value.trim() : null) : yes);
    };
    d.showModal();
    (text ?? d.querySelector('[value="ok"]')).focus();
  });
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
  if (location.hash) route();
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
  const showcase = (auth.showcase ?? []).filter((n) => projects.some((p) => p.name === n && !p.private));
  if (!project) project = showcase[0] ?? projects.at(-1)?.name;
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
  signIn().then(showNewJoinCode);
  renderTour(projects, showcase);
}

/** For a first-time, signed-out visitor: what Loom is, and the projects worth opening. */
function renderTour(projects, showcase) {
  let dismissed = false;
  try { dismissed = localStorage.getItem("loom-tour") === "off"; } catch {}
  if (dismissed || user || store.get(keyName()) || !showcase.length) return;
  const desc = (n) => projects.find((p) => p.name === n)?.description ?? "";
  $("#tour").innerHTML = `
    <div class="tour-text">
      <b>Loom is a git platform for agent swarms, built on Cloudflare.</b>
      The projects below were built by agents working at the same time through Loom. Each declared what it would touch before writing code. Conflicts went to the agent that caused them. The merge queue ran the tests before main moved. The Activity feed is live.
    </div>
    <div class="tour-projects">${showcase.map((n) => `<a href="?project=${encodeURIComponent(n)}" class="${n === project ? "on" : ""}"><b>${esc(n)}</b><span>${esc(desc(n))}</span></a>`).join("")}</div>
    <div class="tour-actions"><button id="tour-agent">Bring your own agent</button><button id="tour-close" class="ghost" title="Hide this">Hide</button></div>`;
  $("#tour").hidden = false;
  $("#tour-agent").onclick = () => showSkill();
  $("#tour-close").onclick = () => { try { localStorage.setItem("loom-tour", "off"); } catch {} $("#tour").hidden = true; };
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
  reviewEvent(e);
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
const STATE_HELP = {
  working: "Holding a task and seen recently",
  waiting: "Blocked on a question to a person",
  conflict: "Its change hit a conflict it has to resolve",
  quiet: "Holding a task but not seen for a while; listed under Stuck",
  paused: "Paused by a person: it can still talk, but can't change code",
  idle: "Around, with no task",
  away: "Not seen recently, with no task",
};
function renderHealth() {
  const h = state.health;
  const t = h.tasks;
  const open = (t.open ?? 0), active = (t.claimed ?? 0) + (t.blocked ?? 0) + (t.conflict ?? 0), review = (t.in_review ?? 0) + (t.queued ?? 0), merged = t.merged ?? 0;
  const total = open + active + review + merged || 1;
  const STAGE_OF = { ok: "landed", info: "review", warn: "active", muted: "open" };
  const seg = (n, cls, label) => n ? `<span class="seg-${cls}" style="flex:${n}" title="${n} ${label}" data-tasks="${STAGE_OF[cls]}"></span>` : "";
  $("#health").innerHTML = `
    <div class="tile wide" title="Agents in this project, by what they're doing now. Click a state to list those agents">
      <b>${h.agents.total}</b><span>agents</span>
      <div class="states">${STATES.filter(([k]) => h.agents.byState[k]).map(([k, label, cls]) => `<button class="state ${cls}" data-state="${k}" title="${STATE_HELP[k] ?? ""}">${h.agents.byState[k]} ${label}</button>`).join("") || `<span class="meta">none yet</span>`}</div>
    </div>
    <div class="tile wide" title="Tasks whose change has landed on main, out of all tasks. The bar shows the rest by stage. Click to list the tasks">
      <a class="tile-link" data-tasks="" href="#tasks"><b>${merged}<small>/${total === 1 && !merged ? 0 : total}</small></b><span>tasks landed</span></a>
      <div class="bar">${seg(merged, "ok", "landed")}${seg(review, "info", "in review or queued")}${seg(active, "warn", "in progress")}${seg(open, "muted", "open")}</div>
      <div class="meta"><a data-tasks="open" href="#tasks">${open} open</a> · <a data-tasks="active" href="#tasks">${active} in progress</a> · <a data-tasks="review" href="#tasks">${review} in review or queued</a></div>
    </div>
    <div class="tile" title="Changes waiting for review. Each is a task any agent can take (take_review); untaken ones are offered to agents who know the code"><b>${(h.reviewTasks?.open ?? 0) + (h.reviewTasks?.assigned ?? 0) + (h.reviewTasks?.in_progress ?? 0)}</b><span>review tasks · ${h.reviewTasks?.open ?? 0} untaken · ${h.reviewTasks?.in_progress ?? 0} being reviewed</span></div>
    <div class="tile" title="Approved changes waiting to land on main. They land one batch at a time, after the project's checks pass"><b>${h.queue.depth}</b><span>in the merge queue${h.queue.depth ? ` · oldest ${dur(h.queue.oldestWaitMs)}` : ""}</span></div>
    <div class="tile" title="Changes that landed on main in the last hour"><b>${h.mergedLastHour}</b><span>merged in the last hour</span></div>
    ${h.people ? `<div class="tile" title="Questions agents asked people that are still open. This hour: ${h.people.askedLastHour} asked, ${h.people.answeredLastHour} answered by people, ${h.people.defaultedLastHour} went ahead on the agent's default. Limits are in Settings"><b class="${h.people.waiting > 5 ? "warn" : ""}">${h.people.waiting}</b><span>questions for people${h.people.waiting ? ` · oldest ${dur(h.people.oldestMs)}` : ""} · ${h.people.askedLastHour} asked this hour${h.people.defaultedLastHour ? `, ${h.people.defaultedLastHour} went ahead on a default` : ""}</span></div>` : ""}
    <div class="tile" title="Share of merge attempts in the last hour that hit a conflict. Over 20% shows red: look at Where the work is"><b class="${h.conflictRate > 0.2 ? "bad" : ""}">${Math.round(h.conflictRate * 100)}%</b><span>conflict rate · ${h.conflictsLastHour} this hour</span></div>
    <div class="tile" title="The commit main points at now. The version goes up by one with each landing"><b class="mono">${(state.project.mainHead ?? "").slice(0, 7)}</b><span>main · v${state.project.mainVersion}${state.project.frozen ? ` · <b class="bad">frozen</b>` : ""}</span></div>`;
  for (const b of document.querySelectorAll("[data-state]")) b.onclick = () => showDirectory(b.dataset.state);
  for (const b of $("#health").querySelectorAll("[data-tasks]")) b.onclick = (e) => { e.preventDefault(); showTasks(b.dataset.tasks); };
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
        ${it.default ? `<div class="default">${it.deadline > Date.now() ? `In ${ago(Date.now() - (it.deadline - Date.now()))}` : "Now"}, ${many && it.defaults < it.threads.length ? `${it.defaults} of them go ahead with their defaults` : many ? "they go ahead with their defaults" : "it goes ahead with its default"} unless someone answers: <b>${esc(it.default)}</b>${me ? ` <button class="ghost mini" data-go-ahead="${it.threads.join(",")}">Let ${many ? "them" : "it"} go ahead now</button>` : ""}</div>` : ""}
        ${me ? `<div class="row"><input data-answer-text="${it.threads.join(",")}" placeholder="Answer${many ? ` all ${it.threads.length}` : ""}…"><button data-answer-send="${it.threads.join(",")}">Send</button></div>` : signInToAct("answer")}`, "q");
    }
    if (it.kind === "dispute") {
      const sides = it.parties.map((p) => `<div class="side">${who(p)} ${it.positions[p] ? esc(it.positions[p]) : `<i class="meta">hasn't stated a position yet</i>`}${me && it.positions[p] ? ` <button class="mini" data-rule="${it.thread}" data-for="${esc(p)}">Rule for ${esc(name(p))}</button>` : ""}</div>`).join("");
      return box(`<div class="kicker">Dispute${it.change ? ` · change #${it.change}` : ""} · ${ago(it.since)}</div><div class="q">${esc(it.question)}</div>${sides}${escalation(it.escalated)}${me ? "" : signInToAct("rule on it")}`, "q");
    }
    if (it.kind === "brief") {
      return box(`<div class="kicker">Review · the brief says a person should look · ${ago(it.since)}</div><div><a data-change="${it.change}">#${it.change} ${esc(it.title)}</a> · ${who(it.agent)}</div><div class="meta">${it.reasons.slice(0, 3).map(esc).join(" · ")}</div>${escalation(it.escalated)}${me ? `<div class="row"><button data-change="${it.change}">Review</button></div>` : signInToAct("review")}`, "q");
    }
    if (it.kind === "review") {
      return box(`<div class="kicker">Review asked of ${it.reviewer === me?.id ? "you" : esc(name(it.reviewer))} · ${ago(it.since)}</div><div><a data-change="${it.change}">#${it.change} ${esc(it.title)}</a> · ${who(it.agent)}</div>${it.reason ? `<div class="meta">${esc(it.reason)}</div>` : ""}${me ? `<div class="row"><button data-change="${it.change}">Review</button></div>` : signInToAct("review")}`, "q");
    }
    if (it.kind === "task") {
      const yours = it.person === me?.id;
      return box(`<div class="kicker">Task for ${yours ? "you" : esc(name(it.person))}${it.by ? ` · from ${esc(name(it.by))}` : ""} · ${ago(it.since)}</div><div><a data-task="${it.task}">#${it.task} ${esc(it.title)}</a></div>${yours ? `<div class="row"><button data-task="${it.task}">Open</button><button class="ghost" data-take-task="${it.task}">Take it</button></div>` : ""}`, "q");
    }
    return box(`<div class="kicker">Approval · touches protected paths · ${ago(it.since)}</div><div><a data-change="${it.change}">#${it.change} ${esc(it.title)}</a> · ${who(it.agent)}</div><div class="files mono">${it.files.map(esc).join("  ")}</div>${escalation(it.escalated)}${me ? `<div class="row"><button data-change="${it.change}">Review</button></div>` : signInToAct("approve")}`, "q");
  }).join("") || `<p class="empty">Nothing needs a person right now.</p>`;
  wire($("#attention"));
  for (const b of $("#attention").querySelectorAll("[data-take-task]")) b.onclick = async () => {
    const r = await act("POST", `/tasks/${b.dataset.takeTask}/claim`);
    showWork(`<div class="card"><b>Task #${r.task.id} is yours.</b>${pushInfo(r)}</div>`);
  };
}

function renderStuck() {
  const items = state.attention.filter((i) => i.kind === "stuck");
  $("#stuck").innerHTML = items.slice(0, 12).map((it) => `<div class="card stuck"><div class="kicker">${esc(it.reason)} · ${ago(it.since)}</div>
    <div>${it.change ? `<a data-change="${it.change}">${esc(it.detail)}</a>` : esc(it.detail)}${it.agent ? ` · ${who(it.agent)}` : ""}</div>${it.action === "review" && me ? `<div class="row"><button class="ghost mini" data-change="${it.change}">Review it yourself</button></div>` : ""}</div>`).join("")
    + (items.length > 12 ? `<p class="meta">and ${items.length - 12} more</p>` : "")
    || `<p class="empty">Nothing is stuck.</p>`;
  wire($("#stuck"));
}

function renderDiscussions() {
  const posts = (t) => t.posts.slice(-3).map((p) => `<div class="post">${who(p.author)} ${esc(p.body)}</div>`).join("");
  $("#discussions").innerHTML = state.discussions.map((t) => `<div class="card inbox"><div class="kicker">${t.kind === "contract" ? "Contract" : t.title?.startsWith("Consult:") ? `Consult · ${esc(name(t.created_by))} asks ${esc(name(t.to_agent))}` : "Discussion"}${t.path ? ` · <span class="mono">${esc(t.path)}${t.line ? ":" + t.line : ""}</span>` : ""}${t.task_id ? ` · <a data-task="${t.task_id}">task #${t.task_id}</a>` : ""}</div>${t.kind === "contract" ? `<div class="mono"><b>${esc(t.title)}</b></div>` : ""}${posts(t)}
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
  for (const a of root.querySelectorAll("[data-task]")) a.onclick = (e) => { e.preventDefault(); showTask(Number(a.dataset.task)); };
  for (const b of root.querySelectorAll("[data-send]")) b.onclick = async () => {
    const input = root.querySelector(`[data-reply="${b.dataset.send}"]`);
    if (!input.value.trim()) return;
    await act("POST", `/threads/${b.dataset.send}/posts`, { body: input.value.trim() });
    input.value = "";
  };
  const answer = (ids, body) => act("POST", "/questions/answer", { threads: ids.split(",").map(Number), body });
  for (const b of root.querySelectorAll("[data-answer]")) b.onclick = () => answer(b.dataset.answer, `Go with “${b.dataset.opt}”.`);
  for (const b of root.querySelectorAll("[data-go-ahead]")) b.onclick = () => act("POST", "/questions/answer", { threads: b.dataset.goAhead.split(",").map(Number), goAhead: true });
  for (const b of root.querySelectorAll("[data-answer-send]")) b.onclick = async () => {
    const input = root.querySelector(`[data-answer-text="${b.dataset.answerSend}"]`);
    if (input.value.trim()) await answer(b.dataset.answerSend, input.value.trim());
  };
  for (const b of root.querySelectorAll("[data-rule]")) b.onclick = async () => {
    const note = await ask({ title: `Rule for ${name(b.dataset.for)}?`, body: "This settles the dispute. The agents will see your reason.", ok: "Rule", input: { label: "Reason (optional)", placeholder: "Why this side wins" } });
    if (note === null) return;
    await act("POST", `/disputes/${b.dataset.rule}/rule`, { for: b.dataset.for, note: note || undefined });
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
  "agent.paused", "agent.resumed", "decision.recorded", "settings.key_saved", "settings.key_removed", "member.added", "member.removed", "standin.acted", "standin.created", "standin.revoked", "project.visibility", "question.asked", "question.answered", "consult.requested", "merge.retry", "task.reassigned", "task.assigned",
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
    section(`Agents${r.total > r.agents.length ? ` (${r.total}, showing ${r.agents.length})` : ""}`, r.agents.map((a) => `<a class="hit" data-agent="${esc(a.id)}"><span class="dot ${a.state}"></span><b>${esc(a.name)}</b> <span class="meta">${a.under ? `under ${esc(a.under.name)} · ` : ""}${a.state}${a.task ? ` · #${a.task.id} ${esc(a.task.title)}` : ""}</span></a>`).join(""))
    + section("Tasks", r.tasks.map((t) => `<a class="hit" data-task="${t.id}">#${t.id} ${esc(t.title)} <span class="meta">${t.status}${t.assigneeName ? ` · ${esc(t.assigneeName)}` : ""}</span></a>`).join(""))
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
    ${r.agents.map((a) => `<tr><td>${who(a.id)}${a.under ? ` <span class="meta">under ${esc(a.under.name)}</span>` : ""}</td><td>${a.task ? `#${a.task.id} ${esc(a.task.title)}` : `<span class="meta">none</span>`}</td><td>${ago(a.lastSeen)} ago</td></tr>`).join("")}</tbody></table>
    ${r.total > r.agents.length ? `<p class="meta">Showing ${r.agents.length} of ${r.total}. Search to narrow it down.</p>` : ""}`;
  wire($("#detail-body"));
  if (!$("#detail").open) $("#detail").showModal();
}

async function showAgent(id) {
  const p = await api(`/agents/${encodeURIComponent(id)}`);
  if (p.error) return toast(p.error);
  const a = p.agent;
  names[a.id] = a.name;
  if (a.under) names[a.under.id] = a.under.name;
  const ctl = isHuman() && a.role !== "human" ? `<div class="row">
      <button data-op="${a.state === "paused" ? "resume" : "pause"}" class="${a.state === "paused" ? "" : "ghost"}">${a.state === "paused" ? "Resume" : "Pause"}</button>
      <input id="dm-body" placeholder="Directive to ${esc(a.name)} only"><button id="dm-send" class="ghost">Send</button></div>` : "";
  $("#detail-body").innerHTML = `
    <h3><span class="dot ${a.state}"></span> ${esc(a.name)} <span class="role">${a.role}</span> <span class="pill">${a.state}</span></h3>
    <p class="meta">Last active ${ago(a.lastSeen)} ago${a.task ? ` · working on #${a.task.id} ${esc(a.task.title)} (${a.task.status})` : ""}${a.under ? ` · works under ${who(a.under.id)}'s key` : ""}</p>
    ${p.underKey?.length ? `<h2>Agents under this key <small>${p.underKey.length}</small></h2>${p.underKey.map((u) => { names[u.id] = u.name; return `<div class="qrow"><span class="dot ${u.state}"></span>${who(u.id)} <span class="grow meta ellipsis">${u.state}${u.task ? ` · #${u.task.id} ${esc(u.task.title)}` : ""}</span></div>`; }).join("")}` : ""}
    ${p.trust ? `<div class="card"><div class="qrow"><b class="grow">Track record</b><span class="pill" title="what this agent's approvals and contest votes count for">${p.trust.weight}× vote</span></div><div class="meta">${esc(p.trust.summary)}</div></div>` : ""}
    ${ctl}
    <div id="agent-grid" class="card contrib-card"></div>
    ${p.knows.length ? `<h2>Knows</h2><div class="knows">${p.knows.map((k) => `<div><span class="mono">${esc(k.path)}</span> <span class="meta">${[k.wrote && `wrote ×${k.wrote}`, k.reviewed && `reviewed ×${k.reviewed}`].filter(Boolean).join(", ")}${k.symbols.length ? ` · ${k.symbols.slice(0, 6).map(esc).join(", ")}${k.symbols.length > 6 ? "…" : ""}` : ""}</span></div>`).join("")}</div>` : ""}
    ${p.reviewQueue.length || p.reviewStats.approved + p.reviewStats.changesRequested ? `<h2>Reviews <small>${p.reviewStats.approved} approved · ${p.reviewStats.changesRequested} sent back${p.reviewStats.medianResponseMs != null ? ` · answers requests in ${dur(p.reviewStats.medianResponseMs)} (median)` : ""}</small></h2>
      ${p.reviewQueue.map((r) => `<div class="qrow"><a data-change="${r.change_id}">#${r.change_id}</a> <span class="grow ellipsis">${esc(r.title)}</span><span class="meta">asked by ${esc(r.requestedByName)} ${ago(r.created_at)} ago · ${esc(r.reason ?? "")}</span></div>`).join("")}` : ""}
    ${p.intents.length ? `<h2>Declared intents</h2>${p.intents.map((i) => `<div><span class="mono">${i.paths.map(esc).join(", ")}</span> ${esc(i.description)}</div>`).join("")}` : ""}
    ${p.changes.length ? `<h2>Changes</h2>${p.changes.map((c) => `<div class="qrow"><a data-change="${c.id}">#${c.id}</a> <span class="grow ellipsis">${esc(c.title)}</span><span class="pill ${c.status}">${c.status}</span></div>`).join("")}` : ""}
    ${p.reviewTasks?.length ? `<h2>Review tasks</h2>${p.reviewTasks.map((t) => `<div class="qrow"><a data-change="${t.change}" class="grow ellipsis">${esc(t.title)}</a><span class="meta">${t.reviewers.find((r) => r.agent === p.agent.id)?.status ?? t.status}</span></div>`).join("")}` : ""}
    ${p.tasks.length && isHuman() ? `<h2>Tasks</h2>${p.tasks.map((t) => `<div class="qrow"><a data-task="${t.id}">#${t.id}</a> <span class="grow ellipsis">${esc(t.title)}</span><span class="meta">${t.status}</span>${t.status !== "merged" ? `<button class="ghost mini" data-reassign="${t.id}">Reassign…</button>` : ""}</div>`).join("")}` : ""}
    ${p.threads.length ? `<h2>Conversations</h2>${p.threads.map((t) => `<div class="post"><span class="meta">${t.kind} · ${t.status}</span> ${esc(t.title)}</div>`).join("")}` : ""}
    <h2>Recent activity</h2><ol class="feed">${p.events.map((e) => { const d = describe(e); return d ? `<li class="ev ${d[0]}"><time>${new Date(e.ts).toLocaleTimeString()}</time>${d[1]}</li>` : ""; }).join("")}</ol>`;
  wire($("#detail-body"));
  renderGrid($("#agent-grid"), a.id);
  for (const b of $("#detail-body").querySelectorAll("[data-op]")) b.onclick = async () => {
    const reason = b.dataset.op === "pause" ? await ask({ title: `Pause ${a.name}?`, body: "It stops taking work until you resume it. It will see your reason.", ok: "Pause", input: { label: "Reason", placeholder: "e.g. Waiting on the schema decision" } }) : undefined;
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
    const to = await ask({ title: `Reassign task #${b.dataset.reassign}?`, body: "The new agent gets its workspace and context. Leave the name blank to put it back on the board.", ok: "Reassign", input: { label: "Agent", placeholder: "Name or id", rows: 1 } });
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
    <div class="row code-row"><a class="button ghost mini" href="/api/projects/${project}/archive?${q}${keyQuery()}" download title="A snapshot of these files, without history">Download zip</a><button class="ghost mini" id="code-clone" title="A read-only git clone command with a token valid for an hour">Clone with git</button>${target.change ? `<button class="ghost mini" data-change="${target.change}">Back to the change</button>` : ""}</div>
    <div id="code-clone-box"></div>
    <span class="seg" role="tablist"><button id="tab-files" class="on" role="tab" title="Browse the files">Files</button><button id="tab-history" role="tab" title="Every commit: merge commits for each landing, with the author's own commits under them">History</button></span>
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
/** Right after creating a project: the join code made with it, shown once. */
function showNewJoinCode() {
  let fresh = null;
  try { fresh = JSON.parse(sessionStorage.getItem("loom-new-join") ?? "null"); sessionStorage.removeItem("loom-new-join"); } catch {}
  if (fresh?.project === project && fresh.code) showSkill(fresh.code);
}
// Whether a skill without a join code was copied, so a code made afterwards says to copy again.
let copiedPlainSkill = false;
async function showSkill(joinCode) {
  const text = await fetch(`/api/projects/${project}/skill${joinCode ? `?code=${encodeURIComponent(joinCode.code)}` : ""}`, { headers: keyHeader() }).then((r) => r.text());
  const codes = isOwner() ? await api("/join-codes").catch(() => []) : [];
  const save = `mkdir -p .claude/skills/loom-${project} && curl -s "${location.origin}/api/projects/${project}/skill${joinCode ? `?code=${encodeURIComponent(joinCode.code)}` : ""}" > .claude/skills/loom-${project}/SKILL.md`;
  const owner = isOwner();
  const codeRows = codes.map((c) => `<div class="qrow"><span class="grow">#${c.id} ${esc(c.label ?? "")} <span class="role">${esc(c.role)}</span> <span class="meta">${c.uses}/${c.maxUses} joined${c.agents.length ? `: ${c.agents.map((a) => esc(a.name)).join(", ")}` : ""} · ${c.revoked ? "revoked" : c.live ? `until ${new Date(c.expiresAt).toLocaleDateString()}` : "expired or used up"}</span></span>${c.live ? `<button class="ghost mini" data-jc-revoke="${c.id}">Revoke</button>` : ""}</div>`).join("");
  // Owners go in order: make a join code, then copy the skill that carries it.
  const step1 = joinCode
    ? `<h2>1. Join code ready</h2><div class="card fresh"><b>Join code #${joinCode.id} is in the skill below</b> <span class="role">${esc(joinCode.role)}</span>
        ${copiedPlainSkill ? `<p><b>Copy the skill again.</b> The one you copied earlier has no join code, so agents given it can't register.</p>` : ""}
        <p class="meta">Any agent you give this skill registers itself once and saves its own key, up to ${joinCode.maxUses} agents until ${new Date(joinCode.expiresAt).toLocaleString()}. Sub-agents use that key with their own names. The code is shown only now; revoke it below to stop new agents joining.</p></div>`
    : `<h2>1. Let agents register themselves</h2>
      <p class="meta">Create a join code first: the skill in step 2 then carries it. One code lets many agents register: each trades it for its own key once and reuses that key, so it keeps its history and track record. Builders claim tasks and write code; reviewers also get every review request and fill in when no builder knows the code.</p>
      <div class="row"><select id="jc-role" title="Builders claim tasks and write code; reviewers also get every review request"><option value="builder">builders</option><option value="reviewer">reviewers</option></select><input id="jc-max" type="number" min="1" max="10000" value="50" title="How many agents may join with it"><span class="meta">agents, for</span><input id="jc-hours" type="number" min="1" max="2160" value="72" title="Hours until it expires"><span class="meta">hours</span><button id="jc-go">Create join code</button></div>`;
  $("#detail-body").innerHTML = `
    <h3>Connect an agent</h3>
    ${owner ? step1 : `<p class="meta">Give an agent this skill. It covers how to work here and how to check back for new work, which matters because agents come and go. ${joinCode ? "It carries a join code: each agent trades it for its own key once." : "Each agent needs its own key or a join code from an owner."}</p>`}
    ${owner ? `<h2>2. Copy the skill</h2><p class="meta">${joinCode ? "With the join code in it." : "It has no join code yet: agents given it need a key you create for each one (below)."}</p>` : ""}
    <div class="row code-row"><button id="skill-copy" class="${joinCode || !owner ? "" : "ghost"}">${joinCode ? "Copy skill with join code" : "Copy skill"}</button><button class="ghost" id="skill-copy-cmd">Copy install command</button></div>
    <pre class="diff copy">${esc(save)}</pre>
    ${owner && codes.length ? `<h2>Join codes</h2>${codeRows}${joinCode ? `<div class="row"><button class="ghost mini" id="jc-another">Create another join code</button></div>` : ""}` : ""}
    <section class="key-section">
    <h2>Single-agent keys <small>separate from join codes</small></h2>
    ${isOwner() ? `<p class="meta">Not a join code: a key you make for one agent you set up yourself. Prefer a join code for anything that starts sub-agents or a swarm. The key is shown once: give it to the agent as <span class="mono">LOOM_KEY</span>. One key per agent, kept for its life; an agent can replace a leaked key without losing who it is.</p>
    <div class="row"><input id="mk-name" placeholder="Agent name, e.g. builder-7"><select id="mk-role"><option value="builder">builder</option><option value="reviewer">reviewer</option></select><button class="ghost" id="mk-go">Create</button></div>
    <div id="mk-out"></div>` : `<p class="meta">${me ? "Only the project's owners can create agent keys." : "Sign in as one of the project's owners to create agent keys."} People don't need keys: they sign in with GitHub and are added in Settings.</p>`}
    </section>
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
      await showSkill(code);
      $("#detail-body").scrollTop = 0;
      $("#detail-body").closest("dialog")?.scrollTo?.(0, 0);
      toast(copiedPlainSkill ? "Join code created. Copy the skill again: it now carries the code" : "Join code created and added to the skill");
    } catch {}
  };
  for (const b of $("#detail-body").querySelectorAll("[data-jc-revoke]")) b.onclick = async () => {
    if (!await ask({ title: "Revoke this join code?", body: "No new agents can join with it. Agents that already joined keep their keys.", ok: "Revoke", danger: true })) return;
    try { await act("DELETE", `/join-codes/${b.dataset.jcRevoke}`); } catch { return; }
    showSkill(joinCode);
  };
  const copied = (what) => { copiedPlainSkill = !joinCode; toast(joinCode ? `${what} copied, with join code #${joinCode.id}` : `${what} copied${owner ? " (no join code in it)" : ""}`); };
  $("#skill-copy").onclick = () => navigator.clipboard?.writeText(text).then(() => copied("Skill"));
  $("#skill-copy-cmd").onclick = () => navigator.clipboard?.writeText(save).then(() => copied("Install command"));
  if ($("#jc-another")) $("#jc-another").onclick = (e) => { e.preventDefault(); showSkill(); };
  if (!$("#detail").open) $("#detail").showModal();
}
$("#skill-open").onclick = () => showSkill();

// ── new projects ────────────────────────────────────────────────────────
const keyBox = (k, proj) => `<div class="card"><b>Key for ${esc(k.name)}</b> <span class="role">${k.role}</span>
  <pre class="diff copy">export LOOM_KEY=${esc(k.key)}</pre>
  <p class="meta">Shown once: Loom keeps only its hash. Give it to the agent with the skill from <b>Connect an agent</b>; it works only on ${esc(proj)}. If the agent starts sub-agents, the skill has each one send its own name with this key, so Loom shows them as separate agents under ${esc(k.name)}.</p>
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
    ${(auth.regions ?? []).includes("eu") ? `<label class="check"><input id="np-eu" type="checkbox"> Keep its data in the EU: repositories, coordinator and change context. This can't be changed later.</label>` : ""}
    <div class="row"><button id="np-create">Create project</button></div>`;
  $("#np-create").onclick = async () => {
    const name = $("#np-name").value.trim();
    if (!/^[a-z0-9-]+$/.test(name)) return toast("Name: lowercase letters, digits and dashes");
    const res = await fetch("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, description: $("#np-desc").value.trim(), requiredApprovals: $("#np-review").checked ? 1 : 0, visibility: $('input[name="np-vis"]:checked').value, ...($("#np-eu")?.checked ? { jurisdiction: "eu" } : {}) }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return toast(data.error ?? `HTTP ${res.status}`);
    // Start with a join code, so the agents you connect each register as themselves.
    const code = await fetch(`/api/projects/${name}/join-codes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: "builder" }) }).then((r) => r.ok ? r.json() : null).catch(() => null);
    try { if (code) sessionStorage.setItem("loom-new-join", JSON.stringify({ project: name, code })); } catch {}
    location.search = `?project=${name}`;
  };
  if (!$("#detail").open) $("#detail").showModal();
}
$("#np-open").onclick = () => showNewProject();

// ── settings: keys people bring for this project ────────────────────────
async function showSettings() {
  if (!isHuman()) return showSignIn("Settings hold this project's people and keys, so only its members can see them.");
  let s, people, si;
  try { [s, people, si] = await Promise.all([act("GET", "/settings/keys"), act("GET", "/members"), act("GET", "/standins").catch(() => ({ scopes: {}, standins: [] }))]); } catch { return; }
  const vis = state?.project?.visibility ?? "public";
  const when = (t) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  $("#detail-body").innerHTML = `
    <h3>Settings · ${esc(project)}</h3>
    <h2>Visibility</h2>
    <p class="meta">${vis === "private" ? "<b>Private.</b> Only members, owners and the project's agents can see it; to everyone else it doesn't exist." : "<b>Public.</b> Anyone can see the work. Only members can act on it."}</p>
    ${isOwner() ? `<div class="row"><button class="ghost" id="vis-toggle">Make it ${vis === "private" ? "public" : "private"}</button></div>` : ""}
    <h2>Where the data lives</h2>
    <p class="meta">${state?.project?.jurisdiction === "eu" ? "<b>In the EU.</b> The repositories, the coordinator and change context stay in the European Union. Chosen when the project was made; it can't move." : "<b>Anywhere.</b> Cloudflare keeps the data where it serves it best. Keeping it in the EU is chosen when a project is made."}</p>
    <h2>Approvals</h2>
    <p class="meta">${state?.project?.approvalMode === "count" ? "<b>Counted.</b> Every approval counts for one." : "<b>Weighted by track record.</b> An agent's approval counts for more when its earlier approvals and votes held up, and for less when they didn't. A newcomer's counts for one; a person's always does."} A change needs ${state?.project?.requiredApprovals ?? 1}.</p>
    ${isOwner() ? `<div class="row"><button class="ghost" id="mode-toggle">${state?.project?.approvalMode === "count" ? "Weigh approvals by track record" : "Count every approval as one"}</button></div>` : ""}
    <p class="meta">${state?.project?.resolveThreads === false ? "<b>Threads don't hold changes back.</b> Line comments are advice; an approved change merges with threads still open." : "<b>Threads must be resolved.</b> A line comment sent with a request for changes (or marked as one to fix) keeps the change out of the merge queue until its author resolves it."}</p>
    ${isOwner() ? `<div class="row"><button class="ghost" id="threads-toggle">${state?.project?.resolveThreads === false ? "Require open threads to be resolved" : "Let changes merge with open threads"}</button></div>` : ""}
    <h2>Checks</h2>
    <p class="meta">${state?.project?.checks ? `Before anything lands, the merge queue runs <span class="mono">${esc(state.project.checks.command)}</span> on main with the change in it, in a container. A change that fails goes back to its author with the output, like a conflict.` : "No checks yet. Set a command (for example <span class=\"mono\">npm ci && npm test</span>) and the merge queue runs it on main with each change before main moves."}</p>
    ${isOwner() ? `<div class="row"><input id="checks-cmd" class="mono grow" placeholder="npm ci && npm test" value="${esc(state?.project?.checks?.command ?? "")}"><button class="ghost" id="checks-save">Save</button></div>` : ""}
    <h2>Questions for people</h2>
    <p class="meta">${(() => { const q = state?.project?.questions ?? { maxOpen: 3, deadlineMinutes: 30 }; return `${q.maxOpen ? `Each agent may have <b>${q.maxOpen}</b> open question${q.maxOpen === 1 ? "" : "s"} for people at a time; past that, it has to wait or decide for itself.` : "<b>No limit</b> on how many questions an agent may have open for people."} An agent can ask with a default; if nobody answers within <b>${q.deadlineMinutes} minutes</b>, it goes ahead with that default. Similar questions show as one card, and one answer goes to every agent that asked.`; })()}</p>
    ${isOwner() ? `<div class="row"><label class="check">Open questions per agent <input id="q-max" type="number" min="0" max="100" style="width:5em" value="${state?.project?.questions?.maxOpen ?? 3}"></label><label class="check">Default after (minutes) <input id="q-deadline" type="number" min="1" max="10080" style="width:6em" value="${state?.project?.questions?.deadlineMinutes ?? 30}"></label><button class="ghost" id="q-save">Save</button></div><p class="meta">0 open questions means no limit.</p>` : ""}
    <h2>Decision model</h2>
    <p class="meta">${s.jevUses ? `Loom can also use the deputy's decision model (<b>${esc(s.jevUses)}</b>) beyond the deputy. Both are off unless you turn them on, and if the model fails Loom does what it does without one.` : "No decision model is connected, so these options have no effect."}</p>
    ${(() => { const o = state?.project?.model ?? {}; const box = (id, on, label, help) => `<label class="check" title="${esc(help)}"><input type="checkbox" id="${id}" ${on ? "checked" : ""} ${isOwner() ? "" : "disabled"}> ${label}</label><p class="meta">${help}</p>`;
      return box("model-reviewers", o.reviewers, "Pick reviewers with the model", "When reviewers are requested, the model reorders the best-placed few by who knows the changed code and can get to it. Their familiarity with the files still decides who is considered.")
        + box("model-intent", o.intent, "Check changes against their intent", "When a change is submitted or updated, the model judges whether the diff does what its agent declared, and nothing else. A doubtful score shows in the review brief and tells the author."); })()}
    <h2>People</h2>
    <p class="meta">People sign in with GitHub. Members can answer agents, review, steer and manage keys; owners can also add people and create agent keys.</p>
    ${people.map((p) => `<div class="qrow"><span class="grow">${esc(p.login)}</span><span class="role">${p.owner ? "owner" : "member"}</span><span class="meta">${p.lastSeen ? `seen ${ago(p.lastSeen)}` : "hasn't signed in yet"}</span>${isOwner() && p.id !== me.id ? `<button class="ghost mini" data-member-remove="${p.id}">Remove</button>` : ""}</div>`).join("")}
    ${isOwner() ? `<div class="row"><input id="mem-login" placeholder="GitHub login, e.g. octocat"><label class="check"><input id="mem-owner" type="checkbox"> Owner</label><button class="ghost" id="mem-add">Add</button></div>` : ""}
    <h2>Your agent</h2>
    <p class="meta">Let your own agent watch this project for you and reach you where you are (Slack, email, a text) when agents need a person. Give it a stand-in key: it signs in as you, but only with the rights you tick, and never touches settings, people or keys. With nothing ticked it only tells you. Everything it does is recorded under your name, marked as through it.</p>
    <div class="card key-card">
      <div class="row"><input id="si-name" placeholder="Your agent's name, e.g. my-assistant"></div>
      ${Object.entries(si.scopes).map(([k, d]) => `<label class="check si-scope"><input type="checkbox" data-si-scope="${k}" ${k === "answer" ? "checked" : ""}> <b>${esc(k)}</b> <span class="meta">${esc(d)}</span></label>`).join("")}
      <div class="row"><input id="si-hook" placeholder="Webhook (optional): https://… where Loom posts what needs you"><button id="si-go">Create stand-in key</button></div>
      <div id="si-out"></div>
    </div>
    ${si.standins.map((x) => `<div class="qrow"><span class="grow"><b>${esc(x.name)}</b>${x.for !== me?.id ? ` <span class="meta">for ${esc(x.forName)}</span>` : ""} <span class="meta">${x.scopes.length ? esc(x.scopes.join(", ")) : "watch only"}${x.webhook ? " · webhook" : ""}${x.lastDelivery ? ` (last ${x.lastDelivery.status && x.lastDelivery.status < 300 ? "delivered" : `failed: ${esc(x.lastDelivery.error || String(x.lastDelivery.status))}`})` : ""} · ${x.revoked ? "revoked" : x.lastUsed ? `used ${ago(x.lastUsed)}` : "not used yet"}</span></span>${!x.revoked && x.webhook ? `<button class="ghost mini" data-si-test="${x.id}">Test</button>` : ""}${x.revoked ? "" : `<button class="ghost mini" data-si-revoke="${x.id}">Revoke</button>`}</div>`).join("")}
    <h2>Keys</h2>
    <p class="meta">Bring your own keys for this project. Loom encrypts them before storing and never shows them again; you'll only see the last four characters. ${s.jevUses ? `The deputy judges with <b>${esc(s.jevUses)}</b>.` : "The deputy has no decision model yet, so it applies only house rules and earlier decisions."}</p>
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
  $("#si-go").onclick = async () => {
    const name = $("#si-name").value.trim();
    if (!name) return toast("Name the agent that will hold the key");
    const scopes = [...$("#detail-body").querySelectorAll("[data-si-scope]")].filter((c) => c.checked).map((c) => c.dataset.siScope);
    let k;
    try { k = await act("POST", "/standins", { name, scopes, webhook: $("#si-hook").value.trim() || null }); } catch { return; }
    const install = `mkdir -p .claude/skills/loom-${project}-standin && curl -s -H \"Authorization: Bearer $LOOM_STANDIN_KEY\" "${k.skill}" > .claude/skills/loom-${project}-standin/SKILL.md`;
    $("#si-out").innerHTML = `<p class="meta">Shown once. Give your agent the skill and the key; Loom keeps only the key's hash.</p>
      <pre class="diff copy">export LOOM_STANDIN_KEY=${esc(k.key)}</pre>
      ${k.webhookSecret ? `<p class="meta">Webhook signing secret: deliveries carry <span class="mono">x-loom-signature: sha256=&lt;HMAC of the body&gt;</span>.</p><pre class="diff copy">${esc(k.webhookSecret)}</pre>` : ""}
      <pre class="diff copy">${esc(install)}</pre>
      <div class="row"><button class="ghost mini" data-copy="${esc(k.key)}">Copy key</button><button class="ghost mini" data-copy="${esc(install)}">Copy install command</button></div>`;
    wireCopy($("#si-out"));
  };
  for (const b of $("#detail-body").querySelectorAll("[data-si-test]")) b.onclick = async () => {
    try { const r = await act("POST", `/standins/${b.dataset.siTest}/test`); toast(r.status && r.status < 300 ? `Webhook answered ${r.status}` : `Webhook failed: ${r.error || r.status}`); } catch {}
  };
  for (const b of $("#detail-body").querySelectorAll("[data-si-revoke]")) b.onclick = async () => {
    if (!await ask({ title: "Revoke this stand-in key?", body: "Your agent can no longer act for you or read what needs you here.", ok: "Revoke", danger: true })) return;
    try { await act("DELETE", `/standins/${b.dataset.siRevoke}`); } catch { return; }
    showSettings();
  };
  if ($("#vis-toggle")) $("#vis-toggle").onclick = async () => {
    const to = vis === "private" ? "public" : "private";
    if (!await ask(to === "private"
      ? { title: "Make this project private?", body: "Only members and its agents will see it.", ok: "Make private" }
      : { title: "Make this project public?", body: "Anyone will be able to see its work.", ok: "Make public", danger: true })) return;
    try { const r = await act("POST", "/settings", { visibility: to }); state.project.visibility = r.visibility; } catch { return; }
    toast(`${project} is now ${to}`);
    showSettings();
  };
  if ($("#mode-toggle")) $("#mode-toggle").onclick = async () => {
    try { const r = await act("POST", "/settings", { approvalMode: state.project.approvalMode === "count" ? "weighted" : "count" }); state.project.approvalMode = r.approvalMode; } catch { return; }
    showSettings();
  };
  if ($("#threads-toggle")) $("#threads-toggle").onclick = async () => {
    try { const r = await act("POST", "/settings", { resolveThreads: state.project.resolveThreads === false }); state.project.resolveThreads = r.resolveThreads; } catch { return; }
    showSettings();
  };
  if ($("#checks-save")) $("#checks-save").onclick = async () => {
    try { const r = await act("POST", "/settings", { checks: { command: $("#checks-cmd").value } }); state.project.checks = r.checks; } catch { return; }
    toast(state.project.checks ? "Checks saved" : "Checks turned off");
    showSettings();
  };
  for (const [id, key] of [["#model-reviewers", "reviewers"], ["#model-intent", "intent"]]) {
    if ($(id) && isOwner()) $(id).onchange = async () => {
      try { const r = await act("POST", "/settings", { model: { [key]: $(id).checked } }); state.project.model = r.model; } catch { $(id).checked = !$(id).checked; return; }
      toast($(id).checked ? "Turned on" : "Turned off");
    };
  }
  if ($("#q-save")) $("#q-save").onclick = async () => {
    try { const r = await act("POST", "/settings", { questions: { maxOpen: Number($("#q-max").value), deadlineMinutes: Number($("#q-deadline").value) } }); state.project.questions = r.questions; } catch { return; }
    toast("Saved");
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
    if (!await ask({ title: "Remove this person?", body: "They lose access to the project. You can invite them again later.", ok: "Remove", danger: true })) return;
    try { await act("DELETE", `/members/${b.dataset.memberRemove}`); } catch { return; }
    showSettings();
  };
  for (const b of $("#detail-body").querySelectorAll("[data-key-remove]")) b.onclick = async () => {
    if (!await ask({ title: "Remove this key?", body: "The deputy falls back to the server's key, or to Clef.", ok: "Remove key", danger: true })) return;
    try { await act("DELETE", `/settings/keys/${b.dataset.keyRemove}`); } catch { return; }
    toast("Key removed");
    showSettings();
  };
  if (!$("#detail").open) $("#detail").showModal();
}
$("#settings-open").onclick = () => showSettings();

// ── my work: people claim tasks, push with git, and submit like agents ───
/** How to clone and push a claimed task's workspace. */
const pushInfo = (r) => `<pre class="diff copy">${esc(r.git.clone)}\ncd work\n# edit, commit, then:\ngit -c http.extraHeader="Authorization: Bearer ${esc(r.workspace.token)}" push origin HEAD:main</pre><p class="meta">The workspace is yours alone; main changes only through the merge queue.</p>
    <div class="row"><input data-intent="${r.task.id}" placeholder="Files you'll touch, e.g. src/db.js, docs/**" style="flex:1"><button class="ghost mini" data-declare="${r.task.id}">Declare</button></div>
    <p class="meta">Declaring warns agents headed for the same files, and tells you what was already decided about them.</p>`;
async function showWork(note = "") {
  if (!me) return toast("Sign in first");
  const [p, open, queue] = await Promise.all([api(`/agents/${encodeURIComponent(me.id)}`), api("/tasks?status=open&limit=30"), api(`/reviews?for=${encodeURIComponent(me.id)}`)]);
  const mine = (p.tasks ?? []).filter((t) => !["merged", "abandoned"].includes(t.status));
  const ready = open.filter((t) => !t.depends_on.length && (!t.assignee || t.assignee === me.id));
  $("#detail-body").innerHTML = `
    <h3>My work</h3>
    <p class="meta">You work like an agent does: take a task, clone its workspace, push your commits, submit. Reviews, conflicts and the merge queue treat you the same.</p>
    ${note}
    <h2>Reviews <small>${queue.length ? `${queue.filter((r) => r.needsPerson).length} of ${queue.length} need a person` : "nothing waiting"}</small></h2>
    ${queue.length ? `<label class="check meta"><input type="checkbox" id="rq-person" ${isHuman() && store.get("loom-rq-all") !== "1" ? "checked" : ""}> Only what needs a person; agents review the rest</label><div id="rq"></div>` : `<p class="meta">No changes are waiting on review.</p>`}
    <h2>Your tasks</h2>
    ${mine.length ? mine.map((t) => `<div class="card work"><div class="qrow">#${t.id} <span class="grow ellipsis">${esc(t.title)}</span><span class="meta">${t.status}</span></div>
      <div class="row"><button class="ghost mini" data-push="${t.id}">Clone and push</button><button class="ghost mini" data-submit="${t.id}">Submit for review</button><button class="ghost mini" data-release="${t.id}">Release</button></div>
      <div id="work-${t.id}"></div></div>`).join("") : `<p class="meta">None yet.</p>`}
    <h2>Open tasks <small>${ready.length} ready</small></h2>
    ${ready.length ? ready.map((t) => `<div class="qrow">#${t.id} <span class="grow ellipsis">${esc(t.title)}</span><button class="mini" data-take="${t.id}">Take it</button></div>`).join("") : `<p class="meta">Nothing open.</p>`}
    <h2>New task</h2>
    <input id="nt-title" placeholder="Title" style="width:100%"><textarea id="nt-desc" rows="3" placeholder="What's wrong or needed, how to reproduce it, what done looks like" style="width:100%;margin-top:6px"></textarea>
    <div class="row"><input id="nt-for" placeholder="For: an agent or person by name, or blank for any agent" style="flex:1"></div>
    <p class="meta">Left blank, any agent can claim it. Given to an agent, it shows in that agent's todo. Given to a person, it waits under Needs a person, where their stand-in sees it, until they take it. The change that fixes it is linked from the task, and the task closes when that change lands.</p>
    <div class="row"><button class="ghost" id="nt-add">File it</button><button id="nt-take">File it and take it</button></div>`;
  const drawQueue = () => {
    if (!$("#rq")) return;
    const only = $("#rq-person").checked;
    const rows = queue.filter((r) => !only || r.needsPerson || r.askedOfYou);
    $("#rq").innerHTML = rows.map((r) => `<div class="card rq ${r.needsPerson ? "person" : ""}">
      <div class="qrow"><span class="badge ${r.needsPerson ? "person" : "agents"}">${r.needsPerson ? "Needs a person" : "Agents"}</span><a data-change="${r.id}" class="grow ellipsis">#${r.id} ${esc(r.title)}</a>${r.askedOfYou ? `<span class="pill review">asked of you</span>` : `<span class="meta">${r.reviewers.length ? r.reviewers.map((x) => `${esc(x.name)} ${x.status}`).join(", ") : "nobody has taken it"}</span>`}${r.yourReview ? `<span class="pill">${r.yourReview.current ? "you reviewed it" : "changed since your review"}</span>` : ""}</div>
      <div class="meta">${who(r.agent)} · <span class="add">+${r.added}</span> <span class="del">−${r.removed}</span> in ${plural(r.files, ["file", "files"])} · approval ${r.approval.weight} of ${r.approval.needed}${r.openThreads ? ` · ${plural(r.openThreads, ["open thread", "open threads"])}` : ""} · ${ago(r.updated_at)} ago</div>
      ${r.reasons.length ? `<div class="meta">${r.reasons.slice(0, 3).map(esc).join(" · ")}</div>` : ""}</div>`).join("")
      || `<p class="meta">Nothing needs a person right now. ${queue.length} ${queue.length === 1 ? "change is" : "changes are"} with the agents.</p>`;
    wire($("#rq"));
  };
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
    const assignee = take ? null : $("#nt-for").value.trim() || null;
    const t = await act("POST", "/tasks", { title, description: $("#nt-desc").value.trim(), assignee });
    if (!take) return showWork(`<p class="meta">Filed <a data-task="${t.id}">#${t.id}</a>${t.assignee ? ` for ${esc(name(t.assignee))}` : " for any agent"}.</p>`);
    const r = await act("POST", `/tasks/${t.id}/claim`);
    showWork(`<div class="card"><b>Task #${t.id} is yours.</b>${pushInfo(r)}</div>`);
  };
  if ($("#rq-person")) $("#rq-person").onchange = () => { store.set("loom-rq-all", $("#rq-person").checked ? null : "1"); drawQueue(); };
  drawQueue();
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
  else {
    const reason = await ask({ title: "Freeze main?", body: "Nothing merges until you unfreeze. Agents will see your reason.", ok: "Freeze", danger: true, input: { label: "Reason", placeholder: "e.g. Cutting a release" } });
    if (reason !== null) await act("POST", "/freeze", { reason });
  }
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
    case "agent.joined": return ["", `${who} joined as ${d.role}${d.via ? ` under ${esc(name(d.via))}'s key` : ""}`];
    case "task.created": return ["", `${who} created task #${e.task_id} “${esc(d.title)}”`];
    case "task.claimed": return ["", `${who} ${d.resumed ? "took over" : "claimed"} task #${e.task_id} in workspace <span class="mono">${esc(d.workspace)}</span>`];
    case "task.reassigned": return ["stale", `Task #${e.task_id} reassigned: ${esc(d.reason)}`];
    case "intent.declared": return ["", `${who} intends to touch <span class="mono">${d.paths.map(esc).join(", ")}</span>${d.description ? `: ${esc(d.description)}` : ""}`];
    case "collision.forecast": return ["collision", `Collision forecast: ${who} and ${to} both plan to touch <span class="mono">${d.paths.map(esc).join(", ")}</span>. Both notified before any code was written.`];
    case "intent.released": return ["", `${who} released an intent`];
    case "workspace.committed": return ["", `${who} committed to their workspace: ${esc(d.message)}`];
    case "workspace.pushed": return ["", `${who} pushed ${d.commits ? `${d.commits} commit${d.commits === 1 ? "" : "s"} ` : ""}to their workspace${d.head ? ` <span class="mono">${esc(d.head.slice(0, 7))}</span>` : ""}`];
    case "change.off_intent": return ["conflict", `${esc(d.model)} doubts change #${e.change_id} does what its intent declared (${Math.round(d.score * 100)}%)`];
    case "change.submitted": return ["review", `${who} submitted change #${e.change_id} (${d.files.length} files)${d.undeclared?.length ? `, ${d.undeclared.length} outside intent` : ""}`];
    case "change.updated": return ["review", `Change #${e.change_id} updated${d.via === "push" ? " from a git push" : ""}${d.reason ? `: ${esc(d.reason)}` : ""}`];
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
    case "standin.acted": return ["directive", `${who}, through ${esc(d.name)}: <span class="mono">${esc(d.action)}</span>`];
    case "standin.created": return ["directive", `${who} gave ${to} a stand-in key for ${esc(d.name)} (${d.scopes.length ? esc(d.scopes.join(", ")) : "watch only"})`];
    case "standin.revoked": return ["directive", `${who} revoked the stand-in key for ${esc(d.name)}`];
    case "settings.key_saved": return ["directive", `${who} saved a ${esc(d.label)} key for the project (…${esc(d.last4)})`];
    case "settings.key_removed": return ["directive", `${who} removed the project's ${esc(d.label)} key`];
    case "delegate.configured": return ["directive", `${who} ${d.enabled ? `set ${esc(d.name)}'s brief: may ${[d.questions?.enabled && "answer questions", d.approvals?.enabled && `approve ${(d.approvals.paths ?? []).map(esc).join(", ") || "nothing"}`].filter(Boolean).join(" and ") || "do nothing yet"}` : `turned ${esc(d.name)} off`}`];
    case "delegate.decided": return ["merged", `${who} ${d.kind === "question" ? `answered for the humans${d.thread ? ` in thread #${d.thread}` : ""}` : d.kind === "dispute" ? `settled dispute #${d.thread}` : `approved #${e.change_id} for the humans`} (${d.via === "model" || d.via === "jev" ? `${esc(d.model ?? "Jev")}'s judgment` : d.via === "precedent" ? `earlier decision${d.precedent ? ` #${d.precedent}` : ""}` : "house rule"}): “${esc(d.decision)}”`];
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

// ── review: a change on its own page ────────────────────────────────────
// With many agents shipping, nobody reads every diff. The page leads with
// the brief (where to look, and whether a person needs to), ranks files by
// risk, and keeps line comments as threads the author has to answer.

/** A unified diff as files and hunks, with old and new line numbers. */
function parsePatch(text) {
  const files = [];
  let f = null, h = null, oldN = 0, newN = 0, minus = null;
  for (const l of (text ?? "").split("\n")) {
    if (l.startsWith("--- ")) { minus = l.slice(4).replace(/^a\//, ""); continue; }
    if (l.startsWith("+++ ")) {
      const plus = l.slice(4).replace(/^b\//, "");
      f = { path: plus === "/dev/null" ? minus : plus, deleted: plus === "/dev/null", added: minus === "/dev/null", hunks: [], plus: 0, minus: 0 };
      files.push(f);
      h = null;
      continue;
    }
    if (!f) continue;
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (m) { oldN = Number(m[1]); newN = Number(m[2]); h = { header: l, lines: [] }; f.hunks.push(h); continue; }
    // Every real line has a one-character prefix; an empty one is the patch's end.
    if (!h || !l) continue;
    if (l.startsWith("+")) { h.lines.push({ kind: "add", text: l.slice(1), old: null, new: newN++ }); f.plus++; }
    else if (l.startsWith("-")) { h.lines.push({ kind: "del", text: l.slice(1), old: oldN++, new: null }); f.minus++; }
    else if (l.startsWith(" ")) h.lines.push({ kind: "ctx", text: l.slice(1), old: oldN++, new: newN++ });
  }
  return files;
}

/** A plain unified diff, for places that only show a patch (contests). */
function diffView(patchText) {
  return `<div class="diffview">${parsePatch(patchText).map((f) => `<div class="dl file">${esc(f.path)}</div>${f.hunks.map((h) => `<div class="dl hunk"><span class="ln"></span><code>${esc(h.header)}</code></div>${h.lines.map((l) => `<div class="dl ${l.kind}"><span class="ln">${l.new ?? ""}</span><code>${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${esc(l.text)}</code></div>`).join("")}`).join("")}`).join("")}</div>`;
}

let review = null; // the change on screen: { id, c, rv, pending, view, since, inter }
const VERDICT = { approve: ["approved", "merged"], request_changes: ["requested changes", "changes_requested"], comment: ["commented", ""] };
const viewedKey = () => `loom-viewed:${project}:${review.id}:${review.c.head}`;
const viewed = () => new Set(JSON.parse(store.get(viewedKey()) ?? "[]"));
const fileId = (p) => `rvf-${btoa(unescape(encodeURIComponent(p))).replace(/[^a-z0-9]/gi, "")}`;

function showChange(id) {
  if (location.hash === `#change/${id}`) route(); else location.hash = `change/${id}`;
}
function showContest(id) {
  if (location.hash === `#contest/${id}`) route(); else location.hash = `contest/${id}`;
}
function showTask(id) {
  if (location.hash === `#task/${id}`) route(); else location.hash = `task/${id}`;
}

/** The dashboard, or a change or contest on its own page, from the URL. */
function route() {
  const m = /^#(change|contest|task)\/(\d+)$/.exec(location.hash);
  document.body.classList.toggle("reviewing", !!m);
  $("#review").hidden = !m;
  if (!m) { review = null; $("#review").innerHTML = ""; return; }
  if ($("#detail").open) $("#detail").close();
  window.scrollTo(0, 0);
  if (m[1] === "change") loadReview(Number(m[2])); else if (m[1] === "task") loadTask(Number(m[2])); else loadContest(Number(m[2]));
}
window.addEventListener("hashchange", route);

async function loadReview(id) {
  const [c, rv] = await Promise.all([api(`/changes/${id}`), api(`/changes/${id}/reviewers`)]);
  if (c.error) { $("#review").innerHTML = `<div class="rv-top"><a class="button ghost mini" href="#">← Back</a><p class="empty">${esc(c.error)}</p></div>`; return; }
  const prev = review?.id === id ? review : null;
  review = { id, c, rv, pending: prev?.pending ?? [], view: store.get("loom-diff-view") ?? "unified", since: prev?.since ?? null, inter: null, file: prev?.file ?? 0 };
  const lastMine = c.reviewedHeads.filter((r) => r.reviewer === me?.id).at(-1)?.head;
  review.lastMine = lastMine && lastMine !== c.head ? lastMine : null;
  if (review.since === null) review.since = !!review.lastMine;
  if (review.since && review.lastMine) {
    review.inter = await api(`/changes/${id}/interdiff?from=${review.lastMine}`);
    if (!review.inter.available) review.since = false;
  } else review.since = false;
  drawReview();
}

function drawReview() {
  const { c, rv } = review;
  const canReview = me && !["merged", "abandoned", "closed"].includes(c.status) && me.id !== c.agent_id;
  const patch = review.since ? review.inter.patch : c.patch;
  const files = parsePatch(patch);
  const briefOf = new Map(c.brief.files.map((f) => [f.path, f]));
  // Riskiest first, as the brief ranks them.
  const rank = new Map(c.brief.files.map((f, i) => [f.path, i]));
  files.sort((a, b) => (rank.get(a.path) ?? 999) - (rank.get(b.path) ?? 999));
  const seen = viewed();
  const threadsAt = (path) => c.threads.filter((t) => t.path === path);
  const open = c.threads.filter((t) => t.status === "open");
  const added = c.brief.files.reduce((s, f) => s + f.added, 0), removed = c.brief.files.reduce((s, f) => s + f.removed, 0);

  const fileList = files.map((f, i) => {
    const b = briefOf.get(f.path), n = threadsAt(f.path).filter((t) => t.status === "open").length;
    return `<li class="${seen.has(f.path) ? "seen" : ""}${i === review.file ? " on" : ""}" data-goto="${i}" title="${esc(f.path)}${b?.flags.length ? "\n" + b.flags.map((x) => "• " + x.text).join("\n") : ""}">
      <input type="checkbox" data-viewed="${esc(f.path)}" ${seen.has(f.path) ? "checked" : ""} title="Viewed">
      <span class="risk r${Math.min(3, Math.ceil((b?.score ?? 0) / 2))}"></span>
      <span class="fname">${esc(f.path)}</span>
      ${n ? `<span class="tcount" title="open threads">${n}</span>` : ""}
      <span class="add">+${f.plus}</span><span class="del">−${f.minus}</span></li>`;
  }).join("");

  const reasons = c.brief.reasons.map((r) => `<li class="${r.kind === "ok" ? "ok" : r.kind === "threads" ? "thr-r" : ""}">${esc(r.text)}${r.files?.length ? ` <span class="meta">${r.files.slice(0, 4).map((p) => `<a class="mono" data-gotopath="${esc(p)}">${esc(p)}</a>`).join(", ")}${r.files.length > 4 ? "…" : ""}</span>` : ""}</li>`).join("");

  $("#review").innerHTML = `
    <div class="rv-top">
      <a class="button ghost mini" href="#">← ${esc(project)}</a>
      <h1>${esc(c.title)} <span class="meta">#${c.id}</span> <span class="pill ${c.status}">${c.status.replace("_", " ")}</span></h1>
      <div class="meta">${who(c.agent_id)} wants to land this for <a href="#task/${c.task.id}">task #${c.task.id} “${esc(c.task.title)}”</a> · updated ${ago(c.updated_at)} ago · <span class="add">+${added}</span> <span class="del">−${removed}</span> in ${plural(c.brief.files.length, ["file", "files"])}</div>
      ${c.summary ? `<p class="rv-summary">${esc(c.summary)}</p>` : ""}
      <div class="row"><button class="ghost mini" data-browse title="See this change's version of every file">Browse files</button><a class="button ghost mini" href="/api/projects/${project}/archive?change=${c.id}${keyQuery()}" download title="A snapshot of the files with this change">Download zip</a><button class="ghost mini" data-clone title="A clone command for this change's workspace, and a git diff against main, to review it in your own editor">Check out locally</button>${c.contest ? `<a class="button ghost mini" href="#contest/${c.contest}">Compare attempts in contest #${c.contest}</a>` : ""}</div>
      <div id="clone-box"></div>
    </div>
    <div class="rv-brief ${c.brief.needsPerson ? "person" : "agents"}">
      <div class="rv-verdict"><span class="badge">${c.brief.needsPerson ? "Needs a person" : "Agents can handle it"}</span> ${esc(c.brief.verdict)}</div>
      ${reasons ? `<ul>${reasons}</ul>` : ""}
    </div>
    <div class="rv-grid">
      <aside class="rv-files panel">
        <div class="panel-head"><h2>Files</h2><small>${seen.size ? `${[...seen].filter((p) => files.some((f) => f.path === p)).length} of ${files.length} viewed` : "riskiest first"}</small></div>
        <ol>${fileList || `<li class="meta">${review.since ? "Nothing changed since your review." : "No files."}</li>`}</ol>
        <p class="meta keys"><kbd>j</kbd> <kbd>k</kbd> move between files · <kbd>v</kbd> mark viewed</p>
      </aside>
      <section class="rv-diff">
        <div class="rv-tools">
          <span class="seg"><button data-view="unified" class="${review.view === "unified" ? "on" : ""}" title="Old and new lines in one column">Unified</button><button data-view="split" class="${review.view === "split" ? "on" : ""}" title="Old on the left, new on the right">Split</button></span>
          ${review.lastMine ? `<span class="seg"><button data-since="0" class="${review.since ? "" : "on"}">All changes</button><button data-since="1" class="${review.since ? "on" : ""}">Since your review</button></span>` : ""}
          <span class="meta grow">${canReview ? "Click a line to comment on it." : !me ? "Sign in to review." : me.id === c.agent_id ? "Your own change: answer the threads on it." : ""}</span>
          ${open.length ? `<span class="pill changes_requested">${plural(open.length, ["open thread", "open threads"])}</span>` : ""}
        </div>
        ${review.since ? `<p class="meta since">Showing what changed since you reviewed it (${review.lastMine.slice(0, 7)} → ${c.head.slice(0, 7)}).</p>` : ""}
        ${orphanThreads(c, files)}
        ${files.map((f, i) => fileBlock(f, i, briefOf.get(f.path), threadsAt(f.path), canReview)).join("")}
        ${canReview ? `<div class="rv-submit panel">
          <textarea id="rv-body" rows="2" placeholder="Review summary (optional)"></textarea>
          <div class="row"><span class="meta grow" id="rv-pending"></span>
            <button data-verdict="comment" class="ghost" title="Send your line comments without a verdict">Comment</button>
            <button data-verdict="request_changes" class="ghost" title="Send it back: the change can't merge until the author answers your threads and pushes again">Request changes</button>
            <button data-verdict="approve" title="Count your approval toward the weight this change needs. A person's approval always counts one">Approve</button></div>
        </div>` : ""}
      </section>
      <aside class="rv-why">${whyPanel(c, rv)}</aside>
    </div>`;
  wireReview(canReview);
}

/** Threads on files or lines this view doesn't show. */
function orphanThreads(c, files) {
  const shown = new Set(files.map((f) => f.path));
  const away = c.threads.filter((t) => !shown.has(t.path));
  return away.length ? `<div class="rv-file"><div class="rv-fhead"><b>Comments on files not shown here</b></div><div class="rv-orphans">${away.map((t) => threadHtml(t, true)).join("")}</div></div>` : "";
}

function fileBlock(f, i, b, threads, canReview) {
  const shownLines = new Set(f.hunks.flatMap((h) => h.lines.map((l) => l.new)).filter(Boolean));
  const inline = threads.filter((t) => t.line && shownLines.has(t.line) && !t.outdated);
  const elsewhere = threads.filter((t) => !inline.includes(t));
  const pend = review.pending.filter((p) => p.path === f.path);
  const at = (n) => [...inline.filter((t) => t.line === n).map((t) => threadHtml(t)), ...pend.filter((p) => p.line === n).map(pendingHtml)].join("");
  const body = review.view === "split" ? splitRows(f, at, canReview) : unifiedRows(f, at, canReview);
  return `<div class="rv-file" id="${fileId(f.path)}" data-file="${i}">
    <div class="rv-fhead"><b class="mono">${esc(f.path)}</b>${f.added ? ` <span class="pill merged">new</span>` : f.deleted ? ` <span class="pill conflict">deleted</span>` : ""}
      ${(b?.flags ?? []).map((x) => `<span class="flag ${x.kind}">${esc(x.text)}</span>`).join("")}
      <span class="grow"></span><span class="add">+${f.plus}</span> <span class="del">−${f.minus}</span>
      ${f.deleted ? "" : `<button class="ghost mini" data-open="${esc(f.path)}" title="The whole file as this change leaves it">View file</button>`}</div>
    ${elsewhere.length ? `<div class="rv-orphans">${elsewhere.map((t) => threadHtml(t, true)).join("")}</div>` : ""}
    <div class="diffview rv-dv ${review.view}">${body}</div>
  </div>`;
}

function unifiedRows(f, at, canReview) {
  return f.hunks.map((h) => `<div class="dl hunk"><span class="ln"></span><span class="ln"></span><code>${esc(h.header)}</code></div>` + h.lines.map((l) => {
    const can = canReview && l.new;
    return `<div class="dl ${l.kind}${can ? " can" : ""}" ${l.new ? `data-path="${esc(f.path)}" data-line="${l.new}"` : ""}><span class="ln">${l.old ?? ""}</span><span class="ln">${l.new ?? ""}</span><code>${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${esc(l.text)}</code></div>${l.new ? at(l.new) : ""}`;
  }).join("")).join("");
}

function splitRows(f, at, canReview) {
  const out = [];
  for (const h of f.hunks) {
    out.push(`<div class="sl hunk"><code>${esc(h.header)}</code></div>`);
    let dels = [], adds = [];
    const flush = () => {
      for (let i = 0; i < Math.max(dels.length, adds.length); i++) out.push(splitRow(f, dels[i], adds[i], at, canReview));
      dels = []; adds = [];
    };
    for (const l of h.lines) {
      if (l.kind === "del") { if (adds.length) flush(); dels.push(l); }
      else if (l.kind === "add") adds.push(l);
      else { flush(); out.push(splitRow(f, l, l, at, canReview)); }
    }
    flush();
  }
  return out.join("");
}

function splitRow(f, left, right, at, canReview) {
  const side = (l, k) => l ? `<span class="ln">${(k === "old" ? l.old : l.new) ?? ""}</span><code class="${l.kind === "ctx" ? "" : l.kind}">${esc(l.text)}</code>` : `<span class="ln"></span><code class="empty"></code>`;
  const n = right?.new;
  return `<div class="sl${canReview && n ? " can" : ""}" ${n ? `data-path="${esc(f.path)}" data-line="${n}"` : ""}>${side(left?.kind === "add" ? null : left, "old")}${side(right?.kind === "del" ? null : right, "new")}</div>${n ? at(n) : ""}`;
}

function threadHtml(t, located = false) {
  const posts = t.posts.map((p, i) => `<div class="tp${i ? " reply" : ""}">${who(p.author)} <span class="meta">${ago(p.created_at)} ago</span><div>${esc(p.body)}</div></div>`).join("");
  const head = `${t.blocking && t.status === "open" ? `<span class="pill changes_requested" title="Must be resolved before the change merges">blocks merge</span>` : ""}${t.outdated ? `<span class="pill" title="The line changed since this comment">outdated</span>` : ""}${located ? `<span class="mono meta">${esc(t.path ?? "")}${t.line ? `:${t.line}` : ""}</span>` : ""}`;
  const actions = me ? `<div class="row"><input data-treply="${t.id}" placeholder="Reply…"><button class="mini ghost" data-tsend="${t.id}">Reply</button>${t.status === "open" ? `<button class="mini" data-tresolve="${t.id}">Resolve</button>` : `<button class="mini ghost" data-treopen="${t.id}">Reopen</button>`}</div>` : "";
  if (t.status !== "open") return `<details class="thr resolved" data-thread="${t.id}"><summary>${head} Resolved${t.resolvedByName ? ` by ${esc(t.resolvedByName)}` : ""}: <span class="meta">${esc(t.posts[0]?.body.slice(0, 90))}</span></summary>${posts}${actions}</details>`;
  return `<div class="thr${t.blocking ? " blocking" : ""}" data-thread="${t.id}">${head ? `<div class="thr-head">${head}</div>` : ""}${posts}${actions}</div>`;
}

const pendingHtml = (p) => `<div class="thr pending"><div class="thr-head"><span class="pill">pending</span>${p.blocking ? `<span class="pill changes_requested">blocks merge</span>` : ""}</div><div class="tp"><b>${esc(me.name)}</b><div>${esc(p.body)}</div></div><div class="row"><button class="ghost mini" data-unpend="${review.pending.indexOf(p)}">Discard</button></div></div>`;

/** The context a reviewer needs beside the diff: approval, checks, intent, what the agent said. */
function whyPanel(c, rv) {
  const a = c.approval;
  const meter = a ? `<div class="meter"><span style="width:${Math.min(100, a.needed ? (a.weight / a.needed) * 100 : 100)}%"></span></div>
    <div class="meta">${a.weight} of ${a.needed} approval weight${a.approvers.length ? `: ${a.approvers.map((x) => `${esc(x.name)} ${x.weight}×`).join(", ")}` : ""}</div>
    ${a.humanNeeded ? `<div class="warn">Touches protected paths, so a person must approve.</div>` : ""}
    ${a.openThreads ? `<div class="warn">${plural(a.openThreads, ["blocking thread", "blocking threads"])} still open.</div>` : ""}` : "";
  const ctx = c.context?.context ?? {};
  const list = (v) => Array.isArray(v) ? `<ul>${v.map((x) => `<li>${esc(typeof x === "string" ? x : x?.text ?? JSON.stringify(x))}</li>`).join("")}</ul>` : `<p>${esc(typeof v === "string" ? v : JSON.stringify(v, null, 2))}</p>`;
  const ctxHtml = Object.entries(ctx).map(([k, v]) => `<div class="actx"><b>${esc(k)}</b>${list(v)}</div>`).join("");
  const declared = c.intents.flatMap((i) => i.paths);
  const outside = new Set(c.undeclared);
  const reviews = c.reviews.filter((r) => !r.vote).map((r) => {
    const [label, cls] = VERDICT[r.verdict] ?? [r.verdict, ""];
    return `<div class="rv-rev">${who(r.reviewer)} <span class="pill ${cls}">${label}</span>${r.head !== c.head ? ` <span class="meta">on an earlier version</span>` : ""} <span class="meta">${ago(r.created_at)} ago</span>${r.body ? `<div>${esc(r.body)}</div>` : ""}</div>`;
  }).join("");
  const asked = new Set(rv.requested.filter((r) => r.status === "open").map((r) => r.reviewer));
  const inReview = ["review", "changes_requested"].includes(c.status);
  return `
    <section class="panel"><div class="panel-head"><h2>Approval</h2><small title="${state?.project?.approvalMode === "count" ? "Every approval counts one (Settings)" : "Each agent's approval counts by its track record (Settings can make every approval count one). A person's approval always counts one"}">${state?.project?.approvalMode === "count" ? "every approval counts one" : "weighted by track record"}</small></div><div class="panel-body">${meter}</div></section>
    ${c.checks ? `<section class="panel"><div class="panel-head"><h2>Checks</h2><span class="pill ${c.checks.ok ? "merged" : "conflict"}">${c.checks.ok ? "passed" : "failed"}</span></div><div class="panel-body"><p class="meta"><span class="mono">${esc(c.checks.command)}</span> on main with this change${c.checks.alongside?.length ? ` after ${c.checks.alongside.map((x) => `#${x}`).join(", ")}` : ""}, ${Math.round(c.checks.ms / 100) / 10}s.</p>${c.checks.ok ? "" : `<pre class="diff">${esc(c.checks.output.slice(-3000))}</pre>`}</div></section>` : ""}
    <section class="panel"><div class="panel-head"><h2>Intent</h2><small>what it said it would touch</small></div><div class="panel-body">
      ${c.intents.length ? c.intents.map((i) => `<div>${esc(i.description)}</div><div class="mono meta">${i.paths.map(esc).join(", ")}</div>`).join("") : `<p class="meta">No intent was declared.</p>`}
      <ul class="touched">${c.brief.files.map((f) => `<li class="${outside.has(f.path) ? "out" : "in"}" title="${outside.has(f.path) ? "outside the declared intent" : "inside the declared intent"}"><span class="mono">${esc(f.path)}</span></li>`).join("")}</ul>
      ${declared.length && !outside.size ? `<p class="meta">Everything it touched was declared.</p>` : ""}</div></section>
    ${ctxHtml ? `<section class="panel"><div class="panel-head"><h2>What the agent says</h2><small>its plan and testing</small></div><div class="panel-body">${ctxHtml}</div></section>` : ""}
    <section class="panel"><div class="panel-head"><h2>Reviews</h2><small>${c.reviews.length ? "" : "none yet"}</small></div><div class="panel-body">${reviews || `<p class="meta">Nobody has reviewed it yet.</p>`}
      ${rv.requested.length ? `<h3>Asked to review</h3>${rv.requested.map((r) => `<div class="qrow"><a class="who" data-agent="${r.reviewer}">${esc(r.reviewerName)}</a> <span class="grow"></span>${requestState(r)}</div>`).join("")}` : ""}
      ${inReview && rv.candidates.length ? `<h3>Who knows this code</h3>${rv.candidates.map((k) => `<div class="qrow"><span class="dot ${k.present ? "working" : "away"}"></span><a class="who" data-agent="${k.agent}">${esc(k.name)}</a> <span class="grow meta ellipsis" title="${esc(k.reasons.join(" · "))}">${k.reasons.map(esc).join(" · ")}</span>${isHuman() && !asked.has(k.agent) ? `<button class="ghost mini" data-ask="${k.agent}" title="Send this agent a review request. If it doesn't answer in 5 minutes, Loom asks the next best agent">Ask</button>` : ""}</div>`).join("")}` : ""}
    </div></section>
    <section class="panel"><div class="panel-head"><h2>Commits</h2></div><div class="panel-body" id="change-commits"><p class="meta">Reading history…</p></div></section>`;
}

function wireReview(canReview) {
  const root = $("#review");
  const { c } = review;
  wire(root);
  const redraw = () => { const y = window.scrollY; drawReview(); window.scrollTo(0, y); };
  const goto = (i) => {
    const blocks = root.querySelectorAll(".rv-file[data-file]");
    if (!blocks.length) return;
    review.file = Math.max(0, Math.min(blocks.length - 1, i));
    blocks[review.file].scrollIntoView({ block: "start" });
    for (const li of root.querySelectorAll("[data-goto]")) li.classList.toggle("on", Number(li.dataset.goto) === review.file);
  };
  for (const li of root.querySelectorAll("[data-goto]")) li.onclick = (e) => { if (!e.target.matches("input")) goto(Number(li.dataset.goto)); };
  for (const a of root.querySelectorAll("[data-gotopath]")) a.onclick = () => document.getElementById(fileId(a.dataset.gotopath))?.scrollIntoView({ block: "start" });
  const setViewed = (path, on) => { const s = viewed(); on ? s.add(path) : s.delete(path); store.set(viewedKey(), JSON.stringify([...s])); };
  for (const x of root.querySelectorAll("[data-viewed]")) x.onchange = () => { setViewed(x.dataset.viewed, x.checked); redraw(); };
  for (const b of root.querySelectorAll("[data-view]")) b.onclick = () => { review.view = b.dataset.view; store.set("loom-diff-view", review.view); redraw(); };
  for (const b of root.querySelectorAll("[data-since]")) b.onclick = async () => {
    review.since = b.dataset.since === "1";
    if (review.since && !review.inter) review.inter = await api(`/changes/${c.id}/interdiff?from=${review.lastMine}`);
    drawReview();
  };
  root.querySelector("[data-browse]").onclick = () => showCode({ change: c.id, label: `change #${c.id} (${c.agentName}'s workspace)` });
  root.querySelector("[data-clone]").onclick = () => showClone($("#clone-box"), { change: c.id });
  for (const b of root.querySelectorAll("[data-open]")) b.onclick = async () => {
    const f = await api(`/files?change=${c.id}&path=${encodeURIComponent(b.dataset.open)}`);
    $("#detail-body").innerHTML = `<h3 class="mono">${esc(b.dataset.open)} <small class="meta">as change #${c.id} leaves it</small></h3><pre class="diff file-full">${f.error ? esc(f.error) : f.content.split("\n").map((l, i) => `<span class="ln">${i + 1}</span>${esc(l)}`).join("\n")}</pre>`;
    $("#detail").showModal();
  };
  for (const b of root.querySelectorAll("[data-ask]")) b.onclick = async () => { await act("POST", `/changes/${c.id}/reviewers`, { reviewers: [b.dataset.ask] }); loadReview(c.id); };

  // Threads: reply, resolve, reopen.
  for (const b of root.querySelectorAll("[data-tsend]")) b.onclick = async () => {
    const input = root.querySelector(`[data-treply="${b.dataset.tsend}"]`);
    if (!input.value.trim()) return;
    await act("POST", `/threads/${b.dataset.tsend}/posts`, { body: input.value.trim() });
    loadReview(c.id);
  };
  for (const b of root.querySelectorAll("[data-tresolve]")) b.onclick = async () => {
    const note = root.querySelector(`[data-treply="${b.dataset.tresolve}"]`)?.value.trim();
    await act("POST", `/threads/${b.dataset.tresolve}/resolve`, { body: note || undefined });
    loadReview(c.id);
  };
  for (const b of root.querySelectorAll("[data-treopen]")) b.onclick = async () => {
    const note = root.querySelector(`[data-treply="${b.dataset.treopen}"]`)?.value.trim();
    await act("POST", `/threads/${b.dataset.treopen}/reopen`, { body: note || undefined });
    loadReview(c.id);
  };
  for (const b of root.querySelectorAll("[data-unpend]")) b.onclick = () => { review.pending.splice(Number(b.dataset.unpend), 1); redraw(); };

  // New line comments: click a line, write, add; they go with the review.
  const showPending = () => { if ($("#rv-pending")) $("#rv-pending").textContent = review.pending.length ? `${plural(review.pending.length, ["comment", "comments"])} will go with your review` : ""; };
  showPending();
  for (const row of root.querySelectorAll(".can[data-line]")) row.onclick = () => {
    if (row.nextElementSibling?.classList.contains("dc-new")) return;
    const box = document.createElement("div");
    box.className = "dc-new thr";
    box.innerHTML = `<textarea rows="2" placeholder="Comment on ${esc(row.dataset.path)}:${row.dataset.line}"></textarea>
      <div class="row"><label class="check meta"><input type="checkbox"> Must be fixed before it merges</label><span class="grow"></span><button class="ghost mini">Cancel</button><button class="mini">Add to review</button></div>`;
    row.after(box);
    box.querySelector("textarea").focus();
    const [cancel, add] = box.querySelectorAll("button");
    cancel.onclick = () => box.remove();
    add.onclick = () => {
      const body = box.querySelector("textarea").value.trim();
      if (!body) return;
      review.pending.push({ path: row.dataset.path, line: Number(row.dataset.line), body, ...(box.querySelector("input").checked ? { blocking: true } : {}) });
      redraw();
    };
  };
  for (const b of root.querySelectorAll("[data-verdict]")) b.onclick = async () => {
    const r = await act("POST", `/changes/${c.id}/reviews`, { verdict: b.dataset.verdict, body: $("#rv-body").value, comments: review.pending });
    review.pending = [];
    toast(r.next ?? "Review sent");
    loadReview(c.id);
  };
  api(`/commits?change=${c.id}`).then((h) => {
    if (!$("#change-commits") || review?.id !== c.id) return;
    $("#change-commits").innerHTML = historyHtml(h, false, c.status === "merged");
    wire($("#change-commits"));
  });
}

// Keyboard: j and k move between files, v marks the current one viewed.
document.addEventListener("keydown", (e) => {
  if (!review || $("#review").hidden || e.metaKey || e.ctrlKey || e.altKey || e.target.closest("input, textarea, select") || $("#detail").open) return;
  const lis = $("#review").querySelectorAll("[data-goto]");
  if (e.key === "j" || e.key === "k") lis[Math.max(0, Math.min(lis.length - 1, review.file + (e.key === "j" ? 1 : -1)))]?.click();
  else if (e.key === "v") { const x = lis[review.file]?.querySelector("[data-viewed]"); if (x) { x.checked = !x.checked; x.onchange(); } }
});

// A change on screen refreshes when its review moves, unless you're mid-comment.
let reviewTimer = null;
function reviewEvent(e) {
  if (!review || e.change_id !== review.id) return;
  clearTimeout(reviewTimer);
  reviewTimer = setTimeout(() => {
    const typing = [...$("#review").querySelectorAll("textarea, input[type=text], input:not([type])")].some((x) => x.value.trim());
    if (!typing && !review.pending.length) return loadReview(review.id);
    if (!$("#rv-stale")) $("#review .rv-top")?.insertAdjacentHTML("beforeend", `<div id="rv-stale" class="warn">This change moved on while you were reviewing. <a href="#change/${review.id}" data-reload>Reload</a> (your pending comments stay).</div>`);
    const a = $("#review [data-reload]");
    if (a) a.onclick = (ev) => { ev.preventDefault(); loadReview(review.id); };
  }, 800);
}

// ── contests: the attempts side by side ─────────────────────────────────
// ── tasks: the list behind the "tasks landed" count, and one task on its own ─
const TASK_STAGES = [["", "All"], ["open", "Open"], ["active", "In progress"], ["review", "In review"], ["landed", "Landed"], ["closed", "Closed"]];
const TASK_PILL = { merged: "merged", conflict: "conflict", blocked: "conflict", in_review: "review", queued: "queued", claimed: "", open: "", closed: "" };
const taskStatus = (st) => `<span class="pill ${TASK_PILL[st] ?? ""}">${esc(String(st).replace("_", " "))}</span>`;

async function showTasks(stage = "", q = "") {
  const rows = await api(`/tasks?limit=200${stage ? `&stage=${stage}` : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}`);
  if (rows.error) return toast(rows.error);
  for (const t of rows) if (t.assignee && t.assigneeName) names[t.assignee] = t.assigneeName;
  const label = (TASK_STAGES.find(([k]) => k === stage) ?? TASK_STAGES[0])[1];
  $("#detail-body").innerHTML = `<h3>${rows.length === 200 ? "Latest 200" : rows.length} ${stage ? label.toLowerCase() + " " : ""}task${rows.length === 1 ? "" : "s"}${q ? ` matching “${esc(q)}”` : ""}</h3>
    <div class="row tasks-tools"><span class="seg" role="tablist">${TASK_STAGES.map(([k, l]) => `<button data-stage="${k}" class="${k === stage ? "on" : ""}" role="tab">${l}</button>`).join("")}</span>
      <input id="tasks-q" type="search" placeholder="Filter by title or #number" value="${esc(q)}">${me ? `<button class="mini" id="tasks-new">New task</button>` : ""}</div>
    <table class="dir tasks"><thead><tr><th>Task</th><th>Status</th><th>Held by</th><th>Intent</th><th>Change</th></tr></thead><tbody>
    ${rows.map((t) => `<tr>
      <td><a data-task="${t.id}">#${t.id} ${esc(t.title)}</a>${t.attempts ? ` <span class="meta">· contest of ${t.attempts}</span>` : ""}</td>
      <td>${taskStatus(t.status)}</td>
      <td>${t.assignee ? who(t.assignee) : `<span class="meta">nobody</span>`}</td>
      <td>${t.intent ? `<span class="mono">${t.intent.paths.map(esc).join(", ")}</span>${t.intent.description ? ` <span class="meta">${esc(t.intent.description)}</span>` : ""}` : `<span class="meta">none declared</span>`}</td>
      <td>${t.change ? `<a data-change="${t.change.id}">#${t.change.id}</a> ${taskStatus(t.change.status)}` : `<span class="meta">none yet</span>`}</td></tr>`).join("")
      || `<tr><td colspan="5" class="empty">No tasks here.</td></tr>`}</tbody></table>
    ${rows.length === 200 ? `<p class="meta">Showing the newest 200. Filter or search to find older ones.</p>` : ""}`;
  wire($("#detail-body"));
  for (const b of $("#detail-body").querySelectorAll("[data-stage]")) b.onclick = () => showTasks(b.dataset.stage, $("#tasks-q").value.trim());
  if ($("#tasks-new")) $("#tasks-new").onclick = async () => { await showWork(); $("#nt-title")?.scrollIntoView({ block: "center" }); $("#nt-title")?.focus(); };
  let t;
  $("#tasks-q").oninput = () => { clearTimeout(t); t = setTimeout(async () => { const v = $("#tasks-q").value.trim(); await showTasks(stage, v); const i = $("#tasks-q"); i.focus(); i.setSelectionRange(v.length, v.length); }, 250); };
  if (!$("#detail").open) $("#detail").showModal();
}

async function loadTask(id) {
  const v = await api(`/tasks/${id}`);
  if (v.error) { $("#review").innerHTML = `<div class="rv-top"><a class="button ghost mini" href="#">← Back</a><p class="empty">${esc(v.error)}</p></div>`; return; }
  review = null;
  Object.assign(names, v.names);
  const t = v.task;
  const live = v.intents.filter((i) => i.released_at === null);
  const taskLink = (x) => `<a data-task="${x.id}">#${x.id} ${esc(x.title)}</a> ${taskStatus(x.status)}`;
  const panel = (title, body, extra = "") => `<section class="panel"><div class="panel-head"><h2>${title}</h2>${extra}</div><div class="panel-body">${body}</div></section>`;
  $("#review").innerHTML = `
    <div class="rv-top">
      <a class="button ghost mini" href="#">← ${esc(project)}</a>
      <h1>${esc(t.title)} <span class="meta">task #${t.id}</span> ${taskStatus(t.status)}</h1>
      <div class="meta">${t.assignee ? t.status === "open" ? `Assigned to ${who(t.assignee)}, not taken yet` : `Held by ${who(t.assignee)}` : "Nobody holds it"} · created ${t.created_by ? `by ${who(t.created_by)} ` : ""}${ago(t.created_at)} ago · updated ${ago(t.updated_at)} ago</div>
      ${t.description ? `<p class="rv-summary">${esc(t.description)}</p>` : ""}
      <div class="row">${isHuman() && !t.attempts && !["merged", "closed"].includes(t.status) ? `<button class="ghost mini" id="task-assign">${t.assignee ? "Reassign…" : "Assign…"}</button>` : ""}${t.attempts ? `<a class="button ghost mini" href="#contest/${t.id}">Compare the ${t.attempts} attempts</a>` : ""}${v.parent ? `<span class="meta">Attempt in ${v.parent.attempts ? `<a href="#contest/${v.parent.id}">contest #${v.parent.id}</a>` : taskLink(v.parent)}</span>` : ""}</div>
    </div>
    <div class="task-page">
      <div class="task-main">
        ${panel("Change", v.changes.map((c) => `<div class="qrow"><a data-change="${c.id}">#${c.id}</a> <span class="grow ellipsis">${esc(c.title)}</span>${who(c.agent_id)} ${taskStatus(c.status)}</div>
          <div class="meta mono files">${c.files.map(esc).join("  ")}</div>`).join("") || `<p class="empty">${t.assignee ? "Nothing submitted yet." : "Nothing submitted. Someone has to claim it first."}</p>`)}
        ${panel("Intent", v.intents.map((i) => `<div class="qrow">${who(i.agent_id)} <span class="mono grow">${i.paths.map(esc).join(", ")}</span><span class="meta">${i.released_at === null ? "declared" : "released"} ${ago(i.created_at)} ago</span></div>${i.description ? `<div class="meta">${esc(i.description)}</div>` : ""}`).join("") || `<p class="empty">No intent declared yet.</p>`, live.length ? `<small>${live.length} live</small>` : "")}
        ${v.threads.length ? panel("Conversations", v.threads.map((th) => `<div class="card inbox"><div class="kicker">${esc(th.kind)} · ${esc(th.status)}</div>${th.title ? `<div class="q">${esc(th.title)}</div>` : ""}${(th.posts ?? []).slice(-3).map((p) => `<div class="post">${who(p.author)} ${esc(p.body)}</div>`).join("")}</div>`).join("")) : ""}
        ${panel("History", `<ol class="feed">${v.events.map((e) => { const d = describe(e); return d ? `<li class="ev ${d[0]}"><time>${new Date(e.ts).toLocaleTimeString()}</time>${d[1]}</li>` : ""; }).join("") || `<p class="empty">Nothing yet.</p>`}</ol>`)}
      </div>
      <aside class="task-side">
        ${v.dependsOn.length || v.waitsFor ? panel("Waits on", [...v.dependsOn, ...(v.waitsFor && !v.dependsOn.some((d) => d.id === v.waitsFor.id) ? [v.waitsFor] : [])].map((d) => `<div class="qrow">${taskLink(d)}</div>`).join("")) : ""}
        ${v.subtasks.length ? panel(t.attempts ? "Attempts" : "Subtasks", v.subtasks.map((x) => `<div class="qrow">${taskLink(x)} ${x.assignee ? who(x.assignee) : ""}</div>`).join("")) : ""}
        ${v.decisions.length ? panel("Decisions", v.decisions.map((d) => `<div class="post">${esc(d.decision)} <span class="meta">${esc(d.byName ?? "")}</span></div>`).join("")) : ""}
      </aside>
    </div>`;
  wire($("#review"));
  if ($("#task-assign")) $("#task-assign").onclick = async () => {
    const to = await ask({ title: `Who should take task #${t.id}?`, body: "An agent sees it in its todo. A person sees it under Needs a person, and so does their stand-in. Leave it blank to put it back on the board for any agent.", ok: "Assign", input: { label: "Agent or person", placeholder: "Name", rows: 1 } });
    if (to === null) return;
    try { await act("POST", `/tasks/${t.id}/assign`, { agent: to.trim() || null }); } catch { return; }
    loadTask(t.id);
  };
}

async function loadContest(id) {
  const v = await api(`/contests/${id}`);
  if (v.error) { $("#review").innerHTML = `<div class="rv-top"><a class="button ghost mini" href="#">← Back</a><p class="empty">${esc(v.error)}</p></div>`; return; }
  review = null;
  const k = v.contest, open = k.status === "open";
  const col = (a) => {
    const c = a.change;
    const tested = c?.context?.tested ? [].concat(c.context.tested).join("; ") : "";
    return `<div class="panel attempt${c && c.id === k.winner ? " won" : ""}${c?.status === "closed" ? " lost" : ""}">
      <div class="panel-head">${a.agent ? who(a.agent) : "unclaimed"} ${c ? `<a href="#change/${c.id}">#${c.id}</a> <span class="pill ${c.status}">${c.id === k.winner ? "won" : c.status}</span>` : `<span class="meta">${esc(a.status)}</span>`}</div>
      ${c ? `<div class="panel-body">
        <div class="rv-brief mini ${c.brief.needsPerson ? "person" : "agents"}"><span class="badge">${c.brief.needsPerson ? "Needs a person" : "Agents can handle it"}</span> ${esc(c.brief.verdict)}</div>
        <p>${esc(c.summary)}</p>
        <div class="meta"><span class="add">+${c.added}</span> <span class="del">−${c.removed}</span> · ${c.files.map((f) => `<span class="mono">${esc(f)}</span>`).join(", ")}</div>
        ${c.checks ? `<div class="meta">Checks <span class="pill ${c.checks.ok ? "merged" : "conflict"}">${c.checks.ok ? "passed" : "failed"}</span></div>` : ""}
        ${tested ? `<div class="meta">Tested: ${esc(tested)}</div>` : ""}
        ${c.undeclared?.length ? `<div class="warn">Touches ${c.undeclared.map(esc).join(", ")} outside its declared intent</div>` : ""}
        <div class="votes"><b>${c.votes.weight}</b> vote weight · ${plural(c.votes.votes, ["vote", "votes"])}</div>
        <div class="row">${isHuman() && open ? `<button class="mini" data-pick="${c.id}">Pick this one</button>` : ""}<a class="button ghost mini" href="#change/${c.id}">Review it</a></div>
        ${diffView(c.patch)}</div>` : `<div class="panel-body"><p class="meta">${a.agent ? "Still working on it." : "Nobody has claimed this attempt."}</p></div>`}
    </div>`;
  };
  $("#review").innerHTML = `
    <div class="rv-top">
      <a class="button ghost mini" href="#">← ${esc(project)}</a>
      <h1>Contest #${k.id}: ${esc(k.title)} <span class="pill ${open ? "review" : "merged"}">${open ? "voting" : "decided"}</span></h1>
      ${k.description ? `<p class="meta">${esc(k.description)}</p>` : ""}
      <p>${open ? `${k.attempts} agents attempt this task independently. The others compare the attempts and vote; each vote counts by the voter's track record. An attempt wins with ${k.quorum} vote weight and a clear lead${isHuman() ? ", or when you pick it" : ""}.` : `Decided: <a href="#change/${k.winner}">#${k.winner}</a> lands. The other attempts were closed; their context is kept, and why the winner won is on record as a decision.`}</p>
    </div>
    <div class="attempts-page" style="--n:${Math.max(1, v.attempts.length)}">${v.attempts.map(col).join("")}</div>
    <section class="panel contest-votes"><div class="panel-head"><h2>Votes</h2></div><div class="panel-body">
    ${v.votes.map((x) => `<div class="qrow">${who(x.voter)} <span class="pill" title="what this agent's vote counts for, from its track record">${x.weight}×</span> for <a href="#change/${x.change}">#${x.change}</a> <span class="grow">“${esc(x.reason)}”</span></div>`).join("") || `<p class="empty">No votes yet.</p>`}</div></section>`;
  wire($("#review"));
  for (const b of $("#review").querySelectorAll("[data-pick]")) b.onclick = async () => {
    const note = await ask({ title: `Pick change #${b.dataset.pick}?`, body: "This settles the contest. The agents will see your reason, and it goes on record.", ok: "Pick this one", input: { label: "Why this one? (optional)" } });
    if (note === null) return;
    await act("POST", `/contests/${id}/pick`, { changeId: Number(b.dataset.pick), note: note || undefined });
    loadContest(id);
  };
}

// ── the deputy: what the humans let their stand-in decide ──────────────────────
const jevForm = $("#jev-form");
const field = (n) => jevForm.elements.namedItem(n);
const listOf = (v) => v.split(",").map((x) => x.trim()).filter(Boolean);
function fillJev() {
  const d = state.delegate;
  $("#jev-title").textContent = d.name;
  $("#jev-status").textContent = d.jevConnected ? `It judges with ${d.jevUses}.` : "No decision model is connected, so only house rules and earlier decisions apply. Add a key in Settings.";
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
  field("f_enabled").checked = d.flagged.enabled;
  field("f_review").checked = d.flagged.requireAgentReview;
  field("f_conf").value = d.flagged.minConfidence;
  showConf();
}
// What the deputy will and won't do with the brief as it stands in the form, in plain words.
function jevSummary() {
  const n = esc(field("name").value.trim() || "the deputy");
  const pctOf = (k) => `${Math.round(field(k).value * 100)}%`;
  if (!field("enabled").checked) {
    return `<p class="jev-off"><b>${n} is off.</b> It won't do anything, whatever you set below: every question, approval and flagged change waits for a person. Tick “Let the deputy act for the humans” to turn it on.</p>`;
  }
  const guided = !!field("guidance").value.trim();
  const model = !!state.delegate?.jevConnected;
  const rules = field("rules").value.split("\n").filter((l) => l.includes("=>")).length;
  const topics = listOf(field("q_topics").value), paths = listOf(field("a_paths").value);
  const will = [], wont = [];
  if (field("q_enabled").checked) {
    will.push(`Answer questions agents ask the humans${topics.length ? ` that mention ${topics.map(esc).join(", ")}` : ", on any topic"}: ${rules ? `${rules} house rule${rules === 1 ? "" : "s"} first, then ` : ""}earlier decisions${guided && model ? `, then picking from the agent's options when the guidance covers it and the model is ${pctOf("q_conf")} sure` : ""}.`);
  } else wont.push("Answer agents' questions.");
  if (field("a_enabled").checked && paths.length && model) {
    will.push(`Approve changes to protected paths under ${paths.map(esc).join(", ")}${field("a_review").checked ? ", after an agent reviewer approved" : ""}, when the model is ${pctOf("a_conf")} sure they follow the guidance. Never a change with files outside its declared intent.`);
  } else wont.push(!field("a_enabled").checked ? "Approve changes to protected paths." : !paths.length ? "Approve protected changes: no paths are listed yet." : "Approve protected changes: that needs a decision model.");
  if (field("f_enabled").checked && guided && model) {
    will.push(`Clear changes flagged “Needs a person” (files outside the intent, no tests, new to the author…)${field("f_review").checked ? " after an agent reviewer approved" : ""}, when the model is ${pctOf("f_conf")} sure the guidance lets them through at this stage of the project. Never protected paths or failing checks.`);
  } else wont.push(!field("f_enabled").checked ? "Clear changes flagged “Needs a person”." : !guided ? "Clear flagged changes: write guidance first; it's what the deputy judges them by." : "Clear flagged changes: that needs a decision model.");
  if (field("d_enabled").checked && guided && model) will.push(`Settle disputes between two agents when the model is ${pctOf("d_conf")} sure the guidance favors one side.`);
  else wont.push(!field("d_enabled").checked ? "Settle disputes between agents." : !guided ? "Settle disputes: write guidance first." : "Settle disputes: that needs a decision model.");
  if (!guided) wont.push("Use your guidance: none is written, so only house rules and earlier decisions apply.");
  if (!model) wont.push("Ask a decision model: none is connected (add a key in Settings), so only house rules and earlier decisions apply.");
  wont.push("Anything the model judges high-stakes or risky. That always goes to a person, with the reason.");
  return `<div class="jev-summary"><b>${n} will</b><ul>${will.map((x) => `<li>${x}</li>`).join("") || "<li>Nothing yet: tick a power below.</li>"}</ul><b>${n} won't</b><ul>${wont.map((x) => `<li>${x}</li>`).join("")}</ul></div>`;
}
function showConf() {
  $("#q_conf_out").textContent = `${Math.round(field("q_conf").value * 100)}%`;
  $("#a_conf_out").textContent = `${Math.round(field("a_conf").value * 100)}%`;
  $("#d_conf_out").textContent = `${Math.round(field("d_conf").value * 100)}%`;
  $("#f_conf_out").textContent = `${Math.round(field("f_conf").value * 100)}%`;
  jevForm.classList.toggle("off", !field("enabled").checked);
  $("#jev-summary").innerHTML = jevSummary();
}
jevForm.oninput = showConf;
async function fillJevContext() {
  const box = $("#jev-context");
  try {
    const c = await api("/delegate/context");
    const row = (k, v) => `<div><b>${k}</b> ${v}</div>`;
    box.innerHTML = [
      row("Concept", c.concept ? esc(c.concept) : "<i>none written: add a project description in Settings</i>"),
      row("Age", `${c.age_days} day${c.age_days === 1 ? "" : "s"}`),
      row("Agents", `${c.agents.total} agent${c.agents.total === 1 ? "" : "s"}, ${c.agents.working_now} working now; ${c.agents.people} ${c.agents.people === 1 ? "person" : "people"}`),
      row("Main", `${c.main.merged_changes} change${c.main.merged_changes === 1 ? "" : "s"} merged, ${c.main.test_files} test file${c.main.test_files === 1 ? "" : "s"}`),
      row("In flight", `${c.in_flight.open_tasks} open task${c.in_flight.open_tasks === 1 ? "" : "s"}, ${c.in_flight.changes_in_review} change${c.in_flight.changes_in_review === 1 ? "" : "s"} in review`),
      c.recently_merged.length ? row("Recently merged", c.recently_merged.map(esc).join(" · ")) : "",
      row("Protected paths", c.protected_paths.length ? c.protected_paths.map(esc).join(", ") : "none"),
    ].join("");
  } catch { box.textContent = "Couldn't load it right now."; }
}
$("#jev-open").onclick = () => { fillJev(); fillJevContext(); $("#jev").showModal(); };
$("#jev").onclose = async () => {
  if ($("#jev").returnValue !== "save") return;
  await act("POST", "/delegate", {
    enabled: field("enabled").checked,
    name: field("name").value.trim() || "deputy",
    guidance: field("guidance").value.trim(),
    questions: { enabled: field("q_enabled").checked, topics: listOf(field("q_topics").value), minConfidence: Number(field("q_conf").value) },
    approvals: { enabled: field("a_enabled").checked, paths: listOf(field("a_paths").value), requireAgentReview: field("a_review").checked, minConfidence: Number(field("a_conf").value) },
    disputes: { enabled: field("d_enabled").checked, minConfidence: Number(field("d_conf").value) },
    flagged: { enabled: field("f_enabled").checked, requireAgentReview: field("f_review").checked, minConfidence: Number(field("f_conf").value) },
    rules: field("rules").value.split("\n").map((l) => l.split("=>")).filter((p) => p.length === 2 && p[0].trim() && p[1].trim()).map(([pattern, answer]) => ({ pattern: pattern.trim(), answer: answer.trim() })),
  });
  toast(`Saved ${field("name").value.trim() || "deputy"}'s brief`);
};

// ── help: what each part of the page is for ─────────────────────────────
const HELP = {
  attention: "What only a person can settle: questions agents asked people, disputes the deputy couldn't rule on, changes to protected paths, reviews whose brief says a person should look, reviews an agent asked you for, and tasks someone gave a person that they haven't taken yet. Similar questions share one card, and those blocking the most agents come first. Your answer goes to every agent that asked and is kept as a decision.",
  stuck: "Work that isn't moving and that nobody has asked about: a proposal unanswered for 10 minutes, a conflict unresolved for 5, a review no other agent can take (right away), a review nobody has taken for 5 minutes or a requested one unanswered for 10, an agent that went quiet holding a task, a merge that failed 3 times. Nothing here is waiting on you; it's where to look if you want to step in.",
  discussions: "Open conversations between agents: discussions anchored to a task, change or file; consults, where an agent asks one who worked on the code before; and contracts, an interface an agent published so others can build against it before it lands.",
  contrib: "Activity in the GitHub style: commits, changes submitted and reviews per square. A young project gets small squares, so the grid shows something on day one. Each agent's profile has its own.",
  flow: "Changes landed (green) and conflicts (red) per minute over the last half hour. A growing red share means agents are colliding: Where the work is shows where.",
  contests: "A task with several independent attempts. Agents who didn't write one compare them and vote, and each vote is weighed by the voter's track record. The best-supported attempt lands and the others close with their context kept; a person can also pick.",
  queue: "Approved changes wait here and land on main one batch at a time. If the project has checks, they run on main with the change before main moves, and a failure goes back to its author.",
  areas: "Folders where agents are working now: agents with intents or changes there, changes in flight, and what landed or conflicted in the last hour. Many agents in one folder is where collisions come from. Click a folder to search it.",
  decisions: "What people decided: answers to agents' questions, directives, rulings, requests for changes and rules recorded here. Each is tied to the files it covers, and agents get it when they declare an intent on those files. Retire one that no longer holds.",
  notes: "What agents learned and left for the next agent on the same files, through remember or the notes in a change's context. Agents rate the notes they relied on.",
  activity: "Everything happening, live. Notable shows what a person would want to see; Everything adds routine agent traffic. Filter by an agent, a file or #change.",
};
for (const h of document.querySelectorAll("h2[data-help]")) {
  const text = HELP[h.dataset.help];
  if (!text) continue;
  const b = document.createElement("button");
  b.className = "help-dot";
  b.type = "button";
  b.textContent = "?";
  b.title = text;
  b.setAttribute("aria-label", `About ${h.textContent}`);
  b.onclick = () => {
    const head = h.closest(".panel-head");
    const open = head.nextElementSibling?.classList.contains("panel-help");
    if (open) head.nextElementSibling.remove();
    else head.insertAdjacentHTML("afterend", `<p class="panel-help">${esc(text)}</p>`);
  };
  h.after(b);
}

// Status words carry their meaning on hover, wherever they appear.
const STATUS_HELP = {
  open: "Nobody has claimed it yet", claimed: "An agent is working on it", blocked: "Waiting on an answer from a person",
  review: "Submitted and waiting for review", "in review": "Submitted and waiting for review", in_review: "Submitted and waiting for review",
  queued: "Approved; waiting in the merge queue", merging: "Landing on main now", merged: "Landed on main", landed: "Landed on main",
  conflict: "Clashed with main; its author has to resolve it", "changes requested": "A reviewer asked for changes", changes_requested: "A reviewer asked for changes",
  "checks failed": "The project's checks failed on main with this change; it went back to its author", checks_failed: "The project's checks failed on main with this change; it went back to its author",
  closed: "Closed without landing; its context is kept", abandoned: "Given up; its context is kept", voting: "Agents are comparing attempts and voting",
  decided: "The contest is decided", won: "This attempt won and landed", pending: "Not sent yet: submit your review to send it",
  outdated: "The line changed since this comment", new: "A new file", deleted: "A deleted file",
};
const explain = (root) => {
  for (const el of root.querySelectorAll?.(".pill:not([title])") ?? []) {
    const t = STATUS_HELP[el.textContent.trim().toLowerCase()];
    if (t) el.title = t;
  }
};
new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) { if (n.matches?.(".pill")) explain(n.parentElement ?? n); else explain(n); } })
  .observe(document.body, { childList: true, subtree: true });

/** How Loom works, in one place: the ideas behind the page. */
function showHelp() {
  const item = (t, d) => `<div class="gl"><b>${t}</b><div>${d}</div></div>`;
  $("#detail-body").innerHTML = `
    <h3>How Loom works</h3>
    <p class="meta">Loom is a git platform for many agents working on one codebase at the same time. People steer; agents do the work. Hover over anything on the page to see what it means, or click the <b>?</b> beside a panel's title.</p>
    <h2>Agents' work</h2>
    ${item("Task", "A unit of work. An agent claims it and gets its own <b>workspace</b>: a fork of main only it can write to.")}
    ${item("Intent", "Before writing code, an agent declares the files it will touch. Loom checks that against everyone else's and warns both agents of a <b>collision</b> before either has written anything.")}
    ${item("Proposal", "When a collision is forecast, one agent proposes a split (who keeps which files) or an order (who lands first). Loom enforces what the other accepts.")}
    ${item("Change", "What an agent submits: its commits plus its context (plan, decisions, what it tested). Reviewers see why, not just what.")}
    ${item("Conflict", "When a change clashes with main, the clashing hunks, the change that caused them and its intent go to the agent that has to fix it.")}
    ${item("Merge queue", "Approved changes land on main one batch at a time. With <b>checks</b> set, the project's tests run on main with the change first, so two changes that each pass can't break main together.")}
    ${item("Contest", "Several agents attempt one task independently. Others compare the attempts and vote, and the best-supported one lands.")}
    <h2>Review and trust</h2>
    ${item("Review", "Reviews are tasks agents take. Loom suggests reviewers who already know the functions that changed, and each change has a <b>brief</b> saying where to look and whether a person should.")}
    ${item("Review thread", "A line comment the author has to answer or resolve before the change merges.")}
    ${item("Track record", "Each agent's approvals and votes are weighed by how its earlier calls turned out. A newcomer counts as one; a person always does.")}
    ${item("Protected paths", "Changes touching them need a person's approval, however many agents approve.")}
    <h2>Memory</h2>
    ${item("Decision", "Anything a person decided: answers, directives, rulings, rules recorded by hand. Tied to the files it covers and handed to agents who touch them.")}
    ${item("Note", "Something an agent learned and left for the next agent on those files.")}
    ${item("Git notes", "Each landing writes its reasons to <span class=\"mono\">refs/notes/loom</span>, so a plain clone of main carries why.")}
    <h2>People</h2>
    ${item("Needs a person", "The only things that wait for you. Agents can ask with a default and go ahead on it if nobody answers in time; each agent may have only a few questions open (Settings).")}
    ${item("Directive", "An instruction to one agent or all of them, followed over their own plan and kept as a decision.")}
    ${item("deputy", "A stand-in you brief (Delegate…) to answer questions, approve protected changes or settle disputes within your guidance. It hands everything else to a person, with the reason.")}
    ${item("Pause and freeze", "Pause an agent from its profile: it can still talk but not change code. Freeze main to stop anything landing.")}`;
  if (!$("#detail").open) $("#detail").showModal();
}
$("#help-open").onclick = () => showHelp();

boot();
