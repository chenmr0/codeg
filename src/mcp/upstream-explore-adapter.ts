import { createExploreGraphApi } from './upstream-explore-graph';
import type CodeGraph from '../index';
import type { ExploreGraph } from '../upstream-explore';
import { QueryBuilder } from '../upstream-explore/db/queries';
import type { SqliteDatabase } from '../upstream-explore/db/sqlite-adapter';
import { loadDeprioritizePatterns } from '../upstream-explore/project-config';
import { detectGeneratedFile } from '../upstream-explore/extraction/generated-detection';
import { ExploreSourceSnapshots } from './explore-source';
import ignore from 'ignore';
import * as path from 'path';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { SqliteStatement } from '../upstream-explore/db/sqlite-adapter';

/** Compatibility only: retain the native graph and extraction; query it with
 * v1.6.2's ranking, traversal and context implementation. No persistent writes. */
class NativeExploreQueries extends QueryBuilder {
  private readonly sources = new AsyncLocalStorage<ExploreSourceSnapshots>();
  private readonly stampStatement: SqliteStatement;
  private readonly tempSchemaStatement: SqliteStatement;
  private readStamp: string | undefined;
  private schemaVersion: string | undefined;

  constructor(private readonly connection: SqliteDatabase) {
    super(connection);
    this.stampStatement = connection.prepare(
      'SELECT total_changes() AS changes, (SELECT data_version FROM pragma_data_version) AS version, '
      + '(SELECT schema_version FROM pragma_schema_version) AS schema_version',
    );
    this.tempSchemaStatement = connection.prepare('PRAGMA temp.schema_version');
  }

  /** All query methods are synchronous. The request facade scopes source
   * verification without retaining or replacing another request's snapshot. */
  forExploration(snapshots: ExploreSourceSnapshots): QueryBuilder {
    const methods = new Map<PropertyKey, (...args: unknown[]) => unknown>();
    return new Proxy(this, {
      get: (target, key) => {
        const value = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        if (!methods.has(key)) methods.set(key, (...args: unknown[]) => {
          target.refreshReadCaches();
          return target.sources.run(snapshots, () => value.apply(target, args));
        });
        return methods.get(key);
      },
    });
  }

  private currentSources(): ExploreSourceSnapshots {
    const sources = this.sources.getStore();
    if (!sources) throw new Error('Explore source access outside a request');
    return sources;
  }

  private refreshReadCaches(): void {
    if (!this.connection.open) throw new Error('Explore database connection is closed');
    const row = this.stampStatement.get() as { changes: number; version: number; schema_version: number };
    const stamp = `${row.changes}:${row.version}`;
    const schemaVersion = `${row.schema_version}:${this.tempSchemaStatement.get().schema_version}`;
    if (this.schemaVersion !== undefined && this.schemaVersion !== schemaVersion) {
      // DDL/rebuild invalidates connection-derived statements, not just data.
      super.rebind(this.connection);
      this.readStamp = undefined;
    }
    this.schemaVersion = schemaVersion;
    // A rollback does not undo total_changes(). Never retain nodes read in a
    // transaction, including SAVEPOINT transactions or unknown backend state.
    if (this.connection.inTransaction !== false || this.readStamp !== stamp) this.clearCache();
    this.readStamp = this.connection.inTransaction === false ? stamp : undefined;
  }

  override getFileByPath(file: string) {
    const record = super.getFileByPath(file);
    return record ? { ...record, generated: this.getGeneratedPathsAmong([file]).has(file) } : null;
  }

  override getAllFiles() {
    const snapshots = this.currentSources();
    return super.getAllFiles().map(record => ({
      ...record,
      // Delay absent legacy metadata until a caller asks for the flag.
      get generated() {
        const source = snapshots.get(record.path).content;
        return source !== undefined && detectGeneratedFile(record.path, source);
      },
    }));
  }

  // The native files table predates upstream's generated column. Reconstruct
  // that index-time fact with the SAME detector, only from hash-verified bytes.
  override getGeneratedPathsAmong(paths: Iterable<string>): Set<string> {
    const result = new Set<string>();
    const snapshots = this.currentSources();
    for (const file of new Set(paths)) {
      const snapshot = snapshots.get(file);
      if (snapshot.content !== undefined && detectGeneratedFile(file, snapshot.content)) result.add(file);
    }
    return result;
  }
}

const vocabStamps = new WeakMap<SqliteDatabase, string>();
const queryCaches = new WeakMap<CodeGraph, { db: SqliteDatabase; queries: NativeExploreQueries }>();
function vocabularyStamp(db: SqliteDatabase): { mainVersion: string; value: string } {
  const dataVersion = db.pragma('data_version', { simple: true });
  const schemaVersion = db.pragma('schema_version', { simple: true });
  const changes = db.prepare('SELECT total_changes() AS n').get().n;
  const tempSchemaVersion = db.pragma('temp.schema_version', { simple: true });
  return { mainVersion: `${dataVersion}:${schemaVersion}`, value: `${dataVersion}:${changes}:${schemaVersion}:${tempSchemaVersion}` };
}

/** TEMP vocabulary avoids upgrading/mutating a native index from a read tool.
 * Rebuild on either same-connection writes or another connection's commit. */
function ensureVocabulary(db: SqliteDatabase, queries: QueryBuilder): void {
  const current = vocabularyStamp(db);
  if (db.inTransaction === false && vocabStamps.get(db) === current.value) return;
  vocabStamps.delete(db);
  let before = current;
  for (let attempt = 0; attempt < 2; attempt++) {
    const beganOutsideTransaction = db.inTransaction === false;
    queries.rebuildTemporaryNameSegmentVocab();
    // Read exactly one post-release stamp. A writer can commit while the
    // source snapshot is pinned or just after RELEASE: never label that old
    // snapshot with a separately read newer version. Retry once if it changed.
    const after = vocabularyStamp(db);
    if (before.mainVersion === after.mainVersion) {
      if (beganOutsideTransaction && db.inTransaction === false) vocabStamps.set(db, after.value);
      return;
    }
    before = after;
  }
  throw new Error('CodeGraph index changed repeatedly while rebuilding the Explore vocabulary; retry the query.');
}

export function createUpstreamExploreGraph(cg: CodeGraph): ExploreGraph {
  const db = cg.getExploreQueryConnection();
  let cached = queryCaches.get(cg);
  if (!cached || cached.db !== db) {
    cached = { db, queries: new NativeExploreQueries(db) };
    queryCaches.set(cg, cached);
  }
  const snapshots = new ExploreSourceSnapshots(cg);
  const queries = cached.queries.forExploration(snapshots);
  queries.setProjectNameTokens(cg.getProjectNameTokens());
  // One config read per exploration, not per candidate/path. This adapter is
  // request-scoped, so the next call still observes configuration changes.
  // Keep the predicate pure: ranking loops can inspect thousands of paths.
  let matcher: ReturnType<typeof ignore> | undefined;
  try {
    const patterns = loadDeprioritizePatterns(cg.getProjectRoot());
    if (patterns.length > 0) matcher = ignore().add(patterns);
  } catch { /* Optional ranking policy must never prevent a query. */ }
  queries.setDeprioritizedPathMatcher((filePath: string): boolean => {
    if (!matcher) return false;
    try {
      const rel = path.isAbsolute(filePath) ? path.relative(cg.getProjectRoot(), filePath) : filePath;
      if (!rel || rel.startsWith('..')) return false;
      return matcher.ignores(rel.split(path.sep).join('/'));
    } catch { return false; }
  });
  return {
    ...createExploreGraphApi(cg.getProjectRoot(), queries, () => ensureVocabulary(db, queries)),
    getVerifiedSource: file => snapshots.get(file).content,
  };
}
