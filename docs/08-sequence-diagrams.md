# 08 · Sequence Diagrams (request → domain → infrastructure)

Seven runtime scenarios. Participants map to the components in doc 04 §4. Each diagram is followed by *what to notice*.

## SD-1 · Edit a task duration (the hot path)

```mermaid
%% name: sd1-edit-duration
sequenceDiagram
  autonumber
  actor U as Scheduler
  participant SPA as SPA store
  participant WW as Worker engine
  participant API as REST API
  participant APP as ApplyCommands
  participant DOM as Plan aggregate
  participant ENG as Engine
  participant DB as PostgreSQL
  participant R as Redis pub/sub
  participant P as Peer clients
  U->>SPA: edit Duration cell to 5d
  SPA->>WW: optimistic apply updateTask
  WW-->>SPA: new dates and float in under 50 ms
  SPA-->>U: Gantt repaints immediately (pending badge)
  SPA->>API: POST /commands {clientOpId, expectedPlanVersion, updateTask}
  API->>API: validate JWT, scope plan.write, schema
  API->>APP: handle(batch, user, tenant)
  APP->>DB: BEGIN, SET LOCAL tenant, SELECT project FOR UPDATE
  APP->>DB: find clientOpId in plan_op
  alt clientOpId already applied
    DB-->>APP: stored result
    APP-->>API: replay stored result
  else new operation
    APP->>DB: load tasks, links, assignments (3 set-based queries)
    APP->>DOM: apply(commands)
    DOM->>ENG: schedule(plan)
    ENG-->>DOM: ScheduleResult
    DOM-->>APP: diff plus domain events
    APP->>DB: write diff, plan_op, outbox, audit_event, plan_version+1
    APP->>DB: COMMIT
    APP->>R: publish plan.changed and schedule.delta
  end
  APP-->>API: {planVersion, schedule, changedTaskIds}
  API-->>SPA: 200
  SPA->>SPA: reconcile - compare server dates with local result
  R-->>P: plan.changed
  P->>P: apply commands, rerun local engine
```

**Notice.** (1) The user never waits for the network: the worker engine answers first. (2) The server result is authoritative; comparing it with the optimistic one is a **continuous consistency check** between the two engine hosts. (3) Everything that must be atomic — data, op log, outbox, audit — is in one `COMMIT`; the Redis publish is best-effort *after* commit.

## SD-2 · Add a link that would create a cycle

```mermaid
%% name: sd2-cycle-rejected
sequenceDiagram
  autonumber
  actor U as Scheduler
  participant SPA as SPA
  participant WW as Worker engine
  participant API as REST API
  participant APP as ApplyCommands
  participant ENG as Engine
  participant DB as PostgreSQL
  U->>SPA: drag link from C to A
  SPA->>WW: optimistic addLink
  WW-->>SPA: ScheduleError CYCLE path A,B,C,A
  SPA-->>U: link rejected inline, cycle highlighted, no request sent
  Note over SPA,WW: Client engine catches it first. The server still re-checks - never trust the client.
  U->>API: (stale or malicious client) POST /commands addLink C to A
  API->>APP: handle
  APP->>DB: BEGIN, lock project
  APP->>ENG: schedule(plan with link)
  ENG-->>APP: throws CYCLE
  APP->>DB: ROLLBACK
  APP-->>API: ScheduleError CYCLE
  API-->>U: 422 problem+json code CYCLE_DETECTED with cycle path
```

**Notice.** Rejection costs no write and leaves `planVersion` unchanged. The cycle path in the response lets any client highlight the offending chain.

## SD-3 · Import an MS-Project file (asynchronous, quarantined)

```mermaid
%% name: sd3-import
sequenceDiagram
  autonumber
  actor U as PM
  participant SPA as SPA
  participant API as REST API
  participant OBJ as Object storage (quarantine)
  participant BUS as Event bus
  participant IMP as Import worker (sandbox)
  participant AV as Malware scan
  participant APP as ApplyCommands
  participant DB as PostgreSQL
  U->>SPA: choose plan.mpp
  SPA->>API: POST /imports {format MPP, fileName}
  API->>DB: insert import_job QUEUED
  API-->>SPA: 202 {job, presigned uploadUrl}
  SPA->>OBJ: PUT file (direct, size capped)
  OBJ->>BUS: object-created
  BUS->>IMP: start job
  IMP->>AV: scan
  AV-->>IMP: clean
  IMP->>IMP: parse in sandbox (CPU, memory, time limits, no network)
  IMP->>IMP: map to commands plus fidelity report
  IMP->>APP: ApplyCommands as importing user (new project)
  APP->>DB: commit plan, import_job SUCCEEDED, report
  APP->>BUS: import.completed
  SPA->>API: GET /imports/{jobId} (or push)
  API-->>SPA: report - mapped, approximated, dropped
  SPA-->>U: show fidelity report, open project
```

**Notice.** The API tier never parses the file. The importer runs with no network, read-only root filesystem, 1 CPU/1 GB, 60 s limit, and produces **commands** — the same validated write path as the UI, so an imported plan cannot violate invariants.

## SD-4 · Save a baseline and compute EVM

```mermaid
%% name: sd4-baseline-evm
sequenceDiagram
  autonumber
  actor U as PM
  participant API as REST API
  participant BSL as BaselineService
  participant DB as PostgreSQL
  participant EVS as EvmService
  participant ENG as Engine evm()
  U->>API: POST /baselines {number 0}
  API->>BSL: save(projectId, 0)
  BSL->>DB: BEGIN, lock project, check baseline 0 absent
  BSL->>DB: INSERT baseline, INSERT baseline_task SELECT FROM task
  BSL->>DB: outbox baseline.saved, audit_event
  BSL->>DB: COMMIT
  API-->>U: 201
  Note over U,DB: weeks later, progress is reported
  U->>API: GET /evm?statusDate=2026-12-04
  API->>EVS: compute
  EVS->>DB: aggregate timephase to status date (PV from baseline, AC actual)
  DB-->>EVS: bac, pv, ac, percent complete per task
  EVS->>ENG: evm(bac, pv, ev = pct x bac, ac)
  ENG-->>EVS: sv, cv, spi, cpi, eac, vac, tcpi (null on divide by zero)
  EVS-->>API: Evm
  API-->>U: 200
```

**Notice.** Baselines are a set-based `INSERT … SELECT` — O(1) round trips regardless of plan size. EV is derived from percent complete × BAC, **never** from actual cost.

## SD-5 · Monte Carlo risk run

```mermaid
%% name: sd5-risk-run
sequenceDiagram
  autonumber
  actor U as PM
  participant API as REST API
  participant DB as PostgreSQL
  participant BUS as Event bus
  participant W as Risk workers (N)
  participant ENG as Engine
  participant RT as Realtime gateway
  U->>API: POST /risk-runs {iterations 5000, seed}
  API->>DB: insert risk_run QUEUED with planVersion
  API-->>U: 202 Location /risk-runs/id
  API->>BUS: risk.requested
  BUS->>W: shard 1..N (iterations / N each)
  loop each iteration in shard
    W->>ENG: schedule(sampled durations)
    ENG-->>W: finish, critical set
  end
  W->>DB: write shard results
  W->>DB: last shard merges, computes P50 P80 P90 and criticality, SUCCEEDED
  W->>BUS: risk.completed
  BUS->>RT: notify project subscribers
  RT-->>U: risk.completed push
  U->>API: GET /risk-runs/id
  API-->>U: percentiles and criticality index
```

**Notice.** Pinning the run to a `planVersion` + `seed` makes it reproducible and auditable. Per-tenant concurrency limits (bulkhead) stop one tenant starving others.

## SD-6 · Sign-in and WebSocket ticket (OIDC + PKCE)

```mermaid
%% name: sd6-auth
sequenceDiagram
  autonumber
  actor U as User
  participant SPA as SPA
  participant IDP as OIDC IdP
  participant GW as API gateway
  participant API as REST API
  participant RT as Realtime gateway
  U->>SPA: open app
  SPA->>IDP: authorization request (code, PKCE S256, state, nonce)
  IDP-->>U: login and MFA
  IDP-->>SPA: authorization code
  SPA->>IDP: token request with code_verifier
  IDP-->>SPA: access token (short-lived), refresh token (rotating)
  SPA->>GW: GET /projects (Bearer)
  GW->>GW: verify signature via cached JWKS, aud, exp, tenant claim
  GW->>API: forward with identity headers
  API->>API: map sub to app_user, membership and role check
  API-->>SPA: 200
  SPA->>API: POST /realtime/tickets {projectId}
  API-->>SPA: ticket (60 s, single use)
  SPA->>RT: WSS connect with ticket
  RT->>API: redeem ticket (atomic delete in Redis)
  API-->>RT: user, tenant, project, role
  RT-->>SPA: hello {lastSeq}
```

**Notice.** Tokens are kept in memory (not localStorage) and renewed with rotating refresh tokens; the WebSocket never sees a bearer token in a URL.

## SD-7 · Offline edit and reconnect

```mermaid
%% name: sd7-offline-sync
sequenceDiagram
  autonumber
  actor U as Scheduler
  participant SPA as SPA
  participant IDB as IndexedDB queue
  participant API as REST API
  participant APP as ApplyCommands
  U->>SPA: edits while offline
  SPA->>IDB: append command batches with clientOpIds and base version v
  Note over SPA: UI shows Offline - changes queued
  SPA->>SPA: connectivity restored
  SPA->>API: GET /plan (ETag v+k)
  API-->>SPA: plan at v+k
  SPA->>SPA: rebase queued batches onto v+k (commute test)
  loop each queued batch in order
    SPA->>API: POST /commands {clientOpId, expectedPlanVersion}
    API->>APP: handle
    alt applied or replayed
      APP-->>SPA: 200
    else VERSION_CONFLICT or CYCLE_DETECTED
      APP-->>SPA: 409 or 422
      SPA->>U: conflict dialog - keep mine, take theirs, edit
    end
  end
```

**Notice.** `clientOpId` makes replay safe if the connection drops mid-request. A batch that no longer applies is never silently dropped — it is surfaced for a decision.
