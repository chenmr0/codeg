/** Stable project facade; native connections belong to admitted operations, not projects. */
import * as path from "node:path";
import { existsSync, statSync, renameSync, appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { CodeGraph, SyncOptions, IndexDataReadiness } from "../../index";
import { DatabaseOpenError } from "../../db";
import {
  PortableCoordinator,
  PortableBusyError,
  type PortableLease,
} from "./protocol";
import {
  FileWatcher,
  LockUnavailableError,
  type WatchOptions,
} from "../watcher";
import { Mutex } from "../../utils";
import { runAdaptiveReadWorker } from "../rebuild-controller";
import type { AdaptivePlan, AdaptiveDecision } from "../adaptive-plan";
import { runPortableRebuild } from "./publisher-client";
import type { SyncResult } from "../../extraction";

export interface PortableReadPin {
  graph: CodeGraph;
  identity: string;
  release(): void;
}
const writes = new Set([
  "indexAll",
  "indexFiles",
  "resolveReferencesBatched",
  "clear",
  "optimize",
  "resolveReferences",
  "setPortableCostHistory",
]);
const asyncWrites = new Set([
  "indexAll",
  "indexFiles",
  "resolveReferencesBatched",
]);
const asyncReads = new Set(["getCode", "findRelevantContext", "buildContext"]);
const facades = new Set<PortableFacade>();
const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

class PortableFacade {
  readonly coordinator: PortableCoordinator;
  private reader?: {
    graph: CodeGraph;
    lease: PortableLease;
    identity: string;
    revision: number;
  };
  private active = 0;
  private closed = false;
  private pending = new Set<Promise<unknown>>();
  private maintenance = new Set<Promise<void>>();
  private failed = new Set<{
    graph: { close(): void; whenIdle(): Promise<void> };
    leases: PortableLease[];
  }>();
  private watcher: FileWatcher | null = null;
  private writeMutex = new Mutex();
  private activeWriter?: CodeGraph;
  private readinessGeneration = 0;
  private readinessWatchRevision = 0;
  private watchRevisionOffset = 0;
  private readinessRevision = 0;
  private lastReadiness: IndexDataReadiness | null = null;
  private aborts = new Set<AbortController>();
  private timer: NodeJS.Timeout;
  readonly facade: CodeGraph;
  constructor(
    private root: string,
    private dataDir: string,
    private factory: (readOnly: boolean) => CodeGraph,
    private readOnly: boolean,
  ) {
    this.coordinator = new PortableCoordinator(dataDir);
    // A live publisher makes recovery busy, but readers may continue in idle.
    try {
      this.coordinator.recover();
    } catch (error) {
      if (!(error instanceof PortableBusyError)) throw error;
    }
    const target = Object.create(null) as Record<PropertyKey, unknown>;
    const getMethod = (key: PropertyKey): unknown => {
      if (Object.prototype.hasOwnProperty.call(target, key)) return target[key];
      const method = this.method(key);
      if (typeof method === "function")
        Object.defineProperty(target, key, {
          value: method,
          writable: true,
          configurable: true,
        });
      return method;
    };
    this.facade = new Proxy(target, {
      get: (_target, key) => getMethod(key),
      getOwnPropertyDescriptor: (_target, key) => {
        getMethod(key);
        return Object.getOwnPropertyDescriptor(target, key);
      },
      set: (_target, key, value) => {
        if (typeof getMethod(key) !== "function" || typeof value !== "function")
          throw new Error("Portable facade state is private");
        target[key] = value;
        return true;
      },
    }) as unknown as CodeGraph;
    this.timer = setInterval(() => {
      try {
        this.retireIdle();
      } catch {
        /* actual requests surface errors */
      }
    }, 20);
    this.timer.unref();
    facades.add(this);
    try {
      this.read((graph) => graph.getStats());
    } catch (error) {
      this.close();
      throw error;
    }
  }
  private track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work);
    void work.then(
      () => this.pending.delete(work),
      () => this.pending.delete(work),
    );
    return work;
  }
  private retireIdle(): void {
    if (this.active || !this.reader) return;
    const state = this.coordinator.snapshot();
    if (
      this.closed ||
      state.mode !== "idle" ||
      state.revision !== this.reader.revision
    )
      this.retire();
  }
  private retire(): void {
    const reader = this.reader;
    if (!reader) return;
    // A failed native close retains the lease and can be retried later.
    reader.graph.close();
    this.reader = undefined;
    const task = this.finishGraph(reader.graph, [reader.lease]);
    this.maintenance.add(task);
    void task.then(
      () => this.maintenance.delete(task),
      () => {},
    );
  }
  private getReader(): NonNullable<PortableFacade["reader"]> {
    if (this.closed) throw new Error("CodeGraph is closed");
    this.retireIdle();
    if (this.coordinator.snapshot().mode !== "idle")
      throw new PortableBusyError("Database publication is draining readers");
    if (!this.reader) {
      const lease = this.coordinator.acquireReader();
      try {
        const revision = this.coordinator.snapshot().revision;
        this.reader = {
          graph: this.factory(true),
          lease,
          identity: randomUUID(),
          revision,
        };
      } catch (error) {
        if (error instanceof DatabaseOpenError && error.connection.isOpen())
          this.failed.add({ graph: error.connection, leases: [lease] });
        else lease.release();
        throw error;
      }
    }
    return this.reader;
  }
  pin(): PortableReadPin {
    const reader = this.getReader();
    this.active++;
    let released = false;
    return {
      graph: reader.graph,
      identity: reader.identity,
      release: () => {
        if (released) return;
        released = true;
        this.active--;
        this.retireIdle();
      },
    };
  }
  private read<T>(action: (graph: CodeGraph) => T): T {
    const pin = this.pin();
    try {
      const value = action(pin.graph);
      if (value && typeof (value as any).then === "function")
        return Promise.resolve(value).finally(() => pin.release()) as T;
      pin.release();
      return value;
    } catch (error) {
      pin.release();
      throw error;
    }
  }
  private async readAsync<T>(
    action: (graph: CodeGraph) => T | Promise<T>,
  ): Promise<T> {
    const deadline = performance.now() + 2000;
    while (true) {
      try {
        return await this.read(action);
      } catch (error) {
        if (
          !(error instanceof PortableBusyError) ||
          performance.now() >= deadline
        )
          throw error;
        await pause(10);
      }
    }
  }
  private async writerLease(signal?: AbortSignal): Promise<PortableLease> {
    const deadline = performance.now() + 30 * 60 * 1000;
    while (true) {
      signal?.throwIfAborted();
      try {
        return this.coordinator.acquireWriter();
      } catch (error) {
        if (
          !(error instanceof PortableBusyError) ||
          performance.now() >= deadline
        )
          throw error;
        await pause(20);
      }
    }
  }
  private async write<T>(
    action: (graph: CodeGraph) => Promise<T> | T,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.readOnly) throw new Error("CodeGraph is read-only");
    return this.writeMutex.withLock(async () => {
      const writer = await this.writerLease(signal);
      let lease: PortableLease | undefined;
      let graph: CodeGraph | undefined;
      try {
        this.coordinator.recover();
        this.coordinator.markMutation();
        lease = this.coordinator.acquireReader();
        graph = this.factory(false);
        this.activeWriter = graph;
        this.readinessGeneration++;
        this.readinessWatchRevision =
          this.watchRevisionOffset + (this.watcher?.getChangeRevision() ?? 0);
        this.readinessRevision = this.coordinator.snapshot().revision;
        this.lastReadiness = null;
        return await action(graph);
      } catch (error) {
        if (
          !graph &&
          error instanceof DatabaseOpenError &&
          error.connection.isOpen()
        ) {
          this.failed.add({
            graph: error.connection,
            leases: [...(lease ? [lease] : []), writer],
          });
          lease = undefined;
          throw error;
        }
        throw error;
      } finally {
        if (graph) {
          try {
            this.lastReadiness = graph.getIndexDataReadiness();
          } catch {
            this.lastReadiness = null;
          }
        }
        this.activeWriter = undefined;
        if (graph)
          await this.finishGraph(graph, [...(lease ? [lease] : []), writer]);
        else if (
          ![...this.failed].some((item) => item.leases.includes(writer))
        ) {
          lease?.release();
          writer.release();
        }
      }
    });
  }
  private async finishGraph(
    graph: { close(): void; whenIdle(): Promise<void> },
    leases: PortableLease[],
  ): Promise<void> {
    const entry = { graph, leases };
    this.failed.add(entry);
    graph.close();
    await graph.whenIdle();
    for (const lease of leases) lease.release();
    this.failed.delete(entry);
  }
  private writeSync<T>(action: (graph: CodeGraph) => T): T {
    if (this.readOnly) throw new Error("CodeGraph is read-only");
    const writer = this.coordinator.acquireWriter();
    let lease: PortableLease | undefined;
    let graph: CodeGraph | undefined;
    try {
      this.coordinator.recover();
      this.coordinator.markMutation();
      lease = this.coordinator.acquireReader();
      graph = this.factory(false);
      return action(graph);
    } catch (error) {
      if (
        !graph &&
        error instanceof DatabaseOpenError &&
        error.connection.isOpen()
      )
        this.failed.add({
          graph: error.connection,
          leases: [...(lease ? [lease] : []), writer],
        });
      throw error;
    } finally {
      if (graph) {
        const task = this.finishGraph(graph, [
          ...(lease ? [lease] : []),
          writer,
        ]);
        this.maintenance.add(task);
        void task.then(
          () => this.maintenance.delete(task),
          () => {},
        );
      } else if (
        ![...this.failed].some((item) => item.leases.includes(writer))
      ) {
        lease?.release();
        writer.release();
      }
    }
  }
  private async sync(options: SyncOptions): Promise<SyncResult> {
    if (this.readOnly) throw new Error("CodeGraph is read-only");
    const abort = new AbortController();
    this.aborts.add(abort);
    const originalSignal = options.signal;
    const cancel = () => abort.abort();
    originalSignal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) abort.abort();
    const started = performance.now();
    this.lastReadiness = null;
    let published: SyncResult | undefined;
    let fallbackReason: string | undefined;
    try {
      options = { ...options, signal: abort.signal };
      // Durable source reconciliation is never bypassed by scoped paths/adaptive opt-out.
      const catchup = async (): Promise<SyncResult | null> =>
        this.write(async (graph) => {
          if (!graph.getPortableCatchup()) return null;
          let result = published;
          while (true) {
            abort.signal.throwIfAborted();
            const evaluation = await runAdaptiveReadWorker<{
              plan?: AdaptivePlan;
              decision: AdaptiveDecision;
              configurationChanged?: boolean;
            }>(
              {
                type: "evaluate",
                root: this.root,
                databasePath: graph.getDatabaseFilePath(),
                portable: true,
                fullHash: true,
                eligibility: { upgradeRequired: graph.isIndexStale() },
              } as any,
              { signal: abort.signal },
            );
            if (!evaluation.plan)
              throw new Error(
                "Pending source reconciliation could not inspect the complete source inventory",
              );
            if (
              evaluation.plan.changedFiles === 0 &&
              !evaluation.configurationChanged && !graph.isIndexStale() &&
              graph.getIndexCompleteness().status === "complete" &&
              !graph.hasPortableCatchupWork()
            ) {
              if (published)
                graph.recordPortableFullCost(performance.now() - started);
              graph.clearPortableCatchup();
              return (
                result ?? {
                  complete: true,
                  filesChecked: evaluation.plan.totalFiles,
                  filesAdded: 0,
                  filesModified: 0,
                  filesRemoved: 0,
                  nodesUpdated: 0,
                  durationMs: performance.now() - started,
                }
              );
            }
            result = await graph.sync({
              ...options,
              adaptive: false,
              paths: undefined,
              forceReindexPaths: evaluation.plan.modified,
            });
            if (result.complete !== true)
              throw new Error(
                "Post-publication source reconciliation incomplete; pending marker retained",
              );
          }
        }, abort.signal);
      while (true) {
        if (this.read((graph) => graph.getPortableCatchup())) {
          const reconciled = await catchup();
          if (reconciled)
            return {
              ...reconciled,
              adaptive:
                published?.adaptive ??
                (fallbackReason
                  ? { strategy: "incremental", reason: fallbackReason }
                  : reconciled.adaptive),
              durationMs: performance.now() - started,
            };
        }
        if (!fallbackReason && options.adaptive !== false &&
            process.env.CODEGRAPH_ADAPTIVE_SYNC !== "0") {
          const evaluation = await this.readAsync((graph) =>
            runAdaptiveReadWorker<{
              plan?: AdaptivePlan;
              decision: AdaptiveDecision;
            }>(
              {
                type: "evaluate",
                root: this.root,
                databasePath: graph.getDatabaseFilePath(),
                portable: true,
                paths: options.paths,
                eligibility: {
                  upgradeRequired: graph.isIndexStale(),
                  fallback: options.adaptiveFallback,
                },
              } as any,
              { signal: abort.signal },
            ),
          );
          try {
            options.onAdaptiveDecision?.(evaluation.decision);
          } catch {
            /* diagnostics cannot change publication */
          }
          const message = `[adaptive-sync] ${JSON.stringify({ ...evaluation.decision, at: new Date().toISOString() })}`;
          if (options.verbose) console.error(message);
          try {
            const log = path.join(this.dataDir, "adaptive-sync.log");
            if (existsSync(log) && statSync(log).size > 1024 * 1024)
              renameSync(log, log + ".1");
            appendFileSync(log, message + "\n");
          } catch {
            /* best effort diagnostics */
          }
          if (evaluation.decision.strategy === "rebuild") {
            try {
              published = await runPortableRebuild(
                this.root,
                this.dataDir,
                options,
              );
            } catch (error) {
              abort.signal.throwIfAborted();
              // Only fall back after child exit AND successful fenced recovery.
              // If publication committed, the next loop must honor its DB marker.
              await this.write((graph) => {
                graph.getStats();
                if (!graph.getPortableCatchup())
                  graph.setPortableCatchup(randomUUID());
              }, abort.signal);
              fallbackReason = `rebuild-fallback: ${error instanceof Error ? error.message : String(error)}`;
            }
            // Cached idle readers observe the revision before any further query.
            this.retireIdle();
            continue;
          }
        }
        const incremental = await this.write(
          (graph) => graph.sync({ ...options, adaptive: false }),
          abort.signal,
        );
        return fallbackReason
          ? {
              ...incremental,
              adaptive: { strategy: "incremental", reason: fallbackReason },
            }
          : incremental;
      }
    } finally {
      originalSignal?.removeEventListener("abort", cancel);
      this.aborts.delete(abort);
    }
  }
  private close(): void {
    if (this.closed) return;
    if (this.active || this.pending.size)
      throw new Error(
        "Portable graph has active operations; abort and await whenIdle before closing",
      );
    this.retire();
    this.closed = true;
    this.watcher?.stop();
    this.watcher = null;
    clearInterval(this.timer);
    if (!this.maintenance.size && !this.failed.size) facades.delete(this);
    else
      void this.idle().catch(() => {
        /* retained until explicit retry/process exit */
      });
  }
  private async idle(): Promise<void> {
    while (this.pending.size || this.maintenance.size) {
      const tasks = [...this.pending, ...this.maintenance];
      await Promise.allSettled(tasks);
      for (const task of tasks) this.maintenance.delete(task as Promise<void>);
    }
    for (const entry of [...this.failed]) {
      entry.graph.close();
      await entry.graph.whenIdle();
      for (const lease of entry.leases) lease.release();
      this.failed.delete(entry);
    }
    if (this.closed) facades.delete(this);
  }
  private method(key: PropertyKey): unknown {
    if (typeof key !== "string") return undefined;
    if (key === "then") return undefined;
    if (key === "constructor") return this.read((graph) => graph.constructor);
    if (key === "isPortableStorage") return () => true;
    if (key === "acquirePortableRead") return () => this.pin();
    if (key === "acquirePortableReadAsync")
      return async () => {
        const deadline = performance.now() + 2000;
        while (true) {
          try {
            return this.pin();
          } catch (error) {
            if (
              !(error instanceof PortableBusyError) ||
              performance.now() >= deadline
            )
              throw error;
            await pause(10);
          }
        }
      };
    if (key === "getDatabaseIdentity")
      return () => this.read(() => this.reader!.identity);
    if (key === "getProjectRoot") return () => this.root;
    if (key === "getDataDirectory") return () => this.dataDir;
    if (key === "getDatabaseFilePath")
      return () => path.join(this.dataDir, "codegraph.db");
    if (key === "close" || key === "destroy") return () => this.close();
    if (key === "whenIdle") return () => this.idle();
    if (key === "abortActiveWork")
      return () => {
        for (const abort of this.aborts) abort.abort();
      };
    if (key === "isIndexing")
      return () => this.writeMutex.isLocked() || this.aborts.size > 0;
    if (key === "getIndexDataReadiness")
      return () => {
        const state =
          this.activeWriter?.getIndexDataReadiness() ?? this.lastReadiness;
        if (!state) return null;
        const current =
          this.watchRevisionOffset +
            (this.watcher?.getChangeRevision() ?? 0) ===
            this.readinessWatchRevision &&
          this.coordinator.snapshot().revision === this.readinessRevision;
        const complete =
          this.activeWriter ||
          this.read(
            (graph) => graph.getIndexCompleteness().status !== "incomplete",
          );
        return {
          generation: this.readinessGeneration,
          symbolsReady: !!current && !!complete && state.symbolsReady,
          relationshipsReady:
            !!current && !!complete && state.relationshipsReady,
        };
      };
    if (key === "watch")
      return (options: WatchOptions = {}) => {
        if (this.readOnly) throw new Error("CodeGraph is read-only");
        if (this.watcher?.isActive()) return true;
        this.watchRevisionOffset += this.watcher?.getChangeRevision() ?? 0;
        this.watcher = new FileWatcher(
          this.root,
          async (paths) => {
            const result = await this.facade.sync({ paths });
            if (result.filesChecked === 0 && result.durationMs === 0)
              throw new LockUnavailableError();
            return {
              filesChanged:
                result.filesAdded + result.filesModified + result.filesRemoved,
              durationMs: result.durationMs,
            };
          },
          options,
        );
        return this.watcher.start();
      };
    if (key === "unwatch")
      return () => {
        this.watchRevisionOffset += this.watcher?.getChangeRevision() ?? 0;
        this.watcher?.stop();
        this.watcher = null;
      };
    if (key === "isWatching") return () => this.watcher?.isActive() ?? false;
    if (key === "getPendingFiles")
      return () => this.watcher?.getPendingFiles() ?? [];
    if (key === "waitUntilWatcherReady")
      return (timeout?: number) =>
        this.watcher?.waitUntilReady(timeout) ?? Promise.resolve();
    if (key === "uninitialize")
      return () => {
        if (this.readOnly) throw new Error("CodeGraph is read-only");
        throw new Error("Stop all processes before removing portable storage");
      };
    if (key === "sync")
      return (options: SyncOptions = {}) => this.track(this.sync(options));
    if (writes.has(key))
      return (...args: unknown[]) =>
        asyncWrites.has(key)
          ? this.track(this.write((graph) => (graph as any)[key](...args)))
          : this.writeSync((graph) => (graph as any)[key](...args));
    return (...args: unknown[]) =>
      asyncReads.has(key)
        ? this.track(this.readAsync((graph) => (graph as any)[key](...args)))
        : this.read((graph) => {
            const method = (graph as any)[key];
            if (typeof method !== "function")
              throw new Error(`Unknown CodeGraph method: ${key}`);
            return method.apply(graph, args);
          });
  }
}
export function createPortableFacade(
  root: string,
  dataDir: string,
  factory: (readOnly: boolean) => CodeGraph,
  readOnly = false,
): CodeGraph {
  return new PortableFacade(root, dataDir, factory, readOnly).facade;
}
