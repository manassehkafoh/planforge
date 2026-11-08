import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schedule, standardCalendar } from '../src/index.ts';
import type { ProjectIn } from '../src/index.ts';
import { randomProject, MON } from './helpers.ts';

/**
 * INDEPENDENT oracle. Shares no code with the engine: it materialises every working minute of a 3-year horizon,
 * works purely in integer positions on that axis, and finds ES/LF by fix-point relaxation (Bellman-Ford style)
 * instead of a topological pass. Scope: one calendar, FS/SS/FF/SF with lag, ASAP/ALAP excluded, SNET + FNLT.
 */
const DAY = 86_400_000, MIN = 60_000;
function axis(startDay: number, days: number) {
  const cal = standardCalendar();
  const starts: number[] = []; // starts[k] = instant at which working minute k begins
  for (let i = 0; i < days; i++) {
    const d = startDay + i * DAY, dow = new Date(d).getUTCDay();
    for (const r of cal.week[dow] ?? []) for (let m = r.startMin; m < r.endMin; m++) starts.push(d + m * MIN);
  }
  const pos = (t: number) => { // number of working minutes strictly before t
    let lo = 0, hi = starts.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (starts[mid] < t) lo = mid + 1; else hi = mid; }
    return lo;
  };
  return { pos, starts };
}

function oracle(p: ProjectIn) {
  const ax = axis(Math.floor(MON / DAY) * DAY, 800);
  const n = p.tasks.length, idx = new Map(p.tasks.map((t, i) => [t.id, i]));
  const d = p.tasks.map((t) => t.durationMin);
  const base = ax.pos(p.startDate);
  const snet = p.tasks.map((t) => t.constraint?.type === 'SNET' ? ax.pos(t.constraint.date!) : -Infinity);
  const fnlt = p.tasks.map((t) => t.constraint?.type === 'FNLT' ? ax.pos(t.constraint.date!) : Infinity);
  const L = p.links.map((l) => ({ a: idx.get(l.pred)!, b: idx.get(l.succ)!, ty: l.type ?? 'FS', lag: l.lagMin ?? 0 }));
  const ES = Array(n).fill(base);
  for (let it = 0; it <= n + 1; it++) {
    let ch = false;
    for (let i = 0; i < n; i++) { const v = Math.max(ES[i], snet[i]); if (v !== ES[i]) { ES[i] = v; ch = true; } }
    for (const e of L) {
      const need = e.ty === 'FS' ? ES[e.a] + d[e.a] + e.lag : e.ty === 'SS' ? ES[e.a] + e.lag : e.ty === 'FF' ? ES[e.a] + d[e.a] + e.lag - d[e.b] : ES[e.a] + e.lag - d[e.b];
      if (need > ES[e.b]) { ES[e.b] = need; ch = true; }
    }
    if (!ch) break;
  }
  const finish = Math.max(...ES.map((s, i) => s + d[i]));
  const LF = Array(n).fill(finish);
  for (let i = 0; i < n; i++) LF[i] = Math.min(LF[i], fnlt[i]);
  for (let it = 0; it <= n + 1; it++) {
    let ch = false;
    for (const e of L) {
      const c2 = e.ty === 'FS' ? LF[e.b] - d[e.b] - e.lag
        : e.ty === 'SS' ? LF[e.b] - d[e.b] - e.lag + d[e.a]
        : e.ty === 'FF' ? LF[e.b] - e.lag
        : LF[e.b] - e.lag + d[e.a]; // SF: LS_a <= LF_b - lag
      if (c2 < LF[e.a]) { LF[e.a] = c2; ch = true; }
    }
    if (!ch) break;
  }
  return { ES, EF: ES.map((s, i) => s + d[i]), TF: LF.map((lf, i) => lf - (ES[i] + d[i])), finish, pos: ax.pos };
}

test('engine == independent brute-force oracle on 400 random networks (dates on the working-minute axis, total float)', () => {
  let mismatches = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const raw = randomProject(seed, 15 + (seed % 10));
    // oracle scope: no ALAP constraint
    const p: ProjectIn = { ...raw, tasks: raw.tasks.map((t) => (t.constraint?.type === 'ALAP' ? { id: t.id, durationMin: t.durationMin } : t)) };
    const eng = schedule(p), o = oracle(p);
    p.tasks.forEach((t, i) => {
      const e = eng.tasks[t.id];
      const ok = o.pos(e.es) === o.ES[i] && o.pos(e.ef) === o.EF[i] && e.totalFloatMin === o.TF[i];
      if (!ok) {
        mismatches++;
        assert.fail(`seed ${seed} task ${t.id}: engine es=${o.pos(e.es)} ef=${o.pos(e.ef)} tf=${e.totalFloatMin} oracle es=${o.ES[i]} ef=${o.EF[i]} tf=${o.TF[i]}`);
      }
    });
    assert.equal(o.pos(eng.finish), o.finish);
  }
  assert.equal(mismatches, 0);
});
