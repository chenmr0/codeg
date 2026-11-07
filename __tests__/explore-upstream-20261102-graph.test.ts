/** Query-only parity regressions against upstream f72c9d2e; no indexing required. */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { flowTokens, resolveNamedSymbolFlow } from '../src/upstream-explore/graph/named-symbol-flow';
import { matchesSymbol } from '../src/upstream-explore/graph/symbol-lookup';
import { goPackageReaderFor } from '../src/upstream-explore/graph/go-package';
import { extractSearchTerms } from '../src/upstream-explore/search/query-utils';
import { GraphTraverser } from '../src/upstream-explore/graph/traversal';
import type { ExploreGraph } from '../src/upstream-explore';
import type { QueryBuilder } from '../src/upstream-explore/db/queries';
import type { Edge, Node } from '../src/upstream-explore/types';

const node = (name: string, extra: Partial<Node> = {}): Node => ({
  id: name, name, qualifiedName: name, kind: 'function', language: 'typescript',
  filePath: 'src/a.ts', startLine: 1, endLine: 1, startColumn: 0, endColumn: 0,
  updatedAt: 0, ...extra,
});

function graph(names: string[], pairs: Array<[string, string]>, kind: Edge['kind'] = 'calls') {
  const nodes = new Map(names.map(name => [name, node(name)]));
  const edges = pairs.map(([source, target]) => ({ source, target, kind, line: 1 } as Edge));
  const outgoing = (id: string) => edges.filter(edge => edge.source === id);
  const incoming = (id: string) => edges.filter(edge => edge.target === id);
  const queries = {
    getNodeById: (id: string) => nodes.get(id),
    getNodesByIds: (ids: string[]) => new Map(ids.filter(id => nodes.has(id)).map(id => [id, nodes.get(id)!])),
    getOutgoingEdges: outgoing, getIncomingEdges: incoming,
  } as unknown as QueryBuilder;
  const api = {
    getProjectRoot: () => '/unavailable-project',
    getNodesByName: (name: string) => nodes.has(name) ? [nodes.get(name)!] : [],
    searchNodes: () => [], getOutgoingEdges: outgoing, getIncomingEdges: incoming,
    getCallees: (id: string) => outgoing(id).map(edge => ({ node: nodes.get(edge.target)!, edge, depth: 1 })),
    getCallers: (id: string) => incoming(id).map(edge => ({ node: nodes.get(edge.source)!, edge, depth: 1 })),
    generatedFilePredicate: () => () => false,
  } as unknown as ExploreGraph;
  return { nodes, queries, api };
}

describe('upstream query and graph parity, 2026-11-02', () => {
  it('retains two-character CJK flow tokens and Korean search terms', () => {
    expect(flowTokens('入口 末端')).toEqual(['入口', '末端']);
    expect(extractSearchTerms('로그인 인증확인')).toEqual(['로그인', '인증확인']);
  });

  it('matches a whole qualified scope, not a suffix or a misleading filename', () => {
    expect(matchesSymbol(node('Price', {
      kind: 'method', qualifiedName: 'LegacyFormat::Price', filePath: 'Format.cs', language: 'csharp',
    }), 'Format.Price')).toBe(false);
    expect(matchesSymbol(node('Price', {
      kind: 'method', qualifiedName: 'Format::Price', filePath: 'Pricing.cs', language: 'csharp',
    }), 'Format.Price')).toBe(true);
  });

  it('uses verified Go source for a root package qualifier', () => {
    const readPackage = goPackageReaderFor({
      getProjectRoot: () => '/unavailable-project', getVerifiedSource: () => 'package gin\n',
    });
    expect(readPackage!('context.go')).toBe('gin');
    expect(matchesSymbol(node('Next', {
      kind: 'method', qualifiedName: 'Context::Next', filePath: 'context.go', language: 'go',
    }), 'gin.Context.Next', readPackage)).toBe(true);
  });

  it('never falls back to disk when the native source verifier rejects a file', () => {
    const root = mkdtempSync(join(tmpdir(), 'explore-go-snapshot-'));
    try {
      writeFileSync(join(root, 'context.go'), 'package unsafeDiskPackage\n');
      let reads = 0;
      const readPackage = goPackageReaderFor({
        getProjectRoot: () => root,
        getVerifiedSource: () => { reads++; return undefined; },
      });
      expect(readPackage!('context.go')).toBeNull();
      expect(readPackage!('context.go')).toBeNull();
      expect(reads).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const fixture = () => graph(['entry', 'mid1', 'mid2', 'deep', 'leaf'], [
    ['entry', 'mid1'], ['entry', 'mid2'], ['mid1', 'deep'], ['mid2', 'leaf'], ['deep', 'leaf'],
  ]);
  it('keeps the named step when a shorter route reached the sink first', () => {
    const result = resolveNamedSymbolFlow(fixture().api, 'entry deep leaf');
    expect(result.chains[0]?.steps.map(step => step.node.name)).toEqual(['entry', 'mid1', 'deep', 'leaf']);
  });

  it('retains the unnamed bridge budget', () => {
    const result = resolveNamedSymbolFlow(fixture().api, 'entry leaf');
    expect(result.chains[0]?.steps.map(step => step.node.name)).toEqual(['entry', 'mid2', 'leaf']);
  });

  it('returns a shortest path with the linear predecessor walk', () => {
    const traverser = new GraphTraverser(fixture().queries);
    expect(traverser.findPath('entry', 'leaf')?.map(step => step.node.name)).toEqual(['entry', 'mid2', 'leaf']);
  });

  it('walks ancestors and descendants independently in a type hierarchy', () => {
    const fixture = graph(['Base', 'Derived'], [['Derived', 'Base']], 'extends');
    fixture.nodes.forEach(value => { value.kind = 'class'; });
    const traverser = new GraphTraverser(fixture.queries);
    expect(traverser.getTypeHierarchy('Base').nodes.has('Derived')).toBe(true);
    expect(traverser.getTypeHierarchy('Derived').nodes.has('Base')).toBe(true);
  });
});
