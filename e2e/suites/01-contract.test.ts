import { before, after } from 'node:test';
import { tc, status, problem, assert, obs, ctx } from '../lib/tc.ts';
import { startServer, newProject, createResource, makeMember, ensureOutsider, USERS, uuid, T, L, addTask, addLink, CAL_A, tokenFor, TENANT_A, TENANT_B, type Server, type Proj } from '../lib/harness.ts';
import { validateResponse, validateSchemaName, oas, operations, isRfc3339 } from '../lib/contract.ts';

let s: Server, P: Proj, adminProj: Proj; let res: any, taskA: any, taskB: any;
before(async () => {
  s = await startServer();
  ensureOutsider();
  P = await newProject(s, 'pm');
  adminProj = await newProject(s, 'pm');
  makeMember(adminProj.id, 'admin', 'ORG_ADMIN');
  res = await createResource(s, 'pm', { name: 'Contract res', maxUnits: 1 });
  taskA = T('A', 480); taskB = T('B', 960);
  await P.ok([addTask(taskA), addTask(taskB), addLink(L(taskA.id, taskB.id)), { op: 'addAssignment', assignment: { id: uuid(), taskId: taskA.id, resourceId: res.id, units: 1 } }]);
});
after(async () => { await s.stop(); });

const V = (path: string, method: string, r: { status: number; body: any }, ct = 'application/json') => {
  const errs = validateResponse(path, method, r.status, r.body, ct);
  assert.equal(errs.length, 0, `${method} ${path} -> ${r.status} violates OpenAPI schema:\n  ` + errs.slice(0, 8).join('\n  ') + `\n  body: ${JSON.stringify(r.body).slice(0, 500)}`);
};

// ---------------------------------------------------------------- A. operation conformance
tc('E2E-CONTRACT-001', ['OAS inventory'], 'OpenAPI declares the 32 operations the campaign enumerates (inventory sanity)', () => {
  assert.equal(operations.length, 32, 'operation count in api/openapi.yaml');
  for (const o of operations) assert.ok(o.operationId, o.path);
});

tc('E2E-CONTRACT-OP-listProjects', ['OAS listProjects', 'docs/07 §1.5'], 'GET /projects -> 200 Project page', async () => {
  const r = await s.call('pm', 'GET', '/projects'); status(r, 200); V('/projects', 'GET', r);
  assert.ok(r.body.items.some((p: any) => p.id === P.id), 'created project is listed');
});
tc('E2E-CONTRACT-OP-createProject', ['OAS createProject'], 'POST /projects -> 201 Project + Location', async () => {
  const r = await s.call('pm', 'POST', '/projects', { name: 'Contract', startDate: '2026-11-09T08:00:00', calendarId: CAL_A, currency: 'EUR', deadline: '2027-03-01T17:00:00' });
  status(r, 201); V('/projects', 'POST', r);
  assert.equal(r.body.currency, 'EUR'); assert.equal(r.body.status, 'ACTIVE'); assert.equal(r.body.planVersion, 0);
  assert.ok(r.headers.get('location'), 'Location header present'); assert.ok(r.headers.get('location')!.includes(r.body.id), 'Location references the new project');
});
tc('E2E-CONTRACT-OP-getProject', ['OAS getProject'], 'GET /projects/{id} -> 200 Project', async () => {
  const r = await s.call('pm', 'GET', `/projects/${P.id}`); status(r, 200); V('/projects/{projectId}', 'GET', r); assert.equal(r.body.id, P.id);
});
tc('E2E-CONTRACT-OP-updateProject', ['OAS updateProject', 'docs/07 §1.7'], 'PATCH /projects/{id} with If-Match -> 200 Project', async () => {
  const pr = await newProject(s, 'pm');
  const r = await s.call('pm', 'PATCH', `/projects/${pr.id}`, { name: 'Renamed', status: 'ON_HOLD' }, { 'If-Match': `"${pr.version}"` });
  status(r, 200); V('/projects/{projectId}', 'PATCH', r); assert.equal(r.body.name, 'Renamed'); assert.equal(r.body.status, 'ON_HOLD');
});
tc('E2E-CONTRACT-OP-updateProject-deadline', ['OAS ProjectPatch.deadline (nullable)'], 'PATCH deadline sets and clears (null) the project deadline', async () => {
  const pr = await newProject(s, 'pm');
  let r = await s.call('pm', 'PATCH', `/projects/${pr.id}`, { deadline: '2027-01-29T17:00:00' }, { 'If-Match': `"${pr.version}"` }); status(r, 200); assert.equal(r.body.deadline, '2027-01-29T17:00:00');
  r = await s.call('pm', 'PATCH', `/projects/${pr.id}`, { deadline: null }, { 'If-Match': `"${pr.version}"` }); status(r, 200); assert.ok(r.body.deadline == null);
});
tc('E2E-CONTRACT-OP-archiveProject', ['OAS archiveProject'], 'DELETE /projects/{id} -> 204 and project reads as ARCHIVED', async () => {
  const pr = await newProject(s, 'pm');
  const r = await s.call('pm', 'DELETE', `/projects/${pr.id}`); status(r, 204);
  assert.equal(r.text, '', '204 has no body');
  const g = await s.call('pm', 'GET', `/projects/${pr.id}`);
  if (g.status === 200) assert.equal(g.body.status, 'ARCHIVED'); else status(g, 404);
});
tc('E2E-CONTRACT-OP-getPlan', ['OAS getPlan', 'docs/07 §1.7'], 'GET plan -> 200 Plan, strong ETag equals planVersion', async () => {
  const r = await s.call('pm', 'GET', `/projects/${P.id}/plan`); status(r, 200); V('/projects/{projectId}/plan', 'GET', r);
  const etag = r.headers.get('etag'); assert.ok(etag && !etag.startsWith('W/'), `strong ETag expected, got ${etag}`);
  assert.equal(etag!.replace(/"/g, ''), String(r.body.planVersion), 'ETag = planVersion');
  for (const t of r.body.tasks) assert.ok(t.schedule?.es, 'task has schedule output');
});
tc('E2E-CONTRACT-OP-getPlan-ndjson', ['OAS getPlan (application/x-ndjson)'], 'GET plan with Accept: application/x-ndjson streams one JSON object per line', async () => {
  const r = await s.raw('GET', `/projects/${P.id}/plan`, { headers: { Authorization: 'Bearer ' + tokenFor('pm'), Accept: 'application/x-ndjson' } });
  status(r, 200);
  assert.match(r.headers.get('content-type') ?? '', /^application\/x-ndjson/, 'content-type must be application/x-ndjson' + ctx(r));
  const lines = r.text.split('\n').filter(Boolean); assert.ok(lines.length >= 3, 'one line per task/link'); for (const l of lines) JSON.parse(l);
});
tc('E2E-CONTRACT-OP-getPlan-include', ['OAS getPlan include'], 'GET plan?include=tasks limits the returned collections', async () => {
  const r = await s.call('pm', 'GET', `/projects/${P.id}/plan?include=tasks`); status(r, 200); V('/projects/{projectId}/plan', 'GET', r);
  assert.ok(Array.isArray(r.body.tasks)); assert.equal(r.body.links, undefined, 'links omitted when not requested'); assert.equal(r.body.calendars, undefined, 'calendars omitted when not requested');
});
tc('E2E-CONTRACT-OP-applyCommands', ['OAS applyCommands'], 'POST commands -> 200 CommandResult', async () => {
  const pr = await newProject(s, 'pm'); const a = T('x', 480);
  const r = await pr.cmd([addTask(a)]); status(r, 200); V('/projects/{projectId}/commands', 'POST', r);
  assert.equal(r.body.planVersion, 1); assert.deepEqual(r.body.changedTaskIds, [a.id]);
});
tc('E2E-CONTRACT-OP-listTasks', ['OAS listTasks'], 'GET tasks -> 200 Task page', async () => {
  const r = await s.call('pm', 'GET', `/projects/${P.id}/tasks`); status(r, 200); V('/projects/{projectId}/tasks', 'GET', r); assert.equal(r.body.items.length, 2);
});
tc('E2E-CONTRACT-FILTER-q', ['OAS listTasks q (name contains)'], 'GET tasks?q= filters by name substring', async () => {
  const pr = await newProject(s, 'pm'); await pr.ok([addTask(T('Foundation', 60)), addTask(T('Walls', 60)), addTask(T('Roof FOUNDATION trim', 60))]);
  const r = await s.call('pm', 'GET', `/projects/${pr.id}/tasks?q=foundation`); status(r, 200);
  assert.deepEqual(r.body.items.map((t: any) => t.name).sort(), ['Foundation', 'Roof FOUNDATION trim'], 'case-insensitive contains');
  const none = await s.call('pm', 'GET', `/projects/${pr.id}/tasks?q=zzzz`); status(none, 200); assert.equal(none.body.items.length, 0);
});
tc('E2E-CONTRACT-FILTER-critical', ['OAS listTasks critical'], 'GET tasks?critical=true|false filters on criticality', async () => {
  const pr = await newProject(s, 'pm'); const a = T('long', 960), b = T('short', 480); await pr.ok([addTask(a), addTask(b)]);
  const t = await s.call('pm', 'GET', `/projects/${pr.id}/tasks?critical=true`); status(t, 200); assert.deepEqual(t.body.items.map((x: any) => x.id), [a.id]);
  const f = await s.call('pm', 'GET', `/projects/${pr.id}/tasks?critical=false`); status(f, 200); assert.deepEqual(f.body.items.map((x: any) => x.id), [b.id]);
});
tc('E2E-CONTRACT-FILTER-parent', ['OAS listTasks parentId'], 'GET tasks?parentId= returns only direct children', async () => {
  const pr = await newProject(s, 'pm'); const par = T('par', 0), c1 = T('c1', 60, { parentId: par.id }), c2 = T('c2', 60, { parentId: par.id }), o = T('other', 60);
  await pr.ok([addTask(par), addTask(c1), addTask(c2), addTask(o)]);
  const r = await s.call('pm', 'GET', `/projects/${pr.id}/tasks?parentId=${par.id}`); status(r, 200); assert.deepEqual(r.body.items.map((x: any) => x.id).sort(), [c1.id, c2.id].sort());
});
tc('E2E-CONTRACT-FILTER-finishBefore', ['OAS listTasks finishBefore'], 'GET tasks?finishBefore= returns tasks finishing at or before the instant', async () => {
  const pr = await newProject(s, 'pm'); const a = T('a', 480), b = T('b', 480); await pr.ok([addTask(a), addTask(b), addLink(L(a.id, b.id))]);
  const r = await s.call('pm', 'GET', `/projects/${pr.id}/tasks?finishBefore=2026-11-09T17:00:00`); status(r, 200); assert.deepEqual(r.body.items.map((x: any) => x.id), [a.id]);
});
tc('E2E-CONTRACT-OP-getTask', ['OAS getTask'], 'GET task -> 200 Task with schedule output', async () => {
  const r = await s.call('pm', 'GET', `/projects/${P.id}/tasks/${taskA.id}`); status(r, 200); V('/projects/{projectId}/tasks/{taskId}', 'GET', r); assert.equal(r.body.id, taskA.id);
});
tc('E2E-CONTRACT-OP-previewSchedule', ['OAS previewSchedule (requestBody CommandBatch)'], 'POST schedule accepts a CommandBatch body and returns ScheduleResult', async () => {
  const r = await s.call('pm', 'POST', `/projects/${P.id}/schedule`, { clientOpId: uuid(), expectedPlanVersion: P.version, commands: [{ op: 'updateTask', id: taskA.id, patch: { durationMin: 960 } }] });
  status(r, 200); V('/projects/{projectId}/schedule', 'POST', r);
});
tc('E2E-CONTRACT-OP-listScenarios', ['OAS listScenarios'], 'GET scenarios -> 200 array of Scenario', async () => {
  const r = await s.call('pm', 'GET', `/projects/${P.id}/scenarios`); status(r, 200); V('/projects/{projectId}/scenarios', 'GET', r);
});
tc('E2E-CONTRACT-OP-createScenario', ['OAS createScenario'], 'POST scenarios -> 201 Scenario', async () => {
  const r = await s.call('pm', 'POST', `/projects/${P.id}/scenarios`, { name: 'what-if', commands: [{ op: 'updateTask', id: taskA.id, patch: { durationMin: 960 } }] });
  status(r, 201); V('/projects/{projectId}/scenarios', 'POST', r);
});
tc('E2E-CONTRACT-OP-listCalendars', ['OAS listCalendars'], 'GET calendars -> 200 array of Calendar', async () => {
  const r = await s.call('pm', 'GET', `/projects/${P.id}/calendars`); status(r, 200); V('/projects/{projectId}/calendars', 'GET', r);
});
tc('E2E-CONTRACT-OP-listResources', ['OAS listResources'], 'GET /resources -> 200 Resource page', async () => {
  const r = await s.call('pm', 'GET', '/resources'); status(r, 200); V('/resources', 'GET', r); assert.ok(r.body.items.some((x: any) => x.id === res.id));
});
tc('E2E-CONTRACT-OP-createResource', ['OAS createResource (ResourceCreate)'], 'POST /resources accepts every ResourceCreate property and echoes it', async () => {
  const body = { name: 'Full', kind: 'WORK', maxUnits: 2, calendarId: CAL_A, stdRatePerHour: 85.5 };
  const r = await s.call('pm', 'POST', '/resources', body); status(r, 201); V('/resources', 'POST', r);
  for (const k of Object.keys(body)) assert.deepEqual((r.body as any)[k], (body as any)[k], `Resource.${k} echoed`);
});
tc('E2E-CONTRACT-OP-getResourceLoad', ['OAS getResourceLoad'], 'GET resource load -> 200 array of {day, plannedMin, capacityMin, overallocated}', async () => {
  const r = await s.call('pm', 'GET', `/resources/${res.id}/load?from=2026-11-09&to=2026-11-13`); status(r, 200); V('/resources/{resourceId}/load', 'GET', r);
});
tc('E2E-CONTRACT-OP-levelResources', ['OAS levelResources'], 'POST level (dry run) -> 200 with documented fields', async () => {
  const r = await s.call('pm', 'POST', `/projects/${P.id}/level`, {}); status(r, 200); V('/projects/{projectId}/level', 'POST', r); assert.equal(r.body.applied, false);
});
tc('E2E-CONTRACT-OP-saveBaseline', ['OAS saveBaseline'], 'POST baselines -> 201 Baseline; duplicate number -> 409', async () => {
  const pr = await newProject(s, 'pm'); await pr.ok([addTask(T('b', 480))]);
  const r = await s.call('pm', 'POST', `/projects/${pr.id}/baselines`, { number: 0, label: 'BL0' }); status(r, 201); V('/projects/{projectId}/baselines', 'POST', r);
  const d = await s.call('pm', 'POST', `/projects/${pr.id}/baselines`, { number: 0 }); status(d, 409);
  const r2 = await s.call('pm', 'POST', `/projects/${pr.id}/baselines`, { number: 1 }); status(r2, 201); V('/projects/{projectId}/baselines', 'POST', r2);
});
tc('E2E-CONTRACT-OP-listBaselines', ['OAS listBaselines'], 'GET baselines -> 200 array of Baseline', async () => {
  const pr = await newProject(s, 'pm'); await pr.ok([addTask(T('b', 480))]); await s.call('pm', 'POST', `/projects/${pr.id}/baselines`, { number: 2, label: 'x' });
  const r = await s.call('pm', 'GET', `/projects/${pr.id}/baselines`); status(r, 200); V('/projects/{projectId}/baselines', 'GET', r);
});
tc('E2E-CONTRACT-OP-getEarnedValue', ['OAS getEarnedValue', 'FR-CT-02'], 'GET evm -> 200 Evm', async () => {
  const pr = await newProject(s, 'pm'); await pr.ok([addTask(T('b', 480, { fixedCost: 100 }))]); await s.call('pm', 'POST', `/projects/${pr.id}/baselines`, { number: 0 });
  const r = await s.call('pm', 'GET', `/projects/${pr.id}/evm?statusDate=2026-11-10`); status(r, 200); V('/projects/{projectId}/evm', 'GET', r);
});
tc('E2E-CONTRACT-OP-getEarnedValue-default', ['OAS getEarnedValue (statusDate optional)'], 'GET evm without statusDate is accepted (parameter is optional in the OAS)', async () => {
  const pr = await newProject(s, 'pm'); await pr.ok([addTask(T('b', 480, { fixedCost: 100 }))]); await s.call('pm', 'POST', `/projects/${pr.id}/baselines`, { number: 0 });
  const r = await s.call('pm', 'GET', `/projects/${pr.id}/evm`); status(r, 200); V('/projects/{projectId}/evm', 'GET', r);
});
tc('E2E-CONTRACT-OP-startRiskRun', ['OAS startRiskRun', 'FR-CT-04'], 'POST risk-runs -> 201/202 RiskRun; GET run -> 200', async () => {
  const r = await s.call('pm', 'POST', `/projects/${P.id}/risk-runs`, { iterations: 200, seed: 7 }); status(r, [201, 202]); V('/projects/{projectId}/risk-runs', 'POST', r);
  const g = await s.call('pm', 'GET', `/projects/${P.id}/risk-runs/${r.body.id}`); status(g, 200); V('/projects/{projectId}/risk-runs/{runId}', 'GET', g);
});
tc('E2E-CONTRACT-OP-exportProject', ['OAS exportProject', 'FR-IN-02'], 'GET export?format=plan -> 200 file', async () => {
  const r = await s.call('pm', 'GET', `/projects/${P.id}/export?format=plan`); status(r, 200);
  assert.ok(r.text.length > 10);
});
tc('E2E-CONTRACT-OP-exportProject-formats', ['OAS exportProject enum', 'FR-IN-02'], 'export honours the requested format (csv is not the plan JSON) and rejects unknown formats', async () => {
  const csv = await s.call('pm', 'GET', `/projects/${P.id}/export?format=csv`);
  if (csv.status === 200) assert.ok(!/^\s*\{/.test(csv.text) && /csv/i.test(csv.headers.get('content-type') ?? ''), `format=csv must return CSV, got content-type ${csv.headers.get('content-type')} body ${csv.text.slice(0, 80)}`);
  else problem(csv, [422, 501], ['IMPORT_UNSUPPORTED', 'NOT_IMPLEMENTED']);
  const bad = await s.call('pm', 'GET', `/projects/${P.id}/export?format=docx`); problem(bad, 400, 'VALIDATION_FAILED');
  const none = await s.call('pm', 'GET', `/projects/${P.id}/export`); problem(none, 400, 'VALIDATION_FAILED');
});
tc('E2E-CONTRACT-OP-members', ['OAS listMembers/setMember/removeMember'], 'members: list 200, PUT 200, DELETE 204 with schema', async () => {
  const pr = await newProject(s, 'pm');
  let r = await s.call('pm', 'PUT', `/projects/${pr.id}/members/${USERS.viewer.id}`, { role: 'VIEWER' }); status(r, 200);
  r = await s.call('pm', 'GET', `/projects/${pr.id}/members`); status(r, 200); V('/projects/{projectId}/members', 'GET', r);
  assert.equal(r.body.items.length, 2);
  r = await s.call('pm', 'DELETE', `/projects/${pr.id}/members/${USERS.viewer.id}`); status(r, 204);
});
tc('E2E-CONTRACT-OP-createRealtimeTicket', ['OAS createRealtimeTicket'], 'POST realtime/tickets -> 201 {ticket, expiresAt}', async () => {
  const r = await s.call('pm', 'POST', '/realtime/tickets', { projectId: P.id }); status(r, 201); V('/realtime/tickets', 'POST', r);
  assert.ok(isRfc3339(r.body.expiresAt), 'expiresAt is RFC 3339 with offset');
  const dt = Date.parse(r.body.expiresAt) - Date.now(); assert.ok(dt > 0 && dt <= 61000, `ticket TTL ${dt}ms must be in (0, 60s]`);
});
tc('E2E-CONTRACT-OP-listAuditEvents', ['OAS listAuditEvents', 'docs/10 §7'], 'GET audit-events as ORG_ADMIN -> 200 AuditEvent page (RFC 3339 timestamps)', async () => {
  const r = await s.call('admin', 'GET', '/audit-events?limit=5'); status(r, 200); V('/audit-events', 'GET', r);
  assert.ok(r.body.items.length > 0); for (const e of r.body.items) assert.ok(isRfc3339(e.occurredAt), 'occurredAt RFC3339 UTC');
});
for (const [m, p, body] of [['GET', '/webhooks', undefined], ['POST', '/webhooks', { url: 'https://example.com/h', events: ['plan.changed'] }], ['POST', '/imports', { format: 'CSV', fileName: 'a.csv' }], ['GET', `/imports/${uuid()}`, undefined]] as const)
  tc(`E2E-CONTRACT-501-${m}${p.replace(/[^A-Za-z]/g, '').slice(0, 10)}`, ['docs/07 §5 NOT_IMPLEMENTED', 'OAS createWebhook/listWebhooks/createImport/getImport'], `${m} ${p.replace(/[0-9a-f-]{36}/, '{id}')} -> 501 problem+json NOT_IMPLEMENTED`, async () => {
    const r = await s.call('pm', m, p, body); problem(r, 501, 'NOT_IMPLEMENTED');
    assert.equal(validateSchemaName('Problem', r.body).length, 0, 'valid Problem body');
  });
for (const [m, p, body] of [['GET', '/webhooks', undefined], ['POST', '/imports', { format: 'CSV', fileName: 'a.csv' }]] as const)
  tc(`E2E-CONTRACT-501-unauth-${m}${p.replace(/[^A-Za-z]/g, '')}`, ['docs/07 §5 UNAUTHENTICATED'], `${m} ${p} without a token is 401, never 501 (auth precedes stub)`, async () => {
    const r = await s.call(null, m, p, body); problem(r, 401, 'UNAUTHENTICATED');
  });

// ---------------------------------------------------------------- pagination / idempotency / headers
tc('E2E-CONTRACT-PAGE-001', ['docs/07 §1.5 keyset pagination', 'OAS Cursor/Limit'], 'tasks pagination walks every task exactly once with opaque cursors', async () => {
  const pr = await newProject(s, 'pm'); const ts = Array.from({ length: 23 }, (_, i) => T('t' + i, 60));
  await pr.ok(ts.map((t) => addTask(t)));
  const seen: string[] = []; let cursor: string | null | undefined; let pages = 0;
  do {
    const r = await s.call('pm', 'GET', `/projects/${pr.id}/tasks?limit=5${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`); status(r, 200); V('/projects/{projectId}/tasks', 'GET', r);
    assert.ok(r.body.items.length <= 5); seen.push(...r.body.items.map((t: any) => t.id)); cursor = r.body.nextCursor; pages++;
  } while (cursor && pages < 20);
  assert.equal(new Set(seen).size, 23, 'no duplicates'); assert.deepEqual(new Set(seen), new Set(ts.map((t) => t.id)), 'no omissions'); assert.equal(pages, 5);
});
tc('E2E-CONTRACT-PAGE-002', ['OAS Limit (1..500)', 'docs/07 §1.5'], 'limit outside 1..500 and non-numeric limit/garbage cursor -> 400 VALIDATION_FAILED', async () => {
  for (const q of ['limit=0', 'limit=501', 'limit=-3', 'limit=abc', 'limit=1.5', 'cursor=' + 'x'.repeat(600)]) {
    const r = await s.call('pm', 'GET', `/projects/${P.id}/tasks?${q}`); problem(r, 400, 'VALIDATION_FAILED', q);
  }
  const g = await s.call('pm', 'GET', `/projects/${P.id}/tasks?cursor=%00%00garbage`); problem(g, 400, 'VALIDATION_FAILED', 'garbage cursor');
});
tc('E2E-CONTRACT-PAGE-003', ['docs/07 §1.5', 'OAS Limit'], 'limit=500 is accepted on every paged list', async () => {
  for (const p of ['/projects', '/resources', `/projects/${P.id}/tasks`]) { const r = await s.call('pm', 'GET', p + '?limit=500'); status(r, 200, p); }
});
tc('E2E-CONTRACT-QUERY-001', ['OAS parameters (uuid / date-time formats)', 'docs/07 §5 VALIDATION_FAILED'], 'malformed typed query parameters are rejected with 400 (audit-events actorId/from/to, projects portfolioId, resources load dates)', async () => {
  const bad: string[] = [];
  for (const [who, path] of [['admin', '/audit-events?actorId=not-a-uuid'], ['admin', '/audit-events?from=yesterday'], ['admin', '/audit-events?to=2026-99-99T00:00:00Z'], ['pm', '/projects?portfolioId=not-a-uuid'], ['pm', `/resources/${res.id}/load?from=bad&to=2026-01-01`], ['pm', `/resources/${res.id}/load?from=2026-02-30&to=2026-03-01`], ['pm', `/resources/${res.id}/load?from=2026-03-02&to=2026-03-01`], ['pm', `/resources/${res.id}/load`]] as const) {
    const r = await s.call(who, 'GET', path); if (r.status !== 400) bad.push(`${path} -> ${r.status}`);
  }
  assert.equal(bad.length, 0, 'accepted malformed parameters: ' + bad.join('; '));
});
tc('E2E-CONTRACT-IDEMP-001', ['docs/07 §1.6 Idempotency-Key', 'OAS IdempotencyKey'], 'POST /projects with the same Idempotency-Key replays the original response (one project)', async () => {
  const key = uuid(); const body = { name: 'Idem ' + key, startDate: '2026-11-09T08:00:00', calendarId: CAL_A };
  const a = await s.call('pm', 'POST', '/projects', body, { 'Idempotency-Key': key }); status(a, 201);
  const b = await s.call('pm', 'POST', '/projects', body, { 'Idempotency-Key': key });
  status(b, [200, 201]); assert.equal(b.body.id, a.body.id, 'replay returns the original project id');
  const list = await s.call('pm', 'GET', '/projects?limit=500'); assert.equal(list.body.items.filter((p: any) => p.name === body.name).length, 1, 'exactly one project created');
});
tc('E2E-CONTRACT-IDEMP-002', ['docs/07 §1.6 Idempotency-Key'], 'Idempotency-Key reuse with a different body is rejected (not silently replayed)', async () => {
  const key = uuid(); const a = await s.call('pm', 'POST', '/projects', { name: 'I1 ' + key, startDate: '2026-11-09T08:00:00', calendarId: CAL_A }, { 'Idempotency-Key': key }); status(a, 201);
  const b = await s.call('pm', 'POST', '/projects', { name: 'I2 ' + key, startDate: '2026-11-09T08:00:00', calendarId: CAL_A }, { 'Idempotency-Key': key });
  assert.ok(b.status === 409 || b.status === 422 || b.status === 400, 'different body under same key must be refused, got ' + b.status + ctx(b));
  assert.notEqual(b.body?.id, a.body.id);
});
tc('E2E-CONTRACT-IFMATCH-001', ['OAS updateProject (If-Match required)', 'docs/07 §1.7'], 'PATCH /projects without If-Match is rejected; stale If-Match is a 409 VERSION_CONFLICT', async () => {
  const pr = await newProject(s, 'pm');
  const none = await s.call('pm', 'PATCH', `/projects/${pr.id}`, { name: 'no-etag' });
  assert.ok([400, 428].includes(none.status), `missing If-Match must be refused (400/428), got ${none.status}${ctx(none)}`);
  await pr.ok([addTask(T('bump', 60))]);
  const stale = await s.call('pm', 'PATCH', `/projects/${pr.id}`, { name: 'stale' }, { 'If-Match': '"0"' }); problem(stale, [409, 412], ['VERSION_CONFLICT']);
});
tc('E2E-CONTRACT-HDR-001', ['docs/07 §1.4', 'RFC 9457'], 'success responses are application/json (UTF-8) and errors application/problem+json', async () => {
  const ok = await s.call('pm', 'GET', '/projects'); assert.match(ok.headers.get('content-type') ?? '', /^application\/json/);
  const bad = await s.call('pm', 'GET', '/projects/not-a-uuid'); assert.match(bad.headers.get('content-type') ?? '', /^application\/problem\+json/);
});
tc('E2E-CONTRACT-HDR-002', ['docs/07 §1.8 plan instants naive local', 'OAS Project'], 'plan instants in responses are naive local (no zone designator); system timestamps carry an offset', async () => {
  const r = await s.call('pm', 'GET', `/projects/${P.id}/plan`);
  for (const t of r.body.tasks) for (const k of ['es', 'ef', 'ls', 'lf']) assert.match(t.schedule[k], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/, `${k} naive`);
  const b = await s.call('pm', 'POST', `/projects/${P.id}/baselines`, { number: 5 }); if (b.status === 201) { const l = await s.call('pm', 'GET', `/projects/${P.id}/baselines`); const arr = Array.isArray(l.body) ? l.body : l.body.items; assert.ok(isRfc3339(arr.find((x: any) => x.number === 5).savedAt), 'savedAt RFC3339'); }
});

// ---------------------------------------------------------------- Error hygiene
const LEAK = [/\bat\s+[\w$.<>]+\s*\(.*:\d+:\d+\)/, /node_modules/, /\.ts:\d+/, /\/home\//, /\/server\/src/, /\bSELECT\b|\bINSERT\s+INTO\b|\bUPDATE\s+\w+\s+SET\b|\bDELETE\s+FROM\b/i, /\bpg_\w+|relation "|violates (check|foreign|unique|not-null)|syntax error at or near|duplicate key value|SQLSTATE|\bpf\.\w+_\w+/i, /ZodError|\bAssertionError\b|TypeError|ReferenceError|RangeError|SyntaxError: /, /"stack"|\bstack\b\s*:/, /password|secret|devpw/i, /\bpostgres(ql)?:\/\//i];
function hygiene(r: { status: number; body: any; text: string; headers: Headers; req: string }, label = '') {
  const ct = r.headers.get('content-type') ?? '';
  if (r.status < 400) return;
  assert.ok(r.status !== 500 && r.status !== 502 && r.status !== 504, `${label} server error ${r.status}: ${r.req} -> ${r.text.slice(0, 300)}`);
  assert.match(ct, /^application\/problem\+json/, `${label} error content-type for ${r.req} -> ${r.status} was "${ct}"`);
  const errs = validateSchemaName('Problem', r.body); assert.equal(errs.length, 0, `${label} body not a valid Problem (${errs.join('; ')}): ${r.text.slice(0, 300)}`);
  assert.ok(r.body.traceId, `${label} traceId missing: ${r.text.slice(0, 200)}`);
  assert.equal(r.body.status, r.status, `${label} problem.status mismatch`);
  for (const re of LEAK) assert.ok(!re.test(r.text), `${label} error body leaks (${re}) for ${r.req}: ${r.text.slice(0, 400)}`);
  assert.ok(!r.text.includes(TENANT_A) && !r.text.includes(TENANT_B), `${label} error body exposes a tenant id for ${r.req}: ${r.text.slice(0, 300)}`);
}
const HUGE = 'x'.repeat(100_000);
const fuzzCases: Array<[string, string, string, (unknown | undefined), Record<string, string>?]> = [];
const pid = () => P.id;
const tid = () => taskA.id;
const addF = (who: string, m: string, p: string, b?: unknown, h?: Record<string, string>) => fuzzCases.push([who, m, p, b, h]);
let fuzzMemo: Promise<Array<{ r: any; n: number }>> | null = null;
function runFuzz() {
  if (!fuzzMemo) fuzzMemo = (async () => {
  const cmdBase = () => ({ clientOpId: uuid(), expectedPlanVersion: P.version });
  const bodies: unknown[] = [null, 1, 'str', [], {}, { x: 1 }, [1, 2], true, { name: 1 }, { name: null }, { name: HUGE }, { name: '\u0000' }, { name: '"; DROP TABLE pf.task; --' }, { name: "' OR 1=1 --" }];
  const paths: Array<[string, string]> = [['POST', '/projects'], ['POST', '/resources'], ['POST', `/projects/${pid()}/commands`], ['POST', `/projects/${pid()}/schedule`], ['POST', `/projects/${pid()}/scenarios`], ['POST', `/projects/${pid()}/level`], ['POST', `/projects/${pid()}/baselines`], ['POST', `/projects/${pid()}/risk-runs`], ['POST', '/realtime/tickets'], ['PUT', `/projects/${pid()}/members/${USERS.viewer.id}`], ['PATCH', `/projects/${pid()}`]];
  for (const [m, p] of paths) for (const b of bodies) addF('pm', m, p, b, m === 'PATCH' ? { 'If-Match': '"0"' } : undefined);
  const badIds = ['not-a-uuid', '00000000-0000-0000-0000-000000000000', "1'; DROP TABLE pf.task;--", '%00', '..%2f..%2fetc%2fpasswd', 'x'.repeat(5000), '%', '{{7*7}}', uuid()];
  for (const id of badIds) { addF('pm', 'GET', `/projects/${id}`); addF('pm', 'GET', `/projects/${id}/plan`); addF('pm', 'GET', `/projects/${pid()}/tasks/${id}`); addF('pm', 'GET', `/resources/${id}/load?from=2026-01-01&to=2026-01-02`); addF('pm', 'GET', `/projects/${pid()}/risk-runs/${id}`); addF('pm', 'DELETE', `/projects/${id}`); addF('pm', 'GET', `/projects/${pid()}/members/${id}`); addF('pm', 'DELETE', `/projects/${pid()}/members/${id}`); addF('pm', 'GET', `/imports/${id}`); }
  const badQ = ['limit=-1', 'limit=99999', 'limit=NaN', 'cursor=%FF%FE', 'critical=maybe', 'parentId=zzz', "q='%20OR%201=1", 'finishBefore=zzz', 'q=' + 'a'.repeat(300), 'limit[]=1', 'limit=1&limit=2'];
  for (const q of badQ) addF('pm', 'GET', `/projects/${pid()}/tasks?${q}`);
  for (const q of ['from=x&to=y', 'from=2026-01-01', 'from=2026-02-31&to=2026-03-01', 'from=2026-03-01&to=2026-01-01', 'from=0000-01-01&to=9999-12-31']) addF('pm', 'GET', `/resources/${res.id}/load?${q}`);
  for (const q of ['statusDate=bad', 'statusDate=2026-13-45', 'baseline=-1', 'baseline=99', 'baseline=x']) addF('pm', 'GET', `/projects/${pid()}/evm?${q}`);
  for (const q of ['format=', 'format=%00', "format=plan'--", 'include=bogus', 'include[]=x']) { addF('pm', 'GET', `/projects/${pid()}/export?${q}`); addF('pm', 'GET', `/projects/${pid()}/plan?${q}`); }
  const badCmds: any[] = [
    { ...cmdBase(), commands: [] }, { ...cmdBase(), commands: [{ op: 'nope' }] }, { ...cmdBase(), commands: [{ op: 'addTask' }] }, { ...cmdBase(), commands: [{ op: 'addTask', task: null }] },
    { ...cmdBase(), commands: [{ op: 'addTask', task: { id: 'zz', name: 'x', durationMin: 1 } }] }, { ...cmdBase(), commands: [{ op: 'addTask', task: { id: uuid(), name: '', durationMin: 1 } }] },
    { ...cmdBase(), commands: [{ op: 'addTask', task: { id: uuid(), name: 'n', durationMin: -1 } }] }, { ...cmdBase(), commands: [{ op: 'addTask', task: { id: uuid(), name: 'n', durationMin: 1e30 } }] },
    { ...cmdBase(), commands: [{ op: 'addTask', task: { id: uuid(), name: 'n', durationMin: 1.5 } }] }, { ...cmdBase(), commands: [{ op: 'addTask', task: { id: uuid(), name: 'n', durationMin: '5' } }] },
    { ...cmdBase(), commands: [{ op: 'addTask', task: { id: uuid(), name: 'n', durationMin: 1, constraint: { type: 'MSO' } } }] }, { ...cmdBase(), commands: [{ op: 'addTask', task: { id: uuid(), name: 'n', durationMin: 1, constraint: { type: 'BOGUS', date: '2026-11-09T08:00:00' } } }] },
    { ...cmdBase(), commands: [{ op: 'addTask', task: { id: uuid(), name: 'n', durationMin: 1, percentComplete: 7 } }] }, { ...cmdBase(), commands: [{ op: 'addLink', link: { id: uuid(), predId: uuid(), succId: uuid() } }] },
    { ...cmdBase(), commands: [{ op: 'deleteTask', id: uuid() }] }, { ...cmdBase(), commands: [{ op: 'updateTask', id: uuid(), patch: {} }] }, { ...cmdBase(), commands: [{ op: 'moveTask', id: tid(), newParentId: tid() }] },
    { ...cmdBase(), commands: [{ op: 'addAssignment', assignment: { id: uuid(), taskId: tid(), resourceId: uuid() } }] }, { ...cmdBase(), commands: [{ op: 'removeLink', id: uuid() }] },
    { clientOpId: 'x', expectedPlanVersion: 0, commands: [{ op: 'deleteTask', id: tid() }] }, { clientOpId: uuid(), expectedPlanVersion: -5, commands: [{ op: 'removeLink', id: uuid() }] }, { clientOpId: uuid(), expectedPlanVersion: 1e30, commands: [{ op: 'removeLink', id: uuid() }] },
    { clientOpId: uuid(), expectedPlanVersion: 'x', commands: [] }, { expectedPlanVersion: 0, commands: [{ op: 'removeLink', id: uuid() }] }, { clientOpId: uuid(), commands: [{ op: 'removeLink', id: uuid() }] },
  ];
  for (const b of badCmds) { addF('pm', 'POST', `/projects/${pid()}/commands`, b); addF('pm', 'POST', `/projects/${pid()}/schedule`, b); }
  addF('pm', 'POST', '/projects', { name: 'n', startDate: '2026-11-09', calendarId: CAL_A }); addF('pm', 'POST', '/projects', { name: 'n', startDate: '2026-11-09T08:00:00+02:00', calendarId: CAL_A });
  addF('pm', 'POST', '/projects', { name: 'n', startDate: '2026-11-09T08:00:00', calendarId: uuid() }); addF('pm', 'POST', '/projects', { name: 'n', startDate: '2026-11-09T08:00:00', calendarId: CAL_A, currency: 'usd' });
  addF('pm', 'POST', '/projects', { name: 'x'.repeat(201), startDate: '2026-11-09T08:00:00', calendarId: CAL_A }); addF('pm', 'POST', '/projects', { name: 'n', startDate: '2026-02-31T08:00:00', calendarId: CAL_A });
  addF('pm', 'POST', '/resources', { name: 'r', maxUnits: -1 }); addF('pm', 'POST', '/resources', { name: 'r', kind: 'ROBOT' }); addF('pm', 'POST', '/resources', { name: 'r', calendarId: uuid() });
  addF('pm', 'POST', `/projects/${pid()}/baselines`, { number: 11 }); addF('pm', 'POST', `/projects/${pid()}/baselines`, { number: -1 }); addF('pm', 'POST', `/projects/${pid()}/baselines`, { number: 1.5 }); addF('pm', 'POST', `/projects/${pid()}/baselines`, { number: 3, label: 'x'.repeat(121) });
  addF('pm', 'POST', `/projects/${pid()}/risk-runs`, { iterations: 99 }); addF('pm', 'POST', `/projects/${pid()}/risk-runs`, { iterations: 10 ** 9 }); addF('pm', 'POST', `/projects/${pid()}/risk-runs`, { seed: 'x' });
  addF('pm', 'POST', `/projects/${pid()}/level`, { order: 'RANDOM' }); addF('pm', 'POST', `/projects/${pid()}/level`, { apply: 'yes' }); addF('pm', 'POST', `/projects/${pid()}/level`, { apply: true });
  addF('pm', 'POST', '/realtime/tickets', { projectId: 'x' }); addF('pm', 'POST', '/realtime/tickets', { projectId: uuid() });
  addF('pm', 'PUT', `/projects/${pid()}/members/${USERS.viewer.id}`, { role: 'ROOT' }); addF('pm', 'PUT', `/projects/${pid()}/members/${USERS.viewer.id}`, { role: 'VIEWER', extra: 1 }); addF('pm', 'PUT', `/projects/${pid()}/members/${uuid()}`, { role: 'VIEWER' });
  addF('pm', 'PATCH', `/projects/${pid()}`, { status: 'ARCHIVED' }, { 'If-Match': '"0"' }); addF('pm', 'PATCH', `/projects/${pid()}`, { deadline: 'bad' }, { 'If-Match': '"0"' });
  addF('admin', 'GET', '/audit-events?limit=0'); addF('admin', 'GET', '/audit-events?from=bad'); addF('admin', 'GET', '/audit-events?actorId=zz'); addF('admin', 'GET', "/audit-events?actorId=' OR 1=1"); addF('admin', 'GET', '/audit-events?cursor=garbage');
  addF('pm', 'GET', '/nope'); addF('pm', 'POST', '/nope', {}); addF('pm', 'PUT', '/projects', {}); addF('pm', 'DELETE', '/projects', undefined); addF('pm', 'GET', '/projects/' + pid() + '/nope'); addF('pm', 'TRACE', '/projects');
    const out: Array<{ r: any; n: number }> = []; let n = 0;
    for (const [who, m, p, b, h] of fuzzCases) { if (m === 'TRACE') continue; try { const r = await s.call(who, m, p, b, h); out.push({ r, n: ++n }); } catch (e: any) { out.push({ r: { status: 0, text: 'transport ' + e.message, req: `${m} ${p}`, headers: new Headers(), body: undefined }, n: ++n }); } }
    obs(`fuzz corpus: ${n} requests executed`);
    return out;
  })();
  return fuzzMemo;
}
const sample = (arr: string[]) => arr.slice(0, 12).map((f) => f.replace(/\s+/g, ' ').slice(0, 280)).join('\n');
tc('E2E-CONTRACT-ERR-001', ['docs/07 §5 principles', 'docs/10 §3 T6'], 'fuzz (>150 malformed requests): no 5xx or transport failure on any input (never an INTERNAL for client errors)', async () => {
  const all = await runFuzz(); assert.ok(all.length >= 150, 'corpus size ' + all.length);
  const bad = all.filter(({ r }) => r.status === 0 || (r.status >= 500 && r.body?.code !== 'NOT_IMPLEMENTED')).map(({ r, n }) => `[${n}] ${r.req} -> ${r.status} ${r.text.slice(0, 120)}`);
  assert.equal(bad.length, 0, `${bad.length}/${all.length} fuzz inputs produced 5xx:\n` + sample(bad));
});
tc('E2E-CONTRACT-ERR-003', ['docs/07 §1.4 RFC 9457', 'OAS Problem'], 'fuzz: every error is application/problem+json, valid against the Problem schema, has traceId and problem.status == HTTP status', async () => {
  const all = await runFuzz(); const bad: string[] = [];
  for (const { r, n } of all) { if (r.status < 400 || r.status >= 500 && r.status !== 501) continue;
    const errs: string[] = []; const ct = r.headers.get('content-type') ?? '';
    if (!/^application\/problem\+json/.test(ct)) errs.push('content-type ' + ct);
    if (r.body && typeof r.body === 'object') { const e = validateSchemaName('Problem', r.body); if (e.length) errs.push('schema ' + e.join(',')); if (!r.body.traceId) errs.push('no traceId'); if (r.body.status !== r.status) errs.push(`problem.status ${r.body.status} != HTTP ${r.status} (code ${r.body.code})`); } else errs.push('body not JSON');
    if (errs.length) bad.push(`[${n}] ${r.req} -> ${r.status}: ${errs.join('; ')}`); }
  assert.equal(bad.length, 0, `${bad.length} malformed error responses:\n` + sample(bad));
});
tc('E2E-CONTRACT-ERR-004', ['docs/07 §5 principles', 'docs/10 §3 T6/T17'], 'fuzz: no error body contains a stack trace, SQL, file path, driver/ORM text, secret, DB URL or tenant id', async () => {
  const all = await runFuzz(); const bad: string[] = [];
  for (const { r, n } of all) { if (r.status < 400) continue; const hits = LEAK.filter((re) => re.test(r.text)).map(String); if (r.text.includes(TENANT_A) || r.text.includes(TENANT_B)) hits.push('tenant-id'); if (hits.length) bad.push(`[${n}] ${r.req} -> ${r.status}: ${hits.join(',')} :: ${r.text.slice(0, 200)}`); }
  assert.equal(bad.length, 0, `${bad.length} leaking error bodies:\n` + sample(bad));
});
tc('E2E-CONTRACT-ERR-005', ['docs/07 §5 VALIDATION_FAILED', 'RFC 9110 15.5.6'], '405 Method Not Allowed carries an Allow header and a body whose status matches', async () => {
  const r = await s.call('pm', 'PUT', '/projects', {}); assert.equal(r.status === 405 || r.status === 404, true, ctx(r));
  if (r.status === 405) { assert.ok(r.headers.get('allow'), 'Allow header required on 405'); assert.equal(r.body.status, 405, 'problem.status must be 405'); }
});
tc('E2E-CONTRACT-ERR-002', ['docs/07 §5', 'OAS Problem.code enum'], 'every error code emitted during fuzz belongs to the documented taxonomy and maps to its documented HTTP status', async () => {
  const table: Record<string, number[]> = { VALIDATION_FAILED: [400], UNAUTHENTICATED: [401], FORBIDDEN: [403], NOT_FOUND: [404], VERSION_CONFLICT: [409], DUPLICATE_CLIENT_OP: [409], CYCLE_DETECTED: [422], LINK_TO_SUMMARY: [422], UNKNOWN_TASK: [422], DUPLICATE_ID: [422], CONSTRAINT_UNSATISFIABLE: [422], PLAN_TOO_LARGE: [413], RATE_LIMITED: [429], DEPENDENCY_UNAVAILABLE: [503], NOT_IMPLEMENTED: [501], INTERNAL: [500] };
  const probes: Array<[string, string, string, unknown?]> = [['pm', 'GET', '/projects/zzz'], ['pm', 'GET', `/projects/${uuid()}`], [null as any, 'GET', '/projects'], ['pm', 'POST', '/projects', {}], ['pm', 'GET', '/webhooks'], ['viewer', 'GET', `/projects/${P.id}`], ['pm', 'POST', `/projects/${P.id}/commands`, { clientOpId: uuid(), expectedPlanVersion: 999, commands: [{ op: 'removeLink', id: uuid() }] }], ['pm', 'POST', `/projects/${P.id}/commands`, { clientOpId: uuid(), expectedPlanVersion: P.version, commands: [{ op: 'deleteTask', id: uuid() }] }]];
  for (const [w, m, p, b] of probes) { const r = await s.call(w as any, m, p, b); assert.ok(r.body?.code in table, `unknown code ${r.body?.code} for ${r.req}`); assert.ok(table[r.body.code].includes(r.status), `${r.body.code} must be HTTP ${table[r.body.code]} but got ${r.status} for ${r.req}`); }
});
