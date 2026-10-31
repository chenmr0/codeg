/** Internal paths for fixed storage. This module deliberately has no sync imports. */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

function stat(file: string): fs.Stats | null {
  try { return fs.lstatSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export function getRuntimeDirectory(dataDir: string): string { return path.join(dataDir, '.runtime'); }
export function ensureRuntimeDirectory(dataDir: string): string {
  const root = stat(dataDir);
  if (!root?.isDirectory()) throw new Error(`Unsafe data directory: ${dataDir}`);
  const runtime = getRuntimeDirectory(dataDir);
  try { fs.mkdirSync(runtime); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  if (!stat(runtime)?.isDirectory()) throw new Error(`Unsafe runtime directory: ${runtime}`);
  return runtime;
}
/** Callers perform normal layout recovery before use; never follow a forged marker. */
export function hasFixedRuntimeLayout(dataDir: string): boolean {
  const runtime = getRuntimeDirectory(dataDir), directory = stat(runtime);
  if (!directory) return false;
  if (!directory.isDirectory()) throw new Error(`Unsafe runtime directory: ${runtime}`);
  const marker = path.join(runtime, 'layout.json'), entry = stat(marker);
  if (!entry) return false;
  if (!entry.isFile() || entry.size > 4096) throw new Error(`Unsafe layout marker: ${marker}`);
  const value = JSON.parse(fs.readFileSync(marker, 'utf8'));
  if (!value || value.version !== 1 || value.layout !== 'fixed-path-v1' || typeof value.migrationId !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.migrationId) ||
      Object.keys(value).some(key => !['version', 'layout', 'migrationId'].includes(key))) throw new Error(`Invalid layout marker: ${marker}`);
  return true;
}
export function getInternalFilePath(dataDir: string, name: string, fixed = hasFixedRuntimeLayout(dataDir)): string {
  if (path.basename(name) !== name || name === '.' || name === '..') throw new Error('Internal filename must be a single component');
  return path.join(fixed ? getRuntimeDirectory(dataDir) : dataDir, name);
}
/** Failed initialization diagnostics belong to runtime even before the marker. */
export function usesRuntimeDiagnostics(dataDir: string): boolean {
  return hasFixedRuntimeLayout(dataDir) || process.env.CODEGRAPH_FIXED_PATH === '1' ||
    stat(path.join(getRuntimeDirectory(dataDir), 'fixed-initialization', 'intent.json')) !== null;
}
export function ensureInternalDirectory(dataDir: string, fixed = hasFixedRuntimeLayout(dataDir)): string {
  return fixed ? ensureRuntimeDirectory(dataDir) : dataDir;
}

/** Keep the DB ignored without adding a fourth entry to the data-directory root.
 * Git's local exclude works for normal repos and linked worktrees; no project
 * .gitignore or global Git configuration is changed. */
export function ensureFixedPathGitProtection(dataDir: string): void {
  const runtime = ensureRuntimeDirectory(dataDir), ignore = path.join(runtime, '.gitignore');
  const entry = stat(ignore);
  if (entry && !entry.isFile()) throw new Error(`Unsafe runtime ignore file: ${ignore}`);
  if (!entry) fs.writeFileSync(ignore, '# CodeGraph internal runtime files\n*\n', { flag: 'wx' });
  const cwd = path.dirname(path.resolve(dataDir));
  let top: string, exclude: string;
  try {
    top = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    exclude = execFileSync('git', ['-C', cwd, 'rev-parse', '--git-path', 'info/exclude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    const detail = (error as { stderr?: Buffer | string }).stderr?.toString() ?? '';
    if (/not a git repository/i.test(detail)) return; // No Git index to protect.
    throw new Error(`Cannot establish CodeGraph Git exclusion: ${String(error)}`);
  }
  const relative = path.relative(top, path.resolve(dataDir));
  if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return;
  if (/[\r\n]/.test(relative)) throw new Error('Cannot safely ignore a data directory containing a newline');
  const pattern = '/' + relative.split(path.sep).join('/').replace(/([\\*?\[\]!# ])/g, '\\$1') + '/';
  const gitRelative = relative.split(path.sep).join('/');
  const verifyProtection = (): void => {
    try {
      // --no-index checks rules even if an operator has already staged data.
      // The directory itself must be excluded: a legacy root .gitignore might
      // otherwise mask an overriding project negation until migration moves it.
      for (const name of ['', '/codegraph.db', '/codegraph.db-wal', '/codegraph.db-shm', '/.runtime/layout.json']) {
        execFileSync('git', ['-C', top, 'check-ignore', '--no-index', '--quiet', '--', gitRelative + name],
          { stdio: ['ignore', 'pipe', 'pipe'] });
      }
      const tracked = execFileSync('git', ['-C', top, 'ls-files', '-z', '--', ':(literal)' + gitRelative],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (tracked) throw new Error('CodeGraph data is already tracked or staged');
    } catch (error) {
      throw new Error(`CodeGraph Git protection is ineffective for ${dataDir}; resolve overriding .gitignore rules or tracked data before continuing. Project rules were not modified. ${String(error)}`);
    }
  };
  const target = path.resolve(cwd, exclude);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const initial = stat(target);
  if (initial && !initial.isFile()) throw new Error(`Unsafe Git exclude file: ${target}`);
  // Normal opens are read-only here and do not contend on the Git edit lock.
  if (initial && fs.readFileSync(target, 'utf8').split(/\r?\n/).includes(pattern)) { verifyProtection(); return; }
  // Standard adjacent exclusive lock: preserve concurrent edits and never steal
  // an unknown lock. A crash leaves evidence for explicit operator recovery.
  const lock = target + '.lock';
  let fd: number, ownsLock = false;
  try { fd = fs.openSync(lock, 'wx', 0o600); ownsLock = true; }
  catch (error) { throw new Error(`Cannot lock Git exclude file ${target}; no Git protection changed: ${String(error)}`); }
  try {
    const targetStat = stat(target);
    if (targetStat && !targetStat.isFile()) throw new Error(`Unsafe Git exclude file: ${target}`);
    const old = targetStat ? fs.readFileSync(target, 'utf8') : '';
    if (old.split(/\r?\n/).includes(pattern)) { verifyProtection(); return; }
    const updated = old + (old && !old.endsWith('\n') ? '\n' : '') + '# CodeGraph local data\n' + pattern + '\n';
    fs.writeFileSync(fd, updated);
    if (targetStat) fs.fchmodSync(fd, targetStat.mode & 0o777);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = -1;
    fs.renameSync(lock, target); ownsLock = false;
    verifyProtection();
  } finally {
    if (fd !== -1) fs.closeSync(fd);
    if (ownsLock) { try { fs.unlinkSync(lock); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
  }
}

const LEGACY_RUNTIME_FILES: ReadonlyArray<readonly [string, string]> = [
  ['.gitignore', 'legacy-root.gitignore'], ['errors.log', 'errors.log'],
  ['daemon.log', 'daemon.log'], ['daemon.pid', 'daemon.pid'], ['daemon.sock', 'daemon.sock'],
  ['adaptive-sync.log', 'adaptive-sync.log'], ['adaptive-sync.log.1', 'adaptive-sync.log.1'],
  ['adaptive-cost-history.json', 'adaptive-cost-history.json'],
];
export const LEGACY_RUNTIME_ARTIFACT_NAMES = LEGACY_RUNTIME_FILES.map(([name]) => name);
/** Offline migration preflight. Unknown files are the layout migrator's concern. */
export function assertLegacyRuntimeArtifactsSafe(dataDir: string): void {
  const runtime = getRuntimeDirectory(dataDir), runtimeStat = stat(runtime);
  if (runtimeStat && !runtimeStat.isDirectory()) throw new Error(`Unsafe runtime directory: ${runtime}`);
  for (const [name, destination] of LEGACY_RUNTIME_FILES) {
    const source = path.join(dataDir, name), entry = stat(source);
    if (!entry) continue;
    if (!entry.isFile() && !(name === 'daemon.sock' && entry.isSocket())) throw new Error(`Unsafe legacy runtime artifact: ${source}`);
    if (stat(path.join(runtime, destination))) throw new Error(`Legacy runtime destination conflict: ${destination}; both files preserved`);
    if (name === 'daemon.pid') {
      const raw = fs.readFileSync(source, 'utf8').trim();
      let pid: unknown;
      try { pid = JSON.parse(raw); if (pid && typeof pid === 'object') pid = (pid as {pid?: unknown}).pid; } catch { /* fail closed below */ }
      if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) throw new Error(`Unrecognized legacy daemon PID; preserve and resolve offline: ${source}`);
      try { process.kill(pid, 0); throw new Error(`Stop legacy daemon PID ${pid} before migration`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
  }
}
/** Only the explicitly authorized offline layout migrator may call this. */
export function migrateLegacyRuntimeArtifacts(dataDir: string): void {
  assertLegacyRuntimeArtifactsSafe(dataDir);
  ensureFixedPathGitProtection(dataDir);
  for (const [name, destination] of LEGACY_RUNTIME_FILES) {
    const source = path.join(dataDir, name);
    if (stat(source)) fs.renameSync(source, path.join(getRuntimeDirectory(dataDir), destination));
  }
}
