import { existsSync } from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';
import {
  cancelledRawEvidenceReport,
  type RawEvidenceProgress,
  type RawEvidenceReport,
  type RawEvidenceTask,
  type RawEvidenceWorkerMessage,
} from './raw-source-types';

// Bound simultaneous scans and their subprocess/output-buffer memory. Workers
// are one-shot: they close after the child is reaped, including on cancellation.
const MAX_ACTIVE_SCANS = 2;
interface ScanJob {
  owner: object;
  task: RawEvidenceTask;
  control: Int32Array;
  worker?: Worker;
  report?: RawEvidenceReport;
  error?: Error;
  onProgress?: (progress: RawEvidenceProgress) => void;
  removeAbortListener: () => void;
  resolve: (report: RawEvidenceReport) => void;
  reject: (error: Error) => void;
}
const jobs = new Set<ScanJob>();
const queue: ScanJob[] = [];
let active = 0;
let exitHandlerInstalled = false;

function killOwnedChild(job: ScanJob): void {
  const pid = Atomics.exchange(job.control, 1, 0);
  if (pid > 0) {
    try { process.kill(pid); } catch { /* already exited */ }
  }
}

function cancel(job: ScanJob): void {
  Atomics.store(job.control, 0, 1);
  if (job.worker) {
    // The shared flag also covers cancellation before the worker's message
    // listener exists. Never terminate a running worker before child cleanup.
    try { job.worker.postMessage({ type: 'cancel' }); } catch { /* exiting */ }
  } else {
    const index = queue.indexOf(job);
    if (index >= 0) queue.splice(index, 1);
    job.removeAbortListener();
    jobs.delete(job);
    job.resolve(cancelledRawEvidenceReport(job.task));
  }
}

/** Called by CodeGraph.close; also cancels jobs still waiting for a slot. */
export function cancelRawEvidenceScans(owner: object): void {
  for (const job of jobs) if (job.owner === owner) cancel(job);
}

function createWorker(job: ScanJob): Worker {
  const options = { workerData: { task: job.task, control: job.control.buffer } };
  const script = path.join(__dirname, 'raw-source-worker.js');
  if (existsSync(script)) return new Worker(script, options);

  // Source-mode tests/embedders cannot run a .ts Worker through Vitest's module
  // loader. Compile only in that development mode; published dist needs no TS.
  const source = path.join(__dirname, 'raw-source-worker.ts');
  if (!existsSync(source)) throw new Error('Raw-source worker is missing; rebuild or reinstall CodeGraph');
  const bootstrap = `
    const fs = require('fs');
    const ts = require(${JSON.stringify(require.resolve('typescript'))});
    require.extensions['.ts'] = (mod, filename) => {
      const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
      }).outputText;
      mod._compile(output, filename);
    };
    require(${JSON.stringify(source)});
  `;
  return new Worker(bootstrap, { ...options, eval: true });
}

function drain(): void {
  while (active < MAX_ACTIVE_SCANS && queue.length > 0) {
    const job = queue.shift()!;
    try {
      job.worker = createWorker(job);
    } catch (error) {
      jobs.delete(job);
      job.removeAbortListener();
      job.reject(new Error(`Failed to start raw-source worker: ${error instanceof Error ? error.message : String(error)}`));
      continue;
    }
    active++;
    job.worker.on('message', (message: RawEvidenceWorkerMessage) => {
      if (message.type === 'result') job.report = message.report;
      else if (message.type === 'error') job.error = new Error(message.message);
      else if (message.type === 'progress') {
        try { job.onProgress?.(message.progress); }
        catch (error) {
          job.error = error instanceof Error ? error : new Error(String(error));
          cancel(job);
        }
      }
    });
    job.worker.once('error', (error) => { job.error = error; });
    job.worker.once('exit', (code) => {
      // Unexpected worker termination must not leave its rg running. The PID
      // is shared synchronously, so cleanup doesn't depend on a progress event
      // reaching a busy MCP thread first.
      killOwnedChild(job);
      active--;
      jobs.delete(job);
      job.removeAbortListener();
      if (job.error || code !== 0 || !job.report) {
        job.reject(job.error ?? new Error(`Raw-source worker exited without a result (code ${code})`));
      } else {
        // Cancellation received after worker completion but before delivery
        // still wins. Elapsed main-thread time NEVER changes a completed scan
        // into a timeout here.
        const report = Atomics.load(job.control, 0) === 1
          ? { ...job.report, cancelled: true }
          : job.report;
        job.resolve(report);
      }
      drain();
    });
  }
}

export function runRawEvidenceWorker(
  owner: object,
  task: RawEvidenceTask,
  signal?: AbortSignal,
  onProgress?: (progress: RawEvidenceProgress) => void,
): Promise<RawEvidenceReport> {
  if (signal?.aborted) return Promise.resolve(cancelledRawEvidenceReport(task));
  if (!exitHandlerInstalled) {
    exitHandlerInstalled = true;
    // MCP's shutdown uses process.exit after closing its engine. Workers may
    // not get another turn to consume cancel, so reap known children here too.
    process.once('exit', () => {
      for (const job of jobs) {
        Atomics.store(job.control, 0, 1);
        killOwnedChild(job);
      }
    });
  }
  return new Promise((resolve, reject) => {
    const job: ScanJob = {
      owner, task, control: new Int32Array(new SharedArrayBuffer(8)),
      resolve, reject, onProgress, removeAbortListener: () => {},
    };
    const abort = () => cancel(job);
    job.removeAbortListener = () => signal?.removeEventListener('abort', abort);
    jobs.add(job);
    queue.push(job);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    drain();
  });
}
