import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
import type { QueryBuilder } from '../src/db/queries';
import type { DatabaseConnection } from '../src/db';
import { WalCheckpointValve, WalValveAbortError } from '../src/db/wal-valve';
import type { ExtractionOrchestrator } from '../src/extraction';
import type { ReferenceResolver } from '../src/resolution';
import type { ResolutionContext } from '../src/resolution/types';

const roots: string[] = [];
const graphs: CodeGraph[] = [];
beforeEach(() => {
  vi.stubEnv('CODEGRAPH_NO_APPEND_DELTA', '1');
  vi.stubEnv('CODEGRAPH_NO_WAL_DEFER', '1');
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const graph of graphs.splice(0)) graph.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

type CallEdge = {
  source: string;
  target: string;
  target_name: string;
  target_kind: string;
  target_file: string;
  metadata: string;
};

async function fixture(threeLevels = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fallback-resolver-epoch-'));
  roots.push(root);
  const files: Record<string, string> = {
    'core/base.hpp': threeLevels
      ? '#include "root.hpp"\nstruct Base : Root {};\n'
      : 'struct Base { int target() { return 1; } };\n',
    'core/derived.cpp': '#include "base.hpp"\nstruct Derived : Base { int call() { return target(); } };\n',
    'unrelated/noise.cpp': 'int target() { return 99; }\n',
  };
  if (threeLevels) files['core/root.hpp'] = 'struct Root { int target() { return 1; } };\n';
  for (const [file, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), contents);
  }
  const graph = CodeGraph.initSync(root);
  graphs.push(graph);
  expect(await graph.indexAll()).toMatchObject({ success: true, complete: true });
  const internal = graph as unknown as {
    queries: QueryBuilder;
    db: DatabaseConnection;
    resolver: ReferenceResolver;
    orchestrator: ExtractionOrchestrator;
  };
  const { queries, resolver, orchestrator } = internal;
  const connection = internal.db;
  const db = connection.getDb();
  const context = (resolver as unknown as { context: ResolutionContext }).context;
  const callNode = () => queries.getNodesByName('call').find(n => n.qualifiedName === 'Derived::call')!;
  const calls = () => db.prepare(`
    SELECT e.source, e.target, e.metadata, t.qualified_name AS target_name,
      t.kind AS target_kind, t.file_path AS target_file
    FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
    WHERE s.qualified_name = 'Derived::call' AND e.kind = 'calls'
    ORDER BY e.target
  `).all() as CallEdge[];
  const initialCalls = calls();
  expect(initialCalls).toHaveLength(1);
  expect(initialCalls[0]).toMatchObject({
    target_name: threeLevels ? 'Root::target' : 'Base::target',
    target_kind: 'method',
    target_file: threeLevels ? 'core/root.hpp' : 'core/base.hpp',
  });
  // A previous scoped resolution pass may warm both caches before the late,
  // node-writing co-importer fallback. Use real QueryBuilder-backed lookups.
  context.getNodesInFile('core/derived.cpp');
  expect(context.getSupertypes!('Derived', 'cpp')).toEqual(['Base']);
  if (threeLevels) expect(context.getSupertypes!('Base', 'cpp')).toEqual(['Root']);
  const forceFallback = (filePaths: string[]) => {
    // Model only the legacy rewiring decision. Parsing, indexFile replacement,
    // SQLite references/edges, CodeGraph.sync and its synthesis tail are real.
    vi.spyOn(orchestrator, 'sync').mockResolvedValueOnce({
      complete: true, filesChecked: 1, filesAdded: 0, filesModified: 0,
      filesRemoved: 0, nodesUpdated: 0, durationMs: 0,
      failedRewireSourceFiles: filePaths,
    });
  };
  const change = (file: string) => fs.writeFileSync(path.join(root, file),
    '// Added line changes declaration node IDs.\n' + files[file]);
  return { root, graph, queries, resolver, orchestrator, connection, db, context,
    callNode, calls, initialCalls, forceFallback, change };
}

function expectOriginalTarget(f: Awaited<ReturnType<typeof fixture>>) {
  expect(f.calls()).toEqual([expect.objectContaining({
    target: f.initialCalls[0]!.target,
    target_name: f.initialCalls[0]!.target_name,
    target_kind: 'method',
    target_file: f.initialCalls[0]!.target_file,
  })]);
  expect(JSON.parse(f.calls()[0]!.metadata)).toMatchObject({ refName: 'target' });
  expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  expect(f.graph.getPendingReferenceCount()).toBe(0);
}

describe('late fallback resolver cache epoch', () => {
  it('resolves with the replaced caller ID rather than a cached pre-fallback owner', async () => {
    const f = await fixture();
    const oldCaller = f.callNode();
    f.change('core/derived.cpp');
    f.forceFallback(['core/derived.cpp']);
    const fallback = vi.spyOn(f.orchestrator, 'indexFile');

    await expect(f.graph.sync({ paths: ['unrelated/noise.cpp'] }))
      .resolves.toMatchObject({ complete: true, filesModified: 1 });

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledWith('core/derived.cpp', { force: true });
    expect(f.callNode().id).not.toBe(oldCaller.id);
    expectOriginalTarget(f);
  });

  it('refreshes intermediate-supertype IDs while the unchanged caller retains its ID', async () => {
    const f = await fixture(true);
    const oldCaller = f.callNode();
    const oldDerived = f.queries.getNodesByName('Derived')[0]!;
    const oldBase = f.queries.getNodesByName('Base')[0]!;
    f.change('core/base.hpp');
    // The second fallback really reparses the unchanged caller. Only the
    // intermediate Base header changes on disk; Derived and call keep IDs.
    f.forceFallback(['core/base.hpp', 'core/derived.cpp']);
    const fallback = vi.spyOn(f.orchestrator, 'indexFile');

    await expect(f.graph.sync({ paths: ['unrelated/noise.cpp'] }))
      .resolves.toMatchObject({ complete: true, filesModified: 2 });

    expect(fallback.mock.calls).toEqual([
      ['core/base.hpp', { force: true }], ['core/derived.cpp', { force: true }],
    ]);
    expect(f.callNode().id).toBe(oldCaller.id);
    expect(f.queries.getNodesByName('Derived')[0]!.id).toBe(oldDerived.id);
    expect(f.queries.getNodesByName('Base')[0]!.id).not.toBe(oldBase.id);
    expectOriginalTarget(f);
  });

  it('drops replaced-node caches on a fallback write-gate abort and preserves durable retry work', async () => {
    const f = await fixture();
    vi.stubEnv('CODEGRAPH_NO_WAL_DEFER', '0');
    expect(f.connection.getBackend()).toBe('node-sqlite');
    const oldCaller = f.callNode();
    const oldAutocheckpoint = f.connection.getWalAutocheckpoint();
    f.change('core/derived.cpp');
    f.forceFallback(['core/derived.cpp']);
    const fallback = vi.spyOn(f.orchestrator, 'indexFile');
    const gate = vi.spyOn(WalCheckpointValve.prototype, 'backpressure')
      .mockRejectedValueOnce(new WalValveAbortError('injected fallback checkpoint failure', 3, 2));

    await expect(f.graph.sync({ paths: ['unrelated/noise.cpp'] }))
      .rejects.toMatchObject({ code: 'WAL_VALVE_ABORT' });

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledWith('core/derived.cpp', { force: true });
    const newCaller = f.callNode();
    expect(newCaller.id).not.toBe(oldCaller.id);
    expect(f.connection.getWalAutocheckpoint()).toBe(oldAutocheckpoint);
    const journal = () => f.queries.getMetadataByPrefix('sync-retry:pending:');
    expect(journal().map(entry => entry.key)).toContain('sync-retry:pending:core/derived.cpp');
    expect(f.graph.getPendingReferenceCount()).toBeGreaterThan(0);
    // A failed checkpoint occurs after the replacement committed. A caller
    // inspecting this still-open graph must not get the old owner ID.
    expect.soft(f.context.getNodesInFile('core/derived.cpp').map(node => node.id))
      .toContain(newCaller.id);
    expect.soft(f.context.getNodesInFile('core/derived.cpp').map(node => node.id))
      .not.toContain(oldCaller.id);

    gate.mockRestore();
    await expect(f.graph.sync()).resolves.toMatchObject({ complete: true });
    expect(journal()).toEqual([]);
    expectOriginalTarget(f);
  });

  it('adds no cache invalidation to a healthy no-fallback no-op', async () => {
    const f = await fixture(true);
    const clear = vi.spyOn(f.resolver, 'clearCaches');
    const fallback = vi.spyOn(f.orchestrator, 'indexFile');

    await expect(f.graph.sync({ paths: ['unrelated/noise.cpp'] }))
      .resolves.toMatchObject({ complete: true, filesModified: 0, filesAdded: 0, filesRemoved: 0 });

    expect(fallback).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expectOriginalTarget(f);
  });
});
