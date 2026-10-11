import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
import type { ExtractionOrchestrator } from '../src/extraction';
import type { QueryBuilder } from '../src/db/queries';
import { StoreWriter, type ReplaceFileStore, type StoreReplacementResult } from '../src/extraction/store-writer';
import * as treeSitter from '../src/extraction/tree-sitter';

const REWIRE_PENDING = 'index_rewire_synthesis_pending';
const roots: string[] = [];
const graphs: CodeGraph[] = [];
const writers: StoreWriter[] = [];
beforeEach(() => {
  // Exercise the replacement/rewiring producer, not the separate append path.
  vi.stubEnv('CODEGRAPH_NO_APPEND_DELTA', '1');
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const writer of writers.splice(0)) await writer.close();
  for (const graph of graphs.splice(0)) graph.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const cases = [
  {
    label: 'C function rename',
    extension: 'c',
    original: 'int modified_target(void) { return 1; }\n',
    changed: 'int renamed_target(void) { return 123; }\n',
    call: 'modified_target()',
    signature: 'int modified_target(void)',
  },
  {
    label: 'C++ overload removal',
    extension: 'cpp',
    original: 'int modified_target(int x) { return x; }\n' +
      'int modified_target(int x, int y) { return x + y; }\n',
    changed: 'int modified_target(int x, int y) { return x + y; }\n',
    call: 'modified_target(1)',
    signature: 'int modified_target(int x)',
  },
] as const;

type FixtureCase = typeof cases[number];
async function fixture(example: FixtureCase) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-modified-ref-sources-'));
  roots.push(root);
  const provider = `provider.${example.extension}`;
  const callers = [`caller_a.${example.extension}`, `caller_b.${example.extension}`];
  fs.writeFileSync(path.join(root, provider), example.original);
  fs.writeFileSync(path.join(root, callers[0]!),
    `int caller_a(void) { return ${example.call}; }\n` +
    `int caller_a_again(void) { return ${example.call}; }\n`);
  fs.writeFileSync(path.join(root, callers[1]!),
    `int caller_b(void) { return ${example.call}; }\n`);
  fs.writeFileSync(path.join(root, `unrelated.${example.extension}`),
    'int unrelated(void) { return 0; }\n');
  const graph = CodeGraph.initSync(root);
  graphs.push(graph);
  await graph.indexAll();
  const db = (graph as any).db.getDb();
  const queries = (graph as any).queries as QueryBuilder;
  const orchestrator = (graph as any).orchestrator as ExtractionOrchestrator;
  const incoming = queries.getIncomingCrossFileEdges(provider).filter(edge => edge.edgeKind === 'calls');
  expect(incoming).toHaveLength(3);
  expect(incoming.every(edge => edge.targetSignature === example.signature)).toBe(true);
  expect(incoming.every(edge => JSON.parse(edge.metadata!).refName === 'modified_target')).toBe(true);
  const callerRecords = callers.map(file => graph.getFile(file));
  const references = () => db.prepare(`
    SELECT file_path, reference_name, reference_kind, status
    FROM unresolved_refs WHERE reference_name = 'modified_target'
    ORDER BY file_path, from_node_id
  `).all();
  expect(references()).toEqual([]);
  expect(queries.getMetadata(REWIRE_PENDING)).toBeNull();
  return { root, provider, callers, graph, db, queries, orchestrator, callerRecords, references };
}

// The worker route uses the shipped script and a separate SQLite connection.
// Run npm run build first, as for incremental-store-worker.test.
function replacementStore(f: Awaited<ReturnType<typeof fixture>>) {
  let writer: StoreWriter | undefined;
  const committed: StoreReplacementResult[] = [];
  const replace: ReplaceFileStore = vi.fn(async request => {
    if (!writer) {
      const connection = (f.graph as any).db;
      expect(connection.getBackend()).toBe('node-sqlite');
      writer = new StoreWriter(path.resolve(__dirname, '../dist/extraction/store-worker.js'),
        connection.getPath(), false, { root: f.root, deferWal: false });
      writers.push(writer);
    }
    const result = await writer.replace(request);
    committed.push(result);
    return result;
  });
  return { replace, committed };
}

function expectPendingCallers(f: Awaited<ReturnType<typeof fixture>>) {
  expect(f.queries.getMetadata(REWIRE_PENDING)).not.toBeNull();
  expect(f.references()).toEqual([
    { file_path: f.callers[0], reference_name: 'modified_target', reference_kind: 'calls', status: 'pending' },
    { file_path: f.callers[0], reference_name: 'modified_target', reference_kind: 'calls', status: 'pending' },
    { file_path: f.callers[1], reference_name: 'modified_target', reference_kind: 'calls', status: 'pending' },
  ]);
  expect(f.callers.map(file => f.graph.getFile(file))).toEqual(f.callerRecords);
  expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
}

describe.each(['main process', 'real store worker'] as const)(
  'modified-file reference sources: %s', route => {
    it.each(cases)('reports unchanged caller files after $label', async example => {
      const f = await fixture(example);
      const workerRoute = route === 'real store worker';
      vi.spyOn(f.queries, 'hasManyIncomingEdges').mockReturnValue(workerRoute);
      const store = replacementStore(f);
      fs.writeFileSync(path.join(f.root, f.provider), example.changed);

      // Stop at extraction: a later global orphan sweep can conceal the missing
      // producer signal by resolving these pending rows anyway.
      const result = await f.orchestrator.sync(undefined, [f.provider], undefined, store.replace);

      expect(result.filesModified).toBe(1);
      expect(result.changedFilePaths).toEqual([f.provider]);
      expect(result.failedRewireSourceFiles).toBeUndefined();
      expectPendingCallers(f);
      expect(store.replace).toHaveBeenCalledTimes(workerRoute ? 1 : 0);
      if (workerRoute) {
        expect.soft(store.committed[0]?.resurrectedSourceFiles?.slice().sort()).toEqual(f.callers);
      }
      expect(result.resurrectedReferenceSourceFiles?.slice().sort()).toEqual(f.callers);
    });
  },
);

it('does not report resurrected callers when all incoming identities are retained', async () => {
  const f = await fixture(cases[0]);
  vi.spyOn(f.queries, 'hasManyIncomingEdges').mockReturnValue(false);
  fs.writeFileSync(path.join(f.root, f.provider),
    'int modified_target(void) { return 123456; }\n');

  const result = await f.orchestrator.sync(undefined, [f.provider]);

  expect(result.filesModified).toBe(1);
  expect(result.resurrectedReferenceSourceFiles).toBeUndefined();
  expect(f.queries.getMetadata(REWIRE_PENDING)).toBeNull();
  expect(f.references()).toEqual([]);
  expect(f.queries.getIncomingCrossFileEdges(f.provider).filter(edge => edge.edgeKind === 'calls')).toHaveLength(3);
  expect(f.callers.map(file => f.graph.getFile(file))).toEqual(f.callerRecords);
});

it('does not publish replacement effects when the worker transaction rolls back', async () => {
  const f = await fixture(cases[0]);
  const oldFile = f.graph.getFile(f.provider);
  const oldIncoming = f.queries.getIncomingCrossFileEdges(f.provider);
  const store = replacementStore(f);
  vi.spyOn(f.queries, 'hasManyIncomingEdges').mockReturnValue(true);
  // File upsert runs after rewireEdges. The trigger verifies that the worker
  // already inserted all pending refs before aborting its transaction.
  f.db.exec(`CREATE TRIGGER fail_modified_reference_store BEFORE INSERT ON files
    WHEN NEW.path = 'provider.c' BEGIN
      SELECT CASE WHEN (
        SELECT COUNT(*) FROM unresolved_refs
        WHERE reference_name = 'modified_target' AND status = 'pending'
      ) = 3 AND EXISTS (
        SELECT 1 FROM project_metadata WHERE key = '${REWIRE_PENDING}'
      ) THEN RAISE(ABORT, 'injected failure after replacement rewiring')
      ELSE RAISE(ABORT, 'injected failure before replacement rewiring') END;
    END`);
  fs.writeFileSync(path.join(f.root, f.provider), cases[0].changed);

  await expect(f.orchestrator.sync(undefined, [f.provider], undefined, store.replace))
    .rejects.toThrow('injected failure after replacement rewiring');

  expect(store.replace).toHaveBeenCalledTimes(1);
  expect(store.committed).toEqual([]);
  expect(f.references()).toEqual([]);
  expect(f.queries.getMetadata(REWIRE_PENDING)).toBeNull();
  expect(f.graph.getFile(f.provider)).toEqual(oldFile);
  expect(f.queries.getIncomingCrossFileEdges(f.provider)).toEqual(oldIncoming);
  expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

  f.db.exec('DROP TRIGGER fail_modified_reference_store');
  fs.writeFileSync(path.join(f.root, f.provider), cases[0].original);
  const unchanged = await f.orchestrator.sync(undefined, [f.provider], undefined, store.replace);
  expect(unchanged.filesModified).toBe(0);
  expect(unchanged.changedFilePaths).toBeUndefined();
  expect(unchanged.resurrectedReferenceSourceFiles).toBeUndefined();
  expect(f.queries.getMetadata(REWIRE_PENDING)).toBeNull();
  expect(store.replace).toHaveBeenCalledTimes(1);
});

describe('main-process indexFile fallback effects', () => {
  it.each(cases)('returns resurrected callers only after storing $label', async example => {
    const f = await fixture(example);
    fs.writeFileSync(path.join(f.root, f.provider), example.changed);

    const result = await f.orchestrator.indexFile(f.provider, { force: true });

    expect(result.stored).toBe(true);
    expect(result.resurrectedReferenceSourceFiles?.slice().sort()).toEqual(f.callers);
    expectPendingCallers(f);
  });

  it('does not publish effects when a fallback parse produces no storable result', async () => {
    const f = await fixture(cases[0]);
    const oldFile = f.graph.getFile(f.provider);
    const oldIncoming = f.queries.getIncomingCrossFileEdges(f.provider);
    fs.writeFileSync(path.join(f.root, f.provider), cases[0].changed);
    vi.spyOn(treeSitter, 'extractFromSource').mockReturnValueOnce({
      nodes: [], edges: [], unresolvedReferences: [], durationMs: 0,
      errors: [{ severity: 'error', code: 'parse_error', message: 'injected fallback parse failure' }],
    });

    const result = await f.orchestrator.indexFile(f.provider, { force: true });

    expect(result.stored).toBe(false);
    expect(result.resurrectedReferenceSourceFiles).toBeUndefined();
    expect(f.references()).toEqual([]);
    expect(f.queries.getMetadata(REWIRE_PENDING)).toBeNull();
    expect(f.graph.getFile(f.provider)).toEqual(oldFile);
    expect(f.queries.getIncomingCrossFileEdges(f.provider)).toEqual(oldIncoming);
  });
});

it('drains caller references created by a late, real indexFile fallback before full synthesis', async () => {
  const f = await fixture(cases[0]);
  const resolver = (f.graph as any).resolver;
  fs.writeFileSync(path.join(f.root, f.provider), cases[0].changed);
  // Model the legacy rewiring decision only. The excluded provider is really
  // parsed/stored by indexFile, and both scoped drains and full synthesis run.
  vi.spyOn(f.orchestrator, 'sync').mockResolvedValueOnce({
    complete: true, filesChecked: 1, filesAdded: 0, filesModified: 0,
    filesRemoved: 0, nodesUpdated: 0, durationMs: 0,
    failedRewireSourceFiles: [f.provider],
  });
  const fallback = vi.spyOn(f.orchestrator, 'indexFile');
  const scopes: string[][] = [];
  let lateCallersDrained = false;
  const originalScoped = resolver.resolveFilesAndPersist.bind(resolver);
  vi.spyOn(resolver, 'resolveFilesAndPersist').mockImplementation(async (...args: any[]) => {
    const files = args[0] as string[];
    scopes.push([...files]);
    if (files.includes(f.callers[0]!)) expectPendingCallers(f);
    const result = await originalScoped(...args);
    if (files.includes(f.callers[0]!)) {
      lateCallersDrained = true;
      expect(f.graph.getPendingReferenceCount()).toBe(0);
      expect(f.queries.getMetadata(REWIRE_PENDING)).not.toBeNull();
    }
    return result;
  });
  const originalFull = f.graph.resolveReferencesBatched.bind(f.graph);
  const full = vi.spyOn(f.graph, 'resolveReferencesBatched').mockImplementation(async (...args) => {
    expect(lateCallersDrained).toBe(true);
    expect(f.graph.getPendingReferenceCount()).toBe(0);
    expect(f.queries.getMetadata(REWIRE_PENDING)).not.toBeNull();
    return originalFull(...args);
  });

  const result = await f.graph.sync({ paths: [f.callers[0]!] });

  expect(result).toMatchObject({ complete: true, filesModified: 1, changedFilePaths: [f.provider] });
  expect(fallback).toHaveBeenCalledTimes(1);
  expect(fallback).toHaveBeenCalledWith(f.provider, { force: true });
  expect(scopes).toHaveLength(2);
  expect(scopes[0]).toEqual([f.provider]);
  expect(scopes[1]?.slice().sort()).toEqual(f.callers);
  expect(full).toHaveBeenCalledTimes(1);
  expect(f.graph.getNodesByName('modified_target')).toEqual([]);
  expect(f.graph.getNodesByName('renamed_target')).toHaveLength(1);
  expect(f.references()).toEqual([
    { file_path: f.callers[0], reference_name: 'modified_target', reference_kind: 'calls', status: 'failed' },
    { file_path: f.callers[0], reference_name: 'modified_target', reference_kind: 'calls', status: 'failed' },
    { file_path: f.callers[1], reference_name: 'modified_target', reference_kind: 'calls', status: 'failed' },
  ]);
  expect(f.queries.getMetadata(REWIRE_PENDING)).toBeNull();
  expect(f.callers.map(file => f.graph.getFile(file))).toEqual(f.callerRecords);
  expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

it('keeps the old main-process graph intact if the dirty-marker write fails', async () => {
  const f = await fixture(cases[0]);
  const oldFile = f.graph.getFile(f.provider);
  const oldIncoming = f.queries.getIncomingCrossFileEdges(f.provider);
  f.db.exec(`CREATE TRIGGER reject_rewire_dirty BEFORE INSERT ON project_metadata
    WHEN NEW.key = '${REWIRE_PENDING}' BEGIN
      SELECT RAISE(ABORT, 'injected dirty-marker failure before delete');
    END`);
  fs.writeFileSync(path.join(f.root, f.provider), cases[0].changed);

  await expect(f.orchestrator.sync(undefined, [f.provider]))
    .rejects.toThrow('injected dirty-marker failure before delete');

  expect(f.references()).toEqual([]);
  expect(f.queries.getMetadata(REWIRE_PENDING)).toBeNull();
  expect(f.graph.getFile(f.provider)).toEqual(oldFile);
  expect(f.queries.getIncomingCrossFileEdges(f.provider)).toEqual(oldIncoming);
  expect(f.graph.getNodesByName('modified_target')).toHaveLength(1);
  expect(f.graph.getNodesByName('renamed_target')).toEqual([]);
  expect(f.callers.map(file => f.graph.getFile(file))).toEqual(f.callerRecords);
  expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

it.each(['before delete', 'after delete'] as const)(
  'preserves main-process recovery refs after a failure %s and recovers on reopen', async stage => {
    const f = await fixture(cases[0]);
    const oldFile = f.graph.getFile(f.provider);
    const oldIncoming = f.queries.getIncomingCrossFileEdges(f.provider);
    if (stage === 'before delete') {
      vi.spyOn(f.queries, 'deleteFile').mockImplementationOnce(() => {
        expectPendingCallers(f);
        throw new Error('injected main store failure before delete');
      });
    } else {
      // Node insertion follows file deletion. Abort only the insert batch;
      // the write-ahead refs and marker must survive on the main connection.
      f.db.exec(`CREATE TRIGGER fail_main_replacement_nodes BEFORE INSERT ON nodes
        WHEN NEW.name = 'renamed_target' BEGIN
          SELECT CASE WHEN EXISTS (
            SELECT 1 FROM project_metadata WHERE key = '${REWIRE_PENDING}'
          ) AND (SELECT COUNT(*) FROM unresolved_refs
            WHERE reference_name = 'modified_target' AND status = 'pending') = 3
          THEN RAISE(ABORT, 'injected main store failure after delete')
          ELSE RAISE(ABORT, 'missing write-ahead recovery evidence') END;
        END`);
    }
    fs.writeFileSync(path.join(f.root, f.provider), cases[0].changed);
    let published = false;

    await expect(f.orchestrator.sync(undefined, [f.provider]).then(result => {
      published = true;
      return result;
    })).rejects.toThrow(`injected main store failure ${stage}`);

    expect(published).toBe(false);
    expectPendingCallers(f);
    expect(f.graph.getIndexCompleteness().status).toBe('incomplete');
    if (stage === 'before delete') {
      expect(f.graph.getFile(f.provider)).toEqual(oldFile);
      expect(f.queries.getIncomingCrossFileEdges(f.provider)).toEqual(oldIncoming);
    } else {
      expect(f.graph.getFile(f.provider)).toBeNull();
      expect(f.queries.getIncomingCrossFileEdges(f.provider)).toEqual([]);
      f.db.exec('DROP TRIGGER fail_main_replacement_nodes');
    }
    vi.restoreAllMocks();
    f.graph.close();
    graphs.splice(graphs.indexOf(f.graph), 1);
    const reopened = CodeGraph.openSync(f.root);
    graphs.push(reopened);
    const reopenedQueries = (reopened as any).queries as QueryBuilder;
    const reopenedDb = (reopened as any).db.getDb();
    expect(reopenedQueries.getMetadata(REWIRE_PENDING)).not.toBeNull();
    expect(reopened.getPendingReferenceCount()).toBeGreaterThan(0);
    const full = vi.spyOn(reopened, 'resolveReferencesBatched');

    const recovered = await reopened.sync({ paths: [f.provider] });

    expect(recovered.complete).toBe(true);
    expect(full).toHaveBeenCalledTimes(1);
    expect(reopenedQueries.getMetadata(REWIRE_PENDING)).toBeNull();
    expect(reopened.getPendingReferenceCount()).toBe(0);
    expect(reopened.getNodesByName('modified_target')).toEqual([]);
    expect(reopened.getNodesByName('renamed_target')).toHaveLength(1);
    expect(reopenedDb.prepare(`SELECT file_path, status FROM unresolved_refs
      WHERE reference_name = 'modified_target' ORDER BY file_path, from_node_id`).all()).toEqual(
      [f.callers[0], f.callers[0], f.callers[1]].map(file => ({ file_path: file, status: 'failed' })),
    );
    expect(f.callers.map(file => reopened.getFile(file))).toEqual(f.callerRecords);
    expect(reopenedDb.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  },
);
