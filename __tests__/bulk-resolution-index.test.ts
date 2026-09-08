import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { createDatabase, type SqliteDatabase } from '../src/db/sqlite-adapter';
import { ReferenceResolver } from '../src/resolution';
import type { Node, UnresolvedReference } from '../src/types';

function node(id: string, kind: Node['kind'] = 'class', qualifiedName = id): Node {
  return { id, name: qualifiedName.split('::').pop()!, qualifiedName, kind,
    language: 'cpp', filePath: 'types.hpp', startLine: 1, endLine: 20,
    startColumn: 0, endColumn: 1, updatedAt: 1 };
}

function ref(fromNodeId: string, referenceName: string,
  referenceKind: UnresolvedReference['referenceKind'] = 'extends', line = 1): UnresolvedReference {
  return { fromNodeId, referenceName, referenceKind, line, column: 0,
    filePath: 'types.hpp', language: 'cpp' };
}

function indexNames(db: SqliteDatabase): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>)
    .map(row => row.name);
}

describe('full resolution retains indexes needed by inheritance reads', () => {
  let directory: string;
  let connection: DatabaseConnection;
  let queries: QueryBuilder;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bulk-ref-index-'));
    connection = DatabaseConnection.initialize(path.join(directory, 'graph.db'));
    queries = new QueryBuilder(connection.getDb());
    queries.insertNodes([node('Derived'), node('Base'), node('Other'), node('noise', 'function')]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    connection.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('keeps real pending-supertype queries selective inside the bulk window, including read-only workers', async () => {
    const db = connection.getDb();
    // Keep the parse-write optimization; only the subsequent read/write phase
    // needs the source index. Exercise the actual parse -> resolution lifecycle.
    connection.beginBulkParseLoad();
    expect(indexNames(db)).not.toContain('idx_unresolved_from_node');
    queries.insertUnresolvedRefsBatch(Array.from({ length: 25_000 }, (_, i) =>
      ref('noise', 'unrelated', 'references', i + 1)));
    db.exec("UPDATE unresolved_refs SET status='failed' WHERE id % 2 = 0");
    const failedBase = ref('Derived', 'Other', 'implements', 20);
    queries.insertUnresolvedRefsBatch([
      ref('Derived', 'Base', 'extends', 10), failedBase,
      ref('Derived', 'not-a-base', 'references'), ref('Other', 'Base'),
    ]);
    queries.markReferencesFailed([failedBase]);
    await connection.endBulkParseLoad();
    expect(indexNames(db)).toContain('idx_unresolved_from_node');

    connection.beginBulkResolutionRefLoad();
    try {
      const prepare = vi.spyOn(db, 'prepare');
      expect(queries.getPendingSupertypes('Derived').map(r => [r.referenceName, r.referenceKind]))
        .toEqual([['Base', 'extends'], ['Other', 'implements']]);
      // Capture the production query, rather than testing a duplicated SQL
      // string that could silently diverge from getPendingSupertypes later.
      const sql = prepare.mock.calls.find(([text]) => text.includes('ORDER BY line,col,reference_name'))?.[0];
      expect(sql).toBeDefined();
      prepare.mockRestore();
      const assertSelective = (reader: SqliteDatabase) => {
        const plan = reader.prepare('EXPLAIN QUERY PLAN ' + sql!).all('Derived') as Array<{ detail: string }>;
        expect(plan.some(row => /USING INDEX idx_unresolved_from_node\b/.test(row.detail))).toBe(true);
        expect(plan.some(row => /USING INDEX idx_unresolved_status\b/.test(row.detail))).toBe(false);
        expect(new QueryBuilder(reader).getPendingSupertypes('absent')).toEqual([]);
      };
      assertSelective(db);
      if (connection.getBackend() === 'node-sqlite') {
        const worker = createDatabase(path.join(directory, 'graph.db'), { readOnly: true }).db;
        try {
          worker.pragma('query_only = ON');
          assertSelective(worker);
          expect(new QueryBuilder(worker).getPendingSupertypes('Derived').map(r => r.referenceName))
            .toEqual(['Base', 'Other']);
        } finally { worker.close(); }
      }
      expect(indexNames(db)).toContain('idx_unresolved_from_node');
      expect(indexNames(db)).not.toContain('idx_unresolved_from_name');
      expect(indexNames(db)).not.toContain('idx_unresolved_name');
    } finally { await connection.endBulkResolutionRefLoad(); }
    expect(indexNames(db)).toContain('idx_unresolved_name');
  });

  it.each(['pending', 'failed'] as const)('resolves inherited calls before the %s base row, across batches', async status => {
    vi.stubEnv('CODEGRAPH_PARALLEL_RESOLVE_MIN', '1');
    queries.insertNodes([node('Base.run', 'method', 'Base::run'), node('caller', 'function')]);
    const base = ref('Derived', 'Base');
    // Calls deliberately precede inheritance in row-id order; a failed base
    // is not selected by the normal pending-row drain at all.
    queries.insertUnresolvedRefsBatch([
      ref('caller', 'Derived::run', 'calls', 10),
      ref('caller', 'Derived::run', 'calls', 11), base,
    ]);
    if (status === 'failed') queries.markReferencesFailed([base]);
    const resolver = new ReferenceResolver(directory, queries);
    resolver.initialize();
    let began = false;
    const result = await resolver.resolveAndPersistBatched(current => {
      expect(began).toBe(true);
      expect(indexNames(connection.getDb())).toContain('idx_unresolved_from_node');
      if (current === 1) {
        expect(queries.getOutgoingEdges('Derived', ['extends'])).toHaveLength(0);
        expect(queries.getOutgoingEdges('caller', ['calls']).map(e => e.target)).toEqual(['Base.run']);
      }
    }, 1, {
      bulkRefLoad: {
        begin: () => { connection.beginBulkResolutionRefLoad(); began = true; },
        end: () => connection.endBulkResolutionRefLoad(),
      },
      bulkEdgeLoad: {
        begin: () => connection.beginBulkResolutionEdgeLoad(),
        end: () => connection.endBulkResolutionEdgeLoad(),
      },
    });
    expect(result.stats.unresolved).toBe(0);
    expect(queries.getOutgoingEdges('caller', ['calls']).map(e => [e.target, e.line]).sort())
      .toEqual([['Base.run', 10], ['Base.run', 11]]);
    expect(queries.getUnresolvedReferencesCount()).toBe(0);
    expect(indexNames(connection.getDb())).toContain('idx_unresolved_from_name');
  });

  it('repairs a source index missing from an interrupted pre-fix bulk window', () => {
    queries.insertUnresolvedRefsBatch([ref('Derived', 'Base')]);
    connection.beginBulkResolutionRefLoad();
    // Simulate a database left by the old implementation, not merely the
    // fixed implementation (which never drops this index in resolution).
    connection.getDb().exec('DROP INDEX IF EXISTS idx_unresolved_from_node');
    connection.close();
    connection = DatabaseConnection.open(path.join(directory, 'graph.db'));
    queries = new QueryBuilder(connection.getDb());
    expect(indexNames(connection.getDb())).toContain('idx_unresolved_from_node');
    expect(queries.getPendingSupertypes('Derived').map(r => r.referenceName)).toEqual(['Base']);
  });
});
