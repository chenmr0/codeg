/**
 * Main-thread client for the fresh-index store worker.
 *
 * Bundles are posted in file order and the worker applies them in arrival
 * order, preserving deterministic row insertion while moving synchronous
 * SQLite binding work off the main thread.
 */

import { Worker } from 'worker_threads';
import { estimateExtractionBytes } from './extraction-size';
import type {
  Edge,
  ExtractionResult,
  FileRecord,
  Language,
  Node,
  UnresolvedReference,
} from '../types';

export interface StoreBundle {
  nodes: Node[];
  edges: Edge[];
  refs: UnresolvedReference[];
  file: FileRecord;
}

export function finalizeStoreBundle(
  result: Pick<ExtractionResult, 'nodes' | 'edges' | 'unresolvedReferences'>,
  filePath: string,
  language: Language,
  file: FileRecord
): StoreBundle {
  const validNodes = result.nodes.filter(
    (node) =>
      node.id && node.kind && node.name && node.filePath && node.language
  );
  // INSERT OR REPLACE keeps the last valid value and moves that row to the
  // end. Preserve both semantics without replacing same-file IDs: with bulk
  // indexes deferred, every replacement scans prior edges/refs for FK deletes.
  const lastPosition = new Map<string, number>();
  validNodes.forEach((node, index) => lastPosition.set(node.id, index));
  const nodes = validNodes.filter((node, index) => lastPosition.get(node.id) === index);
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
  private belowWaiters: Array<{ limit: number; maxBytes: number; resolve: () => void }> = [];
  private nextDrainId = 0;
  private outstanding = 0;
  private outstandingBytes = 0;
  private readonly bundleBytes: number[] = [];
  private exited = false;

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
      (message: { type: string; id?: number; message?: string }) => {
        if (message.type === 'ready') {
          readyResolve();
        } else if (message.type === 'ack') {
          this.settleOne();
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
          this.settleOne();
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
    if (this.firstError) throw this.firstError;
    if (this.exited) throw new Error('store worker already exited');
    const bytes = estimateExtractionBytes(null, {
      nodes: bundle.nodes, edges: bundle.edges, unresolvedReferences: bundle.refs,
    });
    this.outstanding++;
    this.outstandingBytes += bytes;
    this.bundleBytes.push(bytes);
    this.worker.postMessage({ type: 'bundle', bundle });
  }

  waitBelow(limit: number, maxBytes = Infinity): Promise<void> {
    if (
      this.firstError ||
      this.exited ||
      (this.outstanding < limit && this.outstandingBytes < maxBytes)
    ) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.belowWaiters.push({ limit, maxBytes, resolve });
    });
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

  private settleOne(): void {
    if (this.outstanding > 0) {
      this.outstanding--;
      this.outstandingBytes -= this.bundleBytes.shift() ?? 0;
    }
    const remaining: typeof this.belowWaiters = [];
    for (const waiter of this.belowWaiters) {
      if (this.outstanding < waiter.limit && this.outstandingBytes < waiter.maxBytes) waiter.resolve();
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
    this.outstandingBytes = 0;
    this.bundleBytes.length = 0;
    const waiters = this.belowWaiters;
    this.belowWaiters = [];
    for (const waiter of waiters) waiter.resolve();
  }
}
