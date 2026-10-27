import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import type { DatabaseConnection } from '../src/db';
import { __emitWatchEventForTests } from '../src/sync/watcher';

const CAP_BYTES = 2 * 1024 * 1024;
let root: string | undefined;
let graph: CodeGraph | undefined;
let reader: { exec(sql: string): void; close(): void } | undefined;
let readerHeld = false;
let releaseTimer: ReturnType<typeof setTimeout> | undefined;

function releaseReader(): void {
  if (readerHeld) {
    reader!.exec('ROLLBACK');
    readerHeld = false;
  }
}

afterEach(async () => {
  if (releaseTimer) clearTimeout(releaseTimer);
  releaseTimer = undefined;
  releaseReader();
  graph?.unwatch();
  if (graph) {
    await vi.waitFor(() => expect(graph!.isIndexing()).toBe(false), { timeout: 5000, interval: 20 });
  }
  reader?.close(); reader = undefined;
  graph?.close(); graph = undefined;
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function source(updated: boolean): string {
  return Array.from({ length: 1600 }, (_, i) =>
    `int watched_${i}(int value) { return value + ${updated ? i + 100000 : i}; }`
  ).join('\n') + (updated
    ? '\nint watched_added(void) { return watched_0(7); }\n'
    : '\nint watched_removed(void) { return watched_0(1); }\n');
}

it('finishes automatic watch sync after a real reader releases an over-cap WAL', async () => {
  vi.stubEnv('CODEGRAPH_NO_WAL_DEFER', '0');
  vi.stubEnv('CODEGRAPH_WAL_VALVE_MB', '1');
  vi.stubEnv('CODEGRAPH_WAL_WAIT_MS', '10000');
  vi.stubEnv('CODEGRAPH_NO_WATCH', '0');
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-wal-watch-'));
  const filename = path.join(root, 'watched.c');
  fs.writeFileSync(filename, source(false));
  graph = CodeGraph.initSync(root);
  expect((await graph.indexAll()).success).toBe(true);
  const connection = (graph as unknown as { db: DatabaseConnection }).db;
  const db = connection.getDb();
  await connection.checkpointWalTruncate();
  const { DatabaseSync } = require('node:sqlite');
  const nativeReader = new DatabaseSync(connection.getPath(), { readOnly: true });
  reader = nativeReader;
  nativeReader.exec('BEGIN'); readerHeld = true;
  nativeReader.prepare('SELECT COUNT(*) FROM nodes').get();

  let capObservedAt = 0;
  let readerReleasedAt = 0;
  let largestWal = 0;
  let pendingAtCap: string[] = [];
  const walBytes = connection.getWalSizeBytes.bind(connection);
  // Observe the actual physical file size; do not fake writes or checkpoints.
  vi.spyOn(connection, 'getWalSizeBytes').mockImplementation(() => {
    const bytes = walBytes();
    largestWal = Math.max(largestWal, bytes);
    if (bytes > CAP_BYTES && capObservedAt === 0) {
      capObservedAt = Date.now();
      pendingAtCap = graph!.getPendingFiles().map(file => file.path);
      releaseTimer = setTimeout(() => {
        releaseReader();
        readerReleasedAt = Date.now();
      }, 500);
    }
    return bytes;
  });

  type Completion = { result?: { filesChanged: number }; error?: Error; completedAt: number };
  let finish!: (completion: Completion) => void;
  const completed = new Promise<Completion>(resolve => { finish = resolve; });
  const onSyncComplete = vi.fn((result: { filesChanged: number }) => finish({ result, completedAt: Date.now() }));
  const onSyncError = vi.fn((error: Error) => finish({ error, completedAt: Date.now() }));
  expect(graph.watch({ inertForTests: true, debounceMs: 100, onSyncComplete, onSyncError })).toBe(true);
  await graph.waitUntilWatcherReady();
  fs.writeFileSync(filename, source(true));
  expect(__emitWatchEventForTests(root, 'watched.c')).toBe(true);
  expect(graph.getPendingFiles().map(file => file.path)).toContain('watched.c');

  const completion = await completed;
  expect(completion.error).toBeUndefined();
  expect(onSyncError).not.toHaveBeenCalled();
  expect(onSyncComplete).toHaveBeenCalledOnce();
  expect(completion.result?.filesChanged).toBe(1);
  expect(largestWal).toBeGreaterThan(CAP_BYTES);
  expect(capObservedAt).toBeGreaterThan(0);
  expect(readerReleasedAt - capObservedAt).toBeGreaterThanOrEqual(450);
  expect(completion.completedAt).toBeGreaterThanOrEqual(readerReleasedAt);
  expect(pendingAtCap).toContain('watched.c');
  expect(graph.getPendingFiles()).toEqual([]);
  expect(graph.getNodesByName('watched_added')).toHaveLength(1);
  expect(graph.getNodesByName('watched_removed')).toHaveLength(0);
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
}, 15000);
