import { parentPort, workerData } from 'node:worker_threads';
import { scanDirectory } from './index';
import { ScanDiagnostics } from './sync-diagnostics';
import type { RustScanCapture } from './rust-scan';

// Pure filesystem enumeration: no graph/database connection or mutation.
// Reuse the authoritative scanner, including Git, ignores and symlink policy.
const diagnostics = workerData.diagnostics
  ? Object.assign(new ScanDiagnostics(), workerData.diagnostics) : undefined;
const capture: RustScanCapture = {};
try {
  const files = scanDirectory(workerData.rootDir, undefined, diagnostics, capture);
  parentPort?.postMessage({ files, diagnostics, capture });
} catch (error) {
  parentPort?.postMessage({ error: error instanceof Error ? error.stack : String(error) });
} finally { parentPort?.close(); }
