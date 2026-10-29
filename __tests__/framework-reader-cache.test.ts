import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const { CodeGraph } = require('../dist') as typeof import('../src');
const { drainGenerationCollections } = require('../dist/sync/generation-store');
const { getFrameworkResolver } = require('../dist/resolution/frameworks');
const graphs: import('../src').CodeGraph[] = [];
const roots: string[] = [];
const plain = 'def simple():\n    return 1\n';
const flask = "from flask import Flask\napp = Flask(__name__)\n@app.route('/')\ndef simple():\n    return 'ok'\n";
afterEach(async () => {
  vi.restoreAllMocks();
  for (const graph of graphs.splice(0)) graph.close();
  await drainGenerationCollections();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-framework-reader-')); roots.push(root);
  fs.writeFileSync(path.join(root, 'main.py'), plain);
  const graph = await CodeGraph.init(root, { index: true }); graphs.push(graph);
  expect(graph.getDetectedFrameworks()).toEqual([]);
  const node = graph.searchNodes('simple').find(row => row.node.name === 'simple')!.node;
  const reader = CodeGraph.openReadOnlySync(root); graphs.push(reader);
  expect(reader.getDetectedFrameworks()).toEqual([]);
  const current = fs.readFileSync(path.join(graph.getDataDirectory(), 'CURRENT'), 'utf8');
  const unchanged = () => expect(fs.readFileSync(path.join(graph.getDataDirectory(), 'CURRENT'), 'utf8')).toBe(current);
  const index = async (source: string) => {
    fs.writeFileSync(path.join(root, 'main.py'), source);
    expect((await graph.indexAll()).success).toBe(true);
    unchanged();
  };
  return { root, graph, reader, node, unchanged, index };
}

for (const first of ['node', 'file-nodes', 'search', 'direct-node', 'direct-batch'] as const) {
  it(`refreshes same-generation framework additions/removals after ${first}, lazily and once`, async () => {
    const { root, graph, reader, node, unchanged, index } = await fixture();
    for (const [source, expected] of [[flask, ['flask']], [plain, []]] as const) {
      await index(source);
      const detect = vi.spyOn(getFrameworkResolver('flask'), 'detect');
      const initialize = vi.spyOn((reader as any).resolver, 'initialize');
      if (first === 'node') reader.getNode(node.id);
      else if (first === 'file-nodes') reader.getNodesInFile('main.py');
      else if (first === 'search') reader.searchNodes('simple');
      // These bypass the facade and consume QueryBuilder's data_version first.
      else if (first === 'direct-node') (reader as any).queries.getNodeById(node.id);
      else (reader as any).queries.getNodesByIds([node.id]);
      expect(detect).not.toHaveBeenCalled();
      expect(initialize).not.toHaveBeenCalled();
      expect(reader.getDetectedFrameworks()).toEqual(expected);
      expect(reader.getDetectedFrameworks()).toEqual(expected);
      expect(detect).toHaveBeenCalledTimes(1);
      expect(initialize).toHaveBeenCalledTimes(1);
      expect((reader as any).readOnly).toBe(true);
      detect.mockRestore(); initialize.mockRestore();
      // Exercise the default facade's independently cached reader too.
      expect(graph.getDetectedFrameworks()).toEqual(expected);
      const fresh = CodeGraph.openReadOnlySync(root);
      try { expect(reader.getDetectedFrameworks()).toEqual(fresh.getDetectedFrameworks()); }
      finally { fresh.close(); }
      unchanged();
    }
  }, 30000);
}

it('observes another SDK process adding and removing Flask without changing CURRENT', async () => {
  const { root, graph, reader, node, unchanged } = await fixture();
  for (const [source, expected] of [[flask, ['flask']], [plain, []]] as const) {
    const child = spawnSync(process.execPath, ['--liftoff-only', '-e', `
      const fs=require('node:fs'),path=require('node:path');
      const {CodeGraph}=require(process.argv[1]);
      (async()=>{const g=CodeGraph.openSync(process.argv[2]);try {
        fs.writeFileSync(path.join(process.argv[2],'main.py'),process.argv[3]);
        if(!(await g.indexAll()).success)throw Error('index failed');
      }finally{g.close()}})().catch(e=>{console.error(e);process.exitCode=1});
    `, path.resolve(__dirname, '../dist'), root, source], { encoding: 'utf8', timeout: 20000, env: { ...process.env, CODEGRAPH_ALL_LANGUAGES: '1' } });
    expect(child.status, child.stderr).toBe(0);
    unchanged();
    reader.getNode(node.id);
    expect(reader.getDetectedFrameworks()).toEqual(expected);
    expect(graph.getDetectedFrameworks()).toEqual(expected);
  }
}, 60000);

it('invalidates framework state after clear without rebuilding or closing the reader', async () => {
  const { graph, reader, unchanged, index } = await fixture();
  await index(flask);
  expect(reader.getDetectedFrameworks()).toEqual(['flask']);
  graph.clear();
  const detect = vi.spyOn(getFrameworkResolver('flask'), 'detect');
  expect(reader.searchNodes('simple')).toEqual([]);
  expect(detect).not.toHaveBeenCalled();
  expect(reader.getDetectedFrameworks()).toEqual([]);
  expect(reader.getDetectedFrameworks()).toEqual([]);
  expect(detect).toHaveBeenCalledTimes(1);
  unchanged();
}, 30000);

for (const entry of ['resolveOne', 'warmCaches', 'runPostExtract'] as const) {
  it(`refreshes framework context lazily at ${entry}, not only the list accessor`, async () => {
    const { reader, index, unchanged } = await fixture();
    const resolver = (reader as any).resolver;
    const previousContext = resolver.context;
    await index(flask);
    // Consume QueryBuilder's change notification before the resolver sees it.
    (reader as any).queries.getNodesByIds([]);
    const detect = vi.spyOn(getFrameworkResolver('flask'), 'detect');
    if (entry === 'resolveOne') resolver.resolveOne({ referenceName: 'print', referenceKind: 'calls', filePath: 'main.py', language: 'python', sourceNodeId: 'missing' });
    else resolver[entry]();
    expect(detect).toHaveBeenCalledTimes(1);
    expect(resolver.context).not.toBe(previousContext);
    expect(reader.getDetectedFrameworks()).toEqual(['flask']);
    expect(detect).toHaveBeenCalledTimes(1);
    unchanged();
  }, 30000);
}
