import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type CodeGraphType from '../src/index';
import type { StoreWriter as StoreWriterType } from '../src/extraction/store-writer';

// Exercise the shipped worker, including its separate SQLite connection.
// Run npm run build before this integration suite.
const CodeGraph = require('../dist/index').default as typeof CodeGraphType;
const StoreWriter = require('../dist/extraction/store-writer').StoreWriter as typeof StoreWriterType;
let graph: CodeGraphType | undefined;
let directory: string | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  graph?.close(); graph = undefined;
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});
const callers = 2100;
async function fixture(count = callers) {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sync-store-worker-'));
  fs.writeFileSync(path.join(directory, 'provider.c'), 'int worker_target(void) { return 1; }\n');
  fs.writeFileSync(path.join(directory, 'caller.c'), Array.from({ length: count }, (_, i) =>
    `int caller_${i}(void) { return worker_target(); }`).join('\n'));
  graph = CodeGraph.initSync(directory);
  expect((await graph.indexAll()).success).toBe(true);
  return graph;
}
function write(source: string) { fs.writeFileSync(path.join(directory!, 'provider.c'), source); }
function raw() { return (graph as any).db.db; }
function calls() {
  const target = graph!.getNodesByName('worker_target').find(n => n.kind === 'function');
  return target ? graph!.getIncomingEdges(target.id).filter(e => e.kind === 'calls').length : 0;
}

describe('incremental store worker', () => {
  it('retains high-fan-in edge rows on a body edit through the real worker', async () => {
    const cg = await fixture();
    const before = raw().prepare("SELECT id,source,target FROM edges WHERE kind='calls' ORDER BY id").all();
    expect(before).toHaveLength(callers);
    const replace = vi.spyOn(StoreWriter.prototype, 'replace');
    write('int worker_target(void) { return 200; }\n');
    await cg.sync({ paths: ['provider.c'] });
    expect(replace).toHaveBeenCalledTimes(1);
    expect(raw().prepare("SELECT id,source,target FROM edges WHERE kind='calls' ORDER BY id").all()).toEqual(before);
  }, 60_000);

  it('preserves moved targets and retains capped failures until callers are reindexed', async () => {
    const cg = await fixture();
    expect(calls()).toBe(callers);
    const replace = vi.spyOn(StoreWriter.prototype, 'replace');
    const previous = cg.getNodesByName('worker_target')[0]!;
    cg.getNode(previous.id); // Populate the owning connection cache.
    write('\n\nint worker_target(void) { return 22; }\n');
    expect((await cg.sync({ paths: ['provider.c'] })).filesModified).toBe(1);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(calls()).toBe(callers);
    expect(cg.getNodesByName('worker_target')[0]!.startLine).toBe(3);
    const current = cg.getNodesByName('worker_target')[0]!;
    if (current.id !== previous.id) expect(cg.getNode(previous.id)).toBeNull();
    expect(cg.getNode(current.id)!.startLine).toBe(3);
    write('int renamed_target(void) { return 3; }\n');
    await cg.sync({ paths: ['provider.c'] });
    expect(replace).toHaveBeenCalledTimes(2);
    expect(calls()).toBe(0);
    expect(raw().prepare("SELECT count(*) AS n FROM unresolved_refs WHERE reference_name = 'worker_target' AND reference_kind = 'calls'").get().n).toBe(callers);
    write('int worker_target(void) { return 4; }\n');
    await cg.sync({ paths: ['provider.c'] });
    // Historical groups above the sync ceiling remain available for a later
    // caller reindex; changed-file references themselves are never capped.
    expect(calls()).toBe(0);
    expect(raw().prepare("SELECT count(*) AS n FROM unresolved_refs WHERE reference_name = 'worker_target' AND status = 'failed'").get().n).toBe(callers);
    fs.appendFileSync(path.join(directory!, 'caller.c'), '\n// reindex callers after rename\n');
    await cg.sync({ paths: ['caller.c'] });
    expect(calls()).toBe(callers);
    fs.unlinkSync(path.join(directory!, 'provider.c'));
    expect((await cg.sync({ paths: ['provider.c'] })).filesRemoved).toBe(1);
    expect(replace).toHaveBeenCalledWith({ filePath: 'provider.c', remove: true });
    expect(calls()).toBe(0);
    write('int worker_target(void) { return 5; }\n');
    await cg.sync({ paths: ['provider.c'] });
    expect(calls()).toBe(0);
    expect(raw().prepare("SELECT count(*) AS n FROM unresolved_refs WHERE reference_name = 'worker_target' AND status = 'failed'").get().n).toBe(callers);
    fs.appendFileSync(path.join(directory!, 'caller.c'), '\n// reindex callers after restore\n');
    await cg.sync({ paths: ['caller.c'] });
    expect(calls()).toBe(callers);
    expect(raw().prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  }, 60_000);

  it('rolls back a failed worker replacement and leaves the journal retryable', async () => {
    const cg = await fixture();
    const originalHash = cg.getFile('provider.c')!.contentHash;
    raw().exec("CREATE TRIGGER fail_worker_store BEFORE INSERT ON nodes WHEN NEW.name = 'worker_target' BEGIN SELECT RAISE(ABORT, 'injected store failure'); END");
    write('\nint worker_target(void) { return 2; }\n');
    await expect(cg.sync({ paths: ['provider.c'] })).rejects.toThrow('injected store failure');
    expect(cg.getFile('provider.c')!.contentHash).toBe(originalHash);
    expect(calls()).toBe(callers);
    expect(raw().prepare("SELECT count(*) AS n FROM project_metadata WHERE key LIKE 'sync-retry:pending:%'").get().n).toBeGreaterThan(0);
    raw().exec('DROP TRIGGER fail_worker_store');
    expect((await cg.sync({ paths: ['provider.c'] })).filesModified).toBe(1);
    expect(calls()).toBe(callers);
    expect(raw().prepare("SELECT count(*) AS n FROM project_metadata WHERE key LIKE 'sync-retry:pending:%'").get().n).toBe(0);
  }, 60_000);

  it('keeps a small update on the existing path', async () => {
    const cg = await fixture(1);
    const replace = vi.spyOn(StoreWriter.prototype, 'replace');
    write('int worker_target(void) { return 2; }\n');
    await cg.sync({ paths: ['provider.c'] });
    expect(replace).not.toHaveBeenCalled();
    expect(calls()).toBe(1);
  });

  it('serializes a second sync and keeps an edit arriving during the worker write', async () => {
    const cg = await fixture();
    const original = StoreWriter.prototype.replace;
    let started!: () => void;
    const workerStarted = new Promise<void>(resolve => { started = resolve; });
    let active = 0;
    let peak = 0;
    const replace = vi.spyOn(StoreWriter.prototype, 'replace').mockImplementation(async function (this: StoreWriterType, request) {
      peak = Math.max(peak, ++active);
      started();
      try { return await original.call(this, request); }
      finally { active--; }
    });
    write('\nint worker_target(void) { return 2; }\n');
    const first = cg.sync({ paths: ['provider.c'] });
    await workerStarted;
    write('\n\n\nint worker_target(void) { return 3; }\n');
    const second = cg.sync({ paths: ['provider.c'] });
    await Promise.all([first, second]);
    expect(replace).toHaveBeenCalledTimes(2);
    expect(peak).toBe(1);
    expect(cg.getNodesByName('worker_target')[0]!.startLine).toBe(4);
    expect(calls()).toBe(callers);
  }, 60_000);
});
