import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src';
import { createUpstreamExploreGraph } from '../src/mcp/upstream-explore-adapter';
import { ToolHandler as ProductionToolHandler } from '../src/mcp/tools';
import { ToolHandler, namedDataAnchors, notInIndexNote } from '../src/upstream-explore/mcp/tools';
import type { Node } from '../src/upstream-explore/types';

const data = (name: string, extra: Partial<Node> = {}): Node => ({
  id: name, name, qualifiedName: `Scope::${name}`, kind: 'enum_member', language: 'cpp',
  filePath: 'metric.h', startLine: 1, endLine: 1, startColumn: 0, endColumn: 0, updatedAt: 0, ...extra,
});
const roots: string[] = [], graphs: CodeGraph[] = [];
afterEach(() => {
  for (const graph of graphs.splice(0)) graph.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

describe('bounded explicit enum/field definition anchors', () => {
  it('accepts exact snake, camel, uppercase and qualified names, not fuzzy names', () => {
    for (const name of ['DTL_BLOCKING_TIME', 'retryCount', 'READY']) {
      expect(namedDataAnchors(name, [data(name)])).toHaveLength(1);
    }
    expect(namedDataAnchors('Scope::status', [data('status', { kind: 'field' })])).toHaveLength(1);
    expect(namedDataAnchors('Other::status', [data('status', { kind: 'field' })])).toEqual([]);
    expect(namedDataAnchors('retryCount', [data('retryCountExtra')])).toEqual([]);
  });
  it('does not promote common prose even if co-named, or arbitrary ambiguous members', () => {
    for (const name of ['status', 'value', 'How', 'Status']) expect(namedDataAnchors(name, [data(name)])).toEqual([]);
    const family = Array.from({ length: 4 }, (_, i) => data('retry_count', { id: `f${i}`, qualifiedName: `S${i}::retry_count`, kind: 'field' }));
    expect(namedDataAnchors('retry_count', family)).toEqual([]);
    expect(namedDataAnchors('retry_count', family.slice(0, 3))).toHaveLength(3);
    expect(namedDataAnchors('S2::retry_count', family)).toEqual([family[2]]);
  });
  it('does not misdiagnose missing macro metadata as an unindexed file', () => {
    const note = notInIndexNote(['kv_ttl_delete_max_ops'], true);
    expect(note).toContain('a macro or syntax may not have been extracted');
    expect(note).toContain('does not prove the name is absent from source');
    expect(note).not.toContain('defining it is not indexed');
    expect(note).not.toContain('.gitignore');
  });
  it('rescues a real C++ enum and field omitted from initial top-k, retaining exact source and budget', async () => {
    vi.stubEnv('CODEGRAPH_ENABLE_EXPLORE', '1'); vi.stubEnv('CODEGRAPH_NO_DAEMON', '1');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'explore-data-anchor-')); roots.push(root);
    fs.writeFileSync(path.join(root, 'entry.cpp'), 'int startPipeline() { return 731; }\n');
    for (let f = 0; f < 3; f++) fs.writeFileSync(path.join(root, `busy${f}.cpp`),
      Array.from({ length: 30 }, (_, i) => `int busy${f}Function${i}() { return ${i}; }`).join('\n'));
    const prefix = Array.from({length: 150}, (_, i) => `// unrelated prefix ${i}`).join('\n');
    fs.writeFileSync(path.join(root, 'metric.h'), `${prefix}\nenum Metrics {\n  DTL_BLOCKING_TIME = 917,\n};\nstruct Options { int retry_count; };\n`);
    const cg = CodeGraph.initSync(root); graphs.push(cg); await cg.indexAll();
    const graph = createUpstreamExploreGraph(cg);
    expect(graph.getNodesByName('DTL_BLOCKING_TIME').some(n => n.kind === 'enum_member')).toBe(true);
    expect(graph.getNodesByName('retry_count').some(n => n.kind === 'field')).toBe(true);
    const entry = graph.getNodesByName('startPipeline')[0]!;
    const crowded = [entry, ...Array.from({ length: 3 }, (_, f) => graph.getNodesInFile(`busy${f}.cpp`)).flat()
      .filter(n => n.kind === 'function')];
    // Three high-score files survive without backfilling. A weak-kind data
    // seed must survive the relative score floor, not merely gain a tier later.
    vi.spyOn(graph, 'findRelevantContext').mockResolvedValue({ nodes: new Map(crowded.map(n => [n.id, n])), edges: [], roots: crowded.map(n => n.id) });
    const result = await new ToolHandler(graph).execute('codegraph_explore', { query: 'startPipeline DTL_BLOCKING_TIME Options::retry_count', maxFiles: 4 });
    const text = result.content.map(c => c.text ?? '').join('\n');
    expect(result.isError).not.toBe(true);
    expect(text).toContain('DTL_BLOCKING_TIME = 917'); expect(text).toContain('int retry_count;');
    expect(text.length).toBeLessThan(20000);
    // Real production handler also works without the controlled gather.
    const handler = new ProductionToolHandler(cg);
    try {
      const response = await handler.execute('explore', { query: 'startPipeline DTL_BLOCKING_TIME Options::retry_count', maxFiles: 4 });
      expect(response.isError).not.toBe(true);
      expect(response.content.map(c => c.text ?? '').join('\n')).toContain('DTL_BLOCKING_TIME = 917');
      expect(response).not.toHaveProperty('_cgExploreEmission');
    } finally { handler.closeAll(); }
  }, 30000);
});
