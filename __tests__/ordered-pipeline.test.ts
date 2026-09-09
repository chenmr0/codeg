import { describe, expect, it } from 'vitest';
import { orderedParallelMap, type WeightedInput } from '../src/extraction/ordered-pipeline';
import { estimateExtractionBytes, resolveParseBufferBudget } from '../src/extraction/extraction-size';
import type { ExtractionResult } from '../src/types';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function* inputs(weights: number[]): AsyncGenerator<WeightedInput<number>> {
  for (const [value, estimatedBytes] of weights.entries()) yield { value, estimatedBytes };
}
async function collect<T>(iterator: AsyncIterable<T>, consume = (_value: T) => Promise.resolve()): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterator) { await consume(value); values.push(value); }
  return values;
}

describe('ordered parse lookahead', () => {
  it('scales the buffer within system and main-thread heap headroom', () => {
    const mib = 1024 * 1024;
    expect(resolveParseBufferBudget(16_384 * mib, 3_072 * mib)).toBe(512 * mib);
    expect(resolveParseBufferBudget(2_048 * mib, 3_072 * mib)).toBe(128 * mib);
    expect(resolveParseBufferBudget(16_384 * mib, 256 * mib)).toBe(64 * mib);
    expect(resolveParseBufferBudget(0, 0)).toBe(32 * mib);
  });

  it('charges dense references and long signatures without rejecting nodes the store can filter', () => {
    const empty: ExtractionResult = { nodes: [], edges: [], unresolvedReferences: [], errors: [], durationMs: 0 };
    const invalid = { ...empty, nodes: [{}] } as ExtractionResult;
    expect(Number.isFinite(estimateExtractionBytes('source', invalid))).toBe(true);
    const dense = { ...empty, unresolvedReferences: Array.from({ length: 1000 }, () => ({
      fromNodeId: 'caller', referenceName: 'target', referenceKind: 'calls' as const, line: 1, column: 0,
    })) };
    expect(estimateExtractionBytes('short macro invocation', dense)).toBeGreaterThan(256_000);
    const node = { id: 'n', name: 'n', qualifiedName: 'n', filePath: 'n.cpp', signature: 'x'.repeat(10_000) };
    expect(estimateExtractionBytes(null, { ...empty, nodes: [node] } as ExtractionResult)).toBeGreaterThan(20_000);
  });

  it('refills ahead of a slow sibling while preserving consumption order', async () => {
    const slow = deferred();
    const started: number[] = [];
    const written: number[] = [];
    const metrics = { peakPending: 0, peakEstimatedBytes: 0 };
    const run = collect(orderedParallelMap(inputs(Array(12).fill(1)), async id => {
      started.push(id);
      if (id === 1) await slow.promise;
      return id;
    }, { maxPending: 6, maxEstimatedBytes: 100, estimateResultBytes: () => 1, metrics }), async id => {
      written.push(id);
    });
    await tick();
    expect(written).toEqual([0]);
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(metrics.peakPending).toBe(6);
    slow.resolve();
    expect(await run).toEqual(Array.from({ length: 12 }, (_, i) => i));
    expect(written).toEqual(Array.from({ length: 12 }, (_, i) => i));
  });

  it('reserves source bytes before invoking another reader/parser', async () => {
    const gate = deferred();
    const started: number[] = [];
    const metrics = { peakPending: 0, peakEstimatedBytes: 0 };
    const run = collect(orderedParallelMap(inputs([6, 6, 6]), async id => {
      started.push(id);
      if (id === 0) await gate.promise;
      return id;
    }, { maxPending: 4, maxEstimatedBytes: 10, estimateResultBytes: () => 6, metrics }));
    await tick();
    expect(started).toEqual([0]);
    gate.resolve();
    expect(await run).toEqual([0, 1, 2]);
    expect(metrics).toEqual({ peakPending: 1, peakEstimatedBytes: 6 });
  });

  it('charges expanded results through an asynchronous write before admitting more work', async () => {
    const head = deferred(), nextMetadata = deferred(), write = deferred();
    const started: number[] = [], writing: number[] = [];
    async function* source() {
      yield { value: 0, estimatedBytes: 1 };
      yield { value: 1, estimatedBytes: 1 };
      await nextMetadata.promise;
      yield { value: 2, estimatedBytes: 1 };
    }
    const metrics = { peakPending: 0, peakEstimatedBytes: 0 };
    const run = collect(orderedParallelMap(source(), async id => {
      started.push(id);
      if (id === 0) await head.promise;
      return id;
    }, { maxPending: 4, maxEstimatedBytes: 10, estimateResultBytes: id => id === 1 ? 12 : 1, metrics }), async id => {
      writing.push(id);
      if (id === 1) await write.promise;
    });
    await tick();
    nextMetadata.resolve();
    await tick();
    expect(started).toEqual([0, 1]);
    head.resolve();
    await tick();
    expect(writing).toEqual([0, 1]);
    expect(started).toEqual([0, 1]);
    expect(metrics.peakEstimatedBytes).toBe(13);
    write.resolve();
    expect(await run).toEqual([0, 1, 2]);
  });

  it('runs an oversized file alone without dropping it or deadlocking', async () => {
    const write = deferred();
    const started: number[] = [];
    const run = collect(orderedParallelMap(inputs([30, 1]), async id => {
      started.push(id);
      return id;
    }, { maxPending: 4, maxEstimatedBytes: 10, estimateResultBytes: id => id === 0 ? 30 : 1 }), async id => {
      if (id === 0) await write.promise;
    });
    await tick();
    expect(started).toEqual([0]);
    write.resolve();
    expect(await run).toEqual([0, 1]);
  });

  it('observes a later rejection immediately and never consumes past that failure', async () => {
    const head = deferred();
    const written: number[] = [];
    const failure = new Error('parse failed');
    const run = collect(orderedParallelMap(inputs([1, 1, 1]), async id => {
      if (id === 0) await head.promise;
      if (id === 1) throw failure;
      return id;
    }, { maxPending: 3, maxEstimatedBytes: 10, estimateResultBytes: () => 1 }), async id => {
      written.push(id);
    });
    const rejected = expect(run).rejects.toBe(failure);
    await tick(); // Vitest also catches an unhandled rejection during this wait.
    expect(written).toEqual([]);
    head.resolve();
    await rejected;
    expect(written).toEqual([0]);
  });

  it('cancels a stuck head promptly and discards late results/rejections', async () => {
    const abort = new AbortController(), head = deferred<number>(), later = deferred<number>();
    const started: number[] = [], written: number[] = [];
    const run = collect(orderedParallelMap(inputs([1, 1, 1]), async id => {
      started.push(id);
      return id === 0 ? head.promise : later.promise;
    }, { maxPending: 2, maxEstimatedBytes: 10, estimateResultBytes: () => 1, signal: abort.signal }), async id => {
      written.push(id);
    });
    await tick();
    abort.abort();
    expect(await run).toEqual([]);
    head.resolve(0);
    later.reject(new Error('pool destroyed'));
    await tick();
    expect(started).toEqual([0, 1]);
    expect(written).toEqual([]);
  });

  it('stops after a write failure and closes the input iterator', async () => {
    const later = deferred<number>(), failure = new Error('disk full');
    let closed = false;
    const written: number[] = [];
    async function* source() {
      try {
        for (let id = 0; id < 4; id++) yield { value: id, estimatedBytes: 1 };
      } finally { closed = true; }
    }
    const run = collect(orderedParallelMap(source(), async id => id === 0 ? id : later.promise,
      { maxPending: 2, maxEstimatedBytes: 10, estimateResultBytes: () => 1 }), async id => {
      written.push(id);
      throw failure;
    });
    await expect(run).rejects.toBe(failure);
    later.resolve(1);
    await tick();
    expect(closed).toBe(true);
    expect(written).toEqual([0]);
  });

  it('supports an empty input and a serial window', async () => {
    const options = { maxPending: 1, maxEstimatedBytes: 10, estimateResultBytes: () => 1 };
    expect(await collect(orderedParallelMap(inputs([]), async id => id, options))).toEqual([]);
    let active = 0;
    expect(await collect(orderedParallelMap(inputs([1, 1, 1]), async id => {
      expect(active++).toBe(0);
      await tick();
      active--;
      return id;
    }, options))).toEqual([0, 1, 2]);
  });
});
