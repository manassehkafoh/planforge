# 06 · Scheduling Engine Design

The engine is the product's heart and the part of ProjectLibre worth re-specifying carefully (doc 01 §3.2). A **reference implementation** lives in `engine/` (≈ 520 lines of TypeScript, zero runtime dependencies). It implements §3–§5 and §8–§9 (EVM, Monte Carlo); §6 (resource scheduling rules), §7 (incremental recomputation) and the leveller in §6.4 are **designed but not implemented** — each section says which.

**Verified state of the reference engine (this build):** 14 tests pass — calendar arithmetic, all four relationship types, lead/lag, 8 constraints, ALAP, milestones, summary roll-up, error taxonomy, EVM regression, seeded Monte Carlo, and a property test over **300 random DAGs** (invariants: early ≤ late, no negative float without constraints, 0 ≤ free ≤ total float, finish = start + working duration, every relationship satisfied, ≥ 1 critical task). The property test caught two real defects in my first draft (a missing project-finish cap on tasks with successors, and minute-granular backtracking that produced 16:59 start times) — evidence for investing in this style of test.

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

| Tasks | Links | Time |
|---:|---:|---:|
| 1 000 | 1 998 | 20 ms |
| 10 000 | 19 998 | 143 ms |
| 50 000 | 99 998 | 663 ms |

Meets NFR-PERF-01 on this synthetic graph; real plans with long lags, many calendars and resource-driven durations will be slower — the benchmark will be extended with the golden corpus.

## 4. Explainability (“why is this date X?”)
For any task the engine can return the **driving predecessor**: the link whose lower bound equals the chosen start (or finish), or the constraint, or the project start. Chained, this yields the *driving path* to any task, not only the critical path. This is cheap (re-evaluate the max once, keep the arg-max) and is the single most trust-building feature for schedulers. *Designed; the reference engine computes the max but does not yet retain the arg-max.*

## 5. Near-critical and multiple critical paths
`critical` means TF ≤ 0. A configurable threshold (default 2 working days) additionally flags *near-critical* tasks. The critical **path** is the set of critical tasks; when several disjoint chains are critical, all are returned (`criticalPath` is a set ordered by early start, not a single chain).

## 6. Resource-aware scheduling *(designed, not implemented)*
### 6.1 Task types (carry over legacy B5)
Given `Work = Duration × Units × Σ…` per assignment, a change recalculates exactly one of the three:

| Task type | User edits | Recalculated | Effort-driven adds resource ⇒ |
|---|---|---|---|
| Fixed units | duration | work = duration × units | work constant, duration shortens |
| Fixed duration | work or units | units = work / duration | work constant, units split |
| Fixed work | duration or units | the other of (duration, units) | duration shortens |

### 6.2 Effective duration with resource calendars
A task assigned to resources with different calendars uses the **task calendar** for duration; each assignment's *timephased work* is distributed over the intersection of the task's span and the resource's working time. Required invariant: Σ timephased work = assignment work (tested by reconciliation).

### 6.3 Rates and cost
`cost = Σ_day(planned_work_day × rate_effective(day))` plus per-use cost at start; rates are effective-dated (`resource_rate`). Fixed task costs accrue at start/prorated/end per accrual setting.

### 6.4 Resource levelling
Serial, priority-driven, deterministic:
```text
repeat until no over-allocation or no progress:
  find earliest day d where Σ load(r,d) > capacity(r,d) for some resource r
  candidates = tasks active on d that use r, not yet fixed
  victim = argmax(order by: FLOAT descending, then early start descending, then priority ascending, then id)
  delay = smallest shift (working minutes) that removes the overload on d for victim
  if withinFloatOnly and delay > victim.totalFloat: mark unresolved, continue
  apply levelingDelay to victim's assignment ; re-run CPM incrementally
```
Tie-breaks are total (ends with task id) so results are reproducible; dry-run returns delays without persisting. Complexity is bounded by `maxIterations = 10 × assignments`. Quality is judged against the corpus (finish-date slip vs a reference leveller).

## 7. Incremental recomputation *(designed, not implemented)*
Goal: single-task edit on 50 k tasks in < 50 ms (NFR-PERF-03).
1. Keep the topological order as a **dynamic order** (Pearce–Kelly): adding a link reorders only the affected window, and *also* detects a cycle in O(affected) time.
2. On edit, collect the **dirty set** = edited tasks; forward pass visits dirty tasks in order, adding a successor to the set *only if its start/finish actually changed*; stop propagating at unchanged tasks.
3. Backward pass is needed only if the project finish changed or the edited task's late dates are affected: re-run over predecessors of changed tasks, bounded by unchanged late dates.
4. Summary roll-ups update along the parent chain only.
5. **Correctness oracle:** in tests and in staging shadow mode, every incremental result is compared with a full recompute; any difference fails the build (the property test generator is reused with random edit sequences).

Legacy parallel: the old engine used a global calculation-state counter and an `affectsCriticalPath` shortcut (doc 01 §3.2). The new design makes the dirty set explicit and immutable-in/out, so it is thread-safe and testable.

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

### 9.1 Formula language for custom fields *(designed)*
A deliberately small, **non-Turing-complete** expression grammar (arithmetic, comparison, `IF`, `MIN/MAX/SUM`, field references, date/duration functions). It is parsed to an AST and interpreted with step and depth limits; no host-language `eval`, reflection or I/O. This replaces legacy Groovy formulas (D-10). Fuzzing and sandbox-escape tests are required before R2.

## 10. Test strategy for the engine
| Layer | Technique | Status |
|---|---|---|
| Example-based | Hand-computed schedules for each rule | ✅ 13 tests |
| Property-based | 300 random DAGs × invariants | ✅ (found 2 bugs) → raise to 10 000 in CI nightly |
| Differential | Incremental vs full recompute (§7); client vs server results | ⬜ with §7 |
| Golden corpus | ≥ 200 real plans with expected dates from a trusted reference | ⬜ doc 13 |
| Mutation testing | Stryker, score ≥ 70 % | ⬜ |
| Performance | Benchmark gate, regression > 20 % fails | ✅ script exists |

## 11. Known limits of the reference implementation
* Single project calendar for lags; task calendars only for durations.
* No manual-mode tasks, no splits (task interruptions), no status-date rescheduling of remaining work, no sub-project links.
* Free float for ALAP tasks is reported against their early position.
* Not yet DST-aware at the edge (the engine is naive-local by design; the edge adapter is not written).
