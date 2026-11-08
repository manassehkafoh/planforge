import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schedule, standardCalendar, WorkCalendar, resolveCalendars, ScheduleError } from '../src/index.ts';
import type { CalendarDef } from '../src/index.ts';
import { proj, T, D, MON, at } from './helpers.ts';

test('explainability: every leaf names the thing that set its start', () => {
  const r = schedule(proj([T('A', 1), T('B', 1), T('C', 1, { constraint: { type: 'SNET', date: at(2026, 11, 18) } }), T('F', 1)],
    [{ pred: 'A', succ: 'B' }, { pred: 'B', succ: 'C' }, { pred: 'A', succ: 'F', type: 'FF' }]));
  assert.deepEqual(r.drivers.A, { kind: 'PROJECT_START' });
  assert.deepEqual(r.drivers.B, { kind: 'LINK', predId: 'A', linkType: 'FS' });
  assert.deepEqual(r.drivers.C, { kind: 'CONSTRAINT' });
  assert.equal(r.drivers.F.kind === 'PROJECT_START' || r.drivers.F.kind === 'LINK', true);
});

test('near-critical flag uses a working-minute threshold on positive float only', () => {
  const p = proj([T('A', 5), T('B', 4), T('C', 1), T('D', 1)], [{ pred: 'A', succ: 'D' }, { pred: 'B', succ: 'D' }, { pred: 'C', succ: 'D' }]);
  const r = schedule(p);
  assert.equal(r.tasks.A.nearCritical, false);               // critical, not "near"
  assert.equal(r.tasks.A.critical, true);
  assert.equal(r.tasks.B.totalFloatMin, D);
  assert.equal(r.tasks.B.nearCritical, true);                // 1 day float <= 2 days
  assert.equal(r.tasks.C.totalFloatMin, 4 * D);
  assert.equal(r.tasks.C.nearCritical, false);
  assert.equal(schedule({ ...p, nearCriticalMin: 4 * D }).tasks.C.nearCritical, true);
});

test('lag calendar basis: PROJECT vs PRED vs SUCC measure the same lag on different calendars', () => {
  const std = standardCalendar();
  const sevenDay: CalendarDef = { id: 'seven', week: Array.from({ length: 7 }, () => std.week[1]) };
  const mk = (basis?: 'PROJECT' | 'PRED' | 'SUCC') => schedule(proj(
    [T('A', 2, { calendarId: 'seven' }), T('B', 1)], [{ pred: 'A', succ: 'B', lagMin: 4 * D, ...(basis ? { lagBasis: basis } : {}) }],
    { calendars: [sevenDay] }));
  // A ends Tue 17:00. +4 working days on Mon-Fri -> Tue 17:00 next week -> B Wed? (start of next working time)
  assert.equal(mk().tasks.B.es, at(2026, 11, 17, 8));          // Tue 17 Nov (std calendar lag)
  assert.equal(mk('PRED').tasks.B.es, at(2026, 11, 16, 8));    // 7-day calendar: Wed,Thu,Fri,Sat,.. ends Sat 17:00 -> next std working start Mon
  assert.equal(mk('PROJECT').tasks.B.es, mk().tasks.B.es);
});

test('manual scheduling: pinned dates hold, conflict reported when logic disagrees, successors follow', () => {
  const ok = schedule(proj([T('A', 1), T('B', 2, { mode: 'MANUAL', manualStart: at(2026, 11, 12) }), T('C', 1)], [{ pred: 'A', succ: 'B' }, { pred: 'B', succ: 'C' }]));
  assert.equal(ok.tasks.B.es, at(2026, 11, 12, 8));
  assert.deepEqual(ok.conflicts, []);
  assert.equal(ok.tasks.C.es, at(2026, 11, 16, 8));
  assert.equal(ok.drivers.B.kind, 'MANUAL');
  const bad = schedule(proj([T('A', 5), T('B', 1, { mode: 'MANUAL', manualStart: at(2026, 11, 10) })], [{ pred: 'A', succ: 'B' }]));
  assert.equal(bad.tasks.B.es, at(2026, 11, 10, 8));            // user date wins
  assert.equal(bad.conflicts[0].code, 'MANUAL_DATE_CONFLICT');
  assert.throws(() => schedule(proj([T('X', 1, { mode: 'MANUAL' })])), (e: ScheduleError) => e.code === 'BAD_INPUT');
});

test('status date and progress: remaining work resumes at the status date; done tasks are fixed and non-critical', () => {
  const p = proj([T('A', 4, { actualStart: MON, percentComplete: 0.5 }), T('B', 1), T('C', 1, { percentComplete: 1, actualStart: MON, actualFinish: at(2026, 11, 9, 17) }), T('D', 1)],
    [{ pred: 'A', succ: 'B' }, { pred: 'C', succ: 'D' }], { statusDate: at(2026, 11, 11, 8) });
  const r = schedule(p);
  assert.equal(r.tasks.A.state, 'PROGRESS');
  assert.equal(r.tasks.A.es, MON);                              // actual start kept
  assert.equal(r.tasks.A.ef, at(2026, 11, 12, 17));             // 2 days remaining from Wed 08:00
  assert.equal(r.tasks.B.es, at(2026, 11, 13, 8));
  assert.equal(r.tasks.C.state, 'DONE');
  assert.equal(r.tasks.C.critical, false);
  assert.equal(r.tasks.D.es, at(2026, 11, 11, 8));              // after the status date (open work cannot start in the past)
  assert.equal(r.drivers.D.kind === 'STATUS_DATE' || r.drivers.D.kind === 'LINK', true);
  assert.equal(r.drivers.A.kind, 'ACTUAL');
  assert.throws(() => schedule(proj([T('X', 1, { percentComplete: 1 })])), (e: ScheduleError) => e.code === 'BAD_INPUT');
  assert.throws(() => schedule(proj([T('X', 1, { percentComplete: 1.5 })])), (e: ScheduleError) => e.code === 'BAD_INPUT');
});

test('calendar inheritance: null weekdays inherit; exceptions merge; cycles rejected', () => {
  const base = standardCalendar('base');
  base.exceptions = { '2026-11-11': [], '2026-11-12': [] };
  const friOff: CalendarDef = { id: 'fourday', baseId: 'base', week: [null, null, null, null, null, [], null], exceptions: { '2026-11-12': [{ startMin: 480, endMin: 720 }] } };
  const m = resolveCalendars([base, friOff]);
  const c = m.get('fourday')!;
  assert.equal(c.addWork(MON, 2 * D), at(2026, 11, 10, 17));   // Mon, Tue
  assert.equal(c.addWork(MON, 3 * D), at(2026, 11, 16, 12));   // Wed base holiday; Thu half day (derived override); Fri off -> remaining 4h on Mon
  assert.equal(new WorkCalendar(base).addWork(MON, 3 * D), at(2026, 11, 13, 17));
  assert.throws(() => resolveCalendars([{ id: 'a', baseId: 'b', week: [] }, { id: 'b', baseId: 'a', week: [] }]), (e: ScheduleError) => e.code === 'BAD_INPUT');
  assert.throws(() => resolveCalendars([{ id: 'a', baseId: 'zzz', week: [] }]), (e: ScheduleError) => e.code === 'BAD_INPUT');
});

test('ALAP: placed late with zero free float; dependants unaffected', () => {
  const r = schedule(proj([T('A', 5), T('B', 1, { constraint: { type: 'ALAP' } }), T('C', 1)], [{ pred: 'A', succ: 'C' }, { pred: 'B', succ: 'C' }]));
  assert.equal(r.tasks.B.es, at(2026, 11, 13, 8));              // late start so it finishes exactly when C starts... Fri
  assert.equal(r.tasks.B.freeFloatMin, 0);
  assert.equal(r.tasks.C.es, at(2026, 11, 16, 8));
});

test('summary is never both critical and nearCritical; constraint dates at end of day compare on the working-time axis', () => {
  const day = [{ startMin: 480, endMin: 720 }, { startMin: 780, endMin: 1020 }];
  const cal = { id: 'c', week: [[], day, day, day, day, day, []] };
  const MON = Date.UTC(2026, 10, 9);
  const at = (d: number, h: number, m = 0) => MON + d * 86_400_000 + (h * 60 + m) * 60_000;
  const r = schedule({
    startDate: at(0, 8), calendar: cal,
    tasks: [{ id: 'S', durationMin: 0 }, { id: 'A', durationMin: 480, parentId: 'S' }, { id: 'B', durationMin: 120, parentId: 'S' }, { id: 'C', durationMin: 480 }],
    links: [],
  });
  assert.equal(r.tasks.S.critical && r.tasks.S.nearCritical, false);
  // MSO exactly at end of Wednesday (17:00) == start of Thursday on the working-time axis: no conflict
  const r2 = schedule({ startDate: at(0, 8), calendar: cal, tasks: [{ id: 'T', durationMin: 480, constraint: { type: 'MSO', date: at(2, 17) } }], links: [] });
  assert.deepEqual(r2.conflicts, []);
});
