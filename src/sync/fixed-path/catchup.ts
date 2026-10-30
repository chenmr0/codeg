import type { SqliteDatabase } from '../../db/sqlite-adapter';
import { beginSourceWrite, finishSourceWrite } from '../source-ownership';

/** Stored inside the candidate BEFORE sealing/publication. The obligation moves
 * with that database, including crash recovery and an offline database copy. */
export const FIXED_PATH_CATCHUP = 'fixed-path:source-catchup-v1';

export function readFixedPathCatchup(db: SqliteDatabase): string | null {
  const row = db.prepare('SELECT value FROM project_metadata WHERE key = ?')
    .get(FIXED_PATH_CATCHUP) as { value: string } | undefined;
  return row?.value ?? null;
}

/** Caller exclusively owns the unpublished candidate. Metadata and provenance
 * commit together; there is no published-but-not-yet-marked crash window. */
export function markFixedPathCatchup(db: SqliteDatabase, operation: string): void {
  db.transaction(() => {
    const ownership = beginSourceWrite(db);
    if (!ownership) throw new Error('Catch-up candidate must retain source ownership');
    db.prepare('INSERT OR REPLACE INTO project_metadata(key,value,updated_at) VALUES(?,?,?)')
      .run(FIXED_PATH_CATCHUP, operation, Date.now());
    if (!finishSourceWrite(db, ownership, true)) throw new Error('Catch-up candidate ownership changed');
  })();
}

/** Caller holds mutation AND writer admission continuously from full content
 * verification through this acknowledgement. Never acknowledge another image. */
export function clearFixedPathCatchup(db: SqliteDatabase, operation: string): boolean {
  return db.transaction(() => {
    if (readFixedPathCatchup(db) !== operation) return false;
    const ownership = beginSourceWrite(db);
    db.prepare('DELETE FROM project_metadata WHERE key = ? AND value = ?').run(FIXED_PATH_CATCHUP, operation);
    // Failed prior syncs can lose source ownership. Finishing catch-up does not
    // grant it back, nor does the marker authorize replacement of a custom DB.
    if (ownership && !finishSourceWrite(db, ownership, true)) throw new Error('Catch-up acknowledgement ownership changed');
    return true;
  })();
}
