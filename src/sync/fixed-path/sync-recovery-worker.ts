import { parentPort, workerData } from 'node:worker_threads';
import { recover, recoverExisting } from './protocol';
// Recovery owns its own publisher/connection fences. Hashing and removal of
// abandoned large databases must never run on a querying SDK/MCP event loop.
try {
  const maintenance: { cleanupDeferred?: unknown[] } = {};
  const recovered = (workerData.maintenance ? recoverExisting : recover)(workerData, { deferMaintenance: true, maintenance });
  parentPort?.postMessage({ recovered, pending: !recovered || !!maintenance.cleanupDeferred?.length, cleanupDeferred: maintenance.cleanupDeferred });
}
catch (error) { parentPort?.postMessage({ error: error instanceof Error ? error.stack : String(error) }); }
finally { parentPort?.close(); }
