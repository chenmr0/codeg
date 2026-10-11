import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type CodeGraphType from '../src/index';
import type { DatabaseConnection } from '../src/db';

// Built artifact test: npm run build first; exercises the actual writer thread.
const CodeGraph = require('../dist/index').default as typeof CodeGraphType;
const { WalCheckpointValve } = require('../dist/db/wal-valve');
const { StoreWriter } = require('../dist/extraction/store-writer');
let root: string | undefined;
let graph: CodeGraphType | undefined;
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  graph?.close(); graph = undefined;
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

it('parks only after the real store-worker commit/ack for replacement and removal', async () => {
  vi.stubEnv('CODEGRAPH_NO_APPEND_DELTA', '1');
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-wal-real-worker-'));
  fs.writeFileSync(path.join(root, 'provider.c'), 'int target(void) { return 1; }\n');
  fs.writeFileSync(path.join(root, 'caller.c'), 'int target(void); int caller(void) { return target(); }\n');
  graph = CodeGraph.initSync(root);
  await graph.indexAll();
  const conn = (graph as unknown as { db: DatabaseConnection }).db;
  const db = conn.getDb();
  const queries = (graph as any).queries;
  // Force the routing decision only, retaining the real production writer,
  // transaction, acknowledgment, journal and checkpoint implementation.
  vi.spyOn(queries, 'hasManyIncomingEdges').mockReturnValue(true);
  let writing = false, replacements = 0, truncations = 0;
  const replace = StoreWriter.prototype.replace;
  vi.spyOn(StoreWriter.prototype, 'replace').mockImplementation(async function (this: any, ...args: any[]) {
    writing = true; replacements++;
    try { return await replace.apply(this, args); }
    finally { writing = false; }
  });
  const truncate = conn.checkpointWalTruncate.bind(conn);
  vi.spyOn(conn, 'checkpointWalTruncate').mockImplementation(async () => {
    expect(writing).toBe(false);
    // BEGIN IMMEDIATE proves the acknowledged worker has released its write
    // transaction, not merely that the main connection is outside one.
    db.exec('BEGIN IMMEDIATE'); db.exec('ROLLBACK'); truncations++;
    return truncate();
  });
  vi.spyOn(WalCheckpointValve.prototype, 'backpressure').mockImplementation(function (this: any) {
    expect(writing).toBe(false);
    return this.foldNow();
  });
  fs.writeFileSync(path.join(root, 'provider.c'), 'int target(void) { return 12345; }\n');
  await graph.sync({ paths: ['provider.c'] });
  fs.unlinkSync(path.join(root, 'provider.c'));
  await graph.sync({ paths: ['provider.c'] });
  expect(replacements).toBe(2);
  expect(truncations).toBeGreaterThanOrEqual(2);
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  expect(db.prepare("SELECT COUNT(*) AS n FROM unresolved_refs WHERE status='pending'").get()).toEqual({ n: 0 });
}, 30000);
