import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../src/db';
import { WalCheckpointValve, WalValveAbortError, resolveWalValveMb, resolveWalWaitMs } from '../src/db/wal-valve';
import { WalCheckpointError } from '../src/db/wal-checkpoint';

const MB = 1024 * 1024;
const complete = { busy: 0, log: 10, checkpointed: 10 };
function fake(bytes = 3 * MB, waitMs = 250) {
  const state = { bytes };
  const db = {
    getWalSizeBytes: vi.fn(() => state.bytes),
    checkpointWalPassive: vi.fn(async () => complete),
    checkpointWalTruncate: vi.fn(async () => { state.bytes = 0; return { busy: 0, log: 0, checkpointed: 0 }; }),
  };
  return { state, db, valve: new WalCheckpointValve(db as unknown as DatabaseConnection, 1, 2000, undefined, waitMs) };
}

describe('logical checkpoint safety without a physical growth baseline', () => {
  it('keeps environment defaults and clamps sub-MB input instead of disabling the cap', () => {
    expect(resolveWalValveMb(undefined)).toBe(256);
    expect(resolveWalValveMb('0')).toBe(256);
    expect(resolveWalValveMb('10.9')).toBe(10);
    expect(resolveWalValveMb('0.2')).toBe(1);
    expect(resolveWalWaitMs(undefined)).toBe(10_000);
    expect(resolveWalWaitMs('0')).toBe(10_000);
    expect(resolveWalWaitMs('NaN')).toBe(10_000);
    expect(resolveWalWaitMs('Infinity')).toBe(10_000);
    expect(resolveWalWaitMs('1500.9')).toBe(1500);
    expect(resolveWalWaitMs('0.2')).toBe(1);
    expect(resolveWalWaitMs('120000')).toBe(60_000);
  });

  it('does not create workers for an empty WAL or a small write boundary', async () => {
    const { db, valve } = fake(0);
    valve.check();
    await valve.foldNow();
    expect(valve.backpressure()).toBeNull();
    expect(db.checkpointWalPassive).not.toHaveBeenCalled();
    expect(db.checkpointWalTruncate).not.toHaveBeenCalled();
  });

  it('discards a stale timer snapshot and checkpoints writes appended before the result arrives', async () => {
    const { db, state, valve } = fake(1.5 * MB);
    let finish!: (value: typeof complete) => void;
    db.checkpointWalPassive.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    valve.check();
    state.bytes = 1.8 * MB;
    finish(complete);
    await valve.drain();
    expect(db.checkpointWalTruncate).not.toHaveBeenCalled(); // never from timer
    await valve.foldNow();
    expect(db.checkpointWalPassive).toHaveBeenCalledTimes(2);
    expect(db.checkpointWalTruncate).toHaveBeenCalledOnce();
  });

  it('folds a reused generation even when physical size is unchanged', async () => {
    const { db, state, valve } = fake(MB);
    // A reader prevents truncation; a later generation fits the allocation.
    db.checkpointWalTruncate.mockImplementation(async () => ({ busy: 1, log: 10, checkpointed: 10 }));
    await valve.foldNow();
    const size = state.bytes;
    await valve.foldNow();
    expect(state.bytes).toBe(size);
    expect(db.checkpointWalPassive).toHaveBeenCalledTimes(2);
  });

  it('serializes simultaneous fold and backpressure calls', async () => {
    const { db, valve } = fake();
    let active = 0, maxActive = 0;
    db.checkpointWalPassive.mockImplementation(async () => {
      maxActive = Math.max(maxActive, ++active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      return complete;
    });
    await Promise.all([valve.foldNow(), valve.backpressure(), valve.foldNow()]);
    expect(maxActive).toBe(1);
    expect(db.checkpointWalTruncate).toHaveBeenCalledOnce();
  });

  it('bounds unavailable checkpoint retries without releasing the writer above the cap', async () => {
    const { db, valve } = fake();
    db.checkpointWalPassive.mockResolvedValue(null as never);
    await expect(valve.backpressure()).rejects.toBeInstanceOf(WalValveAbortError);
    await expect(valve.backpressure()).rejects.toBeInstanceOf(WalValveAbortError);
    expect(db.checkpointWalPassive.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(db.checkpointWalPassive.mock.calls.length).toBeLessThan(12);
    expect(db.checkpointWalTruncate).not.toHaveBeenCalled();
  });

  it('fails closed when a fully backfilled file cannot be truncated; no busy spin', async () => {
    const { db, valve } = fake();
    db.checkpointWalTruncate.mockResolvedValue({ busy: 1, log: 10, checkpointed: 10 });
    await expect(valve.backpressure()).rejects.toMatchObject({ code: 'WAL_VALVE_ABORT',
      checkpoint: { mode: 'TRUNCATE', reason: 'busy', log: 10, checkpointed: 10 } });
    expect(db.checkpointWalPassive.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(db.checkpointWalPassive.mock.calls.length).toBeLessThan(6);
    expect(db.checkpointWalTruncate.mock.calls.length).toBe(db.checkpointWalPassive.mock.calls.length);
  });

  it('does not truncate an incompletely backfilled snapshot', async () => {
    const { db, valve } = fake();
    db.checkpointWalPassive.mockResolvedValue({ busy: 0, log: 20, checkpointed: 10 });
    await expect(valve.backpressure()).rejects.toBeInstanceOf(WalValveAbortError);
    expect(db.checkpointWalTruncate).not.toHaveBeenCalled();
  });

  it('recovers from transient worker unavailability within the wait budget', async () => {
    const { db, state, valve } = fake();
    db.checkpointWalPassive
      .mockRejectedValueOnce(new WalCheckpointError('worker resource temporarily unavailable', 'unavailable', true))
      .mockResolvedValueOnce(null as never);
    await valve.backpressure();
    expect(state.bytes).toBe(0);
    expect(db.checkpointWalPassive).toHaveBeenCalledTimes(3);
    // The normal attempt retains the original worker deadline. Only retries
    // receive the remaining contention budget.
    expect(db.checkpointWalPassive.mock.calls[0]).toEqual([undefined]);
    const retryOptions = (db.checkpointWalPassive.mock.calls as unknown[][])[1]![0] as { timeoutMs: number };
    expect(retryOptions.timeoutMs).toBeGreaterThan(0);
    expect(retryOptions.timeoutMs).toBeLessThanOrEqual(250);
  });

  it('does not retry a permanent SQLite I/O error or blame readers for it', async () => {
    const { db, valve } = fake();
    db.checkpointWalPassive.mockRejectedValue(new WalCheckpointError('disk I/O error', 'sqlite', false, 'ERR_SQLITE_ERROR', 10));
    const error = await valve.backpressure()!.catch(error => error as WalValveAbortError);
    expect(error).toMatchObject({ code: 'WAL_VALVE_ABORT', checkpoint: {
      reason: 'sqlite', message: 'disk I/O error', errcode: 10, retryable: false, attempts: 1,
    } });
    expect(error.message).toContain('disk I/O error');
    expect(error.message).not.toContain('concurrent database');
    expect(db.checkpointWalPassive).toHaveBeenCalledOnce();
  });

  it('does not restart the retry budget when partial checkpoint progress changes', async () => {
    const { db, state, valve } = fake(3 * MB, 250);
    let checkpointed = 0;
    db.checkpointWalPassive.mockImplementation(async () => ({ busy: 0, log: 1000, checkpointed: ++checkpointed }));
    const error = await valve.backpressure()!.catch(error => error as WalValveAbortError);
    expect(error).toMatchObject({ code: 'WAL_VALVE_ABORT', checkpoint: { mode: 'PASSIVE', reason: 'busy' } });
    expect(error.checkpoint!.waitedMs).toBeGreaterThanOrEqual(250);
    expect(db.checkpointWalPassive.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(db.checkpointWalPassive.mock.calls.length).toBeLessThan(8);
    expect(db.checkpointWalTruncate).not.toHaveBeenCalled();
    expect(state.bytes).toBe(3 * MB);
  });

  it('retries a typed SQLite busy error from TRUNCATE without releasing the writer', async () => {
    const { db, state, valve } = fake();
    db.checkpointWalTruncate.mockRejectedValueOnce(
      new WalCheckpointError('database is locked', 'busy', true, 'ERR_SQLITE_ERROR', 5));
    const waiting = valve.backpressure();
    expect(waiting).not.toBeNull();
    expect(valve.backpressure()).toBe(waiting);
    await waiting;
    expect(state.bytes).toBe(0);
    expect(db.checkpointWalTruncate).toHaveBeenCalledTimes(2);
  });

  it('logs an abort instead of reporting that backpressure was released', async () => {
    const { db } = fake();
    db.checkpointWalPassive.mockRejectedValue(new WalCheckpointError('readonly checkpoint', 'sqlite', false));
    const logs: string[] = [];
    const valve = new WalCheckpointValve(db as unknown as DatabaseConnection, 1, 2000, msg => logs.push(msg), 100);
    await expect(valve.backpressure()).rejects.toBeInstanceOf(WalValveAbortError);
    expect(logs.some(log => log.includes('backpressure aborted'))).toBe(true);
    expect(logs.some(log => log.includes('backpressure released'))).toBe(false);
  });
});

describe('real SQLite readers and WAL reuse', () => {
  const dirs: string[] = [];
  const open: Array<{ close(): void }> = [];
  afterEach(() => {
    for (const db of open.reverse()) { try { db.close(); } catch {} }
    open.length = 0;
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stops at a pinned reader, then recovers without graph writes or lost data', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-wal-pinned-')); dirs.push(dir);
    const filename = path.join(dir, 'db.sqlite');
    const db = DatabaseConnection.initialize(filename); open.push(db);
    db.setWalAutocheckpoint(0);
    const raw = db.getDb();
    raw.exec('CREATE TABLE wal_fixture (id INTEGER PRIMARY KEY, payload BLOB); INSERT INTO wal_fixture VALUES(1,zeroblob(65536))');
    await db.checkpointWalTruncate();
    const { DatabaseSync } = require('node:sqlite');
    const reader = new DatabaseSync(filename); open.push(reader);
    reader.exec('BEGIN');
    reader.prepare('SELECT length(payload) FROM wal_fixture').get();
    for (let i = 0; i < 12; i++) raw.exec('UPDATE wal_fixture SET payload=randomblob(65536) WHERE id=1');
    const expected = raw.prepare('SELECT hex(payload) AS value FROM wal_fixture').get();
    const valve = new WalCheckpointValve(db, 0.125, 2000, undefined, 200);
    expect(db.getWalSizeBytes()).toBeGreaterThan(0.25 * MB);
    const started = Date.now();
    await expect(valve.backpressure()).rejects.toBeInstanceOf(WalValveAbortError);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(raw.prepare('SELECT hex(payload) AS value FROM wal_fixture').get()).toEqual(expected);
    reader.exec('ROLLBACK');
    await valve.backpressure();
    expect(db.getWalSizeBytes()).toBe(0);
    expect(raw.prepare('SELECT hex(payload) AS value FROM wal_fixture').get()).toEqual(expected);
    expect(raw.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
  });

  it.each(['partial-backfill', 'truncate-only'])('waits for a short reader (%s) and continues without new writes', async mode => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-wal-brief-reader-')); dirs.push(dir);
    const filename = path.join(dir, 'db.sqlite');
    const db = DatabaseConnection.initialize(filename); open.push(db);
    db.setWalAutocheckpoint(0);
    const raw = db.getDb();
    raw.exec('CREATE TABLE wal_fixture(id INTEGER PRIMARY KEY, payload BLOB); INSERT INTO wal_fixture VALUES(1,zeroblob(65536))');
    await db.checkpointWalTruncate();
    const { DatabaseSync } = require('node:sqlite');
    const reader = new DatabaseSync(filename); open.push(reader);
    const pin = () => { reader.exec('BEGIN'); reader.prepare('SELECT length(payload) FROM wal_fixture').get(); };
    if (mode === 'partial-backfill') pin();
    for (let i = 0; i < 12; i++) raw.exec('UPDATE wal_fixture SET payload=randomblob(65536) WHERE id=1');
    if (mode === 'truncate-only') { pin(); await db.checkpointWalPassive(); }
    const expected = raw.prepare('SELECT hex(payload) AS value FROM wal_fixture').get();
    const initialBytes = db.getWalSizeBytes();
    const valve = new WalCheckpointValve(db, 0.125, 2000, undefined, 2000);
    let released = false;
    const release = setTimeout(() => { reader.exec('ROLLBACK'); released = true; }, 500);
    try {
      await valve.backpressure();
      expect(released).toBe(true);
      expect(initialBytes).toBeGreaterThan(0.25 * MB);
      expect(db.getWalSizeBytes()).toBe(0);
      expect(raw.prepare('SELECT hex(payload) AS value FROM wal_fixture').get()).toEqual(expected);
      expect(raw.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    } finally {
      clearTimeout(release);
      if (!released) reader.exec('ROLLBACK');
    }
  });

  it('does not mistake complete backfill for reclaimed space while a real reader still pins TRUNCATE', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-wal-full-backfill-pin-')); dirs.push(dir);
    const filename = path.join(dir, 'db.sqlite');
    const db = DatabaseConnection.initialize(filename); open.push(db);
    db.setWalAutocheckpoint(0);
    const raw = db.getDb();
    raw.exec('CREATE TABLE wal_fixture(id INTEGER PRIMARY KEY, payload BLOB); INSERT INTO wal_fixture VALUES(1,zeroblob(65536))');
    await db.checkpointWalTruncate();
    for (let i = 0; i < 12; i++) raw.exec('UPDATE wal_fixture SET payload=randomblob(65536) WHERE id=1');
    const { DatabaseSync } = require('node:sqlite');
    const reader = new DatabaseSync(filename); open.push(reader);
    reader.exec('BEGIN'); reader.prepare('SELECT length(payload) FROM wal_fixture').get();
    const full = await db.checkpointWalPassive();
    expect(full).not.toBeNull();
    expect(full!.log).toBe(full!.checkpointed);
    expect(full!.busy).toBe(0);
    const size = db.getWalSizeBytes();
    expect(size).toBeGreaterThan(0.25 * MB);
    const valve = new WalCheckpointValve(db, 0.125, 2000, undefined, 200);
    await expect(valve.backpressure()).rejects.toMatchObject({
      code: 'WAL_VALVE_ABORT', checkpoint: { mode: 'TRUNCATE', reason: 'busy' },
    });
    expect(db.getWalSizeBytes()).toBe(size);
    reader.exec('ROLLBACK');
    await valve.backpressure();
    expect(db.getWalSizeBytes()).toBe(0);
    expect(raw.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
  });

  it('folds committed writes after a checkpoint reuses a same-sized WAL allocation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-wal-reuse-')); dirs.push(dir);
    const db = DatabaseConnection.initialize(path.join(dir, 'db.sqlite')); open.push(db);
    db.setWalAutocheckpoint(0);
    const raw = db.getDb();
    raw.exec('CREATE TABLE wal_fixture (id INTEGER PRIMARY KEY,x); INSERT INTO wal_fixture VALUES(1,0)');
    for (let i = 0; i < 30; i++) raw.exec('UPDATE wal_fixture SET x=x+1');
    await db.checkpointWalPassive();
    const size = db.getWalSizeBytes();
    raw.exec('UPDATE wal_fixture SET x=x+1');
    expect(db.getWalSizeBytes()).toBe(size);
    const passive = vi.spyOn(db, 'checkpointWalPassive');
    await new WalCheckpointValve(db).foldNow();
    expect(passive).toHaveBeenCalledOnce();
    expect(db.getWalSizeBytes()).toBe(0);
    expect(raw.prepare('SELECT x FROM wal_fixture').get()).toEqual({ x: 31 });
  });
});
