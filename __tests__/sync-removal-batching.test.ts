import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import CodeGraph from '../src/index';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { WalCheckpointValve, WalValveAbortError } from '../src/db/wal-valve';
import type { ExtractionOrchestrator, IndexProgress } from '../src/extraction';
import { REMOVAL_BATCH_LIMITS, addRemovalCost, canBatchRemovals, fitsRemovalBatch,
  removalWalThreshold, type RemovalBatchOptions } from '../src/extraction/removal-batch';

const roots: string[] = [];
const graphs: CodeGraph[] = [];
const connections: DatabaseConnection[] = [];
const cap = 16 * 1024 * 1024;
const batchOptions = (getWalSizeBytes = () => 0): RemovalBatchOptions => ({ hardCapBytes: cap, getWalSizeBytes });
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const graph of graphs.splice(0)) { try { graph.close(); } catch {} }
  for (const db of connections.splice(0)) { try { db.close(); } catch {} }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function tempRoot() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-delete-batch-')); roots.push(root); return root; }
function internals(graph: CodeGraph) {
  return graph as unknown as { db: DatabaseConnection; queries: QueryBuilder; orchestrator: ExtractionOrchestrator };
}
function close(graph: CodeGraph) { graph.close(); graphs.splice(graphs.indexOf(graph), 1); }
function reopen(root: string) { const graph = CodeGraph.openSync(root); graphs.push(graph); return graph; }
const target = (i: number) => `targets/target_${String(i).padStart(3, '0')}.h`;
const source = (i: number) => `#pragma once\nstatic inline int target_${i}(int x) { return x+${i}; }\n`;
const caller = (n: number, name: string) => Array.from({ length: n }, (_, i) => `#include "${target(i)}"`).join('\n') +
  `\nint ${name}(int x) { return ` + Array.from({ length: n }, (_, i) => `target_${i}(x)`).join('+') + '; }\n';
async function fixture(n = 4, withCalls = false) {
  const root = tempRoot(); fs.mkdirSync(path.join(root, 'targets'));
  for (let i = 0; i < n; i++) fs.writeFileSync(path.join(root, target(i)), source(i));
  if (withCalls) {
    fs.writeFileSync(path.join(root, 'keep.c'), caller(n, 'keep'));
    fs.writeFileSync(path.join(root, 'z_later.c'), caller(1, 'later'));
  }
  const graph = CodeGraph.initSync(root); graphs.push(graph);
  expect((await graph.indexAll()).success).toBe(true);
  return { root, graph, ...internals(graph) };
}
function callCount(graph: CodeGraph): number {
  return (internals(graph).db.getDb().prepare(`SELECT COUNT(*) AS n FROM edges e
    JOIN nodes t ON t.id=e.target WHERE e.kind='calls' AND t.file_path LIKE 'targets/%'`).get() as { n: number }).n;
}
function journal(graph: CodeGraph) { return internals(graph).queries.getMetadataByPrefix('sync-retry:rewire:'); }
function removeTargets(root: string, n: number) { for (let i = 0; i < n; i++) fs.unlinkSync(path.join(root, target(i))); }
function abortOnce() { return vi.spyOn(WalCheckpointValve.prototype, 'backpressure').mockRejectedValueOnce(
  new WalValveAbortError('injected committed deletion interruption', cap + 1, cap)); }

describe('removal admission budgets', () => {
  it('uses aggregate work and the actual valve boundary, with small-cap/old-call fallbacks', () => {
    const cost = { nodes: 65, workRows: 260, payloadBytes: 66000 };
    expect(fitsRemovalBatch(cost)).toBe(true);
    expect(fitsRemovalBatch(addRemovalCost(cost, cost))).toBe(false);
    expect(canBatchRemovals(undefined, true, 10)).toBe(false);
    expect(canBatchRemovals(batchOptions(), false, 10)).toBe(false);
    expect(canBatchRemovals(batchOptions(), true, 1)).toBe(false);
    expect(canBatchRemovals({ ...batchOptions(), hardCapBytes: cap - 1 }, true, 10)).toBe(false);
    expect(removalWalThreshold(batchOptions())).toBe(12 * 1024 * 1024);
    const db = { getWalSizeBytes: () => 0 } as DatabaseConnection;
    expect(new WalCheckpointValve(db, 9).hardCapBytes).toBe(18 * 1024 * 1024);
  });

  it('rejects large less-common row fields and both old and newly planned caller journal payloads', () => {
    const db = DatabaseConnection.initialize(path.join(tempRoot(), 'cost.db')); connections.push(db);
    const raw = db.getDb(), queries = new QueryBuilder(raw);
    raw.exec(`INSERT INTO files(path,content_hash,language,size,modified_at,indexed_at) VALUES ('target.c','hash','c',1,1,1);
      INSERT INTO nodes(id,kind,name,qualified_name,file_path,language,start_line,end_line,start_column,end_column,updated_at)
        VALUES ('target','function','target','target','target.c','c',1,1,0,1,1),
        ('caller','function','caller','caller','caller.c','c',1,1,0,1,1);
      INSERT INTO edges(source,target,kind,line,col) VALUES ('caller','target','calls',1,0);
      INSERT INTO unresolved_refs(from_node_id,reference_name,reference_kind,line,col,file_path,language)
        VALUES ('target','missing','calls',1,0,'target.c','c');`);
    const cost = (file = 'target.c') => queries.getRemovalCost(file, 128, 512);
    expect(fitsRemovalBatch(cost())).toBe(true);
    const large = 'x'.repeat(REMOVAL_BATCH_LIMITS.payloadBytes + 1);
    for (const column of ['decorators', 'type_parameters', 'return_type', 'visibility', 'docstring', 'signature']) {
      raw.prepare(`UPDATE nodes SET ${column}=? WHERE id='target'`).run(large);
      expect(fitsRemovalBatch(cost()), column).toBe(false);
      raw.exec(`UPDATE nodes SET ${column}=NULL WHERE id='target'`);
    }
    for (const [table, column, where] of [
      ['files', 'errors', "path='target.c'"], ['edges', 'provenance', "source='caller'"],
      ['edges', 'metadata', "source='caller'"], ['unresolved_refs', 'candidates', "from_node_id='target'"],
      ['unresolved_refs', 'name_tail', "from_node_id='target'"],
    ]) {
      raw.prepare(`UPDATE ${table} SET ${column}=? WHERE ${where}`).run(large);
      expect(fitsRemovalBatch(cost()), `${table}.${column}`).toBe(false);
      raw.prepare(`UPDATE ${table} SET ${column}=? WHERE ${where}`).run('');
    }
    raw.prepare("UPDATE nodes SET file_path=? WHERE id='target'").run(large);
    expect(fitsRemovalBatch(cost(large))).toBe(false);
    raw.exec("UPDATE nodes SET file_path='target.c' WHERE id='target'");
    for (const key of ['sync-retry:done:target.c', 'sync-retry:rewire:caller.c']) {
      queries.setMetadata(key, large); expect(fitsRemovalBatch(cost()), key).toBe(false);
      queries.applyMetadataChanges({ [key]: null });
    }
    raw.prepare("UPDATE nodes SET file_path=? WHERE id='caller'").run(large);
    expect(fitsRemovalBatch(cost()), 'new recovery key includes the caller path').toBe(false);
  });

  it('bounds row scans and rejects the cumulative row workload', () => {
    const db = DatabaseConnection.initialize(path.join(tempRoot(), 'rows.db')); connections.push(db);
    const raw = db.getDb(), queries = new QueryBuilder(raw);
    raw.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<150)
      INSERT INTO nodes(id,kind,name,qualified_name,file_path,language,start_line,end_line,start_column,end_column,updated_at)
      SELECT 'n'||x,'function','name','name','many.c','c',1,1,0,1,1 FROM n`);
    const cost = queries.getRemovalCost('many.c', 128, 512);
    expect(cost.nodes).toBe(129);
    expect(fitsRemovalBatch(cost)).toBe(false);
  });
});

describe('sync removal batching', () => {
  it.each(['noop', 'one', 'disabled', 'old-call'] as const)('does not probe costs for %s syncs', async mode => {
    const { root, orchestrator, queries } = await fixture(2);
    if (mode !== 'noop') removeTargets(root, mode === 'one' ? 1 : 2);
    const probe = vi.spyOn(queries, 'getRemovalCost');
    await orchestrator.sync(undefined, undefined, false, undefined,
      mode === 'disabled' ? undefined : () => null, undefined, undefined,
      mode === 'old-call' ? undefined : batchOptions());
    expect(probe).not.toHaveBeenCalled();
  });

  it('reports only committed batches and calls the gate outside the transaction', async () => {
    const { root, orchestrator, queries } = await fixture(20);
    removeTargets(root, 20);
    const progress: IndexProgress[] = [], boundaries: number[] = [], logs: string[] = [];
    let inTransaction = false, deleted = 0;
    const transaction = queries.runRemovalTransaction.bind(queries);
    vi.spyOn(queries, 'runRemovalTransaction').mockImplementation(operation => transaction(() => {
      inTransaction = true; try { operation(); } finally { inTransaction = false; }
    }));
    const original = queries.deleteFile.bind(queries);
    vi.spyOn(queries, 'deleteFile').mockImplementation((file, metadata) => {
      expect(progress.at(-1)?.current).toBe(boundaries.at(-1) ?? 0);
      original(file, metadata); deleted++;
    });
    vi.spyOn(performance, 'now').mockReturnValue(0);
    vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')); });
    const result = await orchestrator.sync(p => { if (p.phase === 'removing') progress.push(p); }, undefined, true,
      undefined, () => { expect(inTransaction).toBe(false); boundaries.push(deleted); return null; },
      undefined, undefined, batchOptions());
    expect(result.filesRemoved).toBe(20);
    expect(boundaries).toEqual([16, 20]);
    expect(progress.at(-1)).toMatchObject({ current: 20, total: 20, status: 'complete' });
    expect(logs.some(line => line.includes('removal-detail attempted=20 committed=20 mainThread=20'))).toBe(true);
    expect(logs.find(line => line.includes('removal-detail'))).toContain('batchMs=0ms');
  });

  it('commits early on visible WAL pressure, then keeps the original single-file boundary', async () => {
    const { root, orchestrator, queries } = await fixture(4); removeTargets(root, 4);
    let deleted = 0; const boundaries: number[] = [];
    const original = queries.deleteFile.bind(queries);
    vi.spyOn(queries, 'deleteFile').mockImplementation((file, metadata) => { original(file, metadata); deleted++; });
    const batches = vi.spyOn(queries, 'runRemovalTransaction');
    await orchestrator.sync(undefined, undefined, false, undefined,
      () => { boundaries.push(deleted); return null; }, undefined, undefined,
      batchOptions(() => deleted === 0 ? 0 : removalWalThreshold(batchOptions())));
    expect(boundaries).toEqual([1, 2, 3, 4]);
    expect(batches).toHaveBeenCalledOnce();
  });

  it('uses the time target only to decline the next file', async () => {
    const { root, orchestrator, queries } = await fixture(3); removeTargets(root, 3);
    let now = 0, deleted = 0; const boundaries: number[] = [];
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const original = queries.deleteFile.bind(queries);
    vi.spyOn(queries, 'deleteFile').mockImplementation((file, metadata) => { original(file, metadata); deleted++; now += 30; });
    await orchestrator.sync(undefined, undefined, false, undefined,
      () => { boundaries.push(deleted); return null; }, undefined, undefined, batchOptions());
    expect(boundaries).toEqual([1, 2, 3]);
    expect(queries.getAllFiles()).toEqual([]);
  });

  it('keeps a large-payload file out of batches and preserves the worker dispatch', async () => {
    const { root, db, orchestrator, queries } = await fixture(4); removeTargets(root, 4);
    db.getDb().prepare('UPDATE nodes SET decorators=? WHERE file_path=?').run('x'.repeat(140 * 1024), target(2));
    let inBatch = false; const workerFiles: string[] = [];
    const transaction = queries.runRemovalTransaction.bind(queries);
    vi.spyOn(queries, 'runRemovalTransaction').mockImplementation(operation => transaction(() => {
      inBatch = true; try { operation(); } finally { inBatch = false; }
    }));
    vi.spyOn(queries, 'hasManyIncomingEdges').mockImplementation(file => file === target(2));
    await orchestrator.sync(undefined, undefined, false, async request => {
      expect(inBatch).toBe(false); workerFiles.push(request.filePath);
      return orchestrator.storeParsedReplacement(request);
    }, () => null, undefined, undefined, batchOptions());
    expect(workerFiles).toEqual([target(2)]);
    expect(queries.getAllFiles()).toEqual([]);
  });

  it.each([false, true])('rolls back the whole batch and proof/journal with its third file (legacy=%s)', async legacy => {
    const { root, graph, db, queries } = await fixture(8, true);
    if (legacy) db.getDb().exec("UPDATE edges SET metadata=NULL WHERE kind='calls'");
    for (let i = 0; i < 8; i++) queries.setMetadata('sync-retry:done:' + target(i), 'non-reusable-proof-sentinel');
    removeTargets(root, 8); const progress: IndexProgress[] = [];
    const original = queries.deleteNodesByFile.bind(queries); let deleted = 0;
    const failure = vi.spyOn(queries, 'deleteNodesByFile').mockImplementation(file => {
      original(file); if (++deleted === 3) throw new Error('third-file rollback');
    });
    vi.spyOn(performance, 'now').mockReturnValue(0);
    await expect(graph.sync({ onProgress: p => { if (p.phase === 'removing') progress.push(p); } }))
      .rejects.toThrow('third-file rollback');
    failure.mockRestore(); vi.mocked(performance.now).mockRestore();
    expect(progress.at(-1)).toMatchObject({ current: 0, status: 'failed' });
    expect(callCount(graph)).toBe(9); expect(journal(graph)).toEqual([]);
    for (let i = 0; i < 8; i++) {
      expect(queries.getFileByPath(target(i))).not.toBeNull();
      expect(queries.getMetadata('sync-retry:done:' + target(i))).toBe('non-reusable-proof-sentinel');
    }
    close(graph); const retry = reopen(root); expect((await retry.sync()).complete).toBe(true);
    for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(root, target(i)), source(i));
    expect((await retry.sync()).complete).toBe(true); expect(callCount(retry)).toBe(9);
  });

  it.each([false, true])('recovers after two committed-batch aborts and a later caller reappears (legacy=%s)', async legacy => {
    const { root, graph, db, queries } = await fixture(20, true);
    if (legacy) db.getDb().exec("UPDATE edges SET metadata=NULL WHERE kind='calls'");
    removeTargets(root, 18); fs.unlinkSync(path.join(root, 'z_later.c'));
    let gate = abortOnce(); await expect(graph.sync()).rejects.toMatchObject({ code: 'WAL_VALVE_ABORT' }); gate.mockRestore();
    expect(queries.getFileByPath('z_later.c')).not.toBeNull();
    const firstToken = journal(graph).find(row => row.key.endsWith('keep.c'))?.value;
    if (legacy) expect(firstToken).toBeTruthy();
    close(graph); let retry = reopen(root); fs.writeFileSync(path.join(root, 'z_later.c'), caller(1, 'later'));
    gate = abortOnce(); await expect(retry.sync()).rejects.toMatchObject({ code: 'WAL_VALVE_ABORT' }); gate.mockRestore();
    if (legacy) {
      const nextToken = journal(retry).find(row => row.key.endsWith('keep.c'))?.value;
      expect(nextToken).toBeTruthy(); expect(nextToken).not.toBe(firstToken);
    }
    close(retry); retry = reopen(root); expect((await retry.sync()).complete).toBe(true);
    for (let i = 0; i < 18; i++) fs.writeFileSync(path.join(root, target(i)), source(i));
    expect((await retry.sync()).complete).toBe(true); expect(callCount(retry)).toBe(21);
    expect(journal(retry)).toEqual([]);
    expect(internals(retry).db.getDb().prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    const stable = await retry.sync(); expect(stable.filesAdded + stable.filesModified + stable.filesRemoved).toBe(0);
  }, 30000);
});
