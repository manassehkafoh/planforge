import { before, after } from 'node:test';
import { tc, status, assert, obs, ctx, record } from '../lib/tc.ts';
import { startServer, newProject, su, uuid, T, L, addTask, addLink, START, type Server, type Proj } from '../lib/harness.ts';
import { Axis, STD_CAL, oracle, type OTask, type OLink, type DepType } from '../lib/oracle.ts';

let s: Server;
before(async () => { s = await startServer(); });
after(async () => { await s.stop(); });
const axis = new Axis(STD_CAL);
const D = (d: string, h: string) => `2026-${d}T${h}:00`; // e.g. D('11-09','08:00')

// deterministic PRNG so failures reproduce
const rng = (seed: number) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

/** build tasks+links on a fresh project, return server-computed schedule keyed by id */
async function run(tasks: any[], links: any[], extra: any[] = [], proj?: Proj) {
  const p = proj ?? (await newProject(s, 'pm')); const r = await p.ok([...tasks.map((t) => addTask(t)), ...links.map(addLink), ...extra]);
  return { p, r, m: await p.tasksById() };
}
const eq3 = (m: Map<string, any>, id: string, es: string, ef: string, label = '') => { const sc = m.get(id).schedule; assert.equal(sc.es, es, `${label} es`); assert.equal(sc.ef, ef, `${label} ef`); };

// ------------------------------------------------------------- relationship types, hand-computed
tc('E2E-SCHED-LINK-FS', ['docs/06 §3.1 FS', 'FR-SC-01'], 'FS: successor starts at predecessor finish; across lunch and weekend', async () => {
  const a = T('A', 240), b = T('B', 60), c = T('C', 480);
  const { m } = await run([a, b, c], [L(a.id, b.id), L(b.id, c.id)]);
  eq3(m, a.id, D('11-09', '08:00'), D('11-09', '12:00')); eq3(m, b.id, D('11-09', '13:00'), D('11-09', '14:00'), 'B resumes after lunch'); eq3(m, c.id, D('11-09', '14:00'), D('11-10', '14:00'), 'C 14:00-17:00 then 08:00-12:00 and 13:00-14:00');
});
tc('E2E-SCHED-LINK-FS-WEEKEND', ['docs/06 §2 calendar arithmetic'], 'FS across a weekend: Friday work continues Monday', async () => {
  const a = T('A', 480 * 5), b = T('B', 480);
  const { m } = await run([a, b], [L(a.id, b.id)]); eq3(m, a.id, D('11-09', '08:00'), D('11-13', '17:00')); eq3(m, b.id, D('11-16', '08:00'), D('11-16', '17:00'), 'Mon after weekend');
});
tc('E2E-SCHED-LINK-SS', ['docs/06 §3.1 SS'], 'SS +lag: successor start >= predecessor start + lag', async () => {
  const a = T('A', 960), b = T('B', 480), c = T('C', 480);
  const { m } = await run([a, b, c], [L(a.id, b.id, 'SS', 0), L(a.id, c.id, 'SS', 600)]); eq3(m, b.id, D('11-09', '08:00'), D('11-09', '17:00')); eq3(m, c.id, D('11-10', '10:00'), D('11-11', '10:00'), 'lag 600 = 1 day 2 h'); assert.equal(m.get(c.id).schedule.driver.linkType, 'SS');
});
tc('E2E-SCHED-LINK-FF', ['docs/06 §3.1 FF'], 'FF +lag: successor finish >= predecessor finish + lag (start back-computed)', async () => {
  const a = T('A', 960), b = T('B', 240), c = T('C', 2000);
  const { m } = await run([a, b, c], [L(a.id, b.id, 'FF', 0), L(a.id, c.id, 'FF', 0)]); eq3(m, b.id, D('11-10', '13:00'), D('11-10', '17:00'), 'B finishes with A'); assert.equal(m.get(c.id).schedule.es, D('11-09', '08:00'), 'C long enough to start at project start'); assert.equal(m.get(b.id).schedule.driver.kind, 'LINK');
});
tc('E2E-SCHED-LINK-SF', ['docs/06 §3.1 SF'], 'SF +lag: successor finish >= predecessor start + lag', async () => {
  const a = T('A', 480, { constraint: { type: 'SNET', date: D('11-11', '08:00') } }), b = T('B', 240);
  const { m } = await run([a, b], [L(a.id, b.id, 'SF', 0)]); eq3(m, a.id, D('11-11', '08:00'), D('11-11', '17:00')); eq3(m, b.id, D('11-10', '13:00'), D('11-10', '17:00'), 'B finishes when A starts (previous working minute)');
});
tc('E2E-SCHED-LAG-LEAD', ['docs/06 §3.1 (negative lag = lead)'], 'FS with positive lag, with lead (negative lag), and lead larger than predecessor (clamped by project start)', async () => {
  const a = T('A', 960), b = T('B', 480), c = T('C', 480), d = T('D', 480);
  const { m } = await run([a, b, c, d], [L(a.id, b.id, 'FS', 480), L(a.id, c.id, 'FS', -480), L(a.id, d.id, 'FS', -100000)]);
  eq3(m, b.id, D('11-12', '08:00'), D('11-12', '17:00'), 'A ends Tue 17:00, +1 working day lag -> Wed 08:00'); eq3(m, c.id, D('11-10', '08:00'), D('11-10', '17:00'), 'lead 1 day'); assert.equal(m.get(d.id).schedule.es, D('11-09', '08:00'), 'cannot start before project start');
});
tc('E2E-SCHED-LAG-BASIS', ['docs/17 G (lag calendar basis)', 'OAS Link.lagBasis'], 'lagBasis PROJECT/PRED/SUCC measure the lag on different calendars (only the project calendar exists here -> results equal); the value is stored and accepted', async () => {
  const a = T('A', 480), b = T('B', 480), c = T('C', 480), d = T('D', 480);
  const { m, p } = await run([a, b, c, d], [L(a.id, b.id, 'FS', 240, { lagBasis: 'PROJECT' }), L(a.id, c.id, 'FS', 240, { lagBasis: 'PRED' }), L(a.id, d.id, 'FS', 240, { lagBasis: 'SUCC' })]);
  for (const id of [b.id, c.id, d.id]) assert.equal(m.get(id).schedule.es, D('11-10', '13:00')); assert.deepEqual((await p.plan()).body.links.map((l: any) => l.lagBasis).sort(), ['PRED', 'PROJECT', 'SUCC']);
});
tc('E2E-SCHED-ZERO', ['docs/06 (milestones)', 'FR-SC-04'], 'zero-duration milestones: start == finish, chains through, FS successor starts at the milestone', async () => {
  const a = T('A', 480), mlt = T('M', 0), b = T('B', 480);
  const { m } = await run([a, mlt, b], [L(a.id, mlt.id), L(mlt.id, b.id)]); const ms = m.get(mlt.id).schedule; assert.equal(ms.es, ms.ef, 'milestone start==finish'); assert.equal(m.get(b.id).schedule.es, D('11-10', '08:00')); assert.equal(m.get(b.id).schedule.ef, D('11-10', '17:00'));
});
tc('E2E-SCHED-HOLIDAY', ['docs/06 §2 calendar exceptions', 'seed calendar CAL_A (2026-12-25 holiday)'], 'a task spanning the 2026-12-25 holiday skips it', async () => {
  const p = await newProject(s, 'pm', { startDate: D('12-24', '08:00') }); const a = T('A', 960);
  const { m } = await run([a], [], [], p); eq3(m, a.id, D('12-24', '08:00'), D('12-28', '17:00'), 'Thu + (Fri holiday, weekend skipped) + Mon');
});
tc('E2E-SCHED-STARTNONWORK', ['docs/06 §2'], 'project start on a Saturday 10:00 -> first task starts at the next working minute (Mon 08:00)', async () => {
  const p = await newProject(s, 'pm', { startDate: D('11-14', '10:00') }); const a = T('A', 60); const { m } = await run([a], [], [], p); eq3(m, a.id, D('11-16', '08:00'), D('11-16', '09:00'));
});

// ------------------------------------------------------------- constraints
const cons = async (type: string, date: string | undefined, dur = 480, preds: Array<[number, DepType, number]> = []) => {
  const pr = T('PRED', 960); const t = T('X', dur, { constraint: date ? { type, date } : { type } }); const links = preds.length ? [L(pr.id, t.id, preds[0][1], preds[0][2])] : [];
  const r = await run(preds.length ? [pr, t] : [t], links); return { ...r, t, pr, sc: r.m.get(t.id).schedule, conflicts: r.r.body.schedule.conflicts as any[] };
};
tc('E2E-SCHED-CON-SNET', ['docs/06 §3.2 SNET'], 'SNET lower-bounds the start; a later predecessor still wins', async () => {
  let x = await cons('SNET', D('11-12', '08:00')); assert.equal(x.sc.es, D('11-12', '08:00')); assert.equal(x.sc.driver.kind, 'CONSTRAINT');
  x = await cons('SNET', D('11-09', '13:00'), 480, [[0, 'FS', 0]]); assert.equal(x.sc.es, D('11-11', '08:00'), 'predecessor later than SNET'); assert.equal(x.sc.driver.kind, 'LINK');
});
tc('E2E-SCHED-CON-FNET', ['docs/06 §3.2 FNET'], 'FNET lower-bounds the finish (start = finish - duration)', async () => {
  const x = await cons('FNET', D('11-12', '17:00'), 480); assert.equal(x.sc.ef, D('11-12', '17:00')); assert.equal(x.sc.es, D('11-12', '08:00'));
});
tc('E2E-SCHED-CON-MSO', ['docs/06 §3.2 MSO'], 'MSO pins the start; when predecessors would push later -> MSO_VIOLATED conflict inside a 200, start stays pinned', async () => {
  let x = await cons('MSO', D('11-12', '08:00')); assert.equal(x.sc.es, D('11-12', '08:00')); assert.equal(x.conflicts.filter((c) => c.taskId === x.t.id).length, 0); assert.equal(x.sc.totalFloatMin, 0, 'pinned => zero float');
  x = await cons('MSO', D('11-09', '08:00'), 480, [[0, 'FS', 0]]); assert.equal(x.sc.es, D('11-09', '08:00')); assert.ok(x.conflicts.some((c) => c.taskId === x.t.id && c.code === 'MSO_VIOLATED'), JSON.stringify(x.conflicts));
});
tc('E2E-SCHED-CON-MFO', ['docs/06 §3.2 MFO'], 'MFO pins the finish; violated -> MFO_VIOLATED', async () => {
  let x = await cons('MFO', D('11-12', '17:00')); assert.equal(x.sc.ef, D('11-12', '17:00')); assert.equal(x.sc.es, D('11-12', '08:00'));
  x = await cons('MFO', D('11-10', '12:00'), 480, [[0, 'FS', 0]]); assert.ok(x.conflicts.some((c) => c.taskId === x.t.id && c.code === 'MFO_VIOLATED'), JSON.stringify(x.conflicts));
});
tc('E2E-SCHED-CON-SNLT', ['docs/06 §3.2 SNLT'], 'SNLT: soft; unviolated -> positive float, violated -> SNLT_VIOLATED and negative float', async () => {
  let x = await cons('SNLT', D('11-12', '08:00')); assert.equal(x.sc.es, D('11-09', '08:00')); assert.equal(x.conflicts.length, 0);
  x = await cons('SNLT', D('11-09', '08:00'), 480, [[0, 'FS', 0]]); assert.ok(x.conflicts.some((c) => c.taskId === x.t.id && c.code === 'SNLT_VIOLATED'), JSON.stringify(x.conflicts)); assert.ok(x.sc.totalFloatMin < 0, 'float negative: ' + x.sc.totalFloatMin);
});
tc('E2E-SCHED-CON-FNLT', ['docs/06 §3.2 FNLT'], 'FNLT: violated -> FNLT_VIOLATED and negative float', async () => {
  let x = await cons('FNLT', D('11-13', '17:00')); assert.equal(x.conflicts.length, 0);
  x = await cons('FNLT', D('11-10', '17:00'), 480, [[0, 'FS', 0]]); assert.ok(x.conflicts.some((c) => c.taskId === x.t.id && c.code === 'FNLT_VIOLATED'), JSON.stringify(x.conflicts)); assert.ok(x.sc.totalFloatMin < 0);
});
tc('E2E-SCHED-CON-ALAP', ['docs/06 §3.2 ALAP', 'docs/06 §3 (ALAP free float 0)'], 'ALAP: dates reported at the late position; successors unaffected; free float reported 0', async () => {
  const a = T('A', 480), alap = T('B', 480, { constraint: { type: 'ALAP' } }), long = T('Long', 2400);
  const { m } = await run([a, alap, long], [L(a.id, alap.id)]); eq3(m, alap.id, D('11-13', '08:00'), D('11-13', '17:00'), 'pushed to late dates (Long ends Fri)'); assert.equal(m.get(alap.id).schedule.freeFloatMin, 0); assert.equal(m.get(a.id).schedule.es, D('11-09', '08:00'), 'predecessor unaffected');
});
tc('E2E-SCHED-CON-ALL-ORACLE', ['docs/06 §3.2', 'FR-SC-03'], 'all 8 non-ALAP constraint types over a chain, compared with the oracle (dates, floats, conflicts)', async () => {
  for (const type of ['SNET', 'FNET', 'SNLT', 'FNLT', 'MSO', 'MFO']) for (const off of [-1, 0, 1, 3]) {
    const day = 9 + 1 + off + 1; const date = off % 2 ? D(`11-${String(Math.max(9, day)).padStart(2, '0')}`, '08:00') : D(`11-${String(Math.max(9, day)).padStart(2, '0')}`, '17:00');
    const a = T('A', 480), b = T('B', 720, { constraint: { type, date } }), c = T('C', 240);
    const { m, r } = await run([a, b, c], [L(a.id, b.id), L(b.id, c.id)]);
    const o = oracle(axis, START, [{ id: a.id, dur: 480 }, { id: b.id, dur: 720, ctype: type, cdate: date }, { id: c.id, dur: 240 }], [{ pred: a.id, succ: b.id, type: 'FS', lag: 0 }, { pred: b.id, succ: c.id, type: 'FS', lag: 0 }]);
    for (const id of [a.id, b.id, c.id]) { const e = o.tasks.get(id)!, g = m.get(id).schedule; assert.deepEqual([g.es, g.ef, g.ls, g.lf, g.totalFloatMin], [e.es, e.ef, e.ls, e.lf, e.tf], `${type} ${date} task ${id === a.id ? 'A' : id === b.id ? 'B' : 'C'}`); }
    const got = (r.body.schedule.conflicts as any[]).map((x) => x.code).sort(), want = o.conflicts.map((x) => x.code).sort(); assert.deepEqual(got, want, `${type} ${date} conflicts`);
  }
});

// ------------------------------------------------------------- deadline, float, critical, near-critical
tc('E2E-SCHED-DEADLINE', ['docs/06 §3.2 Project deadline', 'FR-SC-07'], 'deadline earlier than finish -> DEADLINE_MISSED on late tasks, negative float; later deadline -> no conflict and no extra float (limit = min(finish, deadline))', async () => {
  const a = T('A', 480), b = T('B', 480), side = T('S', 480); const { p, m } = await run([a, b, side], [L(a.id, b.id)]); assert.equal(m.get(b.id).schedule.totalFloatMin, 0);
  let r = await p.ok([{ op: 'setProject', patch: { deadline: D('11-10', '12:00') } }]); let mm = await p.tasksById(); assert.ok(r.body.schedule.conflicts.some((c: any) => c.code === 'DEADLINE_MISSED' && c.taskId === b.id), JSON.stringify(r.body.schedule.conflicts)); assert.equal(mm.get(b.id).schedule.totalFloatMin, -240, 'finish 17:00 vs deadline 12:00 = 13:00-17:00 = 240 working min (lunch excluded)');
  r = await p.ok([{ op: 'setProject', patch: { deadline: D('11-16', '17:00') } }]); mm = await p.tasksById(); assert.equal(r.body.schedule.conflicts.filter((c: any) => c.code === 'DEADLINE_MISSED').length, 0); assert.equal(mm.get(b.id).schedule.totalFloatMin, 0, 'docs/06: limit = min(projectFinish, deadline): a later deadline adds no float'); assert.equal(mm.get(b.id).schedule.critical, true);
});
tc('E2E-SCHED-FLOAT', ['docs/06 §3 float', 'FR-SC-05'], 'total float, free float, critical and nearCritical on a diamond; nearCriticalMin changes the threshold', async () => {
  const a = T('A', 480), long = T('Long', 960), short = T('Short', 480), z = T('Z', 480); const { p, m } = await run([a, long, short, z], [L(a.id, long.id), L(a.id, short.id), L(long.id, z.id), L(short.id, z.id)]);
  const g = (id: string) => m.get(id).schedule; assert.equal(g(short.id).totalFloatMin, 480); assert.equal(g(short.id).freeFloatMin, 480); assert.equal(g(short.id).critical, false); assert.equal(g(short.id).nearCritical, true, '480 <= 960'); assert.equal(g(long.id).critical, true); assert.equal(g(long.id).nearCritical, false);
  assert.equal(g(short.id).ls, D('11-11', '08:00')); assert.equal(g(short.id).lf, D('11-11', '17:00')); await p.ok([{ op: 'setProject', patch: { nearCriticalMin: 240 } }]); assert.equal((await p.tasksById()).get(short.id).schedule.nearCritical, false, 'threshold 240 < 480');
  const r = await p.ok([{ op: 'setProject', patch: { nearCriticalMin: 480 } }]); void r; assert.equal((await p.tasksById()).get(short.id).schedule.nearCritical, true, 'boundary inclusive');
});
tc('E2E-SCHED-CRITPATH', ['docs/06 §5', 'OAS ScheduleResult.criticalPath'], 'multiple disjoint critical chains are all returned, ordered by early start, early finish, id', async () => {
  const a1 = T('a1', 480), a2 = T('a2', 480), b1 = T('b1', 480), b2 = T('b2', 480); const { r, m } = await run([a1, a2, b1, b2], [L(a1.id, a2.id), L(b1.id, b2.id)]);
  const cp: string[] = r.body.schedule.criticalPath; assert.deepEqual([...cp].sort(), [a1.id, a2.id, b1.id, b2.id].sort()); const key = (id: string) => [m.get(id).schedule.es, m.get(id).schedule.ef, id].join('|'); assert.deepEqual(cp, [...cp].sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0)), 'ordered by es, ef, id');
});
tc('E2E-SCHED-SUMMARY', ['docs/06 §3 roll-up'], 'summary roll-up: ES=min child ES, EF=max child EF, float=min, critical if any child critical; summaries carry no driver of their own requirement', async () => {
  const sm = T('S', 0), c1 = T('c1', 480, { parentId: sm.id }), c2 = T('c2', 960, { parentId: sm.id }), o = T('o', 1440); const { m } = await run([sm, c1, c2, o], [L(c1.id, c2.id)]);
  const S = m.get(sm.id).schedule; assert.equal(S.es, D('11-09', '08:00')); assert.equal(S.ef, D('11-11', '17:00')); assert.equal(S.isSummary, true); assert.equal(S.totalFloatMin, Math.min(m.get(c1.id).schedule.totalFloatMin, m.get(c2.id).schedule.totalFloatMin)); assert.equal(S.critical, true);
});

// ------------------------------------------------------------- manual, status date, progress
tc('E2E-SCHED-MANUAL', ['docs/06 manual mode (G closed)', 'FR-SC-08'], 'MANUAL task keeps its entered dates regardless of predecessors (driver MANUAL); successors follow it; conflict if links would move it', async () => {
  const a = T('A', 1440), man = T('Man', 480, { mode: 'MANUAL', manualStart: D('11-09', '08:00') }); const r0 = await newProject(s, 'pm'); const add = await r0.cmd([addTask(a), addTask(man)]);
  if (add.status !== 200) { obs('MANUAL task creation shape: ' + add.text.slice(0, 200)); const alt = { ...man, manualStart: undefined, manualStartDate: D('11-09', '08:00') }; void alt; }
  assert.equal(add.status, 200, 'MANUAL task must be creatable; OAS Task has manual start field: ' + ctx(add));
  const l = L(a.id, man.id); await r0.ok([addLink(l)]); const m = await r0.tasksById(); eq3(m, man.id, D('11-09', '08:00'), D('11-09', '17:00')); assert.equal(m.get(man.id).schedule.driver.kind, 'MANUAL');
});
tc('E2E-SCHED-STATUSDATE', ['docs/06 status date', 'FR-SC-09'], 'status date: remaining (unstarted) work cannot start before it (driver STATUS_DATE); clearing it restores the earlier dates', async () => {
  const a = T('A', 480), b = T('B', 480); const { p, m } = await run([a, b], []); assert.equal(m.get(b.id).schedule.es, D('11-09', '08:00'));
  await p.ok([{ op: 'setProject', patch: { statusDate: D('11-11', '08:00') } }]); const m2 = await p.tasksById(); assert.equal(m2.get(b.id).schedule.es, D('11-11', '08:00')); assert.equal(m2.get(b.id).schedule.driver.kind, 'STATUS_DATE');
  await p.ok([{ op: 'setProject', patch: { statusDate: null } }]); assert.equal((await p.tasksById()).get(b.id).schedule.es, D('11-09', '08:00'));
});
tc('E2E-SCHED-PROGRESS', ['docs/06 progress', 'OAS Task.percentComplete/actualStart/actualFinish', 'FR-SC-10'], 'completed task: state DONE, not critical/near-critical, keeps actual dates (driver ACTUAL), successor starts after the actual finish', async () => {
  const a = T('A', 480), b = T('B', 480); const { p } = await run([a, b], [L(a.id, b.id)]);
  const r = await p.cmd([{ op: 'updateTask', id: a.id, patch: { percentComplete: 1, actualStart: D('11-10', '08:00'), actualFinish: D('11-10', '17:00') } }]); status(r, 200); const m = await p.tasksById(); const A = m.get(a.id).schedule;
  assert.equal(A.state, 'DONE'); assert.equal(A.critical, false); assert.equal(A.nearCritical, false); assert.equal(A.es, D('11-10', '08:00')); assert.equal(A.ef, D('11-10', '17:00')); assert.equal(A.driver?.kind, 'ACTUAL'); assert.equal(m.get(b.id).schedule.es, D('11-11', '08:00'));
  const r2 = await p.cmd([{ op: 'updateTask', id: b.id, patch: { percentComplete: 0.5 } }]); status(r2, 200); assert.equal((await p.tasksById()).get(b.id).schedule.state, 'PROGRESS');
});
tc('E2E-SCHED-DRIVER', ['docs/06 §4 explainability'], 'driver: PROJECT_START for roots; LINK{predId,linkType} for dependants and the chain of predId leads back to the root; ties keep the first link', async () => {
  const a = T('A', 480), b = T('B', 480), c = T('C', 480), d = T('D', 480); const { m } = await run([a, b, c, d], [L(a.id, c.id), L(b.id, c.id), L(c.id, d.id)]);
  assert.equal(m.get(a.id).schedule.driver.kind, 'PROJECT_START'); assert.equal(m.get(c.id).schedule.driver.kind, 'LINK'); assert.equal(m.get(c.id).schedule.driver.predId, a.id, 'tie -> first link inserted'); assert.equal(m.get(d.id).schedule.driver.predId, c.id);
  let cur = d.id; const chain = [cur]; while (m.get(cur).schedule.driver?.predId) { cur = m.get(cur).schedule.driver.predId; chain.push(cur); } assert.deepEqual(chain, [d.id, c.id, a.id]);
});

// ------------------------------------------------------------- randomised vs independent oracle
function genNet(seed: number, n: number, opts: { types: boolean; lags: boolean; cons: boolean; summary: boolean }) {
  const R = rng(seed); const ids = Array.from({ length: n }, () => uuid()); const tasks: OTask[] = []; const specs: any[] = []; const links: OLink[] = [];
  const nSum = opts.summary ? Math.floor(n / 6) : 0; // first nSum tasks are summaries; others may be their children
  for (let i = 0; i < n; i++) {
    const dur = (1 + Math.floor(R() * 24)) * 60; const parent = i >= nSum && nSum && R() < 0.5 ? ids[Math.floor(R() * nSum)] : null; const o: OTask = { id: ids[i], dur, parent };
    const spec: any = { id: ids[i], name: 't' + i, durationMin: dur, ...(parent ? { parentId: parent } : {}) };
    if (opts.cons && R() < 0.2 && i >= nSum) { const ty = ['SNET', 'FNET', 'SNLT', 'FNLT'][Math.floor(R() * 4)]; const d = axis.startOf(axis.pos(START) + Math.floor(R() * 3000)); o.ctype = ty; o.cdate = d; spec.constraint = { type: ty, date: d }; }
    tasks.push(o); specs.push(spec);
  }
  const hasKids = new Set(tasks.map((t) => t.parent).filter(Boolean) as string[]);
  for (let j = nSum; j < n; j++) for (let k = 0; k < 2; k++) if (R() < 0.55) {
    const i = nSum + Math.floor(R() * (j - nSum)); if (i >= j || hasKids.has(ids[i]) || hasKids.has(ids[j])) continue;
    const type: DepType = opts.types ? (['FS', 'FS', 'SS', 'FF', 'SF'] as DepType[])[Math.floor(R() * 5)] : 'FS'; const lag = opts.lags ? (Math.floor(R() * 13) - 4) * 60 : 0;
    if (links.some((l) => l.pred === ids[i] && l.succ === ids[j] && l.type === type)) continue; links.push({ pred: ids[i], succ: ids[j], type, lag });
  }
  // summaries with no kids behave as leaves -> fine; but leaves whose parent gets children later is handled by the oracle via isParent
  return { tasks, specs, links, hasKids };
}
const cmp = (m: Map<string, any>, o: ReturnType<typeof oracle>, fields: string[], label: string) => {
  for (const [id, e] of o.tasks) { const g = m.get(id)?.schedule; assert.ok(g, `${label}: task ${id} missing`); const exp: any = { es: e.es, ef: e.ef, ls: e.ls, lf: e.lf, totalFloatMin: e.tf, freeFloatMin: e.ff, critical: e.critical, nearCritical: e.near }; for (const f of fields) assert.deepEqual(g[f], exp[f], `${label}: task ${id} field ${f} (server tf=${g.totalFloatMin} summary=${g.isSummary} critical=${g.critical}; oracle tf=${e.tf} near=${e.near})`); }
};
const scenarios: Array<[string, { types: boolean; lags: boolean; cons: boolean; summary: boolean }, number, number]> = [['FS-only', { types: false, lags: false, cons: false, summary: false }, 15, 30], ['all-types', { types: true, lags: false, cons: false, summary: false }, 15, 30], ['lags', { types: true, lags: true, cons: false, summary: false }, 15, 30], ['constraints', { types: true, lags: true, cons: true, summary: false }, 15, 30], ['summaries', { types: true, lags: true, cons: true, summary: true }, 18, 30]];
for (const [name, opts, n, count] of scenarios) {
  tc(`E2E-SCHED-RAND-${name}`, ['docs/06 §3 (oracle)', 'FR-SC-01/03/05', 'NFR-QUAL-01'], `${count} random networks (${name}) match the independent oracle: es/ef/ls/lf/total float/critical/near-critical`, async () => {
    let checked = 0, skippedCycle = 0;
    for (let i = 0; i < count; i++) {
      const seed = 1000 * (scenarios.findIndex((x) => x[0] === name) + 1) + i; const net = genNet(seed, n, opts);
      let o; try { o = oracle(axis, START, net.tasks, net.links); } catch { skippedCycle++; continue; }
      const p = await newProject(s, 'pm'); const r = await p.cmd([...net.specs.sort((a, b) => (a.parentId ? 1 : 0) - (b.parentId ? 1 : 0)).map((t) => addTask(t)), ...net.links.map((l) => addLink(L(l.pred, l.succ, l.type, l.lag)))]);
      assert.equal(r.status, 200, `seed ${seed}: ${r.text.slice(0, 300)}`); const m = await p.tasksById();
      cmp(m, o, ['es', 'ef', 'ls', 'lf', 'totalFloatMin', 'critical', 'nearCritical'], `seed ${seed}`);
      const got = (r.body.schedule.conflicts as any[]).map((c) => c.taskId + c.code).sort(), want = o.conflicts.map((c) => c.taskId + c.code).sort(); assert.deepEqual(got, want, `seed ${seed} conflicts`);
      assert.equal(r.body.schedule.finish, o.finish, `seed ${seed} project finish`); checked++;
    }
    record('sched.rand.' + name, { checked, skippedCycle }); assert.ok(checked >= count - 3, 'enough networks checked');
  });
}
tc('E2E-SCHED-RAND-freefloat', ['docs/06 §3 (free float formula)'], 'free float of random mixed-type networks matches the oracle (docs/06 formula: min slack over successors clamped to [min(0,TF),TF])', async () => {
  for (let i = 0; i < 20; i++) { const net = genNet(7000 + i, 14, { types: true, lags: true, cons: false, summary: false }); const o = oracle(axis, START, net.tasks, net.links); const p = await newProject(s, 'pm'); await p.ok([...net.specs.map((t) => addTask(t)), ...net.links.map((l) => addLink(L(l.pred, l.succ, l.type, l.lag)))]); cmp(await p.tasksById(), o, ['freeFloatMin'], 'seed ' + (7000 + i)); }
});
tc('E2E-SCHED-RAND-edits', ['docs/06 §7', 'FR-SC-01'], 'after 25 random edits (duration changes, link add/remove, deletes) each of 6 plans still equals the oracle computed from the logical network', async () => {
  for (let k = 0; k < 6; k++) {
    const R = rng(9000 + k); const net = genNet(9100 + k, 12, { types: true, lags: true, cons: false, summary: false }); const p = await newProject(s, 'pm');
    await p.ok([...net.specs.map((t) => addTask(t)), ...net.links.map((l) => addLink(L(l.pred, l.succ, l.type, l.lag)))]);
    const lk = new Map<string, OLink>(); const idOf: string[] = []; const plan = (await p.plan()).body; for (const l of plan.links) { lk.set(l.id, { pred: l.predId, succ: l.succId, type: l.type, lag: l.lagMin }); idOf.push(l.id); }
    const tk = new Map(net.tasks.map((t) => [t.id, { ...t }]));
    for (let e = 0; e < 25; e++) {
      const ids = [...tk.keys()]; const pick = R(); let cmd: any;
      if (pick < 0.45) { const id = ids[Math.floor(R() * ids.length)]; const dur = (1 + Math.floor(R() * 24)) * 60; cmd = { op: 'updateTask', id, patch: { durationMin: dur } }; const r = await p.cmd([cmd]); status(r, 200); tk.get(id)!.dur = dur; }
      else if (pick < 0.75) { const a = ids[Math.floor(R() * ids.length)], b = ids[Math.floor(R() * ids.length)]; const type = (['FS', 'SS', 'FF', 'SF'] as DepType[])[Math.floor(R() * 4)]; const lag = (Math.floor(R() * 9) - 3) * 60; const l = L(a, b, type, lag); const r = await p.cmd([addLink(l)]); if (r.status === 200) lk.set(l.id, { pred: a, succ: b, type, lag }); else assert.ok(r.status === 422 || r.status === 400, 'rejected link must be a clean 4xx: ' + r.status); }
      else if (pick < 0.9 && lk.size) { const id = [...lk.keys()][Math.floor(R() * lk.size)]; status(await p.cmd([{ op: 'removeLink', id }]), 200); lk.delete(id); }
      else if (ids.length > 6) { const id = ids[Math.floor(R() * ids.length)]; status(await p.cmd([{ op: 'deleteTask', id }]), 200); tk.delete(id); for (const [lid, l] of [...lk]) if (l.pred === id || l.succ === id) lk.delete(lid); }
    }
    const o = oracle(axis, START, [...tk.values()].map((t) => ({ id: t.id, dur: t.dur, parent: null })), [...lk.values()]); cmp(await p.tasksById(), o, ['es', 'ef', 'ls', 'lf', 'totalFloatMin', 'critical'], 'edit-run ' + k);
  }
});

// ------------------------------------------------------------- calendars via SQL (task calendar), preview
tc('E2E-SCHED-TASKCAL', ['docs/06 §6.2 task calendar', 'OAS Task.calendarId'], 'a task with its own calendar (Mon-Thu 10:00-14:00, 240 min/day) is measured and positioned on that calendar', async () => {
  const cal = uuid(); const week = JSON.stringify([[], ...Array.from({ length: 4 }, () => [{ startMin: 600, endMin: 840 }]), [], []]);
  su(`INSERT INTO pf.calendar (id, tenant_id, name, week) VALUES ('${cal}','aaaaaaaa-0000-4000-8000-000000000001','e2e short-days','${week}')`);
  const a = T('A', 480, { calendarId: cal }), b = T('B', 480); const { m } = await run([a, b], [L(a.id, b.id)]);
  const A = m.get(a.id).schedule; assert.equal(A.es, D('11-09', '10:00'), 'starts when ITS calendar opens'); assert.equal(A.ef, D('11-10', '14:00'), '480 min = two 240-min days'); assert.ok(m.get(b.id).schedule.es >= A.ef, 'successor not before predecessor finish');
});
tc('E2E-SCHED-PREVIEW', ['OAS previewSchedule', 'docs/07 §2'], 'POST /schedule previews hypothetical commands without persisting anything (version, plan_op, tasks unchanged)', async () => {
  const a = T('A', 480), { p } = await run([a], []); const before = JSON.stringify((await p.plan()).body); const ops0 = su(`SELECT count(*) FROM pf.plan_op WHERE project_id='${p.id}'`);
  const r = await s.call('pm', 'POST', `/projects/${p.id}/schedule`, { commands: [{ op: 'updateTask', id: a.id, patch: { durationMin: 4800 } }] }); status(r, 200); assert.equal(r.body.schedule?.finish ?? r.body.finish, D('11-20', '17:00'), 'preview computed with the hypothetical duration');
  assert.equal(JSON.stringify((await p.plan()).body), before, 'nothing persisted'); assert.equal(su(`SELECT count(*) FROM pf.plan_op WHERE project_id='${p.id}'`), ops0);
});
tc('E2E-SCHED-PREVIEW-BATCH', ['OAS previewSchedule requestBody', 'docs/07 §2'], 'OBSERVATION: preview accepts a full CommandBatch body (clientOpId + expectedPlanVersion) as well', async () => {
  const a = T('A', 480), { p } = await run([a], []); const r = await s.call('pm', 'POST', `/projects/${p.id}/schedule`, { clientOpId: uuid(), expectedPlanVersion: p.version, commands: [{ op: 'updateTask', id: a.id, patch: { durationMin: 60 } }] }); obs('preview with CommandBatch body -> ' + r.status); assert.ok(r.status === 200, 'previewSchedule is documented to take a CommandBatch: ' + ctx(r).slice(0, 300));
});
