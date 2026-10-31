import { fork } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import * as path from 'node:path';
import type { IndexProgress, SyncResult } from '../../extraction';
import type { FixedPathProject } from './controller';
import type { AdaptivePlan } from '../adaptive-plan';

const preConstructionContention = new WeakSet<Error>();
/** Only errors received from the child before operation construction qualify;
 * a caller's progress exception carrying the same string code does not. */
export function isFixedPublisherBusy(error: unknown): boolean {
  return error instanceof Error && preConstructionContention.has(error);
}

/** The publisher process is gone, including all native builder threads.
 * Recovery still obtains its own OS leases and hashes off the query event loop. */
function recoverAfterExit(project: FixedPathProject): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'sync-recovery-worker.js'), {
      workerData: project, execArgv: [], env: { ...process.env, NODE_OPTIONS: '' },
    });
    let response: { recovered?: boolean; error?: string } | undefined, failure: Error | undefined;
    worker.on('message', value => { response = value; });
    worker.on('error', error => { failure = error; });
    worker.once('exit', code => {
      if (failure || code !== 0 || response?.error || typeof response?.recovered !== 'boolean') {
        reject(failure ?? new Error(response?.error ?? `Post-build recovery worker exited ${code}`));
      } else resolve(); // A different live owner may legitimately defer collection.
    });
  });
}

/** Publisher owns candidate AND publication in one process. Parent completion
 * always waits for actual exit, including cancellation; no orphan builder PID heuristics. */
export function runFixedPathRebuild(project: FixedPathProject, plan: AdaptivePlan,
  options: { expectedRevision: number; signal?: AbortSignal; onProgress?: (progress: IndexProgress) => void }): Promise<SyncResult> {
  if (options.signal?.aborted) return Promise.reject(new Error('Fixed-path rebuild cancelled'));
  return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, 'rebuild-worker.js'), [project.project, project.dataDirectory], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      execArgv: process.execArgv.filter(arg => arg === '--liftoff-only' || /^--max[-_]old[-_]space[-_]size=\d+$/.test(arg)),
      env: { ...process.env, CODEGRAPH_ADAPTIVE_CHILD: '1' },
    });
    let result: SyncResult | undefined, failure: Error | undefined, stderr = '', timer: NodeJS.Timeout | undefined;
    let cancelled = false;
    child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-16384); });
    const abort = (): void => { cancelled = true; child.kill('SIGTERM'); timer ??= setTimeout(() => child.kill('SIGKILL'), 2000); timer.unref(); };
    options.signal?.addEventListener('abort', abort, { once: true });
    child.on('message', message => {
      const item = message as { type?: string; result?: SyncResult; progress?: IndexProgress; error?: string; code?: string };
      if (item.type === 'result') result = item.result;
      if (item.type === 'error') {
        failure = new Error(item.error);
        if (item.code === 'FIXED_PUBLISHER_BUSY') preConstructionContention.add(failure);
        // A builder reporting an error may still own native worker threads.
        // Terminate it and wait for actual close before attempting reclamation.
        abort();
      }
      if (item.type === 'progress' && item.progress) {
        try { options.onProgress?.(item.progress); } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); abort(); }
      }
    });
    child.on('error', error => { failure = error; });
    child.once('close', async code => {
      options.signal?.removeEventListener('abort', abort); if (timer) clearTimeout(timer);
      try { await recoverAfterExit(project); } catch (error) {
        failure = failure ? new AggregateError([failure, error], 'Rebuild failed and recovery remains blocked')
          : error instanceof Error ? error : new Error(String(error));
      }
      if (cancelled || failure || code !== 0 || !result) reject(failure ?? new Error(cancelled ? 'Fixed-path rebuild cancelled' : `Fixed-path rebuild failed (${code}): ${stderr}`));
      else resolve(result);
    });
    child.send({ plan, expectedRevision: options.expectedRevision, parentExecArgv: [...process.execArgv] });
    if (options.signal?.aborted) abort();
  });
}
