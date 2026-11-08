import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Network, rng, ScheduleError } from '../src/index.ts';
import type { Edit } from '../src/index.ts';
import { randomProject, MON, D } from './helpers.ts';

const same = (net: Network, ctx: string) => {
  const fresh = new Network(net.toProject()).result();
  assert.deepStrictEqual(net.result(), fresh, ctx);
};

test('incremental == full recompute (oracle) over 150 random edit sequences', () => {
  let cycles = 0, edits = 0;
  for (let seed = 1; seed <= 150; seed++) {
    const r = rng(seed * 7919);
    const net = new Network(randomProject(seed, 30));
    let nextId = 1000;
    for (let step = 0; step < 25; step++) {
      const ids = net.leafIds();
      const pick = () => ids[Math.floor(r() * ids.length)];
      const k = r();
      let e: Edit;
      if (k < 0.3) e = { op: 'setTask', id: pick(), patch: { durationMin: Math.floor(r() * 8) * 120 } };
      else if (k < 0.4) e = { op: 'setTask', id: pick(), patch: { constraint: r() < 0.5 ? { type: 'SNET', date: MON + Math.floor(r() * 30) * 86_400_000 } : { type: 'ASAP' } } };
      else if (k < 0.55) e = { op: 'addLink', link: { pred: pick(), succ: pick(), type: (['FS', 'SS', 'FF', 'SF'] as const)[Math.floor(r() * 4)], lagMin: Math.floor(r() * 3) * 60 } };
      else if (k < 0.65) {
        const t = pick(); const preds = net.toProject().links.filter((l) => l.succ === t);
        if (!preds.length) continue;
        e = { op: 'removeLink', pred: preds[0].pred, succ: t, type: preds[0].type };
      } else if (k < 0.72) {
        const t = pick(); const preds = net.toProject().links.filter((l) => l.succ === t);
        if (!preds.length) continue;
        e = { op: 'setLink', pred: preds[0].pred, succ: t, type: preds[0].type, patch: { lagMin: Math.floor(r() * 4) * 60 - 60 } };
      } else if (k < 0.78) e = { op: 'addTask', task: { id: `n${nextId++}`, durationMin: 240 } };
      else if (k < 0.81) e = { op: 'addTask', task: { id: `n${nextId++}`, durationMin: 120, parentId: pick() } };
      else if (k < 0.84) e = { op: 'removeTask', id: pick() };
      else if (k < 0.9) e = { op: 'setTask', id: pick(), patch: { percentComplete: 0.5, actualStart: MON } };
      else if (k < 0.95) e = { op: 'setProject', patch: { deadline: MON + Math.floor(r() * 40) * 86_400_000 } };
      else e = { op: 'setTask', id: pick(), patch: { levelingDelayMin: Math.floor(r() * 4) * 120 } };
      const before = JSON.stringify(net.toProject());
      try { net.apply(e); edits++; }
      catch (err) {
        assert.ok(err instanceof ScheduleError, String(err));
        assert.ok(['CYCLE', 'LINK_TO_SUMMARY', 'BAD_INPUT'].includes(err.code), err.code);
        cycles++;
        assert.equal(JSON.stringify(net.toProject()), before, 'rejected edit must leave the network unchanged');
      }
      same(net, `seed ${seed} step ${step} ${JSON.stringify(e)}`);
    }
  }
  assert.ok(edits > 1500 && cycles > 5, `edits=${edits} cycles=${cycles}`);
});

test('incremental work is local: a tail edit visits few nodes', () => {
  const p = randomProject(5, 2000);
  const net = new Network(p);
  const last = net.topoOrder().slice(-3)[0];
  const s = net.apply({ op: 'setTask', id: last, patch: { durationMin: 60 } });
  assert.ok(s.forwardVisited < 20, `forwardVisited=${s.forwardVisited}`);
  same(net, 'tail edit');
});

test('cycle through addLink reports the path and leaves state intact', () => {
  const net = new Network({ ...randomProject(1, 3), links: [{ pred: 't0', succ: 't1' }, { pred: 't1', succ: 't2' }] });
  const before = JSON.stringify(net.result());
  assert.throws(() => net.apply({ op: 'addLink', link: { pred: 't2', succ: 't0' } }), (e: ScheduleError) => {
    assert.equal(e.code, 'CYCLE');
    const path = (e.detail as { path: string[] }).path;
    assert.deepEqual(path, ['t0', 't1', 't2', 't0']);
    return true;
  });
  assert.equal(JSON.stringify(net.result()), before);
  void D;
});
