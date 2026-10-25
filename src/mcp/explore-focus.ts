import type { Edge, Node, Subgraph } from '../types';
import { EXPLORE_CALLABLES, EXPLORE_TYPES } from './explore-semantic';
import type { ExploreSourceSnapshots } from './explore-source';

/** Record a call site's file before C/C++ declaration/definition endpoints are
 * canonicalized. Rewriting an endpoint must never relocate its line number. */
export function preserveExploreCallOrigin(edge: Edge, source: Node | null | undefined): Edge {
  if (edge.kind !== 'calls') return edge;
  return { ...edge, metadata: { ...edge.metadata,
    exploreSourceNodeId: edge.source,
    exploreSourceFile: source?.filePath,
  } };
}

/** Verified call sites for bounded source windows, not additional graph recall.
 * An incoming edge describes its caller's line, never its target's line. Only
 * source-origin metadata survives canonicalization safely; coincident header
 * and implementation line numbers are not evidence of an implementation call.
 * Synthetic registrations remain useful graph edges but not body locations. */
export function collectExploreFocusLines(
  graph: Subgraph, sources: ExploreSourceSnapshots, favoredIds: ReadonlySet<string>,
): Map<string, number[]> {
  const owners = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (edge.kind !== 'contains' || !EXPLORE_TYPES.has(graph.nodes.get(edge.source)?.kind ?? '')) continue;
    const ids = owners.get(edge.target) ?? new Set<string>();
    ids.add(edge.source); owners.set(edge.target, ids);
  }
  const candidates = new Map<string, Map<number, number>>();
  const sourceLineCounts = new Map<string, number>();
  for (const edge of graph.edges) {
    if (edge.kind !== 'calls' || edge.provenance === 'heuristic' || edge.metadata?.synthesizedBy
      || edge.metadata?.registeredAt || edge.metadata?.wiringSite) continue;
    const source = graph.nodes.get(edge.source), target = graph.nodes.get(edge.target);
    if (!source || !target || source.isDeclaration || !EXPLORE_CALLABLES.has(source.kind)
      || !EXPLORE_CALLABLES.has(target.kind) || !Number.isInteger(edge.line)) continue;
    const line = edge.line!;
    if (line < source.startLine || line > source.endLine) continue;
    const originFile = edge.metadata?.exploreSourceFile;
    if (typeof originFile !== 'string' || originFile.replace(/\\/g, '/') !== source.filePath.replace(/\\/g, '/')) continue;
    const sameOwner = [...(owners.get(source.id) ?? [])].some(id => owners.get(target.id)?.has(id));
    // A named caller is itself source intent, even when its free-function
    // callees are unnamed and no multi-hop Flow can be rendered. These are
    // existing, verified graph edges, not permission to recall new neighbors.
    const priority = favoredIds.has(target.id) ? 0 : sameOwner ? 1 : favoredIds.has(source.id) ? 2 : 3;
    if (priority === 3) continue;
    if (!sourceLineCounts.has(source.filePath)) {
      const snapshot = sources.get(source.filePath);
      sourceLineCounts.set(source.filePath, snapshot.status === 'fresh' && snapshot.content !== undefined
        ? snapshot.content.split(/\r?\n/).length : 0);
    }
    if (line > sourceLineCounts.get(source.filePath)!) continue;
    const lines = candidates.get(source.id) ?? new Map<number, number>();
    lines.set(line, Math.min(lines.get(line) ?? priority, priority));
    candidates.set(source.id, lines);
  }
  return new Map([...candidates].map(([id, lines]) => [id,
    [...lines].sort((a, b) => a[1] - b[1] || a[0] - b[0]).slice(0, 8).map(([line]) => line),
  ]));
}
