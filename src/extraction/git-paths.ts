import * as fs from 'fs';
import type { Ignore } from 'ignore';
import { canonicalFilePath } from '../utils';
import type { ScanDiagnostics } from './sync-diagnostics';
import { runRustGitFilter } from './rust-scan';

export type GitRealpathMode = 'legacy' | 'native' | 'verify';
export type GitIgnoreMode = 'legacy' | 'rust' | 'verify';
export const AUTO_RUST_GIT_CANDIDATES = 50_000;

/** Experimental until target-platform path/order parity has been checked. */
export function gitRealpathMode(candidateCount = 0, platform = process.platform): GitRealpathMode {
  const mode = process.env.CODEGRAPH_GIT_REALPATH;
  if (mode === 'native' || mode === '1') return 'native';
  if (mode === 'verify') return 'verify';
  if (mode === undefined || mode === '' || mode === 'auto') {
    return platform === 'linux' && candidateCount >= AUTO_RUST_GIT_CANDIDATES ? 'native' : 'legacy';
  }
  return 'legacy';
}

export function gitIgnoreMode(candidateCount = 0, platform = process.platform): GitIgnoreMode {
  const mode = process.env.CODEGRAPH_RUST_GIT_IGNORE;
  if (mode === '1' || mode === 'rust') return 'rust';
  if (mode === 'verify') return 'verify';
  if (mode === undefined || mode === '' || mode === 'auto') {
    return platform === 'linux' && candidateCount >= AUTO_RUST_GIT_CANDIDATES ? 'rust' : 'legacy';
  }
  return 'legacy';
}

function safeReason(error: unknown): string {
  const reason = error instanceof Error ? error.message : '';
  return /^[a-z-]+$/.test(reason) ? reason : 'filter-error';
}

function selectCandidates(rootDir: string, candidates: string[], rootRules: string[],
  ig: Pick<Ignore, 'ignores'>, detail: ScanDiagnostics | undefined,
  nativeFilter: typeof runRustGitFilter, requested: GitIgnoreMode): { candidates: string[]; selected: number[] } {
  if (detail) detail.gitIgnoreMode = requested;
  const started = detail ? performance.now() : 0;
  let native: { included: number[]; deferred: number[] } | undefined;
  if (requested !== 'legacy') {
    const nativeStarted = detail ? performance.now() : 0;
    try {
      const result = nativeFilter(rootDir, rootRules, candidates);
      native = { included: result.included, deferred: result.deferred };
      if (detail) {
        detail.gitIgnoreKernelMs = result.kernelMs;
        detail.gitIgnoreNativeKept = native.included.length;
        detail.gitIgnoreDeferred = native.deferred.length;
      }
    } catch (error) {
      if (detail) {
        detail.gitIgnoreMode = 'fallback';
        detail.gitIgnoreReason = safeReason(error);
      }
    } finally {
      if (detail) detail.gitIgnoreNativeMs += performance.now() - nativeStarted;
    }
    if (requested === 'rust' && native) {
      const selected: number[] = [];
      let keep = 0, defer = 0;
      for (let index = 0; index < candidates.length; index++) {
        if (native.included[keep] === index) { selected.push(index); keep++; }
        else if (native.deferred[defer] === index) {
          if (!ig.ignores(candidates[index]!)) selected.push(index);
          defer++;
        }
      }
      if (detail) {
        detail.gitIgnored = candidates.length - selected.length;
        detail.gitIgnoreMs += performance.now() - started;
      }
      return { candidates, selected };
    }
  }
  const selected: number[] = [];
  for (let index = 0; index < candidates.length; index++) {
    if (ig.ignores(candidates[index]!)) {
      if (detail) detail.gitIgnored++;
    } else selected.push(index);
  }
  if (requested === 'verify' && native) {
    const expected = new Set(selected);
    const actual = new Set(native.included);
    const deferred = new Set(native.deferred);
    let mismatch = 0;
    for (let index = 0; index < candidates.length; index++) {
      if (!deferred.has(index) && expected.has(index) !== actual.has(index)) mismatch++;
    }
    if (detail) detail.gitIgnoreMismatches = mismatch;
  }
  if (detail) detail.gitIgnoreMs += performance.now() - started;
  return { candidates, selected };
}

function realpathResolver(mode: GitRealpathMode, detail?: ScanDiagnostics): ((p: string) => string) | undefined {
  if (mode === 'legacy' && !detail) return undefined;
  return (p: string): string => {
    const started = detail ? performance.now() : 0;
    if (detail) detail.gitRealpathCalls++;
    try {
      if (mode === 'legacy') return fs.realpathSync(p);
      // Verify never substitutes a native path for the legacy result, even
      // when only native succeeds. Compare exact strings (including case).
      if (mode === 'verify') {
        let baseline: string | undefined;
        let baselineError: unknown;
        try { baseline = fs.realpathSync(p); }
        catch (error) { baselineError = error; }
        let candidate: string | undefined;
        try {
          if (detail) detail.gitNativeCalls++;
          candidate = fs.realpathSync.native(p);
        } catch {
          if (detail) detail.gitNativeFallbacks++;
        }
        // A native failure is safe: native mode would retry legacy. A native
        // success where legacy failed must also prevent accepting the trial.
        if (candidate !== undefined && candidate !== baseline && detail) detail.gitPathMismatches++;
        if (baseline === undefined) throw baselineError;
        return baseline;
      }
      let candidate: string;
      try {
        if (detail) detail.gitNativeCalls++;
        candidate = fs.realpathSync.native(p);
      } catch {
        // E.g. a platform/filesystem unsupported by native realpath. Keep
        // legacy handling of missing/forbidden paths; never silently drop it.
        if (detail) detail.gitNativeFallbacks++;
        return fs.realpathSync(p);
      }
      return candidate;
    } catch (error) {
      if (detail) detail.gitRealpathErrors++;
      throw error; // canonicalFilePath retains its existing logical fallback.
    } finally {
      if (detail) detail.gitRealpathMs += performance.now() - started;
    }
  };
}

/** Keep Git candidates, logical ignore matching, canonical dedup and order.
 * Do not filter extensions before canonicalization: a symlink's target can
 * have a different extension. This does not supply inferred parent hints.
 */
export function filterGitPaths(rootDir: string, files: Iterable<string>, ig: Pick<Ignore, 'ignores'>,
  rootRules: string[] = [], detail?: ScanDiagnostics,
  nativeFilter: typeof runRustGitFilter = runRustGitFilter): Set<string> {
  const knownCount = Array.isArray(files) ? files.length : files instanceof Set ? files.size : 0;
  const ignoreMode = gitIgnoreMode(knownCount);
  const mode = gitRealpathMode(knownCount);
  if (detail) detail.gitPathMode = mode;
  const resolve = realpathResolver(mode, detail);
  const canonical = new Set<string>();
  // Preserve the old quiet fast path exactly: no candidate-array copy and no
  // clocks when neither native filter nor verbose diagnostics is requested.
  if (!detail && ignoreMode === 'legacy') {
    for (const f of files) {
      if (!ig.ignores(f)) canonical.add(canonicalFilePath(rootDir, f, undefined, resolve));
    }
    return canonical;
  }
  const candidates = Array.isArray(files) ? files : [...files];
  const started = detail ? performance.now() : 0;
  try {
    const selected = selectCandidates(rootDir, candidates, rootRules, ig, detail, nativeFilter, ignoreMode).selected;
    for (const index of selected) {
      const f = candidates[index]!;
      if (!detail) { canonical.add(canonicalFilePath(rootDir, f, undefined, resolve)); continue; }
      detail.gitCanonicalCalls++;
      let phase = performance.now();
      let target: string;
      try { target = canonicalFilePath(rootDir, f, undefined, resolve); }
      finally { detail.gitCanonicalMs += performance.now() - phase; }
      phase = performance.now();
      const size = canonical.size;
      canonical.add(target);
      if (size === canonical.size) detail.gitCanonicalDuplicates++;
      detail.gitDedupMs += performance.now() - phase;
    }
    return canonical;
  } finally {
    if (detail) detail.filterCanonicalMs += performance.now() - started;
  }
}
