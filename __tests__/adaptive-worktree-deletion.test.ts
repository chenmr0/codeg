/** Built-runtime regression: the default fixed-path facade plans in a worker. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import type { PathLike } from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { CodeGraph as Graph } from '../src';
import type { DatabaseConnection } from '../src/db';
import type { FixedPathFacade } from '../src/sync/fixed-path/facade';
const fs = require('node:fs') as typeof import('node:fs');
const fsp = require('node:fs/promises') as typeof import('node:fs/promises');
const { CodeGraph } = require('../dist') as typeof import('../src');
const { createAdaptivePlan, validateAdaptiveSnapshot } = require('../dist/sync/adaptive-plan') as typeof import('../src/sync/adaptive-plan');
const extraction = require('../dist/extraction') as typeof import('../src/extraction');

let root: string;
let graph: Graph;
let originalArgv: string[];
const target = 'include_test.c';
const source = 'int removed_symbol(void) { return 1; }\n';
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const plan = () => createAdaptivePlan(root, graph.getFiles(), { runtimeKey: 'test', fullHash: true });
function readDb<T>(read: (db: ReturnType<DatabaseConnection['getDb']>) => T): T {
  const pin = (graph as Graph & FixedPathFacade).acquireFixedPathRead();
  try { return read((pin.graph as unknown as { db: DatabaseConnection }).db.getDb()); }
  finally { pin.release(); }
}
function snapshot() {
  return readDb(db => ['files', 'nodes', 'edges', 'unresolved_refs'].map(table =>
    db.prepare(`SELECT * FROM ${table}`).all().map(row => JSON.stringify(row)).sort()));
}
function calls(name: string): number {
  return readDb(db => (db.prepare(`SELECT count(*) AS n FROM edges e
    JOIN nodes s ON s.id=e.source JOIN nodes t ON t.id=e.target
    WHERE e.kind='calls' AND s.name='caller_symbol' AND t.name=?`).get(name) as { n: number }).n);
}
function assertDeleted() {
  expect(graph.getFiles().map(f => f.path).sort()).toEqual(['caller.c', 'keep.c']);
  expect(graph.getNodesInFile(target)).toEqual([]);
  expect(graph.getNodesByName('removed_symbol')).toEqual([]);
  expect(graph.getNodesByName('caller_symbol')).toHaveLength(1);
  expect(calls('kept_symbol')).toBe(1);
  readDb(db => {
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare(`SELECT e.* FROM edges e LEFT JOIN nodes s ON s.id=e.source
      LEFT JOIN nodes t ON t.id=e.target WHERE s.id IS NULL OR t.id IS NULL`).all()).toEqual([]);
  });
}
beforeEach(async () => {
  originalArgv = process.execArgv;
  process.execArgv = ['--liftoff-only'];
  vi.stubEnv('NODE_OPTIONS', '');
  // Exercise the actual default layout, never opt into legacy generation fixtures.
  vi.stubEnv('CODEGRAPH_FIXED_PATH', undefined);
  vi.stubEnv('CODEGRAPH_ADAPTIVE_SYNC', undefined);
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-worktree-delete-'));
  git('init', '-q');
  fs.writeFileSync(path.join(root, target), source);
  fs.writeFileSync(path.join(root, 'keep.c'), 'int kept_symbol(void) { return 2; }\n');
  fs.writeFileSync(path.join(root, 'caller.c'), '#include "include_test.c"\n#include "keep.c"\nint caller_symbol(void) { return removed_symbol() + kept_symbol(); }\n');
  git('add', '.');
  git('-c', 'user.name=Regression', '-c', 'user.email=regression@example.invalid', 'commit', '-qm', 'fixture');
  graph = await CodeGraph.init(root, { index: true });
  expect(graph.getBackend()).toBe('node-sqlite');
  expect(fs.existsSync(path.join(graph.getDataDirectory(), '.runtime', 'layout.json'))).toBe(true);
  expect(graph.getFiles()).toHaveLength(3);
  expect(calls('removed_symbol')).toBe(1);
  expect(calls('kept_symbol')).toBe(1);
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (root) {
    const directory = path.join(root, 'locked');
    if (fs.existsSync(directory)) fs.chmodSync(directory, 0o700);
    const file = path.join(root, target);
    if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
  }
  if (graph) { await graph.whenIdle(); graph.close(); await graph.whenIdle(); }
  vi.unstubAllEnvs();
  process.execArgv = originalArgv;
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('Git worktree deletion planning and default-layout sync', () => {
  it.each([
    ['unstaged', 'incremental'], ['staged', 'incremental'],
    ['unstaged', 'rebuild'], ['staged', 'rebuild'],
  ])('%s deletion preserves graph semantics via %s', async (staging, strategy) => {
    const original = snapshot();
    fs.unlinkSync(path.join(root, target));
    if (staging === 'staged') git('add', '-u');
    expect(git('status', '--porcelain')).toContain(staging === 'staged' ? 'D  include_test.c' : ' D include_test.c');
    const result = await plan();
    expect(result.removed).toEqual([target]);
    expect(result.added).toEqual([]);
    expect(result.modified).toEqual([]);
    expect(result.snapshot.files.map(f => f.path)).toEqual(['caller.c', 'keep.c']);
    expect(snapshot()).toEqual(original); // Planning is read-only.
    expect(await validateAdaptiveSnapshot(root, result.snapshot)).toBe(true);
    const decisions: string[] = [];
    const synced = await graph.sync({
      onAdaptiveDecision: decision => decisions.push(decision.strategy),
      ...(strategy === 'rebuild' ? { adaptiveFallback: {
        minChangedFiles: 1, minChangedFraction: 0.1, minWorkFraction: 0.1,
        minAffectedOldNodes: 1, minAffectedOldNodeFraction: 0.1,
      } } : {}),
    });
    expect(decisions).toContain(strategy);
    expect(synced.complete).toBe(true);
    expect(synced.filesRemoved).toBe(1);
    assertDeleted();
    await graph.whenIdle(); graph.close(); await graph.whenIdle(); graph = CodeGraph.openSync(root);
    assertDeleted(); // Durable file/node/edge state, not just the writer's cache.
    fs.writeFileSync(path.join(root, target), source.replace('return 1', 'return 333'));
    expect(await validateAdaptiveSnapshot(root, result.snapshot)).toBe(false);
    expect((await graph.sync()).complete).toBe(true);
    expect(graph.getFiles()).toHaveLength(3);
    expect(graph.getNodesByName('removed_symbol')).toHaveLength(1);
    expect(calls('removed_symbol')).toBe(1);
    expect(calls('kept_symbol')).toBe(1);
  }, 30_000);

  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)('propagates real read EACCES and leaves the database intact', async () => {
    const original = snapshot();
    fs.appendFileSync(path.join(root, target), '// force a content read\n');
    fs.chmodSync(path.join(root, target), 0);
    await expect(plan()).rejects.toMatchObject({ code: 'EACCES' });
    await expect(graph.sync()).rejects.toThrow(/EACCES/);
    expect(snapshot()).toEqual(original);
    const deniedRead = await graph.indexAll();
    expect(deniedRead.complete).toBe(false);
    expect(deniedRead.errors).toEqual(expect.arrayContaining([expect.objectContaining({
      filePath: target, code: 'read_error', message: expect.stringContaining('EACCES'),
    })]));
    expect(graph.getNodesByName('removed_symbol')).toHaveLength(1);
    fs.chmodSync(path.join(root, target), 0o600);
    expect((await graph.indexAll()).complete).toBe(true);
  }, 30_000);

  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)('propagates real directory EACCES without removing inaccessible graph rows', async () => {
    fs.mkdirSync(path.join(root, 'locked'));
    fs.renameSync(path.join(root, target), path.join(root, 'locked', target));
    git('add', '-A');
    expect((await graph.sync()).complete).toBe(true);
    const locked = snapshot();
    fs.chmodSync(path.join(root, 'locked'), 0);
    await expect(plan()).rejects.toMatchObject({ code: 'EACCES' });
    await expect(graph.sync()).rejects.toThrow(/EACCES/);
    expect(snapshot()).toEqual(locked);
    const indexed = await graph.indexAll();
    expect(indexed.complete).toBe(false);
    expect(indexed.errors).toEqual(expect.arrayContaining([expect.objectContaining({
      filePath: `locked/${target}`, code: 'read_error',
    })]));
    expect(graph.getNodesByName('removed_symbol')).toHaveLength(1);
  }, 30_000);

  it('propagates other initial I/O failures instead of treating them as deletion', async () => {
    const original = snapshot();
    vi.spyOn(extraction, 'scanDirectoryAsync').mockResolvedValue([target]);
    const lstat = fs.lstatSync;
    const error = Object.assign(new Error('injected disk I/O failure'), { code: 'EIO' });
    vi.spyOn(fs, 'lstatSync').mockImplementation(((file: PathLike, ...args: unknown[]) => {
      if (String(file) === path.join(root, target)) throw error;
      return (lstat as Function)(file, ...args);
    }) as typeof fs.lstatSync);
    await expect(plan()).rejects.toBe(error);
    expect(snapshot()).toEqual(original);
  });

  it.each(['realpathSync', 'readFileSync', 'statSync'] as const)('rejects disappearance at %s after observing existence', async method => {
    const original = snapshot();
    // A deterministic scan boundary; actual filesystem deletion supplies ENOENT.
    vi.spyOn(extraction, 'scanDirectoryAsync').mockResolvedValue([target, 'keep.c', 'caller.c']);
    const operation = fs[method];
    let fired = false;
    vi.spyOn(fs, method).mockImplementation((...args: unknown[]) => {
      const file = args[0];
      if (!fired && String(file) === path.join(root, target)) {
        fired = true; fs.unlinkSync(path.join(root, target));
      }
      return Reflect.apply(operation, fs, args);
    });
    await expect(plan()).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fired).toBe(true);
    expect(snapshot()).toEqual(original);
    vi.restoreAllMocks();
    fs.writeFileSync(path.join(root, target), source);
    expect((await graph.sync()).complete).toBe(true);
    expect(calls('removed_symbol')).toBe(1);
  });

  it('keeps full-index read races incomplete and retains existing target nodes', async () => {
    const oldNodes = graph.getNodesInFile(target);
    const stat = fsp.stat, readFile = fsp.readFile;
    let observed = false, deleted = false;
    vi.spyOn(fsp, 'stat').mockImplementation((async (file: PathLike, ...args: unknown[]) => {
      const value = await (stat as Function)(file, ...args);
      if (String(file) === path.join(root, target)) observed = true;
      return value;
    }) as typeof fsp.stat);
    vi.spyOn(fsp, 'readFile').mockImplementation((async (file: PathLike, ...args: unknown[]) => {
      if (observed && !deleted && String(file) === path.join(root, target)) {
        deleted = true; fs.unlinkSync(path.join(root, target));
      }
      return (readFile as Function)(file, ...args);
    }) as typeof fsp.readFile);
    const indexed = await graph.indexAll();
    expect(deleted).toBe(true);
    expect(indexed.complete).toBe(false);
    expect(indexed.errors).toEqual(expect.arrayContaining([expect.objectContaining({
      filePath: target, code: 'read_error', message: expect.stringContaining('ENOENT'),
    })]));
    expect(graph.getNodesInFile(target)).toEqual(oldNodes);
    expect(graph.getFiles().map(f => f.path)).toContain(target);
    expect(calls('removed_symbol')).toBe(1);
  });

  it('does not skip other initial full-index stat errors', async () => {
    const oldNodes = graph.getNodesInFile(target);
    const stat = fsp.stat;
    vi.spyOn(fsp, 'stat').mockImplementation((async (file: PathLike, ...args: unknown[]) => {
      if (String(file) === path.join(root, target)) {
        throw Object.assign(new Error('injected EIO'), { code: 'EIO' });
      }
      return (stat as Function)(file, ...args);
    }) as typeof fsp.stat);
    const indexed = await graph.indexAll();
    expect(indexed.complete).toBe(false);
    expect(indexed.errors).toEqual(expect.arrayContaining([expect.objectContaining({
      filePath: target, code: 'read_error', message: expect.stringContaining('EIO'),
    })]));
    expect(graph.getNodesInFile(target)).toEqual(oldNodes);
    expect(calls('removed_symbol')).toBe(1);
  });

  it('rejects full-index candidates recreated before completion', async () => {
    const oldNodes = graph.getNodesInFile(target);
    fs.unlinkSync(path.join(root, target));
    let recreated = false;
    await expect(graph.indexAll({ onProgress(progress) {
      if (progress.phase === 'parsing' && progress.currentFile === 'keep.c') {
        recreated = true; fs.writeFileSync(path.join(root, target), source);
      }
    } })).rejects.toThrow(`Source changed during indexing: ${target}`);
    expect(recreated).toBe(true);
    expect(graph.getNodesInFile(target)).toEqual(oldNodes);
    expect(calls('removed_symbol')).toBe(1);
  });

  it.each([true, false])('rejects deletion/recreation during planning (previously indexed=%s)', async indexed => {
    const original = snapshot();
    const vanished = indexed ? target : 'a_new.c';
    if (indexed) fs.unlinkSync(path.join(root, vanished));
    vi.spyOn(extraction, 'scanDirectoryAsync').mockResolvedValue([vanished, 'keep.c', 'caller.c']);
    const lstat = fs.lstatSync;
    vi.spyOn(fs, 'lstatSync').mockImplementation(((file: PathLike, ...args: unknown[]) => {
      if (String(file) === path.join(root, 'keep.c')) fs.writeFileSync(path.join(root, vanished), source);
      return (lstat as Function)(file, ...args);
    }) as typeof fs.lstatSync);
    await expect(plan()).rejects.toThrow(`Source changed during adaptive planning: ${vanished}`);
    expect(snapshot()).toEqual(original);
  });
});
