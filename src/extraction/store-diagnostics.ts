/** Verbose-only attribution of the existing synchronous sync store path. */
export class StoreDiagnostics {
  readonly timings = {
    canonicalMs: 0, hashMs: 0, lookupMs: 0, retryStateMs: 0,
    snapshotMs: 0, deleteMs: 0, nodesMs: 0, edgesMs: 0, refsMs: 0,
    rewireMs: 0, fileMs: 0,
  };
  files = 0;
  skipped = 0;
  nodeRows = 0;
  edgeRows = 0;
  refRows = 0;
  failedPhase: keyof StoreDiagnostics['timings'] | 'none' = 'none';

  measure<T>(phase: keyof StoreDiagnostics['timings'], operation: () => T): T {
    const started = performance.now();
    try { return operation(); }
    catch (error) { this.failedPhase = phase; throw error; }
    finally { this.timings[phase] += performance.now() - started; }
  }

  format(): string {
    return Object.entries({ files: this.files, skipped: this.skipped,
      nodeRows: this.nodeRows, edgeRows: this.edgeRows, refRows: this.refRows,
      failedPhase: this.failedPhase }).map(([key, value]) => `${key}=${value}`).concat(
      Object.entries(this.timings).map(([key, value]) => `${key}=${Math.round(value)}ms`),
    ).join(' ');
  }
}

export function measureStore<T>(diagnostics: StoreDiagnostics | undefined,
  phase: keyof StoreDiagnostics['timings'], operation: () => T): T {
  return diagnostics ? diagnostics.measure(phase, operation) : operation();
}
