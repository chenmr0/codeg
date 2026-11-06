import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLogger, setLogger } from '../src/errors';
import { DEFAULT_ADAPTIVE_FALLBACK } from '../src/sync/adaptive-plan';
import { indexConfigFingerprints } from '../src/sync/index-policy';
import { FileWatcher } from '../src/sync/watcher';
import { MAX_SYNC_POLICY_BYTES, resolveSyncPolicy, resolvedSyncPolicy, SYNC_POLICY_FILE } from '../src/sync/sync-policy';

let root: string;
const logger = getLogger();
const warn = vi.fn();
const project = (adaptive: unknown) => fs.writeFileSync(path.join(root, SYNC_POLICY_FILE), JSON.stringify({ sync: { adaptive } }));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sync-policy-'));
  vi.stubEnv('CODEGRAPH_ADAPTIVE_SYNC', '');
  setLogger({ ...logger, warn });
  warn.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  setLogger(logger);
  fs.rmSync(root, { recursive: true, force: true });
});

describe('project sync policy', () => {
  it('uses defaults for a missing file and freezes every resolved field', () => {
    const policy = resolveSyncPolicy(root);
    expect(policy).toEqual({ enabled: true, thresholds: DEFAULT_ADAPTIVE_FALLBACK,
      rules: { fileScale: true, oldNodeScale: true }, source: 'default' });
    expect([policy, policy.thresholds, policy.rules].every(Object.isFrozen)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('merges partial project rules and explicit SDK fields in priority order', () => {
    project({ enabled: false, rules: { fileScale: { enabled: false, minChangedFiles: 200 }, oldNodeScale: { minAffectedOldNodes: 500 } } });
    const policy = resolveSyncPolicy(root, { adaptive: true, adaptiveFallback: { minChangedFiles: 300 }, adaptiveRules: { oldNodeScale: false } });
    expect(policy).toMatchObject({ enabled: false, disabledReason: 'all-rules-disabled', source: 'sdk',
      thresholds: { ...DEFAULT_ADAPTIVE_FALLBACK, minChangedFiles: 300, minAffectedOldNodes: 500 },
      rules: { fileScale: false, oldNodeScale: false } });
    expect(resolveSyncPolicy(root, { adaptive: true, adaptiveRules: { fileScale: true } }).enabled).toBe(true);
    expect(resolveSyncPolicy(root).disabledReason).toBe('disabled-by-project');
  });

  it('accepts complete configuration and exact positive/proportion limits', () => {
    project({ enabled: true, rules: {
      fileScale: { enabled: true, minChangedFiles: 1, minChangedFraction: 1, minWorkFraction: 0.00001 },
      oldNodeScale: { enabled: false, minAffectedOldNodes: Number.MAX_SAFE_INTEGER, minAffectedOldNodeFraction: 1 },
    } });
    expect(resolveSyncPolicy(root)).toMatchObject({ enabled: true, source: 'project',
      thresholds: { minChangedFiles: 1, minChangedFraction: 1, minWorkFraction: 0.00001,
        minAffectedOldNodes: Number.MAX_SAFE_INTEGER, minAffectedOldNodeFraction: 1 },
      rules: { fileScale: true, oldNodeScale: false } });
  });

  it.each([
    ['{', 'JSON'], ['[]', SYNC_POLICY_FILE], ['null', SYNC_POLICY_FILE],
    ['{"syncc":{}}', 'syncc'], ['{"sync":null}', 'sync'],
    ['{"sync":{"adaptive":[]}}', 'sync.adaptive'],
    ['{"sync":{"adaptive":{"enabled":1}}}', 'sync.adaptive.enabled'],
    ['{"sync":{"adaptive":{"rules":null}}}', 'sync.adaptive.rules'],
    ['{"sync":{"adaptive":{"rules":{"fileScale":null}}}}', 'sync.adaptive.rules.fileScale'],
    ['{"sync":{"adaptive":{"rules":{"fileScale":{"minChangedFiles":0}}}}}', 'minChangedFiles'],
    ['{"sync":{"adaptive":{"rules":{"oldNodeScale":{"enabled":"false"}}}}}', 'oldNodeScale.enabled'],
    ['{"sync":{"adaptive":{"rules":{"oldNodeScale":{"minWorkFraction":0.5}}}}}', 'oldNodeScale.minWorkFraction'],
  ])('disables one sync and warns once for invalid JSON structure %s', (raw, field) => {
    fs.writeFileSync(path.join(root, SYNC_POLICY_FILE), raw);
    const policy = resolveSyncPolicy(root, { adaptive: true });
    expect(policy.enabled).toBe(false);
    expect(policy.disabledReason).toBe('invalid-project-config');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain(path.join(root, SYNC_POLICY_FILE));
    if (field !== 'JSON') expect(warn.mock.calls[0]![0]).toContain(field);
    expect(resolveSyncPolicy(root, { [resolvedSyncPolicy]: policy })).toBe(policy);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, 1.1, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, '128'])('rejects invalid SDK counts %s', value => {
    expect(resolveSyncPolicy(root, { adaptiveFallback: { minChangedFiles: value as number } })).toMatchObject({ enabled: false, disabledReason: 'invalid-sdk-options' });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, 1.01, Infinity, NaN, null, '0.25'])('rejects invalid SDK fractions %s', value => {
    expect(resolveSyncPolicy(root, { adaptiveFallback: { minChangedFraction: value as number } }).enabled).toBe(false);
    expect(warn.mock.calls[0]![0]).toContain('adaptiveFallback.minChangedFraction');
  });

  it('keeps environment and internal opt-out authoritative over SDK and project settings', () => {
    project({ enabled: true });
    const initial = resolveSyncPolicy(root, { adaptive: true });
    expect(resolveSyncPolicy(root, { [resolvedSyncPolicy]: initial, adaptive: false })).toMatchObject({ enabled: false, disabledReason: 'disabled-by-option' });
    vi.stubEnv('CODEGRAPH_ADAPTIVE_SYNC', '0');
    expect(resolveSyncPolicy(root, { adaptive: true })).toMatchObject({ enabled: false, disabledReason: 'disabled-by-environment' });
    expect(resolveSyncPolicy(root, { [resolvedSyncPolicy]: initial })).toMatchObject({ enabled: false, disabledReason: 'disabled-by-environment' });
  });

  it('retains the active snapshot and reads same-stat edits on the next top-level call', () => {
    project({ rules: { fileScale: { minChangedFiles: 128 } } });
    const originalTime = fs.statSync(path.join(root, SYNC_POLICY_FILE)).mtime;
    const initial = resolveSyncPolicy(root);
    project({ rules: { fileScale: { minChangedFiles: 256 } } });
    fs.utimesSync(path.join(root, SYNC_POLICY_FILE), originalTime, originalTime);
    const open = vi.spyOn(fs, 'openSync');
    expect(resolveSyncPolicy(root, { [resolvedSyncPolicy]: initial })).toBe(initial);
    expect(open).not.toHaveBeenCalled();
    expect(initial.thresholds.minChangedFiles).toBe(128);
    expect(resolveSyncPolicy(root).thresholds.minChangedFiles).toBe(256);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('does not include strategy files in inventory or semantic fingerprints', () => {
    const before = indexConfigFingerprints(root, [{ path: 'a.c' }]);
    project({ enabled: false });
    expect(indexConfigFingerprints(root, [{ path: 'a.c' }])).toEqual(before);
  });

  it('limits the size and catches files that grow after fstat', () => {
    project({ enabled: true });
    const fstat = fs.fstatSync;
    vi.spyOn(fs, 'fstatSync').mockImplementationOnce(((fd: number) => {
      const stat = fstat(fd);
      fs.appendFileSync(path.join(root, SYNC_POLICY_FILE), ' '.repeat(MAX_SYNC_POLICY_BYTES));
      return stat;
    }) as typeof fs.fstatSync);
    expect(resolveSyncPolicy(root)).toMatchObject({ enabled: false, disabledReason: 'invalid-project-config' });
    expect(warn.mock.calls[0]![0]).toContain('exceeds');
    warn.mockClear();
    expect(resolveSyncPolicy(root).enabled).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('reports permission errors and rejects non-regular files', () => {
    const open = vi.spyOn(fs, 'openSync').mockImplementationOnce(() => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); });
    expect(resolveSyncPolicy(root).disabledReason).toBe('invalid-project-config');
    expect(warn.mock.calls[0]![0]).toContain('denied');
    open.mockRestore();
    fs.mkdirSync(path.join(root, SYNC_POLICY_FILE));
    expect(resolveSyncPolicy(root).enabled).toBe(false);
  });
});

describe('strategy-only watcher events', () => {
  it('ignores root policy writes, deletion and replacement while retaining source and unknown events', async () => {
    vi.useFakeTimers();
    const sync = vi.fn().mockResolvedValue({ filesChanged: 0, durationMs: 1 });
    const watcher = new FileWatcher(root, sync, { inertForTests: true, debounceMs: 10 });
    watcher.start();
    try {
      const revision = watcher.getChangeRevision();
      project({ enabled: true });
      watcher.ingestEventForTests(SYNC_POLICY_FILE);
      fs.unlinkSync(path.join(root, SYNC_POLICY_FILE));
      watcher.ingestEventForTests(SYNC_POLICY_FILE);
      project({ enabled: false });
      watcher.ingestEventForTests(SYNC_POLICY_FILE);
      await vi.advanceTimersByTimeAsync(100);
      expect(sync).not.toHaveBeenCalled();
      expect(watcher.getChangeRevision()).toBe(revision);
      fs.writeFileSync(path.join(root, 'a.c'), 'int a;');
      watcher.ingestEventForTests('a.c');
      await vi.advanceTimersByTimeAsync(500);
      expect(sync.mock.calls).toEqual([[['a.c']]]);
      (watcher as unknown as { handleChange(relative: string | null): void }).handleChange(null);
      await vi.advanceTimersByTimeAsync(500);
      expect(sync.mock.calls[1]).toEqual([undefined]);
      watcher.ingestEventForTests(`nested/${SYNC_POLICY_FILE}`);
      await vi.advanceTimersByTimeAsync(500);
      expect(sync.mock.calls[2]).toEqual([undefined]);
    } finally { watcher.stop(); }
  });
});
