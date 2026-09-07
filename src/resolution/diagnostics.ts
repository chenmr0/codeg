/** One changed-file resolution pass; no SQL, source reads or per-ref timers. */
const emptyTimings = () => ({
  loadRefsMs: 0, fileNamesLoadMs: 0, fileNamesSetMs: 0,
  symbolNamesLoadMs: 0, symbolNamesSetMs: 0, nameProbeMs: 0, normalizeMs: 0,
  matchMs: 0, edgeBuildMs: 0, edgeInsertMs: 0,
  resolvedCleanupMs: 0, failedCleanupMs: 0,
});
export type ResolutionTimingPhase = keyof ReturnType<typeof emptyTimings>;

export class ResolutionDiagnostics {
  constructor(readonly scope: 'changed' | 'failed-retry' = 'changed') {}
  private readonly started = performance.now();
  readonly timings = emptyTimings();
  files = 0;
  refs = 0;
  resolved = 0;
  unresolved = 0;
  edges = 0;
  knownFiles = 0;
  knownNames: number | 'not-loaded' = 0;
  nameLookup: 'unknown' | 'full' | 'indexed' = 'unknown';
  nameQueries = 0;
  nameCacheHits = 0;
  nameCacheEntries = 0;
  namePromotion: 'none' | 'query-budget' | 'time-budget' = 'none';
  cache: 'unknown' | 'cold' | 'warm' = 'unknown';
  complete = false;
  failedPhase: ResolutionTimingPhase | 'none' = 'none';

  measure<T>(phase: ResolutionTimingPhase, operation: () => T): T {
    const started = performance.now();
    try { return operation(); }
    catch (error) {
      // Promotion is nested in matching: keep the innermost failing phase.
      if (this.failedPhase === 'none') this.failedPhase = phase;
      throw error;
    }
    finally { this.timings[phase] += performance.now() - started; }
  }

  /** Aggregate retry batches without emitting thousands of per-batch lines. */
  add(batch: ResolutionDiagnostics): void {
    if (this.refs === 0) this.cache = batch.cache;
    for (const key of ['refs', 'resolved', 'unresolved', 'edges', 'nameQueries', 'nameCacheHits'] as const) {
      this[key] += batch[key];
    }
    for (const key of Object.keys(this.timings) as ResolutionTimingPhase[]) this.timings[key] += batch.timings[key];
    this.knownFiles = batch.knownFiles;
    this.knownNames = batch.knownNames;
    this.nameLookup = batch.nameLookup;
    this.nameCacheEntries = batch.nameCacheEntries;
    if (batch.namePromotion !== 'none') this.namePromotion = batch.namePromotion;
    if (batch.failedPhase !== 'none') this.failedPhase = batch.failedPhase;
  }

  format(): string {
    const counts = { scope: this.scope, complete: this.complete, failedPhase: this.failedPhase,
      files: this.files, refs: this.refs, resolved: this.resolved, unresolved: this.unresolved,
      edges: this.edges, cache: this.cache, knownFiles: this.knownFiles, knownNames: this.knownNames,
      nameLookup: this.nameLookup, nameQueries: this.nameQueries,
      nameCacheHits: this.nameCacheHits, nameCacheEntries: this.nameCacheEntries, namePromotion: this.namePromotion };
    const timings = { ...this.timings, totalMs: performance.now() - this.started };
    return Object.entries(counts).map(([k, v]) => `${k}=${v}`).concat(
      Object.entries(timings).map(([k, v]) => `${k}=${Math.round(v)}ms`),
    ).join(' ');
  }
}

export function measureResolution<T>(diagnostics: ResolutionDiagnostics | undefined,
  phase: ResolutionTimingPhase, operation: () => T): T {
  return diagnostics ? diagnostics.measure(phase, operation) : operation();
}
