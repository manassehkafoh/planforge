import { test } from 'node:test';
import assert from 'node:assert/strict';
import { levelResources, applyResourceRules, timephase, schedule, plannedValueAt, rng } from '../src/index.ts';
import type { ProjectIn } from '../src/index.ts';
import { proj, T, D, MON, at } from './helpers.ts';

const R = (id: string, maxUnits = 1, extra = {}) => ({ id, maxUnits, ...extra });
const A = (id: string, taskId: string, resourceId: string, units = 1) => ({ id, taskId, resourceId, units });

test('resource rules: fixed units / duration / work / effort-driven', () => {
  const p = proj([
    T('fu', 4, {}),
    T('fw', 4, { kind: 'FIXED_WORK', workMin: 8 * D }),
    T('ed', 4, { effortDriven: true, workMin: 4 * D }),
    T('fd', 4, { kind: 'FIXED_DURATION' }),
  ], [], { resources: [R('r1'), R('r2')], assignments: [
    A('a1', 'fu', 'r1'), A('a2', 'fu', 'r2'),
    A('b1', 'fw', 'r1'), A('b2', 'fw', 'r2'),
    A('c1', 'ed', 'r1'), A('c2', 'ed', 'r2'),
    A('d1', 'fd', 'r1', 0.5),
  ] });
  const e = applyResourceRules(p);
  const dur = Object.fromEntries(e.tasks.map((t) => [t.id, t.durationMin]));
  assert.equal(dur.fu, 4 * D);  // fixed units, not effort driven: duration stays
  assert.equal(dur.fw, 4 * D);  // 8 days of work / 2 units
  assert.equal(dur.ed, 2 * D);  // adding a second person halves the duration
  assert.equal(dur.fd, 4 * D);
  const tp = timephase(e, schedule(e));
  const work = Object.fromEntries(tp.assignments.map((a) => [a.assignmentId, a.workMin]));
  assert.equal(work.a1, 4 * D);
  assert.equal(work.b1 + work.b2, 8 * D);
  assert.equal(work.d1, 2 * D); // 0.5 units x 4 days
});

test('timephased work, effective-dated rates and per-use cost; planned value', () => {
  const p = proj([T('A', 2)], [], {
    resources: [R('dev', 1, { rates: [{ from: 0, stdPerHour: 60 }, { from: at(2026, 11, 10, 0), stdPerHour: 120, perUse: 100 }] })],
    assignments: [A('a', 'A', 'dev')],
  });
  const s = schedule(p), tp = timephase(p, s);
  assert.equal(tp.assignments[0].workMin, 2 * D);
  assert.deepEqual(tp.assignments[0].days.map((d) => d.cost), [480, 960]);   // 8h x 60, then 8h x 120
  // per-use applies on the first scheduled day only -> 480 + 100 would be wrong because the new rate starts day 2
  assert.equal(tp.totalCost, 1440);
  assert.equal(plannedValueAt(p, s, tp, at(2026, 11, 10, 8)), 480);
  assert.equal(plannedValueAt(p, s, tp, at(2026, 11, 12, 8)), 1440);
});

test('levelling: two tasks on one person are serialised; lower priority moves; dependants follow', () => {
  const p = proj([T('A', 3), T('B', 3, { priority: 800 }), T('C', 1)], [{ pred: 'B', succ: 'C' }], {
    resources: [R('r')], assignments: [A('a', 'A', 'r'), A('b', 'B', 'r')],
  });
  const { project, report, network } = levelResources(p);
  const r = network.result();
  assert.deepEqual(report.unresolved, []);
  assert.equal(report.steps.length, 1);
  assert.equal(report.steps[0].taskId, 'A');                  // lower priority yields
  assert.equal(r.tasks.B.es, MON);
  assert.equal(r.tasks.A.es, r.tasks.B.ef === at(2026, 11, 11, 17) ? at(2026, 11, 12, 8) : r.tasks.A.es);
  assert.equal(r.tasks.A.es, at(2026, 11, 12, 8));
  assert.equal(r.drivers.A.kind, 'LEVELING');
  assert.ok(report.finishAfter >= report.finishBefore);
  assert.equal(project.tasks.find((t) => t.id === 'A')!.levelingDelayMin, 3 * D);
});

test('levelling: priority 1000 is never delayed, and the conflict is reported when both are 1000', () => {
  const p = proj([T('A', 2, { priority: 1000 }), T('B', 2, { priority: 1000 })], [], { resources: [R('r')], assignments: [A('a', 'A', 'r'), A('b', 'B', 'r')] });
  const { report } = levelResources(p);
  assert.equal(report.steps.length, 0);
  assert.equal(report.unresolved.length, 1);
  assert.equal(report.unresolved[0].reason, 'NO_MOVABLE_TASK');
});

test('levelling: withinFloatOnly keeps the finish; otherwise the finish may slip', () => {
  const p = proj([T('A', 2), T('B', 2), T('LONG', 10)], [], { resources: [R('r')], assignments: [A('a', 'A', 'r'), A('b', 'B', 'r')] });
  const within = levelResources(p, { withinFloatOnly: true });
  assert.equal(within.report.finishAfter, within.report.finishBefore);
  assert.deepEqual(within.report.unresolved, []);
  const p2 = proj([T('A', 5), T('B', 5)], [], { resources: [R('r')], assignments: [A('a', 'A', 'r'), A('b', 'B', 'r')] });
  const strict = levelResources(p2, { withinFloatOnly: true });
  assert.equal(strict.report.unresolved[0].reason, 'WOULD_EXCEED_FLOAT');
  assert.equal(levelResources(p2).report.finishAfter, at(2026, 11, 20, 17));
});

test('levelling: capacity 2 allows two concurrent, delays the third', () => {
  const p = proj([T('A', 2), T('B', 2), T('C', 2)], [], { resources: [R('team', 2)], assignments: [A('a', 'A', 'team'), A('b', 'B', 'team'), A('c', 'C', 'team')] });
  const { network, report } = levelResources(p);
  assert.equal(report.steps.length, 1);
  const es = ['A', 'B', 'C'].map((id) => network.result().tasks[id].es).sort((x, y) => x - y);
  assert.deepEqual(es, [MON, MON, at(2026, 11, 11, 8)]);
});

test('levelling property: afterwards no resource is over-allocated unless reported unresolved; deterministic; idempotent', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const r = rng(seed);
    const n = 12;
    const tasks = Array.from({ length: n }, (_, i) => T(`t${i}`, 1 + Math.floor(r() * 3), { priority: [300, 500, 500, 700][Math.floor(r() * 4)] }));
    const links = Array.from({ length: 6 }, () => { const a = Math.floor(r() * (n - 1)); return { pred: `t${a}`, succ: `t${a + 1 + Math.floor(r() * (n - 1 - a))}` }; });
    const asg = tasks.map((t, i) => A(`a${i}`, t.id, `r${Math.floor(r() * 2)}`, r() < 0.8 ? 1 : 0.5));
    const p: ProjectIn = proj(tasks, links, { resources: [R('r0'), R('r1')], assignments: asg });
    const one = levelResources(p), two = levelResources(p);
    assert.deepEqual(one.report.delays, two.report.delays, 'deterministic');
    assert.deepEqual(one.report.unresolved, []);
    // independent check of capacity at every working minute-boundary
    const res = one.network.result();
    for (const rid of ['r0', 'r1']) {
      const pts = new Set<number>();
      for (const a of asg.filter((x) => x.resourceId === rid)) { pts.add(res.tasks[a.taskId].es); }
      for (const t of pts) {
        let load = 0;
        for (const a of asg.filter((x) => x.resourceId === rid)) {
          const o = res.tasks[a.taskId];
          if (o.es <= t && t < o.ef && new Date(t).getUTCHours() !== 12) load += a.units;
        }
        assert.ok(load <= 1 + 1e-9, `seed ${seed} ${rid} load ${load} at ${new Date(t).toISOString()}`);
      }
    }
    const again = levelResources(one.project, { clearFirst: false });
    assert.equal(again.report.steps.length, 0, 'idempotent');
  }
});

test('levelling regression: a predecessor linked SS to its contender is never the one delayed (livelock fix); always converges', () => {
  const p = proj([T('P', 2, { priority: 100 }), T('S', 2)], [{ pred: 'P', succ: 'S', type: 'SS' }], { resources: [R('r')], assignments: [A('a', 'P', 'r'), A('b', 'S', 'r')] });
  const { report, network } = levelResources(p);
  assert.equal(report.converged, true);
  assert.equal(report.steps.length, 1);
  assert.equal(report.steps[0].taskId, 'S');                       // P has lower priority but delaying it would drag S
  assert.ok(network.result().tasks.S.es >= network.result().tasks.P.ef);
  // many random dense networks: must converge without hitting the iteration cap
  for (let seed = 1; seed <= 25; seed++) {
    const r = rng(seed);
    const n = 30;
    const tasks = Array.from({ length: n }, (_, i) => T(`t${i}`, 1 + Math.floor(r() * 3)));
    const links = Array.from({ length: 25 }, () => { const a = Math.floor(r() * (n - 1)); return { pred: `t${a}`, succ: `t${a + 1 + Math.floor(r() * (n - 1 - a))}`, type: (['FS', 'SS', 'FF'] as const)[Math.floor(r() * 3)] }; });
    const asg = tasks.map((t, i) => A(`a${i}`, t.id, `r${Math.floor(r() * 3)}`));
    const out = levelResources(proj(tasks, links, { resources: [R('r0'), R('r1'), R('r2')], assignments: asg }));
    assert.equal(out.report.converged, true, `seed ${seed}`);
  }
});
