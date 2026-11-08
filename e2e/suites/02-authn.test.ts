import { before, after } from 'node:test';
import { createHmac } from 'node:crypto';
import { tc, status, problem, assert, obs, ctx } from '../lib/tc.ts';
import { startServer, newProject, mint, tokenFor, su, USERS, TENANT_A, TENANT_B, uuid, SECRET, sleep, T, addTask, type Server, type Proj } from '../lib/harness.ts';

let s: Server, P: Proj, B: Proj;
before(async () => { s = await startServer(); P = await newProject(s, 'pm'); B = await newProject(s, 'pmB'); await P.ok([addTask(T('x', 60))]); });
after(async () => { await s.stop(); });

const b64u = (x: string) => Buffer.from(x).toString('base64url');
const hs = (alg: 'sha256' | 'sha384' | 'sha512', input: string, secret = SECRET) => createHmac(alg, secret).update(input).digest('base64url');
const get = (tok: string | null, path = `/projects/${P.id}`, scheme = 'Bearer') => s.raw('GET', path, { headers: tok === null ? {} : { Authorization: `${scheme} ${tok}` } });
const goodClaims = () => ({ sub: USERS.pm.sub, tid: USERS.pm.tid });
const expect401 = (r: any, m = '') => problem(r, 401, 'UNAUTHENTICATED', m);

tc('E2E-AUTH-001', ['docs/07 §5 UNAUTHENTICATED', 'docs/10 T1'], 'no Authorization header -> 401 UNAUTHENTICATED on every protected route', async () => {
  for (const [m, p] of [['GET', '/projects'], ['POST', '/projects'], ['GET', `/projects/${P.id}`], ['GET', `/projects/${P.id}/plan`], ['POST', `/projects/${P.id}/commands`], ['GET', '/resources'], ['POST', '/realtime/tickets'], ['GET', '/audit-events'], ['GET', '/audit-events/verify'], ['GET', `/projects/${P.id}/members`], ['GET', `/projects/${P.id}/evm`], ['GET', `/projects/${P.id}/export?format=plan`]] as const)
    expect401(await s.raw(m, p, { headers: m === 'POST' ? { 'content-type': 'application/json' } : {}, body: m === 'POST' ? '{}' : undefined }), `${m} ${p}`);
});
tc('E2E-AUTH-002', ['docs/10 T1', 'RFC 6750 3'], '401 responses advertise WWW-Authenticate: Bearer', async () => {
  const r = await get(null); expect401(r); assert.match(r.headers.get('www-authenticate') ?? '', /^Bearer/i, 'WWW-Authenticate header required on 401');
});
tc('E2E-AUTH-003', ['docs/10 T1'], 'malformed credentials -> 401 (garbage, 2-part, 4-part, empty, huge, non-base64, wrong scheme)', async () => {
  const good = tokenFor('pm');
  const cases: Array<[string, string | null, string?]> = [['garbage', 'not-a-jwt'], ['two parts', good.split('.').slice(0, 2).join('.')], ['four parts', good + '.extra'], ['empty bearer', ''], ['huge', 'a'.repeat(10_000)], ['json header', '{"alg":"HS256"}.{}.x'], ['basic scheme', good, 'Basic'], ['no scheme', good, ''], ['dots', '..'], ['null payload', `${b64u('{"alg":"HS256"}')}.${b64u('null')}.sig`], ['array payload', `${b64u('{"alg":"HS256"}')}.${b64u('[]')}.sig`]];
  for (const [label, tok, scheme] of cases) { const h: Record<string, string> = scheme === '' ? { Authorization: String(tok) } : { Authorization: `${scheme ?? 'Bearer'} ${tok}` }; expect401(await s.raw('GET', '/projects', { headers: h }), label); }
});
tc('E2E-AUTH-004', ['docs/10 T1'], 'tampered signature (flip last chars) and tampered payload (tid swapped, signature kept) -> 401', async () => {
  const [h, p, sig] = tokenFor('pm').split('.');
  expect401(await get(`${h}.${p}.${sig.slice(0, -2)}AA`), 'bad sig');
  expect401(await get(`${h}.${p}.`), 'empty sig');
  const forged = b64u(JSON.stringify({ iss: 'planforge-dev-idp', aud: 'planforge-api', exp: Math.floor(Date.now() / 1000) + 600, sub: USERS.pmB.sub, tid: TENANT_B }));
  expect401(await get(`${h}.${forged}.${sig}`, `/projects/${B.id}`), 'payload swap');
  expect401(await get(mint(goodClaims(), { secret: 'a-completely-different-secret-0123456789abcdef' })), 'wrong secret');
});
tc('E2E-AUTH-005', ['docs/10 T1'], 'alg=none (with and without signature, case variants) is refused', async () => {
  const body = b64u(JSON.stringify({ iss: 'planforge-dev-idp', aud: 'planforge-api', exp: Math.floor(Date.now() / 1000) + 600, ...goodClaims() }));
  for (const alg of ['none', 'None', 'NONE', 'nOnE']) { const h = b64u(JSON.stringify({ alg, typ: 'JWT' })); expect401(await get(`${h}.${body}.`), alg + ' no sig'); expect401(await get(`${h}.${body}.${hs('sha256', h + '.' + body)}`), alg + ' with sig'); }
});
tc('E2E-AUTH-006', ['docs/10 T1'], 'algorithm confusion: HS384/HS512 (valid HMAC), RS256/ES256 headers with HMAC bytes, lower-case hs256, jku/kid injection -> 401', async () => {
  const body = b64u(JSON.stringify({ iss: 'planforge-dev-idp', aud: 'planforge-api', exp: Math.floor(Date.now() / 1000) + 600, ...goodClaims() }));
  for (const [alg, h] of [['HS384', 'sha384'], ['HS512', 'sha512'], ['RS256', 'sha256'], ['ES256', 'sha256'], ['hs256', 'sha256'], ['PS256', 'sha256']] as const) { const hd = b64u(JSON.stringify({ alg, typ: 'JWT' })); expect401(await get(`${hd}.${body}.${hs(h, hd + '.' + body)}`), alg); }
  const hd = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT', jku: 'http://evil.example/jwks.json', kid: '../../etc/passwd', jwk: { kty: 'oct', k: 'AAAA' } }));
  const r = await get(`${hd}.${body}.${hs('sha256', hd + '.' + body, 'attacker-secret-0123456789abcdef-0123456789')}`); expect401(r, 'header injection with attacker key');
});
tc('E2E-AUTH-007', ['docs/10 T1 (iss/aud)'], 'wrong or missing iss/aud -> 401', async () => {
  for (const over of [{ iss: 'evil-idp' }, { aud: 'other-api' }, { iss: '' }, { aud: '' }, { aud: ['planforge-api', 'other'] }, { iss: 123 }]) expect401(await get(mint({ ...goodClaims(), ...over })), JSON.stringify(over));
  expect401(await get(mint(goodClaims(), { omit: ['iss'] })), 'no iss'); expect401(await get(mint(goodClaims(), { omit: ['aud'] })), 'no aud');
});
tc('E2E-AUTH-008', ['docs/10 T1 (exp, skew <= 60 s)'], 'expired token -> 401; expired within the 60 s skew is tolerated; far-future exp ok; missing/non-numeric exp -> 401', async () => {
  const now = Math.floor(Date.now() / 1000);
  expect401(await get(mint({ ...goodClaims(), exp: now - 600 })), 'expired 10min'); expect401(await get(mint({ ...goodClaims(), exp: now - 120 })), 'expired 2min');
  status(await get(mint({ ...goodClaims(), exp: now - 20 })), 200, 'within skew'); status(await get(mint({ ...goodClaims(), exp: now + 10 * 365 * 86400 })), 200, 'far future');
  expect401(await get(mint(goodClaims(), { omit: ['exp'] })), 'no exp'); expect401(await get(mint({ ...goodClaims(), exp: '9999999999' })), 'string exp'); expect401(await get(mint({ ...goodClaims(), exp: null })), 'null exp');
});
tc('E2E-AUTH-009', ['docs/10 T1 (nbf, skew <= 60 s)'], 'nbf in the future -> 401; nbf within skew accepted', async () => {
  const now = Math.floor(Date.now() / 1000);
  expect401(await get(mint({ ...goodClaims(), nbf: now + 3600 })), 'nbf +1h'); expect401(await get(mint({ ...goodClaims(), nbf: now + 300 })), 'nbf +5min'); status(await get(mint({ ...goodClaims(), nbf: now + 20 })), 200, 'nbf within skew'); status(await get(mint({ ...goodClaims(), nbf: now - 10 })), 200, 'nbf past'); expect401(await get(mint({ ...goodClaims(), nbf: 'soon' })), 'nbf string');
});
tc('E2E-AUTH-010', ['docs/10 T2', 'docs/07 §5'], 'missing/invalid sub or tid claims -> 401 (no sub, empty sub, non-string sub, no tid, tid not a UUID, tid injection)', async () => {
  expect401(await get(mint(goodClaims(), { omit: ['sub'] })), 'no sub'); expect401(await get(mint({ ...goodClaims(), sub: '' })), 'empty sub'); expect401(await get(mint({ ...goodClaims(), sub: 42 })), 'numeric sub'); expect401(await get(mint({ ...goodClaims(), sub: 'x'.repeat(500) })), 'sub 500 chars');
  expect401(await get(mint(goodClaims(), { omit: ['tid'] })), 'no tid');
  for (const tid of ['not-a-uuid', '', 'aaaaaaaa-0000-4000-8000-00000000000', `${TENANT_A}'; DROP TABLE pf.tenant;--`, TENANT_A.toUpperCase() + 'x', 12345, null, [TENANT_A]]) expect401(await get(mint({ ...goodClaims(), tid })), 'tid=' + JSON.stringify(tid));
});
tc('E2E-AUTH-011', ['docs/10 T2', 'docs/07 §5'], 'validly signed token for an unknown subject, or for a non-existent tenant -> denied (401/403), never data', async () => {
  const r1 = await get(mint({ sub: 'ghost-user', tid: TENANT_A })); assert.ok([401, 403].includes(r1.status), 'unknown subject: ' + ctx(r1));
  const r2 = await get(mint({ sub: USERS.pm.sub, tid: uuid() })); assert.ok([401, 403].includes(r2.status), 'unknown tenant: ' + ctx(r2));
  obs(`unknown subject -> HTTP ${r1.status} ${r1.body?.code}; unknown tenant -> HTTP ${r2.status} ${r2.body?.code}`);
  for (const r of [r1, r2]) assert.ok(!('items' in (r.body ?? {})) && !('name' in (r.body ?? {})) && !('planVersion' in (r.body ?? {})), 'no project data in body');
});
tc('E2E-AUTH-012', ['docs/10 T2', 'docs/07 §5 NOT_FOUND'], 'subject from tenant B presented with tid=A (and vice versa) is rejected; tenants never mix', async () => {
  const crossA = await get(mint({ sub: USERS.pmB.sub, tid: TENANT_A })); assert.ok([401, 403].includes(crossA.status), ctx(crossA));
  const crossB = await get(mint({ sub: USERS.pm.sub, tid: TENANT_B }), `/projects/${B.id}`); assert.ok([401, 403, 404].includes(crossB.status), ctx(crossB));
  const list = await s.call(mint({ sub: USERS.pm.sub, tid: TENANT_B }), 'GET', '/projects'); if (list.status === 200) assert.deepEqual(list.body.items, [], 'no projects visible'); else assert.ok([401, 403].includes(list.status));
});
tc('E2E-AUTH-013', ['docs/10 T2', 'docs/07 §5 NOT_FOUND'], 'valid tenant-B token against tenant-A ids -> 404 NOT_FOUND (existence not revealed), identical to a random id', async () => {
  const paths = [`/projects/${P.id}`, `/projects/${P.id}/plan`, `/projects/${P.id}/tasks`, `/projects/${P.id}/members`, `/projects/${P.id}/calendars`, `/projects/${P.id}/scenarios`, `/projects/${P.id}/baselines`, `/projects/${P.id}/export?format=plan`];
  for (const p of paths) { const r = await s.call('pmB', 'GET', p); problem(r, 404, 'NOT_FOUND', p); const rnd = await s.call('pmB', 'GET', p.replace(P.id, uuid())); assert.equal(r.status, rnd.status, 'same status as random id'); assert.equal(r.body.title, rnd.body.title); assert.equal(r.body.detail, rnd.body.detail, 'same detail text as for a random id (no existence oracle)'); }
});
tc('E2E-AUTH-014', ['docs/10 T15'], 'tokens in the query string are not accepted as credentials', async () => {
  const tok = tokenFor('pm'); for (const q of [`access_token=${tok}`, `token=${tok}`, `Authorization=Bearer%20${tok}`]) expect401(await s.raw('GET', `/projects?${q}`), q.slice(0, 20));
});
tc('E2E-AUTH-015', ['docs/10 T1'], 'deactivated user (app_user.is_active=false) with a valid token is denied; reactivation restores access', async () => {
  su(`INSERT INTO pf.app_user (id, tenant_id, oidc_subject, email, display_name, is_active) VALUES ('a1000000-0000-4000-8000-0000000000ee','${TENANT_A}','inactive-a','inactive@acme.test','Ida Inactive', false) ON CONFLICT (id) DO UPDATE SET is_active=false`);
  const r = await get(mint({ sub: 'inactive-a', tid: TENANT_A }), '/projects'); assert.ok([401, 403].includes(r.status), 'inactive user must be denied, got ' + r.status + ctx(r));
  su(`UPDATE pf.app_user SET is_active=true WHERE id='a1000000-0000-4000-8000-0000000000ee'`);
  const ok = await get(mint({ sub: 'inactive-a', tid: TENANT_A }), '/projects'); status(ok, 200, 'after reactivation');
  su(`UPDATE pf.app_user SET is_active=false WHERE id='a1000000-0000-4000-8000-0000000000ee'`);
});
tc('E2E-AUTH-016', ['docs/10 T17'], 'rejected credentials are never echoed back in the response body or headers', async () => {
  const bad = 'eyJhbGciOiJIUzI1NiJ9.' + b64u('{"secretmarker":"CANARY-12345"}') + '.sig'; const r = await get(bad); expect401(r);
  assert.ok(!r.text.includes('CANARY-12345') && !r.text.includes(bad), 'token echoed'); for (const [, v] of r.headers) assert.ok(!v.includes('CANARY-12345'));
});
tc('E2E-AUTH-017', ['docs/12 health probes'], 'liveness/readiness probes answer without credentials', async () => {
  for (const p of ['/healthz', '/readyz']) { const r = await s.raw('GET', p); status(r, 200, p); }
});

// ---------------------------------------------------------------- rate limiting (own server with a low limit)
tc('E2E-AUTH-RL-001', ['docs/07 §1.10 RATE_LIMITED', 'docs/10 T20'], 'exceeding the limit yields 429 RATE_LIMITED with Retry-After; other tenants are unaffected', async () => {
  const low = await startServer({ rate: 20 });
  try {
    const codes: number[] = []; let first429: any = null;
    for (let i = 0; i < 80; i++) { const r = await low.call('pm', 'GET', '/projects'); codes.push(r.status); if (r.status === 429 && !first429) first429 = r; }
    assert.ok(codes.includes(429), `no 429 within 80 requests at PF_RATE_LIMIT_PER_MIN=20; statuses: ${[...new Set(codes)]}`);
    const first = codes.indexOf(429); assert.ok(first >= 10 && first <= 60, `429 should begin near the configured budget (20/min), began at request #${first}`);
    problem(first429, 429, 'RATE_LIMITED'); const ra = first429.headers.get('retry-after'); assert.ok(ra && /^\d+$/.test(ra) && Number(ra) >= 1, `Retry-After must be integer seconds >= 1, got ${ra}`);
    assert.ok(Number(ra) <= 60, 'Retry-After sane');
    const other = await low.call('pmB', 'GET', '/projects'); status(other, 200, 'tenant B must not be throttled by tenant A traffic');
    obs(`rate limit 20/min: first 429 at request #${first + 1}; Retry-After=${ra}s`);
  } finally { await low.stop(); }
});
tc('E2E-AUTH-RL-002', ['docs/07 §1.10'], 'after Retry-After elapses the client is served again', async () => {
  const low = await startServer({ rate: 60 });
  try {
    let r429: any = null; for (let i = 0; i < 200 && !r429; i++) { const r = await low.call('pm', 'GET', '/projects'); if (r.status === 429) r429 = r; }
    assert.ok(r429, 'precondition: limit reached'); const wait = Math.min(Number(r429.headers.get('retry-after') ?? 1), 10) * 1000 + 300;
    await sleep(wait); const r = await low.call('pm', 'GET', '/projects'); status(r, 200, `after waiting Retry-After (${wait}ms)`);
  } finally { await low.stop(); }
});
tc('E2E-AUTH-RL-003', ['docs/07 §1.10', 'docs/10 T20'], 'unauthenticated floods are also throttled (no free brute-forcing of tokens)', async () => {
  const low = await startServer({ rate: 20 });
  try { const codes: number[] = []; for (let i = 0; i < 120; i++) codes.push((await low.raw('GET', '/projects', { headers: { Authorization: 'Bearer junk' } })).status); assert.ok(codes.includes(429), `unauthenticated requests never throttled: ${[...new Set(codes)]}`); }
  finally { await low.stop(); }
});
