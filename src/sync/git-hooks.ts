/**
 * Git Sync Hooks
 *
 * When the live file watcher is disabled (e.g. on WSL2 `/mnt/*` drives,
 * see watch-policy.ts), the CodeGraph index would otherwise go stale until
 * the user runs `codegraph sync` by hand. As an opt-in alternative, we can
 * install git hooks that refresh the index after the operations that change
 * files on disk: commit, merge (covers `git pull`), and checkout.
 *
 * Hooks invoke the WX package directly in the background. Marker comments
 * delimit the managed block; outside user-authored commands are preserved.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { getWxCliCommand } from '../cli/launcher';
import { codeGraphDirName } from '../directory';
import { GIT_HOOK_MARKERS, resetManagedSections } from '../installer/managed-sections';
import { atomicWriteFileSync, readConfigFile, removeConfigFile, recordCleanup, withConfigTransaction } from '../installer/config-transaction';

const MARKER_BEGIN = '# >>> codegraph-wx sync hook >>>';
const MARKER_END = '# <<< codegraph-wx sync hook <<<';

export type GitHookName = 'post-commit' | 'post-merge' | 'post-checkout';

/** Hooks installed by default: commit, merge (git pull), and checkout. */
export const DEFAULT_SYNC_HOOKS: GitHookName[] = ['post-commit', 'post-merge', 'post-checkout'];

export interface GitHookResult {
  /** Hook names that were created or updated. */
  installed: GitHookName[];
  /** Resolved hooks directory, or null when not a git repo. */
  hooksDir: string | null;
  /** Reason nothing happened (e.g. not a git repository). */
  skipped?: string;
  notes?: string[];
}

/**
 * Whether `projectRoot` is inside a git working tree. Returns false if git
 * isn't installed or the path isn't a repo.
 */
export function isGitRepo(projectRoot: string): boolean {
  try {
    const out = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
    return out === 'true';
  } catch {
    return false;
  }
}

/**
 * Resolve the git hooks directory for a project, honoring `core.hooksPath`
 * and git worktrees. Returns an absolute path, or null when not a repo.
 */
function gitHooksDir(projectRoot: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
    if (!out) return null;
    return path.isAbsolute(out) ? out : path.resolve(projectRoot, out);
  } catch {
    return null;
  }
}

/** The shell snippet (between markers) injected into each hook. */
function markerBlock(): string {
  const cli = getWxCliCommand();
  // Git runs these hooks in sh, including Git for Windows. Quote paths as
  // shell literals; forward slashes keep Windows drive paths usable in sh.
  const quote = (value: string): string => "'" + value.replace(/'/g, "'\"'\"'") + "'";
  const shellPath = (value: string): string => quote(process.platform === 'win32'
    ? value.replace(/\\/g, '/') : value);
  const command = [cli.command, ...cli.args].map(shellPath).join(' ');
  const dataDir = codeGraphDirName();
  return [
    MARKER_BEGIN,
    '# Keeps the CodeGraph index fresh while the live file watcher is off',
    '# (e.g. WSL2 /mnt drives). Runs in the background so it never blocks git.',
    '# Managed by codegraph-wx; remove with `codegraph uninit` or delete this block.',
    `if [ -x ${shellPath(cli.command)} ] && [ -f ${shellPath(cli.args[0]!)} ] && [ -f ${quote(dataDir + '/codegraph.db')} ]; then`,
    `  ( CODEGRAPH_DIR=${quote(dataDir)} ${command} sync >/dev/null 2>&1 & ) >/dev/null 2>&1`,
    'fi',
    MARKER_END,
  ].join('\n');
}

/** Remove our marker block (and the marker lines) from hook content. */
function stripMarkerBlock(content: string): string {
  return resetManagedSections(content, GIT_HOOK_MARKERS).content;
}

/** Whether a hook body is just a shebang / blank lines (i.e. only ever ours). */
function isEffectivelyEmpty(content: string): boolean {
  return content
    .split('\n')
    .map((l) => l.trim())
    .every((l) => l.length === 0 || l.startsWith('#!'));
}

/**
 * Install (or update) the CodeGraph sync hooks in a git repository.
 * Idempotent: re-running replaces our marker block rather than duplicating
 * it, and any user-authored hook content is preserved.
 */
export function installGitSyncHook(
  projectRoot: string,
  hooks: GitHookName[] = DEFAULT_SYNC_HOOKS,
): GitHookResult {
  return withConfigTransaction('git sync hooks install', () => installHooks(projectRoot, hooks));
}

function installHooks(projectRoot: string, hooks: GitHookName[]): GitHookResult {
  const hooksDir = gitHooksDir(projectRoot);
  if (!hooksDir) {
    return { installed: [], hooksDir: null, skipped: 'not a git repository' };
  }

  const block = markerBlock();
  const installed: GitHookName[] = [];

  for (const hook of hooks) {
    const file = path.join(hooksDir, hook);
    const original = readConfigFile(file);
    const reset = resetManagedSections(original || '#!/bin/sh\n', GIT_HOOK_MARKERS, block, file);
    // Also restore executable mode if an otherwise current hook lost it.
    atomicWriteFileSync(file, reset.content, 0o755);
    if (reset.content !== original) {
      if (reset.count) recordCleanup(`Replaced ${reset.count} managed Git hook blocks in ${file}.`);
    }
    installed.push(hook);
  }

  return { installed, hooksDir };
}

/**
 * Remove the CodeGraph sync hooks. Strips only our marker block; deletes the
 * hook file entirely when nothing but a shebang remains, otherwise rewrites
 * the user's content untouched.
 */
export function removeGitSyncHook(
  projectRoot: string,
  hooks: GitHookName[] = DEFAULT_SYNC_HOOKS,
): GitHookResult {
  return withConfigTransaction('git sync hooks remove', () => removeHooks(projectRoot, hooks));
}

function removeHooks(projectRoot: string, hooks: GitHookName[]): GitHookResult {
  const hooksDir = gitHooksDir(projectRoot);
  if (!hooksDir) {
    return { installed: [], hooksDir: null, skipped: 'not a git repository' };
  }

  const removed: GitHookName[] = [];

  for (const hook of hooks) {
    const file = path.join(hooksDir, hook);
    if (!fs.existsSync(file)) continue;

    const original = readConfigFile(file);
    if (!GIT_HOOK_MARKERS.some(pair => pair.some(marker => original.includes(marker)))) continue;

    const stripped = stripMarkerBlock(original);
    if (isEffectivelyEmpty(stripped)) {
      removeConfigFile(file);
    } else {
      atomicWriteFileSync(file, stripped, 0o755);
    }
    removed.push(hook);
  }

  return { installed: removed, hooksDir };
}

/** Upgrade only hooks already opted into; do not enable additional hooks. */
export function refreshInstalledGitSyncHooks(projectRoot: string): GitHookResult {
  const hooksDir = gitHooksDir(projectRoot);
  if (!hooksDir) return { installed: [], hooksDir };
  const hooks = DEFAULT_SYNC_HOOKS.filter(hook => {
    const file = path.join(hooksDir, hook);
    const content = fs.existsSync(file) ? readConfigFile(file) : '';
    return GIT_HOOK_MARKERS.some(pair => pair.some(marker => content.includes(marker)));
  });
  return hooks.length ? installGitSyncHook(projectRoot, hooks) : { installed: [], hooksDir };
}

/** Whether any CodeGraph sync hook is currently installed. */
export function isSyncHookInstalled(
  projectRoot: string,
  hooks: GitHookName[] = DEFAULT_SYNC_HOOKS,
): boolean {
  const hooksDir = gitHooksDir(projectRoot);
  if (!hooksDir) return false;
  return hooks.some((hook) => {
    const file = path.join(hooksDir, hook);
    return fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(MARKER_BEGIN);
  });
}
