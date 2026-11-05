/** Portable facts travel with the database, never with its local coordination files. */
import { randomUUID } from "node:crypto";
import type { SqliteDatabase as Database } from "../../db/sqlite-adapter";
export const DATABASE_ID = "portable:database-id-v1";
export const CATCHUP = "portable:source-catchup-v1";
export const COST_HISTORY = "adaptive:cost-history-v1";
export function metadata(db: Database, key: string): string | null {
  return (
    (
      db
        .prepare("SELECT value FROM project_metadata WHERE key = ?")
        .get(key) as { value: string } | undefined
    )?.value ?? null
  );
}
export function setMetadata(db: Database, key: string, value: string): void {
  db.prepare(
    "INSERT OR REPLACE INTO project_metadata(key,value,updated_at) VALUES(?,?,?)",
  ).run(key, value, Date.now());
}
export function initializeIdentity(db: Database): string {
  const existing = metadata(db, DATABASE_ID);
  if (existing) return existing;
  const id = randomUUID();
  setMetadata(db, DATABASE_ID, id);
  return id;
}
