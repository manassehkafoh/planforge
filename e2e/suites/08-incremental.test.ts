import { before, after } from 'node:test';
import { tc, status, assert, record, obs } from '../lib/tc.ts';
import { startServer, newProject, createResource, uuid, T, L, addTask, addLink, type Server, type Proj } from '../lib/harness.ts';

let s: Server;
before(async () => { s = await startServer(); });
after(async () => { await s.stop(); });

const rng = (seed: number) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pad = (n: number) => String(n).padStart(2, '0');
const WRITABLE = ['name', 'durationMin', 'mode', 'kind', 'effortDriven', 'constraint', 'calendarId', 'percentComplete', 'priority', 'levelingDelayMin', 'workMin', 'notes', 'custom', 'fixedCost'];
interface Settings { deadline: string | null; statusDate: string | null; nearCriticalMin: number }
interface Model { p: Proj; settings: Settings; actuals: Map<string, { s: string; f: string }>; resources: string[] }

/** The comparable projection of a plan (no ids that legitimately differ between projects are removed; ids are mapped). */
const project = (plan: any, idMap?: Map<string, string>) => {
  const m = (id: string | null | undefined) => (id == null ? id : idMap?.get(id) ?? id);
  const tasks = plan.tasks.map((t: any) => ({ id: m(t.id), parentId: m(t.parentId), wbs: t.wbs, name: t.name, durationMin: t.durationMin, schedule: { ...t.schedule, driver: t.schedule.driver ? { ...t.schedule.driver, predId: m(t.schedule.driver.predId) } : t.schedule.driver } }));
  tasks.sort((a: any, b: any) => (a.id < b.id ? -1 : 1));
  const links = plan.links.map((l: any) => ({ p: m(l.predId), s: m(l.succId), type: l.type, lag: l.lagMin, basis: l.lagBasis })).sort((a: any, b: any) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
  const asg = plan.assignments.map((a: any) => ({ t: m(a.taskId), r: a.resourceId, u: a.units })).sort((a: any, b: any) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
  return { tasks, links, asg };
};
const firstDiff = (a: any, b: any, path = ''): string | null => {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object') { for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = firstDiff(a[k], b[k], path + '/' + k); if (d) return d; } }
  return `${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
};

/** Build a brand-new project from the export of `src` and return its comparable projection. */
async function replay(src: Model): Promise<{ proj: ReturnType<typeof project>; id: string }> {
  const ex = await s.call('pm', 'GET', `/projects/${src.p.id}/export`); status(ex, 200); const plan = (await s.call('pm', 'GET', `/projects/${src.p.id}/plan`)).body;
  const f = await newProject(s, 'pm', { startDate: ex.body.project.startDate }); const idMap = new Map<string, string>(); for (const t of ex.body.tasks) idMap.set(t.id, uuid());
  const kids = (pid: string | null) => ex.body.tasks.filter((t: any) => (t.parentId ?? null) === pid).sort((a: any, b: any) => (a.sortKey < b.sortKey ? -1 : 1));
  const cmds: any[] = []; const walk = (pid: string | null) => { let prev: string | null = null; for (const t of kids(pid)) { const body: any = { id: idMap.get(t.id) }; for (const k of WRITABLE) if (t[k] !== undefined && t[k] !== null) body[k] = t[k]; if (pid) body.parentId = idMap.get(pid); const a = src.actuals.get(t.id); if (a) { body.actualStart = a.s; body.actualFinish = a.f; } cmds.push(addTask(body, prev)); prev = idMap.get(t.id)!; walk(t.id); } }; walk(null);
  for (const l of ex.body.links) cmds.push(addLink({ id: uuid(), predId: idMap.get(l.predId), succId: idMap.get(l.succId), type: l.type, lagMin: l.lagMin, ...(l.lagBasis ? { lagBasis: l.lagBasis } : {}) }));
  for (const a of ex.body.assignments ?? plan.assignments) cmds.push({ op: 'addAssignment', assignment: { id: uuid(), taskId: idMap.get(a.taskId), resourceId: a.resourceId, units: a.units } });
  const patch: any = { nearCriticalMin: src.settings.nearCriticalMin }; if (src.settings.deadline) patch.deadline = src.settings.deadline; if (src.settings.statusDate) patch.statusDate = src.settings.statusDate; cmds.push({ op: 'setProject', patch });
  for (let i = 0; i < cmds.length; i += 400) await f.ok(cmds.slice(i, i + 400));
  return { proj: project((await f.plan()).body, new Map([...idMap].map(([o, n]) => [n, o]))), id: f.id };
}

function makeEdit(R: () => number, m: Model, tasks: any[], links: any[], allowNear = true): { cmds: any[]; label: string; onOk?: () => void } {
  const leaf = () => tasks[Math.floor(R() * tasks.length)]; const day = () => `2026-11-${pad(9 + Math.floor(R() * 14))}`; const hh = () => (R() < 0.5 ? '08:00' : R() < 0.5 ? '13:00' : '15:00');
  const k = R();
  if (k < 0.2 && tasks.length) { const t = leaf(); return { label: 'duration', cmds: [{ op: 'updateTask', id: t.id, patch: { durationMin: Math.floor(R() * 20) * 60 + (R() < 0.3 ? 30 : 0) } }] }; }
  if (k < 0.32 && tasks.length) { const t = leaf(); const ty = ['SNET', 'FNET', 'SNLT', 'FNLT', 'MSO', 'MFO', 'ASAP', 'ALAP'][Math.floor(R() * 8)]; return { label: 'constraint ' + ty, cmds: [{ op: 'updateTask', id: t.id, patch: { constraint: ty === 'ASAP' || ty === 'ALAP' ? { type: ty } : { type: ty, date: `${day()}T${hh()}:00` } } }] }; }
  if (k < 0.42) { const id = uuid(); const parent = tasks.length && R() < 0.3 ? leaf().id : null; return { label: 'addTask', cmds: [addTask(T('n' + id.slice(0, 4), (1 + Math.floor(R() * 12)) * 60, { id, ...(parent ? { parentId: parent } : {}) }))] }; }
  if (k < 0.62 && tasks.length > 1) { const a = leaf(), b = leaf(); const type = ['FS', 'FS', 'SS', 'FF', 'SF'][Math.floor(R() * 5)]; return { label: 'addLink ' + type, cmds: [addLink(L(a.id, b.id, type, (Math.floor(R() * 9) - 3) * 60))] }; }
  if (k < 0.7 && links.length) return { label: 'removeLink', cmds: [{ op: 'removeLink', id: links[Math.floor(R() * links.length)].id }] };
  if (k < 0.74 && links.length) return { label: 'updateLink', cmds: [{ op: 'updateLink', id: links[Math.floor(R() * links.length)].id, patch: { type: ['FS', 'SS', 'FF', 'SF'][Math.floor(R() * 4)], lagMin: (Math.floor(R() * 7) - 2) * 60 } }] };
  if (k < 0.8 && tasks.length > 5) return { label: 'deleteTask', cmds: [{ op: 'deleteTask', id: leaf().id }] };
  if (k < 0.85 && tasks.length > 2) { const a = leaf(), b = leaf(); return { label: 'moveTask', cmds: [{ op: 'moveTask', id: a.id, newParentId: R() < 0.3 ? null : b.id }] }; }
  if (k < 0.89) { const d = R() < 0.3 ? null : `2026-11-${pad(12 + Math.floor(R() * 20))}T17:00:00`; return { label: 'deadline', cmds: [{ op: 'setProject', patch: { deadline: d } }], onOk: () => (m.settings.deadline = d) }; }
  if (k < 0.92) { const d = R() < 0.3 ? null : `2026-11-${pad(9 + Math.floor(R() * 8))}T08:00:00`; return { label: 'statusDate', cmds: [{ op: 'setProject', patch: { statusDate: d } }], onOk: () => (m.settings.statusDate = d) }; }
  if (k < 0.94 && allowNear) { const n = [0, 240, 480, 960, 1920][Math.floor(R() * 5)]; return { label: 'nearCriticalMin', cmds: [{ op: 'setProject', patch: { nearCriticalMin: n } }], onOk: () => (m.settings.nearCriticalMin = n) }; }
  if (k < 0.96 && tasks.length) { const t = leaf(); const pc = [0.25, 0.5, 0.75][Math.floor(R() * 3)]; return { label: 'progress', cmds: [{ op: 'updateTask', id: t.id, patch: { percentComplete: pc } }] }; }
  if (k < 0.975 && tasks.length) { const t = leaf(); const d = day(); return { label: 'complete', cmds: [{ op: 'updateTask', id: t.id, patch: { percentComplete: 1, actualStart: `${d}T08:00:00`, actualFinish: `${d}T17:00:00` } }], onOk: () => m.actuals.set(t.id, { s: `${d}T08:00:00`, f: `${d}T17:00:00` }) }; }
  if (k < 0.99 && tasks.length) { const t = leaf(); return { label: 'assign', cmds: [{ op: 'addAssignment', assignment: { id: uuid(), taskId: t.id, resourceId: m.resources[Math.floor(R() * m.resources.length)], units: R() < 0.5 ? 1 : 0.5 } }] }; }
  const t = leaf(); return { label: 'levelingDelay', cmds: [{ op: 'updateTask', id: t.id, patch: { levelingDelayMin: Math.floor(R() * 5) * 120 } }] };
}

const N_PROJECTS = 12, EDITS = 25;
const models: Model[] = []; const snapshots = new Map<string, string>();
const randomRun = (allowNear: boolean, seedBase: number, keep: boolean) => async () => {
  const resources = [await createResource(s, 'pm', { name: 'incr-1' }), await createResource(s, 'pm', { name: 'incr-2' })].map((r) => r.id);
  let applied = 0, rejected = 0, checks = 0; const kinds: Record<string, number> = {}; const rejectedByStatus: Record<string, number> = {};
  for (let pi = 0; pi < N_PROJECTS; pi++) {
    const R = rng(seedBase + pi); const p = await newProject(s, 'pm'); const m: Model = { p, settings: { deadline: null, statusDate: null, nearCriticalMin: 960 }, actuals: new Map(), resources }; if (keep) models.push(m);
    const seedTasks = Array.from({ length: 8 }, (_, i) => T('s' + i, (1 + Math.floor(R() * 10)) * 60)); await p.ok(seedTasks.map((t) => addTask(t)));
    for (let e = 0; e < EDITS; e++) {
      const plan = (await p.plan()).body; const tasks = plan.tasks.filter((t: any) => !t.schedule.isSummary); const links = plan.links; const before = JSON.stringify(project(plan));
      const ed = makeEdit(R, m, tasks.length ? tasks : plan.tasks, links, allowNear); kinds[ed.label.split(' ')[0]] = (kinds[ed.label.split(' ')[0]] ?? 0) + 1;
      let r = await p.cmd(ed.cmds); if (r.status === 400 && /unknown resource/.test(r.text)) r = await p.cmd(ed.cmds);
      if (r.status === 200) { applied++; ed.onOk?.(); } else { rejected++; rejectedByStatus[r.status] = (rejectedByStatus[r.status] ?? 0) + 1; assert.ok(r.status >= 400 && r.status < 500, `edit "${ed.label}" -> ${r.status} ${r.text.slice(0, 200)}`); assert.equal(JSON.stringify(project((await p.plan()).body)), before, `rejected edit "${ed.label}" (${r.status}) changed the plan`); }
      if ((e + 1) % 5 === 0 || e === EDITS - 1) { const inc = project((await p.plan()).body); const rp = await replay(m); checks++; const d = firstDiff(inc, rp.proj); assert.equal(d, null, `project ${pi} after edit ${e + 1} (${ed.label}): incremental != full replay at ${d}`); }
    }
    if (keep) snapshots.set(p.id, JSON.stringify((await p.plan()).body));
  }
  record('incr.random.' + (allowNear ? 'all' : 'core'), { projects: N_PROJECTS, editsAttempted: N_PROJECTS * EDITS, applied, rejected, checks, kinds, rejectedByStatus }); assert.ok(applied >= 150, `only ${applied} edits applied; generator too restrictive`);
};
tc('E2E-INCR-RANDOM', ['docs/06 §7 incremental == full', 'NFR-QUAL-01', 'FR-SC-06'], `${N_PROJECTS} projects x ${EDITS} randomised edits INCLUDING nearCriticalMin changes: the incrementally maintained plan equals a fresh replay built from the export (checked every 5 edits and at the end)`, randomRun(true, 31000, false));
tc('E2E-INCR-RANDOM-CORE', ['docs/06 §7 incremental == full', 'NFR-QUAL-01', 'FR-SC-06'], `${N_PROJECTS} projects x ${EDITS} randomised edits (duration, constraints, add/remove/update links of all types, add/delete/move tasks, deadline, status date, progress, completion, assignments, levelling delay) EXCLUDING nearCriticalMin: incremental equals fresh replay`, randomRun(false, 41000, true));
tc('E2E-INCR-RESTART', ['docs/04 (stateless restart)', 'NFR-REL-02', 'docs/06 §7'], 'after a server restart (cold cache) every project\'s plan - including all schedule fields and drivers - is byte-identical to its pre-restart state', async () => {
  assert.ok(snapshots.size >= 10, 'precondition: INCR-RANDOM-CORE must have run'); const bad: string[] = [];
  await s.stop(); s = await startServer();
  for (const [id, snap] of snapshots) { const r = await s.call('pm', 'GET', `/projects/${id}/plan`); if (r.status !== 200) { bad.push(`${id}: ${r.status}`); continue; } const d = firstDiff(JSON.parse(snap), r.body); if (d) bad.push(`${id}: ${d}`); }
  assert.deepEqual(bad, [], 'plans differ after restart');
});
tc('E2E-INCR-RESTART-EDIT', ['docs/06 §7', 'NFR-REL-02'], 'after restart the first edit on a cold project equals the full replay (cache rebuilt correctly from the database)', async () => {
  const m = models[0]; const url = `/projects/${m.p.id}`; const plan = (await s.call('pm', 'GET', url + '/plan')).body; const t = plan.tasks.find((x: any) => !x.schedule.isSummary); assert.ok(t); const ver = (await s.call('pm', 'GET', url)).body.planVersion;
  const r = await s.call('pm', 'POST', url + '/commands', { clientOpId: uuid(), expectedPlanVersion: ver, commands: [{ op: 'updateTask', id: t.id, patch: { durationMin: 777 } }] }); status(r, 200);
  const inc = project((await s.call('pm', 'GET', url + '/plan')).body); const rp = await replay(m); assert.equal(firstDiff(inc, rp.proj), null);
});
tc('E2E-INCR-ROLLBACK', ['docs/06 §7 (rejected edits leave the network byte-identical)', 'docs/07 §3'], '30 rejected batches (cycles, unknown ids, link-to-summary, validation) interleaved with valid edits: plan state after each rejection is byte-identical, later valid edits still equal the replay', async () => {
  const p = await newProject(s, 'pm'); const ts = Array.from({ length: 6 }, (_, i) => T('r' + i, 480)); await p.ok([...ts.map((t) => addTask(t)), ...ts.slice(1).map((t, i) => addLink(L(ts[i].id, t.id)))]); const m: Model = { p, settings: { deadline: null, statusDate: null, nearCriticalMin: 960 }, actuals: new Map(), resources: [] };
  const rejectors = [() => [addLink(L(ts[5].id, ts[0].id))], () => [{ op: 'deleteTask', id: uuid() }], () => [{ op: 'updateTask', id: ts[2].id, patch: { durationMin: 9999 } }, addLink(L(ts[4].id, ts[1].id))], () => [addTask(T('child', 60, { parentId: ts[1].id }))], () => [{ op: 'updateTask', id: ts[3].id, patch: { durationMin: -4 } }], () => [{ op: 'updateTask', id: ts[0].id, patch: { constraint: { type: 'MSO' } } }]];
  for (let i = 0; i < 30; i++) {
    const before = JSON.stringify(project((await p.plan()).body)); const r = await p.cmd(rejectors[i % rejectors.length]()); assert.ok(r.status >= 400 && r.status < 500, `rejector ${i % rejectors.length}: ${r.status}`); assert.equal(JSON.stringify(project((await p.plan()).body)), before, `rejection ${i} changed state`);
    if (i % 5 === 4) { status(await p.cmd([{ op: 'updateTask', id: ts[i % 6].id, patch: { durationMin: 480 + 60 * i } }]), 200); const rp = await replay(m); assert.equal(firstDiff(project((await p.plan()).body), rp.proj), null, 'after valid edit ' + i); }
  }
});
tc('E2E-INCR-LARGE-BATCH', ['docs/06 §7', 'docs/07 §3'], 'a single 600-command batch (tasks, links, assignments) lands in the same state as the same commands applied one-by-one in a second project', async () => {
  const R = rng(777); const ids = Array.from({ length: 200 }, () => uuid()); const cmds: any[] = ids.map((id, i) => addTask(T('b' + i, (1 + Math.floor(R() * 8)) * 60, { id }))); for (let i = 1; i < 200; i++) { cmds.push(addLink(L(ids[Math.floor(R() * i)], ids[i], ['FS', 'SS', 'FF', 'SF'][Math.floor(R() * 4)], Math.floor(R() * 5) * 60))); if (i % 2) { const q = ids[Math.floor(R() * i)]; cmds.push(addLink(L(q, ids[i], 'SF', 60))); } }
  const a = await newProject(s, 'pm'); const ok = await a.cmd(cmds.slice(0, 600)); status(ok, 200);
  const b = await newProject(s, 'pm'); const map = new Map<string, string>(); const idsB = ids.map((id) => { const n = uuid(); map.set(id, n); return n; }); void idsB;
  const clone = (c: any) => JSON.parse(JSON.stringify(c, (k, v) => (typeof v === 'string' && map.has(v) ? map.get(v) : v), 0)); const cm = cmds.slice(0, 600).map((c) => { const x = clone(c); if (x.op === 'addLink') x.link.id = uuid(); return x; });
  for (const c of cm) status(await b.cmd([c]), 200);
  const pa = project((await a.plan()).body), pb = project((await b.plan()).body, new Map([...map].map(([o, n]) => [n, o]))); assert.equal(firstDiff(pa, pb), null);
});
