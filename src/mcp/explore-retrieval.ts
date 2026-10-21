import type CodeGraph from '../index';
import type { Edge, Node, Subgraph } from '../types';
import { isDistinctiveIdentifier, STOP_WORDS } from '../search/query-utils';
import { isConfigLeafNode } from '../utils';
import { scanRawSourceEvidence } from './raw-source-evidence';
import type { RawEvidenceReport } from './raw-source-types';
import { ExploreSemanticView, EXPLORE_CALLABLES, EXPLORE_TYPES } from './explore-semantic';

export interface ExploreRetrieval {
  graph: Subgraph;
  lookup: (token: string) => Node[];
  evidence?: RawEvidenceReport;
  note: string;
  fileEvidence: Map<string, number>;
  definitionFiles: Set<string>;
  memberNodeIds: Set<string>;
  contractMemberIds: Set<string>;
}

/** Exact names/paths and literal evidence only; no FTS, substring or split-word seeds. */
export async function retrieveExploreContext(cg: CodeGraph, query: string): Promise<ExploreRetrieval> {
  const view = new ExploreSemanticView(cg);
  const words = [...new Set(query.match(/[A-Za-z_$][\w$]*(?:(?:::|\.)[\w$]+)*/g) ?? [])].slice(0, 32);
  const distinctive = words.filter(w => isDistinctiveIdentifier(w) || w.includes('::') || w.includes('.'));
  const namedTypes = new Map<string, Node>();
  for (const word of words) {
    for (const raw of cg.getNodesBySymbolExact(word)) {
      if (EXPLORE_TYPES.has(raw.kind)) {
        const n = view.resolve(raw); namedTypes.set(n.id, n);
      }
    }
  }
  const owners = new Set([...namedTypes.values()].map(n => n.qualifiedName));
  const ownerTails = new Set([...namedTypes.values()].map(n => n.name));
  const lookupCache = new Map<string, Node[]>();
  const lookup = (word: string): Node[] => {
    if (lookupCache.has(word)) return lookupCache.get(word)!;
    let raw = cg.getNodesBySymbolExact(word).filter(n => !['import', 'export', 'namespace', 'file', 'parameter'].includes(n.kind)
      && !isConfigLeafNode(n));
    const types = raw.filter(n => EXPLORE_TYPES.has(n.kind));
    // A type name is a type anchor, not an implicit request for its constructor.
    if (types.length > 0) raw = types;
    else if (owners.size > 0 && !/[.:]/.test(word)) {
      let scoped = raw.filter(n => ownerTails.has(n.qualifiedName.split(/::|\./).slice(-2, -1)[0] ?? '')
        || [...namedTypes.values()].some(t => t.filePath === n.filePath));
      scoped = scoped.filter(n => {
        const normalized = view.normalize(n);
        return owners.has(normalized.qualifiedName.split(/::|\./).slice(0, -1).join(n.language === 'cpp' || n.language === 'c' ? '::' : '.'));
      });
      raw = scoped.length > 0 ? scoped : raw.length <= 3 || isDistinctiveIdentifier(word) ? raw : [];
    } else if (distinctive.length > 0 && !distinctive.includes(word) && raw.length > 3) {
      // An ambiguous common word needs an owner; an exact unique name does not.
      raw = [];
    }
    const result = [...new Map(raw.map(n => { const v = view.resolve(n); return [v.id, v] as const; })).values()]
      .sort((a, b) => Number(!!a.isDeclaration) - Number(!!b.isDeclaration)
        || a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine);
    lookupCache.set(word, result); return result;
  };
  const groups: Node[][] = [];
  const explicitMembers = new Map<string, Set<string>>();
  const support = new Map<string, Set<string>>();
  const corroborate = (n: Node, token: string) => {
    const terms = support.get(n.id) ?? new Set<string>(); terms.add(token); support.set(n.id, terms);
  };
  const unresolved: string[] = [];
  for (const word of words) {
    if (STOP_WORDS.has(word.toLowerCase()) && !distinctive.includes(word)) continue;
    const matches = lookup(word);
    if (matches.length > 0) {
      groups.push(matches);
      for (const n of matches) {
        corroborate(n, word);
        if (EXPLORE_CALLABLES.has(n.kind)) {
          const owner = n.qualifiedName.split(/::|\./).slice(0, -1).join(n.language === 'cpp' || n.language === 'c' ? '::' : '.');
          if (owner) {
            const members = explicitMembers.get(owner) ?? new Set<string>();
            members.add(n.id); explicitMembers.set(owner, members);
          }
        }
      }
    }
    else if ((distinctive.includes(word) && word.length >= 4) || words.length === 1) unresolved.push(word);
  }
  // Paths stay literal too: a basename must match a whole basename, never a fragment.
  const paths = query.split(/[\s,;]+/).map(s => s.replace(/^[`'"]|[`'"]$/g, '').replace(/\\/g, '/'))
    .filter(s => /\.[A-Za-z0-9]+$/.test(s));
  if (paths.length > 0) {
    for (const file of cg.getFiles()) {
      if (!paths.some(p => p === file.path || (!p.includes('/') && file.path.split('/').at(-1) === p))) continue;
      const matches = view.inFile(file.path).filter(n => EXPLORE_CALLABLES.has(n.kind) || EXPLORE_TYPES.has(n.kind))
        .map(n => view.resolve(n));
      groups.push(matches); for (const n of matches) corroborate(n, file.path);
    }
  }
  let evidence: RawEvidenceReport | undefined;
  if (unresolved.length > 0) {
    evidence = await scanRawSourceEvidence(cg, unresolved.map(needle => ({ label: needle, needle, mode: 'identifier' })));
    for (const state of evidence.states) {
      const bodies = new Map<string, Node>();
      for (const hit of state.snippets) {
        const body = view.enclosingBody(hit.file, hit.line);
        if (body) { bodies.set(body.id, body); corroborate(body, state.spec.needle); }
      }
      if (bodies.size > 0) groups.push([...bodies.values()]);
    }
  }
  // Fair first slot per query anchor; unresolved literals never promote their fragments.
  const entries = new Map<string, Node>();
  for (let rank = 0; rank < 8 && entries.size < 32; rank++) {
    for (const group of groups) {
      const n = group[rank]; if (n && entries.size < 32) entries.set(n.id, n);
    }
  }
  const nodes = new Map(entries);
  const definitionFiles = new Set<string>();
  const memberNodeIds = new Set<string>();
  const contractMemberIds = new Set<string>();
  const ownerRoots = new Set<string>();
  for (const n of entries.values()) {
    if (EXPLORE_CALLABLES.has(n.kind)) {
      const owner = view.ownerType(n); if (owner) ownerRoots.add(owner.id);
    }
  }
  const edges: Edge[] = [];
  const edgeKeys = new Set<string>();
  const addEdge = (edge: Edge) => {
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) return;
    const key = JSON.stringify([edge.source, edge.target, edge.kind, edge.line, edge.column]);
    if (!edgeKeys.has(key)) { edgeKeys.add(key); edges.push(edge); }
  };
  const perEntryLimit = Math.ceil(200 / Math.max(1, entries.size));
  for (const root of entries.values()) {
    const admitted = new Set([root.id]);
    const queue: Array<{ node: Node; depth: number }> = [{ node: root, depth: 0 }];
    while (queue.length > 0) {
      const { node, depth } = queue.shift()!;
      if (depth >= 3) continue;
      const neighbors: Array<{ node: Node; edge: Edge }> = [];
      const isType = EXPLORE_TYPES.has(node.kind);
      const selectedMembers = isType ? explicitMembers.get(node.qualifiedName) : undefined;
      const expandMembers = support.has(node.id) || ownerRoots.has(node.id);
      if (depth === 0 && EXPLORE_CALLABLES.has(node.kind)) {
        const owner = view.ownerType(node);
        if (owner) neighbors.push({ node: owner, edge: { source: owner.id, target: node.id, kind: 'contains',
          metadata: { evidence: 'source-owner' } } });
      }
      if (isType && expandMembers) {
        for (const member of view.members(node)) {
          // Naming a type alongside precise members does not request every
          // other method. Type-only and literal-recovery queries retain breadth.
          if (selectedMembers && !selectedMembers.has(member.id)) continue;
          // A literal hit's enclosing callable is an equally strong owner
          // anchor. Its sibling methods must not fall behind a named type's
          // methods merely because the type name was absent from the query.
          if (support.has(node.id) || ownerRoots.has(node.id)) memberNodeIds.add(member.id);
          // A declared virtual/override contract is a structural entry point,
          // even when the out-of-line definition omits those qualifiers.
          if (view.endpoints(member).some(id => {
            const signature = cg.getNode(id)?.signature ?? '';
            return /\b(?:virtual|abstract)\b/.test(signature.split('(', 1)[0]!)
              || /\boverride\b/.test(signature.slice(signature.lastIndexOf(')') + 1))
              || cg.getOutgoingEdges(id).some(e => e.kind === 'overrides');
          })) contractMemberIds.add(member.id);
          for (const token of support.get(node.id) ?? []) corroborate(member, token);
          if (support.has(node.id) && !member.isDeclaration) definitionFiles.add(member.filePath);
          neighbors.push({ node: member,
            edge: { source: node.id, target: member.id, kind: 'contains', metadata: { evidence: 'semantic-member' } } });
        }
      }
      const endpointIds = new Set(view.endpoints(node));
      for (const e of [...endpointIds].flatMap(id => [...cg.getOutgoingEdges(id), ...cg.getIncomingEdges(id)])) {
        if (!['calls', 'contains', 'defines', 'overrides', 'type_of', 'extends', 'implements'].includes(e.kind)) continue;
        const raw = cg.getNode(endpointIds.has(e.source) ? e.target : e.source);
        if (!raw || ['file', 'namespace', 'import', 'export'].includes(raw.kind) || isConfigLeafNode(raw)) continue;
        const next = view.resolve(raw);
        if (next.id === node.id) continue;
        if (isType && e.kind === 'contains' && endpointIds.has(e.source)
          && (!expandMembers || (selectedMembers && !selectedMembers.has(next.id)))) continue;
        neighbors.push({ node: next, edge: { ...e,
          source: endpointIds.has(e.source) ? node.id : next.id,
          target: endpointIds.has(e.target) ? node.id : next.id } });
      }
      neighbors.sort((a, b) => Number(a.edge.kind !== 'contains') - Number(b.edge.kind !== 'contains')
        || Number(!EXPLORE_CALLABLES.has(a.node.kind)) - Number(!EXPLORE_CALLABLES.has(b.node.kind))
        || Number(!!a.node.isDeclaration) - Number(!!b.node.isDeclaration)
        || a.node.startLine - b.node.startLine);
      for (const next of neighbors) {
        if (!admitted.has(next.node.id)) {
          if (admitted.size >= perEntryLimit || (!nodes.has(next.node.id) && nodes.size >= 200)) continue;
          admitted.add(next.node.id); nodes.set(next.node.id, next.node);
          queue.push({ node: next.node, depth: depth + 1 });
        }
        addEdge(next.edge);
      }
    }
  }
  const parts = ['Exact symbol/path anchors and identifier text evidence; weak word matches are disabled.'];
  if (evidence) {
    const partial = evidence.budgetReached || evidence.timeBudgetReached || evidence.cancelled
      || evidence.omittedQueries > 0 || evidence.states.some(s => s.unreadableFiles > 0 || s.scannedFiles < s.eligibleFiles);
    parts.push(`Literal fallback (${evidence.backend}): ${evidence.states.length} identifier(s), ${evidence.states.reduce((n, s) => n + s.matchingLines, 0)} matching line(s).${partial ? ' Scan incomplete; absence is not established.' : ''}`);
    const locations = evidence.states.flatMap(s => s.snippets.map(h => `${s.spec.needle}: ${h.file}:${h.line}`)).slice(0, 12);
    if (locations.length) parts.push('Literal locations (not complete bodies): ' + locations.join('; '));
    if (evidence.states.some(s => s.matchingLines > s.snippets.length)) parts.push('Only a bounded sample of literal hits was mapped to bodies.');
  }
  const fileTerms = new Map<string, Set<string>>();
  for (const n of nodes.values()) {
    const terms = fileTerms.get(n.filePath) ?? new Set<string>();
    for (const token of support.get(n.id) ?? []) terms.add(token);
    fileTerms.set(n.filePath, terms);
  }
  const fileEvidence = new Map([...fileTerms].map(([file, terms]) => [file, terms.size]));
  return { graph: { nodes, edges, roots: [...entries.keys()] }, lookup, evidence, note: parts.join('\n'), fileEvidence, definitionFiles, memberNodeIds, contractMemberIds };
}
