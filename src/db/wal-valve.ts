/**
 * Bounded WAL checkpoint deferral. Physical size is an allocation high-water
 * mark, NOT an uncheckpointed-frame count: a generation can reuse that space,
 * and an asynchronous checkpoint result can describe an older writer snapshot.
 * Never subtract a "last full backfill" size or skip a phase fold on that basis.
 *
 * Timer checkpoints are PASSIVE only. At a completed-write boundary the writer
 * parks once the absolute WAL file exceeds 2x soft, then PASSIVE + TRUNCATE
 * release the allocation. A pinned reader / unavailable checkpoint cannot let
 * writes continue past that cap. This is a boundary cap: one file/transaction
 * or an internally multi-write synthesis/index-restoration phase may overshoot
 * it; concurrent external writers are outside our control.
 */
import type { DatabaseConnection } from './index';
import { performance } from 'node:perf_hooks';
import { WalCheckpointError, type WalCheckpointResult } from './wal-checkpoint';

const DEFAULT_WAL_VALVE_MB = 256;
const HARD_CAP_MULTIPLIER = 2;
const CHECK_INTERVAL_MS = 2000;
const RETRY_DELAY_MS = 50;
const MAX_RETRY_DELAY_MS = 500;
const DEFAULT_WAL_WAIT_MS = 10_000;
const MAX_WAL_WAIT_MS = 60_000;
const NO_LOG = (_message: string): void => {};

interface WalPauseTimings {
  inflightMs: number;
  passiveMs: number;
  truncateMs: number;
  retrySleepMs: number;
  passiveCalls: number;
  truncateCalls: number;
  retryStarted: boolean;
}

export interface WalValveCheckpointFailure {
  mode: 'PASSIVE' | 'TRUNCATE';
  reason: 'busy' | 'timeout' | 'unavailable' | 'sqlite';
  message: string;
  retryable: boolean;
  busy?: number;
  log?: number;
  checkpointed?: number;
  sqliteCode?: string | number;
  errcode?: number;
  attempts: number;
  waitedMs: number;
}

export class WalValveAbortError extends Error {
  readonly code = 'WAL_VALVE_ABORT' as const;
  constructor(message: string, readonly walBytes: number, readonly hardBytes: number,
    readonly checkpoint?: WalValveCheckpointFailure) {
    super(message);
    this.name = 'WalValveAbortError';
  }
}

/** Retry budget after a checkpoint first reports contention or unavailability. */
export function resolveWalWaitMs(envVal: string | undefined): number {
  if (envVal !== undefined && envVal !== '') {
    const n = Number(envVal);
    if (Number.isFinite(n) && n > 0) return Math.max(1, Math.min(MAX_WAL_WAIT_MS, Math.floor(n)));
  }
  return DEFAULT_WAL_WAIT_MS;
}

export function resolveWalValveMb(envVal: string | undefined): number {
  if (envVal !== undefined && envVal !== '') {
    const n = Number(envVal);
    if (Number.isFinite(n) && n > 0) return Math.max(1, Math.floor(n));
  }
  return DEFAULT_WAL_VALVE_MB;
}

export class WalCheckpointValve {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<void> | null = null;
  private pause: Promise<void> | null = null;
  private readonly softBytes: number;
  private readonly hardBytes: number;

  constructor(
    private readonly db: DatabaseConnection,
    softMb: number = resolveWalValveMb(process.env.CODEGRAPH_WAL_VALVE_MB),
    private readonly intervalMs: number = CHECK_INTERVAL_MS,
    private readonly log: (msg: string) => void = NO_LOG,
    private readonly waitMs: number = resolveWalWaitMs(process.env.CODEGRAPH_WAL_WAIT_MS),
  ) {
    this.softBytes = softMb * 1024 * 1024;
    this.hardBytes = this.softBytes * HARD_CAP_MULTIPLIER;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.check(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Timer frequency bounds redundant PASSIVE work on reused allocations. */
  check(): void {
    try {
      if (!this.pause && !this.inflight && this.db.getWalSizeBytes() > this.softBytes) this.fire();
    } catch (error) {
      // The timer cannot reject its caller. The next write barrier/fold does
      // a strict size observation and propagates an ongoing I/O failure.
      this.log(`WAL size observation failed: ${String(error)}`);
    }
  }

  /** Caller must await after ALL main/store-worker writes have committed. */
  backpressure(): Promise<void> | null {
    if (this.pause) return this.pause;
    if (this.db.getWalSizeBytes() <= this.hardBytes) return null;
    return this.park('cap');
  }

  async drain(): Promise<void> {
    while (this.pause || this.inflight) {
      if (this.pause) await this.pause;
      if (this.inflight) await this.inflight;
    }
  }

  /** A phase fold checks every nonempty generation, regardless of size growth. */
  async foldNow(): Promise<void> {
    await this.drain();
    if (this.db.getWalSizeBytes() === 0) return;
    await this.park('phase');
  }

  private park(trigger: 'cap' | 'phase'): Promise<void> {
    if (this.pause) return this.pause;
    const started = performance.now();
    const beforeBytes = this.db.getWalSizeBytes();
    const timings: WalPauseTimings | undefined = this.log === NO_LOG ? undefined : {
      inflightMs: 0, passiveMs: 0, truncateMs: 0, retrySleepMs: 0,
      passiveCalls: 0, truncateCalls: 0, retryStarted: false,
    };
    this.log(`backpressure: wal=${beforeBytes} cap=${this.hardBytes}; pausing writer`);
    const report = (outcome: 'released' | 'aborted'): void => {
      if (!timings) return;
      const totalMs = performance.now() - started;
      // These intervals are disjoint. A checkpoint call includes its worker's
      // startup, open/checkpoint/close, and confirmed exit, not just SQLite I/O.
      const otherMs = Math.max(0, totalMs - timings.inflightMs - timings.passiveMs -
        timings.truncateMs - timings.retrySleepMs);
      try {
        this.log(`checkpoint-detail trigger=${trigger} outcome=${outcome} ` +
          `passiveCalls=${timings.passiveCalls} truncateCalls=${timings.truncateCalls} ` +
          `retryStarted=${timings.retryStarted} ` +
          `inflightMs=${Math.round(timings.inflightMs)}ms passiveMs=${Math.round(timings.passiveMs)}ms ` +
          `truncateMs=${Math.round(timings.truncateMs)}ms retrySleepMs=${Math.round(timings.retrySleepMs)}ms ` +
          `otherMs=${Math.round(otherMs)}ms totalMs=${Math.round(totalMs)}ms`);
      } catch { /* Additional diagnostics must not change the checkpoint outcome. */ }
    };
    this.pause = this.backfillFully(timings).then(() => {
      this.log(`backpressure released after ${Math.round(performance.now() - started)}ms: wal=${this.db.getWalSizeBytes()}`);
      report('released');
    }, error => {
      this.log(`backpressure aborted after ${Math.round(performance.now() - started)}ms: ${String(error)}`);
      report('aborted');
      throw error;
    }).finally(() => { this.pause = null; });
    return this.pause;
  }

  private abort(checkpoint: WalValveCheckpointFailure): never {
    const bytes = this.db.getWalSizeBytes();
    const advice = checkpoint.reason === 'busy'
      ? 'Let concurrent database transactions finish, then retry sync.'
      : 'Resolve the checkpoint error above, then retry sync.';
    throw new WalValveAbortError(
      `WAL checkpoint cannot release its file while over the write-boundary cap ` +
      `(wal=${bytes}, cap=${this.hardBytes}). Stopping writes to avoid unbounded disk growth. ` +
      `Last checkpoint: ${checkpoint.mode} ${checkpoint.reason}; ${checkpoint.message}; ` +
      `attempts=${checkpoint.attempts}, waited=${checkpoint.waitedMs}ms. ${advice} ` +
      `Pending index work is retained for retry.`, bytes, this.hardBytes, checkpoint);
  }

  private async backfillFully(timings?: WalPauseTimings): Promise<void> {
    // Timer PASSIVE may describe an old snapshot; discard its result and do a
    // fresh checkpoint with this writer parked. Never TRUNCATE from the timer.
    if (this.inflight) {
      const started = timings ? performance.now() : 0;
      try { await this.inflight; }
      finally { if (timings) timings.inflightMs += performance.now() - started; }
    }
    let retryStarted: number | undefined;
    let delay = RETRY_DELAY_MS;
    let attempts = 0;
    let failure: WalValveCheckpointFailure | undefined;
    const waitedMs = () => retryStarted === undefined ? 0 : Math.round(performance.now() - retryStarted);
    // Do not shorten an uncontended checkpoint on slow storage. The retry
    // budget starts only once contention/unavailability has been observed.
    const checkpointOptions = () => retryStarted === undefined ? undefined : {
      timeoutMs: Math.max(1, Math.ceil(this.waitMs - (performance.now() - retryStarted))),
    };
    while (true) {
      if (retryStarted !== undefined) {
        if (this.db.getWalSizeBytes() <= this.hardBytes) return;
        if (performance.now() - retryStarted >= this.waitMs) {
          this.abort({ ...failure!, waitedMs: waitedMs() });
        }
      }
      let mode: 'PASSIVE' | 'TRUNCATE' = 'PASSIVE';
      attempts++;
      try {
        let started = timings ? performance.now() : 0;
        if (timings) timings.passiveCalls++;
        let res: WalCheckpointResult | null;
        try { res = await this.db.checkpointWalPassive(checkpointOptions()); }
        finally { if (timings) timings.passiveMs += performance.now() - started; }
        if (!res) throw new WalCheckpointError('Checkpoint returned no result', 'unavailable', true);
        let incomplete = res;
        if (res.busy === 0 && res.log === res.checkpointed) {
          // PASSIVE itself may have exhausted the remaining retry budget.
          if (retryStarted !== undefined && performance.now() - retryStarted >= this.waitMs) {
            throw new WalCheckpointError('Retry budget exhausted before TRUNCATE', 'timeout', true);
          }
          mode = 'TRUNCATE';
          started = timings ? performance.now() : 0;
          if (timings) timings.truncateCalls++;
          let trunc: WalCheckpointResult | null;
          try { trunc = await this.db.checkpointWalTruncate(checkpointOptions()); }
          finally { if (timings) timings.truncateMs += performance.now() - started; }
          if (!trunc) throw new WalCheckpointError('Checkpoint returned no result', 'unavailable', true);
          if (trunc.busy === 0 && this.db.getWalSizeBytes() <= this.hardBytes) return;
          incomplete = trunc;
        }
        failure = { mode, reason: 'busy', retryable: true, ...incomplete, attempts, waitedMs: waitedMs(),
          message: `busy=${incomplete.busy}, log=${incomplete.log}, checkpointed=${incomplete.checkpointed}` };
      } catch (error) {
        const typed = error instanceof WalCheckpointError ? error : undefined;
        failure = { mode, reason: typed?.reason ?? 'unavailable', retryable: typed?.retryable ?? false,
          message: error instanceof Error ? error.message : String(error),
          sqliteCode: typed?.sqliteCode, errcode: typed?.errcode, attempts, waitedMs: waitedMs() };
      }
      // Preserve advisory phase folds below the cap. Above it all writers
      // remain parked, including during sleeps and checkpoint worker shutdown.
      if (this.db.getWalSizeBytes() <= this.hardBytes) return;
      if (!failure.retryable) this.abort(failure);
      if (retryStarted === undefined) {
        retryStarted = performance.now();
        if (timings) timings.retryStarted = true;
        this.log(`checkpoint blocked: ${failure.mode} ${failure.reason}; ${failure.message}; ` +
          `waiting up to ${this.waitMs}ms with writer paused`);
      }
      const remaining = this.waitMs - (performance.now() - retryStarted);
      if (remaining <= 0) this.abort({ ...failure, waitedMs: waitedMs() });
      const sleepStarted = timings ? performance.now() : 0;
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(delay, remaining)));
      if (timings) timings.retrySleepMs += performance.now() - sleepStarted;
      delay = Math.min(delay * 2, MAX_RETRY_DELAY_MS);
    }
  }

  private fire(): void {
    const p = this.db.checkpointWalPassive()
      .then(() => { /* Results belong to their own snapshot, never a size baseline. */ })
      .catch(() => { /* Timer is advisory; the parked hard-cap path fails closed. */ })
      .finally(() => { if (this.inflight === p) this.inflight = null; });
    this.inflight = p;
  }
}
