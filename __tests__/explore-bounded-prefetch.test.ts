import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, ensureSqlJsReady, type SqliteDatabase } from '../src/db/sqlite-adapter';
import { QueryBuilder } from '../src/upstream-explore/db/queries';
import { GraphTraverser } from '../src/upstream-explore/graph/traversal';
import type { Edge, Node, Subgraph, TraversalOptions } from '../src/upstream-explore/types';
import { baselineBfs, type BfsQueries } from './helpers/bfs-prefetch-baseline';

type Fixture = { nodes: Node[]; edges: Edge[] };
type ResultOrder = 'requested' | 'reversed' | 'sorted';
const MAX_PREFETCH_IDS = 64; // Read-cost contract; batch grouping is deliberately unspecified.
const node = (id: string, kind: Node['kind'] = 'function'): Node => ({
  id, kind, name: id, qualifiedName: `scope.${id}`, language: 'typescript',
  filePath: `src/${id}.ts`, startLine: 2, endLine: 9, startColumn: 0, endColumn: 1,
  signature: `${id}()`, docstring: `Documentation for ${id}`, updatedAt: 17,
});
const edge = (source: string, target: string, kind: Edge['kind'] = 'calls', line = 1, column = 0): Edge => ({
  source, target, kind, line, column, provenance: 'tree-sitter',
  metadata: { confidence: line % 2 ? 0.4 : 0.9, label: `${source}:${target}:${line}:${column}` },
});
// Map equality alone ignores insertion order. Preserve full node objects and
// complete edge objects (including metadata/provenance), not just IDs/counts.
const ordered = (result: Subgraph) => ({ nodes: [...result.nodes.entries()], edges: result.edges, roots: result.roots });

function memoryQueries(fixture: Fixture, order: ResultOrder = 'requested') {
  const nodes = new Map(fixture.nodes.map(value => [value.id, value]));
  const batches: string[][] = [];
  const adjacentReads: string[] = [];
  const queries: BfsQueries = {
    getNodeById: id => nodes.get(id) ?? null,
    getNodesByIds(ids) {
      batches.push([...ids]);
      const found = [...new Set(ids)].filter(id => nodes.has(id));
      if (order === 'reversed') found.reverse();
      if (order === 'sorted') found.sort();
      return new Map(found.map(id => [id, nodes.get(id)!]));
    },
    getOutgoingEdges(id, kinds) {
      adjacentReads.push(`out:${id}`);
      return fixture.edges.filter(e => e.source === id && (!kinds || kinds.includes(e.kind)));
    },
    getIncomingEdges(id, kinds) {
      adjacentReads.push(`in:${id}`);
      return fixture.edges.filter(e => e.target === id && (!kinds || kinds.includes(e.kind)));
    },
  };
  return { queries, batches, adjacentReads };
}

function compare(fixture: Fixture, options: TraversalOptions = {}, order: ResultOrder = 'requested', start = 'root') {
  const baseline = memoryQueries(fixture, order);
  const current = memoryQueries(fixture, order);
  const expected = baselineBfs(baseline.queries, start, options);
  const result = new GraphTraverser(current.queries as QueryBuilder).traverseBFS(start, options);
  expect(ordered(result)).toStrictEqual(ordered(expected));
  expect(current.adjacentReads).toEqual(baseline.adjacentReads);
  expect(current.batches.every(ids => ids.length <= MAX_PREFETCH_IDS && new Set(ids).size === ids.length)).toBe(true);
  expect(current.batches.flat().length).toBeLessThanOrEqual(baseline.batches.flat().length);
  return { ...current, result };
}

function fanout(count: number, incoming = false): Fixture {
  const nodes = [node('root'), ...Array.from({ length: count }, (_, i) => node(`item${i}`))];
  const edges = nodes.slice(1).map((n, i) => edge('root', n.id, 'calls', i + 1));
  const tail = [
    edge('root', 'item0', 'calls', count + 1, 1),
    edge('root', 'item0', 'calls', count + 1, 2),
    edge('root', 'item0', 'calls', count + 2, 1),
    edge('root', 'item0', 'references', count + 1, 1),
  ];
  edges.push(...tail, { ...tail[0]!, metadata: { duplicateIdentity: 'keep the first complete edge' } });
  return { nodes, edges: incoming ? edges.map(e => ({ ...e, source: e.target, target: e.source })) : edges };
}

const optionCases: Array<[string, TraversalOptions]> = [
  ['defaults', {}], ['zero', { limit: 0 }], ['one', { limit: 1 }],
  ['fractional', { limit: 2.5 }], ['unlimited', { limit: Infinity }],
  ['omit root at zero', { includeStart: false, limit: 0 }],
  ['omit root at one', { includeStart: false, limit: 1 }],
  ['omit root with cycles', { includeStart: false, limit: Infinity, direction: 'both' }],
  ['depth zero', { maxDepth: 0 }], ['depth one', { maxDepth: 1 }],
  ['depth two', { maxDepth: 2, limit: 8 }],
  ['incoming', { direction: 'incoming', limit: 8 }], ['both', { direction: 'both', limit: 8 }],
  ['filtered nodes', { nodeKinds: ['function'], limit: 5 }],
  ['no eligible nodes', { nodeKinds: ['interface'], limit: 5 }],
  ['filtered edges', { edgeKinds: ['references'], direction: 'both', limit: 8 }],
  ['combined filters', { edgeKinds: ['contains', 'calls'], nodeKinds: ['function', 'class'], direction: 'both', maxDepth: 2, limit: 5 }],
];

const cyclicFixture = (): Fixture => ({
  nodes: [node('root'), node('left'), node('right', 'class'), node('shared'), node('leaf', 'constant')],
  edges: [
    edge('root', 'root'), edge('root', 'left'), edge('root', 'right', 'contains'),
    edge('left', 'shared'), edge('right', 'shared'), edge('right', 'shared', 'references'),
    edge('shared', 'leaf'), edge('leaf', 'root'), edge('left', 'absent'),
    edge('root', 'left', 'calls', 2), edge('root', 'left', 'calls', 2, 1),
    edge('root', 'left', 'references'), edge('root', 'left', 'calls', 2),
  ],
});

describe('bounded BFS node prefetch preserves the ordered graph', () => {
  it.each([
    ['outgoing', false], ['incoming', true], ['both', false], ['both', true],
  ] as const)('fetches only 24 neighbors of a 10,000-way fanout, direction=%s reversed=%s', (direction, incoming) => {
    const fixture = fanout(10_000, incoming);
    const { result, batches } = compare(fixture, { limit: 25, direction });
    expect([...result.nodes.keys()]).toEqual(['root', ...Array.from({ length: 24 }, (_, i) => `item${i}`)]);
    expect(result.edges).toStrictEqual([...fixture.edges.slice(0, 24), ...fixture.edges.slice(10_000, 10_004)]);
    expect(batches.flat()).toEqual(Array.from({ length: 24 }, (_, i) => `item${i}`));
    expect(batches.every(ids => ids.length <= 24)).toBe(true);
  });

  it('continues through duplicate, missing and rejected targets to later eligible nodes', () => {
    const rejected = Array.from({ length: 300 }, (_, i) => node(`rejected${i}`, 'class'));
    const missing = Array.from({ length: 80 }, (_, i) => `missing${i}`);
    const prefix = [...missing, ...rejected.map(n => n.id)];
    const nodes = [node('root'), ...rejected, node('accepted0'), node('accepted1'), node('afterCap')];
    const edges = prefix.flatMap((id, i) => [edge('root', id, 'calls', i + 1), edge('root', id, 'calls', i + 1, 1)]);
    edges.push(edge('root', 'accepted0'), edge('root', 'accepted1'), edge('root', 'afterCap'));
    // Repeated misses/rejections at the tail must not cause another lookup.
    edges.push(...prefix.map(id => edge('root', id, 'references')));
    edges.push(edge('root', 'accepted0', 'references', 900));
    const { result, batches } = compare({ nodes, edges }, { limit: 3, nodeKinds: ['function'] }, 'reversed');
    expect([...result.nodes.keys()]).toEqual(['root', 'accepted0', 'accepted1']);
    expect(batches.flat()).toEqual([...prefix, 'accepted0', 'accepted1']);
    expect(batches.every(ids => ids.length <= 2)).toBe(true);
    expect(result.edges).toStrictEqual([
      edge('root', 'accepted0'), edge('root', 'accepted1'), edge('root', 'accepted0', 'references', 900),
    ]);
  });

  it.each(optionCases)('retains legacy options: %s', (_label, options) => {
    for (const order of ['requested', 'reversed', 'sorted'] as const) compare(cyclicFixture(), options, order);
  });

  it('handles missing starts and isolated roots without requesting neighbors', () => {
    for (const start of ['root', 'missing']) {
      const { result, batches } = compare({ nodes: [node('root')], edges: [] }, {}, 'requested', start);
      expect(ordered(result)).toStrictEqual({ nodes: start === 'root' ? [['root', node('root')]] : [], edges: [], roots: start === 'root' ? ['root'] : [] });
      expect(batches).toEqual([]);
    }
  });

  it('expands converging and cyclic nodes only once while retaining their distinct edges', () => {
    const fixture = cyclicFixture();
    const { result, adjacentReads } = compare(fixture, { limit: Infinity, direction: 'both' });
    expect(new Set(adjacentReads).size).toBe(adjacentReads.length);
    expect([...result.nodes.keys()]).toEqual(['root', 'right', 'left', 'leaf', 'shared']);
    expect(result.edges).toHaveLength(11); // 13 input edges minus one missing target and one duplicate identity.
  });

  it.each(Array.from({ length: 16 }, (_, i) => 20261105 + i))('matches the frozen BFS on seeded graph %i', seed => {
    let state = seed;
    const rand = (n: number) => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state % n;
    };
    const kinds: Node['kind'][] = ['function', 'class', 'constant', 'macro'];
    const edgeKinds: Edge['kind'][] = ['references', 'contains', 'calls', 'imports'];
    const nodes = Array.from({ length: 18 }, (_, i) => node(i === 0 ? 'root' : `n${i}`, kinds[rand(kinds.length)]));
    const edges: Edge[] = [];
    for (let i = 0; i < 90; i++) {
      const e = edge(nodes[rand(nodes.length)]!.id, rand(9) === 0 ? `missing${rand(3)}` : nodes[rand(nodes.length)]!.id,
        edgeKinds[rand(edgeKinds.length)], rand(12), rand(3));
      edges.push(e);
      if (rand(6) === 0) edges.push({ ...e, metadata: { duplicateIdentity: true } });
    }
    for (const [, options] of optionCases) {
      for (const order of ['requested', 'reversed', 'sorted'] as const) compare({ nodes, edges }, options, order);
    }
  });
});

// Minimal real schema exercises QueryBuilder row conversion, SQL ordering,
// parameter chunking, and its LRU without indexing a repository.
function populate(db: SqliteDatabase, fixture: Fixture) {
  db.exec(`
    CREATE TABLE nodes(id TEXT PRIMARY KEY, kind TEXT, name TEXT, qualified_name TEXT, file_path TEXT,
      language TEXT, start_line INTEGER, end_line INTEGER, start_column INTEGER, end_column INTEGER,
      docstring TEXT, signature TEXT, visibility TEXT, is_exported INTEGER, is_async INTEGER,
      is_static INTEGER, is_abstract INTEGER, is_declaration INTEGER, decorators TEXT,
      type_parameters TEXT, return_type TEXT, updated_at INTEGER);
    CREATE TABLE edges(id INTEGER PRIMARY KEY, source TEXT, target TEXT, kind TEXT, line INTEGER, col INTEGER,
      metadata TEXT, provenance TEXT);
    CREATE INDEX idx_edges_source_kind ON edges(source, kind);
    CREATE INDEX idx_edges_target_kind ON edges(target, kind);
  `);
  const insertNode = db.prepare('INSERT INTO nodes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const insertEdge = db.prepare('INSERT INTO edges(source,target,kind,line,col,metadata,provenance) VALUES(?,?,?,?,?,?,?)');
  db.transaction(() => {
    for (const n of fixture.nodes) insertNode.run(n.id, n.kind, n.name, n.qualifiedName, n.filePath, n.language,
      n.startLine, n.endLine, n.startColumn, n.endColumn, n.docstring ?? null, n.signature ?? null,
      null, 0, 0, 0, 0, 0, null, null, null, n.updatedAt);
    for (const e of fixture.edges) insertEdge.run(e.source, e.target, e.kind, e.line ?? null,
      e.column ?? null, JSON.stringify(e.metadata), e.provenance ?? null);
  })();
}

async function enableWasm() {
  // Source tests do not copy build assets; use the installed WASM binary.
  const fsModule = require('fs') as typeof fs;
  const read = fsModule.readFileSync;
  const wasm = read(require.resolve('sql.js-fts5/dist/sql-wasm.wasm'));
  const mocked = vi.spyOn(fsModule, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: any[]) =>
    typeof file === 'string' && file.endsWith('sql-wasm.wasm') ? wasm : (read as any)(file, ...args)) as any);
  try { await ensureSqlJsReady(); } finally { mocked.mockRestore(); }
  vi.stubEnv('CODEGRAPH_FORCE_WASM', '1');
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe.each(['node-sqlite', 'sql-js'] as const)('bounded BFS with real %s QueryBuilder', backend => {
  it('preserves ordered results with cold, warm and mixed caches on a stable read snapshot', async () => {
    if (backend === 'sql-js') await enableWasm();
    else vi.stubEnv('CODEGRAPH_FORCE_WASM', undefined);
    const root = fs.mkdtempSync(join(tmpdir(), 'cg-bfs-prefetch-'));
    const opened = createDatabase(join(root, 'graph.db'));
    expect(opened.backend).toBe(backend);
    const db = opened.db;
    try {
      populate(db, fanout(1_100));
      const queries = new QueryBuilder(db);
      const traverser = new GraphTraverser(queries);
      const requests = vi.spyOn(queries, 'getNodesByIds');
      const sqlReads: number[] = [];
      const prepare = db.prepare.bind(db);
      vi.spyOn(db, 'prepare').mockImplementation(sql => {
        const statement = prepare(sql);
        if (/^SELECT \* FROM nodes WHERE id IN /.test(sql)) {
          const all = statement.all.bind(statement);
          statement.all = (...params) => { sqlReads.push(params.length); return all(...params); };
        }
        return statement;
      });
      db.exec('BEGIN');
      try {
        const options: TraversalOptions = { limit: 25, direction: 'both' };
        const expected = ordered(baselineBfs(new QueryBuilder(db), 'root', options));
        for (const cache of ['cold', 'warm', 'mixed'] as const) {
          if (cache !== 'warm') queries.clearCache();
          if (cache === 'mixed') queries.getNodesByIds([expected.nodes[9]![0], expected.nodes[3]![0], expected.nodes[1]![0]]);
          requests.mockClear(); sqlReads.length = 0;
          expect(ordered(traverser.traverseBFS('root', options))).toStrictEqual(expected);
          expect(requests.mock.calls.flatMap(([ids]) => [...ids])).toHaveLength(24);
          expect(sqlReads.reduce((sum, n) => sum + n, 0)).toBe(cache === 'warm' ? 0 : cache === 'mixed' ? 21 : 24);
        }
        // A budget beyond the SQL adapter's 500-parameter chunk also exercises
        // the traversal's independent bound of 64 IDs per prefetch request.
        queries.clearCache(); requests.mockClear();
        const wide: TraversalOptions = { limit: 700, maxDepth: 1 };
        const wideExpected = baselineBfs(new QueryBuilder(db), 'root', wide);
        expect(ordered(traverser.traverseBFS('root', wide))).toStrictEqual(ordered(wideExpected));
        expect(requests.mock.calls.flatMap(([ids]) => [...ids])).toHaveLength(699);
        expect(requests.mock.calls.every(([ids]) => ids.length <= MAX_PREFETCH_IDS)).toBe(true);
      } finally { db.exec('ROLLBACK'); }
    } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
});

it('keeps every deferred node batch in the caller-owned SQLite snapshot across an external commit', () => {
  vi.stubEnv('CODEGRAPH_FORCE_WASM', undefined);
  const root = fs.mkdtempSync(join(tmpdir(), 'cg-bfs-snapshot-'));
  const path = join(root, 'graph.db');
  const writer = createDatabase(path, { nativeOnly: true }).db;
  let reader: SqliteDatabase | undefined;
  try {
    writer.pragma('journal_mode = WAL');
    populate(writer, fanout(180));
    reader = createDatabase(path, { readOnly: true }).db;
    reader.exec('BEGIN');
    const options: TraversalOptions = { limit: 140 };
    const expected = ordered(baselineBfs(new QueryBuilder(reader), 'root', options));
    writer.prepare('UPDATE nodes SET name = ? WHERE id = ?').run('afterCommit', 'item100');
    const queries = new QueryBuilder(reader);
    const requests = vi.spyOn(queries, 'getNodesByIds');
    expect(ordered(new GraphTraverser(queries).traverseBFS('root', options))).toStrictEqual(expected);
    expect(requests.mock.calls.length).toBeGreaterThan(1);
    expect(requests.mock.calls.every(([ids]) => ids.length <= MAX_PREFETCH_IDS)).toBe(true);
    reader.exec('ROLLBACK');
    // A fresh request sees the committed data; the earlier match was a real
    // pinned SQLite snapshot rather than a cache hiding the external update.
    const current = new GraphTraverser(new QueryBuilder(reader)).traverseBFS('root', options);
    expect(current.nodes.get('item100')!.name).toBe('afterCommit');
    expect(ordered(current)).toStrictEqual(ordered(baselineBfs(new QueryBuilder(writer), 'root', options)));
  } finally {
    reader?.close(); writer.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});
