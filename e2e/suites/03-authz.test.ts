import { before, after } from 'node:test';
import { tc, status, problem, assert, obs, ctx } from '../lib/tc.ts';
import { startServer, newProject, createResource, makeMember, ensureOutsider, outsiderToken, USERS, uuid, T, L, addTask, addLink, type Server, type Proj, type UserKey } from '../lib/harness.ts';

let s: Server, X: Proj; let resMember: any, resOther: any; let TA: any, TB: any; // TA assigned to member's resource; TB unassigned
type Who = 'admin' | 'portfolio' | 'pm' | 'sched' | 'member' | 'viewer' | 'outsider';
const ROLE_OF: Record<Who, string> = { admin: 'ORG_ADMIN', portfolio: 'PORTFOLIO_MANAGER', pm: 'PROJECT_MANAGER', sched: 'SCHEDULER', member: 'TEAM_MEMBER', viewer: 'VIEWER', outsider: '(non-member)' };
const SHORT: Record<Who, string> = { admin: 'ORGADMIN', portfolio: 'PORTFOLIO', pm: 'PM', sched: 'SCHED', member: 'MEMBER', viewer: 'VIEWER', outsider: 'OUTSIDER' };
const WHOS = Object.keys(ROLE_OF) as Who[];
const tokenOf = (w: Who) => (w === 'outsider' ? outsiderToken() : w);
const call = (w: Who, m: string, p: string, b?: unknown) => s.call(tokenOf(w), m, p, b);

before(async () => {
  s = await startServer(); ensureOutsider();
  X = await newProject(s, 'pm');
  makeMember(X.id, 'admin', 'ORG_ADMIN');
  await X.addMember('portfolio', 'PORTFOLIO_MANAGER'); await X.addMember('sched', 'SCHEDULER'); await X.addMember('member', 'TEAM_MEMBER'); await X.addMember('viewer', 'VIEWER');
  resMember = await createResource(s, 'pm', { name: 'Tess the member', userId: USERS.member.id });
  resOther = await createResource(s, 'pm', { name: 'Someone else', userId: USERS.sched.id });
  TA = T('Assigned task', 960, { fixedCost: 500 }); TB = T('Unassigned task', 480, { fixedCost: 250 });
  await X.ok([addTask(TA), addTask(TB), { op: 'addAssignment', assignment: { id: uuid(), taskId: TA.id, resourceId: resMember.id, units: 1 } }]);
});
after(async () => { await s.stop(); });

const ver = async () => (await s.call('pm', 'GET', `/projects/${X.id}`)).body.planVersion as number;
const cmd = async (w: Who, commands: any[]) => call(w, 'POST', `/projects/${X.id}/commands`, { clientOpId: uuid(), expectedPlanVersion: await ver(), commands });
const pmOk = async (commands: any[]) => { let r = await cmd('pm', commands); if (r.status === 400 && /unknown resource/.test(r.text)) r = await cmd('pm', commands); /* see defect: stale resource cache */ if (r.status !== 200) throw new Error('fixture command failed: ' + r.text); return r; };
const fresh = async (name = 'f') => { const t = T(name + uuid().slice(0, 4), 60); await pmOk([addTask(t)]); return t; };

interface Action { key: string; refs: string[]; desc: string; allowed: Who[]; mutating?: boolean; prep?: () => Promise<any>; run: (w: Who, c: any) => Promise<any>; inferred?: boolean }
const ALL: Who[] = ['admin', 'portfolio', 'pm', 'sched', 'member', 'viewer'];
const EDIT: Who[] = ['admin', 'pm', 'sched'];
const PROG: Who[] = ['admin', 'pm', 'sched', 'member'];
const actions: Action[] = [
  { key: 'READ-PLAN', refs: ['docs/10 §4 Read plan'], desc: 'GET plan', allowed: ALL, run: (w) => call(w, 'GET', `/projects/${X.id}/plan`) },
  { key: 'READ-TASKS', refs: ['docs/10 §4 Read plan'], desc: 'GET tasks + task', allowed: ALL, run: async (w) => { const a = await call(w, 'GET', `/projects/${X.id}/tasks`); if (a.status !== 200) return a; return call(w, 'GET', `/projects/${X.id}/tasks/${TA.id}`); } },
  { key: 'READ-MEMBERS', refs: ['docs/10 §4 Read plan'], desc: 'GET members', allowed: ALL, run: (w) => call(w, 'GET', `/projects/${X.id}/members`) },
  { key: 'COST-EVM', refs: ['docs/10 §4 See rates/costs', 'FR-GV-01'], desc: 'GET evm', allowed: ['admin', 'portfolio', 'pm'], run: (w) => call(w, 'GET', `/projects/${X.id}/evm?statusDate=2026-11-12`) },
  { key: 'STRUCT-ADDTASK', refs: ['docs/10 §4 Edit structure'], desc: 'command addTask', allowed: EDIT, mutating: true, run: (w) => cmd(w, [addTask(T('n' + uuid().slice(0, 4), 60))]) },
  { key: 'STRUCT-UPDATE-DUR', refs: ['docs/10 §4 Edit structure'], desc: 'command updateTask durationMin', allowed: EDIT, mutating: true, prep: fresh, run: (w, t) => cmd(w, [{ op: 'updateTask', id: t.id, patch: { durationMin: 120 } }]) },
  { key: 'STRUCT-CONSTRAINT', refs: ['docs/10 §4 Edit constraints'], desc: 'command updateTask constraint', allowed: EDIT, mutating: true, prep: fresh, run: (w, t) => cmd(w, [{ op: 'updateTask', id: t.id, patch: { constraint: { type: 'SNET', date: '2026-11-16T08:00:00' } } }]) },
  { key: 'STRUCT-MOVE', refs: ['docs/10 §4 Edit structure'], desc: 'command moveTask', allowed: EDIT, mutating: true, prep: async () => ({ a: await fresh(), p: await fresh('parent') }), run: (w, c) => cmd(w, [{ op: 'moveTask', id: c.a.id, newParentId: c.p.id }]) },
  { key: 'STRUCT-DELETE', refs: ['docs/10 §4 Edit structure'], desc: 'command deleteTask', allowed: EDIT, mutating: true, prep: fresh, run: (w, t) => cmd(w, [{ op: 'deleteTask', id: t.id }]) },
  { key: 'LINK-ADD', refs: ['docs/10 §4 Edit links'], desc: 'command addLink', allowed: EDIT, mutating: true, prep: async () => ({ a: await fresh(), b: await fresh() }), run: (w, c) => cmd(w, [addLink(L(c.a.id, c.b.id))]) },
  { key: 'LINK-UPDATE', refs: ['docs/10 §4 Edit links'], desc: 'command updateLink', allowed: EDIT, mutating: true, prep: async () => { const a = await fresh(), b = await fresh(), l = L(a.id, b.id); await pmOk([addLink(l)]); return l; }, run: (w, l) => cmd(w, [{ op: 'updateLink', id: l.id, patch: { lagMin: 60 } }]) },
  { key: 'LINK-REMOVE', refs: ['docs/10 §4 Edit links'], desc: 'command removeLink', allowed: EDIT, mutating: true, prep: async () => { const a = await fresh(), b = await fresh(), l = L(a.id, b.id); await pmOk([addLink(l)]); return l; }, run: (w, l) => cmd(w, [{ op: 'removeLink', id: l.id }]) },
  { key: 'PROJ-SET', refs: ['docs/10 §4 Edit structure (project scheduling parameters)'], desc: 'command setProject', allowed: EDIT, mutating: true, inferred: true, run: (w) => cmd(w, [{ op: 'setProject', patch: { nearCriticalMin: 480 } }]) },
  { key: 'ASSIGN-ADD', refs: ['docs/10 §4 Edit structure (assignments)'], desc: 'command addAssignment', allowed: EDIT, mutating: true, inferred: true, prep: fresh, run: (w, t) => cmd(w, [{ op: 'addAssignment', assignment: { id: uuid(), taskId: t.id, resourceId: resOther.id, units: 1 } }]) },
  { key: 'PROGRESS', refs: ['docs/10 §4 Update own task progress'], desc: 'command updateTask percentComplete on the ASSIGNED task', allowed: PROG, mutating: true, run: (w) => cmd(w, [{ op: 'updateTask', id: TA.id, patch: { percentComplete: 0.25 } }]) },
  { key: 'BASELINE', refs: ['docs/10 §4 Save baseline', 'FR-CT-01'], desc: 'POST baselines', allowed: ['admin', 'pm'], run: (w) => call(w, 'POST', `/projects/${X.id}/baselines`, { number: Math.floor(Math.random() * 10) + 1 }) },
  { key: 'RISK', refs: ['docs/10 §4 Run risk'], desc: 'POST risk-runs', allowed: EDIT, run: (w) => call(w, 'POST', `/projects/${X.id}/risk-runs`, { iterations: 100, seed: 1 }) },
  { key: 'LEVEL-DRY', refs: ['docs/10 §4 Run levelling'], desc: 'POST level (dry run)', allowed: EDIT, run: (w) => call(w, 'POST', `/projects/${X.id}/level`, {}) },
  { key: 'LEVEL-APPLY', refs: ['docs/10 §4 Run levelling'], desc: 'POST level apply=true', allowed: EDIT, mutating: true, run: async (w) => call(w, 'POST', `/projects/${X.id}/level`, { apply: true, clientOpId: uuid(), expectedPlanVersion: await ver() }) },
  { key: 'EXPORT', refs: ['docs/10 §4 Import / export'], desc: 'GET export', allowed: ['admin', 'portfolio', 'pm', 'sched'], run: (w) => call(w, 'GET', `/projects/${X.id}/export?format=plan`) },
  { key: 'MEMBERS-SET', refs: ['docs/10 §4 Manage members'], desc: 'PUT member', allowed: ['admin', 'pm'], run: (w) => call(w, 'PUT', `/projects/${X.id}/members/${USERS.viewer.id}`, { role: 'VIEWER' }) },
  { key: 'MEMBERS-DEL', refs: ['docs/10 §4 Manage members'], desc: 'DELETE member', allowed: ['admin', 'pm'], prep: async () => { await X.addMember('portfolio', 'PORTFOLIO_MANAGER'); }, run: (w) => call(w, 'DELETE', `/projects/${X.id}/members/${USERS.portfolio.id}`) },
  { key: 'AUDIT', refs: ['docs/10 §4 Read audit trail', 'FR-GV-02'], desc: 'GET /audit-events', allowed: ['admin'], run: (w) => call(w, 'GET', `/audit-events?limit=5`) },
  { key: 'AUDIT-VERIFY', refs: ['docs/10 §4 Read audit trail', 'docs/10 §7'], desc: 'GET /audit-events/verify', allowed: ['admin'], run: (w) => call(w, 'GET', `/audit-events/verify`) },
];

// Execute the denied cells before the allowed ones for each action so state-changing allowed runs cannot mask a denial.
for (const a of actions) {
  for (const w of WHOS) {
    const allowed = a.allowed.includes(w);
    const id = `E2E-AUTHZ-${a.key}-${SHORT[w]}`;
    tc(id, [...a.refs, 'FR-GV-01', 'docs/10 T3'], `${ROLE_OF[w]} ${allowed ? 'MAY' : 'is DENIED to'} ${a.desc}${a.inferred ? ' (matrix row inferred)' : ''}`, async () => {
      const ctxv = a.prep ? await a.prep() : undefined; const v0 = await ver();
      if (w === 'viewer' && a.key === 'MEMBERS-DEL') { /* viewer role intact */ }
      const r = await a.run(w, ctxv);
      if (allowed) { assert.ok(r.status >= 200 && r.status < 300, `${ROLE_OF[w]} should be allowed to ${a.desc}, got HTTP ${r.status}${ctx(r)}`); return; }
      if (w === 'outsider') problem(r, [403, 404], ['FORBIDDEN', 'NOT_FOUND'], 'non-member'); else problem(r, 403, 'FORBIDDEN', `${ROLE_OF[w]} must be forbidden to ${a.desc}`);
      if (a.mutating) assert.equal(await ver(), v0, 'denied mutation must not change planVersion');
      if (a.key === 'BASELINE') { const l = await s.call('pm', 'GET', `/projects/${X.id}/baselines`); const arr = Array.isArray(l.body) ? l.body : l.body.items; assert.ok(!arr.some((b: any) => b.number === 99), 'no baseline created'); }
    });
  }
}

// ---------------------------------------------------------------- TEAM_MEMBER progress-only rule
const tm = (patch: any, id = () => TA.id) => cmd('member', [{ op: 'updateTask', id: id(), patch }]);
for (const [k, patch] of [['percentComplete', { percentComplete: 0.5 }], ['actualStart', { actualStart: '2026-11-09T08:00:00' }], ['actualFinish', { actualFinish: '2026-11-10T17:00:00', percentComplete: 1 }]] as const)
  tc(`E2E-AUTHZ-TM-ALLOW-${k}`, ['docs/10 §4 Update own task progress (assigned only)', 'FR-GV-01'], `TEAM_MEMBER may update ${k} on a task assigned to them (resource.user_id = user)`, async () => {
    const r = await tm({ ...patch }); status(r, 200);
    const t = await s.call('pm', 'GET', `/projects/${X.id}/tasks/${TA.id}`); if ('percentComplete' in patch) assert.equal(t.body.percentComplete, (patch as any).percentComplete);
    if ('actualStart' in patch) assert.equal(t.body.actualStart, (patch as any).actualStart);
  });
for (const [k, patch] of [['name', { name: 'hijacked' }], ['durationMin', { durationMin: 1 }], ['constraint', { constraint: { type: 'SNET', date: '2026-11-30T08:00:00' } }], ['notes', { notes: 'x' }], ['priority', { priority: 1000 }], ['fixedCost', { fixedCost: 0 }], ['custom', { custom: { a: 1 } }], ['mode', { mode: 'MANUAL', manualStart: '2026-11-09T08:00:00' }], ['calendarId', { calendarId: null }], ['kind', { kind: 'FIXED_DURATION' }], ['parentId-move', { parentId: null }], ['mixed progress+name', { percentComplete: 0.6, name: 'sneaky' }]] as const)
  tc(`E2E-AUTHZ-TM-DENY-${k.replace(/[^A-Za-z]/g, '')}`, ['docs/10 §4 Update own task progress (progress fields only)', 'docs/10 T3'], `TEAM_MEMBER may NOT change ${k} (non-progress field) even on an assigned task`, async () => {
    const v0 = await ver(); const before = (await s.call('pm', 'GET', `/projects/${X.id}/tasks/${TA.id}`)).body;
    const r = await tm({ ...patch }); problem(r, [403, 400], ['FORBIDDEN', 'VALIDATION_FAILED'], k); if (k !== 'parentId-move') assert.equal(r.status, 403, `must be 403 FORBIDDEN, got ${r.status}${ctx(r)}`);
    assert.equal(await ver(), v0, 'nothing applied'); const after = (await s.call('pm', 'GET', `/projects/${X.id}/tasks/${TA.id}`)).body; assert.deepEqual(after.name, before.name); assert.deepEqual(after.durationMin, before.durationMin);
  });
tc('E2E-AUTHZ-TM-DENY-unassigned', ['docs/10 §4 Update own task progress (assigned only)'], 'TEAM_MEMBER may NOT update progress on a task that is not assigned to them', async () => {
  const v0 = await ver(); const r = await tm({ percentComplete: 0.9 }, () => TB.id); problem(r, 403, 'FORBIDDEN'); assert.equal(await ver(), v0);
});
tc('E2E-AUTHZ-TM-DENY-otherresource', ['docs/10 §4 (assignment requires a resource whose user_id is that user)'], 'a task assigned only to someone else\'s resource is not "assigned" to the TEAM_MEMBER', async () => {
  const t = T('other-owner', 60); await pmOk([addTask(t), { op: 'addAssignment', assignment: { id: uuid(), taskId: t.id, resourceId: resOther.id, units: 1 } }]);
  const r = await tm({ percentComplete: 0.3 }, () => t.id); problem(r, 403, 'FORBIDDEN');
});
tc('E2E-AUTHZ-TM-DENY-unlinkedresource', ['docs/10 §4 (assignment requires a resource whose user_id is that user)'], 'a resource with the same display name but no user_id does not confer assignment', async () => {
  const lookalike = await createResource(s, 'pm', { name: 'Tess Member' }); const t = T('lookalike', 60);
  await pmOk([addTask(t), { op: 'addAssignment', assignment: { id: uuid(), taskId: t.id, resourceId: lookalike.id, units: 1 } }]);
  problem(await tm({ percentComplete: 0.3 }, () => t.id), 403, 'FORBIDDEN');
});
tc('E2E-AUTHZ-TM-DENY-mixedbatch', ['docs/07 §3 atomic batch', 'docs/10 §4'], 'a batch mixing an allowed progress update with a forbidden edit is rejected as a whole (nothing applied)', async () => {
  const v0 = await ver(); const r = await cmd('member', [{ op: 'updateTask', id: TA.id, patch: { percentComplete: 0.77 } }, { op: 'updateTask', id: TB.id, patch: { percentComplete: 0.77 } }]);
  problem(r, 403, 'FORBIDDEN'); assert.equal(await ver(), v0); const t = await s.call('pm', 'GET', `/projects/${X.id}/tasks/${TA.id}`); assert.notEqual(t.body.percentComplete, 0.77, 'first (allowed) command must not have been applied');
});
tc('E2E-AUTHZ-TM-DENY-structural', ['docs/10 §4'], 'TEAM_MEMBER cannot add/delete/link/assign even via a batch that also contains a legal progress update', async () => {
  for (const c of [addTask(T('x', 1)), { op: 'deleteTask', id: TB.id }, { op: 'addAssignment', assignment: { id: uuid(), taskId: TB.id, resourceId: resMember.id } }, { op: 'setProject', patch: { nearCriticalMin: 1 } }]) { const v0 = await ver(); const r = await cmd('member', [{ op: 'updateTask', id: TA.id, patch: { percentComplete: 0.4 } }, c]); problem(r, 403, 'FORBIDDEN', c.op); assert.equal(await ver(), v0, c.op); }
});
tc('E2E-AUTHZ-TM-REVOKE', ['docs/10 §4 (assigned only)'], 'removing the assignment immediately removes the TEAM_MEMBER\'s right to report progress', async () => {
  const t = T('revocable', 60), aid = uuid(); await pmOk([addTask(t), { op: 'addAssignment', assignment: { id: aid, taskId: t.id, resourceId: resMember.id } }]);
  status(await tm({ percentComplete: 0.1 }, () => t.id), 200, 'while assigned'); await pmOk([{ op: 'removeAssignment', id: aid }]);
  problem(await tm({ percentComplete: 0.2 }, () => t.id), 403, 'FORBIDDEN');
});
tc('E2E-AUTHZ-TM-VIEWER-PROGRESS', ['docs/10 §4 Update own task progress (Viewer: no)'], 'VIEWER (even if a resource is linked to them) cannot report progress', async () => {
  const rv = await createResource(s, 'pm', { name: 'Vic res', userId: USERS.viewer.id }); const t = T('viewer-task', 60);
  await pmOk([addTask(t), { op: 'addAssignment', assignment: { id: uuid(), taskId: t.id, resourceId: rv.id } }]);
  problem(await cmd('viewer', [{ op: 'updateTask', id: t.id, patch: { percentComplete: 0.5 } }]), 403, 'FORBIDDEN');
});

// ---------------------------------------------------------------- field-level cost visibility
const COSTY = ['fixedCost', 'cost', 'rate', 'rates', 'stdRatePerHour', 'evm', 'bac', 'ac'];
const hasCostKey = (o: any, path = ''): string[] => {
  const hits: string[] = []; if (Array.isArray(o)) o.forEach((x, i) => hits.push(...hasCostKey(x, path + '/' + i))); else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (COSTY.includes(k)) hits.push(path + '/' + k); hits.push(...hasCostKey(v, path + '/' + k)); }
  return hits;
};
for (const w of ['sched', 'member', 'viewer'] as Who[])
  tc(`E2E-AUTHZ-COSTFIELD-${SHORT[w]}`, ['docs/10 §4 field-level rule', 'FR-GV-01'], `${ROLE_OF[w]} responses omit cost/rate/evm fields everywhere (plan, task, task list, scenarios, baselines, risk, command result)`, async () => {
    const reads: Array<[string, any]> = [['plan', await call(w, 'GET', `/projects/${X.id}/plan`)], ['task', await call(w, 'GET', `/projects/${X.id}/tasks/${TA.id}`)], ['tasks', await call(w, 'GET', `/projects/${X.id}/tasks`)], ['baselines', await call(w, 'GET', `/projects/${X.id}/baselines`)], ['scenarios', await call(w, 'GET', `/projects/${X.id}/scenarios`)]];
    if (w === 'sched') reads.push(['export', await call(w, 'GET', `/projects/${X.id}/export?format=plan`)], ['commands', await cmd(w, [{ op: 'updateTask', id: TB.id, patch: { notes: 'cost-visibility probe' } }])]);
    const leaks: string[] = []; for (const [n, r] of reads) { assert.ok(r.status === 200, `${n}: HTTP ${r.status} ${r.text?.slice(0, 200)}`); const h = hasCostKey(r.body); if (h.length) leaks.push(`${n}: ${[...new Set(h.map((x) => x.replace(/\/\d+/g, '/*')))].join(', ')}`); }
    assert.equal(leaks.length, 0, `cost fields visible to ${ROLE_OF[w]}:\n  ` + leaks.join('\n  '));
  });
for (const w of ['admin', 'portfolio', 'pm'] as Who[])
  tc(`E2E-AUTHZ-COSTFIELD-POS-${SHORT[w]}`, ['docs/10 §4 See rates/costs'], `${ROLE_OF[w]} (cost-visible role) sees fixedCost on tasks`, async () => {
    const r = await call(w, 'GET', `/projects/${X.id}/tasks/${TA.id}`); status(r, 200); assert.equal(r.body.fixedCost, 500);
  });
tc('E2E-AUTHZ-COSTWRITE-SCHED', ['docs/10 §4 (Scheduler: cannot see/edit costs)', 'FR-GV-01'], 'SCHEDULER cannot set fixedCost (addTask with cost, updateTask fixedCost) and the plan is unchanged', async () => {
  const t = await fresh(); const v0 = await ver();
  const r1 = await cmd('sched', [{ op: 'updateTask', id: t.id, patch: { fixedCost: 9999 } }]); problem(r1, 403, 'FORBIDDEN', 'update fixedCost');
  const r2 = await cmd('sched', [addTask(T('costly', 60, { fixedCost: 123 }))]); problem(r2, 403, 'FORBIDDEN', 'add with fixedCost');
  assert.equal(await ver(), v0); const g = await s.call('pm', 'GET', `/projects/${X.id}/tasks/${t.id}`); assert.notEqual(g.body.fixedCost, 9999);
});
tc('E2E-AUTHZ-COSTWRITE-PM', ['docs/10 §4 See rates/costs'], 'PROJECT_MANAGER can set fixedCost', async () => {
  const t = await fresh(); status(await cmd('pm', [{ op: 'updateTask', id: t.id, patch: { fixedCost: 321 } }]), 200); assert.equal((await s.call('pm', 'GET', `/projects/${X.id}/tasks/${t.id}`)).body.fixedCost, 321);
});

// ---------------------------------------------------------------- membership rules
tc('E2E-AUTHZ-MEM-001', ['OAS setMember (only ORG_ADMIN can grant ORG_ADMIN)', 'docs/10 §4'], 'PROJECT_MANAGER cannot grant ORG_ADMIN (to anyone, including self); ORG_ADMIN can', async () => {
  const p = await newProject(s, 'pm'); makeMember(p.id, 'admin', 'ORG_ADMIN');
  problem(await s.call('pm', 'PUT', `/projects/${p.id}/members/${USERS.sched.id}`, { role: 'ORG_ADMIN' }), 403, 'FORBIDDEN'); problem(await s.call('pm', 'PUT', `/projects/${p.id}/members/${USERS.pm.id}`, { role: 'ORG_ADMIN' }), 403, 'FORBIDDEN', 'self-promotion');
  status(await s.call('admin', 'PUT', `/projects/${p.id}/members/${USERS.sched.id}`, { role: 'ORG_ADMIN' }), 200, 'org admin may grant');
  const m = (await s.call('pm', 'GET', `/projects/${p.id}/members`)).body.items; assert.equal(m.find((x: any) => x.userId === USERS.sched.id).role, 'ORG_ADMIN');
  status(await s.call('admin', 'PUT', `/projects/${p.id}/members/${USERS.sched.id}`, { role: 'VIEWER' }), 200, 'cleanup: org-admin grant must not leak into later tests');
});
tc('E2E-AUTHZ-MEM-002', ['OAS removeMember (project must keep at least one project manager)'], 'the last PROJECT_MANAGER cannot be removed (DELETE) - the member stays', async () => {
  const p = await newProject(s, 'pm'); const r = await s.call('pm', 'DELETE', `/projects/${p.id}/members/${USERS.pm.id}`); assert.ok([400, 409, 422].includes(r.status), `expected refusal, got ${r.status}${ctx(r)}`);
  const m = (await s.call('pm', 'GET', `/projects/${p.id}/members`)).body.items; assert.ok(m.some((x: any) => x.userId === USERS.pm.id && x.role === 'PROJECT_MANAGER'));
  await p.addMember('sched', 'PROJECT_MANAGER'); status(await s.call('pm', 'DELETE', `/projects/${p.id}/members/${USERS.pm.id}`), 204, 'allowed once another PM exists');
});
tc('E2E-AUTHZ-MEM-003', ['OAS removeMember (project must keep at least one project manager)', 'docs/05 §3 invariants'], 'the last PROJECT_MANAGER cannot be demoted via PUT either (project must keep >= 1 PM)', async () => {
  const p = await newProject(s, 'pm'); const r = await s.call('pm', 'PUT', `/projects/${p.id}/members/${USERS.pm.id}`, { role: 'VIEWER' });
  assert.ok([400, 409, 422].includes(r.status), `demoting the only PM must be refused, got ${r.status}${ctx(r)}`);
  const m = (await s.call('admin', 'GET', `/projects/${p.id}/members`)); void m;
});
tc('E2E-AUTHZ-MEM-004', ['OAS setMember', 'docs/07 §5 NOT_FOUND'], 'adding an unknown user, a user of another tenant, or a malformed id fails cleanly (not 200, not 500)', async () => {
  const p = await newProject(s, 'pm');
  for (const uid of [uuid(), USERS.pmB.id]) { const r = await s.call('pm', 'PUT', `/projects/${p.id}/members/${uid}`, { role: 'VIEWER' }); assert.ok([400, 404, 422].includes(r.status), `${uid}: ${r.status}${ctx(r)}`); }
  const members = (await s.call('pm', 'GET', `/projects/${p.id}/members`)).body.items; assert.equal(members.length, 1, 'no phantom member rows');
});
tc('E2E-AUTHZ-MEM-005', ['OAS setMember', 'docs/10 T3'], 'role change takes effect immediately (VIEWER -> SCHEDULER can edit; SCHEDULER -> VIEWER cannot) and removal revokes read access', async () => {
  const p = await newProject(s, 'pm'); await p.addMember('viewer', 'VIEWER'); const t = T('r', 60);
  const body = () => ({ clientOpId: uuid(), expectedPlanVersion: p.version, commands: [addTask(t)] });
  problem(await s.call('viewer', 'POST', `/projects/${p.id}/commands`, body()), 403, 'FORBIDDEN'); await p.addMember('viewer', 'SCHEDULER'); status(await s.call('viewer', 'POST', `/projects/${p.id}/commands`, body()), 200); p.version++;
  await p.addMember('viewer', 'VIEWER'); problem(await s.call('viewer', 'POST', `/projects/${p.id}/commands`, { clientOpId: uuid(), expectedPlanVersion: p.version, commands: [addTask(T('r2', 60))] }), 403, 'FORBIDDEN');
  status(await s.call('pm', 'DELETE', `/projects/${p.id}/members/${USERS.viewer.id}`), 204); problem(await s.call('viewer', 'GET', `/projects/${p.id}/plan`), [403, 404], ['FORBIDDEN', 'NOT_FOUND']);
});
tc('E2E-AUTHZ-MEM-006', ['OAS setMember (additionalProperties false)', 'docs/10 T4'], 'setMember rejects unknown body fields and invalid roles', async () => {
  const p = await newProject(s, 'pm');
  for (const b of [{ role: 'ROOT' }, { role: 'VIEWER', userId: USERS.admin.id }, {}, { role: null }, { role: 'viewer' }]) problem(await s.call('pm', 'PUT', `/projects/${p.id}/members/${USERS.viewer.id}`, b), 400, 'VALIDATION_FAILED', JSON.stringify(b));
});
tc('E2E-AUTHZ-MEM-007', ['docs/10 §4 Manage members', 'docs/10 T3'], 'PORTFOLIO_MANAGER/SCHEDULER cannot self-escalate via setMember', async () => {
  const p = await newProject(s, 'pm'); await p.addMember('sched', 'SCHEDULER'); await p.addMember('portfolio', 'PORTFOLIO_MANAGER');
  problem(await s.call('sched', 'PUT', `/projects/${p.id}/members/${USERS.sched.id}`, { role: 'PROJECT_MANAGER' }), 403, 'FORBIDDEN'); problem(await s.call('portfolio', 'PUT', `/projects/${p.id}/members/${USERS.portfolio.id}`, { role: 'PROJECT_MANAGER' }), 403, 'FORBIDDEN');
  const m = (await s.call('pm', 'GET', `/projects/${p.id}/members`)).body.items; assert.equal(m.find((x: any) => x.userId === USERS.sched.id).role, 'SCHEDULER');
});
tc('E2E-AUTHZ-MEM-008', ['docs/10 §4', 'docs/10 T3'], 'a PROJECT_MANAGER cannot demote or remove an ORG_ADMIN member (privilege protection)', async () => {
  const p = await newProject(s, 'pm'); makeMember(p.id, 'admin', 'ORG_ADMIN');
  const r1 = await s.call('pm', 'PUT', `/projects/${p.id}/members/${USERS.admin.id}`, { role: 'VIEWER' }); const r2 = await s.call('pm', 'DELETE', `/projects/${p.id}/members/${USERS.admin.id}`);
  assert.ok(r1.status === 403 && r2.status === 403, `PM must not be able to strip an ORG_ADMIN: PUT->${r1.status}, DELETE->${r2.status}${ctx(r1)}${ctx(r2)}`);
});

// ---------------------------------------------------------------- failed authorisations are audited
tc('E2E-AUTHZ-AUDIT-001', ['docs/10 §7 (failed authorisation logged)', 'FR-GV-02', 'docs/10 T13'], 'every 403 produces an audit event (action authz.denied) attributed to the actor and project', async () => {
  const p = await newProject(s, 'pm'); makeMember(p.id, 'admin', 'ORG_ADMIN'); await p.addMember('viewer', 'VIEWER'); await p.addMember('sched', 'SCHEDULER');
  const before = await s.call('admin', 'GET', '/audit-events?limit=500'); const n0 = before.body.items.length;
  const attempts: Array<[UserKey, string, string, unknown]> = [['viewer', 'POST', `/projects/${p.id}/commands`, { clientOpId: uuid(), expectedPlanVersion: 0, commands: [addTask(T('x', 1))] }], ['viewer', 'POST', `/projects/${p.id}/baselines`, { number: 1 }], ['sched', 'POST', `/projects/${p.id}/baselines`, { number: 1 }], ['sched', 'GET', `/projects/${p.id}/evm?statusDate=2026-11-10`], ['viewer', 'PUT', `/projects/${p.id}/members/${USERS.member.id}`, { role: 'VIEWER' }]];
  for (const [u, m, path, b] of attempts) problem(await s.call(u, m, path, b), 403, 'FORBIDDEN');
  const after = await s.call('admin', 'GET', '/audit-events?limit=500'); const ev = after.body.items.filter((e: any) => e.resourceId === p.id && /denied|forbid|authz/i.test(e.action));
  assert.ok(ev.length >= attempts.length, `expected >= ${attempts.length} denial events for project ${p.id}, found ${ev.length}; n0=${n0}; actions seen: ${[...new Set(after.body.items.slice(0, 15).map((e: any) => e.action))]}`);
  assert.ok(ev.some((e: any) => e.actorId === USERS.viewer.id) && ev.some((e: any) => e.actorId === USERS.sched.id), 'actors recorded');
});
tc('E2E-AUTHZ-AUDIT-002', ['docs/10 §7 (failed authorisation logged)'], 'denied access by a non-member of the project (404) is also audited', async () => {
  const p = await newProject(s, 'pm'); makeMember(p.id, 'admin', 'ORG_ADMIN'); ensureOutsider();
  for (let i = 0; i < 3; i++) problem(await s.call(outsiderToken(), 'GET', `/projects/${p.id}/plan`), [403, 404], ['FORBIDDEN', 'NOT_FOUND']);
  const ev = (await s.call('admin', 'GET', '/audit-events?limit=500')).body.items.filter((e: any) => e.actorId === 'a1000000-0000-4000-8000-0000000000ff' && /denied|forbid|authz|notfound/i.test(e.action));
  assert.ok(ev.length >= 1, 'no audit event recorded for repeated non-member access attempts to a project they cannot see');
});
tc('E2E-AUTHZ-AUDIT-003', ['docs/10 §4 Read audit trail'], 'denied audit-trail reads are themselves audited, and the denial detail carries no payload data', async () => {
  const before = (await s.call('admin', 'GET', '/audit-events?limit=500')).body.items.length;
  problem(await s.call('viewer', 'GET', '/audit-events'), 403, 'FORBIDDEN'); problem(await s.call('pm', 'GET', '/audit-events/verify'), 403, 'FORBIDDEN');
  const after = (await s.call('admin', 'GET', '/audit-events?limit=500')).body.items; assert.ok(after.length >= before + 2 || after.slice(0, 5).some((e: any) => /denied/.test(e.action) && e.actorId === USERS.viewer.id), 'denied audit read not audited');
});

// ---------------------------------------------------------------- unspecified actions: observation only
tc('E2E-AUTHZ-OBS-001', ['docs/10 §4 (actions not in the matrix)'], 'OBSERVATION: behaviour of actions the matrix does not list (PATCH/archive project, scenarios, schedule preview, tickets, resources) per role', async () => {
  const rows: string[] = [];
  for (const w of WHOS) {
    const p = await newProject(s, 'pm'); makeMember(p.id, 'admin', 'ORG_ADMIN'); await p.addMember('portfolio', 'PORTFOLIO_MANAGER'); await p.addMember('sched', 'SCHEDULER'); await p.addMember('member', 'TEAM_MEMBER'); await p.addMember('viewer', 'VIEWER'); await p.ok([addTask(T('o', 60))]);
    const out: string[] = [];
    out.push('PATCH:' + (await call(w, 'PATCH', `/projects/${p.id}`, { name: 'obs' }, )).status);
    out.push('scenario:' + (await call(w, 'POST', `/projects/${p.id}/scenarios`, { name: 'o', commands: [] })).status);
    out.push('preview:' + (await call(w, 'POST', `/projects/${p.id}/schedule`, { commands: [] })).status);
    out.push('ticket:' + (await call(w, 'POST', '/realtime/tickets', { projectId: p.id })).status);
    out.push('resource:' + (await call(w, 'POST', '/resources', { name: 'obs' })).status);
    out.push('archive:' + (await call(w, 'DELETE', `/projects/${p.id}`)).status);
    rows.push(`${ROLE_OF[w]}: ${out.join(' ')}`);
  }
  for (const r of rows) obs(r);
});
