import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';

interface FileState { content: Buffer | null; mode?: number }
interface PendingFile { original: FileState; next: FileState }
interface Transaction { files: Map<string, PendingFile>; notes: string[] }
let active: Transaction | undefined;

function diskState(file: string): FileState {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { content: null };
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${file}: expected a regular configuration file.`);
  return { content: fs.readFileSync(file), mode: stat.mode & 0o777 };
}

function same(a: FileState, b: FileState): boolean {
  return a.content === null ? b.content === null : b.content !== null && a.content.equals(b.content) &&
    (process.platform === 'win32' || a.mode === b.mode);
}

function tracked(file: string): PendingFile {
  const key = path.resolve(file);
  let pending = active!.files.get(key);
  if (!pending) {
    const original = diskState(key);
    pending = { original, next: original };
    active!.files.set(key, pending);
  }
  return pending;
}

/** Reads observe earlier staged edits (e.g. permissions and hooks share settings.json). */
export function readConfigFile(file: string): string {
  const state = active ? tracked(file).next : diskState(file);
  return state.content?.toString('utf8') ?? '';
}

export function configFileExists(file: string): boolean {
  return active ? tracked(file).next.content !== null : fs.existsSync(file);
}

function writeDisk(file: string, state: FileState): void {
  if (state.content === null) {
    fs.unlinkSync(file);
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp.${randomUUID()}`;
  try {
    fs.writeFileSync(temp, state.content, { flag: 'wx', mode: state.mode ?? 0o600 });
    if (state.mode !== undefined) fs.chmodSync(temp, state.mode);
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

export function atomicWriteFileSync(file: string, content: string, mode?: number): void {
  if (active) {
    const pending = tracked(file);
    pending.next = { content: Buffer.from(content), mode: mode ?? pending.original.mode ?? 0o600 };
  } else {
    writeDisk(file, { content: Buffer.from(content), mode: mode ?? diskState(file).mode ?? 0o600 });
  }
}

export function removeConfigFile(file: string): void {
  if (active) tracked(file).next = { content: null };
  else if (fs.existsSync(file)) fs.unlinkSync(file);
}

export function recordCleanup(note: string): void { active?.notes.push(note); }

/** Synchronous scope: plan everything, back up, then apply; restore on a write failure. */
export function withConfigTransaction<T extends { notes?: string[] }>(label: string, work: () => T): T {
  if (active) return work();
  const transaction: Transaction = { files: new Map(), notes: [] };
  active = transaction;
  let result: T;
  try { result = work(); } finally { active = undefined; }
  const changes = [...transaction.files].filter(([, file]) => !same(file.original, file.next));
  if (!changes.length) return result;

  // Outside client plugin/extension auto-load directories; filenames are numeric .bak files.
  const backupDir = path.join(os.homedir(), '.codegraph-wx', 'install-backups', randomUUID());
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const manifest = changes.map(([file, state], index) => {
    if (!same(diskState(file), state.original)) throw new Error(`${file}: changed during install; retry after the client finishes saving.`);
    const backup = state.original.content === null ? null : `${index}.bak`;
    if (backup) fs.writeFileSync(path.join(backupDir, backup), state.original.content!, { mode: 0o600, flag: 'wx' });
    return { path: file, backup, mode: state.original.mode };
  });
  fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify({ label, files: manifest }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });

  const applied: typeof changes = [];
  try {
    for (const [file, state] of changes) {
      if (!same(diskState(file), state.original)) throw new Error(`${file}: changed during install.`);
      writeDisk(file, state.next);
      applied.push([file, state]);
    }
  } catch (error) {
    const failures: string[] = [];
    for (const [file, state] of applied.reverse()) {
      try {
        if (!same(diskState(file), state.next)) throw new Error('modified by another process');
        writeDisk(file, state.original);
      } catch (rollbackError) { failures.push(`${file}: ${String(rollbackError)}`); }
    }
    throw new Error(`${String(error)} ${failures.length ? `Rollback incomplete: ${failures.join('; ')}` : 'Configuration changes rolled back.'} Backup: ${backupDir}`);
  }
  result.notes = [...(result.notes ?? []), ...transaction.notes,
    `Managed configuration refreshed (${changes.length} files). Backup: ${backupDir}`,
    'Restart the client to load the refreshed CodeGraph WX configuration.'];
  return result;
}
