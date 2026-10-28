/**
 * SQLite Adapter
 *
 * Thin wrapper over Node's built-in `node:sqlite` (`DatabaseSync`), exposed
 * through a small better-sqlite3-shaped interface so the rest of the codebase
 * is storage-agnostic.
 *
 * When `node:sqlite` is unavailable (Node < 22.5), falls back to sql.js
 * (WASM-based SQLite). The WASM backend lacks WAL and mmap but supports FTS5
 * and all query features needed by CodeGraph.
 */

export interface SqliteStatement {
  run(...params: any[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: any[]): any;
  all(...params: any[]): any[];
  /**
   * Lazily yield result rows one at a time instead of materializing the whole
   * set with `all()`. Use for unbounded scans (e.g. every function/method node)
   * so memory stays O(1) in the row count rather than O(rows) — see #610, where
   * `all()`-ing every symbol on a dense project spiked the heap into an OOM.
   */
  iterate(...params: any[]): IterableIterator<any>;
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  pragma(str: string, options?: { simple?: boolean }): any;
  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T;
  close(): void;
  readonly open: boolean;
}

/**
 * The active SQLite backend. `node-sqlite` is the primary (full features);
 * `sql-js` is the WASM fallback (no WAL/mmap, but FTS5 works).
 */
export type SqliteBackend = 'node-sqlite' | 'sql-js';

// ---------------------------------------------------------------------------
// node:sqlite adapter (primary)
// ---------------------------------------------------------------------------

/**
 * Wraps Node's built-in `node:sqlite` (`DatabaseSync`) to match the
 * better-sqlite3 interface the rest of the code expects.
 */
class NodeSqliteAdapter implements SqliteDatabase {
  private _db: any;
  private _txDepth = 0;

  constructor(dbPath: string, options?: { readOnly?: boolean }) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite');
    this._db = options?.readOnly
      ? new DatabaseSync(dbPath, { readOnly: true })
      : new DatabaseSync(dbPath);
  }

  get open(): boolean {
    return this._db.isOpen;
  }

  prepare(sql: string): SqliteStatement {
    const stmt = this._db.prepare(sql);
    return {
      run(...params: any[]) {
        const r = stmt.run(...params);
        return {
          changes: Number(r?.changes ?? 0),
          lastInsertRowid: r?.lastInsertRowid ?? 0,
        };
      },
      get(...params: any[]) {
        return stmt.get(...params);
      },
      all(...params: any[]) {
        return stmt.all(...params);
      },
      iterate(...params: any[]) {
        return stmt.iterate(...params);
      },
    };
  }

  exec(sql: string): void {
    this._db.exec(sql);
  }

  pragma(str: string, options?: { simple?: boolean }): any {
    const trimmed = str.trim();
    if (trimmed.includes('=')) {
      this._db.exec(`PRAGMA ${trimmed}`);
      return;
    }
    const row = this._db.prepare(`PRAGMA ${trimmed}`).get();
    if (options?.simple) {
      return row && typeof row === 'object' ? Object.values(row)[0] : row;
    }
    return row;
  }

  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T {
    return (...args: any[]) => {
      // Helpers such as storeFileBundle compose existing transaction-wrapped
      // insert methods. Flatten nested transactions into the outer one: the
      // previous BEGIN-in-BEGIN behavior threw, so no caller could depend on
      // nested rollback granularity.
      if (this._txDepth > 0) {
        this._txDepth++;
        try {
          return fn(...args);
        } finally {
          this._txDepth--;
        }
      }
      this._db.exec('BEGIN');
      this._txDepth = 1;
      try {
        const result = fn(...args);
        this._db.exec('COMMIT');
        this._txDepth = 0;
        return result;
      } catch (error) {
        try { this._db.exec('ROLLBACK'); } finally { this._txDepth = 0; }
        throw error;
      }
    };
  }

  close(): void {
    if (this._db.isOpen) this._db.close();
  }
}

// ---------------------------------------------------------------------------
// sql.js WASM adapter (fallback for old Node / old glibc)
// ---------------------------------------------------------------------------

let SqlJsDatabase: any = null;

/**
 * Pre-initialize the sql.js WASM backend. Must be called (and awaited) before
 * `createDatabase()` when `node:sqlite` is unavailable. Idempotent — safe to
 * call multiple times.
 */
export async function ensureSqlJsReady(): Promise<void> {
  if (SqlJsDatabase) return;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const initSqlJs = require('sql.js-fts5');
  // Load the WASM binary from disk (synchronous read) so sql.js init doesn't
  // need to fetch it over the network.
  const wasmCandidates = [
    path.join(__dirname, 'sql-wasm.wasm'),                          // dist/db/
    path.join(__dirname, '..', 'node_modules', 'sql.js-fts5', 'dist', 'sql-wasm.wasm'),
  ];
  let wasmBinary: Buffer | undefined;
  for (const candidate of wasmCandidates) {
    try {
      wasmBinary = fs.readFileSync(candidate);
      break;
    } catch { /* try next */ }
  }
  const SQL = wasmBinary
    ? await initSqlJs({ wasmBinary })
    : await initSqlJs();
  SqlJsDatabase = SQL.Database;
}

/**
 * sql.js requires `@`-prefixed keys in named-param objects, but CodeGraph
 * passes bare keys (e.g. `{ id: 1 }` for SQL `@id`). This helper adds the
 * prefix when the SQL likely uses `@named` parameters and the first param is
 * an object.
 */
function prefixNamedParams(params: any[]): any[] {
  if (
    params.length === 1 &&
    params[0] !== null &&
    typeof params[0] === 'object' &&
    !Array.isArray(params[0])
  ) {
    const obj: Record<string, any> = {};
    for (const [key, value] of Object.entries(params[0])) {
      const prefixed =
        key.startsWith('@') || key.startsWith('$') || key.startsWith(':')
          ? key
          : `@${key}`;
      obj[prefixed] = value;
    }
    return [obj];
  }
  return params;
}

/** PRAGMAs that sql.js cannot honor — silently swallow them. */
const UNSUPPORTED_WRITE_PRAGMAS = new Set([
  'journal_mode',
  'mmap_size',
]);
const UNSUPPORTED_READ_PRAGMAS = new Set([
  'wal_checkpoint',
]);

class SqlJsAdapter implements SqliteDatabase {
  private _db: any;
  private _dbPath: string;
  private _open = true;
  private _stmts: any[] = [];
  private _txDepth = 0;

  constructor(dbPath: string) {
    if (!SqlJsDatabase) {
      throw new Error(
        'sql.js WASM backend not initialized. Call ensureSqlJsReady() first.',
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs');
    this._dbPath = dbPath;
    if (fs.existsSync(dbPath)) {
      const buf = fs.readFileSync(dbPath);
      this._db = new SqlJsDatabase(buf);
    } else {
      this._db = new SqlJsDatabase();
    }
  }

  get open(): boolean {
    return this._open;
  }

  prepare(sql: string): SqliteStatement {
    const stmt = this._db.prepare(sql);
    this._stmts.push(stmt);
    const db = this._db;

    // Bind params to sql.js statement.
    // Named params: single object → pass as-is (sql.js binds by name).
    // Positional params: array of values → pass the array.
    function bindParams(rawParams: any[]): boolean {
      if (rawParams.length === 0) return true;
      // Single object (named params after prefix transformation)
      if (
        rawParams.length === 1 &&
        rawParams[0] !== null &&
        typeof rawParams[0] === 'object' &&
        !Array.isArray(rawParams[0])
      ) {
        return stmt.bind(rawParams[0]);
      }
      // Positional params — spread into an array for sql.js
      return stmt.bind(rawParams);
    }

    return {
      run(...params: any[]) {
        const bound = prefixNamedParams(params);
        const ok = bindParams(bound);
        if (!ok) throw new Error(`sql.js bind() failed for SQL: ${sql.substring(0, 120)}`);
        try {
          stmt.step();
        } catch (e: any) {
          throw new Error(`sql.js step() failed: ${e.message}\n  SQL: ${sql.substring(0, 120)}`);
        }
        stmt.reset();
        const changes = db.getRowsModified();
        const rowidResult = db.exec('SELECT last_insert_rowid()');
        const lastInsertRowid = rowidResult?.[0]?.values?.[0]?.[0] ?? 0;
        return { changes, lastInsertRowid };
      },
      get(...params: any[]) {
        const bound = prefixNamedParams(params);
        const ok = bindParams(bound);
        if (!ok) throw new Error(`sql.js bind() failed for SQL: ${sql.substring(0, 120)}`);
        let result: any = undefined;
        try {
          if (stmt.step()) {
            result = stmt.getAsObject();
          }
        } catch (e: any) {
          throw new Error(`sql.js get() step failed: ${e.message}\n  SQL: ${sql.substring(0, 120)}`);
        }
        stmt.reset();
        return result;
      },
      all(...params: any[]) {
        const bound = prefixNamedParams(params);
        const ok = bindParams(bound);
        if (!ok) throw new Error(`sql.js bind() failed for SQL: ${sql.substring(0, 120)}`);
        const results: any[] = [];
        try {
          while (stmt.step()) {
            results.push(stmt.getAsObject());
          }
        } catch (e: any) {
          throw new Error(`sql.js all() step failed: ${e.message}\n  SQL: ${sql.substring(0, 120)}`);
        }
        stmt.reset();
        return results;
      },
      iterate(...params: any[]) {
        const bound = prefixNamedParams(params);
        // Create a fresh statement so the iterator's step() doesn't
        // conflict with the outer bind/step state.
        const iterStmt = db.prepare(sql);
        const ok = iterStmt.bind(bound);
        if (!ok) throw new Error(`sql.js bind() failed for SQL: ${sql.substring(0, 120)}`);
        let done = false;
        return {
          [Symbol.iterator]() {
            return this;
          },
          next() {
            if (done) return { value: undefined, done: true };
            try {
              if (iterStmt.step()) {
                return { value: iterStmt.getAsObject(), done: false };
              }
            } catch (e: any) {
              throw new Error(`sql.js iterate() step failed: ${e.message}\n  SQL: ${sql.substring(0, 120)}`);
            }
            done = true;
            iterStmt.free();
            return { value: undefined, done: true };
          },
        };
      },
    };
  }

  exec(sql: string): void {
    try {
      this._db.run(sql);
    } catch (e: any) {
      throw new Error(`sql.js exec() failed: ${e.message}\n  SQL: ${sql.substring(0, 200)}`);
    }
  }

  pragma(str: string, options?: { simple?: boolean }): any {
    const trimmed = str.trim();

    // Unsupported read pragmas — return undefined
    for (const u of UNSUPPORTED_READ_PRAGMAS) {
      if (trimmed.toLowerCase().startsWith(u)) return undefined;
    }

    if (trimmed.includes('=')) {
      const key = (trimmed.split('=')[0] ?? '').trim().toLowerCase();
      if (UNSUPPORTED_WRITE_PRAGMAS.has(key)) return undefined;
      this._db.run(`PRAGMA ${trimmed}`);
      return undefined;
    }

    // Read pragma
    const result = this._db.exec(`PRAGMA ${trimmed}`);
    if (!result || !result.length || !result[0].values?.length) {
      return options?.simple ? null : null;
    }
    const row = result[0].values[0];
    if (options?.simple) return row?.[0];
    const columns = result[0].columns;
    const obj: Record<string, any> = {};
    columns.forEach((col: string, i: number) => {
      obj[col] = row[i];
    });
    return obj;
  }

  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T {
    return (...args: any[]) => {
      if (this._txDepth > 0) {
        this._txDepth++;
        try {
          return fn(...args);
        } finally {
          this._txDepth--;
        }
      }
      this._db.run('BEGIN');
      this._txDepth = 1;
      try {
        const result = fn(...args);
        this._db.run('COMMIT');
        this._txDepth = 0;
        return result;
      } catch (error) {
        try { this._db.run('ROLLBACK'); } finally { this._txDepth = 0; }
        throw error;
      }
    };
  }

  /** Persist in-memory DB to disk. */
  flush(): void {
    if (!this._open) return;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path');
    const data = this._db.export();
    const dir = path.dirname(this._dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this._dbPath, Buffer.from(data));
  }

  close(): void {
    if (!this._open) return;
    for (const s of this._stmts) {
      try { s.free(); } catch { /* already freed */ }
    }
    this._stmts = [];
    this.flush();
    this._db.close();
    this._open = false;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a database connection. Tries `node:sqlite` first; falls back to the
 * sql.js WASM backend when the native module is unavailable.
 *
 * For the WASM path, call `ensureSqlJsReady()` before this function.
 */
export function createDatabase(
  dbPath: string,
  options?: { readOnly?: boolean; nativeOnly?: boolean }
): { db: SqliteDatabase; backend: SqliteBackend } {
  // Try node:sqlite first (full performance, WAL, native).
  // CODEGRAPH_FORCE_WASM=1 skips node:sqlite to test the WASM fallback.
  if (!process.env.CODEGRAPH_FORCE_WASM) {
    try {
      return { db: new NodeSqliteAdapter(dbPath, options), backend: 'node-sqlite' };
    } catch (error) {
      // Resolver workers must never open a writable or copied sql.js database:
      // their contract is read-only access to the writer's live WAL snapshot.
      if (options?.readOnly || options?.nativeOnly) throw error;
      // unavailable, try fallback
    }
  }

  if (options?.readOnly || options?.nativeOnly) {
    throw new Error('Generation and read-only SQLite connections require the node:sqlite backend');
  }

  // Fallback: sql.js WASM backend (no native deps, no WAL)
  if (SqlJsDatabase) {
    return { db: new SqlJsAdapter(dbPath), backend: 'sql-js' };
  }

  throw new Error(
    'Failed to open SQLite.\n' +
    'node:sqlite is unavailable (requires Node.js 22.5+), and the sql.js\n' +
    'WASM fallback has not been initialized. When running on Node < 22.5,\n' +
    'the CLI and MCP server entry points call ensureSqlJsReady() before\n' +
    'opening any database.',
  );
}
