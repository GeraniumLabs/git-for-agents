// The site's admin page (/admin): who has signed up and how much they use.
// Only the server's owners (LOOM_OWNERS) or the admin token can read it. It
// puts together the registry's rows (sign-ins, projects, plans, orgs) with
// counts each project's coordinator keeps (see adminUsage there). Counts only:
// no code, task text or traces leave a project for this page.

/** What the registry hands the admin page (registry/admin in coordinator.ts). */
export interface RegistryDump {
  signins: { login: string; name: string | null; avatar: string | null; first_at: number; last_at: number; count: number }[];
  projects: { name: string; created_at: number | null; private: boolean; jurisdiction: string | null; owner: string | null; hidden: boolean; org: string | null }[];
  plans: { login: string; plan: string | null; status: string | null; renews: number | null; updated_at: number | null }[];
  waitlist: { login: string; name: string | null; asked_at: number | null; asks: number }[];
  creators: { login: string; added_at: number | null }[];
  orgs: { slug: string; name: string | null; created_by: string | null; created_at: number | null }[];
  orgMembers: { org: string; login: string; role: string; added_at: number | null }[];
  emails: { login: string; email: string; updated_at: number | null }[];
}

/** One project's counts, from its coordinator. */
export interface ProjectUsage {
  project: string;
  plan: string | null;
  visibility: string;
  importedFrom: string | null;
  people: { login: string; owner: boolean; joined: number | null; lastSeen: number | null }[];
  agents: number;
  agentsActive7d: number;
  tasks: number;
  changes: Record<string, number>;
  changesTotal: number;
  changes7d: number;
  merged7d: number;
  reviews: number;
  events: number;
  mainVersion: number;
  traces: { count: number; bytes: number; tokens: number; costUsd: number };
  attachments: { count: number; bytes: number };
  checkMinutes30d: number;
  lastActivity: number | null;
  daily: Record<string, { events: number; merged: number }>;
}

const DAY = 86_400_000;
const dayOf = (ts: number) => new Date(ts).toISOString().slice(0, 10);
const min = (xs: (number | null | undefined)[]) => {
  const v = xs.filter((x): x is number => typeof x === "number" && x > 0);
  return v.length ? Math.min(...v) : null;
};
const max = (xs: (number | null | undefined)[]) => {
  const v = xs.filter((x): x is number => typeof x === "number" && x > 0);
  return v.length ? Math.max(...v) : null;
};

/** The last `n` days as YYYY-MM-DD, oldest first, ending today. */
function lastDays(now: number, n: number): string[] {
  return Array.from({ length: n }, (_, i) => dayOf(now - (n - 1 - i) * DAY));
}

/**
 * The admin page's report. People are everyone the server knows by GitHub
 * login: anyone who signed in (recorded since this page was added), and,
 * from before that, anyone who owns a project, is in one, is in an org, asked
 * to create projects, has a plan or saved an email. For those, "first seen" is
 * the earliest of those dates and is marked estimated.
 */
export function adminReport(reg: RegistryDump, usage: Map<string, ProjectUsage | { error: string }>, now = Date.now()) {
  type Person = {
    login: string; name: string | null; avatar: string | null; email: string | null;
    firstSeen: number | null; firstSeenEstimated: boolean; lastSignIn: number | null; signIns: number;
    plan: string; planStatus: string | null; owns: string[]; memberOf: string[]; orgs: string[]; waitlisted: boolean; canCreate: boolean;
    lastActive: number | null;
    usage: { projects: number; agents: number; agentsActive7d: number; changes: number; changes7d: number; merged7d: number; traces: number; storageBytes: number; checkMinutes30d: number };
    _dates: (number | null)[];
  };
  const people = new Map<string, Person>();
  const person = (raw: string | null | undefined): Person | null => {
    const login = String(raw ?? "").trim().toLowerCase();
    if (!login || login === "admin") return null;
    let p = people.get(login);
    if (!p) {
      p = {
        login, name: null, avatar: null, email: null, firstSeen: null, firstSeenEstimated: true, lastSignIn: null, signIns: 0,
        plan: "free", planStatus: null, owns: [], memberOf: [], orgs: [], waitlisted: false, canCreate: false, lastActive: null,
        usage: { projects: 0, agents: 0, agentsActive7d: 0, changes: 0, changes7d: 0, merged7d: 0, traces: 0, storageBytes: 0, checkMinutes30d: 0 },
        _dates: [],
      };
      people.set(login, p);
    }
    return p;
  };

  for (const s of reg.signins) {
    const p = person(s.login);
    if (!p) continue;
    p.name = s.name; p.avatar = s.avatar || null; p.lastSignIn = s.last_at; p.signIns = s.count;
    p.firstSeen = s.first_at; p.firstSeenEstimated = false;
  }
  for (const w of reg.waitlist) { const p = person(w.login); if (p) { p.waitlisted = true; p.name ??= w.name; p._dates.push(w.asked_at); } }
  for (const c of reg.creators) { const p = person(c.login); if (p) { p.canCreate = true; p._dates.push(c.added_at); } }
  for (const e of reg.emails) { const p = person(e.login); if (p) { p.email = e.email; p._dates.push(e.updated_at); } }
  for (const m of reg.orgMembers) { const p = person(m.login); if (p) { p.orgs.push(m.org); p._dates.push(m.added_at); } }
  for (const pl of reg.plans) {
    if (pl.login.startsWith("org:")) continue;
    const p = person(pl.login);
    if (p) { p.plan = pl.plan ?? "free"; p.planStatus = pl.status; p._dates.push(pl.updated_at); }
  }
  for (const pr of reg.projects) {
    const p = person(pr.owner);
    if (p) { p.owns.push(pr.name); p._dates.push(pr.created_at); }
  }

  const projects = reg.projects.map((pr) => {
    const u = usage.get(pr.name);
    const ok = u && !("error" in u) ? u : null;
    if (ok) {
      for (const m of ok.people) {
        const p = person(m.login);
        if (!p) continue;
        if (pr.owner?.toLowerCase() !== p.login) p.memberOf.push(pr.name);
        p._dates.push(m.joined);
        p.lastActive = max([p.lastActive, m.lastSeen]);
      }
      // A project's usage counts toward whoever owns it (an org's, toward no one person).
      const owner = pr.org ? null : person(pr.owner);
      if (owner) {
        const o = owner.usage;
        o.projects++; o.agents += ok.agents; o.agentsActive7d += ok.agentsActive7d; o.changes += ok.changesTotal; o.changes7d += ok.changes7d;
        o.merged7d += ok.merged7d; o.traces += ok.traces.count; o.storageBytes += ok.traces.bytes + ok.attachments.bytes; o.checkMinutes30d += ok.checkMinutes30d;
        owner.lastActive = max([owner.lastActive, ok.lastActivity]);
      }
    }
    return {
      name: pr.name, owner: pr.owner, org: pr.org, created: pr.created_at, private: pr.private, hidden: pr.hidden, jurisdiction: pr.jurisdiction,
      error: u && "error" in u ? u.error : null,
      plan: ok?.plan ?? null, importedFrom: ok?.importedFrom ?? null,
      people: ok?.people.length ?? 0, agents: ok?.agents ?? 0, agentsActive7d: ok?.agentsActive7d ?? 0, tasks: ok?.tasks ?? 0,
      changes: ok?.changesTotal ?? 0, merged: ok?.changes.merged ?? 0, changes7d: ok?.changes7d ?? 0, merged7d: ok?.merged7d ?? 0,
      reviews: ok?.reviews ?? 0, events: ok?.events ?? 0, mainVersion: ok?.mainVersion ?? 0,
      traces: ok?.traces.count ?? 0, tokens: ok?.traces.tokens ?? 0, costUsd: ok?.traces.costUsd ?? 0,
      storageBytes: ok ? ok.traces.bytes + ok.attachments.bytes : 0, attachments: ok?.attachments.count ?? 0,
      checkMinutes30d: ok?.checkMinutes30d ?? 0, lastActivity: ok?.lastActivity ?? null,
    };
  });

  const list = [...people.values()].map(({ _dates, ...p }) => {
    if (p.firstSeen === null) p.firstSeen = min(_dates);
    else p.firstSeen = min([p.firstSeen, ..._dates]) ?? p.firstSeen;
    p.lastActive = max([p.lastActive, p.lastSignIn]);
    p.usage.checkMinutes30d = Math.round(p.usage.checkMinutes30d * 100) / 100;
    return p;
  }).sort((a, b) => (b.firstSeen ?? 0) - (a.firstSeen ?? 0) || a.login.localeCompare(b.login));

  const days = lastDays(now, 30);
  const signupsByDay = days.map((day) => ({ day, n: list.filter((p) => p.firstSeen && dayOf(p.firstSeen) === day).length }));
  const activityByDay = days.map((day) => {
    let events = 0, merged = 0;
    for (const u of usage.values()) if (!("error" in u) && u.daily[day]) { events += u.daily[day].events; merged += u.daily[day].merged; }
    return { day, events, merged };
  });
  const real = projects.filter((p) => !p.hidden);
  const sum = (xs: typeof projects, f: (p: (typeof projects)[number]) => number) => xs.reduce((a, p) => a + f(p), 0);

  return {
    generatedAt: now,
    signinsRecordedSince: min(reg.signins.map((s) => s.first_at)),
    totals: {
      people: list.length,
      signups7d: list.filter((p) => (p.firstSeen ?? 0) > now - 7 * DAY).length,
      signups30d: list.filter((p) => (p.firstSeen ?? 0) > now - 30 * DAY).length,
      active7d: list.filter((p) => (p.lastActive ?? 0) > now - 7 * DAY).length,
      pro: list.filter((p) => p.plan === "pro" && (p.planStatus === "active" || p.planStatus === "trialing")).length,
      proOrgs: reg.plans.filter((pl) => pl.login.startsWith("org:") && pl.plan === "pro" && (pl.status === "active" || pl.status === "trialing")).length,
      waitlist: reg.waitlist.length,
      orgs: reg.orgs.length,
      projects: real.length,
      hiddenProjects: projects.length - real.length,
      privateProjects: real.filter((p) => p.private).length,
      agents: sum(real, (p) => p.agents),
      agentsActive7d: sum(real, (p) => p.agentsActive7d),
      changes: sum(real, (p) => p.changes),
      changes7d: sum(real, (p) => p.changes7d),
      merged7d: sum(real, (p) => p.merged7d),
      traces: sum(real, (p) => p.traces),
      storageBytes: sum(projects, (p) => p.storageBytes),
      checkMinutes30d: Math.round(sum(projects, (p) => p.checkMinutes30d) * 100) / 100,
      unreachable: projects.filter((p) => p.error).length,
    },
    signupsByDay,
    activityByDay,
    people: list,
    projects: projects.sort((a, b) => (b.lastActivity ?? b.created ?? 0) - (a.lastActivity ?? a.created ?? 0)),
    orgs: reg.orgs.map((o) => ({ ...o, members: reg.orgMembers.filter((m) => m.org === o.slug).length, projects: reg.projects.filter((p) => p.org === o.slug).length })),
  };
}

/** Run `f` over `items`, at most `n` at a time. */
export async function pool<T, R>(items: T[], n: number, f: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await f(items[i]); }
  }));
  return out;
}
