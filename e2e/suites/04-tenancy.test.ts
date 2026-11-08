import { before, after } from 'node:test';
import { tc, status, problem, assert, obs, ctx } from '../lib/tc.ts';
import { startServer, newProject, createResource, makeMember, asApp, su, USERS, uuid, T, L, addTask, addLink, CAL_A, CAL_B, TENANT_A, TENANT_B, type Server, type Proj } from '../lib/harness.ts';

let s: Server, A: Proj, B: Proj; let tA: any, tA2: any, linkA: any, asgA: any, resA: any, resB: any;
before(async () => {
  s = await startServer();
  A = await newProject(s, 'pm'); B = await newProject(s, 'pmB');
  resA = await createResource(s, 'pm', { name: 'A-res', userId: USERS.member.id }); resB = await createResource(s, 'pmB', { name: 'B-res' });
  tA = T('A1', 480); tA2 = T('A2', 480); linkA = L(tA.id, tA2.id); asgA = { id: uuid(), taskId: tA.id, resourceId: resA.id, units: 1 };
  await A.ok([addTask(tA), addTask(tA2), addLink(linkA), { op: 'addAssignment', assignment: asgA }]);
  const tB1 = T('B1', 480); await B.ok([addTask(tB1), { op: 'addAssignment', assignment: { id: uuid(), taskId: tB1.id, resourceId: resB.id, units: 1 } }]);
  await s.call('pm', 'POST', `/projects/${A.id}/baselines`, { number: 0 });
  makeMember(A.id, 'admin', 'ORG_ADMIN'); makeMember(B.id, 'pmB', 'ORG_ADMIN'); // pmB is PM of B; bump to ORG_ADMIN for audit checks (A.id/B.id membership via SQL)
});
after(async () => { await s.stop(); });

const same = (x: any, y: any, m: string) => { assert.equal(x.status, y.status, m + ' status'); assert.equal(x.body?.code, y.body?.code, m + ' code'); assert.equal(x.body?.detail, y.body?.detail, m + ' detail'); };

// ---------------------------------------------------------------- API-level isolation
tc('E2E-TENANT-API-001', ['NFR-SEC-01', 'docs/10 T2', 'docs/07 §5 NOT_FOUND'], 'tenant B cannot read any tenant-A project sub-resource by guessing ids (all GET endpoints 404, identical to a random id)', async () => {
  const paths = (id: string) => [`/projects/${id}`, `/projects/${id}/plan`, `/projects/${id}/tasks`, `/projects/${id}/tasks/${tA.id}`, `/projects/${id}/members`, `/projects/${id}/calendars`, `/projects/${id}/scenarios`, `/projects/${id}/baselines`, `/projects/${id}/evm?statusDate=2026-11-12`, `/projects/${id}/export?format=plan`];
  for (const [pa, pr] of paths(A.id).map((p, i) => [p, paths(uuid())[i]])) { const r = await s.call('pmB', 'GET', pa); const rr = await s.call('pmB', 'GET', pr); problem(r, 404, 'NOT_FOUND', pa); assert.equal(r.status, rr.status); assert.equal(r.body.code, rr.body.code); }
});
tc('E2E-TENANT-API-002', ['NFR-SEC-01', 'docs/10 T2'], 'tenant B cannot write to a tenant-A project through any mutating endpoint (404) and nothing changes', async () => {
  const v0 = (await s.call('pm', 'GET', `/projects/${A.id}`)).body;
  const calls: Array<[string, string, unknown, Record<string, string>?]> = [
    ['POST', `/projects/${A.id}/commands`, { clientOpId: uuid(), expectedPlanVersion: v0.planVersion, commands: [addTask(T('evil', 1))] }],
    ['PATCH', `/projects/${A.id}`, { name: 'pwned' }, { 'If-Match': `"${v0.planVersion}"` }], ['DELETE', `/projects/${A.id}`, undefined], ['PUT', `/projects/${A.id}/members/${USERS.pmB.id}`, { role: 'PROJECT_MANAGER' }], ['DELETE', `/projects/${A.id}/members/${USERS.pm.id}`, undefined],
    ['POST', `/projects/${A.id}/baselines`, { number: 3 }], ['POST', `/projects/${A.id}/risk-runs`, { iterations: 100 }], ['POST', `/projects/${A.id}/level`, {}], ['POST', `/projects/${A.id}/scenarios`, { name: 'x', commands: [{ op: 'deleteTask', id: tA.id }] }], ['POST', `/projects/${A.id}/schedule`, { commands: [{ op: 'deleteTask', id: tA.id }] }], ['POST', '/realtime/tickets', { projectId: A.id }],
  ];
  for (const [m, p, b, h] of calls) { const r = await s.call('pmB', m, p, b, h ?? {}); problem(r, 404, 'NOT_FOUND', `${m} ${p}`); }
  const after = (await s.call('pm', 'GET', `/projects/${A.id}`)).body; assert.deepEqual(after, v0, 'project A unchanged');
  assert.equal((await s.call('pm', 'GET', `/projects/${A.id}/members`)).body.items.length, 2, 'A members unchanged (pm + ORG_ADMIN admin)');
});
tc('E2E-TENANT-API-003', ['NFR-SEC-01', 'docs/10 T2', 'docs/07 §5'], 'foreign ids embedded in command bodies (parentId, predId/succId, resourceId, taskId, calendarId, afterId, newParentId, link/assignment ids) are rejected like unknown ids and never touch tenant A', async () => {
  const cases: Array<[string, any[]]> = [
    ['addTask parentId=A task', [addTask(T('x', 1, { parentId: tA.id }))]], ['addTask afterId=A task', [addTask(T('x', 1), tA.id)]], ['addTask calendarId=A calendar', [addTask(T('x', 1, { calendarId: CAL_A }))]],
    ['addLink pred=A task', [addLink(L(tA.id, uuid()))]], ['updateTask id=A task', [{ op: 'updateTask', id: tA.id, patch: { name: 'pwned', durationMin: 1 } }]], ['deleteTask A task', [{ op: 'deleteTask', id: tA.id }]],
    ['moveTask A task', [{ op: 'moveTask', id: tA.id, newParentId: null }]], ['removeLink A link', [{ op: 'removeLink', id: linkA.id }]], ['updateLink A link', [{ op: 'updateLink', id: linkA.id, patch: { lagMin: 999 } }]],
    ['removeAssignment A asg', [{ op: 'removeAssignment', id: asgA.id }]], ['updateAssignment A asg', [{ op: 'updateAssignment', id: asgA.id, patch: { units: 5 } }]],
    ['addAssignment resource=A res', [{ op: 'addAssignment', assignment: { id: uuid(), taskId: uuid(), resourceId: resA.id } }]],
  ];
  const pl = await B.plan(); const bTask = pl.body.tasks[0].id; const out: string[] = [];
  cases.push(['addAssignment B task + A resource', [{ op: 'addAssignment', assignment: { id: uuid(), taskId: bTask, resourceId: resA.id } }]], ['moveTask B task under A task', [{ op: 'moveTask', id: bTask, newParentId: tA.id }]], ['addLink B task -> A task', [addLink(L(bTask, tA.id))]], ['addLink A task -> B task', [addLink(L(tA.id, bTask))]]);
  for (const [label, commands] of cases) {
    const r = await B.cmd(commands, 'pmB'); const rnd = await B.cmd(JSON.parse(JSON.stringify(commands).split(tA.id).join(uuid()).split(linkA.id).join(uuid()).split(asgA.id).join(uuid()).split(resA.id).join(uuid()).split(CAL_A).join(uuid())), 'pmB');
    if (r.status === 200) out.push(`${label}: ACCEPTED ${r.text.slice(0, 120)}`); else if (r.status === 400 && /unknown resource/.test(r.text)) { /* retry for stale resource cache */ }
    else { assert.ok(r.status >= 400 && r.status < 500, `${label}: ${r.status}`); if (r.status !== rnd.status || r.body?.code !== rnd.body?.code) out.push(`${label}: foreign id answered ${r.status}/${r.body?.code} but random id ${rnd.status}/${rnd.body?.code}`); }
  }
  assert.equal(out.length, 0, out.join('\n'));
  // tenant A state is untouched
  const ap = (await s.call('pm', 'GET', `/projects/${A.id}/plan`)).body; assert.equal(ap.tasks.length, 2); assert.equal(ap.links.length, 1); assert.equal(ap.assignments.length, 1); assert.equal(ap.tasks.find((t: any) => t.id === tA.id).name, 'A1'); assert.equal(ap.links[0].lagMin, 0);
  const bp = (await B.plan('pmB')).body; assert.ok(!bp.tasks.some((t: any) => t.name === 'x' || t.name === 'pwned'), 'nothing leaked into B');
});
tc('E2E-TENANT-API-004', ['NFR-SEC-01', 'docs/10 T2'], 'creating a project (or resource) in tenant B with tenant-A calendar/portfolio/resource ids is refused', async () => {
  const r = await s.call('pmB', 'POST', '/projects', { name: 'x-tenant', startDate: '2026-11-09T08:00:00', calendarId: CAL_A }); problem(r, 400, 'VALIDATION_FAILED');
  const r2 = await s.call('pmB', 'POST', '/resources', { name: 'x-cal', calendarId: CAL_A }); assert.ok([400, 404, 201].includes(r2.status), ctx(r2));
  if (r2.status === 201) { const lst = (await s.call('pmB', 'GET', '/resources?limit=500')).body.items.find((x: any) => x.id === r2.body.id); assert.ok(lst.calendarId !== CAL_A, 'a tenant-A calendar id must never be bound to a tenant-B resource (cross-tenant reference accepted: resource.calendarId=' + lst.calendarId + ')'); }
  const r3 = await s.call('pmB', 'POST', '/projects', { name: 'x-tenant', startDate: '2026-11-09T08:00:00', calendarId: CAL_B, portfolioId: uuid() }); assert.ok([400, 404].includes(r3.status), 'unknown portfolio rejected: ' + ctx(r3));
  const r4 = await s.call('pmB', 'POST', '/resources', { name: 'x', userId: USERS.member.id }); assert.ok([400, 404, 422].includes(r4.status), 'userId of tenant A user must not bind to a tenant-B resource: ' + ctx(r4));
});
tc('E2E-TENANT-API-004b', ['NFR-SEC-01', 'docs/07 §5 NOT_FOUND (never reveal existence)'], 'POST /resources calendarId: a foreign-tenant calendar id and a random id get the same answer (no existence oracle)', async () => {
  const foreign = await s.call('pmB', 'POST', '/resources', { name: 'oracle-1', calendarId: CAL_A }), random = await s.call('pmB', 'POST', '/resources', { name: 'oracle-2', calendarId: uuid() });
  assert.equal(foreign.status, random.status, `foreign calendar id -> ${foreign.status}, random id -> ${random.status}: tenant B can probe which calendar ids exist in tenant A`);
});
tc('E2E-TENANT-API-005', ['NFR-SEC-01'], 'list endpoints show only own-tenant rows (projects, resources) and resource load of a foreign resource is 404', async () => {
  const pa = (await s.call('pm', 'GET', '/projects?limit=500')).body.items.map((p: any) => p.id), pb = (await s.call('pmB', 'GET', '/projects?limit=500')).body.items.map((p: any) => p.id);
  assert.ok(pa.includes(A.id) && !pa.includes(B.id)); assert.ok(pb.includes(B.id) && !pb.includes(A.id));
  const ra = (await s.call('pm', 'GET', '/resources?limit=500')).body.items.map((r: any) => r.id), rb = (await s.call('pmB', 'GET', '/resources?limit=500')).body.items.map((r: any) => r.id);
  assert.ok(ra.includes(resA.id) && !ra.includes(resB.id) && rb.includes(resB.id) && !rb.includes(resA.id));
  problem(await s.call('pmB', 'GET', `/resources/${resA.id}/load?from=2026-11-09&to=2026-11-13`), 404, 'NOT_FOUND');
});
tc('E2E-TENANT-API-006', ['NFR-SEC-01', 'docs/10 §7'], 'audit trail is tenant-scoped: tenant-B org admin sees no tenant-A events and tenant A sees none of B\'s', async () => {
  const a = (await s.call('admin', 'GET', '/audit-events?limit=500')).body.items, b = (await s.call('pmB', 'GET', '/audit-events?limit=500'));
  status(b, 200, 'pmB is ORG_ADMIN of B via SQL'); assert.ok(a.length > 0 && b.body.items.length > 0);
  assert.ok(!a.some((e: any) => e.resourceId === B.id || e.actorId === USERS.pmB.id), 'A sees B events'); assert.ok(!b.body.items.some((e: any) => e.resourceId === A.id || e.actorId === USERS.pm.id), 'B sees A events');
  const v = await s.call('pmB', 'GET', '/audit-events/verify'); status(v, 200); assert.equal(v.body.ok, true);
});
tc('E2E-TENANT-API-007', ['docs/10 T2', 'docs/07 §1 Idempotency'], 'the same clientOpId in two tenants/projects does not collide or leak the other tenant\'s stored result', async () => {
  const op = uuid(); const t1 = T('same-op-A', 60), t2 = T('same-op-B', 60);
  const ra = await s.call('pm', 'POST', `/projects/${A.id}/commands`, { clientOpId: op, expectedPlanVersion: (await s.call('pm', 'GET', `/projects/${A.id}`)).body.planVersion, commands: [addTask(t1)] }); status(ra, 200);
  const rb = await s.call('pmB', 'POST', `/projects/${B.id}/commands`, { clientOpId: op, expectedPlanVersion: (await s.call('pmB', 'GET', `/projects/${B.id}`)).body.planVersion, commands: [addTask(t2)] }); status(rb, 200);
  assert.notEqual(rb.body.replayed, true, 'tenant B must get a fresh application, not tenant A\'s replay'); assert.ok(!rb.text.includes(t1.id)); assert.ok(!ra.text.includes(t2.id));
});
tc('E2E-TENANT-API-008', ['docs/10 T6', 'NFR-SEC-01'], 'SQL-injection style strings in names, ids and query parameters are inert (stored verbatim, tables intact, no extra rows exposed)', async () => {
  const before = Number(su(`SELECT count(*) FROM pf.project`)); const tasksBefore = Number(su(`SELECT count(*) FROM pf.task`));
  const inj = ["'; DROP TABLE pf.task; --", "' OR '1'='1", "\\'; DELETE FROM pf.project; --", '"; SELECT pg_sleep(5); --', "Robert'); DROP TABLE students;--", '${jndi:ldap://x}', "{{7*7}}", '%27%20OR%201=1--', "' UNION SELECT oidc_subject,email,id FROM pf.app_user --"];
  const p = await newProject(s, 'pm', { name: inj[0] }); assert.equal(p.project.name, inj[0]);
  const t0 = Date.now();
  for (const [i, str] of inj.entries()) {
    const t = T(str, 60); const r = await p.cmd([addTask(t)]); status(r, 200, 'addTask name=' + str);
    const g = await s.call('pm', 'GET', `/projects/${p.id}/tasks/${t.id}`); assert.equal(g.body.name, str, 'name round-trips verbatim');
    status(await s.call('pm', 'POST', '/resources', { name: str }), 201); const q = await s.call('pm', 'GET', `/projects/${p.id}/tasks?q=${encodeURIComponent(str)}`); status(q, 200);
    for (const bad of [`/projects/${encodeURIComponent(str)}`, `/projects/${p.id}/tasks?parentId=${encodeURIComponent(str)}`]) { const x = await s.call('admin', 'GET', bad); assert.ok(x.status >= 400 && x.status < 500, bad + ' -> ' + x.status); }
    const pf = await s.call('admin', 'GET', `/projects?portfolioId=${encodeURIComponent(str)}`); assert.ok(pf.status < 500, 'portfolioId injection ' + pf.status);
    const au = await s.call('admin', 'GET', `/audit-events?actorId=${encodeURIComponent(str)}&limit=500`); assert.ok(au.status < 500, 'audit filter injection: ' + au.status); if (au.status === 200) assert.ok(au.body.items.every((e: any) => e.actorId == null || /^[0-9a-f-]{36}$/.test(e.actorId)), 'no foreign rows');
    const idem = await s.call('pm', 'POST', '/projects', { name: 'inj-hdr', startDate: '2026-11-09T08:00:00', calendarId: CAL_A }, { 'Idempotency-Key': str.replace(/[^\x20-\x7e]/g, '') }); assert.ok(idem.status < 500, 'Idempotency-Key injection: ' + idem.status);
    void i;
  }
  assert.ok(Date.now() - t0 < 15000, 'no pg_sleep stall'); assert.ok(Number(su(`SELECT count(*) FROM pf.project`)) >= before, 'projects intact'); assert.ok(Number(su(`SELECT count(*) FROM pf.task`)) >= tasksBefore + inj.length, 'tasks table intact');
  assert.equal(su(`SELECT to_regclass('pf.task') IS NOT NULL`), 't');
});

// ---------------------------------------------------------------- SQL-level RLS as the application role
const TENANT_TABLES = ['app_user', 'portfolio', 'calendar', 'calendar_exception', 'project', 'project_member', 'task', 'task_link', 'custom_field_def', 'resource', 'resource_rate', 'assignment', 'assignment_timephase', 'baseline', 'baseline_task', 'scenario', 'risk_run', 'plan_op', 'comment', 'webhook_subscription', 'import_job', 'audit_event', 'outbox', 'realtime_ticket'];
tc('E2E-TENANT-SQL-000', ['NFR-SEC-01', 'docs/05 §5.1'], 'every pf table that carries tenant_id has ENABLE + FORCE row level security and a tenant policy (structural check, including partitions)', async () => {
  const rows = su(`SELECT c.relname || '|' || c.relrowsecurity || '|' || c.relforcerowsecurity || '|' || (SELECT count(*) FROM pg_policy p WHERE p.polrelid=c.oid) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='pf' AND c.relkind IN ('r','p') AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='tenant_id' AND NOT a.attisdropped) ORDER BY 1`).split('\n').map((l) => l.split('|'));
  const bad = rows.filter(([, rls, force, pol]) => rls !== 'true' || force !== 'true' || Number(pol) < 1).map(([n, rls, force, pol]) => `${n}(rls=${rls},force=${force},policies=${pol})`);
  obs(`tables with tenant_id: ${rows.length}`); assert.equal(bad.length, 0, 'tables without enforced RLS: ' + bad.join(', '));
});
tc('E2E-TENANT-SQL-001', ['NFR-SEC-01', 'docs/05 §5.1'], 'as pf_app with the WRONG tenant set, every tenant table returns 0 rows for tenant-A data', async () => {
  const offenders: string[] = [];
  for (const t of TENANT_TABLES) {
    const total = Number(su(`SELECT count(*) FROM pf.${t} WHERE tenant_id='${TENANT_A}'`)); // superuser truth
    const seen = await asApp(TENANT_B, async (c) => Number((await c.query(`SELECT count(*)::int AS n FROM pf.${t} WHERE tenant_id = $1`, [TENANT_A])).rows[0].n));
    const all = await asApp(TENANT_B, async (c) => Number((await c.query(`SELECT count(*)::int AS n FROM pf.${t} WHERE tenant_id <> $1`, [TENANT_B])).rows[0].n));
    if (seen !== 0 || all !== 0) offenders.push(`${t}: A-rows visible=${seen}/${total}, other-tenant rows=${all}`);
  }
  assert.equal(offenders.length, 0, offenders.join('\n'));
});
tc('E2E-TENANT-SQL-002', ['NFR-SEC-01', 'docs/05 §5.1'], 'as pf_app with NO tenant set (or an empty one) every tenant table yields 0 rows or fails closed', async () => {
  const offenders: string[] = [];
  for (const t of TENANT_TABLES) {
    const n = await asApp(null, async (c) => Number((await c.query(`SELECT count(*)::int AS n FROM pf.${t}`)).rows[0].n)); if (n !== 0) offenders.push(`${t}: ${n} rows with tenant unset`);
    try { const m = await asApp(null, async (c) => { await c.query(`SELECT set_config('pf.tenant_id','',true)`); return Number((await c.query(`SELECT count(*)::int AS n FROM pf.${t}`)).rows[0].n); }); if (m !== 0) offenders.push(`${t}: ${m} rows with empty tenant`); } catch { /* error = fail closed, acceptable */ }
  }
  assert.equal(offenders.length, 0, offenders.join('\n'));
});
tc('E2E-TENANT-SQL-003', ['NFR-SEC-01', 'docs/05 §5.1'], 'partitions of assignment_timephase are not directly readable across tenants by pf_app (RLS must also protect child tables)', async () => {
  const a1 = su(`SELECT id FROM pf.assignment WHERE tenant_id='${TENANT_A}' LIMIT 1`), b1 = su(`SELECT id FROM pf.assignment WHERE tenant_id='${TENANT_B}' LIMIT 1`); assert.ok(a1 && b1, 'precondition: assignments exist in both tenants');
  su(`INSERT INTO pf.assignment_timephase (assignment_id, tenant_id, day, planned_work_min) VALUES ('${a1}','${TENANT_A}','2030-01-01',480),('${b1}','${TENANT_B}','2030-01-01',480) ON CONFLICT DO NOTHING`);
  try {
  const leaks: string[] = [];
  for (const part of ['assignment_timephase_p0', 'assignment_timephase_p1', 'assignment_timephase_p2', 'assignment_timephase_p3']) {
    const none = await asApp(null, async (c) => (await c.query(`SELECT count(*)::int AS n, count(DISTINCT tenant_id)::int AS t FROM pf.${part}`)).rows[0]); const wrong = await asApp(TENANT_B, async (c) => (await c.query(`SELECT count(*)::int AS n FROM pf.${part} WHERE tenant_id=$1`, [TENANT_A])).rows[0].n);
    if (none.n > 0 || wrong > 0) leaks.push(`${part}: ${none.n} rows (${none.t} tenants) visible with no tenant; ${wrong} tenant-A rows visible as tenant B`);
  }
  assert.equal(leaks.length, 0, 'cross-tenant rows readable via partition tables:\n' + leaks.join('\n'));
  } finally { su(`DELETE FROM pf.assignment_timephase WHERE day='2030-01-01'`); }
});
tc('E2E-TENANT-SQL-004', ['NFR-SEC-01', 'docs/05 §5.1'], 'inserts for a tenant other than the session tenant (or with no tenant) are rejected by RLS on every writable tenant table tested', async () => {
  const stmts: Array<[string, string, unknown[]]> = [
    ['project', `INSERT INTO pf.project (tenant_id, name, calendar_id, start_local) VALUES ($1,'x',$2,'2026-01-01')`, [TENANT_A, CAL_A]], ['resource', `INSERT INTO pf.resource (tenant_id, name) VALUES ($1,'x')`, [TENANT_A]], ['calendar', `INSERT INTO pf.calendar (tenant_id, name, week) VALUES ($1,'x','[[],[],[],[],[],[],[]]')`, [TENANT_A]],
    ['app_user', `INSERT INTO pf.app_user (tenant_id, oidc_subject, email, display_name) VALUES ($1,'evil','e@x','e')`, [TENANT_A]], ['audit_event', `INSERT INTO pf.audit_event (tenant_id, action, resource, hash) VALUES ($1,'forged','project','\\x00')`, [TENANT_A]], ['portfolio', `INSERT INTO pf.portfolio (tenant_id, name) VALUES ($1,'x')`, [TENANT_A]],
    ['task (cross-tenant project)', `INSERT INTO pf.task (tenant_id, project_id, sort_key, name) VALUES ($1,$2,'a','x')`, [TENANT_B, A.id]], ['project_member', `INSERT INTO pf.project_member (project_id, user_id, tenant_id, role) VALUES ($1,$2,$3,'ORG_ADMIN')`, [A.id, USERS.pmB.id, TENANT_A]],
  ];
  const accepted: string[] = [];
  for (const [label, sql, params] of stmts) {
    for (const mode of ['wrong-tenant', 'no-tenant'] as const) {
      try { await asApp(mode === 'wrong-tenant' ? TENANT_B : null, async (c) => { await c.query(sql, params); }); accepted.push(`${label} [${mode}] ACCEPTED`); } catch (e: any) { if (!/row-level security|violates|permission denied|invalid input syntax|foreign key/i.test(e.message)) accepted.push(`${label} [${mode}] unexpected error ${e.message}`); }
    }
  }
  assert.equal(accepted.length, 0, accepted.join('\n'));
});
tc('E2E-TENANT-SQL-005', ['NFR-SEC-01'], 'UPDATE/DELETE against another tenant\'s rows affects 0 rows', async () => {
  for (const t of ['project', 'task', 'resource', 'task_link', 'assignment', 'calendar', 'app_user']) {
    const [u, d] = await asApp(TENANT_B, async (c) => [(await c.query(`UPDATE pf.${t} SET tenant_id = tenant_id WHERE tenant_id = $1`, [TENANT_A])).rowCount, (await c.query(`DELETE FROM pf.${t} WHERE tenant_id = $1`, [TENANT_A])).rowCount]);
    assert.equal(u, 0, `${t} update`); assert.equal(d, 0, `${t} delete`);
  }
  assert.ok(Number(su(`SELECT count(*) FROM pf.task WHERE tenant_id='${TENANT_A}'`)) > 0);
});
tc('E2E-TENANT-SQL-006', ['docs/10 T13', 'FR-GV-02'], 'pf_app cannot UPDATE/DELETE/TRUNCATE audit_event, plan_op or baseline_task, even for its own tenant', async () => {
  const attempts: Array<[string, string]> = [];
  for (const t of ['audit_event', 'plan_op', 'baseline_task']) { attempts.push([t, `UPDATE pf.${t} SET tenant_id = tenant_id`], [t, `DELETE FROM pf.${t}`], [t, `TRUNCATE pf.${t}`]); }
  attempts.push(['audit_event', `UPDATE pf.audit_event SET action='x' WHERE tenant_id='${TENANT_A}'`], ['plan_op', `DELETE FROM pf.plan_op WHERE tenant_id='${TENANT_A}'`]);
  const succeeded: string[] = [];
  for (const [t, sql] of attempts) { try { await asApp(TENANT_A, async (c) => { await c.query(sql); }); succeeded.push(sql); } catch (e: any) { assert.match(e.message, /permission denied|append-only/i, `${sql}: ${e.message}`); } }
  assert.equal(succeeded.length, 0, 'statements that succeeded: ' + succeeded.join(' ; '));
  assert.ok(Number(su(`SELECT count(*) FROM pf.audit_event`)) > 0 && Number(su(`SELECT count(*) FROM pf.plan_op`)) > 0, 'rows still present');
  for (const t of ['audit_event', 'plan_op', 'baseline_task']) for (const priv of ['UPDATE', 'DELETE', 'TRUNCATE']) assert.equal(su(`SELECT has_table_privilege('pf_app','pf.${t}','${priv}')`), 'f', `pf_app must not hold ${priv} on ${t}`);
});
tc('E2E-TENANT-SQL-007', ['docs/10 T6', 'docs/10 T13'], 'pf_app has no DDL, no RLS bypass: CREATE/DROP/ALTER/DISABLE RLS/SET ROLE/replication-role/COPY PROGRAM all fail', async () => {
  const stmts = [`CREATE TABLE pf.evil (x int)`, `DROP TABLE pf.task`, `ALTER TABLE pf.task DISABLE ROW LEVEL SECURITY`, `ALTER TABLE pf.task NO FORCE ROW LEVEL SECURITY`, `DROP POLICY tenant_isolation ON pf.task`, `DROP TRIGGER audit_event_no_update ON pf.audit_event`, `SET ROLE postgres`, `SET session_replication_role = replica`, `COPY (SELECT 1) TO PROGRAM 'id'`, `CREATE ROLE evil SUPERUSER`, `ALTER ROLE pf_app BYPASSRLS`, `SELECT pg_read_file('/etc/passwd')`, `CREATE FUNCTION pf.f() RETURNS int LANGUAGE sql AS 'SELECT 1'`, ];
  const ok: string[] = [];
  for (const sql of stmts) { try { await asApp(TENANT_A, async (c) => { await c.query(sql); }, { rollback: true }); ok.push(sql); } catch { /* denied as expected */ } }
  assert.equal(ok.length, 0, 'privileged statements accepted for pf_app: ' + ok.join(' ; '));
  const who = await asApp(null, async (c) => (await c.query(`SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user`)).rows[0]); assert.deepEqual(who, { rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false });
});
tc('E2E-TENANT-SQL-008', ['NFR-SEC-01', 'docs/05 §5.1'], 'the tenant GUC is transaction-local: a pooled connection does not keep a previous request\'s tenant', async () => {
  const pg = (await import('pg')).default; const { DB_URL } = await import('../lib/harness.ts'); const pool = new pg.Pool({ connectionString: DB_URL, max: 1 }); const c = await pool.connect();
  try { await c.query('BEGIN'); await c.query(`SELECT set_config('pf.tenant_id', $1, true)`, [TENANT_A]); assert.ok(Number((await c.query(`SELECT count(*)::int n FROM pf.project`)).rows[0].n) > 0); await c.query('COMMIT');
    let n: number; try { n = Number((await c.query(`SELECT count(*)::int n FROM pf.project`)).rows[0].n); } catch { n = 0; } assert.equal(n, 0, 'tenant context leaked past COMMIT'); } finally { c.release(); await pool.end(); }
});
tc('E2E-TENANT-SQL-009', ['NFR-SEC-01'], 'OBSERVATION: the tenant table has no RLS - pf_app can enumerate all tenants', async () => {
  const n = await asApp(TENANT_A, async (c) => Number((await c.query(`SELECT count(*)::int n FROM pf.tenant`)).rows[0].n)); obs(`pf_app sees ${n} tenant rows while acting as tenant A (tenant table is outside RLS)`);
});
