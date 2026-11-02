import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDatabase, ensureSqlJsReady, type SqliteDatabase } from '../src/db/sqlite-adapter';
import { QueryBuilder } from '../src/upstream-explore/db/queries';

type Candidate = { file_path: string; edge_count: number };
const ORIGINAL = `SELECT n.file_path AS file_path, COUNT(*) AS edge_count
  FROM edges e JOIN nodes n ON e.source = n.id JOIN nodes m ON e.target = m.id
  WHERE n.file_path = m.file_path GROUP BY n.file_path ORDER BY edge_count DESC LIMIT 20`;
const connections: SqliteDatabase[] = [];
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of connections.splice(0)) if (db.open) db.close();
  for (const root of roots.splice(0)) {
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unsafe fixture cleanup');
    fs.rmSync(root, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});

function fixture(indexed = true, connection?: SqliteDatabase) {
  const db = connection ?? createDatabase(':memory:').db;
  connections.push(db);
  db.exec(`CREATE TABLE nodes (id TEXT PRIMARY KEY, file_path TEXT, padding TEXT);
    CREATE TABLE edges (id INTEGER PRIMARY KEY, source TEXT, target TEXT, kind TEXT, line INTEGER);
    CREATE TABLE files (path TEXT PRIMARY KEY, generated INTEGER);`);
  if (indexed) db.exec(`CREATE INDEX idx_nodes_file_path ON nodes(file_path);
    CREATE INDEX idx_edges_source_kind ON edges(source,kind);
    CREATE INDEX idx_edges_target_kind ON edges(target,kind);
    CREATE INDEX idx_edges_identity ON edges(source,target,kind,line);`);
  const queries = new QueryBuilder(db);
  const node = db.prepare('INSERT INTO nodes VALUES (?, ?, ?)');
  const edge = db.prepare('INSERT INTO edges(source,target,kind,line) VALUES (?, ?, ?, ?)');
  let sequence = 0;
  return {
    db, queries,
    addNode: (id: string, file: string | null) => node.run(id, file, 'irrelevant wide metadata '.repeat(40)),
    addEdge: (source: string | null, target: string | null, kind = 'references') => edge.run(source, target, kind, ++sequence),
    raw: () => (queries as unknown as { computeDominantFileCandidates(): Candidate[] }).computeDominantFileCandidates(),
    original: () => db.prepare(ORIGINAL).all() as Candidate[],
  };
}

describe('dominant file aggregation preserves the original edge-count contract', () => {
  it.each([false, true])('counts every in-file edge while excluding missing or cross-file endpoints (indexed=%s)', indexed => {
    const f = fixture(indexed);
    f.addNode('a', 'src/alpha.cpp'); f.addNode('b', 'src/alpha.cpp');
    f.addNode('c', 'src/beta.cpp'); f.addNode('d', 'src/beta.cpp');
    f.addNode('null-1', null); f.addNode('null-2', null);
    for (let i = 0; i < 31; i++) f.addEdge('a', 'b', i % 2 ? 'calls' : 'references');
    for (let i = 0; i < 23; i++) f.addEdge('c', 'd');
    f.addEdge('a', 'a'); // A self edge still contributes once.
    f.addEdge('a', 'c'); f.addEdge('c', 'a');
    f.addEdge('missing-source', 'a'); f.addEdge('a', 'missing-target');
    f.addEdge('missing-source', 'missing-target');
    f.addEdge(null, 'a'); f.addEdge('a', null); f.addEdge('null-1', 'null-2');
    expect(f.raw()).toEqual(f.original());
    expect(f.raw()).toEqual([
      { file_path: 'src/alpha.cpp', edge_count: 32 },
      { file_path: 'src/beta.cpp', edge_count: 23 },
    ]);
  });

  it.each([false, true])('keeps the exact top-20 boundary and tie order of the original SQL (analyzed=%s)', analyzed => {
    const f = fixture();
    // Deliberately reverse node insertion and shuffle edge insertion. Equal
    // counts must not pick different files at LIMIT 20 after a plan change.
    const paths = Array.from({ length: 28 }, (_, i) => `src/${i.toString().padStart(2, '0')}.cpp`);
    for (let i = paths.length - 1; i >= 0; i--) {
      f.addNode(`a${i}`, paths[i]!); f.addNode(`b${i}`, paths[i]!);
    }
    for (let row = 0; row < 27; row++) for (let j = 0; j < paths.length; j++) {
      const i = (j * 9) % paths.length;
      if (row < (i < 3 ? 27 : 22)) f.addEdge(`a${i}`, `b${i}`);
    }
    if (analyzed) f.db.exec('ANALYZE');
    expect(f.original()).toHaveLength(20);
    expect(f.raw()).toEqual(f.original());
    f.db.exec('PRAGMA reverse_unordered_selects = ON');
    expect(f.raw()).toEqual(f.original());
  });

  it('retains empty and below-threshold behavior', () => {
    const f = fixture();
    expect(f.raw()).toEqual(f.original()); expect(f.queries.getDominantFile()).toBeNull();
    f.addNode('a', 'src/small.ts');
    for (let i = 0; i < 19; i++) f.addEdge('a', 'a');
    expect(f.raw()).toEqual(f.original()); expect(f.queries.getDominantFile()).toBeNull();
    f.addEdge('a', 'a');
    expect(f.queries.getDominantFile()).toEqual({ filePath: 'src/small.ts', edgeCount: 20, nextEdgeCount: 0 });
  });

  it.each(['inside', 'boundary', 'after'] as const)('only falls back for ties that can affect the top 20 (%s)', location => {
    const f = fixture();
    const counts = Array.from({ length: 25 }, (_, i) => 70 - i);
    const second = location === 'inside' ? 3 : location === 'boundary' ? 20 : 22;
    counts[second] = counts[second - 1]!;
    for (const [i, count] of counts.entries()) {
      f.addNode(`n${i}`, `src/file${i}.ts`);
      for (let j = 0; j < count; j++) f.addEdge(`n${i}`, `n${i}`);
    }
    const expected = f.original();
    const prepare = vi.spyOn(f.db, 'prepare');
    expect(f.raw()).toEqual(expected);
    const aggregateSql = prepare.mock.calls.map(([sql]) => sql).filter(sql => /COUNT\(\*\) AS edge_count/.test(sql));
    expect(aggregateSql).toHaveLength(location === 'after' ? 1 : 2);
    expect(aggregateSql[0]).toMatch(/CROSS JOIN/);
    expect(aggregateSql[0]).toMatch(/LIMIT 21/);
    if (location !== 'after') expect(aggregateSql[1]!.replace(/\s+/g, ' ').trim()).toBe(ORIGINAL.replace(/\s+/g, ' ').trim());
  });

  it('caches the legacy tie result and refreshes both statements after rebind', () => {
    const first = fixture();
    for (const id of ['a', 'b']) {
      first.addNode(id, `src/${id}.ts`);
      for (let j = 0; j < 25; j++) first.addEdge(id, id);
    }
    const compute = vi.spyOn(first.queries as any, 'computeDominantFileCandidates');
    const result = first.queries.getDominantFile();
    expect(first.queries.getDominantFile()).toEqual(result);
    expect(compute).toHaveBeenCalledTimes(1);
    const second = fixture();
    second.addNode('c', 'src/other.ts');
    for (let j = 0; j < 31; j++) second.addEdge('c', 'c');
    first.queries.rebind(second.db);
    expect(first.queries.getDominantFile()).toEqual({ filePath: 'src/other.ts', edgeCount: 31, nextEdgeCount: 0 });
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('filters generated and test files after top-20 selection, and rechecks generated evidence on cached counts', () => {
    const f = fixture();
    const files = ['src/generated.ts', 'test/feature.test.ts', 'src/feature.ts', 'src/secondary.ts'];
    for (const [i, file] of files.entries()) {
      f.addNode(`n${i}`, file);
      for (let j = 0; j < 50 - 8 * i; j++) f.addEdge(`n${i}`, `n${i}`);
    }
    const generated = new Set(['src/generated.ts']);
    vi.spyOn(f.queries, 'getGeneratedPathsAmong').mockImplementation(() => new Set(generated));
    const compute = vi.spyOn(f.queries as any, 'computeDominantFileCandidates');
    expect(f.queries.getDominantFile()).toEqual({ filePath: 'src/feature.ts', edgeCount: 34, nextEdgeCount: 26 });
    expect(compute).toHaveBeenCalledTimes(1);
    generated.clear();
    expect(f.queries.getDominantFile()).toEqual({ filePath: 'src/generated.ts', edgeCount: 50, nextEdgeCount: 34 });
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('does not move low-value filtering before LIMIT 20', () => {
    const f = fixture();
    for (let i = 0; i < 21; i++) {
      f.addNode(`n${i}`, i === 20 ? 'src/answer.ts' : `test/${i}.test.ts`);
      for (let j = 0; j < 50 - i; j++) f.addEdge(`n${i}`, `n${i}`);
    }
    expect(f.raw()).toEqual(f.original());
    expect(f.raw().some(row => row.file_path === 'src/answer.ts')).toBe(false);
    expect(f.queries.getDominantFile()).toBeNull();
  });

  it('uses the real WASM backend for distinct-count and tied top-20 SQL equivalence', async () => {
    // Source tests do not invoke copy-assets. Load the packaged WASM without
    // creating a generated binary in the candidate's source directory.
    const fsModule = require('fs') as typeof fs;
    const originalRead = fsModule.readFileSync;
    const wasm = originalRead(require.resolve('sql.js-fts5/dist/sql-wasm.wasm'));
    const read = vi.spyOn(fsModule, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: any[]) =>
      typeof file === 'string' && file.endsWith('sql-wasm.wasm') ? wasm : (originalRead as any)(file, ...args)) as any);
    try { await ensureSqlJsReady(); } finally { read.mockRestore(); }
    vi.stubEnv('CODEGRAPH_FORCE_WASM', '1');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dominant-wasm-')); roots.push(root);
    const fallback = createDatabase(path.join(root, 'fallback.db'));
    expect(fallback.backend).toBe('sql-js');
    expect(fallback.db.inTransaction).toBeUndefined();
    const f = fixture(true, fallback.db);
    for (let i = 0; i < 25; i++) {
      f.addNode(`n${i}`, `src/file${i}.ts`);
      for (let j = 0; j < 60 - i; j++) f.addEdge(`n${i}`, `n${i}`);
    }
    const prepare = vi.spyOn(f.db, 'prepare');
    expect(f.raw()).toEqual(f.original());
    const fastSql = prepare.mock.calls.find(([sql]) => /CROSS JOIN edges/.test(sql))![0];
    const plan = f.db.prepare(`EXPLAIN QUERY PLAN ${fastSql}`).all() as Array<{ detail: string }>;
    expect(plan.map(row => row.detail)).toEqual(expect.arrayContaining([
      expect.stringMatching(/SEARCH (?:TABLE edges AS )?e USING COVERING INDEX idx_edges_identity \(source=\?\)/),
    ]));
    // Introduce both an internal tie and a tie across the 20/21 boundary.
    f.addEdge('n3', 'n3'); f.addEdge('n20', 'n20');
    expect(f.raw()).toEqual(f.original());
    expect(f.raw()).toHaveLength(20);
  });
});
