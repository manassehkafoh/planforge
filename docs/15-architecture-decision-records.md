# 15 · Architecture Decision Records

Format: *Context → Decision → Alternatives → Consequences*. Status **Proposed** means the decision is recommended by this design pack and awaits sign-off by the architecture authority; none has been ratified.

---
## ADR-001 · Clean-room re-implementation instead of forking ProjectLibre
**Status:** Proposed · **Drivers:** legal, security, architecture
* **Context.** The code is CPAL-1.0 licensed with mandatory attribution and a dual EULA (D-13); it is Java 1.5-era, singleton-ridden, single-user, with Java-serialization files (D-02–D-04) and one test class (D-05).
* **Decision.** Specify behaviour from the published CPM method and observable vocabulary; implement new code with an implementer team that has not read legacy source (doc 01 §7). Reuse of libraries only through their public releases (MPXJ as an isolated converter).
* **Alternatives.** (a) Fork and modernise — keeps attribution/licence obligations on every file, inherits the architecture; (b) Wrap the legacy engine as a service — inherits global state, can't be incremental/parallel; (c) Buy/integrate a commercial engine — recurring cost, no control.
* **Consequences.** + Free choice of licence and architecture; + testable engine. − Re-implementation effort; − must prove parity (golden corpus, doc 13). **Legal review required before build.**

## ADR-002 · One TypeScript engine, run in browser and server
**Status:** Proposed
* **Context.** Instant what-if feedback needs the engine on the client; authority needs it on the server; Monte Carlo needs it in workers. Two implementations would diverge.
* **Decision.** A dependency-free TypeScript package (`engine/`), pure functions, deterministic.
* **Alternatives.** JVM engine + remote calls (latency on every keystroke); Rust→WASM (fastest, more build complexity — kept as an optimisation if benchmarks demand).
* **Consequences.** + Identical results everywhere, continuous client-vs-server consistency check. − JS number/time pitfalls (mitigated by integer minutes and naive-local instants); − a JVM shop would port rather than reuse (the test suite and corpus make a port verifiable).

## ADR-003 · Modular monolith first
**Status:** Proposed
* **Context.** Plan edits must atomically update data, op log, outbox and audit; team is small.
* **Decision.** One deployable "core" with enforced module boundaries (dependency-cruiser), plus separate async workers where isolation/scaling differ (risk, import, notify, analytics).
* **Alternatives.** Microservices from day one (distributed transactions, operational cost with no scaling benefit yet).
* **Consequences.** + Simple ACID commit, easy refactoring. − Must police boundaries; extraction criteria defined: a module is extracted only if it has independent scaling, failure-isolation or team-ownership need *and* its contract has been stable for two releases.

## ADR-004 · PostgreSQL as system of record, RLS for tenancy
**Status:** Proposed (schema executed and RLS/audit behaviours tested)
* **Decision.** PostgreSQL 16; `tenant_id` + forced RLS on every tenant table; JSONB for custom fields; hash-partitioned time-phase table; transactional outbox.
* **Alternatives.** Database-per-tenant (isolation strong, ops heavy at 10 k tenants — offered as an option for large/regulated tenants), schema-per-tenant, NoSQL document store (weak constraints for graph invariants).
* **Consequences.** + Isolation enforced below the application; + rich constraints. − RLS needs discipline (`SET LOCAL` per transaction; migrations role separate); − connection pooling must be transaction-mode aware.

## ADR-005 · Server-sequenced command log; CRDT only for text
**Status:** Proposed
* **Context.** Plans carry global invariants (acyclic, calendar-derived dates).
* **Decision.** Writes are atomic command batches validated by the engine and sequenced per project; optimistic clients; rebase only when batches *commute*; otherwise `409`. CRDT/OT is limited to comment/notes text.
* **Alternatives.** Full CRDT (can merge into a cycle with no safe repair), last-writer-wins on rows (silently loses scheduling intent), pessimistic locks (poor UX).
* **Consequences.** + Invariants always hold; + audit/undo/replay for free. − Server round-trip for authoritative state (hidden by optimistic UI); − single writer per plan (acceptable; see doc 05 §3).

## ADR-006 · REST (OpenAPI 3.0) + WebSocket broadcast; no GraphQL/gRPC externally
**Status:** Proposed
* **Decision.** REST for reads/commands, WebSocket for broadcast only; gRPC may be used internally between core and workers. OpenAPI 3.0.3 chosen (not 3.1) for widest tooling support today.
* **Alternatives.** GraphQL (flexible reads but complicates caching, authz per field and rate limiting for a command-centric domain); gRPC-web (smaller tooling surface for integrators).
* **Consequences.** + Cacheable, integrator-friendly, contract-testable. − Over-fetching on some reads mitigated by `include`/NDJSON.

## ADR-007 · Untrusted-file pipeline: quarantine → sandbox → commands
**Status:** Proposed
* **Decision.** Direct-to-object-storage upload; sandboxed, network-less workers; parsers emit a canonical model mapped to commands; no Java/native deserialization in the main system; MPXJ isolated in its own container.
* **Alternatives.** Parse in the API process (a parser bug becomes an API compromise); convert client-side only (can't guarantee fidelity or security of the output).
* **Consequences.** + Contains parser CVEs. − Latency (async job) and an extra component to operate.

## ADR-008 · OIDC SSO, RBAC with project membership, deny-by-default
**Status:** Proposed
* **Decision.** No local passwords; PKCE for SPA; six roles; checks in the application layer per command; field-level cost visibility; scopes necessary-not-sufficient.
* **Alternatives.** Policy engines (OpenFGA/Cedar) — attractive for relationship-based sharing later (R3), not needed for six fixed roles.

## ADR-009 · Kubernetes-first packaging, Helm, GitOps; cloud adapters
**Status:** Proposed
* **Decision.** OCI images + Helm; Argo CD; Terraform; cloud-specific services only behind adapters so self-hosted customers get the same chart with bundled Postgres/Redis.
* **Consequences.** + Portable, auditable deploys. − Lowest-common-denominator on a few cloud features.

## ADR-010 · Canvas-rendered, virtualised Gantt with an accessible treegrid mirror
**Status:** Proposed
* **Decision.** Canvas for bars/links; ARIA treegrid carries all semantics and keyboard operation; canvas is `aria-hidden`.
* **Alternatives.** DOM/SVG bars (do not scale to 50 k rows); canvas only (inaccessible).
* **Consequences.** + 60 fps at scale and WCAG AA. − Two rendering paths to keep in sync (single row model mitigates).

## ADR-011 · Licensing model for the new product
**Status:** **Open — business decision.**
* **Options.** (1) Proprietary SaaS + self-host licence; (2) Open-core: engine and file-format libraries under Apache-2.0, platform proprietary; (3) AGPL platform with commercial licence for embedding.
* **Recommendation.** Option 2: a permissively licensed engine builds trust (“show your working”) and an ecosystem of integrations while the collaboration/enterprise layer funds the product. *Requires counsel's input on interaction with any third-party components.*

## ADR-012 · AI features are advisory, opt-in and human-approved
**Status:** Proposed
* **Decision.** AI output is always a *proposal* (suggested estimate, draft commands as a diff); the engine validates; tenants opt in; models pass a governance gate with a model card; no tools/network for LLMs.
* **Consequences.** + Contains prompt-injection and automation-bias risk. − Slower "magic" demos; intentional.

## ADR-013 · Third-party dependency policy (answers D-07)
**Status:** Proposed
* **Decision.** Libraries are consumed as versioned packages from registries, never vendored into first-party trees; licence allow-list (MIT, BSD, Apache-2.0, ISC; LGPL only in isolated containers; no GPL/AGPL in distributed core); SBOM per build; automated update PRs weekly; critical CVEs patched within 7 days.
