import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { scanDirectory, scanDirectoryAsync } from '../src/extraction';
import { ScanDiagnostics } from '../src/extraction/sync-diagnostics';
import { planSupplementRoots } from '../src/extraction/hybrid-scan';
import { clearCanonicalCache } from '../src/utils';
import CodeGraph from '../src/index';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, realpathSync: vi.fn(actual.realpathSync) };
});

let dir: string;
let cg: CodeGraph | undefined;
const write = (file: string, content = 'int value;\n') => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
};
const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, windowsHide: true, stdio: 'pipe' });
const scan = (hybrid = true, reuse = true) => {
  vi.stubEnv('CODEGRAPH_HYBRID_SCAN', hybrid ? '1' : '0');
  vi.stubEnv('CODEGRAPH_NO_HYBRID_SCAN', hybrid ? '0' : '1');
  vi.stubEnv('CODEGRAPH_NO_SCAN_PATH_REUSE', reuse ? '0' : '1');
  clearCanonicalCache();
  const diagnostics = new ScanDiagnostics();
  return { files: scanDirectory(dir, undefined, diagnostics), diagnostics };
};
const parity = () => {
  const baseline = scan(false, false);
  const optimized = scan();
  expect(optimized.files).toEqual(baseline.files); // preserve order, not just set
  return optimized;
};
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-scan-opt-'));
  cg = undefined;
  git('init', '-q');
  write('.codegraphignore', '!/extra/\n');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearCanonicalCache();
  cg?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('literal supplement planning', () => {
  it('collapses overlapping directory roots and detects no-negation scans', () => {
    expect(planSupplementRoots('!/one/\n!/one/two/\n!/Other/\n!/other/\n')).toEqual(['one', 'other']);
    expect(planSupplementRoots('#! comment\n\\!literal\n!\n*.tmp\n')).toBeUndefined();
  });
  it.each(['!extra/', '!/extra', '!/x/*.h', '!/x/[ab]/', '!/', '!/../x/',
    '!/a//b/', '!/中文/', ' !/x/', '!/x/ ', '!/a\\ b/'])('falls back for %s', rule => {
    expect(planSupplementRoots(rule)).toBeNull();
  });
});

describe('scan parity and reduced filesystem calls', () => {
  it('defaults to parent reuse, with hybrid explicitly opt-in and rollback taking precedence', () => {
    write('extra/a.c');
    vi.stubEnv('CODEGRAPH_HYBRID_SCAN', '0');
    vi.stubEnv('CODEGRAPH_NO_SCAN_PATH_REUSE', '0');
    let diag = new ScanDiagnostics();
    clearCanonicalCache(); scanDirectory(dir, undefined, diag);
    expect(diag).toMatchObject({ mode: 'walk', canonicalFromParent: 1 });
    vi.stubEnv('CODEGRAPH_HYBRID_SCAN', '1');
    vi.stubEnv('CODEGRAPH_NO_HYBRID_SCAN', '1');
    diag = new ScanDiagnostics();
    clearCanonicalCache(); scanDirectory(dir, undefined, diag);
    expect(diag.mode).toBe('walk');
  });
  it('reuses parent realpaths only for known ordinary entries on full walk', () => {
    for (let i = 0; i < 30; i++) write(`src/f${i}.c`);
    const realpath = vi.mocked(fs.realpathSync);
    realpath.mockClear();
    const baseline = scan(false, false);
    const before = realpath.mock.calls.length;
    realpath.mockClear();
    const optimized = scan(false, true);
    expect(optimized.files).toEqual(baseline.files);
    expect(before - realpath.mock.calls.length).toBe(30);
    expect(optimized.diagnostics.canonicalFromParent).toBe(30);
  });

  it('merges tracked, untracked and gitignored source with identical nested ignore rules and DFS order', () => {
    write('.gitignore', 'extra/\n');
    write('src/z.c'); write('src/deep/a.c'); write('src/a.c');
    write('src/deep/.gitignore', 'skip.c\n'); write('src/deep/skip.c');
    write('extra/added.c'); write('extra/nested/yes.c');
    write('extra/nested/.gitignore', 'no.c\n'); write('extra/nested/no.c');
    write('root.c');
    git('add', 'src', 'root.c');
    git('add', '-f', 'src/deep/skip.c');
    write('src/untracked.c');
    const result = parity();
    expect(result.diagnostics.mode).toBe('hybrid');
    expect(result.files).toContain('extra/added.c');
    expect(result.files).not.toContain('src/deep/skip.c');
    expect(result.files).not.toContain('extra/nested/no.c');
    expect(result.diagnostics.supplementRoots).toBe(1);
  });

  it('retains the anchored whitelist expansion and root/nested precedence', () => {
    write('.codegraphignore', '/*\n!/a/b/\n!/a/c/\n');
    write('a/b/yes.c'); write('a/c/yes.c'); write('a/unwanted.c'); write('other/no.c');
    write('a/.gitignore', 'c/\n');
    expect(parity().files).toEqual(['a/b/yes.c']);
  });

  it('handles case variants, default-ignored targets and missing supplement roots', () => {
    write('.codegraphignore', '!/DiST/\n!/missing/\n');
    write('dist/yes.c'); write('src/normal.c');
    expect(parity().files).toEqual(['dist/yes.c', 'src/normal.c']);
  });

  it('honors root info/exclude but does not accidentally adopt global Git excludes', () => {
    write('.git/info/exclude', 'local/\n');
    write('local/no.c'); write('global/yes.c'); write('extra/yes.c');
    write('global-ignore.txt', 'global/\n');
    git('config', 'core.excludesFile', path.join(dir, 'global-ignore.txt'));
    const result = parity();
    expect(result.diagnostics.mode).toBe('hybrid');
    expect(result.files).toContain('global/yes.c');
    expect(result.files).not.toContain('local/no.c');
  });

  it('omits deleted tracked paths and sees new ignore configuration every invocation', () => {
    write('src/old.c'); write('extra/new.c'); git('add', 'src/old.c');
    fs.unlinkSync(path.join(dir, 'src/old.c'));
    expect(parity().files).toEqual(['extra/new.c']);
    write('.codegraphignore', '/*\n!/different/\n'); write('different/next.c');
    expect(parity().files).toEqual(['different/next.c']);
  });

  it('preserves NUL-delimited Unicode and space-containing source filenames', () => {
    write('src/中文 空格.c'); write('src/a.c'); git('add', 'src');
    expect(parity().files).toContain('src/中文 空格.c');
  });

  it('falls back on directory links and observes retargeting on the next scan', () => {
    write('a/x.c'); write('b/y.c');
    fs.symlinkSync(path.join(dir, 'a'), path.join(dir, 'alias'), 'junction');
    const first = parity();
    expect(first.diagnostics).toMatchObject({ mode: 'walk', fallbackReason: 'hybrid-unsafe', failureStage: 'symlink' });
    fs.unlinkSync(path.join(dir, 'alias'));
    fs.symlinkSync(path.join(dir, 'b'), path.join(dir, 'alias'), 'junction');
    expect(parity().files).toEqual(['a/x.c', 'b/y.c']);
  });

  it('falls back on embedded repositories rather than silently losing their source', () => {
    write('child/inside.c');
    execFileSync('git', ['init', '-q'], { cwd: path.join(dir, 'child'), windowsHide: true });
    const result = parity();
    expect(result.files).toEqual(['child/inside.c']);
    expect(result.diagnostics.mode).toBe('walk');
  });

  it('falls back on gitlinks rather than missing untracked submodule contents', () => {
    write('child/new.c');
    git('update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},child`);
    const result = parity();
    expect(result.files).toEqual(['child/new.c']);
    expect(result.diagnostics).toMatchObject({ mode: 'walk', fallbackReason: 'hybrid-unsafe', failureStage: 'submodule' });
  });

  it('keeps non-git projects and unsupported negations on full walk', () => {
    write('.codegraphignore', '!extra/\n'); write('extra/yes.c');
    expect(parity().diagnostics).toMatchObject({ mode: 'walk', fallbackReason: 'codegraph-negation' });
    write('.codegraphignore', '!/extra/\n');
    // Remove only this fixture's Git metadata; source stays in place.
    fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true });
    expect(parity().diagnostics).toMatchObject({ mode: 'walk', fallbackReason: 'git-path-error' });
  });

  it('returns the same results and progress count through sync and async entry points', async () => {
    write('extra/a.c'); write('src/b.c');
    const result = parity();
    clearCanonicalCache();
    const progress = vi.fn();
    const diagnostics = new ScanDiagnostics();
    expect(await scanDirectoryAsync(dir, progress, diagnostics)).toEqual(result.files);
    expect(progress).toHaveBeenCalledTimes(2);
    expect(diagnostics.mode).toBe('hybrid');
  });

  it('still detects committed edits, additions and deletions during sync', async () => {
    vi.stubEnv('CODEGRAPH_HYBRID_SCAN', '1');
    write('api.c', 'int old_api(void) { return 1; }\n');
    git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial');
    cg = CodeGraph.initSync(dir); await cg.indexAll();
    write('api.c', 'int new_api(void) { return 2; }\n'); write('extra/new.c', 'int added(void) { return 3; }\n');
    git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'update');
    const result = await cg.sync();
    expect(result).toMatchObject({ filesAdded: 1, filesModified: 1, filesRemoved: 0 });
    expect(cg.getNodesByName('new_api')).toHaveLength(1);
    fs.unlinkSync(path.join(dir, 'api.c')); git('add', '-u');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'delete');
    expect(await cg.sync()).toMatchObject({ filesRemoved: 1 });
    expect(cg.getNodesByName('new_api')).toHaveLength(0);
  });
});
