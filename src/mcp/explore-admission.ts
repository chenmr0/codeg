import type { Edge, Node, Subgraph } from '../types';

export interface ExploreNeighbor { node: Node; edge: Edge }
export interface AdmissionAudit {
  reservedPerRoot: number;
  reclaimedNodes: number;
  omittedNodeIds: string[];
  reclaimRejectedNodeIds: string[];
  reason: 'global-node-limit' | null;
}

/** Fair bounded BFS. Unused per-root reservations return to the shared pool;
 * a rejected candidate is never confused with an absent symbol. Source output
 * budgets and graph depth are independent of this admission budget. */
export function admitExploreGraph(
  roots: Node[], neighborsOf: (node: Node) => ExploreNeighbor[], maxNodes = 200, maxDepth = 3,
  canReclaim: (node: Node) => boolean = () => true,
): { graph: Subgraph; audit: AdmissionAudit } {
  const limit = Math.max(0, Math.floor(maxNodes));
  const uniqueRoots = [...new Map(roots.map(n => [n.id, n])).values()].slice(0, limit);
  const nodes = new Map(uniqueRoots.map(n => [n.id, n]));
  const states = uniqueRoots.map(node => ({
    seen: new Set([node.id]), queue: [{ node, depth: 0, next: 0 }], position: 0,
  }));
  const cache = new Map<string, ExploreNeighbor[]>();
  const edges = new Map<string, Edge>();
  const omitted = new Set<string>();
  const reclaimRejected = new Set<string>();
  const reserved = Math.ceil(limit / Math.max(1, uniqueRoots.length));
  const advance = (state: typeof states[number], allowance: number): boolean => {
    if (state.seen.size >= allowance) return false;
    while (state.position < state.queue.length) {
      const item = state.queue[state.position]!;
      if (item.depth >= maxDepth) { state.position++; continue; }
      let neighbors = cache.get(item.node.id);
      if (!neighbors) {
        neighbors = neighborsOf(item.node);
        cache.set(item.node.id, neighbors);
        for (const { edge } of neighbors) {
          const key = JSON.stringify([edge.source, edge.target, edge.kind, edge.line, edge.column]);
          edges.set(key, edge);
        }
      }
      while (item.next < neighbors.length) {
        const next = neighbors[item.next++]!;
        if (state.seen.has(next.node.id)) continue;
        if (allowance === Infinity && !nodes.has(next.node.id) && !canReclaim(next.node)) {
          reclaimRejected.add(next.node.id); continue;
        }
        if (!nodes.has(next.node.id) && nodes.size >= limit) {
          omitted.add(next.node.id); continue;
        }
        state.seen.add(next.node.id);
        nodes.set(next.node.id, next.node);
        state.queue.push({ node: next.node, depth: item.depth + 1, next: 0 });
        return true;
      }
      state.position++;
    }
    return false;
  };
  // Each live root gets a turn before any one root can spend another's share.
  const drain = (allowance: number) => {
    let progressed: boolean;
    do {
      progressed = false;
      for (const state of states) if (advance(state, allowance)) progressed = true;
    } while (progressed);
  };
  drain(reserved);
  const reservedSize = nodes.size;
  // Resume frontiers for evidenced targets, not an unconditional wider survey.
  // Extra low-relevance neighbors otherwise displace already sufficient source
  // at rendering time despite the unchanged character budget.
  drain(Infinity);
  const finalEdges = [...edges.values()].filter(e => nodes.has(e.source) && nodes.has(e.target));
  const omittedNodeIds = [...omitted].filter(id => !nodes.has(id));
  return { graph: { nodes, edges: finalEdges, roots: uniqueRoots.map(n => n.id) },
    audit: { reservedPerRoot: reserved, reclaimedNodes: nodes.size - reservedSize,
      omittedNodeIds, reclaimRejectedNodeIds: [...reclaimRejected].filter(id => !nodes.has(id)),
      reason: omittedNodeIds.length ? 'global-node-limit' : null } };
}
