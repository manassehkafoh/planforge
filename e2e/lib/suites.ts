export const SUITES: Record<string, { name: string; file: string; area: string; desc: string }> = {
  CONTRACT: { name: 'API contract and error hygiene', file: '01-contract', area: 'A', desc: 'Every implemented operation: status and OpenAPI schema; 501 stubs; RFC 9457 problem bodies; leak fuzzing' },
  AUTH: { name: 'Authentication', file: '02-authn', area: 'B', desc: 'JWT forgery/expiry/claims; cross-tenant tokens; rate limiting' },
  AUTHZ: { name: 'Authorisation (RBAC matrix)', file: '03-authz', area: 'C', desc: 'docs/10 section 4 role x action matrix, field-level cost omission, TEAM_MEMBER progress rule, member management rules, audited denials' },
  TENANT: { name: 'Multi-tenancy and RLS', file: '04-tenancy', area: 'D', desc: 'API-level cross-tenant attempts; SQL-level RLS as pf_app; append-only tables; injection' },
  CMD: { name: 'Command path', file: '05-commands', area: 'E', desc: 'Atomicity, idempotency, optimistic concurrency, validation, every command op' },
  SCHED: { name: 'Scheduling correctness', file: '06-scheduling', area: 'F', desc: 'Dependencies, lags, constraints, calendars, float, drivers, manual, status date, deadline, independent oracle' },
  RES: { name: 'Resources, levelling and analytics', file: '07-resources', area: 'F', desc: 'Task types, effort-driven, load, levelling, EVM, baselines, risk, scenarios, preview' },
  INCR: { name: 'Incremental equals full, restart', file: '08-incremental', area: 'G', desc: 'Randomised edit sequences vs fresh replay; cold cache after restart; rollback resilience' },
  RT: { name: 'Realtime (WebSocket)', file: '09-realtime', area: 'H', desc: 'Tickets, hello, plan.changed fan-out, isolation, 4403, connection cap' },
  AUDIT: { name: 'Audit trail', file: '10-audit', area: 'I', desc: 'Audit coverage of mutations, hash chain verify, tamper detection' },
  PERF: { name: 'Non-functional smoke', file: '11-perf', area: 'J', desc: '2,000-task plan, 100 single edits, latency vs NFR targets' },
  ROBUST: { name: 'Robustness', file: '12-robustness', area: 'K', desc: 'Malformed input, huge numbers, unicode, null bytes, aborted requests, DB connection loss' },
};
