# Defects and findings

Generated 2026-11-08T14:30:33.330Z. Severity: S1 data leak / cross-tenant / authz bypass / corruption / wrong dates; S2 spec violation or wrong status/code; S3 minor/inconsistent; S4 cosmetic/doc.

**Reproduced defects in this run: 11** (S1: 0, S2: 5, S3: 6, S4: 0). Spec ambiguities: 2.

| ID | Sev | Kind | Title | Tests |
|---|---|---|---|---|
| PF-001 | S1 | defect | One WebSocket client can crash the whole server process (oversize frame) | E2E-RT-ABUSE-OVERSIZE |
| PF-002 | S1 | defect | Audit hash chain does not cover actor, action, resource or time: rewriting them is undetected | E2E-AUDIT-TAMPER-ACTION |
| PF-003 | S2 | defect | assignment_timephase partitions have no row-level security; pf_app can read other tenants' rows through them | E2E-TENANT-SQL-000, E2E-TENANT-SQL-003 |
| PF-004 | S2 | defect | POST /resources accepts a calendarId belonging to another tenant (cross-tenant reference and existence oracle) | E2E-TENANT-API-004, E2E-TENANT-API-004b |
| PF-005 | S3 | defect | Foreign keys are not tenant-composite: pf_app can insert a task whose project belongs to another tenant | E2E-TENANT-SQL-004 |
| PF-006 | S2 | defect | The last PROJECT_MANAGER can be demoted through PUT /members (only DELETE is guarded) | E2E-AUTHZ-MEM-003 |
| PF-007 | S3 | spec-ambiguity | A PROJECT_MANAGER can demote or remove an ORG_ADMIN member | E2E-AUTHZ-MEM-008 |
| PF-008 | S3 | defect | Access attempts by non-members (404) are not audited | E2E-AUTHZ-AUDIT-002 |
| PF-009 | S3 | defect | 401 responses carry no WWW-Authenticate header | E2E-AUTH-002 |
| PF-010 | S3 | spec-ambiguity | Unauthenticated requests are never rate limited | E2E-AUTH-RL-003 |
| PF-011 | S3 | defect | Audit trail does not record authentication events | E2E-AUDIT-AUTHN |
| PF-012 | S2 | defect | Server errors (500) for malformed but client-caused input | E2E-CONTRACT-ERR-001, E2E-CMD-VAL-fixedWork-without-work, E2E-CMD-VAL-date-month-13, E2E-CMD-VAL-date-hour-25, E2E-CMD-VAL-estimate-order, E2E-CMD-VAL-textual-edge, E2E-ROBUST-UNICODE |
| PF-013 | S3 | defect | Impossible calendar dates are silently accepted (2026-02-30) | E2E-CMD-VAL-date-feb-30 |
| PF-014 | S2 | defect | Batch limits answered with 400, and the 2 MB body limit is not enforced | E2E-CMD-VAL-limits-1001, E2E-CMD-VAL-bodysize |
| PF-015 | S2 | defect | Stale resource cache: a resource created after the plan was first loaded cannot be assigned on the first attempt | E2E-CMD-ASSIGN-FRESHRES, E2E-CMD-ASG-001 |
| PF-016 | S2 | defect | POST /resources rejects stdRatePerHour, so rates cannot be set; resource responses deviate from the contract | E2E-CONTRACT-OP-createResource, E2E-CONTRACT-OP-listResources |
| PF-017 | S2 | defect | previewSchedule rejects the documented CommandBatch body | E2E-CONTRACT-OP-previewSchedule, E2E-SCHED-PREVIEW-BATCH |
| PF-018 | S3 | defect | Several response bodies deviate from their OpenAPI schemas (list wrappers, load, scenario, baseline) | E2E-CONTRACT-OP-listScenarios, E2E-CONTRACT-OP-createScenario, E2E-CONTRACT-OP-listCalendars, E2E-CONTRACT-OP-getResourceLoad, E2E-CONTRACT-OP-saveBaseline, E2E-CONTRACT-OP-listBaselines |
| PF-019 | S2 | defect | EVM response deviates from the contract (statusDate required, datetime, ac/cv null, no eac/etc) | E2E-CONTRACT-OP-getEarnedValue, E2E-CONTRACT-OP-getEarnedValue-default, E2E-RES-EVM-002, E2E-RES-EVM-004 |
| PF-020 | S2 | defect | EVM ignores the baseline parameter | E2E-RES-EVM-003, E2E-RES-EVM-005 |
| PF-021 | S2 | defect | Saving a baseline number twice silently overwrites it (not immutable) | E2E-RES-BASE-001, E2E-RES-BASE-IMMUTABLE |
| PF-022 | S3 | defect | A baseline saved on an empty plan is not returned by listBaselines | E2E-RES-BASE-EMPTY |
| PF-023 | S2 | defect | PATCH /projects rejects deadline | E2E-CONTRACT-OP-updateProject-deadline |
| PF-024 | S3 | defect | If-Match is not enforced on PATCH /projects | E2E-CONTRACT-IFMATCH-001 |
| PF-025 | S2 | defect | Task list filters q, critical and finishBefore are ignored | E2E-CONTRACT-FILTER-q, E2E-CONTRACT-FILTER-critical, E2E-CONTRACT-FILTER-finishBefore |
| PF-026 | S2 | defect | Pagination is not implemented (cursor/limit ignored, limit=0 accepted) | E2E-CONTRACT-PAGE-001, E2E-CONTRACT-PAGE-002 |
| PF-027 | S2 | defect | Idempotency-Key header is ignored on POST /projects | E2E-CONTRACT-IDEMP-001, E2E-CONTRACT-IDEMP-002 |
| PF-028 | S3 | defect | Export format and Accept negotiation ignored | E2E-CONTRACT-OP-exportProject-formats, E2E-CONTRACT-OP-getPlan-ndjson |
| PF-029 | S3 | defect | 405 responses have the wrong body and no Allow header | E2E-CONTRACT-ERR-003, E2E-CONTRACT-ERR-005 |
| PF-030 | S3 | defect | Typed query parameters are not validated (garbage uuid/date accepted) | E2E-CONTRACT-QUERY-001, E2E-RES-LOAD-003 |
| PF-031 | S3 | defect | Empty request body accepted where the contract requires one | E2E-ROBUST-JSON |
| PF-032 | S2 | defect | Changing nearCriticalMin does not recompute nearCritical flags; incremental state diverges from a full recompute | E2E-SCHED-FLOAT, E2E-INCR-RANDOM |
| PF-033 | S3 | defect | A summary task can be critical and nearCritical at the same time | E2E-SCHED-RAND-summaries |
| PF-034 | S3 | defect | False MSO_VIOLATED when the pinned date is a non-working instant that maps to the same working position | E2E-SCHED-CON-ALL-ORACLE |
| PF-035 | S2 | defect | WebSocket protocol deviates from docs/07 §6 and asyncapi.yaml | E2E-RT-HELLO, E2E-RT-FANOUT-SHAPE, E2E-RT-FANOUT-DELTA |
| PF-036 | S4 | defect | Realtime ticket lives 30 s although docs and OAS say 60 s | E2E-RT-TICKET-001 |
| PF-037 | S2 | defect | A maximum-size risk run blocks the whole server: no per-tenant bulkhead; other tenants get connection resets | E2E-PERF-RISK-NEIGHBOUR |
| PF-038 | S2 | defect | Killing a database backend while a request holds it crashes the whole server process (no error listener on checked-out clients) | E2E-ROBUST-PGKILL-IDLE, E2E-ROBUST-PGKILL-LOAD, E2E-ROBUST-PGKILL-WS, E2E-ROBUST-DBDOWN |

## PF-001 [S1] One WebSocket client can crash the whole server process (oversize frame)

- **Spec reference:** docs/10 T11 (connection flood, send-buffer caps), NFR-AVAIL
- **Status this run:** NOT REPRODUCED (linked tests passed)
- **Tests:** E2E-RT-ABUSE-OVERSIZE

**Steps to reproduce**

1. Obtain a ticket for any project you can read (a VIEWER suffices). 2. Open the socket. 3. Send one 1 MB text message.

**Expected:** The offending socket is closed (1009) and every other connection and tenant keeps being served.

**Actual:** The ws library emits an unhandled "error" event (WS_ERR_UNSUPPORTED_MESSAGE_LENGTH, maxPayload 4096), the Node process exits with code 1, and every tenant loses service. Any authenticated user of any tenant can do this. Evidence: server stderr tail captured in the failing test.

**Evidence (from this run)**

- (linked tests passed in this run)

## PF-002 [S1] Audit hash chain does not cover actor, action, resource or time: rewriting them is undetected

- **Spec reference:** docs/10 §7 and T13 (hash = SHA256(prev_hash || canonical_json(row)); any break pinpoints the first tampered row)
- **Status this run:** NOT REPRODUCED (linked tests passed)
- **Tests:** E2E-AUDIT-TAMPER-ACTION

**Steps to reproduce**

1. As superuser disable the append-only trigger. 2. UPDATE audit_event SET actor_id / action / resource_id / occurred_at on one row. 3. Re-enable the trigger. 4. GET /audit-events/verify.

**Expected:** ok:false with firstBrokenId equal to the modified row (as it is for a modified detail column, which IS detected).

**Actual:** verify returns ok:true for all four columns, so the trail can be rewritten to blame someone else or hide who did what without detection. Only the detail column and row deletion/relinking are covered by the hash.

**Evidence (from this run)**

- (linked tests passed in this run)

## PF-003 [S2] assignment_timephase partitions have no row-level security; pf_app can read other tenants' rows through them

- **Spec reference:** docs/10 T2 (RLS on every table, tested), docs/05
- **Status this run:** NOT REPRODUCED (linked tests passed)
- **Tests:** E2E-TENANT-SQL-000, E2E-TENANT-SQL-003

**Steps to reproduce**

1. As superuser insert timephase rows for tenant A and B. 2. As pf_app with NO tenant set (or tenant B) SELECT from pf.assignment_timephase_p0..p3.

**Expected:** Zero rows (RLS forced on every tenant table).

**Actual:** All rows of all tenants are returned from the partitions (the parent table is protected, the child partitions are not). Latent: the current server populates no timephase rows and queries only the parent, so it is not reachable through the API today.

**Evidence (from this run)**

- (linked tests passed in this run)

## PF-004 [S2] POST /resources accepts a calendarId belonging to another tenant (cross-tenant reference and existence oracle)

- **Spec reference:** docs/10 T2, OAS ResourceCreate.calendarId
- **Status this run:** NOT REPRODUCED (linked tests passed)
- **Tests:** E2E-TENANT-API-004, E2E-TENANT-API-004b

**Steps to reproduce**

1. As tenant B POST /resources {name, calendarId: <tenant A calendar id>}. 2. Repeat with a random uuid.

**Expected:** Both are rejected identically (400 unknown calendar / 404), nothing is stored.

**Actual:** The foreign id is accepted (201) and stored, the random id gets 400, so tenant B can test whether a given uuid is a tenant-A calendar (FK checks bypass RLS).

**Evidence (from this run)**

- (linked tests passed in this run)

## PF-006 [S2] The last PROJECT_MANAGER can be demoted through PUT /members (only DELETE is guarded)

- **Spec reference:** docs/10 §4, last-PM rule
- **Status this run:** NOT REPRODUCED (linked tests passed)
- **Tests:** E2E-AUTHZ-MEM-003

**Steps to reproduce**

1. Project with a single PM. 2. PM does PUT /members/{self} {role: VIEWER}.

**Expected:** 409/422: a project must keep a project manager.

**Actual:** 200: the project is left without anyone who can manage it.

**Evidence (from this run)**

- (linked tests passed in this run)

## PF-012 [S2] Server errors (500) for malformed but client-caused input

- **Spec reference:** docs/07 §5 (client errors are 4xx), docs/10 T4
- **Status this run:** NOT REPRODUCED (linked tests passed)
- **Tests:** E2E-CONTRACT-ERR-001, E2E-CMD-VAL-fixedWork-without-work, E2E-CMD-VAL-date-month-13, E2E-CMD-VAL-date-hour-25, E2E-CMD-VAL-estimate-order, E2E-CMD-VAL-textual-edge, E2E-ROBUST-UNICODE

**Steps to reproduce**

POST /resources {"name":"\u0000"}; PATCH /projects name NUL; addTask kind FIXED_WORK without workMin; constraint date 2026-13-09T08:00:00 or T25:00:00; estimate optimistic > likely; project name with a lone surrogate; GET /projects/% ; startDate 2026-02-31.

**Expected:** 400 VALIDATION_FAILED for each.

**Actual:** INTERNAL 500 (database check-constraint, invalid-date and encoding errors leak through as 500). No stack or SQL is exposed, but clients cannot distinguish them from outages.

**Evidence (from this run)**

- (linked tests passed in this run)

## PF-014 [S2] Batch limits answered with 400, and the 2 MB body limit is not enforced

- **Spec reference:** docs/07 §3 and §5 (PLAN_TOO_LARGE 413)
- **Status this run:** NOT REPRODUCED (linked tests passed)
- **Tests:** E2E-CMD-VAL-limits-1001, E2E-CMD-VAL-bodysize

**Steps to reproduce**

1. POST 1001 commands. 2. POST a 3 MB body.

**Expected:** 413 PLAN_TOO_LARGE for both.

**Actual:** 1001 commands -> 400 VALIDATION_FAILED ("at most 1000"); a 3 MB body is parsed and validated field by field (no 413 at all).

**Evidence (from this run)**

- (linked tests passed in this run)

## PF-015 [S2] Stale resource cache: a resource created after the plan was first loaded cannot be assigned on the first attempt

- **Spec reference:** FR-RS-01/02, docs/07 §3 addAssignment
- **Status this run:** NOT REPRODUCED (linked tests passed)
- **Tests:** E2E-CMD-ASSIGN-FRESHRES, E2E-CMD-ASG-001

**Steps to reproduce**

1. Create a project and a task. 2. POST /resources. 3. Immediately addAssignment with the new resource id.

**Expected:** 200.

**Actual:** 400 "unknown resource" on the first attempt; a retry succeeds. Every client that creates a resource and assigns it hits this.

**Evidence (from this run)**

- (linked tests passed in this run)

## PF-016 [S2] POST /resources rejects stdRatePerHour, so rates cannot be set; resource responses deviate from the contract

- **Spec reference:** OAS ResourceCreate / Resource, FR-RS-03
- **Status this run:** REPRODUCED
- **Tests:** E2E-CONTRACT-OP-createResource, E2E-CONTRACT-OP-listResources

**Steps to reproduce**

1. POST /resources {"name":"x","stdRatePerHour":50}. 2. GET /resources.

**Expected:** 201 with the rate stored; list items valid against Resource.

**Actual:** 400 (unknown key); the create response omits calendarId and the list returns calendarId:null (schema violation). Cost EVM can only be exercised by SQL-provisioned rates.

**Evidence (from this run)**

- `E2E-CONTRACT-OP-listResources`: GET /resources -> 200 violates OpenAPI schema:
    /items/0/calendarId must be string {"type":"string"}
    body: {"items":[{"id":"fcc391a7-e961-4c75-89ed-67d4ede670f1","name":"Contract res","kind":"WORK","maxUnits":1,"calendarId":null,"isActive":true,"rates":[]}]}
  
  1 !== 0

## PF-017 [S2] previewSchedule rejects the documented CommandBatch body

- **Spec reference:** OAS previewSchedule (CommandBatch)
- **Status this run:** NOT REPRODUCED (linked tests passed)
- **Tests:** E2E-CONTRACT-OP-previewSchedule, E2E-SCHED-PREVIEW-BATCH

**Steps to reproduce**

POST /projects/{id}/schedule {clientOpId, expectedPlanVersion, commands}.

**Expected:** 200 with a schedule preview.

**Actual:** 400 VALIDATION_FAILED (unknown keys clientOpId/expectedPlanVersion); only a bare {commands} body works.

**Evidence (from this run)**

- (linked tests passed in this run)

## PF-019 [S2] EVM response deviates from the contract (statusDate required, datetime, ac/cv null, no eac/etc)

- **Spec reference:** OAS Evm / getEarnedValue, FR-EV-01
- **Status this run:** REPRODUCED
- **Tests:** E2E-CONTRACT-OP-getEarnedValue, E2E-CONTRACT-OP-getEarnedValue-default, E2E-RES-EVM-002, E2E-RES-EVM-004

**Steps to reproduce**

GET /evm without statusDate; GET /evm?statusDate=2026-11-10.

**Expected:** 200 for the optional parameter; ac, cv numbers; statusDate formatted as date.

**Actual:** 400 when statusDate is omitted; statusDate returned as a datetime; ac and cv are null (actual cost "not tracked"); eac/etc/vac/tcpi absent.

**Evidence (from this run)**

- `E2E-CONTRACT-OP-getEarnedValue`: GET /projects/{projectId}/evm -> 200 violates OpenAPI schema:
    /statusDate must match format "date" {"format":"date"}
    /ac must be number {"type":"number"}
    /cv must be number {"type":"number"}
    body: {"statusDate":"2026-11-10T00:00:00","bac":100,"pv":100,"ev":0,"sv":-100,"spi":0,"pvBasis":"cost of working days before the status date","ac":null,"cpi":null,"cv":null,"note":"actual cost is not tracked by the reference server; pass ?ac= to compute cost indices"}
  
  3 !== 0
- `E2E-CONTRACT-OP-getEarnedValue-default`: GET /projects/{projectId}/evm -> 200 violates OpenAPI schema:
    /statusDate must match format "date" {"format":"date"}
    /ac must be number {"type":"number"}
    /cv must be number {"type":"number"}
    body: {"statusDate":"2026-11-08T00:00:00","bac":100,"pv":0,"ev":0,"sv":0,"spi":null,"pvBasis":"cost of working days before the status date","ac":null,"cpi":null,"cv":null,"note":"actual cost is not tracked by the reference server; pass ?ac= to compute cost indices"}
  
  3 !== 0
- `E2E-RES-EVM-004`: OAS Evm requires numbers; got ac=null cv=null
  + actual - expected
  
  + [
  +   'ac',
  +   'cv'
  + ]
  - []

## PF-020 [S2] EVM ignores the baseline parameter

- **Spec reference:** OAS getEarnedValue.baseline, FR-BL-03
- **Status this run:** NOT REPRODUCED (linked tests passed)
- **Tests:** E2E-RES-EVM-003, E2E-RES-EVM-005

**Steps to reproduce**

1. Save baseline 1, change fixedCost. 2. GET /evm?baseline=1 and ?baseline=7.

**Expected:** baseline=1 uses the saved snapshot; baseline=7 (absent) -> 404.

**Actual:** Both answered from the live plan (BAC 5000 instead of 1000; baseline=7 returns 200).

**Evidence (from this run)**

- (linked tests passed in this run)

## PF-021 [S2] Saving a baseline number twice silently overwrites it (not immutable)

- **Spec reference:** OAS saveBaseline (immutable once saved; 409), FR-BL-02
- **Status this run:** NOT REPRODUCED (linked tests passed)
- **Tests:** E2E-RES-BASE-001, E2E-RES-BASE-IMMUTABLE

**Steps to reproduce**

POST /baselines {number:1} twice with a plan edit between.

**Expected:** 409 on the second save; the first snapshot stays.

**Actual:** 201 again with a new planVersion/finish: the earlier baseline is replaced, destroying the reference for variance reporting.

**Evidence (from this run)**

- (linked tests passed in this run)

## PF-023 [S2] PATCH /projects rejects deadline

- **Spec reference:** OAS ProjectPatch.deadline
- **Status this run:** REPRODUCED
- **Tests:** E2E-CONTRACT-OP-updateProject-deadline

**Steps to reproduce**

PATCH /projects/{id} {"deadline":"2026-12-01T17:00:00"}.

**Expected:** 200.

**Actual:** 400 (unknown key); a deadline can only be set through the setProject command.

**Evidence (from this run)**

- `E2E-CONTRACT-OP-updateProject-deadline`: expected HTTP 200, got 409
    request:  PATCH /projects/072f9087-5173-467c-9f92-c62c3afe338e {"deadline":null}
    response: HTTP 409 {"type":"https://docs.planforge.example/errors/VERSION_CONFLICT","title":"Plan version conflict","status":409,"code":"VERSION_CONFLICT","detail":"plan changed since the ETag was issued","instance":"/projects/072f9087-5173-467c-9f92-c62c3afe338e","traceId":"b134778f-cfbd-4099-950e-c53001ad0498","currentPlanVersion":1}

## PF-025 [S2] Task list filters q, critical and finishBefore are ignored

- **Spec reference:** OAS listTasks
- **Status this run:** REPRODUCED
- **Tests:** E2E-CONTRACT-FILTER-q, E2E-CONTRACT-FILTER-critical, E2E-CONTRACT-FILTER-finishBefore

**Steps to reproduce**

GET /tasks?q=..., ?critical=true, ?finishBefore=...

**Expected:** Filtered result.

**Actual:** Unfiltered list (only parentId works).

**Evidence (from this run)**

- `E2E-CONTRACT-FILTER-critical`: Expected values to be strictly deep-equal:
  + actual - expected
  
    [
  +   'ac016f0a-8833-49d1-9e2e-85eef207e68d',
      'd63d40dd-5a2d-48cd-9896-66d9f58b6ae7'
    ]

## PF-026 [S2] Pagination is not implemented (cursor/limit ignored, limit=0 accepted)

- **Spec reference:** OAS Cursor/Limit parameters, docs/07 §1.5
- **Status this run:** NOT REPRODUCED (linked tests passed)
- **Tests:** E2E-CONTRACT-PAGE-001, E2E-CONTRACT-PAGE-002

**Steps to reproduce**

GET /tasks?limit=3 on a 10-task project; GET /projects?limit=0.

**Expected:** Three tasks and a nextCursor; limit=0 -> 400.

**Actual:** All tasks, no nextCursor; limit=0 -> 200. (The performance suite shows the cost: GET /tasks?limit=100 returns 2,000 tasks.)

**Evidence (from this run)**

- (linked tests passed in this run)

## PF-027 [S2] Idempotency-Key header is ignored on POST /projects

- **Spec reference:** docs/07 §1.6
- **Status this run:** NOT REPRODUCED (linked tests passed)
- **Tests:** E2E-CONTRACT-IDEMP-001, E2E-CONTRACT-IDEMP-002

**Steps to reproduce**

POST /projects twice with the same Idempotency-Key (same body, then different body).

**Expected:** Same project returned; different body -> 409.

**Actual:** Two projects created / second accepted.

**Evidence (from this run)**

- (linked tests passed in this run)

## PF-032 [S2] Changing nearCriticalMin does not recompute nearCritical flags; incremental state diverges from a full recompute

- **Spec reference:** docs/06 §5, §7 (incremental == full), FR-SC-05
- **Status this run:** NOT REPRODUCED (linked tests passed)
- **Tests:** E2E-SCHED-FLOAT, E2E-INCR-RANDOM

**Steps to reproduce**

1. Plan with a task having 480 min of float. 2. setProject nearCriticalMin 240. 3. GET plan.

**Expected:** nearCritical false (480 > 240); identical to what a fresh replay of the same plan produces.

**Actual:** nearCritical stays true until the process restarts and the plan is reloaded; the replay oracle shows the difference after a random edit sequence containing nearCriticalMin changes.

**Evidence (from this run)**

- (linked tests passed in this run)

## PF-035 [S2] WebSocket protocol deviates from docs/07 §6 and asyncapi.yaml

- **Spec reference:** docs/07 §6, api/asyncapi.yaml (hello, plan.changed, schedule.delta)
- **Status this run:** REPRODUCED
- **Tests:** E2E-RT-HELLO, E2E-RT-FANOUT-SHAPE, E2E-RT-FANOUT-DELTA

**Steps to reproduce**

Connect, apply batches, observe messages.

**Expected:** hello {lastSeq}; plan.changed {seq, planVersion, actorId, clientOpId, commands}; schedule.delta.

**Actual:** hello has only projectId; plan.changed carries {projectId, planVersion, changedTaskIds}; no seq (gap detection impossible), no clientOpId (optimistic reconciliation impossible), no schedule.delta.

**Evidence (from this run)**

- `E2E-RT-HELLO`: Expected values to be strictly equal:
  
  undefined !== 2
- `E2E-RT-FANOUT-SHAPE`: asyncapi.yaml PlanChanged fields absent; sample: msg 0: seq=undefined; msg 0: actorId missing; msg 0: commands missing; msg 1: seq=undefined
  + actual - expected
  
  + [
  +   'seq=undefined',
  +   'actorId missing',
  +   'commands missing',
  +   'clientOpId=undefined'
  + ]
  - []
- `E2E-RT-FANOUT-DELTA`: no schedule.delta in ["hello","plan.changed"]

## PF-037 [S2] A maximum-size risk run blocks the whole server: no per-tenant bulkhead; other tenants get connection resets

- **Spec reference:** docs/10 T12 (per-tenant concurrency bulkhead), T20 (noisy neighbour), NFR-SCAL
- **Status this run:** NOT REPRODUCED (linked tests passed)
- **Tests:** E2E-PERF-RISK-NEIGHBOUR

**Steps to reproduce**

1. Tenant A: 2,000-task plan, POST /risk-runs {iterations:2000}. 2. 0.7 s later tenant B (fresh connection): GET /projects/{id}.

**Expected:** Tenant B answered < 5 s; the risk run is queued/limited per tenant.

**Actual:** The risk run executes synchronously on the event loop for 20-50 s; tenant B request fails with ECONNRESET (the server drops the connection once its own header timeout elapses while the loop is blocked). Keep-alive connections were also reset. The server recovers afterwards.

**Evidence (from this run)**

- (linked tests passed in this run)

## PF-038 [S2] Killing a database backend while a request holds it crashes the whole server process (no error listener on checked-out clients)

- **Spec reference:** NFR-REL (DB connection loss), NFR-AVAIL, docs/04 resilience
- **Status this run:** NOT REPRODUCED (linked tests passed)
- **Tests:** E2E-ROBUST-PGKILL-IDLE, E2E-ROBUST-PGKILL-LOAD, E2E-ROBUST-PGKILL-WS, E2E-ROBUST-DBDOWN

**Steps to reproduce**

1. Start server and send traffic. 2. SELECT pg_terminate_backend(pid) for the pf_app backends (or restart PostgreSQL / lower the role connection limit) while requests are in flight.

**Expected:** In-flight requests fail with 503 DEPENDENCY_UNAVAILABLE; the process stays up and recovers.

**Actual:** Intermittent (a race: it needs the backend to die while a client is checked out between queries): the process exits with code 1 on an unhandled "error" event emitted by a pg Client (server/src/db.ts tx(): pool.on("error") covers only idle clients; the checked-out PoolClient has no listener). All tenants lose service until a supervisor restarts it. Reproduced in 1 of 3 full runs; earlier runs passed.

**Evidence (from this run)**

- (linked tests passed in this run)

## PF-005 [S3] Foreign keys are not tenant-composite: pf_app can insert a task whose project belongs to another tenant

- **Spec reference:** docs/05, docs/10 T2 (defence in depth)
- **Status this run:** REPRODUCED
- **Tests:** E2E-TENANT-SQL-004

**Steps to reproduce**

1. As pf_app with tenant B set, INSERT a task with project_id of a tenant-A project and tenant_id = B.

**Expected:** Rejected by a composite FK / check.

**Actual:** Accepted (RLS WITH CHECK only validates the row's own tenant_id).

**Evidence (from this run)**

- `E2E-TENANT-SQL-004`: task (cross-tenant project) [wrong-tenant] ACCEPTED
  
  1 !== 0

## PF-007 [S3] (SPEC AMBIGUITY) A PROJECT_MANAGER can demote or remove an ORG_ADMIN member

- **Spec reference:** docs/10 §4 (members: ORG_ADMIN and PM; ORG_ADMIN grant restricted)
- **Status this run:** REPRODUCED
- **Tests:** E2E-AUTHZ-MEM-008

**Steps to reproduce**

1. ORG_ADMIN is a member (SQL-provisioned). 2. PM PUTs a lower role or DELETEs that member.

**Expected:** Refused: granting ORG_ADMIN needs an ORG_ADMIN, so removing one should as well.

**Actual:** PUT 200 and DELETE 204. Privilege inversion; the spec is silent, so reported as S3 / ambiguity.

**Evidence (from this run)**

- `E2E-AUTHZ-MEM-008`: PM must not be able to strip an ORG_ADMIN: PUT->200, DELETE->204
    request:  PUT /projects/21e5b040-4d04-4ce7-b351-d4a827c90dbc/members/a1000000-0000-4000-8000-000000000001 {"role":"VIEWER"}
    response: HTTP 200 {"userId":"a1000000-0000-4000-8000-000000000001","role":"VIEWER"}
    request:  DELETE /projects/21e5b040-4d04-4ce7-b351-d4a827c90dbc/members/a1000000-0000-4000-8000-000000000001
    response: HTTP 204

## PF-008 [S3] Access attempts by non-members (404) are not audited

- **Spec reference:** docs/10 §7 ("failed authorisation" is logged)
- **Status this run:** REPRODUCED
- **Tests:** E2E-AUTHZ-AUDIT-002

**Steps to reproduce**

1. A tenant user who is not a member of a project repeatedly requests it. 2. Read the audit trail.

**Expected:** An audit event per denied access (as 403 denials get authz.denied).

**Actual:** Nothing is recorded for the 404 form of denial, so enumeration of project ids is invisible in the trail.

**Evidence (from this run)**

- `E2E-AUTHZ-AUDIT-002`: no audit event recorded for repeated non-member access attempts to a project they cannot see

## PF-009 [S3] 401 responses carry no WWW-Authenticate header

- **Spec reference:** RFC 9110 15.5.2, docs/07 §1.3
- **Status this run:** NOT REPRODUCED (linked tests passed)
- **Tests:** E2E-AUTH-002

**Steps to reproduce**

1. GET /projects without a token.

**Expected:** WWW-Authenticate: Bearer ...

**Actual:** Header absent.

**Evidence (from this run)**

- (linked tests passed in this run)

## PF-010 [S3] (SPEC AMBIGUITY) Unauthenticated requests are never rate limited

- **Spec reference:** docs/07 §1.10 (spec silent on anonymous traffic)
- **Status this run:** REPRODUCED
- **Tests:** E2E-AUTH-RL-003

**Steps to reproduce**

1. Send 200 requests without credentials in a minute.

**Expected:** A per-IP limit (429) is documented practice for anonymous traffic.

**Actual:** Always 401; no throttle. The specification only defines limits per tenant/user.

**Evidence (from this run)**

- `E2E-AUTH-RL-003`: unauthenticated requests never throttled: 401

## PF-011 [S3] Audit trail does not record authentication events

- **Spec reference:** docs/10 §7 ("Logged: authentication ...")
- **Status this run:** REPRODUCED
- **Tests:** E2E-AUDIT-AUTHN

**Steps to reproduce**

1. Send a valid and an invalid-token request. 2. Read the audit trail.

**Expected:** Authentication events (at least failures) are recorded.

**Actual:** Only mutations and 403 denials are recorded.

**Evidence (from this run)**

- `E2E-AUDIT-AUTHN`: docs/10 section 7 lists "authentication" among logged events; none was recorded

## PF-013 [S3] Impossible calendar dates are silently accepted (2026-02-30)

- **Spec reference:** docs/07 §1.8 (plan instants), OAS date-time
- **Status this run:** NOT REPRODUCED (linked tests passed)
- **Tests:** E2E-CMD-VAL-date-feb-30

**Steps to reproduce**

addTask with constraint {type: SNET, date: "2026-02-30T08:00:00"}.

**Expected:** 400 VALIDATION_FAILED.

**Actual:** 200: the date is normalised (rolls into March) without notice.

**Evidence (from this run)**

- (linked tests passed in this run)

## PF-018 [S3] Several response bodies deviate from their OpenAPI schemas (list wrappers, load, scenario, baseline)

- **Spec reference:** OAS Scenario, Calendar, Baseline, getResourceLoad
- **Status this run:** REPRODUCED
- **Tests:** E2E-CONTRACT-OP-listScenarios, E2E-CONTRACT-OP-createScenario, E2E-CONTRACT-OP-listCalendars, E2E-CONTRACT-OP-getResourceLoad, E2E-CONTRACT-OP-saveBaseline, E2E-CONTRACT-OP-listBaselines

**Steps to reproduce**

Call each operation and validate the body with ajv against api/openapi.yaml.

**Expected:** Arrays as documented; load = [{day, plannedMin, capacityMin, overallocated}]; Scenario.result has tasks; Baseline.savedAt.

**Actual:** Lists are wrapped as {items:[...]}; resource load is {resourceId, maxUnits, days:[{day, workMin, ...}]}; scenario result lacks tasks; saveBaseline response lacks savedAt.

**Evidence (from this run)**

- `E2E-CONTRACT-OP-listScenarios`: GET /projects/{projectId}/scenarios -> 200 violates OpenAPI schema:
    / must be array {"type":"array"}
    body: {"items":[]}
  
  1 !== 0
- `E2E-CONTRACT-OP-createScenario`: POST /projects/{projectId}/scenarios -> 201 violates OpenAPI schema:
    /result must have required property 'tasks' {"missingProperty":"tasks"}
    body: {"id":"c1ed3b1d-4b74-4d7b-a884-9d510553f14a","name":"what-if","basePlanVersion":1,"result":{"start":"2026-11-09T08:00:00","finish":"2026-11-12T17:00:00","criticalPath":["0e784a03-1e5c-4406-9349-94486ae8599f","67738ed6-b699-41b9-86d8-8f6c5c22683f"],"conflicts":[]}}
  
  1 !== 0
- `E2E-CONTRACT-OP-listCalendars`: GET /projects/{projectId}/calendars -> 200 violates OpenAPI schema:
    / must be array {"type":"array"}
    body: {"items":[{"id":"ca000000-0000-4000-8000-000000000001","name":"Standard 5x8","baseId":null,"timeZone":"UTC","week":[[],[{"endMin":720,"startMin":480},{"endMin":1020,"startMin":780}],[{"endMin":720,"startMin":480},{"endMin":1020,"startMin":780}],[{"endMin":720,"startMin":480},{"endMin":1020,"startMin":780}],[{"endMin":720,"startMin":480},{"endMin":1020,"startMin":780}],[{"endMin":720,"startMin":480},{"endMin":1020,"startMin":780}],[]]}]}
  
  1 !== 0
- `E2E-CONTRACT-OP-getResourceLoad`: GET /resources/{resourceId}/load -> 200 violates OpenAPI schema:
    / must be array {"type":"array"}
    body: {"resourceId":"fcc391a7-e961-4c75-89ed-67d4ede670f1","maxUnits":1,"days":[{"day":"2026-11-09","workMin":480,"capacityMin":480,"overallocated":false}]}
  
  1 !== 0
- `E2E-CONTRACT-OP-saveBaseline`: POST /projects/{projectId}/baselines -> 201 violates OpenAPI schema:
    / must have required property 'savedAt' {"missingProperty":"savedAt"}
    body: {"id":"0d8579c8-9d6a-433d-a176-3dc0d4a0f3cf","number":0,"label":"BL0","planVersion":1,"taskCount":1,"finish":"2026-11-09T17:00:00"}
  
  1 !== 0
- `E2E-CONTRACT-OP-listBaselines`: GET /projects/{projectId}/baselines -> 200 violates OpenAPI schema:
    / must be array {"type":"array"}
    body: {"items":[{"id":"c5419111-d408-4bdb-9096-9ddbe3a82a43","number":2,"label":"x","planVersion":1,"savedAt":"2026-11-08T14:26:49.946Z","finish":"2026-11-09T17:00:00","taskCount":1,"finishVarianceMin":0,"cost":0}]}
  
  1 !== 0

## PF-022 [S3] A baseline saved on an empty plan is not returned by listBaselines

- **Spec reference:** OAS listBaselines
- **Status this run:** NOT REPRODUCED (linked tests passed)
- **Tests:** E2E-RES-BASE-EMPTY

**Steps to reproduce**

Save baseline on a project with no tasks, then list.

**Expected:** One baseline listed.

**Actual:** {"items":[]}.

**Evidence (from this run)**

- (linked tests passed in this run)

## PF-024 [S3] If-Match is not enforced on PATCH /projects

- **Spec reference:** OAS updateProject (If-Match required), docs/07 §4
- **Status this run:** NOT REPRODUCED (linked tests passed)
- **Tests:** E2E-CONTRACT-IFMATCH-001

**Steps to reproduce**

PATCH without If-Match.

**Expected:** 428/400.

**Actual:** 200.

**Evidence (from this run)**

- (linked tests passed in this run)

## PF-028 [S3] Export format and Accept negotiation ignored

- **Spec reference:** OAS exportProject (format), getPlan (ndjson)
- **Status this run:** REPRODUCED
- **Tests:** E2E-CONTRACT-OP-exportProject-formats, E2E-CONTRACT-OP-getPlan-ndjson

**Steps to reproduce**

GET /export?format=csv; GET /plan with Accept: application/x-ndjson.

**Expected:** CSV / NDJSON; unknown format -> 400.

**Actual:** Always the JSON plan.

**Evidence (from this run)**

- `E2E-CONTRACT-OP-exportProject-formats`: format=csv must return CSV, got content-type application/json body {"format":"planforge-plan/1","project":{"id":"4c9a69a5-4851-4ebb-a369-f637e25596
- `E2E-CONTRACT-OP-getPlan-ndjson`: content-type must be application/x-ndjson
    request:  GET /projects/4c9a69a5-4851-4ebb-a369-f637e2559614/plan
    response: HTTP 200 {"projectId":"4c9a69a5-4851-4ebb-a369-f637e2559614","planVersion":1,"tasks":[{"id":"0e784a03-1e5c-4406-9349-94486ae8599f","parentId":null,"wbs":"1","sortKey":"i","name":"A","durationMin":480,"mode":"AUTO","kind":"FIXED_UNITS","effortDriven":false,"constraint":{"type":"ASAP"},"calendarId":null,"percentComplete":0,"priority":500,"levelingDelayMin":0,"workMin":null,"custom":{},"schedule":{"es":"2026-11-09T08:00:00","ef":"2026-11-09T17:00:00","ls":"2026-11-09T08:00:00","lf":"2026-11-09T17:00:00","totalFloatMin":0,"freeFloatMin":0,"critical":true,"nearCritical":false,"isSummary":false,"state":"OPEN","driver":{"kind":"PROJECT_START"}},"fixedCost":0},{"id":"67738ed6-b699-41b9-86d8-8f6c5c22683f","pa...(2094 chars)

## PF-029 [S3] 405 responses have the wrong body and no Allow header

- **Spec reference:** RFC 9110 15.5.6, docs/07 §5
- **Status this run:** NOT REPRODUCED (linked tests passed)
- **Tests:** E2E-CONTRACT-ERR-003, E2E-CONTRACT-ERR-005

**Steps to reproduce**

GET /projects/{id}/members/{uid}.

**Expected:** 405 + Allow + problem.status 405.

**Actual:** 405 with body status 400 / VALIDATION_FAILED and no Allow header.

**Evidence (from this run)**

- (linked tests passed in this run)

## PF-030 [S3] Typed query parameters are not validated (garbage uuid/date accepted)

- **Spec reference:** OAS parameters (format uuid/date-time/date)
- **Status this run:** NOT REPRODUCED (linked tests passed)
- **Tests:** E2E-CONTRACT-QUERY-001, E2E-RES-LOAD-003

**Steps to reproduce**

GET /audit-events?actorId=not-a-uuid&from=yesterday; GET /resources/{id}/load with from>to, missing from/to, 2026-02-31.

**Expected:** 400 VALIDATION_FAILED.

**Actual:** 200 (filters silently ignored or empty result).

**Evidence (from this run)**

- (linked tests passed in this run)

## PF-031 [S3] Empty request body accepted where the contract requires one

- **Spec reference:** OAS previewSchedule, saveBaseline (requestBody required)
- **Status this run:** REPRODUCED
- **Tests:** E2E-ROBUST-JSON

**Steps to reproduce**

POST /schedule and POST /baselines with an empty body.

**Expected:** 400.

**Actual:** 200 / 201 (a baseline is saved with a defaulted number).

**Evidence (from this run)**

- `E2E-ROBUST-JSON`: 2 bad responses
  + actual - expected
  
  + [
  +   'POST /projects/{p}/schedule body="" -> 200',
  +   'POST /projects/{p}/baselines body="" -> 201'
  + ]
  - []

## PF-033 [S3] A summary task can be critical and nearCritical at the same time

- **Spec reference:** docs/06 §5 (nearCritical means 0 < totalFloat <= threshold)
- **Status this run:** NOT REPRODUCED (linked tests passed)
- **Tests:** E2E-SCHED-RAND-summaries

**Steps to reproduce**

Plan with summaries; read a summary with totalFloatMin 0.

**Expected:** nearCritical false when totalFloatMin = 0.

**Actual:** nearCritical true (rolled up as any(child.nearCritical)) while totalFloatMin 0 and critical true.

**Evidence (from this run)**

- (linked tests passed in this run)

## PF-034 [S3] False MSO_VIOLATED when the pinned date is a non-working instant that maps to the same working position

- **Spec reference:** docs/06 §3.2 MSO
- **Status this run:** NOT REPRODUCED (linked tests passed)
- **Tests:** E2E-SCHED-CON-ALL-ORACLE

**Steps to reproduce**

Task with MSO 2026-11-11T17:00:00 (end of day) after one predecessor.

**Expected:** No conflict: the pinned start (next working minute) is not earlier than the predecessor push.

**Actual:** MSO_VIOLATED reported although the task is exactly where it was pinned (raw wall-clock compare against the normalised start). Dates are right; only the conflict list is wrong.

**Evidence (from this run)**

- (linked tests passed in this run)

## PF-036 [S4] Realtime ticket lives 30 s although docs and OAS say 60 s

- **Spec reference:** OAS createRealtimeTicket, docs/07 §6
- **Status this run:** NOT REPRODUCED (linked tests passed)
- **Tests:** E2E-RT-TICKET-001

**Steps to reproduce**

POST /realtime/tickets and compare expiresAt.

**Expected:** 60 s.

**Actual:** 30 s (documentation and implementation disagree).

**Evidence (from this run)**

- (linked tests passed in this run)

