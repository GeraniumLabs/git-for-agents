// The starting codebase for the demos: a tiny todo service.

export const SEED = {
  "README.md": "# todo\n\nA tiny todo service.\n",
  "package.json": JSON.stringify({ name: "todo", version: "0.1.0", type: "module" }, null, 2) + "\n",
  "src/db.js": `// In-memory storage for todos.
const todos = new Map();
let nextId = 1;

export function save(todo) {
  const id = nextId++;
  const record = { id, title: todo.title, done: false };
  todos.set(id, record);
  return record;
}

export function list() {
  return [...todos.values()];
}

export function complete(id) {
  const todo = todos.get(id);
  if (todo) todo.done = true;
  return todo;
}
`,
  "src/routes/todos.js": `import * as db from "../db.js";

export function handle(req) {
  const url = new URL(req.url);
  if (req.method === "GET") {
    return json(db.list());
  }
  if (req.method === "POST") {
    const body = req.body;
    const todo = db.save(body);
    return json(todo, 201);
  }
  if (req.method === "PATCH") {
    const id = Number(url.searchParams.get("id"));
    return json(db.complete(id));
  }
  return json({ error: "method not allowed" }, 405);
}

function json(data, status = 200) {
  return { status, body: JSON.stringify(data) };
}
`,
  "src/server.js": `import { handle } from "./routes/todos.js";

export default { fetch: (req) => handle(req) };
`,
};
