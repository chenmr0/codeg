import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../src/db';
import { WalCheckpointError, walCheckpointErrorFrom, walCheckpointResultFrom } from '../src/db/wal-checkpoint';

describe('checkpoint error classification', () => {
  it.each([5, 6, 261, 262, 517])('allows retry for SQLite busy/locked code %s', errcode => {
    expect(walCheckpointErrorFrom({ message: 'database contention detail', code: 'ERR_SQLITE_ERROR', errcode }))
      .toMatchObject({ name: 'WalCheckpointError', reason: 'busy', retryable: true,
        message: 'database contention detail', sqliteCode: 'ERR_SQLITE_ERROR', errcode });
  });

  it.each([8, 10, 11, 13, 14, 26, 266])('never treats SQLite failure %s as an unavailable worker', errcode => {
    expect(walCheckpointErrorFrom({ message: 'original storage failure', code: 'ERR_SQLITE_ERROR', errcode }, 'unavailable'))
      .toMatchObject({ reason: 'sqlite', retryable: false, errcode, message: 'original storage failure' });
  });

  it('preserves an existing timeout and does not guess busy from message text', () => {
    const timeout = new WalCheckpointError('timed out', 'timeout', true);
    expect(walCheckpointErrorFrom(timeout)).toBe(timeout);
    expect(walCheckpointErrorFrom(new Error('busy reading corrupt database')))
      .toMatchObject({ reason: 'sqlite', retryable: false });
  });

  it('rejects missing and malformed result rows instead of inventing checkpoint progress', () => {
    for (const row of [null, undefined, {}, { busy: 0, log: NaN, checkpointed: 1 }]) {
      expect(() => walCheckpointResultFrom(row)).toThrow(WalCheckpointError);
    }
    expect(walCheckpointResultFrom({ busy: 0, log: -1, checkpointed: -1 }))
      .toEqual({ busy: 0, log: -1, checkpointed: -1 });
  });
});

describe('checkpoint errors retain SQLite evidence', () => {
  let db: DatabaseConnection | undefined;
  let root: string | undefined;
  afterEach(() => {
    vi.restoreAllMocks();
    db?.close(); db = undefined;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('preserves in-memory SQLite failures', async () => {
    db = DatabaseConnection.initialize(':memory:');
    vi.spyOn(db.getDb(), 'prepare').mockImplementationOnce(() => {
      throw Object.assign(new Error('disk I/O error details'), { code: 'ERR_SQLITE_ERROR', errcode: 266 });
    });
    await expect(db.checkpointWalPassive()).rejects.toMatchObject({
      name: 'WalCheckpointError', reason: 'sqlite', retryable: false,
      message: 'disk I/O error details', sqliteCode: 'ERR_SQLITE_ERROR', errcode: 266,
    });
  });

  it('propagates a real worker database-open failure with its SQLite code', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-checkpoint-errors-'));
    db = DatabaseConnection.initialize(path.join(root, 'db.sqlite'));
    // Keep the owning handle valid but point the checkpoint at a nonexistent parent.
    (db as unknown as { dbPath: string }).dbPath = path.join(root, 'missing-directory', 'db.sqlite');
    await expect(db.checkpointWalTruncate()).rejects.toMatchObject({
      name: 'WalCheckpointError', reason: 'sqlite', retryable: false,
      sqliteCode: 'ERR_SQLITE_ERROR', errcode: 14,
    });
  });
});
