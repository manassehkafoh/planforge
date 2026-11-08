# 17 · Gap closure register (v0.2)

Every gap found in the v0.1 design pack or while building v0.2, with its disposition. **Closed** means implemented *and* covered by a test that fails without it. **Deferred** means a conscious decision with an owner-facing reason; nothing here is silently dropped.

| ID | Gap | Status | Evidence |
|---|---|---|---|
| G-01 | `audit_event` and `outbox` were not tenant-isolated by row-level security | **Closed** | `db/migrations/002_scheduling_rules.sql`; server runs as `pf_app` (NOBYPASSRLS); cross-tenant tests |
| G-02 | Resource scheduling rules (task types, effort-driven) only designed | **Closed** | `engine/src/resources.ts`, doc 06 §6.1 |
| G-03 | Timephased work, cost and planned value not implemented | **Closed** | `resources.ts` (`timephase`, `plannedValueAt`); reconciliation tests |
| G-04 | Resource levelling only designed | **Closed** | `engine/src/leveling.ts`; livelock regression test; `converged` + unresolved reasons reported |
| G-05 | Incremental recomputation only designed | **Closed** | `Network.apply`; 150-sequence full-vs-incremental oracle; bench p50 ≈ 1 ms at 50 k tasks |
| G-06 | Engine correctness had no independent oracle | **Closed** | `test/oracle.test.ts` (400 networks, dates + float) |
| G-07 | Lag measured on project calendar only | **Closed** | `lagBasis` PROJECT/PRED/SUCC |
| G-08 | Manual scheduling mode, status date, % complete, actuals | **Closed** | `features.test.ts` |
| G-09 | "Why this date?" driver not retained | **Closed** | `drivers` in result, API `schedule.driver` |
| G-10 | Near-critical threshold; calendar inheritance; ALAP free float | **Closed** | `features.test.ts` |
| G-11 | Formula language only designed | **Closed** | `engine/src/formula.ts` + sandbox escape tests |
| G-12 | DST / time-zone edge | **Closed** | `engine/src/zone.ts` (adapter at the edge; kernel stays zone-free) |
| G-13 | No server: only specs | **Closed (single-instance)** | `server/`: auth, RBAC, command path, idempotency, hash-chained audit, realtime, RFC 9457 errors; smoke test |
| G-14 | Overtime rates and overtime work | **Deferred** | Columns reserved; not modelled (doc 06 §11) |
| G-15 | Task splits (interruptions) | **Deferred** | Doc 06 §11 |
| G-16 | Sub-project / cross-project links and cross-project levelling | **Deferred** | Doc 06 §11 |
| G-17 | Direct work/units editing on FIXED_UNITS/FIXED_DURATION | **Deferred** | Work is derived; no circular recalculation |
| G-18 | Edits that move the project finish need a full backward pass | **Accepted limit** | <50 ms target holds for edits not moving the finish; documented in doc 06 §7 |
| G-19 | Calendar edit is a rebuild, not incremental | **Deferred** | O(V+E) |
| G-20 | Golden corpus, mutation testing, formula fuzzing | **Deferred** | Needs user-supplied plans / CI time (doc 13 §4) |
| G-21 | Import (MSPDI/MPP/.pod) and webhooks | **Deferred** | API returns `501 NOT_IMPLEMENTED` |
| G-22 | Multi-instance server: cache and realtime are in-process | **Deferred** | Needs shared pub/sub; version conflicts are strict (409), no commuting rebase |
| G-23 | EVM actual cost is client-supplied (`?ac=`) | **Deferred** | No actuals ledger |
| G-24 | WebSocket over TLS not tested | **Deferred** | Tested over plain WS in dev |

## End-to-end test results and remediation

An independent testing agent wrote and ran `e2e/` (575 tests against the real server and PostgreSQL; plan in `e2e/TEST_PLAN.md`; reports in `e2e/reports/`: `report.html` (with Download PDF), `report.md`, `junit.xml`, `results.json`, `defects.md`, `traceability.md`).

| Run | Pass | Fail | Notes |
|---|---:|---:|---|
| Independent run, before fixes | 503 | 72 | 38 defects registered (1 S1 reproduced, 19 S2) |
| After remediation (final) | **552** | **23** | 0 untriaged; engine unit tests 37/37 |

**Fixed and verified by re-run (25 of 38 no longer reproduce):** PF-001 (oversize WebSocket frame crashed the process), PF-002 (audit hash now covers actor, action, resource and time), PF-003 (RLS on timephase partitions), PF-004 (cross-tenant calendar reference), PF-006 (last project manager could be demoted), PF-009, PF-012 (client-caused DB errors returned 500), PF-013, PF-014 (413 limits), PF-015 (stale resource cache), PF-017, PF-020 (EVM against a saved baseline), PF-021 (baselines immutable, 409), PF-022, PF-024 (If-Match), PF-026 (pagination), PF-027 (Idempotency-Key), PF-029, PF-030, PF-032 (a `nearCriticalMin` change was dropped by the server; summaries could be both critical and near-critical), PF-033, PF-034, PF-036 (ticket lifetime 60 s), PF-037 (risk runs moved to worker threads with a per-tenant bulkhead), PF-038 (dead database connection crashed the process). Two engine defects surfaced by the oracle run were also fixed: constraint dates at the end of a working day (17:00) now compare on the working-time axis, and a summary can no longer be both critical and near-critical.

**Still open (13 defects, 23 failing tests), by decision, not omission:**

| Defect | Sev | Why it is open |
|---|---|---|
| PF-005 | S3 | Foreign keys are not tenant-composite; RLS already blocks the read path. Needs a schema change across every table. |
| PF-007 | S3 | Spec ambiguity: may a project manager demote an org admin? Needs a product decision. |
| PF-008 | S3 | Non-member 404s are not audited; auditing every probe is itself a flooding risk. Needs a decision. |
| PF-010 | S3 | Spec ambiguity: unauthenticated rate limiting is per-IP only. |
| PF-011 | S3 | Authentication events are not written to the audit trail. |
| PF-016 | S2 | Resource list still deviates in shape from the OpenAPI `Resource` schema. |
| PF-018 | S3 | Several list responses use `{items}` wrappers where the OpenAPI declares bare arrays. The server and spec should be reconciled in one pass. |
| PF-019 | S2 | EVM: `ac`/`cv` are null unless the caller supplies `?ac=`, because no actual-cost ledger exists (G-23). |
| PF-023 | S2 | `PATCH` deadline works, but a deadline change bumps the plan version, so a second PATCH with the old ETag correctly returns 409. The test reuses the old ETag. Likely a test/contract clarification, not a server fault. |
| PF-025 | S2 | `critical=true` also returns summary tasks that contain a critical child. Needs a decision on whether summaries count. |
| PF-028 | S3 | NDJSON plan streaming and export formats other than JSON are not built. |
| PF-031 | S3 | Empty body on the optional-body endpoints `schedule` and `baselines` is accepted. |
| PF-035 | S2 | WebSocket protocol differs from docs/07 §6: no `seq`, `clientOpId`, `schedule.delta` or `lastSeq` in `hello`. Needs a realtime redesign pass (G-22). |

Known remaining operational limits that the tests could not exercise: OIDC/JWKS/SCIM (dev IdP is HS256), webhooks and imports (501), UI and accessibility (no UI), DR/PITR, 50k-task API scale and 5k concurrent editors. Idempotency-Key replay and the per-tenant risk bulkhead are in-process (single instance).
