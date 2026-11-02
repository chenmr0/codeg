import { findNamedCopybooks } from '../upstream-explore/graph/cobol-copybooks';
import type { ExploreGraph } from '../upstream-explore';
import type { QueryBuilder } from '../upstream-explore/db/queries';
import { ContextBuilder } from '../upstream-explore/context';
import { GraphTraverser } from '../upstream-explore/graph/traversal';
import { UpstreamIndexMethods } from '../upstream-explore/index-methods';

/** Host wiring only: v1.6.2 public query API over the supplied query connection.
 * Native and same-graph oracle validation share this exact production path. */
export function createExploreGraphApi(projectRoot: string, queries: QueryBuilder, beforeQuery?: () => void): ExploreGraph {
  const traverser = new GraphTraverser(queries);
  const context = new ContextBuilder(projectRoot, queries, traverser);
  const indexMethods = new UpstreamIndexMethods(queries, context);
  return {
    getProjectRoot: () => projectRoot,
    getSegmentMatches: (words, limit) => { beforeQuery?.(); return indexMethods.getSegmentMatches(words, limit); },
    getStats: () => queries.getStats(),
    getUnseenNames: names => queries.getUnseenNames(names),
    findNamedCopybooks: query => findNamedCopybooks(queries, query),
    getNode: id => queries.getNodeById(id),
    getNodesByIds: ids => queries.getNodesByIds(ids),
    getNodesByName: name => queries.getNodesByName(name),
    getNodesByNamePrefix: (prefix, limit) => queries.getNodesByNamePrefix(prefix, limit),
    getNodesByNameSubstring: (name, limit) => queries.findNodesByNameSubstring(name, limit).map(result => result.node),
    getNodesInFile: file => queries.getNodesByFile(file),
    getFile: file => queries.getFileByPath(file),
    getFiles: () => queries.getAllFiles(),
    searchNodes: (query, options) => queries.searchNodes(query, options),
    getProjectNameTokens: () => queries.getProjectNameTokens(),
    getExploreMissDiagnostics: query => {
      beforeQuery?.();
      return queries.getExploreMissDiagnostics(query);
    },
    getOutgoingEdges: (id, kinds, provenance) => queries.getOutgoingEdges(id, kinds, provenance),
    getIncomingEdges: (id, kinds) => queries.getIncomingEdges(id, kinds),
    getOutgoingEdgesFrom: (ids, kinds) => queries.getOutgoingEdgesFrom(ids, kinds),
    getIncomingEdgesTo: (ids, kinds) => queries.getIncomingEdgesTo(ids, kinds),
    getCallers: (id, depth) => traverser.getCallers(id, depth),
    getCallees: (id, depth) => traverser.getCallees(id, depth),
    getTypeHierarchy: id => traverser.getTypeHierarchy(id),
    generatedFilePredicate: paths => queries.generatedPredicateFor(paths),
    ambientDeclarationFilePredicate: paths => queries.ambientDeclarationPredicateFor(paths),
    findRelevantContext: (query, options) => {
      beforeQuery?.();
      return indexMethods.findRelevantContext(query, options);
    },
  };
}
