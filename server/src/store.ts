import type { PoolClient } from 'pg';
import { Network, type CalendarDef, type ScheduleResult, type TimeRange } from '../../engine/src/index.ts';
import { Problem } from './errors.ts';
import { PlanModel, fromMs, toMs, type LinkRec, type RowOp, type TaskRec } from './model.ts';

const iso = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : fromMs(ms));

export async function loadModel(c: PoolClient, projectId: string): Promise<{ model: PlanModel; version: number; status: string; name: string }> {
  const pr = (await c.query('SELECT * FROM project WHERE id = $1', [projectId])).rows[0];
  if (!pr) throw new Problem('NOT_FOUND', 'project not found');
  const model = new PlanModel({
    id: pr.id, startDate: pr.start_local, calendarId: pr.calendar_id, nearCriticalMin: pr.near_critical_min,
    ...(pr.deadline_local !== null ? { deadline: pr.deadline_local } : {}), ...(pr.status_date_local !== null ? { statusDate: pr.status_date_local } : {}),
  });
  const cals = (await c.query('SELECT id, base_id, week FROM calendar')).rows;
  const exc = (await c.query("SELECT calendar_id, to_char(day, 'YYYY-MM-DD') AS day, ranges FROM calendar_exception")).rows;
  for (const r of cals) {
    const d: CalendarDef = { id: r.id, week: r.week as (TimeRange[] | null)[] };
    if (r.base_id) d.baseId = r.base_id;
    const ex = exc.filter((e) => e.calendar_id === r.id);
    if (ex.length) d.exceptions = Object.fromEntries(ex.map((e) => [e.day, e.ranges as TimeRange[]]));
    model.calendars.push(d);
  }
  for (const r of (await c.query('SELECT * FROM task WHERE project_id = $1', [projectId])).rows) model.tasks.set(r.id, rowToTask(r));
  for (const r of (await c.query('SELECT * FROM task_link WHERE project_id = $1', [projectId])).rows)
    model.links.set(r.id, { id: r.id, pred: r.pred_id, succ: r.succ_id, type: r.type, lagMin: r.lag_min, lagBasis: r.lag_basis });
  for (const r of (await c.query('SELECT * FROM assignment WHERE project_id = $1', [projectId])).rows)
    model.asg.set(r.id, { id: r.id, taskId: r.task_id, resourceId: r.resource_id, units: r.units });
  for (const r of (await c.query('SELECT id FROM resource')).rows) model.resourceIds.add(r.id);
  return { model, version: pr.plan_version, status: pr.status, name: pr.name };
}

function rowToTask(r: Record<string, any>): TaskRec { // eslint-disable-line @typescript-eslint/no-explicit-any
  const t: TaskRec = { id: r.id, name: r.name, durationMin: r.duration_min, sortKey: r.sort_key, parentId: r.parent_id };
  if (r.notes !== null) t.notes = r.notes;
  if (r.mode !== 'AUTO') t.mode = r.mode;
  if (r.kind !== 'FIXED_UNITS') t.kind = r.kind;
  if (r.effort_driven) t.effortDriven = true;
  if (r.constraint_type !== 'ASAP') t.constraint = r.constraint_local !== null ? { type: r.constraint_type, date: r.constraint_local } : { type: r.constraint_type };
  if (r.calendar_id) t.calendarId = r.calendar_id;
  if (r.percent_complete > 0) t.percentComplete = r.percent_complete;
  if (r.actual_start_local !== null) t.actualStart = r.actual_start_local;
  if (r.actual_finish_local !== null) t.actualFinish = r.actual_finish_local;
  if (r.manual_start_local !== null) t.manualStart = r.manual_start_local;
  if (r.manual_finish_local !== null) t.manualFinish = r.manual_finish_local;
  if (r.priority !== 500) t.priority = r.priority;
  if (r.fixed_cost > 0) t.fixedCost = r.fixed_cost;
  if (r.work_min !== null) t.workMin = r.work_min;
  if (r.leveling_delay_min > 0) t.levelingDelayMin = r.leveling_delay_min;
  if (r.est_likely_min !== null) t.estimate = { optimistic: r.est_optimistic_min, mostLikely: r.est_likely_min, pessimistic: r.est_pessimistic_min };
  if (r.custom && Object.keys(r.custom).length) t.custom = r.custom;
  return t;
}

const TASK_COLS = ['parent_id', 'sort_key', 'name', 'notes', 'duration_min', 'mode', 'kind', 'effort_driven', 'constraint_type', 'constraint_local', 'calendar_id',
  'percent_complete', 'actual_start_local', 'actual_finish_local', 'manual_start_local', 'manual_finish_local', 'priority', 'fixed_cost', 'work_min',
  'leveling_delay_min', 'est_optimistic_min', 'est_likely_min', 'est_pessimistic_min', 'custom'] as const;

function taskValues(t: TaskRec): unknown[] {
  return [t.parentId ?? null, t.sortKey, t.name, t.notes ?? null, t.durationMin, t.mode ?? 'AUTO', t.kind ?? 'FIXED_UNITS', t.effortDriven ?? false,
    t.constraint?.type ?? 'ASAP', iso(t.constraint?.date), t.calendarId ?? null, t.percentComplete ?? 0, iso(t.actualStart), iso(t.actualFinish),
    iso(t.manualStart), iso(t.manualFinish), t.priority ?? 500, t.fixedCost ?? 0, t.workMin ?? null, t.levelingDelayMin ?? 0,
    t.estimate?.optimistic ?? null, t.estimate?.mostLikely ?? null, t.estimate?.pessimistic ?? null, JSON.stringify(t.custom ?? {})];
}

export async function persistRows(c: PoolClient, tenantId: string, projectId: string, model: PlanModel, rows: RowOp[]): Promise<void> {
  const seenUpdate = new Set<string>();
  const insertedTasks = new Set<string>();
  const deletedTasks = new Set<string>();
  for (const r of rows) {
    switch (r.t) {
      case 'task.insert': {
        const v = taskValues(r.rec); v[0] = null;      // parents are attached after all inserts (FK order independent of command order)
        await c.query(`INSERT INTO task (id, tenant_id, project_id, ${TASK_COLS.join(', ')}) VALUES ($1, $2, $3, ${TASK_COLS.map((_, i) => `$${i + 4}`).join(', ')})`, [r.rec.id, tenantId, projectId, ...v]);
        insertedTasks.add(r.rec.id); break;
      }
      case 'task.update': {
        if (insertedTasks.has(r.id) || deletedTasks.has(r.id)) break;     // inserted this batch with its final values, or already deleted
        const cur = model.tasks.get(r.id);
        if (!cur) break;
        const key = r.id; if (seenUpdate.has(key)) break; seenUpdate.add(key);
        await c.query(`UPDATE task SET ${TASK_COLS.map((k, i) => `${k} = $${i + 3}`).join(', ')}, version = version + 1, updated_at = now() WHERE id = $1 AND project_id = $2`, [r.id, projectId, ...taskValues(cur)]);
        break;
      }
      case 'task.delete': deletedTasks.add(r.id); await c.query('DELETE FROM task WHERE id = $1 AND project_id = $2', [r.id, projectId]); break;
      case 'link.insert': await c.query('INSERT INTO task_link (id, tenant_id, project_id, pred_id, succ_id, type, lag_min, lag_basis) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [r.rec.id, tenantId, projectId, r.rec.pred, r.rec.succ, r.rec.type, r.rec.lagMin, r.rec.lagBasis]); break;
      case 'link.update': await c.query('UPDATE task_link SET type = $3, lag_min = $4, lag_basis = $5 WHERE id = $1 AND project_id = $2', [r.rec.id, projectId, r.rec.type, r.rec.lagMin, r.rec.lagBasis]); break;
      case 'link.delete': await c.query('DELETE FROM task_link WHERE id = $1 AND project_id = $2', [r.id, projectId]); break;
      case 'asg.insert': await c.query('INSERT INTO assignment (id, tenant_id, project_id, task_id, resource_id, units) VALUES ($1,$2,$3,$4,$5,$6)', [r.rec.id, tenantId, projectId, r.rec.taskId, r.rec.resourceId, r.rec.units ?? 1]); break;
      case 'asg.update': await c.query('UPDATE assignment SET units = $3 WHERE id = $1 AND project_id = $2', [r.rec.id, projectId, r.rec.units ?? 1]); break;
      case 'asg.delete': await c.query('DELETE FROM assignment WHERE id = $1 AND project_id = $2', [r.id, projectId]); break;
      case 'project.update': {
        const p = model.project;
        await c.query('UPDATE project SET start_local = $2, deadline_local = $3, status_date_local = $4, near_critical_min = $5 WHERE id = $1', [projectId, iso(p.startDate), iso(p.deadline), iso(p.statusDate), p.nearCriticalMin]);
        break;
      }
    }
  }
  for (const id of insertedTasks) {
    const t = model.tasks.get(id);
    if (t?.parentId) await c.query('UPDATE task SET parent_id = $2 WHERE id = $1 AND project_id = $3', [id, t.parentId, projectId]);
  }
}

/** Serialise one task's derived output so unchanged rows are not rewritten. */
export function outKey(o: ScheduleResult['tasks'][string], driver: unknown): string {
  return `${o.es}|${o.ef}|${o.ls}|${o.lf}|${o.totalFloatMin}|${o.freeFloatMin}|${o.critical}|${o.nearCritical}|${o.state}|${o.isSummary}|${JSON.stringify(driver ?? null)}`;
}

export async function writeSchedule(c: PoolClient, projectId: string, res: ScheduleResult, only: Set<string>): Promise<void> {
  const ids: string[] = [], es: (string | null)[] = [], ef: (string | null)[] = [], ls: (string | null)[] = [], lf: (string | null)[] = [];
  const tf: number[] = [], ff: number[] = [], cr: boolean[] = [], nc: boolean[] = [], st: string[] = [], sm: boolean[] = [], dr: (string | null)[] = [];
  for (const id of only) {
    const o = res.tasks[id];
    if (!o) continue;
    ids.push(id); es.push(iso(o.es)); ef.push(iso(o.ef)); ls.push(iso(o.ls)); lf.push(iso(o.lf));
    tf.push(Math.round(o.totalFloatMin)); ff.push(Math.round(Math.min(o.freeFloatMin, 2_000_000_000))); cr.push(o.critical); nc.push(o.nearCritical); st.push(o.state); sm.push(o.isSummary);
    dr.push(res.drivers[id] ? JSON.stringify(res.drivers[id]) : null);
  }
  if (!ids.length) return;
  await c.query(
    `UPDATE task t SET es_local = v.es, ef_local = v.ef, ls_local = v.ls, lf_local = v.lf, total_float_min = v.tf, free_float_min = v.ff,
            is_critical = v.cr, is_near_critical = v.nc, state = v.st, is_summary = v.sm, driver = v.dr::jsonb
       FROM UNNEST($2::uuid[], $3::timestamp[], $4::timestamp[], $5::timestamp[], $6::timestamp[], $7::int[], $8::int[], $9::bool[], $10::bool[], $11::text[], $12::bool[], $13::text[])
            AS v(id, es, ef, ls, lf, tf, ff, cr, nc, st, sm, dr)
      WHERE t.id = v.id AND t.project_id = $1`,
    [projectId, ids, es, ef, ls, lf, tf, ff, cr, nc, st, sm, dr]);
}

/** In-process cache of live networks. A miss, or a version mismatch, rebuilds from the database (the source of truth). */
export interface CacheEntry { version: number; model: PlanModel; net: Network; snapshot: Map<string, string> }
export class PlanCache {
  private m = new Map<string, CacheEntry>();
  private max: number;
  constructor(max = 64) { this.max = max; }
  get(id: string, version: number): CacheEntry | undefined { const e = this.m.get(id); return e && e.version === version ? e : undefined; }
  set(id: string, e: CacheEntry) { this.m.delete(id); this.m.set(id, e); if (this.m.size > this.max) this.m.delete(this.m.keys().next().value as string); }
  evict(id: string) { this.m.delete(id); }
  clear() { this.m.clear(); }
}

export function snapshotOf(res: ScheduleResult): Map<string, string> {
  const m = new Map<string, string>();
  for (const [id, o] of Object.entries(res.tasks)) m.set(id, outKey(o, res.drivers[id]));
  return m;
}
export { toMs };
export type { LinkRec };
