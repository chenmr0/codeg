import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createRequire } from 'module';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { ReferenceResolver } from '../src/resolution';
import { ResolutionDiagnostics } from '../src/resolution/diagnostics';
import { IndexedNameLookup, MAX_INDEXED_SYNC_REFS, syncNameLookupMode, type NameLookupMode } from '../src/resolution/name-lookup';
import type { Node, UnresolvedReference } from '../src/types';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types';
const runtimeRequire = createRequire(import.meta.url);

describe('indexed name membership', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('caches positive and negative answers and evicts within the bound', () => {
    const exists = vi.fn((name: string) => name === 'yes');
    const lookup = new IndexedNameLookup(exists, 2);
    expect([lookup.has('yes'), lookup.has('no'), lookup.has('yes'), lookup.has('no')]).toEqual([true, false, true, false]);
    expect(exists).toHaveBeenCalledTimes(2);
    lookup.has('third'); lookup.has('yes');
    expect(exists).toHaveBeenCalledTimes(4); expect(lookup.size).toBe(2);
  });
  it('never negatively caches a failed SQL lookup', () => {
    const exists = vi.fn().mockImplementationOnce(() => { throw new Error('SQL failed'); }).mockReturnValue(true);
    const lookup = new IndexedNameLookup(exists);
    expect(() => lookup.has('name')).toThrow('SQL failed');
    expect(lookup.has('name')).toBe(true); expect(exists).toHaveBeenCalledTimes(2);
  });
  it('does not alias invalid UTF-16 to the replacement character', () => {
    const exists = vi.fn(() => true); const lookup = new IndexedNameLookup(exists);
    expect(lookup.has('\ud800')).toBe(false); expect(lookup.has('\udfff')).toBe(false);
    expect(exists).not.toHaveBeenCalled(); expect(lookup.has('😀')).toBe(true);
  });
  it('selects bounded small sync passes and supports an off switch', () => {
    vi.stubEnv('CODEGRAPH_SYNC_NAME_LOOKUP', 'auto');
    for (const count of [0, 3, MAX_INDEXED_SYNC_REFS]) expect(syncNameLookupMode(count)).toBe('indexed');
    for (const count of [MAX_INDEXED_SYNC_REFS + 1, -1, NaN]) expect(syncNameLookupMode(count)).toBe('full');
    for (const setting of ['0', 'full', 'typo']) {
      vi.stubEnv('CODEGRAPH_SYNC_NAME_LOOKUP', setting); expect(syncNameLookupMode(3)).toBe('full');
    }
  });
});

interface Access {
  hasAnyPossibleMatch(name: string): boolean;
  hasKnownName(name: string): boolean;
  isBuiltInOrExternal(ref: UnresolvedRef): boolean;
  context: ResolutionContext;
}

describe('indexed prefilter parity and cache epochs', () => {
  let root: string;
  type Handle = Pick<DatabaseConnection, 'getDb' | 'close'>;
  const connections: Handle[] = [];
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-indexed-names-')); });
  afterEach(() => {
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    for (const db of connections.splice(0)) db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const node = (name: string, id = name): Node => ({ id, name, qualifiedName: name, kind: 'function',
    language: 'c', filePath: 'a.c', startLine: 1, endLine: 2, startColumn: 0, endColumn: 1, updatedAt: 1 });
  const ref = (name: string): UnresolvedReference => ({ fromNodeId: 'caller', referenceName: name,
    referenceKind: 'calls', filePath: 'a.c', language: 'c', line: 2, column: 0 });
  const fixture = (names = ['caller', 'target'], initialize: (file: string) => Handle = DatabaseConnection.initialize) => {
    const connection = initialize(path.join(root, `db${connections.length}.db`)); connections.push(connection);
    const queries = new QueryBuilder(connection.getDb()); queries.insertNodes(names.map(name => node(name)));
    queries.upsertFile({ path: 'a.c', contentHash: 'fixture', language: 'c', size: 1, modifiedAt: 1, indexedAt: 1, nodeCount: names.length });
    const resolver = new ReferenceResolver(root, queries);
    return { connection, queries, resolver, access: resolver as unknown as Access };
  };

  it.each(['native', 'wasm'])('matches the complete Set with %s SQLite, including binary case and Unicode', async backend => {
    vi.stubEnv('CODEGRAPH_FORCE_WASM', backend === 'wasm' ? '1' : '');
    let initialize: (file: string) => Handle = DatabaseConnection.initialize;
    if (backend === 'wasm') {
      // Exercise the actual packaged WASM adapter, whose adjacent .wasm was
      // installed by npm run build. Source-mode fallback paths aren't a fixture.
      const adapter = runtimeRequire('../dist/db/sqlite-adapter.js');
      await adapter.ensureSqlJsReady();
      initialize = runtimeRequire('../dist/db/index.js').DatabaseConnection.initialize;
    }
    const names = ['caller', 'target', 'Target', '宏', '😀', '\ufffd', "x' OR 1=1 --", 'e\u0301', 'é'];
    const { queries } = fixture(names, initialize);
    const all = new Set(queries.getAllNodeNames());
    const lookup = new IndexedNameLookup(name => queries.hasNodeName(name));
    for (const name of [...names, 'TARGET', 'missing', '宏函数', '\ud800', '\udfff']) {
      expect(lookup.has(name), name).toBe(all.has(name));
    }
    expect(queries.getAllNodes()).toHaveLength(names.length);
  });

  it('uses the name index without enumerating the table', () => {
    const { connection, queries } = fixture();
    const plan = connection.getDb().prepare('EXPLAIN QUERY PLAN SELECT 1 FROM nodes WHERE name = ? COLLATE BINARY LIMIT 1').all('target');
    expect(JSON.stringify(plan)).toContain('idx_nodes_name');
    const load = vi.spyOn(queries, 'getAllNodeNames');
    expect(queries.hasNodeName('target')).toBe(true); expect(load).not.toHaveBeenCalled();
  });

  it('retains all qualified-name, path-tail and Python builtin guards', () => {
    const names = ['caller', 'target', 'Target', 'Item', 'index', 'get', 'Bar', 'drawer.liquid', '宏', 'f'];
    const { queries, resolver: full, access: fullAccess } = fixture(names);
    const indexed = new ReferenceResolver(root, queries); const indexedAccess = indexed as unknown as Access;
    full.warmCaches(); indexed.warmCaches(undefined, 'indexed');
    const cases = ['target', 'TARGET', 'obj.target', 'item.missing', 'x.y.Bar', 'ns::deep::f', 'target::missing',
      'x::y::missing', 'snippets/drawer.liquid', 'snippets/missing.liquid', 'x.宏', '', '.f', '::f'];
    for (const name of cases) expect(indexedAccess.hasAnyPossibleMatch(name), name).toBe(fullAccess.hasAnyPossibleMatch(name));
    for (const name of ['index', 'get', 'append', 'item.append', 'other.append', 'list.append', 'print']) {
      const value: UnresolvedRef = { ...ref(name), language: 'python' };
      expect(indexedAccess.isBuiltInOrExternal(value), name).toBe(fullAccess.isBuiltInOrExternal(value));
    }
  });

  it('invalidates positive and negative entries after names are added, removed or renamed', () => {
    const { queries, resolver, access } = fixture();
    resolver.warmCaches(undefined, 'indexed');
    expect(access.hasKnownName('new')).toBe(false); expect(access.hasKnownName('target')).toBe(true);
    queries.insertNodes([node('new')]); queries.deleteNode('target'); resolver.clearCaches();
    resolver.warmCaches(undefined, 'indexed');
    expect(access.hasKnownName('new')).toBe(true); expect(access.hasKnownName('target')).toBe(false);
    queries.updateNode({ ...node('renamed', 'new') }); resolver.clearCaches();
    resolver.warmCaches(undefined, 'indexed');
    expect(access.hasKnownName('new')).toBe(false); expect(access.hasKnownName('renamed')).toBe(true);
  });

  it('promotes indexed membership for later bulk calls and reuses a full warm Set', () => {
    const { queries, resolver, access } = fixture(); const names = vi.spyOn(queries, 'getAllNodeNames');
    resolver.resolveAll([ref('target')], undefined, new ResolutionDiagnostics(), 'indexed');
    expect(names).not.toHaveBeenCalled();
    const bulk = new ResolutionDiagnostics(); resolver.resolveAll([], undefined, bulk);
    expect(names).toHaveBeenCalledTimes(1); expect(bulk.nameLookup).toBe('full');
    const probes = vi.spyOn(queries, 'hasNodeName');
    const reused = new ResolutionDiagnostics(); resolver.resolveAll([ref('target')], undefined, reused, 'indexed');
    expect(reused.nameLookup).toBe('full'); expect(reused.cache).toBe('warm');
    expect(probes).not.toHaveBeenCalled();
    // Indexed-but-missing on disk still counts as an existing graph file.
    expect(access.context.fileExists('a.c')).toBe(true);
  });

  it('does no symbol work for an empty small pass, but caps indexed requests for large batches', () => {
    const { queries, resolver } = fixture(); const names = vi.spyOn(queries, 'getAllNodeNames');
    const probes = vi.spyOn(queries, 'hasNodeName');
    const empty = new ResolutionDiagnostics(); resolver.resolveAll([], undefined, empty, 'indexed');
    expect(empty).toMatchObject({ nameLookup: 'indexed', knownNames: 'not-loaded', nameQueries: 0 });
    expect(names).not.toHaveBeenCalled(); expect(probes).not.toHaveBeenCalled();
    const large = new ResolutionDiagnostics();
    resolver.resolveAll(Array.from({ length: MAX_INDEXED_SYNC_REFS + 1 }, () => ref('target')), undefined, large, 'indexed');
    expect(large.nameLookup).toBe('full'); expect(names).toHaveBeenCalledTimes(1);
  });

  it('preserves resolved edges, failed rows, progress and repeat-cache diagnostics', () => {
    const exercise = (mode: NameLookupMode) => {
      const { queries, resolver } = fixture();
      queries.insertUnresolvedRefsBatch([ref('target'), ref('missing'), { ...ref('missing'), line: 3 }]);
      const diagnostics = new ResolutionDiagnostics(); const progress: number[][] = [];
      const result = resolver.resolveAndPersist(queries.getUnresolvedReferences(), (n, total) => progress.push([n, total]), diagnostics, mode);
      return { diagnostics, state: { result, edges: queries.getOutgoingEdges('caller'), progress,
        pending: queries.getUnresolvedReferencesCount(), failed: queries.getFailedReferenceRetryPlan(['missing']) } };
    };
    const full = exercise('full'), indexed = exercise('indexed');
    expect(indexed.state).toEqual(full.state);
    expect(indexed.diagnostics).toMatchObject({ nameLookup: 'indexed', knownNames: 'not-loaded', nameQueries: 2, nameCacheHits: 1 });
    expect(indexed.diagnostics.timings.symbolNamesLoadMs).toBe(0);
    expect(indexed.diagnostics.timings.nameProbeMs).toBeGreaterThanOrEqual(0);
  });
});
