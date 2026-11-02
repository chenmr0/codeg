/** Real built SDK/CLI entry points: fast durability is confined to private files. */
import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { CodeGraph as Graph } from '../src';
const { CodeGraph } = require('../dist') as typeof import('../src');
const { PortableCoordinator } = require('../dist/sync/portable/protocol') as typeof import('../src/sync/portable/protocol');
const { getCodeGraphDir } = require('../dist/directory') as typeof import('../src/directory');
const { DatabaseSync } = require('node:sqlite');
const roots: string[] = [];
const graphs: Graph[] = [];
const releases: Array<() => void> = [];
const timers: Array<ReturnType<typeof setTimeout>> = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const timer of timers.splice(0)) clearTimeout(timer);
  for (const release of releases.splice(0)) release();
  for (const graph of graphs.splice(0)) { await graph.whenIdle(); graph.close(); await graph.whenIdle(); }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fast-init-regression-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'main.c'), 'int initial_fast_symbol(void) { return 7; }\n');
  vi.stubEnv('CODEGRAPH_NO_DAEMON', '1');
  vi.stubEnv('CODEGRAPH_NO_FAST_INIT', '0');
  return root;
}
function observePragmas(inject?: (handle: any, sql: string) => void) {
  const events: Array<{ handle: any; sql: string }> = [];
  const exec = DatabaseSync.prototype.exec;
  vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function(this: any, sql: string) {
    inject?.(this, sql);
    const result = exec.call(this, sql);
    if (/^\s*PRAGMA\s+(journal_mode|synchronous)\s*=/i.test(sql)) events.push({ handle: this, sql });
    return result;
  });
  return events;
}
function isMemory(sql: string) { return /journal_mode\s*=\s*MEMORY/i.test(sql); }
function inspectPublished(root: string) {
  const db = new DatabaseSync(path.join(getCodeGraphDir(root), 'codegraph.db'), { readOnly: true });
  try {
    expect(db.prepare('PRAGMA quick_check').get().quick_check).toBe('ok');
    // Portable publication checkpoints and seals a candidate in DELETE mode.
    expect(['wal', 'delete']).toContain(db.prepare('PRAGMA journal_mode').get().journal_mode);
    expect(db.prepare("SELECT value FROM project_metadata WHERE key='index_completeness'").get().value).toBe('complete');
  } finally { db.close(); }
}
it('real SDK full init enters MEMORY/OFF and restores durability before publication', async () => {
  const root = fixture(), events = observePragmas();
  const graph = await CodeGraph.init(root, { index: true }); graphs.push(graph);
  const memory = events.find(event => isMemory(event.sql)); expect(memory).toBeDefined();
  const sameHandle = events.filter(event => event.handle === memory!.handle).map(event => event.sql);
  expect(sameHandle.some(sql => /synchronous\s*=\s*OFF/i.test(sql))).toBe(true);
  expect(sameHandle.some(sql => /synchronous\s*=\s*NORMAL/i.test(sql))).toBe(true);
  expect(sameHandle.slice(sameHandle.findIndex(isMemory) + 1).some(sql => /journal_mode\s*=\s*WAL/i.test(sql))).toBe(true);
  expect(graph.searchNodes('initial_fast_symbol').length).toBeGreaterThan(0);
  inspectPublished(root);
}, 30000);

it('keeps a real pinned active reader alive throughout private init and waits for release before replacement', async () => {
  const root = fixture();
  let reader: Graph | undefined;
  let pin: ReturnType<Graph['acquirePortableRead']> | undefined;
  let released = false, observedIndex = false, pinWasReadable = false;
  let transaction: any, readFailure: unknown;
  const finishRead = () => {
    try { if (transaction) { const db = transaction; transaction = undefined; db.exec('COMMIT'); } }
    finally { pin?.release(); released = true; }
  };
  const graph = await CodeGraph.init(root, {
    index: true,
    onProgress: () => {
      if (reader) return;
      reader = CodeGraph.openReadOnlySync(root); graphs.push(reader);
      pin = reader.acquirePortableRead(); releases.push(finishRead);
      const db = (pin.graph as any).db.getDb();
      db.exec('BEGIN'); transaction = db;
      // Materialize an actual SQLite snapshot, not merely a facade lease.
      expect(db.prepare('SELECT COUNT(*) AS n FROM nodes').get().n).toBe(0);
      expect(pin.graph.getStats().nodeCount).toBe(0);
      const coordinator = new PortableCoordinator(getCodeGraphDir(root));
      const deadline = performance.now() + 5000;
      const releaseDuringDrain = () => {
        try {
          if (coordinator.snapshot().mode !== 'draining') {
            if (performance.now() >= deadline) throw new Error('Publication did not reach reader drain');
            timers.push(setTimeout(releaseDuringDrain, 10));
            return;
          }
          pinWasReadable = transaction.prepare('SELECT COUNT(*) AS n FROM nodes').get().n === 0
            && pin!.graph.getStats().nodeCount === 0;
        } catch (error) { readFailure = error; }
        try { finishRead(); } catch (error) { readFailure = error; }
      };
      // Release independently of the result observer, only after publication
      // is demonstrably waiting on this live SQLite snapshot.
      timers.push(setTimeout(releaseDuringDrain, 10));
    },
    onIndexResult: result => {
      observedIndex = true;
      expect(result.success).toBe(true);
      expect(released).toBe(true);
      const published = CodeGraph.openReadOnlySync(root); graphs.push(published);
      expect(published.searchNodes('initial_fast_symbol').length).toBeGreaterThan(0);
    },
  }); graphs.push(graph);
  expect(observedIndex).toBe(true); expect(released).toBe(true); expect(readFailure).toBeUndefined();
  expect(pinWasReadable).toBe(true);
  expect(reader!.searchNodes('initial_fast_symbol').length).toBeGreaterThan(0);
  inspectPublished(root);
}, 30000);

it('does not notify a successful index result when publication fails', async () => {
  const root = fixture(), onIndexResult = vi.fn();
  vi.spyOn(PortableCoordinator.prototype, 'publishInitialCandidate').mockRejectedValue(new Error('injected publication failure'));
  await expect(CodeGraph.init(root, { index: true, onIndexResult })).rejects.toThrow('injected publication failure');
  expect(onIndexResult).not.toHaveBeenCalled();
  const reader = CodeGraph.openReadOnlySync(root); graphs.push(reader);
  expect(reader.searchNodes('initial_fast_symbol')).toEqual([]);
  const coordinator = new PortableCoordinator(getCodeGraphDir(root));
  const writer = coordinator.acquireWriter(); writer.release();
}, 30000);

it('never enables disposable durability on schema-only active storage, even with a pinned read snapshot', async () => {
  const root = fixture(), graph = CodeGraph.initSync(root); graphs.push(graph);
  const reader = CodeGraph.openReadOnlySync(root); graphs.push(reader);
  const pin = reader.acquirePortableRead(); releases.push(pin.release);
  const db = (pin.graph as any).db.getDb(); db.exec('BEGIN');
  try {
    expect(pin.graph.getStats().nodeCount).toBe(0);
    const events = observePragmas();
    expect((await graph.indexAll()).success).toBe(true);
    expect(events.some(event => isMemory(event.sql) || /synchronous\s*=\s*OFF/i.test(event.sql))).toBe(false);
    expect(pin.graph.getStats().nodeCount).toBe(0);
  } finally { db.exec('COMMIT'); }
  expect(pin.graph.searchNodes('initial_fast_symbol').length).toBeGreaterThan(0);
  pin.release(); inspectPublished(root);
}, 30000);

it.each(['synchronous', 'journal_mode'])('refuses successful publication if fast-init %s restoration fails', async setting => {
  const root = fixture(), fast = new Set<any>();
  observePragmas((handle, sql) => {
    if (isMemory(sql)) fast.add(handle);
    if (fast.has(handle) && (setting === 'synchronous' ? /synchronous\s*=\s*NORMAL/i.test(sql) : /journal_mode\s*=\s*WAL/i.test(sql))) throw new Error('injected durability restoration failure');
  });
  await expect(CodeGraph.init(root, { index: true })).rejects.toThrow(/durability|restor/i);
  expect(fast.size).toBeGreaterThan(0);
  vi.restoreAllMocks();
  const coordinator = new PortableCoordinator(getCodeGraphDir(root)); coordinator.recover();
  const reader = CodeGraph.openReadOnlySync(root); graphs.push(reader);
  expect(reader.searchNodes('initial_fast_symbol')).toEqual([]);
  const writer = coordinator.acquireWriter(); writer.release();
}, 30000);

it('restores durable WAL before safely falling back after a partial fast-init setup failure', async () => {
  const root = fixture(); let injected = false;
  const events = observePragmas((_handle, sql) => {
    if (!injected && /synchronous\s*=\s*OFF/i.test(sql)) {
      injected = true; throw new Error('injected OFF failure after MEMORY');
    }
  });
  const graph = await CodeGraph.init(root, { index: true }); graphs.push(graph);
  expect(injected).toBe(true);
  const memory = events.find(event => isMemory(event.sql)); expect(memory).toBeDefined();
  const tail = events.slice(events.indexOf(memory!) + 1).filter(event => event.handle === memory!.handle);
  expect(tail.some(event => /synchronous\s*=\s*NORMAL/i.test(event.sql))).toBe(true);
  expect(tail.some(event => /journal_mode\s*=\s*WAL/i.test(event.sql))).toBe(true);
  expect(graph.searchNodes('initial_fast_symbol').length).toBeGreaterThan(0); inspectPublished(root);
}, 30000);

it('honors the explicit fast-init opt-out without changing indexed output', async () => {
  const root = fixture(); vi.stubEnv('CODEGRAPH_NO_FAST_INIT', '1');
  const events = observePragmas();
  const graph = await CodeGraph.init(root, { index: true }); graphs.push(graph);
  expect(events.some(event => isMemory(event.sql) || /synchronous\s*=\s*OFF/i.test(event.sql))).toBe(false);
  expect(graph.searchNodes('initial_fast_symbol').length).toBeGreaterThan(0); inspectPublished(root);
}, 30000);

it('real CLI init succeeds with actual MEMORY transition, not silent WAL fallback', () => {
  const root = fixture();
  // Keep the preload outside the project so it is not indexed as test input.
  const trace = path.join(path.dirname(root), path.basename(root) + '-trace.cjs');
  fs.writeFileSync(trace, `const {DatabaseSync}=require('node:sqlite');const exec=DatabaseSync.prototype.exec;DatabaseSync.prototype.exec=function(sql){const r=exec.call(this,sql);if(/journal_mode\\s*=\\s*MEMORY/i.test(sql))process.stderr.write('FAST_INIT_MEMORY_OK\\n');return r;};`);
  try {
    const cli = path.resolve(__dirname, '../dist/bin/codegraph.js');
    const result = spawnSync(process.execPath, ['--liftoff-only', '--require', trace, cli, 'init', root], {
      cwd: root, encoding: 'utf8', input: '', timeout: 30000,
      env: { ...process.env, CI: '1', CODEGRAPH_NO_WATCH: '1', CODEGRAPH_NO_DAEMON: '1' },
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stderr).toContain('FAST_INIT_MEMORY_OK'); inspectPublished(root);
  } finally { fs.unlinkSync(trace); }
}, 40000);

it('falls back to durable DELETE mode when a private candidate cannot enable WAL', async () => {
  const root = fixture();
  const exec = DatabaseSync.prototype.exec;
  const substituted: string[] = [], unsafeAttempts: string[] = [];
  vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function(this: any, sql: string) {
    // SQLite can silently retain a different journal mode rather than throw.
    // Exercise that real state, not a fake getJournalMode() return value.
    const file = this.prepare('PRAGMA database_list').get()?.file as string | undefined;
    const candidate = file !== undefined && path.basename(file) === 'candidate.db';
    if (candidate && (isMemory(sql) || /synchronous\s*=\s*OFF/i.test(sql))) unsafeAttempts.push(sql);
    if (candidate && /^\s*PRAGMA\s+journal_mode\s*=\s*WAL\s*;?\s*$/i.test(sql)) {
      const result = exec.call(this, 'PRAGMA journal_mode = DELETE');
      substituted.push(this.prepare('PRAGMA journal_mode').get().journal_mode);
      return result;
    }
    return exec.call(this, sql);
  });
  const graph = await CodeGraph.init(root, { index: true }); graphs.push(graph);
  expect(substituted.length).toBeGreaterThan(0);
  expect(substituted.every(mode => mode === 'delete')).toBe(true);
  expect(unsafeAttempts).toEqual([]);
  expect(graph.getFiles().map(file => file.path)).toEqual(['main.c']);
  expect(graph.searchNodes('initial_fast_symbol').some(row => row.node.name === 'initial_fast_symbol')).toBe(true);
  inspectPublished(root);
}, 30000);
