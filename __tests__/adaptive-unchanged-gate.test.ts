const fs = require('node:fs') as typeof import('node:fs');
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashContent } from '../src/extraction';
import type { AdaptiveFallbackPolicy } from '../src/sync/adaptive-plan';
// Exercise the built worker's implementation; real-fs race hooks must reach the
// same CommonJS fs object instead of Vitest's immutable builtin ESM namespace.
const { adaptiveConfigFingerprint, createAdaptivePlan, createAdaptivePlanOrUnchanged,
  chooseAdaptiveStrategy } = require('../dist/sync/adaptive-plan') as typeof import('../src/sync/adaptive-plan');
import type { FileRecord } from '../src/types';

const roots: string[] = [];
const repairs: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const repair of repairs.splice(0)) repair();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adaptive-unchanged-')));
  roots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  fs.mkdirSync(path.join(root, 'src', 'nested'), { recursive: true });
  const tracked: FileRecord[] = [];
  for (let i = 0; i < 4; i++) {
    const relative = `src/nested/unit${i}.c`, absolute = path.join(root, relative);
    const source = `int symbol_${i}(void){return ${i};}\n`;
    fs.writeFileSync(absolute, source);
    // A Date cannot preserve arbitrary sub-millisecond stat timestamps.
    fs.utimesSync(absolute, new Date(1700000000000), new Date(1700000000000));
    const stat = fs.statSync(absolute);
    tracked.push({ path: relative, contentHash: hashContent(source), size: stat.size,
      modifiedAt: stat.mtimeMs, indexedAt: 1, nodeCount: i + 1, language: 'c' });
  }
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root });
  return { root, tracked, config: adaptiveConfigFingerprint(root, tracked), file: path.join(root, tracked[0]!.path) };
}
const options = { runtimeKey: 'fixed-path-unmeasured' };

describe('fixed-layout unchanged planning gate', () => {
  it('returns only an incremental hint, with no snapshot, for identical metadata and controls', async () => {
    const { root, tracked, config } = fixture();
    const realpath = vi.spyOn(fs, 'realpathSync');
    expect(await createAdaptivePlanOrUnchanged(root, tracked, options, config)).toBeUndefined();
    // The scanner runs off-thread. This gate resolves the root once; ancestor
    // lstat checks replace thousands of repeated full-path resolutions.
    expect(realpath.mock.calls).toHaveLength(1);
    expect(chooseAdaptiveStrategy(await createAdaptivePlan(root, tracked, options), { version: 1, samples: [] },
      { configFingerprint: config })).toEqual({ strategy: 'incremental', reason: 'no-content-changes' });
  });

  for (const mode of ['add', 'modify', 'unstaged-delete', 'staged-delete', 'ignore', 'config', 'touch'] as const) {
    it(`falls back to the same complete plan for ${mode}`, async () => {
      const { root, tracked, config, file } = fixture();
      if (mode === 'add') fs.writeFileSync(path.join(root, 'added.c'), 'int added(void){return 42;}\n');
      if (mode === 'modify') fs.appendFileSync(file, '// edit\n');
      if (mode === 'unstaged-delete') fs.unlinkSync(file);
      if (mode === 'staged-delete') execFileSync('git', ['rm', '-q', '--', tracked[0]!.path], { cwd: root });
      if (mode === 'ignore') fs.writeFileSync(path.join(root, '.codegraphignore'), tracked[0]!.path + '\n');
      if (mode === 'config') fs.writeFileSync(path.join(root, 'compile_flags.txt'), '-DCHANGED\n');
      if (mode === 'touch') fs.utimesSync(file, new Date(), new Date(Date.now() + 10000));
      const gated = await createAdaptivePlanOrUnchanged(root, tracked, options, config);
      const baseline = await createAdaptivePlan(root, tracked, options);
      expect(gated).toBeDefined();
      expect({ ...gated, planningMs: 0 }).toEqual({ ...baseline, planningMs: 0 });
      const policies: Partial<AdaptiveFallbackPolicy>[] = [{},
        { minChangedFiles: 1, minChangedFraction: .1, minWorkFraction: .1, minAffectedOldNodes: 1, minAffectedOldNodeFraction: .1 },
        { minChangedFiles: 4, minChangedFraction: 1, minWorkFraction: 1, minAffectedOldNodes: 10, minAffectedOldNodeFraction: 1 },
        { minChangedFiles: 5, minAffectedOldNodes: 11 }];
      for (const fallback of policies) {
        expect(chooseAdaptiveStrategy(gated!, { version: 1, samples: [] }, { configFingerprint: config, fallback }))
          .toEqual(chooseAdaptiveStrategy(baseline, { version: 1, samples: [] }, { configFingerprint: config, fallback }));
      }
    });
  }

  it('does not hide same-size/restored-mtime changes from fullHash catchup', async () => {
    const { root, tracked, config, file } = fixture(), before = fs.statSync(file);
    fs.writeFileSync(file, 'int symbol_0(void){return 9;}\n');
    fs.utimesSync(file, before.atime, before.mtime);
    expect(fs.statSync(file).mtimeMs).toBe(before.mtimeMs);
    expect(await createAdaptivePlanOrUnchanged(root, tracked, options, config)).toBeUndefined();
    const plan = await createAdaptivePlanOrUnchanged(root, tracked, { ...options, fullHash: true }, config);
    expect(plan?.modified).toEqual([tracked[0]!.path]);
    expect(plan?.snapshot.files.find(entry => entry.path === tracked[0]!.path)?.contentHash).not.toBe(tracked[0]!.contentHash);
  });

  for (const mode of ['delete', 'edit', 'recreate'] as const) {
    it(`rejects ${mode} after observing a source, before authorizing the hint`, async () => {
      const { root, tracked, config, file } = fixture();
      const original = fs.lstatSync;
      let injected = false;
      vi.spyOn(fs, 'lstatSync').mockImplementation(((target: import('node:fs').PathLike, ...args: unknown[]) => {
        const result = original(target, ...args as []);
        if (!injected && String(target) === file) {
          injected = true;
          if (mode !== 'edit') fs.unlinkSync(file);
          if (mode !== 'delete') fs.writeFileSync(file, 'int changed(void){return 1234;}\n');
        }
        return result;
      }) as typeof fs.lstatSync);
      await expect(createAdaptivePlanOrUnchanged(root, tracked, options, config)).rejects.toThrow(/ENOENT|Source changed/);
      expect(injected).toBe(true);
    });
  }

  it('rejects a directory changed into a symlink after source enumeration', async () => {
    const { root, tracked, config, file } = fixture();
    const directory = path.dirname(file), moved = path.join(root, 'moved');
    const original = fs.lstatSync;
    let injected = false;
    vi.spyOn(fs, 'lstatSync').mockImplementation(((target: import('node:fs').PathLike, ...args: unknown[]) => {
      const result = original(target, ...args as []);
      if (!injected && String(target) === file) {
        injected = true; fs.renameSync(directory, moved); fs.symlinkSync(moved, directory, 'dir');
      }
      return result;
    }) as typeof fs.lstatSync);
    await expect(createAdaptivePlanOrUnchanged(root, tracked, options, config)).rejects.toThrow(/Symlink source/);
  });

  it('falls back when controls change during the final source verification', async () => {
    const { root, tracked, config, file } = fixture();
    const original = fs.lstatSync;
    let observations = 0;
    vi.spyOn(fs, 'lstatSync').mockImplementation(((target: import('node:fs').PathLike, ...args: unknown[]) => {
      const result = original(target, ...args as []);
      if (String(target) === file && ++observations === 2) {
        fs.writeFileSync(path.join(root, 'compile_flags.txt'), '-DCHANGED_DURING_SCAN\n');
      }
      return result;
    }) as typeof fs.lstatSync);
    const plan = await createAdaptivePlanOrUnchanged(root, tracked, options, config);
    expect(plan).toBeDefined();
    expect(chooseAdaptiveStrategy(plan!, { version: 1, samples: [] }, { configFingerprint: config }))
      .toEqual({ strategy: 'rebuild', reason: 'configuration-changed' });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('propagates a real denied ancestor traversal instead of claiming no changes', async () => {
    const { root, tracked, config, file } = fixture();
    const directory = path.dirname(file);
    repairs.push(() => fs.chmodSync(directory, 0o755));
    fs.chmodSync(directory, 0);
    // This is a real POSIX denial; do not count an ineffective chmod as coverage.
    expect(() => fs.lstatSync(file)).toThrow();
    await expect(createAdaptivePlanOrUnchanged(root, tracked, options, config)).rejects.toMatchObject({ code: 'EACCES' });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('propagates a real unreadable control file', async () => {
    const { root, tracked, config } = fixture();
    const control = path.join(root, 'compile_flags.txt');
    fs.writeFileSync(control, '-DCHANGED\n'); fs.chmodSync(control, 0);
    repairs.push(() => fs.chmodSync(control, 0o644));
    expect(() => fs.readFileSync(control)).toThrow();
    await expect(createAdaptivePlanOrUnchanged(root, tracked, options, config)).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('does not authorize empty, missing-identity or escaping tracked inventories', async () => {
    const { root, tracked, config } = fixture();
    expect(await createAdaptivePlanOrUnchanged(root, [], options, config)).toBeDefined();
    expect(await createAdaptivePlanOrUnchanged(root, tracked, options, '')).toBeDefined();
    await expect(createAdaptivePlanOrUnchanged(root, [{ ...tracked[0]!, path: '../escape.c' }], options, config))
      .rejects.toThrow('Tracked source path escapes root');
  });
});
