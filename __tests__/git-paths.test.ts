import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import ignore from 'ignore';
import { AUTO_RUST_GIT_CANDIDATES, filterGitPaths, gitIgnoreMode, gitRealpathMode } from '../src/extraction/git-paths';
import { ScanDiagnostics } from '../src/extraction/sync-diagnostics';
import { clearCanonicalCache } from '../src/utils';
import { scanDirectory, scanDirectoryAsync } from '../src/extraction';

let dir: string;
const write = (file: string, text = 'int value;\n') => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};
const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, windowsHide: true, stdio: 'pipe' });
const filter = (mode: string, paths: string[], rules = '') => {
  vi.stubEnv('CODEGRAPH_GIT_REALPATH', mode);
  clearCanonicalCache();
  const detail = new ScanDiagnostics();
  return { paths: [...filterGitPaths(dir, paths, ignore().add(rules), [rules], detail)], detail };
};
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-git-paths-'));
  vi.stubEnv('CODEGRAPH_GIT_REALPATH', 'legacy');
  vi.stubEnv('CODEGRAPH_RUST_GIT_IGNORE', '0');
  vi.stubEnv('CODEGRAPH_RUST_SCAN', '0');
  vi.stubEnv('CODEGRAPH_HYBRID_SCAN', '0');
  vi.stubEnv('CODEGRAPH_DEDUP_SYMLINKS', '1');
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); clearCanonicalCache();
  if (!dir.startsWith(path.join(os.tmpdir(), 'cg-git-paths-'))) throw new Error('Unsafe fixture cleanup');
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('Git candidate post-processing', () => {
  it.each(['', 'auto', '0', 'legacy', 'unexpected'])('keeps ignore mode %s on legacy by default', setting => {
    vi.stubEnv('CODEGRAPH_RUST_GIT_IGNORE', setting);
    expect(gitIgnoreMode()).toBe('legacy');
  });
  it.each([['1', 'rust'], ['rust', 'rust'], ['verify', 'verify']] as const)(
    'maps ignore mode %s to %s', (setting, expected) => {
      vi.stubEnv('CODEGRAPH_RUST_GIT_IGNORE', setting);
      expect(gitIgnoreMode()).toBe(expected);
    });
  it('automatically selects native Linux paths only for large Git candidate sets', () => {
    vi.stubEnv('CODEGRAPH_RUST_GIT_IGNORE', undefined);
    vi.stubEnv('CODEGRAPH_GIT_REALPATH', undefined);
    expect(gitIgnoreMode(AUTO_RUST_GIT_CANDIDATES - 1, 'linux')).toBe('legacy');
    expect(gitRealpathMode(AUTO_RUST_GIT_CANDIDATES - 1, 'linux')).toBe('legacy');
    expect(gitIgnoreMode(AUTO_RUST_GIT_CANDIDATES, 'linux')).toBe('rust');
    expect(gitRealpathMode(AUTO_RUST_GIT_CANDIDATES, 'linux')).toBe('native');
    expect(gitIgnoreMode(100_000, 'win32')).toBe('legacy');
    expect(gitRealpathMode(100_000, 'win32')).toBe('legacy');
  });
  it('keeps explicit rollback and force settings above the automatic threshold', () => {
    vi.stubEnv('CODEGRAPH_RUST_GIT_IGNORE', '0'); vi.stubEnv('CODEGRAPH_GIT_REALPATH', 'legacy');
    expect(gitIgnoreMode(100_000, 'linux')).toBe('legacy');
    expect(gitRealpathMode(100_000, 'linux')).toBe('legacy');
    vi.stubEnv('CODEGRAPH_RUST_GIT_IGNORE', '1'); vi.stubEnv('CODEGRAPH_GIT_REALPATH', 'native');
    expect(gitIgnoreMode(1, 'win32')).toBe('rust');
    expect(gitRealpathMode(1, 'win32')).toBe('native');
  });
  it.each(['', 'auto', '0', 'legacy', 'unexpected'])('keeps %s on legacy by default', setting => {
    vi.stubEnv('CODEGRAPH_GIT_REALPATH', setting);
    expect(gitRealpathMode()).toBe('legacy');
  });
  it('preserves candidate order, ignores, Unicode, missing paths and dedup in all modes', () => {
    write('src/中文 空格.c'); write('src/z.c'); write('src/a.c');
    const paths = ['src/z.c', 'src/中文 空格.c', 'src/a.c', 'src/z.c', 'deleted.c'];
    const baseline = filter('legacy', paths, 'src/a.c');
    expect(baseline.paths).toEqual(['src/z.c', 'src/中文 空格.c', 'deleted.c']);
    for (const mode of ['native', 'verify']) {
      const result = filter(mode, paths, 'src/a.c');
      expect(result.paths).toEqual(baseline.paths);
      expect(result.detail).toMatchObject({ gitPathMode: mode, gitIgnored: 1, gitCanonicalCalls: 4,
        gitRealpathCalls: 3, gitRealpathErrors: 1, gitPathMismatches: 0, gitCanonicalDuplicates: 1 });
    }
  });
  it('preserves internal/external directory links and observes retargeting after cache clear', () => {
    write('a/x.c'); write('b/x.c');
    fs.symlinkSync(path.join(dir, 'a'), path.join(dir, 'alias'), 'junction');
    fs.symlinkSync(os.tmpdir(), path.join(dir, 'external'), 'junction');
    const paths = ['alias/x.c', 'a/x.c', 'b/x.c', 'external'];
    expect(filter('native', paths).paths).toEqual(filter('legacy', paths).paths);
    expect(filter('verify', paths).detail.gitPathMismatches).toBe(0);
    fs.unlinkSync(path.join(dir, 'alias'));
    fs.symlinkSync(path.join(dir, 'b'), path.join(dir, 'alias'), 'junction');
    expect(filter('native', ['alias/x.c']).paths).toEqual(['b/x.c']);
    expect(filter('native', paths, 'alias/').paths).toEqual(filter('legacy', paths, 'alias/').paths);
  });
  it('does not use the native backend when symlink dedup is explicitly disabled', () => {
    vi.stubEnv('CODEGRAPH_DEDUP_SYMLINKS', '0');
    const result = filter('native', ['missing.c', 'missing.c']);
    expect(result.paths).toEqual(['missing.c']);
    expect(result.detail).toMatchObject({ gitCanonicalCalls: 2, gitRealpathCalls: 0, gitNativeCalls: 0 });
  });
  it('falls back to legacy on native failures, without dropping a valid path', () => {
    write('a.c');
    vi.spyOn(fs.realpathSync, 'native').mockImplementation(() => { throw new Error('native failure'); });
    for (const mode of ['native', 'verify']) {
      const result = filter(mode, ['a.c']);
      expect(result.paths).toEqual(['a.c']);
      expect(result.detail).toMatchObject({ gitNativeCalls: 1, gitNativeFallbacks: 1, gitRealpathErrors: 0 });
    }
  });
  it('verify reports successful-but-different native paths and always returns legacy', () => {
    write('a.c'); write('different.c');
    vi.spyOn(fs.realpathSync, 'native').mockReturnValue(path.join(dir, 'different.c'));
    const result = filter('verify', ['a.c']);
    expect(result.paths).toEqual(['a.c']);
    expect(result.detail.gitPathMismatches).toBe(1);
  });
  it('verify rejects native success when legacy failed, retaining logical fallback', () => {
    vi.spyOn(fs.realpathSync, 'native').mockReturnValue(path.join(dir, 'native-only.c'));
    const result = filter('verify', ['missing.c']);
    expect(result.paths).toEqual(['missing.c']);
    expect(result.detail).toMatchObject({ gitPathMismatches: 1, gitRealpathErrors: 1, gitNativeCalls: 1 });
  });
  it('does not prefilter a candidate based on its logical extension', () => {
    write('target.c');
    vi.spyOn(fs.realpathSync, 'native').mockReturnValue(path.join(dir, 'target.c'));
    expect(filter('native', ['alias.not-source']).paths).toEqual(['target.c']);
  });
  it('keeps quiet and verbose file results identical, with no quiet per-file clocks', () => {
    write('a.c');
    const expected = filter('native', ['a.c']).paths;
    clearCanonicalCache();
    const clock = vi.spyOn(performance, 'now');
    expect([...filterGitPaths(dir, ['a.c'], ignore(), [])]).toEqual(expected);
    expect(clock).not.toHaveBeenCalled();
  });
  it('records ignore errors without swallowing them or leaking paths into diagnostics', () => {
    const detail = new ScanDiagnostics();
    expect(() => filterGitPaths(dir, ['secret.c'], { ignores() { throw new Error('broken rule'); } }, [], detail))
      .toThrow('broken rule');
    expect(detail.gitIgnoreMs).toBeGreaterThanOrEqual(0);
    expect(detail.format()).not.toContain('secret.c');
    expect(detail.format()).toContain('gitPathMode=legacy');
  });
  it('keeps actual Git tracked/untracked selection, excludes, embedded repos and async order', async () => {
    git('init', '-q');
    write('src/tracked.c'); write('src/gone.c'); write('src/blocked.c');
    write('node_modules/dependency.c'); write('src/.gitignore', 'blocked.c\n');
    git('add', '-f', 'src/tracked.c', 'src/gone.c', 'src/blocked.c', 'node_modules/dependency.c');
    fs.unlinkSync(path.join(dir, 'src/gone.c'));
    write('src/new.c'); write('src/untracked-ignored.c'); write('local.c');
    write('global-ignore.txt', '*untracked-ignored.c\n');
    git('config', 'core.excludesFile', path.join(dir, 'global-ignore.txt'));
    write('.git/info/exclude', 'local.c\n');
    write('.codegraphignore', 'src/new.c\n');
    write('child/inner.c');
    execFileSync('git', ['init', '-q'], { cwd: path.join(dir, 'child'), windowsHide: true });
    clearCanonicalCache();
    const baseline = scanDirectory(dir);
    expect(baseline).toEqual(['src/blocked.c', 'src/gone.c', 'src/tracked.c', 'child/inner.c']);
    for (const mode of ['native', 'verify']) {
      vi.stubEnv('CODEGRAPH_GIT_REALPATH', mode); clearCanonicalCache();
      const detail = new ScanDiagnostics();
      expect(scanDirectory(dir, undefined, detail)).toEqual(baseline);
      expect(detail).toMatchObject({ mode: 'git', gitPathMode: mode, gitPathMismatches: 0, gitCommands: 5 });
      clearCanonicalCache();
      expect(await scanDirectoryAsync(dir)).toEqual(baseline);
    }
  });
  it('runs the installed-shape read-only benchmark without creating a database or modifying the repo', () => {
    git('init', '-q'); write('a.c'); git('add', 'a.c');
    const statusBefore = git('status', '--porcelain=v1', '-z').toString();
    const lines = execFileSync(process.execPath, [path.resolve('scripts/benchmark-git-paths.mjs'), dir, '1'],
      { encoding: 'utf8', windowsHide: true, timeout: 30000 }).trim().split('\n').map(line => JSON.parse(line));
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatchObject({ verification: true, requestedMode: 'verify', gitPathMismatches: 0 });
    expect(lines[1]).toMatchObject({ requestedMode: 'legacy', mode: 'git' });
    expect(lines[2]).toMatchObject({ requestedMode: 'native', mode: 'git' });
    expect(lines[3]).toMatchObject({ summary: true, parity: true, sourceFiles: 1 });
    expect(new Set(lines.map(line => line.hash)).size).toBe(1);
    expect(fs.existsSync(path.join(dir, '.codegraph'))).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'a.c'), 'utf8')).toBe('int value;\n');
    expect(git('status', '--porcelain=v1', '-z').toString()).toBe(statusBefore);
  });
});
