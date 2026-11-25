// Visitor counts for the hosted site, with Google Analytics 4, directly (G-…) or through a Tag
// Manager container (GTM-…). Off unless the server sets LOOM_GA_ID (it arrives in /auth/me as
// `analytics`). What goes to Google is deliberately small: a page path with no query string or hash ("/", "/pricing", "/app"), and a few named clicks
// with no values. Never project names, import URLs, logins, keys or anything typed.
//
// Skipped entirely when the browser sends Global Privacy Control, or when the
// visitor said no. Visitors in the EU/EEA are asked first, and nothing loads until they allow it.
// Google's ad features stay off for everyone.
(() => {
  const PREF = "mergery-analytics"; // "yes" | "no"
  const pref = () => { try { return localStorage.getItem(PREF); } catch { return null; } };
  const setPref = (v) => { try { v ? localStorage.setItem(PREF, v) : localStorage.removeItem(PREF); } catch {} };
  // Global Privacy Control is the opt-out signal with legal weight (CCPA); Do Not Track is deprecated.
  const optedOutByBrowser = () => navigator.globalPrivacyControl === true;

  const externalReferrer = () => {
    try { const r = new URL(document.referrer); return r.origin !== location.origin ? r.origin + "/" : ""; } catch { return ""; }
  };

  let on = false;
  const queue = [];
  function gtag() { (window.dataLayer = window.dataLayer || []).push(arguments); }

  function load(id, path) {
    if (on) return;
    on = true;
    mode = gtm(id) ? "gtm" : "gtag";
    window.dataLayer = window.dataLayer || [];
    gtag("consent", "default", { ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied", analytics_storage: "granted" });
    // What every Google tag on the page reports: this path with no query or hash, and another site's
    // origin as referrer (a page of ours would carry its query). A Tag Manager container's Google tag
    // reads these too, as long as it doesn't override page_location itself.
    const page = {
      page_location: location.origin + path,
      page_path: path,
      page_referrer: externalReferrer(),
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
    };
    gtag("set", page);
    gtag("js", new Date());
    const s = document.createElement("script");
    s.async = true;
    if (gtm(id)) {
      window.dataLayer.push({ event: "gtm.js", "gtm.start": Date.now(), mergery_page_path: path, mergery_page_location: page.page_location });
      s.src = `https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(id)}`;
    } else {
      gtag("config", id, page);
      s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`;
    }
    document.head.appendChild(s);
    for (const [n, p] of queue.splice(0)) send(n, p);
  }
  const gtm = (id) => id.startsWith("GTM-");
  let mode = "";
  // GA4 directly takes gtag events; a Tag Manager container takes dataLayer events, which its
  // GA4 event tag forwards with the event's name.
  function send(name, params) {
    if (mode === "gtm") window.dataLayer.push({ event: name, ...params });
    else gtag("event", name, params);
  }

  function banner(id, path) {
    if (document.getElementById("consent")) return;
    const box = document.createElement("div");
    box.id = "consent";
    box.setAttribute("role", "region");
    box.setAttribute("aria-label", "Analytics choice");
    box.style.cssText = "position:fixed;left:16px;right:16px;bottom:16px;max-width:30rem;margin:0 auto;z-index:50;padding:14px 16px;border-radius:12px;background:var(--panel,#fff);color:var(--text,#111);border:1px solid var(--line,#ddd);box-shadow:0 6px 24px rgba(0,0,0,.18);font:14px/1.45 system-ui,sans-serif";
    box.innerHTML = `<p style="margin:0 0 10px">Can Mergery count your visit with Google Analytics? It sees which pages you open, never your projects or anything you type. <a href="/privacy#analytics">Details</a></p>
      <div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" data-a="no">No thanks</button><button type="button" data-a="yes">Allow</button></div>`;
    box.querySelectorAll("button").forEach((b) => {
      b.style.cssText = "font:inherit;padding:6px 14px;border-radius:8px;cursor:pointer;border:1px solid var(--line,#ccc);background:transparent;color:inherit";
      b.onclick = () => { setPref(b.dataset.a); box.remove(); if (b.dataset.a === "yes") load(id, path); };
    });
    document.body.appendChild(box);
  }

  window.mergeryAnalytics = {
    /** cfg is /auth/me's `analytics`; path is what to report for this page; ask shows the EU banner. */
    start(cfg, path, { ask = true } = {}) {
      if (!cfg?.id || optedOutByBrowser() || pref() === "no") return;
      if (!cfg.consent || pref() === "yes") return load(cfg.id, path);
      if (ask) banner(cfg.id, path);
    },
    /** A named event with only the small, fixed params the caller passes. Dropped when analytics is off. */
    event(name, params = {}) {
      if (on) send(name, params);
      else if (queue.length < 20) queue.push([name, params]);
    },
    /** For the privacy page: the visitor's choice in this browser. */
    choice: () => (optedOutByBrowser() ? "browser" : pref()),
    set(v) { setPref(v); },
  };
})();
