// PlanForge scheduling engine - public types (v0.2).
// Clean-room design: no ProjectLibre/OpenProj source was copied. Behaviour follows
// the published CPM/PDM method and the observable MS-Project-style constraint vocabulary.
//
// TIME MODEL: all instants are epoch-milliseconds interpreted as *wall-clock in the project's
// time zone* ("naive local"). Conversion to/from real UTC instants happens at the edge (src/zone.ts).
// Work amounts are integer minutes. A task's `finish` is an END-INSTANT: the moment the last working minute ends.

export type DepType = 'FS' | 'SS' | 'FF' | 'SF';
export type ConstraintType = 'ASAP' | 'ALAP' | 'MSO' | 'MFO' | 'SNET' | 'SNLT' | 'FNET' | 'FNLT';
/** which calendar measures a link's lag: the project calendar (default), the predecessor's or the successor's */
export type LagBasis = 'PROJECT' | 'PRED' | 'SUCC';
export type TaskKind = 'FIXED_UNITS' | 'FIXED_DURATION' | 'FIXED_WORK';

export interface TimeRange { startMin: number; endMin: number } // minutes from local midnight, start<end

export interface CalendarDef {
  id: string;
  /** derived calendars inherit from `baseId`; a `null` weekday entry means "inherit that weekday" */
  baseId?: string;
  /** index 0 = Sunday ... 6 = Saturday. Empty array = non-working weekday. */
  week: (TimeRange[] | null)[];
  /** key 'YYYY-MM-DD'. Empty array = non-working day; otherwise replacement working ranges. Derived overrides base. */
  exceptions?: Record<string, TimeRange[]>;
}

export interface TaskIn {
  id: string;
  name?: string;
  /** work duration in working minutes of the task calendar; 0 = milestone */
  durationMin: number;
  parentId?: string | null;
  constraint?: { type: ConstraintType; date?: number };
  calendarId?: string;
  /** optional 3-point estimate (minutes) used by Monte Carlo */
  estimate?: { optimistic: number; mostLikely: number; pessimistic: number };
  // ---- resource scheduling rules (src/resources.ts)
  kind?: TaskKind;                 // default FIXED_UNITS
  effortDriven?: boolean;          // default false (FIXED_WORK is always effort-driven)
  priority?: number;               // 0..1000, higher = more important; 1000 = never level. default 500
  fixedCost?: number;
  /** total work in working minutes (all resources); required for FIXED_WORK and effort-driven tasks */
  workMin?: number;
  // ---- manual scheduling
  mode?: 'AUTO' | 'MANUAL';        // MANUAL: dates are user-pinned (manualStart required)
  manualStart?: number;
  manualFinish?: number;
  // ---- progress
  percentComplete?: number;        // 0..1
  actualStart?: number;
  actualFinish?: number;           // required when percentComplete = 1
  // ---- leveling output, fed back as input
  levelingDelayMin?: number;
}

export interface LinkIn { pred: string; succ: string; type?: DepType; lagMin?: number; lagBasis?: LagBasis }

export interface RateIn { from: number; stdPerHour: number; perUse?: number }
export interface ResourceIn {
  id: string;
  name?: string;
  kind?: 'WORK' | 'MATERIAL' | 'COST';
  maxUnits?: number;               // 1 = 100 %, default 1
  calendarId?: string;
  rates?: RateIn[];                // effective-dated, any order
}
export interface AssignmentIn { id: string; taskId: string; resourceId: string; units?: number; /* default 1 */ }

export interface ProjectIn {
  startDate: number;
  /** optional hard project deadline (soft constraint on terminal tasks) */
  deadline?: number;
  /** status date: unfinished work cannot start before it (remaining work resumes here) */
  statusDate?: number;
  /** tasks with 0 < total float <= this are flagged nearCritical (default 960 = 2 working days) */
  nearCriticalMin?: number;
  calendar: CalendarDef;
  calendars?: CalendarDef[];
  tasks: TaskIn[];
  links: LinkIn[];
  resources?: ResourceIn[];
  assignments?: AssignmentIn[];
}

export type ConflictCode =
  | 'MSO_VIOLATED' | 'MFO_VIOLATED' | 'SNLT_VIOLATED' | 'FNLT_VIOLATED' | 'DEADLINE_MISSED'
  | 'MANUAL_DATE_CONFLICT';

export interface Conflict { taskId: string; code: ConflictCode; detail: string }

/** why a task starts when it does ("Why this date?") */
export interface Driver {
  kind: 'PROJECT_START' | 'LINK' | 'CONSTRAINT' | 'STATUS_DATE' | 'LEVELING' | 'MANUAL' | 'ACTUAL';
  predId?: string;
  linkType?: DepType;
}

export interface TaskOut {
  id: string;
  isSummary: boolean;
  es: number; ef: number; ls: number; lf: number;
  totalFloatMin: number; freeFloatMin: number;
  critical: boolean;
  nearCritical: boolean;
  state: 'OPEN' | 'PROGRESS' | 'DONE';
}

export interface ScheduleResult {
  start: number; finish: number;
  tasks: Record<string, TaskOut>;
  criticalPath: string[];          // leaf task ids with total float <= 0, in early-start order
  conflicts: Conflict[];
  drivers: Record<string, Driver>; // leaf tasks only
}

export class ScheduleError extends Error {
  code: 'CYCLE' | 'UNKNOWN_TASK' | 'LINK_TO_SUMMARY' | 'BAD_INPUT' | 'DUPLICATE_ID';
  detail?: unknown;
  constructor(code: ScheduleError['code'], message: string, detail?: unknown) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}
