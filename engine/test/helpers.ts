import { standardCalendar, rng } from '../src/index.ts';
import type { ProjectIn, TaskIn, LinkIn, DepType } from '../src/index.ts';

export const D = 480;
export const at = (y: number, m: number, d: number, h = 8, mi = 0) => Date.UTC(y, m - 1, d, h, mi);
export const MON = at(2026, 11, 9);
export const proj = (tasks: TaskIn[], links: LinkIn[] = [], extra: Partial<ProjectIn> = {}): ProjectIn =>
  ({ startDate: MON, calendar: standardCalendar(), tasks, links, ...extra });
export const T = (id: string, days: number, extra: Partial<TaskIn> = {}): TaskIn => ({ id, durationMin: Math.round(days * D), ...extra });

/** random acyclic project: links only go from lower to higher index; mixed types, lags, constraints */
export function randomProject(seed: number, n: number): ProjectIn {
  const r = rng(seed);
  const types: DepType[] = ['FS', 'FS', 'FS', 'SS', 'FF', 'SF'];
  const tasks: TaskIn[] = [];
  for (let i = 0; i < n; i++) {
    const t: TaskIn = { id: `t${i}`, durationMin: Math.floor(r() * 6) * 120 };
    const k = r();
    if (k < 0.06) t.constraint = { type: 'SNET', date: MON + Math.floor(r() * 20) * 86_400_000 };
    else if (k < 0.1) t.constraint = { type: 'ALAP' };
    else if (k < 0.13) t.constraint = { type: 'FNLT', date: MON + Math.floor(r() * 40) * 86_400_000 };
    tasks.push(t);
  }
  const links: LinkIn[] = [];
  for (let j = 1; j < n; j++) {
    const k = 1 + Math.floor(r() * 2);
    for (let q = 0; q < k; q++) {
      const i = Math.floor(r() * j);
      links.push({ pred: `t${i}`, succ: `t${j}`, type: types[Math.floor(r() * types.length)], lagMin: (Math.floor(r() * 5) - 1) * 60 });
    }
  }
  return { startDate: MON, calendar: standardCalendar(), tasks, links };
}
