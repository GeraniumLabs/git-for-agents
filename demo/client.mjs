// Minimal Loom HTTP client shared by the demo scripts.

export class Loom {
  constructor(base, project, key) {
    this.base = base.replace(/\/$/, "");
    this.project = project;
    this.key = key;
  }

  async req(method, path, body) {
    const url = path.startsWith("/api/") ? this.base + path : `${this.base}/api/projects/${this.project}${path}`;
    const res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${this.key}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`${method} ${path} → ${res.status}: ${data.error ?? ""}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  as(key) {
    return new Loom(this.base, this.project, key);
  }

  createProject(body) { return this.req("POST", "/api/projects", body); }
  addAgent(name, role = "builder") { return this.req("POST", "/agents", { name, role }); }
  state() { return this.req("GET", "/state"); }
  createTask(title, description = "", dependsOn = []) { return this.req("POST", "/tasks", { title, description, dependsOn }); }
  claim(taskId) { return this.req("POST", `/tasks/${taskId}/claim`); }
  intent(taskId, paths, description) { return this.req("POST", "/intents", { taskId, paths, description }); }
  read(path, workspace) {
    const q = new URLSearchParams({ path });
    if (workspace) q.set("workspace", workspace);
    return this.req("GET", `/files?${q}`).then((r) => r.content);
  }
  write(workspace, files, message) { return this.req("POST", `/workspaces/${workspace}/commit`, { files, message }); }
  submit(taskId, title, summary, context) { return this.req("POST", "/changes", { taskId, title, summary, context }); }
  update(changeId, summary) { return this.req("POST", `/changes/${changeId}/update`, { summary }); }
  change(id) { return this.req("GET", `/changes/${id}`); }
  review(changeId, verdict, body, comments) { return this.req("POST", `/changes/${changeId}/reviews`, { verdict, body, comments }); }
  sync(taskId, resolutions) { return this.req("POST", `/tasks/${taskId}/sync`, { resolutions }); }
  message(to, body, taskId) { return this.req("POST", "/messages", { to, body, taskId }); }
  me() { return this.req("GET", "/me"); }
  events(after, wait = 20) { return this.req("GET", `/events?after=${after}&wait=${wait}`); }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
