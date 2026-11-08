# 06 · Scheduling Engine Design

The engine is the product's heart and the part of ProjectLibre worth re-specifying carefully (doc 01 §3.2). A **reference implementation** lives in `engine/` (≈ 1 700 lines of TypeScript, zero runtime dependencies). v0.2 implements everything in this document except the items listed in §11 as consciously deferred.

**Verified state of the reference engine (v0.2):** 36 tests pass in ≈ 5 s — calendar arithmetic and inheritance; all four relationship types, lead/lag and lag calendar basis; 8 constraints, ALAP, milestones, summary roll-up; manual mode; status date / percent complete / completed tasks; explainability; near-critical; resource rules; timephased cost and planned value; serial levelling; the sandboxed formula language; the DST edge adapter; and three oracles: (1) a property test over 300 random DAGs, (2) an **independent brute-force oracle** (separate algorithm, integer working-minute axis, fix-point relaxation) that the engine matches on 400 random networks for dates *and* total float, and (3) a **full-vs-incremental oracle** (150 random edit sequences × 25 edits, deep-equal after every edit). The oracles caught real defects in earlier drafts (missing project-finish cap on tasks with successors; minute-granular backtracking producing 16:59 starts; a levelling livelock where a predecessor of the contending task was delayed forever) — evidence for investing in this style of test.

## 1. Contract

```
schedule(project: ProjectIn) -> ScheduleResult        // pure, synchronous, deterministic
```
* **Input**: start date, optional deadline, calendars, tasks (durations in working minutes, optional parent, constraint, calendar), links (type, signed lag).
* **Output**: per-task `es, ef, ls, lf, totalFloat, freeFloat, critical`, project `start/finish`, ordered `criticalPath`, and `conflicts[]`.
* **Errors** (`ScheduleError`): `CYCLE` (with the cycle path), `UNKNOWN_TASK`, `LINK_TO_SUMMARY`, `DUPLICATE_ID`, `BAD_INPUT`.
* **Determinism**: no clock, no randomness (Monte Carlo takes a seed), no I/O, no iteration over hash order for results. Same input ⇒ byte-identical output across browser, Node and CI.

## 2. Time model

| Decision | Detail | Why |
|---|---|---|
| **Wall-clock “naive local” instants** | Instants are epoch-ms *interpreted in the project time zone*. Conversion to UTC happens only at the API edge using the IANA zone. | Working-time rules (08:00–17:00) are expressed in local time; doing arithmetic in UTC makes DST days wrong. |
| **Integer minutes** | Durations/lags/work are integers (minutes). | No floating-point drift; exact equality in tests. |
| **End-instant convention** | A task's `finish` is the instant its last working minute ends (Fri 17:00), not the last minute itself. | FS successor start = `nextWorkStart(finish)` reads naturally and zero-duration milestones can sit on a range boundary. |
| **Working-time axis** | Fri 17:00 and the following Mon 08:00 are the *same point* on the working-time axis. | Float and “latest start” must be computed on this axis; wall-clock comparisons produced bugs found by the property test. When float = 0 the engine canonicalises late dates to the early dates. |
| **DST** | Local gaps/overlaps are resolved at the edge: a non-existent local time moves to the next valid minute; ambiguous times pick the first occurrence. Working ranges are minutes-from-midnight, so a 23-hour day simply has less calendar time, not less defined work. | Documented, tested edge. *(DST test cases are listed in doc 13 corpus; the reference engine treats all instants as naive and is DST-agnostic by construction.)* |

### Calendar operations (`WorkCalendar`)
| Op | Meaning | Complexity |
|---|---|---|
| `nextWorkStart(t)` | earliest working instant ≥ t | O(days scanned) |
| `prevWorkEnd(t)` | latest working-range end/inside instant ≤ t | O(days scanned) |
| `addWork(from, m)` / `subWork(from, m)` | walk `m` working minutes forward/back | O(days spanned) |
| `workBetween(a, b)` | signed working minutes | **O(1) amortised** via per-day prefix sums |
| `shift(t, ±m)` | lag/lead application | as add/sub |
| `latestStartAtOrBefore(t)` | `nextWorkStart(prevWorkEnd(t))` — latest valid start on the working-time axis | – |

Optimisation evidence: replacing the day-by-day `workBetween` with the prefix-sum index cut the 50 k-task benchmark from **10.9 s to 0.66 s** (16×), because float calculations spanned years.

## 3. Algorithm — CPM over a precedence diagram

```text
validate(input)                       # ids unique, refs exist, no link touches a summary
leaves  = tasks without children
order   = topologicalOrder(leaves, links)    # Kahn; on failure -> CYCLE with path via DFS

# FORWARD PASS (early dates)
for t in order:
    start = projectStart
    for each pred link (p, type, lag):
        FS: start = max(start, shift(p.EF, lag))
        SS: start = max(start, shift(p.ES, lag))
        FF: reqFinish = max(reqFinish, shift(p.EF, lag))
        SF: reqFinish = max(reqFinish, shift(p.ES, lag))
    constraints: SNET/MSO -> start = max(start, date) ; FNET/MFO -> reqFinish = max(reqFinish, date)
    if reqFinish: start = max(start, subWork(prevWorkEnd(reqFinish), duration))
    start  = snap(start)                       # next working start (milestones may sit on a range end)
    MSO: report MSO_VIOLATED if start > date ; start = date          # hard constraint wins, conflict reported
    finish = addWork(start, duration)
    MFO: report MFO_VIOLATED if finish > date ; finish = date, start = subWork(finish, duration)
    SNLT / FNLT: report *_VIOLATED if exceeded (soft)
projectFinish = max(EF) ; limit = min(projectFinish, deadline?)

# BACKWARD PASS (late dates)
for t in reverse(order):
    capFinish = limit                          # every task is bounded by the project end (bug fix: not only terminal tasks)
    for each succ link (s, type, lag):
        FS: capFinish = min(capFinish, prevWorkEnd(shift(s.LS, -lag)))
        FF: capFinish = min(capFinish, prevWorkEnd(shift(s.LF, -lag)))
        SS: capFinish = min(capFinish, addWork(latestStart(shift(s.LS,-lag)), duration))
        SF: capFinish = min(capFinish, addWork(latestStart(shift(s.LF,-lag)), duration))
    FNLT/MFO cap by date ; SNLT caps via latest start ; MSO/MFO pin late = early (zero float)
    LF = prevWorkEnd(capFinish) ; LS = subWork(LF, duration)

# FLOAT, CRITICALITY, ALAP, ROLL-UP
TF = workBetween(ES, LS) on the task calendar ; critical = TF <= 0
FF = min over successors of the slack of each relationship type, clamped to [min(0,TF), TF]
ALAP tasks: report dates = late dates (successors are unaffected)
summary: ES=min(child ES), EF=max(child EF), TF=min(child TF), critical = any(child critical)
```

### 3.1 Relationship formulas
| Type | Successor constraint | Backward cap on predecessor |
|---|---|---|
| FS +L | `S.start ≥ P.finish + L` | `P.finish ≤ S.lateStart − L` |
| SS +L | `S.start ≥ P.start + L` | `P.start ≤ S.lateStart − L` |
| FF +L | `S.finish ≥ P.finish + L` | `P.finish ≤ S.lateFinish − L` |
| SF +L | `S.finish ≥ P.start + L` | `P.start ≤ S.lateFinish − L` |

`+L` is working time on the **project** calendar; negative `L` is a *lead*.

### 3.2 Constraint semantics
| Constraint | Forward pass | Backward pass | Conflict code |
|---|---|---|---|
| ASAP | default | default | – |
| ALAP | placed at late dates after both passes | – | – |
| SNET / FNET | lower bound on start / finish | – | – |
| SNLT / FNLT | none (soft) | upper bound on start / finish | `SNLT_VIOLATED` / `FNLT_VIOLATED`; float becomes negative |
| MSO / MFO | pinned to date (hard) | pinned, zero float | `MSO_VIOLATED` / `MFO_VIOLATED` if predecessors would push later |
| Project deadline | – | caps `limit` | `DEADLINE_MISSED` per late task; negative float |

### 3.3 Complexity and measured performance
O(V + E) graph work plus O(1) amortised calendar work per float query and O(days-between) per add/sub. Measured on the build host (Node 22, single thread; synthetic DAG of finish-to-start links, two predecessors per task chosen within a 50-task window, 1–10 day durations):

| Tasks | Links | Time (full compute, kernel only) |
|---:|---:|---:|
| 1 000 | 1 998 | 28 ms |
| 10 000 | 19 998 | 115 ms |
| 50 000 | 99 998 | 436 ms |

Meets NFR-PERF-01 on this synthetic graph; real plans with long lags, many calendars and resource-driven durations will be slower — the benchmark will be extended with the golden corpus.

## 4. Explainability (“why is this date X?”) *(implemented)*
Every leaf task carries a `driver` — the arg-max kept while computing its start: `PROJECT_START`, `LINK {predId, linkType}` (the link whose lower bound set the start or, for FF/SF, the finish), `CONSTRAINT`, `STATUS_DATE`, `LEVELING`, `MANUAL` or `ACTUAL`. Chained through `predId`, this yields the *driving path* to any task, not only the critical path. Ties keep the first candidate in link insertion order (stable and deterministic). The API returns it as `schedule.driver`.

## 5. Near-critical and multiple critical paths *(implemented)*
`critical` means total float ≤ 0 and the task is not complete. `nearCritical` means `0 < totalFloat ≤ nearCriticalMin` (project setting, default 960 working minutes = 2 days). Completed tasks are neither. The critical **path** is the set of critical tasks; when several disjoint chains are critical, all are returned (`criticalPath` is a set ordered by early start, then early finish, then id).

## 6. Resource-aware scheduling *(implemented: `engine/src/resources.ts`, `leveling.ts`)*
### 6.1 Task types and effort
Each task has a `kind` and an `effortDriven` flag. The engine treats **the entered fields as inputs and derives the rest**, so a plan is a pure function of what users typed:

| Task type | Inputs | Derived duration | Derived work per assignment | Adding a resource ⇒ |
|---|---|---|---|---|
| FIXED_UNITS (default) | `durationMin`, units | = `durationMin` | `duration × units` | work grows, duration unchanged |
| FIXED_UNITS + `effortDriven` | `workMin`, units | `ceil(workMin / Σunits)` | `workMin × units / Σunits` | **duration shortens**, work constant |
| FIXED_DURATION | `durationMin`, units | = `durationMin` | `duration × units` | work grows (units × fixed duration) |
| FIXED_WORK | `workMin`, units | `ceil(workMin / Σunits)` (always effort-driven) | `workMin × units / Σunits` | **duration shortens**, work constant |

With no assignments a task keeps its entered duration. `FIXED_WORK` and effort-driven tasks require `workMin`. *Deliberate simplification versus a desktop tool:* users do not edit "work" directly on a FIXED_UNITS/FIXED_DURATION task — they edit duration and units, and work is derived. This keeps the model free of circular derivations; direct work/units editing with the full three-way recalculation is listed as deferred in §11.

### 6.2 Calendars
The **task calendar** measures duration and positions the task. Each assignment's work is spread over the task's working minutes in proportion; where that falls outside the *resource's* own working time the timephase reports an `OFF_RESOURCE_CALENDAR` warning with the minutes (it is surfaced, not silently dropped). Reconciliation invariant (tested): Σ timephased work = assignment work.

### 6.3 Rates and cost
`cost = Σ_day(planned_work_day × rate_effective(day) / 60)` plus the resource's `perUse` cost on the first scheduled day, plus the task's `fixedCost` (accrued at finish for planned value). Rates are effective-dated; the rate in force on each day is used. `MATERIAL` and `COST` resources carry only per-use cost. Overtime rates are stored but **not modelled** (§11). Granularity is one day.
**Planned value** at a status date is the timephased cost of all days *strictly before* the day of the status date plus fixed costs of tasks finished by then.

### 6.4 Resource levelling
Serial and deterministic (`levelResources`). Two options change the outcome: `order` (`PRIORITY_FLOAT` default, `START`, `ID`) and `withinFloatOnly` (the API defaults it to true).
```text
clear previous levelling delays (unless clearFirst = false)
repeat until no over-allocation, or only unresolved ones remain, or maxIterations:
  find the EARLIEST instant t* where Σ units of tasks working at t* > maxUnits(r) for some resource r
  contenders = tasks working at t* on r
  candidates = contenders that are OPEN, priority < 1000, not MANUAL, not MSO/MFO, not previously stuck,
               and NOT a predecessor (transitively) of another contender      # delaying it would drag the contender along
  order candidates by: priority ascending, total float descending, early start descending, id  (PRIORITY_FLOAT)
  for the first candidate: hop to the earliest end of another task on r at which it FITS beside everything else on r (first fit)
  if withinFloatOnly and the hop exceeds its total float: try the next candidate; if none, record `unresolved: WOULD_EXCEED_FLOAT`
  set levelingDelayMin on the task and re-derive dates INCREMENTALLY (Network.apply) - the §7 machinery is what makes this cheap
```
Every step strictly moves one task's start later, so the loop terminates; the iteration cap (`max(1000, 50 × tasks)`) is a second guard and, if hit, the report says `converged: false` and an `ITERATION_LIMIT` entry — never a silent partial result. Unresolvable overloads are reported (`NO_MOVABLE_TASK`, `WOULD_EXCEED_FLOAT`, `ITERATION_LIMIT`) and are de-duplicated per (resource, contending task set). Levelling is **per project**; cross-project levelling of a shared resource is not performed (§11). Measured: 600 tasks / 25 resources levelled in ≈ 100 ms with 289 delays.

## 7. Incremental recomputation *(implemented: `Network.apply`)*
Goal: single-task edit on 50 k tasks in < 50 ms (NFR-PERF-03).
1. **Dynamic topological order** (Pearce–Kelly): adding a link reorders only the window between the two tasks and detects a cycle in O(affected) time, returning the cycle path; the edit is rejected *before* any state changes.
2. **Forward dirty-propagation:** edited tasks are queued in topological order; a successor is queued only if the task's early start/finish actually changed, so propagation stops at unchanged tasks.
3. **Backward pass:** if the project finish (or deadline) did **not** move, only the edited tasks, tasks whose early dates moved, and their predecessors (while late dates keep changing) are re-derived. If the finish moved, every late date is stale and a full backward pass runs. This is the honest limit of the technique: an edit on the critical path is O(V) for the backward pass, not O(affected).
4. Summary roll-ups and per-task output (float, flags) are derived on read from cached early/late dates, O(V+E) for a full `result()` and O(degree) for `taskRow(id)`.
5. **Correctness oracle:** `test/incremental.test.ts` applies 150 random edit sequences (duration, constraint, add/remove/modify link, add/remove/move task incl. leaf→summary conversion, progress, deadline, levelling delay) and requires `result()` to deep-equal a from-scratch computation after **every** edit; rejected edits (cycle, link-to-summary) must leave the network byte-identical. The same generator should run in staging shadow mode.

Measured (Node 22, single thread, random 3-in-5 mixed-type networks): 50 000 tasks — full compute 402 ms; 200 random duration edits **p50 1.0 ms, p95 1.4 ms, max 4.6 ms** (≈ 12 nodes visited), against 294 ms for a full recompute. 10 000 tasks — p50 0.17 ms, p95 0.67 ms, max 21 ms (one edit moved the finish). Targets met for edits that do not move the project finish; critical-path edits cost one backward pass (tens to hundreds of ms at 50 k tasks).

## 8. Earned value *(implemented: `engine/src/evm.ts`)*
```
EV  = percentComplete × BAC          # never AC — legacy defect D-01
SV  = EV − PV        CV = EV − AC
SPI = EV / PV        CPI = EV / AC          # null when the denominator is 0 (no NaN/Infinity)
EAC (CPI method)         = BAC / CPI
EAC (CPI×SPI method)     = AC + (BAC − EV) / (CPI × SPI)
EAC (atypical variance)  = AC + (BAC − EV)
ETC = EAC − AC     VAC = BAC − EAC     TCPI = (BAC − EV) / (BAC − AC)
```
PV/EV/AC are aggregated from `assignment_timephase` up to the status date, per baseline.

## 9. Schedule-risk simulation *(implemented: `engine/src/montecarlo.ts`)*
* Each iteration samples a **triangular** duration for tasks with a three-point estimate, runs `schedule`, records the project finish and which tasks were critical.
* Output: P50/P80/P90 finish and the **criticality index** (share of runs in which a task was critical).
* **Reproducible:** seeded `mulberry32`; the same seed and plan version produce identical output (test).
* Parallel by construction (the engine is pure): the worker shards iterations across cores; shards merge by concatenating finish arrays.
* Known simplification: independent task durations (no correlation) — correlation matrices and PERT-beta sampling are R3 options.

### 9.1 Formula language for custom fields *(implemented: `engine/src/formula.ts`)*
A deliberately small, **non-Turing-complete** expression grammar: numbers, strings, `true/false/null`, field references, `+ - * / %`, comparisons, `&& || !`, `?:`, and `IF MIN MAX ROUND ABS FLOOR CEIL COALESCE CONCAT LEN UPPER LOWER`. It is parsed to an AST and interpreted with limits (source ≤ 2 000 chars, depth ≤ 32, ≤ 5 000 evaluation steps); there is no property access, indexing, assignment, function definition, `eval` or I/O, and field lookup only reads *own* data properties of the supplied record (so `constructor`/`__proto__` are plain null lookups). Escape attempts (`process.exit(1)`, `a.constructor.constructor(...)`, `require`, `eval`, `a[0]`) are syntax errors. This replaces legacy Groovy formulas (D-10). Not yet done: coverage-guided fuzzing (§11).

## 10. Test strategy for the engine
| Layer | Technique | Status |
|---|---|---|
| Example-based | Hand-computed schedules for each rule (14 original + feature tests) | ✅ |
| Property-based | 300 random DAGs × invariants | ✅ → raise to 10 000 in CI nightly |
| **Independent oracle** | Separate algorithm on a materialised working-minute axis; 400 random networks, dates and total float | ✅ `test/oracle.test.ts` |
| **Differential** | Incremental vs full recompute, 150 sequences × 25 edits, deep equality after every edit | ✅ `test/incremental.test.ts` |
| Levelling | Determinism, idempotence, no over-allocation unless reported, convergence on 25 dense random networks, livelock regression | ✅ `test/leveling.test.ts` |
| Sandbox | Escape attempts, limit enforcement | ✅ `test/formula.test.ts` |
| Golden corpus | ≥ 200 real plans with expected dates from a trusted reference | ⬜ no plans yet — requires user-supplied plans (doc 13) |
| Mutation testing | Stryker, score ≥ 70 % | ⬜ not run |
| Performance | `engine/bench` (full, incremental, levelling) | ✅ script; CI regression gate (> 20 %) still to wire |

## 11. Known limits of the reference implementation
Closed in v0.2 (see `docs/17-gap-closure-register.md`): lag calendar basis, manual-mode tasks, status-date rescheduling of remaining work, ALAP free float (reported 0, dates reported at the late position), driver retention, near-critical, calendar inheritance, the DST edge adapter, formula language, resource rules, levelling, incremental recomputation.

Consciously **deferred** (each has an ID in the gap register):
* **Task splits** (interruptions) — a task is one contiguous span of working time.
* **Sub-project / cross-project links** and cross-project resource levelling.
* **Overtime** rates and overtime work; **direct work editing** on FIXED_UNITS/FIXED_DURATION tasks (work is derived).
* **Calendar change as an incremental edit** — editing a calendar rebuilds the network (`new Network`), O(V+E).
* **Progress model:** an in-progress task resumes at the status date (or after the work already done); there is no per-day actuals ledger, so timephased planned work is not reduced by actuals.
* **Levelling** is per project, serial, first-fit; it is not optimal and makes no attempt to minimise finish slip beyond the stated ordering. Resource calendars are reported (`OFF_RESOURCE_CALENDAR`) but do not move tasks.
* **Golden corpus parity, mutation testing and formula fuzzing** have not been run.
* The DST adapter converts instants at the edge; a project whose calendar is defined in a zone with a DST *gap/fold inside working hours* is handled by the adapter's resolution rules (gap → forward, fold → first occurrence), not by the kernel.
