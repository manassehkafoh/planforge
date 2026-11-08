import { before, after } from 'node:test';
import { tc, status, problem, assert, obs, record } from '../lib/tc.ts';
import { makeMember, startServer, newProject, createResource, su, uuid, T, L, addTask, addLink, USERS, TENANT_A, type Server } from '../lib/harness.ts';

let s: Server;
before(async () => { s = await startServer(); const p0 = await newProject(s, 'pm'); makeMember(p0.id, 'admin', 'ORG_ADMIN'); /* provisioning: the API offers no way to mint the first ORG_ADMIN (see defect) */ });
after(async () => {
  try { su('ALTER TABLE pf.audit_event ENABLE TRIGGER audit_event_no_update'); } catch { /* best effort restore */ }
  await s.stop();
});
const events = async (limit = 500) => (await s.call('admin', 'GET', `/audit-events?limit=${limit}`)).body.items as any[];
const newer = async (id0: number) => (await events()).filter((e) => e.id > id0);
const maxId = async () => Math.max(0, ...(await events(5)).map((e) => e.id));
const A = TENANT_A;

tc('E2E-AUDIT-COV', ['docs/10 §7 (every applied batch, membership changes, exports, baseline saves)', 'FR-GV-02'], 'every state-changing API call leaves an audit event attributed to the acting user and the affected resource', async () => {
  const p = await newProject(s, 'pm'); const r = await createResource(s, 'pm', { name: 'aud' }); const a = T('a', 480), b = T('b', 480);
  const steps: Array<[string, () => Promise<any>, string[], string]> = [
    ['createProject', async () => (await s.call('pm', 'POST', '/projects', { name: 'aud-proj', startDate: '2026-11-09T08:00:00', calendarId: 'ca000000-0000-4000-8000-000000000001' })), ['pm'], 'project'],
    ['updateProject', () => s.call('pm', 'PATCH', `/projects/${p.id}`, { name: 'renamed' }, { 'If-Match': '*' }), ['pm'], p.id],
    ['applyCommands', () => p.cmd([addTask(a), addTask(b), addLink(L(a.id, b.id))]), ['pm'], p.id],
    ['setMember', () => s.call('pm', 'PUT', `/projects/${p.id}/members/${USERS.viewer.id}`, { role: 'VIEWER' }), ['pm'], p.id],
    ['removeMember', () => s.call('pm', 'DELETE', `/projects/${p.id}/members/${USERS.viewer.id}`), ['pm'], p.id],
    ['saveBaseline', () => s.call('pm', 'POST', `/projects/${p.id}/baselines`, { number: 2 }), ['pm'], 'baseline'],
    ['createScenario', () => s.call('pm', 'POST', `/projects/${p.id}/scenarios`, { name: 'sc', commands: [{ op: 'updateTask', id: a.id, patch: { durationMin: 60 } }] }), ['pm'], 'scenario'],
    ['createResource', () => s.call('pm', 'POST', '/resources', { name: 'aud2' }), ['pm'], 'resource'],
    ['startRiskRun', () => s.call('pm', 'POST', `/projects/${p.id}/risk-runs`, { iterations: 100, seed: 1 }), ['pm'], 'risk_run'],
    ['export', () => s.call('pm', 'GET', `/projects/${p.id}/export`), ['pm'], p.id],
    ['archiveProject', () => s.call('pm', 'DELETE', `/projects/${p.id}`), ['pm'], p.id],
  ];
  const missing: string[] = []; void r;
  for (const [name, run, , resKind] of steps) {
    const id0 = await maxId(); const res = await run(); if (res.status >= 400) { missing.push(`${name}: call failed ${res.status}`); continue; } if (name === 'applyCommands') p.version = res.body.planVersion;
    const ev = await newer(id0); const mine = ev.filter((e) => e.actorId === USERS.pm.id); if (!mine.length) missing.push(`${name}: no audit event by the actor (new events: ${ev.map((e) => e.action).join(',') || 'none'})`);
    else if (!mine.some((e) => resKind.length === 36 ? e.resourceId === resKind : e.resource === resKind || e.resourceId)) missing.push(`${name}: event does not reference the resource`);
  }
  assert.deepEqual(missing, [], 'mutations without a proper audit event');
});
tc('E2E-AUDIT-FIELDS', ['OAS AuditEvent', 'docs/05 audit_event'], 'audit events carry id, occurredAt (RFC 3339), actorId (uuid), action, resource, resourceId, detail; detail never contains bearer tokens, JWTs, or secrets', async () => {
  const p = await newProject(s, 'pm'); await p.ok([addTask(T('x', 60, { fixedCost: 424242 }))]); const ev = (await events(200)).filter((e) => e.resourceId === p.id); assert.ok(ev.length >= 2);
  for (const e of ev) { assert.equal(typeof e.id, 'number'); assert.match(e.occurredAt, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/); assert.match(e.actorId, /^[0-9a-f-]{36}$/); assert.ok(e.action && e.resource); assert.equal(typeof e.detail, 'object'); }
  const txt = JSON.stringify(await events(500)); assert.ok(!/eyJ[A-Za-z0-9_-]{10,}\./.test(txt), 'JWT in audit trail'); assert.ok(!/bearer\s/i.test(txt), 'bearer token in audit trail'); assert.ok(!txt.includes(process.env.E2E_JWT_SECRET ?? 'e2e-secret-0123456789abcdef'), 'secret in audit trail');
  assert.ok(!txt.includes('424242'), 'cost value duplicated into the audit trail (Confidential class)');
});
tc('E2E-AUDIT-ORDER', ['docs/10 §7', 'OAS listAuditEvents (cursor paging)'], 'the trail is newest-first, ids strictly decreasing; paging through the whole tenant trail with the returned cursor yields every event exactly once and equals the SQL row count', async () => {
  const total = Number(su(`SELECT count(*) FROM pf.audit_event WHERE tenant_id='${A}'`)); const seen = new Set<number>(); let cursor: string | undefined; let pages = 0; let last = Infinity;
  for (;;) { const q: string = `/audit-events?limit=200${cursor ? '&cursor=' + cursor + '&beforeId=' + cursor : ''}`; const r = await s.call('admin', 'GET', q); status(r, 200); pages++; for (const e of r.body.items) { assert.ok(e.id < last || !seen.size, 'ids must strictly decrease'); last = e.id; assert.ok(!seen.has(e.id), 'duplicate event ' + e.id); seen.add(e.id); }
    const next = r.body.nextCursor ?? (r.body.nextBeforeId != null ? String(r.body.nextBeforeId) : undefined); if (!next || !r.body.items.length || pages > 200) break; cursor = next; }
  record('audit.paging', { total, seen: seen.size, pages }); assert.equal(seen.size, total, 'paging misses or repeats events (OAS pagination uses nextCursor/cursor)');
});
tc('E2E-AUDIT-ISOLATION', ['docs/10 T2', 'FR-AU-02'], 'the tenant-A trail contains no event of tenant B, and verify counts only tenant A rows', async () => {
  const b = await newProject(s, 'pmB'); await b.ok([addTask(T('b-only', 60))]); const ev = await events(500); assert.ok(!ev.some((e) => e.resourceId === b.id), 'tenant B project in tenant A trail'); const v = await s.call('admin', 'GET', '/audit-events/verify'); status(v, 200);
  assert.equal(v.body.checked, Number(su(`SELECT count(*) FROM pf.audit_event WHERE tenant_id='${A}'`)), 'verify.checked must equal the tenant row count');
});
tc('E2E-AUDIT-CHAIN-SQL', ['docs/10 §7 hash chain', 'T13'], 'independent chain check in SQL: for every tenant-A event prev_hash equals the previous event\'s hash (first has NULL), and hashes are 32-byte SHA-256 values and unique', async () => {
  const bad = su(`SELECT count(*) FROM (SELECT id, prev_hash, hash, lag(hash) OVER (ORDER BY id) AS ph FROM pf.audit_event WHERE tenant_id='${A}') x WHERE prev_hash IS DISTINCT FROM ph`); assert.equal(bad, '0', 'rows whose prev_hash does not match the previous hash');
  assert.equal(su(`SELECT count(*) FROM pf.audit_event WHERE tenant_id='${A}' AND octet_length(hash) <> 32`), '0'); assert.equal(su(`SELECT count(*) - count(DISTINCT hash) FROM pf.audit_event WHERE tenant_id='${A}'`), '0', 'duplicate hashes');
});
tc('E2E-AUDIT-VERIFY-OK', ['docs/10 §7 verification endpoint'], 'verify on the untouched trail returns ok:true with firstBrokenId null', async () => {
  const v = await s.call('admin', 'GET', '/audit-events/verify'); status(v, 200); assert.equal(v.body.ok, true); assert.equal(v.body.firstBrokenId ?? null, null); assert.ok(v.body.checked > 0);
});

// ---------------------------------------------------------------- tamper (superuser disables the trigger, then restores)
const sq = (x: string) => `'${x.replace(/'/g, "''")}'`;
const reinsert = (id: number, saved: string) => { su(`DELETE FROM pf.audit_event WHERE id=${id}`); su(`INSERT INTO pf.audit_event OVERRIDING SYSTEM VALUE SELECT * FROM json_populate_record(null::pf.audit_event, ${sq(saved)}::json)`); };
const triggerOn = () => su(`SELECT tgenabled FROM pg_trigger WHERE tgname='audit_event_no_update'`);
async function tamper(label: string, mutate: (id: number) => void, restore: (id: number, saved: string) => void, pick: 'first' | 'middle' | 'last') {
  const ids = su(`SELECT string_agg(id::text, ',' ORDER BY id) FROM pf.audit_event WHERE tenant_id='${A}'`).split(',').map(Number); const id = pick === 'first' ? ids[0] : pick === 'last' ? ids[ids.length - 1] : ids[Math.floor(ids.length / 2)];
  const saved = su(`SELECT row_to_json(a)::text FROM pf.audit_event a WHERE id=${id}`); su('ALTER TABLE pf.audit_event DISABLE TRIGGER audit_event_no_update');
  try { mutate(id); su('ALTER TABLE pf.audit_event ENABLE TRIGGER audit_event_no_update'); const v = await s.call('admin', 'GET', '/audit-events/verify'); status(v, 200, label); return { v, id }; }
  finally { try { su('ALTER TABLE pf.audit_event DISABLE TRIGGER audit_event_no_update'); restore(id, saved); } finally { su('ALTER TABLE pf.audit_event ENABLE TRIGGER audit_event_no_update'); } }
}
for (const pick of ['first', 'middle', 'last'] as const)
  tc(`E2E-AUDIT-TAMPER-${pick.toUpperCase()}`, ['docs/10 §7 (any break pinpoints the first tampered row)', 'T13'], `rewriting the detail of the ${pick} audit event is detected by verify (ok:false) and pinpoints that event; after restoring the row verify is ok again`, async () => {
    const { v, id } = await tamper(pick, (i) => su(`UPDATE pf.audit_event SET detail = '{"forged":true}' WHERE id=${i}`), (i, saved) => reinsert(i, saved), pick);
    assert.equal(v.body.ok, false, 'tampering with detail was NOT detected'); assert.equal(v.body.firstBrokenId, id, 'must pinpoint the tampered row'); const after = await s.call('admin', 'GET', '/audit-events/verify'); assert.equal(after.body.ok, true, 'restoring the row must restore verification'); assert.equal(triggerOn(), 'O', 'append-only trigger must be re-enabled');
  });
tc('E2E-AUDIT-TAMPER-ACTION', ['docs/10 §7', 'T13'], 'changing actor/action/resource/time fields of an event (not just detail) is detected too and pinpointed', async () => {
  const fields: Array<[string, string]> = [['actor_id', `'a1000000-0000-4000-8000-0000000000aa'`], ['action', `'nothing.happened'`], ['resource_id', `'00000000-0000-4000-8000-000000000000'`], ['occurred_at', `occurred_at + interval '1 day'`]]; const misses: string[] = []; const detail: string[] = [];
  const tid = Number(su(`SELECT min(id) + 5 FROM pf.audit_event WHERE tenant_id='${A}'`)); const saved = su(`SELECT row_to_json(a)::text FROM pf.audit_event a WHERE id=${tid}`);
  for (const [col, val] of fields) {
    su('ALTER TABLE pf.audit_event DISABLE TRIGGER audit_event_no_update'); let ok = true;
    try { su(`UPDATE pf.audit_event SET ${col} = ${val} WHERE id = ${tid}`); su('ALTER TABLE pf.audit_event ENABLE TRIGGER audit_event_no_update'); const v = await s.call('admin', 'GET', '/audit-events/verify'); ok = v.body.ok === false && v.body.firstBrokenId === tid; if (!ok) detail.push(`${col}: verify said ${JSON.stringify(v.body)} (tampered id ${tid})`); }
    finally { su('ALTER TABLE pf.audit_event DISABLE TRIGGER audit_event_no_update'); reinsert(tid, saved); su('ALTER TABLE pf.audit_event ENABLE TRIGGER audit_event_no_update'); }
    if (!ok) misses.push(col);
  }
  assert.deepEqual(misses, [], 'tampering with these columns went undetected or was not pinpointed: ' + detail.join(' | ')); assert.equal((await s.call('admin', 'GET', '/audit-events/verify')).body.ok, true, 'restored trail verifies');
});
tc('E2E-AUDIT-TAMPER-DELETE', ['docs/10 §7', 'T13'], 'deleting a middle event from the trail is detected and pinpointed (the following row), and re-inserting it restores verification', async () => {
  const ids = su(`SELECT string_agg(id::text, ',' ORDER BY id) FROM pf.audit_event WHERE tenant_id='${A}'`).split(',').map(Number); const id = ids[Math.floor(ids.length / 2)], next = ids[Math.floor(ids.length / 2) + 1];
  const saved = su(`SELECT row_to_json(a)::text FROM pf.audit_event a WHERE id=${id}`); su('ALTER TABLE pf.audit_event DISABLE TRIGGER audit_event_no_update'); let v: any;
  try { su(`DELETE FROM pf.audit_event WHERE id=${id}`); su('ALTER TABLE pf.audit_event ENABLE TRIGGER audit_event_no_update'); v = await s.call('admin', 'GET', '/audit-events/verify'); }
  finally { su('ALTER TABLE pf.audit_event DISABLE TRIGGER audit_event_no_update'); su(`INSERT INTO pf.audit_event OVERRIDING SYSTEM VALUE SELECT * FROM json_populate_record(null::pf.audit_event, ${sq(saved)}::json)`); su('ALTER TABLE pf.audit_event ENABLE TRIGGER audit_event_no_update'); }
  assert.equal(v.body.ok, false, 'a deleted event went undetected'); assert.equal(v.body.firstBrokenId, next, 'break reported at the row after the gap'); assert.equal((await s.call('admin', 'GET', '/audit-events/verify')).body.ok, true); assert.equal(triggerOn(), 'O');
});
tc('E2E-AUDIT-TAMPER-TRAILINGDELETE', ['docs/10 §7 (verify against anchored head)', 'T13'], 'deleting the NEWEST events is undetectable from the chain alone: verify reports ok - OBSERVATION of the documented head-anchor gap', async () => {
  const id = Number(su(`SELECT max(id) FROM pf.audit_event WHERE tenant_id='${A}'`)); const saved = su(`SELECT row_to_json(a)::text FROM pf.audit_event a WHERE id=${id}`); su('ALTER TABLE pf.audit_event DISABLE TRIGGER audit_event_no_update'); let v: any;
  try { su(`DELETE FROM pf.audit_event WHERE id=${id}`); su('ALTER TABLE pf.audit_event ENABLE TRIGGER audit_event_no_update'); v = await s.call('admin', 'GET', '/audit-events/verify'); }
  finally { su('ALTER TABLE pf.audit_event DISABLE TRIGGER audit_event_no_update'); su(`INSERT INTO pf.audit_event OVERRIDING SYSTEM VALUE SELECT * FROM json_populate_record(null::pf.audit_event, ${sq(saved)}::json)`); su('ALTER TABLE pf.audit_event ENABLE TRIGGER audit_event_no_update'); }
  obs(`trailing delete: verify ok=${v.body.ok}. docs/10 T13 relies on an anchored head hash (WORM storage) that the reference server does not implement; the chain alone cannot detect truncation.`); assert.equal((await s.call('admin', 'GET', '/audit-events/verify')).body.ok, true);
});
tc('E2E-AUDIT-IMMUTABLE-APP', ['docs/10 T13 (DB role has no UPDATE/DELETE)'], 'the live server never mutates audit rows: the existing rows are byte-identical before and after 50 mixed API operations', async () => {
  const h = () => su(`SELECT md5(string_agg(a::text, '|' ORDER BY id)) FROM pf.audit_event a WHERE tenant_id='${A}' AND id <= (SELECT max(id) FROM pf.audit_event WHERE tenant_id='${A}')`); const maxBefore = su(`SELECT max(id) FROM pf.audit_event WHERE tenant_id='${A}'`); const hb = su(`SELECT md5(string_agg(a::text, '|' ORDER BY id)) FROM pf.audit_event a WHERE tenant_id='${A}' AND id <= ${maxBefore}`);
  const p = await newProject(s, 'pm'); for (let i = 0; i < 25; i++) { await p.cmd([addTask(T('m' + i, 60))]); await s.call('viewer', 'GET', `/projects/${p.id}/plan`); } void h;
  assert.equal(su(`SELECT md5(string_agg(a::text, '|' ORDER BY id)) FROM pf.audit_event a WHERE tenant_id='${A}' AND id <= ${maxBefore}`), hb);
});
tc('E2E-AUDIT-CONCURRENT-CHAIN', ['docs/10 §7 hash chain', 'NFR-SEC'], '40 concurrent audited operations keep the hash chain intact (no forks: verify ok, no duplicate prev_hash)', async () => {
  const p = await newProject(s, 'pm'); await Promise.all(Array.from({ length: 40 }, (_, i) => s.call('pm', 'POST', '/resources', { name: 'cc' + i }))); await Promise.all(Array.from({ length: 10 }, () => s.call('pm', 'PATCH', `/projects/${p.id}`, { name: 'n' + uuid().slice(0, 4) })));
  const v = await s.call('admin', 'GET', '/audit-events/verify'); assert.equal(v.body.ok, true, 'chain broke under concurrency: ' + JSON.stringify(v.body)); assert.equal(su(`SELECT count(*) - count(DISTINCT prev_hash) FROM pf.audit_event WHERE tenant_id='${A}' AND prev_hash IS NOT NULL`), '0', 'two events share a prev_hash (fork)');
});
tc('E2E-AUDIT-AUTHN', ['docs/10 §7 ("Logged: authentication")'], 'authentication events (successful and failed token validation) are recorded in the audit trail', async () => {
  const id0 = await maxId(); await s.call('pm', 'GET', '/projects'); const bad = await s.raw('GET', '/projects', { headers: { Authorization: 'Bearer ' + 'x.y.z' } }); void bad; const ev = await newer(id0); obs(`events after one authenticated read and one invalid-token request: ${ev.map((e) => e.action).join(',') || 'none'}`);
  assert.ok(ev.some((e) => /auth|login|token/i.test(e.action)), 'docs/10 section 7 lists "authentication" among logged events; none was recorded');
});
tc('E2E-AUDIT-LEVEL', ['docs/10 §7 (every applied command batch)', 'OAS levelResources apply'], 'an applied levelling run (which writes updateTask commands) is audited', async () => {
  const p = await newProject(s, 'pm'); const r = await createResource(s, 'pm', { name: 'aud-lv' }); const ts = [T('a', 480, { priority: 100 }), T('b', 480, { priority: 900 }), T('anchor', 4800)]; await p.ok([...ts.map((t) => addTask(t)), { op: 'addAssignment', assignment: { id: uuid(), taskId: ts[0].id, resourceId: r.id } }, { op: 'addAssignment', assignment: { id: uuid(), taskId: ts[1].id, resourceId: r.id } }]);
  const id0 = await maxId(); const x = await s.call('pm', 'POST', `/projects/${p.id}/level`, { apply: true, clientOpId: uuid(), expectedPlanVersion: p.version }); status(x, 200); assert.equal(x.body.applied, true, 'precondition: levelling applied something');
  assert.ok((await newer(id0)).some((e) => e.resourceId === p.id && e.actorId === USERS.pm.id), 'levelling changed the plan without an audit event');
});
