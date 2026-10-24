// A change with hundreds of files lands like a small one: write, submit,
// review, merge. `node demo/large-change.mjs [project] [files]`
import { Loom } from "./client.mjs";
import { SEED } from "./seed.mjs";

const url = process.env.LOOM_URL ?? "http://127.0.0.1:8787";
const name = process.argv[2] || `large-${Date.now().toString(36).slice(-5)}`;
const count = Number(process.argv[3] ?? 300);
const admin = new Loom(url, name, process.env.LOOM_ADMIN_TOKEN ?? "dev-admin");

await admin.createProject({ name, description: "one change with many files", files: SEED, requiredApprovals: 1 });
const ada = admin.as((await admin.addAgent("ada", "builder")).key);
const rex = admin.as((await admin.addAgent("rex", "reviewer")).key);
const t = await ada.createTask("Generated packing files", "");
const ws = (await ada.claim(t.id)).workspace.name;
await ada.intent(t.id, ["data/packing/"], "generated packing files");
const files = {};
for (let i = 0; i < count; i++) files[`data/packing/d${i % 7}/p${String(i).padStart(4, "0")}.json`] = JSON.stringify({ id: i, items: [i, i * 2] }) + "\n";
await ada.write(ws, files, `${count} packing files`);
const ch = await ada.submit(t.id, t.title, `${count} generated files`, { plan: ["generate"], tested: ["by hand"] });
console.log(`submitted #${ch.id} with ${count} files`);
const detail = await rex.change(ch.id);
console.log(`change shows ${detail.files.length} files`);
await rex.review(ch.id, "approve", "ok");
for (let i = 0; i < 60; i++) {
  const c = await rex.change(ch.id);
  if (c.status === "merged") { console.log(`#${ch.id} merged with ${count} files`); process.exit(0); }
  if (/fail|conflict/.test(c.status)) { console.log(`#${ch.id} ${c.status}`); process.exit(1); }
  await new Promise((r) => setTimeout(r, 1000));
}
console.log(`#${ch.id} did not merge in 60s`);
process.exit(1);
