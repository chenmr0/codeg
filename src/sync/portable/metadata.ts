/** Portable facts travel with the database, never with its local coordination files. */
import { randomUUID } from "node:crypto";
import { beginSourceWrite, finishSourceWrite } from "../source-ownership";
import type { AdaptiveCostHistory, AdaptiveCostSample } from "../adaptive-plan";
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
  const ownership = beginSourceWrite(db);
  db.prepare(
    "INSERT OR REPLACE INTO project_metadata(key,value,updated_at) VALUES(?,?,?)",
  ).run(key, value, Date.now());
  finishSourceWrite(db, ownership, true);
}
export function initializeIdentity(db: Database): string {
  const existing = metadata(db, DATABASE_ID);
  if (existing) return existing;
  const id = randomUUID();
  setMetadata(db, DATABASE_ID, id);
  return id;
}
export function recordCost(
  db: Database,
  sample: Omit<AdaptiveCostSample, "recordedAt">,
): void {
  let samples: AdaptiveCostSample[] = [];
  try {
    samples =
      (JSON.parse(metadata(db, COST_HISTORY) ?? "{}") as AdaptiveCostHistory)
        .samples ?? [];
  } catch {
    /* optional hints */
  }
  if (!Array.isArray(samples)) samples = [];
  samples = samples
    .filter(
      (item) => item && Number.isFinite(item.durationMs) && item.durationMs > 0,
    )
    .slice(-95);
  samples.push({ ...sample, recordedAt: Date.now() });
  setMetadata(db, COST_HISTORY, JSON.stringify({ version: 1, samples }));
}
