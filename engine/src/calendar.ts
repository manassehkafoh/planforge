import { ScheduleError, type CalendarDef, type TimeRange } from './types.ts';

const DAY = 86_400_000;
const MIN = 60_000;
const MAX_DAYS = 366 * 100; // safety bound: refuse to scan > 100 years

function dayStart(t: number): number { return Math.floor(t / DAY) * DAY; }
function key(dayMs: number): string { return new Date(dayMs).toISOString().slice(0, 10); }

/** Working-time arithmetic over one calendar. Pure and allocation-light; memoises day lookups. */
export class WorkCalendar {
  private cache = new Map<number, TimeRange[]>();
  readonly def: CalendarDef;
  constructor(def: CalendarDef) { this.def = def; }

  rangesOn(dayMs: number): TimeRange[] {
    let r = this.cache.get(dayMs);
    if (r) return r;
    const ex = this.def.exceptions?.[key(dayMs)];
    r = ex ?? this.def.week[new Date(dayMs).getUTCDay()] ?? [];  // nulls were resolved by resolveCalendars()
    this.cache.set(dayMs, r);
    return r;
  }

  /** earliest instant >= t that lies inside working time (range start inclusive, end exclusive) */
  nextWorkStart(t: number): number {
    let d = dayStart(t);
    for (let i = 0; i < MAX_DAYS; i++, d += DAY) {
      for (const r of this.rangesOn(d)) {
        const s = d + r.startMin * MIN, e = d + r.endMin * MIN;
        if (t < e) return Math.max(t, s);
      }
    }
    throw new Error('calendar has no working time');
  }

  /** latest instant <= t that is working time or the end of a working range */
  prevWorkEnd(t: number): number {
    let d = dayStart(t);
    for (let i = 0; i < MAX_DAYS; i++, d -= DAY) {
      const rs = this.rangesOn(d);
      for (let k = rs.length - 1; k >= 0; k--) {
        const s = d + rs[k].startMin * MIN, e = d + rs[k].endMin * MIN;
        if (t > s) return Math.min(t, e);
      }
    }
    throw new Error('calendar has no working time');
  }

  /**
   * Latest valid START at or before `t` *on the working-time axis*. An instant that is not working
   * time (e.g. 17:00 or a weekend) is the same point on that axis as the next working start, so a
   * start requested "by Wed 17:00" is Thu 08:00. (Minute-granular backtracking was a bug found by the
   * property test: it produced starts such as 16:59.)
   */
  latestStartAtOrBefore(t: number): number {
    return this.nextWorkStart(this.prevWorkEnd(t));
  }

  /** End-instant after consuming `minutes` of working time starting at/after `from`. */
  addWork(from: number, minutes: number): number {
    if (minutes <= 0) return from;
    let remaining = minutes;
    let d = dayStart(from);
    for (let i = 0; i < MAX_DAYS; i++, d += DAY) {
      for (const r of this.rangesOn(d)) {
        const s = d + r.startMin * MIN, e = d + r.endMin * MIN;
        if (from >= e) continue;
        const b = Math.max(from, s);
        const avail = (e - b) / MIN;
        if (avail >= remaining) return b + remaining * MIN;
        remaining -= avail;
      }
    }
    throw new Error('addWork exceeded horizon');
  }

  /** Start-instant obtained by walking `minutes` of working time backwards from end-instant `from`. */
  subWork(from: number, minutes: number): number {
    if (minutes <= 0) return from;
    let remaining = minutes;
    let d = dayStart(from);
    for (let i = 0; i < MAX_DAYS; i++, d -= DAY) {
      const rs = this.rangesOn(d);
      for (let k = rs.length - 1; k >= 0; k--) {
        const s = d + rs[k].startMin * MIN, e = d + rs[k].endMin * MIN;
        if (from <= s) continue;
        const b = Math.min(from, e);
        const avail = (b - s) / MIN;
        if (avail >= remaining) return b - remaining * MIN;
        remaining -= avail;
      }
    }
    throw new Error('subWork exceeded horizon');
  }

  // Prefix-sum index: cum[i] = working minutes from `base` (a midnight) to the start of day base+i.
  // Turns workBetween from O(days spanned) into O(1) amortised after the index has been extended.
  private base: number | undefined;
  private cum: number[] = [0];

  private dayMinutes(dayMs: number): number {
    let m = 0;
    for (const r of this.rangesOn(dayMs)) m += r.endMin - r.startMin;
    return m;
  }
  private partial(dayMs: number, t: number): number { // working minutes in [dayMs, t]
    let m = 0;
    for (const r of this.rangesOn(dayMs)) {
      const e = Math.min(t, dayMs + r.endMin * MIN), s = dayMs + r.startMin * MIN;
      if (e > s) m += (e - s) / MIN;
    }
    return m;
  }
  private cumulative(t: number): number | undefined {
    if (this.base === undefined) this.base = dayStart(t);
    if (t < this.base) return undefined;
    const idx = Math.floor((t - this.base) / DAY);
    if (idx > MAX_DAYS) return undefined;
    while (this.cum.length <= idx) this.cum.push(this.cum[this.cum.length - 1] + this.dayMinutes(this.base + (this.cum.length - 1) * DAY));
    return this.cum[idx] + this.partial(this.base + idx * DAY, t);
  }

  /** Signed working minutes between two instants (positive when b is later than a). */
  workBetween(a: number, b: number): number {
    if (a === b) return 0;
    if (b < a) return -this.workBetween(b, a);
    const wa = this.cumulative(a), wb = wa === undefined ? undefined : this.cumulative(b);
    if (wa !== undefined && wb !== undefined) return wb - wa;
    let total = 0; // fallback: instant earlier than the index anchor
    let d = dayStart(a);
    const last = dayStart(b);
    for (; d <= last; d += DAY) total += this.partial(d, b) - this.partial(d, a);
    return total;
  }

  /** shift an instant by signed working minutes (lag/lead) */
  shift(t: number, minutes: number): number {
    if (minutes > 0) return this.addWork(t, minutes);
    if (minutes < 0) return this.subWork(t, -minutes);
    return t;
  }
}

/** Standard Mon-Fri 08:00-12:00, 13:00-17:00 calendar (480 working min/day). */
export function standardCalendar(id = 'std'): CalendarDef {
  const day: TimeRange[] = [{ startMin: 480, endMin: 720 }, { startMin: 780, endMin: 1020 }];
  return { id, week: [[], day, day, day, day, day, []] };
}

/**
 * Flatten calendar inheritance. A derived calendar (baseId) takes the base's weekday pattern wherever its own
 * entry is null, and the union of exception days with its own exceptions winning. Cycles are rejected.
 */
export function resolveCalendars(defs: CalendarDef[]): Map<string, WorkCalendar> {
  const byId = new Map(defs.map((d) => [d.id, d]));
  const done = new Map<string, CalendarDef>();
  const visit = (id: string, chain: string[]): CalendarDef => {
    const hit = done.get(id);
    if (hit) return hit;
    const d = byId.get(id);
    if (!d) throw new ScheduleError('BAD_INPUT', `unknown base calendar ${id}`);
    if (chain.includes(id)) throw new ScheduleError('BAD_INPUT', `calendar inheritance cycle: ${[...chain, id].join(' -> ')}`);
    let flat: CalendarDef;
    if (d.baseId) {
      const b = visit(d.baseId, [...chain, id]);
      flat = {
        id: d.id,
        week: Array.from({ length: 7 }, (_, i) => d.week[i] ?? b.week[i] ?? []),
        exceptions: { ...(b.exceptions ?? {}), ...(d.exceptions ?? {}) },
      };
    } else {
      flat = { id: d.id, week: Array.from({ length: 7 }, (_, i) => d.week[i] ?? []), exceptions: d.exceptions };
    }
    done.set(id, flat);
    return flat;
  };
  const out = new Map<string, WorkCalendar>();
  for (const d of defs) out.set(d.id, new WorkCalendar(visit(d.id, [])));
  return out;
}
