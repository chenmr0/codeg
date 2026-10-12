import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { FileHandle } from 'fs/promises';
import { SyncRunLog, SYNC_RUN_LOG_MAX_BYTES, SYNC_RUN_LOG_WARNING } from '../src/sync/run-log';
import { SyncDiagnosticsSummary } from '../src/sync/diagnostics-summary';

const summary = (outcome = 'running', count = 1): string[] => [
  `[sync-summary] schema=1 outcome=${outcome} wallMs=12 phase=preflight phaseElapsedMs=5`,
  '[sync-summary] stages preflightMs=4',
  '[sync-summary] extraction reconcileMs=3',
  `[sync-summary] store filesCount=${count}`,
  '[sync-summary] worker requestCount=2',
  '[sync-summary] wal preflightDrainMs=2 drainCalls=1',
  '[sync-summary] refs changedRefsPlanReadMs=1 failedRetryDetailMatchMs=1',
  '[sync-summary] units=millisecondsExceptCounts relation=inclusiveNestedNotAdditive',
];
const completeName = (time: number, digit = 'a'): string => `codegraph-sync-v1-${time}-${digit.repeat(32)}.log`;
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
async function until(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 2_000;
  do {
    if (condition()) return;
    await tick();
  } while (performance.now() < deadline);
  throw new Error('Condition did not settle');
}

describe('anonymous sync run logs', () => {
  let root: string;
  let dbPath: string;
  let logs: string;
  const writers: SyncRunLog[] = [];
  const make = (snapshot: () => readonly string[] = () => summary(), warning?: () => void): SyncRunLog => {
    const writer = new SyncRunLog(dbPath, { snapshot, warning });
    writers.push(writer);
    return writer;
  };
  const files = (): string[] => fs.existsSync(logs) ? fs.readdirSync(logs) : [];
  const completed = (): string[] => files().filter(name => name.endsWith('.log'));
  const readCompleted = (): string => completed().map(name => fs.readFileSync(path.join(logs, name), 'utf8')).join('');

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-run-log-'));
    const actualDbDir = path.join(root, 'actual-db');
    fs.mkdirSync(actualDbDir);
    dbPath = path.join(actualDbDir, 'index.db');
    logs = path.join(actualDbDir, 'logs');
  });
  afterEach(async () => {
    vi.useRealTimers();
    for (const writer of writers.splice(0)) await writer.finish();
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('accepts additive schema-1 yield observations while keeping eight-line summaries', async () => {
    const diagnostics = new SyncDiagnosticsSummary();
    for (const duration of [0.2, 2, 20, 200, 300]) diagnostics.recordReferenceYield('changedRefs', duration);
    diagnostics.recordReferenceYield('failedRetry', 12);
    const warning = vi.fn();
    const writer = make(() => diagnostics.lines('success'), warning);
    writer.event('start');
    await writer.finish();
    expect(warning).not.toHaveBeenCalled();
    expect(readCompleted()).toContain('changedRefsYieldCount=5');
    expect(readCompleted()).toContain('changedRefsYieldMaxMs=300');
    expect(readCompleted()).toContain('failedRetryYieldGt10Le50Count=1');
  });

  it('writes start/stage/end by the actual DB and finishes once without identifying text', async () => {
    let outcome = 'running';
    const warning = vi.fn();
    const writer = make(() => summary(outcome), warning);
    writer.event('start');
    writer.event('stage');
    outcome = 'success';
    const finished = writer.finish();
    expect(writer.finish()).toBe(finished);
    await finished;
    writer.event('heartbeat');
    expect(files()).toHaveLength(1);
    expect(completed()[0]).toMatch(/^codegraph-sync-v1-\d{13}-[a-f0-9]{32}\.log$/);
    const content = readCompleted();
    expect(content.match(/\[sync-log\]/g)).toHaveLength(3);
    expect(content).toContain('event=start');
    expect(content).toContain('event=stage');
    expect(content).toContain('event=end droppedSnapshots=0');
    expect(content).toContain('outcome=success');
    expect(content).not.toContain(root);
    expect(fs.existsSync(path.join(root, 'logs'))).toBe(false);
    expect(warning).not.toHaveBeenCalled();
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(logs, completed()[0]!)).mode & 0o777).toBe(0o600);
    }
  });

  it('keeps the most recent ten completed files and leaves active/unrelated files and directories alone', async () => {
    fs.mkdirSync(logs);
    for (let i = 0; i < 13; i++) fs.writeFileSync(path.join(logs, completeName(1000000000000 + i)), `[sync-log] schema=1 event=start droppedSnapshots=0\n${i}`);
    const unrelated = ['notes.txt', 'codegraph-sync-v1-user.log', 'codegraph-sync-v1-1000000000000-a.active', completeName(1000000000000, 'd')];
    for (const name of unrelated) fs.writeFileSync(path.join(logs, name), 'keep');
    const directoryName = completeName(1000000000000, 'c');
    fs.mkdirSync(path.join(logs, directoryName));
    await make().finish();
    const regular = completed().filter(name => /^codegraph-sync-v1-\d{13}-[a-f0-9]{32}\.log$/.test(name) && fs.lstatSync(path.join(logs, name)).isFile() && !unrelated.includes(name));
    expect(regular).toHaveLength(10);
    for (let i = 0; i < 4; i++) expect(fs.existsSync(path.join(logs, completeName(1000000000000 + i)))).toBe(false);
    for (let i = 4; i < 13; i++) expect(fs.existsSync(path.join(logs, completeName(1000000000000 + i)))).toBe(true);
    for (const name of unrelated) expect(fs.readFileSync(path.join(logs, name), 'utf8')).toBe('keep');
    expect(fs.statSync(path.join(logs, directoryName)).isDirectory()).toBe(true);
  });

  it('preserves a real file symlink during rotation when link permission is available', async context => {
    fs.mkdirSync(logs);
    const outside = path.join(root, 'outside');
    fs.writeFileSync(outside, 'untouched');
    const linkPath = path.join(logs, completeName(1000000000000, 'b'));
    try { fs.symlinkSync(outside, linkPath, 'file'); }
    catch (error) {
      // Windows can deny file symlinks without Developer Mode/admin rights.
      // Only this real-link case is skipped; rotation and injected-link guards
      // below still run. Unexpected filesystem failures remain failures.
      if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        console.warn('[test] File-symlink permission unavailable; skipping only the real-file-link case.');
        context.skip(); return;
      }
      throw error;
    }
    for (let i = 0; i < 13; i++) fs.writeFileSync(path.join(logs, completeName(1000000000000 + i)), '[sync-log] schema=1 event=start droppedSnapshots=0\n');
    await make().finish();
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(outside, 'utf8')).toBe('untouched');
    expect(completed().filter(name => fs.lstatSync(path.join(logs, name)).isFile())).toHaveLength(10);
  });

  it('rejects a rotation candidate reported as a symlink after directory enumeration', async () => {
    fs.mkdirSync(logs);
    const candidate = path.join(logs, completeName(1000000000000, 'b'));
    const content = '[sync-log] schema=1 event=start droppedSnapshots=0\nkeep';
    fs.writeFileSync(candidate, content);
    for (let i = 0; i < 13; i++) fs.writeFileSync(path.join(logs, completeName(1000000000000 + i)), '[sync-log] schema=1 event=start droppedSnapshots=0\n');
    const realLstat = fs.promises.lstat.bind(fs.promises);
    const checked = vi.fn();
    vi.spyOn(fs.promises, 'lstat').mockImplementation((async (filename: fs.PathLike) => {
      const stat = await realLstat(filename);
      if (String(filename) === candidate) {
        checked();
        stat.isFile = () => false;
        stat.isSymbolicLink = () => true;
      }
      return stat;
    }) as typeof fs.promises.lstat);
    const open = vi.spyOn(fs.promises, 'open');
    const warning = vi.fn();
    await make(() => summary(), warning).finish();
    expect(checked).toHaveBeenCalled();
    expect(open.mock.calls.some(([filename]) => String(filename) === candidate)).toBe(false);
    expect(fs.readFileSync(candidate, 'utf8')).toBe(content);
    expect(warning).not.toHaveBeenCalled();
  });

  it.each(['symlink', 'file'])('rejects a logs %s without failing the sync or changing its target', async kind => {
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    if (kind === 'symlink') fs.symlinkSync(outside, logs, process.platform === 'win32' ? 'junction' : 'dir');
    else fs.writeFileSync(logs, 'keep');
    const warning = vi.fn();
    const writer = make(() => summary(), warning);
    writer.event('start');
    await expect(writer.finish()).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(outside)).toEqual([]);
    if (kind === 'file') expect(fs.readFileSync(logs, 'utf8')).toBe('keep');
  });

  it('uses exclusive no-follow creation and refuses an existing active pathname', async () => {
    const realOpen = fs.promises.open.bind(fs.promises);
    const warning = vi.fn();
    let attemptedPath = '';
    vi.spyOn(fs.promises, 'open').mockImplementation(async (filename, flags, mode) => {
      attemptedPath = String(filename);
      expect(Number(flags) & fs.constants.O_EXCL).not.toBe(0);
      expect(Number(flags) & fs.constants.O_CREAT).not.toBe(0);
      if (fs.constants.O_NOFOLLOW) expect(Number(flags) & fs.constants.O_NOFOLLOW).not.toBe(0);
      fs.writeFileSync(attemptedPath, 'do not overwrite');
      return realOpen(filename, flags, mode);
    });
    await make(() => summary(), warning).finish();
    expect(fs.readFileSync(attemptedPath, 'utf8')).toBe('do not overwrite');
    expect(warning).toHaveBeenCalledTimes(1);
    expect(completed()).toEqual([]);
  });

  it('does not overwrite an existing completed destination', async () => {
    const realLink = fs.promises.link.bind(fs.promises);
    const warning = vi.fn();
    let target = '';
    vi.spyOn(fs.promises, 'link').mockImplementation(async (source, destination) => {
      target = String(destination);
      fs.writeFileSync(target, 'existing user file');
      return realLink(source, destination);
    });
    await make(() => summary(), warning).finish();
    expect(fs.readFileSync(target, 'utf8')).toBe('existing user file');
    expect(files().filter(name => name.endsWith('.active'))).toHaveLength(1);
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['raw path', '[sync-summary] store file=/private/source.ts'],
    ['identifier key', '[sync-summary] store SecretClass=12'],
    ['unknown group', '[sync-summary] private filesCount=1'],
    ['raw error', '[sync-summary] store filesCount=1\nsecret exception'],
    ['non-finite number', '[sync-summary] store filesCount=NaN'],
    ['unsafe integer', '[sync-summary] store filesCount=9007199254740992'],
    ['duplicate key', '[sync-summary] store filesCount=1 filesCount=2'],
  ])('rejects %s at the serialization boundary', async (_label, replacement) => {
    const warning = vi.fn();
    const writer = make(() => {
      const lines = summary();
      lines[3] = replacement;
      return lines;
    }, warning);
    writer.event('start');
    await writer.finish();
    expect(files()).toEqual([]);
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it('contains collector and warning exceptions, without forwarding their messages', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => { throw new Error('warning failed'); });
    const writer = make(() => { throw new Error('private/path.js secret source text'); });
    expect(() => writer.event('start')).not.toThrow();
    await expect(writer.finish()).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(SYNC_RUN_LOG_WARNING);
    expect(files()).toEqual([]);
  });

  it('writes one fixed warning and disables on append failure', async () => {
    const realOpen = fs.promises.open.bind(fs.promises);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let handle: FileHandle | undefined;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      handle = await realOpen(...args);
      vi.spyOn(handle, 'writeFile').mockRejectedValue(new Error('ENOSPC: /private/db secret'));
      return handle;
    });
    const writer = make();
    writer.event('start');
    writer.event('stage');
    await expect(writer.finish()).resolves.toBeUndefined();
    await until(() => handle?.fd === -1);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(SYNC_RUN_LOG_WARNING);
    expect(completed()).toEqual([]);
  });

  it('bounds queued snapshots and serializes single-writer batches under delayed writes', async () => {
    const realOpen = fs.promises.open.bind(fs.promises);
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let writes = 0;
    let concurrent = 0;
    let maxConcurrent = 0;
    const batchBytes: number[] = [];
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      const write = handle.writeFile.bind(handle);
      vi.spyOn(handle, 'writeFile').mockImplementation(async (...writeArgs) => {
        writes++;
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        batchBytes.push(Buffer.byteLength(String(writeArgs[0])));
        if (writes === 1) await blocked;
        try { return await write(...writeArgs); }
        finally { concurrent--; }
      });
      return handle;
    });
    const snapshot = vi.fn(() => summary());
    const writer = make(snapshot);
    writer.event('start');
    await until(() => writes === 1);
    for (let i = 0; i < 10_000; i++) writer.event('stage');
    expect(snapshot).toHaveBeenCalledTimes(9); // one active + eight queued
    const finished = writer.finish();
    release();
    await finished;
    expect(maxConcurrent).toBe(1);
    expect(batchBytes.every(bytes => bytes <= 64 * 1024)).toBe(true);
    expect(readCompleted()).toContain('event=end droppedSnapshots=9992');
    expect(readCompleted().match(/\[sync-log\]/g)).toHaveLength(10);
  });

  it('caps the entire run at 1MiB and reserves a final snapshot with dropped counts', async () => {
    const realOpen = fs.promises.open.bind(fs.promises);
    let writeCalls = 0;
    let settledWrites = 0;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      const write = handle.writeFile.bind(handle);
      vi.spyOn(handle, 'writeFile').mockImplementation(async (...writeArgs) => {
        writeCalls++;
        try { return await write(...writeArgs); }
        finally { settledWrites++; }
      });
      return handle;
    });
    let outcome = 'running';
    const writer = make(() => summary(outcome, 1234567890123456));
    // Feed small batches, waiting for their write to settle, so this exercises
    // the per-run disk cap independently of the queue backpressure cap.
    for (let batch = 0; batch < 500; batch++) {
      for (let i = 0; i < 8; i++) writer.event('stage');
      await tick();
      await until(() => settledWrites === writeCalls);
      await tick();
    }
    outcome = 'success';
    await writer.finish();
    const content = readCompleted();
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(SYNC_RUN_LOG_MAX_BYTES);
    expect(content).toMatch(/event=end droppedSnapshots=[1-9]\d*/);
    expect(content).toContain('outcome=success');
    expect(Buffer.byteLength(content)).toBeGreaterThan(900_000);
  });

  it('takes 60-second heartbeat snapshots and clears its timer on finish', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const snapshot = vi.fn(() => summary());
    const writer = make(snapshot);
    writer.event('start');
    vi.advanceTimersByTime(59_999);
    expect(snapshot).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(snapshot).toHaveBeenCalledTimes(2);
    await writer.finish();
    expect(vi.getTimerCount()).toBe(0);
    expect(readCompleted()).toContain('event=heartbeat');
  });

  it('bounds final waiting and closes a delayed writer only after its outstanding write settles', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const realOpen = fs.promises.open.bind(fs.promises);
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let entered = false;
    let closed = false;
    let writeFinished = false;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      const write = handle.writeFile.bind(handle);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, 'writeFile').mockImplementation(async (...writeArgs) => {
        entered = true;
        await blocked;
        await write(...writeArgs);
        writeFinished = true;
      });
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        expect(writeFinished).toBe(true);
        await close();
        closed = true;
      });
      return handle;
    });
    const warning = vi.fn();
    const writer = make(() => summary(), warning);
    writer.event('start');
    await until(() => entered);
    const finished = writer.finish();
    vi.advanceTimersByTime(2_000);
    await expect(finished).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalledTimes(1);
    expect(closed).toBe(false);
    release();
    await until(() => closed);
    expect(completed()).toEqual([]);
    expect(files().filter(name => name.endsWith('.active'))).toHaveLength(1);
  });
});
