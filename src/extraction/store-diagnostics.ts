/** Verbose-only attribution of the existing synchronous sync store path. */
export class StoreDiagnostics {
  readonly timings = {
    canonicalMs: 0, hashMs: 0, lookupMs: 0, retryStateMs: 0,
    snapshotMs: 0, deleteMs: 0, nodesMs: 0, edgesMs: 0, refsMs: 0,
    rewireMs: 0, fileMs: 0, retainMs: 0,
  };
  files = 0;
  skipped = 0;
  nodeRows = 0;
  edgeRows = 0;
  refRows = 0;
  retainedFiles = 0;
  failedPhase: keyof StoreDiagnostics['timings'] | 'none' = 'none';

  add(other: StoreDiagnosticsSnapshot): void {
    for (const phase of Object.keys(this.timings) as Array<keyof typeof this.timings>) {
      this.timings[phase] += other.timings[phase];
    }
    for (const count of ['files', 'skipped', 'nodeRows', 'edgeRows', 'refRows', 'retainedFiles'] as const) this[count] += other[count];
    if (other.failedPhase !== 'none') this.failedPhase = other.failedPhase;
  }

  measure<T>(phase: keyof StoreDiagnostics['timings'], operation: () => T): T {
    const started = performance.now();
    try { return operation(); }
    catch (error) { this.failedPhase = phase; throw error; }
    finally { this.timings[phase] += performance.now() - started; }
  }

  format(): string {
    return Object.entries({ files: this.files, skipped: this.skipped,
      nodeRows: this.nodeRows, edgeRows: this.edgeRows, refRows: this.refRows, retainedFiles: this.retainedFiles,
      failedPhase: this.failedPhase }).map(([key, value]) => `${key}=${value}`).concat(
      Object.entries(this.timings).map(([key, value]) => `${key}=${Math.round(value)}ms`),
    ).join(' ');
  }
}

export type StoreDiagnosticsSnapshot = Pick<StoreDiagnostics,
  'timings' | 'files' | 'skipped' | 'nodeRows' | 'edgeRows' | 'refRows' | 'retainedFiles' | 'failedPhase'>;

export function measureStore<T>(diagnostics: StoreDiagnostics | undefined,
  phase: keyof StoreDiagnostics['timings'], operation: () => T): T {
  return diagnostics ? diagnostics.measure(phase, operation) : operation();
}
