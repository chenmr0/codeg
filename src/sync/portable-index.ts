/** Image-bound metadata. Host leases and rename recovery deliberately live elsewhere. */
import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import type { SqliteDatabase } from '../db/sqlite-adapter';

export const PORTABLE_INDEX_KEY = 'portable:index-v1';
export const PORTABLE_IMPORT_KEY = 'portable:import-pending-v1';
type Reader = Pick<SqliteDatabase, 'prepare'>;
export interface PortableIndex { version: 1; id: string; revision: string; }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function readPortableIndex(db: Reader): PortableIndex | null {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_metadata'").get()) return null;
  const row = db.prepare('SELECT value FROM project_metadata WHERE key=?').get(PORTABLE_INDEX_KEY) as { value: string } | undefined;
  if (!row) return null;
  const value = JSON.parse(row.value) as PortableIndex;
  if (!value || value.version !== 1 || !uuid.test(value.id) || !uuid.test(value.revision) ||
      Object.keys(value).some(key => !['version', 'id', 'revision'].includes(key))) throw new Error('Invalid portable index identity; database retained');
  return value;
}
export function portableStamp(db: Reader): string | null {
  const identity = readPortableIndex(db);
  return identity ? JSON.stringify(identity) : null;
}
/** Caller owns the graph write transaction, including source-ownership bookkeeping. */
export function createPortableIndex(db: Reader): void {
  if (readPortableIndex(db)) return;
  db.prepare('INSERT INTO project_metadata(key,value,updated_at) VALUES(?,?,?)').run(PORTABLE_INDEX_KEY,
    JSON.stringify({ version: 1, id: randomUUID(), revision: randomUUID() }), Date.now());
}
export function advancePortableRevision(db: Reader): void {
  const identity = readPortableIndex(db);
  if (identity) db.prepare('UPDATE project_metadata SET value=?,updated_at=? WHERE key=?')
    .run(JSON.stringify({ ...identity, revision: randomUUID() }), Date.now(), PORTABLE_INDEX_KEY);
}

// A failed native close is not evidence of handle retirement. Keep the actual
// handle reachable until process exit, and let callers retain admission leases.
const retainedNative = new Set<unknown>();
export class PortableCloseError extends Error {}
export function portableCloseFailure(resource: unknown, cause: unknown): PortableCloseError {
  retainedNative.add(resource);
  return new PortableCloseError('Portable native close is uncertain; stop this process before retrying', { cause });
}
export function retainPortableResource(resource: unknown): void { retainedNative.add(resource); }
export function readPortableFile(file: string): string | null {
  if (!lstatSync(file).isFile()) throw new Error('Portable database must be a regular file, not a symlink');
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try {
      if (!lstatSync(file + suffix).isFile()) throw new Error('Portable database sidecar must be a regular file, not a symlink');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try { return portableStamp(db); } finally {
    try { db.close(); } catch (error) { throw portableCloseFailure(db, error); }
  }
}
