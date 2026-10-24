import type CodeGraph from '../index';
import type { Edge, Node, Subgraph } from '../types';
import { isDistinctiveIdentifier, STOP_WORDS } from '../search/query-utils';
import { isConfigLeafNode } from '../utils';
import { scanRawSourceEvidence } from './raw-source-evidence';
import type { RawEvidenceReport } from './raw-source-types';
import { ExploreSemanticView, EXPLORE_CALLABLES, EXPLORE_TYPES } from './explore-semantic';
import { admitExploreGraph, type AdmissionAudit } from './explore-admission';
import { ExploreSourceSnapshots } from './explore-source';
import { resolveExploreTargets, supplementExploreTargets, type ExploreTargets } from './explore-targets';

export type ExploreSeedKind = 'qualified' | 'identifier' | 'owner-member' | 'co-named' | 'symbol-bag' | 'single-symbol' | 'path' | 'literal';
interface SeedDecision {
  token: string;
  kind: ExploreSeedKind | 'uncorroborated' | 'unresolved';
  candidateIds: string[];
  exactMatchCount?: number;
}

export interface ExploreRetrieval {
  sources: ExploreSourceSnapshots;
  targets: ExploreTargets;
  graph: Subgraph;
  lookup: (token: string) => Node[];
  evidence?: RawEvidenceReport;
  note: string;
  fileEvidence: Map<string, number>;
  definitionFiles: Set<string>;
  memberNodeIds: Set<string>;
  contractMemberIds: Set<string>;
  /** Explicit query names/paths, distinct from bodies recovered by literal hits. */
  namedNodeIds: Set<string>;
  diagnostics: {
    targets: { addedNodes: number; exactTargets: number; baseNodes: number };
    seeds: SeedDecision[];
    admission: AdmissionAudit;
    omittedSeedIds: string[];
    members: Array<{ ownerId: string; nodeId: string; admitted: boolean;
      reason: 'admitted' | 'not-requested-member' | 'global-node-limit' | 'not-reached-within-depth' }>;
  };
}

/** Exact names/paths and literal evidence only; no FTS, substring or split-word seeds. */
export async function retrieveExploreContext(cg: CodeGraph, query: string, options: { maxFiles?: number } = {}): Promise<ExploreRetrieval> {
  const sources = new ExploreSourceSnapshots(cg);
  const view = new ExploreSemanticView(cg, sources);
  const resolvedTargets = resolveExploreTargets(cg, query, view, sources, options);
  const { targets } = resolvedTargets;
  const words = [...new Set(targets.matchQuery.match(/[A-Za-z_$][\w$]*(?:(?:::|\.)~?[\w$]+)*/g) ?? [])].slice(0, 32);
  const distinctive = words.filter(w => isDistinctiveIdentifier(w) || /[.:]/.test(w) || /^[A-Z]/.test(w));
  const exactCache = new Map<string, Node[]>();
  const exact = (word: string) => {
    if (resolvedTargets.qualifiedMatches.has(word)) return resolvedTargets.qualifiedMatches.get(word)!;
    if (!exactCache.has(word)) exactCache.set(word, cg.getNodesBySymbolExact(word).filter(n =>
      !['import', 'export', 'namespace', 'file', 'parameter'].includes(n.kind) && !isConfigLeafNode(n)));
    return exactCache.get(word)!;
  };
  // Adapted from the corroboration guard in upstream v1.6.2 tools.ts
  // (6560052a, MIT): ordinary prose collisions do not become strong named seeds.
  // Keep single-symbol queries and same-file symbol bags; no fuzzy recall.
  const coNamed = (word: string, node: Node) => words.some(other => other !== word
    && exact(other).some(n => n.filePath === node.filePath
      && (EXPLORE_TYPES.has(n.kind) || EXPLORE_CALLABLES.has(n.kind))));
  // A whole query made of unambiguous callable names is also evidence, even
  // across files. Do not require co-location for a deliberate symbol bag.
  const symbolBag = words.length > 1 && distinctive.length === 0 && words.every(word => {
    if (STOP_WORDS.has(word.toLowerCase())) return false;
    const matches = exact(word).filter(n => EXPLORE_TYPES.has(n.kind) || EXPLORE_CALLABLES.has(n.kind));
    return matches.length > 0 && matches.length <= 3;
  });
  const namedTypes = new Map<string, Node>();
  for (const word of words) {
    for (const raw of exact(word)) {
      if (EXPLORE_TYPES.has(raw.kind) && (distinctive.includes(word) || words.length === 1 || coNamed(word, raw))) {
        const n = view.resolve(raw); namedTypes.set(n.id, n);
      }
    }
  }
  const owners = new Set([...namedTypes.values()].map(n => n.qualifiedName));
  const ownerTails = new Set([...namedTypes.values()].map(n => n.name));
  const lookupCache = new Map<string, Node[]>();
  const decisions = new Map<string, SeedDecision>();
  const lookup = (word: string): Node[] => {
    if (lookupCache.has(word)) return lookupCache.get(word)!;
    const original = exact(word);
    let raw = original;
    let owned = false;
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
      if (scoped.length > 0) { raw = scoped; owned = true; }
    }
    const precise = distinctive.includes(word);
    if (!precise && words.length > 1 && !owned && !symbolBag) raw = raw.filter(n => coNamed(word, n));
    const result = [...new Map(raw.map(n => { const v = view.resolve(n); return [v.id, v] as const; })).values()]
      .sort((a, b) => Number(!!a.isDeclaration) - Number(!!b.isDeclaration)
        || a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine);
    const kind: SeedDecision['kind'] = result.length === 0 ? original.length ? 'uncorroborated' : 'unresolved'
      : /[.:]/.test(word) ? 'qualified' : precise ? 'identifier'
      : words.length === 1 ? 'single-symbol' : owned ? 'owner-member' : symbolBag ? 'symbol-bag' : 'co-named';
    decisions.set(word, { token: word, kind, candidateIds: result.map(n => n.id), exactMatchCount: original.length });
    lookupCache.set(word, result); return result;
  };
  const groups: Node[][] = [];
  const namedCandidates = new Set<string>();
  const explicitMembers = new Map<string, Set<string>>();
  const support = new Map<string, Set<string>>();
  const corroborate = (n: Node, token: string) => {
    const terms = support.get(n.id) ?? new Set<string>(); terms.add(token); support.set(n.id, terms);
  };
  const unresolved: string[] = [];
  for (const word of words) {
    const matches = lookup(word);
    if (matches.length > 0) {
      groups.push(matches);
      for (const n of matches) {
        namedCandidates.add(n.id);
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
    else if (!resolvedTargets.qualifiedMatches.has(word) && exact(word).length === 0 && !STOP_WORDS.has(word.toLowerCase())
      && ((distinctive.includes(word) && word.length >= 4) || words.length === 1)) unresolved.push(word);
  }
  for (const [file, matches] of resolvedTargets.fileNodes) {
    // A pure source-range request needs target span nodes for coverage, but
    // does not request a traversal through siblings and cross-file callees.
    if (!targets.rangeOnly) groups.push(matches);
    decisions.set(file, { token: file, kind: 'path', candidateIds: matches.map(n => n.id) });
    // A file pin supplies scoped evidence without pretending every member was
    // explicitly requested. Only line-owned/qualified nodes become exact.
    for (const n of matches) corroborate(n, file);
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
      if (bodies.size > 0) {
        groups.push([...bodies.values()]);
        decisions.set(state.spec.needle, { token: state.spec.needle, kind: 'literal', candidateIds: [...bodies.keys()] });
      }
    }
  }
  // Fair first slot per query anchor; unresolved literals never promote their fragments.
  const entries = new Map<string, Node>();
  for (let rank = 0; rank < 8 && entries.size < 32; rank++) {
    for (const group of groups) {
      const n = group[rank]; if (n && entries.size < 32) entries.set(n.id, n);
    }
  }
  const namedNodeIds = new Set([...entries.keys()].filter(id => namedCandidates.has(id)));
  const definitionFiles = new Set<string>();
  const memberNodeIds = new Set<string>();
  const contractMemberIds = new Set<string>();
  const ownerRoots = new Set<string>();
  for (const n of entries.values()) {
    if (EXPLORE_CALLABLES.has(n.kind)) {
      const owner = view.ownerType(n); if (owner) ownerRoots.add(owner.id);
    }
  }
  const knownMembers = new Map<string, { ownerId: string; requested: boolean }>();
  const { graph, audit } = admitExploreGraph([...entries.values()], node => {
      const neighbors: Array<{ node: Node; edge: Edge }> = [];
      const isType = EXPLORE_TYPES.has(node.kind);
      const selectedMembers = isType ? explicitMembers.get(node.qualifiedName) : undefined;
      const expandMembers = support.has(node.id) || ownerRoots.has(node.id);
      if (entries.has(node.id) && EXPLORE_CALLABLES.has(node.kind)) {
        const owner = view.ownerType(node);
        if (owner) neighbors.push({ node: owner, edge: { source: owner.id, target: node.id, kind: 'contains',
          metadata: { evidence: 'source-owner' } } });
      }
      if (isType && expandMembers) {
        for (const member of view.members(node)) {
          knownMembers.set(member.id, { ownerId: node.id, requested: !selectedMembers || selectedMembers.has(member.id) });
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
      return neighbors;
  // Spend reclaimed reservations on proven members of query-anchored owners.
  // Ordinary neighbors keep their first-pass allocation, without automatically
  // turning every spare node slot into more peripheral context.
  }, 200, 3, node => memberNodeIds.has(node.id));
  const targetAudit = supplementExploreTargets(cg, view, graph, resolvedTargets);
  for (const id of targets.exactNodeIds) namedNodeIds.add(id);
  const parts = ['Exact symbol/path anchors and identifier text evidence; weak word matches are disabled.'];
  if (graph.nodes.size === 0) {
    const rejected = [...decisions.values()].filter(d => d.kind === 'uncorroborated');
    if (rejected.length) parts.push(`Exact-name matches for ${rejected.slice(0, 6).map(d => d.token).join(', ')} were not admitted without owner or co-naming evidence; this does not establish symbol absence.`);
  }
  if (evidence) {
    const partial = evidence.budgetReached || evidence.timeBudgetReached || evidence.cancelled
      || evidence.omittedQueries > 0 || evidence.states.some(s => s.unreadableFiles > 0 || s.scannedFiles < s.eligibleFiles);
    parts.push(`Literal fallback (${evidence.backend}): ${evidence.states.length} identifier(s), ${evidence.states.reduce((n, s) => n + s.matchingLines, 0)} matching line(s).${partial ? ' Scan incomplete; absence is not established.' : ''}`);
    const locations = evidence.states.flatMap(s => s.snippets.map(h => `${s.spec.needle}: ${h.file}:${h.line}`)).slice(0, 12);
    if (locations.length) parts.push('Literal locations (not complete bodies): ' + locations.join('; '));
    if (evidence.states.some(s => s.matchingLines > s.snippets.length)) parts.push('Only a bounded sample of literal hits was mapped to bodies.');
  }
  const fileTerms = new Map<string, Set<string>>();
  for (const n of graph.nodes.values()) {
    const terms = fileTerms.get(n.filePath) ?? new Set<string>();
    for (const token of support.get(n.id) ?? []) terms.add(token);
    fileTerms.set(n.filePath, terms);
  }
  const fileEvidence = new Map([...fileTerms].map(([file, terms]) => [file, terms.size]));
  const omitted = new Set(audit.omittedNodeIds);
  return { sources, targets, graph, lookup, evidence, note: parts.join('\n'), fileEvidence, definitionFiles, memberNodeIds, contractMemberIds, namedNodeIds,
    diagnostics: { targets: targetAudit, seeds: [...decisions.values()], admission: audit,
      omittedSeedIds: [...new Set(groups.flat().map(n => n.id))].filter(id => !entries.has(id)),
      members: [...knownMembers].map(([nodeId, value]) => ({ ownerId: value.ownerId, nodeId,
        admitted: graph.nodes.has(nodeId), reason: graph.nodes.has(nodeId) ? 'admitted'
          : !value.requested ? 'not-requested-member' : omitted.has(nodeId) ? 'global-node-limit' : 'not-reached-within-depth' })) } };
}
