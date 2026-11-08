import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';

/** deterministic JSON: sorted keys, no whitespace (the same bytes on write and on verification) */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}
const digest = (prev: Buffer | null, row: unknown): Buffer => createHash('sha256').update(prev ?? Buffer.alloc(0)).update(canonical(row)).digest();

interface Entry { tenantId: string; actorId: string | null; action: string; resource: string; resourceId: string | null; detail?: Record<string, unknown>; ip?: string | null }

/** Append a hash-chained audit event inside the caller's transaction (per-tenant advisory lock serialises the chain). */
export async function audit(c: PoolClient, e: Entry): Promise<void> {
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`audit:${e.tenantId}`]);
  const prev = (await c.query('SELECT hash FROM audit_event WHERE tenant_id = $1 ORDER BY id DESC LIMIT 1', [e.tenantId])).rows[0]?.hash as Buffer | undefined;
  const ip = e.ip ? ((await c.query('SELECT host($1::inet) AS h', [e.ip])).rows[0].h as string) : null;
  const occurredAt = new Date().toISOString();
  const row = { tenant_id: e.tenantId, occurred_at: occurredAt, actor_id: e.actorId, action: e.action, resource: e.resource, resource_id: e.resourceId, ip, detail: e.detail ?? {} };
  const hash = digest(prev ?? null, row);
  await c.query(
    `INSERT INTO audit_event (tenant_id, occurred_at, actor_id, action, resource, resource_id, ip, detail, prev_hash, hash)
     VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7::inet, $8::jsonb, $9, $10)`,
    [e.tenantId, occurredAt, e.actorId, e.action, e.resource, e.resourceId, ip, JSON.stringify(row.detail), prev ?? null, hash]);
}

/** Recompute the whole chain for a tenant; report the first broken row. */
export async function verifyChain(c: PoolClient, tenantId: string): Promise<{ ok: boolean; checked: number; firstBrokenId: number | null }> {
  const { rows } = await c.query(
    `SELECT id, tenant_id, occurred_at, actor_id, action, resource, resource_id, host(ip) AS ip, detail, prev_hash, hash
       FROM audit_event WHERE tenant_id = $1 ORDER BY id`, [tenantId]);
  let prev: Buffer | null = null, n = 0;
  for (const r of rows) {
    const row = { tenant_id: r.tenant_id, occurred_at: (r.occurred_at as Date).toISOString(), actor_id: r.actor_id, action: r.action, resource: r.resource, resource_id: r.resource_id, ip: r.ip, detail: r.detail };
    const want = digest(prev, row);
    const linked = (prev === null && r.prev_hash === null) || (prev !== null && r.prev_hash !== null && Buffer.compare(prev, r.prev_hash) === 0);
    if (!linked || Buffer.compare(want, r.hash) !== 0) return { ok: false, checked: n, firstBrokenId: Number(r.id) };
    prev = r.hash; n++;
  }
  return { ok: true, checked: n, firstBrokenId: null };
}
