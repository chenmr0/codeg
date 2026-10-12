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
import type { SyncDiagnosticPhase, SyncDiagnosticsSummary } from '../sync/diagnostics-summary';

type WalTiming = 'backpressureWait' | 'drain' | 'drainPauseWait' | 'drainInflightWait' |
  'fold' | 'park' | 'parkedInflightWait' | 'parkedPassive' | 'parkedTruncate' |
  'parkedRetry' | 'advisoryCheck' | 'advisoryPassive';

const DEFAULT_WAL_VALVE_MB = 256;
const HARD_CAP_MULTIPLIER = 2;
const MAX_PAUSED_BACKFILL_PASSES = 20;
const CHECK_INTERVAL_MS = 2000;
const RETRY_DELAY_MS = 50;

export class WalValveAbortError extends Error {
  readonly code = 'WAL_VALVE_ABORT' as const;
  constructor(message: string, readonly walBytes: number, readonly hardBytes: number) {
    super(message);
    this.name = 'WalValveAbortError';
  }
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
    private readonly log: (msg: string) => void = () => {},
    private readonly summary?: SyncDiagnosticsSummary
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
    const phase = this.summary?.phase;
    const started = phase ? performance.now() : 0;
    let failed = false;
    try {
      if (!this.pause && !this.inflight && this.db.getWalSizeBytes() > this.softBytes) this.fire(phase);
    } catch (error) {
      failed = true;
      // The timer cannot reject its caller. The next write barrier/fold does
      // a strict size observation and propagates an ongoing I/O failure.
      this.log(`WAL size observation failed: ${String(error)}`);
    } finally {
      if (phase) this.finish('advisoryCheck', phase, started, failed);
    }
  }

  /** Caller must await after ALL main/store-worker writes have committed. */
  backpressure(): Promise<void> | null {
    const phase = this.summary?.phase;
    const started = phase ? performance.now() : 0;
    if (phase) this.add('backpressureCalls', phase, 1);
    try {
      if (this.pause) {
        return phase ? this.observe('backpressureWait', phase, () => this.pause!, started) : this.pause;
      }
      if (this.db.getWalSizeBytes() <= this.hardBytes) return null;
      return phase ? this.observe('backpressureWait', phase, () => this.park(phase), started) : this.park();
    } catch (error) {
      if (phase) this.add('backpressureErrors', phase, 1);
      throw error;
    }
  }

  async drain(): Promise<void> {
    const phase = this.summary?.phase;
    const started = phase ? performance.now() : 0;
    let failed = false;
    try {
      while (this.pause || this.inflight) {
        if (this.pause) {
          await (phase ? this.observe('drainPauseWait', phase, () => this.pause!) : this.pause);
        }
        if (this.inflight) {
          await (phase ? this.observe('drainInflightWait', phase, () => this.inflight!) : this.inflight);
        }
      }
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      if (phase) this.finish('drain', phase, started, failed);
    }
  }

  /** A phase fold checks every nonempty generation, regardless of size growth. */
  async foldNow(): Promise<void> {
    const phase = this.summary?.phase;
    const started = phase ? performance.now() : 0;
    let failed = false;
    try {
      await this.drain();
      if (this.db.getWalSizeBytes() === 0) return;
      await this.park(phase);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      if (phase) this.finish('fold', phase, started, failed);
    }
  }

  private park(phase?: SyncDiagnosticPhase): Promise<void> {
    if (this.pause) return this.pause;
    // Count the shared pause once as work; callers separately observe their
    // own wait. Keep the original promise identity and checkpoint scheduling.
    return phase ? this.observe('park', phase, () => this.beginPark(phase)) : this.beginPark();
  }

  private beginPark(phase?: SyncDiagnosticPhase): Promise<void> {
    const started = Date.now();
    this.log(`backpressure: wal=${this.db.getWalSizeBytes()} cap=${this.hardBytes}; pausing writer`);
    this.pause = this.backfillFully(phase).finally(() => {
      this.pause = null;
      this.log(`backpressure released after ${Date.now() - started}ms: wal=${this.db.getWalSizeBytes()}`);
    });
    return this.pause;
  }

  private abort(): never {
    const bytes = this.db.getWalSizeBytes();
    throw new WalValveAbortError(
      `WAL checkpoint cannot release its file while over the write-boundary cap ` +
      `(wal=${bytes}, cap=${this.hardBytes}). Stopping writes to avoid unbounded disk growth. ` +
      `Close concurrent database readers and retry; the index can resume.`, bytes, this.hardBytes);
  }

  private async backfillFully(phase?: SyncDiagnosticPhase): Promise<void> {
    // Timer PASSIVE may describe an old snapshot; discard its result and do a
    // fresh checkpoint with this writer parked. Never TRUNCATE from the timer.
    if (this.inflight) {
      await (phase ? this.observe('parkedInflightWait', phase, () => this.inflight!) : this.inflight);
    }
    let previous: string | undefined;
    for (let i = 0; i < MAX_PAUSED_BACKFILL_PASSES; i++) {
      const res = await (phase
        ? this.observe('parkedPassive', phase, () => this.db.checkpointWalPassive())
        : this.db.checkpointWalPassive());
      if (!res) {
        if (this.db.getWalSizeBytes() > this.hardBytes) this.abort();
        return;
      }
      if (res.busy === 0 && res.log === res.checkpointed) {
        const trunc = await (phase
          ? this.observe('parkedTruncate', phase, () => this.db.checkpointWalTruncate())
          : this.db.checkpointWalTruncate());
        if (trunc?.busy === 0 && this.db.getWalSizeBytes() <= this.hardBytes) return;
      }
      // A reader can pin a fully backfilled generation and prevent TRUNCATE.
      // Below cap that is safe; above cap never release the writer silently.
      if (this.db.getWalSizeBytes() <= this.hardBytes) return;
      const progress = `${res.busy}:${res.log}:${res.checkpointed}:${this.db.getWalSizeBytes()}`;
      if (progress === previous) this.abort();
      previous = progress;
      await (phase
        ? this.observe('parkedRetry', phase, () => new Promise<void>(resolve => setTimeout(resolve, RETRY_DELAY_MS)))
        : new Promise<void>(resolve => setTimeout(resolve, RETRY_DELAY_MS)));
    }
    this.abort();
  }

  private fire(phase?: SyncDiagnosticPhase): void {
    const p = (phase
      ? this.observe('advisoryPassive', phase, () => this.db.checkpointWalPassive())
      : this.db.checkpointWalPassive())
      .then(() => { /* Results belong to their own snapshot, never a size baseline. */ })
      .catch(() => { /* Timer is advisory; the parked hard-cap path fails closed. */ })
      .finally(() => { if (this.inflight === p) this.inflight = null; });
    this.inflight = p;
  }

  /**
   * Every timing is monotonic wall time. Fold includes drain and park; park
   * includes checkpoint calls, retry sleeps and any advisory-inflight wait.
   * Backpressure/drain waits are per caller, overlap the shared work, and must
   * not be added to checkpoint time. Advisory PASSIVE is separate from parked
   * PASSIVE; parkedInflightWait overlaps that advisory work. Caller-facing
   * backpressure/fold/drain metrics also capture the initiating caller's phase,
   * never the phase at completion; checkpoint work is reported globally only.
   * These helpers are reached only when a collector was explicitly supplied.
   */
  private observe<T>(metric: WalTiming, phase: SyncDiagnosticPhase,
    operation: () => Promise<T>, started = performance.now()): Promise<T> {
    let promise: Promise<T>;
    try {
      promise = operation();
    } catch (error) {
      this.finish(metric, phase, started, true);
      throw error;
    }
    // Both settlement paths finalize counters without changing the original
    // promise or creating an unhandled rejection from a discarded .finally.
    void promise.then(
      () => this.finish(metric, phase, started, false),
      () => this.finish(metric, phase, started, true)
    );
    return promise;
  }

  private finish(metric: WalTiming, phase: SyncDiagnosticPhase, started: number, failed: boolean): void {
    this.add(`${metric}Calls`, phase, 1);
    this.add(`${metric}Ms`, phase, Math.max(0, performance.now() - started));
    if (failed) this.add(`${metric}Errors`, phase, 1);
  }

  private add(key: string, phase: SyncDiagnosticPhase, value: number): void {
    // All key parts are fixed literals or the caller's bounded phase enum.
    this.summary!.add('wal', key, value);
    if (key.startsWith('backpressure') || key.startsWith('fold') || key.startsWith('drain')) {
      this.summary!.add('wal', `${phase}${key[0]!.toUpperCase()}${key.slice(1)}`, value);
    }
  }
}
