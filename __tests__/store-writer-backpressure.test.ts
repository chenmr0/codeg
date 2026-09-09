import { describe, expect, it, vi } from 'vitest';
import type { EventEmitter } from 'node:events';
import { StoreWriter, type StoreBundle } from '../src/extraction/store-writer';

vi.mock('worker_threads', async () => {
  const { EventEmitter } = await import('node:events');
  return { Worker: class extends EventEmitter {
    postMessage(message: { type: string }) {
      if (message.type === 'open') this.emit('message', { type: 'ready' });
      if (message.type === 'close') queueMicrotask(() => this.emit('exit', 0));
    }
    terminate() { return Promise.resolve(0); }
  } };
});

const tick = () => new Promise(resolve => setImmediate(resolve));
function bundle(id: string, docLength = 1000): StoreBundle {
  return { nodes: [{ id, kind: 'function', name: id, qualifiedName: id, filePath: 'a.cpp',
    language: 'cpp', startLine: 1, endLine: 1, startColumn: 0, endColumn: 1,
    updatedAt: 1, docstring: 'x'.repeat(docLength) }], edges: [], refs: [],
    file: { path: 'a.cpp', language: 'cpp', size: 1, contentHash: 'hash',
      modifiedAt: 1, indexedAt: 1, nodeCount: 1 } };
}
function fixture() {
  const writer = new StoreWriter('unused-worker.js', 'unused.db', true);
  const worker = (writer as unknown as { worker: EventEmitter }).worker;
  return { writer, worker, ack: () => worker.emit('message', { type: 'ack' }) };
}

describe('store worker buffer backpressure', () => {
  it('keeps a byte-bound waiter blocked until enough ordered acknowledgments arrive', async () => {
    const { writer, ack } = fixture();
    try {
      writer.send(bundle('a')); writer.send(bundle('b')); writer.send(bundle('c'));
      let ready = false;
      const waiting = writer.waitBelow(64, 3000).then(() => { ready = true; });
      await tick();
      expect(ready).toBe(false); // Three bundles are below the count limit.
      ack(); await tick();
      expect(ready).toBe(false);
      ack(); await waiting;
      expect(ready).toBe(true);
      ack();
    } finally { await writer.close(); }
  });

  it('retains the count limit and lets an oversized bundle drain', async () => {
    const { writer, ack } = fixture();
    try {
      writer.send(bundle('a', 0)); writer.send(bundle('b', 0));
      let ready = false;
      const countWait = writer.waitBelow(2, 1_000_000).then(() => { ready = true; });
      await tick(); expect(ready).toBe(false);
      ack(); await countWait;
      writer.send(bundle('large', 10_000));
      ready = false;
      const byteWait = writer.waitBelow(64, 3000).then(() => { ready = true; });
      ack(); await tick(); expect(ready).toBe(false);
      ack(); await byteWait;
      expect(ready).toBe(true);
    } finally { await writer.close(); }
  });

  it('wakes both kinds of waiters on worker failure and exposes the error on drain', async () => {
    const { writer, worker } = fixture();
    try {
      writer.send(bundle('a'));
      const waiting = Promise.all([writer.waitBelow(1), writer.waitBelow(64, 1)]);
      const error = new Error('writer failed');
      worker.emit('error', error);
      await waiting;
      await expect(writer.drain()).rejects.toBe(error);
      expect(() => writer.send(bundle('b'))).toThrow('writer failed');
    } finally { await writer.close(); }
  });
});
