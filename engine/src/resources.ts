import type { WorkCalendar } from './calendar.ts';
import { resolveCalendars } from './calendar.ts';
import {
  ScheduleError,
  type AssignmentIn, type ProjectIn, type RateIn, type ResourceIn, type ScheduleResult, type TaskIn,
} from './types.ts';

/**
 * Resource scheduling rules.
 *
 *   kind            input            derived                         what happens when units change
 *   FIXED_UNITS     duration, units  work = duration x units         work changes (duration fixed)
 *   FIXED_UNITS + effortDriven       work (workMin) fixed,           duration = work / sum(units)
 *                                    duration derived
 *   FIXED_DURATION  duration, units  work = duration x units         work changes
 *   FIXED_WORK      work             duration = ceil(work / sum(u))  duration changes (always effort-driven)
 *
 * With no assignments a task keeps its entered duration. Everything here is a pure function of the plan.
 */

const DAY = 86_400_000;
const MIN = 60_000;
const EPS = 1e-9;

export interface EffortResult { durationMin: number; workMin: number; perAssignment: Record<string, number> }

export function validateResources(p: ProjectIn): void {
  const tasks = new Map(p.tasks.map((t) => [t.id, t]));
  const res = new Map<string, ResourceIn>();
  for (const r of p.resources ?? []) {
    if (res.has(r.id)) throw new ScheduleError('DUPLICATE_ID', `duplicate resource id ${r.id}`);
    if (r.maxUnits !== undefined && !(r.maxUnits > 0)) throw new ScheduleError('BAD_INPUT', `resource ${r.id}: maxUnits must be > 0`);
    res.set(r.id, r);
  }
  const seen = new Set<string>();
  const parents = new Set(p.tasks.map((t) => t.parentId).filter(Boolean));
  for (const a of p.assignments ?? []) {
    if (seen.has(a.id)) throw new ScheduleError('DUPLICATE_ID', `duplicate assignment id ${a.id}`);
    seen.add(a.id);
    if (!tasks.has(a.taskId)) throw new ScheduleError('UNKNOWN_TASK', `assignment ${a.id}: unknown task ${a.taskId}`);
    if (parents.has(a.taskId)) throw new ScheduleError('BAD_INPUT', `assignment ${a.id}: task ${a.taskId} is a summary`);
    if (!res.has(a.resourceId)) throw new ScheduleError('BAD_INPUT', `assignment ${a.id}: unknown resource ${a.resourceId}`);
    if (a.units !== undefined && !(a.units > 0)) throw new ScheduleError('BAD_INPUT', `assignment ${a.id}: units must be > 0`);
  }
  for (const t of p.tasks) {
    if ((t.kind === 'FIXED_WORK' || t.effortDriven) && (t.workMin === undefined || t.workMin < 0))
      throw new ScheduleError('BAD_INPUT', `task ${t.id}: ${t.kind === 'FIXED_WORK' ? 'FIXED_WORK' : 'effortDriven'} requires workMin >= 0`);
  }
}

export function effort(t: TaskIn, asg: AssignmentIn[]): EffortResult {
  const sumU = asg.reduce((s, a) => s + (a.units ?? 1), 0);
  const per: Record<string, number> = {};
  const workDriven = t.kind === 'FIXED_WORK' || ((t.kind ?? 'FIXED_UNITS') === 'FIXED_UNITS' && t.effortDriven === true);
  if (workDriven && sumU > 0 && t.workMin !== undefined) {
    const duration = Math.ceil(t.workMin / sumU - EPS);
    for (const a of asg) per[a.id] = (t.workMin * (a.units ?? 1)) / sumU;
    return { durationMin: duration, workMin: t.workMin, perAssignment: per };
  }
  let w = 0;
  for (const a of asg) { per[a.id] = t.durationMin * (a.units ?? 1); w += per[a.id]; }
  return { durationMin: t.durationMin, workMin: t.workMin !== undefined && asg.length === 0 ? t.workMin : w, perAssignment: per };
}

export function groupByTask(p: ProjectIn): Map<string, AssignmentIn[]> {
  const m = new Map<string, AssignmentIn[]>();
  for (const a of p.assignments ?? []) (m.get(a.taskId) ?? m.set(a.taskId, []).get(a.taskId)!).push(a);
  return m;
}

/** Return a copy of the plan whose task durations obey the resource rules (what the CPM engine should schedule). */
export function applyResourceRules(p: ProjectIn): ProjectIn {
  validateResources(p);
  const by = groupByTask(p);
  return {
    ...p,
    tasks: p.tasks.map((t) => {
      const asg = by.get(t.id);
      if (!asg?.length) return t;
      const e = effort(t, asg);
      return e.durationMin === t.durationMin ? t : { ...t, durationMin: e.durationMin };
    }),
  };
}

export function rateAt(rates: RateIn[] | undefined, at: number): RateIn | undefined {
  let best: RateIn | undefined;
  for (const r of rates ?? []) if (r.from <= at && (!best || r.from > best.from)) best = r;
  return best;
}

const iso = (dayMs: number) => new Date(dayMs).toISOString().slice(0, 10);

/** Working minutes of `cal` per day inside [from, to). */
export function workByDay(cal: WorkCalendar, from: number, to: number): { dayMs: number; minutes: number }[] {
  const out: { dayMs: number; minutes: number }[] = [];
  for (let d = Math.floor(from / DAY) * DAY; d < to; d += DAY) {
    let m = 0;
    for (const r of cal.rangesOn(d)) {
      const s = Math.max(from, d + r.startMin * MIN), e = Math.min(to, d + r.endMin * MIN);
      if (e > s) m += (e - s) / MIN;
    }
    if (m > 0) out.push({ dayMs: d, minutes: m });
  }
  return out;
}

export interface AssignmentPhase {
  assignmentId: string; taskId: string; resourceId: string;
  workMin: number; cost: number;
  days: { day: string; workMin: number; cost: number }[];
}
export interface Timephase {
  assignments: AssignmentPhase[];
  /** resource -> ISO day -> assigned work minutes */
  byResource: Record<string, Record<string, number>>;
  totalWorkMin: number; totalCost: number;
  /** assignments whose work falls (partly) outside the resource's own working time */
  warnings: { assignmentId: string; code: 'OFF_RESOURCE_CALENDAR'; minutes: number }[];
}

/**
 * Timephased work and cost. Work of an assignment is spread over the task's working minutes between its scheduled
 * start and finish in proportion to units. Cost = work x effective-dated rate at that day (+ per-use cost on the first day).
 * COST/MATERIAL resources carry only per-use cost. Granularity is one day.
 */
export function timephase(p: ProjectIn, s: ScheduleResult): Timephase {
  validateResources(p);
  const cals = resolveCalendars([p.calendar, ...(p.calendars ?? [])]);
  const projCal = cals.get(p.calendar.id)!;
  const res = new Map((p.resources ?? []).map((r) => [r.id, r]));
  const tasks = new Map(p.tasks.map((t) => [t.id, t]));
  const out: Timephase = { assignments: [], byResource: {}, totalWorkMin: 0, totalCost: 0, warnings: [] };
  const by = groupByTask(p);
  for (const [taskId, asg] of by) {
    const t = tasks.get(taskId)!, o = s.tasks[taskId];
    const cal = t.calendarId ? cals.get(t.calendarId)! : projCal;
    const e = effort(t, asg);
    const buckets = workByDay(cal, o.es, o.ef);
    const total = buckets.reduce((x, b) => x + b.minutes, 0);
    for (const a of asg) {
      const r = res.get(a.resourceId)!;
      const ph: AssignmentPhase = { assignmentId: a.id, taskId, resourceId: a.resourceId, workMin: 0, cost: 0, days: [] };
      const isWork = (r.kind ?? 'WORK') === 'WORK';
      const rcal = r.calendarId ? cals.get(r.calendarId) : undefined;
      let off = 0;
      buckets.forEach((b, i) => {
        const w = isWork && total > 0 ? (e.perAssignment[a.id] * b.minutes) / total : 0;
        const rate = rateAt(r.rates, b.dayMs);
        let cost = ((rate?.stdPerHour ?? 0) * w) / 60;
        if (i === 0) cost += rate?.perUse ?? 0;
        if (rcal && isWork) {
          const rm = workByDay(rcal, Math.max(o.es, b.dayMs), Math.min(o.ef, b.dayMs + DAY)).reduce((x, y) => x + y.minutes, 0);
          if (rm < b.minutes) off += ((b.minutes - rm) * w) / b.minutes / (a.units ?? 1);
        }
        const day = iso(b.dayMs);
        ph.days.push({ day, workMin: round(w), cost: round(cost) });
        ph.workMin += w; ph.cost += cost;
        (out.byResource[a.resourceId] ??= {})[day] = round((out.byResource[a.resourceId][day] ?? 0) + w);
      });
      if (buckets.length === 0) ph.cost += rateAt(r.rates, o.es)?.perUse ?? 0; // milestone-like: per-use only
      if (off > 1e-6) out.warnings.push({ assignmentId: a.id, code: 'OFF_RESOURCE_CALENDAR', minutes: round(off) });
      ph.workMin = round(ph.workMin); ph.cost = round(ph.cost);
      out.assignments.push(ph);
      out.totalWorkMin += ph.workMin; out.totalCost += ph.cost;
    }
  }
  for (const t of p.tasks) out.totalCost += t.fixedCost ?? 0;
  out.totalWorkMin = round(out.totalWorkMin); out.totalCost = round(out.totalCost);
  return out;
}

/** Planned value from the timephased budget: cost of all days strictly before the day of `at`. */
export function plannedValueAt(p: ProjectIn, s: ScheduleResult, tp: Timephase, at: number): number {
  const cutoff = iso(Math.floor(at / DAY) * DAY);
  let pv = 0;
  for (const a of tp.assignments) for (const d of a.days) if (d.day < cutoff) pv += d.cost;
  for (const t of p.tasks) {
    const o = s.tasks[t.id];
    if (t.fixedCost && o && !o.isSummary && o.ef <= at) pv += t.fixedCost;
  }
  return round(pv);
}

const round = (x: number) => Math.round(x * 1e6) / 1e6;
