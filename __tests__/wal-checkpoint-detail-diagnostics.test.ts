import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vm from 'node:vm';
import type { DatabaseConnection as DatabaseConnectionType, WalCheckpointDiagnostics, WalCheckpointObserver } from '../src/db';
import { WalCheckpointValve } from '../src/db/wal-valve';
import { SyncDiagnosticsSummary } from '../src/sync/diagnostics-summary';

// Exercise the shipped CommonJS dynamic worker import, as the lifecycle test does.
const DatabaseConnection = require('../dist/db').DatabaseConnection as typeof DatabaseConnectionType;
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const MB = 1024 * 1024;
let now = 1000;
const state = { workers: [] as FakeWorker[], importError: false, constructError: false };
class FakeWorker extends EventEmitter {
  end!: () => void;
  terminate = vi.fn(() => new Promise<number>(resolve => { this.end = () => resolve(0); }));
  constructor(readonly source: string, readonly options: { workerData: Record<string, unknown> }) {
    super();
    now += 2;
    if (state.constructError) throw new Error('private construction error');
    state.workers.push(this);
  }
}
function connection(dbPath = '/private/checkpoint-detail.sqlite', db?: unknown): DatabaseConnectionType {
  return Object.assign(Object.create(DatabaseConnection.prototype), { dbPath, db });
}
async function flush() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
function message(extra: Record<string, unknown> = {}) {
  return {
    row: { busy: 0, log: 10, checkpointed: 10 },
    diagnostics: { workerEntryMs: 1, workerModuleLoadMs: 1, workerOpenMs: 2, workerBusyTimeoutMs: 1,
      workerPragmaMs: 3, workerCloseMs: 2, workerTotalMs: 10 },
    clockOrigin: performance.timeOrigin, enteredAt: 1005, postedAt: 1015,
    ...extra,
  };
}
function counters(summary: SyncDiagnosticsSummary): Record<string, number> {
  const line = summary.lines('success').find(value => value.startsWith('[sync-summary] wal '))!;
  return Object.fromEntries(line.slice('[sync-summary] wal '.length).trim().split(/\s+/).filter(Boolean)
    .map(part => { const [key, value] = part.split('='); return [key, Number(value)]; }));
}

beforeEach(() => {
  now = 1000;
  state.workers.length = 0;
  state.importError = false;
  state.constructError = false;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const originalLoad = Module._load;
  vi.spyOn(Module, '_load').mockImplementation(function (this: unknown, ...args: any[]) {
    if (args[0] === 'node:worker_threads') {
      if (state.importError) throw new Error('private import error');
      return { Worker: FakeWorker };
    }
    return originalLoad.apply(this, args);
  });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('checkpoint lifecycle observation', () => {
  it('separates worker PRAGMA time from delayed parent delivery and awaited termination', async () => {
    const observed = vi.fn();
    const pending = connection().checkpointWalTruncate(observed);
    await flush();
    const worker = state.workers[0]!;
    now = 1100;
    worker.emit('message', message());
    worker.emit('error', new Error('ignored later event'));
    worker.emit('exit', 1);
    expect(observed).not.toHaveBeenCalled();
    now = 1120;
    worker.end();
    await expect(pending).resolves.toEqual({ busy: 0, log: 10, checkpointed: 10 });
    expect(observed).toHaveBeenCalledOnce();
    expect(observed.mock.calls[0]![0]).toMatchObject({
      parentTotalMs: 120, parentConstructMs: 2, workerStartupMs: 5,
      workerPragmaMs: 3, workerTotalMs: 10, parentDeliveryMs: 85, parentTerminateMs: 20,
      workerMessages: 1, resultRows: 1, resultBusy: 0, resultLogFrames: 10, resultCheckpointedFrames: 10,
    });
    const observation = observed.mock.calls[0]![0];
    expect(Object.values(observation).every(value => typeof value === 'number' && Number.isFinite(value))).toBe(true);
    expect(observation).not.toHaveProperty('enteredAt');
    expect(observation).not.toHaveProperty('postedAt');
    expect(observation).not.toHaveProperty('clockOrigin');
    expect(JSON.stringify(observation)).not.toMatch(/private|sqlite|error text/);
  });

  it.each([
    { clockOrigin: performance.timeOrigin + 1 },
    { enteredAt: 999 },
    { postedAt: 1101 },
  ])('does not subtract unverified cross-thread clock marks: %j', async (marks) => {
    const observed = vi.fn();
    const pending = connection().checkpointWalPassive(observed);
    await flush();
    now = 1100;
    state.workers[0]!.emit('message', message(marks));
    state.workers[0]!.end();
    await pending;
    expect(observed.mock.calls[0]![0]).toMatchObject({
      clockUnavailableResults: 1, parentUnattributedMs: 90, workerPragmaMs: 3,
    });
    expect(observed.mock.calls[0]![0]).not.toHaveProperty('workerStartupMs');
    expect(observed.mock.calls[0]![0]).not.toHaveProperty('parentDeliveryMs');
  });

  it.each(['error', 'exit', 'timeout'] as const)('reports %s once, only after termination', async (event) => {
    const observed = vi.fn(() => { throw new Error('observer must not escape'); });
    const pending = connection().checkpointWalTruncate(observed);
    await flush();
    const worker = state.workers[0]!;
    now = 61002;
    if (event === 'timeout') await vi.advanceTimersByTimeAsync(60_000);
    else worker.emit(event, event === 'error' ? new Error('private worker error') : 1);
    worker.emit('message', message());
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(observed).not.toHaveBeenCalled();
    now += 20;
    worker.end();
    await expect(pending).resolves.toBeNull();
    expect(observed).toHaveBeenCalledOnce();
    expect(observed.mock.calls[0]![0]).toMatchObject({ nullResults: 1, parentTerminateMs: 20,
      [event === 'error' ? 'workerErrors' : event === 'exit' ? 'earlyExitResults' : 'timeoutResults']: 1 });
  });

  it.each(['import', 'construct'] as const)('preserves null result on %s failure and reports once', async (failure) => {
    state.importError = failure === 'import';
    state.constructError = failure === 'construct';
    const observed = vi.fn();
    await expect(connection().checkpointWalPassive(observed)).resolves.toBeNull();
    expect(observed).toHaveBeenCalledOnce();
    expect(observed.mock.calls[0]![0]).toMatchObject({ nullResults: 1,
      [failure === 'import' ? 'importErrors' : 'constructErrors']: 1 });
  });

  it('keeps a successful result when the observer throws', async () => {
    const observed = vi.fn(() => { throw new Error('observer must not escape'); });
    const pending = connection().checkpointWalPassive(observed);
    await flush();
    now = 1100;
    state.workers[0]!.emit('message', message());
    state.workers[0]!.end();
    await expect(pending).resolves.toEqual({ busy: 0, log: 10, checkpointed: 10 });
    expect(observed).toHaveBeenCalledOnce();
  });

  it('makes no diagnostic clock calls or worker observations when omitted', async () => {
    const pending = connection().checkpointWalPassive();
    await flush();
    const worker = state.workers[0]!;
    expect(worker.options.workerData.diagnostics).toBe(false);
    worker.emit('message', { row: null });
    worker.end();
    await expect(pending).resolves.toBeNull();
    expect(performance.now).not.toHaveBeenCalled();
  });

  it('observes inline errors without changing the null fallback', async () => {
    const prepare = vi.fn(() => { now += 3; throw new Error('private inline error'); });
    const observed = vi.fn();
    await expect(connection(':memory:', { prepare }).checkpointWalPassive(observed)).resolves.toBeNull();
    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledWith('PRAGMA wal_checkpoint(PASSIVE)');
    expect(observed).toHaveBeenCalledOnce();
    expect(observed).toHaveBeenCalledWith({ inlineCalls: 1, inlinePragmaMs: 3,
      inlinePragmaErrors: 1, parentTotalMs: 3, nullResults: 1 });
  });
});

// Evaluate the exact generated worker source, with a deterministic clock and
// database stub. This verifies real instrumentation rather than invented payloads.
describe('worker-side segment instrumentation', () => {
  it.each(['none', 'module', 'open', 'busyTimeout', 'pragma', 'close'] as const)(
    'retains existing SQL/close control flow for %s failure', async (failure) => {
      const pending = connection().checkpointWalPassive(() => {});
      await flush();
      const worker = state.workers[0]!;
      let workerNow = 1005;
      const sql: string[] = [];
      let closed = 0;
      let posted: any;
      const step = (phase: typeof failure, duration: number) => {
        workerNow += duration;
        if (phase === failure) throw new Error('private worker-stage error');
      };
      class DatabaseSync {
        constructor() { step('open', 5); }
        exec(command: string) { sql.push(command); step('busyTimeout', 7); }
        prepare(command: string) {
          sql.push(command);
          return { get: () => { step('pragma', 24); return { busy: 0, log: 10, checkpointed: 10 }; } };
        }
        close() { closed++; step('close', 17); }
      }
      vm.runInNewContext(worker.source, {
        performance: { now: () => workerNow, timeOrigin: performance.timeOrigin },
        require: (name: string) => {
          if (name === 'node:worker_threads') {
            workerNow++;
            return { workerData: worker.options.workerData, parentPort: { postMessage: (value: unknown) => { posted = value; } } };
          }
          expect(name).toBe('node:sqlite');
          step('module', 3);
          return { DatabaseSync };
        },
      });
      const expectedKeys = { module: 'workerModuleLoadErrors', open: 'workerOpenErrors',
        busyTimeout: 'workerBusyTimeoutErrors', pragma: 'workerPragmaErrors', close: 'workerCloseErrors' } as const;
      expect(posted.diagnostics.workerEntryMs).toBe(1);
      expect(posted.diagnostics.workerModuleLoadMs).toBe(3);
      if (failure !== 'none') expect(posted.diagnostics[expectedKeys[failure]]).toBe(1);
      if (failure === 'none' || failure === 'close' || failure === 'pragma') {
        expect(sql).toEqual(['PRAGMA busy_timeout=0', 'PRAGMA wal_checkpoint(PASSIVE)']);
        expect(closed).toBe(1);
        expect(posted.diagnostics).toMatchObject({ workerOpenMs: 5, workerBusyTimeoutMs: 7,
          workerPragmaMs: 24, workerCloseMs: 17, workerTotalMs: 57 });
      } else {
        expect(closed).toBe(0); // Preserve the existing outer-catch behavior.
        expect(posted.row).toBeNull();
      }
      now = workerNow + 50;
      worker.emit('message', posted);
      worker.end();
      await pending;
    });
});

describe('bounded valve result aggregation', () => {
  it('classifies inline non-WAL -1 frame results as unavailable without changing checkpoint decisions', async () => {
    const summary = new SyncDiagnosticsSummary();
    const prepare = vi.fn(() => ({ get: () => ({ busy: 0, log: -1, checkpointed: -1 }) }));
    const db = connection(':memory:', { prepare });
    vi.spyOn(db, 'getWalSizeBytes').mockReturnValue(1);
    const valve = new WalCheckpointValve(db, 1, 2000, undefined, summary);
    await valve.foldNow();
    const values = counters(summary);
    expect(values).toMatchObject({
      parkedPassiveInlineCalls: 1, parkedPassiveUnavailableResultsCount: 1,
      parkedTruncateInlineCalls: 1, parkedTruncateUnavailableResultsCount: 1,
    });
    expect(values).not.toHaveProperty('parkedPassiveFullResultsCount');
    expect(values).not.toHaveProperty('parkedPassiveLogFramesSamplesCount');
    expect(values).not.toHaveProperty('parkedPassiveLogFramesLastCount');
    expect(values).not.toHaveProperty('parkedTruncateFullResultsCount');
    expect(prepare.mock.calls).toEqual([['PRAGMA wal_checkpoint(PASSIVE)'], ['PRAGMA wal_checkpoint(TRUNCATE)']]);
  });

  it('keeps snapshot frame maxima/last values and exclusive result counts across checkpoints', async () => {
    const summary = new SyncDiagnosticsSummary();
    const observations: WalCheckpointDiagnostics[] = [
      { resultRows: 1, resultBusy: 0, resultLogFrames: 10, resultCheckpointedFrames: 10 },
      { resultRows: 1, resultBusy: 1, resultLogFrames: 10, resultCheckpointedFrames: 8 },
      { resultRows: 1, resultBusy: 0, resultLogFrames: 7, resultCheckpointedFrames: 3 },
      { resultRows: 1, resultBusy: 0, resultLogFrames: -1, resultCheckpointedFrames: -1 },
      { nullResults: 1 },
    ];
    const db = {
      getWalSizeBytes: () => 2 * MB,
      checkpointWalPassive: vi.fn(async (observe?: WalCheckpointObserver) => {
        observe?.({ parentTotalMs: 20, workerPragmaMs: 2, ...observations.shift()! });
        return null;
      }),
    };
    const valve = new WalCheckpointValve(db as unknown as DatabaseConnectionType, 1, 2000, undefined, summary);
    for (let i = 0; i < 5; i++) { valve.check(); await valve.drain(); }
    const values = counters(summary);
    expect(values).toMatchObject({
      advisoryPassiveLifecycleCalls: 5, advisoryPassiveResultRowsCount: 4, advisoryPassiveNullResultsCount: 1,
      advisoryPassiveFullResultsCount: 1, advisoryPassiveBusyResultsCount: 1, advisoryPassivePartialResultsCount: 1,
      advisoryPassiveUnavailableResultsCount: 1, advisoryPassiveLogFramesSamplesCount: 3,
      advisoryPassiveLogFramesMaxCount: 10, advisoryPassiveLogFramesLastCount: 7,
      advisoryPassiveCheckpointedFramesMaxCount: 10, advisoryPassiveCheckpointedFramesLastCount: 3,
      advisoryPassiveBusyValueMaxCount: 1, advisoryPassiveParentTotalMs: 100, advisoryPassiveWorkerPragmaMs: 10,
    });
    expect(values.advisoryPassiveBusyValueLastCount ?? 0).toBe(0);
    expect(values).not.toHaveProperty('advisoryPassiveLogFramesTotalCount');
    expect(values).not.toHaveProperty('advisoryPassiveCheckpointedFramesTotalCount');
  });
});
