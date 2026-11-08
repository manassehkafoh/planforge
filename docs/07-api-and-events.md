# 07 · API, Events and Error Taxonomy

Machine-readable contracts: **`api/openapi.yaml`** (OpenAPI 3.0.3 — validated: 22 paths, 29 operations, 32 schemas) and **`api/asyncapi.yaml`** (AsyncAPI 2.6 — validated with the official parser, 0 errors). This document explains the rules behind them.

## 1. API principles
1. **Resources for reads, commands for writes.** `GET` endpoints expose resources; every plan mutation is a `Command` in `POST /projects/{id}/commands`. One validated, atomic, idempotent, auditable path.
2. **Strict versioning.** Major version in the URL (`/v1`). Within a major version only additive changes (new optional fields, new enum *outputs* documented as open). Breaking changes ⇒ `/v2` with 12 months' overlap and `Deprecation`/`Sunset` headers. Clients must ignore unknown fields.
3. **Schema-first.** Zod schemas generate both the OpenAPI document and runtime validation; CI fails if the committed `openapi.yaml` drifts from the code.
4. **Problem Details.** All errors are RFC 9457 `application/problem+json` with a stable `code` and a `traceId`.
5. **Pagination.** Keyset cursors (`cursor`, `limit ≤ 500`), never offsets.
6. **Idempotency.** `Idempotency-Key` header for creates; `clientOpId` inside command batches (stored in `plan_op`).
7. **Concurrency control.** ETag = `planVersion` for plan reads; `If-Match` for project PATCH; `expectedPlanVersion` for commands.
8. **Time.** Plan instants are naive local (project zone); system timestamps RFC 3339 UTC. The API never accepts a zone offset on plan instants (rejects with `VALIDATION_FAILED`) to remove ambiguity.
9. **Least privilege.** OAuth2/OIDC scopes `plan.read|write|baseline|admin`, `resource.write`, `integration.admin`, `audit.read`; scopes are *necessary but not sufficient* — membership/role checks still apply.
10. **Rate limits.** Token bucket per (tenant, client): default 600 req/min, bursts 100; `429` with `Retry-After`. Commands are limited separately (120/min per project).

## 2. Endpoint catalogue

| Area | Method & path | Purpose | Scope |
|---|---|---|---|
| Projects | `GET/POST /projects`, `GET/PATCH/DELETE /projects/{id}` | CRUD envelope, archive | plan.read/write/admin |
| Plan | `GET /projects/{id}/plan` | Snapshot (JSON or NDJSON stream), ETag | plan.read |
| | `POST /projects/{id}/commands` | **The write path** | plan.write |
| | `GET /projects/{id}/tasks[/{taskId}]` | Filtered/paged read model | plan.read |
| | `POST /projects/{id}/schedule` | Stateless what-if | plan.read |
| | `GET/POST /projects/{id}/scenarios` | Named what-if branches | plan.read/write |
| | `GET /projects/{id}/calendars` | Calendars in use | plan.read |
| | `POST /realtime/tickets` | 60 s single-use WebSocket ticket | plan.read |
| Resources | `GET/POST /resources`, `GET /resources/{id}/load` | Pool & utilisation | resource.write |
| | `POST /projects/{id}/level` | Levelling dry-run/apply | plan.write |
| Control | `GET/POST /projects/{id}/baselines`, `GET /projects/{id}/evm` | Baselines, EVM | plan.baseline |
| Risk | `POST /projects/{id}/risk-runs`, `GET …/{runId}` | Async Monte Carlo | plan.write |
| Import/Export | `POST /imports`, `GET /imports/{jobId}`, `GET /projects/{id}/export` | Quarantined import; export | plan.write |
| Integration | `GET/POST /webhooks` | Subscriptions | integration.admin |
| Governance | `GET /audit-events` | Audit trail | audit.read |

## 3. Command model

| `op` | Fields | Validation highlights |
|---|---|---|
| `addTask` | `task`, `afterId?` | name 1–500 chars, `durationMin ≥ 0`, constraint date required for non-ASAP/ALAP |
| `updateTask` | `id`, `patch` | patch is partial; changing `parentId` is **not** allowed here (use `moveTask`) |
| `moveTask` | `id`, `newParentId?`, `afterId?` | no parent cycles; new fractional `sort_key` computed server-side |
| `deleteTask` | `id` | cascades to links/assignments; summary delete removes the subtree |
| `addLink` | `link` | endpoints exist, not summaries, no self-link, no duplicate, **no cycle** |
| `removeLink` | `id` | – |

Batch semantics: **all-or-nothing**. Batches are limited to 1 000 commands and 2 MB. The response carries the new `planVersion`, the recalculated `schedule`, and `changedTaskIds` (so clients patch rather than reload).

## 4. Concurrency, rebase and conflict policy (ADR-005)

```text
client sends   { clientOpId, expectedPlanVersion = v, commands }
server state   plan_version = v + k   (k other batches committed since)

if k == 0          -> apply
else if the k intervening batches COMMUTE with this batch -> rebase (apply on latest), return new version
else               -> 409 VERSION_CONFLICT { currentPlanVersion, interveningOps[] } ; client replays or merges
```
**Commute test** (conservative): two batches commute iff they touch disjoint task ids *and* neither adds a link that touches a task changed by the other *and* neither moves a task into a subtree the other deletes. Anything else → conflict. Field-level last-writer-wins is used only for non-scheduling fields (`name`, `notes`, `custom`). Scheduling fields (`durationMin`, constraint, links, structure) never silently overwrite.

*Why not CRDT for the plan?* Merging two valid replicas can produce a **cycle** (A→B on one replica, B→A on the other) or a violated constraint that no merge rule can repair without a global check — which is exactly what a server sequencer provides. CRDT/OT is used only for long-text fields (comments, notes).

## 5. Error taxonomy

Principles: every error has (1) a stable `code` clients can switch on, (2) an HTTP status, (3) a user-safe message, (4) a developer `detail`, (5) a `traceId`; **no stack traces, SQL, file paths or internal ids** ever reach the client.

| Class | `code` | HTTP | Raised by | Retry? | Client guidance |
|---|---|:-:|---|:-:|---|
| Validation | `VALIDATION_FAILED` | 400 | Zod/schema, domain I3–I6 | No | Fix the field in `errors[].path` |
| Authentication | `UNAUTHENTICATED` | 401 | JWT invalid/expired | After refresh | Re-authenticate |
| Authorisation | `FORBIDDEN` | 403 | RBAC / membership / scope | No | Request access |
| Not found | `NOT_FOUND` | 404 | repository (also for cross-tenant ids — never reveal existence) | No | – |
| Concurrency | `VERSION_CONFLICT` | 409 | `expectedPlanVersion` mismatch, non-commuting | After re-sync | Replay on latest |
| Idempotency | `DUPLICATE_CLIENT_OP` | 409 | same `clientOpId` with **different** body | No | Use a new id |
| Scheduling | `CYCLE_DETECTED` | 422 | Engine `CYCLE` | No | Remove a link on `cycle[]` path |
| Scheduling | `LINK_TO_SUMMARY` | 422 | Engine | No | Link the leaf tasks |
| Scheduling | `UNKNOWN_TASK` | 422 | Engine | No | Refresh plan |
| Scheduling | `DUPLICATE_ID` | 422 | Engine | No | – |
| Scheduling | `CONSTRAINT_UNSATISFIABLE` | 422 | Engine hard-constraint contradictions that cannot be reported as warnings | No | Relax constraint |
| Limits | `PLAN_TOO_LARGE` | 413 | > 100 k tasks / batch > 1 000 cmds | No | Split project |
| Import | `IMPORT_UNSUPPORTED` / `IMPORT_REJECTED_UNSAFE` | 422 | Importer | No | See report |
| Throttling | `RATE_LIMITED` | 429 | Gateway | After `Retry-After` | Back off |
| Dependency | `DEPENDENCY_UNAVAILABLE` | 503 | DB/Redis/Kafka breaker open | Yes (jitter) | – |
| Internal | `INTERNAL` | 500 | Anything else | Yes, idempotent only | Quote `traceId` |

**Soft conflicts are not errors.** `MSO_VIOLATED`, `MFO_VIOLATED`, `SNLT_VIOLATED`, `FNLT_VIOLATED`, `DEADLINE_MISSED` are returned **inside a successful 200** `schedule.conflicts[]`: the plan is valid but unmet. The UI shows badges; the user decides.

Mapping from engine `ScheduleError.code` → HTTP is a total function in one file (`errors/map.ts`) with an exhaustiveness check so adding an engine error without a mapping fails compilation.

Example:
```json
{
  "type": "https://docs.planforge.example/errors/CYCLE_DETECTED",
  "title": "Dependency cycle",
  "status": 422,
  "code": "CYCLE_DETECTED",
  "detail": "Adding this link would create a cycle.",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "cycle": ["7c1…", "b2e…", "91d…", "7c1…"]
}
```

## 6. Realtime protocol (WebSocket)

1. `POST /realtime/tickets {projectId}` → ticket (60 s, single-use, bound to user + tenant + project).
2. Connect `wss://rt…/v1?ticket=…`; server sends `hello {lastSeq}`.
3. Server pushes `plan.changed {seq, planVersion, commands, clientOpId}` in strict `seq` order, then `schedule.delta` (server-authoritative dates), and `presence.updated`.
4. Client applies `plan.changed` to its local store and engine; if it sees `seq` gap > 1 it fetches `GET /plan` and resumes.
5. Heartbeat every 25 s; server closes idle sockets at 60 s; client reconnects with jittered back-off (0.5 s → 30 s).
6. Backpressure: per-socket send buffer cap; on overflow drop **presence** first, then close with code 4408 so the client re-syncs.

Delivery: at-most-once with gap detection — the REST write path is the source of truth, so a lost push can never lose data.

## 7. Webhooks
* Subscription events: `plan.changed`, `schedule.changed`, `baseline.saved`, `risk.completed`, `import.completed`.
* HTTPS only; target host resolved and **checked against private ranges at delivery time** (SSRF defence); redirects not followed.
* Signature: `X-PlanForge-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + body)>`; receivers reject if |now − t| > 5 min.
* At-least-once; retries with exponential back-off for 24 h; `eventId` for de-duplication; endpoint auto-disabled after 7 days of failures with email notice.

## 8. Contract testing
* **Schemathesis** property-based tests generated from `openapi.yaml` run against every PR (status codes, schema conformance, no 5xx on fuzzed input).
* **Consumer-driven contracts** (Pact) for the SPA and the three first-party integrations.
* `openapi-diff` in CI classifies each change as breaking/non-breaking; breaking changes fail unless the version path changed.
