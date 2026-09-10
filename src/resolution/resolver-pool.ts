/**
 * Read-only worker pool for reference resolution.
 *
 * A database batch is split into contiguous chunks. Workers may finish out of
 * order, but results are concatenated in original chunk order and all database
 * writes remain on the main thread. A worker failure rejects the whole batch;
 * the caller then resolves that untouched batch sequentially.
 */

import { Worker } from 'worker_threads';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { UnresolvedReference } from '../types';
import { memoryBudgetBytes } from './memory-budget';
import type { ResolvedRef, UnresolvedRef } from './types';

export interface ResolverAdmissionResult {
  resolved: ResolvedRef[];
  unresolved: UnresolvedRef[];
  deferredChain: UnresolvedRef[];
  byMethod: Record<string, number>;
}

interface PoolWorker {
  worker: Worker;
  ready: Promise<void>;
  busy: number;
}

interface Waiter {
  resolve: (result: ResolverAdmissionResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const MAX_AUTOMATIC_WORKERS = 6;
const MAX_EXPLICIT_WORKERS = 16;
const MIN_PARALLEL_BATCH = 1_000;
const RESOLUTION_CHUNK_SIZE = 500;
const DEFAULT_TASK_TIMEOUT_MS = 180_000;

/** Minimum pending-reference count before pool startup is worth its cost. */
export function minRefsForResolverPool(): number {
  const raw = process.env.CODEGRAPH_PARALLEL_RESOLVE_MIN;
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 150_000;
}

/** Worker task timeout; timeout only triggers a whole-batch sequential retry. */
function resolverTaskTimeoutMs(): number {
  const raw = process.env.CODEGRAPH_RESOLVE_TASK_TIMEOUT_MS;
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_TASK_TIMEOUT_MS;
}

/**
 * Resolve pool size from CPU and memory headroom.
 *
 * Returns null when fewer than two workers are safe or useful. Inputs are
 * explicit so the policy is deterministic and unit-testable.
 */
export function resolveResolverPoolSize(options: {
  explicit?: string;
  availableParallelism: number;
  availableMemoryBytes: number;
  databaseSizeBytes: number;
}): number | null {
  if (options.explicit !== undefined && options.explicit !== '') {
    const parsed = Number.parseInt(options.explicit, 10);
    if (Number.isFinite(parsed)) {
      if (parsed <= 0) return null;
      return Math.min(Math.floor(parsed), MAX_EXPLICIT_WORKERS);
    }
  }

  // Keep one CPU for ordered persistence and UI/watchdog progress.
  const cpuCap = Math.min(
    Math.max(0, Math.floor(options.availableParallelism) - 1),
    MAX_AUTOMATIC_WORKERS
  );

  // A worker holds query caches in addition to SQLite pages. Reserve 30% of
  // currently available memory for the writer and non-resolution state.
  const perWorker = Math.min(
    Math.max(options.databaseSizeBytes * 0.2, 256 * 1024 * 1024),
    1.5 * 1024 * 1024 * 1024
  );
  const memoryCap = Math.floor((options.availableMemoryBytes * 0.7) / perWorker);
  const size = Math.min(cpuCap, memoryCap);
  return size >= 2 ? size : null;
}

export class ResolverPool {
  private readonly workers: PoolWorker[] = [];
  private readonly waiters = new Map<number, Waiter>();
  private nextId = 1;
  private failed: Error | null = null;
  private destroying = false;

  static worthParallel(batchLength: number): boolean {
    return batchLength >= MIN_PARALLEL_BATCH;
  }

  /**
   * Create a pool only when the compiled worker exists and node:sqlite is in
   * use. Returning null is an intentional sequential fallback.
   */
  static tryCreate(dbPath: string, projectRoot: string): ResolverPool | null {
    if (process.env.CODEGRAPH_NO_PARALLEL_RESOLVE === '1') return null;
    if (process.env.CODEGRAPH_FORCE_WASM === '1') return null;

    const workerScript = path.join(__dirname, 'resolver-worker.js');
    if (!fs.existsSync(workerScript)) return null;

    let databaseSizeBytes = 0;
    try {
      databaseSizeBytes = fs.statSync(dbPath).size;
    } catch {
      // The 256 MB per-worker floor remains in effect.
    }

    const availableMemoryBytes = memoryBudgetBytes();
    const availableParallelism = os.availableParallelism();
    const size = resolveResolverPoolSize({
      explicit: process.env.CODEGRAPH_RESOLVE_WORKERS,
      availableParallelism,
      availableMemoryBytes,
      databaseSizeBytes,
    });
    if (process.env.CODEGRAPH_SYNTH_TIMINGS) {
      console.error(
        `[resolve-pool] ${size === null ? 'disabled' : `workers=${size}`} ` +
          `(cpus=${availableParallelism}, freeMB=${Math.round(availableMemoryBytes / 1024 / 1024)}, ` +
          `dbMB=${Math.round(databaseSizeBytes / 1024 / 1024)})`
      );
    }
    if (size === null) return null;

    try {
      return new ResolverPool(workerScript, dbPath, projectRoot, size);
    } catch {
      return null;
    }
  }

  private constructor(
    workerScript: string,
    dbPath: string,
    projectRoot: string,
    size: number
  ) {
    for (let i = 0; i < size; i++) {
      const worker = new Worker(workerScript);
      let readyResolve!: () => void;
      let readyReject!: (error: Error) => void;
      const ready = new Promise<void>((resolve, reject) => {
        readyResolve = resolve;
        readyReject = reject;
      });
      // A rejected readiness promise may race with pool downgrade before the
      // caller attaches Promise.all. Attach a no-op observer immediately.
      void ready.catch(() => undefined);

      const member: PoolWorker = { worker, ready, busy: 0 };
      worker.on('message', (raw: unknown) => {
        const message = (raw ?? {}) as {
          type?: string;
          id?: number;
          error?: string;
          result?: ResolverAdmissionResult;
        };
        if (message.type === 'ready') {
          readyResolve();
          return;
        }
        if (message.type === 'result' && message.id !== undefined && message.result) {
          member.busy = Math.max(0, member.busy - 1);
          const waiter = this.waiters.get(message.id);
          if (!waiter) return;
          this.waiters.delete(message.id);
          clearTimeout(waiter.timer);
          waiter.resolve(message.result);
          return;
        }
        if (message.type === 'error') {
          const error = new Error(message.error || 'resolver worker failed');
          readyReject(error);
          this.fail(error);
        }
      });
      worker.on('error', (error) => {
        readyReject(error);
        this.fail(error);
      });
      worker.on('exit', (code) => {
        if (!this.destroying && code !== 0) {
          const error = new Error(`resolver worker exited with code ${code}`);
          readyReject(error);
          this.fail(error);
        }
      });
      worker.postMessage({ type: 'open', dbPath, projectRoot });
      this.workers.push(member);
    }
  }

  async ready(): Promise<void> {
    await Promise.all(this.workers.map((member) => member.ready));
  }

  /**
   * Resolve one database batch without side effects.
   *
   * A worker receives its next chunk only after completing the current one.
   * Resolution cost is data-dependent (template-heavy C++ names can be much
   * slower than ordinary exact matches), so pre-assigning all chunks makes the
   * tail depend on the initial round-robin assignment. Results remain merged in
   * original chunk order, independent of worker completion order.
   */
  async resolveBatch(refs: UnresolvedReference[]): Promise<ResolverAdmissionResult> {
    if (this.failed) throw this.failed;

    const inputs: UnresolvedReference[][] = [];
    for (let offset = 0; offset < refs.length; offset += RESOLUTION_CHUNK_SIZE) {
      inputs.push(refs.slice(offset, offset + RESOLUTION_CHUNK_SIZE));
    }
    if (inputs.length === 0) {
      return { resolved: [], unresolved: [], deferredChain: [], byMethod: {} };
    }

    return new Promise<ResolverAdmissionResult>((resolve, reject) => {
      const results = new Array<ResolverAdmissionResult>(inputs.length);
      let nextInput = 0;
      let completed = 0;
      let settled = false;

      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const finish = (): void => {
        if (settled || completed !== inputs.length) return;
        settled = true;
        const combined: ResolverAdmissionResult = {
          resolved: [],
          unresolved: [],
          deferredChain: [],
          byMethod: {},
        };
        for (const result of results) {
          combined.resolved.push(...result.resolved);
          combined.unresolved.push(...result.unresolved);
          combined.deferredChain.push(...result.deferredChain);
          for (const [method, count] of Object.entries(result.byMethod)) {
            combined.byMethod[method] = (combined.byMethod[method] || 0) + count;
          }
        }
        resolve(combined);
      };
      const dispatch = (member: PoolWorker): void => {
        if (settled || nextInput >= inputs.length) {
          finish();
          return;
        }
        const inputIndex = nextInput++;
        const refsForWorker = inputs[inputIndex]!;
        const id = this.nextId++;
        member.busy++;
        const timer = setTimeout(() => {
          if (!this.waiters.delete(id)) return;
          const error = new Error(`resolver worker task timed out after ${resolverTaskTimeoutMs()}ms`);
          this.fail(error);
          fail(error);
        }, resolverTaskTimeoutMs());
        timer.unref?.();
        this.waiters.set(id, {
          resolve: (result) => {
            if (settled) return;
            results[inputIndex] = result;
            completed++;
            dispatch(member);
            finish();
          },
          reject: fail,
          timer,
        });
        member.worker.postMessage({ type: 'resolve', id, refs: refsForWorker });
      };

      for (const member of this.workers) dispatch(member);
    });
  }

  private fail(error: Error): void {
    if (!this.failed) this.failed = error;
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(this.failed);
    }
    this.waiters.clear();
  }

  async destroy(): Promise<void> {
    this.destroying = true;
    if (!this.failed) this.fail(new Error('resolver pool destroyed'));
    await Promise.all(
      this.workers.map(async ({ worker }) => {
        try {
          await worker.terminate();
        } catch {
          // Already exited.
        }
      })
    );
  }
}
