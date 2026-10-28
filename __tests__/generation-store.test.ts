import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createGeneration, GenerationWriterLock, hasRebuildDiskSpace, publishGeneration,
  resolveGeneration, GenerationPublicationError, cleanupGenerationCandidate, collectRetiredGenerations, GenerationCandidate, collectRetiredGenerations,
} from '../src/sync/generation-store';
import { FileLock } from '../src/utils';
import { getDatabasePath } from '../src/db';
import { getCodeGraphDir, isInitialized, createDirectory } from '../src/directory';

describe('generation publication protocol', () => {
  let project: string;
  let root: string;
  let lock: GenerationWriterLock;
  let candidates: GenerationCandidate[];
  beforeEach(() => {
    candidates = [];
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-generations-'));
    root = path.join(project, '.codegraph-wx');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'codegraph.db'), 'legacy');
    lock = new GenerationWriterLock(root);
    lock.acquire();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const candidate of candidates) cleanupGenerationCandidate(root, candidate);
    await collectRetiredGenerations(root);
    try { lock.release(); } catch { /* test replaces lock deliberately */ }
    fs.rmSync(project, { recursive: true, force: true });
  });
  function candidate() {
    const result = createGeneration(root, lock);
    candidates.push(result);
    fs.writeFileSync(result.databasePath, 'candidate');
    return result;
  }
  function options() {
    return { lock, expectedPreviousId: null, success: true, complete: true,
      validate: () => true, sourceUnchanged: () => true };
  }
  it('resolves legacy layout without creating anything', () => {
    expect(resolveGeneration(root)).toEqual({ id: null, databasePath: path.join(root, 'codegraph.db') });
    expect(fs.readdirSync(root).sort()).toEqual(['codegraph.db', 'codegraph.lock']);
  });
  it('publishes only the pointer and keeps old files and open readers', async () => {
    const old = fs.openSync(path.join(root, 'codegraph.db'), 'r');
    try {
      const next = candidate();
      await publishGeneration(root, next, options());
      expect(resolveGeneration(root)).toEqual({ id: next.id, databasePath: next.databasePath });
      expect(fs.readFileSync(old, 'utf8')).toBe('legacy');
      expect(fs.readFileSync(path.join(root, 'codegraph.db'), 'utf8')).toBe('legacy');
      expect(getDatabasePath(project)).toBe(next.databasePath);
      expect(isInitialized(project)).toBe(true);
      expect(() => createDirectory(project)).toThrow(/already initialized/);
    } finally { fs.closeSync(old); }
  });
  it('can advance CURRENT a second time without deleting the previous generation', async () => {
    const a = candidate();
    await publishGeneration(root, a, options());
    const b = candidate();
    await publishGeneration(root, b, { ...options(), expectedPreviousId: a.id });
    expect(resolveGeneration(root).id).toBe(b.id);
    expect(fs.existsSync(a.databasePath)).toBe(true);
  });
  it.each(['success', 'complete'] as const)('rejects a false %s flag', async key => {
    await expect(publishGeneration(root, candidate(), { ...options(), [key]: false })).rejects.toThrow(/Incomplete/);
    expect(resolveGeneration(root).id).toBeNull();
  });
  it('rejects validation failure without switching', async () => {
    await expect(publishGeneration(root, candidate(), { ...options(), validate: () => false })).rejects.toThrow(/validation/);
    expect(resolveGeneration(root).id).toBeNull();
  });
  it('rejects source mutation at the final boundary', async () => {
    await expect(publishGeneration(root, candidate(), { ...options(), sourceUnchanged: () => false })).rejects.toMatchObject({ published: false });
    expect(resolveGeneration(root).id).toBeNull();
  });
  it('rejects a nonempty WAL rather than publishing a main-file-only snapshot', async () => {
    const next = candidate(); fs.writeFileSync(next.databasePath + '-wal', 'pending');
    await expect(publishGeneration(root, next, options())).rejects.toThrow(/WAL/);
    expect(resolveGeneration(root).id).toBeNull();
  });
  it('requires the actual root lock before creation and publication', async () => {
    const next = candidate(); lock.release();
    expect(() => createGeneration(root, lock)).toThrow(/ownership/);
    await expect(publishGeneration(root, next, options())).rejects.toThrow(/ownership/);
  });
  it('checks expected CURRENT rather than overwriting an intervening publication', async () => {
    const a = candidate(); await publishGeneration(root, a, options());
    await expect(publishGeneration(root, candidate(), options())).rejects.toThrow(/CURRENT generation changed/);
    expect(resolveGeneration(root).id).toBe(a.id);
  });
  it('fails closed for malformed CURRENT instead of using legacy data', () => {
    fs.writeFileSync(path.join(root, 'CURRENT'), '{}');
    expect(() => resolveGeneration(root)).toThrow(/manifest/);
    expect(() => getDatabasePath(project)).toThrow(/manifest/);
  });
  it('rejects a forged READY token', async () => {
    const next = candidate(); await publishGeneration(root, next, options());
    const ready = JSON.parse(fs.readFileSync(path.join(next.directory, 'READY.json'), 'utf8'));
    ready.token = '11111111-1111-1111-1111-111111111111';
    fs.writeFileSync(path.join(next.directory, 'READY.json'), JSON.stringify(ready));
    expect(() => resolveGeneration(root)).toThrow(/validated generation/);
  });
  it('does not fall back when a published database is missing', async () => {
    const next = candidate(); await publishGeneration(root, next, options());
    fs.unlinkSync(next.databasePath);
    expect(() => resolveGeneration(root)).toThrow();
  });
  it('rejects path traversal in CURRENT', () => {
    fs.writeFileSync(path.join(root, 'CURRENT'), JSON.stringify({ version: 1, generation: '../escape', complete: true, token: '11111111-1111-1111-1111-111111111111' }));
    expect(() => resolveGeneration(root)).toThrow(/manifest/);
  });
  it('recognizes a manifest-only preferred directory instead of falling back to legacy', async () => {
    const next = candidate(); await publishGeneration(root, next, options());
    fs.unlinkSync(path.join(root, 'codegraph.db'));
    const legacy = path.join(project, '.codegraph'); fs.mkdirSync(legacy);
    fs.writeFileSync(path.join(legacy, 'codegraph.db'), 'older');
    expect(getCodeGraphDir(project)).toBe(root);
    expect(isInitialized(project)).toBe(true);
  });
  it('refuses symlink CURRENT and does not fall back to a legacy index', () => {
    if (process.platform === 'win32') return;
    const legacy = path.join(project, '.codegraph'); fs.mkdirSync(legacy);
    fs.writeFileSync(path.join(legacy, 'codegraph.db'), 'older');
    fs.unlinkSync(path.join(root, 'codegraph.db'));
    fs.symlinkSync(path.join(project, 'missing'), path.join(root, 'CURRENT'));
    expect(getCodeGraphDir(project)).toBe(root);
    expect(() => resolveGeneration(root)).toThrow(/regular file/);
  });
  it('refuses a symlink candidate database', async () => {
    if (process.platform === 'win32') return;
    const next = candidate(); fs.unlinkSync(next.databasePath);
    fs.symlinkSync(path.join(root, 'codegraph.db'), next.databasePath);
    await expect(publishGeneration(root, next, options())).rejects.toThrow(/regular file/);
    expect(resolveGeneration(root).id).toBeNull();
  });
  it('refuses a symlink generations directory', () => {
    if (process.platform === 'win32') return;
    const outside = path.join(project, 'outside'); fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(root, 'generations'));
    expect(() => createGeneration(root, lock)).toThrow(/real directory/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });
  it('retains the old pointer on an atomic rename failure', async () => {
    const a = candidate(); await publishGeneration(root, a, options());
    const b = candidate();
    vi.spyOn(require('fs'), 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('injected busy filesystem'), { code: 'EBUSY' });
    });
    await expect(publishGeneration(root, b, { ...options(), expectedPreviousId: a.id })).rejects.toMatchObject({ published: false });
    expect(resolveGeneration(root).id).toBe(a.id);
    expect(fs.existsSync(a.databasePath)).toBe(true);
  });
  it('fails closed when disk fills before publication', async () => {
    const next = candidate();
    vi.spyOn(require('fs'), 'fsyncSync').mockImplementation(() => {
      throw Object.assign(new Error('injected no space'), { code: 'ENOSPC' });
    });
    await expect(publishGeneration(root, next, options())).rejects.toThrow(/no space/);
    expect(resolveGeneration(root).id).toBeNull();
  });
  it('never takes over an old live root lock', () => {
    fs.utimesSync(lock.lockPath, 0, 0);
    expect(() => new GenerationWriterLock(root).acquire()).toThrow(/locked/);
  });
  it('never automatically takes over even a dead root lock', () => {
    lock.release(); fs.writeFileSync(lock.lockPath, '99999999\nold-token\n');
    expect(() => new GenerationWriterLock(root).acquire()).toThrow(/locked/);
  });
  it('does not release a replacement lock owned by the same PID', () => {
    fs.writeFileSync(lock.lockPath, `${process.pid}\ndifferent-token\n`);
    lock.release();
    expect(fs.readFileSync(lock.lockPath, 'utf8')).toContain('different-token');
  });
  it('treats an unknown free-space result conservatively', () => {
    expect(hasRebuildDiskSpace('/does-not-exist', 100)).toBe(false);
    expect(hasRebuildDiskSpace(root, NaN)).toBe(false);
    expect(hasRebuildDiskSpace(root, -1)).toBe(false);
    expect(hasRebuildDiskSpace(root, Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(hasRebuildDiskSpace(root, 1)).toBe(true);
  });
  it('reports a post-rename fsync failure as published, never false rollback', async () => {
    if (process.platform === 'win32') return;
    const next = candidate();
    const fsync = fs.fsyncSync;
    const spy = vi.spyOn(require('fs'), 'fsyncSync').mockImplementation(fd => {
      if (fs.existsSync(path.join(root, 'CURRENT'))) throw new Error('injected flush failure');
      return fsync(fd);
    });
    let error: unknown;
    try { await publishGeneration(root, next, options()); } catch (caught) { error = caught; }
    spy.mockRestore();
    expect(error).toBeInstanceOf(GenerationPublicationError);
    expect(error).toMatchObject({ published: true });
    expect(resolveGeneration(root).id).toBe(next.id);
  });
});

describe('legacy FileLock safety', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lock-safety-')); });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
  it('does not expire a live lock after two minutes', () => {
    const file = path.join(root, 'lock');
    const lock = new FileLock(file); lock.acquire(); fs.utimesSync(file, 0, 0);
    expect(() => new FileLock(file).acquire()).toThrow(/locked/);
    lock.release();
  });
  it('does not delete malformed or unknown-owner locks', () => {
    const file = path.join(root, 'lock'); fs.writeFileSync(file, 'invalid');
    expect(() => new FileLock(file).acquire()).toThrow(/locked/);
    expect(fs.readFileSync(file, 'utf8')).toBe('invalid');
    fs.writeFileSync(file, '12345');
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }); });
    expect(() => new FileLock(file).acquire()).toThrow(/locked/);
    expect(fs.readFileSync(file, 'utf8')).toBe('12345');
  });
  it('does not automatically reclaim a dead PID in another namespace', () => {
    const file = path.join(root, 'lock'); fs.writeFileSync(file, '99999999');
    expect(() => new FileLock(file).acquire()).toThrow(/locked/);
    expect(fs.readFileSync(file, 'utf8')).toBe('99999999');
  });
  it('does not remove a same-PID replacement during release', () => {
    const file = path.join(root, 'lock'); const lock = new FileLock(file); lock.acquire();
    fs.writeFileSync(file, `${process.pid}\nnew-owner\n`); lock.release();
    expect(fs.existsSync(file)).toBe(true);
  });
});
