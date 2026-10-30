import { AsyncLocalStorage } from 'node:async_hooks';
import type { WorkerOptions } from 'node:worker_threads';

const isolated = new AsyncLocalStorage<boolean>();

/** Fixed-path catch-up cannot be skipped because its caller was an eval script
 * or used an application loader. Do not mutate process-wide argv/environment. */
export function withIsolatedWorkerRuntime<T>(action: () => T): T {
  return isolated.run(true, action);
}

export function workerRuntimeOptions(options?: WorkerOptions): WorkerOptions | undefined {
  if (!isolated.getStore()) return options;
  return { ...options, execArgv: [], env: { ...process.env,
    ...(typeof options?.env === 'object' ? options.env : {}), NODE_OPTIONS: '' } };
}
