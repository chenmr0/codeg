import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder, SUPERTYPE_NODE_KINDS } from '../src/db/queries';
import { ReferenceResolver } from '../src/resolution';
import type { ResolutionContext } from '../src/resolution/types';
import type { Node, Language } from '../src/types';

let root: string, connection: DatabaseConnection, queries: QueryBuilder;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-supertype-query-'));
  connection = DatabaseConnection.initialize(path.join(root, 'graph.db'));
  queries = new QueryBuilder(connection.getDb());
});
afterEach(() => {
  vi.restoreAllMocks(); connection?.close();
  const resolved = fs.realpathSync(root);
  if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) ||
      !path.basename(resolved).startsWith('cg-supertype-query-')) throw new Error('Unsafe cleanup');
  fs.rmSync(resolved, { recursive: true, force: true });
});
function node(id: string, kind: Node['kind'], language: Language = 'cpp', qualifiedName = 'N::Type'): Node {
  return {id, kind, language, name: qualifiedName.split('::').pop()!, qualifiedName,
    filePath: 'types.cpp', startLine: 1, endLine: 3, startColumn: 0, endColumn: 1, updatedAt: 1};
}
const context = (resolver: ReferenceResolver) =>
  (resolver as unknown as {context: ResolutionContext}).context;

describe('filtered supertype candidates', () => {
  it('matches the old language/kind filter and stable ordering for both name forms', () => {
    const nodes = SUPERTYPE_NODE_KINDS.map((kind, i) => node(`type-${i}`, kind));
    nodes.push(node('namespace', 'namespace'), node('method', 'method'), node('variable', 'variable'),
      node('other-language', 'class', 'c'), node('other-owner', 'class', 'cpp', 'Other::Type'),
      {...node('declaration', 'class'), isDeclaration: true});
    queries.insertNodes(nodes);
    const keep = (nodes: Node[]) => nodes.filter(n => n.language === 'cpp' && SUPERTYPE_NODE_KINDS.includes(n.kind));
    expect(queries.getSupertypeNodes('Type', 'cpp', false)).toEqual(keep(queries.getNodesByName('Type')));
    expect(queries.getSupertypeNodes('N::Type', 'cpp', true)).toEqual(keep(queries.getNodesByQualifiedNameExact('N::Type')));
    expect(queries.getSupertypeNodes('N::Type', 'c', false)).toEqual([]);
  });

  it('does not hydrate namespace collisions and clears cached misses after node changes', () => {
    queries.insertNodes([node('type', 'namespace'), node('base', 'class', 'cpp', 'N::Base')]);
    const resolver = new ReferenceResolver(root, queries);
    const filtered = vi.spyOn(queries, 'getSupertypeNodes');
    vi.spyOn(queries, 'getNodesByName').mockImplementation(() => { throw new Error('broad name lookup'); });
    vi.spyOn(queries, 'getNodesByQualifiedNameExact').mockImplementation(() => { throw new Error('broad qualified lookup'); });
    expect(context(resolver).getSupertypes!('N::Type', 'cpp')).toEqual([]);
    expect(context(resolver).getSupertypes!('N::Type', 'cpp')).toEqual([]);
    expect(filtered).toHaveBeenCalledTimes(1);

    queries.updateNode({...node('type', 'class'), startLine: 5});
    queries.insertEdges([{source:'type', target:'base', kind:'extends'}]);
    resolver.clearCaches();
    expect(context(resolver).getSupertypes!('N::Type', 'cpp')).toEqual(['N::Base']);
    expect(context(resolver).hasCppInheritance!('N::Type')).toBe(true);
    expect(filtered).toHaveBeenCalledTimes(2);
  });

  it('retains pending C++ base resolution before its edge has been persisted', () => {
    queries.insertNodes([node('type', 'class'), node('base', 'class', 'cpp', 'N::Base')]);
    queries.insertUnresolvedRefsBatch([{fromNodeId:'type', referenceName:'N::Base', referenceKind:'extends',
      filePath:'types.cpp', language:'cpp', line:1, column:0}]);
    const resolver = new ReferenceResolver(root, queries);
    resolver.warmCaches();
    expect(context(resolver).getSupertypes!('N::Type', 'cpp')).toEqual(['N::Base']);
    expect(context(resolver).hasCppInheritance!('N::Type')).toBe(true);
    expect(queries.getOutgoingEdges('type', ['extends'])).toEqual([]);
  });
});
