/**
 * CodeGraph
 *
 * A local-first code intelligence system that builds a semantic
 * knowledge graph from any codebase.
 */

import * as path from 'path';
import {
  Node,
  Edge,
  FileRecord,
  ExtractionResult,
  Subgraph,
  TraversalOptions,
  SearchOptions,
  SearchResult,
  Context,
  GraphStats,
  TaskInput,
  TaskContext,
  BuildContextOptions,
  FindRelevantContextOptions,
  RelationshipDirection,
  EdgeKind,
  DirectRelationshipGroup,
} from './types';
import { DatabaseConnection, getDatabasePath } from './db';
import { WalCheckpointValve } from './db/wal-valve';
import { QueryBuilder } from './db/queries';
import {
  isInitialized,
  createDirectory,
  removeDirectory,
  validateDirectory,
} from './directory';
import {
  ExtractionOrchestrator,
  IndexProgress,
  IndexResult,
  SyncResult,
  extractFromSource,
  initGrammars,
} from './extraction';
import {
  ReferenceResolver,
  createResolver,
  ResolutionResult,
} from './resolution';
import { GraphTraverser, GraphQueryManager } from './graph';
import { ContextBuilder, createContextBuilder } from './context';
import { Mutex, FileLock, canonicalFilePath } from './utils';
import { FileWatcher, WatchOptions, PendingFile, LockUnavailableError } from './sync';
import { EXTRACTION_VERSION } from './extraction/extraction-version';
import { SyncRetryState } from './extraction/sync-retry-state';
import {
  collectPersistedIndexDiagnostics,
  isDeclarationMacroRecoverySkipped,
} from './extraction/diagnostics';
import { getCodeGraphDir } from './directory';
import { deriveProjectNameTokens } from './search/query-utils';
import { CodeGraphPackageVersion } from './mcp/version';
import { ResolutionDiagnostics, measureResolution } from './resolution/diagnostics';
import { syncNameLookupMode } from './resolution/name-lookup';

// Re-export types for consumers
export * from './types';
// Storage building blocks for embedded/SDK consumers that drive the graph
// directly (open a DB, run prepared queries) rather than through the CodeGraph
// facade. Exposed from the package entry so they no longer require deep imports
// into dist/ (issue #354).
export { getDatabasePath, DatabaseConnection } from './db';
export { QueryBuilder } from './db/queries';
export {
  getCodeGraphDir,
  isInitialized,
  findNearestCodeGraphRoot,
  CODEGRAPH_DIR,
} from './directory';
export { IndexProgress, IndexResult, SyncResult } from './extraction';
export { detectLanguage, isLanguageSupported, isGrammarLoaded, getSupportedLanguages, initGrammars, loadGrammarsForLanguages, loadAllGrammars } from './extraction';
export { ResolutionResult } from './resolution';
export {
  CodeGraphError,
  FileError,
  ParseError,
  DatabaseError,
  SearchError,
  VectorError,
  ConfigError,
  Logger,
  setLogger,
  getLogger,
  silentLogger,
  defaultLogger,
} from './errors';
export { Mutex, FileLock, processInBatches, debounce, throttle, MemoryMonitor } from './utils';
export { FileWatcher, WatchOptions, PendingFile, LockUnavailableError } from './sync';
export { MCPServer } from './mcp';

/** A sync made partial progress but left one or more changed files stale. */
export class SyncIncompleteError extends Error {
  constructor(public readonly result: SyncResult) {
    const failed = result.failedFilePaths ?? [];
    const sample = failed.slice(0, 3).join(', ');
    const suffix = failed.length > 3 ? ` (+${failed.length - 3} more)` : '';
    super(
      `CodeGraph sync incomplete: ${result.filesErrored ?? failed.length} file(s) failed` +
      (sample ? ` (${sample}${suffix})` : ''),
    );
    this.name = 'SyncIncompleteError';
  }
}

/**
 * Options for initializing a new CodeGraph project
 */
export interface InitOptions {
  /** Whether to run initial indexing after init */
  index?: boolean;

  /** Progress callback for indexing */
  onProgress?: (progress: IndexProgress) => void;
}

/**
 * Options for opening an existing CodeGraph project
 */
export interface OpenOptions {
  /** Whether to run sync if files have changed */
  sync?: boolean;

  /** Whether to run in read-only mode */
  readOnly?: boolean;
}

/**
 * Options for indexing
 */
export interface IndexOptions {
  /** Progress callback */
  onProgress?: (progress: IndexProgress) => void;

  /** Abort signal for cancellation */
  signal?: AbortSignal;

  /** Enable verbose logging (worker lifecycle, memory, timeouts) */
  verbose?: boolean;
}

/** Options for incremental synchronization. */
export interface SyncOptions extends IndexOptions {
  /**
   * Exact project-relative source paths reported by the file watcher.
   * @internal Callers without a complete event set must leave this undefined.
   */
  paths?: string[];
}

/**
 * Main CodeGraph class
 *
 * Provides the primary interface for interacting with the code knowledge graph.
 */
export class CodeGraph {
  private db: DatabaseConnection;
  private queries: QueryBuilder;
  private projectRoot: string;
  private orchestrator: ExtractionOrchestrator;
  private resolver: ReferenceResolver;
  private graphManager: GraphQueryManager;
  private traverser: GraphTraverser;
  private contextBuilder: ContextBuilder;

  // Mutex for preventing concurrent indexing operations (in-process)
  private indexMutex = new Mutex();

  // File lock for preventing concurrent writes across processes (CLI, MCP, git hooks)
  private fileLock: FileLock;

  // File watcher for auto-sync on file changes
  private watcher: FileWatcher | null = null;

  private constructor(
    db: DatabaseConnection,
    queries: QueryBuilder,
    projectRoot: string
  ) {
    this.db = db;
    this.queries = queries;
    this.projectRoot = projectRoot;
    // Down-weight the project name as a query term in search ranking — it names
    // the whole repo, not a symbol, so it has no discriminative value (#720).
    try {
      this.queries.setProjectNameTokens(deriveProjectNameTokens(projectRoot));
    } catch {
      // Best-effort: ranking still works without it.
    }
    this.fileLock = new FileLock(
      path.join(getCodeGraphDir(projectRoot), 'codegraph.lock')
    );
    this.orchestrator = new ExtractionOrchestrator(projectRoot, queries);
    this.resolver = createResolver(projectRoot, queries);
    this.graphManager = new GraphQueryManager(queries);
    this.traverser = new GraphTraverser(queries);
    this.contextBuilder = createContextBuilder(
      projectRoot,
      queries,
      this.traverser
    );
  }

  // ===========================================================================
  // Lifecycle Methods
  // ===========================================================================

  /**
   * Initialize a new CodeGraph project
   *
   * Creates the .CodeGraph directory, database, and configuration.
   *
   * @param projectRoot - Path to the project root directory
   * @param options - Initialization options
   * @returns A new CodeGraph instance
   */
  static async init(projectRoot: string, options: InitOptions = {}): Promise<CodeGraph> {
    await initGrammars();
    const resolvedRoot = path.resolve(projectRoot);

    // Check if already initialized
    if (isInitialized(resolvedRoot)) {
      throw new Error(`CodeGraph already initialized in ${resolvedRoot}`);
    }

    // Create directory structure
    createDirectory(resolvedRoot);

    // Initialize database
    const dbPath = getDatabasePath(resolvedRoot);
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    const instance = new CodeGraph(db, queries, resolvedRoot);

    // Run initial indexing if requested
    if (options.index) {
      const result = await instance.indexAll({ onProgress: options.onProgress });
      // `success` means a usable index was produced. `complete` is a separate
      // coverage signal: optional synthesis/framework phases may be incomplete
      // while the base database remains valid and queryable.
      if (!result.success) {
        instance.destroy();
        const errors = result.errors.filter((diagnostic) => diagnostic.severity === 'error');
        const detail = (errors.length > 0 ? errors : result.errors)
          .map((diagnostic) => diagnostic.message)
          .join('; ');
        throw new Error(detail || 'Initial indexing failed');
      }
    }

    return instance;
  }

  /**
   * Initialize synchronously (without indexing)
   */
  static initSync(projectRoot: string): CodeGraph {
    const resolvedRoot = path.resolve(projectRoot);

    // Check if already initialized
    if (isInitialized(resolvedRoot)) {
      throw new Error(`CodeGraph already initialized in ${resolvedRoot}`);
    }

    // Create directory structure
    createDirectory(resolvedRoot);

    // Initialize database
    const dbPath = getDatabasePath(resolvedRoot);
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    return new CodeGraph(db, queries, resolvedRoot);
  }

  /**
   * Open an existing CodeGraph project
   *
   * @param projectRoot - Path to the project root directory
   * @param options - Open options
   * @returns A CodeGraph instance
   */
  static async open(projectRoot: string, options: OpenOptions = {}): Promise<CodeGraph> {
    await initGrammars();
    const resolvedRoot = path.resolve(projectRoot);

    // Check if initialized
    if (!isInitialized(resolvedRoot)) {
      throw new Error(`CodeGraph not initialized in ${resolvedRoot}. Run init() first.`);
    }

    // Validate directory structure
    const validation = validateDirectory(resolvedRoot);
    if (!validation.valid) {
      throw new Error(`Invalid CodeGraph directory: ${validation.errors.join(', ')}`);
    }

    // Open database
    const dbPath = getDatabasePath(resolvedRoot);
    const db = DatabaseConnection.open(dbPath);
    const queries = new QueryBuilder(db.getDb());

    const instance = new CodeGraph(db, queries, resolvedRoot);

    // Sync if requested
    if (options.sync) {
      await instance.sync();
    }

    return instance;
  }

  /**
   * Open synchronously (without sync)
   */
  static openSync(projectRoot: string): CodeGraph {
    const resolvedRoot = path.resolve(projectRoot);

    // Check if initialized
    if (!isInitialized(resolvedRoot)) {
      throw new Error(`CodeGraph not initialized in ${resolvedRoot}. Run init() first.`);
    }

    // Validate directory structure
    const validation = validateDirectory(resolvedRoot);
    if (!validation.valid) {
      throw new Error(`Invalid CodeGraph directory: ${validation.errors.join(', ')}`);
    }

    // Open database
    const dbPath = getDatabasePath(resolvedRoot);
    const db = DatabaseConnection.open(dbPath);
    const queries = new QueryBuilder(db.getDb());

    return new CodeGraph(db, queries, resolvedRoot);
  }

  /**
   * Check if a directory has been initialized as a CodeGraph project
   */
  static isInitialized(projectRoot: string): boolean {
    return isInitialized(path.resolve(projectRoot));
  }

  /**
   * Close the CodeGraph instance and release resources
   */
  close(): void {
    this.unwatch();
    // Release file lock if held
    this.fileLock.release();
    this.db.close();
  }

  /**
   * Get the project root directory
   */
  getProjectRoot(): string {
    return this.projectRoot;
  }

  // ===========================================================================
  // Indexing
  // ===========================================================================

  /**
   * Index all files in the project
   *
   * Uses a mutex to prevent concurrent indexing operations.
   */
  async indexAll(options: IndexOptions = {}): Promise<IndexResult> {
    return this.indexMutex.withLock(async () => {
      try {
        this.fileLock.acquire();
      } catch {
        return { success: false, filesIndexed: 0, filesSkipped: 0, filesErrored: 0, nodesCreated: 0, edgesCreated: 0, errors: [{ message: 'Could not acquire file lock - another process may be indexing', severity: 'error' as const }], durationMs: 0 };
      }
      try {
        const before = this.queries.getNodeAndEdgeCount();
        const freshDb = before.nodes === 0;

        // A completely fresh node:sqlite database is disposable until this
        // run finishes, so avoid rollback-journal fsync during construction.
        // Existing databases and the sql.js fallback retain durable defaults.
        let fastInit =
          freshDb &&
          this.db.getBackend() === 'node-sqlite' &&
          process.env.CODEGRAPH_NO_FAST_INIT !== '1';
        if (fastInit) {
          try {
            this.db.getDb().pragma('journal_mode = MEMORY');
            this.db.getDb().pragma('synchronous = OFF');
          } catch {
            fastInit = false;
          }
        }

        // WAL checkpoint valve (#1231): defer auto-checkpointing during the bulk
        // index so the store is pure sequential WAL appends instead of re-writing
        // hot B-tree/FTS pages over and over (the difference between 45s and 19+
        // minutes on HDD-class storage). The valve bounds WAL growth off-thread
        // so deferral can't fill the disk. Only in WAL mode — on the WASM backend
        // (or any mount where WAL couldn't be enabled) getJournalMode() is 'delete'
        // and the whole mechanism is a no-op. CODEGRAPH_NO_WAL_DEFER=1 disables it.
        const deferWal =
          !fastInit &&
          process.env.CODEGRAPH_NO_WAL_DEFER !== '1' &&
          this.db.getJournalMode() === 'wal';
        let priorAutocheckpoint = 0;
        const walValve = deferWal
          ? new WalCheckpointValve(this.db, undefined, undefined, options.verbose ? (msg: string) => console.log(`[wal] ${msg}`) : undefined)
          : null;
        if (deferWal) {
          priorAutocheckpoint = this.db.getWalAutocheckpoint();
          this.db.setWalAutocheckpoint(0);
          walValve!.start();
        }

        try {
          const bulkFts =
            process.env.CODEGRAPH_NO_BULK_FTS !== '1';
          const deferParseIndexes =
            freshDb &&
            process.env.CODEGRAPH_NO_PARSE_INDEX_DEFER !== '1';
          let bulkFtsStarted = false;
          let parseIndexesDeferred = false;
          let result: IndexResult;
          let resolutionDiagnostics: NonNullable<ResolutionResult['diagnostics']> = [];
          try {
            if (bulkFts) {
              this.db.beginBulkNodeLoad();
              bulkFtsStarted = true;
            }
            if (deferParseIndexes) {
              this.db.beginBulkParseLoad();
              parseIndexesDeferred = true;
            }
            result = await this.orchestrator.indexAll(
              options.onProgress,
              options.signal,
              options.verbose,
              walValve ? () => walValve.backpressure() : undefined,
              freshDb
                ? {
                    dbPath: this.db.getPath(),
                    fastInit,
                    useWorker: this.db.getBackend() === 'node-sqlite',
                  }
                : null
            );
          } finally {
            try {
              if (parseIndexesDeferred) {
                await this.db.endBulkParseLoad();
              }
            } finally {
              if (bulkFtsStarted) {
                this.db.endBulkNodeLoad();
              }
            }
          }

          // Phase-boundary fold: backfill the ENTIRE WAL before resolution's first
          // read, so the next phase never pages a bulk-write-sized WAL on the main
          // thread (the post-parse read against a multi-GB WAL is what blew the
          // #850 watchdog's 60s window in the #1231 repro).
          if (walValve) await walValve.foldNow();

          // Re-detect frameworks now that the index is populated. The resolver
          // is constructed with createResolver() before any files exist, so
          // framework resolvers whose detect() consults the indexed file list
          // (e.g. UIKit/SwiftUI scanning for imports, swift-objc-bridge looking
          // for both Swift and ObjC files) all return false on that initial pass
          // and silently drop themselves. Re-initializing here gives them a
          // chance to see the actual project before resolution runs.
          if (result.success && result.filesIndexed > 0) {
            this.resolver.initialize();
            // Cross-file finalization (e.g. NestJS RouterModule prefixes). Runs
            // before resolution so updated names show up in subsequent reads.
            this.resolver.runPostExtract();
          }

          // Resolve references to create call/import/extends edges
          if (result.success && result.filesIndexed > 0) {
            // Get count without loading all refs into memory
            const unresolvedCount = this.queries.getUnresolvedReferencesCount();

            options.onProgress?.({
              phase: 'resolving',
              current: 0,
              total: unresolvedCount,
            });

            const resolution = await this.resolveReferencesBatched(
              (current, total) => {
                options.onProgress?.({
                  phase: 'resolving',
                  current,
                  total,
                });
              },
              (current, total) => {
                options.onProgress?.({
                  phase: 'synthesizing',
                  current,
                  total,
                });
              }
            );
            resolutionDiagnostics = resolution.diagnostics ?? [];

            // Second pass: chained calls whose method lives on a supertype the
            // receiver conforms to (protocol-extension / inherited / default-
            // interface). Needs the implements/extends edges the main pass just
            // built, so it runs after resolution (#750).
            this.resolver.resolveChainedCallsViaConformance();
          }

          // Stop the valve and drain any in-flight/backpressure, then refresh
          // planner stats + checkpoint the WAL after bulk writes. runMaintenance
          // now runs the checkpoint off-thread so a multi-GB WAL can't block the
          // main thread past the watchdog window. Best-effort; never load-bearing.
          if (walValve) { walValve.stop(); await walValve.drain(); }
          if (result.success && result.filesIndexed > 0) {
            await this.db.runMaintenance();
          }

          // The orchestrator only sees extraction-phase counts; resolution and
          // synthesizer edges (often >50% of the graph on JVM repos) come later.
          // Recompute against the DB so the CLI summary reports the true totals.
          if (result.success && result.filesIndexed > 0) {
            const after = this.queries.getNodeAndEdgeCount();
            result.nodesCreated = after.nodes - before.nodes;
            result.edgesCreated = after.edges - before.edges;
          }

          // Stamp the index with the engine that built it, so `codegraph status`
          // and `codegraph upgrade` can recommend a re-index when the running
          // engine produces richer extraction than the one on disk. Only on a
          // real full index — a sync touches a subset, so it must NOT advance the
          // extraction stamp (the bulk would still be stale). See extraction-version.ts.
          if (result.success && result.filesIndexed > 0) {
            try {
              this.queries.setMetadata('indexed_with_version', CodeGraphPackageVersion);
              this.queries.setMetadata('indexed_with_extraction_version', String(EXTRACTION_VERSION));
            } catch { /* metadata is advisory — never fail an index over it */ }
          }

          // Keep usability and coverage as independent signals. A recoverable
          // resolution/synthesis/framework diagnostic makes the graph
          // incomplete, but does not invalidate the base database. Fatal
          // indexing failures already set `result.success = false` upstream.
          if (resolutionDiagnostics.length > 0) {
            result.errors.push(...resolutionDiagnostics);
          }
          const hasIncompleteGlobalError = result.errors.some(
            (diagnostic) => diagnostic.severity === 'error' && !diagnostic.filePath
          );
          const hasDeclarationMacroRecoverySkip = result.errors.some(
            isDeclarationMacroRecoverySkipped
          );
          result.complete =
            result.success && result.filesErrored === 0 && !hasIncompleteGlobalError &&
            !hasDeclarationMacroRecoverySkip && resolutionDiagnostics.length === 0;
          try {
            this.queries.setMetadata(
              'index_completeness',
              result.complete ? 'complete' : 'incomplete'
            );
            this.queries.setMetadata(
              'index_diagnostics',
              result.complete
                ? '[]'
                : JSON.stringify(
                    collectPersistedIndexDiagnostics(result.errors, result.filesErrored)
                  )
            );
          } catch { /* the returned diagnostics remain authoritative */ }

          return result;
        } finally {
          // Restore auto-checkpointing even on error/abort so subsequent syncs
          // don't keep running with it disabled.
          if (walValve) { walValve.stop(); await walValve.drain(); }
          if (deferWal) {
            try { this.db.setWalAutocheckpoint(priorAutocheckpoint); } catch { /* best-effort */ }
          }
          if (fastInit) {
            try {
              this.db.getDb().pragma('synchronous = NORMAL');
              this.db.getDb().pragma('journal_mode = WAL');
            } catch {
              // connection may be closing after a failed index
            }
          }
        }
      } finally {
        this.fileLock.release();
      }
    });
  }

  /**
   * Index specific files
   *
   * Uses a mutex to prevent concurrent indexing operations.
   */
  async indexFiles(filePaths: string[]): Promise<IndexResult> {
    return this.indexMutex.withLock(async () => {
      try {
        this.fileLock.acquire();
      } catch {
        return { success: false, filesIndexed: 0, filesSkipped: 0, filesErrored: 0, nodesCreated: 0, edgesCreated: 0, errors: [{ message: 'Could not acquire file lock - another process may be indexing', severity: 'error' as const }], durationMs: 0 };
      }
      try {
        return this.orchestrator.indexFiles(filePaths);
      } finally {
        this.fileLock.release();
      }
    });
  }

  /**
   * Sync with current file state (incremental update)
   *
   * Uses a mutex to prevent concurrent indexing operations.
   */
  async sync(options: SyncOptions = {}): Promise<SyncResult> {
    return this.indexMutex.withLock(async () => {
      try {
        this.fileLock.acquire();
      } catch {
        return { filesChecked: 0, filesAdded: 0, filesModified: 0, filesRemoved: 0, nodesUpdated: 0, durationMs: 0 };
      }
      // Sync updates the same FTS and secondary-index pages as a full index.
      // On a large existing database, SQLite's default 1000-page automatic
      // checkpoint cadence can therefore repeatedly rewrite hot pages even
      // when only a few source files changed. Mirror indexAll's WAL valve for
      // the whole incremental run: append sequentially, bound WAL growth
      // off-thread, and restore the connection policy on every exit path.
      // CODEGRAPH_NO_WAL_DEFER=1 remains the shared escape hatch.
      let deferWal = false;
      let priorAutocheckpoint = 0;
      let walValve: WalCheckpointValve | null = null;
      // Verbose-only attribution of the work AFTER extraction. These are
      // sequential wall intervals, not sums of per-reference CPU timings.
      let tailCheckpoint = 0;
      const tailTimings: Record<string, number> = {};
      const tailMark = (phase: string): void => {
        if (!options.verbose || tailCheckpoint === 0) return;
        const now = performance.now();
        tailTimings[phase] = (tailTimings[phase] ?? 0) + now - tailCheckpoint;
        tailCheckpoint = now;
      };
      try {
        deferWal =
          process.env.CODEGRAPH_NO_WAL_DEFER !== '1' &&
          this.db.getJournalMode() === 'wal';
        if (deferWal) {
          priorAutocheckpoint = this.db.getWalAutocheckpoint();
          this.db.setWalAutocheckpoint(0);
          walValve = new WalCheckpointValve(
            this.db,
            undefined,
            undefined,
            options.verbose ? (msg: string) => console.log(`[wal] ${msg}`) : undefined
          );
          walValve.start();
        }

        const repairedIncludeFiles = this.queries.repairLegacyCppIncludes();
        const retryState = new SyncRetryState(this.queries);
        const recoveredRetryFiles = retryState.filePaths;
        this.orchestrator.setSyncRetryState(retryState);
        const result = await this.orchestrator.sync(
          options.onProgress,
          options.paths,
          options.verbose,
        );
        const hasSuccessfulChangedFiles = (result.changedFilePaths?.length ?? 0) > 0;
        if (options.verbose) tailCheckpoint = performance.now();
        retryState.finishPrimaryExtraction();
        const referenceFiles = [...new Set([
          ...(result.changedFilePaths ?? []), ...recoveredRetryFiles, ...repairedIncludeFiles,
        ])];

        // Fold extraction writes before resolution starts reading the changed
        // graph. Besides bounding the WAL, this avoids making the main thread
        // page through a large unfurled write set at the phase boundary.
        if (walValve) await walValve.foldNow();
        tailMark('prepareAndWalMs');

        // Cross-file finalization (e.g. NestJS RouterModule prefixes). Run on
        // every sync that touched files so edits to `app.module.ts` propagate
        // to controllers in unchanged files. The pass is idempotent and cheap
        // (regex over *.module.ts only).
        if (referenceFiles.length > 0) {
          this.resolver.runPostExtract();
        } else if (result.filesRemoved > 0) {
          // Pure deletion still resolves resurrected incoming references below.
          // Drop name/node caches warmed against the pre-deletion graph.
          this.resolver.clearCaches();
        }

        tailMark('postExtractMs');
        // Resolve references for changed files first. This restores their
        // import edges (e.g. `a.c --imports--> a.h`), which the co-importer
        // query in the next step relies on.
        if (referenceFiles.length > 0) {
          const detail = options.verbose ? new ResolutionDiagnostics() : undefined;
          if (detail) detail.files = referenceFiles.length;
          try {
            const refs = measureResolution(detail, 'loadRefsMs',
              () => this.queries.getUnresolvedReferencesByFiles(referenceFiles));
            this.resolver.resolveAndPersist(refs, (current, total) => {
              options.onProgress?.({ phase: 'resolving', current, total });
            }, detail, syncNameLookupMode(refs.length));
            if (detail) detail.complete = true;
          } finally {
            if (detail) console.log(`[sync] refs-detail ${detail.format()}`);
          }
        }

        tailMark('changedRefsMs');
        // Whole-file deletion cascades incoming edges from unchanged callers.
        // The extraction layer resurrects stamped edges as pending references;
        // resolve just those source files rather than sweeping the whole table.
        const resurrectedRefs = result.resurrectedReferenceSourceFiles?.length
          ? this.queries.getUnresolvedReferencesByFiles(
              result.resurrectedReferenceSourceFiles
            )
          : [];
        if (resurrectedRefs.length > 0) {
          this.resolver.resolveAndPersist(resurrectedRefs, (current, total) => {
            options.onProgress?.({ phase: 'resolving', current, total });
          });
        }

        tailMark('resurrectedRefsMs');
        // A changed file may introduce a symbol needed by references in files
        // that did not change. Retry only failed rows whose final qualified
        // name segment matches a node contributed by the changed files. Stream
        // every matching name in bounded primary-key batches: popular names
        // must not be skipped wholesale merely because they exceed one batch.
        const retryFailedReferences = async (allowFilter: boolean): Promise<void> => {
          const planningStarted = performance.now();
          const eligibility = retryState.plan(allowFilter, result.failedRewireSourceFiles);
          const retryPlan = this.queries.getFailedReferenceRetryPlan(
            eligibility.names,
          );
          const started = performance.now();
          const planningMs = started - planningStarted;
          let visited = 0;
          let attempted = 0;
          const retryDetail = options.verbose ? new ResolutionDiagnostics('failed-retry') : undefined;
          const retryFiles = retryDetail ? new Set<string>() : undefined;
          if (retryPlan.total > 0) {
            options.onProgress?.({
              phase: 'resolving',
              current: 0,
              total: retryPlan.total,
            });

            for (const group of retryPlan.groups) {
              let afterRowId = 0;
              while (afterRowId < group.maxRowId) {
                const batch = this.queries.getFailedReferenceRetryBatch(
                  group.nameTail,
                  afterRowId,
                  group.maxRowId,
                );
                if (batch.length === 0) break;

                const lastRowId = batch[batch.length - 1]!.rowId;
                if (lastRowId === undefined || lastRowId <= afterRowId) {
                  throw new Error(
                    `Failed-reference retry made no primary-key progress for ${group.nameTail}`
                  );
                }

                const eligible = eligibility.filtered ? batch.filter(eligibility.shouldRetry) : batch;
                if (eligible.length > 0) {
                  const batchDetail = retryDetail ? new ResolutionDiagnostics('failed-retry') : undefined;
                  if (retryFiles) for (const ref of eligible) if (ref.filePath) retryFiles.add(ref.filePath);
                  try {
                    // Reuse the same indexed epoch as changed refs. A default
                    // bulk call here would merely move the full-name load into
                    // the retry tail. Row selection and persistence stay intact.
                    this.resolver.resolveAndPersist(eligible, undefined, batchDetail, syncNameLookupMode(eligible.length));
                  } finally {
                    if (retryDetail && batchDetail) retryDetail.add(batchDetail);
                  }
                }
                attempted += eligible.length;
                visited += batch.length;
                afterRowId = lastRowId;
                options.onProgress?.({
                  phase: 'resolving',
                  current: visited,
                  total: retryPlan.total,
                });
                await new Promise<void>((resolve) => setImmediate(resolve));
              }
            }

            // With the index mutex held, every row in the snapshot must be
            // visited exactly once. Never turn an unexpected query/cleanup
            // mismatch into another silently incomplete successful sync.
            if (visited !== retryPlan.total) {
              throw new Error(
                `Failed-reference retry incomplete: visited ${visited} ` +
                  `of ${retryPlan.total} planned row(s)`
              );
            }
          }
          if (options.verbose) {
            if (retryDetail && attempted > 0) {
              retryDetail.files = retryFiles?.size ?? 0;
              retryDetail.complete = true;
              console.log(`[sync] refs-detail ${retryDetail.format()}`);
            }
            console.log(`[sync] failed-ref-retry mode=${eligibility.filtered ? 'safe-comments' : 'full'} ` +
              `proofFiles=${eligibility.proofFiles} safeFiles=${eligibility.safeFiles} ` +
              `names=${eligibility.names.length} scanned=${visited} attempted=${attempted} ` +
              `skipped=${visited - attempted} planMs=${Math.round(planningMs)}ms ` +
              `durationMs=${Math.round(performance.now() - started)}ms`);
          }
        };
        if (retryState.hasWork) {
          await retryFailedReferences(result.complete !== false && result.filesRemoved === 0 &&
            !result.resurrectedReferenceSourceFiles?.length);
        }

        tailMark('failedRefRetryMs');
        // Edge re-wiring (done inside storeExtractionResult during
        // orchestrator.sync()) already restored incoming cross-file edges
        // from unchanged files to the changed files' new nodes.  Only the
        // files whose edges couldn't be re-wired (symbol renamed/removed,
        // or ambiguous overload) need the old co-importer re-index fallback.
        const failedFiles = result.failedRewireSourceFiles?.length
          ? result.failedRewireSourceFiles.filter(
              fp => !(result.changedFilePaths ?? []).includes(fp)
            )
          : [];

        if (failedFiles.length > 0) {
          const successfullyReindexedFiles: string[] = [];
          const recordReindexFailure = (
            filePath: string,
            errors: ExtractionResult['errors'],
          ): void => {
            const reportedErrors = errors.length > 0
              ? errors
              : [{
                  message: 'Fallback re-index produced no storable result',
                  filePath,
                  severity: 'error' as const,
                  code: 'parse_error',
                }];
            result.complete = false;
            result.filesErrored = (result.filesErrored ?? 0) + 1;
            result.failedFilePaths = [
              ...new Set([...(result.failedFilePaths ?? []), filePath]),
            ];
            result.errors = [
              ...(result.errors ?? []),
              ...reportedErrors.map((error) => ({
                ...error,
                filePath: error.filePath ?? filePath,
              })),
            ];
          };

          options.onProgress?.({
            phase: 'parsing',
            current: 0,
            total: failedFiles.length,
            currentFile: failedFiles[0],
          });

          for (let i = 0; i < failedFiles.length; i++) {
            const fp = failedFiles[i]!;
            try {
              const reindexResult = await this.orchestrator.indexFile(fp, { force: true });
              if (reindexResult.stored) {
                successfullyReindexedFiles.push(fp);
                result.filesModified++;
              } else {
                recordReindexFailure(fp, reindexResult.errors);
              }
            } catch (error) {
              recordReindexFailure(fp, [{
                message: error instanceof Error ? error.message : String(error),
                filePath: fp,
                severity: 'error',
                code: 'parse_error',
              }]);
            }
            options.onProgress?.({
              phase: 'parsing',
              current: i + 1,
              total: failedFiles.length,
            });
          }

          const coImportRefs =
            this.queries.getUnresolvedReferencesByFiles(successfullyReindexedFiles);
          if (coImportRefs.length > 0) {
            this.resolver.resolveAndPersist(coImportRefs, (current, total) => {
              options.onProgress?.({ phase: 'resolving', current, total });
            });
          }

          // Only files whose replacement graph was actually stored are safe
          // for downstream resolution and incremental synthesis.
          if (successfullyReindexedFiles.length > 0) {
            const changedFilePaths = result.changedFilePaths ?? [];
            result.changedFilePaths = changedFilePaths.concat(
              successfullyReindexedFiles.filter(fp => !changedFilePaths.includes(fp))
            );
          }
        }

        tailMark('coImporterMs');
        // A process killed during reference resolution can leave untouched
        // pending rows behind. Scoped sync normally reads only changed files,
        // so those rows (and their missing call/import edges) would otherwise
        // survive forever. Sweep them after all scoped work, including during
        // a no-change sync. A healthy sync pays for only this COUNT query.
        const orphanCount = this.queries.getUnresolvedReferencesCount();
        if (orphanCount > 0) {
          options.onProgress?.({
            phase: 'resolving',
            current: 0,
            total: orphanCount,
          });
          await this.resolveReferencesBatched((current, total) => {
            options.onProgress?.({ phase: 'resolving', current, total });
          });
        } else if (result.changedFilePaths?.length || recoveredRetryFiles.length > 0) {
          // The normal changed-file path resolves only scoped references and
          // therefore does not enter the full dynamic-synthesis tail. Rebuild
          // just the C/C++ declaration/definition, extern-variable, and
          // override relationships invalidated by replacing these files.
          // If an orphan sweep ran above, its full synthesis already did this.
          try {
            await this.resolver.synthesizeIncrementalCCpp([...new Set([
              ...(result.changedFilePaths ?? []), ...recoveredRetryFiles,
            ])]);
          } catch (error) {
            // Match the full synthesis phase's best-effort contract: losing an
            // optional heuristic edge must not discard an otherwise valid
            // extraction/reference sync.
            console.error(
              `[CodeGraph] Incremental C/C++ synthesis failed: ` +
                `${error instanceof Error ? error.message : String(error)}. ` +
                `The base sync is still usable but heuristic coverage is incomplete.`
            );
          }
        }

        tailMark('orphanAndSynthesisMs');
        if (
          hasSuccessfulChangedFiles ||
          retryState.hasWork ||
          resurrectedRefs.length > 0 ||
          orphanCount > 0
        ) {
          // Run after every resolution source: scoped refs, resurrected refs,
          // co-importer fallback, and the interrupted-run orphan sweep.
          this.resolver.resolveChainedCallsViaConformance();
        }
        tailMark('chainedCallsMs');

        // Refresh planner stats + checkpoint the WAL after bulk writes.
        if (
          hasSuccessfulChangedFiles ||
          retryState.hasWork ||
          result.filesRemoved > 0 ||
          orphanCount > 0
        ) {
          await this.db.runMaintenance();
        }

        tailMark('maintenanceMs');
        // A successful sync may have replaced (or deleted) files that were
        // previously stored through the base-only fallback. Reconcile those
        // file-scoped diagnostics so `codegraph status` stops reporting stale
        // incompleteness as soon as full declaration-macro recovery succeeds.
        // Keep metadata unchanged after a partial sync: its pending failures
        // still need a conservative incomplete signal.
        if (result.complete !== false) {
          this.refreshDeclarationMacroRecoveryCompleteness();
        }

        if (result.complete === false) {
          throw new SyncIncompleteError(result);
        }
        retryState.complete();
        tailMark('finalizeMs');
        return result;
      } finally {
        this.orchestrator.setSyncRetryState();
        // Stop checkpoint activity before restoring SQLite's original policy.
        // Keep restoration and lock release nested so even an unexpected valve
        // teardown failure cannot leave later sync/index commands wedged.
        try {
          if (walValve) {
            walValve.stop();
            await walValve.drain();
          }
        } finally {
          try {
            if (deferWal) {
              this.db.setWalAutocheckpoint(priorAutocheckpoint);
            }
          } catch {
            // The connection may already be closing after a failed sync.
          } finally {
            this.fileLock.release();
            if (options.verbose && tailCheckpoint !== 0) {
              tailMark('cleanupMs');
              console.log('[sync] tail-detail ' + Object.entries(tailTimings)
                .map(([key, value]) => `${key}=${Math.round(value)}ms`).join(' '));
            }
          }
        }
      }
    });
  }

  /**
   * Check if an indexing operation is currently in progress
   */
  isIndexing(): boolean {
    return this.indexMutex.isLocked();
  }

  // ===========================================================================
  // File Watching
  // ===========================================================================

  /**
   * Start watching for file changes and auto-syncing.
   *
   * Uses native OS file events (FSEvents on macOS, inotify on Linux 19+,
   * ReadDirectoryChangesW on Windows) with debouncing to avoid thrashing.
   *
   * @param options - Watch options (debounce delay, callbacks)
   * @returns true if watching started successfully
   */
  watch(options: WatchOptions = {}): boolean {
    if (this.watcher?.isActive()) return true;

    this.watcher = new FileWatcher(
      this.projectRoot,
      async (paths?: string[]) => {
        const result = await this.sync({ paths });
        // sync() returns this exact zero-shape iff it failed to acquire the
        // file lock (a real empty sync always has filesChecked > 0 because
        // scanDirectory ran). Surface that to the watcher as a typed error
        // so it keeps pendingFiles + reschedules instead of clearing them
        // (#449).
        if (result.filesChecked === 0 && result.durationMs === 0) {
          throw new LockUnavailableError();
        }
        const filesChanged = result.filesAdded + result.filesModified + result.filesRemoved;
        return { filesChanged, durationMs: result.durationMs };
      },
      options
    );

    return this.watcher.start();
  }

  /**
   * Stop watching for file changes.
   */
  unwatch(): void {
    if (this.watcher) {
      this.watcher.stop();
      this.watcher = null;
    }
  }

  /**
   * Check if the file watcher is active.
   */
  isWatching(): boolean {
    return this.watcher?.isActive() ?? false;
  }

  /**
   * Files seen by the file watcher since the last successful sync —
   * the per-file "stale" signal MCP tools attach to responses so an agent
   * can fall back to {@link Read} for just the affected file without
   * waiting for a debounced sync to complete (issue #403).
   *
   * Returns an empty list when the watcher isn't active, or no events have
   * arrived. Each entry includes `firstSeenMs` and `lastSeenMs` (wall-clock
   * `Date.now()` values) so callers can render "edited Nms ago", plus an
   * `indexing` flag indicating whether the in-flight sync (if any) will
   * absorb that file.
   */
  getPendingFiles(): PendingFile[] {
    return this.watcher?.getPendingFiles() ?? [];
  }

  /**
   * Resolves once the file watcher has installed its watch set. Useful for
   * tests that need a deterministic boundary before asserting on
   * `getPendingFiles()`. Resolves immediately when no watcher is active.
   */
  waitUntilWatcherReady(timeoutMs?: number): Promise<void> {
    return this.watcher ? this.watcher.waitUntilReady(timeoutMs) : Promise.resolve();
  }

  /**
   * Get files that have changed since last index
   */
  getChangedFiles(): { added: string[]; modified: string[]; removed: string[] } {
    return this.orchestrator.getChangedFiles();
  }

  /**
   * Most recent index timestamp (ms since epoch) across all tracked files, or
   * null when nothing is indexed yet. Lets library consumers check index
   * freshness without shelling out to `codegraph status --json`. (#329)
   */
  getLastIndexedAt(): number | null {
    return this.queries.getLastIndexedAt();
  }

  /**
   * Which engine built the current index: the package version + extraction
   * version stamped at the last full `indexAll`. Either field is null for an
   * index built before stamping existed (treated as stale). See
   * `extraction-version.ts` and `isIndexStale()`.
   */
  getIndexBuildInfo(): { version: string | null; extractionVersion: number | null } {
    const version = this.queries.getMetadata('indexed_with_version');
    const ev = this.queries.getMetadata('indexed_with_extraction_version');
    const parsed = ev != null ? parseInt(ev, 10) : NaN;
    return { version, extractionVersion: Number.isFinite(parsed) ? parsed : null };
  }

  /** Persisted completeness of the current index, including visible reasons. */
  getIndexCompleteness(): {
    status: 'complete' | 'incomplete' | 'unknown';
    diagnostics: Array<{ message: string; severity: string; code?: string; filePath?: string }>;
  } {
    const rawStatus = this.queries.getMetadata('index_completeness');
    const status = rawStatus === 'complete' || rawStatus === 'incomplete'
      ? rawStatus
      : 'unknown';
    try {
      const parsed = JSON.parse(this.queries.getMetadata('index_diagnostics') ?? '[]');
      return { status, diagnostics: Array.isArray(parsed) ? parsed : [] };
    } catch {
      return { status, diagnostics: [] };
    }
  }

  /**
   * True when the on-disk index was built by an engine whose extraction is
   * older than the one now running — i.e. a re-index would add data a migration
   * can't backfill. False when there's no index yet (nothing to refresh) or the
   * stamp is current. This is the signal behind `codegraph status`'s re-index
   * hint and `codegraph upgrade`'s reminder.
   */
  isIndexStale(): boolean {
    if (this.queries.getLastIndexedAt() == null) return false;
    const { extractionVersion } = this.getIndexBuildInfo();
    return extractionVersion == null || extractionVersion < EXTRACTION_VERSION;
  }

  /**
   * Extract nodes and edges from source code (without storing)
   */
  extractFromSource(filePath: string, source: string): ExtractionResult {
    return extractFromSource(filePath, source);
  }

  // ===========================================================================
  // Reference Resolution
  // ===========================================================================

  /**
   * Resolve unresolved references and create edges
   *
   * This method takes unresolved references from extraction and attempts
   * to resolve them using multiple strategies:
   * - Framework-specific patterns (React, Express, Laravel)
   * - Import-based resolution
   * - Name-based symbol matching
   */
  resolveReferences(onProgress?: (current: number, total: number) => void): ResolutionResult {
    // Get all unresolved references from the database
    const unresolvedRefs = this.queries.getUnresolvedReferences();
    return this.resolver.resolveAndPersist(unresolvedRefs, onProgress);
  }

  /**
   * Resolve references in batches to keep memory bounded on large codebases.
   * Processes chunks of unresolved refs, persisting results after each batch.
   */
  async resolveReferencesBatched(
    onProgress?: (current: number, total: number) => void,
    onSynthesisProgress?: (current: number, total: number) => void
  ): Promise<ResolutionResult> {
    const deferResolutionIndexes =
      process.env.CODEGRAPH_NO_RESOLVE_INDEX_DEFER !== '1';
    return this.resolver.resolveAndPersistBatched(onProgress, undefined, {
      dbPath:
        this.db.getBackend() === 'node-sqlite'
          ? this.db.getPath()
          : undefined,
      bulkEdgeLoad: deferResolutionIndexes
        ? {
            begin: () => this.db.beginBulkResolutionEdgeLoad(),
            end: () => this.db.endBulkResolutionEdgeLoad(),
          }
        : undefined,
      bulkRefLoad: deferResolutionIndexes
        ? {
            begin: () => this.db.beginBulkResolutionRefLoad(),
            end: () => this.db.endBulkResolutionRefLoad(),
          }
        : undefined,
      onSynthesisProgress,
    });
  }

  /**
   * References extracted but not yet attempted by a resolution pass. A
   * non-zero value at rest normally means indexing was interrupted; the next
   * sync sweeps these rows in bounded batches.
   */
  getPendingReferenceCount(): number {
    return this.queries.getUnresolvedReferencesCount();
  }

  /**
   * Get detected frameworks in the project
   */
  getDetectedFrameworks(): string[] {
    return this.resolver.getDetectedFrameworks();
  }

  /**
   * Re-initialize the resolver (useful after adding new files)
   */
  reinitializeResolver(): void {
    this.resolver.initialize();
  }

  // ===========================================================================
  // Graph Statistics
  // ===========================================================================

  /**
   * Get statistics about the knowledge graph
   */
  getStats(): GraphStats {
    const stats = this.queries.getStats();
    stats.dbSizeBytes = this.db.getSize();
    return stats;
  }

  /**
   * Active SQLite backend for this project's connection (`node-sqlite` — Node's
   * built-in real-SQLite module). Surfaced via `codegraph status` and the
   * `codegraph_status` MCP tool alongside the effective journal mode.
   */
  getBackend(): import('./db').SqliteBackend {
    return this.db.getBackend();
  }

  /**
   * The journal mode actually in effect ('wal', 'delete', …). 'wal' means
   * readers never block on a concurrent writer; anything else means they can,
   * which is the precondition for the "database is locked" failures in issue
   * #238. Surfaced via `codegraph status` and the `codegraph_status` MCP tool.
   */
  getJournalMode(): string {
    return this.db.getJournalMode();
  }

  // ===========================================================================
  // Node Operations
  // ===========================================================================

  /**
   * Get a node by ID
   */
  getNode(id: string): Node | null {
    return this.queries.getNodeById(id);
  }

  /**
   * Get all nodes in a file
   */
  getNodesInFile(filePath: string): Node[] {
    // Canonicalize so a caller passing a symlink path resolves to the file's
    // canonical (realpath-relative) path as stored in the DB.
    return this.queries.getNodesByFile(canonicalFilePath(this.projectRoot, filePath));
  }

  /**
   * Get all nodes of a specific kind
   */
  getNodesByKind(kind: Node['kind']): Node[] {
    return this.queries.getNodesByKind(kind);
  }

  /**
   * Get ALL nodes with an exact name (direct index lookup, not FTS-ranked/capped).
   * Used to enumerate every overload of a heavily-overloaded name so the specific
   * definition the caller wants is never dropped below a search cut.
   */
  getNodesByName(name: string): Node[] {
    return this.queries.getNodesByName(name);
  }

  /**
   * Remove persisted declaration-macro degradation diagnostics whose backing
   * file record has now been fully restored or deleted. Other full-index
   * diagnostics are preserved verbatim; a sync must never erase an unrelated
   * synthesis, framework, or whole-file coverage warning.
   */
  private refreshDeclarationMacroRecoveryCompleteness(): void {
    try {
      const completeness = this.getIndexCompleteness();
      if (!completeness.diagnostics.some(isDeclarationMacroRecoverySkipped)) {
        return;
      }

      const diagnostics = completeness.diagnostics.flatMap((diagnostic) => {
        if (!isDeclarationMacroRecoverySkipped(diagnostic)) return [diagnostic];
        if (!diagnostic.filePath) return [diagnostic];

        const currentFile = this.queries.getFileByPath(diagnostic.filePath);
        const currentDiagnostic = currentFile?.errors?.find(
          isDeclarationMacroRecoverySkipped,
        );
        return currentDiagnostic ? [currentDiagnostic] : [];
      });

      this.queries.setMetadata('index_diagnostics', JSON.stringify(diagnostics));
      this.queries.setMetadata(
        'index_completeness',
        diagnostics.length === 0 ? 'complete' : 'incomplete',
      );
    } catch {
      // Completeness metadata is advisory. The recovered graph and file-level
      // diagnostics remain authoritative if metadata refresh itself fails.
    }
  }

  /**
   * Get every exact candidate for a bare or qualified symbol. Qualification
   * is applied before any result cap, so overloaded tail names cannot hide
   * the requested namespace/module candidate.
   */
  getNodesBySymbolExact(symbol: string): Node[] {
    return this.queries.getNodesBySymbolExact(symbol);
  }

  /**
   * Search nodes by text
   */
  searchNodes(query: string, options?: SearchOptions): SearchResult[] {
    return this.queries.searchNodes(query, options);
  }

  /**
   * Normalized project-name tokens (go.mod / package.json / repo dir) used to
   * down-weight the non-discriminative project name in search ranking (#720).
   * Exposed so explore can exclude it from the PascalCase type-disambiguation
   * bias, which would otherwise pull overloaded tokens toward whichever stack
   * embeds the project name.
   */
  getProjectNameTokens(): Set<string> {
    return this.queries.getProjectNameTokens();
  }

  /**
   * Find the project's "primary route file" — the file with the densest
   * concentration of framework-emitted `route` nodes (≥3 routes, ≥30%
   * of all non-test routes). Used to inline the routing config in
   * `codegraph_explore` responses on small realworld template repos
   * (rails-realworld, laravel-realworld, drupal-admintoolbar, …) where
   * Glob+Read of `routes.rb`/`urls.py`/etc. otherwise beats codegraph.
   */
  getTopRouteFile(): { filePath: string; routeCount: number; totalRoutes: number } | null {
    return this.queries.getTopRouteFile();
  }

  /**
   * Build a URL → handler routing manifest from the index. Each entry
   * pairs a route node (URL + method) with its handler function/method
   * via the `references` edge that framework resolvers emit. Returns
   * null when fewer than 3 valid (non-test) routes exist.
   */
  getRoutingManifest(limit?: number): {
    entries: Array<{ url: string; handler: string; handlerFile: string; handlerLine: number; handlerKind: string }>;
    topHandlerFile: string | null;
    topHandlerFileCount: number;
    totalRoutes: number;
  } | null {
    return this.queries.getRoutingManifest(limit);
  }

  // ===========================================================================
  // Edge Operations
  // ===========================================================================

  /**
   * Get outgoing edges from a node
   */
  getOutgoingEdges(nodeId: string): Edge[] {
    return this.queries.getOutgoingEdges(nodeId);
  }

  /**
   * Get incoming edges to a node
   */
  getIncomingEdges(nodeId: string): Edge[] {
    return this.queries.getIncomingEdges(nodeId);
  }

  /**
   * Get one relationship layer without collapsing parallel source locations.
   * Use this for callers/callees presentation; recursive traversal APIs retain
   * their existing node-oriented deduplication semantics.
   */
  getDirectRelationshipGroups(
    nodeId: string,
    direction: RelationshipDirection,
    kinds?: EdgeKind[],
  ): DirectRelationshipGroup[] {
    return this.traverser.getDirectRelationshipGroups(nodeId, direction, kinds);
  }

  // ===========================================================================
  // File Operations
  // ===========================================================================

  /**
   * Get a file record by path
   */
  getFile(filePath: string): FileRecord | null {
    return this.queries.getFileByPath(filePath);
  }

  /**
   * Get all tracked files
   */
  getFiles(): FileRecord[] {
    return this.queries.getAllFiles();
  }

  // ===========================================================================
  // Graph Query Methods
  // ===========================================================================

  /**
   * Get the context for a node (ancestors, children, references)
   *
   * Returns comprehensive context about a node including its containment
   * hierarchy, children, incoming/outgoing references, type information,
   * and relevant imports.
   *
   * @param nodeId - ID of the focal node
   * @returns Context object with all related information
   */
  getContext(nodeId: string): Context {
    return this.graphManager.getContext(nodeId);
  }

  /**
   * Traverse the graph from a starting node
   *
   * Uses breadth-first search by default. Supports filtering by edge types,
   * node types, and traversal direction.
   *
   * @param startId - Starting node ID
   * @param options - Traversal options
   * @returns Subgraph containing traversed nodes and edges
   */
  traverse(startId: string, options?: TraversalOptions): Subgraph {
    return this.traverser.traverseBFS(startId, options);
  }

  /**
   * Get the call graph for a function
   *
   * Returns both callers (functions that call this function) and
   * callees (functions called by this function) up to the specified depth.
   *
   * @param nodeId - ID of the function/method node
   * @param depth - Maximum depth in each direction (default: 2)
   * @returns Subgraph containing the call graph
   */
  getCallGraph(nodeId: string, depth: number = 2): Subgraph {
    return this.traverser.getCallGraph(nodeId, depth);
  }

  /**
   * Get the type hierarchy for a class/interface
   *
   * Returns both ancestors (types this extends/implements) and
   * descendants (types that extend/implement this).
   *
   * @param nodeId - ID of the class/interface node
   * @returns Subgraph containing the type hierarchy
   */
  getTypeHierarchy(nodeId: string): Subgraph {
    return this.traverser.getTypeHierarchy(nodeId);
  }

  /**
   * Find all usages of a symbol
   *
   * Returns all nodes that reference the specified symbol through
   * any edge type (calls, references, type_of, etc.).
   *
   * @param nodeId - ID of the symbol node
   * @returns Array of nodes and edges that reference this symbol
   */
  findUsages(nodeId: string): Array<{ node: Node; edge: Edge }> {
    return this.traverser.findUsages(nodeId);
  }

  /**
   * Get callers of a function/method
   *
   * @param nodeId - ID of the function/method node
   * @param maxDepth - Maximum depth to traverse (default: 1)
   * @returns Array of nodes that call this function
   */
  getCallers(nodeId: string, maxDepth: number = 1): Array<{ node: Node; edge: Edge }> {
    return this.traverser.getCallers(nodeId, maxDepth);
  }

  /**
   * Get callees of a function/method
   *
   * @param nodeId - ID of the function/method node
   * @param maxDepth - Maximum depth to traverse (default: 1)
   * @returns Array of nodes called by this function
   */
  getCallees(nodeId: string, maxDepth: number = 1): Array<{ node: Node; edge: Edge }> {
    return this.traverser.getCallees(nodeId, maxDepth);
  }

  /**
   * Calculate the impact radius of a node
   *
   * Returns all nodes that could be affected by changes to this node.
   *
   * @param nodeId - ID of the node
   * @param maxDepth - Maximum depth to traverse (default: 3)
   * @returns Subgraph containing potentially impacted nodes
   */
  getImpactRadius(nodeId: string, maxDepth: number = 3): Subgraph {
    return this.traverser.getImpactRadius(nodeId, maxDepth);
  }

  /**
   * Find the shortest path between two nodes
   *
   * @param fromId - Starting node ID
   * @param toId - Target node ID
   * @param edgeKinds - Edge types to consider (all if empty)
   * @returns Array of nodes and edges forming the path, or null if no path exists
   */
  findPath(
    fromId: string,
    toId: string,
    edgeKinds?: Edge['kind'][]
  ): Array<{ node: Node; edge: Edge | null }> | null {
    return this.traverser.findPath(fromId, toId, edgeKinds);
  }

  /**
   * Get ancestors of a node in the containment hierarchy
   *
   * @param nodeId - ID of the node
   * @returns Array of ancestor nodes from immediate parent to root
   */
  getAncestors(nodeId: string): Node[] {
    return this.traverser.getAncestors(nodeId);
  }

  /**
   * Get immediate children of a node
   *
   * @param nodeId - ID of the node
   * @returns Array of child nodes
   */
  getChildren(nodeId: string): Node[] {
    return this.traverser.getChildren(nodeId);
  }

  /**
   * Get dependencies of a file
   *
   * @param filePath - Path to the file
   * @returns Array of file paths this file depends on
   */
  getFileDependencies(filePath: string): string[] {
    return this.graphManager.getFileDependencies(filePath);
  }

  /**
   * Get dependents of a file
   *
   * @param filePath - Path to the file
   * @returns Array of file paths that depend on this file
   */
  getFileDependents(filePath: string): string[] {
    // Canonicalize so a caller passing a symlink path resolves to the canonical
    // path the dependency graph is keyed on.
    return this.graphManager.getFileDependents(canonicalFilePath(this.projectRoot, filePath));
  }

  /**
   * Find circular dependencies in the codebase
   *
   * @returns Array of cycles, each cycle is an array of file paths
   */
  findCircularDependencies(): string[][] {
    return this.graphManager.findCircularDependencies();
  }

  /**
   * Find dead code (unreferenced symbols)
   *
   * @param kinds - Node kinds to check (default: functions, methods, classes)
   * @returns Array of unreferenced nodes
   */
  findDeadCode(kinds?: Node['kind'][]): Node[] {
    return this.graphManager.findDeadCode(kinds);
  }

  /**
   * Get complexity metrics for a node
   *
   * @param nodeId - ID of the node
   * @returns Object containing various complexity metrics
   */
  getNodeMetrics(nodeId: string): {
    incomingEdgeCount: number;
    outgoingEdgeCount: number;
    callCount: number;
    callerCount: number;
    childCount: number;
    depth: number;
  } {
    return this.graphManager.getNodeMetrics(nodeId);
  }

  // ===========================================================================
  // Context Building
  // ===========================================================================

  /**
   * Get the source code for a node
   *
   * Reads the file and extracts the code between startLine and endLine.
   *
   * @param nodeId - ID of the node
   * @returns Code string or null if not found
   */
  async getCode(nodeId: string): Promise<string | null> {
    return this.contextBuilder.getCode(nodeId);
  }

  /**
   * Find relevant subgraph for a query
   *
   * Combines semantic search with graph traversal to find the most
   * relevant nodes and their relationships for a given query.
   *
   * @param query - Natural language query describing the task
   * @param options - Search and traversal options
   * @returns Subgraph of relevant nodes and edges
   */
  async findRelevantContext(
    query: string,
    options?: FindRelevantContextOptions
  ): Promise<Subgraph> {
    return this.contextBuilder.findRelevantContext(query, options);
  }

  /**
   * Build context for a task
   *
   * Creates comprehensive context by:
   * 1. Running FTS search to find entry points
   * 2. Expanding the graph around entry points
   * 3. Extracting code blocks for key nodes
   * 4. Formatting output for Claude
   *
   * @param input - Task description (string or {title, description})
   * @param options - Build options (maxNodes, includeCode, format, etc.)
   * @returns TaskContext object or formatted string (markdown/JSON)
   */
  async buildContext(
    input: TaskInput,
    options?: BuildContextOptions
  ): Promise<TaskContext | string> {
    return this.contextBuilder.buildContext(input, options);
  }

  // ===========================================================================
  // Database Management
  // ===========================================================================

  /**
   * Optimize the database (vacuum and analyze)
   */
  optimize(): void {
    this.db.optimize();
  }

  /**
   * Clear all data from the graph
   */
  clear(): void {
    this.queries.clear();
  }

  /**
   * Alias for close() for backwards compatibility.
   * @deprecated Use close() instead
   */
  destroy(): void {
    this.close();
  }

  /**
   * Completely remove CodeGraph from the project.
   * This closes the database and deletes the .CodeGraph directory.
   *
   * WARNING: This permanently deletes all CodeGraph data for the project.
   */
  uninitialize(): void {
    this.close();
    removeDirectory(this.projectRoot);
  }
}

// Default export
export default CodeGraph;
