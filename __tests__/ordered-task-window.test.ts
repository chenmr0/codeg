import { describe, expect, it } from 'vitest';
import {
  runOrderedTaskWindow,
  type OrderedWindowState,
} from '../src/extraction/ordered-task-window';

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('ordered task window', () => {
  it('runs concurrently but yields strictly by sequence', async () => {
    const gates = Array.from({ length: 4 }, deferred);
    const started: number[] = [];
    const iterator = runOrderedTaskWindow(
      gates.map((gate, sequence) => ({
        weight: 1,
        run: async () => {
          started.push(sequence);
          await gate.promise;
          return sequence;
        },
      })),
      { maxTasks: 4, maxWeight: 4 },
    )[Symbol.asyncIterator]();

    const first = iterator.next();
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual([0, 1, 2, 3]);

    gates[3]!.resolve();
    gates[2]!.resolve();
    gates[1]!.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    let firstSettled = false;
    void first.then(() => {
      firstSettled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(firstSettled).toBe(false);

    gates[0]!.resolve();
    expect((await first).value).toEqual({ sequence: 0, value: 0 });
    expect((await iterator.next()).value).toEqual({ sequence: 1, value: 1 });
    expect((await iterator.next()).value).toEqual({ sequence: 2, value: 2 });
    expect((await iterator.next()).value).toEqual({ sequence: 3, value: 3 });
    expect((await iterator.next()).done).toBe(true);
  });

  it('enforces task and weight limits while permitting an oversize task alone', async () => {
    const gate = deferred();
    const states: OrderedWindowState[] = [];
    const iterator = runOrderedTaskWindow(
      [3, 3, 9, 1].map((weight, sequence) => ({
        weight,
        run: async () => {
          if (sequence < 2) await gate.promise;
          return sequence;
        },
      })),
      {
        maxTasks: 3,
        maxWeight: 5,
        getResultWeight: (value) => value + 1,
        onStateChange: (state) => states.push({ ...state }),
      },
    )[Symbol.asyncIterator]();

    const first = iterator.next();
    await new Promise((resolve) => setImmediate(resolve));
    expect(Math.max(...states.map((state) => state.retainedTasks))).toBe(1);
    expect(Math.max(...states.map((state) => state.retainedWeight))).toBe(3);

    gate.resolve();
    expect((await first).value).toEqual({ sequence: 0, value: 0 });
    expect((await iterator.next()).value).toEqual({ sequence: 1, value: 1 });
    expect((await iterator.next()).value).toEqual({ sequence: 2, value: 2 });
    expect((await iterator.next()).value).toEqual({ sequence: 3, value: 3 });
    expect((await iterator.next()).done).toBe(true);

    const oversizeStates = states.filter(
      (state) => state.retainedWeight === 9,
    );
    expect(oversizeStates.length).toBeGreaterThan(0);
    expect(oversizeStates.every((state) => state.retainedTasks === 1)).toBe(true);
    expect(Math.max(...states.map((state) => state.retainedResultWeight))).toBe(4);
  });

 it('surfaces failures at their deterministic sequence', async () => {
    const yielded: number[] = [];
    await expect(async () => {
      for await (const item of runOrderedTaskWindow(
        [
          { weight: 1, run: async () => 0 },
          { weight: 1, run: async () => { throw new Error('sequence one failed'); } },
          { weight: 1, run: async () => 2 },
        ],
        { maxTasks: 3, maxWeight: 3 },
      )) {
        yielded.push(item.value);
      }
    }).rejects.toThrow('sequence one failed');
   expect(yielded).toEqual([0]);
 });

  it('releases retained window state when a consumer stops early', async () => {
    const secondGate = deferred();
    const states: OrderedWindowState[] = [];
    const iterator = runOrderedTaskWindow(
      [
        { weight: 3, run: async () => 0 },
        {
          weight: 4,
          run: async () => {
            await secondGate.promise;
            return 1;
          },
        },
      ],
      {
        maxTasks: 2,
        maxWeight: 7,
        getResultWeight: (value) => value + 5,
        onStateChange: (state) => states.push({ ...state }),
      },
    )[Symbol.asyncIterator]();

    expect((await iterator.next()).value).toEqual({ sequence: 0, value: 0 });
    await iterator.return?.();

    expect(states.at(-1)).toMatchObject({
      retainedTasks: 0,
      retainedWeight: 0,
      retainedResultWeight: 0,
    });
    expect(states.some((state) => state.retainedResultWeight === 5)).toBe(true);
    secondGate.resolve();
  });

  it('stops admitting work while completed result weight reaches its budget', async () => {
    const firstGate = deferred();
    const started: number[] = [];
    const iterator = runOrderedTaskWindow(
      [0, 1, 2].map((sequence) => ({
        weight: 1,
        run: async () => {
          started.push(sequence);
          if (sequence === 0) await firstGate.promise;
          return sequence;
        },
      })),
      {
        maxTasks: 2,
        maxWeight: 2,
        getResultWeight: (value) => value === 1 ? 10 : 1,
        maxResultWeight: 10,
      },
    )[Symbol.asyncIterator]();

    const first = iterator.next();
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual([0, 1]);

    firstGate.resolve();
    expect((await first).value).toEqual({ sequence: 0, value: 0 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual([0, 1]);

    expect((await iterator.next()).value).toEqual({ sequence: 1, value: 1 });
    expect((await iterator.next()).value).toEqual({ sequence: 2, value: 2 });
    expect(started).toEqual([0, 1, 2]);
  });
});

