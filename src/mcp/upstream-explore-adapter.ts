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

/** Compatibility only: retain the native graph and extraction; query it with
 * v1.6.2's ranking, traversal and context implementation. No persistent writes. */
class NativeExploreQueries extends QueryBuilder {
  constructor(db: SqliteDatabase, private snapshots: ExploreSourceSnapshots) { super(db); }

  override getFileByPath(file: string) {
    const record = super.getFileByPath(file);
    return record ? { ...record, generated: this.getGeneratedPathsAmong([file]).has(file) } : null;
  }

  override getAllFiles() {
    const queries = this;
    return super.getAllFiles().map(record => ({
      ...record,
      // Delay absent legacy metadata until a caller asks for the flag.
      get generated() { return queries.getGeneratedPathsAmong([record.path]).has(record.path); },
    }));
  }

  // The native files table predates upstream's generated column. Reconstruct
  // that index-time fact with the SAME detector, only from hash-verified bytes.
  override getGeneratedPathsAmong(paths: Iterable<string>): Set<string> {
    const result = new Set<string>();
    for (const file of new Set(paths)) {
      const snapshot = this.snapshots.get(file);
      if (snapshot.content !== undefined && detectGeneratedFile(file, snapshot.content)) result.add(file);
    }
    return result;
  }
}

const vocabStamps = new WeakMap<SqliteDatabase, string>();
function changeStamp(db: SqliteDatabase): string {
  return `${db.pragma('data_version', { simple: true })}:${db.prepare('SELECT total_changes() AS n').get().n}`;
}

/** TEMP vocabulary avoids upgrading/mutating a native index from a read tool.
 * Rebuild on either same-connection writes or another connection's commit. */
function ensureVocabulary(db: SqliteDatabase, queries: QueryBuilder): void {
  if (vocabStamps.get(db) === changeStamp(db)) return;
  db.exec('CREATE TEMP TABLE IF NOT EXISTS name_segment_vocab (segment TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY(segment,name)) WITHOUT ROWID');
  queries.clearNameSegmentVocab();
  for (let offset = 0; ; offset += 2000) {
    const names = queries.getDistinctNodeNames(2000, offset);
    if (!names.length) break;
    queries.insertNameSegmentsBatch(names);
  }
  vocabStamps.set(db, changeStamp(db));
}

export function createUpstreamExploreGraph(cg: CodeGraph): ExploreGraph {
  const db = cg.getExploreQueryConnection();
  const queries = new NativeExploreQueries(db, new ExploreSourceSnapshots(cg));
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
  return createExploreGraphApi(cg.getProjectRoot(), queries, () => ensureVocabulary(db, queries));
}
