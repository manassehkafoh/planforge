import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schedule, standardCalendar, WorkCalendar, evm, earnedValue, simulate, rng, ScheduleError } from '../src/index.ts';
import type { ProjectIn, TaskIn, LinkIn } from '../src/index.ts';

const D = 480; // one working day in minutes
const at = (y: number, m: number, d: number, h = 8, mi = 0) => Date.UTC(y, m - 1, d, h, mi);
const MON = at(2026, 11, 9); // Monday 09 Nov 2026 08:00
const proj = (tasks: TaskIn[], links: LinkIn[], extra: Partial<ProjectIn> = {}): ProjectIn =>
  ({ startDate: MON, calendar: standardCalendar(), tasks, links, ...extra });
const T = (id: string, days: number, extra: Partial<TaskIn> = {}): TaskIn => ({ id, durationMin: days * D, ...extra });

test('calendar: addWork skips lunch and weekends; subWork inverts it', () => {
  const c = new WorkCalendar(standardCalendar());
  assert.equal(c.addWork(MON, 5 * D), at(2026, 11, 13, 17)); // Fri 17:00
  assert.equal(c.addWork(MON, 6 * D), at(2026, 11, 16, 17)); // next Mon 17:00
  assert.equal(c.addWork(MON, 300), at(2026, 11, 9, 14)); // 4h morning + 1h after lunch -> 14:00
  assert.equal(c.subWork(at(2026, 11, 16, 17), 6 * D), MON);
  assert.equal(c.nextWorkStart(at(2026, 11, 14, 10)), at(2026, 11, 16, 8)); // Saturday -> Monday
  assert.equal(c.nextWorkStart(at(2026, 11, 13, 17)), at(2026, 11, 16, 8)); // range end is not a start
  assert.equal(c.workBetween(MON, at(2026, 11, 16, 8)), 5 * D);
  assert.equal(c.workBetween(at(2026, 11, 16, 8), MON), -5 * D);
});

test('calendar: exception day (public holiday) is skipped', () => {
  const cal = standardCalendar();
  cal.exceptions = { '2026-11-11': [] }; // Wednesday off
  const c = new WorkCalendar(cal);
  assert.equal(c.addWork(MON, 3 * D), at(2026, 11, 12, 17)); // Mon, Tue, Thu
});

test('FS chain: dates, all critical, project finish', () => {
  const r = schedule(proj([T('A', 2), T('B', 3), T('C', 1)], [{ pred: 'A', succ: 'B' }, { pred: 'B', succ: 'C' }]));
  assert.equal(r.tasks.A.ef, at(2026, 11, 10, 17));
  assert.equal(r.tasks.B.es, at(2026, 11, 11, 8));
  assert.equal(r.tasks.B.ef, at(2026, 11, 13, 17));
  assert.equal(r.tasks.C.es, at(2026, 11, 16, 8));
  assert.equal(r.finish, at(2026, 11, 16, 17));
  assert.deepEqual(r.criticalPath, ['A', 'B', 'C']);
  assert.equal(r.tasks.A.totalFloatMin, 0);
});

test('float: parallel branch has total and free float', () => {
  const r = schedule(proj([T('A', 1), T('B', 3), T('C', 1)], [{ pred: 'A', succ: 'C' }, { pred: 'B', succ: 'C' }]));
  assert.equal(r.tasks.A.totalFloatMin, 2 * D);
  assert.equal(r.tasks.A.freeFloatMin, 2 * D);
  assert.equal(r.tasks.A.critical, false);
  assert.deepEqual(r.criticalPath, ['B', 'C']);
});

test('SS with lag, FF and SF relationships', () => {
  const ss = schedule(proj([T('A', 5), T('B', 2)], [{ pred: 'A', succ: 'B', type: 'SS', lagMin: D }]));
  assert.equal(ss.tasks.B.es, at(2026, 11, 10, 8));
  const ff = schedule(proj([T('A', 3), T('B', 1)], [{ pred: 'A', succ: 'B', type: 'FF' }]));
  assert.equal(ff.tasks.B.ef, ff.tasks.A.ef);
  assert.equal(ff.tasks.B.es, at(2026, 11, 11, 8));
  const sf = schedule(proj([T('A', 2, { constraint: { type: 'SNET', date: at(2026, 11, 12) } }), T('B', 2)],
    [{ pred: 'A', succ: 'B', type: 'SF' }]));
  // SF: B must finish no earlier than A starts (Thu 08:00) -> latest working instant is Wed 17:00
  assert.equal(sf.tasks.B.ef, at(2026, 11, 11, 17));
  assert.equal(sf.tasks.B.es, at(2026, 11, 10, 8));
});

test('negative lag (lead) overlaps successor', () => {
  const r = schedule(proj([T('A', 2), T('B', 2)], [{ pred: 'A', succ: 'B', lagMin: -D }]));
  assert.equal(r.tasks.B.es, at(2026, 11, 10, 8)); // one day before A finishes
});

test('constraints: SNET delays; MSO violation reported but honoured; FNLT conflict; deadline', () => {
  const snet = schedule(proj([T('A', 1, { constraint: { type: 'SNET', date: at(2026, 11, 12) } })], []));
  assert.equal(snet.tasks.A.es, at(2026, 11, 12, 8));

  const mso = schedule(proj([T('A', 3), T('B', 1, { constraint: { type: 'MSO', date: at(2026, 11, 10) } })], [{ pred: 'A', succ: 'B' }]));
  assert.equal(mso.tasks.B.es, at(2026, 11, 10, 8));
  assert.ok(mso.conflicts.some((c) => c.taskId === 'B' && c.code === 'MSO_VIOLATED'));

  const fnlt = schedule(proj([T('A', 3, { constraint: { type: 'FNLT', date: at(2026, 11, 10, 17) } })], []));
  assert.ok(fnlt.conflicts.some((c) => c.code === 'FNLT_VIOLATED'));
  assert.ok(fnlt.tasks.A.totalFloatMin < 0 && fnlt.tasks.A.critical);

  const dl = schedule(proj([T('A', 5)], [], { deadline: at(2026, 11, 12, 17) }));
  assert.ok(dl.conflicts.some((c) => c.code === 'DEADLINE_MISSED'));
  assert.equal(dl.tasks.A.totalFloatMin, -D);
});

test('ALAP places a task at its late dates without moving the project end', () => {
  const r = schedule(proj([T('A', 1, { constraint: { type: 'ALAP' } }), T('B', 3), T('C', 1)],
    [{ pred: 'A', succ: 'C' }, { pred: 'B', succ: 'C' }]));
  assert.equal(r.tasks.A.es, at(2026, 11, 11, 8)); // pushed to Wed (late start)
  assert.equal(r.finish, at(2026, 11, 12, 17)); // B(3d) Mon-Wed then C(1d) Thu
  assert.equal(r.tasks.C.ef, r.finish);
});

test('milestone has zero duration and zero float on the critical path', () => {
  const r = schedule(proj([T('A', 2), T('M', 0)], [{ pred: 'A', succ: 'M' }]));
  assert.equal(r.tasks.M.es, r.tasks.A.ef);
  assert.equal(r.tasks.M.ef, r.tasks.M.es);
  assert.equal(r.tasks.M.totalFloatMin, 0);
});

test('summary tasks roll up children', () => {
  const r = schedule(proj([T('S', 0), T('A', 2, { parentId: 'S' }), T('B', 3, { parentId: 'S' })], [{ pred: 'A', succ: 'B' }]));
  assert.equal(r.tasks.S.isSummary, true);
  assert.equal(r.tasks.S.es, r.tasks.A.es);
  assert.equal(r.tasks.S.ef, r.tasks.B.ef);
  assert.equal(r.tasks.S.critical, true);
});

test('errors: cycle with path, unknown task, link to summary, duplicate id', () => {
  try {
    schedule(proj([T('A', 1), T('B', 1), T('C', 1)], [{ pred: 'A', succ: 'B' }, { pred: 'B', succ: 'C' }, { pred: 'C', succ: 'B' }]));
    assert.fail('expected cycle');
  } catch (e) {
    assert.ok(e instanceof ScheduleError && e.code === 'CYCLE');
    const path = (e.detail as { path: string[] }).path;
    assert.deepEqual([path[0], path[path.length - 1]], [path[0], path[0]]);
    assert.ok(path.includes('B') && path.includes('C'));
  }
  assert.throws(() => schedule(proj([T('A', 1)], [{ pred: 'A', succ: 'Z' }])), { code: 'UNKNOWN_TASK' });
  assert.throws(() => schedule(proj([T('S', 0), T('A', 1, { parentId: 'S' })], [{ pred: 'S', succ: 'A' }])), { code: 'LINK_TO_SUMMARY' });
  assert.throws(() => schedule(proj([T('A', 1), T('A', 2)], [])), { code: 'DUPLICATE_ID' });
});

test('EVM: EV is percent-complete x BAC, never actual cost (legacy defect regression)', () => {
  const ev = earnedValue(1000, 0.4);
  assert.equal(ev, 400);
  const r = evm({ bac: 1000, pv: 500, ev, ac: 500 });
  assert.equal(r.cv, -100); // legacy code returned ACWP-ACWP = 0 here
  assert.equal(r.sv, -100);
  assert.equal(r.cpi, 0.8);
  assert.equal(r.spi, 0.8);
  assert.equal(r.eacCpi, 1250);
  assert.equal(r.vac, -250);
  assert.equal(evm({ bac: 100, pv: 0, ev: 0, ac: 0 }).cpi, null); // divide-by-zero is explicit, not NaN
  assert.throws(() => earnedValue(100, 1.5), RangeError);
});

test('Monte Carlo is reproducible and ordered', () => {
  const p = proj([T('A', 5, { estimate: { optimistic: 3 * D, mostLikely: 5 * D, pessimistic: 10 * D } }),
    T('B', 5, { estimate: { optimistic: 4 * D, mostLikely: 5 * D, pessimistic: 8 * D } })], [{ pred: 'A', succ: 'B' }]);
  const a = simulate(p, 300, 7), b = simulate(p, 300, 7);
  assert.deepEqual(a, b);
  assert.ok(a.p50 <= a.p80 && a.p80 <= a.p90);
  assert.equal(a.criticalityIndex.A, 1);
});

test('property: invariants hold on 300 random DAGs', () => {
  const r = rng(2026);
  const cal = new WorkCalendar(standardCalendar());
  for (let run = 0; run < 300; run++) {
    const n = 2 + Math.floor(r() * 25);
    const tasks = Array.from({ length: n }, (_, i) => T('t' + i, Math.floor(r() * 6)));
    const links: LinkIn[] = [];
    const types = ['FS', 'SS', 'FF', 'SF'] as const;
    for (let j = 1; j < n; j++) for (let i = 0; i < j; i++) if (r() < 0.15)
      links.push({ pred: 't' + i, succ: 't' + j, type: types[Math.floor(r() * 4)], lagMin: (Math.floor(r() * 3) - 1) * 120 });
    const res = schedule(proj(tasks, links));
    for (const t of tasks) {
      const o = res.tasks[t.id];
      assert.ok(o.es <= o.ls && o.ef <= o.lf, `run ${run} ${t.id}: early<=late`);
      assert.ok(o.totalFloatMin >= 0, `run ${run} ${t.id}: no negative float without constraints`);
      assert.ok(o.freeFloatMin <= o.totalFloatMin && o.freeFloatMin >= 0, `run ${run} ${t.id}: 0<=FF<=TF`);
      assert.equal(o.ef, t.durationMin > 0 ? cal.addWork(o.es, t.durationMin) : o.es, `run ${run} ${t.id}: ef = es + duration`);
      assert.ok(o.es >= MON, 'never before project start');
    }
    for (const l of links) {
      const p = res.tasks[l.pred], s = res.tasks[l.succ], lag = l.lagMin ?? 0;
      const need = l.type === 'FS' ? cal.shift(p.ef, lag) : l.type === 'SS' ? cal.shift(p.es, lag) : -Infinity;
      if (l.type === 'FS' || l.type === 'SS') assert.ok(s.es >= need, `run ${run}: ${l.type} satisfied`);
      else { const f = cal.shift(l.type === 'FF' ? p.ef : p.es, lag); assert.ok(s.ef >= cal.prevWorkEnd(f), `run ${run}: ${l.type} satisfied`); }
    }
    assert.ok(res.criticalPath.length >= 1, `run ${run}: at least one critical task`);
    assert.equal(res.finish, Math.max(...tasks.map((t) => res.tasks[t.id].ef)));
  }
});
