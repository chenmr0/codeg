import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDatabase, type SqliteDatabase } from '../db/sqlite-adapter';
import { beginSourceWrite, finishSourceWrite } from './source-ownership';
import { createPortableIndex, readPortableFile, portableStamp, advancePortableRevision, PortableCloseError, portableCloseFailure, retainPortableResource, PORTABLE_IMPORT_KEY } from './portable-index';
import { gate, lease, paths, records, state, recover } from './fixed-path/protocol';
import type { FixedPathProject } from './fixed-path/controller';

export const PORTABLE_OFFLINE_MESSAGE = 'Portable database has no registered local coordination. Queries are read-only; close all CodeGraph processes and external SQLite tools, then run codegraph migrate-storage --offline. Missing runtime is not proof that old readers exited.';

function usingLocks<T>(held: Array<{ close(): void }>, action: () => T): T {
  let retain = false;
  try { return action(); }
  catch (error) {
    retain = error instanceof PortableCloseError;
    if (retain) held.forEach(retainPortableResource);
    throw error;
  } finally {
    if (!retain) for (const lock of [...held].reverse()) {
      try { lock.close(); }
      catch (error) {
        held.forEach(retainPortableResource);
        throw portableCloseFailure(lock, error);
      }
    }
  }
}
function readBinding(db: any): string | null {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='portable_binding'").get()) return null;
  return db.prepare('SELECT stamp FROM portable_binding WHERE id=1').get()?.stamp ?? null;
}
function binding(p: ReturnType<typeof paths>): string | null {
  return gate(p, readBinding, { readOnly: true });
}
function writeBinding(db: any, stamp: string): void {
  db.exec('CREATE TABLE IF NOT EXISTS portable_binding(id INTEGER PRIMARY KEY CHECK(id=1), stamp TEXT NOT NULL)');
  if (readBinding(db) === stamp) return;
  db.prepare('INSERT OR REPLACE INTO portable_binding VALUES(1,?)').run(stamp);
  db.prepare('UPDATE state SET revision=revision+1 WHERE id=1').run();
}
function saveBinding(p: ReturnType<typeof paths>, stamp: string): void {
  gate(p, (db: any) => writeBinding(db, stamp));
}
/** Advance image revision BEFORE a managed mutation, while holding mutation
 * admission and the coordinator gate. Concurrent opens read stamp + binding in
 * one gate, so an ordinary writer cannot be mistaken for an external import.
 * If the process dies after this commit, existing graph recovery still applies.
 * A crash between the two DB commits happens before graph mutation and leaves
 * an unacknowledged image requiring conservative import verification. */
export function beginPortableWrite(project: FixedPathProject, db: SqliteDatabase): void {
  const p = paths(project);
  gate(p, (coordinator: any) => {
    if (portableStamp(db) === null) return;
    db.transaction(() => {
      const ownership = beginSourceWrite(db);
      advancePortableRevision(db);
      if (ownership && !finishSourceWrite(db, ownership, true)) throw new Error('Portable revision ownership changed');
    })();
    writeBinding(coordinator, portableStamp(db)!);
  });
}
/** Never recreate a disappeared coordination domain merely because a portable
 * root exists. Existing processes may still hold the unlinked lock files. */
export function assertPortableRegistration(project: FixedPathProject): void {
  const p = paths(project);
  if (!fs.existsSync(p.gate)) {
    if (readPortableFile(p.active) !== null) throw new Error(PORTABLE_OFFLINE_MESSAGE);
    return;
  }
  const held = lease(p.connections);
  if (!held) return; // Existing protocol admission handles a publisher's drain.
  usingLocks([held], () => {
    gate(p, (db: any) => {
      // Let the original publication recovery examine uncommitted rename state
      // before interpreting either file as a user-supplied replacement.
      if (db.prepare('SELECT mode FROM state WHERE id=1').get()?.mode !== 'idle') return;
      const current = readPortableFile(p.active), registered = readBinding(db);
      if (current !== null && registered === null) throw new Error(PORTABLE_OFFLINE_MESSAGE);
      if (current !== registered) assertNoImportLog(p.active);
    }, { readOnly: true });
  });
}
function assertNoImportLog(file: string): void {
  for (const suffix of ['-wal', '-journal']) {
    const sidecar = file + suffix;
    if (fs.existsSync(sidecar) && (!fs.lstatSync(sidecar).isFile() || fs.statSync(sidecar).size !== 0)) {
      throw new Error('Portable import has an unresolved SQLite log; preserve database and sidecars and recover offline');
    }
  }
}
function validateStandalone(file: string): void {
  if (!fs.lstatSync(file).isFile()) throw new Error('Portable import requires a regular database file');
  assertNoImportLog(file);
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Portable database integrity check failed');
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='files' AND type='table'").get() ||
        !db.prepare("SELECT 1 FROM sqlite_master WHERE name='project_metadata' AND type='table'").get()) throw new Error('Unsupported portable database schema');
    const complete = db.prepare("SELECT value FROM project_metadata WHERE key='index_completeness'").get()?.value;
    const empty = db.prepare('SELECT count(*) AS n FROM files').get().n === 0 && db.prepare('SELECT count(*) AS n FROM nodes').get().n === 0;
    if (complete !== 'complete' && !empty) throw new Error('Portable database index is incomplete; recover the original index before importing');
  } finally {
    try { db.close(); } catch (error) { throw portableCloseFailure(db, error); }
  }
}
/** Explicit offline registration uses the existing migration's validation first. */
export function preparePortableImport(dataDirectory: string): void {
  const file = path.join(dataDirectory, 'codegraph.db');
  validateStandalone(file);
  const { db } = createDatabase(file, { nativeOnly: true });
  try {
    db.transaction(() => {
      const ownership = beginSourceWrite(db);
      createPortableIndex(db);
      const prior = db.prepare("SELECT value FROM project_metadata WHERE key='fixed-path:source-catchup-v1'").get() as { value: string } | undefined;
      const pending = db.prepare('SELECT value FROM project_metadata WHERE key=?').get(PORTABLE_IMPORT_KEY) as { value: string } | undefined;
      db.prepare('INSERT OR REPLACE INTO project_metadata(key,value,updated_at) VALUES(?,?,?)')
        .run(PORTABLE_IMPORT_KEY, prior?.value ?? pending?.value ?? randomUUID(), Date.now());
      if (ownership && !finishSourceWrite(db, ownership, true)) throw new Error('Portable import ownership changed');
    })();
  } finally {
    try { db.close(); } catch (error) { throw portableCloseFailure(db, error); }
  }
}
/** Existing registered domains can fence cooperating handles. Missing domains
 * cannot prove legacy readers exited and are NEVER silently bootstrapped here. */
export function ensurePortableBinding(project: FixedPathProject, fresh = false): void {
  const p = paths(project);
  const shared = lease(p.connections);
  if (!shared) throw new Error('Portable database admission is busy; retry after active operations finish');
  let stamp: string | null, registered: string | null;
  ({ stamp, registered } = usingLocks([shared], () => gate(p, (db: any) => ({ stamp: readPortableFile(p.active), registered: readBinding(db) }), { readOnly: true })));
  if (stamp === null) {
    if (registered !== null) throw new Error('Portable database identity is missing or replaced by a legacy database; close all processes and run codegraph migrate-storage --offline');
    return;
  }
  if (registered === stamp) return;
  if (registered === null && !fresh) throw new Error(PORTABLE_OFFLINE_MESSAGE);
  const held: Array<{ close(): void }> = [];
  usingLocks(held, () => {
    for (const file of [p.owner, p.mutations, p.writers, p.connections]) {
      const lock = lease(file, true);
      if (!lock) throw new Error('Portable database replacement requires all managed connections to close; retry offline');
      held.push(lock);
    }
    if (state(p).mode !== 'idle' || records(p).some((r: any) => !['committed', 'aborted', 'cleaned'].includes(r.phase))) {
      throw new Error('Portable database conflicts with unresolved publication; preserve runtime and recover offline');
    }
    if (binding(p) === readPortableFile(p.active)) return;
    if (!fresh) preparePortableImport(project.dataDirectory);
    const current = readPortableFile(p.active);
    if (current === null) throw new Error('Portable database identity disappeared');
    saveBinding(p, current);
  });
}

/** This entry is only reached after an explicit --offline acknowledgement and
 * the existing layout migration. Reacquire real leases; an acknowledgement is
 * not a substitute for excluding concurrently restarted cooperating clients. */
export function adoptPortableOffline(project: FixedPathProject): void {
  recover(project);
  const p = paths(project), held: Array<{ close(): void }> = [];
  usingLocks(held, () => {
    for (const file of [p.owner, p.mutations, p.writers, p.connections]) {
      const lock = lease(file, true);
      if (!lock) throw new Error('Offline portable adoption requires all managed connections to close');
      held.push(lock);
    }
    if (state(p).mode !== 'idle' || records(p).some((r: any) => !['committed', 'aborted', 'cleaned'].includes(r.phase))) throw new Error('Unresolved portable adoption recovery state');
    preparePortableImport(project.dataDirectory);
    saveBinding(p, readPortableFile(p.active)!);
  });
}
