/**
 * Edge adapter between real instants (UTC epoch ms) and the engine's "naive local" instants (wall clock of the
 * project's IANA time zone encoded as if it were UTC). Keeps all DST handling out of the CPM kernels.
 *   gap  (spring forward, local time does not exist)  -> resolved forward to the first valid instant after the gap
 *   fold (autumn back, local time occurs twice)        -> resolved to the FIRST occurrence (earlier offset)
 */
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    fmtCache.set(tz, f);
  }
  return f;
}

/** offset in ms (local - utc) of the zone at a real instant */
export function offsetAt(utcMs: number, tz: string): number {
  const p: Record<string, number> = {};
  for (const x of fmt(tz).formatToParts(new Date(Math.floor(utcMs / 1000) * 1000))) if (x.type !== 'literal') p[x.type] = Number(x.value);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

export function utcToLocal(utcMs: number, tz: string): number { return utcMs + offsetAt(utcMs, tz); }

export function localToUtc(localMs: number, tz: string): number {
  // candidate offsets around the instant; a valid solution satisfies utc + offset(utc) == local
  const DAY = 86_400_000;
  const o1 = offsetAt(localMs - DAY, tz), o2 = offsetAt(localMs + DAY, tz);
  const sols = new Set<number>();
  for (const o of new Set([o1, o2])) {
    const u = localMs - o;
    if (u + offsetAt(u, tz) === localMs) sols.add(u);
  }
  if (sols.size) return Math.min(...sols); // fold: first occurrence
  // gap: the wall time was skipped; move forward by the size of the jump
  return localMs - Math.min(o1, o2);
}
