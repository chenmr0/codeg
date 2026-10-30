import { parentPort, workerData } from 'node:worker_threads';
import { recover } from './protocol';
// Recovery owns its own publisher/connection fences. Hashing and removal of
// abandoned large databases must never run on a querying SDK/MCP event loop.
try { parentPort?.postMessage({ recovered: recover(workerData, { deferMaintenance: true }) }); }
catch (error) { parentPort?.postMessage({ error: error instanceof Error ? error.stack : String(error) }); }
finally { parentPort?.close(); }
