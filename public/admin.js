// The site's admin page: signups and usage. /api/admin/overview answers only the server's owners.
(() => {
  const main = document.getElementById("main");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const num = (n) => Number(n ?? 0).toLocaleString();
  const bytes = (b) => { b = Number(b ?? 0); const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0; while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; } return `${b < 10 && i ? b.toFixed(1) : Math.round(b)} ${u[i]}`; };
  const date = (t) => (t ? new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "");
  const ago = (t) => {
    if (!t) return "";
    const s = (Date.now() - t) / 1000;
    if (s < 90) return "just now";
    if (s < 5400) return `${Math.round(s / 60)} min ago`;
    if (s < 129600) return `${Math.round(s / 3600)} h ago`;
    if (s < 86400 * 45) return `${Math.round(s / 86400)} days ago`;
    return date(t);
  };
  let data = null;
  const sort = { people: { key: "firstSeen", dir: -1 }, projects: { key: "lastActivity", dir: -1 } };
  const filter = { q: "", hidden: false };

  const tile = (n, label) => `<div class="tile"><b>${n}</b><span>${label}</span></div>`;
  const bars = (series, key, title) => {
    const top = Math.max(1, ...series.map((d) => d[key]));
    const total = series.reduce((a, d) => a + d[key], 0);
    return `<div class="chart"><h3>${title} <span class="meta">(${num(total)} in 30 days)</span></h3>
      <div class="bars">${series.map((d) => `<div class="${d[key] ? "" : "z"}" style="height:${Math.max(2, (d[key] / top) * 100)}%" title="${esc(d.day)}: ${num(d[key])}"></div>`).join("")}</div>
      <div class="axis"><span>${esc(series[0]?.day)}</span><span>${esc(series.at(-1)?.day)}</span></div></div>`;
  };
  const head = (table, cols) => `<tr>${cols.map(([k, label, n]) => `<th class="${n ? "n" : ""}" data-t="${table}" data-k="${k}">${label}${sort[table].key === k ? (sort[table].dir > 0 ? " ▲" : " ▼") : ""}</th>`).join("")}</tr>`;
  const get = (o, k) => k.split(".").reduce((v, p) => v?.[p], o);
  const sorted = (rows, table) => {
    const { key, dir } = sort[table];
    return [...rows].sort((a, b) => {
      const x = get(a, key), y = get(b, key);
      if (typeof x === "string" || typeof y === "string") return dir * String(x ?? "").localeCompare(String(y ?? ""));
      return dir * ((x ?? -Infinity) - (y ?? -Infinity));
    });
  };
  const match = (...fields) => !filter.q || fields.some((f) => String(f ?? "").toLowerCase().includes(filter.q));

  function render() {
    const d = data, t = d.totals;
    const people = sorted(d.people.filter((p) => match(p.login, p.name, p.email, p.orgs.join(" "))), "people");
    const projects = sorted(d.projects.filter((p) => (filter.hidden || !p.hidden) && match(p.name, p.owner, p.org)), "projects");
    main.innerHTML = `
      <h1>Signups and usage</h1>
      <p class="meta">As of ${new Date(d.generatedAt).toLocaleString()}. ${d.signinsRecordedSince ? `Sign-ins recorded since ${date(d.signinsRecordedSince)}; first-seen dates before that are estimated from projects, orgs, plans and the waitlist (shown in grey).` : "Sign-ins are recorded from now on; first-seen dates so far are estimated from projects, orgs, plans and the waitlist (shown in grey)."} Site visits are in Google Analytics.</p>
      <div class="tiles">
        ${tile(num(t.people), "people")}
        ${tile(num(t.signups7d), "new in 7 days")}
        ${tile(num(t.signups30d), "new in 30 days")}
        ${tile(num(t.active7d), "active in 7 days")}
        ${tile(num(t.pro + t.proOrgs), `on Pro${t.proOrgs ? ` (${t.proOrgs} org${t.proOrgs === 1 ? "" : "s"})` : ""}`)}
        ${tile(num(t.waitlist), "on the waitlist")}
        ${tile(num(t.projects), `projects (${num(t.privateProjects)} private)`)}
        ${tile(num(t.orgs), "organizations")}
        ${tile(num(t.agents), `agents (${num(t.agentsActive7d)} active)`)}
        ${tile(num(t.changes), `changes (${num(t.changes7d)} this week)`)}
        ${tile(num(t.merged7d), "merged in 7 days")}
        ${tile(num(t.traces), "session traces")}
        ${tile(bytes(t.storageBytes), "traces + attachments")}
        ${tile(num(t.checkMinutes30d), "check minutes, 30 days")}
      </div>
      ${t.unreachable ? `<p class="err">${t.unreachable} project${t.unreachable === 1 ? "" : "s"} didn't answer; their numbers are missing.</p>` : ""}
      ${t.hiddenProjects ? `<p class="meta" style="margin-top:8px">Project totals leave out ${t.hiddenProjects} hidden project${t.hiddenProjects === 1 ? "" : "s"} (tests and demos).</p>` : ""}
      <h2>Over the last 30 days</h2>
      <div class="charts">${bars(d.signupsByDay, "n", "New people a day")}${bars(d.activityByDay, "merged", "Changes merged a day")}</div>

      <h2>People</h2>
      <div class="tools"><input id="q" type="search" placeholder="Filter by login, name, email, org or project" value="${esc(filter.q)}"><label><input type="checkbox" id="hid" ${filter.hidden ? "checked" : ""}> Show hidden projects</label></div>
      <div class="tablewrap"><table>
        ${head("people", [["login", "Person"], ["firstSeen", "First seen"], ["lastActive", "Last active"], ["signIns", "Sign-ins", 1], ["plan", "Plan"], ["owns.length", "Owns", 1], ["memberOf.length", "Member of", 1], ["usage.agents", "Agents", 1], ["usage.changes", "Changes", 1], ["usage.merged7d", "Merged 7d", 1], ["usage.traces", "Traces", 1], ["usage.storageBytes", "Storage", 1], ["email", "Email"]])}
        ${people.map((p) => `<tr>
          <td><div class="who">${p.avatar ? `<img src="${esc(p.avatar)}&s=44" alt="" loading="lazy">` : ""}<a href="https://github.com/${esc(p.login)}" target="_blank" rel="noopener">${esc(p.login)}</a>${p.name && p.name.toLowerCase() !== p.login ? ` <span class="meta">${esc(p.name)}</span>` : ""}${p.waitlisted ? `<span class="tag">waitlist</span>` : ""}${p.orgs.map((o) => `<span class="tag">${esc(o)}</span>`).join("")}</div></td>
          <td class="${p.firstSeenEstimated ? "est" : ""}" title="${p.firstSeenEstimated ? "estimated" : "first sign-in"}">${date(p.firstSeen)}</td>
          <td>${ago(p.lastActive)}</td>
          <td class="n">${p.signIns || ""}</td>
          <td>${p.plan === "pro" ? `<span class="tag pro">Pro${p.planStatus && p.planStatus !== "active" ? ` · ${esc(p.planStatus)}` : ""}</span>` : esc(p.plan)}</td>
          <td class="n" title="${esc(p.owns.join(", "))}">${p.owns.length || ""}</td>
          <td class="n" title="${esc(p.memberOf.join(", "))}">${p.memberOf.length || ""}</td>
          <td class="n">${p.usage.agents || ""}</td>
          <td class="n">${p.usage.changes || ""}</td>
          <td class="n">${p.usage.merged7d || ""}</td>
          <td class="n">${p.usage.traces || ""}</td>
          <td class="n">${p.usage.storageBytes ? bytes(p.usage.storageBytes) : ""}</td>
          <td>${esc(p.email)}</td></tr>`).join("") || `<tr><td colspan="13" class="meta">Nobody matches.</td></tr>`}
      </table></div>
      <p class="meta" style="margin-top:8px">A person's usage counts the projects they own themselves; an organization's projects are listed below.</p>

      <h2>Projects</h2>
      <div class="tablewrap"><table>
        ${head("projects", [["name", "Project"], ["owner", "Owner"], ["created", "Created"], ["lastActivity", "Last activity"], ["people", "People", 1], ["agents", "Agents", 1], ["agentsActive7d", "Active 7d", 1], ["tasks", "Tasks", 1], ["changes", "Changes", 1], ["merged", "Merged", 1], ["merged7d", "Merged 7d", 1], ["reviews", "Reviews", 1], ["traces", "Traces", 1], ["tokens", "Trace tokens", 1], ["storageBytes", "Storage", 1], ["checkMinutes30d", "Check min 30d", 1]])}
        ${projects.map((p) => `<tr>
          <td><a href="/?project=${encodeURIComponent(p.name)}">${esc(p.name)}</a>${p.private ? `<span class="tag">private</span>` : ""}${p.hidden ? `<span class="tag">hidden</span>` : ""}${p.jurisdiction ? `<span class="tag">${esc(p.jurisdiction)}</span>` : ""}${p.plan === "pro" ? `<span class="tag pro">Pro</span>` : ""}${p.error ? ` <span class="err" title="${esc(p.error)}">no answer</span>` : ""}</td>
          <td>${p.org ? `org <b>${esc(p.org)}</b>` : p.owner ? esc(p.owner) : `<span class="meta">admin token</span>`}</td>
          <td>${date(p.created)}</td>
          <td>${ago(p.lastActivity)}</td>
          ${["people", "agents", "agentsActive7d", "tasks", "changes", "merged", "merged7d", "reviews", "traces", "tokens"].map((k) => `<td class="n">${p[k] ? num(p[k]) : ""}</td>`).join("")}
          <td class="n">${p.storageBytes ? bytes(p.storageBytes) : ""}</td>
          <td class="n">${p.checkMinutes30d || ""}</td></tr>`).join("") || `<tr><td colspan="16" class="meta">No projects match.</td></tr>`}
      </table></div>

      ${d.orgs.length ? `<h2>Organizations</h2><div class="tablewrap"><table><tr><th>Org</th><th>Created by</th><th>Created</th><th class="n">People</th><th class="n">Projects</th></tr>
        ${d.orgs.map((o) => `<tr><td>${esc(o.name || o.slug)} <span class="meta">${esc(o.slug)}</span></td><td>${esc(o.created_by)}</td><td>${date(o.created_at)}</td><td class="n">${o.members}</td><td class="n">${o.projects}</td></tr>`).join("")}</table></div>` : ""}`;

    const q = document.getElementById("q");
    q.oninput = () => { filter.q = q.value.trim().toLowerCase(); const at = q.selectionStart; render(); const n = document.getElementById("q"); n.focus(); n.setSelectionRange(at, at); };
    document.getElementById("hid").onchange = (e) => { filter.hidden = e.target.checked; render(); };
    main.querySelectorAll("th[data-k]").forEach((th) => (th.onclick = () => {
      const s = sort[th.dataset.t];
      if (s.key === th.dataset.k) s.dir = -s.dir; else { s.key = th.dataset.k; s.dir = th.dataset.k === "login" || th.dataset.k === "name" ? 1 : -1; }
      render();
    }));
  }

  async function load() {
    const r = await fetch("/api/admin/overview", { credentials: "same-origin" }).catch(() => null);
    if (!r || !r.ok) {
      const why = r ? (await r.json().catch(() => ({}))).error : "couldn't reach the server";
      main.innerHTML = r?.status === 401
        ? `<div class="state"><p>Sign in with the site owner's GitHub account to see this page.</p><a class="button" href="/auth/github?return=/admin">Sign in with GitHub</a></div>`
        : `<div class="state"><p class="err">${esc(why || `HTTP ${r?.status}`)}</p></div>`;
      return;
    }
    data = await r.json();
    render();
  }
  document.getElementById("refresh").onclick = () => { main.innerHTML = `<div class="state">Loading…</div>`; load(); };
  load();
})();
