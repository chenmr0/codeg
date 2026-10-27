export type WalCheckpointFailureReason = 'busy' | 'timeout' | 'unavailable' | 'sqlite';

export interface WalCheckpointOptions {
  /** Request cancellation after this interval; still wait for worker exit. */
  timeoutMs?: number;
}

export interface WalCheckpointResult {
  busy: number;
  log: number;
  checkpointed: number;
}

/** A checkpoint failure with enough detail to distinguish retryable contention. */
export class WalCheckpointError extends Error {
  readonly code = 'WAL_CHECKPOINT_FAILED' as const;

  constructor(
    message: string,
    readonly reason: WalCheckpointFailureReason,
    readonly retryable: boolean,
    readonly sqliteCode?: string | number,
    readonly errcode?: number,
  ) {
    super(message);
    this.name = 'WalCheckpointError';
  }
}

/** Preserve SQLite extended codes; never infer contention from an error message. */
export function walCheckpointErrorFrom(
  error: unknown,
  fallbackReason: 'sqlite' | 'unavailable' = 'sqlite',
): WalCheckpointError {
  if (error instanceof WalCheckpointError) return error;
  const details = error && typeof error === 'object'
    ? error as { message?: unknown; code?: unknown; errcode?: unknown }
    : undefined;
  const message = typeof details?.message === 'string' ? details.message : String(error);
  const sqliteCode = typeof details?.code === 'string' || typeof details?.code === 'number'
    ? details.code : undefined;
  const errcode = typeof details?.errcode === 'number' && Number.isInteger(details.errcode)
    ? details.errcode : undefined;
  const numericCode = errcode ?? (typeof sqliteCode === 'number' ? sqliteCode : undefined);
  const busy = numericCode !== undefined
    ? (numericCode & 0xff) === 5 || (numericCode & 0xff) === 6
    : typeof sqliteCode === 'string' && /^SQLITE_(BUSY|LOCKED)(_|$)/.test(sqliteCode);
  const sqliteFailure = numericCode !== undefined ||
    (typeof sqliteCode === 'string' && (sqliteCode.startsWith('SQLITE_') || sqliteCode === 'ERR_SQLITE_ERROR'));
  const reason = busy ? 'busy' : sqliteFailure ? 'sqlite' : fallbackReason;
  return new WalCheckpointError(message, reason, busy || reason === 'unavailable', sqliteCode, errcode);
}

export function walCheckpointResultFrom(row: unknown): WalCheckpointResult {
  if (row && typeof row === 'object') {
    const values = row as Record<string, unknown>;
    if (typeof values.busy === 'number' && Number.isFinite(values.busy) &&
        typeof values.log === 'number' && Number.isFinite(values.log) &&
        typeof values.checkpointed === 'number' && Number.isFinite(values.checkpointed)) {
      return { busy: values.busy, log: values.log, checkpointed: values.checkpointed };
    }
  }
  throw new WalCheckpointError('WAL checkpoint returned no valid result row', 'unavailable', true);
}
