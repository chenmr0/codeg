import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { ensureSqlJsReady } from '../src/db/sqlite-adapter';
import type { Node } from '../src/types';

const cleanKey = 'resolution:cpp-macro-evidence-clean-v1';
const hashKey = 'resolution:cpp-macro-evidence-v1';
const macro = (id = 'macro', signature: string | undefined = '#define FLAG 1'): Node => ({
  id, kind: 'macro', name: id, qualifiedName: id, signature,
  filePath: 'map.h', language: 'cpp', startLine: 1, endLine: 1,
  startColumn: 0, endColumn: 1,
});
let root: string;
let connection: DatabaseConnection;
let queries: QueryBuilder;
const otherConnections: DatabaseConnection[] = [];
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-macro-evidence-'));
  connection = DatabaseConnection.initialize(path.join(root, 'graph.db'));
  queries = new QueryBuilder(connection.getDb());
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const other of otherConnections.splice(0)) other.close();
  connection.close();
  fs.rmSync(root, { recursive: true, force: true });
});

it('persists and revokes the clean marker with the WASM SQLite backend', async () => {
  // Source-tree tests have no copied dist/db/sql-wasm.wasm. Let sql.js load
  // its own local binary through fs instead of Node's HTTP-only fetch.
  vi.stubGlobal('fetch', undefined);
  await ensureSqlJsReady();
  connection.close();
  vi.stubEnv('CODEGRAPH_FORCE_WASM', '1');
  connection = DatabaseConnection.initialize(path.join(root, 'wasm.db'));
  queries = new QueryBuilder(connection.getDb());
  queries.insertNode(macro());
  await queries.invalidateCppMacroCalls();
  connection.close();
  connection = DatabaseConnection.open(path.join(root, 'wasm.db'));
  queries = new QueryBuilder(connection.getDb());
  const scans = scanSpy();
  await queries.invalidateCppMacroCalls();
  expect(scans()).toBe(0);
  queries.updateNode(macro('macro', '#define FLAG 9'));
  await queries.invalidateCppMacroCalls();
  expect(scans()).toBe(1);
  expect(queries.getMetadata(cleanKey)).toBe(queries.getMetadata(hashKey));
});
function scanSpy() {
  const spy = vi.spyOn(connection.getDb(), 'prepare');
  return () => spy.mock.calls.filter(([sql]) => /SELECT DISTINCT name,signature FROM nodes/.test(sql)).length;
}
function reopen() {
  connection.close();
  connection = DatabaseConnection.open(path.join(root, 'graph.db'));
  queries = new QueryBuilder(connection.getDb());
}

it('skips the macro scan across database reopen without changing the graph or metadata', async () => {
  queries.insertNode(macro());
  await queries.invalidateCppMacroCalls();
  reopen();
  const scans = scanSpy();
  const before = connection.getDb().prepare('SELECT total_changes() AS n').get().n;
  expect(await queries.invalidateCppMacroCalls()).toEqual([]);
  expect(await queries.invalidateCppMacroCalls()).toEqual([]);
  expect(scans()).toBe(0);
  expect(connection.getDb().prepare('SELECT total_changes() AS n').get().n).toBe(before);
});

it.each(['insert', 'delete', 'rename', 'signature', 'null-signature', 'kind', 'replace-kind'] as const)(
  'rechecks after a raw SQL %s on another connection', async (change) => {
    queries.insertNode(macro());
    await queries.invalidateCppMacroCalls();
    const oldHash = queries.getMetadata(hashKey);
    const other = DatabaseConnection.open(path.join(root, 'graph.db'));
    otherConnections.push(other);
    const db = other.getDb();
    switch (change) {
      case 'insert': new QueryBuilder(db).insertNode(macro('added')); break;
      case 'delete': db.exec("DELETE FROM nodes WHERE id='macro'"); break;
      case 'rename': db.exec("UPDATE nodes SET name='renamed' WHERE id='macro'"); break;
      case 'signature': db.exec("UPDATE nodes SET signature='#define FLAG 2' WHERE id='macro'"); break;
      case 'null-signature': db.exec("UPDATE nodes SET signature=NULL WHERE id='macro'"); break;
      case 'kind': db.exec("UPDATE nodes SET kind='variable' WHERE id='macro'"); break;
      case 'replace-kind':
        db.exec('PRAGMA recursive_triggers=OFF');
        new QueryBuilder(db).insertNode({ ...macro(), kind: 'variable' });
        break;
    }
    const scans = scanSpy();
    expect(queries.getMetadata(cleanKey)).toBeNull();
    await queries.invalidateCppMacroCalls();
    expect(scans()).toBe(1);
    expect(queries.getMetadata(hashKey)).not.toBe(oldHash);
    expect(queries.getMetadata(cleanKey)).toBe(queries.getMetadata(hashKey));
    await queries.invalidateCppMacroCalls();
    expect(scans()).toBe(1);
  },
);

it('preserves cleanliness after rolled back writes and irrelevant node updates', async () => {
  queries.insertNode(macro());
  await queries.invalidateCppMacroCalls();
  expect(() => connection.getDb().transaction(() => {
    queries.insertNode(macro('rollback'));
    throw new Error('rollback');
  })()).toThrow('rollback');
  connection.getDb().exec("UPDATE nodes SET updated_at=1,signature=signature WHERE id='macro'");
  const scans = scanSpy();
  await queries.invalidateCppMacroCalls();
  expect(scans()).toBe(0);
});

it('keeps invalidation active during fresh-index bulk loading', async () => {
  await queries.invalidateCppMacroCalls();
  connection.beginBulkNodeLoad();
  connection.beginBulkParseLoad();
  try { queries.insertNode(macro()); }
  finally {
    connection.endBulkNodeLoad();
    await connection.endBulkParseLoad();
  }
  const scans = scanSpy();
  await queries.invalidateCppMacroCalls();
  expect(scans()).toBe(1);
});

it('performs one check after upgrading v8 and preserves the existing fingerprint', async () => {
  queries.insertNode(macro());
  await queries.invalidateCppMacroCalls();
  const fingerprint = queries.getMetadata(hashKey);
  connection.getDb().exec(`
    DROP TRIGGER nodes_macro_evidence_ai;
    DROP TRIGGER nodes_macro_evidence_ad;
    DROP TRIGGER nodes_macro_evidence_au;
    UPDATE schema_versions SET version=8 WHERE version=9;
  `);
  reopen();
  expect(queries.getMetadata(hashKey)).toBe(fingerprint);
  expect(queries.getMetadata(cleanKey)).toBeNull();
  const scans = scanSpy();
  await queries.invalidateCppMacroCalls();
  await queries.invalidateCppMacroCalls();
  expect(scans()).toBe(1);
  expect(queries.getMetadata(hashKey)).toBe(fingerprint);
  queries.insertNode(macro('after-migration'));
  expect(queries.getMetadata(cleanKey)).toBeNull();
});

it('does not certify a failed check as clean after reopen', async () => {
  queries.insertNode(macro());
  const db = connection.getDb();
  const prepare = db.prepare.bind(db);
  vi.spyOn(db, 'prepare').mockImplementation(sql => {
    if (/SELECT DISTINCT name,signature FROM nodes/.test(sql)) throw new Error('interrupted');
    return prepare(sql);
  });
  await expect(queries.invalidateCppMacroCalls()).rejects.toThrow('interrupted');
  vi.restoreAllMocks();
  reopen();
  const scans = scanSpy();
  await queries.invalidateCppMacroCalls();
  expect(scans()).toBe(1);
  expect(queries.getMetadata(cleanKey)).toBe(queries.getMetadata(hashKey));
});

it('does not publish an obsolete fingerprint if a node write occurs during an edge page', async () => {
  queries.insertNodes([
    macro(),
    { ...macro('caller'), kind: 'function', filePath: 'caller.cpp' },
    { ...macro('overload1'), name: 'run', qualifiedName: 'run', kind: 'function', signature: 'int run(int)' },
    { ...macro('overload2'), name: 'run', qualifiedName: 'run', kind: 'function', signature: 'int run(double)' },
  ]);
  queries.insertEdge({ source: 'caller', target: 'overload1', kind: 'calls', line: 1, column: 0,
    metadata: { refName: 'run' } });
  await queries.invalidateCppMacroCalls();
  queries.updateNode(macro('macro', '#define FLAG 2'));
  // The first edge page yields via setImmediate. Its write must revoke the
  // in-flight token, so the next invocation still detects the newer evidence.
  const duringPage = new Promise<void>(resolve => setImmediate(() => {
    queries.updateNode(macro('macro', '#define FLAG 3'));
    resolve();
  }));
  expect(await queries.invalidateCppMacroCalls()).toContain('caller.cpp');
  await duringPage;
  expect(queries.getMetadata(cleanKey)).toBeNull();
  const scans = scanSpy();
  await queries.invalidateCppMacroCalls();
  expect(scans()).toBe(1);
  expect(queries.getMetadata(cleanKey)).toBe(queries.getMetadata(hashKey));
});
