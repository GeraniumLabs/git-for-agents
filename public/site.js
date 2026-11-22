// The storefront's few behaviors: the import box, copy buttons, and links into the app.
(() => {
  const $ = (s) => document.querySelector(s);
  // An old link into the app (/#change/12) lands here when signed out: send it on to the app.
  if (location.hash && location.pathname === "/" && !document.getElementById(location.hash.slice(1))) {
    location.replace(`/?project=${location.hash}`);
    return;
  }
  try {
    // Someone who pasted an agent key into the app is a user already.
    if (location.pathname === "/" && Object.keys(localStorage).some((k) => k.startsWith("loom-key:"))) { location.replace("/?project="); return; }
  } catch {}

  const line = $("#mcp-line");
  if (line) line.textContent = line.textContent.replace("https://mergery.dev", location.origin);

  document.querySelectorAll("[data-copy]").forEach((b) => (b.onclick = async () => {
    window.mergeryAnalytics?.event("copy_setup", { what: b.dataset.copy.replace(/[^a-z0-9-]/gi, "").slice(0, 40) });
    try { await navigator.clipboard.writeText($(b.dataset.copy).textContent); b.textContent = "Copied"; setTimeout(() => (b.textContent = "Copy"), 1500); } catch {}
  }));

  // The privacy page's analytics switch, for this browser.
  const choice = $("#analytics-choice");
  const ga = window.mergeryAnalytics;
  if (choice && ga) {
    const show = () => {
      const c = ga.choice();
      if (c === "browser") { choice.textContent = "Your browser asks sites not to track you, so analytics is off here."; return; }
      choice.innerHTML = c === "no" ? `Analytics is <b>off</b> in this browser. <button type="button" data-v="">Allow it</button>` : `Analytics is <b>${c === "yes" ? "allowed" : "on unless you're asked first"}</b> in this browser. <button type="button" data-v="no">Turn it off</button>`;
      choice.querySelector("button").onclick = (e) => { ga.set(e.target.dataset.v === "" ? "yes" : "no"); show(); };
    };
    show();
  }

  const form = $("#import");
  if (form) form.onsubmit = (e) => {
    e.preventDefault();
    const url = $("#import-url").value.trim();
    if (!url) { $("#import-url").focus(); return; }
    window.mergeryAnalytics?.event("import_start"); // the URL itself stays out of analytics
    location.href = `/?import=${encodeURIComponent(url)}`;
  };

  // Which way people go into the app: a project, a new one, or their account. The link's
  // project name never goes along.
  document.querySelectorAll("a[data-app]").forEach((a) => a.addEventListener("click", () => {
    const href = a.getAttribute("href") ?? "";
    window.mergeryAnalytics?.event("open_app", { cta: href.includes("new=1") ? "new_project" : href.includes("#account") ? "account" : a.hasAttribute("data-featured") ? "featured" : "open", page: location.pathname });
  }));

  // Open the app on the showcase project, or straight into the featured change's Intent view.
  fetch("/auth/me", { cache: "no-store" }).then((r) => r.json()).then((me) => {
    const first = me.showcase?.[0];
    if (first) document.querySelectorAll("a[data-app]").forEach((a) => (a.href = a.getAttribute("href").replace("project=", `project=${encodeURIComponent(first)}`)));
    if (me.featured) document.querySelectorAll("a[data-featured]").forEach((a) => (a.href = me.featured));
    window.mergeryAnalytics?.start(me.analytics, location.pathname.replace(/\.html$/, ""));
    if (me.user) document.querySelectorAll("a[data-app][data-signed-in]").forEach((a) => (a.textContent = a.dataset.signedIn));
  }).catch(() => {});
})();
