import pg from 'pg';
import { Problem } from './errors.ts';

pg.types.setTypeParser(1114, (v) => Date.parse(`${v.replace(' ', 'T')}Z`)); // timestamp (naive local) -> epoch ms read as wall clock
pg.types.setTypeParser(1700, (v) => parseFloat(v));                          // numeric -> number
pg.types.setTypeParser(1082, (v) => v);                                      // date -> 'YYYY-MM-DD' (never a local-time Date)
pg.types.setTypeParser(20, (v) => Number(v));                                // bigint -> number (plan versions stay < 2^53)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID.test(s);

export function makePool(url: string, max = 20): pg.Pool {
  const pool = new pg.Pool({ connectionString: url, max, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 3_000 });
  pool.on('error', () => { /* idle client errors are surfaced on next use */ });
  return pool;
}

/**
 * Run `fn` in a transaction bound to one tenant: SET LOCAL pf.tenant_id makes PostgreSQL Row-Level Security
 * the last line of defence (the application also filters, but a missing WHERE can never leak another tenant).
 */
export async function tx<T>(pool: pg.Pool, tenantId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  if (!isUuid(tenantId)) throw new Problem('UNAUTHENTICATED');
  let c: pg.PoolClient;
  try { c = await pool.connect(); } catch { throw new Problem('DEPENDENCY_UNAVAILABLE', 'database unavailable'); }
  const onErr = () => { /* PF-038: a dead backend must fail this request, not the process */ };
  c.on('error', onErr);
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('pf.tenant_id', $1, true)", [tenantId]);
    await c.query("SET LOCAL statement_timeout = '8s'");
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch { /* connection already gone */ }
    throw e;
  } finally { c.off('error', onErr); c.release(); }
}
