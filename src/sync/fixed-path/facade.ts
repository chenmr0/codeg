import type { SyncResult } from '../../extraction';
import { runAdaptiveReadWorker } from '../rebuild-controller';
import type { AdaptivePlan, AdaptiveDecision } from '../adaptive-plan';
import { runFixedPathRebuild } from './rebuild';
import type { CodeGraph, SyncOptions } from '../../index';
import { FileWatcher, LockUnavailableError, type WatchOptions } from '../watcher';
import { FixedPathController, type FixedPathPin, type FixedPathProject } from './controller';

const asynchronousReads = new Set(['getCode', 'findRelevantContext', 'buildContext']);
const asynchronousWrites = new Set(['indexAll', 'indexFiles', 'sync', 'resolveReferencesBatched']);
const synchronousWrites = new Set(['clear', 'optimize', 'resolveReferences']);
const synchronousReads = new Set([
  'getChangedFiles', 'getLastIndexedAt', 'getIndexBuildInfo', 'getIndexCompleteness', 'isIndexStale',
  'extractFromSource', 'getPendingReferenceCount', 'getDetectedFrameworks', 'reinitializeResolver',
  'getStats', 'getBackend', 'getJournalMode', 'getNode', 'getNodesInFile', 'getNodesByKind',
  'getNodesByName', 'getNodesBySymbolExact', 'searchNodes', 'getProjectNameTokens', 'getTopRouteFile',
  'getRoutingManifest', 'getOutgoingEdges', 'getIncomingEdges', 'getDirectRelationshipGroups',
  'getFile', 'getFiles', 'getContext', 'traverse', 'getCallGraph', 'getTypeHierarchy', 'findUsages',
  'getCallers', 'getCallees', 'getImpactRadius', 'findPath', 'getAncestors', 'getChildren',
  'getFileDependencies', 'getFileDependents', 'findCircularDependencies', 'findDeadCode', 'getNodeMetrics',
]);
export interface FixedPathFacade {
  acquireFixedPathRead(): FixedPathPin<CodeGraph>;
  getDatabaseIdentity(): string;
}
/** Explicit public API dispatch. Unknown methods/properties cannot expose a stale
 * native handle. Watcher state belongs to the facade, not a replaceable reader.
 */
export function createFixedPathFacade(project: FixedPathProject, prototype: object,
  factory: ConstructorParameters<typeof FixedPathController<CodeGraph>>[1], readOnly = false): CodeGraph {
  const controller = new FixedPathController(project, factory);
  let watcher: FileWatcher | null = null;
  const methods = new Map<string, (...args: any[]) => any>();
  let facade: CodeGraph;
  const builds = new Set<AbortController>();
  const operations = new Set<AbortController>();
  const rebuilds = new Set<Promise<unknown>>();
  const invoke = (graph: CodeGraph, key: string, args: unknown[]): unknown =>
    (Reflect.get(graph, key) as (...args: unknown[]) => unknown).apply(graph, args);
  const assertWritable = (): void => { if (readOnly) throw new Error('This CodeGraph facade is read-only'); };
  const close = (): void => { if (rebuilds.size) throw new Error('Cannot close during fixed-path sync; abortActiveWork() and await whenIdle() first'); controller.close(); watcher?.stop(); watcher = null; };
  methods.set('close', close); methods.set('destroy', close);
  methods.set('getProjectRoot', () => project.project);
  methods.set('getDataDirectory', () => project.dataDirectory);
  methods.set('getDatabaseFilePath', () => controller.readSync(graph => graph.getDatabaseFilePath()));
  methods.set('getDatabaseIdentity', () => controller.currentIdentity());
  methods.set('acquireFixedPathRead', () => controller.pin());
  methods.set('whenIdle', async () => { await Promise.allSettled([...rebuilds]); await controller.whenIdle(); });
  methods.set('isIndexing', () => controller.isWriting || rebuilds.size > 0);
  // Reopened readers cannot inherit a completed in-memory writer proof.
  methods.set('getIndexDataReadiness', () => null);
  methods.set('abortActiveWork', () => { for (const operation of operations) operation.abort(); for (const build of builds) build.abort(); });
  methods.set('watch', (options: WatchOptions = {}) => {
    assertWritable();
    if (watcher?.isActive()) return true;
    watcher = new FileWatcher(project.project, async paths => {
      const result = await facade.sync({ paths });
      if (result.filesChecked === 0 && result.durationMs === 0) throw new LockUnavailableError();
      return { filesChanged: result.filesAdded + result.filesModified + result.filesRemoved, durationMs: result.durationMs };
    }, options);
    return watcher.start();
  });
  methods.set('unwatch', () => { watcher?.stop(); watcher = null; });
  methods.set('isWatching', () => watcher?.isActive() ?? false);
  methods.set('getPendingFiles', () => watcher?.getPendingFiles() ?? []);
  methods.set('waitUntilWatcherReady', (timeout?: number) => watcher?.waitUntilReady(timeout) ?? Promise.resolve());
  methods.set('uninitialize', () => { throw new Error('Fixed-path removal requires explicit offline removal of all participating processes'); });
  for (const key of synchronousReads) methods.set(key, (...args) => controller.readSync(graph => invoke(graph, key, args)));
  for (const key of asynchronousReads) methods.set(key, async (...args) => controller.read(graph => invoke(graph, key, args)));
  for (const key of synchronousWrites) methods.set(key, (...args) => { assertWritable(); return controller.writeSync(graph => invoke(graph, key, args)); });
  for (const key of asynchronousWrites) methods.set(key, async (...args) => { assertWritable(); return controller.write(graph => invoke(graph, key, args)); });
  methods.set('sync', async (options: SyncOptions = {}) => {
    assertWritable();
    const cancellation = new AbortController();
    operations.add(cancellation);
    options = { ...options, signal: options.signal ? AbortSignal.any([options.signal, cancellation.signal]) : cancellation.signal };
    const operation = (async () => {
      const started = performance.now();
      let published: SyncResult | undefined;
      while (true) {
      const supportedRuntime = !process.env.NODE_OPTIONS?.trim() && process.execArgv.every(arg =>
        arg === '--liftoff-only' || /^--max[-_]old[-_]space[-_]size=\d+$/.test(arg) || /^--test(?:$|[-=])/.test(arg));
      if (options.adaptive !== false && process.env.CODEGRAPH_ADAPTIVE_SYNC !== '0' && supportedRuntime) {
        // Heavy planning runs off-thread while one genuine reader operation
        // protects the underlying file through worker exit.
        const baselineRevision = controller.currentRevision();
        const evaluation = await controller.read(graph => runAdaptiveReadWorker<{ plan?: AdaptivePlan; decision: AdaptiveDecision }>({
          type: 'evaluate', root: project.project, databasePath: graph.getDatabaseFilePath(), paths: published ? undefined : options.paths,
          eligibility: { upgradeRequired: graph.isIndexStale(), fallback: options.adaptiveFallback },
          fullHash: !!published,
        }, { signal: options.signal }));
        if (controller.currentRevision() !== baselineRevision) throw new Error('Database changed during adaptive planning; retry sync');
        try { options.onAdaptiveDecision?.(evaluation.decision); } catch { /* diagnostics only */ }
        if (published && evaluation.plan?.changedFiles === 0 && evaluation.decision.strategy === 'incremental') {
          published.durationMs = performance.now() - started;
          return published;
        }
        if (published && !evaluation.plan) throw new Error('Post-publication source verification could not establish a complete owned index');
        if (evaluation.decision.strategy === 'rebuild' && evaluation.plan) {
          const abort = new AbortController(); builds.add(abort);
          const cancel = (): void => abort.abort();
          options.signal?.addEventListener('abort', cancel, { once: true });
          if (options.signal?.aborted) abort.abort();
          try {
            published = await runFixedPathRebuild(project, evaluation.plan, { expectedRevision: baselineRevision, signal: abort.signal, onProgress: options.onProgress });
            // Source may change after the preflight observation. Recheck the
            // published graph with full content hashes off-thread and converge
            // automatically; this is not instantaneous source consistency.
            continue;
          } finally { builds.delete(abort); options.signal?.removeEventListener('abort', cancel); }
        }
      }
      const incremental = await controller.write(graph => graph.sync({ ...options, paths: published ? undefined : options.paths, adaptive: false }));
      if (!published) return incremental;
      if (incremental.complete === false) throw new Error('Post-publication incremental reconciliation is incomplete');
      published = { ...incremental, adaptive: published.adaptive, durationMs: performance.now() - started };
      }
    })();
    rebuilds.add(operation);
    const finished = (): void => { rebuilds.delete(operation); operations.delete(cancellation); };
    void operation.then(finished, finished);
    return operation;
  });
  facade = new Proxy(Object.create(prototype) as CodeGraph, {
    get(_target, key) { return typeof key === 'string' ? methods.get(key) : undefined; },
    set() { throw new Error('Fixed-path facade state is private'); },
  });
  // Fail a corrupt/missing public replacement at open, not later on first query.
  try { controller.readSync(graph => graph.getStats()); }
  catch (error) { controller.close(); throw error; }
  return facade;
}
