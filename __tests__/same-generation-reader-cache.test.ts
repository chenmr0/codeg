import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const { CodeGraph } = require('../dist') as typeof import('../src');
const { drainGenerationCollections } = require('../dist/sync/generation-store');
const graphs: import('../src').CodeGraph[] = [];
const roots: string[] = [];
const pins: Array<{ release(): void }> = [];
function pinReader(facade: import('../src').CodeGraph): import('../src').CodeGraph {
  const pin = facade.acquirePortableRead(); pins.push(pin); return pin.graph;
}
afterEach(async () => {
  for (const pin of pins.splice(0)) pin.release();
  for (const graph of graphs.splice(0)) {
    await graph.whenIdle(); graph.close(); await graph.whenIdle();
  }
  await drainGenerationCollections();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-same-generation-')); roots.push(root);
  fs.writeFileSync(path.join(root, 'main.c'), 'int cached_symbol(void) { return 1; }\n');
  const graph = await CodeGraph.init(root, { index: true }); graphs.push(graph);
  const node = graph.searchNodes('cached_symbol').find(row => row.node.name === 'cached_symbol')!.node;
  expect(graph.getNode(node.id)).not.toBeNull();
  const database = graph.getDatabaseFilePath(), identity = fs.statSync(database);
  const unchanged = () => {
    expect(graph.getDatabaseFilePath()).toBe(database);
    const current = fs.statSync(database);
    expect([current.dev, current.ino, current.birthtimeMs]).toEqual([identity.dev, identity.ino, identity.birthtimeMs]);
    expect(fs.existsSync(path.join(graph.getDataDirectory(), 'CURRENT'))).toBe(false);
  };
  return { root, graph, node, unchanged };
}
for (const mutation of ['delete', 'update', 'clear'] as const) {
  it(`invalidates a hot same-generation node reader after ${mutation}`, async () => {
    const { root, graph, node, unchanged } = await fixture();
    if (mutation === 'clear') graph.clear();
    else {
      if (mutation === 'delete') fs.unlinkSync(path.join(root, 'main.c'));
      else fs.writeFileSync(path.join(root, 'main.c'), 'int cached_symbol(int argument) {\n return argument;\n}\n');
      await graph.sync({ adaptive: false });
    }
    unchanged();
    if (mutation === 'update') {
      const current = graph.searchNodes('cached_symbol').find(row => row.node.id === node.id)!.node;
      expect(current.signature).not.toBe(node.signature);
      expect(graph.getNode(node.id)).toEqual(current);
    } else {
      expect(graph.searchNodes('cached_symbol')).toEqual([]);
      expect(graph.getFiles()).toEqual([]);
      expect(graph.getNode(node.id)).toBeNull();
    }
  }, 30000);
}
it('sees a commit by a separate SDK writer process without replacing the database file', async () => {
  const { root, graph, node, unchanged } = await fixture();
  const child = spawnSync(process.execPath, ['--liftoff-only', '-e', `const {CodeGraph}=require(process.argv[1]);(async()=>{const g=CodeGraph.openSync(process.argv[2]);try{g.clear();await g.whenIdle();}finally{g.close();await g.whenIdle();}})().catch(error=>{console.error(error);process.exitCode=1});`, path.resolve(__dirname, '../dist'), root], { encoding: 'utf8', timeout: 15000 });
  expect(child.status, child.stderr).toBe(0);
  unchanged();
  expect(graph.getNode(node.id)).toBeNull();
}, 30000);
it('invalidates a directly pinned reader and batch cache after a same-generation commit', async () => {
  const { root, graph, node } = await fixture();
  const facade = CodeGraph.openReadOnlySync(root); graphs.push(facade);
  // A retained native pin prevents facade reopening from masking cache bugs.
  const reader = pinReader(facade);
  expect(reader.getNode(node.id)).not.toBeNull();
  const queries = (reader as any).queries;
  expect(queries.getNodesByIds([node.id]).has(node.id)).toBe(true);
  graph.clear();
  expect(queries.getNodesByIds([node.id]).has(node.id)).toBe(false);
  expect(reader.getNode(node.id)).toBeNull();
}, 30000);
it('does not advance an explicit SQLite read snapshot while invalidating later commits', async () => {
  const { root, graph, node } = await fixture();
  const facade = CodeGraph.openReadOnlySync(root); graphs.push(facade);
  // A retained native pin prevents facade reopening from masking cache bugs.
  const reader = pinReader(facade);
  const db = (reader as any).db.getDb();
  db.exec('BEGIN');
  try {
    expect(reader.getNode(node.id)).not.toBeNull();
    graph.clear();
    expect(reader.getNode(node.id)).toEqual(node);
    expect(reader.searchNodes('cached_symbol').length).toBeGreaterThan(0);
  } finally { db.exec('COMMIT'); }
  expect(reader.getNode(node.id)).toBeNull();
}, 30000);
