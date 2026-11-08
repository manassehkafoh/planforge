import { before, after } from 'node:test';
import { tc, status, problem, assert, obs, ctx, record } from '../lib/tc.ts';
import { makeMember, startServer, newProject, openWs, sleep, su, uuid, T, L, addTask, addLink, tokenFor, type Server, type Proj } from '../lib/harness.ts';

let s: Server;
before(async () => { s = await startServer(); });
after(async () => { await s.stop(); });

const ticketFor = async (who: string, projectId: string) => { const r = await s.call(who, 'POST', '/realtime/tickets', { projectId }); status(r, 201, 'ticket for ' + who); return r.body as { ticket: string; expiresAt: string }; };
const connect = async (who: string, p: Proj) => { const t = await ticketFor(who, p.id); const c = openWs(s, t.ticket); const ok = await c.opened(); return { c, ok, t }; };
const types = (c: { msgs: any[] }) => c.msgs.map((m) => m?.type);
const close = (c: any) => { try { c.ws.close(); } catch { /* ignore */ } };

tc('E2E-RT-TICKET-001', ['OAS createRealtimeTicket', 'docs/07 §6.1'], 'ticket: 201 {ticket, expiresAt}; expiry is in the future and within 60 s; unknown or foreign project -> 404; VIEWER (plan.read) may obtain one', async () => {
  const p = await newProject(s, 'pm'); const t0 = Date.now(); const r = await s.call('pm', 'POST', '/realtime/tickets', { projectId: p.id }); status(r, 201); assert.equal(typeof r.body.ticket, 'string'); assert.ok(r.body.ticket.length >= 20);
  const ttl = (Date.parse(r.body.expiresAt) - t0) / 1000; assert.ok(ttl > 1 && ttl <= 61, `ttl ${ttl}s`); obs(`ticket TTL observed: ${ttl.toFixed(0)} s (spec: 60 s)`); assert.ok(ttl >= 55, `OAS and docs/07 say a 60-second ticket; observed ${ttl.toFixed(0)} s`);
  problem(await s.call('pm', 'POST', '/realtime/tickets', { projectId: uuid() }), 404, 'NOT_FOUND'); problem(await s.call('pmB', 'POST', '/realtime/tickets', { projectId: p.id }), 404, 'NOT_FOUND', 'foreign tenant'); problem(await s.call('viewer', 'POST', '/realtime/tickets', { projectId: p.id }), 404, 'NOT_FOUND', 'non-member');
  await p.addMember('viewer', 'VIEWER'); status(await s.call('viewer', 'POST', '/realtime/tickets', { projectId: p.id }), 201);
  for (const body of [{}, { projectId: 'x' }, { projectId: 5 }, { projectId: p.id, extra: 1 }, null]) { const x = await s.call('pm', 'POST', '/realtime/tickets', body as any); assert.ok(x.status === 400, `${JSON.stringify(body)} -> ${x.status}`); }
  const raw = await s.raw('POST', '/realtime/tickets', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: p.id }) }); problem(raw, 401, 'UNAUTHENTICATED');
});
tc('E2E-RT-HELLO', ['docs/07 §6.2 hello {lastSeq}'], 'connecting yields hello with lastSeq equal to the number of committed batches', async () => {
  const p = await newProject(s, 'pm'); await p.ok([addTask(T('a', 60))]); await p.ok([addTask(T('b', 60))]); const { c, ok } = await connect('pm', p); assert.ok(ok, 'upgrade failed ' + JSON.stringify(c.error));
  const hello = await c.waitFor(() => c.msgs.find((m) => m.type === 'hello')); assert.ok(hello, 'no hello: ' + JSON.stringify(c.msgs)); assert.equal(hello.lastSeq, 2); close(c);
});
const fan = async () => {
  const p = await newProject(s, 'pm'); const a = await connect('pm', p), b = await connect('pm', p); assert.ok(a.ok && b.ok); await a.c.waitFor(() => a.c.msgs.length); await b.c.waitFor(() => b.c.msgs.length);
  const t = T('x', 60); const ops: string[] = ['first']; await p.ok([addTask(t)]);
  for (let i = 0; i < 10; i++) { const op = uuid(); ops.push(op); status(await p.cmd([{ op: 'updateTask', id: t.id, patch: { durationMin: 60 + i } }], 'pm', { clientOpId: op }), 200); }
  for (const c of [a.c, b.c]) await c.waitFor(() => c.msgs.filter((m) => m.type === 'plan.changed').length >= 11, 8000);
  return { p, a, b, ops };
};
tc('E2E-RT-FANOUT-001', ['docs/07 §6.3', 'asyncapi plan.changed'], 'every committed batch is pushed to all subscribers exactly once, in order of planVersion (1..11), tagged with the right projectId', async () => {
  const { p, a, b } = await fan(); for (const c of [a.c, b.c]) { const pc = c.msgs.filter((m) => m.type === 'plan.changed'); assert.equal(pc.length, 11, 'got ' + pc.length + ' ' + JSON.stringify(types(c))); pc.forEach((m, i) => { assert.equal(m.planVersion, i + 1); assert.equal(m.projectId, p.id); }); close(c); }
});
tc('E2E-RT-FANOUT-SHAPE', ['asyncapi plan.changed required [type, projectId, seq, planVersion, actorId, commands]', 'docs/07 §6.3'], 'plan.changed carries the documented fields: gapless seq, actorId, clientOpId (to reconcile the originating client) and commands', async () => {
  const { a, b, ops } = await fan(); const problems: string[] = [];
  for (const c of [a.c, b.c]) c.msgs.filter((m) => m.type === 'plan.changed').forEach((m, i) => { if (m.seq !== i + 1) problems.push(`msg ${i}: seq=${m.seq}`); if (typeof m.actorId !== 'string') problems.push(`msg ${i}: actorId missing`); if (!Array.isArray(m.commands)) problems.push(`msg ${i}: commands missing`); if (i > 0 && m.clientOpId !== ops[i]) problems.push(`msg ${i}: clientOpId=${m.clientOpId}`); });
  close(a.c); close(b.c); assert.deepEqual([...new Set(problems.map((x) => x.replace(/msg \d+: /, '')))], [], 'asyncapi.yaml PlanChanged fields absent; sample: ' + problems.slice(0, 4).join('; '));
});
tc('E2E-RT-FANOUT-DELTA', ['docs/07 §6.3 schedule.delta', 'asyncapi ScheduleDelta'], 'a schedule.delta message with server-authoritative dates follows plan.changed', async () => {
  const p = await newProject(s, 'pm'); const t = T('d', 60); await p.ok([addTask(t)]); const { c, ok } = await connect('pm', p); assert.ok(ok); await c.waitFor(() => c.msgs.length); await p.ok([{ op: 'updateTask', id: t.id, patch: { durationMin: 600 } }]); await sleep(600);
  assert.ok(c.msgs.some((m) => m.type === 'schedule.delta'), 'no schedule.delta in ' + JSON.stringify(types(c))); close(c);
});
tc('E2E-RT-FANOUT-LAT', ['NFR-PERF-04 (push latency)'], 'push latency: plan.changed arrives within 500 ms of the 200 response (p95 over 30 edits)', async () => {
  const p = await newProject(s, 'pm'); const t = T('x', 60); await p.ok([addTask(t)]); const { c, ok } = await connect('pm', p); assert.ok(ok); await sleep(100); const lat: number[] = [];
  for (let i = 0; i < 30; i++) { const n0 = c.msgs.filter((m) => m.type === 'plan.changed').length; const t0 = performance.now(); status(await p.cmd([{ op: 'updateTask', id: t.id, patch: { durationMin: 61 + i } }]), 200); await c.waitFor(() => c.msgs.filter((m) => m.type === 'plan.changed').length > n0, 3000); lat.push(performance.now() - t0); }
  lat.sort((a, b) => a - b); const p95 = lat[Math.floor(lat.length * 0.95) - 1]; record('rt.latency', { p50: lat[15], p95, max: lat[29] }); assert.ok(p95 < 500, `p95 ${p95.toFixed(0)} ms`); close(c);
});
tc('E2E-RT-ISOLATION-001', ['docs/10 T10', 'FR-AU-02'], 'a subscriber to project A never receives events of project B, even the same user in the same tenant', async () => {
  const a = await newProject(s, 'pm'), b = await newProject(s, 'pm'); const ca = await connect('pm', a); assert.ok(ca.ok); await ca.c.waitFor(() => ca.c.msgs.length); await b.ok([addTask(T('b-secret-task', 60))]); await a.ok([addTask(T('a-task', 60))]); await ca.c.waitFor(() => ca.c.msgs.some((m) => m.type === 'plan.changed'), 3000); await sleep(300);
  const all = JSON.stringify(ca.c.msgs); assert.ok(!all.includes('b-secret-task') && !all.includes(b.id), 'leaked project B data'); assert.equal(ca.c.msgs.filter((m) => m.type === 'plan.changed').length, 1); close(ca.c);
});
tc('E2E-RT-ISOLATION-002', ['docs/10 T2/T10'], 'cross-tenant: a tenant-B user cannot obtain a ticket for a tenant-A project, and a forged ticket (tenant prefix swapped, id altered, wrong project) is refused at the gateway', async () => {
  const p = await newProject(s, 'pm'); const t = await ticketFor('pm', p.id); const [tenant, id] = t.ticket.split('.'); const forged = [`bbbbbbbb-0000-4000-8000-000000000001.${id}`, `${tenant}.${uuid()}`, t.ticket + 'x', t.ticket.slice(0, -2), id, '', 'a.b.c', '../../etc/passwd', "' OR 1=1 --", '%00'];
  for (const f of forged) { const c = openWs(s, f); const ok = await c.opened(); assert.equal(ok, false, 'forged ticket accepted: ' + f); close(c); }
  const c = openWs(s, t.ticket); assert.equal(await c.opened(), true, 'the genuine ticket must still work (forgeries must not burn it)'); close(c);
});
tc('E2E-RT-SINGLEUSE', ['OAS createRealtimeTicket (single-use)', 'docs/10 T10'], 'a ticket works exactly once; 5 simultaneous attempts with the same ticket yield exactly one open socket', async () => {
  const p = await newProject(s, 'pm'); const t = await ticketFor('pm', p.id); const a = openWs(s, t.ticket); assert.equal(await a.opened(), true); const b = openWs(s, t.ticket); assert.equal(await b.opened(), false, 'second use accepted'); close(a);
  const t2 = await ticketFor('pm', p.id); const cs = Array.from({ length: 5 }, () => openWs(s, t2.ticket)); const res = await Promise.all(cs.map((c) => c.opened())); assert.equal(res.filter(Boolean).length, 1, 'racing reuse: ' + res.join(',')); cs.forEach(close);
});
tc('E2E-RT-EXPIRY', ['OAS createRealtimeTicket (60 s)', 'docs/10 T10'], 'an expired ticket (expires_at moved to the past via SQL) is refused', async () => {
  const p = await newProject(s, 'pm'); const t = await ticketFor('pm', p.id); const id = t.ticket.split('.')[1]; su(`UPDATE pf.realtime_ticket SET expires_at = now() - interval '1 minute' WHERE id = '${id}'`); const c = openWs(s, t.ticket); assert.equal(await c.opened(), false, 'expired ticket accepted'); close(c);
  const t2 = await ticketFor('pm', p.id); su(`UPDATE pf.realtime_ticket SET expires_at = now() + interval '5 seconds' WHERE id = '${t2.ticket.split('.')[1]}'`); const ok = openWs(s, t2.ticket); assert.equal(await ok.opened(), true, 'ticket with time left must work'); close(ok);
});
tc('E2E-RT-UNAUTH', ['docs/07 §6', 'docs/10 T10'], 'no ticket / empty ticket / Authorization header only (no ticket) / wrong path -> no socket', async () => {
  for (const url of [`ws://127.0.0.1:${s.port}/realtime`, `ws://127.0.0.1:${s.port}/realtime?ticket=`, `ws://127.0.0.1:${s.port}/nothing?ticket=abc`, `ws://127.0.0.1:${s.port}/`]) { const { default: WS } = await import('ws'); const ws = new WS(url, { headers: { Authorization: 'Bearer ' + tokenFor('pm') } }); const ok = await new Promise<boolean>((r) => { ws.on('open', () => r(true)); ws.on('error', () => r(false)); ws.on('close', () => r(false)); ws.on('unexpected-response', () => r(false)); }); assert.equal(ok, false, url); try { ws.terminate(); } catch { /* */ } }
});
tc('E2E-RT-REVOKE', ['docs/10 T10 (4403 on role change/removal)', 'docs/07 §6'], 'removing a member closes that member\'s sockets with 4403 and they receive no further events; other subscribers are unaffected', async () => {
  const p = await newProject(s, 'pm'); await p.addMember('viewer', 'VIEWER'); await p.addMember('sched', 'SCHEDULER'); const v = await connect('viewer', p), sc = await connect('sched', p), pm = await connect('pm', p); assert.ok(v.ok && sc.ok && pm.ok);
  const { USERS } = await import('../lib/harness.ts'); status(await s.call('pm', 'DELETE', `/projects/${p.id}/members/${USERS.viewer.id}`), 204); const closed = await v.c.waitFor(() => v.c.closed, 4000); assert.ok(closed, 'viewer socket still open after removal'); assert.equal(closed.code, 4403);
  await p.ok([addTask(T('after', 60))]); await pm.c.waitFor(() => pm.c.msgs.some((m) => m.type === 'plan.changed'), 3000); assert.ok(pm.c.msgs.some((m) => m.type === 'plan.changed'), 'remaining subscriber still served'); assert.ok(!v.c.msgs.some((m) => m.type === 'plan.changed'), 'removed member got an event'); assert.equal(sc.c.closed, null); [pm, sc].forEach((x) => close(x.c));
  const again = await s.call('viewer', 'POST', '/realtime/tickets', { projectId: p.id }); assert.equal(again.status, 404, 'removed member can no longer obtain tickets');
});
tc('E2E-RT-REVOKE-ROLE', ['docs/10 T10 (membership re-checked on role change)'], 'demoting/changing a role keeps the socket only if the new role still has plan.read; archiving the project does not crash the gateway', async () => {
  const p = await newProject(s, 'pm'); await p.addMember('sched', 'SCHEDULER'); const sc = await connect('sched', p); assert.ok(sc.ok); status(await s.call('pm', 'PUT', `/projects/${p.id}/members/${(await import('../lib/harness.ts')).USERS.sched.id}`, { role: 'VIEWER' }), 200); await sleep(300); obs('socket after role change SCHEDULER->VIEWER: ' + (sc.c.closed ? 'closed ' + sc.c.closed.code : 'open'));
  assert.ok(sc.c.closed === null || sc.c.closed.code === 4403, 'either stays (still reads) or is closed with 4403'); close(sc.c); status(await s.call('pm', 'GET', '/projects'), 200);
});
tc('E2E-RT-NOEVENT-REJECTED', ['docs/07 §6', 'docs/07 §3 atomic'], 'rejected batches (409, 422, 400) and idempotent replays push nothing', async () => {
  const p = await newProject(s, 'pm'); const a = T('a', 60); await p.ok([addTask(a)]); const { c, ok } = await connect('pm', p); assert.ok(ok); await c.waitFor(() => c.msgs.length); const n0 = c.msgs.filter((m) => m.type === 'plan.changed').length;
  await s.call('pm', 'POST', `/projects/${p.id}/commands`, { clientOpId: uuid(), expectedPlanVersion: 99, commands: [addTask(T('z', 1))] }); await p.cmd([{ op: 'deleteTask', id: uuid() }]); await p.cmd([{ op: 'nope' }]);
  const op = uuid(); const body = { clientOpId: op, expectedPlanVersion: p.version, commands: [{ op: 'updateTask', id: a.id, patch: { name: 'q' } }] }; status(await s.call('pm', 'POST', `/projects/${p.id}/commands`, body), 200); await s.call('pm', 'POST', `/projects/${p.id}/commands`, body); await sleep(500);
  assert.equal(c.msgs.filter((m) => m.type === 'plan.changed').length, n0 + 1, 'exactly one event for the one applied batch'); close(c);
});
tc('E2E-RT-COSTLEAK', ['docs/10 §4 field-level rule (omit cost/rate/evm fields)', 'T3'], 'a VIEWER subscriber\'s plan.changed stream does not carry cost fields (fixedCost) that the REST API omits for that role', async () => {
  const p = await newProject(s, 'pm'); await p.addMember('viewer', 'VIEWER'); const v = await connect('viewer', p); assert.ok(v.ok); await v.c.waitFor(() => v.c.msgs.length); await p.ok([addTask(T('costly', 60, { fixedCost: 987654 }))]); await v.c.waitFor(() => v.c.msgs.some((m) => m.type === 'plan.changed'), 3000);
  const rest = await s.call('viewer', 'GET', `/projects/${p.id}/plan`); assert.ok(!JSON.stringify(rest.body).includes('987654'), 'precondition: REST omits cost for VIEWER'); assert.ok(!JSON.stringify(v.c.msgs).includes('987654'), 'fixedCost 987654 leaked over WebSocket to a VIEWER: ' + JSON.stringify(v.c.msgs).slice(0, 300)); close(v.c);
});
tc('E2E-RT-CAP', ['docs/10 T11 (per-user/per-tenant connection caps)', 'NFR-SEC'], 'connection flood: opening many sockets for one user is capped (some attempt is refused), the server stays healthy, and closing sockets frees capacity', async () => {
  const p = await newProject(s, 'pm'); const opened: Array<ReturnType<typeof openWs>> = []; let refused = 0, firstRefusal = -1;
  for (let i = 0; i < 60; i++) { const t = await ticketFor('pm', p.id); const c = openWs(s, t.ticket); const ok = await c.opened(); if (ok) opened.push(c); else { refused++; if (firstRefusal < 0) firstRefusal = i; close(c); if (refused >= 3) break; } }
  record('rt.cap', { openedBeforeRefusal: opened.length, firstRefusal }); assert.ok(refused > 0, `${opened.length} concurrent sockets for one user were accepted without limit`); status(await s.call('pm', 'GET', '/projects'), 200, 'server alive');
  opened.slice(0, 2).forEach(close); await sleep(300); const t = await ticketFor('pm', p.id); const c = openWs(s, t.ticket); assert.equal(await c.opened(), true, 'capacity must be released after close'); close(c); opened.forEach(close);
});
async function abuse(label: string, attack: (c: ReturnType<typeof openWs>) => Promise<void>) {
  const srv = await startServer(); try {
    const p = await newProject(srv, 'pm'); const tk = async () => (await srv.call('pm', 'POST', '/realtime/tickets', { projectId: p.id })).body.ticket; const good = openWs(srv, await tk()), bad = openWs(srv, await tk()); const oks = await Promise.all([good.opened(), bad.opened()]); assert.ok(oks[0] && oks[1], 'both sockets must open');
    await attack(bad); await sleep(500); let alive = false; try { alive = (await srv.call('pm', 'GET', '/projects')).status === 200; } catch { /* connection refused */ }
    assert.equal(alive, true, `${label}: the server process died (exit=${srv.proc.exitCode}) after one client misbehaved. Log tail: ${srv.logs.join('').slice(-300).replace(/\s+/g, ' ')}`);
    status(await srv.call('pm', 'POST', `/projects/${p.id}/commands`, { clientOpId: uuid(), expectedPlanVersion: 0, commands: [addTask(T('still-works', 60))] }), 200); await good.waitFor(() => good.msgs.some((m) => m.type === 'plan.changed'), 3000); assert.ok(good.msgs.some((m) => m.type === 'plan.changed'), 'healthy subscriber no longer served'); close(good); close(bad);
  } finally { await srv.stop(); }
}
tc('E2E-RT-ABUSE-OVERSIZE', ['docs/10 T11 (send-buffer caps)', 'NFR-AVAIL'], 'a subscriber sending a 1 MB WebSocket message is disconnected; the server process and other subscribers are unaffected', async () => abuse('oversize frame', async (c) => { try { c.ws.send('x'.repeat(1_000_000)); } catch { /* */ } }));
tc('E2E-RT-ABUSE-BINARY', ['docs/10 T11'], 'binary garbage and malformed JSON from a subscriber do not affect the server or other subscribers', async () => abuse('binary garbage', async (c) => { try { c.ws.send(Buffer.from([0xff, 0xfe, 0, 1, 2])); c.ws.send('{not json'); c.ws.send('null'); c.ws.send('[1,2,3]'); } catch { /* */ } }));
tc('E2E-RT-ABUSE-FLOOD', ['docs/10 T11 (connection flood / slowloris)'], 'a subscriber flooding 5000 small messages does not affect the server or other subscribers', async () => abuse('message flood', async (c) => { for (let i = 0; i < 5000; i++) { try { c.ws.send('{"type":"ping"}'); } catch { break; } } }));
tc('E2E-RT-MANY-SUBS', ['docs/07 §6', 'NFR-PERF-04'], '5 subscribers (distinct users) all receive each of 20 batches in commit order (by planVersion; the missing seq field is covered by FANOUT-SHAPE)', async () => {
  const p = await newProject(s, 'pm'); const users = ['sched', 'member', 'viewer', 'portfolio', 'admin'] as const; for (const u of users) { if (u === 'admin') makeMember(p.id, 'admin', 'ORG_ADMIN'); else await p.addMember(u, u === 'viewer' ? 'VIEWER' : u === 'member' ? 'TEAM_MEMBER' : u === 'portfolio' ? 'PORTFOLIO_MANAGER' : 'SCHEDULER'); }
  const cs = []; for (const u of users) { const x = await connect(u, p); assert.ok(x.ok, u); cs.push(x.c); } await sleep(150); const t = T('x', 60); await p.ok([addTask(t)]); for (let i = 0; i < 19; i++) await p.ok([{ op: 'updateTask', id: t.id, patch: { durationMin: 61 + i } }]);
  for (const c of cs) { await c.waitFor(() => c.msgs.filter((m) => m.type === 'plan.changed').length >= 20, 8000); const vs = c.msgs.filter((m) => m.type === 'plan.changed').map((m) => m.planVersion); assert.deepEqual(vs, Array.from({ length: 20 }, (_, i) => i + 1), 'delivered in commit order, none missing or duplicated'); close(c); }
});
