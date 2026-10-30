import { fork } from 'node:child_process';
import * as path from 'node:path';
import type { IndexProgress, SyncResult } from '../../extraction';
import type { FixedPathProject } from './controller';
import type { AdaptivePlan } from '../adaptive-plan';

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
      const item = message as { type?: string; result?: SyncResult; progress?: IndexProgress; error?: string };
      if (item.type === 'result') result = item.result;
      if (item.type === 'error') failure = new Error(item.error);
      if (item.type === 'progress' && item.progress) {
        try { options.onProgress?.(item.progress); } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); abort(); }
      }
    });
    child.on('error', error => { failure = error; });
    child.once('close', code => {
      options.signal?.removeEventListener('abort', abort); if (timer) clearTimeout(timer);
      if (cancelled || failure || code !== 0 || !result) reject(failure ?? new Error(cancelled ? 'Fixed-path rebuild cancelled' : `Fixed-path rebuild failed (${code}): ${stderr}`));
      else resolve(result);
    });
    child.send({ plan, expectedRevision: options.expectedRevision, parentExecArgv: [...process.execArgv] });
    if (options.signal?.aborted) abort();
  });
}
