import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseConnection } from '../src/db';
import { WalCheckpointValve, WalValveAbortError } from '../src/db/wal-valve';
import { SyncDiagnosticsSummary } from '../src/sync/diagnostics-summary';

const MB = 1024 * 1024;
const complete = { busy: 0, log: 10, checkpointed: 10 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fixture(summary?: SyncDiagnosticsSummary, bytes = 3 * MB) {
  const state = { bytes };
  const db = {
    getWalSizeBytes: vi.fn(() => state.bytes),
    checkpointWalPassive: vi.fn(async (): Promise<typeof complete | null> => complete),
    checkpointWalTruncate: vi.fn(async (): Promise<typeof complete | null> => {
      state.bytes = 0;
      return complete;
    }),
  };
  return {
    state, db,
    valve: new WalCheckpointValve(db as unknown as DatabaseConnection, 1, 2000, undefined, summary),
  };
}

function counters(summary: SyncDiagnosticsSummary): Record<string, number> {
  const line = summary.lines('success').find(value => value.startsWith('[sync-summary] wal '))!;
  return Object.fromEntries(line.slice('[sync-summary] wal '.length).trim().split(/\s+/)
    .filter(Boolean).map(part => {
      const [key, value] = part.split('=');
      return [key, Number(value)];
    }));
}

async function flush() {
  // Settle existing promise observers without advancing the monotonic clock.
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('opt-in numeric WAL summary diagnostics', () => {
  let now: number;

  beforeEach(() => {
    now = 0;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    vi.spyOn(performance, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does no observer or monotonic-clock work without the optional collector', async () => {
    const add = vi.spyOn(SyncDiagnosticsSummary.prototype, 'add');
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    const interval = vi.spyOn(globalThis, 'setInterval');
    const { valve, db } = fixture();

    const first = valve.backpressure();
    expect(valve.backpressure()).toBe(first);
    await first;
    valve.check();
    await valve.drain();
    await valve.foldNow();
    expect(valve.backpressure()).toBeNull();

    expect(performance.now).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(timeout).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
    expect(db.checkpointWalPassive).toHaveBeenCalledTimes(1);
    expect(db.checkpointWalTruncate).toHaveBeenCalledTimes(1);
    expect(db.getWalSizeBytes).toHaveBeenCalledTimes(7);
  });

  it('counts empty checks and folds without claiming a backpressure wait', async () => {
    const summary = new SyncDiagnosticsSummary();
    summary.phase = 'extraction';
    const { valve, db } = fixture(summary, 0);
    valve.check();
    expect(valve.backpressure()).toBeNull();
    await valve.foldNow();
    const values = counters(summary);

    expect(values).toMatchObject({
      backpressureCalls: 1, extractionBackpressureCalls: 1,
      advisoryCheckCalls: 1, foldCalls: 1, drainCalls: 1,
    });
    expect(values.foldMs ?? 0).toBe(0);
    expect(values.drainMs ?? 0).toBe(0);
    expect(values.backpressureWaitCalls).toBeUndefined();
    expect(values.parkCalls).toBeUndefined();
    expect(db.getWalSizeBytes).toHaveBeenCalledTimes(3);
    expect(db.checkpointWalPassive).not.toHaveBeenCalled();
    expect(db.checkpointWalTruncate).not.toHaveBeenCalled();
  });

  it('attributes overlapping callers to their starting phases and counts shared work once', async () => {
    const summary = new SyncDiagnosticsSummary();
    const { valve, db, state } = fixture(summary);
    const passive = deferred<typeof complete>();
    const truncate = deferred<typeof complete>();
    db.checkpointWalPassive.mockImplementationOnce(() => passive.promise);
    db.checkpointWalTruncate.mockImplementationOnce(() => truncate.promise);

    now = 10;
    summary.phase = 'extraction';
    const first = valve.backpressure();
    now = 20;
    summary.phase = 'changedRefs';
    const second = valve.backpressure();
    expect(second).toBe(first);
    now = 35;
    summary.phase = 'cleanup';
    passive.resolve(complete);
    await flush();
    expect(db.checkpointWalTruncate).toHaveBeenCalledTimes(1);
    now = 45;
    state.bytes = 0;
    truncate.resolve(complete);
    await Promise.all([first, second]);

    expect(counters(summary)).toMatchObject({
      backpressureCalls: 2, backpressureWaitCalls: 2, backpressureWaitMs: 60,
      extractionBackpressureWaitMs: 35, changedRefsBackpressureWaitMs: 25,
      parkCalls: 1, parkMs: 35,
      parkedPassiveCalls: 1, parkedPassiveMs: 25,
      parkedTruncateCalls: 1, parkedTruncateMs: 10,
    });
    expect(counters(summary).extractionParkMs).toBeUndefined();
    expect(counters(summary).extractionParkedPassiveMs).toBeUndefined();
    expect(counters(summary).cleanupParkedTruncateCalls).toBeUndefined();
    expect(db.getWalSizeBytes).toHaveBeenCalledTimes(4);
  });

  it('separates advisory checkpoint work from overlapping parked inflight wait', async () => {
    const summary = new SyncDiagnosticsSummary();
    summary.phase = 'extraction';
    const { valve, db, state } = fixture(summary, 1.5 * MB);
    const advisory = deferred<typeof complete>();
    const parked = deferred<typeof complete>();
    db.checkpointWalPassive.mockImplementationOnce(() => advisory.promise)
      .mockImplementationOnce(() => parked.promise);
    valve.check();
    now = 10;
    summary.phase = 'changedRefs';
    state.bytes = 3 * MB;
    const pending = valve.backpressure();
    now = 40;
    summary.phase = 'cleanup';
    advisory.resolve(complete);
    await flush();
    expect(db.checkpointWalPassive).toHaveBeenCalledTimes(2);
    now = 60;
    parked.resolve(complete);
    await pending;

    expect(counters(summary)).toMatchObject({
      advisoryPassiveCalls: 1, advisoryPassiveMs: 40,
      parkedInflightWaitCalls: 1, parkedInflightWaitMs: 30,
      parkedPassiveCalls: 1, parkedPassiveMs: 20,
      parkMs: 50, backpressureWaitMs: 50,
      changedRefsBackpressureWaitMs: 50,
    });
    expect(counters(summary).extractionAdvisoryPassiveMs).toBeUndefined();
    expect(counters(summary).changedRefsParkedInflightWaitMs).toBeUndefined();
    expect(db.checkpointWalTruncate).toHaveBeenCalledTimes(1);
  });

  it('reports inclusive fold and drain waits separately from shared checkpoint work', async () => {
    const summary = new SyncDiagnosticsSummary();
    summary.phase = 'extraction';
    const { valve, db } = fixture(summary);
    const passive = deferred<typeof complete>();
    db.checkpointWalPassive.mockImplementationOnce(() => passive.promise);
    const pending = valve.backpressure();
    now = 5;
    summary.phase = 'prepare';
    const fold = valve.foldNow();
    now = 25;
    summary.phase = 'cleanup';
    passive.resolve(complete);
    await Promise.all([pending, fold]);

    expect(counters(summary)).toMatchObject({
      parkCalls: 1, parkedPassiveCalls: 1, parkedPassiveMs: 25,
      foldCalls: 1, foldMs: 20, prepareFoldMs: 20,
      drainCalls: 1, drainMs: 20, prepareDrainMs: 20,
      drainPauseWaitCalls: 1, drainPauseWaitMs: 20, prepareDrainPauseWaitMs: 20,
    });
  });

  it('keeps a fold phase after its advisory drain completes in a later phase', async () => {
    const summary = new SyncDiagnosticsSummary();
    summary.phase = 'extraction';
    const { valve, db } = fixture(summary, 1.5 * MB);
    const advisory = deferred<typeof complete>();
    const parked = deferred<typeof complete>();
    db.checkpointWalPassive.mockImplementationOnce(() => advisory.promise)
      .mockImplementationOnce(() => parked.promise);
    valve.check();
    now = 5;
    summary.phase = 'prepare';
    const fold = valve.foldNow();
    now = 15;
    summary.phase = 'cleanup';
    advisory.resolve(complete);
    await flush();
    now = 30;
    parked.resolve(complete);
    await fold;

    expect(counters(summary)).toMatchObject({
      prepareFoldMs: 25, prepareDrainMs: 10,
      drainInflightWaitCalls: 1, drainInflightWaitMs: 10,
      prepareDrainInflightWaitMs: 10,
      parkedPassiveCalls: 1, parkedPassiveMs: 15,
      parkMs: 15,
    });
    expect(counters(summary).cleanupFoldCalls).toBeUndefined();
    expect(counters(summary).cleanupParkCalls).toBeUndefined();
  });

  it('records retry sleep and all failed waits when a pinned reader aborts', async () => {
    const summary = new SyncDiagnosticsSummary();
    summary.phase = 'failedRetry';
    const { valve, db } = fixture(summary);
    db.checkpointWalTruncate.mockResolvedValue({ busy: 1, log: 10, checkpointed: 10 });
    const pending = valve.backpressure()!;
    // Attach the rejection assertion before advancing the existing retry timer.
    const rejected = expect(pending).rejects.toBeInstanceOf(WalValveAbortError);
    await flush();
    expect(vi.getTimerCount()).toBe(1);
    now = 50;
    await vi.advanceTimersByTimeAsync(50);
    await rejected;

    expect(counters(summary)).toMatchObject({
      backpressureCalls: 1, backpressureWaitCalls: 1, backpressureWaitMs: 50,
      backpressureWaitErrors: 1, parkErrors: 1, parkMs: 50,
      parkedRetryCalls: 1, parkedRetryMs: 50,
      parkedPassiveCalls: 2, parkedTruncateCalls: 2,
      failedRetryBackpressureWaitMs: 50,
    });
    expect(db.checkpointWalPassive).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('finalizes failed checkpoint, fold and drain metrics without recording error text', async () => {
    const summary = new SyncDiagnosticsSummary();
    summary.phase = 'changedRefs';
    const { valve, db } = fixture(summary);
    const passive = deferred<typeof complete>();
    db.checkpointWalPassive.mockImplementationOnce(() => passive.promise);
    const pending = valve.backpressure()!;
    const fold = valve.foldNow();
    const results = Promise.allSettled([pending, fold]);
    now = 19;
    passive.reject(new Error('/private/project/SECRET.ts: secret SQL failure'));
    expect((await results).map(result => result.status)).toEqual(['rejected', 'rejected']);

    expect(counters(summary)).toMatchObject({
      parkedPassiveCalls: 1, parkedPassiveErrors: 1, parkedPassiveMs: 19,
      backpressureWaitErrors: 1, backpressureWaitMs: 19,
      parkErrors: 1, drainErrors: 1, drainPauseWaitErrors: 1, foldErrors: 1,
      foldMs: 19, drainMs: 19,
    });
    expect(summary.lines('error').join('\n')).not.toMatch(/private|SECRET|SQL failure/);
    for (const [key, value] of Object.entries(counters(summary))) {
      expect(key).toMatch(/^[A-Za-z][A-Za-z0-9]*$/);
      expect(Number.isFinite(value) && value >= 0).toBe(true);
    }
  });

  it('counts synchronous size failures while keeping advisory errors nonfatal', () => {
    const summary = new SyncDiagnosticsSummary();
    const { valve, db } = fixture(summary);
    const error = new Error('size failed');
    db.getWalSizeBytes.mockImplementation(() => { now += 3; throw error; });
    expect(() => valve.check()).not.toThrow();
    expect(() => valve.backpressure()).toThrow(error);
    expect(counters(summary)).toMatchObject({
      advisoryCheckCalls: 1, advisoryCheckErrors: 1, advisoryCheckMs: 3,
      backpressureCalls: 1, backpressureErrors: 1,
    });
  });

  it('records advisory checkpoint failure without changing its swallowed rejection', async () => {
    const summary = new SyncDiagnosticsSummary();
    const { valve, db } = fixture(summary, 1.5 * MB);
    const passive = deferred<typeof complete>();
    db.checkpointWalPassive.mockImplementationOnce(() => passive.promise);
    valve.check();
    const drain = valve.drain();
    now = 12;
    passive.reject(new Error('checkpoint failed'));
    await expect(drain).resolves.toBeUndefined();
    expect(counters(summary)).toMatchObject({
      advisoryPassiveCalls: 1, advisoryPassiveErrors: 1, advisoryPassiveMs: 12,
      drainCalls: 1, drainMs: 12, drainInflightWaitMs: 12,
    });
    expect(counters(summary).drainErrors).toBeUndefined();
    expect(db.checkpointWalTruncate).not.toHaveBeenCalled();
  });
});
