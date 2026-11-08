// Earned Value Management. Formulas follow the PMI / ANSI-EIA-748 definitions:
//   EV (BCWP) = percentComplete x BAC       <-- NOT actual cost (legacy ProjectLibre defect: bcwp() returned ACWP)
//   PV (BCWS) = planned value to status date
//   AC (ACWP) = actual cost to status date
export interface EvmInput { bac: number; pv: number; ev: number; ac: number }
export interface EvmResult {
  sv: number; cv: number; spi: number | null; cpi: number | null;
  eacCpi: number | null; eacCpiSpi: number | null; eacAtypical: number; etc: number | null; vac: number | null; tcpiBac: number | null;
}
const div = (a: number, b: number): number | null => (b === 0 ? null : a / b);

/** earned value from percent complete (0..1) and budget at completion */
export function earnedValue(bac: number, percentComplete: number): number {
  if (percentComplete < 0 || percentComplete > 1) throw new RangeError('percentComplete must be within [0,1]');
  return bac * percentComplete;
}

export function evm({ bac, pv, ev, ac }: EvmInput): EvmResult {
  const cpi = div(ev, ac), spi = div(ev, pv);
  const eacCpi = cpi === null || cpi === 0 ? null : bac / cpi;
  const eacCpiSpi = cpi === null || spi === null || cpi * spi === 0 ? null : ac + (bac - ev) / (cpi * spi);
  const eacAtypical = ac + (bac - ev);
  return {
    sv: ev - pv, cv: ev - ac, spi, cpi,
    eacCpi, eacCpiSpi, eacAtypical,
    etc: eacCpi === null ? null : eacCpi - ac,
    vac: eacCpi === null ? null : bac - eacCpi,
    tcpiBac: div(bac - ev, bac - ac),
  };
}
