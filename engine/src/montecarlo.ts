import { schedule } from './cpm.ts';
import type { ProjectIn } from './types.ts';

/** mulberry32: tiny seeded PRNG so simulations are reproducible (same seed -> same percentiles). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function triangular(r: () => number, a: number, m: number, b: number): number {
  const u = r(), f = (m - a) / (b - a || 1);
  return u < f ? a + Math.sqrt(u * (b - a) * (m - a)) : b - Math.sqrt((1 - u) * (b - a) * (b - m));
}

export interface RiskResult {
  iterations: number;
  p50: number; p80: number; p90: number;               // project finish instants
  criticalityIndex: Record<string, number>;            // share of runs in which the task was critical
}

export function simulate(p: ProjectIn, iterations = 1000, seed = 42): RiskResult {
  const r = rng(seed);
  const finishes: number[] = [];
  const crit: Record<string, number> = {};
  for (let i = 0; i < iterations; i++) {
    const tasks = p.tasks.map((t) =>
      t.estimate
        ? { ...t, durationMin: Math.round(triangular(r, t.estimate.optimistic, t.estimate.mostLikely, t.estimate.pessimistic)) }
        : t);
    const res = schedule({ ...p, tasks });
    finishes.push(res.finish);
    for (const id of res.criticalPath) crit[id] = (crit[id] ?? 0) + 1;
  }
  finishes.sort((a, b) => a - b);
  const q = (x: number) => finishes[Math.min(finishes.length - 1, Math.floor(x * finishes.length))];
  for (const k of Object.keys(crit)) crit[k] /= iterations;
  return { iterations, p50: q(0.5), p80: q(0.8), p90: q(0.9), criticalityIndex: crit };
}
