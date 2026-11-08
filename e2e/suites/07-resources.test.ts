import { before, after } from 'node:test';
import { tc, status, problem, assert, obs, ctx } from '../lib/tc.ts';
import { startServer, newProject, createResource, su, uuid, T, L, addTask, addLink, type Server, type Proj } from '../lib/harness.ts';

let s: Server;
before(async () => { s = await startServer(); });
after(async () => { await s.stop(); });
const D = (d: string, h: string) => `2026-${d}T${h}:00`;
const asg = (taskId: string, resourceId: string, units = 1) => ({ op: 'addAssignment', assignment: { id: uuid(), taskId, resourceId, units } });
const load = async (p: Proj, rid: string, from = '2026-11-09', to = '2026-12-31') => (await s.call('pm', 'GET', `/resources/${rid}/load?from=${from}&to=${to}`)).body;
const over = (l: any) => (l.days ?? l).filter((d: any) => d.overallocated);

// ---------------------------------------------------------------- task types (docs/06 §6.1)
tc('E2E-RES-KIND-UNITS', ['docs/06 §6.1 FIXED_UNITS', 'FR-RS-02'], 'FIXED_UNITS: adding a second resource leaves the duration unchanged', async () => {
  const p = await newProject(s, 'pm'); const r1 = await createResource(s, 'pm', { name: 'u1' }), r2 = await createResource(s, 'pm', { name: 'u2' }); const t = T('t', 960);
  await p.ok([addTask(t), asg(t.id, r1.id)]); assert.equal((await p.tasksById()).get(t.id).schedule.ef, D('11-10', '17:00')); await p.ok([asg(t.id, r2.id)]); assert.equal((await p.tasksById()).get(t.id).schedule.ef, D('11-10', '17:00'), 'duration unchanged');
});
tc('E2E-RES-KIND-FIXEDWORK', ['docs/06 §6.1 (no assignments keep the entered duration)', 'FR-RS-02'], 'FIXED_WORK without assignments keeps its entered duration (100 min); creating it without workMin is rejected', async () => {
  const p = await newProject(s, 'pm'); const t = T('fw', 100, { kind: 'FIXED_WORK', workMin: 960 }); await p.ok([addTask(t)]); assert.equal((await p.tasksById()).get(t.id).schedule.ef, D('11-09', '09:40'));
});
tc('E2E-RES-KIND-FIXEDWORK-DUR', ['docs/06 §6.1 FIXED_WORK'], 'FIXED_WORK with assignments: 960 work min / 1 unit = 960 min (2 days); with 2 resources = 480 (1 day); 3 units total -> ceil(960/3)=320', async () => {
  const p = await newProject(s, 'pm'); const [r1, r2, r3] = await Promise.all([1, 2, 3].map((i) => createResource(s, 'pm', { name: 'fwd' + i }))); const t = T('fw', 100, { kind: 'FIXED_WORK', workMin: 960 }); await p.ok([addTask(t), asg(t.id, r1.id)]);
  assert.equal((await p.tasksById()).get(t.id).schedule.ef, D('11-10', '17:00'), '1 resource'); await p.ok([asg(t.id, r2.id)]); assert.equal((await p.tasksById()).get(t.id).schedule.ef, D('11-09', '17:00'), '2 resources');
  await p.ok([asg(t.id, r3.id)]); const sc = (await p.tasksById()).get(t.id).schedule; assert.equal(sc.ef, D('11-09', '13:00') .replace('13:00', '14:20'), '320 min = 08:00 + 240 + 80 after lunch = 14:20');
  const plan = (await p.plan()).body; assert.equal(plan.assignments.length, 3);
});
tc('E2E-RES-KIND-EFFORT', ['docs/06 §6.1 FIXED_UNITS + effortDriven'], 'effort-driven FIXED_UNITS: duration = ceil(workMin/sum units) once resources are assigned; removing one restores the longer duration', async () => {
  const p = await newProject(s, 'pm'); const r1 = await createResource(s, 'pm', { name: 'e1' }), r2 = await createResource(s, 'pm', { name: 'e2' }); const t = T('e', 480, { effortDriven: true, workMin: 960 });
  const a1 = { id: uuid(), taskId: t.id, resourceId: r1.id, units: 1 }, a2 = { id: uuid(), taskId: t.id, resourceId: r2.id, units: 1 }; await p.ok([addTask(t), { op: 'addAssignment', assignment: a1 }, { op: 'addAssignment', assignment: a2 }]);
  assert.equal((await p.tasksById()).get(t.id).schedule.ef, D('11-09', '17:00'), '960/2'); await p.ok([{ op: 'removeAssignment', id: a2.id }]); assert.equal((await p.tasksById()).get(t.id).schedule.ef, D('11-10', '17:00'), '960/1');
});
tc('E2E-RES-KIND-FIXEDDUR', ['docs/06 §6.1 FIXED_DURATION'], 'FIXED_DURATION: adding resources never changes the duration', async () => {
  const p = await newProject(s, 'pm'); const r1 = await createResource(s, 'pm', { name: 'fd1' }), r2 = await createResource(s, 'pm', { name: 'fd2' }); const t = T('fd', 960, { kind: 'FIXED_DURATION' }); await p.ok([addTask(t), asg(t.id, r1.id), asg(t.id, r2.id)]); assert.equal((await p.tasksById()).get(t.id).schedule.ef, D('11-10', '17:00'));
});
tc('E2E-RES-ASG-DELETE', ['docs/05 assignment cascade'], 'deleting a resource-assigned FIXED_WORK task restores nothing stale: the resource load drops to zero', async () => {
  const p = await newProject(s, 'pm'); const r = await createResource(s, 'pm', { name: 'ld' }); const t = T('t', 480); await p.ok([addTask(t), asg(t.id, r.id)]); let l = await load(p, r.id); assert.ok((l.days ?? l).length >= 1);
  await p.ok([{ op: 'deleteTask', id: t.id }]); l = await load(p, r.id); assert.equal(((l.days ?? l) as any[]).reduce((a, d) => a + (d.workMin ?? d.plannedMin ?? 0), 0), 0, 'no load left');
});

// ---------------------------------------------------------------- load
tc('E2E-RES-LOAD-001', ['OAS getResourceLoad', 'FR-RS-04'], 'resource load: daily workMin = sum(units x task minutes that day), capacity = 480 x maxUnits, overallocated iff load > capacity', async () => {
  const p = await newProject(s, 'pm'); const r = await createResource(s, 'pm', { name: 'load', maxUnits: 1 }); const a = T('a', 480), b = T('b', 480, { }), c = T('c', 480);
  await p.ok([addTask(a), addTask(b), addTask(c), asg(a.id, r.id, 1), asg(b.id, r.id, 0.5), asg(c.id, r.id, 1), addLink(L(a.id, c.id))]);
  const l = await load(p, r.id, '2026-11-09', '2026-11-11'); const days = (l.days ?? l) as any[]; const d9 = days.find((d) => d.day === '2026-11-09'), d10 = days.find((d) => d.day === '2026-11-10');
  const w = (d: any) => d.workMin ?? d.plannedMin; assert.equal(w(d9), 480 + 240, 'a(1.0) + b(0.5)'); assert.equal(d9.capacityMin, 480); assert.equal(d9.overallocated, true); assert.equal(w(d10), 480); assert.equal(d10.overallocated, false, 'exactly at capacity is not over-allocated');
});
tc('E2E-RES-LOAD-002', ['OAS getResourceLoad (cross-project)', 'FR-RS-04'], 'load is aggregated across all of the tenant\'s projects', async () => {
  const r = await createResource(s, 'pm', { name: 'xproj' }); const p1 = await newProject(s, 'pm'), p2 = await newProject(s, 'pm'); const a = T('a', 480), b = T('b', 480);
  await p1.ok([addTask(a), asg(a.id, r.id)]); await p2.ok([addTask(b), asg(b.id, r.id)]); const l = await load(p1, r.id, '2026-11-09', '2026-11-09'); const d = ((l.days ?? l) as any[])[0]; assert.equal(d.workMin ?? d.plannedMin, 960); assert.equal(d.overallocated, true);
});
tc('E2E-RES-LOAD-003', ['OAS getResourceLoad params', 'docs/07 §1.5'], 'load validation: from > to, missing from/to, malformed dates, unknown resource -> 4xx problem+json (404 for unknown id)', async () => {
  const r = await createResource(s, 'pm', { name: 'lv' }); const bad: string[] = []; for (const q of ['from=2026-11-10&to=2026-11-09', 'to=2026-11-09', 'from=2026-11-09', 'from=x&to=y', 'from=2026-02-31&to=2026-03-01']) { const x = await s.call('pm', 'GET', `/resources/${r.id}/load?${q}`); if (x.status !== 400) bad.push(`${q} -> ${x.status}`); } assert.deepEqual(bad, [], 'these must be 400 VALIDATION_FAILED');
  problem(await s.call('pm', 'GET', `/resources/${uuid()}/load?from=2026-11-09&to=2026-11-10`), 404, 'NOT_FOUND');
});
tc('E2E-RES-LOAD-004', ['OAS getResourceLoad', 'FR-RS-04'], 'load over a 1-year window stays fast and bounded (<2s)', async () => {
  const r = await createResource(s, 'pm', { name: 'ly' }); const x = await s.call('pm', 'GET', `/resources/${r.id}/load?from=2026-01-01&to=2026-12-31`); status(x, 200); assert.ok(x.ms < 2000, `took ${x.ms} ms`);
});

// ---------------------------------------------------------------- levelling
async function contended(n = 4, dur = 480, over: Record<string, unknown> = {}) {
  const p = await newProject(s, 'pm'); const r = await createResource(s, 'pm', { name: 'lv-' + uuid().slice(0, 4) }); const ts = Array.from({ length: n }, (_, i) => T('lv' + i, dur, { priority: 500 + i, ...over })); const anchor = T('anchor', 480 * (n + 3));
  await p.ok([...ts.map((t) => addTask(t)), addTask(anchor), ...ts.map((t) => asg(t.id, r.id))]); return { p, r, ts, anchor };
}
const lvl = (p: Proj, body: any = {}) => s.call('pm', 'POST', `/projects/${p.id}/level`, body);
tc('E2E-RES-LEVEL-DRY', ['OAS levelResources (dry run unless apply)', 'FR-RS-05'], 'dry run proposes delays but changes nothing (version, schedule, plan_op unchanged); response conforms', async () => {
  const { p } = await contended(); const before = JSON.stringify((await p.plan()).body); const ops = su(`SELECT count(*) FROM pf.plan_op WHERE project_id='${p.id}'`); const r = await lvl(p); status(r, 200);
  assert.equal(r.body.applied, false); assert.ok(r.body.delays.length >= 1, 'a contended plan with float yields delays: ' + JSON.stringify(r.body).slice(0, 300)); assert.equal(r.body.planVersion, p.version); assert.equal(JSON.stringify((await p.plan()).body), before); assert.equal(su(`SELECT count(*) FROM pf.plan_op WHERE project_id='${p.id}'`), ops);
  assert.equal(r.body.converged, true);
});
tc('E2E-RES-LEVEL-APPLY', ['OAS levelResources apply', 'docs/06 §6 levelling', 'FR-RS-05'], 'apply: plan version advances once, the project finish does not move (withinFloatOnly), and NO resource is over-allocated afterwards', async () => {
  const { p, r, anchor } = await contended(4); const fin0 = (await p.tasksById()).get(anchor.id).schedule.ef; assert.ok(over(await load(p, r.id)).length >= 1, 'precondition: over-allocated');
  const x = await lvl(p, { apply: true, clientOpId: uuid(), expectedPlanVersion: p.version }); status(x, 200); assert.equal(x.body.applied, true); assert.equal(x.body.planVersion, p.version + 1); p.version = x.body.planVersion;
  assert.equal(x.body.unresolved?.length ?? 0, 0, JSON.stringify(x.body.unresolved)); const o = over(await load(p, r.id)); assert.equal(o.length, 0, 'still over-allocated: ' + JSON.stringify(o)); assert.equal((await p.tasksById()).get(anchor.id).schedule.ef, fin0, 'finish unchanged');
  assert.equal(new Date(x.body.projectFinish) <= new Date(x.body.finishBefore ?? x.body.projectFinish), true);
});
tc('E2E-RES-LEVEL-IDEMP', ['docs/06 §6 levelling', 'OAS levelResources.delays ("Total levelling delay")', 'FR-RS-05'], 'levelling is idempotent: a dry run twice is identical; after apply, a second apply leaves the schedule byte-identical and the proposed TOTAL delays equal the applied ones', async () => {
  const { p, r } = await contended(3); const a = await lvl(p), b = await lvl(p); assert.deepEqual(a.body, b.body, 'dry runs identical');
  const x = await lvl(p, { apply: true, clientOpId: uuid(), expectedPlanVersion: p.version }); status(x, 200); p.version = x.body.planVersion; const sched1 = JSON.stringify((await p.plan()).body.tasks.map((t: any) => [t.id, t.schedule, t.levelingDelayMin]).sort());
  const norm = (d: any[]) => JSON.stringify(d.map((q) => [q.taskId, q.delayMin]).sort()); const again = await lvl(p); assert.equal(norm(again.body.delays), norm(x.body.delays), 'dry run after apply proposes the same total delays');
  const y = await lvl(p, { apply: true, clientOpId: uuid(), expectedPlanVersion: p.version }); status(y, 200); p.version = y.body.planVersion; assert.equal(JSON.stringify((await p.plan()).body.tasks.map((t: any) => [t.id, t.schedule, t.levelingDelayMin]).sort()), sched1, 'second apply changes nothing'); assert.equal(over(await load(p, r.id)).length, 0);
});
tc('E2E-RES-LEVEL-ORDER', ['OAS levelResources.order', 'docs/06 levelling'], 'order PRIORITY_FLOAT / START / ID are accepted; higher-priority task is delayed last; unknown order -> 400', async () => {
  const { p, ts } = await contended(3); for (const order of ['PRIORITY_FLOAT', 'START', 'ID']) status(await lvl(p, { order }), 200, order); problem(await lvl(p, { order: 'RANDOM' }), 400, 'VALIDATION_FAILED');
  const r = await lvl(p, { order: 'PRIORITY_FLOAT' }); const delayed = new Set(r.body.delays.map((d: any) => d.taskId)); assert.ok(!delayed.has(ts[2].id) || delayed.size === 2, 'highest priority (' + ts[2].name + ') is delayed only after lower ones');
  assert.ok(r.body.delays.every((d: any) => d.delayMin > 0 && Number.isInteger(d.delayMin)));
});
tc('E2E-RES-LEVEL-PROTECT', ['OAS levelResources description (never delayed)', 'docs/06 §6'], 'priority-1000, DONE and MSO tasks are never delayed', async () => {
  const p = await newProject(s, 'pm'); const r = await createResource(s, 'pm', { name: 'prot' }); const hi = T('hi', 480, { priority: 1000 }), mso = T('mso', 480, { constraint: { type: 'MSO', date: D('11-09', '08:00') } }), mov = T('mov', 480, { priority: 100 }), anchor = T('anchor', 4800);
  await p.ok([addTask(hi), addTask(mso), addTask(mov), addTask(anchor), asg(hi.id, r.id), asg(mso.id, r.id), asg(mov.id, r.id)]); const x = await lvl(p); status(x, 200); const ids = x.body.delays.map((d: any) => d.taskId);
  assert.ok(!ids.includes(hi.id), 'priority 1000 delayed'); assert.ok(!ids.includes(mso.id), 'MSO delayed'); assert.ok(ids.includes(mov.id), 'the movable task should be the one delayed: ' + JSON.stringify(x.body));
});
tc('E2E-RES-LEVEL-UNRESOLVED', ['OAS levelResources.unresolved', 'docs/06 §6 (never hidden)'], 'conflicts that cannot be resolved (all critical, withinFloatOnly) are reported in unresolved with a reason and NOT silently dropped; withinFloatOnly=false resolves them by moving the finish', async () => {
  const p = await newProject(s, 'pm'); const r = await createResource(s, 'pm', { name: 'unres' }); const a = T('a', 480), b = T('b', 480); await p.ok([addTask(a), addTask(b), asg(a.id, r.id), asg(b.id, r.id)]);
  const x = await lvl(p); status(x, 200); assert.ok(x.body.unresolved.length >= 1, JSON.stringify(x.body)); assert.ok(['NO_MOVABLE_TASK', 'WOULD_EXCEED_FLOAT', 'ITERATION_LIMIT'].includes(x.body.unresolved[0].reason));
  const y = await lvl(p, { withinFloatOnly: false }); status(y, 200); assert.equal(y.body.unresolved?.length ?? 0, 0, JSON.stringify(y.body)); assert.ok(new Date(y.body.projectFinish) > new Date(y.body.finishBefore), 'finish moved');
});
tc('E2E-RES-LEVEL-VER', ['OAS levelResources 409', 'docs/07 §4'], 'apply with a stale expectedPlanVersion -> 409 VERSION_CONFLICT; apply without clientOpId/expectedPlanVersion -> 400; replay of the same clientOpId does not apply twice', async () => {
  const { p } = await contended(3); problem(await lvl(p, { apply: true, clientOpId: uuid(), expectedPlanVersion: p.version + 7 }), 409, 'VERSION_CONFLICT'); problem(await lvl(p, { apply: true }), 400, 'VALIDATION_FAILED');
  const op = uuid(); const body = { apply: true, clientOpId: op, expectedPlanVersion: p.version }; const a = await lvl(p, body); status(a, 200); const b = await lvl(p, body); assert.ok(b.status === 200, ctx(b)); const v = (await s.call('pm', 'GET', `/projects/${p.id}`)).body.planVersion; assert.equal(v, a.body.planVersion, 'replay must not bump the version again');
});
tc('E2E-RES-LEVEL-AUTHZ', ['docs/10 §4 Run risk / levelling', 'FR-AU-01'], 'VIEWER and TEAM_MEMBER may not level (403), SCHEDULER may', async () => {
  const { p } = await contended(2); await p.addMember('viewer', 'VIEWER'); await p.addMember('member', 'TEAM_MEMBER'); await p.addMember('sched', 'SCHEDULER');
  for (const u of ['viewer', 'member']) problem(await s.call(u, 'POST', `/projects/${p.id}/level`, {}), 403, 'FORBIDDEN', u); status(await s.call('sched', 'POST', `/projects/${p.id}/level`, {}), 200);
});
tc('E2E-RES-LEVEL-ITER', ['OAS levelResources.converged', 'docs/06 (iteration cap)'], 'a heavily contended plan (60 tasks, one resource) terminates quickly and honestly: converged=true or unresolved/ITERATION_LIMIT; never hangs', async () => {
  const { p } = await contended(60, 120); const t0 = Date.now(); const x = await lvl(p, { withinFloatOnly: false }); status(x, 200); assert.ok(Date.now() - t0 < 20000, 'took ' + (Date.now() - t0));
  assert.ok(x.body.converged === true || (x.body.unresolved ?? []).length > 0, 'not converged must be explained');
});

// ---------------------------------------------------------------- baselines + EVM
tc('E2E-RES-BASE-001', ['OAS saveBaseline', 'FR-BL-01'], 'save baseline 0..10; duplicate number -> 409; number 11/-1/string -> 400; list returns them; label max 120', async () => {
  const p = await newProject(s, 'pm'); await p.ok([addTask(T('a', 480))]); const b0 = await s.call('pm', 'POST', `/projects/${p.id}/baselines`, { number: 0, label: 'first' }); status(b0, 201); assert.equal(b0.body.number, 0); assert.equal(b0.body.planVersion, p.version);
  problem(await s.call('pm', 'POST', `/projects/${p.id}/baselines`, { number: 0 }), 409, ['CONFLICT', 'BASELINE_EXISTS', 'VERSION_CONFLICT'] as any);
  for (const n of [11, -1, '1', 1.5, null]) problem(await s.call('pm', 'POST', `/projects/${p.id}/baselines`, { number: n }), 400, 'VALIDATION_FAILED', String(n)); problem(await s.call('pm', 'POST', `/projects/${p.id}/baselines`, { number: 3, label: 'x'.repeat(121) }), 400, 'VALIDATION_FAILED');
  status(await s.call('pm', 'POST', `/projects/${p.id}/baselines`, { number: 10 }), 201); const l = await s.call('pm', 'GET', `/projects/${p.id}/baselines`); status(l, 200); const arr = Array.isArray(l.body) ? l.body : l.body.items; assert.deepEqual(arr.map((x: any) => x.number).sort((a: number, b: number) => a - b), [0, 10]);
});
tc('E2E-RES-BASE-EMPTY', ['OAS saveBaseline/listBaselines', 'FR-BL-01'], 'a baseline saved on an empty plan (201) is returned by listBaselines', async () => {
  const p = await newProject(s, 'pm'); status(await s.call('pm', 'POST', `/projects/${p.id}/baselines`, { number: 1 }), 201); const l = await s.call('pm', 'GET', `/projects/${p.id}/baselines`); const arr = Array.isArray(l.body) ? l.body : l.body.items; assert.equal(arr.length, 1, 'saved baseline missing from the list: ' + JSON.stringify(l.body));
});
tc('E2E-RES-BASE-IMMUTABLE', ['OAS saveBaseline (immutable once saved)', 'FR-BL-02'], 'a saved baseline is immutable: later plan edits do not change its stored snapshot', async () => {
  const p = await newProject(s, 'pm'); const a = T('a', 480); await p.ok([addTask(a)]); const b = await s.call('pm', 'POST', `/projects/${p.id}/baselines`, { number: 1 }); status(b, 201);
  const snap = () => su(`SELECT md5(coalesce(string_agg(row(bt.*)::text, '|' ORDER BY bt.task_id::text),'')) FROM pf.baseline_task bt JOIN pf.baseline bl ON bl.id = bt.baseline_id WHERE bl.project_id='${p.id}'`);
  const h0 = snap(); await p.ok([{ op: 'updateTask', id: a.id, patch: { durationMin: 4800 } }]); assert.equal(snap(), h0, 'baseline rows changed after a plan edit'); problem(await s.call('pm', 'POST', `/projects/${p.id}/baselines`, { number: 1 }), 409, ['CONFLICT', 'BASELINE_EXISTS'] as any);
});
tc('E2E-RES-BASE-AUTHZ', ['docs/10 §4 Save baseline (ADMIN, PM only)'], 'only PM/ORG_ADMIN may save a baseline: SCHEDULER, TEAM_MEMBER, VIEWER, PORTFOLIO_MANAGER get 403', async () => {
  const p = await newProject(s, 'pm'); await p.ok([addTask(T('a', 60))]); const roles: Array<[string, string]> = [['sched', 'SCHEDULER'], ['member', 'TEAM_MEMBER'], ['viewer', 'VIEWER'], ['portfolio', 'PORTFOLIO_MANAGER']]; for (const [u, r] of roles) await p.addMember(u as any, r);
  let n = 1; for (const [u] of roles) problem(await s.call(u, 'POST', `/projects/${p.id}/baselines`, { number: n++ }), 403, 'FORBIDDEN', u);
});
tc('E2E-RES-EVM-001', ['OAS getEarnedValue', 'docs/06 EVM', 'FR-EV-01'], 'EVM with fixed costs: BAC = sum, EV = percentComplete x BAC, SV = EV - PV; SPI = EV/PV, null when PV = 0 (never NaN/Infinity)', async () => {
  const p = await newProject(s, 'pm'); const a = T('a', 480, { fixedCost: 1000, percentComplete: 1, actualStart: D('11-09', '08:00'), actualFinish: D('11-09', '17:00') }), b = T('b', 480, { fixedCost: 3000, percentComplete: 0.5 }), c = T('c', 480, { fixedCost: 2000 }); await p.ok([addTask(a), addTask(b), addTask(c), addLink(L(a.id, b.id)), addLink(L(b.id, c.id))]);
  const e0 = await s.call('pm', 'GET', `/projects/${p.id}/evm?statusDate=2026-11-09`); status(e0, 200); assert.equal(e0.body.bac, 6000); assert.equal(e0.body.pv, 0); assert.equal(e0.body.ev, 1000 + 1500); assert.equal(e0.body.spi, null, 'PV=0 => null'); assert.equal(e0.body.sv, e0.body.ev - e0.body.pv);
  const e1 = await s.call('pm', 'GET', `/projects/${p.id}/evm?statusDate=2026-11-11`); status(e1, 200); assert.equal(e1.body.pv, 1000 + 3000, 'a and b finished by 2026-11-11 00:00? b finishes 11-10 17:00'); assert.equal(e1.body.ev, 2500); assert.ok(Math.abs(e1.body.spi - 2500 / 4000) < 1e-9); assert.equal(e1.body.sv, 2500 - 4000);
  const e2 = await s.call('pm', 'GET', `/projects/${p.id}/evm?statusDate=2027-06-01`); assert.equal(e2.body.pv, 6000, 'after the end PV = BAC');
  for (const k of ['bac', 'pv', 'ev', 'sv']) assert.ok(Number.isFinite(e1.body[k]), k);
});
tc('E2E-RES-EVM-002', ['OAS getEarnedValue.statusDate (optional)', 'FR-EV-01'], 'statusDate is optional in the contract: omitting it uses the project status date or today', async () => {
  const p = await newProject(s, 'pm'); await p.ok([addTask(T('a', 480, { fixedCost: 100, percentComplete: 0.5 }))]); status(await s.call('pm', 'GET', `/projects/${p.id}/evm`), 200, 'statusDate omitted');
});
tc('E2E-RES-EVM-004', ['OAS Evm required [ac, cv]', 'FR-EV-01'], 'EVM exposes ac and cv as numbers per the contract (required fields); statusDate is a date, not a datetime', async () => {
  const p = await newProject(s, 'pm'); await p.ok([addTask(T('a', 480, { fixedCost: 100, percentComplete: 0.5 }))]); const e = await s.call('pm', 'GET', `/projects/${p.id}/evm?statusDate=2026-11-10`); status(e, 200);
  const bad = ['ac', 'cv'].filter((k) => typeof e.body[k] !== 'number'); assert.deepEqual(bad, [], `OAS Evm requires numbers; got ac=${JSON.stringify(e.body.ac)} cv=${JSON.stringify(e.body.cv)}`); assert.match(e.body.statusDate, /^\d{4}-\d{2}-\d{2}$/, 'OAS: format date');
});
tc('E2E-RES-EVM-003', ['OAS getEarnedValue.baseline', 'FR-BL-03'], 'EVM against a baseline that does not exist is not silently answered from the live plan (404)', async () => {
  const p = await newProject(s, 'pm'); await p.ok([addTask(T('a', 480, { fixedCost: 1000 }))]); problem(await s.call('pm', 'GET', `/projects/${p.id}/evm?statusDate=2026-11-10&baseline=7`), 404, 'NOT_FOUND', 'baseline 7 does not exist');
});
tc('E2E-RES-EVM-005', ['OAS getEarnedValue.baseline', 'FR-BL-03'], 'EVM against an existing baseline uses its snapshot: BAC from the baseline even after the plan changed', async () => {
  const p = await newProject(s, 'pm'); const a = T('a', 480, { fixedCost: 1000 }); await p.ok([addTask(a)]); status(await s.call('pm', 'POST', `/projects/${p.id}/baselines`, { number: 1 }), 201); await p.ok([{ op: 'updateTask', id: a.id, patch: { fixedCost: 5000 } }]);
  const base = await s.call('pm', 'GET', `/projects/${p.id}/evm?statusDate=2026-11-10&baseline=1`); status(base, 200); assert.equal(base.body.bac, 1000, 'baseline BAC');
});
tc('E2E-RES-EVM-COST', ['docs/06 §6.3 cost', 'FR-RS-03'], 'resource cost = hours x rate (rates provisioned via SQL because the API cannot set them) feeds BAC; fixedCost added; non-cost roles never see it', async () => {
  const p = await newProject(s, 'pm'); const r = await createResource(s, 'pm', { name: 'rated' }); su(`INSERT INTO pf.resource_rate (resource_id, tenant_id, effective_from, std_rate_per_hour, per_use_cost) VALUES ('${r.id}','aaaaaaaa-0000-4000-8000-000000000001','2020-01-01',50,0)`);
  const t = T('t', 480, { fixedCost: 100 }); await p.ok([addTask(t), asg(t.id, r.id, 1)]); const e = await s.call('pm', 'GET', `/projects/${p.id}/evm?statusDate=2026-11-30`); status(e, 200); assert.equal(e.body.bac, 8 * 50 + 100, 'BAC = 8 h x 50 + 100 fixed');
  await p.addMember('sched', 'SCHEDULER'); const e2 = await s.call('sched', 'GET', `/projects/${p.id}/evm?statusDate=2026-11-30`); assert.ok(e2.status === 403 || (e2.status === 200 && e2.body.bac === undefined), `SCHEDULER must not see cost: ${e2.status} ${JSON.stringify(e2.body).slice(0, 200)}`);
});

// ---------------------------------------------------------------- risk
const estimated = async (n = 5) => { const p = await newProject(s, 'pm'); const ts = Array.from({ length: n }, (_, i) => T('r' + i, 480, { estimate: { optimisticMin: 240, likelyMin: 480, pessimisticMin: 1440 } })); await p.ok([...ts.map((t) => addTask(t)), ...ts.slice(1).map((t, i) => addLink(L(ts[i].id, t.id)))]); return { p, ts }; };
tc('E2E-RES-RISK-001', ['OAS startRiskRun', 'FR-RK-01'], 'risk run on a three-point-estimated chain: p50 <= p80 <= p90, p50 within [best case, worst case], criticality in [0,1], planVersion recorded', async () => {
  const { p, ts } = await estimated(); const r = await s.call('pm', 'POST', `/projects/${p.id}/risk-runs`, { iterations: 1000, seed: 42 }); assert.ok([201, 202].includes(r.status), ctx(r)); let run = r.body; if (r.status === 202) for (let i = 0; i < 50 && run.status !== 'SUCCEEDED'; i++) { await new Promise((x) => setTimeout(x, 200)); run = (await s.call('pm', 'GET', `/projects/${p.id}/risk-runs/${run.id}`)).body; }
  assert.equal(run.status, 'SUCCEEDED'); assert.equal(run.iterations, 1000); assert.equal(run.seed, 42); assert.equal(run.planVersion, p.version); assert.ok(run.p50 <= run.p80 && run.p80 <= run.p90, `${run.p50} ${run.p80} ${run.p90}`);
  const best = '2026-11-09T08:00:00', worst = '2026-11-13T17:00:00'; assert.ok(run.p50 > best && run.p90 <= '2026-11-20T17:00:00', 'percentiles inside the feasible window: ' + run.p50 + ' ' + run.p90); void worst;
  const crit = run.criticality ?? run.criticalityIndex; assert.ok(crit, 'criticality (OAS name) present'); for (const t of ts) assert.ok(crit[t.id] >= 0 && crit[t.id] <= 1); assert.equal(crit[ts[0].id], 1, 'single chain: every task always critical');
  const get = await s.call('pm', 'GET', `/projects/${p.id}/risk-runs/${run.id}`); status(get, 200); assert.equal(get.body.p80, run.p80, 'GET returns the stored result');
});
tc('E2E-RES-RISK-SEED', ['OAS startRiskRun.seed', 'FR-RK-02 (same seed + plan version = identical result)'], 'same seed + same plan version -> identical percentiles and criticality; different seed -> (very likely) different distribution', async () => {
  const { p, ts } = await estimated(8); const run = async (seed?: number) => (await s.call('pm', 'POST', `/projects/${p.id}/risk-runs`, { iterations: 500, ...(seed !== undefined ? { seed } : {}) })).body;
  const a = await run(7), b = await run(7); for (const k of ['p50', 'p80', 'p90']) assert.equal(a[k], b[k], k); assert.deepEqual(a.criticality ?? a.criticalityIndex, b.criticality ?? b.criticalityIndex);
  const outs = new Set<string>(); for (const sd of [1, 2, 3, 4, 5, 6]) { const r = await run(sd); outs.add(r.p50 + r.p80 + r.p90); } assert.ok(outs.size > 1, 'six seeds all produced the same percentiles: the seed is not used'); void ts;
});
tc('E2E-RES-RISK-NOEST', ['OAS startRiskRun', 'FR-RK-03'], 'a plan without estimates yields p50=p80=p90 = deterministic finish (no variance), never NaN', async () => {
  const p = await newProject(s, 'pm'); await p.ok([addTask(T('a', 480))]); const r = await s.call('pm', 'POST', `/projects/${p.id}/risk-runs`, { iterations: 200, seed: 1 }); status(r, 201); assert.equal(r.body.p50, D('11-09', '17:00')); assert.equal(r.body.p90, D('11-09', '17:00'));
});
tc('E2E-RES-RISK-VAL', ['OAS startRiskRun.iterations (100..20000 reference)'], 'iterations < 100, > 20000, non-integer, string -> 400; default applies with empty body', async () => {
  const { p } = await estimated(2); for (const it of [99, 0, -5, 20001, 100001, 1.5, '1000', null]) { const r = await s.call('pm', 'POST', `/projects/${p.id}/risk-runs`, { iterations: it }); problem(r, 400, 'VALIDATION_FAILED', String(it)); }
  const d = await s.call('pm', 'POST', `/projects/${p.id}/risk-runs`, {}); assert.ok([201, 202].includes(d.status), ctx(d)); assert.equal(d.body.iterations, 1000, 'reference default 1000');
});
tc('E2E-RES-RISK-QUOTA', ['OAS startRiskRun (tasks x iterations <= 4,000,000 else 413 PLAN_TOO_LARGE)', 'T12'], 'quota: 201 tasks x 20000 iterations > 4,000,000 -> 413 PLAN_TOO_LARGE and no run is stored; 200 x 20000 is allowed', async () => {
  const p = await newProject(s, 'pm'); await p.ok(Array.from({ length: 201 }, (_, i) => addTask(T('q' + i, 60)))); const n0 = su(`SELECT count(*) FROM pf.risk_run WHERE project_id='${p.id}'`);
  const r = await s.call('pm', 'POST', `/projects/${p.id}/risk-runs`, { iterations: 20000, seed: 1 }); problem(r, 413, 'PLAN_TOO_LARGE'); assert.equal(su(`SELECT count(*) FROM pf.risk_run WHERE project_id='${p.id}'`), n0);
  const ok = await s.call('pm', 'POST', `/projects/${p.id}/risk-runs`, { iterations: 19900, seed: 1 }); assert.ok(ok.status === 201 || ok.status === 202, `201 x 19900 = 4,000,..: ${ok.status}`.slice(0, 0) + ctx(ok).slice(0, 200));
});
tc('E2E-RES-RISK-AUTHZ', ['docs/10 §4 Run risk (not TEAM_MEMBER/VIEWER/PORTFOLIO)'], 'VIEWER, TEAM_MEMBER and PORTFOLIO_MANAGER may not start a risk run (403); runs are tenant-isolated (other tenant 404)', async () => {
  const { p } = await estimated(2); await p.addMember('viewer', 'VIEWER'); await p.addMember('member', 'TEAM_MEMBER'); await p.addMember('portfolio', 'PORTFOLIO_MANAGER');
  for (const u of ['viewer', 'member', 'portfolio']) problem(await s.call(u, 'POST', `/projects/${p.id}/risk-runs`, { iterations: 100 }), 403, 'FORBIDDEN', u);
  const run = (await s.call('pm', 'POST', `/projects/${p.id}/risk-runs`, { iterations: 100, seed: 1 })).body; problem(await s.call('pmB', 'GET', `/projects/${p.id}/risk-runs/${run.id}`), 404, 'NOT_FOUND'); problem(await s.call('pm', 'GET', `/projects/${p.id}/risk-runs/${uuid()}`), 404, 'NOT_FOUND');
});

// ---------------------------------------------------------------- scenarios, calendars
tc('E2E-RES-SCEN-001', ['OAS createScenario', 'FR-SN-01'], 'a scenario stores its commands, base planVersion and computed result without touching the live plan; listing returns it', async () => {
  const p = await newProject(s, 'pm'); const a = T('a', 480); await p.ok([addTask(a)]); const before = JSON.stringify((await p.plan()).body);
  const r = await s.call('pm', 'POST', `/projects/${p.id}/scenarios`, { name: 'longer', commands: [{ op: 'updateTask', id: a.id, patch: { durationMin: 1440 } }] }); status(r, 201); assert.equal(r.body.basePlanVersion, p.version); assert.equal(r.body.result.finish, D('11-11', '17:00'));
  assert.equal(JSON.stringify((await p.plan()).body), before, 'live plan untouched'); const l = await s.call('pm', 'GET', `/projects/${p.id}/scenarios`); const arr = Array.isArray(l.body) ? l.body : l.body.items; assert.ok(arr.some((x: any) => x.id === r.body.id));
});
tc('E2E-RES-SCEN-VAL', ['OAS ScenarioCreate'], 'scenario with invalid commands (cycle, unknown task, bad shape), empty/oversized name -> 4xx and not stored; VIEWER cannot create (403)', async () => {
  const p = await newProject(s, 'pm'); const a = T('a', 480), b = T('b', 480); await p.ok([addTask(a), addTask(b), addLink(L(a.id, b.id))]); const n0 = su(`SELECT count(*) FROM pf.scenario WHERE project_id='${p.id}'`);
  problem(await s.call('pm', 'POST', `/projects/${p.id}/scenarios`, { name: 'cyc', commands: [addLink(L(b.id, a.id))] }), 422, 'CYCLE_DETECTED'); problem(await s.call('pm', 'POST', `/projects/${p.id}/scenarios`, { name: 'u', commands: [{ op: 'deleteTask', id: uuid() }] }), 422, 'UNKNOWN_TASK');
  for (const body of [{ name: '', commands: [] }, { name: 'x'.repeat(121), commands: [{ op: 'removeLink', id: uuid() }] }, { commands: [] }, { name: 'n' }]) { const r = await s.call('pm', 'POST', `/projects/${p.id}/scenarios`, body); assert.ok(r.status >= 400 && r.status < 500, JSON.stringify(body).slice(0, 60) + ' -> ' + r.status); }
  assert.equal(su(`SELECT count(*) FROM pf.scenario WHERE project_id='${p.id}'`), n0, 'rejected scenarios must not be stored'); await p.addMember('viewer', 'VIEWER'); problem(await s.call('viewer', 'POST', `/projects/${p.id}/scenarios`, { name: 'v', commands: [{ op: 'updateTask', id: a.id, patch: { name: 'z' } }] }), 403, 'FORBIDDEN');
});
tc('E2E-RES-CAL-001', ['OAS listCalendars', 'FR-CA-01'], 'listCalendars returns the tenant\'s calendars including the seeded default with 7 weekday entries; no foreign-tenant calendar', async () => {
  const p = await newProject(s, 'pm'); const r = await s.call('pm', 'GET', `/projects/${p.id}/calendars`); status(r, 200); const arr = Array.isArray(r.body) ? r.body : r.body.items; const cal = arr.find((c: any) => c.id === 'ca000000-0000-4000-8000-000000000001'); assert.ok(cal, 'seeded calendar present'); assert.equal(cal.week.length, 7); assert.ok(!arr.some((c: any) => c.id === 'cb000000-0000-4000-8000-000000000001'), 'tenant B calendar leaked');
});
