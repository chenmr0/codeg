import * as fs from 'node:fs';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { paths, lease, records, state } from './protocol';
import type { FixedPathProject } from './controller';

const failedCloses = new Set<{ close(): void }>();
function busy(error: unknown): boolean {
  const code = (error as { errcode?: number }).errcode;
  return typeof code === 'number' && ((code & 255) === 5 || (code & 255) === 6);
}
function tryAcquire(file: string): { close(): void } | null {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { if (!fs.lstatSync(file + suffix).isFile()) throw new Error('Unsafe sync admission file'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=FULL');
    if (Object.values(db.prepare('PRAGMA journal_mode').get())[0] !== 'delete') throw new Error('Sync admission requires DELETE journal mode');
    db.exec('CREATE TABLE IF NOT EXISTS admission(value INTEGER); BEGIN EXCLUSIVE');
  } catch (error) {
    try { db.close(); } catch (closeError) { failedCloses.add(db); throw new AggregateError([error, closeError], 'Sync admission close failed'); }
    if (busy(error)) return null;
    throw error;
  }
  let released = false;
  return { close() {
    if (released) return;
    try { db.close(); released = true; failedCloses.delete(db); }
    catch (error) { failedCloses.add(db); throw error; }
  } };
}
function pause(signal?: AbortSignal, delayMs = 50): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new Error('Fixed-path sync admission cancelled')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, delayMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
function recoverOffThread(project: FixedPathProject, signal: AbortSignal | undefined, deadline: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    if (performance.now() >= deadline) { reject(new Error('Fixed-path sync admission timed out before recovery')); return; }
    // Recovery can precede catch-up's async context (including a queued caller
    // whose publisher just exited). Parent-only flags/loaders cannot block it.
    const worker = new Worker(path.join(__dirname, 'sync-recovery-worker.js'), {
      workerData: project, execArgv: [], env: { ...process.env, NODE_OPTIONS: '' },
    });
    let timedOut = false;
    let response: { recovered?: boolean; error?: string } | undefined, failure: Error | undefined;
    const cancel = (): void => { void worker.terminate().catch(() => {}); };
    const timer = setTimeout(() => { timedOut = true; cancel(); }, Math.max(1, deadline - performance.now()));
    worker.on('message', value => { response = value; });
    worker.on('error', error => { failure = error; });
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    worker.once('exit', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      if (timedOut) reject(new Error('Fixed-path sync admission timed out during recovery'));
      else if (signal?.aborted) reject(new Error('Fixed-path sync admission cancelled'));
      else if (failure || code !== 0 || response?.error || typeof response?.recovered !== 'boolean') reject(failure ?? new Error(response?.error ?? `Sync recovery worker exited ${code}`));
      else resolve(response.recovered);
    });
  });
}
/** Serializes whole cooperating sync operations BEFORE planning, never queries.
 * Waiters own no graph, mutation, publisher or read lease. After admission they
 * plan from current storage/source rather than reuse another process's plan.
 * A crashed holder releases the OS lock; no PID/time based lock stealing. */
export async function acquireFixedSyncAdmission(project: FixedPathProject,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<{ close(): void }> {
  const timeout = options.timeoutMs ?? 30 * 60 * 1000;
  if (!Number.isFinite(timeout) || timeout < 0) throw new Error('syncCoordinationTimeoutMs must be finite and non-negative');
  const p = paths(project), file = path.join(p.runtime, 'sync-admission.sqlite');
  const deadline = performance.now() + timeout;
  let waited = false;
  while (true) {
    if (waited && performance.now() >= deadline) throw new Error(`Fixed-path sync admission timed out after ${timeout}ms; existing sync was not cancelled`);
    if (options.signal?.aborted) throw new Error('Fixed-path sync admission cancelled');
    const held = tryAcquire(file);
    if (held) {
      try {
        // The previous sync parent may have died before its publisher child.
        // Its separate OS owner remains authoritative until actual child exit.
        while (true) {
          if (waited && performance.now() >= deadline) throw new Error(`Fixed-path sync admission timed out after ${timeout}ms; existing publisher was not cancelled`);
          if (options.signal?.aborted) throw new Error('Fixed-path sync admission cancelled');
          const publisher = lease(p.owner, true);
          if (publisher) {
            publisher.close();
            if (state(p).mode === 'idle' && records(p).every((record: { phase: string }) => record.phase === 'cleaned')) return held;
            if (await recoverOffThread(project, options.signal, deadline)) return held;
          }
          if (performance.now() >= deadline) throw new Error(`Fixed-path sync admission timed out after ${timeout}ms; existing publisher was not cancelled`);
          waited = true; await pause(options.signal, Math.max(1, Math.min(50, deadline - performance.now())));
        }
      } catch (error) { held.close(); throw error; }
    }
    if (performance.now() >= deadline) throw new Error(`Fixed-path sync admission timed out after ${timeout}ms; existing sync was not cancelled`);
    waited = true; await pause(options.signal, Math.max(1, Math.min(50, deadline - performance.now())));
  }
}
