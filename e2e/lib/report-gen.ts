// Turns reports/data/raw.ndjson (+ records.jsonl, engine.json) into junit.xml, results.json, report.md, report.html, traceability.md, defects.md.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { SUITES } from './suites.ts';
import { DEFECTS } from './defects.ts';
import { CORRECTIONS } from './corrections.ts';
import { COVERAGE_NOTES, REQ_TESTS } from './coverage-notes.ts';

const OUT = new URL('../reports/', import.meta.url).pathname;
const read = (f: string) => (existsSync(OUT + f) ? readFileSync(OUT + f, 'utf8') : '');
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const xmlEsc = (s: unknown) => esc(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '?');

interface Tc { id: string; suite: string; title: string; refs: string[]; status: 'pass' | 'fail' | 'skip'; ms: number; message?: string; stack?: string; defects: string[] }
const events = read('data/raw.ndjson').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const records = read('data/records.jsonl').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const meta = existsSync(OUT + 'data/meta.json') ? JSON.parse(read('data/meta.json')) : {};
const engine = existsSync(OUT + 'data/engine.json') ? JSON.parse(read('data/engine.json')) : null;

const tests: Tc[] = []; const hookFailures: any[] = []; const stderrs: string[] = [];
for (const e of events) {
  if (e.t === 'stderr') { stderrs.push(e.message); continue; }
  if (e.t !== 'pass' && e.t !== 'fail') continue;
  const m = /^(E2E-([A-Z]+)-[A-Za-z0-9-]+) \| (.*?) \| refs: (.*)$/.exec(e.name);
  if (!m) { if (e.t === 'fail') hookFailures.push(e); continue; }
  tests.push({ id: m[1], suite: m[2], title: m[3], refs: m[4].split('; ').filter(Boolean), status: e.t === 'fail' ? 'fail' : e.skip || e.todo ? 'skip' : 'pass', ms: e.ms, message: e.message, stack: e.stack, defects: [] });
}
for (const d of DEFECTS) for (const id of d.tests) { const t = tests.find((x) => x.id === id); if (t) t.defects.push(d.id); }
const failed = tests.filter((t) => t.status === 'fail');
const untriaged = failed.filter((t) => t.defects.length === 0);
const reproduced = DEFECTS.filter((d) => d.tests.some((id) => tests.find((t) => t.id === id)?.status === 'fail'));
const notReproduced = DEFECTS.filter((d) => !reproduced.includes(d));
const totals = { total: tests.length, pass: tests.filter((t) => t.status === 'pass').length, fail: failed.length, skip: tests.filter((t) => t.status === 'skip').length };
const totalMs = tests.reduce((a, t) => a + t.ms, 0);
const sevOrder = ['S1', 'S2', 'S3', 'S4'];
const bySev = (list: typeof DEFECTS) => sevOrder.map((s) => `${s}: ${list.filter((d) => d.severity === s && d.kind !== 'spec-ambiguity').length}`).join(', ');
const suiteIds = Object.keys(SUITES);
const suiteStats = suiteIds.map((sid) => {
  const ts = tests.filter((t) => t.suite === sid);
  return { id: sid, ...SUITES[sid], total: ts.length, pass: ts.filter((t) => t.status === 'pass').length, fail: ts.filter((t) => t.status === 'fail').length, skip: ts.filter((t) => t.status === 'skip').length, ms: ts.reduce((a, t) => a + t.ms, 0), tests: ts };
});
const metrics = records.filter((r) => r.kind === 'metric');
const observations = records.filter((r) => r.kind === 'obs');
const startedAt = meta.startedAt ?? new Date().toISOString();

// ---- traceability ----
const refMap = new Map<string, Tc[]>();
for (const t of tests) for (const r of t.refs) (refMap.get(r) ?? refMap.set(r, []).get(r)!).push(t);
const refRows = [...refMap.entries()].sort((a, b) => a[0].localeCompare(b[0], 'en', { numeric: true })).map(([ref, ts]) => {
  const f = ts.filter((t) => t.status === 'fail').length, p = ts.filter((t) => t.status === 'pass').length;
  return { ref, ids: ts.map((t) => t.id), result: f ? (p ? 'PARTIAL' : 'FAIL') : 'PASS', pass: p, fail: f, total: ts.length };
});
// requirement catalogue from docs/03
const req = read('../../docs/03-requirements.md') || readFileSync(new URL('../../docs/03-requirements.md', import.meta.url), 'utf8');
const reqIds = [...new Set([...req.matchAll(/\b((?:FR|NFR)-[A-Z]+-\d+)\b/g)].map((m) => m[1]))];
const reqRows = reqIds.map((rid) => {
  const ts = [...new Set([...(refMap.get(rid) ?? []), ...tests.filter((t) => (REQ_TESTS[rid] ?? []).some((pre) => t.id.startsWith(pre)))])];
  const f = ts.filter((t) => t.status === 'fail').length;
  const status = !ts.length ? 'NOT COVERED' : f ? 'FAIL' : 'PASS';
  return { rid, status, ids: ts.map((t) => t.id), note: COVERAGE_NOTES[rid] ?? (ts.length ? '' : 'No e2e test (not API-observable in the reference server or out of campaign scope)') };
});

// ---- results.json ----
const results = {
  generatedAt: new Date().toISOString(), startedAt, node: process.version, totals, durationMsSum: Math.round(totalMs),
  engineUnitTests: engine, defectsReproduced: reproduced.map((d) => d.id), defectsNotReproduced: notReproduced.map((d) => d.id), untriagedFailures: untriaged.map((t) => t.id),
  suites: suiteStats.map((s) => ({ id: s.id, name: s.name, total: s.total, pass: s.pass, fail: s.fail, skip: s.skip, ms: Math.round(s.ms) })),
  tests: tests.map((t) => ({ id: t.id, suite: t.suite, title: t.title, refs: t.refs, status: t.status, ms: Math.round(t.ms), defects: t.defects, message: t.message })),
  defects: DEFECTS.map((d) => ({ ...d, reproduced: reproduced.includes(d) })), metrics, observations, hookFailures: hookFailures.map((h) => ({ name: h.name, message: h.message })),
  requirements: reqRows,
};
writeFileSync(OUT + 'results.json', JSON.stringify(results, null, 2));

// ---- junit.xml ----
let junit = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="PlanForge e2e" tests="${totals.total}" failures="${totals.fail}" skipped="${totals.skip}" time="${(totalMs / 1000).toFixed(3)}">\n`;
for (const s of suiteStats) {
  junit += `  <testsuite name="${xmlEsc(s.id + ' - ' + s.name)}" tests="${s.total}" failures="${s.fail}" skipped="${s.skip}" time="${(s.ms / 1000).toFixed(3)}" timestamp="${startedAt}">\n`;
  for (const t of s.tests) {
    junit += `    <testcase classname="${xmlEsc(s.id)}" name="${xmlEsc(t.id + ' ' + t.title)}" time="${(t.ms / 1000).toFixed(3)}">\n`;
    junit += `      <properties><property name="refs" value="${xmlEsc(t.refs.join('; '))}"/>${t.defects.length ? `<property name="defects" value="${xmlEsc(t.defects.join(','))}"/>` : ''}</properties>\n`;
    if (t.status === 'fail') junit += `      <failure message="${xmlEsc((t.message ?? '').split('\n')[0].slice(0, 300))}" type="AssertionError">${xmlEsc(t.message + '\n' + (t.stack ?? ''))}</failure>\n`;
    if (t.status === 'skip') junit += `      <skipped/>\n`;
    junit += `    </testcase>\n`;
  }
  junit += `  </testsuite>\n`;
}
junit += `</testsuites>\n`;
writeFileSync(OUT + 'junit.xml', junit);

// ---- traceability.md ----
let tm = `# Traceability matrix\n\nGenerated ${results.generatedAt}. Result per clause: PASS = all linked tests passed, FAIL = all failed, PARTIAL = mixed.\n\n## Requirements (docs/03)\n\n| Requirement | Result | Tests | Note |\n|---|---|---|---|\n`;
for (const r of reqRows) tm += `| ${r.rid} | ${r.status} | ${r.ids.join(', ') || '-'} | ${r.note} |\n`;
tm += `\n## Spec clauses -> tests\n\n| Spec clause | Result | Pass/Total | Test ids |\n|---|---|---|---|\n`;
for (const r of refRows) tm += `| ${r.ref} | ${r.result} | ${r.pass}/${r.total} | ${r.ids.join(', ')} |\n`;
writeFileSync(OUT + 'traceability.md', tm);

// ---- defects.md ----
const evidence = (d: (typeof DEFECTS)[number]) => d.tests.map((id) => tests.find((t) => t.id === id)).filter((t) => t && t.status === 'fail').map((t) => `- \`${t!.id}\`: ${(t!.message ?? '').trim().replace(/\n/g, '\n  ')}`).join('\n') || '- (linked tests passed in this run)';
let dm = `# Defects and findings\n\nGenerated ${results.generatedAt}. Severity: S1 data leak / cross-tenant / authz bypass / corruption / wrong dates; S2 spec violation or wrong status/code; S3 minor/inconsistent; S4 cosmetic/doc.\n\n**Reproduced defects in this run: ${reproduced.filter((d) => d.kind !== 'spec-ambiguity').length}** (${bySev(reproduced)}). Spec ambiguities: ${DEFECTS.filter((d) => d.kind === 'spec-ambiguity').length}.\n\n`;
if (untriaged.length) dm += `> UNTRIAGED FAILURES (failing tests not yet linked to a defect): ${untriaged.map((t) => t.id).join(', ')}\n\n`;
dm += `| ID | Sev | Kind | Title | Tests |\n|---|---|---|---|---|\n` + DEFECTS.map((d) => `| ${d.id} | ${d.severity} | ${d.kind ?? 'defect'} | ${d.title} | ${d.tests.join(', ')} |`).join('\n') + '\n\n';
for (const d of [...DEFECTS].sort((a, b) => a.severity.localeCompare(b.severity) || a.id.localeCompare(b.id))) {
  dm += `## ${d.id} [${d.severity}] ${d.kind === 'spec-ambiguity' ? '(SPEC AMBIGUITY) ' : ''}${d.title}\n\n- **Spec reference:** ${d.spec}\n- **Status this run:** ${reproduced.includes(d) ? 'REPRODUCED' : 'NOT REPRODUCED (linked tests passed)'}\n- **Tests:** ${d.tests.join(', ')}\n\n**Steps to reproduce**\n\n${d.steps}\n\n**Expected:** ${d.expected}\n\n**Actual:** ${d.actual}\n\n**Evidence (from this run)**\n\n${evidence(d)}\n\n`;
}
writeFileSync(OUT + 'defects.md', dm);

// ---- report.md ----
let md = `# PlanForge reference server - e2e test report\n\n- Generated: ${results.generatedAt} (run started ${startedAt})\n- Node ${process.version}; database \`${meta.db ?? 'planforge_e2e'}\`; server: child process \`server/src/main.ts\`\n- Re-run: \`cd /home/claude/planforge/e2e && npm test\`\n\n## Totals\n\n| Total | Pass | Fail | Skip |\n|---:|---:|---:|---:|\n| ${totals.total} | ${totals.pass} | ${totals.fail} | ${totals.skip} |\n\n`;
if (engine) md += `Engine unit tests (author's \`cd engine && npm test\`, recorded once): ${engine.pass} pass / ${engine.fail} fail of ${engine.tests} (exit ${engine.exit}).\n\n`;
md += `## Suites\n\n| Suite | Name | Pass | Fail | Skip | Time (s) |\n|---|---|---:|---:|---:|---:|\n` + suiteStats.map((s) => `| ${s.id} | ${s.name} | ${s.pass} | ${s.fail} | ${s.skip} | ${(s.ms / 1000).toFixed(1)} |`).join('\n') + '\n\n';
md += `## Defects\n\nReproduced: ${reproduced.filter((d) => d.kind !== 'spec-ambiguity').length} (${bySev(reproduced)}).${untriaged.length ? ` UNTRIAGED failing tests: ${untriaged.map((t) => t.id).join(', ')}.` : ''}${notReproduced.length ? ` Registered but not reproduced this run: ${notReproduced.map((d) => d.id).join(', ')}.` : ''}\n\n| ID | Sev | Title |\n|---|---|---|\n` + DEFECTS.map((d) => `| ${d.id} | ${d.severity}${d.kind === 'spec-ambiguity' ? ' (ambiguity)' : ''} | ${d.title} |`).join('\n') + '\n\nFull detail: `defects.md`.\n\n';
if (metrics.length) md += `## Measurements\n\n| Test | Metric | Value |\n|---|---|---|\n` + metrics.map((m) => `| ${m.id} | ${m.key} | ${typeof m.value === 'object' ? JSON.stringify(m.value) : m.value} |`).join('\n') + '\n\n';
if (observations.length) md += `## Observations (not pass/fail; unspecified behaviour or notes)\n\n` + observations.map((o) => `- \`${o.id}\`: ${o.value}`).join('\n') + '\n\n';
md += `## Test-code corrections\n\nChanges made to the test code (never the product) after a first run to correct my own errors or expectations:\n\n` + (CORRECTIONS.length ? CORRECTIONS.map((c) => `- ${c}`).join('\n') : '- none recorded') + '\n\n';
md += `## Requirement coverage\n\n| Requirement | Status |\n|---|---|\n` + reqRows.map((r) => `| ${r.rid} | ${r.status}${r.note ? ' - ' + r.note : ''} |`).join('\n') + '\n\n';
if (hookFailures.length) md += `## Setup/teardown failures\n\n` + hookFailures.map((h) => `- ${h.name}: ${h.message}`).join('\n') + '\n\n';
writeFileSync(OUT + 'report.md', md);

// ---- report.html ----
const badge = (s: string) => `<span class="b ${s}">${s.toUpperCase()}</span>`;
let html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PlanForge e2e test report</title><style>
:root{--ink:#1c2430;--mut:#5d6b7c;--line:#d9dfe7;--bg:#f6f8fb;--ok:#127a3e;--bad:#b3261e;--skip:#8a6d00;--card:#fff}
*{box-sizing:border-box}body{font:14px/1.5 system-ui,Segoe UI,Roboto,sans-serif;color:var(--ink);background:var(--bg);margin:0}
main{max-width:1180px;margin:0 auto;padding:24px 16px 64px}h1{margin:0 0 4px;font-size:26px}h2{margin:32px 0 10px;font-size:19px;border-bottom:2px solid var(--line);padding-bottom:4px}
.mut{color:var(--mut)}.cards{display:flex;gap:12px;flex-wrap:wrap;margin:16px 0}.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 18px;min-width:120px}
.card b{display:block;font-size:26px}.ok{color:var(--ok)}.bad{color:var(--bad)}.sk{color:var(--skip)}
table{border-collapse:collapse;width:100%;background:var(--card);border:1px solid var(--line);font-size:13px}th,td{padding:6px 9px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{background:#eef2f7}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}.b{display:inline-block;padding:0 7px;border-radius:9px;font-size:11px;font-weight:700;color:#fff}.b.pass{background:var(--ok)}.b.fail{background:var(--bad)}.b.skip{background:var(--skip)}
.b.PASS{background:var(--ok)}.b.FAIL{background:var(--bad)}.b.PARTIAL{background:var(--skip)}.b.NOTCOVERED{background:#6b7785}
details{background:var(--card);border:1px solid var(--line);border-radius:8px;margin:8px 0;padding:6px 12px}summary{cursor:pointer;font-weight:600}
pre{white-space:pre-wrap;word-break:break-word;background:#f1f3f6;border-radius:6px;padding:8px;font-size:12px;margin:6px 0}code{font-size:12px}
.btn{position:fixed;top:14px;right:16px;background:#1d4ed8;color:#fff;border:0;border-radius:6px;padding:9px 16px;font-size:14px;font-weight:600;cursor:pointer;z-index:9;box-shadow:0 2px 6px rgba(0,0,0,.2)}
.sev{font-weight:700}.S1,.S2{color:var(--bad)}.S3{color:var(--skip)}
@media print{.btn{display:none}body{background:#fff;font-size:11px}main{max-width:none;padding:0}details{border:0;padding:0}details>*{display:block!important}h2{break-after:avoid}tr,details{break-inside:avoid}.card{break-inside:avoid}a{color:inherit;text-decoration:none}}
@page{size:A4;margin:12mm}
</style></head><body><button class="btn" onclick="window.print()" aria-label="Download PDF">Download PDF</button><main>
<h1>PlanForge reference server - e2e test report</h1><div class="mut">Generated ${esc(results.generatedAt)} &middot; Node ${esc(process.version)} &middot; DB <code>${esc(meta.db ?? 'planforge_e2e')}</code> &middot; re-run: <code>cd e2e &amp;&amp; npm test</code></div>
<div class="cards"><div class="card"><b>${totals.total}</b>tests</div><div class="card"><b class="ok">${totals.pass}</b>passed</div><div class="card"><b class="bad">${totals.fail}</b>failed</div><div class="card"><b class="sk">${totals.skip}</b>skipped</div><div class="card"><b>${reproduced.filter((d) => d.kind !== 'spec-ambiguity').length}</b>defects<br><span class="mut">${esc(bySev(reproduced))}</span></div><div class="card"><b>${(totalMs / 1000).toFixed(0)}s</b>test time</div></div>
${untriaged.length ? `<p class="bad"><b>UNTRIAGED FAILURES:</b> ${esc(untriaged.map((t) => t.id).join(', '))}</p>` : ''}
${engine ? `<p class="mut">Engine unit tests (author's suite, recorded once): <b>${engine.pass}/${engine.tests}</b> pass.</p>` : ''}
<h2>Suites</h2><table><tr><th>Suite</th><th>Name</th><th>Scope</th><th class="n">Pass</th><th class="n">Fail</th><th class="n">Skip</th><th class="n">Time (s)</th></tr>
${suiteStats.map((s) => `<tr><td><a href="#s-${s.id}">${s.id}</a></td><td>${esc(s.name)}</td><td class="mut">${esc(s.desc)}</td><td class="n ok">${s.pass}</td><td class="n ${s.fail ? 'bad' : ''}">${s.fail}</td><td class="n">${s.skip}</td><td class="n">${(s.ms / 1000).toFixed(1)}</td></tr>`).join('')}</table>
<h2>Defects</h2>${DEFECTS.length ? `<table><tr><th>ID</th><th>Sev</th><th>Title</th><th>Spec</th><th>Status</th><th>Tests</th></tr>${DEFECTS.map((d) => `<tr><td><a href="#d-${d.id}">${d.id}</a></td><td class="sev ${d.severity}">${d.severity}</td><td>${esc(d.title)}${d.kind === 'spec-ambiguity' ? ' <i class="mut">(spec ambiguity)</i>' : ''}</td><td>${esc(d.spec)}</td><td>${reproduced.includes(d) ? '<span class="bad">reproduced</span>' : 'not reproduced'}</td><td>${esc(d.tests.join(', '))}</td></tr>`).join('')}</table>` : '<p>None registered.</p>'}
${[...DEFECTS].sort((a, b) => a.severity.localeCompare(b.severity)).map((d) => `<details id="d-${d.id}"><summary><span class="sev ${d.severity}">${d.severity}</span> ${d.id} - ${esc(d.title)}</summary><p><b>Spec:</b> ${esc(d.spec)}</p><p><b>Steps:</b></p><pre>${esc(d.steps)}</pre><p><b>Expected:</b> ${esc(d.expected)}</p><p><b>Actual:</b> ${esc(d.actual)}</p><p><b>Evidence:</b></p><pre>${esc(evidence(d))}</pre></details>`).join('')}
${suiteStats.map((s) => `<h2 id="s-${s.id}">${s.id} - ${esc(s.name)} <span class="mut">(${s.pass}/${s.total} pass)</span></h2><table><tr><th>Test</th><th>Title</th><th>Spec refs</th><th>Result</th><th class="n">ms</th></tr>${s.tests.map((t) => `<tr><td><code>${t.id}</code></td><td>${esc(t.title)}${t.status === 'fail' ? `<details><summary class="bad">failure${t.defects.length ? ' (' + esc(t.defects.join(', ')) + ')' : ' (UNTRIAGED)'}</summary><pre>${esc(t.message)}</pre></details>` : ''}</td><td class="mut">${esc(t.refs.join('; '))}</td><td>${badge(t.status)}</td><td class="n">${t.ms.toFixed(0)}</td></tr>`).join('')}</table>`).join('')}
<h2>Requirement traceability</h2><table><tr><th>Requirement</th><th>Result</th><th>Tests</th><th>Note</th></tr>${reqRows.map((r) => `<tr><td>${r.rid}</td><td><span class="b ${r.status.replace(' ', '')}">${r.status}</span></td><td>${esc(r.ids.join(', ') || '-')}</td><td class="mut">${esc(r.note)}</td></tr>`).join('')}</table>
<h2>Spec clause traceability</h2><table><tr><th>Spec clause</th><th>Result</th><th class="n">Pass/Total</th><th>Tests</th></tr>${refRows.map((r) => `<tr><td>${esc(r.ref)}</td><td><span class="b ${r.result}">${r.result}</span></td><td class="n">${r.pass}/${r.total}</td><td class="mut">${esc(r.ids.join(', '))}</td></tr>`).join('')}</table>
${metrics.length ? `<h2>Measurements</h2><table><tr><th>Test</th><th>Metric</th><th>Value</th></tr>${metrics.map((m) => `<tr><td>${esc(m.id)}</td><td>${esc(m.key)}</td><td>${esc(typeof m.value === 'object' ? JSON.stringify(m.value) : m.value)}</td></tr>`).join('')}</table>` : ''}
${observations.length ? `<h2>Observations</h2><ul>${observations.map((o) => `<li><code>${esc(o.id)}</code> ${esc(o.value)}</li>`).join('')}</ul>` : ''}
<h2>Test-code corrections</h2><ul>${CORRECTIONS.length ? CORRECTIONS.map((c) => `<li>${esc(c)}</li>`).join('') : '<li>none recorded</li>'}</ul>
</main></body></html>`;
writeFileSync(OUT + 'report.html', html);
console.log(`reports written: ${totals.total} tests, ${totals.pass} pass, ${totals.fail} fail, ${totals.skip} skip; defects reproduced ${reproduced.length}; untriaged ${untriaged.length}`);
