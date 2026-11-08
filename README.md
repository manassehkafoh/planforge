# PlanForge - Reverse-Engineering and Solution-Design Pack

*Working name for a clean-room, web-first successor to **ProjectLibre** (`github.com/smartqubit/projectlibre`).*
Prepared 2026-11-08. Method: reverse-engineer-anything style — observe → specify → verify — then design the superior product.

## What this is
A complete design pack: an evidence-based analysis of ProjectLibre, a vision and requirements for a better product, the full solution architecture, and a **working, tested reference implementation of the scheduling engine** and **an executed database schema** to de-risk the hardest parts.

## Reading order
| # | Document | Read it for |
|---|---|---|
| 01 | `docs/01-reverse-engineering-report.md` | What ProjectLibre is, how its engine works, 13 evidenced defects, legal/clean-room protocol |
| 02 | `docs/02-vision-and-gap-analysis.md` | What “superior” means (8 measurable dimensions), personas, capability gap matrix |
| 03 | `docs/03-requirements.md` | Functional (MoSCoW, verification) and non-functional requirements with numeric targets |
| 04 | `docs/04-architecture.md` | C4 context/containers/components, deployment, stack, caching, resilience, SLAs |
| 05 | `docs/05-domain-and-data-model.md` | Bounded contexts, aggregates, invariants, ERD, table-by-table notes, RLS |
| 06 | `docs/06-scheduling-engine-design.md` | Algorithms, time model, constraints, incremental design, EVM, Monte Carlo, measured benchmarks |
| 07 | `docs/07-api-and-events.md` | API rules, command model, concurrency, **error taxonomy**, realtime, webhooks |
| 08 | `docs/08-sequence-diagrams.md` | 7 request → domain → infrastructure sequences |
| 09 | `docs/09-frontend-design.md` | Component hierarchy, state machines, performance budget, WCAG 2.1 AA, test pyramid |
| 10 | `docs/10-security-and-threat-model.md` | DFD, STRIDE (20 threats), RBAC matrix, hardened import pipeline |
| 11 | `docs/11-data-analytics-and-ai.md` | Medallion pipelines, DQ, lineage; AI/MLOps with model card, feature store, drift |
| 12 | `docs/12-platform-and-operations.md` | Kubernetes/GitOps, CI/CD, SLOs, chaos, FinOps, runbooks |
| 13 | `docs/13-migration-compatibility-and-testing.md` | Importers, fidelity report, golden corpus, deviation catalogue, test strategy |
| 14 | `docs/14-legacy-traceability.md` | Legacy component → new component matrix |
| 15 | `docs/15-architecture-decision-records.md` | 13 ADRs |
| 16 | `docs/16-roadmap-and-risks.md` | Phases, team, 13 risks, open decisions, first 30 days |

## Machine-readable artefacts
| Path | Content | Verified how |
|---|---|---|
| `api/openapi.yaml` | OpenAPI 3.0.3, 22 paths / 29 operations / 32 schemas | `openapi-spec-validator` → valid |
| `api/asyncapi.yaml` | AsyncAPI 2.6 realtime + event contracts | Official `@asyncapi/parser` → 0 errors |
| `db/schema.sql` | PostgreSQL 16 DDL, 28 tables, forced RLS, audit immutability, outbox | **Executed** on PostgreSQL 16; RLS isolation, cross-tenant insert rejection and audit append-only behaviour tested |
| `engine/` | Reference scheduling engine (TypeScript, ~520 LOC, zero deps) + tests + benchmark | `npm test` → 14/14 pass incl. 300-graph property test; benchmark 50 k tasks in 0.66 s |
| `docs/diagrams/*.mmd, *.svg` | All 28 diagrams as Mermaid source + rendered SVG | `tools/render-diagrams.py` renders every block |
| `platform/*.yaml`, `.github/workflows/ci.yml` | SLOs, Kyverno policies, NetworkPolicies, CI pipeline | Parse as valid YAML (not executed in a live cluster / GitHub) |
| `tools/measure-legacy.sh` | Reproduces every inventory number in doc 01 | Run against the clone |

## Reproduce
```bash
# engine tests and benchmark (Node >= 22.18)
cd engine && npm test && npm run bench
# diagrams (needs mermaid-cli)       # legacy metrics
python3 tools/render-diagrams.py      tools/measure-legacy.sh /path/to/projectlibre
# schema
psql -v ON_ERROR_STOP=1 -f db/schema.sql
```

## Headline findings
1. ProjectLibre is a ~175 k-LOC (first-party) single-user Swing application; a further ~300 k LOC is **vendored third-party code** (MPXJ, Flamingo, Batik).
2. Its scheduling core is a conventional CPM engine (forward/backward pass, sentinel tasks, event-driven invalidation) wrapped in global singletons, with **one test class in the entire repository**.
3. Files are **Java-serialized** (`.pod`), the licence (CPAL 1.0) carries attribution obligations — hence a **clean-room** rebuild (ADR-001) rather than a fork.
4. A latent EVM defect exists (`bcwp()` returns actual cost; no callers found for that overload).
5. The new design: one pure TypeScript engine shared by browser and server; server-sequenced command log; PostgreSQL with RLS; sandboxed imports; real-time collaboration; Monte Carlo risk; advisory AI.

## Honest limits
* **Static analysis only** — ProjectLibre was not compiled or run. About 15 % of first-party code was read closely; the rest was inventoried.
* The engine (≈ 1 700 lines, 36 tests) implements CPM, calendars with inheritance, 8 constraints, manual mode, status date, resource rules, timephased cost, serial levelling, incremental recomputation, EVM, Monte Carlo and a sandboxed formula language. It is checked against an independent brute-force oracle and a full-vs-incremental differential test. **Not modelled:** overtime, task splits, sub-project links, cross-project levelling (see `docs/17-gap-closure-register.md`).
* **Incremental recomputation:** single-task edit on 50 k tasks p50 ≈ 1 ms, p95 ≈ 1.4 ms — *for edits that do not move the project finish*. An edit that moves the finish needs a full backward pass.
* The server (`server/`) is a single-instance reference: auth, RBAC, RLS-backed tenancy, idempotent command path, hash-chained audit, realtime. Imports and webhooks return 501. It has a smoke test, not load or penetration testing.
* Golden-corpus parity (the real proof of compatibility) has **not** been measured — the corpus does not exist yet. Mutation testing has not been run.
* Estimates in doc 16 and capacity figures in doc 04 are planning assumptions, not measurements.
* Competitive statements are limited to public, general capabilities and were not benchmarked.
* The working name is unsearched; the licence model (ADR-011) and clean-room protocol need **legal review before any build**. This pack is engineering analysis, not legal advice.
