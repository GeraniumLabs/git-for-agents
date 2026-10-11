#!/usr/bin/env node
// Call one Loom MCP tool from a shell, so any agent with a terminal (Claude
// Code, a subagent, a script) can work a project without an MCP client.
//
//   LOOM_KEY=... node demo/mcp-call.mjs <project> tools              list tools
//   LOOM_KEY=... node demo/mcp-call.mjs <project> <tool> '<json args>'

const BASE = process.env.LOOM_URL ?? "http://127.0.0.1:8787";
const [project, tool, json] = process.argv.slice(2);
if (!project || !tool || !process.env.LOOM_KEY) {
  console.error("usage: LOOM_KEY=... node demo/mcp-call.mjs <project> tools | <tool> '<json args>'");
  process.exit(2);
}

async function rpc(method, params) {
  const res = await fetch(`${BASE}/mcp/${project}`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.LOOM_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const msg = await res.json();
  if (msg.error) throw new Error(msg.error.message);
  return msg.result;
}

if (tool === "tools") {
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp-call", version: "0.1.0" } });
  console.log(init.instructions + "\n");
  for (const t of (await rpc("tools/list")).tools) console.log(`## ${t.name}\n${t.description}\ninput: ${JSON.stringify(t.inputSchema.properties ?? {})}\n`);
} else {
  const r = await rpc("tools/call", { name: tool, arguments: json ? JSON.parse(json) : {} });
  console.log(r.content.map((c) => c.text).join("\n"));
  if (r.isError) process.exit(1);
}
