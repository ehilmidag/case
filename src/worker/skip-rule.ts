// Bölüm 9.3's skip rule, extracted to a pure function so it can be tested directly (see
// skip-rule.property.spec.ts) without needing a running BatchProcessorService.
export type SkipFilterState = {
  cell: string;
  stable: boolean;
  evalTs: number | null;
};

export function shouldSkipEvaluation(
  filter: SkipFilterState | null,
  point: { ts: number },
  cell: string,
  isUniformCell: boolean,
  forceEvalMs: number,
): filter is SkipFilterState {
  return (
    filter !== null &&
    cell === filter.cell &&
    isUniformCell &&
    filter.stable &&
    filter.evalTs !== null &&
    point.ts - filter.evalTs < forceEvalMs
  );
}
