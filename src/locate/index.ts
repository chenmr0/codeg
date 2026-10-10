import * as fs from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { extractLocateDocument } from './signals';
import { emptyLocateResult, type LocateTask, type LocateOptions, type LocateResult } from './types';
import { boundLocateOutput } from './output';

export type { LocateResult, LocateOptions } from './types';
export const MAX_DOCUMENT_BYTES = 128 * 1024;

export function integerOption(value: number | undefined, fallback: number, min: number, max: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return result;
}

export function readLocateDocument(file: string): string {
  const fd = fs.openSync(path.resolve(file), 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_DOCUMENT_BYTES) throw new Error('Document must be a regular UTF-8 file no larger than 128 KiB');
    const buffer = Buffer.alloc(MAX_DOCUMENT_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = fs.readSync(fd, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > MAX_DOCUMENT_BYTES) throw new Error('Document exceeds 128 KiB');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
  } finally { fs.closeSync(fd); }
}

/** A worker deadline can interrupt synchronous SQLite work, not just asynchronous waits. */
export async function locateIssue(projectPath: string, input: string, options: LocateOptions = {}): Promise<LocateResult> {
  const started = performance.now();
  if (typeof input !== 'string' || !input.trim()) throw new Error('Document text must not be empty');
  if (Buffer.byteLength(input, 'utf8') > MAX_DOCUMENT_BYTES) throw new Error('Document exceeds 128 KiB');
  const finishOutput = (result: LocateResult) => {
    const lines = input.split(/\r?\n/);
    for (const candidate of result.candidates) {
      const evidence = candidate.evidence.find(e => e.kind !== 'graph') ?? candidate.evidence[0];
      if (evidence) {
        const text = lines[evidence.documentLine - 1]?.trim();
        if (text) evidence.documentText = text.length > 200 ? text.slice(0, 199) + '…' : text;
      }
    }
    return boundLocateOutput(result, options.outputFormat ?? 'json', options.verbose).result;
  };
  const task: LocateTask = {
    projectPath: fs.realpathSync(path.resolve(projectPath)), document: extractLocateDocument(input),
    timeoutMs: integerOption(options.timeoutMs, 45000, 1, 60000, 'timeoutMs'),
    maxCandidates: integerOption(options.maxCandidates, 10, 1, 20, 'maxCandidates'),
    maxTokens: integerOption(options.maxTokens, 20000, 512, 32000, 'maxTokens'),
    maxTokensPerClue: integerOption(options.maxTokensPerClue, 2000, 128, 8000, 'maxTokensPerClue'),
  };
  if (task.maxTokensPerClue > task.maxTokens) throw new Error('maxTokensPerClue must not exceed maxTokens');
  let latest = emptyLocateResult(task);
  if (!task.document.signals.length) {
    latest.notes.push('未提取到明确的代码符号或路径；请提供函数名、类名、路径或代码片段。');
    return finishOutput(latest);
  }
  if (options.signal?.aborted) {
    latest.partial = true; latest.stopReasons.push('cancelled');
    return finishOutput(latest);
  }
  const workerFile = path.join(__dirname, 'worker.js');
  // Development only: published builds always have worker.js and never need TypeScript.
  const bootstrap = () => `const fs = require('fs'); const ts = require(${JSON.stringify(require.resolve('typescript'))});
    require.extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
    }).outputText, filename); require(${JSON.stringify(path.join(__dirname, 'worker.ts'))});`;
  const worker = fs.existsSync(workerFile)
    ? new Worker(workerFile, { workerData: task })
    : new Worker(bootstrap(), { eval: true, workerData: task });
  const result = await new Promise<LocateResult>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, reason?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (reason) { latest.partial = true; latest.stopReasons.push(reason); }
      // There are no child processes in this worker. Termination closes its read-only DB.
      void worker.terminate().then(() => error ? reject(error) : resolve(latest), reject);
    };
    const abort = () => finish(undefined, 'cancelled');
    const timer = setTimeout(() => finish(undefined, 'deadline'), Math.max(1, task.timeoutMs - (performance.now() - started)));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    worker.on('message', (message: { type: string; result?: LocateResult; message?: string }) => {
      if (settled) return;
      if (message.result) latest = message.result;
      if (message.type === 'result') finish();
      if (message.type === 'error') finish(new Error(message.message));
    });
    worker.once('error', error => finish(error));
    worker.once('exit', code => { if (!settled) finish(new Error(`Locate worker exited without a result (${code})`)); });
  });
  result.stats.elapsedMs = Math.round(performance.now() - started);
  return finishOutput(result);
}
