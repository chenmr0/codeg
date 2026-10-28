import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { Worker } from 'worker_threads';
import { waitForAdaptiveReadWorker } from '../src/sync/rebuild-controller';
function worker() { const emitter = new EventEmitter() as EventEmitter & { terminate: ReturnType<typeof vi.fn> }; emitter.terminate = vi.fn(async () => 1); return emitter; }
it('requires both a result and a successful worker exit', async () => {
  const w = worker(); const promise = waitForAdaptiveReadWorker(w as unknown as Worker);
  w.emit('exit', 0); await expect(promise).rejects.toThrow('exited 0');
});
it('rejects a result followed by abnormal exit', async () => {
  const w = worker(); const promise = waitForAdaptiveReadWorker(w as unknown as Worker);
  w.emit('message', { result: true }); w.emit('exit', 1); await expect(promise).rejects.toThrow('exited 1');
});
it('keeps failure pending until the worker has exited', async () => {
  const w = worker(); const promise = waitForAdaptiveReadWorker(w as unknown as Worker);
  let settled = false; void promise.catch(() => { settled = true; });
  w.emit('error', new Error('validation failed')); await Promise.resolve(); expect(settled).toBe(false);
  w.emit('exit', 1); await expect(promise).rejects.toThrow('validation failed');
});
it('cancellation terminates the worker but cannot release ownership before exit', async () => {
  const w = worker(), abort = new AbortController();
  const promise = waitForAdaptiveReadWorker(w as unknown as Worker, abort.signal);
  let settled = false; void promise.catch(() => { settled = true; }); abort.abort();
  expect(w.terminate).toHaveBeenCalledOnce(); await Promise.resolve(); expect(settled).toBe(false);
  w.emit('exit', 1); await expect(promise).rejects.toThrow('cancelled');
});
it('propagates validation refusal without changing its meaning', async () => {
  const w = worker(); const promise = waitForAdaptiveReadWorker<boolean>(w as unknown as Worker);
  w.emit('message', { result: false }); w.emit('exit', 0); await expect(promise).resolves.toBe(false);
});

it('rejects malformed messages rather than treating an absent result as validation success', async () => {
  const w = worker(); const promise = waitForAdaptiveReadWorker(w as unknown as Worker);
  w.emit('message', {}); w.emit('exit', 0); await expect(promise).rejects.toThrow('no result');
});
