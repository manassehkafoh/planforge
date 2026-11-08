# 14 · Legacy-to-New Traceability Matrix

Maps what exists in ProjectLibre (paths relative to the repository root) to where the capability lives in PlanForge and what to do about it. **Disposition:** *Re-specify* = re-implement from behaviour (clean-room), *Replace* = different technology, *Drop* = not carried forward, *Wrap* = isolate and reuse as a separate component.

| Legacy artefact (size) | Capability | PlanForge component (doc) | Disposition | Verification |
|---|---|---|---|---|
| `openproj_core/.../pm/criticalpath/CriticalPath`, `TaskSchedule`, `PredecessorTaskList` (≈ 1.7 k LOC) | Forward/backward pass, sentinels, ordered list | `engine/src/cpm.ts` (06 §3) | Re-specify | Engine tests, corpus |
| `pm/scheduling/*` (`ConstraintType`, `SchedulingType`, `FixedUnits/Duration/Work`) | Constraints, task types | `cpm.ts` constraints; resource rules (06 §3.2, §6.1) | Re-specify | Table-driven tests |
| `pm/dependency/*` (`Dependency`, `DependencyType`, `DependencyService`) | Link semantics, FF/FS/SF/SS = 0/1/2/3 | `TaskLink` aggregate part; enum `DepType` (05 §3) | Re-specify (keep ids in importer only) | Corpus, importer map (13 §2) |
| `pm/calendar/*` (`WorkingCalendar`, `WorkDay`, `WorkWeek`, 3.8 k LOC) | Working time, exceptions, inheritance | `engine/src/calendar.ts`; `calendar` tables (05) | Re-specify | Calendar unit tests, DST cases |
| `pm/task/Project`, `Task`, `NormalTask` (7.3 k LOC) | God-object model | `Plan` aggregate + `ApplyCommands` (04 §4, 05 §3) | Replace (decompose) | Command tests |
| `pm/assignment/*` (6 k LOC) | Work, units, timephased cost | `assignment`, `assignment_timephase` (05); rules (06 §6) | Re-specify | Reconciliation tests |
| `pm/resource/*` (3.3 k LOC) | Resource pool | `resource`, `resource_rate` (05) | Re-specify | API tests |
| `pm/costing/EarnedValueCalculator`, `CostRate*` | EVM, rate tables | `engine/src/evm.ts` (06 §8); `EvmService` | Re-specify **(fix D-01)** | EVM tests, DQ rule `ev = pct × bac` |
| `pm/snapshot/*`, `TaskSnapshot` | Baselines | `baseline`, `baseline_task` (05) | Re-specify | Immutability test |
| `undo/*` (20 `*Edit` classes) | Undo/redo | Inverse commands in op log (04 §7.6) | Replace | Property test: apply∘inverse = identity |
| `field/Field`, `configuration.xml` (183 fields), `view.xml` | Metadata-driven columns/forms | Column/field definitions served by API; custom fields (05, 09) | Replace (keep the *idea*) | Contract tests |
| `grouping/core/*` (`Node`, `OutlineCode`) | Hierarchy / outline | `task.parent_id` + `sort_key` (05) | Replace | Reorder property test |
| `script/`, `scripting/formulas` + Groovy/BSF JARs | Formulas | Sandboxed expression grammar (06 §9.1) | Replace (**D-10**) | Fuzz/sandbox tests |
| `session/LocalSession`, `FileHelper` | Open/save local files | Server persistence + export (13) | Replace | Round-trip tests |
| `openproj_exchange/.../Serializer`, `.pod` | Native persistence | Allow-listed reader / convert-once (13 §3) | Replace (**D-04**) | Fuzzing |
| `projectlibre_exchange` (vendored MPXJ, 266 k LOC) | MPP/MSPDI/Primavera I/O | Isolated converter container (13 §1) | Wrap (LGPL) | Corpus |
| `openproj_ui` first-party (≈ 60 k LOC) | Swing views, dialogs, ribbon | React SPA (09) | Replace | E2E, a11y |
| `openproj_ui/org/pushingpixels` (Flamingo, 38 k) | Ribbon widget | Not needed (web UI) | Drop | – |
| `openproj_reports` (JasperReports) | Reports | Report definitions + PDF export; BI marts (11) | Replace | Golden PDFs |
| `options/*Option` singletons | Global options | Project settings (05 `project`) | Replace (**D-03**) | Multi-tenant test |
| `projectlibre_core` next-gen core (10.6 k LOC) | Unfinished rewrite | Architectural *intent* only | Drop | – |
| `openproj_build` (Ant, installers, samples) | Packaging | Container + Helm (12); samples → corpus fixtures | Replace; keep samples | – |

## Coverage check
All ten extracted behaviours B1–B10 (doc 01 §5) have a destination row above; every defect D-01…D-13 has either a replacement design (D-01, D-03, D-04, D-05, D-06, D-09, D-10, D-11, D-12), a process answer (D-13 → ADR-001; D-07 → dependency policy in 15) or is moot because the component is dropped (D-02, D-08).
