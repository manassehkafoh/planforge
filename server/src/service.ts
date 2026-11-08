import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { Network, ScheduleError, type ResourceIn, type ScheduleResult } from '../../engine/src/index.ts';
import { audit, canonical } from './audit.ts';
import { tx } from './db.ts';
import { Problem, fromEngine } from './errors.ts';
import { fromMs, type PlanModel, type RowOp } from './model.ts';
import { can, PROGRESS_FIELDS, type Perm, type Role } from './rbac.ts';
import type { Cmd } from './schemas.ts';
import { loadModel, persistRows, PlanCache, snapshotOf, writeSchedule, type CacheEntry } from './store.ts';
import type { Hub } from './realtime.ts';

export interface Access { tenantId: string; userId: string; role: Role; projectId: string; ip?: string | null }
export interface Deps { pool: Pool; secret: string; cache: PlanCache; hub: Hub; rateLimitPerMin: number }

export const taskOutApi = (o: ScheduleResult['tasks'][string], driver?: unknown) => ({
  es: fromMs(o.es), ef: fromMs(o.ef), ls: fromMs(o.ls), lf: fromMs(o.lf),
  totalFloatMin: o.totalFloatMin, freeFloatMin: Math.min(o.freeFloatMin, 2_000_000_000), critical: o.critical, nearCritical: o.nearCritical,
  isSummary: o.isSummary, state: o.state, ...(driver ? { driver } : {}),
});

export function scheduleApi(res: ScheduleResult, only?: Iterable<string>) {
  const ids = only ? [...only] : Object.keys(res.tasks);
  return {
    start: fromMs(res.start), finish: fromMs(res.finish),
    tasks: Object.fromEntries(ids.filter((id) => res.tasks[id]).map((id) => [id, taskOutApi(res.tasks[id], res.drivers[id])])),
    criticalPath: res.criticalPath, conflicts: res.conflicts,
  };
}

/** Live network for a project at its current version: cache hit, else rebuilt from the database. */
export async function liveEntry(d: Deps, c: PoolClient, projectId: string): Promise<CacheEntry & { status: string }> {
  const v = (await c.query('SELECT plan_version, status FROM project WHERE id = $1', [projectId])).rows[0];
  if (!v) throw new Problem('NOT_FOUND', 'project not found');
  const hit = d.cache.get(projectId, v.plan_version);
  if (hit) return { ...hit, status: v.status };
  const { model, version } = await loadModel(c, projectId);
  const net = toNetwork(model);
  const entry: CacheEntry = { version, model, net, snapshot: snapshotOf(net.result()) };
  d.cache.set(projectId, entry);
  return { ...entry, status: v.status };
}

export function toNetwork(model: PlanModel): Network {
  try { return new Network(model.engineProject()); } catch (e) { if (e instanceof ScheduleError) throw fromEngine(e); throw e; }
}

export async function resourcesFor(c: PoolClient, model: PlanModel, withRates: boolean): Promise<ResourceIn[]> {
  const ids = [...new Set([...model.asg.values()].map((a) => a.resourceId))];
  if (!ids.length) return [];
  const rs = (await c.query('SELECT id, kind, max_units, calendar_id FROM resource WHERE id = ANY($1::uuid[])', [ids])).rows;
  const rates = withRates ? (await c.query('SELECT resource_id, effective_from, std_rate_per_hour, per_use_cost FROM resource_rate WHERE resource_id = ANY($1::uuid[])', [ids])).rows : [];
  return rs.map((r) => ({
    id: r.id, kind: r.kind, maxUnits: r.max_units, ...(r.calendar_id ? { calendarId: r.calendar_id } : {}),
    rates: rates.filter((x) => x.resource_id === r.id).map((x) => ({ from: Date.parse(`${x.effective_from as string}T00:00:00Z`), stdPerHour: x.std_rate_per_hour, perUse: x.per_use_cost })),
  }));
}

export async function assignedTaskIds(c: PoolClient, projectId: string, userId: string): Promise<Set<string>> {
  const r = await c.query('SELECT a.task_id FROM assignment a JOIN resource r ON r.id = a.resource_id WHERE a.project_id = $1 AND r.user_id = $2', [projectId, userId]);
  return new Set(r.rows.map((x) => x.task_id));
}

/** Authorisation of the CONTENT of a command batch (route-level permission was already checked). */
export async function authorizeCommands(c: PoolClient, a: Access, cmds: Cmd[]): Promise<void> {
  let mine: Set<string> | undefined;
  for (const cmd of cmds) {
    const progressOnly = cmd.op === 'updateTask' && Object.keys(cmd.patch).every((k) => (PROGRESS_FIELDS as readonly string[]).includes(k));
    const need: Perm = progressOnly ? 'plan.progress' : 'plan.structure';
    if (!can(a.role, need)) throw new Problem('FORBIDDEN', `role ${a.role} may not issue ${cmd.op}${need === 'plan.progress' ? '' : ' (structure change)'}`);
    if (progressOnly && a.role === 'TEAM_MEMBER') {
      mine ??= await assignedTaskIds(c, a.projectId, a.userId);
      if (!mine.has((cmd as Extract<Cmd, { op: 'updateTask' }>).id)) throw new Problem('FORBIDDEN', 'team members may update progress only on tasks assigned to them');
    }
    const touchesCost = (cmd.op === 'updateTask' && 'fixedCost' in cmd.patch) || (cmd.op === 'addTask' && cmd.task.fixedCost !== undefined);
    if (touchesCost && !can(a.role, 'cost.read')) throw new Problem('FORBIDDEN', 'cost fields require a cost-visible role');
  }
}

export interface BatchBody { clientOpId: string; expectedPlanVersion: number; commands: Cmd[] }
export interface BatchOutcome { result: Record<string, unknown>; commit: () => void; replayed: boolean }

/**
 * THE write path. Within the caller's tenant transaction:
 * lock project -> idempotency -> version check -> authorise -> apply to model+engine (incremental) -> persist diff
 * -> bump version -> op log -> audit chain -> outbox. `commit()` must be called after COMMIT succeeded.
 */
export async function applyBatch(d: Deps, c: PoolClient, a: Access, body: BatchBody, action = 'plan.commands'): Promise<BatchOutcome> {
  const pr = (await c.query('SELECT plan_version, status FROM project WHERE id = $1 FOR UPDATE', [a.projectId])).rows[0];
  const bodyHash = createHash('sha256').update(canonical(body)).digest('hex');
  const prior = (await c.query('SELECT command FROM plan_op WHERE project_id = $1 AND client_op_id = $2', [a.projectId, body.clientOpId])).rows[0];
  if (prior) {
    if (prior.command.bodyHash !== bodyHash) throw new Problem('DUPLICATE_CLIENT_OP', 'clientOpId was already used with a different request body');
    return { result: { ...prior.command.response, replayed: true }, commit: () => {}, replayed: true };
  }
  if (pr.status === 'ARCHIVED') throw new Problem('FORBIDDEN', 'project is archived');
  if (pr.plan_version !== body.expectedPlanVersion)
    throw new Problem('VERSION_CONFLICT', `expected plan version ${body.expectedPlanVersion} but the plan is at ${pr.plan_version}`, { currentPlanVersion: pr.plan_version });
  if (body.commands.length > 1000) throw new Problem('PLAN_TOO_LARGE', 'at most 1000 commands per batch');
  await authorizeCommands(c, a, body.commands);

  const entry = await liveEntry(d, c, a.projectId);
  d.cache.evict(a.projectId);            // we own the entry until commit(); any failure leaves the cache empty -> rebuilt from the DB
  const { model, net } = entry;
  try {
    const rows: RowOp[] = [], edits = [];
    for (const cmd of body.commands) edits.push(...model.apply(cmd, rows));
    const stats = net.apply(edits);
    const res = net.result();
    const snap = snapshotOf(res);
    const changed = new Set<string>();
    for (const [id, k] of snap) if (entry.snapshot.get(id) !== k) changed.add(id);
    await persistRows(c, a.tenantId, a.projectId, model, rows);
    await writeSchedule(c, a.projectId, res, changed);
    const version = pr.plan_version + 1;
    await c.query('UPDATE project SET plan_version = $2, updated_at = now() WHERE id = $1', [a.projectId, version]);
    const result = {
      planVersion: version, schedule: scheduleApi(res, changed), changedTaskIds: [...changed],
      stats: { forwardVisited: stats.forwardVisited, backwardVisited: stats.backwardVisited, fullBackward: stats.fullBackward },
    };
    await c.query('INSERT INTO plan_op (project_id, seq, tenant_id, actor_id, client_op_id, command) VALUES ($1,$2,$3,$4,$5,$6::jsonb)',
      [a.projectId, version, a.tenantId, a.userId, body.clientOpId, JSON.stringify({ bodyHash, commands: body.commands, response: result })]);
    await audit(c, { tenantId: a.tenantId, actorId: a.userId, action, resource: 'project', resourceId: a.projectId, ip: a.ip,
      detail: { seq: version, ops: body.commands.map((x) => x.op), count: body.commands.length } });
    await c.query("INSERT INTO outbox (tenant_id, aggregate, aggregate_id, event_type, payload) VALUES ($1,'project',$2,'plan.changed',$3::jsonb)",
      [a.tenantId, a.projectId, JSON.stringify({ planVersion: version, changedTaskIds: [...changed].slice(0, 1000) })]);
    return {
      result, replayed: false,
      commit: () => {
        d.cache.set(a.projectId, { version, model, net, snapshot: snap });
        d.hub.broadcast(a.projectId, { type: 'plan.changed', projectId: a.projectId, planVersion: version, changedTaskIds: [...changed].slice(0, 1000) });
      },
    };
  } catch (e) {
    d.cache.evict(a.projectId);
    if (e instanceof ScheduleError) throw fromEngine(e);
    throw e;
  }
}

/** open a tenant tx, resolve the caller's user and role in the project (404 when not a member: existence is not disclosed) */
export async function inProject<T>(d: Deps, claims: { sub: string; tid: string }, projectId: string, perm: Perm | null, ip: string | null,
  fn: (c: PoolClient, a: Access) => Promise<T>): Promise<T> {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(projectId)) throw new Problem('NOT_FOUND', 'project not found');
  let denied: { userId: string } | null = null;
  try {
    return await tx(d.pool, claims.tid, async (c) => {
      const user = (await c.query('SELECT id FROM app_user WHERE oidc_subject = $1 AND is_active', [claims.sub])).rows[0];
      if (!user) throw new Problem('FORBIDDEN', 'no active user for this subject in the tenant');
      const role = (await c.query('SELECT role FROM project_member WHERE project_id = $1 AND user_id = $2', [projectId, user.id])).rows[0]?.role as Role | undefined;
      if (!role) throw new Problem('NOT_FOUND', 'project not found');
      if (perm && !can(role, perm)) { denied = { userId: user.id }; throw new Problem('FORBIDDEN', `role ${role} lacks permission ${perm}`); }
      return fn(c, { tenantId: claims.tid, userId: user.id, role, projectId, ip });
    });
  } catch (e) {
    if (denied && e instanceof Problem && e.code === 'FORBIDDEN') {
      const u = denied as { userId: string };
      try { await tx(d.pool, claims.tid, (c) => audit(c, { tenantId: claims.tid, actorId: u.userId, action: 'authz.denied', resource: 'project', resourceId: projectId, ip, detail: { perm } })); } catch { /* best effort */ }
    }
    throw e;
  }
}

export const newOpId = (): string => randomUUID();

// ---- risk-run bulkhead (docs/10 T12/T20): simulations run in worker threads; one per tenant, a small global cap
const riskRunning = new Map<string, number>();
let riskTotal = 0;
const RISK_GLOBAL_MAX = 2, RISK_TIMEOUT_MS = 120_000;
export async function runRisk<T>(tenantId: string, project: unknown, iterations: number, seed: number): Promise<T> {
  if ((riskRunning.get(tenantId) ?? 0) >= 1 || riskTotal >= RISK_GLOBAL_MAX)
    throw new Problem('RATE_LIMITED', 'a risk run is already in progress for this tenant (or the server is at capacity); retry shortly');
  riskRunning.set(tenantId, 1); riskTotal++;
  const { Worker } = await import('node:worker_threads');
  try {
    return await new Promise<T>((resolve, reject) => {
      const w = new Worker(new URL('./riskworker.ts', import.meta.url), { workerData: { project, iterations, seed } });
      const timer = setTimeout(() => { void w.terminate(); reject(new Problem('DEPENDENCY_UNAVAILABLE', 'risk run timed out')); }, RISK_TIMEOUT_MS);
      w.once('message', (m) => { clearTimeout(timer); resolve(m as T); });
      w.once('error', (e) => { clearTimeout(timer); reject(e); });
      w.once('exit', (code) => { clearTimeout(timer); if (code !== 0) reject(new Problem('INTERNAL')); });
    });
  } finally { riskRunning.delete(tenantId); riskTotal--; }
}
