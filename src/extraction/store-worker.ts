/**
 * Dedicated SQLite writer for fresh indexing and expensive sync replacements.
 */

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  (require('node:module') as { enableCompileCache?: () => void }).enableCompileCache?.();
} catch {
  // best-effort
}

import { parentPort } from 'worker_threads';
import { QueryBuilder } from '../db/queries';
import { createDatabase, type SqliteDatabase } from '../db/sqlite-adapter';
import type { StoreBundle, StoreReplacement } from './store-writer';

if (!parentPort) {
  throw new Error('store-worker must run in a worker thread');
}
const port = parentPort;

let database: SqliteDatabase | null = null;
let queries: QueryBuilder | null = null;
let replacementRoot: string | undefined;
let replacementStore: import('./index').ExtractionOrchestrator | null = null;

type StoreWorkerMessage =
  | { type: 'open'; dbPath: string; fastInit: boolean; replacement?: { root: string; deferWal: boolean } }
  | { type: 'bundle'; bundle: StoreBundle }
  | { type: 'replace'; id: number; request: StoreReplacement }
  | { type: 'drain'; id: number }
  | { type: 'close' };

port.on('message', (message: StoreWorkerMessage) => {
  try {
    switch (message.type) {
      case 'open': {
        const created = createDatabase(message.dbPath);
        if (created.backend !== 'node-sqlite') {
          created.db.close();
          throw new Error('store worker requires the node:sqlite backend');
        }
        database = created.db;
        database.pragma('busy_timeout = 5000');
        database.pragma('foreign_keys = ON');
        if (message.fastInit) {
          database.pragma('journal_mode = MEMORY');
          database.pragma('synchronous = OFF');
        } else {
          database.pragma('synchronous = NORMAL');
        }
        database.pragma('cache_size = -64000');
        database.pragma('temp_store = MEMORY');
        database.pragma('mmap_size = 268435456');
        if (message.replacement?.deferWal) database.pragma('wal_autocheckpoint = 0');
        replacementRoot = message.replacement?.root;
        queries = new QueryBuilder(database);
        port.postMessage({ type: 'ready' });
        break;
      }
      case 'bundle':
        if (!queries) throw new Error('bundle received before database open');
        queries.storeFileBundle(message.bundle);
        port.postMessage({ type: 'ack' });
        break;
      case 'replace': {
        if (!queries || !replacementRoot) throw new Error('replacement received before sync store open');
        if (!replacementStore) {
          // Lazy: fresh indexing keeps its lightweight bundle-only worker.
          const { ExtractionOrchestrator } = require('./index') as typeof import('./index');
          replacementStore = new ExtractionOrchestrator(replacementRoot, queries);
        }
        // Readers on the owning connection keep seeing the old file until
        // deletion, insertion and incoming-edge rewiring all commit together.
        const result = database!.transaction(() =>
          replacementStore!.storeParsedReplacement(message.request))();
        port.postMessage({ type: 'replaced', id: message.id, result });
        break;
      }
      case 'drain':
        port.postMessage({ type: 'drained', id: message.id });
        break;
      case 'close':
        try {
          database?.close();
        } catch {
          // already closed
        }
        process.exit(0);
    }
  } catch (error) {
    port.postMessage({
      type: 'error',
      id: 'id' in message ? message.id : undefined,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
