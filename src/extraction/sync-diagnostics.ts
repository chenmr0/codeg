import { diagnosticPath, type RustScanDiagnostic } from './rust-scan';
/** Verbose-only, per-invocation diagnostics. No source paths or contents. */
export class ScanDiagnostics {
  mode: 'unknown' | 'git' | 'hybrid' | 'rust' | 'walk' | 'scoped' = 'unknown';
  fallbackReason: 'none' | 'codegraph-negation' | 'parent-gitignored' | 'git-path-error' | 'hybrid-unsafe' = 'none';
  failureStage = 'none';
  gitCommandMs = 0;
  ignoreBuildMs = 0;
  filterCanonicalMs = 0;
  // Ordinary Git route only. These are children of filterCanonicalMs;
  // gitRealpathMs is nested inside gitCanonicalMs, never an extra phase.
  gitPathMode: 'unused' | 'legacy' | 'native' | 'verify' = 'unused';
  gitIgnoreMs = 0;
  gitIgnoreMode: 'legacy' | 'rust' | 'verify' | 'fallback' = 'legacy';
  gitIgnoreReason = 'none';
  gitIgnoreNativeMs = 0;
  gitIgnoreKernelMs = 0;
  gitIgnoreMismatches = 0;
  gitIgnoreNativeKept = 0;
  gitIgnoreDeferred = 0;
  gitCanonicalMs = 0;
  gitRealpathMs = 0;
  gitDedupMs = 0;
  gitIgnored = 0;
  gitCanonicalCalls = 0;
  gitRealpathCalls = 0;
  gitRealpathErrors = 0;
  gitNativeCalls = 0;
  gitNativeFallbacks = 0;
  gitPathMismatches = 0;
  gitCanonicalDuplicates = 0;
  walkMs = 0;
  gitCommands = 0;
  gitCandidates = 0;
  sourceFiles = 0;
  walkDirectories = 0;
  gitDirectories = 0;
  supplementRoots = 0;
  canonicalFromParent = 0;
  nativeStatus: 'off' | 'used' | 'verified' | 'mismatch' | 'fallback' = 'off';
  nativeReason = 'none';
  nativeDiagnostic?: RustScanDiagnostic;
  nativeMs = 0;
  nativeDirectories = 0;
  nativeMetadata = 0;

  format(): string {
    return `scan-detail mode=${this.mode} fallbackReason=${this.fallbackReason} failureStage=${this.failureStage} ` +
      formatMs({ gitCommandMs: this.gitCommandMs, ignoreBuildMs: this.ignoreBuildMs,
        filterCanonicalMs: this.filterCanonicalMs, walkMs: this.walkMs }) +
      ` gitCommands=${this.gitCommands} gitCandidates=${this.gitCandidates}` +
      ` sourceFiles=${this.sourceFiles} walkDirectories=${this.walkDirectories}` +
      ` gitDirectories=${this.gitDirectories} supplementRoots=${this.supplementRoots}` +
      ` canonicalFromParent=${this.canonicalFromParent}` +
      ` nativeStatus=${this.nativeStatus} nativeReason=${this.nativeReason} nativeMs=${Math.round(this.nativeMs)}ms` +
      ` nativeDirectories=${this.nativeDirectories} nativeMetadata=${this.nativeMetadata}` +
      ` gitPathMode=${this.gitPathMode} ` +
      (this.nativeDiagnostic ? 'nativeDiagnosticReason=' + this.nativeDiagnostic.reason +
        ' nativeExcludedAsFile=' + this.nativeDiagnostic.excludedAsFile +
        ' nativeExcludedAsDirectory=' + this.nativeDiagnostic.excludedAsDirectory +
        ' nativeTargetType=' + this.nativeDiagnostic.targetType + diagnosticPath(this.nativeDiagnostic) + ' ' : '') +
      formatMs({ gitIgnoreMs: this.gitIgnoreMs, gitCanonicalMs: this.gitCanonicalMs,
        gitRealpathMs: this.gitRealpathMs, gitDedupMs: this.gitDedupMs }) +
      ` gitIgnoreMode=${this.gitIgnoreMode} gitIgnoreReason=${this.gitIgnoreReason}` +
      ` gitIgnoreNativeMs=${Math.round(this.gitIgnoreNativeMs)}ms` +
      ` gitIgnoreKernelMs=${Math.round(this.gitIgnoreKernelMs)}ms` +
      ` gitIgnoreMismatches=${this.gitIgnoreMismatches} gitIgnoreNativeKept=${this.gitIgnoreNativeKept}` +
      ` gitIgnoreDeferred=${this.gitIgnoreDeferred}` +
      ` gitIgnored=${this.gitIgnored} gitCanonicalCalls=${this.gitCanonicalCalls}` +
      ` gitRealpathCalls=${this.gitRealpathCalls} gitRealpathErrors=${this.gitRealpathErrors}` +
      ` gitNativeCalls=${this.gitNativeCalls} gitNativeFallbacks=${this.gitNativeFallbacks}` +
      ` gitPathMismatches=${this.gitPathMismatches} gitCanonicalDuplicates=${this.gitCanonicalDuplicates}`;
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
  readonly removal = new RemovalDiagnostics();
  readonly phases = {
    enumerateMs: 0, loadTrackedMs: 0, buildLookupMs: 0, removalMs: 0, changeCheckMs: 0,
  };
  readonly io = { statMs: 0, readForHashMs: 0, hashMs: 0, statRefreshMs: 0 };
  readonly counts = {
    currentFiles: 0, trackedFiles: 0,
    // Explicit reconciliation calls only, not calls inside scanner/helpers.
    existsChecks: 0, statChecks: 0, statUnchanged: 0, statErrors: 0,
    snapshotPresence: 0, snapshotStats: 0,
    hashReadAttempts: 0, hashReadFiles: 0, hashReadErrors: 0,
    sameHashSkipped: 0, sameHashStatUpdated: 0, sameHashStatDeferred: 0, recoveryRetryFiles: 0,
    added: 0, modified: 0, removed: 0,
  };

  log(log: (message: string) => void, totalMs: number): void {
    log(this.scan.format());
    log(`reconcile-detail scope=${this.scope} ${formatMs(this.phases)} totalMs=${Math.round(totalMs)}ms`);
    log(`reconcile-io ${formatMs(this.io)}`);
    log(`reconcile-counts ${Object.entries(this.counts).map(([key, value]) => `${key}=${value}`).join(' ')}`);
  }
}

/**
 * Attribution within existing per-file removals, never another reconcile phase.
 * Known scan omissions belong to removalMs; late stat/read deletions belong to
 * changeCheckMs. The timings below are disjoint children of operationMs.
 * workerMs includes dispatch/startup, IPC and the worker's whole transaction;
 * preserveDeleteMs measures the alternative main-thread path, not its child.
 */
export class RemovalDiagnostics {
  readonly timings = {
    beforeNodeWriteMs: 0, proofMs: 0, probeMs: 0, preserveDeleteMs: 0,
    workerMs: 0, walWaitMs: 0,
  };
  attempted = 0;
  committed = 0;
  mainThread = 0;
  worker = 0;
  late = 0;
  operationMs = 0;
  failedPhase: keyof RemovalDiagnostics['timings'] | 'none' = 'none';
  private activePhase: keyof RemovalDiagnostics['timings'] | undefined;
  private phaseStarted = 0;
  private fileStarted: number | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastLog = -Infinity;

  beginFile(late: boolean, knownTotal: number, log: (message: string) => void): void {
    this.attempted++;
    if (late) this.late++;
    this.fileStarted = performance.now();
    if (!this.timer) {
      this.timer = setInterval(() => {
        if (this.fileStarted !== undefined) this.progress(knownTotal, log);
      }, 1000);
      this.timer.unref?.();
    }
    this.progress(knownTotal, log);
  }

  endFile(): void {
    if (this.fileStarted !== undefined) this.operationMs += performance.now() - this.fileStarted;
    this.fileStarted = undefined;
  }

  measure<T>(phase: keyof RemovalDiagnostics['timings'], operation: () => T): T {
    this.activePhase = phase;
    this.phaseStarted = performance.now();
    try { return operation(); }
    catch (error) { this.failedPhase = phase; throw error; }
    finally {
      this.timings[phase] += performance.now() - this.phaseStarted;
      this.activePhase = undefined;
    }
  }

  async measureAsync<T>(phase: keyof RemovalDiagnostics['timings'], operation: () => Promise<T>): Promise<T> {
    this.activePhase = phase;
    this.phaseStarted = performance.now();
    try { return await operation(); }
    catch (error) { this.failedPhase = phase; throw error; }
    finally {
      this.timings[phase] += performance.now() - this.phaseStarted;
      this.activePhase = undefined;
    }
  }

  progress(knownTotal: number, log: (message: string) => void, status = 'running', force = false): void {
    const now = performance.now();
    if (!force && now - this.lastLog < 1000) return;
    this.lastLog = now;
    const elapsed = this.operationMs + (this.fileStarted === undefined ? 0 : now - this.fileStarted);
    try {
      log(`removing-progress target=stale-index-entries status=${status} committed=${this.committed} ` +
        `total=${this.late > 0 ? 'unknown' : knownTotal} knownTotal=${knownTotal} late=${this.late} ` +
        `stage=${this.activePhase ?? 'between-files'} operationMs=${Math.round(elapsed)}ms`);
    } catch { /* Diagnostic output must not fail sync or escape the heartbeat. */ }
  }

  finish(knownTotal: number, complete: boolean, log: (message: string) => void): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.attempted === 0) return;
    this.progress(knownTotal, log, complete ? 'complete' : 'failed', true);
    try {
      log(`removal-detail attempted=${this.attempted} committed=${this.committed} ` +
        `mainThread=${this.mainThread} worker=${this.worker} late=${this.late} ` +
        `failedPhase=${this.failedPhase} ${formatMs(this.timings)} operationMs=${Math.round(this.operationMs)}ms ` +
        `timingRelation=children-of-operation operationRelation=within-removal-or-changeCheck`);
    } catch { /* Never replace a store/checkpoint error with a logging error. */ }
  }
}

function formatMs(values: Record<string, number>): string {
  return Object.entries(values).map(([key, value]) => `${key}=${Math.round(value)}ms`).join(' ');
}
