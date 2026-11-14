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
    try { await navigator.clipboard.writeText($(b.dataset.copy).textContent); b.textContent = "Copied"; setTimeout(() => (b.textContent = "Copy"), 1500); } catch {}
  }));

  const form = $("#import");
  if (form) form.onsubmit = (e) => {
    e.preventDefault();
    const url = $("#import-url").value.trim();
    if (!url) { $("#import-url").focus(); return; }
    location.href = `/?import=${encodeURIComponent(url)}`;
  };

  // Open the app on the showcase project, or straight into the featured change's Intent view.
  fetch("/auth/me", { cache: "no-store" }).then((r) => r.json()).then((me) => {
    const first = me.showcase?.[0];
    if (first) document.querySelectorAll("a[data-app]").forEach((a) => (a.href = a.getAttribute("href").replace("project=", `project=${encodeURIComponent(first)}`)));
    if (me.featured) document.querySelectorAll("a[data-featured]").forEach((a) => (a.href = me.featured));
    if (me.user) document.querySelectorAll("a[data-app][data-signed-in]").forEach((a) => (a.textContent = a.dataset.signedIn));
  }).catch(() => {});
})();
