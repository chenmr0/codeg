import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { canonicalFilePath, clearCanonicalCache, createScanCanonicalizer } from '../src/utils';

let dir: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-scan-context-')));
  fs.mkdirSync(path.join(dir, 'nested'));
  fs.writeFileSync(path.join(dir, 'nested', '中文 space.c'), 'int value;');
  vi.stubEnv('CODEGRAPH_DEDUP_SYMLINKS', '1');
});
afterEach(() => {
  vi.unstubAllEnvs(); clearCanonicalCache();
  fs.rmSync(dir, { recursive: true, force: true });
});

it.each(['absolute', 'relative', 'normalized', 'filesystem-root'])(
  'matches the original canonicalizer with %s roots and unusual paths', kind => {
    const root = kind === 'relative' ? path.relative(process.cwd(), dir)
      : kind === 'normalized' ? path.join(dir, 'nested') + '/..'
      : kind === 'filesystem-root' ? path.parse(dir).root : dir;
    const file = path.join(dir, 'nested', '中文 space.c');
    const rel = path.relative(root, file);
    const paths = [rel, './' + rel, file, 'missing.c', '.', '', '../outside.c'];
    if (process.platform !== 'win32') {
      fs.writeFileSync(path.join(dir, 'back\\slash.c'), 'int value;');
      paths.push(path.relative(root, path.join(dir, 'back\\slash.c')));
    }
    clearCanonicalCache();
    const baseline = paths.map(p => canonicalFilePath(root, p));
    clearCanonicalCache();
    const canonicalize = createScanCanonicalizer(root);
    expect(paths.map(canonicalize)).toEqual(baseline);
  });

it.skipIf(process.platform === 'win32')('preserves symlink roots, ancestor links, leaf links, external links and broken links', () => {
  fs.symlinkSync('nested', path.join(dir, 'alias'));
  fs.symlinkSync('nested/中文 space.c', path.join(dir, 'leaf.data'));
  fs.symlinkSync('missing.c', path.join(dir, 'broken.c'));
  fs.symlinkSync(os.tmpdir(), path.join(dir, 'external'));
  const roots = [dir, path.join(dir, 'alias')];
  for (const root of roots) {
    const paths = ['nested/中文 space.c', 'alias/中文 space.c', 'leaf.data', 'broken.c', 'external', '中文 space.c'];
    clearCanonicalCache();
    const baseline = paths.map(p => canonicalFilePath(root, p));
    clearCanonicalCache();
    expect(paths.map(createScanCanonicalizer(root))).toEqual(baseline);
  }
});

it('captures configuration only for this scan and rereads it for the next scan', () => {
  const calls: string[] = [];
  const resolver = (p: string) => { calls.push(p); return path.join(dir, 'nested', '中文 space.c'); };
  for (const enabled of ['0', '1', 'off', '']) {
    vi.stubEnv('CODEGRAPH_DEDUP_SYMLINKS', enabled);
    clearCanonicalCache(); calls.length = 0;
    const baseline = canonicalFilePath(dir, 'alias.data', undefined, resolver);
    clearCanonicalCache(); calls.length = 0;
    expect(createScanCanonicalizer(dir, resolver)('alias.data')).toBe(baseline);
    expect(calls.length).toBe(enabled === '0' || enabled === 'off' ? 0 : 1);
  }
});
