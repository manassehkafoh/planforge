import { Network, levelResources, rng } from '../src/index.ts';
import { randomProject } from '../test/helpers.ts';

const time = <T>(f: () => T): [T, number] => { const t = process.hrtime.bigint(); const r = f(); return [r, Number(process.hrtime.bigint() - t) / 1e6]; };

for (const n of [10_000, 50_000]) {
  const p = randomProject(11, n);
  const [net, tFull] = time(() => new Network(p));
  const r = rng(3);
  const ids = net.topoOrder();
  const samples: { ms: number; fv: number; bv: number; full: boolean }[] = [];
  for (let i = 0; i < 200; i++) {
    const id = ids[Math.floor(r() * ids.length)];
    const [s, ms] = time(() => net.apply({ op: 'setTask', id, patch: { durationMin: Math.floor(r() * 8) * 120 } }));
    samples.push({ ms, fv: s.forwardVisited, bv: s.backwardVisited, full: s.fullBackward });
  }
  const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
  const q = (x: number) => sorted[Math.min(sorted.length - 1, Math.floor(x * sorted.length))].toFixed(2);
  const local = samples.filter((s) => !s.full);
  console.log(`${n} tasks: full ${tFull.toFixed(0)} ms | 200 random duration edits: p50 ${q(0.5)} ms, p95 ${q(0.95)} ms, max ${sorted.at(-1)!.toFixed(1)} ms | ` +
    `${local.length}/200 did not move the finish (mean ${(local.reduce((a, s) => a + s.fv + s.bv, 0) / Math.max(1, local.length)).toFixed(0)} nodes visited)`);
  const [, tRef] = time(() => new Network(net.toProject()));
  console.log(`   re-running a full recompute instead would cost ${tRef.toFixed(0)} ms per edit`);
}

// levelling at scale
{
  const n = 600;
  const rr = rng(5);
  const base = randomProject(21, n);
  const tasks = base.tasks.map((t) => ({ ...t, constraint: undefined, durationMin: 240 + Math.floor(rr() * 4) * 240 }));
  const res = Array.from({ length: 25 }, (_, i) => ({ id: `r${i}`, maxUnits: 1 }));
  const asg = tasks.map((t, i) => ({ id: `a${i}`, taskId: t.id, resourceId: `r${Math.floor(rr() * 25)}`, units: 1 }));
  const [out, ms] = time(() => levelResources({ ...base, tasks, resources: res, assignments: asg }));
  console.log(`levelling ${n} tasks / 25 resources: ${ms.toFixed(0)} ms, ${out.report.steps.length} delays, ${out.report.unresolved.length} unresolved, finish ${((out.report.finishAfter - out.report.finishBefore) / 86_400_000).toFixed(0)} days later`);
}
