import type { Subgraph } from '../types';

/** Bounded, directed delegation within a source-proven owner. Degree alone
 * cannot turn an unrelated utility or an incoming caller into an entry path. */
export function findEntryProcessingNodes(
  graph: Subgraph, members: Set<string>, contracts: Set<string>, explicitRoots: Iterable<string> = graph.roots,
): Set<string> {
  const owners = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (edge.kind !== 'contains' || !members.has(edge.target)) continue;
    const owner = graph.nodes.get(edge.source);
    if (!owner || !['class', 'struct', 'interface', 'trait', 'protocol'].includes(owner.kind)) continue;
    const ids = owners.get(edge.target) ?? new Set<string>();
    ids.add(edge.source); owners.set(edge.target, ids);
  }
  const calls = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (edge.kind !== 'calls' || edge.source === edge.target
      || !members.has(edge.source) || !members.has(edge.target)) continue;
    const sourceOwners = owners.get(edge.source), targetOwners = owners.get(edge.target);
    if (!sourceOwners || !targetOwners || ![...sourceOwners].some(id => targetOwners.has(id))) continue;
    const targets = calls.get(edge.source) ?? new Set<string>();
    targets.add(edge.target); calls.set(edge.source, targets);
  }
  const roots = [...new Set([...contracts, ...explicitRoots])].filter(id => {
    const n = graph.nodes.get(id);
    return members.has(id) && n && !n.isDeclaration && !n.name.startsWith('~')
      && ![...owners.get(id) ?? []].some(owner => graph.nodes.get(owner)?.name === n.name);
  });
  const depth = new Map(roots.map(id => [id, 0]));
  const queue = [...roots];
  const result = new Set<string>();
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!, d = depth.get(id)!;
    if (d >= 2) continue;
    for (const next of calls.get(id) ?? []) {
      if (depth.has(next)) continue;
      depth.set(next, d + 1); queue.push(next);
      // Prefer processing/delegation over leaf accessors. Leaves remain ordinary
      // members and can still be selected by explicit queries or other evidence.
      if (calls.get(next)?.size && !graph.nodes.get(next)?.isDeclaration) result.add(next);
    }
  }
  return result;
}
