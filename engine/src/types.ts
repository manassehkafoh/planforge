// PlanForge scheduling engine - public types.
// Clean-room design: no ProjectLibre/OpenProj source was copied. Behaviour follows
// the published CPM/PDM method (precedence diagramming) and the observable MS-Project-style
// constraint vocabulary (ASAP, ALAP, MSO, MFO, SNET, SNLT, FNET, FNLT).
//
// TIME MODEL: all instants are epoch-milliseconds interpreted as *wall-clock in the project's
// time zone* ("naive local"). Conversion to/from real UTC instants happens at the API edge
// (see docs/06-scheduling-engine-design.md section 2). Work amounts are integer minutes.
// A task's `finish` is an END-INSTANT: the moment the last working minute ends.

export type DepType = 'FS' | 'SS' | 'FF' | 'SF';
export type ConstraintType = 'ASAP' | 'ALAP' | 'MSO' | 'MFO' | 'SNET' | 'SNLT' | 'FNET' | 'FNLT';

export interface TimeRange { startMin: number; endMin: number } // minutes from local midnight, start<end

export interface CalendarDef {
  id: string;
  /** index 0 = Sunday ... 6 = Saturday. Empty array = non-working weekday. */
  week: TimeRange[][];
  /** key 'YYYY-MM-DD'. Empty array = non-working day; otherwise replacement working ranges. */
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
}

export interface LinkIn { pred: string; succ: string; type?: DepType; lagMin?: number }

export interface ProjectIn {
  startDate: number;
  /** optional hard project deadline (soft constraint on terminal tasks) */
  deadline?: number;
  calendar: CalendarDef;
  calendars?: CalendarDef[];
  tasks: TaskIn[];
  links: LinkIn[];
}

export type ConflictCode =
  | 'MSO_VIOLATED' | 'MFO_VIOLATED' | 'SNLT_VIOLATED' | 'FNLT_VIOLATED' | 'DEADLINE_MISSED';

export interface Conflict { taskId: string; code: ConflictCode; detail: string }

export interface TaskOut {
  id: string;
  isSummary: boolean;
  es: number; ef: number; ls: number; lf: number;
  totalFloatMin: number; freeFloatMin: number;
  critical: boolean;
}

export interface ScheduleResult {
  start: number; finish: number;
  tasks: Record<string, TaskOut>;
  criticalPath: string[];          // leaf task ids with total float <= 0, in early-start order
  conflicts: Conflict[];
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
