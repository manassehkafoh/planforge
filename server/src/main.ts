import { createServer } from 'node:http';
import { createHandler } from './app.ts';
import { makePool } from './db.ts';
import { Hub } from './realtime.ts';
import { PlanCache } from './store.ts';

export function start(opts: { port?: number; databaseUrl: string; jwtSecret: string; rateLimitPerMin?: number; log?: (s: string) => void }) {
  if (opts.jwtSecret.length < 32) throw new Error('PF_JWT_SECRET must be at least 32 characters');
  const pool = makePool(opts.databaseUrl);
  const hub = new Hub();
  const deps = { pool, secret: opts.jwtSecret, cache: new PlanCache(), hub, rateLimitPerMin: opts.rateLimitPerMin ?? 6000 };
  const server = createServer(createHandler(deps, opts.log));
  server.requestTimeout = 30_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 5_000;
  hub.attach(server, pool);
  return new Promise<{ port: number; close: () => Promise<void>; deps: typeof deps }>((resolve) => {
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ port, deps, close: async () => { hub.close(); server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); await pool.end(); } });
    });
  });
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  const url = process.env.PF_DATABASE_URL, secret = process.env.PF_JWT_SECRET;
  if (!url || !secret) { console.error('PF_DATABASE_URL and PF_JWT_SECRET are required'); process.exit(2); }
  const s = await start({ port: Number(process.env.PORT ?? 8080), databaseUrl: url, jwtSecret: secret, rateLimitPerMin: Number(process.env.PF_RATE_LIMIT_PER_MIN ?? 6000), log: (l) => console.log(l) });
  console.log(`planforge reference server listening on :${s.port}`);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { void s.close().then(() => process.exit(0)); });
}
