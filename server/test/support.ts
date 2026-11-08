import { randomUUID } from 'node:crypto';
import { sign } from '../src/auth.ts';
import { start } from '../src/main.ts';

export const SECRET = 'test-secret-0123456789abcdef-0123456789';
export const DB_URL = process.env.PF_DATABASE_URL ?? 'postgres://pf_app:devpw-change-me@localhost/planforge';
export const TENANT_A = 'aaaaaaaa-0000-4000-8000-000000000001', TENANT_B = 'bbbbbbbb-0000-4000-8000-000000000001';
export const CAL_A = 'ca000000-0000-4000-8000-000000000001', CAL_B = 'cb000000-0000-4000-8000-000000000001';
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

export const token = (u: UserKey, over: Record<string, unknown> = {}) =>
  sign({ sub: USERS[u].sub, tid: USERS[u].tid, exp: Math.floor(Date.now() / 1000) + 600, ...over } as never, SECRET);

export async function boot(rate = 100000) {
  const s = await start({ port: 0, databaseUrl: DB_URL, jwtSecret: SECRET, rateLimitPerMin: rate });
  const base = `http://127.0.0.1:${s.port}`;
  async function call(user: UserKey | string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { ...headers };
    if (user) h.Authorization = `Bearer ${user in USERS ? token(user as UserKey) : user}`;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const r = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json: any; try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
    return { status: r.status, body: json, headers: r.headers };
  }
  return { ...s, base, call };
}
export const id = () => randomUUID();
