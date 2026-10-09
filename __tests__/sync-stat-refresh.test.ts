import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import CodeGraph from '../src/index';
import type { QueryBuilder, UnchangedFileStatUpdate } from '../src/db/queries';
import * as rustScan from '../src/extraction/rust-scan';

const hooks = vi.hoisted(() => ({
  afterRead: null as ((filename: unknown) => void) | null,
}));
vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, readFileSync: (...args: any[]) => {
    const value = (actual.readFileSync as any)(...args);
    hooks.afterRead?.(args[0]);
    return value;
  } };
});

let root: string;
let cg: CodeGraph;
let q: QueryBuilder;
const filename = () => path.join(root, 'api.c');
const source = 'int target(void) { return 1; }\n';
const db = () => (cg as any).db.getDb();
const graph = () => ['nodes', 'edges', 'unresolved_refs'].map(table =>
  db().prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
const touch = (file = filename()) => {
  const stat = fs.statSync(file);
  fs.utimesSync(file, stat.atime, new Date(stat.mtimeMs + 5000));
};
const refresh = (): UnchangedFileStatUpdate => {
  const file = q.getFileByPath('api.c')!;
  const stat = fs.statSync(filename());
  return { path: file.path, contentHash: file.contentHash, previousSize: file.size,
    previousModifiedAt: file.modifiedAt, indexedAt: file.indexedAt,
    size: stat.size, modifiedAt: stat.mtimeMs };
};
beforeEach(async () => {
  hooks.afterRead = null;
  vi.stubEnv('CODEGRAPH_RUST_SCAN', '0');
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-stat-refresh-'));
  fs.writeFileSync(filename(), source);
  fs.writeFileSync(path.join(root, 'api.h'), 'int target(void);\n');
  fs.writeFileSync(path.join(root, 'caller.c'), '#include "api.h"\nint caller(void) { return target(); }\n');
  cg = CodeGraph.initSync(root);
  q = (cg as any).queries;
  expect((await cg.indexAll()).complete).toBe(true);
  await cg.sync();
});
afterEach(() => {
  hooks.afterRead = null;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  cg?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

it.each(['full', 'scoped', 'native'] as const)('refreshes stat-only changes once, including after reopen (%s)', async mode => {
  const old = q.getFileByPath('api.c')!;
  q.upsertFile({ ...old, errors: [{ severity: 'warning', code: 'test_warning', message: 'preserve me' }] });
  const before = q.getFileByPath('api.c')!;
  const beforeGraph = graph();
  const beforeMetadata = db().prepare('SELECT * FROM project_metadata ORDER BY key').all();
  touch();
  if (mode === 'native') {
    // Simulate the real native snapshot contract: integer mtime and no inode
    // or ctime. The refresh must obtain a fresh stat before reading content.
    fs.writeFileSync(path.join(root, '.codegraphignore'), '/*\n!/api.c\n!/api.h\n!/caller.c\n');
    vi.stubEnv('CODEGRAPH_RUST_SCAN', '1');
    vi.spyOn(rustScan, 'runRustScan').mockImplementation(() => {
      const paths = ['api.c', 'api.h', 'caller.c'];
      return { paths, stats: new Map(paths.map(p => {
        const stat = fs.statSync(path.join(root, p));
        return [p, { path: p, size: stat.size, mtimeMs: Math.floor(stat.mtimeMs) }];
      })), directories: 1, entries: 3, metadata: 3, kernelMs: 0 };
    });
  }
  let reads = 0;
  hooks.afterRead = file => { if (file === filename()) reads++; };
  const options = mode === 'scoped' ? { paths: ['api.c'] } : {};
  expect(await cg.sync(options)).toMatchObject({ filesModified: 0, filesAdded: 0, nodesUpdated: 0 });
  expect(reads).toBe(1);
  expect(q.getFileByPath('api.c')).toEqual({ ...before, size: fs.statSync(filename()).size,
    modifiedAt: fs.statSync(filename()).mtimeMs });
  expect(graph()).toEqual(beforeGraph);
  expect(db().prepare('SELECT * FROM project_metadata ORDER BY key').all()).toEqual(beforeMetadata);
  cg.close(); cg = CodeGraph.openSync(root); q = (cg as any).queries;
  expect(await cg.sync(options)).toMatchObject({ filesModified: 0, nodesUpdated: 0 });
  expect(reads).toBe(1);
  expect(graph()).toEqual(beforeGraph);
});

it.each(['edit', 'edit-restored-mtime', 'replace', 'delete'] as const)('does not acknowledge a concurrent %s after reading the old bytes', async mode => {
  touch();
  const before = q.getFileByPath('api.c')!;
  let fired = false;
  hooks.afterRead = file => {
    if (file !== filename() || fired) return;
    fired = true;
    if (mode === 'delete') fs.unlinkSync(filename());
    else if (mode === 'edit-restored-mtime') {
      const stat = fs.statSync(filename());
      // Let the filesystem's ctime advance before changing same-length bytes
      // and restoring mtime: size/mtime alone must not certify this read.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      fs.writeFileSync(filename(), source.replace('return 1', 'return 9'));
      fs.utimesSync(filename(), stat.atime, stat.mtime);
    } else if (mode === 'replace') {
      const stat = fs.statSync(filename());
      const replacement = path.join(root, 'replacement.tmp');
      fs.writeFileSync(replacement, source.replace('return 1', 'return 9'));
      fs.utimesSync(replacement, stat.atime, stat.mtime);
      fs.unlinkSync(filename()); fs.renameSync(replacement, filename());
    } else {
      fs.writeFileSync(filename(), source.replace('return 1', 'return 12345'));
      touch();
    }
  };
  expect(await cg.sync()).toMatchObject({ filesModified: 0, nodesUpdated: 0 });
  expect(fired).toBe(true);
  expect(q.getFileByPath('api.c')).toEqual(before);
  hooks.afterRead = null;
  if (mode === 'delete') expect((await cg.sync()).filesRemoved).toBe(1);
  else {
    expect((await cg.sync()).filesModified).toBe(1);
    expect(q.getFileByPath('api.c')!.contentHash).not.toBe(before.contentHash);
  }
});

it('batches hundreds of stat acknowledgements and avoids source reads on the next sync', async () => {
  const template = q.getFileByPath('api.c')!;
  for (let i = 0; i < 513; i++) {
    const file = `copy-${i}.c`, full = path.join(root, file);
    fs.writeFileSync(full, source);
    const stat = fs.statSync(full);
    q.upsertFile({ ...template, path: file, size: stat.size, modifiedAt: stat.mtimeMs - 5000, nodeCount: 0 });
  }
  const sizes: number[] = [];
  const original = q.refreshUnchangedFileStats.bind(q);
  vi.spyOn(q, 'refreshUnchangedFileStats').mockImplementation(files => {
    sizes.push(files.length); return original(files);
  });
  let reads = 0;
  hooks.afterRead = file => { if (typeof file === 'string' && file.startsWith(root) && file.endsWith('.c')) reads++; };
  expect((await cg.sync()).filesModified).toBe(0);
  expect(reads).toBe(513); expect(sizes).toEqual([500, 13]);
  expect((await cg.sync()).filesModified).toBe(0);
  expect(reads).toBe(513); expect(sizes).toEqual([500, 13]);
});

it.each(['deleted', 'hash', 'size', 'mtime', 'indexedAt'] as const)('does not overwrite a %s file record changed after the comparison', kind => {
  touch();
  const update = refresh();
  const old = q.getFileByPath('api.c')!;
  if (kind === 'deleted') q.deleteFile('api.c');
  else q.upsertFile({ ...old,
    ...(kind === 'hash' ? { contentHash: 'newer-hash' } : {}),
    ...(kind === 'size' ? { size: old.size + 1 } : {}),
    ...(kind === 'mtime' ? { modifiedAt: old.modifiedAt + 1 } : {}),
    ...(kind === 'indexedAt' ? { indexedAt: old.indexedAt + 1 } : {}),
  });
  const newer = q.getFileByPath('api.c');
  expect(q.refreshUnchangedFileStats([update])).toBe(0);
  expect(q.getFileByPath('api.c')).toEqual(newer);
});

it('preserves recovery journals and indexing metadata during the batched SQL update', () => {
  touch();
  const file = q.getFileByPath('api.c')!;
  q.upsertFile({ ...file, errors: [{ severity: 'warning', message: 'retry',
    code: 'declaration_macro_recovery_skipped' }] });
  q.setMetadata('sync-retry:pending:api.c', 'keep');
  const before = q.getFileByPath('api.c')!;
  const metadata = db().prepare('SELECT * FROM project_metadata ORDER BY key').all();
  expect(q.refreshUnchangedFileStats([refresh()])).toBe(1);
  expect(q.getFileByPath('api.c')).toEqual({ ...before, modifiedAt: fs.statSync(filename()).mtimeMs });
  expect(db().prepare('SELECT * FROM project_metadata ORDER BY key').all()).toEqual(metadata);
});

it('rolls back a batch if a database update fails', () => {
  touch();
  const update = refresh(), before = q.getFileByPath('api.c')!;
  db().exec(`CREATE TRIGGER reject_refresh BEFORE UPDATE ON files WHEN NEW.path='api.h'
    BEGIN SELECT RAISE(ABORT, 'injected refresh failure'); END;`);
  const header = q.getFileByPath('api.h')!;
  expect(() => q.refreshUnchangedFileStats([update, { ...update, path: header.path,
    contentHash: header.contentHash, previousSize: header.size, previousModifiedAt: header.modifiedAt,
    indexedAt: header.indexedAt }])).toThrow('injected refresh failure');
  expect(q.getFileByPath('api.c')).toEqual(before);
});
