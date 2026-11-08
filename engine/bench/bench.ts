import { schedule, standardCalendar, rng } from '../src/index.ts';
const MON = Date.UTC(2026, 10, 9, 8);
function build(n: number, fan: number, seed = 1) {
  const r = rng(seed);
  const tasks = Array.from({ length: n }, (_, i) => ({ id: 't' + i, durationMin: (1 + Math.floor(r() * 10)) * 480 }));
  const links = [];
  for (let j = 1; j < n; j++) for (let k = 0; k < fan; k++) {
    const i = Math.max(0, j - 1 - Math.floor(r() * 50));
    if (i < j) links.push({ pred: 't' + i, succ: 't' + j, type: 'FS' as const, lagMin: 0 });
  }
  return { startDate: MON, calendar: standardCalendar(), tasks, links };
}
for (const n of [1_000, 10_000, 50_000]) {
  const p = build(n, 2);
  const t0 = performance.now();
  const res = schedule(p);
  const ms = performance.now() - t0;
  console.log(`${String(n).padStart(6)} tasks, ${p.links.length} links: ${ms.toFixed(0)} ms (critical=${res.criticalPath.length})`);
}
