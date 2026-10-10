import { parentPort, workerData } from 'worker_threads';
import { runLocate } from './engine';
import type { LocateTask } from './types';

if (!parentPort) throw new Error('locate worker requires a parent port');
const port = parentPort;
try {
  const result = runLocate(workerData as LocateTask, value => port.postMessage({ type: 'checkpoint', result: value }));
  port.postMessage({ type: 'result', result });
} catch (error) {
  port.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
} finally { port.close(); }
