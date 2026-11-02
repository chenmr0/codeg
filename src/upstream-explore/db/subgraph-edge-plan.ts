import type { SqliteDatabase } from './sqlite-adapter';

/**
 * A high-indegree target can make SQLite's target-first IN/IN plan hundreds
 * of times more expensive than source probes. Recover the exact legacy scan
 * order, not just its set: Explore keeps the first edge per source/target/kind
 * and downstream budget allocation can depend on insertion order.
 *
 * Only the known ascending BINARY (target,kind,rowid) plan is rewritten.
 * Unknown index layouts, planners, partial indexes and reverse scans retain their
 * original SQL. Inspect on each invocation: an open connection may see schema,
 * statistics or PRAGMA changes. This never writes the user's portable DB.
 */
export function subgraphEdgeSql(db: SqliteDatabase, sql: string, params: readonly string[]): string {
  try {
    const reverse = db.prepare('PRAGMA reverse_unordered_selects').get() as Record<string, number> | undefined;
    if (!reverse || Object.values(reverse)[0] !== 0) return sql;
    const indexes = db.prepare("PRAGMA index_list('edges')").all() as Array<{ name: string; partial: number }>;
    const valid = (name: string, first: string): boolean => {
      if (!indexes.some(row => row.name === name && row.partial === 0)) return false;
      const cols = db.prepare(`PRAGMA index_xinfo('${name}')`).all() as Array<{
        cid: number; name: string | null; desc: number; coll: string; key: number;
      }>;
      return cols.length === 3
        && cols[0]?.name === first && cols[0]?.key === 1
        && cols[1]?.name === 'kind' && cols[1]?.key === 1
        && cols[2]?.cid === -1 && cols[2]?.key === 0
        && cols.every(row => row.desc === 0 && row.coll === 'BINARY');
    };
    if (!valid('idx_edges_target_kind', 'target') || !valid('idx_edges_source_kind', 'source')) return sql;
    const details = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
      .map(row => row.detail).filter(detail => /\bedges\b/.test(detail));
    if (details.length !== 1 || !/^SEARCH (?:TABLE )?edges USING INDEX idx_edges_target_kind \(target=\?(?: AND kind=\?)?\)$/.test(details[0]!)) return sql;
    // Both probes are covering and bounded. A source hub can be the inverse
    // of the target-hub problem, so do not blindly force source-first. Small
    // differences do not repay the explicit sort and compatibility checks.
    const kindOffset = sql.indexOf(' AND kind IN (');
    const kindClause = kindOffset < 0 ? '' : sql.slice(kindOffset);
    const probeParams = [params[0]!, ...params.slice(2)];
    const count = (side: 'source' | 'target', limit: number): number =>
      (db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM edges INDEXED BY idx_edges_${side}_kind`
        + ` WHERE ${side} IN (SELECT value FROM json_each(?))${kindClause} LIMIT ${limit})`)
        .get(...probeParams) as { n: number }).n;
    const sources = count('source', 4097);
    if (sources === 0 || sources > 4096) return sql;
    const threshold = Math.max(128, sources * 4);
    if (count('target', threshold) < threshold) return sql;
    return sql.replace('FROM edges WHERE', 'FROM edges INDEXED BY idx_edges_source_kind WHERE')
      + ' ORDER BY target COLLATE BINARY, kind COLLATE BINARY, rowid';
  } catch {
    // Compatibility is more important than this optional acceleration.
    return sql;
  }
}
