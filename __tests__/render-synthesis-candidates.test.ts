import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { synthesizeCallbackEdges } from '../src/resolution/callback-synthesizer';
import type { Edge, Language, Node } from '../src/types';
import type { ResolutionContext } from '../src/resolution/types';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// Baseline implementation: compare complete ordered edge payloads, rather than
// just edge counts, including the first render child and per-class fanout cap.
function legacyRenderEdges(queries: QueryBuilder, context: ResolutionContext): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const cls of queries.getNodesByKind('class')) {
    const children = queries.getOutgoingEdges(cls.id, ['contains'])
      .map((edge) => queries.getNodeById(edge.target))
      .filter((node): node is Node => !!node && node.kind === 'method');
    const render = children.find((node) => node.name === 'render');
    if (!render) continue;
    let added = 0;
    for (const method of children) {
      if (added >= 40) break;
      if (method.id === render.id) continue;
      const content = context.readFile(method.filePath);
      const source = content && method.startLine && method.endLine
        ? content.split('\n').slice(method.startLine - 1, method.endLine).join('\n') : null;
      if (!source || !/this\.setState\s*\(/.test(source)) continue;
      const key = `${method.id}>${render.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source: method.id, target: render.id, kind: 'calls', line: method.startLine,
        provenance: 'heuristic', metadata: {
          synthesizedBy: 'react-render', via: 'setState',
          registeredAt: `${render.filePath}:${render.startLine}`,
        } });
      added++;
    }
  }
  return edges;
}

describe('indexed render owner candidates', () => {
  it.each(['default', 'all'] as const)('preserves ordered legacy edges in %s scope', async (scope) => {
    vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', scope === 'all' ? '1' : '0');
    vi.stubEnv('CODEGRAPH_NO_SYNTHESIS', '0');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-render-candidates-'));
    const connection = DatabaseConnection.initialize(path.join(directory, 'graph.db'));
    const queries = new QueryBuilder(connection.getDb());
    const sources = new Map<string, string>();
    const makeNode = (id: string, name: string, kind: Node['kind'], language: Language): Node => ({
      id, name, qualifiedName: id, kind, language, filePath: `${id}.${language}`,
      startLine: 1, endLine: 1, startColumn: 0, endColumn: 16,
    });
    const nodes: Node[] = [];
    const contains: Edge[] = [];
    const add = (node: Node, source = '') => {
      nodes.push(node);
      sources.set(node.filePath, source);
      return node;
    };
    const connect = (owner: Node, child: Node, line = 1) =>
      contains.push({ source: owner.id, target: child.id, kind: 'contains', line });
    try {
      // Many irrelevant classes must never trigger contains lookups. Insertion
      // order intentionally opposes name order for the actual candidates.
      for (let i = 0; i < 300; i++) add(makeNode(`noise-${i}`, 'Unrelated', 'class', 'python'));
      const languageList: Language[] = scope === 'all'
        ? ['python', 'javascript', 'java', 'vue', 'svelte', 'cpp']
        : ['python', 'cpp', 'objc', 'lua'];
      for (const [index, language] of languageList.entries()) {
        const owner = add(makeNode(`z-owner-${index}`, 'Owner', 'class', language));
        const secondOwner = add(makeNode(`a-owner-${index}`, 'OtherOwner', 'class', language));
        const render = add(makeNode(`render-${index}`, 'render', 'method', language));
        const secondRender = add(makeNode(`render-second-${index}`, 'render', 'method', language));
        connect(owner, render);
        connect(owner, render, 2); // repeated contains edge must not duplicate the owner
        connect(owner, secondRender);
        connect(secondOwner, render); // one render method can have several owners
        for (let i = 0; i < 45; i++) {
          const mutate = add(makeNode(`mutate-${index}-${i}`, 'mutate', 'method', language), 'this.setState({})');
          connect(owner, mutate);
          if (i === 0) connect(secondOwner, mutate); // global duplicate edge suppression
        }
        const impostor = add(makeNode(`function-${index}`, 'render', 'function', language));
        const falseOwner = add(makeNode(`false-owner-${index}`, 'FalseOwner', 'class', language));
        connect(falseOwner, impostor);
      }
      add(makeNode('orphan-render', 'render', 'method', 'python'));
      queries.insertNodes(nodes);
      queries.insertEdges(contains);
      for (const language of languageList) {
        queries.upsertFile({ path: `manifest.${language}`, language, contentHash: language,
          size: 1, modifiedAt: 1, indexedAt: 1, nodeCount: 1 });
      }
      const context: ResolutionContext = {
        getNodesInFile: (file) => queries.getNodesByFile(file),
        getNodesByName: (name) => queries.getNodesByName(name),
        getNodesByQualifiedName: (name) => queries.getNodesByQualifiedNameExact(name),
        getNodesByKind: (kind) => queries.getNodesByKind(kind),
        getNodesByLowerName: () => [], getAllFiles: () => [...sources.keys()],
        getProjectRoot: () => directory, getImportMappings: () => [],
        fileExists: (file) => sources.has(file), readFile: (file) => sources.get(file) ?? null,
      };
      const legacy = legacyRenderEdges(queries, context);
      expect(legacy).toHaveLength(languageList.length * 40);
      const expectedOwners = queries.getNodesByKind('class').filter((owner) =>
        queries.getOutgoingEdges(owner.id, ['contains']).some((edge) => {
          const child = queries.getNodeById(edge.target);
          return child?.kind === 'method' && child.name === 'render';
        }));
      expect(queries.getClassesContainingMethod('render')).toEqual(expectedOwners);
      // Without ANALYZE, an IN subquery can make SQLite scan idx_nodes_kind
      // for every class. Inspect the exact prepared query on this fresh DB.
      const prepare = vi.spyOn(connection.getDb(), 'prepare');
      const freshQueries = new QueryBuilder(connection.getDb());
      freshQueries.getClassesContainingMethod('render');
      const candidateSql = prepare.mock.calls.find(([sql]) => sql.includes('AS method INDEXED BY idx_nodes_name'))![0];
      const plan = connection.getDb().prepare(`EXPLAIN QUERY PLAN ${candidateSql}`).all('render') as Array<{ detail: string }>;
      expect(plan.some((row) => /SEARCH method USING INDEX idx_nodes_name/.test(row.detail))).toBe(true);
      expect(plan.some((row) => /SEARCH owner .*\(id=\?\)/.test(row.detail))).toBe(true);
      expect(plan.some((row) => /SCAN owner|SEARCH owner USING INDEX idx_nodes_kind/.test(row.detail))).toBe(false);
      const staged: Edge[] = [];
      const originalStage = queries.stageSynthesisEdges.bind(queries);
      vi.spyOn(queries, 'stageSynthesisEdges').mockImplementation((edges) => {
        staged.push(...edges.filter((edge) => edge.metadata?.synthesizedBy === 'react-render'));
        return originalStage(edges);
      });
      // Other legitimate passes still inspect classes in mixed projects;
      // capture the dedicated candidate lookup and compare its emitted edges.
      const owners = vi.spyOn(queries, 'getClassesContainingMethod');
      expect((await synthesizeCallbackEdges(queries, context)).complete).toBe(true);
      expect(owners).toHaveBeenCalledWith('render');
      expect(staged).toEqual(legacy);
      expect(staged.some((edge) => edge.source.startsWith('mutate-0-'))).toBe(true);

      // The prepared statement is live across sync updates; it is not a
      // cached candidate set that can miss a newly renamed render method.
      const orphan = queries.getNodeById('orphan-render')!;
      queries.updateNode({ ...orphan, name: 'ordinary' });
      expect(queries.getClassesContainingMethod('ordinary')).toEqual([]);
      const newOwner = nodes.find((node) => node.id === 'noise-0')!;
      queries.insertEdges([{ source: newOwner.id, target: orphan.id, kind: 'contains' }]);
      expect(queries.getClassesContainingMethod('ordinary')).toEqual([queries.getNodeById(newOwner.id)]);
    } finally {
      connection.close();
      const resolved = path.resolve(directory);
      if (path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
          !path.basename(resolved).startsWith('cg-render-candidates-')) {
        throw new Error('Unexpected test directory');
      }
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  });

  it('never scans unrelated classes when the graph has no render method', async () => {
    vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', '0');
    vi.stubEnv('CODEGRAPH_NO_SYNTHESIS', '0');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-render-candidates-'));
    const connection = DatabaseConnection.initialize(path.join(directory, 'graph.db'));
    const queries = new QueryBuilder(connection.getDb());
    try {
      queries.insertNodes(Array.from({ length: 2_000 }, (_, index): Node => ({
        id: `class-${index}`, name: `Class${index}`, qualifiedName: `Class${index}`,
        kind: 'class', language: 'python', filePath: 'classes.py',
        startLine: index + 1, endLine: index + 1, startColumn: 0, endColumn: 1,
      })));
      queries.upsertFile({ path: 'classes.py', language: 'python', contentHash: 'classes',
        size: 1, modifiedAt: 1, indexedAt: 1, nodeCount: 2_000 });
      const getKind = queries.getNodesByKind.bind(queries);
      const classScans = vi.spyOn(queries, 'getNodesByKind').mockImplementation((kind) => {
        if (kind === 'class') throw new Error('Unexpected full class scan');
        return getKind(kind);
      });
      const outgoing = vi.spyOn(queries, 'getOutgoingEdges');
      const context: ResolutionContext = {
        getNodesInFile: () => [], getNodesByName: () => [], getNodesByQualifiedName: () => [],
        getNodesByKind: (kind) => queries.getNodesByKind(kind), getNodesByLowerName: () => [],
        getAllFiles: () => [], getProjectRoot: () => directory,
        getImportMappings: () => [], fileExists: () => false, readFile: () => null,
      };
      expect(await synthesizeCallbackEdges(queries, context)).toEqual({
        edgesAdded: 0, complete: true, diagnostics: [],
      });
      expect(classScans.mock.calls.some(([kind]) => kind === 'class')).toBe(false);
      expect(outgoing).not.toHaveBeenCalled();
    } finally {
      connection.close();
      const resolved = path.resolve(directory);
      if (path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
          !path.basename(resolved).startsWith('cg-render-candidates-')) {
        throw new Error('Unexpected test directory');
      }
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  });
});
