import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { DatabaseConnection } from '../src/db';
import { WalCheckpointValve, WalValveAbortError } from '../src/db/wal-valve';
import { REWIRE_RECOVERY_PREFIX } from '../src/extraction/sync-retry-state';
import { AppendDeltaState } from '../src/extraction/append-delta';
import type { QueryBuilder } from '../src/db/queries';
import type { ExtractionOrchestrator } from '../src/extraction';

const roots: string[] = [];
const graphs: CodeGraph[] = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const graph of graphs.splice(0)) { try { graph.close(); } catch {} }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function internals(graph: CodeGraph) {
  return graph as unknown as { db: DatabaseConnection; queries: QueryBuilder; orchestrator: ExtractionOrchestrator };
}
function calls(graph: CodeGraph) {
  return internals(graph).db.getDb().prepare(`
    SELECT source.name AS caller,target.name AS callee,target.signature
    FROM edges JOIN nodes source ON source.id=edges.source
    JOIN nodes target ON target.id=edges.target WHERE edges.kind='calls'
    ORDER BY source.name,target.name`).all();
}
function pending(graph: CodeGraph) {
  return internals(graph).queries.getMetadataByPrefix(REWIRE_RECOVERY_PREFIX);
}
function close(graph: CodeGraph) {
  graph.close();
  graphs.splice(graphs.indexOf(graph), 1);
}
async function fixture(Graph = CodeGraph, appendDelta = false) {
  vi.stubEnv('CODEGRAPH_NO_APPEND_DELTA', appendDelta ? '' : '1');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rewire-wal-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'provider.c'), 'int target(void) { return 1; }\n');
  fs.writeFileSync(path.join(root, 'caller.c'), 'int caller(void) { return target(); }\n');
  const graph = Graph.initSync(root); graphs.push(graph);
  expect((await graph.indexAll()).success).toBe(true);
  expect(calls(graph)).toEqual([{ caller: 'caller', callee: 'target', signature: 'int target(void)' }]);
  return { root, graph };
}
function reopen(root: string, Graph = CodeGraph) {
  const graph = Graph.openSync(root); graphs.push(graph);
  return graph;
}
function unstamped(graph: CodeGraph) {
  internals(graph).db.getDb().exec("UPDATE edges SET metadata=NULL WHERE kind='calls'");
}
function change(root: string) {
  fs.writeFileSync(path.join(root, 'provider.c'), 'long target(void) { return 2; }\n');
}
function abortOnce(Valve = WalCheckpointValve) {
  return vi.spyOn(Valve.prototype, 'backpressure').mockRejectedValueOnce(
    new WalValveAbortError('injected after-write failure', 3, 2));
}

describe('WAL interruption preserves caller source recovery', () => {
  it.each([false, true])('restores the real call edge after reopening (legacy edge=%s)', async legacy => {
    const { root, graph } = await fixture();
    if (legacy) unstamped(graph);
    change(root);
    const gate = abortOnce();
    await expect(graph.sync()).rejects.toMatchObject({ code: 'WAL_VALVE_ABORT' });
    gate.mockRestore();
    expect(calls(graph)).toEqual([]);
    expect(pending(graph)).toHaveLength(legacy ? 1 : 0);
    close(graph);
    const retry = reopen(root);
    vi.stubEnv('CODEGRAPH_NO_WAL_DEFER', '1');
    await expect(retry.sync()).resolves.toMatchObject({ complete: true });
    expect(calls(retry)).toEqual([{ caller: 'caller', callee: 'target', signature: 'long target(void)' }]);
    expect(pending(retry)).toEqual([]);
    expect(internals(retry).db.getDb().prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('keeps caller recovery through a second abort after its re-extraction commits', async () => {
    const { root, graph } = await fixture();
    unstamped(graph); change(root);
    let gate = abortOnce();
    await expect(graph.sync()).rejects.toMatchObject({ code: 'WAL_VALVE_ABORT' });
    gate.mockRestore(); close(graph);
    const retry = reopen(root);
    gate = abortOnce();
    await expect(retry.sync()).rejects.toMatchObject({ code: 'WAL_VALVE_ABORT' });
    gate.mockRestore();
    expect(pending(retry)).toHaveLength(1);
    close(retry);
    const final = reopen(root);
    await expect(final.sync()).resolves.toMatchObject({ complete: true });
    expect(calls(final)).toEqual([{ caller: 'caller', callee: 'target', signature: 'long target(void)' }]);
    expect(pending(final)).toEqual([]);
  });

  it('recovers an unstamped deleted target reference so a later re-add restores the call', async () => {
    const { root, graph } = await fixture();
    unstamped(graph);
    fs.unlinkSync(path.join(root, 'provider.c'));
    const gate = abortOnce();
    await expect(graph.sync()).rejects.toMatchObject({ code: 'WAL_VALVE_ABORT' });
    gate.mockRestore();
    expect(pending(graph)).toHaveLength(1);
    close(graph);
    const retry = reopen(root);
    await expect(retry.sync()).resolves.toMatchObject({ complete: true });
    expect(pending(retry)).toEqual([]);
    expect(internals(retry).db.getDb().prepare(
      "SELECT reference_name,status FROM unresolved_refs WHERE file_path='caller.c'").all())
      .toEqual([{ reference_name: 'target', status: 'failed' }]);
    change(root);
    await retry.sync();
    expect(calls(retry)).toEqual([{ caller: 'caller', callee: 'target', signature: 'long target(void)' }]);
  });

  it('retires a recovery task when reconciliation confirms the caller was deleted', async () => {
    const { root, graph } = await fixture();
    unstamped(graph); change(root);
    const gate = abortOnce();
    await expect(graph.sync()).rejects.toMatchObject({ code: 'WAL_VALVE_ABORT' });
    gate.mockRestore(); close(graph);
    fs.unlinkSync(path.join(root, 'caller.c'));
    const retry = reopen(root);
    await expect(retry.sync()).resolves.toMatchObject({ complete: true });
    expect(pending(retry)).toEqual([]);
    expect(internals(retry).queries.getFileByPath('caller.c')).toBeNull();
  });

  it('reparses a present caller with no DB row even when a scoped sync omits it', async () => {
    const { root, graph } = await fixture();
    unstamped(graph); change(root);
    const gate = abortOnce();
    await expect(graph.sync()).rejects.toMatchObject({ code: 'WAL_VALVE_ABORT' });
    gate.mockRestore();
    // Simulate a second interruption after deleting a caller's previous graph
    // but before its replacement file record was committed.
    internals(graph).queries.deleteFile('caller.c');
    expect(pending(graph)).toHaveLength(1);
    close(graph);
    const retry = reopen(root);
    await expect(retry.sync({ paths: ['provider.c'] })).resolves.toMatchObject({ complete: true });
    expect(calls(retry)).toEqual([{ caller: 'caller', callee: 'target', signature: 'long target(void)' }]);
    expect(pending(retry)).toEqual([]);
  });

  it('recovers a pending legacy caller while append-delta remains enabled', async () => {
    const { root, graph } = await fixture(CodeGraph, true);
    unstamped(graph);
    // A deletion leaves only the durable caller task, without a file-store
    // retry journal that would independently turn append-delta off.
    fs.unlinkSync(path.join(root, 'provider.c'));
    const gate = abortOnce();
    await expect(graph.sync()).rejects.toMatchObject({ code: 'WAL_VALVE_ABORT' });
    gate.mockRestore(); close(graph);
    fs.appendFileSync(path.join(root, 'caller.c'), '\nstatic int added(void) { return 3; }\n');
    const delta = vi.spyOn(AppendDeltaState.prototype, 'tryStore');
    const retry = reopen(root);
    await expect(retry.sync()).resolves.toMatchObject({ complete: true });
    expect(delta).toHaveBeenCalled();
    expect(delta.mock.results.some(result => result.type === 'return' && result.value === true)).toBe(true);
    expect(internals(retry).db.getDb().prepare(
      "SELECT reference_name,status FROM unresolved_refs WHERE file_path='caller.c'").all())
      .toEqual([{ reference_name: 'target', status: 'failed' }]);
    expect(internals(retry).queries.getNodesByName('added')).toHaveLength(1);
    expect(pending(retry)).toEqual([]);
    change(root);
    await retry.sync();
    expect(calls(retry)).toEqual([{ caller: 'caller', callee: 'target', signature: 'long target(void)' }]);
  });

  it('retains a missing-row caller task when its source is temporarily unreadable', async () => {
    const { root, graph } = await fixture();
    unstamped(graph); change(root);
    const gate = abortOnce();
    await expect(graph.sync()).rejects.toMatchObject({ code: 'WAL_VALVE_ABORT' });
    gate.mockRestore();
    internals(graph).queries.deleteFile('caller.c');
    close(graph);
    const retry = reopen(root);
    // Inject the extractor's real read-failure contract at its call boundary;
    // spying on a default fs/promises object does not replace the namespace
    // binding imported by the source runtime under Vitest.
    const inaccessible = vi.spyOn(internals(retry).orchestrator, 'indexFile').mockResolvedValueOnce({
      nodes: [], edges: [], unresolvedReferences: [], durationMs: 0, stored: false,
      errors: [{ filePath: 'caller.c', code: 'read_error', severity: 'error',
        message: 'Failed to read file: EACCES temporary permission failure' }],
    });
    await expect(retry.sync({ paths: ['provider.c'] })).rejects.toMatchObject({ name: 'SyncIncompleteError' });
    expect(inaccessible).toHaveBeenCalledWith('caller.c', { force: true });
    inaccessible.mockRestore();
    expect(pending(retry)).toHaveLength(1);
    await expect(retry.sync({ paths: ['provider.c'] })).resolves.toMatchObject({ complete: true });
    expect(calls(retry)).toEqual([{ caller: 'caller', callee: 'target', signature: 'long target(void)' }]);
    expect(pending(retry)).toEqual([]);
  });

  it('rolls the recovery marker back with a failed target deletion transaction', async () => {
    const { root, graph } = await fixture();
    unstamped(graph); change(root);
    const queries = internals(graph).queries;
    const original = queries.deleteNodesByFile.bind(queries);
    const fail = vi.spyOn(queries, 'deleteNodesByFile').mockImplementationOnce(file => {
      original(file);
      throw new Error('injected deletion failure');
    });
    await expect(graph.sync()).rejects.toThrow('injected deletion failure');
    fail.mockRestore();
    expect(pending(graph)).toEqual([]);
    expect(calls(graph)).toEqual([{ caller: 'caller', callee: 'target', signature: 'int target(void)' }]);
  });
});

// npm run build first: this exercises the shipped worker and its own connection.
describe('built store-worker caller recovery', () => {
  it.each(['replace', 'delete'])('journals %s atomically before its worker acknowledgement', async operation => {
    const Graph = require('../dist/index').default as typeof CodeGraph;
    const Valve = require('../dist/db/wal-valve').WalCheckpointValve as typeof WalCheckpointValve;
    const { StoreWriter } = require('../dist/extraction/store-writer');
    const { root, graph } = await fixture(Graph);
    unstamped(graph);
    vi.spyOn(internals(graph).queries, 'hasManyIncomingEdges').mockReturnValue(true);
    const writer = vi.spyOn(StoreWriter.prototype, 'replace');
    if (operation === 'delete') fs.unlinkSync(path.join(root, 'provider.c'));
    else change(root);
    const gate = abortOnce(Valve);
    await expect(graph.sync()).rejects.toMatchObject({ code: 'WAL_VALVE_ABORT' });
    gate.mockRestore();
    expect(writer).toHaveBeenCalledOnce();
    expect(pending(graph)).toHaveLength(1);
    close(graph);
    const retry = reopen(root, Graph);
    await expect(retry.sync()).resolves.toMatchObject({ complete: true });
    expect(pending(retry)).toEqual([]);
    if (operation === 'delete') { change(root); await retry.sync(); }
    expect(calls(retry)).toEqual([{ caller: 'caller', callee: 'target', signature: 'long target(void)' }]);
  }, 30000);
});
