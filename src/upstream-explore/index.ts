import type { QueryBuilder } from './db/queries';
import type { GraphTraverser } from './graph/traversal';
import type { UpstreamIndexMethods } from './index-methods';
import type { FileRecord, Node } from './types';
export interface ExploreGraph extends Pick<QueryBuilder,
 'getNodesByName' | 'getNodesByNamePrefix' | 'getNodesByIds' | 'getOutgoingEdgesFrom' | 'getIncomingEdgesTo' |
 'searchNodes' | 'getOutgoingEdges' | 'getIncomingEdges' |
 'getExploreMissDiagnostics' | 'getProjectNameTokens' | 'getStats'>,
 Pick<GraphTraverser, 'getCallers' | 'getCallees' | 'getTypeHierarchy'>,
 Pick<UpstreamIndexMethods, 'findRelevantContext' | 'getSegmentMatches'> {
 getNodesByNameSubstring(name: string, options?: Parameters<QueryBuilder['findNodesByNameSubstring']>[1]): Node[];
 getNodesInFile: QueryBuilder['getNodesByFile'];
 getNode: QueryBuilder['getNodeById'];
 getProjectRoot(): string;
 getFile(path: string): FileRecord | null;
 getFiles(): FileRecord[];
 /** Hash-verified bytes shared within this exploration only. */
 getVerifiedSource?(path: string): string | undefined;
 generatedFilePredicate(paths: Iterable<string>): (path: string) => boolean;
 ambientDeclarationFilePredicate(paths: Iterable<string>): (path: string) => boolean;
}
export default ExploreGraph;
