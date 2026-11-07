import type CodeGraph from '../index';
import type { Node } from '../types';
import { CppTargetIdentity } from '../mcp/cpp-target-identity';

/** A conservative Flow-only identity view. A prototype is a transparent
 * endpoint, not an extra call hop. Never fold a declaration that has its own
 * dispatch or incident synthesized evidence: those edges belong to its
 * original identity/location and must stay visible to Flow's link renderer.
 * Raw call edges and the persistent graph are never rewritten. */
export function cppLogicalCallTarget(graph: CodeGraph): (node: Node) => Node {
  const identities = new CppTargetIdentity(graph, new Set());
  const cache = new Map<string, Node>();
  return node => {
    const cached = cache.get(node.id);
    if (cached) return cached;
    const definition = identities.canonical(node);
    let target = node;
    if (definition.id !== node.id) {
      try {
        const outgoing = graph.getOutgoingEdges(node.id);
        const ownsDispatch = outgoing.some(edge =>
          edge.kind === 'calls' || edge.kind === 'navigates');
        // The renderer scans named nodes' RAW incident heuristic edges. An
        // incoming override can target this prototype even though it owns no
        // outgoing calls. Folding it would hide that evidence. The identity
        // bridge itself is safe: it is also incident to the kept definition.
        const ownsSynthesizedEvidence = [...graph.getIncomingEdges(node.id), ...outgoing]
          .some(edge => edge.provenance === 'heuristic'
            && !(edge.kind === 'defines' && edge.source === definition.id && edge.target === node.id
              && edge.metadata?.synthesizedBy === (node.language === 'cpp' ? 'cpp-decl-def' : 'c-decl-def')));
        if (!ownsDispatch && !ownsSynthesizedEvidence) target = definition;
      } catch { /* Unknown adjacency must not erase declaration behavior. */ }
    }
    cache.set(node.id, target);
    return target;
  };
}
