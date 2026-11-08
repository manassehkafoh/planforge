# 03 · Requirements

Priorities use MoSCoW (**M**ust, **S**hould, **C**ould, **W**on't-now). Phase: R1/R2/R3 (doc 16). Each requirement lists its **verification** so nothing is untestable. “Legacy” links to behaviours B1–B10 in doc 01 §5.

## 1. Functional requirements

### 1.1 Planning
| ID | Requirement | Pri | Ph | Verification | Legacy |
|---|---|:-:|:-:|---|---|
| FR-PL-01 | Create/edit/delete tasks in a hierarchy; summary tasks derive dates, duration and float from children | M | R1 | Engine unit + API contract test | B4 |
| FR-PL-02 | Reorder/indent/outdent tasks without renumbering siblings | M | R1 | Property test on fractional keys | – |
| FR-PL-03 | Dependencies FS/SS/FF/SF with signed lag; reject self-links and cycles, returning the cycle path | M | R1 | Engine test `CYCLE`; API 422 `CYCLE_DETECTED` | B1 |
| FR-PL-04 | Eight constraint types; conflicts are reported (not silently resolved) | M | R1 | Engine tests; UI shows conflict badge | B2 |
| FR-PL-05 | Milestones (zero duration), manual vs auto-scheduled mode | M | R1 | Engine tests | – |
| FR-PL-06 | Task, resource and project calendars with exception days, base-calendar inheritance and time zone | M | R1 | Calendar unit tests; DST test | B6 |
| FR-PL-07 | Fixed units / duration / work and effort-driven option | M | R1 | Table-driven engine tests from doc 06 §6 | B5 |
| FR-PL-08 | Percent complete, actual start/finish; status-date-aware rescheduling of remaining work | S | R2 | Golden corpus | – |
| FR-PL-09 | Critical path, total and free float, near-critical threshold, driving-predecessor trace (“why is this date X?”) | M | R1 | Engine tests; explainability test | B3 |
| FR-PL-10 | Custom fields (typed) and formulas in a sandboxed language | S | R2 | Grammar fuzzing; sandbox escape tests | B10 |
| FR-PL-11 | Task-level notes, attachments (links), labels | S | R2 | API tests | – |

### 1.2 Resources and cost
| ID | Requirement | Pri | Ph | Verification |
|---|---|:-:|:-:|---|
| FR-RS-01 | Resource pool (work, material, cost resources) with max units and calendar | M | R1 | API tests |
| FR-RS-02 | Assignments with units/work; task-type recalculation (fixed units/duration/work) | M | R1 | Table-driven tests |
| FR-RS-03 | Effective-dated rate tables (standard, overtime, per-use) | M | R1 | Unit tests with rate changes mid-task |
| FR-RS-04 | Over-allocation detection and daily load histograms across projects | M | R2 | Property test: Σ assignment load = histogram |
| FR-RS-05 | Resource levelling within float, dry-run and apply, deterministic tie-breaks | S | R2 | Golden corpus; determinism test |
| FR-RS-06 | Time-phased planned/actual work and cost | M | R1 | Reconciliation test (Σ phases = totals) |

### 1.3 Control and analytics
| ID | Requirement | Pri | Ph | Verification |
|---|---|:-:|:-:|---|
| FR-CT-01 | Up to 11 immutable baselines; variance columns | M | R1 | Immutability test |
| FR-CT-02 | Earned value: PV, EV (=% complete × BAC), AC, SV, CV, SPI, CPI, EAC (3 methods), ETC, VAC, TCPI; explicit null on divide-by-zero | M | R1 | `engine.test.ts` EVM test |
| FR-CT-03 | What-if scenarios: branch from a plan version, compare finish/cost/critical path, promote or discard | S | R2 | E2E |
| FR-CT-04 | Monte Carlo schedule risk (3-point estimates): P50/P80/P90 finish and criticality index; seeded and reproducible | S | R2 | Reproducibility test |
| FR-CT-05 | Portfolio roll-up: schedule/cost/risk RAG, capacity vs demand | S | R3 | Analytics reconciliation |
| FR-CT-06 | AI-assisted duration suggestions and natural-language plan drafts, always as *proposals* needing user acceptance | C | R3 | Model card gates (doc 11) |

### 1.4 Collaboration and integration
| ID | Requirement | Pri | Ph | Verification |
|---|---|:-:|:-:|---|
| FR-CO-01 | Real-time multi-user editing with presence; no lost updates | M | R2 | Soak/chaos test |
| FR-CO-02 | Comments, @mentions, activity feed, notifications | S | R2 | E2E |
| FR-CO-03 | Per-user undo/redo that does not undo other users' work | M | R2 | Property test on inverse commands |
| FR-CO-04 | Offline edit queue with deterministic reconciliation on reconnect | S | R2 | Network-partition test |
| FR-IN-01 | Import MSPDI XML, CSV; MPP via isolated converter; legacy `.pod` one-way; each import yields a **fidelity report** | M | R1 | Golden corpus (doc 13) |
| FR-IN-02 | Export: native `.plan`, MSPDI, CSV, iCal, PDF | M | R1 | Round-trip tests |
| FR-IN-03 | REST API with OpenAPI 3.0; webhooks and event stream | M | R1/R2 | Contract tests (Schemathesis) |
| FR-IN-04 | SSO via OIDC; SCIM user provisioning | M | R1/R2 | IdP integration test |

### 1.5 Governance
| ID | Requirement | Pri | Ph | Verification |
|---|---|:-:|:-:|---|
| FR-GV-01 | Role-based access (6 roles) with project-level membership; field-level cost visibility | M | R1 | AuthZ matrix test (doc 10) |
| FR-GV-02 | Immutable, hash-chained audit trail for every plan mutation and admin action | M | R1 | Tamper test |
| FR-GV-03 | Data residency (tenant region), retention policies, export & erase on request | S | R2 | Policy test |

## 2. Non-functional requirements

| ID | Quality | Requirement (measurable) | Measured how |
|---|---|---|---|
| NFR-PERF-01 | Engine throughput | Full CPM on **50 k tasks / 100 k links < 1 s** server-side; **10 k tasks < 250 ms** in browser worker | `engine/bench` in CI (reference: 663 ms / 143 ms on build host) |
| NFR-PERF-02 | Edit latency | p95 command round-trip (client → commit → ack) **< 300 ms** for ≤ 10 k-task plans; local optimistic render **< 50 ms** | Synthetic probe + RUM |
| NFR-PERF-03 | Incremental recalc | Single-task edit on 50 k plan **< 50 ms** p95 (doc 06 §7) | Benchmark |
| NFR-PERF-04 | UI | LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1; Gantt scroll ≥ 55 fps at 50 k rows | Lighthouse CI, RUM |
| NFR-AVAIL-01 | Availability | API 99.9 % monthly (≈ 43 min budget); realtime gateway 99.5 % | SLO burn-rate alerts |
| NFR-DUR-01 | Durability | RPO ≤ 5 min, RTO ≤ 1 h (regional); PITR 35 days | DR drill each quarter |
| NFR-SEC-01 | AuthN/Z | OIDC + PKCE; least-privilege RBAC; tenant isolation by RLS | Pen test; RLS tests |
| NFR-SEC-02 | Data protection | TLS 1.2+ in transit, AES-256 at rest, secrets only in a managed vault, no secrets in config/images | IaC scan |
| NFR-SEC-03 | Safe parsing | Untrusted files parsed only in a sandboxed worker with CPU/mem/time limits; no native deserialization | Fuzzing, import-bomb tests |
| NFR-ACC-01 | Accessibility | WCAG 2.1 AA; whole app keyboard operable | axe-core CI + manual audit |
| NFR-SCAL-01 | Scale | 10 k tenants, 5 k concurrent editors, plans to 100 k tasks | Load test |
| NFR-OBS-01 | Observability | Traces, metrics, structured logs with `traceId` on every error response | Synthetic checks |
| NFR-I18N-01 | Localisation | UTF-8 everywhere, ICU formatting, RTL-ready layout, locale-aware week start | Pseudo-locale test |
| NFR-MAINT-01 | Maintainability | Engine package has zero runtime dependencies; ≥ 90 % branch coverage on engine; mutation score ≥ 70 % | CI |
| NFR-COMP-01 | Compatibility | ≥ 98 % of date/float values equal to the MS-Project-compatible reference on the golden corpus; every deviation documented | Corpus report |

## 3. Constraints and assumptions
* **C-1** Legal: clean-room implementation (ADR-001). No legacy code is linked.
* **C-2** Scheduling dates are *calendar arithmetic*; the product does not claim to replicate undocumented behaviours of any proprietary product. Deviations are catalogued (doc 13 §4).
* **A-1** Target plan size for the design is ≤ 100 k tasks per project; beyond that, programme structures (sub-projects) apply.
* **A-2** The first deployment target is Kubernetes on any major cloud; cloud-specific services are used only behind adapters (ADR-003).

## 4. Key use cases (summary)

| UC | Title | Actor | Main flow |
|---|---|---|---|
| UC-01 | Build a schedule | Scheduler | Create tasks → indent to make summaries → link → set calendars → view critical path |
| UC-02 | Re-plan after slip | Scheduler | Change duration/constraint → instantly see finish move and which tasks became critical → save as scenario or apply |
| UC-03 | Baseline and track | PM | Save baseline 0 → team reports % complete → EVM and variance update |
| UC-04 | Resolve over-allocation | Resource Manager | Open load histogram → run levelling dry-run → apply delays |
| UC-05 | Quantify risk | PM | Enter three-point estimates → run 5 000-iteration simulation → report P80 date |
| UC-06 | Migrate from MS Project | PM | Upload MPP/MSPDI → review fidelity report → fix flagged items |
| UC-07 | Integrate | Integrator | Register webhook → receive `plan.changed.v1` → update ERP |
| UC-08 | Audit | Auditor | Query audit trail by actor/date → verify hash chain |
