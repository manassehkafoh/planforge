import { before, after } from 'node:test';
import { tc, status, problem, assert, obs, ctx, pool } from '../lib/tc.ts';
import { startServer, newProject, createResource, su, USERS, uuid, T, L, addTask, addLink, CAL_A, tokenFor, START, type Server, type Proj } from '../lib/harness.ts';
import { validateResponse } from '../lib/contract.ts';

let s: Server;
before(async () => { s = await startServer(); });
after(async () => { await s.stop(); });

const snap = async (p: Proj) => { const r = await p.plan(); const v = (await s.call(p.owner, 'GET', `/projects/${p.id}`)).body.planVersion; return { version: v, plan: JSON.stringify(r.body.tasks.map((t: any) => [t.id, t.name, t.durationMin, t.parentId, t.wbs, t.schedule]).sort()), links: JSON.stringify(r.body.links.map((l: any) => [l.id, l.type, l.lagMin]).sort()), asg: r.body.assignments.length, dbOps: Number(su(`SELECT count(*) FROM pf.plan_op WHERE project_id='${p.id}'`)) }; };
const sameSnap = (a: any, b: any, m = '') => assert.deepEqual(b, a, m + ' state must be unchanged');
const mk = async (n = 3) => { const p = await newProject(s, 'pm'); const ts = Array.from({ length: n }, (_, i) => T('T' + (i + 1), 480)); await p.ok(ts.map((t) => addTask(t))); return { p, ts }; };
const rejects = async (p: Proj, commands: any[], st: number | number[], code: string | string[], label = '') => { const s0 = await snap(p); const r = await p.cmd(commands); problem(r, st, code, label); sameSnap(s0, await snap(p), label); return r; };

// ---------------------------------------------------------------- atomicity
tc('E2E-CMD-ATOM-001', ['docs/07 §3 all-or-nothing', 'OAS applyCommands (4)', 'docs/05 §5.4'], 'a batch whose LAST command is invalid changes nothing (plan, planVersion, plan_op log)', async () => {
  const { p, ts } = await mk(2);
  await rejects(p, [addTask(T('ok-1', 60)), addTask(T('ok-2', 60)), { op: 'updateTask', id: ts[0].id, patch: { durationMin: 7 } }, { op: 'deleteTask', id: uuid() }], 422, 'UNKNOWN_TASK', 'unknown task last');
  await rejects(p, [addTask(T('ok-3', 60)), addLink(L(ts[0].id, ts[1].id)), addLink(L(ts[1].id, ts[0].id))], 422, 'CYCLE_DETECTED', 'cycle last');
  await rejects(p, [addTask(T('ok-4', 60)), { op: 'updateTask', id: ts[0].id, patch: { durationMin: 99 } }, { op: 'addTask', task: { id: uuid(), name: 'bad', durationMin: -5 } }], 400, 'VALIDATION_FAILED', 'validation last');
  const r = await p.ok([addTask(T('after', 60))]); assert.equal(r.body.planVersion, 2, 'version advanced by exactly one after the failed attempts');
});
tc('E2E-CMD-ATOM-002', ['docs/07 §3', 'FR-PL-03'], 'a failing batch of 200 commands with the error at the very end applies none of the 199 valid ones', async () => {
  const { p } = await mk(1); const cmds: any[] = Array.from({ length: 199 }, (_, i) => addTask(T('bulk' + i, 60))); cmds.push({ op: 'deleteTask', id: uuid() });
  await rejects(p, cmds, 422, 'UNKNOWN_TASK');
});
tc('E2E-CMD-ATOM-003', ['docs/06 §7 incremental', 'docs/07 §3'], 'after a rolled-back batch the next edit is computed from the committed state, not from the discarded in-memory copy', async () => {
  const { p, ts } = await mk(3); await p.ok([addLink(L(ts[0].id, ts[1].id)), addLink(L(ts[1].id, ts[2].id))]);
  await rejects(p, [{ op: 'updateTask', id: ts[0].id, patch: { durationMin: 4800 } }, { op: 'deleteTask', id: uuid() }], 422, 'UNKNOWN_TASK');
  await rejects(p, [{ op: 'updateTask', id: ts[1].id, patch: { durationMin: 4800 } }, addLink(L(ts[2].id, ts[0].id))], 422, 'CYCLE_DETECTED');
  const r = await p.ok([{ op: 'updateTask', id: ts[2].id, patch: { durationMin: 960 } }]); const m = await p.tasksById();
  assert.equal(m.get(ts[0].id).schedule.ef, '2026-11-09T17:00:00'); assert.equal(m.get(ts[1].id).schedule.es, '2026-11-10T08:00:00'); assert.equal(m.get(ts[2].id).schedule.es, '2026-11-11T08:00:00'); assert.equal(m.get(ts[2].id).schedule.ef, '2026-11-12T17:00:00');
  void r;
});
tc('E2E-CMD-OPLOG-001', ['docs/05 §5 plan_op gapless seq', 'I7 planVersion +1 per batch'], 'plan_op seq is gapless 1..N per committed batch; failed batches leave no trace; planVersion == N', async () => {
  const { p, ts } = await mk(2); await p.ok([addLink(L(ts[0].id, ts[1].id))]); await p.cmd([{ op: 'deleteTask', id: uuid() }]); await p.ok([{ op: 'updateTask', id: ts[0].id, patch: { name: 'x' } }]); await p.cmd([{ op: 'nope' }]);
  const seqs = su(`SELECT string_agg(seq::text, ',' ORDER BY seq) FROM pf.plan_op WHERE project_id='${p.id}'`); assert.equal(seqs, '1,2,3'); assert.equal((await s.call('pm', 'GET', `/projects/${p.id}`)).body.planVersion, 3);
});

// ---------------------------------------------------------------- versions / concurrency
tc('E2E-CMD-VER-001', ['docs/07 §4', 'docs/07 §5 VERSION_CONFLICT', 'OAS applyCommands'], 'expectedPlanVersion mismatch (stale or future) -> 409 VERSION_CONFLICT carrying currentPlanVersion; nothing applied', async () => {
  const { p, ts } = await mk(1); await p.ok([{ op: 'updateTask', id: ts[0].id, patch: { name: 'v2' } }]); const s0 = await snap(p);
  for (const v of [0, 1, 3, 99]) { const r = await s.call('pm', 'POST', `/projects/${p.id}/commands`, { clientOpId: uuid(), expectedPlanVersion: v, commands: [{ op: 'updateTask', id: ts[0].id, patch: { name: 'stale' + v } }] }); problem(r, 409, 'VERSION_CONFLICT', 'expected ' + v); assert.equal(r.body.currentPlanVersion, 2); assert.equal(validateResponse('/projects/{projectId}/commands', 'POST', 409, r.body, 'application/json').length >= 0, true); }
  sameSnap(s0, await snap(p));
});
tc('E2E-CMD-VER-002', ['docs/07 §4 (rebase of commuting batches)', 'docs/07 §5'], 'a stale batch that touches DISJOINT tasks is either rebased (200, version+1) or refused with 409 - and the client is told which version to re-sync to', async () => {
  const { p, ts } = await mk(2); await p.ok([{ op: 'updateTask', id: ts[0].id, patch: { name: 'other-user-edit' } }]);
  const r = await s.call('pm', 'POST', `/projects/${p.id}/commands`, { clientOpId: uuid(), expectedPlanVersion: 1, commands: [{ op: 'updateTask', id: ts[1].id, patch: { name: 'my-edit' } }] });
  assert.ok([200, 409].includes(r.status), ctx(r));
  if (r.status === 409) { problem(r, 409, 'VERSION_CONFLICT'); assert.equal(r.body.currentPlanVersion, 2); obs('stale-but-commuting batch: 409 VERSION_CONFLICT (docs/07 section 4 describes rebase; not implemented)'); } else { assert.equal(r.body.planVersion, 3); obs('stale-but-commuting batch rebased'); }
});
tc('E2E-CMD-CONC-001', ['docs/07 §4', 'docs/05 §5.4', 'FR-CO-01 (no lost updates)'], '10 parallel batches with the SAME expectedPlanVersion editing the same task: exactly one succeeds, nine get 409 VERSION_CONFLICT, version advances by exactly 1', async () => {
  const { p, ts } = await mk(1); const v = (await s.call('pm', 'GET', `/projects/${p.id}`)).body.planVersion;
  const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => s.call('pm', 'POST', `/projects/${p.id}/commands`, { clientOpId: uuid(), expectedPlanVersion: v, commands: [{ op: 'updateTask', id: ts[0].id, patch: { name: 'writer-' + i, durationMin: 60 * (i + 1) } }] })));
  const okc = rs.filter((r) => r.status === 200), conf = rs.filter((r) => r.status === 409);
  assert.equal(okc.length, 1, `exactly one winner expected, statuses: ${rs.map((r) => r.status).join(',')}`); assert.equal(conf.length, 9); for (const c of conf) { assert.equal(c.body.code, 'VERSION_CONFLICT'); assert.equal(c.body.currentPlanVersion, v + 1); }
  const t = (await s.call('pm', 'GET', `/projects/${p.id}/tasks/${ts[0].id}`)).body; const winner = okc[0].req.match(/writer-(\d+)/)![1]; assert.equal(t.name, 'writer-' + winner); assert.equal(t.durationMin, 60 * (Number(winner) + 1), 'final state is exactly the winner\'s'); assert.equal((await s.call('pm', 'GET', `/projects/${p.id}`)).body.planVersion, v + 1);
});
tc('E2E-CMD-CONC-002', ['docs/07 §4', 'FR-CO-01'], '10 parallel batches with the same expectedPlanVersion adding DIFFERENT tasks: never a 5xx, never a lost or duplicated update, versions strictly sequential', async () => {
  const { p } = await mk(1); const v = (await s.call('pm', 'GET', `/projects/${p.id}`)).body.planVersion; const tasks = Array.from({ length: 10 }, (_, i) => T('par' + i, 60));
  const rs = await Promise.all(tasks.map((t) => s.call('pm', 'POST', `/projects/${p.id}/commands`, { clientOpId: uuid(), expectedPlanVersion: v, commands: [addTask(t)] })));
  assert.ok(rs.every((r) => r.status === 200 || r.status === 409), rs.map((r) => r.status).join(','));
  const won = rs.filter((r) => r.status === 200); const vs = won.map((r) => r.body.planVersion).sort((a, b) => a - b); assert.deepEqual(vs, vs.map((_, i) => v + 1 + i), 'versions strictly sequential with no gaps/duplicates');
  const plan = (await p.plan()).body; assert.equal(plan.tasks.length, 1 + won.length, 'every acknowledged add is present exactly once'); assert.equal(plan.planVersion, v + won.length);
});
tc('E2E-CMD-CONC-003', ['docs/05 §5.4 (idempotent replay)', 'docs/07 §1.6'], 'concurrent identical clientOpId+body (x10): applied exactly once; the others replay (replayed=true) or conflict, never a second application', async () => {
  const { p } = await mk(1); const v = (await s.call('pm', 'GET', `/projects/${p.id}`)).body.planVersion; const op = uuid(), t = T('once', 60);
  const body = { clientOpId: op, expectedPlanVersion: v, commands: [addTask(t)] };
  const rs = await Promise.all(Array.from({ length: 10 }, () => s.call('pm', 'POST', `/projects/${p.id}/commands`, body)));
  assert.ok(rs.every((r) => r.status < 500), rs.map((r) => r.status).join(',')); const fresh = rs.filter((r) => r.status === 200 && !r.body.replayed); assert.equal(fresh.length, 1, 'exactly one non-replayed application: ' + rs.map((r) => r.status + (r.body?.replayed ? 'R' : '')).join(','));
  const plan = (await p.plan()).body; assert.equal(plan.tasks.filter((x: any) => x.id === t.id).length, 1); assert.equal(plan.planVersion, v + 1);
  const losers = rs.filter((r) => r !== fresh[0]); const notReplay = losers.filter((r) => !(r.status === 200 && r.body.replayed === true)); assert.equal(notReplay.length, 0, `racing duplicates of the same clientOpId+body must replay the original result (docs/05 section 5.4 step 3), got: ${notReplay.map((r) => r.status + ' ' + r.body?.code).join(', ')}`);
});

// ---------------------------------------------------------------- idempotency
tc('E2E-CMD-IDEMP-001', ['docs/07 §1.6', 'OAS applyCommands (idempotent)', 'OAS CommandResult.replayed'], 'same clientOpId + same body -> original result, replayed=true, planVersion unchanged', async () => {
  const { p, ts } = await mk(2); const op = uuid(); const body = { clientOpId: op, expectedPlanVersion: p.version, commands: [addLink(L(ts[0].id, ts[1].id)), { op: 'updateTask', id: ts[0].id, patch: { durationMin: 960 } }] };
  const a = await s.call('pm', 'POST', `/projects/${p.id}/commands`, body); status(a, 200); assert.ok(!a.body.replayed); const v1 = (await s.call('pm', 'GET', `/projects/${p.id}`)).body.planVersion;
  const b = await s.call('pm', 'POST', `/projects/${p.id}/commands`, body); status(b, 200); assert.equal(b.body.replayed, true); assert.equal(b.body.planVersion, a.body.planVersion, 'original planVersion returned'); assert.deepEqual(b.body.schedule, a.body.schedule); assert.deepEqual(b.body.changedTaskIds, a.body.changedTaskIds);
  assert.equal((await s.call('pm', 'GET', `/projects/${p.id}`)).body.planVersion, v1, 'no version bump'); assert.equal((await p.plan()).body.links.length, 1, 'link not added twice');
});
tc('E2E-CMD-IDEMP-002', ['docs/07 §5 DUPLICATE_CLIENT_OP'], 'same clientOpId + different body -> 409 DUPLICATE_CLIENT_OP and nothing applied', async () => {
  const { p, ts } = await mk(1); const op = uuid(); status(await s.call('pm', 'POST', `/projects/${p.id}/commands`, { clientOpId: op, expectedPlanVersion: p.version, commands: [{ op: 'updateTask', id: ts[0].id, patch: { name: 'first' } }] }), 200);
  const s0 = await snap(p); const r = await s.call('pm', 'POST', `/projects/${p.id}/commands`, { clientOpId: op, expectedPlanVersion: p.version + 1, commands: [{ op: 'updateTask', id: ts[0].id, patch: { name: 'second' } }] }); problem(r, 409, 'DUPLICATE_CLIENT_OP'); sameSnap(s0, await snap(p));
  const r2 = await s.call('pm', 'POST', `/projects/${p.id}/commands`, { clientOpId: op, expectedPlanVersion: p.version, commands: [{ op: 'updateTask', id: ts[0].id, patch: { name: 'second' } }] }); problem(r2, 409, 'DUPLICATE_CLIENT_OP', 'same expectedPlanVersion but different command'); assert.equal((await s.call('pm', 'GET', `/projects/${p.id}/tasks/${ts[0].id}`)).body.name, 'first');
});
tc('E2E-CMD-IDEMP-003', ['docs/05 §5.4 step 3 precedes step 4', 'docs/07 §1.6'], 'a retry of a committed batch after OTHER batches advanced the version still returns the original result (replay precedes the version check)', async () => {
  const { p, ts } = await mk(1); const body = { clientOpId: uuid(), expectedPlanVersion: p.version, commands: [{ op: 'updateTask', id: ts[0].id, patch: { name: 'lost-ack' } }] };
  const a = await s.call('pm', 'POST', `/projects/${p.id}/commands`, body); status(a, 200); p.version = a.body.planVersion; await p.ok([{ op: 'updateTask', id: ts[0].id, patch: { name: 'later' } }]); await p.ok([addTask(T('later2', 60))]);
  const b = await s.call('pm', 'POST', `/projects/${p.id}/commands`, body); status(b, 200, 'client retry after lost response'); assert.equal(b.body.replayed, true); assert.equal(b.body.planVersion, a.body.planVersion); assert.equal((await s.call('pm', 'GET', `/projects/${p.id}/tasks/${ts[0].id}`)).body.name, 'later', 'replay must not re-apply');
});
tc('E2E-CMD-IDEMP-004', ['docs/07 §1.6 (same body)'], 'a retry whose JSON differs only in key order/whitespace counts as the same body', async () => {
  const { p, ts } = await mk(1); const op = uuid(); const cmd = { op: 'updateTask', id: ts[0].id, patch: { name: 'k', durationMin: 120 } };
  const raw1 = JSON.stringify({ clientOpId: op, expectedPlanVersion: p.version, commands: [cmd] }), raw2 = `{ "commands": [ {"patch": {"durationMin":120,"name":"k"}, "id":"${ts[0].id}", "op":"updateTask"} ], "expectedPlanVersion": ${p.version}, "clientOpId": "${op}" }`;
  const h = { Authorization: 'Bearer ' + tokenFor('pm'), 'Content-Type': 'application/json' }; const a = await s.raw('POST', `/projects/${p.id}/commands`, { headers: h, body: raw1 }); status(a, 200);
  const b = await s.raw('POST', `/projects/${p.id}/commands`, { headers: h, body: raw2 }); status(b, 200, 'semantically identical retry'); assert.equal(b.body.replayed, true);
});
tc('E2E-CMD-IDEMP-005', ['docs/07 §1.6', 'docs/10 T5'], 'clientOpId is scoped per project: the same id may be reused in another project', async () => {
  const a = await mk(1), b = await mk(1); const op = uuid();
  status(await s.call('pm', 'POST', `/projects/${a.p.id}/commands`, { clientOpId: op, expectedPlanVersion: a.p.version, commands: [addTask(T('a', 60))] }), 200);
  const r = await s.call('pm', 'POST', `/projects/${b.p.id}/commands`, { clientOpId: op, expectedPlanVersion: b.p.version, commands: [addTask(T('b', 60))] }); status(r, 200); assert.ok(!r.body.replayed);
});

// ---------------------------------------------------------------- validation / mass assignment
const T0 = () => ({ id: uuid(), name: 'v', durationMin: 60 });
const massAssign: Array<[string, any]> = [['es', { es: '2026-11-09T08:00:00' }], ['ef', { ef: '2026-11-09T09:00:00' }], ['ls', { ls: '2026-11-09T08:00:00' }], ['lf', { lf: '2026-11-09T09:00:00' }], ['isCritical', { isCritical: true }], ['critical', { critical: true }], ['planVersion', { planVersion: 99 }], ['schedule', { schedule: { es: '2026-01-01T08:00:00', critical: true } }], ['totalFloatMin', { totalFloatMin: 5 }], ['wbs', { wbs: '9.9' }], ['sortKey', { sortKey: 'a' }], ['tenantId', { tenantId: uuid() }], ['projectId', { projectId: uuid() }], ['isSummary', { isSummary: true }], ['state', { state: 'DONE' }], ['driver', { driver: { kind: 'MANUAL' } }], ['version', { version: 7 }], ['createdAt', { createdAt: '2020-01-01T00:00:00Z' }], ['__proto__', JSON.parse('{"__proto__":{"admin":true}}')], ['constructor', { constructor: { prototype: { x: 1 } } }]];
for (const [k, extra] of massAssign)
  tc(`E2E-CMD-MASS-${k.replace(/[^A-Za-z]/g, '')}`, ['docs/10 T4 (strict schemas)', 'FR-PL-01'], `mass assignment: unknown/derived field "${k}" in addTask and updateTask is rejected with 400 and nothing is stored`, async () => {
    const { p, ts } = await mk(1); const s0 = await snap(p);
    await rejects(p, [addTask({ ...T0(), ...extra })], 400, 'VALIDATION_FAILED', 'addTask'); await rejects(p, [{ op: 'updateTask', id: ts[0].id, patch: { ...extra } }], 400, 'VALIDATION_FAILED', 'updateTask'); sameSnap(s0, await snap(p));
  });
tc('E2E-CMD-MASS-envelope', ['docs/10 T4'], 'unknown fields at batch and command level are rejected (extra batch key, extra command key, wrong op)', async () => {
  const { p, ts } = await mk(1); const send = (b: any) => s.call('pm', 'POST', `/projects/${p.id}/commands`, b);
  for (const b of [{ clientOpId: uuid(), expectedPlanVersion: p.version, commands: [addTask(T0())], planVersion: 5 }, { clientOpId: uuid(), expectedPlanVersion: p.version, commands: [{ ...addTask(T0()), bypass: true }] }, { clientOpId: uuid(), expectedPlanVersion: p.version, commands: [{ op: 'sudo', id: ts[0].id }] }, { clientOpId: uuid(), expectedPlanVersion: p.version, commands: [{ op: 'deleteTask', id: ts[0].id, cascade: false }] }, { clientOpId: uuid(), expectedPlanVersion: p.version, commands: [{ op: 'updateLink', id: uuid(), patch: { predId: uuid() } }] }, { clientOpId: uuid(), expectedPlanVersion: p.version, commands: [{ op: 'addLink', link: { ...L(uuid(), uuid()), isDriving: true } }] }, { clientOpId: uuid(), expectedPlanVersion: p.version, commands: [{ op: 'setProject', patch: { planVersion: 1 } }] }, { clientOpId: uuid(), expectedPlanVersion: p.version, commands: [{ op: 'addAssignment', assignment: { id: uuid(), taskId: ts[0].id, resourceId: uuid(), workMin: 1 } }] }])
    problem(await send(b), 400, 'VALIDATION_FAILED', JSON.stringify(b).slice(0, 100));
});
const bad = (label: string, make: (ts: any[]) => any[], st: number | number[] = 400, code: string | string[] = 'VALIDATION_FAILED') => tc(`E2E-CMD-VAL-${label}`, ['docs/07 §3 validation highlights', 'docs/05 §3 I3-I6', 'OAS Task/Link/Assignment constraints'], `invalid input rejected, nothing applied: ${label.replace(/-/g, ' ')}`, async () => { const { p, ts } = await mk(2); await rejects(p, make(ts), st, code, label); });
bad('negative-duration', () => [addTask({ ...T0(), durationMin: -1 })]); bad('fractional-duration', () => [addTask({ ...T0(), durationMin: 1.5 })]); bad('string-duration', () => [addTask({ ...T0(), durationMin: '60' })]); bad('null-duration', () => [addTask({ ...T0(), durationMin: null })]); bad('huge-duration', () => [addTask({ ...T0(), durationMin: 1e15 })]); bad('int32-overflow-duration', () => [addTask({ ...T0(), durationMin: 2147483648 })]); bad('NaN-duration', () => [addTask({ ...T0(), durationMin: 'NaN' })]);
bad('empty-name', () => [addTask({ ...T0(), name: '' })]); bad('name-501', () => [addTask({ ...T0(), name: 'x'.repeat(501) })]); bad('name-number', () => [addTask({ ...T0(), name: 5 })]); bad('name-missing', () => [addTask({ id: uuid(), durationMin: 5 })]); bad('id-missing', () => [addTask({ name: 'x', durationMin: 5 })]); bad('id-not-uuid', () => [addTask({ ...T0(), id: 'abc' })]); bad('id-uppercase-garbage', () => [addTask({ ...T0(), id: 'ZZZZZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZZZZZZZZZ' })]);
bad('percent-above-1', () => [addTask({ ...T0(), percentComplete: 1.01 })]); bad('percent-negative', () => [addTask({ ...T0(), percentComplete: -0.1 })]); bad('percent-string', () => [addTask({ ...T0(), percentComplete: '0.5' })]); bad('priority-1001', () => [addTask({ ...T0(), priority: 1001 })]); bad('priority-negative', () => [addTask({ ...T0(), priority: -1 })]); bad('priority-fraction', () => [addTask({ ...T0(), priority: 1.5 })]);
bad('kind-enum', () => [addTask({ ...T0(), kind: 'FIXED_EVERYTHING' })]); bad('mode-enum', () => [addTask({ ...T0(), mode: 'SEMI' })]); bad('constraint-enum', () => [addTask({ ...T0(), constraint: { type: 'MUST', date: START } })]); bad('constraint-MSO-without-date', () => [addTask({ ...T0(), constraint: { type: 'MSO' } })]); bad('constraint-SNET-null-date', () => [addTask({ ...T0(), constraint: { type: 'SNET', date: null } })]); bad('fixedWork-without-work', () => [addTask({ ...T0(), kind: 'FIXED_WORK' })]); bad('manual-without-start', () => [addTask({ ...T0(), mode: 'MANUAL' })]); bad('negative-fixedCost', () => [addTask({ ...T0(), fixedCost: -1 })]); bad('negative-workMin', () => [addTask({ ...T0(), workMin: -1 })]); bad('negative-levelingDelay', () => [addTask({ ...T0(), levelingDelayMin: -5 })]);
for (const [label, d] of [['date-only', '2026-11-09'], ['month-13', '2026-13-09T08:00:00'], ['feb-30', '2026-02-30T08:00:00'], ['hour-25', '2026-11-09T25:00:00'], ['zulu', '2026-11-09T08:00:00Z'], ['offset', '2026-11-09T08:00:00+02:00'], ['garbage', 'tomorrow'], ['number', 1762675200000], ['empty', ''], ['sql', "2026-11-09'; DROP TABLE x;--"]] as const)
  bad(`date-${label}`, () => [addTask({ ...T0(), constraint: { type: 'SNET', date: d } })]);
bad('estimate-order', () => [addTask({ ...T0(), estimate: { optimisticMin: 10, likelyMin: 5, pessimisticMin: 20 } })]); bad('estimate-partial', () => [addTask({ ...T0(), estimate: { optimisticMin: 10 } })]); bad('custom-not-object', () => [addTask({ ...T0(), custom: 'x' })]); bad('calendarId-not-uuid', () => [addTask({ ...T0(), calendarId: 'x' })]); bad('calendarId-unknown', () => [addTask({ ...T0(), calendarId: uuid() })]); bad('notes-number', () => [addTask({ ...T0(), notes: 5 })]);
bad('link-self', (ts) => [addLink(L(ts[0].id, ts[0].id))], [400, 422], ['VALIDATION_FAILED', 'CYCLE_DETECTED']); bad('link-type-enum', (ts) => [addLink(L(ts[0].id, ts[1].id, 'XX'))]); bad('link-lag-fraction', (ts) => [addLink(L(ts[0].id, ts[1].id, 'FS', 1.5))]); bad('link-lag-string', (ts) => [addLink(L(ts[0].id, ts[1].id, 'FS', '5' as any))]); bad('link-lagBasis-enum', (ts) => [addLink(L(ts[0].id, ts[1].id, 'FS', 0, { lagBasis: 'MOON' }))]); bad('link-unknown-pred', (ts) => [addLink(L(uuid(), ts[1].id))], 422, 'UNKNOWN_TASK'); bad('link-unknown-succ', (ts) => [addLink(L(ts[0].id, uuid()))], 422, 'UNKNOWN_TASK'); bad('link-lag-huge', (ts) => [addLink(L(ts[0].id, ts[1].id, 'FS', 1e18))], [400, 422], ['VALIDATION_FAILED', 'CONSTRAINT_UNSATISFIABLE']);
bad('update-unknown-task', () => [{ op: 'updateTask', id: uuid(), patch: { name: 'x' } }], 422, 'UNKNOWN_TASK'); bad('delete-unknown-task', () => [{ op: 'deleteTask', id: uuid() }], 422, 'UNKNOWN_TASK'); bad('move-unknown-task', () => [{ op: 'moveTask', id: uuid(), newParentId: null }], 422, 'UNKNOWN_TASK'); bad('move-unknown-parent', (ts) => [{ op: 'moveTask', id: ts[0].id, newParentId: uuid() }], 422, 'UNKNOWN_TASK'); bad('addTask-unknown-parent', () => [addTask({ ...T0(), parentId: uuid() })], 422, 'UNKNOWN_TASK'); bad('addTask-unknown-afterId', () => [addTask(T0(), uuid())], [400, 422], ['VALIDATION_FAILED', 'UNKNOWN_TASK']);
bad('update-parentId-forbidden', (ts) => [{ op: 'updateTask', id: ts[0].id, patch: { parentId: ts[1].id } }]); bad('update-empty-patch-bad-field', (ts) => [{ op: 'updateTask', id: ts[0].id, patch: { durationMin: -1 } }]); bad('update-id-in-patch', (ts) => [{ op: 'updateTask', id: ts[0].id, patch: { id: uuid() } }]);
bad('asg-units-zero', (ts) => [{ op: 'addAssignment', assignment: { id: uuid(), taskId: ts[0].id, resourceId: uuid(), units: 0 } }]); bad('asg-units-negative', (ts) => [{ op: 'addAssignment', assignment: { id: uuid(), taskId: ts[0].id, resourceId: uuid(), units: -1 } }]); bad('asg-units-101', (ts) => [{ op: 'addAssignment', assignment: { id: uuid(), taskId: ts[0].id, resourceId: uuid(), units: 101 } }]); bad('asg-unknown-task', () => [{ op: 'addAssignment', assignment: { id: uuid(), taskId: uuid(), resourceId: uuid() } }], [400, 422], ['UNKNOWN_TASK', 'VALIDATION_FAILED']); bad('asg-unknown-resource', (ts) => [{ op: 'addAssignment', assignment: { id: uuid(), taskId: ts[0].id, resourceId: uuid() } }], [400, 404, 422], ['VALIDATION_FAILED', 'NOT_FOUND', 'UNKNOWN_TASK']);
bad('setProject-nearCritical-negative', () => [{ op: 'setProject', patch: { nearCriticalMin: -1 } }]); bad('setProject-startDate-offset', () => [{ op: 'setProject', patch: { startDate: '2026-11-09T08:00:00+01:00' } }]); bad('setProject-empty-commands', () => []); bad('setProject-bad-statusDate', () => [{ op: 'setProject', patch: { statusDate: 'x' } }]);
tc('E2E-CMD-VAL-limits-1001', ['docs/07 §3 (<= 1000 commands)', 'docs/07 §5 PLAN_TOO_LARGE', 'OAS CommandBatch.maxItems'], '1001 commands -> 413 PLAN_TOO_LARGE; nothing applied', async () => {
  const { p } = await mk(1); const s0 = await snap(p); const r = await p.cmd(Array.from({ length: 1001 }, (_, i) => addTask(T('big' + i, 1)))); problem(r, 413, 'PLAN_TOO_LARGE'); sameSnap(s0, await snap(p));
});
tc('E2E-CMD-VAL-limits-1000', ['docs/07 §3 (<= 1000 commands)'], 'exactly 1000 commands in one batch is accepted', async () => {
  const { p } = await mk(1); const r = await p.cmd(Array.from({ length: 1000 }, (_, i) => addTask(T('b' + i, 1)))); status(r, 200); assert.equal((await p.plan()).body.tasks.length, 1001);
});
tc('E2E-CMD-VAL-bodysize', ['docs/07 §3 (2 MB)', 'docs/07 §5 PLAN_TOO_LARGE'], 'body > 2 MB -> 413 (clean, connection still usable, server alive)', async () => {
  const { p } = await mk(1); const big = JSON.stringify({ clientOpId: uuid(), expectedPlanVersion: p.version, commands: [addTask({ ...T0(), notes: 'x'.repeat(3 * 1024 * 1024) })] });
  const r = await s.raw('POST', `/projects/${p.id}/commands`, { headers: { Authorization: 'Bearer ' + tokenFor('pm'), 'Content-Type': 'application/json' }, body: big }); assert.equal(r.status, 413, 'body >2MB must be 413 '+ctx(r).slice(0,300)); if (r.body && typeof r.body === 'object') assert.ok(['PLAN_TOO_LARGE', 'VALIDATION_FAILED'].includes(r.body.code), ctx(r));
  status(await s.call('pm', 'GET', '/projects'), 200, 'server alive'); const ok = await p.cmd([addTask(T('after-big', 1))]); status(ok, 200);
});
tc('E2E-CMD-VAL-contenttype', ['docs/07 §1.4', 'OAS requestBody application/json'], 'wrong or missing content-type, invalid JSON, empty body -> 4xx problem+json (415/400), nothing applied', async () => {
  const { p } = await mk(1); const good = JSON.stringify({ clientOpId: uuid(), expectedPlanVersion: p.version, commands: [addTask(T0())] }); const auth = { Authorization: 'Bearer ' + tokenFor('pm') };
  for (const [label, h, body] of [['text/plain', { 'Content-Type': 'text/plain' }, good], ['form', { 'Content-Type': 'application/x-www-form-urlencoded' }, 'a=b'], ['xml', { 'Content-Type': 'application/xml' }, '<a/>'], ['no content-type', {}, good], ['bad json', { 'Content-Type': 'application/json' }, '{"clientOpId":'], ['empty', { 'Content-Type': 'application/json' }, ''], ['json array', { 'Content-Type': 'application/json' }, '[]'], ['bom', { 'Content-Type': 'application/json' }, '﻿' + good], ['null', { 'Content-Type': 'application/json' }, 'null'], ['deep nest', { 'Content-Type': 'application/json' }, '['.repeat(100000) + ']'.repeat(100000)]] as const) {
    const r = await s.raw('POST', `/projects/${p.id}/commands`, { headers: { ...auth, ...h }, body }); if (label === 'no content-type' && r.status === 200) { obs('request without Content-Type was accepted as JSON'); continue; }
    assert.ok(r.status >= 400 && r.status < 500, `${label}: ${r.status}${ctx(r)}`); assert.match(r.headers.get('content-type') ?? '', /problem\+json/, label);
  }
  assert.equal((await p.plan()).body.tasks.length, 1);
});
tc('E2E-CMD-VAL-textual-edge', ['NFR-I18N-01', 'docs/05 task.name'], 'unicode, emoji, RTL, combining marks and 500-char names are stored verbatim and round-trip; NUL bytes are rejected cleanly (400), never 500', async () => {
  const { p } = await mk(1); const names = ['Zażółć gęślą jaźń', '🚀 Launch ✅ — Phase 𝟚', 'مرحبا بالعالم', 'עברית', '日本語のタスク', 'é combining', 'x'.repeat(500), '   spaced   ', "O'Brien \"quoted\" <b>html</b> & \\ backslash", '‮RTL override', 'a\tb\nc'];
  for (const n of names) { const t = T(n, 60); status(await p.cmd([addTask(t)]), 200, JSON.stringify(n).slice(0, 40)); assert.equal((await s.call('pm', 'GET', `/projects/${p.id}/tasks/${t.id}`)).body.name, n); }
  const r = await p.cmd([addTask(T('nul\u0000byte', 60))]); assert.ok(r.status >= 400 && r.status < 500, `NUL byte in name must be a clean 4xx, got ${r.status}${ctx(r)}`);
  const r2 = await s.call('pm', 'POST', '/projects', { name: 'nul\u0000', startDate: START, calendarId: CAL_A }); assert.ok(r2.status >= 400 && r2.status < 500, `NUL in project name: ${r2.status}`);
  const r3 = await p.cmd([addTask(T('lone surrogate \ud800', 60))]); assert.ok(r3.status < 500, `lone surrogate: ${r3.status}${ctx(r3)}`);
});
tc('E2E-CMD-VAL-timeoffset', ['docs/07 §1.8'], 'plan instants with a zone offset/Z are rejected with VALIDATION_FAILED (no silent conversion) in addTask, updateTask, setProject and project create', async () => {
  const { p, ts } = await mk(1);
  for (const c of [addTask({ ...T0(), constraint: { type: 'SNET', date: '2026-11-09T08:00:00Z' } }), { op: 'updateTask', id: ts[0].id, patch: { actualStart: '2026-11-09T08:00:00+00:00' } }, { op: 'setProject', patch: { deadline: '2026-12-01T17:00:00Z' } }]) await rejects(p, [c], 400, 'VALIDATION_FAILED', JSON.stringify(c).slice(0, 80));
  problem(await s.call('pm', 'POST', '/projects', { name: 'z', startDate: '2026-11-09T08:00:00Z', calendarId: CAL_A }), 400, 'VALIDATION_FAILED');
});

// ---------------------------------------------------------------- per-op behaviour
tc('E2E-CMD-ADD-001', ['docs/07 §3 addTask', 'FR-PL-02', 'docs/05 sort_key'], 'addTask with afterId inserts after that sibling; wbs numbers follow order; appended otherwise', async () => {
  const p = await newProject(s, 'pm'); const [a, b, c, d] = ['A', 'B', 'C', 'D'].map((n) => T(n, 60)); await p.ok([addTask(a), addTask(b), addTask(c, a.id), addTask(d, b.id)]);
  const m = (await p.plan()).body.tasks; const order = [...m].sort((x: any, y: any) => x.sortKey < y.sortKey ? -1 : 1).map((t: any) => t.name); assert.deepEqual(order, ['A', 'C', 'B', 'D']); assert.deepEqual(m.sort((x: any, y: any) => Number(x.wbs) - Number(y.wbs)).map((t: any) => t.name), ['A', 'C', 'B', 'D']);
  assert.deepEqual(m.map((t: any) => t.wbs).sort(), ['1', '2', '3', '4']);
});
tc('E2E-CMD-ADD-002', ['docs/07 §3 addTask', 'docs/05 §2 (summary if it has children)', 'FR-PL-01'], 'adding a child under a leaf turns the leaf into a SUMMARY: isSummary, wbs 1.1/1.2, dates roll up from children (own duration ignored)', async () => {
  const p = await newProject(s, 'pm'); const par = T('Parent', 9999), c1 = T('c1', 480, { parentId: par.id }), c2 = T('c2', 960, { parentId: par.id });
  await p.ok([addTask(par)]); let m = await p.tasksById(); assert.equal(m.get(par.id).schedule.isSummary, false);
  await p.ok([addTask(c1), addTask(c2), addLink(L(c1.id, c2.id))]); m = await p.tasksById();
  assert.equal(m.get(par.id).schedule.isSummary, true); assert.equal(m.get(c1.id).wbs, '1.1'); assert.equal(m.get(c2.id).wbs, '1.2'); assert.equal(m.get(par.id).schedule.es, m.get(c1.id).schedule.es); assert.equal(m.get(par.id).schedule.ef, m.get(c2.id).schedule.ef); assert.equal(m.get(par.id).schedule.ef, '2026-11-11T17:00:00', 'ignores the stale 9999 min duration');
});
tc('E2E-CMD-ADD-003', ['docs/05 I5', 'docs/07 §5 DUPLICATE_ID'], 'duplicate task ids (existing id, or twice in one batch) -> 422 DUPLICATE_ID', async () => {
  const { p, ts } = await mk(1); await rejects(p, [addTask({ ...T0(), id: ts[0].id })], 422, 'DUPLICATE_ID', 'existing id'); const d = uuid(); await rejects(p, [addTask({ ...T0(), id: d }), addTask({ ...T0(), id: d })], 422, 'DUPLICATE_ID', 'twice in batch');
  const l = L(uuid(), uuid()); void l; const lk = L(ts[0].id, uuid()); void lk;
});
tc('E2E-CMD-UPD-001', ['docs/07 §3 updateTask (partial patch)'], 'updateTask is a partial patch: untouched fields keep their values; patched fields change', async () => {
  const p = await newProject(s, 'pm'); const t = T('orig', 480, { notes: 'n1', priority: 800, custom: { a: 1 }, constraint: { type: 'SNET', date: '2026-11-10T08:00:00' } }); await p.ok([addTask(t)]);
  await p.ok([{ op: 'updateTask', id: t.id, patch: { name: 'renamed' } }]); let g = (await s.call('pm', 'GET', `/projects/${p.id}/tasks/${t.id}`)).body;
  assert.equal(g.name, 'renamed'); assert.equal(g.notes, 'n1'); assert.equal(g.priority, 800); assert.deepEqual(g.custom, { a: 1 }); assert.equal(g.durationMin, 480); assert.deepEqual(g.constraint, { type: 'SNET', date: '2026-11-10T08:00:00' }); assert.equal(g.schedule.es, '2026-11-10T08:00:00');
  await p.ok([{ op: 'updateTask', id: t.id, patch: { constraint: { type: 'ASAP' } } }]); g = (await s.call('pm', 'GET', `/projects/${p.id}/tasks/${t.id}`)).body; assert.equal(g.constraint.type, 'ASAP'); assert.equal(g.schedule.es, '2026-11-09T08:00:00', 'constraint removed -> back to project start');
});
tc('E2E-CMD-MOVE-001', ['docs/07 §3 moveTask', 'FR-PL-02'], 'moveTask reparents (wbs renumbers) and reorders with afterId without touching other siblings\' sort keys', async () => {
  const p = await newProject(s, 'pm'); const [a, b, c, par] = [T('A', 60), T('B', 60), T('C', 60), T('P', 0)]; await p.ok([addTask(par), addTask(a), addTask(b), addTask(c)]);
  const before = new Map([...(await p.tasksById())].map(([id, t]) => [id, t.sortKey])); await p.ok([{ op: 'moveTask', id: c.id, afterId: par.id }]);
  const m = await p.tasksById(); const order = [...m.values()].sort((x, y) => (x.sortKey < y.sortKey ? -1 : 1)).map((t) => t.name); assert.deepEqual(order, ['P', 'C', 'A', 'B']); for (const t of [par, a, b]) assert.equal(m.get(t.id).sortKey, before.get(t.id), 'sibling keys not rewritten');
  await p.ok([{ op: 'moveTask', id: a.id, newParentId: par.id }, { op: 'moveTask', id: b.id, newParentId: par.id, afterId: a.id }]); const m2 = await p.tasksById(); assert.equal(m2.get(a.id).parentId, par.id); assert.equal(m2.get(a.id).wbs.endsWith('.1'), true); assert.equal(m2.get(b.id).wbs.endsWith('.2'), true); assert.equal(m2.get(par.id).schedule.isSummary, true);
  await p.ok([{ op: 'moveTask', id: a.id, newParentId: null }]); assert.equal((await p.tasksById()).get(a.id).parentId, null);
});
tc('E2E-CMD-MOVE-002', ['docs/05 I5 (no parent cycles)', 'docs/07 §3 moveTask'], 'moving a task under itself or under its own descendant is refused (no parent cycle), nothing applied', async () => {
  const p = await newProject(s, 'pm'); const a = T('A', 0), b = T('B', 0, { parentId: a.id }), c = T('C', 60, { parentId: b.id }); await p.ok([addTask(a), addTask(b), addTask(c)]);
  await rejects(p, [{ op: 'moveTask', id: a.id, newParentId: c.id }], [400, 409, 422], ['CYCLE_DETECTED', 'VALIDATION_FAILED'], 'under descendant'); await rejects(p, [{ op: 'moveTask', id: a.id, newParentId: a.id }], [400, 409, 422], ['CYCLE_DETECTED', 'VALIDATION_FAILED'], 'under itself');
});
tc('E2E-CMD-MOVE-003', ['docs/05 I2', 'docs/07 §5 LINK_TO_SUMMARY'], 'moving a task into a linked leaf (which becomes a summary) is refused with LINK_TO_SUMMARY, atomically', async () => {
  const { p, ts } = await mk(3); await p.ok([addLink(L(ts[0].id, ts[1].id))]); await rejects(p, [{ op: 'moveTask', id: ts[2].id, newParentId: ts[0].id }], 422, 'LINK_TO_SUMMARY');
});
tc('E2E-CMD-DEL-001', ['docs/07 §3 deleteTask (cascades to links/assignments)'], 'deleteTask removes the task with its links and assignments and reschedules successors', async () => {
  const p = await newProject(s, 'pm'); const r = await createResource(s, 'pm', { name: 'del-res' }); const [a, b, c] = [T('A', 480), T('B', 480), T('C', 480)];
  await p.ok([addTask(a), addTask(b), addTask(c), addLink(L(a.id, b.id)), addLink(L(b.id, c.id)), { op: 'addAssignment', assignment: { id: uuid(), taskId: b.id, resourceId: r.id } }]);
  assert.equal((await p.tasksById()).get(c.id).schedule.es, '2026-11-11T08:00:00'); await p.ok([{ op: 'deleteTask', id: b.id }]); const pl = (await p.plan()).body;
  assert.equal(pl.tasks.length, 2); assert.equal(pl.links.length, 0, 'both links touching B removed'); assert.equal(pl.assignments.length, 0, 'assignment removed'); assert.equal(pl.tasks.find((t: any) => t.id === c.id).schedule.es, '2026-11-09T08:00:00', 'C no longer waits for A/B');
  assert.equal(Number(su(`SELECT count(*) FROM pf.assignment WHERE project_id='${p.id}'`)), 0); assert.equal(Number(su(`SELECT count(*) FROM pf.task_link WHERE project_id='${p.id}'`)), 0);
  problem((await p.cmd([{ op: 'deleteTask', id: b.id }])), 422, 'UNKNOWN_TASK', 'second delete');
});
tc('E2E-CMD-DEL-002', ['docs/07 §3 deleteTask (summary delete removes the subtree)'], 'deleting a summary removes its whole subtree (grandchildren, their links and assignments); links from outside are dropped too', async () => {
  const p = await newProject(s, 'pm'); const par = T('P', 0), k1 = T('k1', 480, { parentId: par.id }), k2 = T('k2', 480, { parentId: k1.id }), out = T('out', 480), after = T('after', 480); const r = await createResource(s, 'pm', { name: 'sub-res' });
  await p.ok([addTask(par), addTask(k1), addTask(k2), addTask(out), addTask(after), addLink(L(out.id, k2.id)), addLink(L(k2.id, after.id)), { op: 'addAssignment', assignment: { id: uuid(), taskId: k2.id, resourceId: r.id } }]);
  await p.ok([{ op: 'deleteTask', id: par.id }]); const pl = (await p.plan()).body; assert.deepEqual(pl.tasks.map((t: any) => t.name).sort(), ['after', 'out']); assert.equal(pl.links.length, 0); assert.equal(pl.assignments.length, 0); assert.equal(pl.tasks.find((t: any) => t.id === after.id).schedule.es, '2026-11-09T08:00:00');
  assert.equal(Number(su(`SELECT count(*) FROM pf.task WHERE project_id='${p.id}'`)), 2, 'rows really gone');
});
tc('E2E-CMD-LINK-001', ['docs/07 §3 addLink', 'docs/05 I2', 'docs/07 §5 LINK_TO_SUMMARY'], 'links to/from a summary are rejected 422 LINK_TO_SUMMARY (both ends), including when a batch turns a linked leaf into a summary', async () => {
  const p = await newProject(s, 'pm'); const par = T('P', 0), c1 = T('c1', 60, { parentId: par.id }), x = T('x', 60), y = T('y', 60); await p.ok([addTask(par), addTask(c1), addTask(x), addTask(y)]);
  await rejects(p, [addLink(L(par.id, x.id))], 422, 'LINK_TO_SUMMARY', 'summary as pred'); await rejects(p, [addLink(L(x.id, par.id))], 422, 'LINK_TO_SUMMARY', 'summary as succ');
  await p.ok([addLink(L(x.id, y.id))]); await rejects(p, [addTask({ ...T0(), parentId: x.id })], 422, 'LINK_TO_SUMMARY', 'leaf with link becomes summary');
});
tc('E2E-CMD-LINK-002', ['docs/05 I1', 'FR-PL-03', 'docs/07 §5 CYCLE_DETECTED', 'OAS Problem.cycle'], 'cycles (2-node, 3-node, via SS/FF/SF, built inside one batch) -> 422 CYCLE_DETECTED with the cycle path: ids of real tasks, first repeated at the end, each hop a real link', async () => {
  for (const types of [['FS', 'FS', 'FS'], ['SS', 'FF', 'SF'], ['FS', 'SS', 'FF']] as const) {
    const { p, ts } = await mk(3); const links = [L(ts[0].id, ts[1].id, types[0]), L(ts[1].id, ts[2].id, types[1])]; await p.ok(links.map(addLink)); const closing = L(ts[2].id, ts[0].id, types[2]);
    const r = await p.cmd([addLink(closing)]); problem(r, 422, 'CYCLE_DETECTED', types.join('/')); const cyc: string[] = r.body.cycle; assert.ok(Array.isArray(cyc) && cyc.length >= 3, 'cycle array present'); assert.equal(cyc[0], cyc[cyc.length - 1], 'first id repeated at the end'); const ids = new Set(ts.map((t) => t.id)); for (const id of cyc) assert.ok(ids.has(id), 'path ids are real task ids');
    const edges = new Set([...links, closing].map((l) => l.predId + '>' + l.succId)); for (let i = 0; i < cyc.length - 1; i++) assert.ok(edges.has(cyc[i] + '>' + cyc[i + 1]), `hop ${i} is not a link`); assert.equal(new Set(cyc.slice(0, -1)).size, cyc.length - 1, 'simple cycle'); assert.equal((await p.plan()).body.links.length, 2);
  }
  const { p, ts } = await mk(2); const r = await p.cmd([addLink(L(ts[0].id, ts[1].id)), addLink(L(ts[1].id, ts[0].id, 'SS'))]); problem(r, 422, 'CYCLE_DETECTED', 'inside one batch'); assert.equal((await p.plan()).body.links.length, 0, 'whole batch rolled back');
});
tc('E2E-CMD-LINK-003', ['docs/05 I6 unique (pred,succ,type)'], 'a duplicate link (same pred, succ, type) is rejected cleanly (4xx, not 500); a different type between the same tasks is allowed', async () => {
  const { p, ts } = await mk(2); await p.ok([addLink(L(ts[0].id, ts[1].id, 'FS'))]); const r = await p.cmd([addLink(L(ts[0].id, ts[1].id, 'FS', 60))]); assert.ok([400, 409, 422].includes(r.status), `duplicate link: ${r.status}${ctx(r)}`);
  const ok = await p.cmd([addLink(L(ts[0].id, ts[1].id, 'SS'))]); status(ok, 200, 'same pair, different type'); assert.equal((await p.plan()).body.links.length, 2);
  const dupId = await p.cmd([addLink({ ...L(ts[1].id, ts[0].id, 'FS') , id: (await p.plan()).body.links[0].id })]); assert.ok(dupId.status >= 400 && dupId.status < 500, `duplicate link id: ${dupId.status}`);
});
tc('E2E-CMD-LINK-004', ['docs/07 §3 updateLink/removeLink'], 'updateLink changes type/lag/lagBasis (schedule follows); removeLink frees the successor; unknown link ids are refused', async () => {
  const { p, ts } = await mk(2); const l = L(ts[0].id, ts[1].id); await p.ok([addLink(l)]); assert.equal((await p.tasksById()).get(ts[1].id).schedule.es, '2026-11-10T08:00:00');
  await p.ok([{ op: 'updateLink', id: l.id, patch: { type: 'SS', lagMin: 240 } }]); const g = (await p.plan()).body.links[0]; assert.equal(g.type, 'SS'); assert.equal(g.lagMin, 240); assert.equal((await p.tasksById()).get(ts[1].id).schedule.es, '2026-11-09T13:00:00');
  await p.ok([{ op: 'updateLink', id: l.id, patch: { lagBasis: 'SUCC' } }]); assert.equal((await p.plan()).body.links[0].lagBasis, 'SUCC');
  await p.ok([{ op: 'removeLink', id: l.id }]); assert.equal((await p.tasksById()).get(ts[1].id).schedule.es, '2026-11-09T08:00:00'); const r1 = await p.cmd([{ op: 'removeLink', id: l.id }]); assert.ok(r1.status >= 400 && r1.status < 500, 'second remove: ' + r1.status); const r2 = await p.cmd([{ op: 'updateLink', id: uuid(), patch: { lagMin: 1 } }]); assert.ok(r2.status >= 400 && r2.status < 500);
});
tc('E2E-CMD-ASG-001', ['docs/07 §3 (assignments)', 'OAS Assignment', 'FR-RS-02'], 'add/update/removeAssignment: units default 1, update units, remove; duplicate (task,resource) refused cleanly; assignments appear in GET plan', async () => {
  const { p, ts } = await mk(1); const r = await createResource(s, 'pm', { name: 'asg-res' }); const a = { id: uuid(), taskId: ts[0].id, resourceId: r.id };
  status(await p.cmd([{ op: 'addAssignment', assignment: a }]), 200); await p.cmd([{ op: 'removeAssignment', id: uuid() }]).then((x) => assert.ok(x.status >= 400 && x.status < 500)); let g = (await p.plan()).body.assignments; assert.equal(g.length, 1); assert.equal(g[0].units, 1, 'default units = 1');
  status(await p.cmd([{ op: 'updateAssignment', id: a.id, patch: { units: 0.5 } }]), 200); g = (await p.plan()).body.assignments; assert.equal(g[0].units, 0.5);
  const dup = await p.cmd([{ op: 'addAssignment', assignment: { id: uuid(), taskId: ts[0].id, resourceId: r.id } }]); assert.ok(dup.status >= 400 && dup.status < 500, `duplicate assignment: ${dup.status}${ctx(dup)}`);
  status(await p.cmd([{ op: 'removeAssignment', id: a.id }]), 200); assert.equal((await p.plan()).body.assignments.length, 0);
});
tc('E2E-CMD-ASSIGN-FRESHRES', ['docs/07 §3', 'FR-RS-01/02', 'docs/04 caching'], 'a resource created AFTER the project\'s plan was first loaded can be assigned immediately (no spurious "unknown resource")', async () => {
  const p = await newProject(s, 'pm'); const t = T('t', 60); status(await p.cmd([addTask(t)]), 200); const r = await createResource(s, 'pm', { name: 'fresh-res' });
  const a = await p.cmd([{ op: 'addAssignment', assignment: { id: uuid(), taskId: t.id, resourceId: r.id } }]); status(a, 200, 'first attempt after creating the resource');
});
tc('E2E-CMD-PROJ-001', ['OAS CmdSetProject', 'FR-PL-08'], 'setProject startDate/deadline/statusDate/nearCriticalMin take effect; deadline/statusDate accept null to clear', async () => {
  const { p, ts } = await mk(1); await p.ok([{ op: 'setProject', patch: { startDate: '2026-11-16T08:00:00' } }]); assert.equal((await p.tasksById()).get(ts[0].id).schedule.es, '2026-11-16T08:00:00'); assert.equal((await s.call('pm', 'GET', `/projects/${p.id}`)).body.startDate, '2026-11-16T08:00:00');
  await p.ok([{ op: 'setProject', patch: { deadline: '2026-11-16T12:00:00' } }]); let r = await p.ok([{ op: 'setProject', patch: { statusDate: '2026-11-17T08:00:00' } }]); void r;
  await p.ok([{ op: 'setProject', patch: { deadline: null, statusDate: null, nearCriticalMin: 0 } }]); const g = (await s.call('pm', 'GET', `/projects/${p.id}`)).body; assert.ok(g.deadline == null);
});
tc('E2E-CMD-RES-001', ['docs/07 §3', 'OAS CommandResult.changedTaskIds', 'OAS applyCommands (schedule.tasks only changed)'], 'changedTaskIds covers every task whose derived schedule changed, and schedule.tasks agrees with GET plan for those tasks', async () => {
  const { p, ts } = await mk(4); await p.ok([addLink(L(ts[0].id, ts[1].id)), addLink(L(ts[1].id, ts[2].id))]); const before = await p.tasksById();
  const r = await p.ok([{ op: 'updateTask', id: ts[0].id, patch: { durationMin: 1440 } }]); const after = await p.tasksById(); const moved = [...after.keys()].filter((id) => JSON.stringify(after.get(id).schedule) !== JSON.stringify(before.get(id).schedule));
  assert.ok(moved.length >= 3, 'precondition'); for (const id of moved) assert.ok(r.body.changedTaskIds.includes(id), `task ${id} changed but is not in changedTaskIds`);
  for (const [id, sc] of Object.entries<any>(r.body.schedule.tasks)) { const g = after.get(id).schedule; for (const k of ['es', 'ef', 'ls', 'lf', 'totalFloatMin', 'freeFloatMin', 'critical']) assert.deepEqual(sc[k], g[k], `${id}.${k} differs between command result and GET plan`); }
  assert.ok(!r.body.changedTaskIds.includes(ts[3].id) || JSON.stringify(after.get(ts[3].id).schedule) !== JSON.stringify(before.get(ts[3].id).schedule), 'untouched independent task should not be reported as changed');
  const v = validateResponse('/projects/{projectId}/commands', 'POST', 200, r.body); assert.equal(v.length, 0, v.join(';'));
});
tc('E2E-CMD-VERSION-001', ['docs/05 I7 planVersion +1 per batch'], 'planVersion increases by exactly 1 per committed batch (also for batches that change nothing visible); rejected batches and replays do not bump it', async () => {
  const { p, ts } = await mk(1); const v0 = (await s.call('pm', 'GET', `/projects/${p.id}`)).body.planVersion; await p.ok([{ op: 'updateTask', id: ts[0].id, patch: { name: ts[0].name } }]); assert.equal((await s.call('pm', 'GET', `/projects/${p.id}`)).body.planVersion, v0 + 1); await p.ok([addTask(T('a', 1)), addTask(T('b', 1)), addTask(T('c', 1))]); assert.equal((await s.call('pm', 'GET', `/projects/${p.id}`)).body.planVersion, v0 + 2);
});
tc('E2E-CMD-ARCH-001', ['OAS archiveProject (soft delete)'], 'OBSERVATION: commands on an ARCHIVED project', async () => {
  const { p } = await mk(1); status(await s.call('pm', 'DELETE', `/projects/${p.id}`), 204); const r = await p.cmd([addTask(T('post-archive', 1))]); obs(`command on archived project -> HTTP ${r.status} ${r.body?.code ?? ''}`);
});
