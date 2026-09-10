/**
 * Dedicated SQLite writer for the fresh-database parse phase.
 */

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  (require('node:module') as { enableCompileCache?: () => void }).enableCompileCache?.();
} catch {
  // best-effort
}

import { parentPort } from 'worker_threads';
import {
  DEFAULT_WRITE_BATCH_SIZES,
  NATIVE_STORE_WRITE_BATCH_SIZES,
  QueryBuilder,
} from '../db/queries';
import { createDatabase, type SqliteDatabase } from '../db/sqlite-adapter';
import type {
  StoreBundle,
  StoreWorkerTransactionStats,
} from './store-writer';

if (!parentPort) {
  throw new Error('store-worker must run in a worker thread');
}
const port = parentPort;

let database: SqliteDatabase | null = null;
let queries: QueryBuilder | null = null;

type StoreWorkerMessage =
  | { type: 'open'; dbPath: string; fastInit: boolean }
  | { type: 'batch'; bundles: StoreBundle[] }
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
        queries = new QueryBuilder(database, {
          batchSizes:
            process.env.CODEGRAPH_NO_NATIVE_STORE_ROW_BATCH === '1'
              ? DEFAULT_WRITE_BATCH_SIZES
              : NATIVE_STORE_WRITE_BATCH_SIZES,
        });
        port.postMessage({ type: 'ready' });
        break;
      }
      case 'batch': {
        if (!queries) throw new Error('batch received before database open');
        const timing = queries.storeFileBundles(message.bundles);
        const stats: StoreWorkerTransactionStats = {
          ...timing,
          filesStored: message.bundles.length,
          nodesStored: 0,
          edgesStored: 0,
          unresolvedRefsStored: 0,
        };
        for (const bundle of message.bundles) {
          stats.nodesStored += bundle.nodes.length;
          stats.edgesStored += bundle.edges.length;
          stats.unresolvedRefsStored += bundle.refs.length;
        }
        stats.nodesStored -= timing.duplicateNodeRowsElided;
        port.postMessage({
          type: 'ack',
          bundleCount: message.bundles.length,
          stats,
        });
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
      bundleCount: message.type === 'batch' ? message.bundles.length : 0,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
