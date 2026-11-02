import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import CodeGraph from '../src/index';
import type { Edge, Node, Subgraph } from '../src/types';
import { collectExploreFocusLines, preserveExploreCallOrigin } from '../src/mcp/explore-focus';
import { ExploreSourceSnapshots } from '../src/mcp/explore-source';
import { ExploreSemanticView } from '../src/mcp/explore-semantic';
import { retrieveExploreContext } from '../src/mcp/explore-retrieval';
import { resolveExploreTargets, supplementExploreTargets } from '../src/mcp/explore-targets';
import { ToolHandler } from '../src/mcp/tools';

const callable = (id: string, extra: Partial<Node> = {}): Node => ({ id, name: id, qualifiedName: `Pipe::${id}`,
  kind: 'method', filePath: 'pipe.cpp', language: 'cpp', startLine: 3, endLine: 30,
  startColumn: 0, endColumn: 1, updatedAt: 0, ...extra });
const caller = callable('step'), target = callable('save', { startLine: 40, endLine: 45 });
const edge = (line: number, extra: Partial<Edge> = {}): Edge => ({ source: caller.id, target: target.id,
  kind: 'calls', line, column: 2, provenance: 'tree-sitter', ...extra });
const graph = (edges: Edge[], nodes = [caller, target]): Subgraph => ({
  nodes: new Map(nodes.map(n => [n.id, n])), roots: [caller.id], edges,
});
const snapshots = (status = 'fresh') => ({ get: () => ({ status, content: '\n'.repeat(60) }) } as unknown as ExploreSourceSnapshots);
const origin = (e: Edge, source = caller) => preserveExploreCallOrigin(e, source);

describe('call-site origin survives canonical graph endpoints', () => {
  it('preserves original metadata and coordinates without mutating the indexed edge', () => {
    const original = edge(7, { metadata: { custom: 'retained' } });
    const copy = origin(original);
    expect(copy).toEqual({ ...original, metadata: { custom: 'retained',
      exploreSourceFile: 'pipe.cpp', exploreSourceNodeId: 'step' } });
    expect(original.metadata).toEqual({ custom: 'retained' });
    expect(preserveExploreCallOrigin(copy, undefined).metadata?.exploreSourceFile).toBeUndefined();
    const containment: Edge = { source: 'owner', target: 'step', kind: 'contains' };
    expect(origin(containment)).toBe(containment);
  });
  it('rejects coincident header line numbers after a source endpoint is canonicalized', () => {
    const declaration = callable('step-decl', { filePath: 'pipe.h', isDeclaration: true });
    const merged = { ...origin(edge(8, { source: declaration.id }), declaration), source: caller.id };
    expect(collectExploreFocusLines(graph([merged]), snapshots(), new Set([target.id])).size).toBe(0);
    expect(collectExploreFocusLines(graph([origin(edge(8))]), snapshots(), new Set([target.id])).get(caller.id)).toEqual([8]);
  });
  it('keeps distinct parallel call sites but never puts a caller line into the callee', () => {
    const result = collectExploreFocusLines(graph([origin(edge(8)), origin(edge(12)), origin(edge(8, { column: 9 }))]),
      snapshots(), new Set([target.id]));
    expect(result.get(caller.id)).toEqual([8, 12]);
    expect(result.has(target.id)).toBe(false);
  });
  it('excludes out-of-body, stale, declaration, and unproven origin locations', () => {
    const invalid = [origin(edge(2)), origin(edge(31)), origin(edge(8.5)), edge(8)];
    expect(collectExploreFocusLines(graph(invalid), snapshots(), new Set([target.id])).size).toBe(0);
    expect(collectExploreFocusLines(graph([origin(edge(8))]), snapshots('changed'), new Set([target.id])).size).toBe(0);
    expect(collectExploreFocusLines(graph([origin(edge(8))], [{ ...caller, isDeclaration: true }, target]),
      snapshots(), new Set([target.id])).size).toBe(0);
  });
  it('excludes heuristic registration/wiring locations even when their line lies inside a body', () => {
    const synthetic = [origin(edge(8, { provenance: 'heuristic' })),
      origin(edge(9, { provenance: undefined, metadata: { synthesizedBy: 'event-emitter' } })),
      origin(edge(10, { metadata: { registeredAt: 'pipe.cpp:10' } }))];
    expect(collectExploreFocusLines(graph(synthetic), snapshots(), new Set([target.id])).size).toBe(0);
  });
  it('prioritizes favored targets over proven same-owner members with a bounded unique result', () => {
    const sibling = callable('helper'), type = callable('owner', { kind: 'class', qualifiedName: 'Pipe' });
    const edges: Edge[] = [caller, target, sibling].map(n => ({ source: type.id, target: n.id, kind: 'contains' }));
    edges.push(...Array.from({ length: 10 }, (_, i) => origin(edge(i + 4, { target: sibling.id }))));
    edges.push(origin(edge(25)), origin(edge(28)));
    const result = collectExploreFocusLines(graph(edges, [caller, target, sibling, type]), snapshots(), new Set([target.id]));
    expect(result.get(caller.id)).toEqual([25, 28, 4, 5, 6, 7, 8, 9]);
    expect(collectExploreFocusLines(graph([origin(edge(8))]), snapshots(), new Set()).size).toBe(0);
  });
  it('uses a favored caller as a bounded fallback without admitting unnamed cross-owner calls', () => {
    const unrelated = callable('external', { filePath: 'external.cpp', qualifiedName: 'Other::external' });
    const calls = Array.from({ length: 9 }, (_, i) => origin(edge(i + 4, { target: unrelated.id })));
    calls.push(origin(edge(27)));
    const g = graph(calls, [caller, target, unrelated]);
    expect(collectExploreFocusLines(g, snapshots(), new Set()).size).toBe(0);
    expect(collectExploreFocusLines(g, snapshots(), new Set([caller.id, target.id])).get(caller.id))
      .toEqual([27, 4, 5, 6, 7, 8, 9, 10]);
    const unsafe = graph([origin(edge(8, { target: unrelated.id, provenance: 'heuristic' })),
      { ...origin(edge(9, { target: unrelated.id })), metadata: { exploreSourceFile: 'elsewhere.h' } }], [caller, unrelated]);
    expect(collectExploreFocusLines(unsafe, snapshots(), new Set([caller.id])).size).toBe(0);
    expect(collectExploreFocusLines(g, snapshots('changed'), new Set([caller.id])).size).toBe(0);
  });
});

describe('real C++ declaration/definition call-site provenance', () => {
  let root: string, cg: CodeGraph;
  let lateLines: number[];
  beforeAll(async () => {
    vi.stubEnv('CODEGRAPH_ENABLE_EXPLORE', '1');
    vi.stubEnv('CODEGRAPH_EXPLORE_LINENUMS', '1');
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-focus-p3-'));
    fs.writeFileSync(path.join(root, 'worker.h'), `namespace grove {\nclass BatchWorker { public:\n int run(int value);\n int run(double value);\n int save();\n};\n}\n`);
    fs.writeFileSync(path.join(root, 'worker.cpp'), `#include "worker.h"\nnamespace grove {\nint BatchWorker::run(int value) {\n  const int first = save();\n  return first + save() + value;\n}\nint BatchWorker::run(double value) {\n  return save() + 2;\n}\nint BatchWorker::save() { return 9; }\n}\n`);
    const entry = ["import { verifyProbe, storeProbe } from './probe-targets';", '',
      'export function smallProbe(value: number) { return value & 1; }', '',
      'export function largeProbe(value: number) {', '  let state = value;'];
    for (let i = 0; i < 260; i++) entry.push(`  state = (state + ${i}) >>> 0; // ${'deterministic arithmetic '.repeat(3)}`);
    lateLines = [entry.length + 1, entry.length + 2];
    entry.push('  const checked = verifyProbe(state);', '  return storeProbe(checked);', '}');
    fs.writeFileSync(path.join(root, 'probe-entry.ts'), entry.join('\n'));
    fs.writeFileSync(path.join(root, 'probe-targets.ts'), 'export function verifyProbe(value: number) { return Math.max(value, 0); }\nexport function storeProbe(value: number) { return value; }\n');
    cg = CodeGraph.initSync(root, { config: { include: ['**/*.cpp', '**/*.h', '**/*.ts'], exclude: [] } });
    await cg.indexAll();
  });
  afterAll(() => {
    cg?.close();
    const relative = path.relative(os.tmpdir(), root);
    if (!relative.startsWith('cg-focus-p3-') || relative.includes(path.sep)) throw new Error('unsafe fixture cleanup');
    fs.rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  it('keeps each overload and actual definition call sites in the retrieval graph', async () => {
    const result = await retrieveExploreContext(cg, 'BatchWorker run save');
    const runs = result.lookup('run');
    expect(runs).toHaveLength(2);
    expect(runs.every(n => n.filePath === 'worker.cpp' && !n.isDeclaration)).toBe(true);
    const focus = collectExploreFocusLines(result.graph, result.sources, new Set(result.lookup('save').map(n => n.id)));
    expect(focus.get(runs.find(n => n.signature?.includes('int value'))!.id)).toEqual([4, 5]);
    expect(focus.get(runs.find(n => n.signature?.includes('double value'))!.id)).toEqual([8]);
    expect(result.graph.edges.filter(e => e.kind === 'calls').every(e => e.metadata?.exploreSourceFile)).toBe(true);
  });
  it('also preserves original call coordinates during exact-target supplementation', () => {
    const sources = new ExploreSourceSnapshots(cg), view = new ExploreSemanticView(cg, sources);
    const resolved = resolveExploreTargets(cg, 'grove::BatchWorker::run grove::BatchWorker::save', view, sources);
    const supplemented: Subgraph = { nodes: new Map(), edges: [], roots: [] };
    supplementExploreTargets(cg, view, supplemented, resolved);
    const save = [...supplemented.nodes.values()].find(n => n.name === 'save')!;
    const focus = collectExploreFocusLines(supplemented, sources, new Set([save.id]));
    expect([...focus.values()].flat().sort((a, b) => a - b)).toEqual([4, 5, 8]);
    expect(supplemented.edges.filter(e => e.kind === 'calls').every(e =>
      e.metadata?.exploreSourceFile === 'worker.cpp' && !!e.metadata.exploreSourceNodeId)).toBe(true);
  });
  it('delivers late calls from a named free-function body even when the query has no renderable Flow', async () => {
    const handler = new ToolHandler(cg);
    const result = await handler.execute('explore', { query: 'smallProbe largeProbe', maxFiles: 3 });
    expect(result.isError).not.toBe(true);
    const text = result.content.filter(c => c.type === 'text').map(c => (c as { text: string }).text).join('\n');
    expect(text).not.toContain('## Flow');
    expect(text).toContain('3\texport function smallProbe');
    expect(text).toContain(`${lateLines[0]}\t  const checked = verifyProbe(state);`);
    expect(text).toContain(`${lateLines[1]}\t  return storeProbe(checked);`);
    expect(text).toContain('Omitted body: probe-entry.ts:5-');
    expect(text.length).toBeLessThanOrEqual(13000);
  });
});
