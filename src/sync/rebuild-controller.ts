import * as fs from 'fs';
import * as path from 'path';
import { fork } from 'child_process';
import type { IndexProgress, IndexResult } from '../extraction';
import { DatabaseConnection } from '../db';
import type { AdaptiveSnapshot } from './adaptive-plan';
import { isSourceOwned } from './source-ownership';

/** Reject on cancellation only after the child exited, so callers may then release the root lock. */
export async function runRebuildChild(root: string, databasePath: string, options: {
  signal?: AbortSignal; onProgress?: (progress: IndexProgress) => void;
}): Promise<IndexResult> {
  if (options.signal?.aborted) throw new Error('Adaptive rebuild cancelled');
  const worker = path.join(__dirname, 'rebuild-worker.js');
  if (!fs.existsSync(worker)) throw new Error('Adaptive rebuild worker is not built');
  const out = fs.openSync(path.join(path.dirname(databasePath), 'build.stdout.log'), 'wx');
  let err: number | undefined;
  try {
    err = fs.openSync(path.join(path.dirname(databasePath), 'build.stderr.log'), 'wx');
    return await new Promise<IndexResult>((resolve, reject) => {
      const child = fork(worker, [root, databasePath], {
        stdio: ['ignore', out, err!, 'ipc'],
        // Preserve runtime flags but never inherit test loaders, debugger ports or eval source.
        execArgv: process.execArgv.filter(arg => arg === '--liftoff-only' || /^--max[-_]old[-_]space[-_]size=\d+$/.test(arg)),
        env: { ...process.env, CODEGRAPH_ADAPTIVE_CHILD: '1' },
      });
      let result: IndexResult | undefined;
      let failure: Error | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      let cancelled = false;
      const abort = (): void => {
        cancelled = true;
        child.kill('SIGTERM');
        killTimer ??= setTimeout(() => child.kill('SIGKILL'), 2000);
        killTimer.unref();
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      child.on('message', (message: unknown) => {
        const m = message as { type?: string; result?: IndexResult; progress?: IndexProgress };
        if (m?.type === 'result') result = m.result;
        if (m?.type === 'progress' && m.progress) {
          try { options.onProgress?.(m.progress); }
          catch (error) { failure = error instanceof Error ? error : new Error(String(error)); abort(); }
        }
      });
      child.on('error', error => { failure = error; });
      child.once('close', (code, signal) => {
        options.signal?.removeEventListener('abort', abort);
        if (killTimer) clearTimeout(killTimer);
        if (cancelled || failure || code !== 0 || !result) {
          reject(failure ?? new Error(cancelled ? 'Adaptive rebuild cancelled; old generation retained' :
            `Adaptive rebuild child failed (code=${code}, signal=${signal}); old generation retained`));
        } else resolve(result);
      });
      if (options.signal?.aborted) abort();
    });
  } finally { fs.closeSync(out); if (err !== undefined) fs.closeSync(err); }
}

/** No migration, repair or database writes are permitted during validation. */
export function validateRebuiltDatabase(databasePath: string, snapshot: AdaptiveSnapshot): boolean {
  const connection = DatabaseConnection.openReadOnly(databasePath);
  const db = connection.getDb();
  try {
    if (!isSourceOwned(db)) return false;
    const quick = db.prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>;
    if (quick.length !== 1 || Object.values(quick[0]!)[0] !== 'ok') return false;
    if (db.prepare('PRAGMA foreign_key_check').all().length) return false;
    const completeness = db.prepare("SELECT value FROM project_metadata WHERE key = 'index_completeness'").get() as { value: string } | undefined;
    if (completeness?.value !== 'complete') return false;
    const files = db.prepare('SELECT path, content_hash AS hash, errors FROM files').all() as Array<{path: string; hash: string; errors: string | null}>;
    if (files.length !== snapshot.files.length) return false;
    const expected = new Map(snapshot.files.map(file => [file.path, file.contentHash]));
    for (const file of files) {
      if (expected.get(file.path) !== file.hash) return false;
      if (file.errors) {
        let diagnostics: unknown;
        try { diagnostics = JSON.parse(file.errors); } catch { return false; }
        if (!Array.isArray(diagnostics) || diagnostics.some(diagnostic => !diagnostic ||
          diagnostic.code !== 'skipped_macro_data_header' || diagnostic.severity !== 'warning')) return false;
      }
    }
    const objects = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type IN ('index','trigger','table')").all() as Array<{name:string}>).map(row => row.name));
    return ['nodes_fts', 'nodes_ai', 'nodes_ad', 'nodes_au', 'idx_edges_identity', 'idx_nodes_name', 'idx_nodes_kind', 'idx_unresolved_status'].every(name => objects.has(name));
  } finally { connection.close(); }
}

/** Wait for worker exit on every path: validation cannot outlive writer ownership. */
export async function runAdaptiveReadWorker<T>(job: import('./rebuild-validation-worker').AdaptiveReadJob,
  options: { signal?: AbortSignal; isolatedRuntime?: boolean } = {}): Promise<T> {
  if (options.signal?.aborted) throw new Error('Adaptive read cancelled');
  // TypeScript development/tests still execute the explicitly built worker.
  // Packaged JS always resolves its adjacent, version-matched worker.
  const workerPath = __filename.endsWith('.ts')
    ? path.resolve(__dirname, '../../dist/sync/rebuild-validation-worker.js')
    : path.join(__dirname, 'rebuild-validation-worker.js');
  if (!fs.existsSync(workerPath)) throw new Error('Adaptive validation worker is not built');
  const { Worker } = await import('worker_threads');
  const worker = new Worker(workerPath, { workerData: { job, parentExecArgv: [...process.execArgv] },
    // Durable fixed-path catch-up is mandatory even when optional adaptive
    // planning is disabled by a parent-only loader / --input-type flag.
    ...(options.isolatedRuntime ? {
      execArgv: [],
      env: { ...process.env, NODE_OPTIONS: '' },
    } : {}),
  });
  return await waitForAdaptiveReadWorker<T>(worker, options.signal);
}

/** @internal Lifecycle seam tested without starting expensive graph validation. */
export function waitForAdaptiveReadWorker<T>(worker: import('worker_threads').Worker, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let result: T | undefined;
    let received = false;
    let failure: Error | undefined;
    let cancelled = false;
    const abort = (): void => { cancelled = true; void worker.terminate().catch(error => { failure = error; }); };
    signal?.addEventListener('abort', abort, { once: true });
    worker.on('message', (message: { result?: T; error?: string }) => {
      if (!message || typeof message !== 'object') failure = new Error('Malformed adaptive worker response');
      else if (message.error) failure = new Error(message.error);
      else if (Object.prototype.hasOwnProperty.call(message, 'result')) { result = message.result; received = true; }
      else failure = new Error('Adaptive worker response has no result');
    });
    worker.on('error', error => { failure = error; });
    worker.once('exit', code => {
      signal?.removeEventListener('abort', abort);
      if (cancelled || failure || code !== 0 || !received) reject(failure ?? new Error(cancelled ?
        'Adaptive read cancelled; old generation retained' : `Adaptive validation worker exited ${code}`));
      else resolve(result as T);
    });
    if (signal?.aborted) abort();
  });
}
