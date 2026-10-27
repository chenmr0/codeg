import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShimmerWorkerMessage } from '../src/ui/types';

const channel = vi.hoisted(() => ({
  handler: undefined as ((message: ShimmerWorkerMessage) => void) | undefined,
  writes: [] as string[],
  posts: [] as ShimmerWorkerMessage[],
}));
vi.mock('fs', () => ({ writeSync: (_fd: number, text: string) => { channel.writes.push(text); } }));
vi.mock('worker_threads', () => ({
  workerData: { startTime: 0 },
  parentPort: {
    on: (_event: string, handler: (message: ShimmerWorkerMessage) => void) => { channel.handler = handler; },
    postMessage: vi.fn(),
  },
  Worker: class {
    postMessage(message: ShimmerWorkerMessage) { channel.posts.push(message); }
  },
}));

describe('stale-index removal display', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    channel.writes.length = 0;
    channel.posts.length = 0;
    channel.handler = undefined;
  });
  afterEach(() => {
    channel.handler?.({ type: 'stop' });
    vi.useRealTimers();
  });

  it('forwards exact counts and failure state without describing source deletion', async () => {
    const { createShimmerProgress } = await import('../src/ui/shimmer-progress');
    const display = createShimmerProgress();
    display.onProgress({ phase: 'removing', current: 2, total: 3, status: 'failed' });
    expect(channel.posts.at(-1)).toMatchObject({
      phaseName: 'Removing stale index entries', count: 2, total: 3, status: 'failed',
    });
  });

  it.each(['running', 'failed', 'complete'] as const)('retains counts and honest %s state on stop', async status => {
    await import('../src/ui/shimmer-worker');
    channel.handler!({ type: 'update', phase: 'removing', phaseName: 'Removing stale index entries',
      count: 2, total: 3, percent: 67, status });
    await vi.advanceTimersByTimeAsync(50);
    channel.handler!({ type: 'stop' });
    const output = channel.writes.join('').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    expect(output).toContain('2/3 index entries removed');
    expect(output).toContain(status === 'running' ? '; stopped' : `; ${status}`);
    expect(output).not.toMatch(/found|done/);
  });

  it('does not invent a percent or total for late deletions', async () => {
    await import('../src/ui/shimmer-worker');
    channel.handler!({ type: 'update', phase: 'removing', phaseName: 'Removing stale index entries',
      count: 1, total: 0, percent: -1, status: 'running' });
    await vi.advanceTimersByTimeAsync(50);
    expect(channel.writes.join('')).toContain('1 index entries removed (total unknown)');
    expect(channel.writes.join('')).not.toContain('%');
  });
});
