import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { boot, CAL_A, id, USERS } from './support.ts';

let api: Awaited<ReturnType<typeof boot>>;
before(async () => { api = await boot(); });
after(async () => { await api.close(); });

test('smoke: project -> tasks -> links -> schedule -> idempotency -> conflict -> cycle', async () => {
  const p = await api.call('pm', 'POST', '/projects', { name: 'Smoke', startDate: '2026-11-09T08:00:00', calendarId: CAL_A });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  const pid = p.body.id;
  const [a, b, c] = [id(), id(), id()];
  const op1 = id();
  const r1 = await api.call('pm', 'POST', `/projects/${pid}/commands`, {
    clientOpId: op1, expectedPlanVersion: 0,
    commands: [
      { op: 'addTask', task: { id: a, name: 'A', durationMin: 960 } },
      { op: 'addTask', task: { id: b, name: 'B', durationMin: 480 } },
      { op: 'addTask', task: { id: c, name: 'C', durationMin: 480 } },
      { op: 'addLink', link: { id: id(), predId: a, succId: b } },
      { op: 'addLink', link: { id: id(), predId: b, succId: c } },
    ],
  });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal(r1.body.planVersion, 1);
  assert.equal(r1.body.schedule.finish, '2026-11-12T17:00:00');
  assert.deepEqual(r1.body.schedule.criticalPath.sort(), [a, b, c].sort());
  // replay returns the original
  const r1b = await api.call('pm', 'POST', `/projects/${pid}/commands`, { clientOpId: op1, expectedPlanVersion: 0, commands: [
    { op: 'addTask', task: { id: a, name: 'A', durationMin: 960 } }, { op: 'addTask', task: { id: b, name: 'B', durationMin: 480 } }, { op: 'addTask', task: { id: c, name: 'C', durationMin: 480 } },
    { op: 'addLink', link: { id: r1.body.x ?? id(), predId: a, succId: b } }] });
  assert.equal(r1b.status, 409);                       // different body, same clientOpId
  assert.equal(r1b.body.code, 'DUPLICATE_CLIENT_OP');
  // stale version
  const stale = await api.call('pm', 'POST', `/projects/${pid}/commands`, { clientOpId: id(), expectedPlanVersion: 0, commands: [{ op: 'updateTask', id: a, patch: { durationMin: 480 } }] });
  assert.equal(stale.status, 409); assert.equal(stale.body.code, 'VERSION_CONFLICT'); assert.equal(stale.body.currentPlanVersion, 1);
  // edit
  const r2 = await api.call('pm', 'POST', `/projects/${pid}/commands`, { clientOpId: id(), expectedPlanVersion: 1, commands: [{ op: 'updateTask', id: a, patch: { durationMin: 480 } }] });
  assert.equal(r2.status, 200); assert.equal(r2.body.schedule.finish, '2026-11-11T17:00:00');
  // cycle
  const cyc = await api.call('pm', 'POST', `/projects/${pid}/commands`, { clientOpId: id(), expectedPlanVersion: 2, commands: [{ op: 'addLink', link: { id: id(), predId: c, succId: a } }] });
  assert.equal(cyc.status, 422); assert.equal(cyc.body.code, 'CYCLE_DETECTED'); assert.ok(cyc.body.cycle.length >= 3);
  const plan = await api.call('pm', 'GET', `/projects/${pid}/plan`);
  assert.equal(plan.body.planVersion, 2); assert.equal(plan.body.tasks.length, 3); assert.equal(plan.body.links.length, 2);
  // other tenant cannot see it
  assert.equal((await api.call('pmB', 'GET', `/projects/${pid}`)).status, 404);
  // unauthenticated
  assert.equal((await api.call(null, 'GET', `/projects/${pid}`)).status, 401);
  void USERS;
});
