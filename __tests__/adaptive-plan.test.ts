import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as extraction from '../src/extraction';
import { hashContent } from '../src/extraction';
import { getCodeGraphDir } from '../src/directory';
import type { FileRecord } from '../src/types';
import { adaptiveConfigFingerprint, adaptiveRuntimeKey, adaptiveSampleFromFiles, chooseAdaptiveStrategy,
  createAdaptivePlan, adaptiveChangeGate, hasAdaptiveCalibration, readAdaptiveHistory, recordAdaptiveSample,
  validateAdaptiveSnapshot, type AdaptivePlan, type AdaptiveCostHistory, type AdaptiveCostSample } from '../src/sync/adaptive-plan';

const roots: string[] = [];
function root(): string { const value = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-adaptive-plan-')); roots.push(value); return value; }
function record(base: string, relative: string): FileRecord {
  const full = path.join(base, relative), stat = fs.statSync(full);
  return { path: relative, contentHash: hashContent(fs.readFileSync(full, 'utf8')), language: 'cpp',
    size: stat.size, modifiedAt: stat.mtimeMs, indexedAt: Date.now(), nodeCount: 10 };
}
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function plan(): AdaptivePlan {
  return { runtimeKey: 'runtime', snapshot: { files: [], configSourcePaths: [], configFingerprint: 'config', contentFingerprint: 'content' },
    added: [], modified: ['one'], removed: [], changedFiles: 120, affectedOldNodes: 1200, changedBytes: 12000,
    totalFiles: 1000, totalBytes: 100000, totalNodes: 10000, shape: 'modified-only', planningMs: 0 };
}
function sample(patch: Partial<AdaptiveCostSample> = {}): AdaptiveCostSample {
  return { kind: 'incremental', runtimeKey: 'runtime', configFingerprint: 'config', totalFiles: 1000,
    totalBytes: 100000, totalNodes: 10000, durationMs: 200000, changedFiles: 100, affectedOldNodes: 1000,
    changedBytes: 10000, addedFiles: 0, modifiedFiles: 100, removedFiles: 0, shape: 'modified-only', recordedAt: Date.now(), ...patch };
}
function history(): AdaptiveCostHistory {
  return { version: 1, samples: [sample({ kind: 'full', durationMs: 20000 }), sample(), sample({ changedFiles: 80, affectedOldNodes: 800, durationMs: 160000 }), sample({ changedFiles: 60, affectedOldNodes: 600, durationMs: 120000 })] };
}

describe('adaptive cost decision', () => {
  it('uses measured local costs rather than a changed-file percentage', () => {
    const result = chooseAdaptiveStrategy(plan(), history());
    expect(result.strategy).toBe('rebuild');
    expect(result.estimatedIncrementalMs).toBe(216000);
    expect(result.estimatedRebuildMs).toBe(23000);
    expect(chooseAdaptiveStrategy(plan(), { version: 1, samples: history().samples.map(value => value.kind === 'full' ? { ...value, durationMs: 200000 } : value) }).strategy).toBe('incremental');
  });
  it.each([
    ['no history', (p: AdaptivePlan, h: AdaptiveCostHistory) => { h.samples = []; return p; }],
    ['runtime changed', (p: AdaptivePlan) => ({ ...p, runtimeKey: 'new-runtime' })],
    ['config changed', (p: AdaptivePlan) => ({ ...p, snapshot: { ...p.snapshot, configFingerprint: 'new-config' } })],
    ['target size changed', (p: AdaptivePlan) => ({ ...p, totalBytes: 200000 })],
    ['unseen workload', (p: AdaptivePlan) => ({ ...p, affectedOldNodes: 2001 })],
    ['too few observations', (p: AdaptivePlan, h: AdaptiveCostHistory) => { h.samples.pop(); return p; }],
    ['mixed shape', (p: AdaptivePlan) => ({ ...p, shape: 'mixed' as const })],
    ['no changes', (p: AdaptivePlan) => ({ ...p, changedFiles: 0 })],
  ])('keeps %s incremental', (_name, modify) => {
    const h = history();
    expect(chooseAdaptiveStrategy(modify(plan(), h), h).strategy).toBe('incremental');
  });
  it('admits calibrated mixed branch switches but rejects a different composition', () => {
    const p = { ...plan(), shape: 'mixed' as const, added: Array(12).fill('a'), modified: Array(96).fill('m'), removed: Array(12).fill('r') };
    const h = history();
    h.samples = h.samples.map(value => value.kind === 'full' ? value : { ...value, shape: 'mixed' as const, addedFiles: value.changedFiles * 0.1, modifiedFiles: value.changedFiles * 0.8, removedFiles: value.changedFiles * 0.1 });
    expect(chooseAdaptiveStrategy(p, h).strategy).toBe('rebuild');
    expect(chooseAdaptiveStrategy({ ...p, added: Array(60).fill('a'), modified: Array(48).fill('m') }, h).strategy).toBe('incremental');
  });
  it('uses changed bytes for a calibrated pure-add workload', () => {
    const p = { ...plan(), shape: 'added-only' as const, affectedOldNodes: 0, added: Array(120).fill('a'), modified: [] };
    const h = history();
    h.samples = h.samples.map(value => value.kind === 'full' ? value : { ...value, shape: 'added-only' as const, affectedOldNodes: 0, addedFiles: value.changedFiles, modifiedFiles: 0, removedFiles: 0, changedBytes: value.changedFiles * 100 });
    expect(chooseAdaptiveStrategy(p, h).strategy).toBe('rebuild');
  });
  it('honors explicit eligibility blockers and config mismatches', () => {
    expect(chooseAdaptiveStrategy(plan(), history(), { blockedReason: 'recovery-pending' }).reason).toBe('recovery-pending');
    expect(chooseAdaptiveStrategy(plan(), history(), { configFingerprint: 'other' }).reason).toBe('configuration-changed');
  });
  it('needs both a complete full baseline and several incremental observations', () => {
    expect(hasAdaptiveCalibration(history(), 'runtime')).toBe(true);
    expect(hasAdaptiveCalibration(history(), 'other')).toBe(false);
    expect(hasAdaptiveCalibration({ version: 1, samples: history().samples.slice(1) }, 'runtime')).toBe(false);
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
    expect(result.affectedOldNodes).toBe(20); expect(result.shape).toBe('mixed');
    expect(JSON.stringify(before)).toBe(original);
    expect(fs.existsSync(getCodeGraphDir(dir))).toBe(false);
    expect(await validateAdaptiveSnapshot(dir, result.snapshot)).toBe(true);
    fs.appendFileSync(path.join(dir, 'a.cpp'), 'int later;');
    expect(await validateAdaptiveSnapshot(dir, result.snapshot)).toBe(false);
  });
  it('rejects out-of-root tracked paths', async () => {
    const dir = root(); fs.writeFileSync(path.join(dir, 'a.cpp'), 'int a;');
    await expect(createAdaptivePlan(dir, [{ ...record(dir, 'a.cpp'), path: '../outside.cpp' }], { runtimeKey: 'runtime' })).rejects.toThrow('escapes root');
  });
  it('full validation catches preserved-size/mtime source changes', async () => {
    const dir = root(); fs.writeFileSync(path.join(dir, 'a.cpp'), 'int alpha;\n');
    const original = record(dir, 'a.cpp');
    const result = await createAdaptivePlan(dir, [original], { runtimeKey: 'runtime' });
    fs.writeFileSync(path.join(dir, 'a.cpp'), 'int bravo;\n');
    fs.utimesSync(path.join(dir, 'a.cpp'), new Date(original.modifiedAt), new Date(original.modifiedAt));
    expect(await validateAdaptiveSnapshot(dir, result.snapshot)).toBe(false);
  });
  it('retains removed source ancestors for config verification', async () => {
    const dir = root(); fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', '.gitignore'), '# no rules\n');
    fs.writeFileSync(path.join(dir, 'sub', 'gone.cpp'), 'int gone;\n');
    const original = record(dir, 'sub/gone.cpp'); fs.unlinkSync(path.join(dir, 'sub', 'gone.cpp'));
    const result = await createAdaptivePlan(dir, [original], { runtimeKey: 'runtime' });
    expect(await validateAdaptiveSnapshot(dir, result.snapshot)).toBe(true);
    fs.appendFileSync(path.join(dir, 'sub', '.gitignore'), '*.cpp\n');
    expect(await validateAdaptiveSnapshot(dir, result.snapshot)).toBe(false);
  });
  it('ignores absent controls in new source directories but detects a new real ignore file', () => {
    const dir = root();
    const before = adaptiveConfigFingerprint(dir, [{ path: 'a.cpp' }]);
    fs.mkdirSync(path.join(dir, 'new-sub'));
    expect(adaptiveConfigFingerprint(dir, [{ path: 'a.cpp' }, { path: 'new-sub/b.cpp' }])).toBe(before);
    fs.writeFileSync(path.join(dir, 'new-sub', '.gitignore'), '*.h');
    expect(adaptiveConfigFingerprint(dir, [{ path: 'a.cpp' }, { path: 'new-sub/b.cpp' }])).not.toBe(before);
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

describe('bounded observation history', () => {
  it('does not record incomplete operations and rejects corrupt data', () => {
    const dir = root(); fs.mkdirSync(getCodeGraphDir(dir));
    recordAdaptiveSample(dir, sample(), false);
    expect(readAdaptiveHistory(dir).samples).toEqual([]);
    recordAdaptiveSample(dir, sample(), true);
    expect(readAdaptiveHistory(dir).samples).toHaveLength(1);
    fs.writeFileSync(path.join(getCodeGraphDir(dir), 'adaptive-cost-history.json'), '{broken');
    expect(readAdaptiveHistory(dir).samples).toEqual([]);
  });
  it('bounds history and preserves full observations', () => {
    const dir = root(); fs.mkdirSync(getCodeGraphDir(dir));
    recordAdaptiveSample(dir, sample({ kind: 'full' }), true);
    for (let i = 0; i < 40; i++) recordAdaptiveSample(dir, sample(), true);
    const saved = readAdaptiveHistory(dir);
    expect(saved.samples.length).toBeLessThanOrEqual(24);
    expect(saved.samples.some(value => value.kind === 'full')).toBe(true);
    recordAdaptiveSample(dir, sample({ runtimeKey: 'new-runtime' }), true);
    expect(readAdaptiveHistory(dir).samples).toHaveLength(1);
  });
  it('does not count unchanged co-importers as primary content modifications', () => {
    const file = { path: 'a.cpp', contentHash: 'same', size: 10, nodeCount: 10, modifiedAt: 0, indexedAt: 0, language: 'cpp' as const };
    const observed = adaptiveSampleFromFiles({ kind: 'incremental', runtimeKey: 'runtime', configFingerprint: 'config',
      before: [file], after: [{ ...file, indexedAt: 100, nodeCount: 12 }], changedFilePaths: ['a.cpp'], durationMs: 123 });
    expect(observed.changedFiles).toBe(0); expect(observed.affectedOldNodes).toBe(0); expect(observed.changedBytes).toBe(0);
  });
  it('derives workload from actual file deltas without scanning source', () => {
    const file = { path: 'a.cpp', contentHash: 'old', size: 10, nodeCount: 10, modifiedAt: 0, indexedAt: 0, language: 'cpp' as const };
    const observed = adaptiveSampleFromFiles({ kind: 'incremental', runtimeKey: 'runtime', configFingerprint: 'config',
      before: [file], after: [{ ...file, contentHash: 'new', size: 20 }], durationMs: 123 });
    expect(observed.affectedOldNodes).toBe(10); expect(observed.changedBytes).toBe(20); expect(observed.shape).toBe('modified-only');
  });
});


describe('cheap adaptive negative gate', () => {
  it('rejects unchanged and below-range work without hashing or changing files', async () => {
    const dir = root(); fs.writeFileSync(path.join(dir, 'a.cpp'), 'int before;');
    const tracked = [record(dir, 'a.cpp')];
    expect(await adaptiveChangeGate(dir, tracked, history(), 'runtime')).toEqual({ belowRange: true, candidates: 0, minimum: 60 });
    fs.appendFileSync(path.join(dir, 'a.cpp'), 'int after;');
    expect(await adaptiveChangeGate(dir, tracked, history(), 'runtime')).toEqual({ belowRange: true, candidates: 1, minimum: 60 });
  });
  it('counts additions and removed/ignored tracked files, and admits exactly the lower bound', async () => {
    const dir = root(); fs.writeFileSync(path.join(dir, 'gone.cpp'), 'int gone;');
    const tracked = [record(dir, 'gone.cpp')]; fs.unlinkSync(path.join(dir, 'gone.cpp'));
    fs.writeFileSync(path.join(dir, 'new.cpp'), 'int added;');
    const h = { version: 1 as const, samples: [sample({ changedFiles: 2 }), sample({ runtimeKey: 'other', changedFiles: 1 })] };
    expect(await adaptiveChangeGate(dir, tracked, h, 'runtime')).toEqual({ belowRange: false, candidates: 2, minimum: 2 });
  });
  it('uses the most permissive valid matching runtime sample, never an incompatible larger subset minimum', async () => {
    const dir = root(); fs.writeFileSync(path.join(dir, 'a.cpp'), 'int a;');
    const h = history(); h.samples.push(...Array.from({ length: 3 }, () => sample({ changedFiles: 1, shape: 'added-only', configFingerprint: 'other-config' })));
    expect((await adaptiveChangeGate(dir, [], h, 'runtime')).belowRange).toBe(false);
    expect((await adaptiveChangeGate(dir, [], h, 'unknown')).belowRange).toBe(false);
  });
  it('does not retain an inventory: ordinary plans see changes after the gate', async () => {
    const dir = root(); fs.writeFileSync(path.join(dir, 'a.cpp'), 'int a;');
    const tracked = [record(dir, 'a.cpp')];
    expect((await adaptiveChangeGate(dir, tracked, history(), 'runtime')).belowRange).toBe(true);
    fs.writeFileSync(path.join(dir, 'b.cpp'), 'int b;');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'a.cpp\n');
    const next = await createAdaptivePlan(dir, tracked, { runtimeKey: 'runtime' });
    expect(next.added).toEqual(['b.cpp']); expect(next.removed).toEqual(['a.cpp']);
  });
  it('rejects a stat race instead of treating an inaccessible candidate as unchanged', async () => {
    const dir = root(), absolute = path.join(dir, 'a.cpp');
    fs.writeFileSync(absolute, 'int a;');
    const tracked = [record(dir, 'a.cpp')];
    const scan = vi.spyOn(extraction, 'scanDirectoryAsync').mockImplementationOnce(async () => {
      // The scanner saw the file, but it disappeared before the gate's stat.
      fs.unlinkSync(absolute);
      return ['a.cpp'];
    });
    try {
      await expect(adaptiveChangeGate(dir, tracked, { version: 1, samples: [sample()] }, 'runtime')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { scan.mockRestore(); }
  });
  it('safely over-counts mtime-only changes without authorizing a rebuild', async () => {
    const dir = root(), absolute = path.join(dir, 'a.cpp');
    fs.writeFileSync(absolute, 'int a;');
    const tracked = [record(dir, 'a.cpp')];
    const later = new Date(tracked[0]!.modifiedAt + 2000);
    fs.utimesSync(absolute, later, later);
    const h = { version: 1 as const, samples: [sample({ changedFiles: 1 })] };
    expect(await adaptiveChangeGate(dir, tracked, h, 'runtime')).toEqual({ belowRange: false, candidates: 1, minimum: 1 });
    const strict = await createAdaptivePlan(dir, tracked, { runtimeKey: 'runtime' });
    expect(strict.changedFiles).toBe(0);
    expect(chooseAdaptiveStrategy(strict, h).reason).toBe('no-content-changes');
  });
  it('counts a newly ignored tracked file even though it remains on disk', async () => {
    const dir = root(), absolute = path.join(dir, 'a.cpp');
    fs.writeFileSync(absolute, 'int a;');
    const tracked = [record(dir, 'a.cpp')];
    fs.writeFileSync(path.join(dir, '.gitignore'), 'a.cpp\n');
    const h = { version: 1 as const, samples: [sample({ changedFiles: 1 })] };
    expect(fs.existsSync(absolute)).toBe(true);
    expect(await adaptiveChangeGate(dir, tracked, h, 'runtime')).toEqual({ belowRange: false, candidates: 1, minimum: 1 });
  });

});


describe('modified-only calibrated stat gate', () => {
  it('avoids enumeration when only modifications are calibrated, even if new source appears', async () => {
    const dir = root(); fs.writeFileSync(path.join(dir, 'a.cpp'), 'int a;');
    const tracked = [record(dir, 'a.cpp')]; fs.writeFileSync(path.join(dir, 'new.cpp'), 'int new_source;');
    const scan = vi.spyOn(extraction, 'scanDirectoryAsync');
    try {
      expect(await adaptiveChangeGate(dir, tracked, history(), 'runtime')).toEqual({ belowRange: true, candidates: 0, minimum: 60 });
      expect(scan).not.toHaveBeenCalled();
    } finally { scan.mockRestore(); }
    // Added-only lacks three observations, so declining a rebuild is identical
    // to the strict policy. The ordinary scanner still sees the new source.
    const strict = await createAdaptivePlan(dir, tracked, { runtimeKey: 'runtime' });
    expect(strict.added).toEqual(['new.cpp']); expect(chooseAdaptiveStrategy(strict, history()).strategy).toBe('incremental');
  });
  it.each(['added-only', 'removed-only', 'mixed'] as const)('enumerates when %s also has three samples', async shape => {
    const dir = root(); fs.writeFileSync(path.join(dir, 'a.cpp'), 'int a;');
    const tracked = [record(dir, 'a.cpp')];
    const h = history(); h.samples.push(...Array.from({ length: 3 }, () => sample({ shape, configFingerprint: 'even-incompatible' })));
    const scan = vi.spyOn(extraction, 'scanDirectoryAsync');
    try {
      expect((await adaptiveChangeGate(dir, tracked, h, 'runtime')).belowRange).toBe(true);
      expect(scan).toHaveBeenCalledTimes(1);
    } finally { scan.mockRestore(); }
  });
  it('rejects missing/escaped tracked files instead of making a low-change claim', async () => {
    const dir = root(); fs.writeFileSync(path.join(dir, 'a.cpp'), 'int a;');
    const tracked = [record(dir, 'a.cpp')]; fs.unlinkSync(path.join(dir, 'a.cpp'));
    await expect(adaptiveChangeGate(dir, tracked, history(), 'runtime')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(adaptiveChangeGate(dir, [{ ...tracked[0]!, path: '../escaped.cpp' }], history(), 'runtime')).rejects.toThrow('escapes root');
  });
  it('uses the same size/floored-mtime blind spot as the existing incremental planner', async () => {
    const dir = root(), absolute = path.join(dir, 'a.cpp'); fs.writeFileSync(absolute, 'int a;');
    const tracked = [record(dir, 'a.cpp')]; fs.writeFileSync(absolute, 'int b;');
    fs.utimesSync(absolute, new Date(tracked[0]!.modifiedAt), new Date(tracked[0]!.modifiedAt));
    // Derive expected candidate status from the actual filesystem precision.
    const st = fs.statSync(absolute);
    const expected = Math.floor(st.mtimeMs) === Math.floor(tracked[0]!.modifiedAt) ? 0 : 1;
    expect((await adaptiveChangeGate(dir, tracked, history(), 'runtime')).candidates).toBe(expected);
    const strict = await createAdaptivePlan(dir, tracked, { runtimeKey: 'runtime' });
    expect(strict.changedFiles).toBe(expected);
    expect((await createAdaptivePlan(dir, tracked, { runtimeKey: 'runtime', fullHash: true })).changedFiles).toBe(1);
  });
});
