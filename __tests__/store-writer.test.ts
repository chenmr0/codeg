import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Node } from '../src/types';
import {
  StoreWriter,
  batchStoreBundles,
  type StoreBundle,
} from '../src/extraction/store-writer';

const tempDirectories: string[] = [];

function makeTempDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-store-writer-'));
  tempDirectories.push(directory);
  return directory;
}

function bundle(name: string, nodeCount = 1, size = 10): StoreBundle {
  const nodes: Node[] = Array.from({ length: nodeCount }, (_, index) => ({
    id: `${name}-${index}`,
    kind: 'function',
    name: `${name}-${index}`,
    qualifiedName: `${name}-${index}`,
    filePath: `${name}.ts`,
    language: 'typescript',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 1,
  }));
  return {
    nodes,
    edges: [],
    refs: [],
    file: {
      path: `${name}.ts`,
      contentHash: `hash-${name}`,
      language: 'typescript',
      size,
      modifiedAt: 1,
      indexedAt: 1,
      nodeCount,
    },
  };
}

describe('store writer batching', () => {
  afterEach(() => {
    for (const directory of tempDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('preserves order and isolates bundles that exceed a batch budget', () => {
    const input = [
      bundle('first', 1, 10),
      bundle('second', 1, 10),
      bundle('oversized', 10, 10),
      bundle('last', 1, 10),
    ];
    const batches = batchStoreBundles(input, {
      maxBundles: 3,
      maxRows: 6,
      maxSourceBytes: 100,
    });

    expect(batches.map((batch) => batch.map((item) => item.file.path))).toEqual([
      ['first.ts', 'second.ts'],
      ['oversized.ts'],
      ['last.ts'],
    ]);
    expect(batches.flat()).toEqual(input);
  });

  it('tracks bundle-weighted backpressure and worker transaction stats', async () => {
    const directory = makeTempDirectory();
    const workerPath = path.join(directory, 'fixture-worker.cjs');
    fs.writeFileSync(workerPath, `
      const { parentPort } = require('worker_threads');
      parentPort.on('message', (message) => {
        if (message.type === 'open') {
          parentPort.postMessage({ type: 'ready' });
        } else if (message.type === 'batch') {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
          const stats = {
            transactionMs: 5,
            rowAggregationMs: 0.25,
            duplicateNodeRowsElided: 1,
            nodeWriteMs: 1,
            edgeWriteMs: 0.5,
            unresolvedRefWriteMs: 2,
            fileWriteMs: 0.25,
            filesStored: message.bundles.length,
            nodesStored: message.bundles.reduce((n, b) => n + b.nodes.length, 0),
            edgesStored: message.bundles.reduce((n, b) => n + b.edges.length, 0),
            unresolvedRefsStored: message.bundles.reduce((n, b) => n + b.refs.length, 0),
          };
          parentPort.postMessage({
            type: 'ack',
            bundleCount: message.bundles.length,
            stats,
          });
        } else if (message.type === 'drain') {
          parentPort.postMessage({ type: 'drained', id: message.id });
        } else if (message.type === 'close') {
          process.exit(0);
        }
      });
    `);

    const writer = new StoreWriter(workerPath, 'unused.db', true);
    try {
      await writer.ready();
      writer.sendMany([bundle('a', 2, 10), bundle('b', 3, 20)]);
      writer.send(bundle('c', 4, 30));
      const waitedMs = await writer.waitBelow(3);
      await writer.drain();

      const stats = writer.getStats();
      expect(waitedMs).toBeGreaterThan(0);
      expect(stats).toMatchObject({
        bundlesSent: 3,
        messagesSent: 2,
        sourceBytes: 60,
        nodesSent: 9,
        maxOutstandingBundles: 3,
        windowWaitCount: 1,
        transactions: 2,
        transactionMs: 10,
        rowAggregationMs: 0.5,
        duplicateNodeRowsElided: 2,
        nodeWriteMs: 2,
        edgeWriteMs: 1,
        unresolvedRefWriteMs: 4,
        fileWriteMs: 0.5,
        filesStored: 3,
        nodesStored: 9,
      });
      expect(stats.windowWaitMs).toBeGreaterThan(0);
    } finally {
      await writer.close();
    }
  });
});

