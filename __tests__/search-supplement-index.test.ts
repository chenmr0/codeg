import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { ensureSqlJsReady } from '../src/db/sqlite-adapter';
import type { Node, SearchOptions } from '../src/types';

const indexed = 'SELECT * FROM nodes WHERE lower(name) = lower(?)';
const original = 'SELECT * FROM nodes WHERE name = ? COLLATE NOCASE';
const makeNode = (id: string, name: string, i = 0): Node => ({
  id, name, kind: i % 3 ? 'function' : 'class', language: i % 2 ? 'python' : 'cpp',
  filePath: `${i % 2 ? 'target' : 'other'}/${id}.cpp`, startLine: i + 1,
  endLine: i + 2, startColumn: 0, endColumn: 1, updatedAt: 1,
});

for (const backend of ['native', 'wasm']) {
  describe(`indexed case-insensitive search supplement (${backend})`, () => {
    let directory: string;
    let connection: DatabaseConnection;
    let queries: QueryBuilder;
    beforeAll(async () => {
      vi.stubGlobal('fetch', undefined);
      try { await ensureSqlJsReady(); } finally { vi.unstubAllGlobals(); }
    });
    beforeEach(() => {
      if (backend === 'wasm') vi.stubEnv('CODEGRAPH_FORCE_WASM', '1');
      else vi.stubEnv('CODEGRAPH_FORCE_WASM', '');
      directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-search-index-'));
      connection = DatabaseConnection.initialize(path.join(directory, 'graph.db'));
      queries = new QueryBuilder(connection.getDb());
    });
    afterEach(() => {
      vi.restoreAllMocks();
      connection?.close();
      vi.unstubAllEnvs();
      fs.rmSync(directory, { recursive: true, force: true });
    });

    it('uses the existing expression index without changing ranking, filters or limits', () => {
      queries.insertNodes(Array.from({ length: 300 }, (_, i) =>
        makeNode(`node-${String(i).padStart(3, '0')}`, i < 60
          ? ['ObObj', 'obobj', 'OBOBJ'][i % 3]! : `ObObjDescriptor${i}`, i)));
      const db = connection.getDb();
      const prepare = db.prepare.bind(db);
      const statements: string[] = [];
      const spy = vi.spyOn(db, 'prepare').mockImplementation(sql => {
        statements.push(sql);
        return prepare(sql);
      });
      const cases: Array<[string, SearchOptions]> = [
        ['ObObj', { limit: 1 }], ['oBoBj', { limit: 10 }],
        ['ObObj', { limit: 100, offset: 5 }],
        ['ObObj', { kinds: ['function'], languages: ['python'], limit: 30 }],
        ['ObObj path:target name:obj', { limit: 20 }],
        ['ObObj', { pathHint: 'target/node-059.cpp', limit: 20 }],
      ];
      const actual = cases.map(([query, options]) => queries.searchNodes(query, options));
      const supplement = statements.find(sql => sql.startsWith(indexed));
      expect(supplement).toBeDefined();
      expect(supplement).toContain('LIMIT 20');
      const plan = prepare(`EXPLAIN QUERY PLAN ${supplement}`).all('ObObj');
      expect(plan.map(row => row.detail).join('\n')).toContain('idx_nodes_lower_name');
      expect(plan.map(row => row.detail).join('\n')).not.toContain('SCAN nodes');
      spy.mockImplementation(sql => prepare(sql.replace(indexed, original)));
      const before = cases.map(([query, options]) => queries.searchNodes(query, options));
      expect(actual).toEqual(before);
      expect(actual[0]).toHaveLength(1);
      expect(actual[0]![0]!.node.name.toLowerCase()).toBe('obobj');
    });

    it('preserves ASCII, non-ASCII and embedded-NUL comparison semantics', () => {
      const names = ['ObObj', 'oBoBj', 'Äbc', 'äbc', 'İd', 'id', 'Σx', 'σx',
        '中文Ab', '中文aB', 'nul\0B', 'NUL\0c', 'nul\0bb', 'nul', 'nul\0', '🦀Ab'];
      queries.insertNodes(names.map((name, i) => makeNode(`n${i}`, name)));
      const db = connection.getDb();
      const prepare = db.prepare.bind(db);
      const observed: string[] = [];
      vi.spyOn(db, 'prepare').mockImplementation(sql => {
        if (sql.startsWith(indexed) || sql.startsWith(original)) observed.push(sql);
        return prepare(sql);
      });
      for (const term of names) {
        observed.length = 0;
        queries.searchNodes(term);
        const sql = observed.at(-1);
        expect(sql, `supplement generated for ${JSON.stringify(term)}`).toBeDefined();
        expect(sql!.startsWith(term.includes('\0') ? original : indexed)).toBe(true);
        // Compare IDs rather than decoded names: SQL.js truncates NUL strings
        // when returning JS text, independently of SQL comparison semantics.
        const ids = (statement: string) => prepare(statement).all(term).map(row => row.id);
        expect(ids(sql!)).toEqual(ids(sql!.replace(indexed, original)));
      }
      // Explicitly demonstrate why the NUL fallback must remain.
      const a = 'nul\0B', b = 'NUL\0c';
      expect(prepare('SELECT ? = ? COLLATE NOCASE AS equal').get(a, b).equal).toBe(1);
      expect(prepare('SELECT lower(?) = lower(?) AS equal').get(a, b).equal).toBe(0);
    });
  });
}
