import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formula, zone } from '../src/index.ts';
const { evaluate, FormulaError } = formula;

test('formula: arithmetic, precedence, strings, conditionals, functions', () => {
  assert.equal(evaluate('1 + 2 * 3'), 7);
  assert.equal(evaluate('(1 + 2) * 3'), 9);
  assert.equal(evaluate('-2 * -3'), 6);
  assert.equal(evaluate('ROUND(budget / hours, 2)', { budget: 1000, hours: 3 }), 333.33);
  assert.equal(evaluate('pct >= 0.5 ? "late" : "ok"', { pct: 0.7 }), 'late');
  assert.equal(evaluate('CONCAT(UPPER(a), "-", b + 1)', { a: 'x', b: 1 }), 'X-2');
  assert.equal(evaluate('COALESCE(missing, 5)'), 5);
  assert.equal(evaluate('MAX(1, 9, 3) - MIN(4, 2)'), 7);
  assert.equal(evaluate('a && !b || c', { a: true, b: true, c: false }), false);
});

test('formula: sandbox - no host access, no prototype reach, bounded work', () => {
  for (const bad of ['process.exit(1)', 'this.constructor', 'a.b', 'eval("1")', 'require("fs")', 'a[0]', 'a = 1', '1; 2', 'a.constructor.constructor("return 1")()'])
    assert.throws(() => evaluate(bad, { a: 1 }), (e: unknown) => e instanceof FormulaError, bad);
  for (const name of ['constructor', '__proto__', 'globalThis', 'process', 'prototype']) assert.equal(evaluate(name), null, name); // bare names are only ever data lookups
  assert.equal(evaluate('toString', {}), null);
  assert.throws(() => evaluate('(' .repeat(100) + '1' + ')'.repeat(100)), (e: InstanceType<typeof FormulaError>) => e.code === 'LIMIT');
  assert.throws(() => evaluate('1'.repeat(3000)), (e: InstanceType<typeof FormulaError>) => e.code === 'LIMIT');
  const big = Array.from({ length: 2600 }, () => '1').join('+');
  assert.throws(() => evaluate(big), (e: InstanceType<typeof FormulaError>) => e.code === 'LIMIT');
  assert.throws(() => evaluate('1/0'), (e: InstanceType<typeof FormulaError>) => e.code === 'DIV_ZERO');
  assert.throws(() => evaluate('"a" * 2'), (e: InstanceType<typeof FormulaError>) => e.code === 'TYPE');
});

test('zone: UTC <-> naive local across DST (Europe/London, America/New_York, no-DST Africa/Accra)', () => {
  const tz = 'Europe/London';
  const utc = (y: number, m: number, d: number, h: number, mi = 0) => Date.UTC(y, m - 1, d, h, mi);
  assert.equal(zone.utcToLocal(utc(2026, 1, 15, 12), tz), utc(2026, 1, 15, 12));       // GMT
  assert.equal(zone.utcToLocal(utc(2026, 7, 15, 12), tz), utc(2026, 7, 15, 13));       // BST
  assert.equal(zone.localToUtc(utc(2026, 7, 15, 13), tz), utc(2026, 7, 15, 12));
  // spring forward 2026-03-29 01:00 UTC: local 01:30 does not exist -> resolved forward to 02:00 BST == 01:00 UTC
  const gap = zone.localToUtc(utc(2026, 3, 29, 1, 30), tz);
  assert.equal(zone.utcToLocal(gap, tz), utc(2026, 3, 29, 2, 30)); // normalised to a valid wall time after the gap
  // autumn back 2026-10-25 02:00 BST -> 01:00 GMT: local 01:30 occurs twice -> first occurrence (00:30 UTC)
  assert.equal(zone.localToUtc(utc(2026, 10, 25, 1, 30), tz), utc(2026, 10, 25, 0, 30));
  assert.equal(zone.localToUtc(utc(2026, 10, 25, 3, 0), tz), utc(2026, 10, 25, 3, 0));
  // round trip for every hour of a year (non-gap, non-fold instants)
  let n = 0;
  for (let t = utc(2026, 1, 1, 0); t < utc(2027, 1, 1, 0); t += 3_600_000 * 7) {
    for (const z of ['Europe/London', 'America/New_York', 'Africa/Accra', 'Australia/Lord_Howe']) {
      const local = zone.utcToLocal(t, z), back = zone.localToUtc(local, z);
      assert.equal(zone.utcToLocal(back, z), local, `${z} ${new Date(t).toISOString()}`); // wall time is preserved
      assert.ok(back <= t && t - back <= 3_600_000, 'only a fold may map to the earlier occurrence'); n++;
    }
  }
  assert.ok(n > 5000);
  assert.equal(zone.offsetAt(utc(2026, 6, 1, 0), 'Africa/Accra'), 0);
});
