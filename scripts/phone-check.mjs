#!/usr/bin/env node
// Check the dashboard on a phone: npm run phone-check -- [project]
// Opens the main pages and dialogs at 360 px wide against a local Loom
// (npm run dev, with a project from npm run demo) and fails if a page is wider
// than the screen, a control sits off it, a button is too small to tap, or an
// input's text is small enough for iOS to zoom in on focus.
// Needs Playwright (npm i -g playwright && npx playwright install chromium).
// PHONE_SHOTS=dir also saves a screenshot of each view.

import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); }
catch { console.error("phone-check needs Playwright: npm i -g playwright && npx playwright install chromium"); process.exit(2); }

const base = (process.env.LOOM_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const login = process.env.LOOM_LOGIN ?? "jonathanherr"; // an owner in wrangler.toml's local env
const shots = process.env.PHONE_SHOTS;
const width = Number(process.env.PHONE_WIDTH ?? 360);
let project = process.argv[2];
if (!project) {
  const list = await fetch(`${base}/api/projects`).then((r) => r.json()).catch(() => null);
  if (!list?.length) { console.error(`No projects at ${base}. Start Loom (npm run shim, npm run dev) and run npm run demo first.`); process.exit(2); }
  project = list[list.length - 1].name;
}
if (shots) mkdirSync(shots, { recursive: true });

// Runs in the page: what's wrong with the view as it is now.
const audit = () => {
  const vw = document.documentElement.clientWidth;
  const problems = [];
  const root = [...document.querySelectorAll("dialog[open]")].pop() ?? document.body;
  const shown = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden"; };
  const name = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""} “${(el.innerText || el.value || el.placeholder || el.title || "").trim().slice(0, 30)}”`;
  // Inside a box that scrolls sideways on purpose (code, diffs, tab strips), off-screen is fine.
  const scrolls = (el) => { for (let p = el.parentElement; p && p !== root; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === "auto" || o === "scroll") return true; } return false; };
  if (document.documentElement.scrollWidth > vw + 1) problems.push(`the page is ${document.documentElement.scrollWidth} px wide on a ${vw} px screen`);
  for (const el of root.querySelectorAll("button, a.button, input, select, textarea, summary")) {
    if (!shown(el) || el.closest("[hidden], .results[hidden]")) continue;
    const r = el.getBoundingClientRect();
    if ((r.right > vw + 1 || r.left < -1) && !scrolls(el)) problems.push(`${name(el)} is off the screen (x ${Math.round(r.left)} to ${Math.round(r.right)})`);
    const box = el.type === "checkbox" || el.type === "radio";
    if (box ? r.height < 20 : el.tagName !== "SUMMARY" && el.type !== "range" && r.height < 40) problems.push(`${name(el)} is ${Math.round(r.height)} px tall`);
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) && !box && el.type !== "range" && parseFloat(getComputedStyle(el).fontSize) < 16) problems.push(`${name(el)} has ${getComputedStyle(el).fontSize} text, so iOS zooms in on it`);
  }
  return problems;
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width, height: 760 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const home = `${base}/?project=${encodeURIComponent(project)}`;
await page.goto(`${base}/auth/dev?login=${login}&return=${encodeURIComponent(`/?project=${project}`)}`, { waitUntil: "networkidle" });

const views = [
  ["home", async () => {}],
  ["menu", async () => page.click("#menu-open")],
  ["settings", async () => page.click("#settings-open")],
  ["connect an agent", async () => page.click("#skill-open")],
  ["help", async () => page.click("#help-open")],
  ["new project", async () => page.click("#np-open")],
  ["my work", async () => page.click("#work-open")],
  ["steer", async () => page.click("#controls .steer-toggle")],
  ["deputy", async () => { await page.click("#controls .steer-toggle"); await page.click("#jev-open"); }],
  ["tasks", async () => page.click('a[href="#tasks"]')],
  ["change", async () => page.goto(`${home}#change/1`, { waitUntil: "networkidle" })],
  ["task", async () => page.goto(`${home}#task/1`, { waitUntil: "networkidle" })],
  ["code", async () => page.goto(`${home}#code`, { waitUntil: "networkidle" })],
  ["account", async () => page.goto(`${home}#account`, { waitUntil: "networkidle" })],
];

let failed = 0;
for (const [label, open] of views) {
  await page.goto(home, { waitUntil: "networkidle" });
  // Opening a menu item closes the menu, so each view starts from the home page.
  const needsMenu = /^(settings|connect an agent|help|new project|my work)$/.test(label);
  if (needsMenu) await page.click("#menu-open");
  try { await open(); } catch (e) { console.log(`✗ ${label}: couldn't open it (${String(e.message).split("\n")[0]})`); failed++; continue; }
  await page.waitForTimeout(800);
  if (shots) await page.screenshot({ path: `${shots}/${label.replace(/ /g, "-")}.png` });
  // Look at the whole view, not just the first screen: scroll dialogs and the page.
  const problems = new Set(await page.evaluate(audit));
  await page.evaluate(() => { const d = [...document.querySelectorAll("dialog[open]")].pop(); if (d) d.scrollTop = d.scrollHeight; else window.scrollTo(0, document.body.scrollHeight); });
  await page.waitForTimeout(200);
  for (const p of await page.evaluate(audit)) problems.add(p);
  console.log(`${problems.size ? "✗" : "✓"} ${label}${[...problems].slice(0, 12).map((p) => `\n    ${p}`).join("")}${problems.size > 12 ? `\n    and ${problems.size - 12} more` : ""}`);
  if (problems.size) failed++;
}
await browser.close();
console.log(failed ? `\n${failed} of ${views.length} views have problems at ${width} px.` : `\nAll ${views.length} views fit a ${width} px phone.`);
process.exit(failed ? 1 : 0);
