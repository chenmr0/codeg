/** Real executable parity gate. Set CODEGRAPH_RUST_SCAN_EXPECT=1 in native CI. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import ignore from 'ignore';
import { scanDirectory, scanDirectoryAsync } from '../src/extraction';
import { ScanDiagnostics } from '../src/extraction/sync-diagnostics';
import { runRustGitFilter, type RustScanCapture } from '../src/extraction/rust-scan';
import { clearCanonicalCache } from '../src/utils';

const binary = process.env.CODEGRAPH_RUST_SCAN_PATH ?? path.resolve(__dirname, '../dist/native-scan',
  `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'codegraph-scan.exe' : 'codegraph-scan');
const available = fs.existsSync(binary);
if (process.env.CODEGRAPH_RUST_SCAN_EXPECT === '1') {
  it('requires the native executable in this test job', () => expect(available, binary).toBe(true));
}

describe.skipIf(!available)('real Rust scanner differential gate', () => {
  let dir: string;
  const write = (file: string, content = 'int value;\n') => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-native-parity-'));
    vi.stubEnv('CODEGRAPH_RUST_SCAN_PATH', binary);
    vi.stubEnv('CODEGRAPH_HYBRID_SCAN', '0');
    write('.codegraphignore', '!/extra/\n');
  });
  afterEach(() => {
    vi.unstubAllEnvs(); clearCanonicalCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const compare = (expectedStatus = 'used') => {
    vi.stubEnv('CODEGRAPH_RUST_SCAN', '0'); clearCanonicalCache();
    const baseline = scanDirectory(dir);
    vi.stubEnv('CODEGRAPH_RUST_SCAN', '1'); clearCanonicalCache();
    const diag = new ScanDiagnostics(); const capture: RustScanCapture = {};
    expect(scanDirectory(dir, undefined, diag, capture)).toEqual(baseline);
    expect(diag.nativeStatus, diag.nativeReason).toBe(expectedStatus);
    if (expectedStatus === 'used') {
      expect(capture.snapshot?.paths).toEqual(baseline);
      for (const file of baseline) {
        const stat = fs.statSync(path.join(dir, file));
        expect(capture.snapshot?.stats.get(file)).toEqual({ path: file, size: stat.size, mtimeMs: Math.floor(stat.mtimeMs) });
      }
    } else expect(capture.snapshot).toBeUndefined();
  };

  it('matches ASCII order, extensions, special route/template files and metadata', () => {
    for (const file of ['src/z.c', 'src/A.h', 'src/a space.cpp', 'src/deep/b.c', 'root.C',
      'conf/routes', 'app/conf/routes', 'app/foo.routes', 'templates/a.json', 'a/sections/group.json',
      'templates/.json', 'app/config.json', 'notes.md', '.hidden.c']) write(file);
    compare();
  });

  it('matches root and nested rules, including anchored re-inclusion below excluded parents', () => {
    write('.codegraphignore', '/*\n!/a/b/\n!/a/c/\n');
    write('a/b/yes.c'); write('a/b/no.c'); write('a/c/yes.c'); write('other/no.c');
    write('a/b/.gitignore', 'no.c\n');
    compare();
  });

  it('preserves root info/exclude and does not load unrelated global configuration', () => {
    write('.git/info/exclude', 'hidden/\n');
    write('hidden/no.c'); write('visible/yes.c'); write('extra/yes.c');
    compare();
  });

  it('keeps the no-reinclude-under-blocked-parent rule for nested matchers', () => {
    write('src/.gitignore', 'blocked/\n!blocked/yes.c\n');
    write('src/blocked/yes.c'); write('src/ok.c');
    compare();
  });

  it('matches double-star globs and file negations', () => {
    write('.gitignore', 'tests/**/test_*\n!tests/**/test_*.*\n*.tmp\n');
    write('tests/test_A.c'); write('tests/deep/test_B.c'); write('tests/deep/test_noext');
    write('src/normal.c'); compare();
  });

  it('skips all CodeGraph data directories and the active override', () => {
    vi.stubEnv('CODEGRAPH_DIR', 'custom-index');
    write('.codegraph/a.c'); write('.codegraph-other/a.c'); write('custom-index/a.c'); write('src/a.c');
    compare();
  });

  it('falls back as a whole for unsupported patterns and Unicode filenames', () => {
    write('src/a.c'); write('.gitignore', '[ab].c\n'); compare('fallback');
    write('.gitignore', ''); write('src/中文.c'); compare('fallback');
  });

  it('ignores ordinary Unicode documentation without deferring the source scan', () => {
    write('AGENTS - 副本.md'); write('docs/中文报告.txt'); write('src/a.c');
    compare();
  });

  it.each(['中文/a.c', 'src/中文.Kt', 'templates/中文.json', 'src/中文.routes'])(
    'still defers Unicode directories and possible source paths: %s', file => {
      write('src/a.c'); write(file); compare('fallback');
    });

  it('defers junction/symlink semantics without losing files', () => {
    write('real/a.c');
    fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'alias'), 'junction');
    compare('fallback');
  });

  it('supports verify mode and always returns the JS result without snapshot reuse', async () => {
    write('src/a.c');
    vi.stubEnv('CODEGRAPH_RUST_SCAN', 'verify');
    const diag = new ScanDiagnostics(); const capture: RustScanCapture = {};
    expect(await scanDirectoryAsync(dir, undefined, diag, capture)).toEqual(['src/a.c']);
    expect(diag.nativeStatus, diag.nativeReason).toBe('verified');
    expect(capture.snapshot).toBeUndefined();
  });

  it('filters caller-supplied Git candidates as ordered indexes', () => {
    const candidates = ['src/a.c', 'build/no.c', 'deep/value.tmp', 'keep.tmp', 'src/b.c'];
    expect(runRustGitFilter(dir, ['build/\n*.tmp\n!/keep.tmp\n'], candidates)).toMatchObject({
      included: [0, 3, 4],
    });
    expect(() => runRustGitFilter(dir, ['[ab].c\n'], candidates)).toThrow('unsupported-rule');
    expect(runRustGitFilter(dir, [], [...candidates, '中文.c']).deferred).toEqual([5]);
  });

  it('matches the JS root matcher across supported glob and negation shapes', () => {
    const candidates = ['foo', 'foo/a.c', 'deep/foo', 'deep/foo/a.c', 'a/x/b.c', 'a/x/y/b.c',
      'a/one.c', 'a/deep/two.h', 'root/a.c', 'ROOT/KEEP.C', 'notes.tmp', 'keep.tmp',
      '.hidden.c', 'dir/a space.c', 'src/test1.c', 'src/testA.c'];
    const groups = [
      ['foo\n!deep/foo\n'],
      ['foo/\n!foo/a.c\n'],
      ['/root/*\n!/root/keep.c\n'],
      ['a/**/b.c\n'],
      ['a/*\n!a/one.c\n'],
      ['*.tmp\n!/keep.tmp\n'],
      ['src/test?.c\n'],
      ['# comment\n.hidden.c\ndir/a space.c\n'],
      ['missing/\n', '*.tmp\n', '!keep.tmp\n'],
    ];
    for (const rootRules of groups) {
      const matcher = ignore({ ignorecase: true });
      for (const group of rootRules) matcher.add(group);
      const expected = candidates.map((candidate, index) => matcher.ignores(candidate) ? -1 : index)
        .filter(index => index >= 0);
      expect(runRustGitFilter(dir, rootRules, candidates).included, rootRules.join('|')).toEqual(expected);
    }
  });
});
