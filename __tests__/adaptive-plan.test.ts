import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as extraction from '../src/extraction';
import { hashContent } from '../src/extraction';
import { getCodeGraphDir } from '../src/directory';
import { indexConfigFingerprints } from '../src/sync/index-policy';
import { getLanguageScopeKey } from '../src/extraction/language-scope';
import type { FileRecord } from '../src/types';
import { adaptiveConfigFingerprint, adaptiveRuntimeKey,
  createAdaptivePlan, includeAdaptiveReindexWork, chooseStructuralStrategy, canSkipScopedAdaptivePlan, hasStructuralRebuildWork,
  type AdaptivePlan } from '../src/sync/adaptive-plan';

const roots: string[] = [];
function root(): string { const value = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-adaptive-plan-')); roots.push(value); return value; }
function record(base: string, relative: string): FileRecord {
  const full = path.join(base, relative), stat = fs.statSync(full);
  return { path: relative, contentHash: hashContent(fs.readFileSync(full, 'utf8')), language: 'cpp',
    size: stat.size, modifiedAt: stat.mtimeMs, indexedAt: Date.now(), nodeCount: 10 };
}
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function plan(): AdaptivePlan {
  return { runtimeKey: 'runtime', snapshot: { files: [], configFingerprint: 'config', semanticConfigFingerprint: 'semantic' },
    added: [], modified: ['one'], removed: [], changedFiles: 120, affectedOldNodes: 1200, changedBytes: 12000,
    totalFiles: 1000, totalBytes: 100000, totalNodes: 10000, planningMs: 0 };
}
describe('configuration fingerprints', () => {
  it('preserves published configuration digests and rereads same-stat configuration bytes', () => {
    const dir = root(), lib = path.join(dir, 'lib');
    fs.mkdirSync(lib);
    fs.writeFileSync(path.join(dir, '.gitignore'), '*.tmp\n');
    fs.writeFileSync(path.join(lib, '.gitignore'), '*.log\n');
    fs.writeFileSync(path.join(lib, 'Cargo.toml'), 'first\n');
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"example"}');
    const files = ['a.cpp', 'lib/a.cpp', 'lib/none/sub/extra.cpp'].map(path => ({ path }));
    const fingerprints = indexConfigFingerprints(dir, files);
    // Produced by 0e5d4518 for this fixture.
    expect(fingerprints).toEqual({
      configFingerprint: getLanguageScopeKey() === 'all' ? 'ca802356997fec40172e777755fd869aaa753dd957234ceb397d50443ff3d088'
        : 'f6cc80ac767211edd79a307d4b4631b6fc763e592d3310f8ac165df060577e8f',
      semanticConfigFingerprint: '02b0bdf7ac73617a20b5b8c2a2fd21e345589faa6500eaa8576e0e65dbdeda4a',
    });
    const cargo = path.join(lib, 'Cargo.toml'), time = fs.statSync(cargo).mtime;
    fs.writeFileSync(cargo, 'other\n');
    fs.utimesSync(cargo, time, time);
    const changed = indexConfigFingerprints(dir, files);
    expect(changed.configFingerprint).toBe(fingerprints.configFingerprint);
    expect(changed.semanticConfigFingerprint).not.toBe(fingerprints.semanticConfigFingerprint);
  });

  it('counts a Git-listed missing source as a removal and catches its reappearance on the next inventory', async () => {
    const dir = root(), source = path.join(dir, 'removed.cpp');
    fs.writeFileSync(source, 'int original;');
    const tracked = [record(dir, 'removed.cpp')];
    fs.unlinkSync(source);
    const scan = vi.spyOn(extraction, 'scanDirectoryAsync').mockResolvedValue(['removed.cpp']);
    try {
      const result = await createAdaptivePlan(dir, tracked, { runtimeKey: 'runtime' });
      expect(result.removed).toEqual(['removed.cpp']);
      fs.writeFileSync(source, 'int returned;');
      const after = await createAdaptivePlan(dir, [], { runtimeKey: 'runtime', fullHash: true });
      expect(after.added).toEqual(['removed.cpp']);
    } finally { scan.mockRestore(); }
  });
});

describe('read-only source plan', () => {
  it('compares add/modify/remove without mutating source or tracked records', async () => {
    const dir = root();
    fs.writeFileSync(path.join(dir, 'a.cpp'), 'int before() { return 1; }\n');
    fs.writeFileSync(path.join(dir, 'gone.cpp'), 'int gone;\n');
    const before = [record(dir, 'a.cpp'), record(dir, 'gone.cpp')];
    const original = JSON.stringify(before);
    fs.writeFileSync(path.join(dir, 'a.cpp'), 'int after() { return 222; }\n');
    fs.unlinkSync(path.join(dir, 'gone.cpp'));
    fs.writeFileSync(path.join(dir, 'new.cpp'), 'int added;\n');
    const result = await createAdaptivePlan(dir, before, { runtimeKey: 'runtime' });
    expect(result.added).toEqual(['new.cpp']); expect(result.modified).toEqual(['a.cpp']); expect(result.removed).toEqual(['gone.cpp']);
    expect(result.affectedOldNodes).toBe(20);
    expect(JSON.stringify(before)).toBe(original);
    expect(fs.existsSync(getCodeGraphDir(dir))).toBe(false);
  });
  it('agrees with sync on real changes alongside macro retries, including a same-stat edit', async () => {
    const dir = root(), fixed = new Date('2025-01-01T00:00:00Z');
    const tracked = ['retry.cpp', 'edited.cpp', 'other.cpp'].map(name => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, 'int before;');
      fs.utimesSync(file, fixed, fixed);
      const row = record(dir, name);
      if (name !== 'other.cpp') row.errors = [{ severity: 'warning', message: 'retry', code: 'declaration_macro_recovery_skipped' }];
      return row;
    });
    const edited = path.join(dir, 'edited.cpp');
    fs.writeFileSync(edited, 'int edited;');
    fs.utimesSync(edited, fixed, fixed);
    fs.appendFileSync(path.join(dir, 'other.cpp'), 'int new_work;');
    const inventory = await extraction.scanSyncInventory(dir);
    const changes = await extraction.summarizeSyncCandidates(dir, inventory, tracked);
    const plan = await createAdaptivePlan(dir, tracked, { runtimeKey: 'runtime' });
    expect(changes?.modified.sort()).toEqual(['edited.cpp', 'other.cpp']);
    expect(plan.modified.sort()).toEqual(changes!.modified);
    expect(plan.affectedOldNodes).toBe(20);
    expect(chooseStructuralStrategy(changes!, { fallback: { minChangedFiles: 2 } }).strategy).toBe('rebuild');
    expect(chooseStructuralStrategy(plan, { fallback: { minChangedFiles: 2 } }).strategy).toBe('rebuild');
  });
  it('counts required same-content re-extraction without double-counting source deltas', async () => {
    const dir = root();
    for (const file of ['same.cpp', 'edited.cpp', 'removed.cpp']) fs.writeFileSync(path.join(dir, file), 'int before;');
    const tracked = ['same.cpp', 'edited.cpp', 'removed.cpp'].map(file => record(dir, file));
    fs.writeFileSync(path.join(dir, 'edited.cpp'), 'int after_changed;');
    fs.writeFileSync(path.join(dir, 'added.cpp'), 'int added;');
    fs.unlinkSync(path.join(dir, 'removed.cpp'));
    const original = await createAdaptivePlan(dir, tracked, { runtimeKey: 'runtime', fullHash: true });
    const expanded = includeAdaptiveReindexWork(original, tracked,
      ['same.cpp', 'same.cpp', 'edited.cpp', 'removed.cpp', 'added.cpp', 'absent.cpp']);
    expect(original.modified).toEqual(['edited.cpp']);
    expect(expanded.modified).toEqual(['edited.cpp', 'same.cpp']);
    expect(expanded.changedFiles).toBe(4);
    expect(expanded.affectedOldNodes).toBe(30);
    expect(expanded.changedBytes).toBe(original.changedBytes + tracked[0]!.size);
    expect(expanded.snapshot).toBe(original.snapshot);
    expect(includeAdaptiveReindexWork(expanded, tracked, ['same.cpp'])).toEqual(expanded);
  });
  it('rejects out-of-root tracked paths', async () => {
    const dir = root(); fs.writeFileSync(path.join(dir, 'a.cpp'), 'int a;');
    await expect(createAdaptivePlan(dir, [{ ...record(dir, 'a.cpp'), path: '../outside.cpp' }], { runtimeKey: 'runtime' })).rejects.toThrow('escapes root');
  });
  it('full-hash catch-up catches preserved-size/mtime source changes', async () => {
    const dir = root(); fs.writeFileSync(path.join(dir, 'a.cpp'), 'int alpha;\n');
    const original = record(dir, 'a.cpp');
    fs.writeFileSync(path.join(dir, 'a.cpp'), 'int bravo;\n');
    fs.utimesSync(path.join(dir, 'a.cpp'), new Date(original.modifiedAt), new Date(original.modifiedAt));
    const result = await createAdaptivePlan(dir, [original], { runtimeKey: 'runtime', fullHash: true });
    expect(result.modified).toEqual(['a.cpp']);
  });
  it('retains removed source ancestors for config verification', async () => {
    const dir = root(); fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', '.gitignore'), '# no rules\n');
    fs.writeFileSync(path.join(dir, 'sub', 'gone.cpp'), 'int gone;\n');
    const original = record(dir, 'sub/gone.cpp'); fs.unlinkSync(path.join(dir, 'sub', 'gone.cpp'));
    const result = await createAdaptivePlan(dir, [original], { runtimeKey: 'runtime' });
    fs.appendFileSync(path.join(dir, 'sub', '.gitignore'), '*.cpp\n');
    const after = await createAdaptivePlan(dir, [original], { runtimeKey: 'runtime' });
    expect(after.snapshot.configFingerprint).not.toBe(result.snapshot.configFingerprint);
  });
  it('ignores absent controls in new source directories but detects a new real ignore file', () => {
    const dir = root();
    const before = adaptiveConfigFingerprint(dir, [{ path: 'a.cpp' }]);
    fs.mkdirSync(path.join(dir, 'new-sub'));
    expect(adaptiveConfigFingerprint(dir, [{ path: 'a.cpp' }, { path: 'new-sub/b.cpp' }])).toBe(before);
    fs.writeFileSync(path.join(dir, 'new-sub', '.gitignore'), '*.h');
    expect(adaptiveConfigFingerprint(dir, [{ path: 'a.cpp' }, { path: 'new-sub/b.cpp' }])).not.toBe(before);
  });
  it('detects semantic controls that the legacy configuration fingerprint omits', async () => {
    const dir = root(); fs.writeFileSync(path.join(dir, 'a.cpp'), 'int a;');
    fs.mkdirSync(path.join(dir, 'build'));
    const before = await createAdaptivePlan(dir, [record(dir, 'a.cpp')], { runtimeKey: 'runtime' });
    fs.writeFileSync(path.join(dir, 'build', 'compile_commands.json'), '[]');
    expect(adaptiveConfigFingerprint(dir, [{ path: 'a.cpp' }])).toBe(before.snapshot.configFingerprint);
    const after = await createAdaptivePlan(dir, [record(dir, 'a.cpp')], { runtimeKey: 'runtime' });
    expect(after.snapshot.semanticConfigFingerprint).not.toBe(before.snapshot.semanticConfigFingerprint);
  });
  it('detects root and nested configuration changes', () => {
    const dir = root(); fs.mkdirSync(path.join(dir, 'sub'));
    const files = [{ path: 'sub/a.cpp' }];
    const first = adaptiveConfigFingerprint(dir, files);
    fs.writeFileSync(path.join(dir, 'sub', '.gitignore'), '*.h\n');
    expect(adaptiveConfigFingerprint(dir, files)).not.toBe(first);
  });
  it('invalidates a cached helper identity when bytes at the same path change', () => {
    const dir = root(), helper = path.join(dir, 'fake-scan'), previous = process.env.CODEGRAPH_RUST_SCAN_PATH;
    try {
      fs.writeFileSync(helper, 'not an executable: old');
      process.env.CODEGRAPH_RUST_SCAN_PATH = helper;
      const first = adaptiveRuntimeKey(dir, 'node-sqlite');
      fs.writeFileSync(helper, 'not an executable: new bytes');
      expect(adaptiveRuntimeKey(dir, 'node-sqlite')).not.toBe(first);
    } finally { if (previous === undefined) delete process.env.CODEGRAPH_RUST_SCAN_PATH; else process.env.CODEGRAPH_RUST_SCAN_PATH = previous; }
  });
  it('runtime identity changes with backend and parse options', () => {
    const dir = root(), previous = process.env.CODEGRAPH_PARSE_TIMEOUT_MS;
    try {
      const first = adaptiveRuntimeKey(dir, 'node-sqlite');
      expect(adaptiveRuntimeKey(dir, 'sql.js')).not.toBe(first);
      process.env.CODEGRAPH_PARSE_TIMEOUT_MS = '12345';
      expect(adaptiveRuntimeKey(dir, 'node-sqlite')).not.toBe(first);
    } finally { if (previous === undefined) delete process.env.CODEGRAPH_PARSE_TIMEOUT_MS; else process.env.CODEGRAPH_PARSE_TIMEOUT_MS = previous; }
  });
});

describe('structural sync rules', () => {
  const boundary = () => ({ ...plan(), changedFiles: 128, totalFiles: 512, changedBytes: 25000,
    totalBytes: 100000, affectedOldNodes: 0, totalNodes: 40000 });

  it('requires all file-scale conditions at their exact boundaries', () => {
    const work = boundary();
    expect(chooseStructuralStrategy(work)).toMatchObject({ strategy: 'rebuild', matchedRule: 'fileScale',
      metrics: { oldFiles: 512, changedFileFraction: 0.25, changedByteFraction: 0.25 } });
    for (const patch of [{ changedFiles: 127 }, { totalFiles: 513 }, { changedBytes: 24999 }]) {
      expect(chooseStructuralStrategy({ ...work, ...patch }).strategy).toBe('incremental');
    }
    expect(hasStructuralRebuildWork({ ...work, changedBytes: 0, affectedOldNodes: 10000 })).toBe(true);
    expect(hasStructuralRebuildWork({ ...work, changedBytes: 0, affectedOldNodes: 9999 })).toBe(false);
  });

  it('keeps the node-rule ratio independent from file-scale work coverage', () => {
    const work = { ...boundary(), affectedOldNodes: 10000, changedBytes: 0 };
    expect(chooseStructuralStrategy(work)).toMatchObject({ matchedRule: 'both' });
    expect(chooseStructuralStrategy(work, { fallback: { minAffectedOldNodeFraction: 0.5 } })).toMatchObject({ matchedRule: 'fileScale' });
    expect(chooseStructuralStrategy(work, { fallback: { minWorkFraction: 0.5 } })).toMatchObject({ matchedRule: 'oldNodeScale' });
  });

  it('allows one high-node source to qualify while honoring both independent rule switches', () => {
    const work = { ...boundary(), changedFiles: 1, affectedOldNodes: 10000, changedBytes: 1 };
    expect(chooseStructuralStrategy(work)).toMatchObject({ strategy: 'rebuild', matchedRule: 'oldNodeScale' });
    expect(chooseStructuralStrategy({ ...work, totalNodes: 40001 }).strategy).toBe('incremental');
    expect(chooseStructuralStrategy({ ...work, affectedOldNodes: 9999 }).strategy).toBe('incremental');
    expect(chooseStructuralStrategy(work, { rules: { oldNodeScale: false } }).strategy).toBe('incremental');
    expect(chooseStructuralStrategy(work, { rules: { fileScale: false } }).strategy).toBe('rebuild');
    expect(chooseStructuralStrategy(boundary(), { rules: { fileScale: false } }).strategy).toBe('incremental');
    expect(chooseStructuralStrategy(boundary(), { rules: { oldNodeScale: false } }).strategy).toBe('rebuild');
    expect(chooseStructuralStrategy(work, { rules: { oldNodeScale: false, fileScale: false } }).reason).toBe('rules-disabled');
  });

  it('uses the larger old/target file population and current target bytes', () => {
    const removed = { ...boundary(), totalFiles: 384, removed: Array.from({ length: 128 }, (_, i) => 'gone' + i),
      changedBytes: 0, affectedOldNodes: 2500, totalNodes: 10000 };
    expect(chooseStructuralStrategy(removed)).toMatchObject({ strategy: 'rebuild',
      metrics: { oldFiles: 512, totalFiles: 384, changedFileFraction: 0.25, changedByteFraction: 0 } });
    expect(chooseStructuralStrategy({ ...removed, totalFiles: 385 }).strategy).toBe('incremental');
    const added = { ...boundary(), added: Array.from({ length: 128 }, (_, i) => 'new' + i) };
    expect(chooseStructuralStrategy(added)).toMatchObject({ strategy: 'rebuild',
      metrics: { oldFiles: 384, totalFiles: 512, changedFileFraction: 0.25, changedByteFraction: 0.25 } });
  });

  it('handles no-op, empty targets and explicit disablement without changing correctness blockers', () => {
    expect(chooseStructuralStrategy({ ...boundary(), changedFiles: 0 }).reason).toBe('no-content-changes');
    const removed = { ...boundary(), totalFiles: 0, totalBytes: 0, removed: Array(512).fill('gone') };
    expect(chooseStructuralStrategy(removed)).toMatchObject({ strategy: 'incremental', reason: 'empty-target' });
    expect(chooseStructuralStrategy(boundary(), { enabled: false, disabledReason: 'invalid-config' }).reason).toBe('invalid-config');
    expect(chooseStructuralStrategy(boundary(), { blockedReason: 'custom-index', enabled: true }).reason).toBe('custom-index');
    expect(chooseStructuralStrategy(boundary(), { configurationChanged: true, upgradeRequired: true }).strategy).toBe('rebuild');
    expect(chooseStructuralStrategy({ ...boundary(), changedFiles: 0 }, { configurationChanged: true }).strategy).toBe('incremental');
  });

  it('validates overrides and reports no predicted timings', () => {
    for (const value of [0, -1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => chooseStructuralStrategy(boundary(), { fallback: { minChangedFiles: value } })).toThrow('Invalid');
    }
    for (const value of [0, -1, 1.1, NaN, Infinity]) {
      expect(() => chooseStructuralStrategy(boundary(), { fallback: { minWorkFraction: value } })).toThrow('Invalid');
    }
    expect(chooseStructuralStrategy(boundary())).not.toHaveProperty('estimatedIncrementalMs');
    expect(chooseStructuralStrategy(boundary())).not.toHaveProperty('estimatedRebuildMs');
  });
});

describe('structural scoped shortcut', () => {
  const scope = { pathsCount: 127, totalOldFiles: 512, affectedOldNodes: 0, totalOldNodes: 40000 };
  it('uses a conservative upper bound for files and nodes', () => {
    expect(canSkipScopedAdaptivePlan(scope)).toBe(true);
    expect(canSkipScopedAdaptivePlan({ ...scope, pathsCount: 128 })).toBe(false);
    expect(canSkipScopedAdaptivePlan({ ...scope, pathsCount: 128, totalOldFiles: 100000 })).toBe(true);
    expect(canSkipScopedAdaptivePlan({ ...scope, pathsCount: 128, totalOldFiles: 0 })).toBe(false);
    expect(canSkipScopedAdaptivePlan({ ...scope, pathsCount: 1, affectedOldNodes: 10000 })).toBe(false);
    expect(canSkipScopedAdaptivePlan({ ...scope, affectedOldNodes: 9999 })).toBe(true);
    expect(canSkipScopedAdaptivePlan({ ...scope, pathsCount: 0 })).toBe(true);
  });
  it('honors only enabled rules and custom thresholds', () => {
    expect(canSkipScopedAdaptivePlan({ ...scope, pathsCount: 128 }, { rules: { fileScale: false } })).toBe(true);
    expect(canSkipScopedAdaptivePlan({ ...scope, affectedOldNodes: 10000 }, { rules: { oldNodeScale: false } })).toBe(true);
    expect(canSkipScopedAdaptivePlan(scope, { fallback: { minChangedFiles: 1, minChangedFraction: 0.01 } })).toBe(false);
    expect(canSkipScopedAdaptivePlan({ ...scope, pathsCount: 100000, affectedOldNodes: 40000 },
      { rules: { fileScale: false, oldNodeScale: false } })).toBe(true);
  });
  it('keeps configuration/upgrade and invalid scope out of the shortcut', () => {
    for (const eligibility of [{ configurationChanged: true }, { upgradeRequired: true }, { blockedReason: 'source' }]) {
      expect(canSkipScopedAdaptivePlan(scope, eligibility)).toBe(false);
    }
    for (const patch of [{ pathsCount: -1 }, { pathsCount: 0.5 }, { totalOldFiles: -1 },
      { totalOldNodes: NaN }, { affectedOldNodes: Infinity }, { affectedOldNodes: 40001 }]) {
      expect(canSkipScopedAdaptivePlan({ ...scope, ...patch })).toBe(false);
    }
  });
  it('never skips a source change that satisfies an enabled rule', () => {
    for (const oldCount of [0, 1, 128, 512, 1000]) {
      for (const removed of [0, Math.min(128, oldCount)]) {
        for (const added of [0, 128, 500]) {
          for (const modified of [0, Math.min(128, oldCount - removed)]) {
            for (const rules of [{}, { fileScale: false }, { oldNodeScale: false }]) {
              const changes = added + removed + modified;
              const work = { ...plan(), added: Array(added).fill('a'), removed: Array(removed).fill('r'),
                changedFiles: changes, totalFiles: oldCount - removed + added, totalNodes: oldCount * 100,
                affectedOldNodes: (removed + modified) * 100, changedBytes: (added + modified) * 1000,
                totalBytes: (oldCount - removed + added) * 1000 };
              const canSkip = canSkipScopedAdaptivePlan({ pathsCount: changes, totalOldFiles: oldCount,
                totalOldNodes: work.totalNodes, affectedOldNodes: work.affectedOldNodes }, { rules });
              if (canSkip) expect(chooseStructuralStrategy(work, { rules }).strategy).toBe('incremental');
            }
          }
        }
      }
    }
  });
});
