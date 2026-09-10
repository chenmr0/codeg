/**
 * CodeGraph Type Definitions
 *
 * Core types for the semantic knowledge graph system.
 */

// =============================================================================
// Union Types
// =============================================================================

/**
 * Types of nodes in the knowledge graph.
 *
 * Defined as a runtime-iterable `as const` array so the same source
 * of truth backs both the TS type and any runtime validation
 * (e.g. the search query parser).
 */
export const NODE_KINDS = [
  'file',
  'module',
  'class',
  'struct',
  'interface',
  'trait',
  'protocol',
  'function',
  'method',
  'macro',
  'property',
  'field',
  'variable',
  'constant',
  'enum',
  'enum_member',
  'type_alias',
  'namespace',
  'parameter',
  'import',
  'export',
  'route',
  'component',
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

/**
 * Types of edges (relationships) between nodes
 */
export type EdgeKind =
  | 'contains'        // Parent contains child (file→class, class→method)
  | 'calls'           // Function/method calls another
  | 'imports'         // File imports from another
  | 'exports'         // File exports a symbol
  | 'extends'         // Class/interface extends another
  | 'implements'      // Class implements interface
  | 'references'      // Generic reference to another symbol
  | 'type_of'         // Variable/parameter has type
  | 'returns'         // Function returns type
  | 'instantiates'    // Creates instance of class
  | 'overrides'       // Method overrides parent method
  | 'decorates'       // Decorator applied to symbol
  | 'defines';        // C++ definition (with body) defines its declaration (prototype)

/**
 * Supported programming languages. See NODE_KINDS for why this is a
 * runtime-iterable const array.
 */
export const LANGUAGES = [
  'typescript',
  'javascript',
  'tsx',
  'jsx',
  'python',
  'go',
  'rust',
  'java',
  'c',
  'cpp',
  'csharp',
  'razor',
  'php',
  'ruby',
  'swift',
  'kotlin',
  'dart',
  'svelte',
  'vue',
  'liquid',
  'pascal',
  'scala',
  'lua',
  'luau',
  'objc',
  'yaml',
  'twig',
  'xml',
  'properties',
  'unknown',
] as const;

export type Language = (typeof LANGUAGES)[number];

// =============================================================================
// Core Graph Types
// =============================================================================

/**
 * A node in the knowledge graph representing a code symbol
 */
export interface Node {
  /** Unique identifier (hash of file path + qualified name) */
  id: string;

  /** Type of code element */
  kind: NodeKind;

  /** Simple name (e.g., "calculateTotal") */
  name: string;

  /** Fully qualified name (e.g., "src/utils.ts::MathHelper.calculateTotal") */
  qualifiedName: string;

  /** File path relative to project root */
  filePath: string;

  /** Programming language */
  language: Language;

  /** Starting line number (1-indexed) */
  startLine: number;

  /** Ending line number (1-indexed) */
  endLine: number;

  /** Starting column (0-indexed) */
  startColumn: number;

  /** Ending column (0-indexed) */
  endColumn: number;

  /** Documentation string if present */
  docstring?: string;

  /** Function/method signature */
  signature?: string;

  /** Visibility modifier */
  visibility?: 'public' | 'private' | 'protected' | 'internal';

  /** Whether symbol is exported */
  isExported?: boolean;

  /** Whether symbol is async */
  isAsync?: boolean;

  /** Whether symbol is static */
  isStatic?: boolean;

  /** Whether symbol is abstract */
  isAbstract?: boolean;

  /**
   * Whether this is a declaration (prototype) rather than a definition.
   * C/C++ function prototypes extracted from headers (e.g. `int foo();` with
   * no body) are marked true; the corresponding `function_definition` nodes
   * with a body are false/undefined. Lets cDeclDefEdges pair prototypes with
   * definitions without relying on the buggy endLine>startLine heuristic
   * (which misclassifies multi-line prototypes as definitions).
   */
  isDeclaration?: boolean;

  /** Decorators/annotations applied */
  decorators?: string[];

  /** Generic type parameters */
  typeParameters?: string[];

  /**
   * Normalized return/result type name for a function/method (the bare class
   * name, smart-pointer pointee unwrapped). Captured for C/C++ so resolution
   * can infer a chained receiver's type from what the inner call returns —
   * `Foo::instance().bar()` resolves `bar` on `Foo` (issue #645). Undefined for
   * languages/symbols where it isn't captured.
   */
  returnType?: string;

  /** When the node was last updated */
  updatedAt: number;
}

/**
 * An edge representing a relationship between two nodes
 */
export interface Edge {
  /** Source node ID */
  source: string;

  /** Target node ID */
  target: string;

  /** Type of relationship */
  kind: EdgeKind;

  /** Additional context about the relationship */
  metadata?: Record<string, unknown>;

  /** Line number where relationship occurs (e.g., call site) */
  line?: number;

  /** Column number where relationship occurs */
  column?: number;

  /** How this edge was created */
  provenance?: 'tree-sitter' | 'scip' | 'heuristic';
}

/** Direction of a direct relationship lookup from one indexed symbol. */
export type RelationshipDirection = 'incoming' | 'outgoing';

/**
 * One directly-related symbol and every parallel edge connecting it to the
 * lookup root. Unlike recursive caller/callee traversal, this preserves
 * multiple call/reference/import sites between the same two symbols.
 */
export interface DirectRelationshipGroup {
  node: Node;
  edges: Edge[];
}

/**
 * Metadata about a tracked file
 */
export interface FileRecord {
  /** File path relative to project root */
  path: string;

  /** Content hash for change detection */
  contentHash: string;

  /** Detected language */
  language: Language;

  /** File size in bytes */
  size: number;

  /** Last modification timestamp */
  modifiedAt: number;

  /** When last indexed */
  indexedAt: number;

  /** Number of nodes extracted */
  nodeCount: number;

  /** Any extraction errors */
  errors?: ExtractionError[];
}

// =============================================================================
// Extraction Types
// =============================================================================

/**
 * Result from parsing a source file
 */
export interface ExtractionResult {
  /** Extracted nodes */
  nodes: Node[];

  /** Extracted edges */
  edges: Edge[];

  /** References that couldn't be resolved yet */
  unresolvedReferences: UnresolvedReference[];

  /** Any errors during extraction */
  errors: ExtractionError[];

  /** Extraction duration in milliseconds */
  durationMs: number;

  /**
   * Optional fine-grained extractor timings. These are diagnostic only and do
   * not participate in graph identity or persistence.
   */
  timings?: ExtractionTimings;
}

/** Fine-grained parsing timings used by verbose index/sync diagnostics. */
export interface ExtractionTimings {
  /** Initial parse plus any offset-preserving adaptive parse retries. */
  primaryParseMs?: number;
  /** Primary AST traversal and ordinary symbol/reference extraction. */
  primaryExtractionMs?: number;
  /** Declaration-macro scan, argument substitution and recursive expansion. */
  declarationMacroExpansionMs?: number;
  /** Construction of the sparse, context-preserving recovery source. */
  declarationMacroRecoverySourceMs?: number;
  /** Isolated tree-sitter extraction of the recovery source. */
  declarationMacroAuxParseMs?: number;
  /** Filtering and merging recovered nodes/contains edges. */
  declarationMacroMergeMs?: number;
  /** Declaration-scope macro invocations considered for recovery. */
  declarationMacroInvocationCount?: number;
  /** UTF-8 bytes in sparse recovery sources sent to auxiliary parsers. */
  declarationMacroRecoverySourceBytes?: number;
  /** Number of isolated declaration-macro auxiliary parses attempted. */
  declarationMacroAuxParseAttempts?: number;
  /** New declaration nodes actually retained from auxiliary parse output. */
  declarationMacroRecoveredNodes?: number;
}

/**
 * Error during code extraction
 */
export interface ExtractionError {
  /** Error message */
  message: string;

  /** File path where the error occurred */
  filePath?: string;

  /** Line number if available */
  line?: number;

  /** Column number if available */
  column?: number;

  /** Error severity */
  severity: 'error' | 'warning';

  /** Error code for categorization */
  code?: string;
}

/**
 * Snapshot of a cross-file incoming edge saved before a file's old nodes
 * are deleted, so the edge can be re-wired to the new nodes after re-insertion.
 */
export interface SavedCrossFileEdge {
  /** Source node ID (in another file — NOT being re-indexed) */
  sourceId: string;
  /** File path of the source node */
  sourceFilePath: string;
  /** Language of the source node */
  sourceLanguage: Language;
  /** Name of the target node (in the file being re-indexed) */
  targetName: string;
  /** Kind of the target node */
  targetKind: string;
  /** Previous identity, including overload/owner information (not just a name). */
  targetId: string;
  targetQualifiedName: string;
  targetSignature: string | null;
  targetIsDeclaration: boolean;
  /** Edge relationship kind */
  edgeKind: string;
  /** Edge metadata (JSON string from DB) */
  metadata: string | null;
  /** Line number at the edge site */
  line: number | null;
  /** Column number at the edge site */
  col: number | null;
  /** How the edge was created */
  provenance: string | null;
}

/**
 * A reference that couldn't be resolved during extraction
 */
export interface UnresolvedReference {
  /**
   * `unresolved_refs.id` when the reference was loaded from SQLite.
   *
   * Resolution cleanup uses this exact row id so two same-named call sites
   * owned by the same node cannot delete each other across a batch boundary.
   */
  rowId?: number;

  /** ID of the node containing the reference */
  fromNodeId: string;

  /** Name being referenced */
  referenceName: string;

  /** Type of reference (call, type, import, etc.) */
  referenceKind: EdgeKind;

  /** Location of the reference */
  line: number;
  column: number;

  /** File path where reference occurs (denormalized for performance) */
  filePath?: string;

  /** Language of the source file (denormalized for performance) */
  language?: Language;

  /** Possible qualified names it might resolve to */
  candidates?: string[];
}

// =============================================================================
// Query Types
// =============================================================================

/**
 * A subgraph containing a subset of the knowledge graph
 */
export interface Subgraph {
  /** Nodes in this subgraph */
  nodes: Map<string, Node>;

  /** Edges in this subgraph */
  edges: Edge[];

  /** Root node IDs (entry points) */
  roots: string[];

  /**
   * Retrieval confidence for context-style queries. `'low'` means the query
   * resolved only to isolated common-word matches (no entry point corroborated
   * by 2+ distinct query terms) — callers should surface an honest handoff to
   * explore/trace rather than present the results as comprehensive. Undefined
   * for graph traversals that don't run the search-ranking path.
   */
  confidence?: 'high' | 'low';
}

/**
 * Options for graph traversal
 */
export interface TraversalOptions {
  /** Maximum depth to traverse (default: Infinity) */
  maxDepth?: number;

  /** Edge types to follow (default: all) */
  edgeKinds?: EdgeKind[];

  /** Node types to include (default: all) */
  nodeKinds?: NodeKind[];

  /** Direction of traversal */
  direction?: 'outgoing' | 'incoming' | 'both';

  /** Maximum nodes to return */
  limit?: number;

  /** Whether to include the starting node */
  includeStart?: boolean;
}

/**
 * Options for searching the graph
 */
export interface SearchOptions {
  /** Node types to search */
  kinds?: NodeKind[];

  /** Languages to include */
  languages?: Language[];

  /**
   * Case-insensitive file-path globs to include. Slash-free patterns match a
   * basename in any directory; patterns containing `/` match the full path.
   * This is glob matching, not arbitrary substring matching.
   */
  includePatterns?: string[];

  /**
   * Case-insensitive file-path globs to exclude. Slash-free patterns match a
   * basename in any directory; patterns containing `/` match the full path.
   */
  excludePatterns?: string[];

  /** Only return symbols whose source span contains this 1-based line */
  line?: number;

  /**
   * Optional soft file-path hint used only for ranking. Candidates are never
   * excluded when this path is absent or only approximately matches.
   */
  pathHint?: string;

  /** Maximum results to return */
  limit?: number;

  /** Offset for pagination */
  offset?: number;

  /** Whether search is case-sensitive */
  caseSensitive?: boolean;

  /**
   * Strict exact-match lookup. Bare queries match `name` byte-for-byte;
   * qualified queries (`A::B::name`, `A.B.name`, `module/name`) match the
   * semantic qualified name or module path. Case-sensitive, with no prefix /
   * substring / edit-distance fallback. When false (default) the FTS → LIKE →
   * fuzzy chain is used.
   */
  exact?: boolean;
}

/**
 * A search result with relevance scoring
 */
export interface SearchResult {
  /** Matching node */
  node: Node;

  /** Relevance score (0-1) */
  score: number;

  /** Matched text snippets for highlighting */
  highlights?: string[];
}

// =============================================================================
// Context Types
// =============================================================================

/**
 * Context information for code understanding
 */
export interface Context {
  /** Primary node being examined */
  focal: Node;

  /** Nodes containing the focal node (file, class, etc.) */
  ancestors: Node[];

  /** Nodes directly contained by focal node */
  children: Node[];

  /** Incoming references (who calls/uses this) */
  incomingRefs: Array<{ node: Node; edge: Edge }>;

  /** Outgoing references (what this calls/uses) */
  outgoingRefs: Array<{ node: Node; edge: Edge }>;

  /** Related type information */
  types: Node[];

  /** Relevant imports */
  imports: Node[];
}

/**
 * A block of code with context
 */
export interface CodeBlock {
  /** The code content */
  content: string;

  /** File path */
  filePath: string;

  /** Starting line */
  startLine: number;

  /** Ending line */
  endLine: number;

  /** Language for syntax highlighting */
  language: Language;

  /** Associated node if extracted */
  node?: Node;
}

// =============================================================================
// Database Types
// =============================================================================

/**
 * Database schema version info
 */
export interface SchemaVersion {
  /** Current schema version */
  version: number;

  /** When schema was created/updated */
  appliedAt: number;

  /** Description of this version */
  description?: string;
}

/**
 * Statistics about the knowledge graph
 */
export interface GraphStats {
  /** Total number of nodes */
  nodeCount: number;

  /** Total number of edges */
  edgeCount: number;

  /** Number of tracked files */
  fileCount: number;

  /** Node counts by kind */
  nodesByKind: Record<NodeKind, number>;

  /** Edge counts by kind */
  edgesByKind: Record<EdgeKind, number>;

  /** File counts by language */
  filesByLanguage: Record<Language, number>;

  /** Database size in bytes */
  dbSizeBytes: number;

  /** Last update timestamp */
  lastUpdated: number;
}

// =============================================================================
// Task Context Types (for buildContext)
// =============================================================================

/**
 * Input for building task context
 */
export type TaskInput = string | { title: string; description?: string };

/**
 * Options for building task context
 */
export interface BuildContextOptions {
  /** Maximum number of nodes to include (default: 50) */
  maxNodes?: number;

  /** Maximum number of code blocks to include (default: 10) */
  maxCodeBlocks?: number;

  /** Maximum characters per code block (default: 2000) */
  maxCodeBlockSize?: number;

  /** Whether to include code blocks (default: true) */
  includeCode?: boolean;

  /** Output format (default: 'markdown') */
  format?: 'markdown' | 'json';

  /** Number of semantic search results (default: 5) */
  searchLimit?: number;

  /** Graph traversal depth from entry points (default: 2) */
  traversalDepth?: number;

  /** Minimum semantic similarity score (default: 0.3) */
  minScore?: number;
}

/**
 * Full context for a task, ready for Claude
 */
export interface TaskContext {
  /** The original query/task */
  query: string;

  /** Subgraph of relevant nodes and edges */
  subgraph: Subgraph;

  /** Entry point nodes (from semantic search) */
  entryPoints: Node[];

  /** Code blocks extracted from key nodes */
  codeBlocks: CodeBlock[];

  /** Files involved in this context */
  relatedFiles: string[];

  /** Brief summary of the context */
  summary: string;

  /** Statistics about the context */
  stats: {
    /** Number of nodes included */
    nodeCount: number;
    /** Number of edges included */
    edgeCount: number;
    /** Number of files touched */
    fileCount: number;
    /** Number of code blocks included */
    codeBlockCount: number;
    /** Total characters in code blocks */
    totalCodeSize: number;
  };
}

/**
 * Options for finding relevant context
 */
export interface FindRelevantContextOptions {
  /** Number of semantic search results (default: 5) */
  searchLimit?: number;

  /** Graph traversal depth (default: 2) */
  traversalDepth?: number;

  /** Maximum nodes in result (default: 50) */
  maxNodes?: number;

  /** Minimum semantic similarity score (default: 0.3) */
  minScore?: number;

  /** Edge types to follow in traversal */
  edgeKinds?: EdgeKind[];

  /** Node types to include */
  nodeKinds?: NodeKind[];
}
