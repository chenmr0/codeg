import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../src/db';
import { WalCheckpointValve, WalValveAbortError, resolveWalValveMb } from '../src/db/wal-valve';

const MB = 1024 * 1024;
const complete = { busy: 0, log: 10, checkpointed: 10 };
function fake(bytes = 3 * MB) {
  const state = { bytes };
  const db = {
    getWalSizeBytes: vi.fn(() => state.bytes),
    checkpointWalPassive: vi.fn(async () => complete),
    checkpointWalTruncate: vi.fn(async () => { state.bytes = 0; return { busy: 0, log: 0, checkpointed: 0 }; }),
  };
  return { state, db, valve: new WalCheckpointValve(db as unknown as DatabaseConnection, 1) };
}

describe('logical checkpoint safety without a physical growth baseline', () => {
  it('keeps environment defaults and clamps sub-MB input instead of disabling the cap', () => {
    expect(resolveWalValveMb(undefined)).toBe(256);
    expect(resolveWalValveMb('0')).toBe(256);
    expect(resolveWalValveMb('10.9')).toBe(10);
    expect(resolveWalValveMb('0.2')).toBe(1);
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

  it('fails closed on unavailable checkpoint machinery above the absolute cap', async () => {
    const { db, valve } = fake();
    db.checkpointWalPassive.mockResolvedValue(null as never);
    await expect(valve.backpressure()).rejects.toBeInstanceOf(WalValveAbortError);
    await expect(valve.backpressure()).rejects.toBeInstanceOf(WalValveAbortError);
    expect(db.checkpointWalPassive).toHaveBeenCalledTimes(2);
  });

  it('fails closed when a fully backfilled file cannot be truncated; no busy spin', async () => {
    const { db, valve } = fake();
    db.checkpointWalTruncate.mockResolvedValue({ busy: 1, log: 10, checkpointed: 10 });
    await expect(valve.backpressure()).rejects.toMatchObject({ code: 'WAL_VALVE_ABORT' });
    expect(db.checkpointWalPassive).toHaveBeenCalledTimes(2);
    expect(db.checkpointWalTruncate).toHaveBeenCalledTimes(2);
  });

  it('does not truncate an incompletely backfilled snapshot', async () => {
    const { db, valve } = fake();
    db.checkpointWalPassive.mockResolvedValue({ busy: 0, log: 20, checkpointed: 10 });
    await expect(valve.backpressure()).rejects.toBeInstanceOf(WalValveAbortError);
    expect(db.checkpointWalTruncate).not.toHaveBeenCalled();
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
    const valve = new WalCheckpointValve(db, 0.125);
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
