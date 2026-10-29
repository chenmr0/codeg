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
function changeStamp(db: SqliteDatabase): string {
  return `${db.pragma('data_version', { simple: true })}:${db.prepare('SELECT total_changes() AS n').get().n}`
    + `:${db.pragma('schema_version', { simple: true })}:${db.pragma('temp.schema_version', { simple: true })}`;
}

/** TEMP vocabulary avoids upgrading/mutating a native index from a read tool.
 * Rebuild on either same-connection writes or another connection's commit. */
function ensureVocabulary(db: SqliteDatabase, queries: QueryBuilder): void {
  if (db.inTransaction === false && vocabStamps.get(db) === changeStamp(db)) return;
  db.exec('CREATE TEMP TABLE IF NOT EXISTS name_segment_vocab (segment TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY(segment,name)) WITHOUT ROWID');
  queries.clearNameSegmentVocab();
  for (let offset = 0; ; offset += 2000) {
    const names = queries.getDistinctNodeNames(2000, offset);
    if (!names.length) break;
    queries.insertNameSegmentsBatch(names);
  }
  if (db.inTransaction === false) vocabStamps.set(db, changeStamp(db));
  else vocabStamps.delete(db);
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
  // Same lazy config hook as upstream CodeGraph.wireLayers.
  let cachedPatterns: string[] | undefined;
  let cachedMatcher: ReturnType<typeof ignore> | undefined;
  queries.setDeprioritizedPathMatcher((filePath: string): boolean => {
    try {
      const patterns = loadDeprioritizePatterns(cg.getProjectRoot());
      if (patterns.length === 0) return false;
      if (patterns !== cachedPatterns) {
        cachedPatterns = patterns;
        cachedMatcher = ignore().add(patterns);
      }
      const rel = path.isAbsolute(filePath) ? path.relative(cg.getProjectRoot(), filePath) : filePath;
      if (!rel || rel.startsWith('..')) return false;
      return cachedMatcher!.ignores(rel.split(path.sep).join('/'));
    } catch { return false; }
  });
  return {
    ...createExploreGraphApi(cg.getProjectRoot(), queries, () => ensureVocabulary(db, queries)),
    getVerifiedSource: file => snapshots.get(file).content,
  };
}
