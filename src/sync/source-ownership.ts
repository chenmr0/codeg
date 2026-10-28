/**
 * A source-only provenance guard for automatic rebuilds. It is not a security
 * boundary against hostile SQL: all writers must respect the project lock.
 * Legacy/custom databases are never adopted merely because their rows look
 * plausible. Only a freshly initialized, empty, exact stock schema can start
 * an ownership chain. Ordinary external SQL mutations break that chain.
 */
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import * as path from 'path';
import type { SqliteDatabase } from '../db/sqlite-adapter';

const OWNER_KEY = 'adaptive:source-owner-v1';
const GUARDED_TABLES = ['nodes', 'edges', 'files', 'unresolved_refs', 'schema_versions', 'project_metadata'] as const;
const graphTables = ['nodes', 'edges', 'files', 'unresolved_refs'] as const;
let stockFingerprint: string | undefined;

function schemaFingerprint(db: Pick<SqliteDatabase, 'prepare'>): string {
  // ANALYZE is allowed to add SQLite's own statistics, not application data.
  const schema = db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_stat%' ORDER BY type, name`).all();
  return createHash('sha256').update(JSON.stringify(schema)).digest('hex');
}

function expectedStockFingerprint(): string {
  if (stockFingerprint !== undefined) return stockFingerprint;
  // Do not use the WASM adapter here: its close() persists even ':memory:' as
  // a file. Automatic rebuilds are native-only; this template never touches disk.
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:') as Pick<SqliteDatabase, 'exec' | 'prepare' | 'close'>;
  try {
    db.exec(readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
    stockFingerprint = schemaFingerprint(db);
    return stockFingerprint;
  } finally { db.close(); }
}

function marker(db: SqliteDatabase): string | null {
  const row = db.prepare('SELECT value FROM project_metadata WHERE key = ?').get(OWNER_KEY) as { value: string } | undefined;
  return row?.value ?? null;
}

function putMarker(db: SqliteDatabase, fingerprint: string): void {
  db.prepare('INSERT OR REPLACE INTO project_metadata (key, value, updated_at) VALUES (?, ?, ?)')
    .run(OWNER_KEY, fingerprint, Date.now());
}

function guardSql(): string {
  const statements: string[] = [];
  for (const table of GUARDED_TABLES) {
    for (const [suffix, operation] of [['ai', 'INSERT'], ['au', 'UPDATE'], ['ad', 'DELETE']] as const) {
      const metadataCondition = table !== 'project_metadata' ? '' : operation === 'INSERT'
        ? `NEW.key <> '${OWNER_KEY}' AND ` : operation === 'DELETE'
          ? `OLD.key <> '${OWNER_KEY}' AND `
          : `(OLD.key <> '${OWNER_KEY}' OR NEW.key <> '${OWNER_KEY}') AND `;
      statements.push(`CREATE TRIGGER adaptive_owner_${table}_${suffix} AFTER ${operation} ON ${table}
        WHEN ${metadataCondition}EXISTS (SELECT 1 FROM project_metadata WHERE key = '${OWNER_KEY}')
        BEGIN DELETE FROM project_metadata WHERE key = '${OWNER_KEY}'; END;`);
    }
  }
  return statements.join('\n');
}

/** Only call immediately after DatabaseConnection.initialize on a NEW database. */
export function installSourceOwnership(db: SqliteDatabase): boolean {
  if (process.env.CODEGRAPH_FORCE_WASM) return false;
  return db.transaction(() => {
    if (schemaFingerprint(db) !== expectedStockFingerprint()) return false;
    if ((db.prepare('SELECT count(*) AS n FROM project_metadata').get() as { n: number }).n !== 0) return false;
    for (const table of graphTables) {
      if (db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) return false;
    }
    db.exec(guardSql());
    putMarker(db, schemaFingerprint(db));
    return true;
  })();
}

/** Cheap in graph size: checks schema objects, never hashes all graph rows/files. */
export function isSourceOwned(db: SqliteDatabase): boolean {
  try {
    const fingerprint = marker(db);
    return fingerprint !== null && fingerprint === schemaFingerprint(db);
  } catch { return false; }
}

const tokenBrand: unique symbol = Symbol('SourceWriteToken');
export interface SourceWriteToken { readonly [tokenBrand]: true; }
interface TokenState { database: SqliteDatabase; fingerprint: string; }
const tokens = new WeakMap<SourceWriteToken, TokenState>();

/** Caller holds the root writer lock until finish, including async worker writes. */
export function beginSourceWrite(db: SqliteDatabase): SourceWriteToken | null {
  return db.transaction(() => {
    if (!isSourceOwned(db)) return null;
    const fingerprint = marker(db)!;
    db.prepare('DELETE FROM project_metadata WHERE key = ?').run(OWNER_KEY);
    const token: SourceWriteToken = Object.freeze({ [tokenBrand]: true as const });
    tokens.set(token, { database: db, fingerprint });
    return token;
  })();
}

/** An incomplete/failed operation permanently breaks eligibility until a fresh init. */
export function finishSourceWrite(db: SqliteDatabase, token: SourceWriteToken | null, complete: boolean): boolean {
  if (token === null) return false;
  const state = tokens.get(token);
  tokens.delete(token);
  if (!state || state.database !== db || complete !== true) return false;
  return db.transaction(() => {
    if (marker(db) !== null || schemaFingerprint(db) !== state.fingerprint) return false;
    putMarker(db, state.fingerprint);
    return true;
  })();
}
