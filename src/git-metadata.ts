/** Repository-local Git metadata, without consulting user/global ignore settings.
 * A linked worktree's .git is a gitfile; info/exclude belongs to its common
 * directory, not the per-worktree gitdir. Paths here deliberately never enter
 * portable configuration fingerprints: only the exclude file's content does.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

function optionalStat(file: string): fs.Stats | null {
  try { return fs.statSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function repositoryGitDirectories(root: string): { gitDir: string; commonDir: string } | null {
  const entry = path.resolve(root, '.git');
  const stat = optionalStat(entry);
  if (!stat) return null;
  let gitDir = entry;
  if (stat.isFile()) {
    const match = /^gitdir: (.+?)[\r\n]*$/.exec(fs.readFileSync(entry, 'utf8'));
    if (!match) throw new Error(`Invalid Git gitfile: ${entry}`);
    gitDir = path.resolve(root, match[1]!);
  } else if (!stat.isDirectory()) {
    throw new Error(`Invalid Git metadata entry: ${entry}`);
  }
  if (!fs.statSync(gitDir).isDirectory()) throw new Error(`Git directory is not a directory: ${gitDir}`);
  const commonFile = path.join(gitDir, 'commondir');
  let commonDir = gitDir;
  if (optionalStat(commonFile)) {
    const value = fs.readFileSync(commonFile, 'utf8').replace(/[\r\n]+$/, '');
    if (!value || /[\r\n]/.test(value)) throw new Error(`Invalid Git commondir: ${commonFile}`);
    commonDir = path.resolve(gitDir, value);
    if (!fs.statSync(commonDir).isDirectory()) throw new Error(`Git common directory is not a directory: ${commonDir}`);
  }
  return { gitDir, commonDir };
}

export function repositoryExcludePath(root: string): string | null {
  const dirs = repositoryGitDirectories(root);
  return dirs ? path.join(dirs.commonDir, 'info', 'exclude') : null;
}
