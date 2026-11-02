import { QueryBuilder } from '../db/queries';
import { Node, NodeKind, SearchResult } from '../types';
import { isDistinctiveIdentifier, isTestFile } from '../search/query-utils';
import { cppCallableOwnersMatch, cppCallableParametersMatch } from '../resolution/cpp-signature';

const TYPE_KINDS = new Set<NodeKind>(['class', 'struct', 'enum', 'type_alias']);
const CALLABLE_KINDS = new Set<NodeKind>(['method', 'function']);

/** Choose a semantic entry without deleting declaration evidence from the DB.
 * Only unambiguous, overload-compatible definitions may replace declarations. */
export function canonicalContextNode(queries: QueryBuilder, node: Node): Node {
  if ((node.language !== 'cpp' && node.language !== 'c') || node.isDeclaration !== true) return node;
  if (TYPE_KINDS.has(node.kind)) {
    const definitions = queries.getNodesByQualifiedNameExact(node.qualifiedName)
      .filter(n => n.language === node.language && n.kind === node.kind && n.isDeclaration !== true);
    return definitions.length === 1 ? definitions[0]! : node;
  }
  if (!CALLABLE_KINDS.has(node.kind)) return node;
  const candidates = new Map<string, Node>();
  for (const edge of queries.getIncomingEdges(node.id, ['defines'])) {
    const definition = queries.getNodeById(edge.source);
    if (definition) candidates.set(definition.id, definition);
  }
  // Also handles legacy indexes without a same-file declaration bridge.
  for (const n of queries.getNodesByQualifiedNameExact(node.qualifiedName)) candidates.set(n.id, n);
  const definitions = [...candidates.values()].filter(n =>
    n.language === node.language && n.kind === node.kind && n.isDeclaration !== true
    && (node.kind === 'function' ? n.qualifiedName === node.qualifiedName : cppCallableOwnersMatch(n, node))
    && cppCallableParametersMatch(n, node) === true);
  return definitions.length === 1 ? definitions[0]! : node;
}

/** Reserve one entry for each explicit C/C++ identifier before fuzzy matches.
 * Extra declarations and constructors must not consume the named type's slots. */
export function selectContextEntries(
  queries: QueryBuilder, query: string, results: SearchResult[], limit: number,
  kinds?: NodeKind[], includeTests = false,
): SearchResult[] {
  const canonical = new Map<string, SearchResult>();
  const cache = new Map<string, Node>();
  const normalize = (n: Node): Node => {
    if (!cache.has(n.id)) cache.set(n.id, canonicalContextNode(queries, n));
    return cache.get(n.id)!;
  };
  for (const r of results) {
    const node = normalize(r.node);
    const previous = canonical.get(node.id);
    if (!previous || previous.score < r.score) canonical.set(node.id, { ...r, node });
  }
  const rawTokens = [...new Set(query.split(/[\s,()[\]]+/).filter(Boolean))];
  const tokens = rawTokens
    .filter(t => /^[A-Za-z_$][\w$]*(?:(?:::|\.)[\w$]+)*$/.test(t)
      && (isDistinctiveIdentifier(t) || t.includes('::'))).slice(0, 16);
  const named: SearchResult[] = [];
  const exact = new Map<string, SearchResult>();
  const namedTypes = new Set<string>();
  for (const token of tokens) {
    const candidates = [...new Map(queries.getNodesBySymbolExact(token)
      .filter(n => (n.language === 'cpp' || n.language === 'c')
        && (!kinds?.length || kinds.includes(n.kind))
        && (includeTests || !isTestFile(n.filePath))
        && n.kind !== 'namespace' && n.kind !== 'file' && n.kind !== 'import')
      .map(n => { const normalized = normalize(n); return [normalized.id, normalized] as const; })).values()];
    candidates.sort((a, b) => Number(TYPE_KINDS.has(b.kind)) - Number(TYPE_KINDS.has(a.kind))
      || Number(a.isDeclaration === true) - Number(b.isDeclaration === true)
      || (canonical.get(b.id)?.score ?? 0) - (canonical.get(a.id)?.score ?? 0)
      || a.qualifiedName.localeCompare(b.qualifiedName) || a.filePath.localeCompare(b.filePath)
      || a.startLine - b.startLine);
    const node = candidates[0];
    if (!node) continue;
    named.push(canonical.get(node.id) ?? { node, score: 1 });
    for (const candidate of candidates) exact.set(candidate.id,
      canonical.get(candidate.id) ?? { node: candidate, score: 1 });
    if (TYPE_KINDS.has(node.kind)) namedTypes.add(node.qualifiedName);
  }
  const selected = new Map<string, SearchResult>();
  // A fully resolved symbol bag already supplies its search anchors. Filling
  // spare slots with fragments of those names (e.g. a common namespace/macro)
  // reintroduces unrelated graph hubs. Keep exact overloads/owners instead.
  const namedOnly = tokens.length > 0 && tokens.length === rawTokens.length && named.length === tokens.length;
  const remaining = namedOnly ? exact : canonical;
  for (const r of [...named, ...[...remaining.values()].sort((a, b) => b.score - a.score)]) {
    if (selected.size >= limit) break;
    const n = r.node;
    const owner = n.qualifiedName.slice(0, n.qualifiedName.lastIndexOf('::'));
    const isConstructor = n.language === 'cpp' && CALLABLE_KINDS.has(n.kind)
      && owner.split('::').at(-1) === n.name;
    if (isConstructor && namedTypes.has(owner) && !tokens.includes(n.qualifiedName)
      && !tokens.some(t => t.includes('::') && n.qualifiedName.endsWith('::' + t))) continue;
    selected.set(n.id, r);
  }
  return [...selected.values()];
}
