/**
 * Incremental-sync WAL checkpoint deferral (#1248).
 *
 * Full indexing already uses WalCheckpointValve. These tests pin the matching
 * sync lifecycle: auto-checkpointing is disabled only while sync is active,
 * restored on every exit path, and does not change the resulting graph update.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../src/db';
import CodeGraph from '../src/index';

let tmpDir: string;
let openGraphs: CodeGraph[];
let previousWalDefer: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sync-wal-'));
  openGraphs = [];
  previousWalDefer = process.env.CODEGRAPH_NO_WAL_DEFER;
  delete process.env.CODEGRAPH_NO_WAL_DEFER;
});

afterEach(() => {
  for (const graph of openGraphs.splice(0)) {
    try { graph.close(); } catch { /* already closed */ }
  }
  if (previousWalDefer === undefined) delete process.env.CODEGRAPH_NO_WAL_DEFER;
  else process.env.CODEGRAPH_NO_WAL_DEFER = previousWalDefer;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFixture(returnOffset = 1): void {
  fs.mkdirSync(path.join(tmpDir, 'include'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, 'include', 'api.h'),
    '#pragma once\nint compute(int value);\n'
  );
  fs.writeFileSync(
    path.join(tmpDir, 'src', 'api.c'),
    `#include "../include/api.h"\nint compute(int value) { return value + ${returnOffset}; }\n`
  );
  fs.writeFileSync(
    path.join(tmpDir, 'src', 'main.c'),
    '#include "../include/api.h"\nint main(void) { return compute(41); }\n'
  );
}

function openGraph(): CodeGraph {
  const graph = CodeGraph.initSync(tmpDir);
  openGraphs.push(graph);
  return graph;
}

function closeGraph(graph: CodeGraph): void {
  graph.close();
  openGraphs = openGraphs.filter((candidate) => candidate !== graph);
}

function connectionOf(graph: CodeGraph): DatabaseConnection {
  return (graph as unknown as { db: DatabaseConnection }).db;
}

describe('sync WAL deferral', () => {
  it('disables auto-checkpointing during a changed-file sync and restores it', async () => {
    writeFixture();
    const graph = openGraph();
    const indexed = await graph.indexAll();
    expect(indexed.success).toBe(true);

    const connection = connectionOf(graph);
    const originalInterval = connection.getWalAutocheckpoint();
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'api.c'),
      '#include "../include/api.h"\nint compute(int value) { return value + 100; }\n'
    );

    const observedIntervals: number[] = [];
    const result = await graph.sync({
      onProgress: () => observedIntervals.push(connection.getWalAutocheckpoint()),
    });

    expect(result.filesModified).toBe(1);
    expect(observedIntervals.length).toBeGreaterThan(0);
    expect(observedIntervals.every((value) => value === 0)).toBe(true);
    expect(connection.getWalAutocheckpoint()).toBe(originalInterval);
  });

  it('restores the original interval after a no-change sync', async () => {
    writeFixture();
    const graph = openGraph();
    await graph.indexAll();
    const connection = connectionOf(graph);
    const originalInterval = connection.getWalAutocheckpoint();

    const result = await graph.sync();

    expect(result.filesAdded + result.filesModified + result.filesRemoved).toBe(0);
    expect(connection.getWalAutocheckpoint()).toBe(originalInterval);
  });

  it('restores the interval and releases the file lock when sync throws', async () => {
    writeFixture();
    const graph = openGraph();
    await graph.indexAll();
    const connection = connectionOf(graph);
    const originalInterval = connection.getWalAutocheckpoint();
    const internals = graph as unknown as {
      orchestrator: { sync: () => Promise<never> };
    };
    const originalSync = internals.orchestrator.sync;
    let intervalDuringFailure: number | null = null;
    internals.orchestrator.sync = async () => {
      intervalDuringFailure = connection.getWalAutocheckpoint();
      throw new Error('synthetic sync failure');
    };

    await expect(graph.sync()).rejects.toThrow('synthetic sync failure');
    expect(intervalDuringFailure).toBe(0);
    expect(connection.getWalAutocheckpoint()).toBe(originalInterval);

    // A second sync proves the cross-process file lock was released as well.
    internals.orchestrator.sync = originalSync;
    const retry = await graph.sync();
    expect(retry.filesChecked).toBeGreaterThan(0);
  });

  it('produces the same C graph update with deferral enabled and disabled', async () => {
    writeFixture();
    const deferred = openGraph();
    await deferred.indexAll();
    writeFixture(100);
    const deferredResult = await deferred.sync();
    const expected = {
      filesModified: deferredResult.filesModified,
      nodesUpdated: deferredResult.nodesUpdated,
    };
    closeGraph(deferred);

    fs.rmSync(path.join(tmpDir, '.codegraph-wx'), { recursive: true, force: true });
    writeFixture();
    process.env.CODEGRAPH_NO_WAL_DEFER = '1';
    const ordinary = openGraph();
    await ordinary.indexAll();
    writeFixture(200);
    const ordinaryResult = await ordinary.sync();

    expect({
      filesModified: ordinaryResult.filesModified,
      nodesUpdated: ordinaryResult.nodesUpdated,
    }).toEqual(expected);
  });
});
