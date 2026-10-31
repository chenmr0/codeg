import * as fs from 'node:fs';
import * as path from 'node:path';
import { Worker, isMainThread } from 'node:worker_threads';
import { languageScopeWorkerEnv } from './language-scope';
import type { ScanDiagnostics } from './sync-diagnostics';
import type { RustScanCapture } from './rust-scan';

const script = path.join(__dirname, 'scan-worker.js');
export function canScanOffThread(): boolean {
  // Planning/index workers are already isolated from the serving event loop.
  // Direct TypeScript users retain the existing implementation without loaders.
  return isMainThread && fs.existsSync(script);
}

export async function scanOffThread(rootDir: string, diagnostics?: ScanDiagnostics,
  capture?: RustScanCapture): Promise<string[]> {
  if (capture) { capture.snapshot = undefined; capture.fallback = undefined; }
  const worker = new Worker(script, { workerData: { rootDir: path.resolve(rootDir), diagnostics },
    execArgv: [], env: { ...languageScopeWorkerEnv(), NODE_OPTIONS: '' } });
  let result: { files?: string[]; diagnostics?: ScanDiagnostics; capture?: RustScanCapture; error?: string } | undefined;
  let failure: Error | undefined;
  await new Promise<void>((resolve, reject) => {
    worker.on('message', value => { result = value; });
    worker.on('error', error => { failure = error; });
    worker.once('exit', code => {
      if (failure || code !== 0 || result?.error || !Array.isArray(result?.files)) {
        reject(failure ?? new Error(result?.error ?? `Filesystem scan worker exited ${code}`));
      } else resolve();
    });
  });
  if (diagnostics && result!.diagnostics) Object.assign(diagnostics, result!.diagnostics);
  if (capture && result!.capture) Object.assign(capture, result!.capture);
  return result!.files!;
}
