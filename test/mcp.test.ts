import { test } from "node:test";
import assert from "node:assert/strict";
import { canonical } from "../src/mcp.ts";

test("tool results have one shape: camelCase keys, while agents' own context and path-keyed maps stay as written", () => {
  const out = canonical({
    id: 6, agent_id: "ada", task_id: 5, created_at: 1, intents: [{ agent_id: "bex", task_id: 7, paths: ["src/"] }],
    context: { plan_steps: ["keep me"] }, symbols: { "src/my_file.ts": ["trim_title"] },
    files: [{ path: "src/db_util.ts", status: "M" }], agentId: "ada",
  }) as any;
  assert.deepEqual(Object.keys(out).sort(), ["agentId", "context", "createdAt", "files", "id", "intents", "symbols", "taskId"]);
  assert.deepEqual(out.intents[0], { agentId: "bex", taskId: 7, paths: ["src/"] });
  assert.deepEqual(out.context, { plan_steps: ["keep me"] });
  assert.deepEqual(out.symbols, { "src/my_file.ts": ["trim_title"] });
  assert.equal(out.files[0].path, "src/db_util.ts");
});
