import type { QueryBuilder } from '../../src/upstream-explore/db/queries';
import type { Edge, Node, Subgraph, TraversalOptions } from '../../src/upstream-explore/types';

export type BfsQueries = Pick<QueryBuilder,
  'getNodeById' | 'getNodesByIds' | 'getOutgoingEdges' | 'getIncomingEdges'>;

/**
 * Frozen pre-prefetch BFS oracle, from GraphTraverser.traverseBFS and
 * getAdjacentEdges in src/upstream-explore/graph/traversal.ts at
 * faa00f697f5bbbc247e9592babe19302b158399e (2026-11-05).
 * Only extracted the method, inlined adjacency, and removed comments/unused
 * queue.edge. Preserve its eager fetch and all observable legacy semantics;
 * do not refactor it alongside the optimized product traversal.
 */
export function baselineBfs(queries: BfsQueries, startId: string, options: TraversalOptions = {}): Subgraph {
  const opts: Required<TraversalOptions> = {
    maxDepth: Infinity, edgeKinds: [], nodeKinds: [], direction: 'outgoing',
    limit: 1000, includeStart: true, ...options,
  };
  const startNode = queries.getNodeById(startId);
  if (!startNode) return { nodes: new Map(), edges: [], roots: [] };
  const nodes = new Map<string, Node>();
  const edges: Edge[] = [];
  const visited = new Set<string>();
  const enqueued = new Set([startNode.id]);
  const seenEdges = new Set<string>();
  const queue = [{ node: startNode, depth: 0 }];
  if (opts.includeStart) nodes.set(startNode.id, startNode);

  while (queue.length > 0 && nodes.size < opts.limit) {
    const { node, depth } = queue.shift()!;
    if (visited.has(node.id)) continue;
    visited.add(node.id);
    if (depth >= opts.maxDepth) continue;
    const kinds = opts.edgeKinds && opts.edgeKinds.length > 0 ? opts.edgeKinds : undefined;
    const adjacentEdges = opts.direction === 'outgoing'
      ? queries.getOutgoingEdges(node.id, kinds)
      : opts.direction === 'incoming'
        ? queries.getIncomingEdges(node.id, kinds)
        : [...queries.getOutgoingEdges(node.id, kinds), ...queries.getIncomingEdges(node.id, kinds)];
    const priority = (edge: Edge) => edge.kind === 'contains' ? 0 : edge.kind === 'calls' ? 1 : 2;
    adjacentEdges.sort((a, b) => priority(a) - priority(b));
    const wantIds = adjacentEdges
      .map(edge => edge.source === node.id ? edge.target : edge.source)
      .filter(id => !visited.has(id) && !enqueued.has(id));
    const neighborNodes = wantIds.length > 0 ? queries.getNodesByIds(wantIds) : new Map<string, Node>();

    for (const edge of adjacentEdges) {
      const nextId = edge.source === node.id ? edge.target : edge.source;
      const next = neighborNodes.get(nextId) ?? nodes.get(nextId);
      if (!next) continue;
      if (opts.nodeKinds && opts.nodeKinds.length > 0 && !opts.nodeKinds.includes(next.kind)) continue;
      if (!visited.has(nextId) && !enqueued.has(nextId)) {
        if (nodes.size >= opts.limit) continue;
        enqueued.add(nextId);
        nodes.set(next.id, next);
        queue.push({ node: next, depth: depth + 1 });
      }
      const key = `${edge.source}|${edge.target}|${edge.kind}|${edge.line ?? -1}|${edge.column ?? -1}`;
      if (!seenEdges.has(key)) {
        seenEdges.add(key);
        edges.push(edge);
      }
    }
  }
  return { nodes, edges, roots: [startId] };
}
