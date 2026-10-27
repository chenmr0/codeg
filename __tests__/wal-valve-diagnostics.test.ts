import { afterEach, describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import type { DatabaseConnection } from '../src/db';
import { WalCheckpointError } from '../src/db/wal-checkpoint';
import { WalCheckpointValve } from '../src/db/wal-valve';

const MB = 1024 * 1024;
const complete = { busy: 0, log: 10, checkpointed: 10 };

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function fixture(bytes = 3 * MB) {
  const state = { bytes, now: 100 };
  vi.spyOn(performance, 'now').mockImplementation(() => state.now);
  const logs: string[] = [];
  const db = {
    getWalSizeBytes: () => state.bytes,
    checkpointWalPassive: vi.fn(async () => { state.now += 11; return complete; }),
    checkpointWalTruncate: vi.fn(async () => {
      state.now += 13; state.bytes = 0; return { busy: 0, log: 0, checkpointed: 0 };
    }),
  };
  const valve = new WalCheckpointValve(db as unknown as DatabaseConnection, 1, 2000,
    message => logs.push(message), 250);
  return { state, logs, db, valve };
}

describe('WAL pause diagnostics', () => {
  it.each([false, true])('does not let a diagnostic logger replace the checkpoint result (failure=%s)', async failed => {
    const { db } = fixture();
    if (failed) db.checkpointWalPassive.mockRejectedValueOnce(
      new WalCheckpointError('disk I/O error', 'sqlite', false));
    const valve = new WalCheckpointValve(db as unknown as DatabaseConnection, 1, 2000, message => {
      if (message.startsWith('checkpoint-detail')) throw new Error('diagnostic sink failed');
    });
    if (failed) await expect(valve.backpressure()).rejects.toMatchObject({ code: 'WAL_VALVE_ABORT' });
    else await expect(valve.backpressure()).resolves.toBeUndefined();
  });

  it('separates an existing timer wait from new checkpoints without labelling it a contention retry', async () => {
    const { state, logs, db, valve } = fixture(1.5 * MB);
    let finish!: (row: typeof complete) => void;
    db.checkpointWalPassive.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    valve.check();
    state.bytes = 3 * MB;
    const pending = valve.backpressure();
    state.now += 7;
    finish(complete);
    await pending;
    const detail = logs.find(line => line.startsWith('checkpoint-detail'));
    expect(detail).toContain('trigger=cap outcome=released passiveCalls=1 truncateCalls=1 retryStarted=false');
    expect(detail).toContain('inflightMs=7ms passiveMs=11ms truncateMs=13ms retrySleepMs=0ms otherMs=0ms totalMs=31ms');
    expect(db.checkpointWalPassive).toHaveBeenCalledTimes(2);
    expect(db.checkpointWalTruncate).toHaveBeenCalledOnce();
    expect(logs.some(line => line.startsWith('checkpoint blocked'))).toBe(false);
  });

  it('accounts for actual retry sleep separately and keeps the same bounded checkpoint attempts', async () => {
    vi.useFakeTimers();
    const { state, logs, db, valve } = fixture();
    db.checkpointWalPassive.mockImplementationOnce(async () => {
      state.now += 9; return { busy: 0, log: 10, checkpointed: 0 };
    });
    const pending = valve.backpressure();
    await vi.advanceTimersByTimeAsync(0);
    state.now += 50;
    await vi.advanceTimersByTimeAsync(50);
    await pending;
    const detail = logs.find(line => line.startsWith('checkpoint-detail'));
    expect(detail).toContain('passiveCalls=2 truncateCalls=1 retryStarted=true');
    expect(detail).toContain('passiveMs=20ms truncateMs=13ms retrySleepMs=50ms otherMs=0ms totalMs=83ms');
    expect(state.bytes).toBe(0);
    expect(db.checkpointWalPassive).toHaveBeenCalledTimes(2);
  });

  it('reports failed checkpoint time and preserves the original abort', async () => {
    const { state, logs, db, valve } = fixture();
    db.checkpointWalPassive.mockImplementationOnce(async () => {
      state.now += 17; throw new WalCheckpointError('disk I/O error', 'sqlite', false);
    });
    await expect(valve.backpressure()).rejects.toMatchObject({ code: 'WAL_VALVE_ABORT',
      checkpoint: { reason: 'sqlite', message: 'disk I/O error' } });
    const detail = logs.find(line => line.startsWith('checkpoint-detail'));
    expect(detail).toContain('outcome=aborted passiveCalls=1 truncateCalls=0 retryStarted=false');
    expect(detail).toContain('passiveMs=17ms truncateMs=0ms retrySleepMs=0ms otherMs=0ms totalMs=17ms');
    expect(logs.some(line => line.includes('backpressure released'))).toBe(false);
    expect(state.bytes).toBe(3 * MB);
  });

  it('distinguishes a phase fold from hitting the cap and skips empty WAL', async () => {
    const { logs, db, valve } = fixture(MB);
    expect(valve.backpressure()).toBeNull();
    expect(logs).toEqual([]);
    await valve.foldNow();
    await valve.foldNow();
    expect(logs.filter(line => line.startsWith('checkpoint-detail'))).toHaveLength(1);
    expect(logs.find(line => line.startsWith('checkpoint-detail'))).toContain('trigger=phase outcome=released');
    expect(db.checkpointWalPassive).toHaveBeenCalledOnce();
  });
});
