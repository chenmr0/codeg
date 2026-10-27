import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DatabaseConnection as DatabaseConnectionType } from '../src/db';
// Built artifact test: rebuild before running, so dynamic imports use CommonJS.
const DatabaseConnection = require('../dist/db').DatabaseConnection as typeof DatabaseConnectionType;
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const state: { workers: FakeWorker[]; startupError?: Error } = { workers: [] };
class FakeWorker extends EventEmitter {
  private resolveTermination?: (code: number) => void;
  terminate = vi.fn(() => new Promise<number>(resolve => { this.resolveTermination = resolve; }));
  constructor() {
    super();
    if (state.startupError) throw state.startupError;
    state.workers.push(this);
  }
  exit(code = 0): void {
    this.emit('exit', code);
    this.resolveTermination?.(code);
  }
}
let root: string | undefined;
let db: DatabaseConnectionType | undefined;
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks();
  db?.close(); db = undefined;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
  state.workers.length = 0;
  state.startupError = undefined;
});

function fixture(): DatabaseConnectionType {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-checkpoint-lifecycle-'));
  db = DatabaseConnection.initialize(path.join(root, 'db.sqlite'));
  const originalLoad = Module._load;
  vi.spyOn(Module, '_load').mockImplementation(function (this: unknown, ...args: any[]) {
    if (args[0] === 'node:worker_threads') return { Worker: FakeWorker };
    return originalLoad.apply(this, args);
  });
  vi.useFakeTimers();
  return db;
}

/** Attach both handlers immediately so advancing fake time cannot leak rejections. */
function observe<T>(promise: Promise<T>) {
  let settled = false;
  const result = promise.then(
    value => { settled = true; return { value, error: undefined }; },
    error => { settled = true; return { value: undefined, error }; },
  );
  return { result, isSettled: () => settled };
}

describe('checkpoint worker lifecycle', () => {
  it.each([undefined, 125])('waits for actual exit after cancellation with timeout %s', async timeoutMs => {
    const pending = observe(fixture().checkpointWalTruncate(timeoutMs === undefined ? undefined : { timeoutMs }));
    await vi.advanceTimersByTimeAsync(0);
    const worker = state.workers[0]!;
    expect(state.workers).toHaveLength(1);
    await vi.advanceTimersByTimeAsync((timeoutMs ?? 60_000) - 1);
    expect(worker.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(pending.isSettled()).toBe(false);
    worker.exit();
    expect((await pending.result).error).toMatchObject({
      name: 'WalCheckpointError', reason: 'timeout', retryable: true,
      message: `WAL TRUNCATE checkpoint timed out after ${timeoutMs ?? 60_000}ms`,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('holds a successful result until exit and clears the cancellation timer', async () => {
    const pending = observe(fixture().checkpointWalPassive());
    await vi.advanceTimersByTimeAsync(0);
    const worker = state.workers[0]!;
    worker.emit('message', { row: { busy: 0, log: 8, checkpointed: 8 } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pending.isSettled()).toBe(false);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    worker.exit(1); // terminate() may produce exit code 1 even after a valid result.
    expect((await pending.result).value).toEqual({ busy: 0, log: 8, checkpointed: 8 });
  });

  it.each([
    { errcode: 261, reason: 'busy', retryable: true },
    { errcode: 266, reason: 'sqlite', retryable: false },
  ])('retains worker SQLite details and waits for exit: $errcode', async expected => {
    const pending = observe(fixture().checkpointWalTruncate());
    await vi.advanceTimersByTimeAsync(0);
    const worker = state.workers[0]!;
    worker.emit('message', { error: {
      message: 'original SQLite failure detail', code: 'ERR_SQLITE_ERROR', errcode: expected.errcode, reason: 'sqlite',
    } });
    await vi.advanceTimersByTimeAsync(0);
    expect(pending.isSettled()).toBe(false);
    worker.exit();
    expect((await pending.result).error).toMatchObject({
      message: 'original SQLite failure detail', sqliteCode: 'ERR_SQLITE_ERROR', ...expected,
    });
  });

  it.each(['reject', 'throw'])('does not mistake a failed termination request (%s) for worker exit', async failureMode => {
    const pending = observe(fixture().checkpointWalPassive({ timeoutMs: 10 }));
    await vi.advanceTimersByTimeAsync(0);
    const worker = state.workers[0]!;
    if (failureMode === 'throw') {
      worker.terminate.mockImplementationOnce(() => { throw new Error('termination unavailable'); });
    } else {
      worker.terminate.mockRejectedValueOnce(new Error('termination unavailable'));
    }
    await vi.advanceTimersByTimeAsync(10);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(pending.isSettled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(pending.isSettled()).toBe(false);
    worker.exit();
    expect((await pending.result).error).toMatchObject({ reason: 'timeout', retryable: true });
  });

  it('reports an unexpected exit without a result instead of a null checkpoint', async () => {
    const pending = observe(fixture().checkpointWalPassive());
    await vi.advanceTimersByTimeAsync(0);
    state.workers[0]!.exit(7);
    expect((await pending.result).error).toMatchObject({
      reason: 'unavailable', retryable: true,
      message: 'WAL PASSIVE checkpoint worker exited before returning a result (code=7)',
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports startup errors without waiting for an uncreated worker', async () => {
    const connection = fixture();
    state.startupError = Object.assign(new Error('worker permission denied'), { code: 'ERR_ACCESS_DENIED' });
    const pending = observe(connection.checkpointWalPassive());
    expect((await pending.result).error).toMatchObject({
      reason: 'unavailable', retryable: true, message: 'worker permission denied', sqliteCode: 'ERR_ACCESS_DENIED',
    });
    expect(state.workers).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for exit after a worker error event and retains its message', async () => {
    const pending = observe(fixture().checkpointWalPassive());
    await vi.advanceTimersByTimeAsync(0);
    const worker = state.workers[0]!;
    worker.emit('error', Object.assign(new Error('worker failed during bootstrap'), { code: 'ERR_WORKER_INIT_FAILED' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(pending.isSettled()).toBe(false);
    worker.exit(1);
    expect((await pending.result).error).toMatchObject({
      reason: 'unavailable', retryable: true, message: 'worker failed during bootstrap', sqliteCode: 'ERR_WORKER_INIT_FAILED',
    });
  });
});
