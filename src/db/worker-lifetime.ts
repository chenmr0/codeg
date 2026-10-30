import { workerRuntimeOptions } from '../worker-runtime';
import { Worker, type WorkerOptions } from 'node:worker_threads';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertFixedPathOpenAdmitted, fixedPathDatabaseKey } from '../sync/fixed-path/open-context';

export type WorkerLeaseFactory = () => { release(): void };
export interface ProtectedDatabaseWorker {
  worker: Worker;
  exited: Promise<void>;
  stop(): void;
}
/** Parent-side ownership is acquired before launch and released only by the OS
 * thread exit event. Messages and terminate() rejection are not closure proof. */
export function startDatabaseWorker(script: string, dbPath: string,
  leaseFactory?: WorkerLeaseFactory, options?: WorkerOptions): ProtectedDatabaseWorker {
  if (!leaseFactory) {
    assertFixedPathOpenAdmitted(dbPath);
    // Construction capability only protects the synchronous parent open. It
    // never substitutes for independent ownership of a new native thread.
    const file = fixedPathDatabaseKey(dbPath);
    if (path.basename(file) === 'codegraph.db' && fs.existsSync(path.join(path.dirname(file), '.runtime', 'layout.json'))) {
      throw new Error('Fixed-path database worker requires an independent lease factory');
    }
  }
  const held = leaseFactory?.();
  let worker: Worker;
  try { worker = new Worker(script, workerRuntimeOptions(options)); }
  catch (error) { held?.release(); throw error; }
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    try { void worker.terminate().catch(() => {}); } catch { /* real exit is still required */ }
  };
  const exited = new Promise<void>((resolve, reject) => {
    worker.once('exit', () => {
      try { held?.release(); resolve(); } catch (error) { reject(error); }
    });
  });
  // A startup error must not strand a native thread when a client downgrades.
  worker.once('error', stop);
  void exited.catch(() => {});
  return { worker, exited, stop };
}
