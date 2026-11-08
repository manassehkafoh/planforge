import { ScheduleError } from '../../engine/src/index.ts';

/** Stable client-facing codes (docs/07 section 5). */
export type ProblemCode =
  | 'VALIDATION_FAILED' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' | 'VERSION_CONFLICT' | 'DUPLICATE_CLIENT_OP'
  | 'CYCLE_DETECTED' | 'LINK_TO_SUMMARY' | 'UNKNOWN_TASK' | 'DUPLICATE_ID' | 'CONSTRAINT_UNSATISFIABLE' | 'PLAN_TOO_LARGE'
  | 'BASELINE_EXISTS' | 'PRECONDITION_REQUIRED' | 'IMPORT_UNSUPPORTED' | 'IMPORT_REJECTED_UNSAFE' | 'RATE_LIMITED' | 'DEPENDENCY_UNAVAILABLE' | 'NOT_IMPLEMENTED' | 'INTERNAL';

const STATUS: Record<ProblemCode, number> = {
  VALIDATION_FAILED: 400, UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404, VERSION_CONFLICT: 409, DUPLICATE_CLIENT_OP: 409,
  CYCLE_DETECTED: 422, LINK_TO_SUMMARY: 422, UNKNOWN_TASK: 422, DUPLICATE_ID: 422, CONSTRAINT_UNSATISFIABLE: 422, PLAN_TOO_LARGE: 413,
  BASELINE_EXISTS: 409, PRECONDITION_REQUIRED: 428, IMPORT_UNSUPPORTED: 422, IMPORT_REJECTED_UNSAFE: 422, RATE_LIMITED: 429, DEPENDENCY_UNAVAILABLE: 503, NOT_IMPLEMENTED: 501, INTERNAL: 500,
};
const TITLE: Record<ProblemCode, string> = {
  VALIDATION_FAILED: 'Validation failed', UNAUTHENTICATED: 'Authentication required', FORBIDDEN: 'Forbidden', NOT_FOUND: 'Not found',
  VERSION_CONFLICT: 'Plan version conflict', DUPLICATE_CLIENT_OP: 'Client operation id reused with a different body',
  CYCLE_DETECTED: 'Dependency cycle', LINK_TO_SUMMARY: 'Links to summary tasks are not allowed', UNKNOWN_TASK: 'Unknown task',
  DUPLICATE_ID: 'Duplicate identifier', CONSTRAINT_UNSATISFIABLE: 'Constraint cannot be satisfied', PLAN_TOO_LARGE: 'Request exceeds a plan limit',
  BASELINE_EXISTS: 'Baseline number already saved (baselines are immutable)', PRECONDITION_REQUIRED: 'If-Match header required', IMPORT_UNSUPPORTED: 'Import format not supported', IMPORT_REJECTED_UNSAFE: 'Import rejected as unsafe', RATE_LIMITED: 'Too many requests',
  DEPENDENCY_UNAVAILABLE: 'Dependency unavailable', NOT_IMPLEMENTED: 'Not implemented in the reference server', INTERNAL: 'Internal error',
};

export class Problem extends Error {
  code: ProblemCode;
  status: number;
  extra: Record<string, unknown>;
  constructor(code: ProblemCode, detail?: string, extra: Record<string, unknown> = {}) {
    super(detail ?? TITLE[code]);
    this.code = code; this.status = STATUS[code]; this.extra = extra;
  }
}

/** Total mapping engine -> API: adding an engine error code without a mapping here is a compile-time error (satisfies). */
const ENGINE_MAP = {
  CYCLE: 'CYCLE_DETECTED', UNKNOWN_TASK: 'UNKNOWN_TASK', LINK_TO_SUMMARY: 'LINK_TO_SUMMARY', BAD_INPUT: 'VALIDATION_FAILED', DUPLICATE_ID: 'DUPLICATE_ID',
} as const satisfies Record<ScheduleError['code'], ProblemCode>;

export function fromEngine(e: ScheduleError): Problem {
  const code = ENGINE_MAP[e.code];
  const extra: Record<string, unknown> = {};
  if (e.code === 'CYCLE') extra.cycle = (e.detail as { path?: string[] } | undefined)?.path ?? [];
  return new Problem(code, e.message, extra);
}

export function problemBody(p: Problem, instance: string, traceId: string) {
  return {
    type: `https://docs.planforge.example/errors/${p.code}`,
    title: TITLE[p.code], status: p.status, code: p.code,
    detail: p.code === 'INTERNAL' ? 'An unexpected error occurred. Quote the traceId when contacting support.' : p.message,
    instance, traceId, ...p.extra,
  };
}
