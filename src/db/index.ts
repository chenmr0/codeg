import { withFixedPathInitializationCreationGate } from '../sync/fixed-path-initialization';
import { isFixedPathLayout } from '../sync/fixed-path/probe';
import { assertFixedPathOpenAdmitted, acquireAuthorizedFixedPathLease } from '../sync/fixed-path/open-context';
/**
 * Database Layer
 *
 * Handles SQLite database initialization and connection management.
 */

import { SqliteDatabase, SqliteBackend, createDatabase } from './sqlite-adapter';
import * as fs from 'fs';
import * as path from 'path';
import { SchemaVersion } from '../types';
import { runMigrations, getCurrentVersion, CURRENT_SCHEMA_VERSION } from './migrations';
import { getCodeGraphDir } from '../directory';
import { resolveGeneration, acquireGenerationLease, GenerationLease } from '../sync/generation-store';
import {
  WalCheckpointError,
  walCheckpointErrorFrom,
  walCheckpointResultFrom,
  type WalCheckpointOptions,
  type WalCheckpointResult,
} from './wal-checkpoint';

export { SqliteDatabase, SqliteBackend } from './sqlite-adapter';

/**
 * Apply connection-level PRAGMAs. Shared by `initialize` and `open` so the two
 * paths can't drift.
 *
 * `busy_timeout` is set FIRST, before any pragma that might touch the database
 * file (notably `journal_mode`). If another process holds a write lock at open
 * time, the later pragmas — and the connection's first query — then wait out
 * the lock instead of throwing "database is locked" immediately. See issue #238.
 *
 * The 5s window (was 120s) rides out a normal incremental sync; the old
 * 2-minute wait presented as a frozen, hung agent. With WAL, reads never block
 * on a writer, so this timeout only governs cross-process write contention
 * (e.g. the git-hook `codegraph sync` running while the MCP server writes).
 */
function configureConnection(db: SqliteDatabase, backend: SqliteBackend): void {
  db.pragma('busy_timeout = 5000');      // MUST be first — see above
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');       // silently ignored by sql.js (stays delete)
  db.pragma('synchronous = NORMAL');     // safe with WAL mode
  db.pragma('cache_size = -64000');      // 64 MB page cache
  db.pragma('temp_store = MEMORY');      // temp tables in memory
  if (backend === 'node-sqlite') {
    db.pragma('mmap_size = 268435456');  // 256 MB memory-mapped I/O — WASM can't do this
  }
}

/** A factory failed and its native handle remains open. Lease owners must retain
 * this connection (and their lease) rather than treating a failed open as closed.
 */
export class DatabaseOpenError extends Error {
  constructor(readonly connection: DatabaseConnection, readonly cause: unknown, readonly closeCause: unknown) {
    super('Database opening failed and its SQLite connection could not be closed');
    this.name = 'DatabaseOpenError';
  }
}

/** Public low-level SDK readers participate too; custom/flat databases are untouched. */
function acquireDatabaseLease(databasePath: string): GenerationLease | undefined {
  let resolved = path.resolve(databasePath);
  try { resolved = fs.realpathSync(resolved); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // initialize() can target a new file inside an existing managed directory.
    try { resolved = path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved)); }
    catch (parentError) { if ((parentError as NodeJS.ErrnoException).code !== 'ENOENT') throw parentError; }
  }
  const directory = path.dirname(resolved);
  if (path.basename(resolved) !== 'codegraph.db' || path.basename(path.dirname(directory)) !== 'generations' ||
      !/^g-[a-zA-Z0-9-]{1,100}$/.test(path.basename(directory))) return undefined;
  const root = path.dirname(path.dirname(directory));
  if (!fs.existsSync(path.join(root, '.generation-lifecycle.sqlite'))) return undefined;
  // Unknown historical/custom directories are never collected. Registered IDs
  // must still acquire the real lock; sealed/deleting IDs always fail closed.
  return acquireGenerationLease(root, path.basename(directory), { allowUnmanaged: true });
}

/**
 * Database connection wrapper with lifecycle management
 */
export class DatabaseConnection {
  // SDK callers can retain only getDb() or discard an opening error. Explicit
  // close owns lease release; independent JS finalizers must not reorder it.
  private static readonly managedOrFailedConnections = new Set<DatabaseConnection>();
  private db: SqliteDatabase;
  private dbPath: string;
  private backend: SqliteBackend;
  private storageLease?: GenerationLease;

  private backgroundLeaseFactory?: () => { release(): void };
  private backgroundOperations = 0;
  private backgroundIdleWaiters: Array<() => void> = [];

  /** The storage controller supplies independent admission, not the facade's lease.
   * It must remain valid even if close() closes this connection during worker I/O. */
  setBackgroundLeaseFactory(factory: () => { release(): void }): void {
    if (this.backgroundOperations) throw new Error('Cannot change background admission while workers are active');
    this.backgroundLeaseFactory = factory;
  }

  /** Drain asynchronously: never block the event loop needed to observe worker exit. */
  whenBackgroundIdle(): Promise<void> {
    if (!this.backgroundOperations) return Promise.resolve();
    return new Promise(resolve => this.backgroundIdleWaiters.push(resolve));
  }

  /** Independent ownership for an external native database worker. */
  retainBackgroundLease(): { release(): void } {
    return { release: this.retainBackgroundOperation() };
  }

  private retainBackgroundOperation(): () => void {
    if (!this.isOpen()) throw new Error('Database connection is closed');
    // Acquire before the first await or native worker launch. Managed generation
    // handles need a distinct lease too: closing the parent must not unpin them.
    if (!this.backgroundLeaseFactory) assertFixedPathOpenAdmitted(this.dbPath);
    const lease = this.backgroundLeaseFactory?.() ?? acquireDatabaseLease(this.dbPath);
    this.backgroundOperations++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try { lease?.release(); }
      finally {
        this.backgroundOperations--;
        if (!this.backgroundOperations) this.backgroundIdleWaiters.splice(0).forEach(resolve => resolve());
      }
    };
  }

  private constructor(db: SqliteDatabase, dbPath: string, backend: SqliteBackend, storageLease?: GenerationLease) {
    this.db = db;
    this.dbPath = dbPath;
    this.backend = backend;
    this.storageLease = storageLease;
    if (storageLease) DatabaseConnection.managedOrFailedConnections.add(this);
  }

  /**
   * Initialize a new database at the given path
   */
  static initialize(dbPath: string): DatabaseConnection {
    assertFixedPathOpenAdmitted(dbPath);
    if (path.basename(dbPath) !== 'codegraph.db') return this.initializeStorage(dbPath);
    // Existing managed generations already participate in their lifecycle gate.
    const generation = acquireDatabaseLease(dbPath);
    if (generation) {
      try { return this.initializeStorage(dbPath); } finally { generation.release(); }
    }
    let nativeCoordination = false;
    try { nativeCoordination = typeof require('node:sqlite').DatabaseSync === 'function'; } catch { /* old pure-legacy runtime */ }
    if (!nativeCoordination) return this.initializeStorage(dbPath);
    let connection: DatabaseConnection | undefined, closed = false;
    return withFixedPathInitializationCreationGate(path.dirname(dbPath), () => {
      try {
        connection = this.initializeStorage(dbPath);
        // WASM construction is initially in memory. Materialize under the same
        // creation fence before a fixed initializer can observe root absence.
        (connection.getDb() as SqliteDatabase & { flush?: () => void }).flush?.();
        return connection;
      } catch (error) {
        if (connection) { connection.close(); closed = !connection.isOpen(); }
        throw error;
      }
    }, { closedOnError: () => closed });
  }

  private static initializeStorage(dbPath: string): DatabaseConnection {
    assertFixedPathOpenAdmitted(dbPath);
    const lease = acquireAuthorizedFixedPathLease(dbPath) ?? acquireDatabaseLease(dbPath);
    dbPath = lease?.databasePath ?? dbPath; // Open the same canonical target we pinned.
    let created: ReturnType<typeof createDatabase>;
    try {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      created = createDatabase(dbPath, lease ? { nativeOnly: true } : undefined);
    } catch (error) { lease?.release(); throw error; }
    const { db, backend } = created;
    // Wrap immediately: configuration/schema failures must not strand a raw handle.
    const connection = new DatabaseConnection(db, dbPath, backend, lease);
    try {
      configureConnection(db, backend);
      const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
      db.exec(schema);
      const currentVersion = getCurrentVersion(db);
      if (currentVersion < CURRENT_SCHEMA_VERSION) {
        db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)')
          .run(CURRENT_SCHEMA_VERSION, Date.now(), 'Initial schema includes all migrations');
      }
      return connection;
    } catch (error) { return DatabaseConnection.closeFailedOpen(connection, error); }
  }

  /**
   * Open an existing database
   */
  static open(dbPath: string, options: { nativeOnly?: boolean } = {}): DatabaseConnection {
    if (!fs.existsSync(dbPath)) {
      throw new Error(`Database not found: ${dbPath}`);
    }

    assertFixedPathOpenAdmitted(dbPath);
    const lease = acquireAuthorizedFixedPathLease(dbPath) ?? acquireDatabaseLease(dbPath);
    dbPath = lease?.databasePath ?? dbPath; // Open the same canonical target we pinned.
    let created: ReturnType<typeof createDatabase>;
    try {
      // Recheck after acquisition: a retired path may have been collected while
      // waiting for the gate. Never let SQLite recreate that removed database.
      if (!fs.existsSync(dbPath)) throw new Error(`Database not found: ${dbPath}`);
      created = createDatabase(dbPath, lease ? { ...options, nativeOnly: true } : options);
    } catch (error) { lease?.release(); throw error; }
    const { db, backend } = created;
    const connection = new DatabaseConnection(db, dbPath, backend, lease);
    try {
      configureConnection(db, backend);
      const currentVersion = getCurrentVersion(db);
      if (currentVersion < CURRENT_SCHEMA_VERSION) runMigrations(db, currentVersion);
      // Repair processes interrupted inside fresh-index bulk windows.
      connection.healBulkNodeLoad();
      connection.healBulkParseIndexes();
      return connection;
    } catch (error) { return DatabaseConnection.closeFailedOpen(connection, error); }
  }

  /** Native, non-migrating connection for generation-pinned readers and validation. */
  static openReadOnly(dbPath: string): DatabaseConnection {
    if (!fs.existsSync(dbPath)) throw new Error(`Database not found: ${dbPath}`);
    assertFixedPathOpenAdmitted(dbPath);
    const lease = acquireAuthorizedFixedPathLease(dbPath) ?? acquireDatabaseLease(dbPath);
    dbPath = lease?.databasePath ?? dbPath; // Open the same canonical target we pinned.
    let created: ReturnType<typeof createDatabase>;
    try { created = createDatabase(dbPath, { readOnly: true }); }
    catch (error) { lease?.release(); throw error; }
    const { db, backend } = created;
    const connection = new DatabaseConnection(db, dbPath, backend, lease);
    try {
      db.pragma('busy_timeout = 5000');
      db.pragma('query_only = ON');
      if (getCurrentVersion(db) !== CURRENT_SCHEMA_VERSION) {
        throw new Error('Read-only generation requires the current schema version');
      }
      return connection;
    } catch (error) { return DatabaseConnection.closeFailedOpen(connection, error); }
  }

  private static closeFailedOpen(connection: DatabaseConnection, cause: unknown): never {
    let closeCause: unknown;
    try { connection.close(); } catch (error) { closeCause = error; }
    let stillOpen = true;
    try { stillOpen = connection.isOpen(); } catch (error) { closeCause ??= error; }
    if (stillOpen) throw new DatabaseOpenError(connection, cause, closeCause ?? new Error('SQLite handle remained open after close'));
    throw cause;
  }

  private static readonly FTS_TRIGGER_NAMES = ['nodes_ai', 'nodes_ad', 'nodes_au'] as const;

  /**
   * Drop per-row FTS synchronization during a full node load. The caller must
   * pair this with endBulkNodeLoad() in a finally block.
   */
  beginBulkNodeLoad(): void {
    for (const trigger of DatabaseConnection.FTS_TRIGGER_NAMES) {
      this.db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
    }
  }

  /** Rebuild FTS once and restore its synchronization triggers. */
  endBulkNodeLoad(): void {
    this.db.exec(`INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')`);
    this.recreateFtsTriggers();
  }

  private healBulkNodeLoad(): void {
    const row = this.db
      .prepare(
        `SELECT count(*) AS c FROM sqlite_master
         WHERE type = 'trigger' AND name IN ('nodes_ai','nodes_ad','nodes_au')`
      )
      .get() as { c: number } | undefined;
    if ((row?.c ?? 0) >= DatabaseConnection.FTS_TRIGGER_NAMES.length) return;
    this.endBulkNodeLoad();
  }

  private recreateFtsTriggers(): void {
    const schema = this.readSchema();
    const triggerDdls = schema.match(
      /CREATE TRIGGER IF NOT EXISTS nodes_a[idu]\b[\s\S]*?END;/g
    );
    if (!triggerDdls || triggerDdls.length !== DatabaseConnection.FTS_TRIGGER_NAMES.length) {
      throw new Error(
        `schema.sql: expected ${DatabaseConnection.FTS_TRIGGER_NAMES.length} node FTS triggers, found ${triggerDdls?.length ?? 0}`
      );
    }
    for (const ddl of triggerDdls) this.db.exec(ddl);
  }

  /**
   * Non-unique indexes whose per-row B-tree maintenance is unnecessary while
   * building a completely fresh graph. Primary keys and idx_edges_identity
   * deliberately remain for upsert and edge-dedup correctness.
   */
  private static readonly BULK_PARSE_INDEX_NAMES = [
    'idx_nodes_kind',
    'idx_nodes_name',
    'idx_nodes_qualified_name',
    'idx_nodes_file_path',
    'idx_nodes_language',
    'idx_nodes_file_line',
    'idx_nodes_lower_name',
    'idx_unresolved_from_node',
    'idx_unresolved_name',
    'idx_unresolved_file_path',
    'idx_unresolved_from_name',
    'idx_unresolved_status',
    'idx_unresolved_failed_tail',
    'idx_files_language',
    'idx_files_modified_at',
    'idx_edges_kind',
    'idx_edges_source_kind',
    'idx_edges_target_kind',
    'idx_edges_provenance',
  ] as const;

  /** Enter the fresh-database parse bulk window. */
  beginBulkParseLoad(): void {
    for (const indexName of DatabaseConnection.BULK_PARSE_INDEX_NAMES) {
      this.db.exec(`DROP INDEX IF EXISTS ${indexName}`);
    }
  }

  /** Recreate deferred parse indexes one at a time, yielding between scans. */
  async endBulkParseLoad(): Promise<void> {
    const schema = this.readSchema();
    for (const indexName of DatabaseConnection.BULK_PARSE_INDEX_NAMES) {
      const ddl = schema.match(
        new RegExp(`CREATE INDEX IF NOT EXISTS ${indexName}\\b[^;]*;`)
      )?.[0];
      if (!ddl) {
        throw new Error(`schema.sql: parse index ${indexName} not found for bulk-load recreation`);
      }
      this.db.exec(ddl);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  /**
   * Non-unique edge indexes that are not required for correctness while the
   * main resolution batches insert edges. The unique identity index remains:
   * it preserves INSERT OR IGNORE deduplication and its `source` prefix keeps
   * the supertype walk queryable between batches.
   */
  private static readonly BULK_RESOLUTION_EDGE_INDEX_NAMES = [
    'idx_edges_kind',
    'idx_edges_source_kind',
    'idx_edges_target_kind',
    'idx_edges_provenance',
  ] as const;

  /** Enter the large-resolution edge-write window. */
  beginBulkResolutionEdgeLoad(): void {
    for (const indexName of DatabaseConnection.BULK_RESOLUTION_EDGE_INDEX_NAMES) {
      this.db.exec(`DROP INDEX IF EXISTS ${indexName}`);
    }
  }

  /** Restore edge lookup indexes before conformance and callback synthesis. */
  async endBulkResolutionEdgeLoad(): Promise<void> {
    await this.recreateIndexes(DatabaseConnection.BULK_RESOLUTION_EDGE_INDEX_NAMES);
  }

  /**
   * Defer only reference indexes not needed by full-resolution reads. The
   * drain itself seeks/deletes by id, but getPendingSupertypes also reads by
   * from_node_id while C++ inheritance edges are not yet persisted. Keep
   * idx_unresolved_from_node: without it, each lookup can scan every pending
   * and failed row through idx_unresolved_status. This applies to both the
   * main resolver and its read-only workers.
   */
  private static readonly BULK_RESOLUTION_REF_INDEX_NAMES = [
    'idx_unresolved_name',
    'idx_unresolved_file_path',
    'idx_unresolved_from_name',
    'idx_unresolved_failed_tail',
  ] as const;

  /** Enter the large-resolution unresolved-reference cleanup window. */
  beginBulkResolutionRefLoad(): void {
    for (const indexName of DatabaseConnection.BULK_RESOLUTION_REF_INDEX_NAMES) {
      this.db.exec(`DROP INDEX IF EXISTS ${indexName}`);
    }
  }

  /** Restore unresolved-reference lookup indexes after the batched drain. */
  async endBulkResolutionRefLoad(): Promise<void> {
    await this.recreateIndexes(DatabaseConnection.BULK_RESOLUTION_REF_INDEX_NAMES);
  }

  /** Restore only missing deferred indexes after an interrupted fresh index. */
  private healBulkParseIndexes(): void {
    const rows = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`)
      .all() as Array<{ name: string }>;
    const existing = new Set(rows.map((row) => row.name));
    const missing = DatabaseConnection.BULK_PARSE_INDEX_NAMES.filter(
      (name) => !existing.has(name)
    );
    if (missing.length === 0) return;

    const schema = this.readSchema();
    for (const indexName of missing) {
      const ddl = schema.match(
        new RegExp(`CREATE INDEX IF NOT EXISTS ${indexName}\\b[^;]*;`)
      )?.[0];
      if (!ddl) {
        throw new Error(`schema.sql: parse index ${indexName} not found for recovery`);
      }
      this.db.exec(ddl);
    }
  }

  /** Recreate named schema indexes one at a time, yielding between scans. */
  private async recreateIndexes(indexNames: readonly string[]): Promise<void> {
    const schema = this.readSchema();
    for (const indexName of indexNames) {
      const ddl = schema.match(
        new RegExp(`CREATE (?:UNIQUE )?INDEX IF NOT EXISTS ${indexName}\\b[^;]*;`)
      )?.[0];
      if (!ddl) {
        throw new Error(`schema.sql: index ${indexName} not found for recreation`);
      }
      this.db.exec(ddl);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  private readSchema(): string {
    return fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
  }

  /**
   * Get the underlying database instance
   */
  getDb(): SqliteDatabase {
    return this.db;
  }

  /**
   * Get the SQLite backend serving this connection. Per-instance so
   * MCP cross-project queries report the right backend even when
   * multiple project DBs are open in the same process.
   */
  getBackend(): SqliteBackend {
    return this.backend;
  }

  /**
   * Get database file path
   */
  getPath(): string {
    return this.dbPath;
  }

  /**
   * The journal mode actually in effect (e.g. 'wal', 'delete').
   *
   * SQLite silently keeps the prior mode if WAL can't be enabled — e.g. on
   * filesystems without shared-memory support (some network/virtualized mounts,
   * WSL2 /mnt), and always on the wasm backend. So the effective mode can differ
   * from what `configureConnection` requested. Surfaced in `codegraph status` so
   * a "database is locked" report is triageable: 'wal' ⇒ readers never block on a
   * writer; anything else ⇒ they can. See issue #238.
   */
  getJournalMode(): string {
    const raw = this.db.pragma('journal_mode');
    const row = Array.isArray(raw) ? raw[0] : raw;
    const mode = row && typeof row === 'object'
      ? (row as Record<string, unknown>).journal_mode
      : row;
    return String(mode ?? '').toLowerCase();
  }

  /**
   * Get current schema version
   */
  getSchemaVersion(): SchemaVersion | null {
    const row = this.db
      .prepare('SELECT version, applied_at, description FROM schema_versions ORDER BY version DESC LIMIT 1')
      .get() as { version: number; applied_at: number; description: string | null } | undefined;

    if (!row) return null;

    return {
      version: row.version,
      appliedAt: row.applied_at,
      description: row.description ?? undefined,
    };
  }

  /**
   * Execute a function within a transaction
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /**
   * Get database file size in bytes
   */
  getSize(): number {
    const stats = fs.statSync(this.dbPath);
    return stats.size;
  }

  /**
   * Size of the `-wal` sidecar file in bytes. 0 when it doesn't exist (non-WAL
   * journal mode, in-memory DB, or no write since the last checkpoint+reset).
   */
  getWalSizeBytes(): number {
    if (!this.dbPath || this.dbPath === ':memory:') return 0;
    try {
      return fs.statSync(`${this.dbPath}-wal`).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      // Unknown is not empty: fail the next write boundary rather than
      // silently disabling capacity checks on an I/O or permission failure.
      throw error;
    }
  }

  /** Current `wal_autocheckpoint` interval in pages (0 = disabled). */
  getWalAutocheckpoint(): number {
    const v = this.db.pragma('wal_autocheckpoint', { simple: true });
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  /**
   * Set the connection's `wal_autocheckpoint` interval (pages; 0 disables).
   * Bulk indexing defers checkpoints entirely (#1231): the default 1000-page
   * auto-checkpoint re-writes hot B-tree/FTS pages into the main DB file over
   * and over — measured at ~95% of ALL disk I/O during a bulk index, and the
   * difference between 45s and 19+ minutes on HDD-class storage. During
   * deferral a {@link WalCheckpointValve} bounds WAL growth off-thread.
   */
  setWalAutocheckpoint(pages: number): void {
    this.db.pragma(`wal_autocheckpoint = ${Math.max(0, Math.floor(pages))}`);
  }

  /** Off-thread, non-blocking-reader checkpoint. Safe while the writer is active. */
  checkpointWalPassive(options?: WalCheckpointOptions): Promise<WalCheckpointResult | null> {
    return this.checkpointWal('PASSIVE', options);
  }

  /**
   * Release reusable WAL space. Call ONLY with every writer parked outside a
   * transaction. busy_timeout=0 means a pinned reader returns busy rather than
   * blocking a writer waiting for this checkpoint. Never called by the timer.
   */
  checkpointWalTruncate(options?: WalCheckpointOptions): Promise<WalCheckpointResult | null> {
    return this.checkpointWal('TRUNCATE', options);
  }

  private async checkpointWal(
    mode: 'PASSIVE' | 'TRUNCATE',
    options: WalCheckpointOptions = {},
  ): Promise<WalCheckpointResult | null> {
    if (!this.dbPath || this.dbPath === ':memory:') {
      try {
        return walCheckpointResultFrom(this.db.prepare(`PRAGMA wal_checkpoint(${mode})`).get());
      } catch (error) { throw walCheckpointErrorFrom(error); }
    }
    const requestedTimeout = options.timeoutMs;
    const timeoutMs = requestedTimeout !== undefined && Number.isFinite(requestedTimeout)
      ? Math.max(1, Math.min(2_147_483_647, Math.floor(requestedTimeout))) : 60_000;
    const releaseBackground = this.retainBackgroundOperation();
    try {
      const { Worker } = await import('node:worker_threads');
      const workerSource = `
        const { workerData, parentPort } = require('node:worker_threads');
        let db;
        let response;
        let reason = 'unavailable';
        const failure = (error, reason) => ({ error: {
          message: error && typeof error.message === 'string' ? error.message : String(error),
          code: error && error.code,
          errcode: error && error.errcode,
          reason,
        } });
        try {
          const { DatabaseSync } = require('node:sqlite');
          reason = 'sqlite';
          db = new DatabaseSync(workerData.dbPath);
          db.exec('PRAGMA busy_timeout=0');
          response = { row: db.prepare('PRAGMA wal_checkpoint(' + workerData.mode + ')').get() };
        } catch (error) {
          response = failure(error, reason);
        } finally {
          try { if (db) db.close(); }
          catch (error) { if (!response || !response.error) response = failure(error, 'sqlite'); }
        }
        parentPort.postMessage(response);
      `;
      return await new Promise<WalCheckpointResult>((resolve, reject) => {
        type Outcome = { row: WalCheckpointResult; error?: never } | { error: WalCheckpointError; row?: never };
        let outcome: Outcome | undefined;
        let settled = false;
        let exited = false;
        let stopping = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let worker: import('node:worker_threads').Worker | undefined;
        const clearTimer = (): void => {
          if (timer) clearTimeout(timer);
          timer = undefined;
        };
        const settleAfterExit = (): void => {
          if (settled || !exited || !outcome) return;
          settled = true;
          clearTimer();
          if (outcome.error) reject(outcome.error);
          else resolve(outcome.row);
        };
        const terminationFailed = (error: unknown): void => {
          // A rejected termination request is NOT evidence of thread exit.
          // Keep waiting for 'exit', even beyond the cancellation deadline.
          if (!outcome?.error) outcome = { error: walCheckpointErrorFrom(error, 'unavailable') };
        };
        const finish = (next: Outcome): void => {
          if (settled) return;
          if (!outcome || (!outcome.error && next.error)) outcome = next;
          clearTimer();
          if (exited) { settleAfterExit(); return; }
          if (stopping) return;
          stopping = true;
          // Neither success nor failure may resume the writer until the
          // checkpoint thread has actually exited and released SQLite locks.
          try { void worker!.terminate().catch(terminationFailed); }
          catch (error) { terminationFailed(error); }
        };
        try {
          worker = new Worker(workerSource, { eval: true, workerData: { dbPath: this.dbPath, mode } });
        } catch (error) {
          reject(walCheckpointErrorFrom(error, 'unavailable'));
          return;
        }
        worker.once('message', (message: {
          row?: unknown;
          error?: { message?: unknown; code?: unknown; errcode?: unknown; reason?: string };
        } | undefined) => {
          if (message?.error) {
            finish({ error: walCheckpointErrorFrom(message.error,
              message.error.reason === 'unavailable' ? 'unavailable' : 'sqlite') });
          } else {
            try { finish({ row: walCheckpointResultFrom(message?.row) }); }
            catch (error) { finish({ error: walCheckpointErrorFrom(error, 'unavailable') }); }
          }
        });
        worker.once('error', (error) => { finish({ error: walCheckpointErrorFrom(error, 'unavailable') }); });
        worker.once('exit', (code) => {
          exited = true;
          if (!outcome) outcome = { error: new WalCheckpointError(
            `WAL ${mode} checkpoint worker exited before returning a result (code=${code})`, 'unavailable', true) };
          settleAfterExit();
        });
        // This bounds the cancellation request, not uninterruptible OS I/O.
        timer = setTimeout(() => finish({ error: new WalCheckpointError(
          `WAL ${mode} checkpoint timed out after ${timeoutMs}ms`, 'timeout', true) }), timeoutMs);
      });
    } catch (error) { throw walCheckpointErrorFrom(error, 'unavailable'); }
    finally { releaseBackground(); }
  }

  /**
   * Optimize database (vacuum and analyze)
   */
  optimize(): void {
    this.db.exec('VACUUM');
    this.db.exec('ANALYZE');
  }

  /**
   * Lightweight maintenance to run after bulk writes (indexAll, sync).
   * Two operations:
   *
   *   - `PRAGMA optimize` — incremental ANALYZE; SQLite only re-analyzes
   *     tables whose row counts changed materially since the last
   *     ANALYZE. Without it, the query planner has no statistics on the
   *     freshly-bulk-loaded tables and can pick suboptimal indexes.
   *
   *   - `PRAGMA wal_checkpoint(PASSIVE)` — fold pending WAL pages back
   *     into the main database file so the WAL file doesn't grow
   *     unboundedly between automatic checkpoints (auto-fires at 1000
   *     pages by default; large indexAll runs blow past that).
   *
   * Runs on a WORKER THREAD with its own connection (node-sqlite file DB):
   * on a multi-GB index these pragmas are minutes of synchronous IO (a 95k-file
   * kernel index left a 593MB WAL whose checkpoint alone blew the #850
   * watchdog's 60s window and got a COMPLETED index SIGKILLed at the finish
   * line). WAL checkpointing from a second connection is standard SQLite;
   * `PRAGMA optimize` persists its statistics in sqlite_stat tables, so the
   * main connection benefits the same. The main thread awaits actual worker exit,
   * so the event loop — and the watchdog heartbeat — keep turning.
   *
   * The sql.js (WASM) backend is in-memory and can't open a second connection,
   * so it runs `PRAGMA optimize` inline and then `flush?.()` to persist to disk
   * after bulk writes — the same path it always took. Pragma failures are
   * best-effort, but admission failures propagate: maintenance must never
   * open an unprotected connection during publication. If worker threads are unavailable, falls back to a bounded
   * in-line `PRAGMA optimize` and SKIPS the checkpoint (the final close()
   * checkpoints after the CLI has already disarmed its watchdog).
   */
  async runMaintenance(): Promise<void> {
    // sql.js (WASM, in-memory) and in-memory test DBs: no worker round-trip.
    if (this.backend === 'sql-js' || !this.dbPath || this.dbPath === ':memory:') {
      try { this.db.exec('PRAGMA optimize'); } catch { /* ignore */ }
      try { this.db.exec('PRAGMA wal_checkpoint(PASSIVE)'); } catch { /* ignore (e.g., not in WAL mode) */ }
      // sql.js is in-memory — persist to disk after bulk writes
      if (this.backend === 'sql-js') {
        (this.db as any).flush?.();
      }
      return;
    }
    await this.runPragmasOffThread(
      ['PRAGMA analysis_limit=1000', 'PRAGMA optimize', 'PRAGMA wal_checkpoint(PASSIVE)'],
      // Worker threads unavailable — bounded in-line fallback, no checkpoint.
      ['PRAGMA analysis_limit=1000', 'PRAGMA optimize']
    );
  }

  /**
   * Run pragmas on a worker thread against its own connection to this DB
   * (shared machinery for {@link runMaintenance} and
   * {@link checkpointWalPassive}). Each pragma is individually best-effort;
   * the whole call is best-effort. `inlineFallback` (if any) runs on THIS
   * connection only when worker threads are unavailable — keep it to pragmas
   * that are safe to run synchronously on the main thread.
   */
  private async runPragmasOffThread(pragmas: string[], inlineFallback: string[] = []): Promise<void> {
    const releaseBackground = this.retainBackgroundOperation();
    try {
      let Worker: typeof import('node:worker_threads').Worker;
      try { ({ Worker } = await import('node:worker_threads')); }
      catch {
        // Only module unavailability permits inline fallback; a rejected
        // termination or worker error is never evidence that its handle closed.
        for (const p of inlineFallback) {
          try { this.db.exec(p); } catch { /* best-effort maintenance */ }
        }
        return;
      }
      const workerSource = `
        const { workerData, parentPort } = require('node:worker_threads');
        let db;
        try {
          const { DatabaseSync } = require('node:sqlite');
          db = new DatabaseSync(workerData.dbPath);
          for (const p of workerData.pragmas) { try { db.exec(p); } catch {} }
        } catch {}
        finally { try { if (db) db.close(); } catch {} }
        parentPort.postMessage('done');
      `;
      await new Promise<void>((resolve) => {
        let worker: import('node:worker_threads').Worker;
        let stopping = false;
        const stop = (): void => {
          if (stopping) return;
          stopping = true;
          // Completion messages (including failed close) are not proof of exit.
          try { void worker.terminate().catch(() => {}); } catch { /* await exit */ }
        };
        try { worker = new Worker(workerSource, { eval: true, workerData: { dbPath: this.dbPath, pragmas } }); }
        catch { resolve(); return; } // No native worker was created.
        worker.once('message', stop);
        worker.once('error', stop);
        worker.once('exit', () => resolve());
      });
    } finally { releaseBackground(); }
  }

  /**
   * Close the database connection
   */
  close(): void {
    DatabaseConnection.managedOrFailedConnections.add(this);
    try { this.db.close(); }
    finally {
      if (!this.db.open) {
        this.storageLease?.release(); this.storageLease = undefined;
        DatabaseConnection.managedOrFailedConnections.delete(this);
      }
    }
  }

  /**
   * Check if the database connection is open
   */
  isOpen(): boolean {
    return this.db.open;
  }
}

/**
 * Default database filename
 */
export const DATABASE_FILENAME = 'codegraph.db';

/**
 * Get the default database path for a project
 */
export function getDatabasePath(projectRoot: string): string {
  const dataDirectory = getCodeGraphDir(projectRoot);
  if (isFixedPathLayout(dataDirectory)) return path.join(dataDirectory, 'codegraph.db');
  return resolveGeneration(dataDirectory).databasePath;
}
