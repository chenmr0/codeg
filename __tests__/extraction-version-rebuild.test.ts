import {afterEach, expect, it, vi} from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
import {EXTRACTION_VERSION} from '../src/extraction/extraction-version';

const roots: string[] = [];
const graphs: CodeGraph[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const graph of graphs.splice(0)) graph.close();
  for (const root of roots.splice(0)) fs.rmSync(root, {recursive:true, force:true});
});

async function oldIndex() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-version-rebuild-')); roots.push(root);
  fs.writeFileSync(path.join(root, 'api.cpp'), 'enum class Mode { ON };\n'
    + 'namespace actual { using ON = int; } namespace local { namespace Mode = actual; int api(Mode::ON); }\n'
    + '#define MAKE() int run(int value) { return 1; } int run(double value) { return 2; }\nMAKE()\n');
  const graph = CodeGraph.initSync(root); graphs.push(graph);
  await graph.indexAll();
  // Reproduce persisted wrong kinds / missing overloads without changing the
  // source hash or depending on a historical engine installation in the suite.
  const db = (graph as any).db.db;
  db.prepare("UPDATE nodes SET kind='variable' WHERE name='api'").run();
  db.prepare("DELETE FROM nodes WHERE name='run' AND signature LIKE '%double%'").run();
  (graph as any).queries.setMetadata('indexed_with_extraction_version', String(EXTRACTION_VERSION - 1));
  return graph;
}

function expectOld(graph: CodeGraph) {
  expect(graph.isIndexStale()).toBe(true);
  expect(graph.getIndexBuildInfo().extractionVersion).toBe(EXTRACTION_VERSION - 1);
  expect(graph.getNodesByName('api')[0]?.kind).toBe('variable');
  expect(graph.getNodesByName('run')).toHaveLength(1);
}

it('ordinary full indexing replaces old content even when source hashes match', async () => {
  let graph = await oldIndex();
  const root = graph.getProjectRoot();
  graph.close(); graphs.pop(); graph = CodeGraph.openSync(root); graphs.push(graph);
  expectOld(graph);
  expect((await graph.sync()).filesModified).toBe(0);
  expectOld(graph);
  const result = await graph.indexAll();
  expect(result.complete).toBe(true);
  expect(graph.getNodesByName('api')[0]?.kind).toBe('function');
  expect(graph.getNodesByName('run')).toHaveLength(2);
  expect(graph.getIndexBuildInfo().extractionVersion).toBe(EXTRACTION_VERSION);
  expect(graph.isIndexStale()).toBe(false);
});

it('keeps an old version stale after an aborted rebuild', async () => {
  const graph = await oldIndex();
  const controller = new AbortController(); controller.abort();
  const result = await graph.indexAll({signal:controller.signal});
  expect(result.complete).toBe(false);
  expectOld(graph);
  expect((await graph.indexAll()).complete).toBe(true);
  expect(graph.isIndexStale()).toBe(false);
});

it('does not certify a partial rebuild merely because some files were indexed', async () => {
  const graph = await oldIndex();
  const orchestrator = (graph as any).orchestrator;
  const original = orchestrator.indexAll.bind(orchestrator);
  const partial = vi.spyOn(orchestrator, 'indexAll').mockImplementationOnce(async (...args) => {
    const result = await original(...args);
    return {...result, filesErrored:1, errors:[...result.errors, {filePath:'unavailable.cpp', message:'Injected read failure', severity:'error'}]};
  });
  const result = await graph.indexAll();
  expect(result.filesIndexed).toBeGreaterThan(0);
  expect(result.complete).toBe(false);
  expect(graph.getIndexBuildInfo().extractionVersion).toBe(EXTRACTION_VERSION - 1);
  expect(graph.isIndexStale()).toBe(true);
  partial.mockRestore();
  expect((await graph.indexAll()).complete).toBe(true);
  expect(graph.isIndexStale()).toBe(false);
});
