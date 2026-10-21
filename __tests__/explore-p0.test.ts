import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
import { QueryBuilder } from '../src/db/queries';
import { Node } from '../src/types';
import { canonicalContextNode, selectContextEntries } from '../src/context/entry-points';
import { extractFromSource } from '../src/extraction/tree-sitter';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { CCppSourceScope } from '../src/extraction/c-cpp-source-scope';

const node = (id: string, extra: Partial<Node> = {}): Node => ({
  id, name: id, qualifiedName: id, kind: 'method', language: 'cpp', filePath: 'a.cpp',
  startLine: 1, endLine: 2, startColumn: 0, endColumn: 1, ...extra,
});

describe('bounded BFS and semantic entries', () => {
  let dir: string, cg: CodeGraph, queries: QueryBuilder;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-p0-'));
    cg = CodeGraph.initSync(dir);
    queries = (cg as any).queries;
  });
  afterEach(() => { cg.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('caps high fan-out per admission and retains admitted structural edges', () => {
    queries.insertNodes([node('root', { kind: 'class' }), ...Array.from({ length: 100 }, (_, i) => node(`n${i}`))]);
    queries.insertEdges(Array.from({ length: 100 }, (_, i) => ({ source: 'root', target: `n${i}`, kind: 'contains' as const })));
    const graph = cg.traverse('root', { limit: 25, direction: 'both' });
    expect(graph.nodes.size).toBe(25);
    expect(graph.edges).toHaveLength(24);
    for (const edge of graph.edges) expect(graph.nodes.has(edge.source) && graph.nodes.has(edge.target)).toBe(true);
    expect(cg.traverse('root', { limit: 0 }).nodes.size).toBe(0);
  });

  it('preserves parallel calls and cycles among retained nodes after reaching the cap', () => {
    queries.insertNodes(['root', 'a', 'b', 'overflow'].map(id => node(id)));
    queries.insertEdges([
      { source: 'root', target: 'a', kind: 'calls', line: 1 },
      { source: 'root', target: 'a', kind: 'calls', line: 2 },
      { source: 'root', target: 'b', kind: 'calls', line: 3 },
      { source: 'a', target: 'b', kind: 'calls', line: 4 },
      { source: 'b', target: 'root', kind: 'calls', line: 5 },
      { source: 'a', target: 'overflow', kind: 'calls', line: 6 },
    ]);
    const graph = cg.traverse('root', { limit: 3, direction: 'outgoing', maxDepth: 3 });
    expect([...graph.nodes.keys()]).toEqual(['root', 'a', 'b']);
    expect(graph.edges.map(e => e.line).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(cg.traverse('root', { maxDepth: 1 }).edges.map(e => e.line).sort()).toEqual([1, 2, 3]);
  });

  it('does not reinsert an excluded start through a cycle', () => {
    queries.insertNodes([node('root'), node('a')]);
    queries.insertEdges([{ source: 'root', target: 'a', kind: 'calls' }, { source: 'a', target: 'root', kind: 'calls' }]);
    const graph = cg.traverse('root', { includeStart: false, limit: 1 });
    expect([...graph.nodes.keys()]).toEqual(['a']);
    expect(graph.edges).toEqual([]);
  });

  it('reserves named types without duplicate declarations or constructor roots', async () => {
    const forward = node('forward', { kind: 'class', name: 'FlowControl', qualifiedName: 'ns::FlowControl', isDeclaration: true });
    const definition = node('definition', { ...forward, id: 'definition', isDeclaration: false });
    const ctor = node('ctor', { name: 'FlowControl', qualifiedName: 'ns::FlowControl::FlowControl' });
    const channel = node('channel', { kind: 'class', name: 'BasicChannel' });
    const metric = node('metric', { kind: 'enum_member', name: 'BLOCKING_TIME' });
    queries.insertNodes([forward, definition, ctor, channel, metric]);
    const results = [forward, definition, ctor].map(n => ({ node: n, score: 100 }));
    const selected = selectContextEntries(queries, 'FlowControl BasicChannel BLOCKING_TIME', results, 3);
    expect(selected.map(r => r.node.id)).toEqual(['definition', 'channel', 'metric']);
    expect(queries.getNodeById('forward')).toBeTruthy();
    expect(selectContextEntries(queries, 'FlowControl BasicChannel BLOCKING_TIME', [
      ...results, { node: node('noise', { name: 'Flow', kind: 'namespace' }), score: 999 },
    ], 8).map(r => r.node.id)).toEqual(['definition', 'channel', 'metric']);
    expect(selectContextEntries(queries, 'ns::FlowControl::FlowControl', results, 1)[0]?.node.id).toBe('ctor');
    // Default traversal kinds omit enum members, but an explicitly named enum
    // value still needs its own entry. An explicit caller filter stays binding.
    const graph = await cg.findRelevantContext('FlowControl BasicChannel BLOCKING_TIME', { searchLimit: 8 });
    expect(graph.roots).toEqual(['definition', 'channel', 'metric']);
    const filtered = await cg.findRelevantContext('FlowControl BLOCKING_TIME', { searchLimit: 8, nodeKinds: ['class'] });
    expect(filtered.roots).not.toContain('metric');
    const bfs = vi.spyOn((cg as any).traverser, 'traverseBFS');
    const single = await cg.findRelevantContext('FlowControl', { searchLimit: 8, maxNodes: 24 });
    expect(single.roots).toEqual(['definition']);
    expect(bfs.mock.calls.every(call => (call[1] as { limit: number }).limit <= 8)).toBe(true);
    bfs.mockRestore();
  });

  it('keeps fuzzy fallback when a query has unresolved symbols or prose', () => {
    const exact = node('exact', { name: 'BasicChannel', kind: 'class' });
    const fuzzy = node('fuzzy', { name: 'connect' });
    queries.insertNodes([exact, fuzzy]);
    expect(selectContextEntries(queries, 'BasicChannel MissingSymbol', [{ node: fuzzy, score: 2 }], 8)
      .map(r => r.node.id)).toEqual(['exact', 'fuzzy']);
    expect(selectContextEntries(queries, 'BasicChannel wait blocking', [{ node: fuzzy, score: 2 }], 8)
      .map(r => r.node.id)).toEqual(['exact', 'fuzzy']);
  });

  it('merges only the matching overload and preserves ambiguous owners', () => {
    const declaration = node('decl', { name: 'wait', qualifiedName: 'left::Channel::wait', signature: 'void wait(int value)', isDeclaration: true });
    const intDef = node('int', { ...declaration, id: 'int', isDeclaration: false, signature: 'void Channel::wait(int)' });
    const doubleDef = node('double', { ...intDef, id: 'double', signature: 'void Channel::wait(double)' });
    const wrongOwner = node('right', { ...intDef, id: 'right', qualifiedName: 'right::Channel::wait' });
    queries.insertNodes([declaration, intDef, doubleDef, wrongOwner]);
    expect(canonicalContextNode(queries, declaration).id).toBe('int');
    queries.insertNodes([node('duplicate', { ...intDef, id: 'duplicate', filePath: 'other.cpp' })]);
    expect(canonicalContextNode(queries, declaration).id).toBe('decl');
  });

  it('does not let namespace-scoped lookups reserve another namespace', () => {
    const left = node('left', { kind: 'class', name: 'SameClass', qualifiedName: 'left::SameClass' });
    const right = node('right', { ...left, id: 'right', qualifiedName: 'right::SameClass' });
    queries.insertNodes([left, right]);
    expect(selectContextEntries(queries, 'right::SameClass', [{ node: left, score: 99 }], 1)[0]?.node.id).toBe('right');
  });
});

describe('C++ source namespace and owner evidence', () => {
  beforeAll(async () => { await initGrammars(); await loadGrammarsForLanguages(['cpp']); });

  it('attaches out-of-line methods to the definition, not a preceding forward declaration', () => {
    const result = extractFromSource('a.cpp', `namespace left {
class Channel;
class Channel { public: int wait(); };
int Channel::wait() { return 1; }
}
namespace right {
class Channel { public: int wait(); };
int Channel::wait() { return 2; }
}`, 'cpp');
    for (const ns of ['left', 'right']) {
      const owner = result.nodes.find(n => n.qualifiedName === `${ns}::Channel` && !n.isDeclaration)!;
      const method = result.nodes.find(n => n.qualifiedName === `${ns}::Channel::wait` && !n.isDeclaration)!;
      expect(owner).toBeTruthy(); expect(method).toBeTruthy();
      expect(result.edges.filter(e => e.target === method.id && e.kind === 'contains')
        .some(e => e.source === owner.id)).toBe(true);
      const forward = result.nodes.find(n => n.qualifiedName === `${ns}::Channel` && n.isDeclaration);
      if (forward) expect(result.edges.some(e => e.source === forward.id && e.target === method.id)).toBe(false);
    }
  });

  it('tracks nested namespaces through comments, literals and conditional function bodies', () => {
    const source = `namespace outer { namespace inner {
void prior() {
  const char *s = "} namespace fake {";
#ifdef FLAG
  if (true) {
#else
  if (false) {
#endif
  }
}
int Channel::wait() { return 0; }
} }
int Global::wait() { return 1; }`;
    const scope = new CCppSourceScope(source);
    expect(scope.namespaceAt(source.indexOf('int Channel'))).toBe('outer::inner');
    expect(scope.namespaceAt(source.indexOf('int Global'))).toBe('');
    const result = extractFromSource('a.cpp', source, 'cpp');
    expect(result.nodes.find(n => n.name === 'wait' && n.startLine === 11)?.qualifiedName).toBe('outer::inner::Channel::wait');
  });

  it('does not guess a namespace across incompatible conditional branches', () => {
    const source = '#if FLAG\nnamespace left {\n#else\nnamespace right {\n#endif\nint ambiguous;';
    expect(new CCppSourceScope(source).namespaceAt(source.indexOf('int ambiguous'))).toBe('');
  });
});
