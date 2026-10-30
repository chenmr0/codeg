import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { ensureSqlJsReady } from '../src/db/sqlite-adapter';
import type { Node, SearchOptions } from '../src/types';

const oldJoin = 'JOIN nodes ON nodes_fts.id = nodes.id';
const newJoin = `JOIN nodes ON nodes.rowid = CASE WHEN EXISTS (
        SELECT 1 FROM nodes_fts AS posting
        LEFT JOIN nodes AS content ON content.rowid = posting.rowid
        WHERE posting.nodes_fts MATCH ? AND content.rowid IS NULL
      ) THEN (
        SELECT legacy.rowid FROM nodes AS legacy WHERE legacy.id = nodes_fts.id
      ) ELSE nodes_fts.rowid END AND nodes.id IS NOT NULL`;
const node = (id: string, name: string, i = 0): Node => ({
  id, name, qualifiedName: `Scope::${name}`, kind: i % 3 ? 'function' : 'class',
  language: i % 2 ? 'python' : 'cpp', filePath: `${i % 2 ? 'target' : 'other'}/${id}.cpp`,
  startLine: i + 1, endLine: i + 2, startColumn: 0, endColumn: 1,
  docstring: i % 3 ? 'shared documentation about Widget' : 'short text',
  signature: `${name}(argument: Widget)`, updatedAt: 1,
});

for (const backend of ['native', 'wasm']) {
  describe(`FTS external-content rowid join (${backend})`, () => {
    let dir: string;
    let connection: DatabaseConnection;
    let queries: QueryBuilder;
    beforeAll(async () => {
      vi.stubGlobal('fetch', undefined);
      try { await ensureSqlJsReady(); } finally { vi.unstubAllGlobals(); }
    });
    beforeEach(() => {
      vi.stubEnv('CODEGRAPH_FORCE_WASM', backend === 'wasm' ? '1' : '');
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fts-rowid-'));
      connection = DatabaseConnection.initialize(path.join(dir, 'graph.db'));
      queries = new QueryBuilder(connection.getDb());
    });
    afterEach(() => {
      vi.restoreAllMocks();
      connection?.close();
      vi.unstubAllEnvs();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    function compare(query: string, options: SearchOptions = {}, paths: string[] = [], names: string[] = []) {
      const db = connection.getDb();
      const prepare = db.prepare.bind(db);
      let captured: string | undefined;
      const spy = vi.spyOn(db, 'prepare').mockImplementation(sql => {
        if (sql.includes(newJoin)) captured = sql;
        return prepare(sql);
      });
      // Check the FTS stage itself; an empty FTS response silently followed by
      // LIKE or the supplement must not make the equivalence test pass.
      const fts = (queries as any).searchNodesFTS(query, options, paths, names);
      expect(captured).toBeDefined();
      const actual = queries.searchNodes(query, options);
      spy.mockImplementation(sql => {
        const statement = prepare(sql.replace(newJoin, oldJoin));
        if (!sql.includes(newJoin)) return statement;
        return { ...statement, all: (...args: any[]) => statement.all(...args.slice(1)) };
      });
      expect(fts).toEqual((queries as any).searchNodesFTS(query, options, paths, names));
      expect(actual).toEqual(queries.searchNodes(query, options));
      spy.mockRestore();
      return { fts, actual, sql: captured! };
    }

    it('preserves BM25, deterministic same-name ordering, filters, limit and offset', () => {
      queries.insertNodes(Array.from({ length: 250 }, (_, i) =>
        node(`n${String(i).padStart(3, '0')}`, i < 80 ? 'Widget' : `WidgetSuffix${i}`, i)));
      const result = compare('Widget', { limit: 1 });
      expect(result.fts).toHaveLength(100); // Existing 5x/min-100 candidate budget.
      expect(result.actual).toHaveLength(1);
      const plan = connection.getDb().prepare(`EXPLAIN QUERY PLAN ${result.sql}`).all('"Widget"*', '"Widget"*', 100, 0);
      expect(plan.map(row => row.detail).join('\n')).toMatch(/INTEGER PRIMARY KEY \(rowid=\?\)/);
      for (const options of [
        { limit: 30, offset: 7 }, { kinds: ['function'], languages: ['python'], limit: 20 },
        { limit: 5, pathHint: 'target/n079.cpp' },
      ] as SearchOptions[]) compare('Widget', options);
      const filtered = compare('Widget', { limit: 1 }, ['target/n249'], ['suffix']);
      expect(filtered.fts).toHaveLength(1);
      expect(filtered.fts[0].node.id).toBe('n249');
      compare('Widget path:target name:suffix', { limit: 20 });
      compare('missingWord', { limit: 5 });
    });

    it('preserves the original errors and search fallbacks for orphan postings', () => {
      queries.insertNode(node('same', 'OldAlpha'));
      queries.insertNode(node('same', 'NewBeta'));
      queries.insertNode(node('valid', 'OldAlphaLive'));
      expect(() => connection.getDb().exec("INSERT INTO nodes_fts(nodes_fts, rank) VALUES('integrity-check', 1)")).toThrow();
      for (const term of ['OldAlpha', 'OldAlpha NewBeta', 'OldAlphaLive', 'NewBeta']) {
        compare(term);
        compare(term, { kinds: ['function'], languages: ['python'] }, ['absent'], ['new']);
        compare(term, { kinds: ['class'], languages: ['cpp'], limit: 1, offset: 2 });
      }
      expect(compare('OldAlpha NewBeta').fts).toHaveLength(0);
      expect(compare('NewBeta').fts).toHaveLength(1);
      // A repaired index takes the fast branch again without persisted state.
      connection.endBulkNodeLoad();
      expect(compare('OldAlpha NewBeta').fts).toHaveLength(2);
    });

    if (backend === 'native') it('keeps guard and join in one WAL snapshot across a concurrent replacement', () => {
      queries.insertNode(node('same', 'OldAlpha'));
      const db = connection.getDb();
      const prepare = db.prepare.bind(db);
      let paused = false;
      (db as any)._db.function('test_guard_snapshot', (found: number) => {
        expect(found).toBe(0);
        paused = true;
        const writer = spawnSync(process.execPath, ['-e', `
          const {DatabaseSync}=require('node:sqlite');
          const db=new DatabaseSync(process.argv[1]);
          db.exec("INSERT OR REPLACE INTO nodes SELECT 'same',kind,'NewBeta',qualified_name,file_path,language,start_line,end_line,start_column,end_column,docstring,signature,visibility,is_exported,is_async,is_static,is_abstract,is_declaration,decorators,type_parameters,return_type,updated_at FROM nodes WHERE id='same'");
          db.close();
        `, path.join(dir, 'graph.db')], { encoding: 'utf8', timeout: 5000 });
        expect(writer.status, writer.stderr).toBe(0);
        return found;
      });
      const spy = vi.spyOn(db, 'prepare').mockImplementation(sql => prepare(sql.includes(newJoin)
        ? sql.replace('CASE WHEN EXISTS (', 'CASE WHEN test_guard_snapshot(EXISTS (')
          .replace(') THEN (', ')) THEN (') : sql));
      const before = (queries as any).searchNodesFTS('OldAlpha', {});
      expect(paused).toBe(true);
      expect(before.map((r: any) => r.node.name)).toEqual(['OldAlpha']);
      spy.mockRestore();
      // Next statement sees the committed replacement and orphan, not a cached
      // guard result. It reproduces the original error/fallback behavior.
      expect(compare('OldAlpha NewBeta').fts).toHaveLength(0);
      expect(compare('NewBeta').fts.map((r: any) => r.node.name)).toEqual(['NewBeta']);
    });

    it('keeps external content synchronized across mutations, rowid extremes, rebuild and reopen', () => {
      queries.insertNodes([node('nullable', 'NullIdentity'), node('first', 'Alpha'), node('second', 'Beta'), node('third', 'Gamma')]);
      const db = connection.getDb();
      db.exec("UPDATE nodes SET id=NULL WHERE id='nullable'");
      expect(compare('NullIdentity').fts).toHaveLength(0);
      // These are valid SQLite rowids, not array offsets or JS indices. The
      // join stays in SQL so even >MAX_SAFE_INTEGER never crosses JS as rowid.
      db.exec("UPDATE nodes SET rowid=-7 WHERE id='first'; UPDATE nodes SET rowid=0 WHERE id='second'; UPDATE nodes SET rowid=9223372036854775806 WHERE id='third';");
      for (const name of ['Alpha', 'Beta', 'Gamma']) expect(compare(name).fts).toHaveLength(1);
      queries.updateNode(node('first', 'Renamed'));
      expect(compare('Alpha').fts).toHaveLength(0);
      expect(compare('Renamed').fts[0].node.id).toBe('first');
      queries.deleteNode('second');
      expect(compare('Beta').fts).toHaveLength(0);
      // Explicit rowid reuse + text primary-key change exercise both trigger
      // OLD and NEW identities rather than assuming stable insertion order.
      db.exec("UPDATE nodes SET rowid=0, id='new-id' WHERE id='first'");
      expect(compare('Renamed').fts[0].node.id).toBe('new-id');
      db.exec("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')");
      db.exec("INSERT INTO nodes_fts(nodes_fts, rank) VALUES('integrity-check', 1)");
      expect(compare('Gamma').fts[0].node.id).toBe('third');
      connection.close();
      connection = DatabaseConnection.open(path.join(dir, 'graph.db'));
      queries = new QueryBuilder(connection.getDb());
      expect(compare('Renamed').fts[0].node.id).toBe('new-id');
      expect(compare('Gamma').fts[0].node.id).toBe('third');
      expect(compare('Beta').fts).toHaveLength(0);
      queries.deleteNode('third');
      expect(compare('Gamma').fts).toHaveLength(0);
    });
  });
}
