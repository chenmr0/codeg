import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import childProcess from 'child_process';
import CodeGraph from '../src/index';
import type { ExtractionOrchestrator, IndexProgress } from '../src/extraction';
import type { QueryBuilder } from '../src/db/queries';
import { RemovalDiagnostics } from '../src/extraction/sync-diagnostics';

describe('sync stale-index removal progress', () => {
  let directory: string;
  let graph: CodeGraph;
  let orchestrator: ExtractionOrchestrator;
  let queries: QueryBuilder;
  let progress: IndexProgress[];
  let messages: string[];
  const removed = () => progress.filter(p => p.phase === 'removing');
  const removeSource = (file: string) => fs.unlinkSync(path.join(directory, file));

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-removal-progress-'));
    for (const file of ['a.c', 'b.c']) {
      fs.writeFileSync(path.join(directory, file), `int ${file[0]}_private_symbol(void) { return 7; }\n`);
    }
    graph = CodeGraph.initSync(directory);
    await graph.indexFiles(['a.c', 'b.c']);
    ({ orchestrator, queries } = graph as unknown as {
      orchestrator: ExtractionOrchestrator; queries: QueryBuilder;
    });
    progress = [];
    messages = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => { messages.push(args.join(' ')); });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    graph?.close();
    if (directory && path.basename(directory).startsWith('cg-removal-progress-')) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reports committed index-entry counts and preserves every source file still present', async () => {
    removeSource('a.c');
    removeSource('b.c');
    const deletionOrder: string[] = [];
    const originalDelete = queries.deleteFile.bind(queries);
    vi.spyOn(queries, 'deleteFile').mockImplementation((file, metadata) => {
      deletionOrder.push(file);
      expect(removed().at(-1)?.current).toBe(deletionOrder.length - 1);
      originalDelete(file, metadata);
    });
    const result = await orchestrator.sync(p => { progress.push(p); }, undefined, true);
    expect(result.filesRemoved).toBe(2);
    expect(deletionOrder).toEqual(['a.c', 'b.c']);
    expect(removed()[0]).toMatchObject({ current: 0, total: 2, status: 'running' });
    expect(removed().at(-1)).toMatchObject({ current: 2, total: 2, status: 'complete' });
    expect(removed().every(p => p.currentFile === undefined)).toBe(true);
    expect(queries.getAllFiles()).toHaveLength(0);
    expect(messages.some(m => m.includes('removal-detail attempted=2 committed=2 mainThread=2'))).toBe(true);
    for (const message of messages.filter(m => /remov(al|ing)-/.test(m))) {
      expect(message).not.toContain(directory);
      expect(message).not.toMatch(/a\.c|b\.c|private_symbol|return 7/);
    }
  });

  it('does not invent a removal phase or verbose logging on a no-op', async () => {
    await orchestrator.sync(p => { progress.push(p); });
    expect(removed()).toHaveLength(0);
    expect(messages.some(m => /remov(al|ing)-/.test(m))).toBe(false);
    expect(fs.existsSync(path.join(directory, 'a.c'))).toBe(true);
    expect(queries.getAllFiles()).toHaveLength(2);
  });

  it('uses an unknown total for a late deletion still enumerated by git', async () => {
    childProcess.execFileSync('git', ['init', '-q'], { cwd: directory, stdio: 'pipe', windowsHide: true });
    childProcess.execFileSync('git', ['add', 'a.c', 'b.c'], { cwd: directory, stdio: 'pipe', windowsHide: true });
    removeSource('a.c');
    const result = await orchestrator.sync(p => { progress.push(p); }, undefined, true);
    expect(result.filesRemoved).toBe(1);
    expect(removed().length).toBeGreaterThan(0);
    expect(removed().every(p => p.total === 0)).toBe(true);
    expect(removed().at(-1)).toMatchObject({ current: 1, status: 'complete' });
    expect(messages.some(m => m.includes('total=unknown knownTotal=0 late=1'))).toBe(true);
    expect(fs.existsSync(path.join(directory, 'b.c'))).toBe(true);
  });

  it('increments only after the replacement callback acknowledges the committed removal', async () => {
    removeSource('a.c');
    vi.spyOn(queries, 'hasManyIncomingEdges').mockReturnValue(true);
    let acknowledge!: () => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const ack = new Promise<void>(resolve => { acknowledge = resolve; });
    const sync = orchestrator.sync(p => { progress.push(p); }, undefined, true, async request => {
      started();
      await ack;
      return orchestrator.storeParsedReplacement(request);
    });
    try {
      await entered;
      expect(removed().at(-1)).toMatchObject({ current: 0, total: 1 });
      expect(queries.getFileByPath('a.c')).not.toBeNull();
    } finally { acknowledge(); }
    expect((await sync).filesRemoved).toBe(1);
    expect(removed().at(-1)).toMatchObject({ current: 1, status: 'complete' });
    expect(messages.some(m => m.includes('mainThread=0 worker=1'))).toBe(true);
  });

  it('keeps the last committed count visible when the WAL gate fails', async () => {
    removeSource('a.c');
    removeSource('b.c');
    const error = new Error('controlled WAL failure');
    await expect(orchestrator.sync(p => { progress.push(p); }, undefined, true, undefined, async () => {
      expect(removed().at(-1)).toMatchObject({ current: 1, status: 'running' });
      throw error;
    })).rejects.toBe(error);
    expect(removed().at(-1)).toMatchObject({ current: 1, total: 2, status: 'failed' });
    expect(queries.getAllFiles()).toHaveLength(1);
    expect(messages.some(m => m.includes('status=failed committed=1 total=2'))).toBe(true);
    expect(messages.some(m => m.includes('failedPhase=walWaitMs'))).toBe(true);
  });

  it('does not count an uncommitted deletion and still emits final diagnostics', async () => {
    removeSource('a.c');
    vi.spyOn(queries, 'deleteFile').mockImplementation(() => { throw new Error('controlled delete failure'); });
    await expect(orchestrator.sync(p => { progress.push(p); }, undefined, true))
      .rejects.toThrow('controlled delete failure');
    expect(removed().at(-1)).toMatchObject({ current: 0, total: 1, status: 'failed' });
    expect(queries.getFileByPath('a.c')).not.toBeNull();
    expect(messages.some(m => m.includes('failedPhase=preserveDeleteMs'))).toBe(true);
    expect(messages.some(m => m.includes('status=failed committed=0 total=1'))).toBe(true);
  });

  it('preserves the original WAL error when new diagnostic output and failure reporting throw', async () => {
    removeSource('a.c');
    vi.mocked(console.log).mockImplementation(() => { throw new Error('diagnostic output failed'); });
    const original = new Error('original checkpoint failure');
    await expect(orchestrator.sync(p => {
      if (p.status === 'failed') throw new Error('failure callback failed');
    }, undefined, true, undefined, async () => { throw original; })).rejects.toBe(original);
    expect(queries.getFileByPath('a.c')).toBeNull();
  });
});

describe('removal diagnostic throttling', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('emits a heartbeat for an outstanding operation and a forced final snapshot', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const detail = new RemovalDiagnostics();
    const log = vi.fn();
    detail.beginFile(false, 3, log);
    expect(log).toHaveBeenCalledTimes(1);
    now = 900;
    detail.progress(3, log);
    expect(log).toHaveBeenCalledTimes(1);
    now = 1000;
    await vi.advanceTimersByTimeAsync(1000);
    expect(log).toHaveBeenCalledTimes(2);
    detail.committed = 1;
    detail.endFile();
    now = 1100;
    detail.finish(3, false, log);
    expect(log).toHaveBeenCalledTimes(4);
    expect(log.mock.calls[2]?.[0]).toContain('status=failed committed=1 total=3');
    expect(log.mock.calls[3]?.[0]).toContain('timingRelation=children-of-operation');
    await vi.advanceTimersByTimeAsync(5000);
    expect(log).toHaveBeenCalledTimes(4);
  });

  it('treats logger errors as best effort and always stops the heartbeat', async () => {
    vi.useFakeTimers();
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const detail = new RemovalDiagnostics();
    const log = vi.fn(() => { throw new Error('output unavailable'); });
    expect(() => detail.beginFile(false, 2, log)).not.toThrow();
    now = 1000;
    await vi.advanceTimersByTimeAsync(1000);
    expect(log).toHaveBeenCalledTimes(2);
    detail.endFile();
    expect(() => detail.finish(2, false, log)).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
});
