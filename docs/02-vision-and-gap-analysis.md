# 02 · Vision, Positioning and Gap Analysis

> **Working name:** *PlanForge*. A placeholder — run a trademark search before any external use.

## 1. Vision

> **A scheduling-first project and portfolio platform that behaves like a trustworthy calculator, works like a shared document, and plugs into everything through an API.**

ProjectLibre proves there is demand for an open, MS-Project-class scheduler. Its limits are structural, not cosmetic: single user, desktop only, global singletons, serialized-object files, no tests, no API (doc 01 §4). PlanForge keeps what is valuable — the **scheduling vocabulary and file compatibility** — and rebuilds everything around it.

## 2. What “superior” means (measurable, not rhetorical)

| # | Dimension | ProjectLibre as found | PlanForge target | How we will prove it |
|---|---|---|---|---|
| S1 | **Correctness** | 1 test class repo-wide (D-05); latent EVM defect (D-01) | Every scheduling rule pinned by unit, property and golden-corpus tests; deterministic output | CI gate: engine suite + ≥ 200 corpus plans at 100 % parity on dates/float (doc 13) |
| S2 | **Collaboration** | Single user, local file | Real-time multi-user editing, comments, presence, what-if scenarios | Two-client soak test: 50 concurrent editors, zero lost updates |
| S3 | **Scale** | Not measured; mutable shared graph, UI-thread recalc | 50 k-task plan: full recalc < 1 s (reference engine **0.66 s measured**); edit-to-screen p95 < 100 ms | Benchmark in CI (`engine/bench`), k6 load test in staging |
| S4 | **Openness** | Proprietary `.pod` (Java serialization) | Documented JSON plan format, OpenAPI/AsyncAPI, webhooks, MSPDI/CSV/iCal export | Public schema + conformance tests |
| S5 | **Security** | Deserialization surface, ancient JARs (D-04, D-10) | OIDC SSO, RLS tenant isolation, hash-chained audit, sandboxed formulas, quarantined imports | Threat-model closure (doc 10), pen-test before GA |
| S6 | **Insight** | Gantt, network, EVM | Monte Carlo schedule risk (P50/P80/P90 + criticality index), scenario compare, portfolio roll-up, AI-assisted estimates | Reproducible seeded simulations; model card + drift monitoring (doc 11) |
| S7 | **Experience** | Swing ribbon; Windows/Mac/Linux install | Browser-first, installable PWA, keyboard-first, WCAG 2.1 AA | Axe + manual audit; Core Web Vitals budget (doc 09) |
| S8 | **Operability** | n/a (desktop) | SLOs, error budgets, runbooks, GitOps | SLO dashboards (doc 12) |

## 3. Personas

| Persona | Needs | Key capabilities |
|---|---|---|
| **Scheduler / Project Manager** (primary) | Build and defend a credible schedule; see the critical path; re-plan fast | Gantt, dependencies, constraints, calendars, baselines, what-if, resource levelling |
| **PMO / Portfolio Manager** | Cross-project visibility, capacity, risk | Portfolio roll-ups, resource load across projects, EVM, risk runs |
| **Team Member** | Know my tasks, report progress simply | My-work view, % complete / actual work, comments, mobile-friendly |
| **Executive / Sponsor** | Trustworthy status in 30 seconds | Dashboards, P80 finish date, baseline variance |
| **Resource Manager** | Avoid over-allocation | Load histograms, levelling proposals, availability calendars |
| **Integrator / Platform Admin** | Connect to ERP/ITSM/BI; govern access | REST + webhooks, SSO/SCIM, audit trail, retention |

## 4. Scope

**In scope (R1–R3):** scheduling engine, plan editing, calendars, resources and assignments, baselines, EVM, risk simulation, collaboration, import/export, API, portfolio roll-ups, AI-assisted estimating.
**Out of scope:** time-sheet/payroll, document management, full ITSM, a general-purpose BI tool (we export to one), a native mobile app in R1 (responsive PWA instead).

## 5. Capability gap matrix

Legend — *As found*: ✅ present · ◐ partial/unverified · ❌ absent. *Phase*: R1 = MVP, R2 = collaboration/scale, R3 = portfolio/AI.

| Capability | ProjectLibre (as found) | PlanForge target | Phase |
|---|:--:|---|:--:|
| Task hierarchy / WBS / outline | ✅ | ✅ fractional-index ordering, drag-reorder O(1) | R1 |
| Dependencies FS/SS/FF/SF + lag/lead | ✅ | ✅ identical semantics, cycle path reported | R1 |
| Constraints (8 types) + conflict reporting | ✅ | ✅ explicit `Conflict` codes surfaced in UI/API | R1 |
| Calendars + exceptions + inheritance | ✅ | ✅ time-zone aware, prefix-sum index | R1 |
| Critical path, total/free float | ✅ | ✅ + near-critical threshold & driving-path trace | R1 |
| Fixed units / duration / work, effort-driven | ✅ | ✅ | R1 |
| Baselines (multiple) | ✅ | ✅ immutable, up to 11 | R1 |
| Earned value | ◐ (D-01) | ✅ verified formulas, time-phased | R1 |
| Resource assignment, rates | ✅ | ✅ + rate effective-dating | R1 |
| Resource levelling | ◐ (UI + delay field; algorithm unverified) | ✅ serial leveller within float, dry-run & apply | R2 |
| Gantt / network / RBS / resource views | ✅ Swing | ✅ canvas-virtualised Gantt, network, board, histogram | R1–R2 |
| Undo/redo | ✅ | ✅ inverse commands, per-user | R1 |
| Custom fields / formulas | ✅ (Groovy, D-10) | ✅ typed fields + sandboxed expression language | R2 |
| Import MS Project (MPP/MSPDI) | ✅ via MPXJ | ✅ MSPDI native; MPP via isolated MPXJ service; fidelity report | R1 |
| Import legacy `.pod` | ✅ | ✅ one-way, sandboxed | R2 |
| Multi-user / server | ❌ | ✅ real-time, RBAC, tenancy | R2 |
| REST/Event API, webhooks | ❌ | ✅ | R1 (REST) / R2 (events) |
| What-if scenarios | ❌ | ✅ branch/compare/merge | R2 |
| Monte Carlo schedule risk | ❌ | ✅ | R2 |
| Portfolio roll-up & capacity | ❌ | ✅ | R3 |
| AI duration suggestions, NL → plan draft | ❌ | ✅ human-in-the-loop, explainable | R3 |
| SSO (OIDC), audit trail, data residency | ❌ | ✅ | R1–R2 |
| Accessibility (WCAG 2.1 AA) | ❓ unknown | ✅ | R1 |
| Offline editing | ✅ (desktop) | ✅ PWA queue + sync | R2 |

## 6. Principles that follow from the analysis

1. **The engine is a library, not a feature.** Pure, deterministic, dependency-free; the same code runs in the browser worker, the API server and the risk simulator.
2. **One write path.** All mutations are commands validated by the engine; this gives undo, audit, collaboration and idempotency from one mechanism.
3. **Compatibility is a feature.** Preserve legacy IDs and semantics (doc 01 §3.2) so users can leave MS Project / ProjectLibre without re-learning.
4. **Show your working.** Every date can be explained (driving predecessor, constraint, calendar) — trust is the product.
5. **Secure by default.** Untrusted files are data, never code.
