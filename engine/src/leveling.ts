import { Network } from './network.ts';
import type { WorkCalendar } from './calendar.ts';
import { applyResourceRules, groupByTask } from './resources.ts';
import type { ProjectIn, TaskIn } from './types.ts';

/**
 * Serial resource levelling (deterministic).
 *
 * Repeatedly: find the EARLIEST instant at which some resource is over-allocated (sum of units of tasks working at
 * that instant > maxUnits); among the tasks working then, pick the one to delay by the sort key below; delay it
 * until the earliest-finishing competing task has ended (levelingDelayMin on the task); re-derive dates
 * INCREMENTALLY via Network.apply(). Each step strictly moves one start later, so the loop terminates; an
 * iteration cap is a second guard.
 *
 * Never delayed: priority 1000, completed or started tasks, manual tasks, MSO/MFO-pinned tasks.
 * Resource-level conflicts that cannot be resolved by delaying are reported, not hidden.
 */
export type LevelOrder = 'PRIORITY_FLOAT' | 'START' | 'ID';

export interface LevelOptions {
  order?: LevelOrder;
  /** only delay a task within its total float, so the project finish cannot move because of levelling */
  withinFloatOnly?: boolean;
  /** drop previous levelling delays first (default true) */
  clearFirst?: boolean;
  maxIterations?: number;
}

export interface LevelStep { taskId: string; resourceId: string; at: number; addedDelayMin: number; totalDelayMin: number }
export interface Unresolved { resourceId: string; at: number; load: number; maxUnits: number; taskIds: string[]; reason: 'NO_MOVABLE_TASK' | 'WOULD_EXCEED_FLOAT' | 'ITERATION_LIMIT' }
export interface LevelReport {
  steps: LevelStep[];
  unresolved: Unresolved[];
  delays: { taskId: string; delayMin: number }[];
  finishBefore: number; finishAfter: number;
  iterations: number;
  /** false when maxIterations was hit: the plan is NOT fully levelled */
  converged: boolean;
  incrementalVisits: number;
}

interface Seg { s: number; e: number; u: number; taskId: string }

export function levelResources(input: ProjectIn, opts: LevelOptions = {}): { project: ProjectIn; report: LevelReport; network: Network } {
  const order = opts.order ?? 'PRIORITY_FLOAT';
  const base = applyResourceRules(input);
  const start: ProjectIn = opts.clearFirst === false ? base : { ...base, tasks: base.tasks.map((t) => stripDelay(t)) };
  const net = new Network(start);
  const by = groupByTask(start);
  const res = new Map((start.resources ?? []).map((r) => [r.id, r]));
  const taskMap = new Map(start.tasks.map((t) => [t.id, t]));
  const cap = opts.maxIterations ?? Math.max(1000, start.tasks.length * 50);
  const report: LevelReport = { steps: [], unresolved: [], delays: [], finishBefore: net.result().finish, finishAfter: 0, iterations: 0, converged: true, incrementalVisits: 0 };
  const skip = new Set<string>(); // resource + contending task set already reported as unresolvable
  const blockKey = (rid: string, segs: Seg[]) => `${rid}|${[...new Set(segs.map((g) => g.taskId))].sort().join(',')}`;
  const stuck = new Set<string>(); // tasks whose delay had no effect

  const segsBetween = (cal: WorkCalendar, es: number, ef: number, u: number, taskId: string): Seg[] => {
    const segs: Seg[] = [];
    if (ef <= es) return segs;
    for (let d = Math.floor(es / 86_400_000) * 86_400_000; d < ef; d += 86_400_000)
      for (const r of cal.rangesOn(d)) {
        const s = Math.max(es, d + r.startMin * 60_000), e = Math.min(ef, d + r.endMin * 60_000);
        if (e > s) segs.push({ s, e, u, taskId });
      }
    return segs;
  };
  const segmentsOf = (taskId: string, u: number): Seg[] => {
    const n = net.node(taskId);
    return segsBetween(net.calendarOf(taskId), n.es, n.ef, u, taskId);
  };
  /** would `mine` fit beside `others` without exceeding `max` at any instant? */
  const fits = (others: Seg[], mine: Seg[], max: number): boolean => {
    for (const m of mine) {
      const ev: { t: number; d: number }[] = [];
      for (const g of others) if (g.s < m.e && g.e > m.s) ev.push({ t: Math.max(g.s, m.s), d: g.u }, { t: Math.min(g.e, m.e), d: -g.u });
      ev.sort((a, b) => a.t - b.t || a.d - b.d);
      let load = 0;
      for (let i = 0; i < ev.length;) {
        const t = ev[i].t;
        while (i < ev.length && ev[i].t === t) load += ev[i++].d;
        if (load + m.u > max + 1e-9 && t < m.e) return false;
      }
    }
    return true;
  };

  // per-resource assignments, and a cache of each resource's earliest overload; only resources whose tasks moved are re-scanned
  const asgOfRes = new Map<string, { taskId: string; units: number }[]>();
  for (const [taskId, asg] of by) {
    if (stateOf(taskMap.get(taskId)!) === 'DONE') continue;
    for (const a of asg) {
      if ((res.get(a.resourceId)!.kind ?? 'WORK') !== 'WORK') continue;
      (asgOfRes.get(a.resourceId) ?? asgOfRes.set(a.resourceId, []).get(a.resourceId)!).push({ taskId, units: a.units ?? 1 });
    }
  }
  const resOfTask = new Map<string, string[]>();
  for (const [rid, list] of asgOfRes) for (const x of list) (resOfTask.get(x.taskId) ?? resOfTask.set(x.taskId, []).get(x.taskId)!).push(rid);
  type Ovl = { resourceId: string; at: number; load: number; segs: Seg[]; all: Seg[] } | null;
  const cache = new Map<string, Ovl>();
  const dirty = new Set<string>(asgOfRes.keys());

  const scan = (rid: string): Ovl => {
    const segs: Seg[] = [];
    for (const x of asgOfRes.get(rid)!) segs.push(...segmentsOf(x.taskId, x.units));
    const max = res.get(rid)!.maxUnits ?? 1;
    const ev: { t: number; d: number }[] = [];
    for (const g of segs) ev.push({ t: g.s, d: g.u }, { t: g.e, d: -g.u });
    ev.sort((a, b) => a.t - b.t || a.d - b.d); // ends before starts at the same instant
    let load = 0;
    for (let i = 0; i < ev.length;) {
      const t = ev[i].t;
      while (i < ev.length && ev[i].t === t) load += ev[i++].d;
      if (load > max + 1e-9) {
        const here = segs.filter((g) => g.s <= t && t < g.e);
        if (skip.has(blockKey(rid, here))) continue; // same contenders already reported as unresolvable
        return { resourceId: rid, at: t, load, segs: here, all: segs };
      }
    }
    return null;
  };
  const findOverload = (): Ovl => {
    for (const rid of dirty) cache.set(rid, scan(rid));
    dirty.clear();
    let best: Ovl = null;
    for (const [rid, o] of cache) if (o && (!best || o.at < best.at || (o.at === best.at && rid < best.resourceId))) best = o;
    return best;
  };
  const markMoved = (ids: string[]) => { for (const id of ids) for (const rid of resOfTask.get(id) ?? []) dirty.add(rid); };

  let iter = 0;
  for (; iter < cap; iter++) {
    const o = findOverload();
    if (!o) break;
    const max = res.get(o.resourceId)!.maxUnits ?? 1;
    const active = [...new Set(o.segs.map((g) => g.taskId))];
    const movable = active.filter((id) => {
      const t = taskMap.get(id)!;
      return (t.priority ?? 500) < 1000 && stateOf(t) === 'OPEN' && t.mode !== 'MANUAL'
        && t.constraint?.type !== 'MSO' && t.constraint?.type !== 'MFO' && !stuck.has(id)
        // delaying a predecessor of a contender would drag the contender along and never resolve the overload
        && !active.some((other) => other !== id && net.reaches(id, other));
    });
    const unresolved = (reason: Unresolved['reason']) => {
      skip.add(blockKey(o.resourceId, o.segs)); dirty.add(o.resourceId);
      report.unresolved.push({ resourceId: o.resourceId, at: o.at, load: o.load, maxUnits: max, taskIds: active, reason });
    };
    if (!movable.length) { unresolved('NO_MOVABLE_TASK'); continue; }

    const key = (id: string) => {
      const t = taskMap.get(id)!, x = net.taskRow(id);
      return { pr: t.priority ?? 500, fl: x.totalFloatMin, es: x.es, id };
    };
    movable.sort((a, b) => {
      const A = key(a), B = key(b);
      if (order === 'ID') return A.id < B.id ? -1 : 1;
      if (order === 'START') return B.es - A.es || (A.id < B.id ? -1 : 1);
      return A.pr - B.pr || B.fl - A.fl || B.es - A.es || (A.id < B.id ? -1 : 1);
    });
    let chosen: string | undefined, delayTo = 0;
    for (const id of movable) {
      // first fit: hop to the earliest end-of-another-task at which this task fits beside everything else on the resource
      const rid = o.resourceId, cal = net.calendarOf(id), cur = net.node(id).es, d = taskMap.get(id)!.durationMin;
      const mine = o.all.find((g) => g.taskId === id);
      const u = mine ? mine.u : 1;
      const rest = o.all.filter((g) => g.taskId !== id);
      const ends = [...new Set(rest.map((g) => net.node(g.taskId).ef))].filter((e) => e > cur).sort((a, b) => a - b);
      let target = 0;
      for (const e of ends) {
        const es2 = cal.nextWorkStart(e), ef2 = d > 0 ? cal.addWork(es2, d) : es2;
        target = es2;
        if (fits(rest, segsBetween(cal, es2, ef2, u, id), max)) break;
      }
      if (!target) continue;
      const added = net.projectCalendar().workBetween(cur, target);
      if (added <= 0) continue;
      void rid;
      if (opts.withinFloatOnly && added > net.taskRow(id).totalFloatMin) continue;
      chosen = id; delayTo = added; break;
    }
    if (!chosen) { unresolved(opts.withinFloatOnly ? 'WOULD_EXCEED_FLOAT' : 'NO_MOVABLE_TASK'); continue; }

    const t = taskMap.get(chosen)!;
    const total = (t.levelingDelayMin ?? 0) + delayTo;
    const before = net.node(chosen).es;
    const upd: TaskIn = { ...t, levelingDelayMin: total };
    taskMap.set(chosen, upd);
    const st = net.apply({ op: 'setTask', id: chosen, patch: { levelingDelayMin: total } });
    report.incrementalVisits += st.forwardVisited + st.backwardVisited;
    markMoved(st.changed);
    if (net.node(chosen).es <= before) { // the delay did not move the task (e.g. a binding constraint): undo and exclude it
      stuck.add(chosen); taskMap.set(chosen, t);
      markMoved(net.apply({ op: 'setTask', id: chosen, patch: { levelingDelayMin: t.levelingDelayMin ?? 0 } }).changed);
      continue;
    }
    report.steps.push({ taskId: chosen, resourceId: o.resourceId, at: o.at, addedDelayMin: delayTo, totalDelayMin: total });
  }
  report.iterations = iter;
  if (iter >= cap) {
    report.converged = false;
    const o = findOverload();
    if (o) report.unresolved.push({ resourceId: o.resourceId, at: o.at, load: o.load, maxUnits: res.get(o.resourceId)!.maxUnits ?? 1, taskIds: [...new Set(o.segs.map((g) => g.taskId))], reason: 'ITERATION_LIMIT' });
  }

  const finalProject = net.toProject();
  report.delays = finalProject.tasks.filter((t) => (t.levelingDelayMin ?? 0) > 0).map((t) => ({ taskId: t.id, delayMin: t.levelingDelayMin! }));
  report.finishAfter = net.result().finish;
  return { project: finalProject, report, network: net };
}

function stripDelay(t: TaskIn): TaskIn {
  if (t.levelingDelayMin === undefined) return t;
  const { levelingDelayMin: _omit, ...rest } = t; void _omit;
  return rest;
}
function stateOf(t: TaskIn): 'OPEN' | 'PROGRESS' | 'DONE' {
  if (t.actualFinish !== undefined || (t.percentComplete ?? 0) >= 1) return 'DONE';
  if ((t.percentComplete ?? 0) > 0 || t.actualStart !== undefined) return 'PROGRESS';
  return 'OPEN';
}
