// Test registration + assertions with request/response context + metric/observation recording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync } from 'node:fs';
import type { Res } from './harness.ts';

const DATA = new URL('../reports/data/', import.meta.url).pathname;
mkdirSync(DATA, { recursive: true });

/** Register a test: stable id, title, and the spec clauses it verifies (for the traceability matrix). */
export function tc(id: string, refs: string[], title: string, fn: (t: any) => Promise<void> | void, opts: Record<string, unknown> = {}) {
  return test(`${id} | ${title} | refs: ${refs.join('; ')}`, opts, async (t) => { currentId = id; await fn(t); });
}
let currentId = '';
export function record(kind: 'obs' | 'metric', key: string, value: unknown, id = currentId) {
  appendFileSync(DATA + 'records.jsonl', JSON.stringify({ kind, id, key, value, at: new Date().toISOString() }) + '\n');
}
export const obs = (text: string) => record('obs', 'observation', text);

const short = (s: string, n = 700) => (s.length > n ? s.slice(0, n) + `...(${s.length} chars)` : s);
export function ctx(r: Res) { return `\n  request:  ${r.req}\n  response: HTTP ${r.status} ${short(r.text)}`; }
export function status(r: Res, expected: number | number[], msg = '') {
  const ok = Array.isArray(expected) ? expected.includes(r.status) : r.status === expected;
  assert.ok(ok, `${msg} expected HTTP ${Array.isArray(expected) ? expected.join('|') : expected}, got ${r.status}${ctx(r)}`);
}
export function problem(r: Res, st: number | number[], code: string | string[], msg = '') {
  status(r, st, msg);
  const ct = r.headers.get('content-type') ?? '';
  assert.ok(/^application\/problem\+json/.test(ct), `${msg} expected content-type application/problem+json, got "${ct}"${ctx(r)}`);
  const codes = Array.isArray(code) ? code : [code];
  assert.ok(r.body && codes.includes(r.body.code), `${msg} expected problem code ${codes.join('|')}, got ${r.body?.code}${ctx(r)}`);
  assert.equal(r.body.status, r.status, `${msg} problem.status must equal HTTP status${ctx(r)}`);
  assert.ok(typeof r.body.traceId === 'string' && r.body.traceId.length > 0, `${msg} problem.traceId missing${ctx(r)}`);
}
export const eq = (actual: unknown, expected: unknown, msg: string) => assert.deepStrictEqual(actual, expected, msg);
export const ok = (v: unknown, msg: string) => assert.ok(v, msg);
export { assert };

/** Run `n` async jobs with limited concurrency. */
export async function pool<T>(items: T[], n: number, fn: (x: T, i: number) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { for (;;) { const k = i++; if (k >= items.length) return; await fn(items[k], k); } }));
}
export const pct = (arr: number[], p: number) => { const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))]; };
