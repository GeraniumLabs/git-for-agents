// Gather bench/results/*.json into public/benchmark.json, which /benchmark.html shows.
//
//   node bench/build.mjs
//
// A run lands in bench/results from demo/load.mjs --json. Runs are ordered by
// repository size, then by agents, so the page reads small to big.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = new URL("./results/", import.meta.url).pathname;
const runs = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => ({ id: f.replace(/\.json$/, ""), ...JSON.parse(readFileSync(join(dir, f), "utf8")) }))
  .sort((a, b) => a.repo.files - b.repo.files || a.agents - b.agents || a.at.localeCompare(b.at));

// Earlier runs, from before results were saved as JSON (docs/guide.md has the details).
const earlier = [
  { label: "150 agents, small repository", target: "local wrangler dev", at: "2026-10-12", agents: 150, merged: 150, wallSeconds: 48, mergesPerHour: 11200, p50: 17000 },
  { label: "200 agents, small repository", target: "local wrangler dev", at: "2026-10-12", agents: 200, merged: 200, wallSeconds: 71, mergesPerHour: 10200, p50: 25000 },
  { label: "300 agents, small repository", target: "local wrangler dev", at: "2026-10-12", agents: 300, merged: 300, wallSeconds: 155, mergesPerHour: 7000, p50: 61000 },
  { label: "100 agents, small repository", target: "production", at: "2026-10-12", agents: 100, merged: 100, wallSeconds: 117, mergesPerHour: 3070, p50: 44000 },
  { label: "200 agents, small repository", target: "production", at: "2026-10-12", agents: 200, merged: 200, wallSeconds: 349, mergesPerHour: 2070, p50: 115000 },
];

const out = {
  generated: new Date().toISOString(),
  method: "demo/load.mjs: each agent claims a task, declares an intent, reads, commits one file (30% of agents touch shared files), submits, and a reviewer pool approves; Loom merges in batches. Times are measured by the client.",
  runs,
  earlier,
};
writeFileSync(new URL("../public/benchmark.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
console.log(`public/benchmark.json: ${runs.length} runs`);
