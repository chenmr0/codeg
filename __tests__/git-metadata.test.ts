import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { repositoryGitDirectories, repositoryExcludePath } from '../src/git-metadata';
import { adaptiveConfigFingerprint } from '../src/sync/adaptive-plan';
import { buildDefaultIgnore, scanDirectory, scanDirectoryAsync } from '../src/extraction';
import { FileWatcher } from '../src/sync/watcher';

const roots: string[] = [];
function temporary() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-git-metadata-')); roots.push(dir); return dir; }
function git(root: string, ...args: string[]) { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function linked() {
  const base = temporary(), main = path.join(base, 'main'), worktree = path.join(base, 'linked');
  fs.mkdirSync(main); git(main, 'init'); git(main, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'initial');
  git(main, 'worktree', 'add', '-b', 'linked-test', worktree);
  return { main, worktree };
}
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('repository-local Git metadata', () => {
  it('uses real Git common-dir exclude in linked worktrees, with portable content fingerprints', async () => {
    const { main, worktree } = linked();
    const exclude = repositoryExcludePath(worktree)!;
    expect(exclude).toBe(path.resolve(worktree, git(worktree, 'rev-parse', '--git-path', 'info/exclude')));
    const before = adaptiveConfigFingerprint(worktree, []);
    expect(before).toBe(adaptiveConfigFingerprint(main, []));
    fs.writeFileSync(exclude, 'hidden.py\n');
    expect(adaptiveConfigFingerprint(worktree, [])).not.toBe(before);
    expect(adaptiveConfigFingerprint(worktree, [])).toBe(adaptiveConfigFingerprint(main, []));
    expect(buildDefaultIgnore(worktree).ignores('hidden.py')).toBe(true);
    fs.writeFileSync(path.join(worktree, 'hidden.py'), 'def hidden(): pass\n');
    fs.writeFileSync(path.join(worktree, 'visible.py'), 'def visible(): pass\n');
    expect(scanDirectory(worktree)).toEqual(['visible.py']);
    expect(await scanDirectoryAsync(worktree)).toEqual(['visible.py']);
    const dirs = repositoryGitDirectories(worktree)!;
    fs.mkdirSync(path.join(dirs.gitDir, 'info')); fs.writeFileSync(path.join(dirs.gitDir, 'info/exclude'), 'visible.py\n');
    expect(buildDefaultIgnore(worktree).ignores('visible.py')).toBe(false);
  });
  it.each(['relative', 'absolute'])('resolves %s gitfile and commondir paths', mode => {
    const { main, worktree } = linked();
    const dirs = repositoryGitDirectories(worktree)!;
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${mode === 'relative' ? path.relative(worktree, dirs.gitDir) : dirs.gitDir}\r\n`);
    fs.writeFileSync(path.join(dirs.gitDir, 'commondir'), `${mode === 'relative' ? path.relative(dirs.gitDir, dirs.commonDir) : dirs.commonDir}\r\n`);
    expect(repositoryExcludePath(worktree)).toBe(repositoryExcludePath(main));
  });
  it('does not hide malformed gitfiles or broken metadata targets', () => {
    const root = temporary();
    expect(repositoryExcludePath(root)).toBeNull();
    fs.writeFileSync(path.join(root, '.git'), 'not a gitfile');
    expect(() => adaptiveConfigFingerprint(root, [])).toThrow(/gitfile/);
    expect(() => buildDefaultIgnore(root)).toThrow(/gitfile/);
    fs.writeFileSync(path.join(root, '.git'), 'gitdir: missing\n');
    expect(() => repositoryExcludePath(root)).toThrow(/ENOENT/);
    fs.mkdirSync(path.join(root, 'metadata'));
    fs.writeFileSync(path.join(root, '.git'), 'gitdir: metadata\n');
    fs.writeFileSync(path.join(root, 'metadata/commondir'), 'missing\n');
    expect(() => repositoryExcludePath(root)).toThrow(/ENOENT/);
  });
  it('a real watcher observes common exclude changes outside the worktree', async () => {
    const { worktree } = linked();
    fs.writeFileSync(path.join(worktree, 'main.py'), 'def main(): pass\n');
    let calls = 0;
    const watcher = new FileWatcher(worktree, async () => { calls++; return { filesChanged: 0, durationMs: 0 }; }, { debounceMs: 30 });
    try {
      expect(watcher.start()).toBe(true);
      fs.writeFileSync(repositoryExcludePath(worktree)!, 'main.py\n');
      const end = Date.now() + 5000;
      while (!calls && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 25));
      expect(calls).toBeGreaterThan(0);
      expect(buildDefaultIgnore(worktree).ignores('main.py')).toBe(true);
    } finally { watcher.stop(); }
  });
});
