import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const { CodeGraph } = require('../dist') as typeof import('../src');
const { resolveGeneration, drainGenerationCollections } = require('../dist/sync/generation-store');
const graphs: import('../src').CodeGraph[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const graph of graphs.splice(0)) graph.close();
  await drainGenerationCollections();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-same-generation-')); roots.push(root);
  fs.writeFileSync(path.join(root, 'main.c'), 'int cached_symbol(void) { return 1; }\n');
  const graph = await CodeGraph.init(root, { index: true }); graphs.push(graph);
  const node = graph.searchNodes('cached_symbol').find(row => row.node.name === 'cached_symbol')!.node;
  expect(graph.getNode(node.id)).not.toBeNull();
  return { root, graph, node, generation: resolveGeneration(graph.getDataDirectory()).id };
}
for (const mutation of ['delete', 'update', 'clear'] as const) {
  it(`invalidates a hot same-generation node reader after ${mutation}`, async () => {
    const { root, graph, node, generation } = await fixture();
    if (mutation === 'clear') graph.clear();
    else {
      if (mutation === 'delete') fs.unlinkSync(path.join(root, 'main.c'));
      else fs.writeFileSync(path.join(root, 'main.c'), 'int cached_symbol(int argument) {\n return argument;\n}\n');
      await graph.sync({ adaptive: false });
    }
    expect(resolveGeneration(graph.getDataDirectory()).id).toBe(generation);
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
it('sees a commit by a separate SDK writer process without replacing CURRENT', async () => {
  const { root, graph, node, generation } = await fixture();
  const child = spawnSync(process.execPath, ['--liftoff-only', '-e', `const {CodeGraph}=require(process.argv[1]);const g=CodeGraph.openSync(process.argv[2]);g.clear();g.close();`, path.resolve(__dirname, '../dist'), root], { encoding: 'utf8', timeout: 15000 });
  expect(child.status, child.stderr).toBe(0);
  expect(resolveGeneration(graph.getDataDirectory()).id).toBe(generation);
  expect(graph.getNode(node.id)).toBeNull();
}, 30000);
it('invalidates a directly pinned reader and batch cache after a same-generation commit', async () => {
  const { root, graph, node } = await fixture();
  const reader = CodeGraph.openReadOnlySync(root); graphs.push(reader);
  expect(reader.getNode(node.id)).not.toBeNull();
  const queries = (reader as any).queries;
  expect(queries.getNodesByIds([node.id]).has(node.id)).toBe(true);
  graph.clear();
  expect(queries.getNodesByIds([node.id]).has(node.id)).toBe(false);
  expect(reader.getNode(node.id)).toBeNull();
}, 30000);
it('does not advance an explicit SQLite read snapshot while invalidating later commits', async () => {
  const { root, graph, node } = await fixture();
  const reader = CodeGraph.openReadOnlySync(root); graphs.push(reader);
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
