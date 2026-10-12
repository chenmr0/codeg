/** Opt-in, per-sync numeric counters. Never stores paths, names or error text. */
export type SyncDiagnosticGroup = 'stages' | 'extraction' | 'store' | 'worker' | 'wal' | 'refs';
export type SyncDiagnosticPhase = 'preflight' | 'extraction' | 'prepare' | 'changedRefs' | 'resurrectedRefs' | 'failedRetry' | 'fallback' | 'synthesis' | 'chained' | 'maintenance' | 'finalize' | 'cleanup';
export class SyncDiagnosticsSummary {
  private readonly started = performance.now();
  private readonly groups: Record<SyncDiagnosticGroup, Record<string, number>> = {
    stages: {}, extraction: {}, store: {}, worker: {}, wal: {}, refs: {},
  };
  phase: SyncDiagnosticPhase = 'preflight';
  add(group: SyncDiagnosticGroup, key: string, value: number): void {
    // Call sites use fixed keys only. Refuse accidental free-form text/numbers.
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key) || !Number.isFinite(value) || value < 0) return;
    this.groups[group][key] = (this.groups[group][key] ?? 0) + value;
  }
  max(group: SyncDiagnosticGroup, key: string, value: number): void {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key) || !Number.isFinite(value) || value < 0) return;
    this.groups[group][key] = Math.max(this.groups[group][key] ?? 0, value);
  }
  last(group: SyncDiagnosticGroup, key: string, value: number): void {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key) || !Number.isFinite(value) || value < 0) return;
    this.groups[group][key] = value;
  }
  /** Observes an existing setImmediate await; does not introduce a probe/timer. */
  recordReferenceYield(scope: SyncDiagnosticPhase, elapsedMs: number): void {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return;
    this.add('refs', scope + 'YieldMs', elapsedMs);
    this.add('refs', scope + 'YieldCount', 1);
    this.max('refs', scope + 'YieldMaxMs', elapsedMs);
    const bucket = elapsedMs <= 1 ? 'Le1' : elapsedMs <= 10 ? 'Gt1Le10' :
      elapsedMs <= 50 ? 'Gt10Le50' : elapsedMs <= 250 ? 'Gt50Le250' : 'Gt250';
    this.add('refs', scope + 'Yield' + bucket + 'Count', 1);
  }
  measure<T>(group: SyncDiagnosticGroup, key: string, operation: () => T): T {
    const start = performance.now();
    try { return operation(); } finally { this.add(group, key, performance.now() - start); }
  }
  async measureAsync<T>(group: SyncDiagnosticGroup, key: string, operation: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try { return await operation(); } finally { this.add(group, key, performance.now() - start); }
  }
  lines(outcome: 'running' | 'success' | 'incomplete' | 'error' | 'lockUnavailable', phaseElapsedMs?: number): string[] {
    return [
      `[sync-summary] schema=1 outcome=${outcome} wallMs=${Math.round(performance.now() - this.started)}` +
        (phaseElapsedMs === undefined ? '' : ` phase=${this.phase} phaseElapsedMs=${Math.round(Math.max(0, phaseElapsedMs))}`),
      ...Object.entries(this.groups).map(([group, values]) => `[sync-summary] ${group} ` +
        Object.entries(values).filter(([, value]) => Math.round(value) !== 0)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => `${key}=${Math.round(value)}`).join(' ')),
      '[sync-summary] units=millisecondsExceptCounts relation=inclusiveNestedNotAdditive',
    ];
  }
}
