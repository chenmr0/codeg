import * as path from 'node:path';
import { startDatabaseWorker, type WorkerLeaseFactory } from './worker-lifetime';

/** Return only after real thread exit, including cancellation and open failure. */
export async function repairLegacyIncludesOffThread(databasePath: string,
  leaseFactory: WorkerLeaseFactory, signal?: AbortSignal, deferWal = false): Promise<string[]> {
  signal?.throwIfAborted();
  const lifetime = startDatabaseWorker(path.join(__dirname, 'legacy-include-repair-worker.js'),
    databasePath, leaseFactory, { workerData: { databasePath, deferWal }, execArgv: [],
      env: { ...process.env, NODE_OPTIONS: '' } });
  let response: { files?: string[]; error?: string } | undefined;
  let failure: Error | undefined;
  let code: number | undefined;
  lifetime.worker.on('message', message => { response = message; });
  lifetime.worker.on('error', error => { failure = error; });
  lifetime.worker.once('exit', value => { code = value; });
  const abort = (): void => lifetime.stop();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    await lifetime.exited;
    signal?.throwIfAborted();
    if (failure || code !== 0 || response?.error || !Array.isArray(response?.files)) {
      throw failure ?? new Error(response?.error ?? `Legacy include repair worker exited ${code}`);
    }
    return response.files;
  } finally { signal?.removeEventListener('abort', abort); }
}
