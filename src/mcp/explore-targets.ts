import type CodeGraph from '../index';
import type { Node, Subgraph } from '../types';
import { statSync } from 'fs';
import { isConfigLeafNode, validatePathWithinRoot } from '../utils';
import { extractQueryPaths, queryMightContainPaths, type QueryPathExtraction } from '../search/query-paths';
import { ExploreSemanticView, EXPLORE_CALLABLES, EXPLORE_TYPES } from './explore-semantic';
import { ExploreSourceSnapshots } from './explore-source';

export interface ExploreTargets {
  pinnedFiles: string[];
  /** Invalid explicit ranges must not fall back to whole-file rendering. */
  blockedFiles: Set<string>;
  /** A pure multi-line source request does not authorize graph exploration. */
  rangeOnly: boolean;
  exactNodeIds: Set<string>;
  spans: Map<string, Array<{ start: number; end: number }>>;
  issues: string[];
  matchQuery: string;
}

interface TargetResolution {
  targets: ExploreTargets;
  nodes: Map<string, Node>;
  fileNodes: Map<string, Node[]>;
  qualifiedMatches: Map<string, Node[]>;
}

const MAX_QUALIFIED_CANDIDATES = 512;
const MAX_EXACT_TARGETS = 128;
const MAX_FILE_NODES = 300;
const comparable = (name: string) => name.replace(/::/g, '.');
const eligible = (node: Node) => EXPLORE_CALLABLES.has(node.kind) || EXPLORE_TYPES.has(node.kind);
const qualifiedEligible = (node: Node) => !isConfigLeafNode(node)
  && (eligible(node) || ['property', 'field', 'variable', 'constant', 'enum_member', 'type_alias'].includes(node.kind));

/** Resolve explicit intent before tokenization. The upstream path recognizer is
 * pure; this adapter adds our canonical C/C++ declaration/definition view and
 * fresh-source validation. Pins are file intent, not a claim that every member
 * was explicitly named. Qualified suffixes must identify one owner, never an
 * arbitrary namespace with a similarly named class. */
export function resolveExploreTargets(
  cg: CodeGraph, query: string, view: ExploreSemanticView, sources: ExploreSourceSnapshots,
  options: { maxFiles?: number } = {},
): TargetResolution {
  const issues: string[] = [];
  const qualifiedMatches = new Map<string, Node[]>();
  const nodes = new Map<string, Node>();
  const exactNodeIds = new Set<string>();
  const paths: QueryPathExtraction = queryMightContainPaths(query) ? extractQueryPaths(query, cg.getFiles().map(f => f.path), {
    maxPins: Math.max(1, options.maxFiles ?? 8),
    // A line number or bare file name must not silently bind to several files.
    maxMatchesPerSpan: 1,
    allowBasenameFallbackForRelativePaths: false,
    existsOnDisk: file => {
      try { const abs = validatePathWithinRoot(cg.getProjectRoot(), file); return !!abs && statSync(abs).isFile(); }
      catch { return false; }
    },
    symbolFiles: symbol => cg.getNodesBySymbolExact(symbol).flatMap(n => [n.filePath, view.resolve(n).filePath]),
  }) : { strippedQuery: query, pinnedFiles: [], unresolvedPathSpans: [], lineAnchors: [], setAsideMatches: [] };
  issues.push(...paths.unresolvedPathSpans.map(p => `Path unresolved or ambiguous: ${p}; use a repository-relative path.`));
  issues.push(...paths.setAsideMatches.map(p => `Path ${p.span}: set aside ${p.files.join(', ')} using the named symbol evidence.`));
  if (paths.limitedPathSpanCount) issues.push(`${paths.limitedPathSpanCount} path target(s) exceed the file or path-scan limit: ${paths.limitedPathSpans?.join(', ')}. Their path fragments were not searched as symbols.`);
  issues.push(...(paths.invalidLineReferences ?? []).slice(0, 4).map(r => `Invalid line target ${r.reference}: expected positive, bounded 1-based line numbers; no range was guessed.`));
  issues.push(...(paths.normalizedLineReferences ?? []).map(r => `Reversed line target ${r} was normalized to ascending inclusive order.`));
  const invalidRangeFiles = new Set((paths.invalidLineReferences ?? []).flatMap(r => r.file ? [r.file] : []));
  // Validate requested source bounds before resolving members. Otherwise a
  // failed line constraint could already have promoted a whole callable.
  for (const anchor of paths.lineAnchors) {
    const snapshot = sources.get(anchor.file);
    if (snapshot.status !== 'fresh' || snapshot.content === undefined) continue;
    if (anchor.end > snapshot.content.split(/\r?\n/).length) invalidRangeFiles.add(anchor.file);
  }
  const failedPathConstraint = paths.unresolvedPathSpans.length > 0 || !!paths.limitedPathSpanCount || invalidRangeFiles.size > 0;
  const pinned = new Set(paths.pinnedFiles);
  const canonicalTarget = (node: Node): Node => {
    const canonical = view.resolve(node);
    if ((node.language === 'cpp' || node.language === 'c') && !eligible(node)) {
      const owner = view.owner(node);
      if (owner) return { ...canonical, qualifiedName: owner + '::' + node.name };
    }
    return canonical;
  };
  // Operator declarators need a signature parser, not identifier fragments.
  // Keep this stage bounded: report the unsupported whole spelling and offer
  // the already-supported file/line route instead of selecting its owner.
  const matchQuery = paths.strippedQuery.replace(/[A-Za-z_$][\w$]*(?:(?:::|\.)[\w$]+)*(?:::|\.)operator(?:\s+[A-Za-z_$][\w$]*(?:(?:::|\.)[\w$]+)*)?(?:[^\s,;]*)/g, token => {
    issues.push(`Qualified operator target ${token} requires a file and line reference; its fragments were not searched as symbols.`);
    return ' ';
  }).trim();
  const targetTokens = [...new Set(matchQuery.match(/[A-Za-z_$][\w$]*(?:(?:::|\.)~?[\w$]+)+/g) ?? [])];
  const addExact = (matches: Node[], label: string) => {
    const additions = matches.filter(n => !exactNodeIds.has(n.id));
    if (exactNodeIds.size + additions.length > MAX_EXACT_TARGETS) {
      issues.push(`Explicit target ${label} exceeds the ${MAX_EXACT_TARGETS}-node target limit; narrow the request.`);
      return false;
    }
    for (const n of matches) { nodes.set(n.id, n); exactNodeIds.add(n.id); }
    return true;
  };
  for (const token of targetTokens) {
    if (failedPathConstraint) {
      qualifiedMatches.set(token, []);
      issues.push(`Qualified target ${token} was not widened to the whole repository because a path or line constraint could not be honored.`);
      continue;
    }
    // Name-only lookup is deliberately bounded before expensive source-backed
    // normalization. It repairs old qualified-name extraction without FTS.
    const tail = token.split(/::|\./).at(-1)!;
    const raw = new Map(cg.getNodesBySymbolExact(token).filter(qualifiedEligible).map(n => [n.id, n]));
    const tailMatches = cg.getNodesByName(tail).filter(qualifiedEligible);
    if (tailMatches.length <= MAX_QUALIFIED_CANDIDATES) for (const n of tailMatches) raw.set(n.id, n);
    else if (raw.size === 0) issues.push(`Qualified target ${token}: tail-name lookup exceeds ${MAX_QUALIFIED_CANDIDATES} candidates; use its full qualification or a file path.`);
    let matches = [...new Map([...raw.values()].map(n => { const canonical = canonicalTarget(n); return [canonical.id, canonical]; })).values()];
    if (pinned.size) {
      const scoped = matches.filter(n => pinned.has(n.filePath)
        || view.endpoints(n).some(id => { const alias = cg.getNode(id); return !!alias && pinned.has(alias.filePath); }));
      // Combining a path and a member is a scoped request, not two independent
      // broad seeds. Do not silently fall back to an unrelated file.
      matches = scoped;
    }
    const wanted = comparable(token);
    const exact = matches.filter(n => comparable(n.qualifiedName) === wanted);
    matches = exact.length ? exact : matches.filter(n => comparable(n.qualifiedName).endsWith('.' + wanted));
    if (new Set(matches.map(n => comparable(n.qualifiedName))).size > 1) {
      issues.push(`Qualified target ${token} is ambiguous across namespaces or owners; provide a full qualification or path.`);
      matches = [];
    }
    if (matches.length === 0) issues.push(`No unambiguous indexed target for ${token}; this does not establish source absence.`);
    // Keep every overload under the same qualified name. Never pick one by
    // ordering when the request did not specify a signature.
    if (!addExact(matches, token)) matches = [];
    qualifiedMatches.set(token, matches);
  }
  const spans = new Map<string, Array<{ start: number; end: number }>>();
  // A requested field/property has no callable body for the function selector.
  // Preserve its actual declaration range as source, not only an outline name.
  for (const node of nodes.values()) {
    if (eligible(node)) continue;
    const snapshot = sources.get(node.filePath);
    if (snapshot.status !== 'fresh' || snapshot.content === undefined) continue;
    const lineCount = snapshot.content.split(/\r?\n/).length;
    if (node.startLine < 1 || node.endLine < node.startLine || node.endLine > lineCount) {
      issues.push(`Indexed range for ${node.qualifiedName} is outside the current source; no range was guessed.`);
      continue;
    }
    const existing = spans.get(node.filePath) ?? [];
    if (!existing.some(s => s.start === node.startLine && s.end === node.endLine)) existing.push({ start: node.startLine, end: node.endLine });
    spans.set(node.filePath, existing);
  }
  for (const anchor of paths.lineAnchors) {
    const snapshot = sources.get(anchor.file);
    if (snapshot.status !== 'fresh' || snapshot.content === undefined) {
      issues.push(`Line target ${anchor.file}:${anchor.start}-${anchor.end} cannot be mapped safely: ${snapshot.reason ?? snapshot.status}.`);
      continue;
    }
    const lineCount = snapshot.content.split(/\r?\n/).length;
    if (anchor.end > lineCount) {
      issues.push(`Line target ${anchor.file}:${anchor.start}-${anchor.end} exceeds ${lineCount} current source lines; no range was guessed.`);
      invalidRangeFiles.add(anchor.file);
      continue;
    }
    const existing = spans.get(anchor.file) ?? [];
    existing.push({ start: anchor.start, end: anchor.end }); spans.set(anchor.file, existing);
    if (anchor.start === anchor.end) {
      const enclosing = view.inFile(anchor.file).filter(n => EXPLORE_CALLABLES.has(n.kind)
        && n.startLine <= anchor.start && n.endLine >= anchor.end)
        .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine)
          || (b.startColumn - a.startColumn));
      if (enclosing.length > 0) {
        const width = enclosing[0]!.endLine - enclosing[0]!.startLine;
        const nearest = enclosing.filter(n => n.endLine - n.startLine === width);
        const canonical = [...new Map(nearest.map(n => { const c = view.resolve(n); return [c.id, c]; })).values()];
        if (canonical.length === 1) addExact(canonical, `${anchor.file}:${anchor.start}`);
        else issues.push(`Line target ${anchor.file}:${anchor.start} intersects multiple callable declarations; the line span is protected without guessing a function.`);
      }
    }
  }
  const rangeOnly = matchQuery.length === 0 && targetTokens.length === 0 && spans.size > 0
    && [...spans.values()].every(list => list.every(span => span.start < span.end))
    && paths.pinnedFiles.every(file => spans.has(file) || paths.lineAnchors.some(anchor => anchor.file === file)
      || invalidRangeFiles.has(file));
  const fileNodes = new Map<string, Node[]>();
  for (const file of paths.pinnedFiles) {
    if (invalidRangeFiles.has(file)) { fileNodes.set(file, []); continue; }
    const requested = spans.get(file) ?? [];
    const candidates = [...new Map(view.inFile(file).filter(n => rangeOnly
      ? EXPLORE_CALLABLES.has(n.kind) && requested.some(span => n.startLine <= span.end && n.endLine >= span.start)
      : eligible(n)).map(n => {
        // Source coordinates, including header declarations, stay in the
        // requested file. A pure range does not ask for its remote definition.
        const c = rangeOnly ? view.normalize(n) : view.resolve(n); return [c.id, c];
      })).values()];
    candidates.sort((a, b) => Number(exactNodeIds.has(b.id)) - Number(exactNodeIds.has(a.id))
      || Number(!!a.isDeclaration) - Number(!!b.isDeclaration) || a.startLine - b.startLine || a.id.localeCompare(b.id));
    if (candidates.length > MAX_FILE_NODES) issues.push(`File target ${file}: ${candidates.length - MAX_FILE_NODES} indexed nodes exceed the ${MAX_FILE_NODES}-node file supplementation limit.`);
    fileNodes.set(file, candidates.slice(0, MAX_FILE_NODES));
  }
  return { targets: { pinnedFiles: paths.pinnedFiles, blockedFiles: invalidRangeFiles, rangeOnly, exactNodeIds, spans, issues: [...new Set(issues)], matchQuery },
    nodes, fileNodes, qualifiedMatches };
}

/** Explicit target supplementation follows the bounded base traversal, as in
 * upstream explore. Add only canonical nodes and edges whose two endpoints are
 * admitted; declaration aliases remain usable for the combined C/C++ graph. */
export function supplementExploreTargets(
  cg: CodeGraph, view: ExploreSemanticView, graph: Subgraph, resolved: TargetResolution,
): { addedNodes: number; exactTargets: number; baseNodes: number } {
  const baseNodes = graph.nodes.size;
  const added = new Map<string, Node>(resolved.nodes);
  for (const list of resolved.fileNodes.values()) for (const n of list) added.set(n.id, n);
  for (const n of added.values()) graph.nodes.set(n.id, n);
  for (const id of resolved.targets.exactNodeIds) if (!graph.roots.includes(id)) graph.roots.push(id);
  const aliasToCanonical = new Map<string, string>();
  for (const n of graph.nodes.values()) for (const id of view.endpoints(n)) aliasToCanonical.set(id, n.id);
  const edgeKeys = new Set(graph.edges.map(e => JSON.stringify([e.source, e.target, e.kind, e.line, e.column])));
  for (const n of added.values()) for (const endpoint of view.endpoints(n)) {
    for (const edge of [...cg.getOutgoingEdges(endpoint), ...cg.getIncomingEdges(endpoint)]) {
      const source = aliasToCanonical.get(edge.source), target = aliasToCanonical.get(edge.target);
      if (!source || !target || source === target) continue;
      const key = JSON.stringify([source, target, edge.kind, edge.line, edge.column]);
      if (!edgeKeys.has(key)) { graph.edges.push({ ...edge, source, target }); edgeKeys.add(key); }
    }
  }
  return { baseNodes, addedNodes: graph.nodes.size - baseNodes, exactTargets: resolved.targets.exactNodeIds.size };
}
