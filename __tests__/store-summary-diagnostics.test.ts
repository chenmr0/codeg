import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { EventEmitter } from 'node:events';
import CodeGraph from '../src/index';
import { ExtractionOrchestrator } from '../src/extraction';
import type { QueryBuilder } from '../src/db/queries';
import { StoreWriter, type StoreReplacement } from '../src/extraction/store-writer';
import {
  StoreDiagnostics, measureStoreTransaction, reportStoreDiagnostics,
  type StoreTransactionDiagnostics,
} from '../src/extraction/store-diagnostics';
import { SyncDiagnosticsSummary } from '../src/sync/diagnostics-summary';

vi.mock('worker_threads', async () => {
  const { EventEmitter } = await import('node:events');
  return { Worker: class extends EventEmitter {
    sent: unknown[] = [];
    failure: Error | undefined;
    postMessage(message: { type: string }) {
      if (this.failure) throw this.failure;
      this.sent.push(message);
      if (message.type === 'open') this.emit('message', { type: 'ready' });
      if (message.type === 'close') queueMicrotask(() => this.emit('exit', 0));
    }
    terminate() { return Promise.resolve(0); }
  } };
});

type MockWorker = EventEmitter & { sent: Array<{ type: string; request?: StoreReplacement }>; failure?: Error };
function writerFixture(summary?: SyncDiagnosticsSummary) {
  const writer = new StoreWriter('unused.js', 'private-database.db', false,
    { root: '/private-project', deferWal: false }, summary);
  return { writer, worker: (writer as unknown as { worker: MockWorker }).worker };
}
function values(summary: SyncDiagnosticsSummary, group: string): Record<string, number> {
  const line = summary.lines('success').find(value => value.startsWith(`[sync-summary] ${group} `));
  return Object.fromEntries((line?.split(' ').slice(2) ?? [])
    .filter(Boolean).map(pair => { const [key, value] = pair.split('='); return [key, Number(value)]; }));
}
function transactionDiagnostics(): StoreTransactionDiagnostics {
  return { transactionWallMs: 0, bodyMs: 0, boundaryMs: 0 };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('anonymous store diagnostics', () => {
  it('reports only fixed numeric fields and keeps owning-thread and worker groups separate', () => {
    const summary = new SyncDiagnosticsSummary();
    const detail = new StoreDiagnostics();
    detail.files = 2;
    detail.timings.nodesMs = 13;
    (detail as any).filePath = '/private/source.ts';
    (detail.timings as any).privateSourceName = 999;
    reportStoreDiagnostics(summary, detail);
    reportStoreDiagnostics(summary, detail, 'worker');
    expect(values(summary, 'store')).toMatchObject({ filesCount: 2, nodesMs: 13 });
    expect(values(summary, 'store').failedCount ?? 0).toBe(0);
    expect(values(summary, 'worker')).toMatchObject({ filesCount: 2, nodesMs: 13 });
    expect(summary.lines('success').join('\n')).not.toMatch(/private|source\.ts/);
  });

  it.each(['success', 'body-error', 'commit-error', 'begin-error'] as const)(
    'times the existing transaction wrapper and body, including %s', outcome => {
      let time = 0;
      vi.spyOn(performance, 'now').mockImplementation(() => time);
      const metrics = transactionDiagnostics();
      const failure = new Error('original transaction error');
      const body = vi.fn(() => {
        time += 11;
        if (outcome === 'body-error') throw failure;
        return 42;
      });
      const transaction = vi.fn((operation: () => number) => {
        time += 5;
        if (outcome === 'begin-error') throw failure;
        try {
          const result = operation();
          if (outcome === 'commit-error') throw failure;
          return result;
        } finally { time += 7; }
      });
      if (outcome === 'success') expect(measureStoreTransaction(metrics, transaction, body)).toBe(42);
      else {
        let caught: unknown;
        try { measureStoreTransaction(metrics, transaction, body); } catch (error) { caught = error; }
        expect(caught).toBe(failure);
      }
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(body).toHaveBeenCalledTimes(outcome === 'begin-error' ? 0 : 1);
      expect(metrics).toEqual(outcome === 'begin-error'
        ? { transactionWallMs: 5, bodyMs: 0, boundaryMs: 5 }
        : { transactionWallMs: 23, bodyMs: 11, boundaryMs: 12 });
    },
  );

  it('adds no clocks and retains the exact transaction body with diagnostics disabled', () => {
    const now = vi.spyOn(performance, 'now');
    const body = () => 17;
    const transaction = vi.fn((operation: () => number) => operation());
    expect(measureStoreTransaction(undefined, transaction, body)).toBe(17);
    expect(transaction).toHaveBeenCalledWith(body);
    expect(now).not.toHaveBeenCalled();
  });

  it.each(['replaced', 'error'] as const)('aggregates worker %s messages and removal request walls', async outcome => {
    let time = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => time);
    const summary = new SyncDiagnosticsSummary();
    const { writer, worker } = writerFixture(summary);
    const detail = new StoreDiagnostics();
    detail.timings.deleteMs = 11;
    if (outcome === 'error') detail.failedPhase = 'deleteMs';
    const transaction = { transactionWallMs: 23, bodyMs: 11, boundaryMs: 12 };
    try {
      const pending = writer.replace({ filePath: 'private-source.ts', remove: true });
      expect(worker.sent.at(-1)?.request).toEqual({ filePath: 'private-source.ts', remove: true, diagnostics: true });
      time += 31;
      worker.emit('message', outcome === 'replaced'
        ? { type: outcome, id: 0, result: { failedSourceFiles: [], diagnostics: detail }, transactionDiagnostics: transaction }
        : { type: outcome, id: 0, message: 'private-source.ts failed', diagnostics: detail, transactionDiagnostics: transaction });
      if (outcome === 'replaced') await expect(pending).resolves.toMatchObject({ diagnostics: detail });
      else await expect(pending).rejects.toThrow('store worker: private-source.ts failed');
      expect(values(summary, 'worker')).toMatchObject({ requestWallMs: 31, requestCount: 1,
        deleteMs: 11, transactionWallMs: 23, bodyMs: 11, boundaryMs: 12 });
      expect(values(summary, 'worker').failedCount ?? 0).toBe(outcome === 'error' ? 1 : 0);
      expect(values(summary, 'store')).toEqual({});
      expect(summary.lines('error').join('\n')).not.toContain('private');
    } finally { await writer.close(); }
  });

  it.each(['error', 'exit', 'serialization'] as const)('records RPC time without replacing the original %s failure', async failure => {
    let time = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => time);
    const summary = new SyncDiagnosticsSummary();
    const { writer, worker } = writerFixture(summary);
    const original = new Error('original failure');
    try {
      if (failure === 'serialization') worker.failure = original;
      const pending = writer.replace({ filePath: 'private.ts', remove: true });
      time = 7;
      if (failure === 'error') worker.emit('error', original);
      else if (failure === 'exit') worker.emit('exit', 1);
      if (failure === 'exit') await expect(pending).rejects.toThrow('store worker exited with code 1');
      else await expect(pending).rejects.toBe(original);
      expect(values(summary, 'worker')).toMatchObject({ requestWallMs: 7, requestCount: 1, failedRequestCount: 1 });
    } finally { worker.failure = undefined; await writer.close(); }
  });

  it('does not enable worker diagnostics or add timing calls when summary is absent', async () => {
    const now = vi.spyOn(performance, 'now');
    const { writer, worker } = writerFixture();
    const request: StoreReplacement = { filePath: 'private.ts', remove: true };
    try {
      const pending = writer.replace(request);
      expect(worker.sent.at(-1)?.request).toBe(request);
      worker.emit('message', { type: 'replaced', id: 0, result: { failedSourceFiles: [] } });
      await pending;
      expect(now).not.toHaveBeenCalled();
    } finally { await writer.close(); }
  });
});

describe('extraction summary failure boundaries', () => {
  it('keeps successful extraction and no-op results unchanged without verbose output', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-summary-parity-'));
    const graph = CodeGraph.initSync(root);
    const queries = (graph as unknown as { queries: QueryBuilder }).queries;
    const orchestrator = new ExtractionOrchestrator(root, queries);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('CODEGRAPH_RUST_SCAN', '0');
    try {
      fs.writeFileSync(path.join(root, 'private-source.ts'), 'export function privateSymbol() { return 123; }\n');
      const firstSummary = new SyncDiagnosticsSummary();
      const first = await orchestrator.sync(undefined, ['private-source.ts'], false,
        undefined, undefined, undefined, firstSummary);
      expect(first).toMatchObject({ complete: true, filesAdded: 1, filesModified: 0 });
      expect(values(firstSummary, 'store')).toMatchObject({ filesCount: 1 });
      const nodes = queries.getNodesByFile('private-source.ts');
      const file = queries.getFileByPath('private-source.ts');
      const { durationMs: _plainDuration, ...plain } = await orchestrator.sync(undefined, ['private-source.ts']);
      const summary = new SyncDiagnosticsSummary();
      const { durationMs: _summaryDuration, ...measured } = await orchestrator.sync(undefined,
        ['private-source.ts'], false, undefined, undefined, undefined, summary);
      expect(measured).toEqual(plain);
      expect(queries.getNodesByFile('private-source.ts')).toEqual(nodes);
      expect(queries.getFileByPath('private-source.ts')).toEqual(file);
      for (const key of ['frameworkMs', 'macroMs', 'setupMs', 'readMs', 'parseWallMs', 'storeWallMs']) {
        expect(values(summary, 'extraction')[key] ?? 0).toBe(0);
      }
      expect(values(summary, 'store').filesCount ?? 0).toBe(0);
      expect(values(summary, 'store').nodeRowsCount ?? 0).toBe(0);
      expect(log).not.toHaveBeenCalled();
      expect(firstSummary.lines('success').join('\n')).not.toMatch(/private-source|privateSymbol/);
    } finally { graph.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('keeps the failed store wall separate from parse cleanup and reports partial node insertion', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-summary-failed-store-'));
    const graph = CodeGraph.initSync(root);
    const queries = (graph as unknown as { queries: QueryBuilder }).queries;
    const orchestrator = new ExtractionOrchestrator(root, queries);
    const original = new Error('original store failure');
    vi.stubEnv('CODEGRAPH_RUST_SCAN', '0');
    try {
      fs.writeFileSync(path.join(root, 'private-source.ts'), 'export function privateSymbol() { return 123; }\n');
      vi.spyOn(queries, 'insertNodes').mockImplementation(() => { throw original; });
      const summary = new SyncDiagnosticsSummary();
      const add = vi.spyOn(summary, 'add');
      await expect(orchestrator.sync(undefined, ['private-source.ts'], false,
        undefined, undefined, undefined, summary)).rejects.toBe(original);
      expect(add).toHaveBeenCalledWith('extraction', 'storeWallMs', expect.any(Number));
      expect(add).toHaveBeenCalledWith('extraction', 'cleanupMs', expect.any(Number));
      expect(values(summary, 'store')).toMatchObject({ failedCount: 1 });
      expect(values(summary, 'store').filesCount ?? 0).toBe(0);
      expect(add).toHaveBeenCalledWith('store', 'nodesMs', expect.any(Number));
      expect(add).toHaveBeenCalledWith('store', 'mainThreadWallMs', expect.any(Number));
    } finally { graph.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('records main-thread removal substages and partial store failure without verbose paths', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-summary-store-'));
    const graph = CodeGraph.initSync(root);
    const queries = (graph as unknown as { queries: QueryBuilder }).queries;
    const orchestrator = new ExtractionOrchestrator(root, queries);
    const detail = new StoreDiagnostics();
    const original = new Error('private-source.ts database failure');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      queries.upsertFile({ path: 'private-source.ts', language: 'typescript', contentHash: 'old',
        modifiedAt: 1, indexedAt: 1, size: 1, nodeCount: 0 });
      vi.spyOn(queries, 'deleteFile').mockImplementation(() => { throw original; });
      const summary = new SyncDiagnosticsSummary();
      const add = vi.spyOn(summary, 'add');
      await expect(orchestrator.sync(undefined, ['private-source.ts'], false,
        undefined, undefined, undefined, summary)).rejects.toBe(original);
      expect(add).toHaveBeenCalledWith('extraction', 'reconcileMs', expect.any(Number));
      expect(values(summary, 'store')).toMatchObject({ failedCount: 1 });
      expect(add).toHaveBeenCalledWith('store', 'mainThreadWallMs', expect.any(Number));
      expect(add).toHaveBeenCalledWith('store', 'deleteMs', expect.any(Number));
      expect(log).not.toHaveBeenCalled();
      expect(summary.lines('error').join('\n')).not.toContain('private-source');
      expect(() => orchestrator.storeParsedReplacement(
        { filePath: 'private-source.ts', remove: true, diagnostics: true }, detail)).toThrow(original);
      expect(detail.failedPhase).toBe('deleteMs');
    } finally { graph.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
});
