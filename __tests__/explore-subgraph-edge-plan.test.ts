import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase, ensureSqlJsReady } from '../src/db/sqlite-adapter';
import { subgraphEdgeSql } from '../src/upstream-explore/db/subgraph-edge-plan';
import { QueryBuilder } from '../src/upstream-explore/db/queries';
import type { EdgeKind } from '../src/upstream-explore/types';

beforeAll(async () => {
  const fs = require('node:fs');
  const originalRead = fs.readFileSync;
  const wasm = originalRead(require.resolve('sql.js-fts5/dist/sql-wasm.wasm'));
  const read = vi.spyOn(fs, 'readFileSync').mockImplementation(((file: unknown, ...args: unknown[]) =>
    typeof file === 'string' && file.endsWith('sql-wasm.wasm') ? wasm : originalRead(file, ...args)) as any);
  try { await ensureSqlJsReady(); } finally { read.mockRestore(); }
});
for (const backend of ['native', 'wasm']) describe(`subgraph ordered differential / ${backend}`, () => {
  for (const layout of ['normal', 'target-desc', 'target-nocase', 'target-extra', 'source-missing', 'partial', 'reverse', 'without-rowid', 'analyzed', 'source-hub', 'source-desc', 'source-nocase', 'source-extra']) {
    it(`preserves full ordered rows for ${layout}`, () => {
      const old = process.env.CODEGRAPH_FORCE_WASM;
      if (backend === 'wasm') process.env.CODEGRAPH_FORCE_WASM = '1'; else delete process.env.CODEGRAPH_FORCE_WASM;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'explore-edge-plan-'));
      const { db, backend: actual } = createDatabase(backend === 'native' ? ':memory:' : path.join(dir, 'test.db'));
      if (old === undefined) delete process.env.CODEGRAPH_FORCE_WASM; else process.env.CODEGRAPH_FORCE_WASM = old;
      expect(actual).toBe(backend === 'wasm' ? 'sql-js' : 'node-sqlite');
      try {
        db.exec(`CREATE TABLE edges(id INTEGER PRIMARY KEY,source TEXT NOT NULL,target TEXT NOT NULL,kind TEXT NOT NULL,line INTEGER,col INTEGER,metadata TEXT,provenance TEXT) ${layout === 'without-rowid' ? 'WITHOUT ROWID' : ''};`);
        const source = layout === 'source-desc' ? 'source DESC,kind' : layout === 'source-nocase' ? 'source COLLATE NOCASE,kind' : layout === 'source-extra' ? 'source,kind,target' : 'source,kind';
        if (layout !== 'source-missing') db.exec(`CREATE INDEX idx_edges_source_kind ON edges(${source})`);
        const target = layout === 'target-desc' ? 'target DESC,kind' : layout === 'target-nocase' ? 'target COLLATE NOCASE,kind' : layout === 'target-extra' ? 'target,kind,source' : 'target,kind';
        db.exec(`CREATE INDEX idx_edges_target_kind ON edges(${target}) ${layout === 'partial' ? "WHERE kind='calls'" : ''}`);
        const names = ['z', 'a', 'A', 'é', '𝑥', 'x\0tail', 'outside'];
        const insert = db.prepare('INSERT INTO edges VALUES(?,?,?,?,?,?,?,?)');
        for (let i = 1; i <= 499; i++) insert.run(i, names[i % 7], names[(i * 3 + Math.floor(i / 7)) % 7], ['calls','references','contains'][i % 3], i, 0, `{"n":${i}}`, null);
        for (let i = 500; i < 8500; i++) insert.run(i, layout === 'source-hub' ? 'a' : `outside${i}`, layout === 'source-hub' ? `outside${i}` : 'a', 'calls', i, 0, '{}', null);
        if (layout === 'reverse') db.exec('PRAGMA reverse_unordered_selects=ON');
        if (layout === 'analyzed') db.exec('ANALYZE');
        const queries = new QueryBuilder(db);
        let optimized = 0;
        for (const ids of [[], ['a'], ['z','a','A','é','𝑥','x\0tail','z'], [...names, ...Array.from({length: layout === 'normal' ? 40000 : 40}, (_, i) => `absent${i}`)]]) {
          for (const kinds of [undefined, [], ['references'], ['references','calls','references'], ['calls','contains','references']] as (EdgeKind[] | undefined)[]) {
            const sql = 'SELECT * FROM edges WHERE source IN (SELECT value FROM json_each(?)) AND target IN (SELECT value FROM json_each(?))'
              + (kinds?.length ? ` AND kind IN (${kinds.map(() => '?').join(',')})` : '');
            const params = [JSON.stringify(ids), JSON.stringify(ids), ...(kinds ?? [])];
            const next = subgraphEdgeSql(db, sql, params);
            if (next !== sql) optimized++;
            const expected = db.prepare(sql).all(...params);
            expect(db.prepare(next).all(...params)).toEqual(expected);
            expect(queries.findEdgesBetweenNodes(ids, kinds)).toEqual(expected.map(r => ({source:r.source,target:r.target,kind:r.kind,line:r.line,column:r.col,metadata:JSON.parse(r.metadata),provenance:r.provenance})));
          }
        }
        if (layout === 'normal') expect(optimized).toBeGreaterThan(0);
        if (!['normal','analyzed'].includes(layout)) expect(optimized).toBe(0);
        if (layout === 'normal') {
          const prepare = db.prepare.bind(db);
          const spy = vi.spyOn(db, 'prepare').mockImplementation(sql => {
            if (sql.startsWith('EXPLAIN QUERY PLAN')) throw new Error('unsupported plan inspection');
            return prepare(sql);
          });
          const original = 'SELECT * FROM edges WHERE source IN (SELECT value FROM json_each(?)) AND target IN (SELECT value FROM json_each(?))';
          expect(subgraphEdgeSql(db, original, ['["a"]','["a"]'])).toBe(original);
          spy.mockRestore();
        }
        // Live changes must not retain an index-name/plan decision in a cache.
        db.exec('DROP INDEX idx_edges_target_kind');
        const sql = 'SELECT * FROM edges WHERE source IN (SELECT value FROM json_each(?)) AND target IN (SELECT value FROM json_each(?))';
        expect(subgraphEdgeSql(db, sql, ['["a"]','["a"]'])).toBe(sql);
      } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
    });
  }
});
