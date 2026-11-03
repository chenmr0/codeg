import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src';
import { createUpstreamExploreGraph } from '../src/mcp/upstream-explore-adapter';
import { ToolHandler as ProductionToolHandler } from '../src/mcp/tools';
import { ToolHandler, namedDataAnchors, notInIndexNote } from '../src/upstream-explore/mcp/tools';
import { ExploreSessionState } from '../src/upstream-explore/mcp/explore-session-state';
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
  async function emptyGatherFixture(source: string | null) {
    vi.stubEnv('CODEGRAPH_ENABLE_EXPLORE', '1'); vi.stubEnv('CODEGRAPH_NO_DAEMON', '1');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'explore-empty-data-anchor-')); roots.push(root);
    if (source !== null) fs.writeFileSync(path.join(root, 'metric.h'), source);
    const cg = CodeGraph.initSync(root); graphs.push(cg); await cg.indexAll();
    const graph = createUpstreamExploreGraph(cg);
    // Reproduce a filtered/scored initial gather with no entries at all.
    const gather = vi.spyOn(graph, 'findRelevantContext').mockImplementation(async () => ({
      nodes: new Map(), edges: [], roots: [],
    }));
    const session = new ExploreSessionState();
    const record = vi.spyOn(session, 'record');
    return { graph, gather, session, record, handler: new ToolHandler(graph) };
  }

  it.each([
    ['DTL_BLOCKING_TIME', 'DTL_BLOCKING_TIME = 917'],
    ['Options::retry_count', 'int retry_count;'],
  ])('recovers %s even when the initial gather is completely empty', async (query, source) => {
    const { handler, gather, session, record } = await emptyGatherFixture(
      'enum Metrics { DTL_BLOCKING_TIME = 917 };\nstruct Options { int retry_count; };\n',
    );
    const result = await handler.execute('codegraph_explore', { query, maxFiles: 1 }, session);
    const text = result.content.map(c => c.text ?? '').join('\n');
    expect(result.isError).not.toBe(true);
    expect(text).toContain(source);
    expect(text).not.toContain('No relevant code found');
    expect(text.length).toBeLessThan(20000);
    expect(gather).toHaveBeenCalledTimes(1);
    expect(gather).toHaveBeenCalledWith(query, {
      searchLimit: 8, traversalDepth: 3, maxNodes: 200, minScore: 0.2,
    });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]![0].sourceBytes).toBeGreaterThan(0);
    expect(record.mock.calls[0]![0].files).toHaveLength(1);
    expect(result).not.toHaveProperty('_cgExploreEmission');
  }, 30000);

  it.each([
    ['startPipeline', 'int startPipeline() { return 731; }'],
    ['activeCount', 'int activeCount = 419;'],
    ['profileInfo', 'int getProfileInfoV2() { return 823; }'],
  ])('retains existing named seeding for %s on an empty gather', async (query, source) => {
    const { graph, handler, session, record } = await emptyGatherFixture(`${source}\n`);
    const infix = vi.spyOn(graph, 'getNodesByNameSubstring');
    const result = await handler.execute('codegraph_explore', { query, maxFiles: 1 }, session);
    const text = result.content.map(c => c.text ?? '').join('\n');
    expect(result.isError).not.toBe(true);
    expect(text).toContain(source);
    expect(text).not.toContain('No relevant code found');
    expect(record.mock.calls[0]![0].sourceBytes).toBeGreaterThan(0);
    if (query === 'profileInfo') expect(infix).toHaveBeenCalledWith(query, {
      kinds: ['function', 'method', 'component', 'variable', 'constant'], limit: 60,
    });
    else expect(infix).not.toHaveBeenCalled();
  }, 30000);

  it.each([1, 64])('does not recover unrelated prose from %i same-named callables', async count => {
    const { graph, handler, session, record } = await emptyGatherFixture(
      Array.from({ length: count }, (_, i) => `namespace Scope${i} { int check() { return ${i}; } }`).join('\n'),
    );
    expect(graph.getNodesByName('check')).toHaveLength(count);
    const fileLookup = vi.spyOn(graph, 'getNodesInFile');
    const result = await handler.execute('codegraph_explore', { query: 'check the latest version' }, session);
    expect(result.isError).not.toBe(true);
    expect(result.content.map(c => c.text ?? '').join('\n')).toContain('No relevant code found');
    expect(record.mock.calls[0]![0].sourceBytes).toBe(0);
    // Co-name corroboration is cached per file, not repeated per overload.
    expect(fileLookup.mock.calls.filter(([file]) => file === 'metric.h')).toHaveLength(1);
  }, 30000);

  it.each(['retry_count', 'status', 'missing_metric'])('preserves empty-result diagnostics and accounting for %s', async query => {
    const { handler, session, record } = await emptyGatherFixture(
      Array.from({ length: 4 }, (_, i) => `struct S${i} { int retry_count; int status; };`).join('\n'),
    );
    const result = await handler.execute('codegraph_explore', { query, maxFiles: 1 }, session);
    const text = result.content.map(c => c.text ?? '').join('\n');
    expect(result.isError).not.toBe(true);
    expect(text).toContain(`No relevant code found for "${query}"`);
    expect(text).toContain('Explore matches symbol/file names');
    expect(text).toContain('No lexical matches for checked words:');
    if (query === 'missing_metric') expect(text).toContain('Not in the index');
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({
      projectRoot: expect.any(String), query, files: [], sourceBytes: 0, responseBytes: text.length,
    });
  }, 30000);

  it('does not bypass the named-token cap on an empty gather', async () => {
    const { graph, handler, session } = await emptyGatherFixture('enum Metrics { DTL_BLOCKING_TIME = 917 };\n');
    const lookup = vi.spyOn(graph, 'getNodesByName');
    const query = [...Array.from({ length: 16 }, (_, i) => `missing_${i}`), 'DTL_BLOCKING_TIME'].join(' ');
    const result = await handler.execute('codegraph_explore', { query }, session);
    const text = result.content.map(c => c.text ?? '').join('\n');
    expect(text).toContain('No relevant code found');
    expect(lookup).not.toHaveBeenCalledWith('DTL_BLOCKING_TIME');
    expect(lookup.mock.calls.length).toBeLessThanOrEqual(16);
  }, 30000);

  it('retains the nothing-indexed diagnostic for an empty project', async () => {
    const { handler, session, record } = await emptyGatherFixture(null);
    const result = await handler.execute('codegraph_explore', { query: 'missing_metric' }, session);
    expect(result.content.map(c => c.text ?? '').join('\n')).toContain('This project has nothing indexed.');
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]![0].sourceBytes).toBe(0);
  }, 30000);

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
