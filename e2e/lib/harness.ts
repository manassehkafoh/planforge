// Shared harness: server process management, token minting, HTTP client, builders. No product imports.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import WebSocket from 'ws';

export const ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
export const SECRET = process.env.E2E_JWT_SECRET ?? 'e2e-secret-0123456789abcdef-0123456789abcdef';
export const DB_NAME = process.env.E2E_DB ?? 'planforge_e2e';
export const DB_URL = process.env.PF_DATABASE_URL ?? `postgres://pf_app:devpw-change-me@localhost/${DB_NAME}`;
export const TENANT_A = 'aaaaaaaa-0000-4000-8000-000000000001';
export const TENANT_B = 'bbbbbbbb-0000-4000-8000-000000000001';
export const CAL_A = 'ca000000-0000-4000-8000-000000000001';
export const CAL_B = 'cb000000-0000-4000-8000-000000000001';
export const USERS = {
  admin: { sub: 'admin-a', id: 'a1000000-0000-4000-8000-000000000001', tid: TENANT_A },
  portfolio: { sub: 'portfolio-a', id: 'a1000000-0000-4000-8000-000000000002', tid: TENANT_A },
  pm: { sub: 'pm-a', id: 'a1000000-0000-4000-8000-000000000003', tid: TENANT_A },
  sched: { sub: 'sched-a', id: 'a1000000-0000-4000-8000-000000000004', tid: TENANT_A },
  member: { sub: 'member-a', id: 'a1000000-0000-4000-8000-000000000005', tid: TENANT_A },
  viewer: { sub: 'viewer-a', id: 'a1000000-0000-4000-8000-000000000006', tid: TENANT_A },
  pmB: { sub: 'pm-b', id: 'b1000000-0000-4000-8000-000000000001', tid: TENANT_B },
} as const;
export type UserKey = keyof typeof USERS;
export const uuid = () => randomUUID();

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
/** Independent JWT minter (HS256) so tests can forge arbitrary headers/claims. */
export function mint(claims: Record<string, unknown>, opts: { secret?: string; header?: Record<string, unknown>; omit?: string[] } = {}) {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT', ...(opts.header ?? {}) }));
  const full: Record<string, unknown> = { iss: 'planforge-dev-idp', aud: 'planforge-api', exp: Math.floor(Date.now() / 1000) + 600, ...claims };
  for (const k of opts.omit ?? []) delete full[k];
  const body = b64u(JSON.stringify(full));
  const sig = createHmac('sha256', opts.secret ?? SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
export const tokenFor = (u: UserKey, over: Record<string, unknown> = {}) => mint({ sub: USERS[u].sub, tid: USERS[u].tid, ...over });

export interface Res { status: number; body: any; headers: Headers; text: string; ms: number }
export interface Server {
  base: string; port: number; proc: ChildProcess; logs: string[];
  stop(): Promise<void>;
  call(who: UserKey | string | null, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Res>;
  raw(method: string, path: string, init?: { headers?: Record<string, string>; body?: string | Buffer }): Promise<Res>;
}

export async function startServer(opts: { rate?: number; port?: number; env?: Record<string, string> } = {}): Promise<Server> {
  const env = { ...process.env, PF_DATABASE_URL: DB_URL, PF_JWT_SECRET: SECRET, PORT: String(opts.port ?? 0), PF_RATE_LIMIT_PER_MIN: String(opts.rate ?? 1_000_000), ...(opts.env ?? {}) };
  const proc = spawn('node', ['src/main.ts'], { cwd: ROOT + '/server', env, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs: string[] = [];
  const port = await new Promise<number>((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('server start timeout; logs: ' + logs.join('\n'))), 20000);
    const onData = (d: Buffer) => {
      for (const line of d.toString().split('\n')) if (line) logs.push(line);
      const m = /listening on :(\d+)/.exec(d.toString());
      if (m) { clearTimeout(to); resolve(Number(m[1])); }
    };
    proc.stdout!.on('data', onData); proc.stderr!.on('data', onData);
    proc.on('exit', (c) => { clearTimeout(to); reject(new Error(`server exited early (${c}): ${logs.join('\n')}`)); });
  });
  proc.stdout!.on('data', (d: Buffer) => { for (const l of d.toString().split('\n')) if (l) logs.push(l); });
  const base = `http://127.0.0.1:${port}`;
  async function raw(method: string, path: string, init: { headers?: Record<string, string>; body?: string | Buffer } = {}): Promise<Res> {
    const t0 = performance.now();
    const r = await fetch(base + path, { method, headers: init.headers, body: init.body as any });
    const text = await r.text();
    let body: any; try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
    return { status: r.status, body, headers: r.headers, text, ms: performance.now() - t0 };
  }
  async function call(who: UserKey | string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { ...headers };
    if (who) h.Authorization = `Bearer ${who in USERS ? tokenFor(who as UserKey) : who}`;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    return raw(method, path, { headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  return {
    base, port, proc, logs, call, raw,
    async stop() {
      if (proc.exitCode !== null) return;
      proc.kill('SIGTERM');
      await new Promise<void>((r) => { const t = setTimeout(() => { proc.kill('SIGKILL'); r(); }, 5000); proc.on('exit', () => { clearTimeout(t); r(); }); });
    },
  };
}

/** Superuser SQL (tamper / RLS bypass experiments, independent verification). */
export function su(sql: string, db = DB_NAME): string {
  const args = ['-d', db, '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', sql];
  try {
    return execFileSync('su', ['postgres', '-c', `psql ${args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e: any) { throw new Error('su sql failed: ' + (e.stderr || e.message)); }
}

/** A pg client as the least-privilege app role; run fn inside one transaction with optional tenant setting. */
export async function asApp<T>(tenant: string | null, fn: (c: pg.PoolClient) => Promise<T>, opts: { rollback?: boolean } = {}): Promise<T> {
  const pool = new pg.Pool({ connectionString: DB_URL, max: 1 });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    if (tenant) await c.query(`SELECT set_config('pf.tenant_id', $1, true)`, [tenant]);
    const out = await fn(c);
    await c.query(opts.rollback === false ? 'COMMIT' : 'ROLLBACK');
    return out;
  } catch (e) { try { await c.query('ROLLBACK'); } catch { /* */ } throw e; }
  finally { c.release(); await pool.end(); }
}

// ---------- domain builders ----------
export const day = (d: string, hhmm = '08:00') => `${d}T${hhmm}:00`;
export const START = '2026-11-09T08:00:00'; // Monday
export interface TaskIn { id?: string; name?: string; durationMin?: number; parentId?: string | null; [k: string]: unknown }
export const T = (name: string, durationMin: number, extra: Record<string, unknown> = {}) => ({ id: uuid(), name, durationMin, ...extra });
export const L = (predId: string, succId: string, type = 'FS', lagMin = 0, extra: Record<string, unknown> = {}) => ({ id: uuid(), predId, succId, type, lagMin, ...extra });
export const addTask = (task: any, afterId?: string | null) => ({ op: 'addTask', task, ...(afterId !== undefined ? { afterId } : {}) });
export const addLink = (link: any) => ({ op: 'addLink', link });
export const batch = (expectedPlanVersion: number, commands: any[], clientOpId = uuid()) => ({ clientOpId, expectedPlanVersion, commands });

/** Create a project as `owner` (becomes PROJECT_MANAGER) and return helpers. */
export async function newProject(s: Server, owner: UserKey = 'pm', over: Record<string, unknown> = {}) {
  const calendarId = USERS[owner].tid === TENANT_B ? CAL_B : CAL_A;
  const r = await s.call(owner, 'POST', '/projects', { name: 'E2E ' + uuid().slice(0, 8), startDate: START, calendarId, ...over });
  if (r.status !== 201) throw new Error('createProject failed: ' + r.text);
  const p = r.body; let version = p.planVersion as number;
  const api = {
    id: p.id as string, project: p, owner,
    get version() { return version; },
    set version(v: number) { version = v; },
    /** Apply commands as `who` (default owner); tracks planVersion on success. */
    async cmd(commands: any[], who: UserKey | string = owner, extra: Record<string, unknown> = {}) {
      const body = { clientOpId: uuid(), expectedPlanVersion: version, commands, ...extra };
      const r = await s.call(who, 'POST', `/projects/${p.id}/commands`, body);
      if (r.status === 200 && typeof r.body?.planVersion === 'number' && !r.body.replayed) version = r.body.planVersion;
      return r;
    },
    async ok(commands: any[], who: UserKey | string = owner) {
      const r = await api.cmd(commands, who);
      if (r.status !== 200) throw new Error('commands failed: ' + r.text);
      return r;
    },
    plan: (who: UserKey | string = owner) => s.call(who, 'GET', `/projects/${p.id}/plan`),
    async tasksById(who: UserKey | string = owner) {
      const pl = await api.plan(who);
      if (pl.status !== 200) throw new Error('plan failed: ' + pl.text);
      return new Map<string, any>(pl.body.tasks.map((t: any) => [t.id, t]));
    },
    async addMember(user: UserKey, role: string) {
      const r = await s.call(owner, 'PUT', `/projects/${p.id}/members/${USERS[user].id}`, { role });
      if (r.status !== 200) throw new Error('addMember failed: ' + r.text);
    },
  };
  return api;
}
export type Proj = Awaited<ReturnType<typeof newProject>>;

export async function createResource(s: Server, who: UserKey, over: Record<string, unknown> = {}) {
  const r = await s.call(who, 'POST', '/resources', { name: 'Res ' + uuid().slice(0, 6), ...over });
  if (r.status !== 201) throw new Error('createResource failed: ' + r.text);
  return r.body;
}

export function openWs(s: Server, ticket: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${s.port}/realtime?ticket=${encodeURIComponent(ticket)}`);
  const msgs: any[] = []; let closed: { code: number; reason: string } | null = null; let error: any = null;
  const waiters: Array<() => void> = [];
  const poke = () => waiters.splice(0).forEach((f) => f());
  ws.on('message', (d) => { try { msgs.push(JSON.parse(d.toString())); } catch { msgs.push(d.toString()); } poke(); });
  ws.on('close', (code, reason) => { closed = { code, reason: reason.toString() }; poke(); });
  ws.on('error', (e) => { error = e; poke(); });
  ws.on('unexpected-response', (_req, res) => { error = { unexpected: res.statusCode }; poke(); });
  const waitFor = async (pred: () => any, ms = 5000) => {
    const t0 = Date.now();
    for (;;) {
      const v = pred(); if (v) return v;
      if (Date.now() - t0 > ms) return null;
      await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 50); });
    }
  };
  return { ws, msgs, get closed() { return closed; }, get error() { return error; }, waitFor,
    opened: () => new Promise<boolean>((r) => { ws.on('open', () => r(true)); ws.on('error', () => r(false)); ws.on('close', () => r(false)); ws.on('unexpected-response', () => r(false)); }) };
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
