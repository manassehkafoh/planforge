# PlanForge reference implementation - end-to-end test plan

Version 1.0. Author: independent testing agent. Status: executed (see `reports/`).

## 1. Purpose and scope

Establish, independently of the implementers, whether the PlanForge reference implementation (`server/` + `engine/` + `db/`) behaves as the specification says (`docs/03` requirements, `docs/05` data model, `docs/06` scheduling design, `docs/07` API and events, `docs/10` security, `api/openapi.yaml`, `api/asyncapi.yaml`).

In scope: the running HTTP/WebSocket server (started as a child process) against PostgreSQL 16, plus direct SQL as the application role `pf_app` and as superuser (for RLS and tamper experiments only).
Out of scope: the browser UI, OIDC/JWKS federation (the server only has a dev HS256 IdP), webhooks, import (both return 501 stubs and are tested only as stubs), Redis/Kafka, object storage, malware sandbox, multi-region DR, load beyond the single-node smoke figures in suite PERF, and anything that needs scopes in the token (the dev IdP issues none).

## 2. Approach

* **Black-box first.** Tests are derived from the specification, not from the implementation. Server source was read only to diagnose an observed failure.
* **Independent oracle.** `lib/oracle.ts` re-implements CPM on an integer working-minute axis (4 link types, lags, 8 constraints, deadline, float, near-critical, summary roll-up). It shares no code with `engine/`.
* **Independent replay.** Incremental-equals-full is checked by exporting a plan, rebuilding it in a brand-new project through the public API, and diffing every derived field.
* **Data-driven authorisation matrix.** 23 actions x 7 principals (six roles + non-member) from `docs/10` section 4.
* **Contract validation.** Every implemented operation response is validated with ajv against `api/openapi.yaml` (loaded from the file, not re-typed).
* **Fault injection.** pg_terminate_backend, connection-limit lockout, truncated bodies, aborted sockets, slow-loris, oversize WebSocket frames, audit tampering with the append-only trigger disabled (always restored).
* **Honest reporting.** A failing test is never weakened. Where the spec is silent the test is labelled a *spec ambiguity* or an *observation*; where the test itself was wrong it is listed under "Test-code corrections" in `reports/report.md`.

## 3. Environment

| Item | Value |
|---|---|
| Runtime | Node 22 (`node --test`, TypeScript type stripping), no build step |
| Server under test | `node server/src/main.ts` spawned per suite (random port), env `PF_DATABASE_URL`, `PF_JWT_SECRET`, `PF_RATE_LIMIT_PER_MIN` |
| Database | PostgreSQL 16, database `planforge_e2e` (separate from dev), recreated by `db/reset-dev.sh` at the start of every run |
| App role | `pf_app` (no DDL, no BYPASSRLS); superuser access via `su postgres -c psql` only inside test helpers named `su()` |
| Seed | tenants A and B, calendars, six role users in A, one in B, holiday 2026-12-25 |
| Test-only dependencies | ajv, ajv-formats, yaml, pg, ws (in `e2e/node_modules`) |

## 4. Entry and exit criteria

Entry: PostgreSQL reachable, `db/reset-dev.sh` runnable, `engine` unit tests runnable, server dependencies installed.
Exit (a run is *complete*): every suite executed, `reports/` regenerated, no server process left running, audit append-only trigger enabled, **zero untriaged failures** (every failing test maps to a registered defect or labelled ambiguity). A run is *green* only when there are no failures; this implementation is not expected to be green, and the report states why.

## 5. Severity scheme

S1 data leak, cross-tenant access, authorisation bypass, corruption, wrong schedule dates, or remote crash of the shared process. S2 specification violation or wrong status/code. S3 minor or inconsistent behaviour. S4 cosmetic/documentation.

## 6. Suites

| Suite | File | Area | Ids |
|---|---|---|---|
| CONTRACT | `suites/01-contract.test.ts` | A: OpenAPI conformance per operation, 501 stubs, pagination/filters/idempotency header, problem+json hygiene fuzz (>300 requests), query validation | E2E-CONTRACT-* |
| AUTH | `suites/02-authn.test.ts` | B: JWT forgery (alg none, wrong key, HS/RS confusion, kid tricks), claims, expiry/nbf/skew, rate limiting | E2E-AUTH-001..017, E2E-RL-* |
| AUTHZ | `suites/03-authz.test.ts` | C: role matrix, TEAM_MEMBER progress-only, cost-field omission and write denial, member management (ORG_ADMIN grant rule, last PM), audited denials | E2E-AUTHZ-* |
| TENANT | `suites/04-tenancy.test.ts` | D: cross-tenant API probes, SQL as pf_app (no tenant, wrong tenant, partitions, inserts, append-only), injection | E2E-TENANT-* |
| CMD | `suites/05-commands.test.ts` | E: atomicity, plan_op log, expectedPlanVersion, 10-way concurrency, clientOpId replay/duplicate, mass assignment, ~100 validation cases, limits (1000/1001 commands, 2 MB), every command op, cycle path, summary rules | E2E-CMD-* |
| SCHED | `suites/06-scheduling.test.ts` | F: link types, lags/leads, constraints, deadline, float, critical path, ALAP, manual, status date, progress, drivers, calendars, 150 random networks vs oracle, 6 random edit runs | E2E-SCHED-* |
| RES | `suites/07-resources.test.ts` | F: task kinds, effort-driven, resource load, levelling (dry run/apply/idempotent/deterministic/no over-allocation), baselines, EVM, risk (seed determinism, quota), scenarios, calendars | E2E-RES-* |
| INCR | `suites/08-incremental.test.ts` | G: 24 projects x 25 random edits vs fresh replay from export, restart persistence, rollback resilience, large batch | E2E-INCR-* |
| RT | `suites/09-realtime.test.ts` | H: tickets (single use, expiry via SQL, forged), hello, fan-out, isolation, 4403 revocation, connection cap, abusive frames, cost leakage | E2E-RT-* |
| AUDIT | `suites/10-audit.test.ts` | I: coverage, fields, paging, isolation, SQL chain check, verify, tamper (update/delete) with trigger restore, concurrency | E2E-AUDIT-* |
| PERF | `suites/11-perf.test.ts` | J: 2,000-task plan, 100 single edits, p50/p95 against NFR-PERF-02/03, cold start, levelling and risk timings | E2E-PERF-* |
| ROBUST | `suites/12-robustness.test.ts` | K: malformed JSON everywhere, numeric extremes, unicode, raw HTTP abuse, aborted requests, slow-loris, DB kill during load, DB down, SIGTERM | E2E-ROBUST-* |

Every test title has the form `E2E-<SUITE>-<ID> | <title> | refs: <spec references>`; the traceability matrix (`reports/traceability.md`) maps requirement ids from `docs/03` to the tests that cite them.

## 7. Risks and limitations of this test campaign

* Single node, single run: concurrency findings are reproducible but not statistically exhaustive.
* Performance numbers are API round-trips on a shared dev VM, not the 50k-task benchmark environment of the specification.
* ORG_ADMIN principals must be provisioned by SQL because the API offers no way to create the first one (reported as a defect/ambiguity).
* Rates cannot be set through the API (reported defect); cost-bearing EVM tests provision rates by SQL.

## 8. How to run

`cd e2e && npm test` (resets the DB, runs the engine unit tests once, runs all suites, writes `reports/`). Environment knobs: `E2E_ONLY=<substring of suite file>`, `E2E_SKIP_RESET=1`, `E2E_SKIP_ENGINE=1`, `E2E_ALLOW_FAIL=1` (exit 0 even with failures).
