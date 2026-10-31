import { parentPort, workerData } from 'node:worker_threads';
import { createDatabase } from './sqlite-adapter';
import { QueryBuilder } from './queries';

// The parent holds mutation admission and an independent connection lease until
// this thread exits. Keep the existing repair transaction/stamp atomic.
let database: ReturnType<typeof createDatabase>['db'] | undefined;
try {
  const created = createDatabase(workerData.databasePath, { nativeOnly: true });
  database = created.db;
  database.pragma('busy_timeout = 5000');
  database.pragma('foreign_keys = ON');
  database.pragma('synchronous = NORMAL');
  if (workerData.deferWal) database.pragma('wal_autocheckpoint = 0');
  const files = new QueryBuilder(database).repairLegacyCppIncludes();
  database.close(); database = undefined;
  parentPort?.postMessage({ files });
} catch (error) {
  parentPort?.postMessage({ error: error instanceof Error ? error.stack : String(error) });
} finally {
  database?.close();
  parentPort?.close();
}
