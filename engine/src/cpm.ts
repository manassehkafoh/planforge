import { WorkCalendar } from './calendar.ts';
import {
  ScheduleError,
  type Conflict, type DepType, type LinkIn, type ProjectIn, type ScheduleResult, type TaskIn, type TaskOut,
} from './types.ts';

interface Edge { other: string; type: DepType; lag: number }

/**
 * Deterministic Critical Path Method over a precedence diagram.
 *   1. validate + build graph (summary tasks are derived from hierarchy, never linked)
 *   2. topological order (Kahn) - cycles are reported with an explicit path
 *   3. forward pass  -> early dates, constraint conflicts
 *   4. backward pass -> late dates against project finish (or earlier deadline)
 *   5. float, critical flag, ALAP placement, summary roll-up
 * Complexity O(V+E) plus calendar arithmetic (O(days spanned) per date operation, memoised).
 */
export function schedule(p: ProjectIn): ScheduleResult {
  const cals = new Map<string, WorkCalendar>();
  const projCal = new WorkCalendar(p.calendar);
  cals.set(p.calendar.id, projCal);
  for (const c of p.calendars ?? []) cals.set(c.id, new WorkCalendar(c));
  const calOf = (t: TaskIn): WorkCalendar => {
    if (!t.calendarId) return projCal;
    const c = cals.get(t.calendarId);
    if (!c) throw new ScheduleError('BAD_INPUT', `unknown calendar ${t.calendarId} on task ${t.id}`);
    return c;
  };

  // ---- 1. validate -------------------------------------------------------------------------
  const byId = new Map<string, TaskIn>();
  for (const t of p.tasks) {
    if (byId.has(t.id)) throw new ScheduleError('DUPLICATE_ID', `duplicate task id ${t.id}`);
    if (!Number.isInteger(t.durationMin) || t.durationMin < 0)
      throw new ScheduleError('BAD_INPUT', `task ${t.id}: durationMin must be a non-negative integer`);
    if (t.constraint && t.constraint.type !== 'ASAP' && t.constraint.type !== 'ALAP' && t.constraint.date === undefined)
      throw new ScheduleError('BAD_INPUT', `task ${t.id}: constraint ${t.constraint.type} requires a date`);
    byId.set(t.id, t);
  }
  const children = new Map<string, string[]>();
  for (const t of p.tasks) {
    if (t.parentId) {
      if (!byId.has(t.parentId)) throw new ScheduleError('UNKNOWN_TASK', `task ${t.id}: unknown parent ${t.parentId}`);
      (children.get(t.parentId) ?? children.set(t.parentId, []).get(t.parentId)!).push(t.id);
    }
  }
  const isSummary = (id: string) => children.has(id);
  const preds = new Map<string, Edge[]>(), succs = new Map<string, Edge[]>();
  for (const t of p.tasks) if (!isSummary(t.id)) { preds.set(t.id, []); succs.set(t.id, []); }
  for (const l of p.links as LinkIn[]) {
    for (const end of [l.pred, l.succ]) {
      if (!byId.has(end)) throw new ScheduleError('UNKNOWN_TASK', `link references unknown task ${end}`);
      if (isSummary(end)) throw new ScheduleError('LINK_TO_SUMMARY', `link end ${end} is a summary task`);
    }
    const type = l.type ?? 'FS', lag = l.lagMin ?? 0;
    preds.get(l.succ)!.push({ other: l.pred, type, lag });
    succs.get(l.pred)!.push({ other: l.succ, type, lag });
  }

  // ---- 2. topological order ----------------------------------------------------------------
  const leaves = [...preds.keys()];
  const indeg = new Map(leaves.map((id) => [id, preds.get(id)!.length]));
  const queue = leaves.filter((id) => indeg.get(id) === 0);
  const order: string[] = [];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    order.push(id);
    for (const e of succs.get(id)!) {
      const n = indeg.get(e.other)! - 1;
      indeg.set(e.other, n);
      if (n === 0) queue.push(e.other);
    }
  }
  if (order.length !== leaves.length) {
    const stuck = new Set(leaves.filter((id) => indeg.get(id)! > 0));
    throw new ScheduleError('CYCLE', 'dependency cycle detected', { path: findCycle(stuck, succs) });
  }

  // ---- 3. forward pass ---------------------------------------------------------------------
  const conflicts: Conflict[] = [];
  const es = new Map<string, number>(), ef = new Map<string, number>();
  for (const id of order) {
    const t = byId.get(id)!, cal = calOf(t), d = t.durationMin, c = t.constraint;
    let start = p.startDate;
    let reqFinish = -Infinity;
    for (const e of preds.get(id)!) {
      const pe = ef.get(e.other)!, ps = es.get(e.other)!;
      switch (e.type) {
        case 'FS': start = Math.max(start, projCal.shift(pe, e.lag)); break;
        case 'SS': start = Math.max(start, projCal.shift(ps, e.lag)); break;
        case 'FF': reqFinish = Math.max(reqFinish, projCal.shift(pe, e.lag)); break;
        case 'SF': reqFinish = Math.max(reqFinish, projCal.shift(ps, e.lag)); break;
      }
    }
    if (c?.type === 'SNET' || c?.type === 'MSO') start = Math.max(start, c.date!);
    if (c?.type === 'FNET' || c?.type === 'MFO') reqFinish = Math.max(reqFinish, c.date!);
    const depStart = start;
    if (reqFinish > -Infinity) {
      const s = d > 0 ? cal.subWork(cal.prevWorkEnd(reqFinish), d) : cal.prevWorkEnd(reqFinish);
      start = Math.max(start, s);
    }
    start = snapStart(cal, start, d);
    if (c?.type === 'MSO') {
      if (start > c.date!) conflicts.push({ taskId: id, code: 'MSO_VIOLATED', detail: 'predecessors push start past the fixed date' });
      start = snapStart(cal, c.date!, d); // hard constraint wins, conflict is reported
    }
    let fin = d > 0 ? cal.addWork(start, d) : start;
    if (c?.type === 'MFO') {
      if (fin > c.date!) conflicts.push({ taskId: id, code: 'MFO_VIOLATED', detail: 'predecessors push finish past the fixed date' });
      fin = cal.prevWorkEnd(c.date!);
      start = d > 0 ? cal.subWork(fin, d) : fin;
    }
    if (c?.type === 'SNLT' && start > c.date!) conflicts.push({ taskId: id, code: 'SNLT_VIOLATED', detail: 'start later than limit' });
    if (c?.type === 'FNLT' && fin > c.date!) conflicts.push({ taskId: id, code: 'FNLT_VIOLATED', detail: 'finish later than limit' });
    es.set(id, start); ef.set(id, fin);
    void depStart;
  }
  const projectFinish = leaves.length ? Math.max(...leaves.map((i) => ef.get(i)!)) : p.startDate;
  const projectStart = leaves.length ? Math.min(...leaves.map((i) => es.get(i)!)) : p.startDate;
  const limit = p.deadline !== undefined ? Math.min(projectFinish, p.deadline) : projectFinish;
  if (p.deadline !== undefined)
    for (const id of leaves) if (ef.get(id)! > p.deadline)
      conflicts.push({ taskId: id, code: 'DEADLINE_MISSED', detail: `finishes after project deadline` });

  // ---- 4. backward pass --------------------------------------------------------------------
  const ls = new Map<string, number>(), lf = new Map<string, number>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i], t = byId.get(id)!, cal = calOf(t), d = t.durationMin, c = t.constraint;
    let capF = limit; // every task is bounded by project finish (or earlier deadline), even with successors
    for (const e of succs.get(id)!) {
      const sLs = ls.get(e.other)!, sLf = lf.get(e.other)!;
      switch (e.type) {
        case 'FS': capF = Math.min(capF, projCal.prevWorkEnd(projCal.shift(sLs, -e.lag))); break;
        case 'FF': capF = Math.min(capF, projCal.prevWorkEnd(projCal.shift(sLf, -e.lag))); break;
        case 'SS': capF = Math.min(capF, finishForLatestStart(cal, projCal.shift(sLs, -e.lag), d)); break;
        case 'SF': capF = Math.min(capF, finishForLatestStart(cal, projCal.shift(sLf, -e.lag), d)); break;
      }
    }
    if (c?.type === 'FNLT' || c?.type === 'MFO') capF = Math.min(capF, c.date!);
    if (c?.type === 'SNLT') capF = Math.min(capF, finishForLatestStart(cal, c.date!, d));
    let late = cal.prevWorkEnd(capF);
    if (c?.type === 'MSO' || c?.type === 'MFO') late = ef.get(id)!; // hard-pinned: zero float by definition
    lf.set(id, late);
    ls.set(id, c?.type === 'MSO' || c?.type === 'MFO' ? es.get(id)! : d > 0 ? cal.subWork(late, d) : late);
  }

  // ---- 5. float, ALAP, outputs -------------------------------------------------------------
  const out: Record<string, TaskOut> = {};
  for (const id of leaves) {
    const t = byId.get(id)!, cal = calOf(t);
    const tf = cal.workBetween(es.get(id)!, ls.get(id)!);
    // Canonicalise: an instant such as Fri 17:00 and the following Mon 08:00 are the same point on the
    // working-time axis. When float is zero the late dates ARE the early dates (matters for milestones).
    if (tf === 0) { ls.set(id, es.get(id)!); lf.set(id, ef.get(id)!); }
    let ff = succs.get(id)!.length === 0 ? projCal.workBetween(ef.get(id)!, projectFinish) : Infinity;
    for (const e of succs.get(id)!) {
      const s = e.other;
      const slack =
        e.type === 'FS' ? projCal.workBetween(projCal.shift(ef.get(id)!, e.lag), es.get(s)!) :
        e.type === 'SS' ? projCal.workBetween(projCal.shift(es.get(id)!, e.lag), es.get(s)!) :
        e.type === 'FF' ? projCal.workBetween(projCal.shift(ef.get(id)!, e.lag), ef.get(s)!) :
                          projCal.workBetween(projCal.shift(es.get(id)!, e.lag), ef.get(s)!);
      ff = Math.min(ff, slack);
    }
    ff = Math.min(Math.max(ff, Math.min(0, tf)), tf);
    let a = es.get(id)!, b = ef.get(id)!;
    if (t.constraint?.type === 'ALAP') { a = ls.get(id)!; b = lf.get(id)!; }
    out[id] = { id, isSummary: false, es: a, ef: b, ls: ls.get(id)!, lf: lf.get(id)!, totalFloatMin: tf, freeFloatMin: ff, critical: tf <= 0 };
  }
  const rollup = (id: string): TaskOut => {
    const kids = children.get(id);
    if (!kids) return out[id];
    const ks = kids.map(rollup);
    const r: TaskOut = {
      id, isSummary: true,
      es: Math.min(...ks.map((k) => k.es)), ef: Math.max(...ks.map((k) => k.ef)),
      ls: Math.min(...ks.map((k) => k.ls)), lf: Math.max(...ks.map((k) => k.lf)),
      totalFloatMin: Math.min(...ks.map((k) => k.totalFloatMin)),
      freeFloatMin: Math.min(...ks.map((k) => k.freeFloatMin)),
      critical: ks.some((k) => k.critical),
    };
    out[id] = r;
    return r;
  };
  for (const t of p.tasks) rollup(t.id);

  const criticalPath = leaves
    .filter((id) => out[id].critical)
    .sort((x, y) => out[x].es - out[y].es || out[x].ef - out[y].ef);
  return { start: projectStart, finish: projectFinish, tasks: out, criticalPath, conflicts };
}

function snapStart(cal: WorkCalendar, t: number, d: number): number {
  if (d > 0) return cal.nextWorkStart(t);
  return cal.prevWorkEnd(t) === t ? t : cal.nextWorkStart(t); // milestone may sit on a range end
}

function finishForLatestStart(cal: WorkCalendar, latestStart: number, d: number): number {
  if (d === 0) return cal.prevWorkEnd(latestStart);
  return cal.addWork(cal.latestStartAtOrBefore(latestStart), d);
}

function findCycle(stuck: Set<string>, succs: Map<string, Edge[]>): string[] {
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const dfs = (u: string): string[] | null => {
    state.set(u, 1); stack.push(u);
    for (const e of succs.get(u)!) {
      if (!stuck.has(e.other)) continue;
      if (state.get(e.other) === 1) return [...stack.slice(stack.indexOf(e.other)), e.other];
      if (!state.has(e.other)) { const r = dfs(e.other); if (r) return r; }
    }
    stack.pop(); state.set(u, 2);
    return null;
  };
  for (const s of stuck) if (!state.has(s)) { const r = dfs(s); if (r) return r; }
  return [];
}
