/**
 * Main-thread client for the fresh-index store worker.
 *
 * Bundles are posted in file order and the worker applies them in arrival
 * order, preserving deterministic row insertion while moving synchronous
 * SQLite binding work off the main thread.
 */

import { Worker } from 'worker_threads';
import type {
  Edge,
  ExtractionResult,
  FileRecord,
  Language,
  Node,
  UnresolvedReference,
} from '../types';
import type { InitProfileWriter } from '../performance/init-profile';

export interface StoreBundle {
  nodes: Node[];
  edges: Edge[];
  refs: UnresolvedReference[];
  file: FileRecord;
}

export interface StoreBatchLimits {
  maxBundles: number;
  maxRows: number;
  maxSourceBytes: number;
}

export interface StoreWorkerTransactionStats {
  transactionMs: number;
  rowAggregationMs: number;
  duplicateNodeRowsElided: number;
  nodeWriteMs: number;
  edgeWriteMs: number;
  unresolvedRefWriteMs: number;
  fileWriteMs: number;
  filesStored: number;
  nodesStored: number;
  edgesStored: number;
  unresolvedRefsStored: number;
}

export const DEFAULT_STORE_BATCH_LIMITS: StoreBatchLimits = {
  maxBundles: 10,
  maxRows: 50_000,
  maxSourceBytes: 16 * 1024 * 1024,
};

function storeBundleRows(bundle: StoreBundle): number {
  return bundle.nodes.length + bundle.edges.length + bundle.refs.length + 1;
}

export function batchStoreBundles(
  bundles: readonly StoreBundle[],
  limits: StoreBatchLimits = DEFAULT_STORE_BATCH_LIMITS,
): StoreBundle[][] {
  const batches: StoreBundle[][] = [];
  let current: StoreBundle[] = [];
  let currentRows = 0;
  let currentSourceBytes = 0;

  for (const bundle of bundles) {
    const rows = storeBundleRows(bundle);
    const sourceBytes = Math.max(0, bundle.file.size);
    const exceedsCurrent = current.length > 0 && (
      current.length + 1 > limits.maxBundles ||
      currentRows + rows > limits.maxRows ||
      currentSourceBytes + sourceBytes > limits.maxSourceBytes
    );
    if (exceedsCurrent) {
      batches.push(current);
      current = [];
      currentRows = 0;
      currentSourceBytes = 0;
    }
    current.push(bundle);
    currentRows += rows;
    currentSourceBytes += sourceBytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function finalizeStoreBundle(
  result: Pick<ExtractionResult, 'nodes' | 'edges' | 'unresolvedReferences'>,
  filePath: string,
  language: Language,
  file: FileRecord
): StoreBundle {
  const nodes = result.nodes.filter(
    (node) =>
      node.id && node.kind && node.name && node.filePath && node.language
  );
  const insertedIds = new Set(nodes.map((node) => node.id));
  const edges = result.edges.filter(
    (edge) =>
      insertedIds.has(edge.source) && insertedIds.has(edge.target)
  );
  const refs = result.unresolvedReferences
    .filter((ref) => insertedIds.has(ref.fromNodeId))
    .map((ref) => ({
      ...ref,
      filePath: ref.filePath ?? filePath,
      language: ref.language ?? language,
    }));
  return { nodes, edges, refs, file };
}

export class StoreWriter {
  private readonly worker: Worker;
  private readonly readyPromise: Promise<void>;
  private firstError: Error | null = null;
  private drainWaiters = new Map<
    number,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  private belowWaiters: Array<{ limit: number; resolve: () => void }> = [];
  private nextDrainId = 0;
  private outstanding = 0;
  private exited = false;
  private readonly stats: InitProfileWriter = {
    bundlesSent: 0,
    messagesSent: 0,
    sourceBytes: 0,
    nodesSent: 0,
    edgesSent: 0,
    unresolvedRefsSent: 0,
    maxOutstandingBundles: 0,
    walBackpressureCount: 0,
    windowWaitCount: 0,
    windowWaitMs: 0,
    transactions: 0,
    transactionMs: 0,
    rowAggregationMs: 0,
    duplicateNodeRowsElided: 0,
    nodeWriteMs: 0,
    edgeWriteMs: 0,
    unresolvedRefWriteMs: 0,
    fileWriteMs: 0,
    filesStored: 0,
    nodesStored: 0,
    edgesStored: 0,
    unresolvedRefsStored: 0,
  };

  constructor(workerScriptPath: string, dbPath: string, fastInit: boolean) {
    this.worker = new Worker(workerScriptPath);
    let readyResolve!: () => void;
    let readyReject!: (error: Error) => void;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    // The orchestrator intentionally queues bundles without awaiting startup;
    // attach an observer so a boot failure cannot become an unhandled
    // rejection. drain() still surfaces the same firstError to the caller.
    void this.readyPromise.catch(() => {});

    this.worker.on(
      'message',
      (message: {
        type: string;
        id?: number;
        message?: string;
        bundleCount?: number;
        stats?: StoreWorkerTransactionStats;
      }) => {
        if (message.type === 'ready') {
          readyResolve();
        } else if (message.type === 'ack') {
          if (message.stats) this.recordTransaction(message.stats);
          this.settle(message.bundleCount ?? message.stats?.filesStored ?? 1);
        } else if (message.type === 'drained' && message.id !== undefined) {
          const waiter = this.drainWaiters.get(message.id);
          this.drainWaiters.delete(message.id);
          if (!waiter) return;
          if (this.firstError) waiter.reject(this.firstError);
          else waiter.resolve();
        } else if (message.type === 'error') {
          if (!this.firstError) {
            this.firstError = new Error(`store worker: ${message.message}`);
          }
          this.settle(message.bundleCount ?? 1);
        }
      }
    );
    this.worker.on('error', (error) => {
      this.failAll(error);
      readyReject(this.firstError!);
    });
    this.worker.on('exit', (code) => {
      this.exited = true;
      if (code !== 0) {
        this.failAll(new Error(`store worker exited with code ${code}`));
        readyReject(this.firstError!);
      } else if (
        this.drainWaiters.size > 0 ||
        this.belowWaiters.length > 0
      ) {
        this.failAll(
          new Error('store worker exited before pending writes drained')
        );
      }
    });

    this.worker.postMessage({ type: 'open', dbPath, fastInit });
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  send(bundle: StoreBundle): void {
    this.sendMany([bundle]);
  }

  sendMany(bundles: readonly StoreBundle[]): void {
    if (bundles.length === 0) return;
    if (this.firstError) throw this.firstError;
    if (this.exited) throw new Error('store worker already exited');
    this.worker.postMessage({ type: 'batch', bundles });
    this.outstanding += bundles.length;
    this.stats.messagesSent++;
    this.stats.bundlesSent += bundles.length;
    for (const bundle of bundles) {
      this.stats.sourceBytes += Math.max(0, bundle.file.size);
      this.stats.nodesSent += bundle.nodes.length;
      this.stats.edgesSent += bundle.edges.length;
      this.stats.unresolvedRefsSent += bundle.refs.length;
    }
    this.stats.maxOutstandingBundles = Math.max(
      this.stats.maxOutstandingBundles,
      this.outstanding,
    );
  }

  async waitBelow(limit: number): Promise<number> {
    if (
      this.firstError ||
      this.exited ||
      this.outstanding < limit
    ) {
      return 0;
    }
    const started = performance.now();
    this.stats.windowWaitCount++;
    await new Promise<void>((resolve) => {
      this.belowWaiters.push({ limit, resolve });
    });
    const durationMs = performance.now() - started;
    this.stats.windowWaitMs += durationMs;
    return durationMs;
  }

  getStats(): InitProfileWriter {
    return { ...this.stats };
  }

  drain(): Promise<void> {
    if (this.firstError) return Promise.reject(this.firstError);
    if (this.exited) {
      return Promise.reject(new Error('store worker already exited'));
    }
    const id = this.nextDrainId++;
    const promise = new Promise<void>((resolve, reject) => {
      this.drainWaiters.set(id, { resolve, reject });
    });
    this.worker.postMessage({ type: 'drain', id });
    return promise;
  }

  async close(): Promise<void> {
    if (this.exited) return;
    this.worker.postMessage({ type: 'close' });
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        void this.worker.terminate().then(() => resolve());
      }, 5_000);
      this.worker.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  private recordTransaction(stats: StoreWorkerTransactionStats): void {
    this.stats.transactions++;
    this.stats.transactionMs += Math.max(0, stats.transactionMs);
    this.stats.rowAggregationMs += Math.max(0, stats.rowAggregationMs);
    this.stats.duplicateNodeRowsElided += Math.max(
      0,
      stats.duplicateNodeRowsElided,
    );
    this.stats.nodeWriteMs += Math.max(0, stats.nodeWriteMs);
    this.stats.edgeWriteMs += Math.max(0, stats.edgeWriteMs);
    this.stats.unresolvedRefWriteMs += Math.max(0, stats.unresolvedRefWriteMs);
    this.stats.fileWriteMs += Math.max(0, stats.fileWriteMs);
    this.stats.filesStored += stats.filesStored;
    this.stats.nodesStored += stats.nodesStored;
    this.stats.edgesStored += stats.edgesStored;
    this.stats.unresolvedRefsStored += stats.unresolvedRefsStored;
  }

  private settle(bundleCount: number): void {
    this.outstanding = Math.max(0, this.outstanding - Math.max(1, bundleCount));
    const remaining: typeof this.belowWaiters = [];
    for (const waiter of this.belowWaiters) {
      if (this.outstanding < waiter.limit) waiter.resolve();
      else remaining.push(waiter);
    }
    this.belowWaiters = remaining;
  }

  private failAll(error: Error): void {
    if (!this.firstError) this.firstError = error;
    for (const waiter of this.drainWaiters.values()) {
      waiter.reject(this.firstError);
    }
    this.drainWaiters.clear();
    this.outstanding = 0;
    const waiters = this.belowWaiters;
    this.belowWaiters = [];
    for (const waiter of waiters) waiter.resolve();
  }
}
