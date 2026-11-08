// node:test custom reporter: streams a compact NDJSON event log that lib/report-gen.ts turns into JUnit/HTML/MD/JSON reports.
export default async function* reporter(source: AsyncIterable<any>) {
  for await (const ev of source) {
    const d = ev.data ?? {};
    if (ev.type === 'test:pass' || ev.type === 'test:fail') {
      if (d.details?.type === 'suite') continue;
      const err = d.details?.error;
      const cause = err?.cause ?? err;
      yield JSON.stringify({
        t: ev.type === 'test:pass' ? 'pass' : 'fail', name: d.name, nesting: d.nesting, file: d.file,
        ms: d.details?.duration_ms ?? 0, skip: d.skip ?? false, todo: d.todo ?? false,
        message: ev.type === 'test:fail' ? String(cause?.message ?? err?.message ?? err ?? 'failed') : undefined,
        stack: ev.type === 'test:fail' ? String(cause?.stack ?? '').split('\n').slice(0, 6).join('\n') : undefined,
      }) + '\n';
    } else if (ev.type === 'test:diagnostic') {
      yield JSON.stringify({ t: 'diag', message: d.message, file: d.file }) + '\n';
    } else if (ev.type === 'test:stderr' || ev.type === 'test:stdout') {
      // keep a trimmed copy of unexpected output for diagnostics
      yield JSON.stringify({ t: ev.type === 'test:stderr' ? 'stderr' : 'stdout', message: String(d.message).slice(0, 500), file: d.file }) + '\n';
    }
  }
}
