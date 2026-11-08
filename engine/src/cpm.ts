import { Network } from './network.ts';
import type { ProjectIn, ScheduleResult } from './types.ts';

/**
 * Deterministic Critical Path Method over a precedence diagram (see network.ts for the kernels).
 * schedule() is the stateless entry point; use `Network` directly for incremental recomputation.
 */
export function schedule(p: ProjectIn): ScheduleResult {
  return new Network(p).result();
}
