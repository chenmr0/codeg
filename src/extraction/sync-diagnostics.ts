/** Verbose-only, per-invocation diagnostics. No source paths or contents. */
export class ScanDiagnostics {
  mode: 'unknown' | 'git' | 'walk' | 'scoped' = 'unknown';
  fallbackReason: 'none' | 'codegraph-negation' | 'parent-gitignored' | 'git-path-error' = 'none';
  failureStage = 'none';
  gitCommandMs = 0;
  ignoreBuildMs = 0;
  filterCanonicalMs = 0;
  walkMs = 0;
  gitCommands = 0;
  gitCandidates = 0;
  sourceFiles = 0;
  walkDirectories = 0;

  format(): string {
    return `scan-detail mode=${this.mode} fallbackReason=${this.fallbackReason} failureStage=${this.failureStage} ` +
      formatMs({ gitCommandMs: this.gitCommandMs, ignoreBuildMs: this.ignoreBuildMs,
        filterCanonicalMs: this.filterCanonicalMs, walkMs: this.walkMs }) +
      ` gitCommands=${this.gitCommands} gitCandidates=${this.gitCandidates}` +
      ` sourceFiles=${this.sourceFiles} walkDirectories=${this.walkDirectories}`;
  }
}

/**
 * The five phases are disjoint. I/O timings are CHILDREN of changeCheckMs,
 * not additional phases. Scan details are children of enumerateMs; walkMs
 * includes nested ignore construction. Cooperative yields stay in their
 * enclosing phase. Construct only for verbose sync, never cache globally.
 */
export class ReconcileDiagnostics {
  scope: 'full' | 'scoped' | 'full-fallback' = 'full';
  readonly scan = new ScanDiagnostics();
  readonly phases = {
    enumerateMs: 0, loadTrackedMs: 0, buildLookupMs: 0, removalMs: 0, changeCheckMs: 0,
  };
  readonly io = { statMs: 0, readForHashMs: 0, hashMs: 0 };
  readonly counts = {
    currentFiles: 0, trackedFiles: 0,
    // Explicit reconciliation calls only, not calls inside scanner/helpers.
    existsChecks: 0, statChecks: 0, statUnchanged: 0, statErrors: 0,
    hashReadAttempts: 0, hashReadFiles: 0, hashReadErrors: 0,
    sameHashSkipped: 0, recoveryRetryFiles: 0,
    added: 0, modified: 0, removed: 0,
  };

  log(log: (message: string) => void, totalMs: number): void {
    log(this.scan.format());
    log(`reconcile-detail scope=${this.scope} ${formatMs(this.phases)} totalMs=${Math.round(totalMs)}ms`);
    log(`reconcile-io ${formatMs(this.io)}`);
    log(`reconcile-counts ${Object.entries(this.counts).map(([key, value]) => `${key}=${value}`).join(' ')}`);
  }
}

function formatMs(values: Record<string, number>): string {
  return Object.entries(values).map(([key, value]) => `${key}=${Math.round(value)}ms`).join(' ');
}
