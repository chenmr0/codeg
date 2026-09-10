/**
 * Multi-core tree-sitter parse pool.
 *
 * Parsing is parallel, but callers still admit/store results in discovery
 * order so database row order and ambiguous-name resolution stay deterministic.
 */

import { Worker } from 'worker_threads';
import type { ExtractionResult, Language } from '../types';
import type { CppMacroDefinition } from './declaration-macros';

export interface ParsePoolWorker {
  postMessage(message: unknown): void;
  terminate(): Promise<number> | void;
  on(event: 'message', listener: (message: unknown) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'exit', listener: (code: number) => void): void;
}

export interface ParseTask {
  filePath: string;
  content: string;
  language: Language;
  frameworkNames?: string[];
  /** Retry safety mode: preserve the primary AST but omit optional macro replay. */
  skipDeclarationMacroRecovery?: boolean;
}

const DEFAULT_POOL_CAP = 8;
const MAX_POOL_SIZE = 16;
const DEFAULT_RECYCLE_INTERVAL = 250;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 180_000;
const HARD_KILL_MULTIPLIER = 3;
const MAX_CONCURRENT_SPAWN = 2;
const CRASH_BUDGET = 100;

export function resolveParseTimeoutMs(value: string | undefined): number {
  if (value !== undefined && value !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return DEFAULT_TIMEOUT_MS;
}

export function resolveParsePoolSize(
  value: string | undefined,
  cpuCount: number
): number {
  if (value !== undefined && value !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.max(1, Math.min(Math.floor(parsed), MAX_POOL_SIZE));
    }
  }
  return Math.max(1, Math.min(Math.floor(cpuCount) - 1, DEFAULT_POOL_CAP));
}

interface ParseJob {
  id: number;
  task: ParseTask;
  resolve: (result: ExtractionResult) => void;
  reject: (error: Error) => void;
  settled: boolean;
  timer?: ReturnType<typeof setTimeout>;
  hardKillTimer?: ReturnType<typeof setTimeout>;
  timerExpired?: boolean;
  budgetMs?: number;
}

interface ParseWorkerMessage {
  type?: string;
  id?: number;
  result?: ExtractionResult;
  parseMs?: number;
}

export interface ParseWorkerPoolOptions {
  languages: Language[];
  size: number;
  workerScriptPath?: string;
  recycleInterval?: number;
  parseTimeoutMs?: number;
  createWorker?: () => ParsePoolWorker;
  log?: (message: string) => void;
  grammarBuffers?: Record<string, Uint8Array>;
  /** Fork-specific C/C++ macro context, initialized on every worker. */
  macroNames?: string[];
  bodylessMacroNames?: string[];
  macroDefinitions?: CppMacroDefinition[];
  /** Opt-in profile hook; omitted on the production indexing path. */
  onStateChange?: (state: {
    queueDepth: number;
    inflightWorkers: number;
    idleWorkers: number;
    pendingWorkers: number;
    liveWorkers: number;
  }) => void;
}

export class ParseWorkerPool {
  private idle: ParsePoolWorker[] = [];
  private queue: ParseJob[] = [];
  private inflight = new Map<ParsePoolWorker, ParseJob>();
  private workers = new Set<ParsePoolWorker>();
  private pending = new Set<ParsePoolWorker>();
  private parseCounts = new Map<ParsePoolWorker, number>();
  private nextId = 1;
  private crashCount = 0;
  private destroyed = false;
  private readyWaiters: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];

  private readonly languages: Language[];
  private readonly maxSize: number;
  private readonly recycleInterval: number;
  private readonly parseTimeoutMs: number;
  private readonly createWorker: () => ParsePoolWorker;
  private readonly log: (message: string) => void;
  private readonly grammarBuffers?: Record<string, Uint8Array>;
  private readonly macroNames: string[];
  private readonly bodylessMacroNames: string[];
  private readonly macroDefinitions: CppMacroDefinition[];
  private readonly onStateChange?: ParseWorkerPoolOptions['onStateChange'];

  constructor(options: ParseWorkerPoolOptions) {
    this.languages = options.languages;
    this.maxSize = Math.max(1, Math.min(options.size, MAX_POOL_SIZE));
    this.recycleInterval = options.recycleInterval ?? DEFAULT_RECYCLE_INTERVAL;
    this.parseTimeoutMs = options.parseTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.log = options.log ?? (() => {});
    this.grammarBuffers = options.grammarBuffers;
    this.macroNames = options.macroNames ?? [];
    this.bodylessMacroNames = options.bodylessMacroNames ?? [];
    this.macroDefinitions = options.macroDefinitions ?? [];
    this.onStateChange = options.onStateChange;

    if (options.createWorker) {
      this.createWorker = options.createWorker;
    } else if (options.workerScriptPath) {
      const scriptPath = options.workerScriptPath;
      this.createWorker = () => new Worker(scriptPath);
    } else {
      throw new Error('ParseWorkerPool requires workerScriptPath or createWorker');
    }

    this.spawnOne();
  }

  get size(): number {
    return this.maxSize;
  }

  get liveWorkers(): number {
    return this.workers.size;
  }

  get healthy(): boolean {
    return !this.destroyed && this.crashCount < CRASH_BUDGET;
  }

  /** Bulk indexing knows all workers will be useful, so start them eagerly. */
  prewarm(): void {
    while (this.workers.size < this.maxSize) {
      const before = this.workers.size;
      this.spawnOne();
      if (this.workers.size === before) break;
    }
  }

  /** Wait until every worker started so far has loaded its grammars/context. */
  waitUntilReady(): Promise<void> {
    if (this.destroyed) return Promise.reject(new Error('Parse pool destroyed'));
    if (this.pending.size === 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.readyWaiters.push({ resolve, reject });
    });
  }

  requestParse(task: ParseTask): Promise<ExtractionResult> {
    if (this.destroyed) return Promise.reject(new Error('Parse pool destroyed'));
    return new Promise<ExtractionResult>((resolve, reject) => {
      this.queue.push({
        id: this.nextId++,
        task,
        resolve,
        reject,
        settled: false,
      });
      this.reportState();
      this.drain();
    });
  }

  private spawnOne(): void {
    if (
      this.destroyed ||
      !this.healthy ||
      this.workers.size >= this.maxSize
    ) {
      return;
    }

    let worker: ParsePoolWorker;
    try {
      worker = this.createWorker();
    } catch {
      this.crashCount++;
      return;
    }

    this.workers.add(worker);
    this.pending.add(worker);
    this.parseCounts.set(worker, 0);
    worker.on('message', (message) =>
      this.onMessage(worker, (message ?? {}) as ParseWorkerMessage)
    );
    worker.on('error', (error) =>
      this.onWorkerGone(worker, `Worker error: ${error?.message ?? 'unknown'}`)
    );
    worker.on('exit', (code) => {
      if (this.workers.has(worker)) {
        this.onWorkerGone(worker, `Worker exited with code ${code}`);
      }
    });

    // Macro sets travel with grammar initialization so the worker is not made
    // idle until both parser and fork-specific C/C++ context are ready.
    worker.postMessage({
      type: 'load-grammars',
      languages: this.languages,
      grammarBuffers: this.grammarBuffers,
      macroNames: this.macroNames,
      bodylessMacroNames: this.bodylessMacroNames,
      macroDefinitions: this.macroDefinitions,
    });
  }

  private onMessage(worker: ParsePoolWorker, message: ParseWorkerMessage): void {
    if (message.type === 'grammars-loaded') {
      if (!this.workers.has(worker)) return;
      this.pending.delete(worker);
      this.idle.push(worker);
      this.reportState();
      this.settleReadyWaiters();
      this.drain();
      return;
    }

    if (message.type !== 'parse-result') return;
    const job = this.inflight.get(worker);
    if (!job || (message.id !== undefined && message.id !== job.id)) return;
    this.inflight.delete(worker);

    if (job.timerExpired) {
      const parseMs =
        typeof message.parseMs === 'number' ? Math.round(message.parseMs) : undefined;
      const detail =
        parseMs === undefined
          ? ''
          : parseMs < (job.budgetMs ?? this.parseTimeoutMs)
            ? ` (parse took ${parseMs}ms in-worker; main thread was delayed)`
            : ` (parse took ${parseMs}ms)`;
      this.log(`Late parse-result accepted: ${job.task.filePath}${detail}`);
    }

    if ((this.parseCounts.get(worker) ?? 0) >= this.recycleInterval) {
      this.recycle(worker);
    } else {
      this.idle.push(worker);
    }
    this.reportState();
    this.settle(job, message.result);
    this.drain();
  }

  private onWorkerGone(worker: ParsePoolWorker, message: string): void {
    if (!this.workers.has(worker)) return;
    const job = this.inflight.get(worker);
    this.inflight.delete(worker);
    this.removeWorker(worker);
    this.reportState();
    this.crashCount++;
    try {
      void worker.terminate();
    } catch {
      // already gone
    }
    if (job) this.settle(job, undefined, new Error(message));
    if (this.healthy) this.spawnOne();
    this.settleReadyWaiters();
    this.drain();
  }

  private dispatch(worker: ParsePoolWorker, job: ParseJob): void {
    this.inflight.set(worker, job);
    this.reportState();
    this.parseCounts.set(worker, (this.parseCounts.get(worker) ?? 0) + 1);
    const timeoutMs = Math.min(
      this.parseTimeoutMs +
        Math.floor(job.task.content.length / 100_000) * 10_000,
      MAX_TIMEOUT_MS
    );
    job.budgetMs = timeoutMs;
    job.timer = setTimeout(
      () => this.onTimeout(worker, job, timeoutMs),
      timeoutMs
    );
    job.timer.unref?.();
    worker.postMessage({
      type: 'parse',
      id: job.id,
      filePath: job.task.filePath,
      content: job.task.content,
      language: job.task.language,
      frameworkNames: job.task.frameworkNames,
      skipDeclarationMacroRecovery: job.task.skipDeclarationMacroRecovery,
    });
  }

  private onTimeout(
    worker: ParsePoolWorker,
    job: ParseJob,
    timeoutMs: number
  ): void {
    if (job.settled || !this.workers.has(worker)) return;
    const graceMs = timeoutMs * (HARD_KILL_MULTIPLIER - 1);
    this.log(
      `TIMEOUT: ${job.task.filePath} exceeded ${timeoutMs}ms; waiting ${graceMs}ms for a late result`
    );
    job.timerExpired = true;
    job.hardKillTimer = setTimeout(
      () =>
        this.onHardTimeout(
          worker,
          job,
          timeoutMs * HARD_KILL_MULTIPLIER
        ),
      graceMs
    );
    job.hardKillTimer.unref?.();
  }

  private onHardTimeout(
    worker: ParsePoolWorker,
    job: ParseJob,
    totalMs: number
  ): void {
    if (job.settled || !this.workers.has(worker)) return;
    this.removeWorker(worker);
    this.inflight.delete(worker);
    this.reportState();
    try {
      void worker.terminate();
    } catch {
      // wedged/already gone
    }
    this.settle(
      job,
      undefined,
      new Error(`Parse timed out after ${totalMs}ms`)
    );
    if (this.healthy) this.spawnOne();
    this.drain();
  }

  private drain(): void {
    while (
      this.queue.length > this.idle.length + this.pending.size &&
      this.workers.size < this.maxSize &&
      this.pending.size < MAX_CONCURRENT_SPAWN &&
      this.healthy
    ) {
      this.spawnOne();
    }

    while (this.idle.length > 0 && this.queue.length > 0) {
      let job = this.queue.shift();
      while (job?.settled) job = this.queue.shift();
      if (!job) break;
      this.dispatch(this.idle.pop()!, job);
    }

    if (
      this.queue.length > 0 &&
      this.idle.length === 0 &&
      this.pending.size === 0 &&
      this.workers.size === 0
    ) {
      const reason = this.destroyed
        ? 'parse pool destroyed'
        : 'parse pool exhausted its worker crash budget';
      for (const job of this.queue.splice(0)) {
        this.settle(job, undefined, new Error(reason));
      }
    }
  }

  private recycle(worker: ParsePoolWorker): void {
    this.log(
      `Recycling worker after ${this.parseCounts.get(worker)} parses ` +
        `(heap: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB RSS)`
    );
    this.removeWorker(worker);
    this.reportState();
    try {
      void worker.terminate();
    } catch {
      // already gone
    }
    if (this.healthy) this.spawnOne();
  }

  private removeWorker(worker: ParsePoolWorker): void {
    this.workers.delete(worker);
    this.pending.delete(worker);
    this.parseCounts.delete(worker);
    this.idle = this.idle.filter((candidate) => candidate !== worker);
  }

  private settle(
    job: ParseJob,
    result?: ExtractionResult,
    error?: Error
  ): void {
    if (job.settled) return;
    job.settled = true;
    if (job.timer) clearTimeout(job.timer);
    if (job.hardKillTimer) clearTimeout(job.hardKillTimer);
    if (error) job.reject(error);
    else job.resolve(result!);
  }

  private settleReadyWaiters(error?: Error): void {
    if (!error && this.pending.size > 0) return;
    const waiters = this.readyWaiters.splice(0);
    for (const waiter of waiters) {
      if (error) waiter.reject(error);
      else waiter.resolve();
    }
  }

  private reportState(): void {
    this.onStateChange?.({
      queueDepth: this.queue.length,
      inflightWorkers: this.inflight.size,
      idleWorkers: this.idle.length,
      pendingWorkers: this.pending.size,
      liveWorkers: this.workers.size,
    });
  }

  /** Give retry attempts fresh WASM heaps. */
  recycleAll(): void {
    for (const worker of [...this.idle]) this.recycle(worker);
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.settleReadyWaiters(new Error('parse pool destroyed'));
    const workers = [...this.workers];
    this.workers.clear();
    this.pending.clear();
    this.parseCounts.clear();
    this.idle = [];
    for (const job of [...this.inflight.values(), ...this.queue]) {
      this.settle(job, undefined, new Error('parse pool destroyed'));
    }
    this.inflight.clear();
    this.queue = [];
    this.reportState();
    await Promise.all(
      workers.map((worker) =>
        Promise.resolve(worker.terminate()).catch(() => {
          // already gone
        })
      )
    );
  }
}
