import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DatabaseConnection as DatabaseConnectionType } from '../src/db';
const DatabaseConnection = require('../dist/db').DatabaseConnection as typeof DatabaseConnectionType;
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const state = { workers: [] as any[] };
class FakeWorker extends EventEmitter {
  end!: () => void;
  terminate = vi.fn(() => new Promise<number>(resolve => { this.end = () => resolve(0); }));
  constructor() { super(); state.workers.push(this); }
}
let root: string | undefined;
let db: DatabaseConnectionType | undefined;
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks();
  db?.close(); db = undefined;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  state.workers.length = 0;
});

it('requests timeout cancellation but never releases the writer before checkpoint worker exit', async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-checkpoint-lifecycle-'));
  db = DatabaseConnection.initialize(path.join(root, 'db.sqlite'));
  const originalLoad = Module._load;
  vi.spyOn(Module, '_load').mockImplementation(function (this: unknown, ...args: any[]) {
    if (args[0] === 'node:worker_threads') return { Worker: FakeWorker };
    return originalLoad.apply(this, args);
  });
  vi.useFakeTimers();
  let settled = false;
  const pending = db.checkpointWalTruncate().then(result => { settled = true; return result; });
  await vi.advanceTimersByTimeAsync(1);
  expect(state.workers).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(state.workers[0].terminate).toHaveBeenCalledOnce();
  expect(settled).toBe(false);
  state.workers[0].end();
  await expect(pending).resolves.toBeNull();
  expect(settled).toBe(true);
});
