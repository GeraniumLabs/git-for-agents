// Organizations. An org owns projects; everyone in it is a member of each of
// its projects, and its owners own them. People are invited once, by GitHub
// login or with an invite link, instead of project by project. The org's plan
// (src/billing.ts) sets the limits of its projects.
//
// The registry keeps orgs, their people and invites; each project keeps its
// own members, so the Worker copies an org's people into its projects
// whenever they change (see syncProjects in index.ts).

/** A refusal with its HTTP status; the registry turns it into a response. */
export class OrgError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const HttpError = OrgError;

export type OrgRole = "owner" | "member";

export const ORG_SLUG = /^[a-z0-9][a-z0-9-]{1,38}$/;
export const LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,38})$/i;
const INVITE_DAYS = 14;

/** The key a plan is kept under: a person's login, or an org's slug marked as one. */
export const orgAccount = (slug: string) => `org:${slug}`;

export const ORG_TABLES = `
  CREATE TABLE IF NOT EXISTS orgs (slug TEXT PRIMARY KEY, name TEXT, created_by TEXT, created_at INTEGER);
  CREATE TABLE IF NOT EXISTS org_members (org TEXT, login TEXT, role TEXT, added_by TEXT, added_at INTEGER, PRIMARY KEY (org, login));
  CREATE TABLE IF NOT EXISTS org_invites (code TEXT PRIMARY KEY, org TEXT, role TEXT, created_by TEXT, created_at INTEGER, expires_at INTEGER, uses INTEGER DEFAULT 0, revoked_at INTEGER);
  CREATE TABLE IF NOT EXISTS people (login TEXT PRIMARY KEY, email TEXT, updated_at INTEGER);
`;

const randomCode = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");

export interface OrgPeople {
  org: string;
  members: { login: string; role: OrgRole }[];
  projects: { name: string; jurisdiction: string | null }[];
}

/** The registry's side of orgs: everything is keyed by lowercase logins and slugs. */
export function orgRegistry(sql: SqlStorage, method: string, what: string, url: URL, body: any): unknown {
  const login = String(body.login ?? url.searchParams.get("login") ?? "").trim().replace(/^@/, "").toLowerCase();
  const slug = String(body.slug ?? url.searchParams.get("slug") ?? "").trim().toLowerCase();
  const by = String(body.by ?? url.searchParams.get("by") ?? "").toLowerCase();
  const org = () => {
    const o = sql.exec("SELECT slug, name, created_by, created_at FROM orgs WHERE slug = ?", slug).toArray()[0];
    if (!o) throw new HttpError(404, `no organization ${slug}`);
    return o;
  };
  const roleOf = (l: string) => (sql.exec("SELECT role FROM org_members WHERE org = ? AND login = ?", slug, l).toArray()[0]?.role as OrgRole | undefined) ?? null;
  const people = (): OrgPeople => ({
    org: slug,
    members: sql.exec("SELECT login, role FROM org_members WHERE org = ? ORDER BY role DESC, login", slug).toArray() as any,
    projects: sql.exec("SELECT name, jurisdiction FROM projects WHERE org = ? ORDER BY name", slug).toArray() as any,
  });
  const mustOwn = () => { if (roleOf(by) !== "owner") throw new HttpError(403, `only owners of ${slug} can do that`); };
  const owners = () => sql.exec("SELECT COUNT(*) AS n FROM org_members WHERE org = ? AND role = 'owner'", slug).one().n as number;

  // Orgs a person is in.
  if (what === "orgs" && method === "GET") {
    return sql.exec(`SELECT o.slug, o.name, m.role, (SELECT COUNT(*) FROM projects p WHERE p.org = o.slug) AS projects
      FROM org_members m JOIN orgs o ON o.slug = m.org WHERE m.login = ? ORDER BY o.name`, login).toArray();
  }
  if (what === "orgs" && method === "POST") {
    if (!ORG_SLUG.test(slug)) throw new HttpError(400, "an organization's name in links is lowercase letters, digits and dashes");
    if (sql.exec("SELECT 1 FROM orgs WHERE slug = ?", slug).toArray().length) throw new HttpError(409, `${slug} is taken`);
    const name = String(body.name ?? "").trim().slice(0, 80) || slug;
    const now = Date.now();
    sql.exec("INSERT INTO orgs (slug, name, created_by, created_at) VALUES (?, ?, ?, ?)", slug, name, by, now);
    sql.exec("INSERT INTO org_members (org, login, role, added_by, added_at) VALUES (?, ?, 'owner', ?, ?)", slug, by, by, now);
    return { slug, name, role: "owner", projects: 0 };
  }

  if (what === "org") {
    const o = org();
    if (method === "GET") {
      const role = roleOf(login);
      return {
        slug: o.slug, name: o.name, created_by: o.created_by, created_at: o.created_at, role, ...people(),
        invites: role === "owner" ? sql.exec("SELECT code, role, created_by, created_at, expires_at, uses FROM org_invites WHERE org = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC", slug, Date.now()).toArray() : [],
      };
    }
    if (method === "DELETE") {
      mustOwn();
      if (people().projects.length) throw new HttpError(409, `${slug} still owns projects: move or delete them first`);
      for (const t of ["org_members", "org_invites"]) sql.exec(`DELETE FROM ${t} WHERE org = ?`, slug);
      sql.exec("DELETE FROM orgs WHERE slug = ?", slug);
      sql.exec("DELETE FROM plans WHERE login = ?", orgAccount(slug));
      return { deleted: slug };
    }
    if (method === "PUT") {
      mustOwn();
      const name = String(body.name ?? "").trim().slice(0, 80);
      if (name) sql.exec("UPDATE orgs SET name = ? WHERE slug = ?", name, slug);
      return { ok: true };
    }
  }

  if (what === "members") {
    org();
    if (!LOGIN.test(login)) throw new HttpError(400, "give a GitHub login, e.g. octocat");
    if (method === "POST") {
      mustOwn();
      const role: OrgRole = body.role === "owner" ? "owner" : "member";
      if (roleOf(login) === "owner" && role !== "owner" && owners() <= 1) throw new HttpError(409, "an organization needs at least one owner");
      sql.exec(`INSERT INTO org_members (org, login, role, added_by, added_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(org, login) DO UPDATE SET role = excluded.role`, slug, login, role, by, Date.now());
      return people();
    }
    if (method === "DELETE") {
      // Owners remove anyone; anyone can leave.
      if (login !== by) mustOwn();
      if (!roleOf(login)) throw new HttpError(404, `${login} isn't in ${slug}`);
      if (roleOf(login) === "owner" && owners() <= 1) throw new HttpError(409, "an organization needs at least one owner");
      sql.exec("DELETE FROM org_members WHERE org = ? AND login = ?", slug, login);
      return people();
    }
  }

  if (what === "invites") {
    org();
    mustOwn();
    if (method === "POST") {
      const code = randomCode();
      const role: OrgRole = body.role === "owner" ? "owner" : "member";
      const now = Date.now();
      sql.exec("INSERT INTO org_invites (code, org, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)", code, slug, role, by, now, now + INVITE_DAYS * 86_400_000);
      return { code, role, expires_at: now + INVITE_DAYS * 86_400_000 };
    }
    if (method === "DELETE") {
      sql.exec("UPDATE org_invites SET revoked_at = ? WHERE code = ? AND org = ?", Date.now(), String(body.code ?? url.searchParams.get("code") ?? ""), slug);
      return { ok: true };
    }
  }

  // An invite link: what it's for, and taking it.
  if (what === "invite") {
    const code = String(body.code ?? url.searchParams.get("code") ?? "");
    const inv = sql.exec("SELECT i.code, i.org, i.role, i.expires_at, i.revoked_at, o.name FROM org_invites i JOIN orgs o ON o.slug = i.org WHERE i.code = ?", code).toArray()[0];
    if (!inv || inv.revoked_at || (inv.expires_at as number) < Date.now()) throw new HttpError(404, "this invite link has expired or was withdrawn; ask for a new one");
    if (method === "GET") return { org: inv.org, name: inv.name, role: inv.role };
    if (method === "POST") {
      if (!LOGIN.test(login)) throw new HttpError(400, "sign in with GitHub first");
      const was = sql.exec("SELECT role FROM org_members WHERE org = ? AND login = ?", inv.org, login).toArray()[0]?.role;
      // An invite never demotes: an owner who follows a member's link stays an owner.
      const role = was === "owner" ? "owner" : inv.role;
      sql.exec(`INSERT INTO org_members (org, login, role, added_by, added_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(org, login) DO UPDATE SET role = excluded.role`, inv.org, login, role, `invite:${code.slice(0, 6)}`, Date.now());
      sql.exec("UPDATE org_invites SET uses = uses + 1 WHERE code = ?", code);
      const slugOf = inv.org as string;
      return {
        org: slugOf, name: inv.name, role, joined: !was,
        members: sql.exec("SELECT login, role FROM org_members WHERE org = ? ORDER BY role DESC, login", slugOf).toArray(),
        projects: sql.exec("SELECT name, jurisdiction FROM projects WHERE org = ? ORDER BY name", slugOf).toArray(),
      };
    }
  }

  // Which org a project belongs to; moving it in or out.
  if (what === "project-org" && method === "POST") {
    const name = String(body.name ?? "");
    const p = sql.exec("SELECT name, org, owner, jurisdiction FROM projects WHERE name = ?", name).toArray()[0];
    if (!p) throw new HttpError(404, `no project ${name}`);
    const to = body.org ? String(body.org).toLowerCase() : null;
    if (to) {
      const target = sql.exec("SELECT role FROM org_members WHERE org = ? AND login = ?", to, by).toArray()[0];
      if (target?.role !== "owner") throw new HttpError(403, `only owners of ${to} can move projects into it`);
    }
    // Moving a project out of an org takes an owner of that org; it becomes the mover's own.
    if (p.org && sql.exec("SELECT role FROM org_members WHERE org = ? AND login = ?", p.org, by).toArray()[0]?.role !== "owner") throw new HttpError(403, `only owners of ${p.org} can move its projects`);
    sql.exec("UPDATE projects SET org = ?, owner = CASE WHEN ? IS NULL THEN ? ELSE owner END WHERE name = ?", to, to, by, name);
    return { name, from: p.org ?? null, org: to, jurisdiction: p.jurisdiction ?? null };
  }

  // A person's own settings: for now, where Loom emails them.
  if (what === "person") {
    if (method === "GET") return { login, email: (sql.exec("SELECT email FROM people WHERE login = ?", login).toArray()[0]?.email as string) ?? null };
    const e = body.email == null ? "" : String(body.email).trim();
    if (e && (e.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))) throw new HttpError(400, "give an email address, e.g. you@example.com");
    sql.exec("INSERT INTO people (login, email, updated_at) VALUES (?, ?, ?) ON CONFLICT(login) DO UPDATE SET email = excluded.email, updated_at = excluded.updated_at", login, e || null, Date.now());
    return { login, email: e || null };
  }

  throw new HttpError(404, "not found");
}
