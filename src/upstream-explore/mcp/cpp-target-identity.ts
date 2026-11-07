import type { Edge, Node } from '../types';
import { cppCallableParametersMatch } from '../../resolution/cpp-signature';

/** Query-only owner identity. Keep native synthesis semantics unchanged: the
 * legacy graph may contain a case-folded bridge, which Explore must not trust.
 * Short out-of-line owners may still match a fully qualified owner suffix. */
export function exploreCppCallableOwnersMatch(
  left: Pick<Node, 'qualifiedName'>,
  right: Pick<Node, 'qualifiedName'>,
): boolean {
  const owner = (name: string) => name.replace(/\./g, '::').split('::').filter(Boolean).slice(0, -1);
  const a = owner(left.qualifiedName), b = owner(right.qualifiedName);
  if (!a.length || !b.length) return false;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return longer.slice(longer.length - shorter.length).every((part, i) => part === shorter[i]);
}

interface IdentityGraph {
  getNode(id: string): Node | null | undefined;
  getIncomingEdges(id: string): Edge[];
}

const isCallable = (n: Node) => (n.language === 'c' || n.language === 'cpp')
  && (n.kind === 'function' || n.kind === 'method');

/** Parameter identity alone does not distinguish C++ cv/ref overloads. */
function memberQualifiers(n: Node): string | null {
  const signature = n.signature;
  if (!signature) return null;
  let after = -1;
  for (let from = 0; from < signature.length;) {
    const at = signature.indexOf(n.name, from);
    if (at < 0) break;
    from = at + n.name.length;
    if (at > 0 && /[\w$]/.test(signature[at - 1]!)) continue;
    let open = from;
    while (/\s/.test(signature[open] ?? '')) open++;
    if (signature[open] !== '(') continue;
    let depth = 0;
    for (let i = open; i < signature.length; i++) {
      if (signature[i] === '(') depth++;
      else if (signature[i] === ')' && --depth === 0) { after = i + 1; break; }
    }
    if (after >= 0) break;
  }
  if (after < 0) return null;
  let tail = signature.slice(after).trimStart();
  const qualifiers: string[] = [];
  for (;;) {
    const match = /^(const\b|volatile\b|&&|&)/.exec(tail);
    if (!match) break;
    qualifiers.push(match[1]!);
    tail = tail.slice(match[0].length).trimStart();
  }
  return qualifiers.sort().join(' ');
}

/**
 * Query-local identity view, never a rewrite of the index. Only the native
 * overload-checked bridge (definition -> declaration) can establish a pair;
 * a name match or a single surviving BFS edge is not sufficient. The full
 * incoming-edge lookup catches definitions outside this query's subgraph.
 * Explicitly requested files retain their declaration identities.
 */
export class CppTargetIdentity {
  private readonly definitions = new Map<string, Node | null>();

  constructor(private readonly graph: IdentityGraph, private readonly explicitFiles: ReadonlySet<string>) {}

  canonical(node: Node): Node {
    if (!isCallable(node) || node.isDeclaration !== true || this.explicitFiles.has(node.filePath)) return node;
    if (this.definitions.has(node.id)) return this.definitions.get(node.id) ?? node;
    let definition: Node | null = null;
    try {
      const expectedBridge = node.language === 'cpp' ? 'cpp-decl-def' : 'c-decl-def';
      const candidates = new Map<string, Node>();
      const incoming = this.graph.getIncomingEdges(node.id);
      for (const edge of incoming) {
        if (edge.kind !== 'defines' || edge.target !== node.id) continue;
        const source = this.graph.getNode(edge.source);
        if (!source || !isCallable(source) || source.isDeclaration === true) continue;
        // Count all concrete definitions before validating provenance/identity.
        // An unrecognized alternative must not manufacture a unique pairing.
        candidates.set(source.id, source);
      }
      if (candidates.size === 1) {
        const candidate = candidates.values().next().value as Node;
        const trustedBridge = incoming.some(edge =>
          edge.source === candidate.id && edge.target === node.id && edge.kind === 'defines'
          && edge.metadata?.synthesizedBy === expectedBridge);
        if (trustedBridge && candidate.language === node.language && candidate.kind === node.kind
          && candidate.name === node.name && candidate.id !== node.id
          && (node.language !== 'cpp' || exploreCppCallableOwnersMatch(candidate, node))
          && cppCallableParametersMatch(candidate, node) === true
          && memberQualifiers(candidate) !== null
          && memberQualifiers(candidate) === memberQualifiers(node)) {
          definition = candidate;
        }
      }
    } catch { /* incomplete/legacy graph: keep the original declaration */ }
    this.definitions.set(node.id, definition);
    return definition ?? node;
  }

  /** Retains first-seen order; distinct overloads and unrelated names stay distinct. */
  unique(nodes: Iterable<Node>): Node[] {
    return [...new Map([...nodes].map(n => {
      const canonical = this.canonical(n);
      return [canonical.id, canonical] as const;
    })).values()];
  }

  /** Suppress duplicate weight only if the definition is actually in the gather. */
  aliasesIn(nodes: ReadonlyMap<string, Node>): Map<string, string> {
    const aliases = new Map<string, string>();
    for (const node of nodes.values()) {
      const definition = this.canonical(node);
      if (definition.id !== node.id && nodes.has(definition.id)) aliases.set(node.id, definition.id);
    }
    return aliases;
  }
}

/**
 * A topology-only scoring view: preserve edge multiplicity, but count each
 * paired target once. Raw edges (including their call-site coordinates) are
 * untouched and remain authoritative for Flow, source windows and tools.
 */
export function cppIdentityRankingView(nodes: ReadonlyMap<string, Node>, edges: Edge[], aliases: ReadonlyMap<string, string>) {
  return {
    nodeIds: [...nodes.keys()].filter(id => !aliases.has(id)),
    edges: aliases.size === 0 ? edges : edges.map(edge => ({
      kind: edge.kind, source: aliases.get(edge.source) ?? edge.source, target: aliases.get(edge.target) ?? edge.target,
    })),
  };
}
