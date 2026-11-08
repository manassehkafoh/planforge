// Independent scheduling oracle (written from docs/06 section 3 semantics; does NOT import the engine).
// Works on the "working-minute axis": pos(t) = number of working minutes strictly before instant t.
// A task occupies positions [S, S+dur). Instants map back as ES = start-of-minute(S), EF = end-of-minute(S+dur-1).
export type Range = { startMin: number; endMin: number };
export interface Cal { week: Range[][]; exceptions: Record<string, Range[]> }
export const STD_WEEK: Range[][] = [[], ...Array.from({ length: 5 }, () => [{ startMin: 480, endMin: 720 }, { startMin: 780, endMin: 1020 }]), []];
export const STD_CAL: Cal = { week: STD_WEEK, exceptions: { '2026-12-25': [] } };

const BASE = Date.UTC(2025, 0, 6); // a Monday well before any test date
const DAY = 86400000;
const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const parse = (s: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(s)!; return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]); };
export const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 19);

export class Axis {
  cum: number[] = [0]; // cum[d] = working minutes in days [0, d)
  cal: Cal; days: number;
  constructor(cal: Cal, days = 365 * 6) {
    this.cal = cal; this.days = days;
    for (let d = 0; d < days; d++) this.cum.push(this.cum[d] + this.rangesOf(d).reduce((a, r) => a + r.endMin - r.startMin, 0));
  }
  rangesOf(d: number): Range[] {
    const ms = BASE + d * DAY; const ex = this.cal.exceptions[dayKey(ms)];
    return ex ?? this.cal.week[new Date(ms).getUTCDay()];
  }
  pos(t: string | number): number {
    const ms = typeof t === 'string' ? parse(t) : t; const d = Math.floor((ms - BASE) / DAY); const min = Math.floor((ms - BASE - d * DAY) / 60000);
    let p = this.cum[d];
    for (const r of this.rangesOf(d)) p += Math.max(0, Math.min(min, r.endMin) - r.startMin);
    return p;
  }
  /** start instant of the working minute with index p */
  startOf(p: number): string {
    let lo = 0, hi = this.days;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.cum[mid] <= p) lo = mid; else hi = mid - 1; }
    let rem = p - this.cum[lo];
    for (const r of this.rangesOf(lo)) { const len = r.endMin - r.startMin; if (rem < len) return fmt(BASE + lo * DAY + (r.startMin + rem) * 60000); rem -= len; }
    throw new Error('axis overflow');
  }
  /** end instant of the working minute p-1 (i.e. the instant "at" position p seen from the left) */
  endOf(p: number): string { const s = parse(this.startOf(p - 1)); return fmt(s + 60000); }
  total(): number { return this.cum[this.days]; }
}

export type DepType = 'FS' | 'SS' | 'FF' | 'SF';
export interface OTask { id: string; dur: number; parent?: string | null; ctype?: string; cdate?: string; deadlineExempt?: boolean }
export interface OLink { pred: string; succ: string; type: DepType; lag: number }
export interface OOut { es: string; ef: string; ls: string; lf: string; tf: number; ff: number; critical: boolean; near: boolean; S: number; F: number; LS: number; LF: number }
export interface OResult { tasks: Map<string, OOut>; conflicts: Array<{ taskId: string; code: string }>; finish: string; criticalPath: string[] }

/** Forward/backward CPM on leaf tasks (positive durations only), summaries rolled up. */
export function oracle(axis: Axis, startIso: string, tasks: OTask[], links: OLink[], opts: { deadline?: string; nearMin?: number } = {}): OResult {
  const near = opts.nearMin ?? 960;
  const S0 = axis.pos(startIso);
  const isParent = new Set(tasks.map((t) => t.parent).filter(Boolean) as string[]);
  const leaves = tasks.filter((t) => !isParent.has(t.id));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const preds = new Map<string, OLink[]>(), succs = new Map<string, OLink[]>();
  for (const l of links) { (preds.get(l.succ) ?? preds.set(l.succ, []).get(l.succ)!).push(l); (succs.get(l.pred) ?? succs.set(l.pred, []).get(l.pred)!).push(l); }
  // topological order (Kahn)
  const indeg = new Map(leaves.map((t) => [t.id, 0]));
  for (const l of links) indeg.set(l.succ, (indeg.get(l.succ) ?? 0) + 1);
  const order: string[] = []; const q = leaves.filter((t) => indeg.get(t.id) === 0).map((t) => t.id);
  while (q.length) { const id = q.shift()!; order.push(id); for (const l of succs.get(id) ?? []) { indeg.set(l.succ, indeg.get(l.succ)! - 1); if (indeg.get(l.succ) === 0) q.push(l.succ); } }
  if (order.length !== leaves.length) throw new Error('oracle: cycle');
  const S = new Map<string, number>(), F = new Map<string, number>(); const conflicts: OResult['conflicts'] = [];
  const cpos = (t: OTask) => (t.cdate ? axis.pos(t.cdate) : 0);
  for (const id of order) {
    const t = byId.get(id)!; let s = S0; let reqF = -Infinity;
    for (const l of preds.get(id) ?? []) {
      const ps = S.get(l.pred)!, pf = F.get(l.pred)!;
      if (l.type === 'FS') s = Math.max(s, pf + l.lag); else if (l.type === 'SS') s = Math.max(s, ps + l.lag);
      else if (l.type === 'FF') reqF = Math.max(reqF, pf + l.lag); else reqF = Math.max(reqF, ps + l.lag);
    }
    const ct = t.ctype ?? 'ASAP';
    if (ct === 'SNET' || ct === 'MSO') s = Math.max(s, ct === 'MSO' ? -Infinity : cpos(t));
    if (ct === 'FNET') reqF = Math.max(reqF, cpos(t));
    if (reqF > -Infinity) s = Math.max(s, reqF - t.dur);
    s = Math.max(s, S0);
    if (ct === 'MSO') { const pin = cpos(t); if (s > pin) conflicts.push({ taskId: id, code: 'MSO_VIOLATED' }); s = pin; }
    let f = s + t.dur;
    if (ct === 'MFO') { const pin = cpos(t); if (f > pin) conflicts.push({ taskId: id, code: 'MFO_VIOLATED' }); f = pin; s = f - t.dur; }
    if (ct === 'SNLT' && s > cpos(t)) conflicts.push({ taskId: id, code: 'SNLT_VIOLATED' });
    if (ct === 'FNLT' && f > cpos(t)) conflicts.push({ taskId: id, code: 'FNLT_VIOLATED' });
    S.set(id, s); F.set(id, f);
  }
  const projF = Math.max(...order.map((i) => F.get(i)!));
  const limit = opts.deadline ? Math.min(projF, axis.pos(opts.deadline)) : projF;
  const LS = new Map<string, number>(), LF = new Map<string, number>();
  for (const id of [...order].reverse()) {
    const t = byId.get(id)!; let cap = limit;
    for (const l of succs.get(id) ?? []) {
      const sLS = LS.get(l.succ)!, sLF = LF.get(l.succ)!;
      if (l.type === 'FS') cap = Math.min(cap, sLS - l.lag); else if (l.type === 'FF') cap = Math.min(cap, sLF - l.lag);
      else if (l.type === 'SS') cap = Math.min(cap, sLS - l.lag + t.dur); else cap = Math.min(cap, sLF - l.lag + t.dur);
    }
    const ct = t.ctype ?? 'ASAP';
    if (ct === 'FNLT') cap = Math.min(cap, cpos(t));
    if (ct === 'SNLT') cap = Math.min(cap, cpos(t) + t.dur);
    let lf = cap, ls = lf - t.dur;
    if (ct === 'MSO' || ct === 'MFO') { ls = S.get(id)!; lf = F.get(id)!; }
    LF.set(id, lf); LS.set(id, ls);
  }
  if (opts.deadline) for (const id of order) if (F.get(id)! > axis.pos(opts.deadline) && (LF.get(id)! < F.get(id)!)) conflicts.push({ taskId: id, code: 'DEADLINE_MISSED' });
  const out = new Map<string, OOut>();
  for (const id of order) {
    const t = byId.get(id)!; const tf = LS.get(id)! - S.get(id)!;
    let ff = tf;
    for (const l of succs.get(id) ?? []) {
      const ss = S.get(l.succ)!, sf = F.get(l.succ)!; const ps = S.get(id)!, pf = F.get(id)!;
      const slack = l.type === 'FS' ? ss - (pf + l.lag) : l.type === 'SS' ? ss - (ps + l.lag) : l.type === 'FF' ? sf - (pf + l.lag) : sf - (ps + l.lag);
      ff = Math.min(ff, slack);
    }
    ff = Math.max(Math.min(0, tf), Math.min(ff, tf));
    out.set(id, { S: S.get(id)!, F: F.get(id)!, LS: LS.get(id)!, LF: LF.get(id)!, es: axis.startOf(S.get(id)!), ef: axis.endOf(F.get(id)!), ls: axis.startOf(LS.get(id)!), lf: axis.endOf(LF.get(id)!), tf, ff, critical: tf <= 0, near: tf > 0 && tf <= near });
    void t;
  }
  // summary roll-up (min ES, max EF, min TF, any critical)
  const kids = new Map<string, string[]>();
  for (const t of tasks) if (t.parent) (kids.get(t.parent) ?? kids.set(t.parent, []).get(t.parent)!).push(t.id);
  const rolled = (id: string): OOut => {
    if (out.has(id)) return out.get(id)!;
    const cs = kids.get(id)!.map(rolled);
    const S1 = Math.min(...cs.map((c) => c.S)), F1 = Math.max(...cs.map((c) => c.F)), LS1 = Math.min(...cs.map((c) => c.LS)), LF1 = Math.max(...cs.map((c) => c.LF));
    const tf = Math.min(...cs.map((c) => c.tf));
    const o: OOut = { S: S1, F: F1, LS: LS1, LF: LF1, es: axis.startOf(S1), ef: axis.endOf(F1), ls: axis.startOf(LS1), lf: axis.endOf(LF1), tf, ff: Math.min(...cs.map((c) => c.ff)), critical: cs.some((c) => c.critical), near: tf > 0 && tf <= near };
    out.set(id, o); return o;
  };
  for (const t of tasks) rolled(t.id);
  return { tasks: out, conflicts, finish: axis.endOf(projF), criticalPath: order.filter((i) => out.get(i)!.critical) };
}
