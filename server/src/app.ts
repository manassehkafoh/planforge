import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PoolClient } from 'pg';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import {
  applyResourceRules, evm, levelResources, plannedValueAt, simulate, timephase, workByDay, resolveCalendars, WorkCalendar,
  type ResourceIn,
} from '../../engine/src/index.ts';
import { audit, verifyChain } from './audit.ts';
import { verify } from './auth.ts';
import { tx } from './db.ts';
import { Problem, problemBody } from './errors.ts';
import { fromMs, newId, toMs, type TaskRec } from './model.ts';
import { can, MATRIX, type Role } from './rbac.ts';
import * as S from './schemas.ts';
import { applyBatch, runRisk, inProject, liveEntry, resourcesFor, scheduleApi, taskOutApi, toNetwork, type Deps } from './service.ts';
import { loadModel } from './store.ts';

interface Req { raw: IncomingMessage; url: URL; params: string[]; claims: { sub: string; tid: string }; body: unknown; ip: string | null; traceId: string }
type Handler = (r: Req, d: Deps) => Promise<{ status: number; body?: unknown; headers?: Record<string, string> }>;
const routes: { method: string; re: RegExp; h: Handler; auth: boolean }[] = [];
const route = (method: string, path: string, h: Handler, auth = true) =>
  routes.push({ method, re: new RegExp(`^${path.replace(/:[a-zA-Z]+/g, '([^/]+)')}$`), h, auth });

const parse = <T extends ZodTypeAny>(schema: T, v: unknown): z.infer<T> => {
  const r = schema.safeParse(v);
  if (r.success) return r.data;
  throw new Problem('VALIDATION_FAILED', 'request body failed validation', { errors: r.error.issues.map((i) => ({ path: `/${i.path.join('/')}`, message: i.message })) });
};
const ok = (body: unknown, status = 200, headers?: Record<string, string>) => ({ status, body, headers });
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const needUuid = (s: string, what = 'resource') => { if (!uuidRe.test(s)) throw new Problem('NOT_FOUND', `${what} not found`); return s; };

/** limit 1..1000 (400 outside), cursor = opaque base64 offset; PF-026 */
function page(qp: URLSearchParams, total: number): { limit: number; offset: number; next: string | null } {
  const lim = qp.get('limit');
  let limit = 200;
  if (lim !== null) { limit = Number(lim); if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Problem('VALIDATION_FAILED', 'limit must be an integer 1..500'); }
  let offset = Math.max(0, Number(qp.get('offset') ?? 0) || 0);
  const cur = qp.get('cursor');
  if (cur) { const n = Number(Buffer.from(cur, 'base64url').toString('utf8')); if (!Number.isInteger(n) || n < 0) throw new Problem('VALIDATION_FAILED', 'invalid cursor'); offset = n; }
  const end = offset + limit;
  return { limit, offset, next: end < total ? Buffer.from(String(end)).toString('base64url') : null };
}

// ------------------------------------------------------------------------------------------ views
function taskView(r: Record<string, any>, costVisible: boolean, wbs: string) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const t: Record<string, unknown> = {
    id: r.id, parentId: r.parent_id, wbs, sortKey: r.sort_key, name: r.name, durationMin: r.duration_min, mode: r.mode, kind: r.kind, effortDriven: r.effort_driven,
    constraint: { type: r.constraint_type, ...(r.constraint_local !== null ? { date: fromMs(r.constraint_local) } : {}) },
    calendarId: r.calendar_id, percentComplete: r.percent_complete, priority: r.priority, levelingDelayMin: r.leveling_delay_min, workMin: r.work_min, custom: r.custom,
    ...(r.notes !== null ? { notes: r.notes } : {}),
    ...(r.actual_start_local !== null ? { actualStart: fromMs(r.actual_start_local) } : {}), ...(r.actual_finish_local !== null ? { actualFinish: fromMs(r.actual_finish_local) } : {}),
    ...(r.manual_start_local !== null ? { manualStart: fromMs(r.manual_start_local) } : {}), ...(r.manual_finish_local !== null ? { manualFinish: fromMs(r.manual_finish_local) } : {}),
    ...(r.est_likely_min !== null ? { estimate: { optimisticMin: r.est_optimistic_min, likelyMin: r.est_likely_min, pessimisticMin: r.est_pessimistic_min } } : {}),
    schedule: r.es_local === null ? null : {
      es: fromMs(r.es_local), ef: fromMs(r.ef_local), ls: fromMs(r.ls_local), lf: fromMs(r.lf_local), totalFloatMin: r.total_float_min, freeFloatMin: r.free_float_min,
      critical: r.is_critical, nearCritical: r.is_near_critical, isSummary: r.is_summary, state: r.state, driver: r.driver,
    },
  };
  if (costVisible) t.fixedCost = r.fixed_cost;
  return t;
}

async function orderedTasks(c: PoolClient, projectId: string, costVisible: boolean) {
  const rows = (await c.query('SELECT * FROM task WHERE project_id = $1', [projectId])).rows;
  const kids = new Map<string | null, typeof rows>();
  for (const r of rows) (kids.get(r.parent_id) ?? kids.set(r.parent_id, []).get(r.parent_id)!).push(r);
  const out: ReturnType<typeof taskView>[] = [];
  const walk = (pid: string | null, prefix: string) => {
    const list = (kids.get(pid) ?? []).sort((a, b) => (a.sort_key < b.sort_key ? -1 : a.sort_key > b.sort_key ? 1 : 0));
    list.forEach((r, i) => { const w = prefix ? `${prefix}.${i + 1}` : `${i + 1}`; out.push(taskView(r, costVisible, w)); walk(r.id, w); });
  };
  walk(null, '');
  return out;
}

const projectView = (r: Record<string, any>, finish?: number | null) => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
  id: r.id, name: r.name, startDate: fromMs(r.start_local), calendarId: r.calendar_id, currency: r.currency, planVersion: r.plan_version, status: r.status,
  ...(r.deadline_local !== null ? { deadline: fromMs(r.deadline_local) } : {}), ...(r.status_date_local !== null ? { statusDate: fromMs(r.status_date_local) } : {}),
  ...(finish ? { finish: fromMs(finish) } : {}),
});

async function currentUser(c: PoolClient, sub: string) {
  const u = (await c.query('SELECT id FROM app_user WHERE oidc_subject = $1 AND is_active', [sub])).rows[0];
  if (!u) throw new Problem('FORBIDDEN', 'no active user for this subject in the tenant');
  return u.id as string;
}
async function tenantRoles(c: PoolClient, userId: string): Promise<Role[]> {
  return (await c.query('SELECT DISTINCT role FROM project_member WHERE user_id = $1', [userId])).rows.map((r) => r.role as Role);
}

// ------------------------------------------------------------------------------------------ health
route('GET', '/healthz', async () => ok({ status: 'ok' }), false);
route('GET', '/readyz', async (_r, d) => { try { await d.pool.query('SELECT 1'); return ok({ status: 'ready' }); } catch { throw new Problem('DEPENDENCY_UNAVAILABLE'); } }, false);

// ------------------------------------------------------------------------------------------ projects
route('GET', '/projects', async (r, d) => tx(d.pool, r.claims.tid, async (c) => {
  const pf = r.url.searchParams.get('portfolioId');
  if (pf !== null && !uuidRe.test(pf)) throw new Problem('VALIDATION_FAILED', 'portfolioId must be a uuid');
  const uid = await currentUser(c, r.claims.sub);
  const rows = (await c.query(
    `SELECT p.*, (SELECT max(ef_local) FROM task t WHERE t.project_id = p.id AND NOT t.is_summary) AS finish
       FROM project p JOIN project_member m ON m.project_id = p.id WHERE m.user_id = $1 AND p.status <> 'ARCHIVED' AND ($2::uuid IS NULL OR p.portfolio_id = $2) ORDER BY p.created_at, p.id LIMIT 500`, [uid, pf])).rows;
  return ok({ items: rows.map((x) => projectView(x, x.finish)) });
}));

route('POST', '/projects', async (r, d) => {
  const b = parse(S.ProjectCreate, r.body);
  return tx(d.pool, r.claims.tid, async (c) => {
    const uid = await currentUser(c, r.claims.sub);
    if (!(await c.query('SELECT 1 FROM calendar WHERE id = $1', [b.calendarId])).rowCount) throw new Problem('VALIDATION_FAILED', 'unknown calendarId', { errors: [{ path: '/calendarId', message: 'not found' }] });
    if (b.portfolioId && !(await c.query('SELECT 1 FROM portfolio WHERE id = $1', [b.portfolioId])).rowCount) throw new Problem('VALIDATION_FAILED', 'unknown portfolioId', { errors: [{ path: '/portfolioId', message: 'not found' }] });
    const row = (await c.query(
      `INSERT INTO project (tenant_id, name, calendar_id, start_local, deadline_local, currency, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [r.claims.tid, b.name, b.calendarId, b.startDate, b.deadline ?? null, b.currency ?? 'USD', uid])).rows[0];
    await c.query('INSERT INTO project_member (project_id, user_id, tenant_id, role) VALUES ($1,$2,$3,$4)', [row.id, uid, r.claims.tid, 'PROJECT_MANAGER']);
    await audit(c, { tenantId: r.claims.tid, actorId: uid, action: 'project.create', resource: 'project', resourceId: row.id, ip: r.ip, detail: { name: b.name } });
    return ok(projectView(row), 201, { Location: `/projects/${row.id}` });
  });
});

route('GET', '/projects/:id', async (r, d) => inProject(d, r.claims, r.params[0], 'plan.read', r.ip, async (c, a) => {
  const row = (await c.query('SELECT p.*, (SELECT max(ef_local) FROM task t WHERE t.project_id = p.id AND NOT t.is_summary) AS finish FROM project p WHERE id = $1', [a.projectId])).rows[0];
  return ok({ ...projectView(row, row.finish), role: a.role });
}));

route('PATCH', '/projects/:id', async (r, d) => {
  const b = parse(S.ProjectPatch, r.body);
  const ifMatch = r.raw.headers['if-match'];
  if (ifMatch === undefined) throw new Problem('PRECONDITION_REQUIRED', 'If-Match with the plan ETag is required');
  const out = await inProject(d, r.claims, r.params[0], 'plan.structure', r.ip, async (c, a) => {
    const cur = (await c.query('SELECT plan_version FROM project WHERE id = $1', [a.projectId])).rows[0];
    if (ifMatch !== '*' && ifMatch !== `"${cur.plan_version}"`) throw new Problem('VERSION_CONFLICT', 'plan changed since the ETag was issued', { currentPlanVersion: cur.plan_version });
    let commit = () => {};
    if (b.deadline !== undefined) {
      const batch = await applyBatch(d, c, a, { clientOpId: randomUUID(), expectedPlanVersion: cur.plan_version, commands: [{ op: 'setProject', patch: { deadline: b.deadline } }] }, 'project.update');
      commit = batch.commit;
    }
    const row = (await c.query('UPDATE project SET name = coalesce($2, name), status = coalesce($3, status), updated_at = now() WHERE id = $1 AND status <> \'ARCHIVED\' RETURNING *', [a.projectId, b.name ?? null, b.status ?? null])).rows[0];
    if (!row) throw new Problem('FORBIDDEN', 'project is archived');
    await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'project.update', resource: 'project', resourceId: a.projectId, ip: r.ip, detail: { fields: Object.keys(b) } });
    return { res: ok(projectView(row)), commit };
  });
  out.commit();
  return out.res;
});

route('DELETE', '/projects/:id', async (r, d) => inProject(d, r.claims, r.params[0], 'project.archive', r.ip, async (c, a) => {
  await c.query("UPDATE project SET status = 'ARCHIVED', updated_at = now() WHERE id = $1", [a.projectId]);
  d.cache.evict(a.projectId);
  await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'project.archive', resource: 'project', resourceId: a.projectId, ip: r.ip });
  return { status: 204 };
}));

// ------------------------------------------------------------------------------------------ membership
route('GET', '/projects/:id/members', async (r, d) => inProject(d, r.claims, r.params[0], 'plan.read', r.ip, async (c, a) => {
  const rows = (await c.query('SELECT m.user_id AS "userId", u.display_name AS "displayName", m.role FROM project_member m JOIN app_user u ON u.id = m.user_id WHERE m.project_id = $1 ORDER BY u.display_name, m.user_id', [a.projectId])).rows;
  return ok({ items: rows });
}));
route('PUT', '/projects/:id/members/:userId', async (r, d) => {
  const b = parse(S.MemberRole, r.body);
  return inProject(d, r.claims, r.params[0], 'members.manage', r.ip, async (c, a) => {
    needUuid(r.params[1], 'user');
    if (!(await c.query('SELECT 1 FROM app_user WHERE id = $1 AND is_active', [r.params[1]])).rowCount) throw new Problem('VALIDATION_FAILED', 'unknown user');
    if (b.role === 'ORG_ADMIN' && a.role !== 'ORG_ADMIN') throw new Problem('FORBIDDEN', 'only an org admin can grant ORG_ADMIN');
    const cur = (await c.query('SELECT role FROM project_member WHERE project_id = $1 AND user_id = $2', [a.projectId, r.params[1]])).rows[0];
    if (cur?.role === 'PROJECT_MANAGER' && b.role !== 'PROJECT_MANAGER') {
      const others = (await c.query("SELECT count(*)::int AS n FROM project_member WHERE project_id = $1 AND role = 'PROJECT_MANAGER' AND user_id <> $2", [a.projectId, r.params[1]])).rows[0].n;
      if (others === 0) throw new Problem('VALIDATION_FAILED', 'a project must keep at least one project manager');
    }
    if (b.role === 'ORG_ADMIN' && a.role !== 'ORG_ADMIN') throw new Problem('FORBIDDEN', 'only an org admin can grant ORG_ADMIN');
    await c.query('INSERT INTO project_member (project_id, user_id, tenant_id, role) VALUES ($1,$2,$3,$4) ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role', [a.projectId, r.params[1], a.tenantId, b.role]);
    await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'member.set', resource: 'project', resourceId: a.projectId, ip: r.ip, detail: { userId: r.params[1], role: b.role } });
    d.hub.revoke(a.projectId, r.params[1]);           // sockets re-subscribe with a fresh ticket under the new role
    return ok({ userId: r.params[1], role: b.role });
  });
});
route('DELETE', '/projects/:id/members/:userId', async (r, d) => inProject(d, r.claims, r.params[0], 'members.manage', r.ip, async (c, a) => {
  needUuid(r.params[1], 'user');
  const left = (await c.query("SELECT count(*)::int AS n FROM project_member WHERE project_id = $1 AND role = 'PROJECT_MANAGER' AND user_id <> $2", [a.projectId, r.params[1]])).rows[0].n;
  const target = (await c.query('SELECT role FROM project_member WHERE project_id = $1 AND user_id = $2', [a.projectId, r.params[1]])).rows[0];
  if (!target) throw new Problem('NOT_FOUND', 'member not found');
  if (target.role === 'PROJECT_MANAGER' && left === 0) throw new Problem('VALIDATION_FAILED', 'a project must keep at least one project manager');
  await c.query('DELETE FROM project_member WHERE project_id = $1 AND user_id = $2', [a.projectId, r.params[1]]);
  await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'member.remove', resource: 'project', resourceId: a.projectId, ip: r.ip, detail: { userId: r.params[1] } });
  d.hub.revoke(a.projectId, r.params[1]);
  return { status: 204 };
}));

// ------------------------------------------------------------------------------------------ plan reads
route('GET', '/projects/:id/plan', async (r, d) => inProject(d, r.claims, r.params[0], 'plan.read', r.ip, async (c, a) => {
  const costs = can(a.role, 'cost.read');
  const v = (await c.query('SELECT plan_version FROM project WHERE id = $1', [a.projectId])).rows[0].plan_version;
  const etag = `"${v}"`;
  if (r.raw.headers['if-none-match'] === etag) return { status: 304, headers: { ETag: etag } };
  const inc = new Set((r.url.searchParams.get('include') ?? 'tasks,links,assignments,calendars').split(','));
  const plan: Record<string, unknown> = { projectId: a.projectId, planVersion: v };
  if (inc.has('tasks') || inc.has('schedule')) plan.tasks = await orderedTasks(c, a.projectId, costs);
  if (inc.has('links')) plan.links = (await c.query('SELECT id, pred_id AS "predId", succ_id AS "succId", type, lag_min AS "lagMin", lag_basis AS "lagBasis" FROM task_link WHERE project_id = $1 ORDER BY id', [a.projectId])).rows;
  if (inc.has('assignments')) plan.assignments = (await c.query('SELECT id, task_id AS "taskId", resource_id AS "resourceId", units FROM assignment WHERE project_id = $1 ORDER BY id', [a.projectId])).rows;
  if (inc.has('calendars')) plan.calendars = (await c.query('SELECT id, name, base_id AS "baseId", time_zone AS "timeZone", week FROM calendar ORDER BY id')).rows;
  return ok(plan, 200, { ETag: etag });
}));

route('GET', '/projects/:id/tasks', async (r, d) => inProject(d, r.claims, r.params[0], 'plan.read', r.ip, async (c, a) => {
  const all = await orderedTasks(c, a.projectId, can(a.role, 'cost.read'));
  const qp = r.url.searchParams;
  let list = all;
  if (qp.get('critical') === 'true') list = list.filter((t) => (t.schedule as { critical?: boolean } | null)?.critical);
  if (qp.get('parentId')) list = list.filter((t) => t.parentId === qp.get('parentId'));
  const q = qp.get('q');
  if (q) list = list.filter((t) => String(t.name).toLowerCase().includes(q.toLowerCase()));
  const fb = qp.get('finishBefore');
  if (fb) { const ms = Date.parse(`${fb.length === 10 ? fb + 'T23:59:59' : fb}Z`); if (Number.isNaN(ms)) throw new Problem('VALIDATION_FAILED', 'finishBefore must be a date or naive local date-time');
    list = list.filter((t) => { const s = t.schedule as { ef: string } | null; return s !== null && Date.parse(`${s.ef}Z`) <= ms; }); }
  const { limit, offset, next } = page(qp, list.length);
  return ok({ items: list.slice(offset, offset + limit), total: list.length, offset, limit, nextCursor: next });
}));

route('GET', '/projects/:id/tasks/:taskId', async (r, d) => inProject(d, r.claims, r.params[0], 'plan.read', r.ip, async (c, a) => {
  const all = await orderedTasks(c, a.projectId, can(a.role, 'cost.read'));
  const t = all.find((x) => x.id === r.params[1]);
  if (!t) throw new Problem('NOT_FOUND', 'task not found');
  return ok(t);
}));

// ------------------------------------------------------------------------------------------ the write path
route('POST', '/projects/:id/commands', async (r, d) => {
  const body = parse(S.CommandBatch, r.body);
  const out = await inProject(d, r.claims, r.params[0], 'plan.progress', r.ip, (c, a) => applyBatch(d, c, a, body));
  out.commit();
  return ok(out.result, 200);
});

route('POST', '/projects/:id/schedule', async (r, d) => {
  const body = parse(S.PreviewRequest, r.body ?? {});
  if ((body.commands?.length ?? 0) > 1000) throw new Problem('PLAN_TOO_LARGE', 'at most 1000 commands per batch');
  return inProject(d, r.claims, r.params[0], 'plan.read', r.ip, async (c) => {
    const { model } = await loadModel(c, r.params[0]);
    const scratch = model.clone();
    const edits = [];
    for (const cmd of body.commands ?? []) edits.push(...scratch.apply(cmd, []));
    const net = toNetwork(scratch);
    return ok(scheduleApi(net.result()));
  });
});

// ------------------------------------------------------------------------------------------ scenarios
route('POST', '/projects/:id/scenarios', async (r, d) => {
  const b = parse(S.ScenarioCreate, r.body);
  return inProject(d, r.claims, r.params[0], 'plan.structure', r.ip, async (c, a) => {
    const { model, version } = await loadModel(c, a.projectId);
    const scratch = model.clone();
    for (const cmd of b.commands) scratch.apply(cmd, []);
    const res = toNetwork(scratch).result();
    const summary = { start: fromMs(res.start), finish: fromMs(res.finish), criticalPath: res.criticalPath, conflicts: res.conflicts };
    const row = (await c.query('INSERT INTO scenario (tenant_id, project_id, name, base_plan_version, patch, result, created_by) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7) RETURNING id',
      [a.tenantId, a.projectId, b.name, version, JSON.stringify(b.commands), JSON.stringify(summary), a.userId])).rows[0];
    await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'scenario.create', resource: 'scenario', resourceId: row.id, ip: r.ip });
    return ok({ id: row.id, name: b.name, basePlanVersion: version, result: summary }, 201);
  });
});
route('GET', '/projects/:id/scenarios', async (r, d) => inProject(d, r.claims, r.params[0], 'plan.read', r.ip, async (c, a) => {
  const rows = (await c.query('SELECT id, name, base_plan_version AS "basePlanVersion", result FROM scenario WHERE project_id = $1 ORDER BY created_at, id', [a.projectId])).rows;
  return ok({ items: rows });
}));

route('GET', '/projects/:id/calendars', async (r, d) => inProject(d, r.claims, r.params[0], 'plan.read', r.ip, async (c) => {
  const rows = (await c.query('SELECT id, name, base_id AS "baseId", time_zone AS "timeZone", week FROM calendar ORDER BY id')).rows;
  return ok({ items: rows });
}));

// ------------------------------------------------------------------------------------------ resources
route('POST', '/resources', async (r, d) => {
  const b = parse(S.ResourceCreate, r.body);
  return tx(d.pool, r.claims.tid, async (c) => {
    const uid = await currentUser(c, r.claims.sub);
    if (!(await tenantRoles(c, uid)).some((x) => can(x, 'resource.write'))) throw new Problem('FORBIDDEN', 'creating resources requires the project-manager or admin role');
    if (b.calendarId && !(await c.query('SELECT 1 FROM calendar WHERE id = $1', [b.calendarId])).rowCount) throw new Problem('VALIDATION_FAILED', 'unknown calendarId or userId');
    if (b.userId && !(await c.query('SELECT 1 FROM app_user WHERE id = $1', [b.userId])).rowCount) throw new Problem('VALIDATION_FAILED', 'unknown calendarId or userId');
    const row = (await c.query('INSERT INTO resource (tenant_id, name, kind, max_units, calendar_id, user_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [r.claims.tid, b.name, b.kind ?? 'WORK', b.maxUnits ?? 1, b.calendarId ?? null, b.userId ?? null]).catch((e) => { if (e.code === '23503') throw new Problem('VALIDATION_FAILED', 'unknown calendarId or userId'); throw e; })).rows[0];
    const rates = [...(b.rates ?? []), ...(b.stdRatePerHour !== undefined || b.perUseCost !== undefined ? [{ effectiveFrom: '1970-01-01', stdPerHour: b.stdRatePerHour ?? 0, perUse: b.perUseCost }] : [])];
    if (rates.length && !(await tenantRoles(c, uid)).some((x) => can(x, 'cost.read'))) throw new Problem('FORBIDDEN', 'rates require a cost-visible role');
    for (const rt of rates)
      await c.query('INSERT INTO resource_rate (resource_id, tenant_id, effective_from, std_rate_per_hour, per_use_cost) VALUES ($1,$2,$3,$4,$5)', [row.id, r.claims.tid, rt.effectiveFrom, rt.stdPerHour, rt.perUse ?? 0]);
    d.cache.clear();   // PF-015: cached engine inputs embed the resource list
    await audit(c, { tenantId: r.claims.tid, actorId: uid, action: 'resource.create', resource: 'resource', resourceId: row.id, ip: r.ip });
    return ok({ id: row.id, name: b.name, kind: b.kind ?? 'WORK', maxUnits: b.maxUnits ?? 1, calendarId: b.calendarId ?? null, isActive: true, ...(b.stdRatePerHour !== undefined ? { stdRatePerHour: b.stdRatePerHour } : {}), ...(b.perUseCost !== undefined ? { perUseCost: b.perUseCost } : {}) }, 201);
  });
});
route('GET', '/resources', async (r, d) => tx(d.pool, r.claims.tid, async (c) => {
  const uid = await currentUser(c, r.claims.sub);
  const costs = (await tenantRoles(c, uid)).some((x) => can(x, 'cost.read'));
  const rows = (await c.query('SELECT id, name, kind, max_units AS "maxUnits", calendar_id AS "calendarId", is_active AS "isActive" FROM resource ORDER BY name, id LIMIT 1000')).rows;
  if (costs) {
    const rates = (await c.query("SELECT resource_id, to_char(effective_from,'YYYY-MM-DD') AS \"effectiveFrom\", std_rate_per_hour AS \"stdPerHour\", per_use_cost AS \"perUse\" FROM resource_rate ORDER BY effective_from")).rows;
    for (const x of rows) x.rates = rates.filter((q) => q.resource_id === x.id).map(({ resource_id: _r, ...rest }) => { void _r; return rest; });
  }
  return ok({ items: rows });
}));

route('GET', '/resources/:id/load', async (r, d) => tx(d.pool, r.claims.tid, async (c) => {
  needUuid(r.params[0]);
  const uid = await currentUser(c, r.claims.sub);
  const res = (await c.query('SELECT id, max_units, calendar_id FROM resource WHERE id = $1', [r.params[0]])).rows[0];
  if (!res) throw new Problem('NOT_FOUND', 'resource not found');
  const from = r.url.searchParams.get('from'), to = r.url.searchParams.get('to');
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const real = (v: string) => day.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
  if (!from || !to || !real(from) || !real(to)) throw new Problem('VALIDATION_FAILED', 'from and to are required and must be real YYYY-MM-DD dates');
  if (from > to) throw new Problem('VALIDATION_FAILED', 'from must not be after to');
  // projects the caller can read that contain assignments of this resource
  const projects = (await c.query(
    `SELECT DISTINCT a.project_id FROM assignment a JOIN project_member m ON m.project_id = a.project_id AND m.user_id = $1 WHERE a.resource_id = $2`, [uid, res.id])).rows;
  const perDay = new Map<string, number>();
  for (const p of projects) {
    const e = await liveEntry(d, c, p.project_id);
    const rsrc: ResourceIn[] = await resourcesFor(c, e.model, false);
    const proj = e.model.engineProject(rsrc, true);
    const eff = applyResourceRules(proj);
    const tp = timephase(eff, e.net.result());
    for (const [dday, w] of Object.entries(tp.byResource[res.id] ?? {})) perDay.set(dday, (perDay.get(dday) ?? 0) + w);
  }
  const defs = (await c.query('SELECT id, base_id, week FROM calendar')).rows.map((x) => ({ id: x.id, baseId: x.base_id ?? undefined, week: x.week }));
  const exc = (await c.query("SELECT calendar_id, to_char(day,'YYYY-MM-DD') AS day, ranges FROM calendar_exception")).rows;
  for (const dd of defs) { const ex = exc.filter((x) => x.calendar_id === dd.id); if (ex.length) (dd as any).exceptions = Object.fromEntries(ex.map((x) => [x.day, x.ranges])); } // eslint-disable-line @typescript-eslint/no-explicit-any
  let calId = res.calendar_id;
  if (!calId) calId = (await c.query('SELECT calendar_id FROM project WHERE id = $1', [projects[0]?.project_id ?? '00000000-0000-0000-0000-000000000000'])).rows[0]?.calendar_id ?? defs[0]?.id;
  const cal: WorkCalendar | undefined = calId ? resolveCalendars(defs).get(calId) : undefined;
  const days = [...perDay.keys()].filter((x) => (!from || x >= from) && (!to || x <= to)).sort().map((dday) => {
    const ms = Date.parse(`${dday}T00:00:00Z`);
    const cap = cal ? workByDay(cal, ms, ms + 86_400_000).reduce((s, b) => s + b.minutes, 0) * res.max_units : null;
    const w = Math.round(perDay.get(dday)! * 100) / 100;
    return { day: dday, workMin: w, capacityMin: cap, overallocated: cap !== null && w > cap + 1e-6 };
  });
  return ok({ resourceId: res.id, maxUnits: res.max_units, days });
}));

// ------------------------------------------------------------------------------------------ levelling
route('POST', '/projects/:id/level', async (r, d) => {
  const b = parse(S.LevelRequest, r.body ?? {});
  if (b.apply && (b.clientOpId === undefined || b.expectedPlanVersion === undefined))
    throw new Problem('VALIDATION_FAILED', 'apply=true requires clientOpId and expectedPlanVersion', { errors: [{ path: '/clientOpId', message: 'required with apply' }] });
  const out = await inProject(d, r.claims, r.params[0], 'plan.level_risk', r.ip, async (c, a) => {
    const e = await liveEntry(d, c, a.projectId);
    const res = await resourcesFor(c, e.model, false);
    const p = e.model.engineProject(res, true);
    const lv = levelResources(p, { withinFloatOnly: b.withinFloatOnly ?? true, order: b.order ?? 'PRIORITY_FLOAT' });
    const delays = lv.report.delays.map((x) => ({ taskId: x.taskId, delayMin: x.delayMin }));
    const response = {
      delays, projectFinish: fromMs(lv.report.finishAfter), finishBefore: fromMs(lv.report.finishBefore), converged: lv.report.converged,
      steps: lv.report.steps.length,
      unresolved: lv.report.unresolved.map((u) => ({ resourceId: u.resourceId, at: fromMs(u.at), load: u.load, maxUnits: u.maxUnits, taskIds: u.taskIds, reason: u.reason })),
      applied: false as boolean, planVersion: e.version as number,
    };
    if (!b.apply) return { response, commit: () => {} };
    const want = new Map(lv.project.tasks.map((t) => [t.id, t.levelingDelayMin ?? 0]));
    const cmds = [];
    for (const [id, t] of e.model.tasks) { const cur = t.levelingDelayMin ?? 0, nxt = want.get(id) ?? 0; if (cur !== nxt && !e.model.isSummary(id)) cmds.push({ op: 'updateTask' as const, id, patch: { levelingDelayMin: nxt } }); }
    if (!cmds.length) return { response, commit: () => {} };
    const batch = await applyBatch(d, c, a, { clientOpId: b.clientOpId!, expectedPlanVersion: b.expectedPlanVersion!, commands: cmds }, 'plan.level');
    return { response: { ...response, applied: true, planVersion: (batch.result as { planVersion: number }).planVersion }, commit: batch.commit };
  });
  out.commit();
  return ok(out.response);
});

// ------------------------------------------------------------------------------------------ baselines, EVM, risk
route('POST', '/projects/:id/baselines', async (r, d) => {
  const b = parse(S.BaselineCreate, r.body ?? {});
  return inProject(d, r.claims, r.params[0], 'plan.baseline', r.ip, async (c, a) => {
    const e = await liveEntry(d, c, a.projectId);
    const res = e.net.result();
    const rs = await resourcesFor(c, e.model, true);
    const eff = applyResourceRules(e.model.engineProject(rs, true));
    const tp = timephase(eff, res);
    const cost = new Map<string, number>(), work = new Map<string, number>();
    for (const x of tp.assignments) { cost.set(x.taskId, (cost.get(x.taskId) ?? 0) + x.cost); work.set(x.taskId, (work.get(x.taskId) ?? 0) + x.workMin); }
    const num = b.number ?? 0;
    if ((await c.query('SELECT 1 FROM baseline WHERE project_id = $1 AND number = $2', [a.projectId, num])).rowCount) throw new Problem('BASELINE_EXISTS', `baseline ${num} is already saved and immutable`);
    const bl = (await c.query('INSERT INTO baseline (tenant_id, project_id, number, label, plan_version, saved_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, saved_at', [a.tenantId, a.projectId, num, b.label ?? null, e.version, a.userId])).rows[0];
    const leaves = [...e.model.tasks.values()].filter((t) => !e.model.isSummary(t.id));
    await c.query(
      `INSERT INTO baseline_task (baseline_id, task_id, tenant_id, start_local, finish_local, duration_min, work_min, cost)
       SELECT $1, v.id, $2, v.s, v.f, v.d, v.w, v.c FROM UNNEST($3::uuid[], $4::timestamp[], $5::timestamp[], $6::int[], $7::numeric[], $8::numeric[]) AS v(id, s, f, d, w, c)`,
      [bl.id, a.tenantId, leaves.map((t) => t.id), leaves.map((t) => fromMs(res.tasks[t.id].es)), leaves.map((t) => fromMs(res.tasks[t.id].ef)),
        leaves.map((t) => e.model.effectiveTask(t.id).durationMin), leaves.map((t) => Math.round(work.get(t.id) ?? 0)), leaves.map((t) => (cost.get(t.id) ?? 0) + (t.fixedCost ?? 0))]);
    await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'baseline.save', resource: 'baseline', resourceId: bl.id, ip: r.ip, detail: { number: num, planVersion: e.version } });
    return ok({ id: bl.id, number: num, label: b.label ?? null, planVersion: e.version, taskCount: leaves.length, finish: fromMs(res.finish) }, 201);
  });
});
route('GET', '/projects/:id/baselines', async (r, d) => inProject(d, r.claims, r.params[0], 'plan.read', r.ip, async (c, a) => {
  const costs = can(a.role, 'cost.read');
  const e = await liveEntry(d, c, a.projectId);
  const cur = e.net.result();
  const rows = (await c.query(
    `SELECT b.id, b.number, b.label, b.plan_version AS "planVersion", b.saved_at AS "savedAt", max(t.finish_local) AS finish, sum(t.cost) AS cost, count(*)::int AS "taskCount"
       FROM baseline b LEFT JOIN baseline_task t ON t.baseline_id = b.id WHERE b.project_id = $1 GROUP BY b.id ORDER BY b.number`, [a.projectId])).rows;
  return ok({ items: rows.map((x) => ({ id: x.id, number: x.number, label: x.label, planVersion: x.planVersion, savedAt: x.savedAt, finish: x.finish === null ? null : fromMs(x.finish), taskCount: x.taskCount,
    finishVarianceMin: x.finish === null ? null : Math.round((cur.finish - x.finish) / 60000), ...(costs ? { cost: x.cost } : {}) })) });
}));

route('GET', '/projects/:id/evm', async (r, d) => inProject(d, r.claims, r.params[0], 'cost.read', r.ip, async (c, a) => {
  const e = await liveEntry(d, c, a.projectId);
  const sd = r.url.searchParams.get('statusDate');
  const status = sd ? toMs(sd.length === 10 ? `${sd}T00:00` : sd) : e.model.project.statusDate ?? Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  if (status === undefined || Number.isNaN(status)) throw new Problem('VALIDATION_FAILED', 'statusDate query parameter (or a project status date) is required');
  const acQ = r.url.searchParams.get('ac');
  const ac = acQ === null ? null : Number(acQ);
  if (ac !== null && !(ac >= 0)) throw new Problem('VALIDATION_FAILED', 'ac must be a non-negative number');
  const rs = await resourcesFor(c, e.model, true);
  const eff = applyResourceRules(e.model.engineProject(rs, true));
  const res = e.net.result();
  const tp = timephase(eff, res);
  const budget = new Map<string, number>();
  for (const x of tp.assignments) budget.set(x.taskId, (budget.get(x.taskId) ?? 0) + x.cost);
  let ev = 0;
  for (const t of e.model.tasks.values()) if (!e.model.isSummary(t.id)) ev += ((budget.get(t.id) ?? 0) + (t.fixedCost ?? 0)) * (t.percentComplete ?? 0);
  let bac = tp.totalCost, pv = plannedValueAt(eff, res, tp, status);
  const bq = r.url.searchParams.get('baseline');
  let pvBasis = 'cost of working days before the status date';
  if (bq !== null) {
    const bn = Number(bq);
    if (!Number.isInteger(bn) || bn < 0 || bn > 10) throw new Problem('VALIDATION_FAILED', 'baseline must be an integer 0..10');
    const bl = (await c.query('SELECT id FROM baseline WHERE project_id = $1 AND number = $2', [a.projectId, bn])).rows[0];
    if (!bl) throw new Problem('NOT_FOUND', `baseline ${bn} not found`);
    const bt = (await c.query('SELECT task_id, start_local, finish_local, cost FROM baseline_task WHERE baseline_id = $1', [bl.id])).rows;
    bac = 0; pv = 0;
    for (const t of bt) {
      const cost = Number(t.cost), s0 = t.start_local as number, f0 = t.finish_local as number;
      bac += cost;
      pv += status >= f0 ? cost : status <= s0 || f0 <= s0 ? 0 : cost * ((status - s0) / (f0 - s0));
    }
    pvBasis = `baseline ${bn}: cost spread linearly over elapsed time between baseline start and finish`;
    // EV against the baseline budget of each task
    ev = 0;
    for (const t of bt) ev += Number(t.cost) * (e.model.tasks.get(t.task_id)?.percentComplete ?? 0);
  }
  const base = { statusDate: fromMs(status), bac, pv, ev: Math.round(ev * 100) / 100, sv: Math.round((ev - pv) * 100) / 100, spi: pv > 0 ? ev / pv : null, pvBasis };
  if (ac === null) return ok({ ...base, ac: null, cpi: null, cv: null, note: 'actual cost is not tracked by the reference server; pass ?ac= to compute cost indices' });
  return ok({ ...base, ac, ...evm({ bac, pv, ev, ac }) });
}));

route('POST', '/projects/:id/risk-runs', async (r, d) => {
  const b = parse(S.RiskRequest, r.body ?? {});
  return inProject(d, r.claims, r.params[0], 'plan.level_risk', r.ip, async (c, a) => {
    const e = await liveEntry(d, c, a.projectId);
    const iterations = b.iterations ?? 1000, seed = b.seed ?? 42;
    const n = [...e.model.tasks.keys()].length;
    if (n * iterations > 4_000_000) throw new Problem('PLAN_TOO_LARGE', 'tasks x iterations exceeds the synchronous quota (4,000,000); reduce iterations');
    const result = await runRisk<ReturnType<typeof simulate>>(a.tenantId, e.model.engineProject(), iterations, seed);
    const out = { p50: fromMs(result.p50), p80: fromMs(result.p80), p90: fromMs(result.p90), iterations, seed, criticalityIndex: result.criticalityIndex };
    const row = (await c.query(
      `INSERT INTO risk_run (tenant_id, project_id, plan_version, iterations, seed, status, p50_local, p80_local, p90_local, criticality, requested_by, finished_at, result)
       VALUES ($1,$2,$3,$4,$5,'SUCCEEDED',$6,$7,$8,$9::jsonb,$10,now(),$11::jsonb) RETURNING id`,
      [a.tenantId, a.projectId, e.version, iterations, seed, out.p50, out.p80, out.p90, JSON.stringify(out.criticalityIndex), a.userId, JSON.stringify(out)])).rows[0];
    await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'risk.run', resource: 'risk_run', resourceId: row.id, ip: r.ip, detail: { iterations } });
    return ok({ id: row.id, status: 'SUCCEEDED', planVersion: e.version, ...out }, 201);
  });
});
route('GET', '/projects/:id/risk-runs/:runId', async (r, d) => inProject(d, r.claims, r.params[0], 'plan.read', r.ip, async (c, a) => {
  needUuid(r.params[1], 'risk run');
  const row = (await c.query('SELECT id, status, plan_version, result FROM risk_run WHERE id = $1 AND project_id = $2', [r.params[1], a.projectId])).rows[0];
  if (!row) throw new Problem('NOT_FOUND', 'risk run not found');
  return ok({ id: row.id, status: row.status, planVersion: row.plan_version, ...row.result });
}));

// ------------------------------------------------------------------------------------------ export, realtime, audit
route('GET', '/projects/:id/export', async (r, d) => inProject(d, r.claims, r.params[0], 'export', r.ip, async (c, a) => {
  const costs = can(a.role, 'cost.read');
  const tasks = await orderedTasks(c, a.projectId, costs);
  const links = (await c.query('SELECT id, pred_id AS "predId", succ_id AS "succId", type, lag_min AS "lagMin", lag_basis AS "lagBasis" FROM task_link WHERE project_id = $1 ORDER BY id', [a.projectId])).rows;
  const asg = (await c.query('SELECT id, task_id AS "taskId", resource_id AS "resourceId", units FROM assignment WHERE project_id = $1 ORDER BY id', [a.projectId])).rows;
  const pr = (await c.query('SELECT * FROM project WHERE id = $1', [a.projectId])).rows[0];
  await audit(c, { tenantId: a.tenantId, actorId: a.userId, action: 'project.export', resource: 'project', resourceId: a.projectId, ip: r.ip });
  return ok({ format: 'planforge-plan/1', project: projectView(pr), tasks, links, assignments: asg }, 200, { 'Content-Disposition': `attachment; filename="plan-${a.projectId}.json"` });
}));

route('POST', '/realtime/tickets', async (r, d) => {
  const b = parse(S.TicketRequest, r.body);
  return inProject(d, r.claims, b.projectId, 'plan.read', r.ip, async (c, a) => {
    const row = (await c.query("INSERT INTO realtime_ticket (tenant_id, project_id, user_id, expires_at) VALUES ($1,$2,$3, now() + interval '60 seconds') RETURNING id, expires_at", [a.tenantId, a.projectId, a.userId])).rows[0];
    return ok({ ticket: `${a.tenantId}.${row.id}`, expiresAt: row.expires_at, url: '/realtime' }, 201);
  });
});

route('GET', '/audit-events', async (r, d) => tx(d.pool, r.claims.tid, async (c) => {
  const uid = await currentUser(c, r.claims.sub);
  if (!(await tenantRoles(c, uid)).some((x) => can(x, 'audit.read'))) throw new Problem('FORBIDDEN', 'audit trail requires the org-admin role');
  const limit = Math.min(500, Math.max(1, Number(r.url.searchParams.get('limit') ?? 100) || 100));
  const before = Number(r.url.searchParams.get('beforeId') ?? 0) || null;
  const qs = r.url.searchParams, actor = qs.get('actorId'), from = qs.get('from'), to = qs.get('to');
  const ts = (v: string | null) => { if (v === null) return null; const ms = Date.parse(v); if (Number.isNaN(ms) || !/^\d{4}-\d{2}-\d{2}/.test(v) || new Date(ms).toISOString().slice(0, 10) !== v.slice(0, 10)) throw new Problem('VALIDATION_FAILED', 'from/to must be RFC 3339 date-times'); return new Date(ms).toISOString(); };
  if (actor !== null && !uuidRe.test(actor)) throw new Problem('VALIDATION_FAILED', 'actorId must be a uuid');
  const fromTs = ts(from), toTs = ts(to);
  const rows = (await c.query(
    `SELECT id, occurred_at AS "occurredAt", actor_id AS "actorId", action, resource, resource_id AS "resourceId", detail FROM audit_event
      WHERE ($2::bigint IS NULL OR id < $2) AND ($3::uuid IS NULL OR actor_id = $3) AND ($4::timestamptz IS NULL OR occurred_at >= $4) AND ($5::timestamptz IS NULL OR occurred_at <= $5)
      ORDER BY id DESC LIMIT $1`, [limit, before, actor, fromTs, toTs])).rows;
  return ok({ items: rows, nextBeforeId: rows.length === limit ? rows[rows.length - 1].id : null });
}));
route('GET', '/audit-events/verify', async (r, d) => tx(d.pool, r.claims.tid, async (c) => {
  const uid = await currentUser(c, r.claims.sub);
  if (!(await tenantRoles(c, uid)).some((x) => can(x, 'audit.read'))) throw new Problem('FORBIDDEN', 'audit trail requires the org-admin role');
  return ok(await verifyChain(c, r.claims.tid));
}));

// ------------------------------------------------------------------------------------------ declared but not part of this build
for (const [m, p, code] of [['GET', '/webhooks', 'NOT_IMPLEMENTED'], ['POST', '/webhooks', 'NOT_IMPLEMENTED'], ['POST', '/imports', 'NOT_IMPLEMENTED'], ['GET', '/imports/:jobId', 'NOT_IMPLEMENTED']] as const)
  route(m, p, async () => { throw new Problem(code, 'webhooks and the sandboxed import pipeline are specified (docs/10, docs/13) but not built in the reference server'); });

export const permissionMatrix = MATRIX;
export { newId };

// ------------------------------------------------------------------------------------------ pipeline
const buckets = new Map<string, { tokens: number; at: number }>();
function limited(key: string, perMin: number): boolean {
  const now = Date.now(), b = buckets.get(key) ?? { tokens: perMin, at: now };
  b.tokens = Math.min(perMin, b.tokens + ((now - b.at) / 60_000) * perMin); b.at = now;
  buckets.set(key, b);
  if (buckets.size > 50_000) buckets.clear();
  if (b.tokens < 1) return true;
  b.tokens -= 1;
  return false;
}

const idem = new Map<string, { hash: string; status: number; body: unknown; headers?: Record<string, string>; at: number }>();
function wellFormed(v: unknown, depth = 0): boolean {
  if (typeof v === 'string') return v.isWellFormed() && !v.includes('\u0000');
  if (depth > 64) return false;
  if (Array.isArray(v)) return v.every((x) => wellFormed(x, depth + 1));
  if (v && typeof v === 'object') return Object.entries(v).every(([k, x]) => wellFormed(k, depth + 1) && wellFormed(x, depth + 1));
  return true;
}
const MAX_BODY = 2_000_000;
async function readBody(req: IncomingMessage): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'DELETE') return undefined;
  const ct = req.headers['content-type'] ?? '';
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > MAX_BODY) throw new Problem('PLAN_TOO_LARGE', 'request body exceeds 2 MB');
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const ch of req) {
    n += (ch as Buffer).length;
    if (n > MAX_BODY) throw new Problem('PLAN_TOO_LARGE', 'request body exceeds 2 MB');
    chunks.push(ch as Buffer);
  }
  if (!n) return undefined;
  if (!/^application\/json(\s*;|$)/i.test(ct)) throw new Problem('VALIDATION_FAILED', 'Content-Type must be application/json');
  let v: unknown;
  try { v = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Problem('VALIDATION_FAILED', 'body is not valid JSON'); }
  if (!wellFormed(v)) throw new Problem('VALIDATION_FAILED', 'strings must be valid Unicode (lone surrogate or NUL found)');
  return v;
}

const SEC_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'Cross-Origin-Resource-Policy': 'same-origin' };

export function createHandler(d: Deps, log: (line: string) => void = () => {}) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const traceId = randomUUID(), t0 = Date.now();
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status: number, body: unknown, extra: Record<string, string> = {}, problem = false) => {
      const payload = body === undefined ? '' : JSON.stringify(body);
      res.writeHead(status, { ...SEC_HEADERS, 'X-Trace-Id': traceId, ...(payload ? { 'Content-Type': problem ? 'application/problem+json' : 'application/json' } : {}), ...extra });
      res.end(payload);
    };
    try {
      const hit = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
      if (!hit) {
        { const allow = [...new Set(routes.filter((x) => x.re.test(url.pathname)).map((x) => x.method))]; if (allow.length) return send(405, { ...problemBody(new Problem('VALIDATION_FAILED', 'method not allowed'), url.pathname, traceId), status: 405 }, { Allow: allow.join(', ') }, true); }
        throw new Problem('NOT_FOUND', 'no such route');
      }
      let claims = { sub: 'anonymous', tid: '00000000-0000-0000-0000-000000000000' };
      if (hit.auth) {
        const h = req.headers.authorization ?? '';
        claims = verify(h.startsWith('Bearer ') ? h.slice(7) : undefined, d.secret);
        if (limited(`${claims.tid}:${claims.sub}`, d.rateLimitPerMin)) { res.setHeader('Retry-After', '10'); throw new Problem('RATE_LIMITED'); }
      } else if (limited(`ip:${req.socket.remoteAddress}`, d.rateLimitPerMin * 2)) throw new Problem('RATE_LIMITED');
      const body = await readBody(req);
      const m = hit.re.exec(url.pathname)!;
      // Idempotency-Key (docs/07 section 1.6): same key+body replays the stored response, same key+different body is 409. In-process, 24 h, single instance (G-22).
      const ik = req.method === 'POST' && hit.auth ? req.headers['idempotency-key'] : undefined;
      let ikKey = '', ikHash = '';
      if (typeof ik === 'string' && ik.length >= 8 && ik.length <= 128) {
        ikKey = `${claims.tid}:${claims.sub}:${url.pathname}:${ik}`;
        ikHash = createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
        const prev = idem.get(ikKey);
        if (prev && Date.now() - prev.at < 86_400_000) {
          if (prev.hash !== ikHash) throw new Problem('DUPLICATE_CLIENT_OP', 'Idempotency-Key was already used with a different request body');
          send(prev.status, prev.body, { ...(prev.headers ?? {}), 'Idempotent-Replayed': 'true' });
          return;
        }
      }
      const out = await hit.h({ raw: req, url, params: m.slice(1).map((s) => decodeURIComponent(s)), claims, body, ip: req.socket.remoteAddress ?? null, traceId }, d);
      if (ikKey && out.status < 300) { if (idem.size > 20_000) idem.clear(); idem.set(ikKey, { hash: ikHash, status: out.status, body: out.body, headers: out.headers, at: Date.now() }); }
      send(out.status, out.body, out.headers);
      log(`${req.method} ${url.pathname} ${out.status} ${Date.now() - t0}ms ${traceId}`);
    } catch (e) {
      let p: Problem;
      if (e instanceof Problem) p = e;
      else if (e instanceof ZodError) p = new Problem('VALIDATION_FAILED', 'validation failed');
      else if (e instanceof URIError) p = new Problem('NOT_FOUND', 'no such route');
      else if (typeof (e as { code?: unknown })?.code === 'string' && /^(22|23)/.test((e as { code: string }).code)) p = new Problem('VALIDATION_FAILED', 'value rejected by data constraints'); // PF-012: client-caused DB errors are 4xx
      else if (/^(57P0|08)/.test((e as { code?: string })?.code ?? '') || /terminat|Connection (closed|ended)|ECONNRESET/i.test((e as Error)?.message ?? '')) p = new Problem('DEPENDENCY_UNAVAILABLE', 'database connection lost; retry');
      else if ((e as { code?: string })?.code === '57014') p = new Problem('DEPENDENCY_UNAVAILABLE', 'request timed out');
      else { p = new Problem('INTERNAL'); log(`ERROR ${req.method} ${url.pathname} ${traceId} ${(e as Error)?.stack ?? e}`); }
      const extra: Record<string, string> = p.code === 'RATE_LIMITED' ? { 'Retry-After': '10' } : p.code === 'UNAUTHENTICATED' ? { 'WWW-Authenticate': 'Bearer' } : {};
      send(p.status, problemBody(p, url.pathname, traceId), extra, true);
      if (p.code !== 'INTERNAL') log(`${req.method} ${url.pathname} ${p.status} ${p.code} ${Date.now() - t0}ms ${traceId}`);
    }
  };
}
