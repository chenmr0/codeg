/** One changed-file resolution pass; no SQL, source reads or per-ref timers. */
const emptyTimings = () => ({
  loadRefsMs: 0, fileNamesLoadMs: 0, fileNamesSetMs: 0,
  symbolNamesLoadMs: 0, symbolNamesSetMs: 0, nameProbeMs: 0, normalizeMs: 0,
  matchMs: 0, edgeBuildMs: 0, edgeInsertMs: 0,
  resolvedCleanupMs: 0, failedCleanupMs: 0,
});
export type ResolutionTimingPhase = keyof ReturnType<typeof emptyTimings>;

export class ResolutionDiagnostics {
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
  cache: 'unknown' | 'cold' | 'warm' = 'unknown';
  complete = false;
  failedPhase: ResolutionTimingPhase | 'none' = 'none';

  measure<T>(phase: ResolutionTimingPhase, operation: () => T): T {
    const started = performance.now();
    try { return operation(); }
    catch (error) { this.failedPhase = phase; throw error; }
    finally { this.timings[phase] += performance.now() - started; }
  }

  format(): string {
    const counts = { scope: 'changed', complete: this.complete, failedPhase: this.failedPhase,
      files: this.files, refs: this.refs, resolved: this.resolved, unresolved: this.unresolved,
      edges: this.edges, cache: this.cache, knownFiles: this.knownFiles, knownNames: this.knownNames,
      nameLookup: this.nameLookup, nameQueries: this.nameQueries,
      nameCacheHits: this.nameCacheHits, nameCacheEntries: this.nameCacheEntries };
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
