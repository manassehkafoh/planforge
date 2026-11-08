// One-command runner: reset DB, record engine unit result, run all suites with node:test (sequential), write reports.
import { spawnSync, execSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { createWriteStream } from 'node:fs';

const HERE = new URL('.', import.meta.url).pathname;
const ROOT = HERE + '../';
const DB = process.env.E2E_DB ?? 'planforge_e2e';
mkdirSync(HERE + 'reports/data', { recursive: true });
for (const f of ['raw.ndjson', 'records.jsonl', 'engine.json', 'meta.json']) rmSync(HERE + 'reports/data/' + f, { force: true });
const startedAt = new Date().toISOString();

if (!process.env.E2E_SKIP_RESET) {
  console.log(`[e2e] resetting database ${DB}`);
  const cmd = `PF_APP_PASSWORD=devpw-change-me PF_DB=${DB} ${ROOT}server/scripts/reset-dev.sh`;
  const r = process.getuid?.() === 0 ? spawnSync('su', ['postgres', '-c', cmd], { encoding: 'utf8' }) : spawnSync('bash', ['-c', cmd], { encoding: 'utf8' });
  if (r.status !== 0) { console.error('[e2e] DB reset failed (set E2E_SKIP_RESET=1 to use an existing DB):\n' + r.stderr + r.stdout); process.exit(2); }
}

if (!process.env.E2E_SKIP_ENGINE) {
  console.log('[e2e] engine unit tests (recorded once)');
  const r = spawnSync('npm', ['test'], { cwd: ROOT + 'engine', encoding: 'utf8' });
  const out = r.stdout + r.stderr; const n = (k: string) => Number(new RegExp(`^# ${k} (\\d+)`, 'm').exec(out)?.[1] ?? NaN);
  writeFileSync(HERE + 'reports/data/engine.json', JSON.stringify({ exit: r.status, tests: n('tests'), pass: n('pass'), fail: n('fail'), skipped: n('skipped') }));
  console.log(`[e2e] engine: ${n('pass')}/${n('tests')} pass`);
}
writeFileSync(HERE + 'reports/data/meta.json', JSON.stringify({ startedAt, db: DB }));

const files = readdirSync(HERE + 'suites').filter((f) => f.endsWith('.test.ts')).sort().map((f) => 'suites/' + f);
const only = process.env.E2E_ONLY ? files.filter((f) => f.includes(process.env.E2E_ONLY!)) : files;
const args = ['--test', '--test-concurrency=1', '--test-timeout=300000', '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=./lib/reporter.ts', '--test-reporter-destination=reports/data/raw.ndjson', ...only];
console.log('[e2e] running ' + only.length + ' suite files');
const t = spawnSync('node', args, { cwd: HERE, stdio: 'inherit' });
try { execSync('node lib/report-gen.ts', { cwd: HERE, stdio: 'inherit' }); } catch { console.error('[e2e] report generation failed'); process.exit(3); }
console.log('[e2e] reports in ' + HERE + 'reports/');
process.exit(process.env.E2E_ALLOW_FAIL ? 0 : t.status ?? 1);
