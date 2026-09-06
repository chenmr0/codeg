import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ignore from 'ignore';
import { filterGitPaths } from '../src/extraction/git-paths';
import { ScanDiagnostics } from '../src/extraction/sync-diagnostics';
import { decodeRustGitFilter } from '../src/extraction/rust-scan';
import { clearCanonicalCache } from '../src/utils';

const candidates = ['src/a.c', 'build/no.c', 'src/b.c'];
const rules = ['build/\n'];
const baseline = () => {
  const matcher = ignore();
  for (const group of rules) matcher.add(group);
  return matcher;
};
const nativeFilter = vi.fn();
const run = (mode: string, detail = new ScanDiagnostics()) => {
  vi.stubEnv('CODEGRAPH_RUST_GIT_IGNORE', mode);
  vi.stubEnv('CODEGRAPH_DEDUP_SYMLINKS', '0');
  clearCanonicalCache();
  return { paths: [...filterGitPaths(process.cwd(), candidates, baseline(), rules, detail, nativeFilter)], detail };
};

beforeEach(() => nativeFilter.mockReset());
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); clearCanonicalCache(); });

describe('Rust Git ignore transport integration', () => {
  it('keeps legacy default without starting the helper', () => {
    expect(run('0').paths).toEqual(['src/a.c', 'src/b.c']);
    expect(nativeFilter).not.toHaveBeenCalled();
  });
  it('uses ordered native indexes without calling the JS matcher', () => {
    nativeFilter.mockReturnValue({ included: [0, 2], deferred: [], kernelMs: 4 });
    const matcher = { ignores: vi.fn(() => { throw new Error('must not run'); }) };
    vi.stubEnv('CODEGRAPH_RUST_GIT_IGNORE', '1'); vi.stubEnv('CODEGRAPH_DEDUP_SYMLINKS', '0');
    const detail = new ScanDiagnostics();
    expect([...filterGitPaths(process.cwd(), candidates, matcher, rules, detail, nativeFilter)])
      .toEqual(['src/a.c', 'src/b.c']);
    expect(matcher.ignores).not.toHaveBeenCalled();
    expect(nativeFilter).toHaveBeenCalledWith(process.cwd(), rules, candidates);
    expect(detail).toMatchObject({ gitIgnoreMode: 'rust', gitIgnoreReason: 'none',
      gitIgnored: 1, gitIgnoreNativeKept: 2, gitIgnoreKernelMs: 4 });
  });
  it('fully falls back to JS on any helper rejection', () => {
    nativeFilter.mockImplementation(() => { throw new Error('unsupported-rule'); });
    const result = run('1');
    expect(result.paths).toEqual(['src/a.c', 'src/b.c']);
    expect(result.detail).toMatchObject({ gitIgnoreMode: 'fallback',
      gitIgnoreReason: 'unsupported-rule', gitIgnored: 1 });
  });
  it('verify always returns JS and reports exact decision mismatches', () => {
    nativeFilter.mockReturnValue({ included: [0, 1], deferred: [], kernelMs: 2 });
    const result = run('verify');
    expect(result.paths).toEqual(['src/a.c', 'src/b.c']);
    expect(result.detail).toMatchObject({ gitIgnoreMode: 'verify', gitIgnoreMismatches: 2,
      gitIgnoreNativeKept: 2, gitIgnored: 1 });
  });
  it('verify reports parity for the same ordered decisions', () => {
    nativeFilter.mockReturnValue({ included: [0, 2], deferred: [], kernelMs: 1 });
    expect(run('verify').detail.gitIgnoreMismatches).toBe(0);
  });
  it('uses JS only for deferred candidates and merges them in original order', () => {
    nativeFilter.mockReturnValue({ included: [0], deferred: [1, 2], kernelMs: 1 });
    const matcher = { ignores: vi.fn((candidate: string) => candidate === 'build/no.c') };
    vi.stubEnv('CODEGRAPH_RUST_GIT_IGNORE', '1'); vi.stubEnv('CODEGRAPH_DEDUP_SYMLINKS', '0');
    const detail = new ScanDiagnostics();
    expect([...filterGitPaths(process.cwd(), candidates, matcher, rules, detail, nativeFilter)])
      .toEqual(['src/a.c', 'src/b.c']);
    expect(matcher.ignores).toHaveBeenCalledTimes(2);
    expect(detail).toMatchObject({ gitIgnoreMode: 'rust', gitIgnoreDeferred: 2,
      gitIgnoreNativeKept: 1, gitIgnored: 1 });
  });
  it('verify excludes deferred candidates from mismatch accounting', () => {
    nativeFilter.mockReturnValue({ included: [0], deferred: [2], kernelMs: 1 });
    expect(run('verify').detail).toMatchObject({ gitIgnoreMismatches: 0, gitIgnoreDeferred: 1 });
  });
});

describe('Rust Git filter decoder', () => {
  const response = () => ({ protocol: 1, ok: true, reason: '', operation: 'filter', files: [],
    included: [0, 2], deferred: [], counters: { directories: 0, entries: 0, metadata: 0 }, elapsedMs: 3 });
  it('accepts strictly ordered candidate indexes', () => {
    expect(decodeRustGitFilter(response(), 3)).toEqual({ included: [0, 2], deferred: [], kernelMs: 3 });
  });
  it.each(['protocol', 'operation', 'failure', 'files', 'duplicate', 'descending', 'negative',
    'out-of-range', 'fractional', 'deferred-order', 'overlap', 'elapsed'])('rejects malformed or partial output: %s', shape => {
    const value: any = response();
    if (shape === 'protocol') value.protocol++;
    if (shape === 'operation') value.operation = 'scan';
    if (shape === 'failure') { value.ok = false; value.reason = 'unsupported-rule'; }
    if (shape === 'files') value.files.push({});
    if (shape === 'duplicate') value.included = [0, 0];
    if (shape === 'descending') value.included = [2, 0];
    if (shape === 'negative') value.included = [-1];
    if (shape === 'out-of-range') value.included = [3];
    if (shape === 'fractional') value.included = [0.5];
    if (shape === 'deferred-order') value.deferred = [2, 1];
    if (shape === 'overlap') value.deferred = [2];
    if (shape === 'elapsed') value.elapsedMs = Number.NaN;
    expect(() => decodeRustGitFilter(value, 3)).toThrow();
  });
});
