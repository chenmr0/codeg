import { describe, expect, it } from 'vitest';
import type { Edge, Node, Subgraph } from '../src/types';
import { findEntryProcessingNodes } from '../src/mcp/explore-entry-chain';
import { renderExploreSources, type ExploreSourceFile } from '../src/mcp/explore-selection';

const n = (id: string, kind = 'method', startLine = 1, endLine = 1): Node =>
  ({ id, name: id, qualifiedName: id, kind, startLine, endLine, language: 'typescript' } as Node);
const edge = (source: string, target: string, kind: Edge['kind'] = 'calls'): Edge => ({ source, target, kind });
function fixture() {
  const names = ['dispatch', 'transform', 'write', 'checksum', 'leaf', 'unrelated', 'external', 'deep'];
  const nodes = new Map([n('owner', 'class'), n('other', 'class'), ...names.map(id => n(id))].map(v => [v.id, v]));
  const edges = [
    ...names.map(id => edge(id === 'external' ? 'other' : 'owner', id, 'contains')),
    edge('dispatch', 'transform'), edge('transform', 'write'), edge('write', 'checksum'), edge('checksum', 'deep'),
    edge('dispatch', 'leaf'), edge('unrelated', 'dispatch'), edge('external', 'leaf'), edge('dispatch', 'external'),
  ];
  return { graph: { nodes, edges, roots: ['owner'] } as Subgraph, members: new Set(names) };
}
describe('directed entry processing evidence', () => {
  it('ranks delegation within two directed member hops, excluding leaves and incoming callers', () => {
    const { graph, members } = fixture();
    expect([...findEntryProcessingNodes(graph, members, new Set(['dispatch']))].sort()).toEqual(['transform', 'write']);
  });
  it('uses explicit callable roots without requiring a virtual contract', () => {
    const { graph, members } = fixture(); graph.roots = ['dispatch'];
    expect(findEntryProcessingNodes(graph, members, new Set())).toEqual(new Set(['transform', 'write']));
  });
  it('does not invent entry evidence from degree alone', () => {
    const { graph, members } = fixture();
    expect(findEntryProcessingNodes(graph, members, new Set()).size).toBe(0);
  });
  it('does not treat an incidental literal root as an explicitly requested entry', () => {
    const { graph, members } = fixture(); graph.roots = ['dispatch'];
    expect(findEntryProcessingNodes(graph, members, new Set(), []).size).toBe(0);
  });
  it('deduplicates callsites and terminates cycles without promoting the entry again', () => {
    const { graph, members } = fixture();
    graph.edges.push(edge('dispatch', 'transform'), edge('write', 'dispatch'), edge('transform', 'transform'));
    expect(findEntryProcessingNodes(graph, members, new Set(['dispatch']))).toEqual(new Set(['transform', 'write']));
  });
  it('does not cross owner boundaries or declaration-only processing nodes', () => {
    const { graph, members } = fixture(); graph.nodes.get('write')!.isDeclaration = true;
    expect(findEntryProcessingNodes(graph, members, new Set(['dispatch']))).toEqual(new Set(['transform']));
  });
  it('is invariant to symbol spelling, paths and graph insertion order', () => {
    const { graph, members } = fixture();
    const rename = (id: string) => `Renamed_${id.length}_${id.split('').reverse().join('')}`;
    const renamed: Subgraph = {
      nodes: new Map([...graph.nodes].reverse().map(([id, v]) => [rename(id), { ...v, id: rename(id), name: rename(id), filePath: 'different/module.cc' }])),
      edges: [...graph.edges].reverse().map(e => ({ ...e, source: rename(e.source), target: rename(e.target) })), roots: [rename('owner')],
    };
    expect(findEntryProcessingNodes(renamed, new Set([...members].map(rename)), new Set([rename('dispatch')]))).toEqual(new Set(['transform', 'write'].map(rename)));
  });
});

const body = (id: string, lines: number) => [`function ${id}() {`, ...Array.from({ length: lines - 2 }, (_, i) => `  value += ${i}; // ${id}`), `} // END_${id}`].join('\n');
const source = (path: string, content: string, nodes: Node[], priorities: Record<string, number> = {}): ExploreSourceFile => ({
  path, content, nodes, priority: v => priorities[v.id] ?? 4, connectivity: () => 0, skeleton: false, bodyAllowed: () => true,
});
const render = (files: ExploreSourceFile[], maxOutputChars = 1800, maxCharsPerFile = 450, maxFiles = 12) =>
  renderExploreSources('', files, { maxOutputChars, maxCharsPerFile, maxFiles, lineNumbers: true, headerSymbols: 8 });
describe('budgeted source gaps and entry-chain allocation', () => {
  it('keeps an affordable anchored mechanism before funding a large entry chain', () => {
    const mechanism = source('mechanism.ts', [body('initialize', 8), body('calculate', 8), body('check', 8)].join('\n'),
      [n('initialize', 'method', 1, 8), n('calculate', 'method', 9, 16), n('check', 'method', 17, 24)], { initialize: 0, calculate: 2, check: 2 });
    const task = source('worker.ts', body('dispatch', 5) + '\n' + body('execute', 50),
      [n('dispatch', 'method', 1, 5), n('execute', 'method', 6, 55)], { dispatch: 1.25, execute: 1.5 });
    const out = render([task, mechanism], 2100, 1000);
    for (const name of ['initialize', 'calculate', 'check', 'dispatch']) expect(out).toContain(`END_${name}`);
    expect(out).toContain('worker.ts:6-55 execute; shown none; missing 6-55');
    expect(out.length).toBeLessThanOrEqual(2100);
  });
  it('funds a large processing body ahead of small helpers while protecting a peer', () => {
    const main = source('job.ts', body('handle', 27) + '\n' + body('helper', 10), [n('handle', 'method', 1, 27), n('helper', 'method', 28, 37)], { handle: 1.5, helper: 1.5 });
    main.connectivity = v => v.id === 'handle' ? 10 : 0;
    const peer = source('peer.ts', body('anchor', 4), [n('anchor', 'method', 1, 4)], { anchor: 0 });
    const out = render([main, peer], 1400, 450);
    expect(out).toContain('END_handle'); expect(out).toContain('END_anchor');
    expect(out.length).toBeLessThanOrEqual(1400);
  });
  it('prioritizes a missing entry-chain body over earlier files with many irrelevant omissions', () => {
    const noise = source('framework.ts', Array.from({ length: 9 }, (_, i) => body(`noise${i}`, 40)).join('\n'),
      Array.from({ length: 9 }, (_, i) => n(`noise${i}`, 'method', i * 40 + 1, (i + 1) * 40)));
    const important = source('worker.ts', body('processBatch', 100), [n('processBatch', 'method', 1, 100)], { processBatch: 1.5 });
    const out = render([noise, important], 1800, 400);
    const gaps = out.split('\n').filter(l => l.startsWith('- Omitted body:'));
    expect(gaps[0]).toContain('worker.ts:1-100 processBatch');
    expect(out).toContain('not exhaustive'); expect(out.length).toBeLessThanOrEqual(1800);
  });
  it('reports only the actual remaining lines of a partial body', () => {
    const out = render([source('large.ts', body('large', 100), [n('large', 'method', 1, 100)], { large: 0 })], 950, 450);
    const shown = out.match(/Shown 1-(\d+);/)!;
    expect(shown).not.toBeNull();
    const end = Number(shown[1]);
    expect(out).toContain(`shown 1-${end}; missing ${end + 1}-100`);
    expect(out).not.toContain('END_large');
  });
  it('subtracts several emitted nested spans from an omitted enclosing callable', () => {
    const content = Array.from({ length: 40 }, (_, i) => `statement_${i};`).join('\n');
    const f = source('nested.ts', content, [n('outer', 'method', 1, 40), n('innerA', 'method', 5, 7), n('innerB', 'method', 20, 22)], { innerA: 0, innerB: 0, outer: 2 });
    const out = render([f], 650, 300);
    expect(out).toContain('shown 5-7,20-22; missing 1-4,8-19,23-40');
    expect(out.length).toBeLessThanOrEqual(650);
  });
  it('does not report a nested callable omitted when a complete parent covers it', () => {
    const f = source('nested.ts', body('outer', 12), [n('outer', 'method', 1, 12), n('inner', 'method', 3, 5)], { outer: 0 });
    expect(render([f])).not.toContain('Omitted body:');
  });
  it('reports unadmitted files as missing, without exceeding maxFiles or the output cap', () => {
    const a = source('a.ts', body('a', 4), [n('a', 'method', 1, 4)], { a: 0 });
    const b = source('b.ts', body('b', 4), [n('b', 'method', 1, 4)], { b: 0 });
    const out = render([a, b], 1000, 450, 1);
    expect(out.match(/^#### /gm)).toHaveLength(1);
    expect(out).toContain('b.ts:1-4 b; shown none; missing 1-4');
    expect(out.length).toBeLessThanOrEqual(1000);
  });
});
