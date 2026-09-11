/**
 * Database Queries
 *
 * Prepared statements for CRUD operations on the knowledge graph.
 */

import { SqliteDatabase, SqliteStatement } from './sqlite-adapter';
import picomatch from 'picomatch';
import {
  Node,
  Edge,
  FileRecord,
  UnresolvedReference,
  SavedCrossFileEdge,
  NodeKind,
  EdgeKind,
  Language,
  GraphStats,
  SearchOptions,
  SearchResult,
} from '../types';
import { safeJsonParse } from '../utils';
import {
  comparePathSimilarity,
  comparePathSimilarityScores,
  kindBonus,
  nameMatchBonus,
  scorePathRelevance,
  scorePathSimilarity,
} from '../search/query-utils';
import { parseQuery, boundedEditDistance } from '../search/query-parser';
import {
  canonicalQualifiedName,
  isQualifiedSymbol,
  lastQualifierPart,
  matchesSymbol,
} from '../search/symbol-match';
import { isGeneratedFile } from '../extraction/generated-detection';

/**
 * Path-only heuristic for files that should not be candidates for
 * "dominant file" detection: test/spec files and tool-generated files.
 * Generated files (`*.pb.go`, `*.pulsar.go`, mock outputs, …) often
 * have huge in-file edge counts that dwarf the real source — etcd's
 * `rpc.pb.go` has 4× the in-file edges of `server.go`.
 */
function isLowValueFile(filePath: string): boolean {
  const lp = filePath.toLowerCase();
  return (
    /(?:^|\/)(tests?|__tests?__|spec)\//.test(lp) ||
    /_test\.go$/.test(lp) ||
    /(?:^|\/)test_[^/]+\.py$/.test(lp) ||
    /_test\.py$/.test(lp) ||
    /_spec\.rb$/.test(lp) ||
    /_test\.rb$/.test(lp) ||
    /\.(test|spec)\.[jt]sx?$/.test(lp) ||
    /(test|spec|tests)\.(java|kt|scala)$/.test(lp) ||
    /(tests?|spec)\.cs$/.test(lp) ||
    /tests?\.swift$/.test(lp) ||
    /_test\.dart$/.test(lp) ||
    isGeneratedFile(filePath)
  );
}

const SQLITE_PARAM_CHUNK_SIZE = 500;

/** Bounds rows, not just SQL parameters, for incremental reference resolution. */
export const SCOPED_REFERENCE_BATCH_SIZE = 10000;

export interface PendingReferenceFileChunk {
  filePaths: string[];
  total: number;
  maxRowId: number;
}

export interface PendingReferenceCursor {
  filePath: string;
  rowId: number;
}

/**
 * Database row types (snake_case from SQLite)
 */
interface NodeRow {
  id: string;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  language: string;
  start_line: number;
  end_line: number;
  start_column: number;
  end_column: number;
  docstring: string | null;
  signature: string | null;
  visibility: string | null;
  is_exported: number;
  is_async: number;
  is_static: number;
  is_abstract: number;
  is_declaration: number;
  decorators: string | null;
  type_parameters: string | null;
  return_type: string | null;
  updated_at: number;
}

interface EdgeRow {
  id: number;
  source: string;
  target: string;
  kind: string;
  metadata: string | null;
  line: number | null;
  col: number | null;
  provenance: string | null;
}

interface FileRow {
  path: string;
  content_hash: string;
  language: string;
  size: number;
  modified_at: number;
  indexed_at: number;
  node_count: number;
  errors: string | null;
}

interface UnresolvedRefRow {
  id: number;
  from_node_id: string;
  reference_name: string;
  reference_kind: string;
  line: number;
  col: number;
  candidates: string | null;
  file_path: string;
  language: string;
  status: string;
  name_tail: string;
}

/** Stable snapshot of one failed-reference name selected for retry. */
export interface FailedReferenceRetryGroup {
  nameTail: string;
  total: number;
  maxRowId: number;
}

/** Failed references matching symbols contributed by changed files. */
export interface FailedReferenceRetryPlan {
  groups: FailedReferenceRetryGroup[];
  total: number;
}

/** Last qualified segment that can match a newly-added plain node name. */
function referenceNameTail(referenceName: string): string {
  const separator = Math.max(referenceName.lastIndexOf('.'), referenceName.lastIndexOf(':'));
  return separator >= 0 ? referenceName.slice(separator + 1) : referenceName;
}

/**
 * Convert database row to Node object
 */
function rowToNode(row: NodeRow): Node {
  return {
    id: row.id,
    kind: row.kind as NodeKind,
    name: row.name,
    qualifiedName: row.qualified_name,
    filePath: row.file_path,
    language: row.language as Language,
    startLine: row.start_line,
    endLine: row.end_line,
    startColumn: row.start_column,
    endColumn: row.end_column,
    docstring: row.docstring ?? undefined,
    signature: row.signature ?? undefined,
    visibility: row.visibility as Node['visibility'],
    isExported: row.is_exported === 1,
    isAsync: row.is_async === 1,
    isStatic: row.is_static === 1,
    isAbstract: row.is_abstract === 1,
    isDeclaration: row.is_declaration === 1,
    decorators: row.decorators ? safeJsonParse(row.decorators, undefined) : undefined,
    typeParameters: row.type_parameters ? safeJsonParse(row.type_parameters, undefined) : undefined,
    returnType: row.return_type ?? undefined,
    updatedAt: row.updated_at,
  };
}

/**
 * Convert database row to Edge object
 */
function rowToEdge(row: EdgeRow): Edge {
  return {
    source: row.source,
    target: row.target,
    kind: row.kind as EdgeKind,
    metadata: row.metadata ? safeJsonParse(row.metadata, undefined) : undefined,
    line: row.line ?? undefined,
    column: row.col ?? undefined,
    provenance: row.provenance as Edge['provenance'],
  };
}

/**
 * Convert database row to FileRecord object
 */
function rowToFileRecord(row: FileRow): FileRecord {
  return {
    path: row.path,
    contentHash: row.content_hash,
    language: row.language as Language,
    size: row.size,
    modifiedAt: row.modified_at,
    indexedAt: row.indexed_at,
    nodeCount: row.node_count,
    errors: row.errors ? safeJsonParse(row.errors, undefined) : undefined,
  };
}

/**
 * Preserve relevance as the primary search order while making equal-score
 * results stable. Definitions precede declarations so callers that select the
 * first exact-name hit do not accidentally inspect a prototype with no edges.
 */
function compareSearchResultsDeterministically(a: SearchResult, b: SearchResult): number {
  if (a.score !== b.score) return b.score - a.score;

  const declarationOrder =
    Number(a.node.isDeclaration === true) - Number(b.node.isDeclaration === true);
  if (declarationOrder !== 0) return declarationOrder;

  const lengthOrder = a.node.name.length - b.node.name.length;
  if (lengthOrder !== 0) return lengthOrder;

  const textFields: Array<[string, string]> = [
    [a.node.name, b.node.name],
    [a.node.qualifiedName ?? a.node.name, b.node.qualifiedName ?? b.node.name],
    [a.node.kind, b.node.kind],
    [a.node.filePath, b.node.filePath],
  ];
  for (const [left, right] of textFields) {
    if (left < right) return -1;
    if (left > right) return 1;
  }

  const lineOrder = (a.node.startLine ?? 0) - (b.node.startLine ?? 0);
  if (lineOrder !== 0) return lineOrder;

  const columnOrder = (a.node.startColumn ?? 0) - (b.node.startColumn ?? 0);
  if (columnOrder !== 0) return columnOrder;

  if (a.node.id < b.node.id) return -1;
  if (a.node.id > b.node.id) return 1;
  return 0;
}

function compareNodesDeterministically(a: Node, b: Node): number {
  return compareSearchResultsDeterministically(
    { node: a, score: 0 },
    { node: b, score: 0 }
  );
}

/** Compile the public SearchOptions path globs once per query. */
function createSearchPathMatcher(
  includePatterns: string[] = [],
  excludePatterns: string[] = []
): ((filePath: string) => boolean) | undefined {
  const normalizePattern = (pattern: string) => pattern.trim().replace(/\\/g, '/');
  const compilePattern = (pattern: string) => picomatch(
    pattern.includes('/') ? pattern : `**/${pattern}`,
    { dot: true, nocase: true }
  );
  const includes = includePatterns
    .map(normalizePattern)
    .filter(Boolean)
    .map(compilePattern);
  const excludes = excludePatterns
    .map(normalizePattern)
    .filter(Boolean)
    .map(compilePattern);
  if (includes.length === 0 && excludes.length === 0) return undefined;

  return (filePath: string): boolean => {
    const normalized = filePath.replace(/\\/g, '/');
    if (includes.length > 0 && !includes.some((matches) => matches(normalized))) return false;
    return !excludes.some((matches) => matches(normalized));
  };
}

function nodeContainsLine(node: Node, line: number | undefined): boolean {
  if (line === undefined) return true;
  return node.startLine <= line && (node.endLine ?? node.startLine) >= line;
}

function deterministicNodeOrderSql(tableAlias = ''): string {
  const column = (name: string) => `${tableAlias}${name}`;
  return [
    `${column('is_declaration')} ASC`,
    `length(${column('name')}) ASC`,
    `${column('name')} ASC`,
    `${column('qualified_name')} ASC`,
    `${column('kind')} ASC`,
    `${column('file_path')} ASC`,
    `${column('start_line')} ASC`,
    `${column('start_column')} ASC`,
    `${column('id')} ASC`,
  ].join(', ');
}

/**
 * Query builder for the knowledge graph database
 */
export class QueryBuilder {
  private db: SqliteDatabase;

  // Project-name tokens (go.mod / package.json / repo dir), normalized. A query
  // word matching one is dropped from path-relevance scoring — it names the
  // whole project, not a symbol, so it carries no discriminative signal (#720).
  // Set once by the CodeGraph instance; empty by default (no down-weighting).
  private projectNameTokens: Set<string> = new Set();

  // Node cache for frequently accessed nodes (LRU-style, max 1000 entries)
  private nodeCache: Map<string, Node> = new Map();
  private readonly maxCacheSize = 1000;

  // Prepared statements (lazily initialized)
  private stmts: {
    insertNode?: SqliteStatement;
    updateNode?: SqliteStatement;
    deleteNode?: SqliteStatement;
    deleteNodesByFile?: SqliteStatement;
    getNodeById?: SqliteStatement;
    getNodesByFile?: SqliteStatement;
    getNodesByKind?: SqliteStatement;
    getClassesContainingMethod?: SqliteStatement;
    insertEdge?: SqliteStatement;
    upsertFile?: SqliteStatement;
    deleteEdgesBySource?: SqliteStatement;
    deleteEdgesByTarget?: SqliteStatement;
    getEdgesBySource?: SqliteStatement;
    getEdgesByTarget?: SqliteStatement;
    insertFile?: SqliteStatement;
    updateFile?: SqliteStatement;
    deleteFile?: SqliteStatement;
    getFileByPath?: SqliteStatement;
    getAllFiles?: SqliteStatement;
    insertUnresolved?: SqliteStatement;
    deleteUnresolvedByNode?: SqliteStatement;
    getUnresolvedByName?: SqliteStatement;
    getPendingSupertypes?: SqliteStatement;
    getNodesByName?: SqliteStatement;
    getNodesByQualifiedNameExact?: SqliteStatement;
    getNodesByLowerName?: SqliteStatement;
    getUnresolvedCount?: SqliteStatement;
    getUnresolvedBatch?: SqliteStatement;
    getUnresolvedBatchAfter?: SqliteStatement;
    getFailedRetryBatch?: SqliteStatement;
    deleteRefsByRowIdsFull?: SqliteStatement;
    getAllFilePaths?: SqliteStatement;
    getAllNodeNames?: SqliteStatement;
    hasNodeName?: SqliteStatement;
    getDominantFile?: SqliteStatement;
    getTopRouteFile?: SqliteStatement;
    getRoutingManifest?: SqliteStatement;
  } = {};

  // Multi-row INSERT statements cached by operation and row count. A maximum
  // batch of 32 keeps even the 22-column node insert below sql.js's commonly
  // compiled 999-variable limit while removing most JS-to-SQLite call overhead.
  private batchStmts: Map<string, SqliteStatement> = new Map();

  // Keys depend only on query shape and <=500 placeholders, never paths or
  // page numbers. sql.js retains prepared statements until connection close.
  private scopedRefStmts: Map<string, SqliteStatement> = new Map();

  private scopedRefStatement(key: string, sql: string): SqliteStatement {
    let stmt = this.scopedRefStmts.get(key);
    if (!stmt) { stmt = this.db.prepare(sql); this.scopedRefStmts.set(key, stmt); }
    return stmt;
  }
  private static readonly BATCH_SIZES: readonly number[] = [32, 8, 1];

  private runBatched(
    kind: string,
    head: string,
    tuple: string,
    rows: unknown[][]
  ): void {
    if (rows.length === 0) return;
    let offset = 0;
    const batchSizes =
      process.env.CODEGRAPH_NO_BATCH_WRITES === '1'
        ? ([1] as const)
        : QueryBuilder.BATCH_SIZES;
    for (const size of batchSizes) {
      while (rows.length - offset >= size) {
        const key = `${kind}:${size}`;
        let stmt = this.batchStmts.get(key);
        if (!stmt) {
          stmt = this.db.prepare(head + new Array(size).fill(tuple).join(','));
          this.batchStmts.set(key, stmt);
        }
        if (size === 1) {
          stmt.run(...rows[offset]!);
        } else {
          const params: unknown[] = [];
          for (let rowIndex = 0; rowIndex < size; rowIndex++) {
            params.push(...rows[offset + rowIndex]!);
          }
          stmt.run(...params);
        }
        offset += size;
      }
    }
  }

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  /** Set the normalized project-name tokens used to down-weight non-discriminative
   * query words in path scoring (#720). Called once when the project opens. */
  setProjectNameTokens(tokens: Set<string>): void {
    this.projectNameTokens = tokens;
  }

  /** The normalized project-name tokens (#720); empty if none were derived. */
  getProjectNameTokens(): Set<string> {
    return this.projectNameTokens;
  }

  // ===========================================================================
  // Node Operations
  // ===========================================================================

  /**
   * Insert a new node
   */
  insertNode(node: Node): void {
    if (!this.stmts.insertNode) {
      this.stmts.insertNode = this.db.prepare(`
        INSERT OR REPLACE INTO nodes (
          id, kind, name, qualified_name, file_path, language,
          start_line, end_line, start_column, end_column,
          docstring, signature, visibility,
          is_exported, is_async, is_static, is_abstract, is_declaration,
          decorators, type_parameters, return_type, updated_at
        ) VALUES (
          @id, @kind, @name, @qualifiedName, @filePath, @language,
          @startLine, @endLine, @startColumn, @endColumn,
          @docstring, @signature, @visibility,
          @isExported, @isAsync, @isStatic, @isAbstract, @isDeclaration,
          @decorators, @typeParameters, @returnType, @updatedAt
        )
      `);
    }

    // Validate required fields to prevent SQLite bind errors
    if (!node.id || !node.kind || !node.name || !node.filePath || !node.language) {
      console.error('[CodeGraph] Skipping node with missing required fields:', {
        id: node.id,
        kind: node.kind,
        name: node.name,
        filePath: node.filePath,
        language: node.language,
      });
      return;
    }

    // INSERT OR REPLACE may overwrite a node we have cached. Drop the
    // stale entry so the next getNodeById sees the new row, not the old
    // one (matches the cache-invalidation pattern used by updateNode and
    // deleteNode below).
    this.nodeCache.delete(node.id);

    this.stmts.insertNode.run({
      id: node.id,
      kind: node.kind,
      name: node.name,
      qualifiedName: node.qualifiedName ?? node.name,
      filePath: node.filePath,
      language: node.language,
      startLine: node.startLine ?? 0,
      endLine: node.endLine ?? 0,
      startColumn: node.startColumn ?? 0,
      endColumn: node.endColumn ?? 0,
      docstring: node.docstring ?? null,
      signature: node.signature ?? null,
      visibility: node.visibility ?? null,
      isExported: node.isExported ? 1 : 0,
      isAsync: node.isAsync ? 1 : 0,
      isStatic: node.isStatic ? 1 : 0,
      isAbstract: node.isAbstract ? 1 : 0,
      isDeclaration: node.isDeclaration ? 1 : 0,
      decorators: node.decorators ? JSON.stringify(node.decorators) : null,
      typeParameters: node.typeParameters ? JSON.stringify(node.typeParameters) : null,
      returnType: node.returnType ?? null,
      updatedAt: node.updatedAt ?? Date.now(),
    });
  }

  /**
   * Insert multiple nodes in a transaction
   */
  insertNodes(nodes: Node[]): void {
    this.db.transaction(() => {
      const rows: unknown[][] = [];
      for (const node of nodes) {
        if (!node.id || !node.kind || !node.name || !node.filePath || !node.language) {
          console.error('[CodeGraph] Skipping node with missing required fields:', {
            id: node.id,
            kind: node.kind,
            name: node.name,
            filePath: node.filePath,
            language: node.language,
          });
          continue;
        }
        this.nodeCache.delete(node.id);
        rows.push([
          node.id,
          node.kind,
          node.name,
          node.qualifiedName ?? node.name,
          node.filePath,
          node.language,
          node.startLine ?? 0,
          node.endLine ?? 0,
          node.startColumn ?? 0,
          node.endColumn ?? 0,
          node.docstring ?? null,
          node.signature ?? null,
          node.visibility ?? null,
          node.isExported ? 1 : 0,
          node.isAsync ? 1 : 0,
          node.isStatic ? 1 : 0,
          node.isAbstract ? 1 : 0,
          node.isDeclaration ? 1 : 0,
          node.decorators ? JSON.stringify(node.decorators) : null,
          node.typeParameters ? JSON.stringify(node.typeParameters) : null,
          node.returnType ?? null,
          node.updatedAt ?? Date.now(),
        ]);
      }
      this.runBatched(
        'insertNodes',
        `INSERT OR REPLACE INTO nodes (
          id, kind, name, qualified_name, file_path, language,
          start_line, end_line, start_column, end_column,
          docstring, signature, visibility,
          is_exported, is_async, is_static, is_abstract, is_declaration,
          decorators, type_parameters, return_type, updated_at
        ) VALUES `,
        '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        rows
      );
    })();
  }

  /**
   * Store one fresh-index file as one transaction. Callers must pre-filter
   * edges and refs to the valid node ids in this bundle.
   */
  storeFileBundle(bundle: {
    nodes: Node[];
    edges: Edge[];
    refs: UnresolvedReference[];
    file: FileRecord;
  }): void {
    this.db.transaction(() => {
      this.insertNodes(bundle.nodes);
      this.insertEdgesUnchecked(bundle.edges);
      this.insertUnresolvedRefsBatch(bundle.refs);
      this.upsertFile(bundle.file);
    })();
  }

  /**
   * Update an existing node
   */
  updateNode(node: Node): void {
    if (!this.stmts.updateNode) {
      this.stmts.updateNode = this.db.prepare(`
        UPDATE nodes SET
          kind = @kind,
          name = @name,
          qualified_name = @qualifiedName,
          file_path = @filePath,
          language = @language,
          start_line = @startLine,
          end_line = @endLine,
          start_column = @startColumn,
          end_column = @endColumn,
          docstring = @docstring,
          signature = @signature,
          visibility = @visibility,
          is_exported = @isExported,
          is_async = @isAsync,
          is_static = @isStatic,
          is_abstract = @isAbstract,
          is_declaration = @isDeclaration,
          decorators = @decorators,
          type_parameters = @typeParameters,
          return_type = @returnType,
          updated_at = @updatedAt
        WHERE id = @id
      `);
    }

    // Invalidate cache before update
    this.nodeCache.delete(node.id);

    // Validate required fields
    if (!node.id || !node.kind || !node.name || !node.filePath || !node.language) {
      console.error('[CodeGraph] Skipping node update with missing required fields:', node.id);
      return;
    }

    this.stmts.updateNode.run({
      id: node.id,
      kind: node.kind,
      name: node.name,
      qualifiedName: node.qualifiedName ?? node.name,
      filePath: node.filePath,
      language: node.language,
      startLine: node.startLine ?? 0,
      endLine: node.endLine ?? 0,
      startColumn: node.startColumn ?? 0,
      endColumn: node.endColumn ?? 0,
      docstring: node.docstring ?? null,
      signature: node.signature ?? null,
      visibility: node.visibility ?? null,
      isExported: node.isExported ? 1 : 0,
      isAsync: node.isAsync ? 1 : 0,
      isStatic: node.isStatic ? 1 : 0,
      isAbstract: node.isAbstract ? 1 : 0,
      isDeclaration: node.isDeclaration ? 1 : 0,
      decorators: node.decorators ? JSON.stringify(node.decorators) : null,
      typeParameters: node.typeParameters ? JSON.stringify(node.typeParameters) : null,
      returnType: node.returnType ?? null,
      updatedAt: node.updatedAt ?? Date.now(),
    });
  }

  /**
   * Delete a node by ID
   */
  deleteNode(id: string): void {
    if (!this.stmts.deleteNode) {
      this.stmts.deleteNode = this.db.prepare('DELETE FROM nodes WHERE id = ?');
    }
    // Invalidate cache
    this.nodeCache.delete(id);
    this.stmts.deleteNode.run(id);
  }

  /**
   * Delete all nodes for a file
   */
  deleteNodesByFile(filePath: string): void {
    if (!this.stmts.deleteNodesByFile) {
      this.stmts.deleteNodesByFile = this.db.prepare('DELETE FROM nodes WHERE file_path = ?');
    }
    // Invalidate cache for nodes in this file
    for (const [id, node] of this.nodeCache) {
      if (node.filePath === filePath) {
        this.nodeCache.delete(id);
      }
    }
    this.stmts.deleteNodesByFile.run(filePath);
  }

  /**
   * Get a node by ID
   */
  getNodeById(id: string): Node | null {
    // Check cache first
    if (this.nodeCache.has(id)) {
      const cached = this.nodeCache.get(id)!;
      // Move to end to implement LRU (delete and re-add)
      this.nodeCache.delete(id);
      this.nodeCache.set(id, cached);
      return cached;
    }

    if (!this.stmts.getNodeById) {
      this.stmts.getNodeById = this.db.prepare('SELECT * FROM nodes WHERE id = ?');
    }
    const row = this.stmts.getNodeById.get(id) as NodeRow | undefined;
    if (!row) {
      return null;
    }

    const node = rowToNode(row);
    this.cacheNode(node);
    return node;
  }

  /**
   * Batch lookup: fetch many nodes by ID in a single SQL round-trip.
   *
   * Replaces the N+1 pattern in graph traversal where every edge would
   * trigger its own `getNodeById` call. For a function with 50 callers
   * this collapses 50 point reads into one IN-list query (~10-50x
   * faster end-to-end).
   *
   * Returns a Map keyed by id so callers can preserve their own ordering
   * (typically the order edges were returned from the graph). Missing IDs
   * are simply absent from the map.
   *
   * Cache-aware: ids already in the LRU cache are served from memory and
   * the SQL query only touches the misses.
   */
  getNodesByIds(ids: readonly string[]): Map<string, Node> {
    const out = new Map<string, Node>();
    if (ids.length === 0) return out;

    // Serve cache hits first; build the miss list for SQL.
    const misses: string[] = [];
    for (const id of ids) {
      const cached = this.nodeCache.get(id);
      if (cached !== undefined) {
        // LRU touch
        this.nodeCache.delete(id);
        this.nodeCache.set(id, cached);
        out.set(id, cached);
      } else {
        misses.push(id);
      }
    }
    if (misses.length === 0) return out;

    // Chunk under SQLite's parameter limit (default 999, raised to 32766
    // in better-sqlite3 builds — chunk at 500 for safety across both
    // backends and to keep the query plan simple).
    for (let i = 0; i < misses.length; i += SQLITE_PARAM_CHUNK_SIZE) {
      const chunk = misses.slice(i, i + SQLITE_PARAM_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db
        .prepare(`SELECT * FROM nodes WHERE id IN (${placeholders})`)
        .all(...chunk) as NodeRow[];
      for (const row of rows) {
        const node = rowToNode(row);
        out.set(node.id, node);
        this.cacheNode(node);
      }
    }
    return out;
  }

  private getExistingNodeIds(ids: readonly string[]): Set<string> {
    const out = new Set<string>();
    if (ids.length === 0) return out;

    const uniqueIds = [...new Set(ids)];
    for (let i = 0; i < uniqueIds.length; i += SQLITE_PARAM_CHUNK_SIZE) {
      const chunk = uniqueIds.slice(i, i + SQLITE_PARAM_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db
        .prepare(`SELECT id FROM nodes WHERE id IN (${placeholders})`)
        .all(...chunk) as { id: string }[];
      for (const row of rows) {
        out.add(row.id);
      }
    }

    return out;
  }

  /**
   * Add a node to the cache, evicting oldest if needed
   */
  private cacheNode(node: Node): void {
    if (this.nodeCache.size >= this.maxCacheSize) {
      // Evict oldest (first) entry
      const firstKey = this.nodeCache.keys().next().value;
      if (firstKey) {
        this.nodeCache.delete(firstKey);
      }
    }
    this.nodeCache.set(node.id, node);
  }

  /**
   * Clear the node cache
   */
  clearCache(): void {
    this.nodeCache.clear();
  }

  /**
   * Get all nodes in a file
   */
  getNodesByFile(filePath: string): Node[] {
    if (!this.stmts.getNodesByFile) {
      this.stmts.getNodesByFile = this.db.prepare(
        'SELECT * FROM nodes WHERE file_path = ? ORDER BY start_line'
      );
    }
    const rows = this.stmts.getNodesByFile.all(filePath) as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Find the file that holds the densest concentration of the project's
   * internal call graph — the "core" file. Used by context-builder to
   * boost ranking of symbols in that file's directory (so e.g. sinatra
   * queries surface `lib/sinatra/base.rb`'s `route!` instead of
   * `sinatra-contrib/lib/sinatra/multi_route.rb`'s `route` extension).
   *
   * Returns null if no file has a meaningful concentration (e.g. spread
   * evenly across many files, or empty index).
   *
   * "Internal" = source and target are in the same file. Cross-file
   * edges aren't useful here — they don't tell us which file is the
   * functional center.
   *
   * Excludes test/spec files from candidacy via path-pattern. The agent's
   * typical question is "how does X work", not "how is X tested", so
   * boosting a test file's directory would be a misfire.
   */
  getDominantFile(): { filePath: string; edgeCount: number; nextEdgeCount: number } | null {
    if (!this.stmts.getDominantFile) {
      // Pull top 20 candidates; we then filter out test/generated files
      // in code (regex-grade matching that SQL LIKE can't express). The
      // generated-file filter is critical — without it, etcd's
      // `api/etcdserverpb/rpc.pb.go` (1916 in-file edges, generated
      // protobuf stub) outranks the real `server/etcdserver/server.go`
      // (470 edges) by 4×, and the boost would push the agent toward
      // generated code.
      this.stmts.getDominantFile = this.db.prepare(`
        SELECT n.file_path AS file_path, COUNT(*) AS edge_count
        FROM edges e
        JOIN nodes n ON e.source = n.id
        JOIN nodes m ON e.target = m.id
        WHERE n.file_path = m.file_path
        GROUP BY n.file_path
        ORDER BY edge_count DESC
        LIMIT 20
      `);
    }
    const rows = this.stmts.getDominantFile.all() as Array<{ file_path: string; edge_count: number }>;
    const filtered = rows.filter(r => !isLowValueFile(r.file_path));
    if (filtered.length === 0 || filtered[0]!.edge_count < 20) return null;
    return {
      filePath: filtered[0]!.file_path,
      edgeCount: filtered[0]!.edge_count,
      nextEdgeCount: filtered[1]?.edge_count ?? 0,
    };
  }

  /**
   * Find the file that holds the densest concentration of the project's
   * `route` nodes (framework-emitted: Express/Gin/Flask/Rails/Drupal/etc.).
   * Used by handleContext on small repos to inline the project's routing
   * config when the agent's query is about request flow — eliminating the
   * "Glob + Read routes.rb" pattern that beats codegraph on tiny realworld
   * template repos.
   *
   * Excludes test/generated files from candidacy. Returns null if there
   * are fewer than 3 non-test routes total, or if no file holds at least
   * 30% of them (diffuse routing → no single answer file).
   */
  getTopRouteFile(): { filePath: string; routeCount: number; totalRoutes: number } | null {
    if (!this.stmts.getTopRouteFile) {
      this.stmts.getTopRouteFile = this.db.prepare(`
        SELECT file_path, COUNT(*) AS cnt
        FROM nodes
        WHERE kind = 'route'
        GROUP BY file_path
        ORDER BY cnt DESC
        LIMIT 20
      `);
    }
    const rows = this.stmts.getTopRouteFile.all() as Array<{ file_path: string; cnt: number }>;
    const filtered = rows.filter(r => !isLowValueFile(r.file_path));
    if (filtered.length === 0) return null;
    const totalRoutes = filtered.reduce((sum, r) => sum + r.cnt, 0);
    const top = filtered[0]!;
    if (totalRoutes < 3 || top.cnt < 3) return null;
    if (top.cnt / totalRoutes < 0.30) return null;
    return { filePath: top.file_path, routeCount: top.cnt, totalRoutes };
  }

  /**
   * Build a URL → handler manifest from the index. Each route node's
   * `references` edge points at the function/method that handles the
   * request. We join them in one pass; the agent gets the canonical
   * routing answer ("POST /users/login → AuthController#login") without
   * having to parse the framework's route DSL itself.
   *
   * Also returns the file with the most handler endpoints — used as the
   * "top handler file" to inline source for, so the agent has both the
   * mapping AND the handler implementations.
   */
  getRoutingManifest(limit: number = 40): {
    entries: Array<{ url: string; handler: string; handlerFile: string; handlerLine: number; handlerKind: string }>;
    topHandlerFile: string | null;
    topHandlerFileCount: number;
    totalRoutes: number;
  } | null {
    if (!this.stmts.getRoutingManifest) {
      // Edge kind varies across framework resolvers: Spring/Rails/
      // Laravel/Drupal emit `references`, Express emits `calls`. Accept
      // both — the semantic is the same (route → its handler).
      this.stmts.getRoutingManifest = this.db.prepare(`
        SELECT
          r.name AS url,
          h.name AS handler,
          h.file_path AS handler_file,
          h.start_line AS handler_line,
          h.kind AS handler_kind
        FROM nodes r
        JOIN edges e ON e.source = r.id
        JOIN nodes h ON e.target = h.id
        WHERE r.kind = 'route'
          AND e.kind IN ('references', 'calls')
          AND h.kind IN ('function', 'method', 'class')
        ORDER BY r.file_path, r.start_line
        LIMIT ?
      `);
    }
    const rows = this.stmts.getRoutingManifest.all(limit) as Array<{
      url: string; handler: string; handler_file: string; handler_line: number; handler_kind: string;
    }>;
    // Drop test/generated handlers — same hygiene as elsewhere.
    const filtered = rows.filter(r => !isLowValueFile(r.handler_file));
    if (filtered.length < 3) return null;
    // Identify the file holding the most handlers (the "primary handler file").
    const fileCounts = new Map<string, number>();
    for (const r of filtered) {
      fileCounts.set(r.handler_file, (fileCounts.get(r.handler_file) ?? 0) + 1);
    }
    let topHandlerFile: string | null = null;
    let topHandlerFileCount = 0;
    for (const [file, count] of fileCounts) {
      if (count > topHandlerFileCount) {
        topHandlerFile = file;
        topHandlerFileCount = count;
      }
    }
    return {
      entries: filtered.map(r => ({
        url: r.url,
        handler: r.handler,
        handlerFile: r.handler_file,
        handlerLine: r.handler_line,
        handlerKind: r.handler_kind,
      })),
      topHandlerFile,
      topHandlerFileCount,
      totalRoutes: filtered.length,
    };
  }

  /**
   * Get all nodes of a specific kind
   */
  getNodesByKind(kind: NodeKind): Node[] {
    if (!this.stmts.getNodesByKind) {
      this.stmts.getNodesByKind = this.db.prepare('SELECT * FROM nodes WHERE kind = ?');
    }
    const rows = this.stmts.getNodesByKind.all(kind) as NodeRow[];
    return rows.map(rowToNode);
  }

  /** Find render/build-style owners without materializing every class. */
  getClassesContainingMethod(name: string): Node[] {
    if (!this.stmts.getClassesContainingMethod) {
      // Fix the traversal at the selective name lookup. Without statistics,
      // SQLite can otherwise start at every class and test an IN subquery.
      this.stmts.getClassesContainingMethod = this.db.prepare(`
        SELECT DISTINCT owner.* FROM nodes AS method INDEXED BY idx_nodes_name
        CROSS JOIN edges AS edge ON edge.target = method.id AND edge.kind = 'contains'
        CROSS JOIN nodes AS owner ON owner.id = edge.source
        WHERE method.name = ? AND method.kind = 'method' AND owner.kind = 'class'
        ORDER BY owner.rowid
      `);
    }
    const rows = this.stmts.getClassesContainingMethod.all(name) as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Stream every node of a kind one at a time (lazy) instead of materializing
   * them all like {@link getNodesByKind}. For unbounded kinds (`function`,
   * `method`) on a symbol-dense project the full array is gigabytes; the
   * dynamic-edge synthesizers only scan-and-filter, so they iterate to keep
   * memory O(1) in the node count rather than O(nodes) (#610).
   */
  *iterateNodesByKind(kind: NodeKind): IterableIterator<Node> {
    // Fresh statement per call (not a cached one): an iterator holds an open
    // cursor, so a shared statement would conflict across overlapping scans.
    const stmt = this.db.prepare('SELECT * FROM nodes WHERE kind = ?');
    for (const row of stmt.iterate(kind)) {
      yield rowToNode(row as NodeRow);
    }
  }

  /**
   * Get all nodes in the database
   */
  getAllNodes(): Node[] {
    const rows = this.db.prepare('SELECT * FROM nodes').all() as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Get nodes by exact name match (uses idx_nodes_name index)
   */
  getNodesByName(name: string): Node[] {
    if (!this.stmts.getNodesByName) {
      this.stmts.getNodesByName = this.db.prepare('SELECT * FROM nodes WHERE name = ?');
    }
    const rows = this.stmts.getNodesByName.all(name) as NodeRow[];
    // Re-indexing changes SQLite row order. Many resolver strategies retain
    // the first equally ranked candidate, so use stable symbol order rather
    // than insertion order (which made comment-only sync change targets).
    return rows.map(rowToNode).sort(compareNodesDeterministically);
  }

  /**
   * Get nodes by exact qualified name match (uses idx_nodes_qualified_name index)
   */
  getNodesByQualifiedNameExact(qualifiedName: string): Node[] {
    if (!this.stmts.getNodesByQualifiedNameExact) {
      this.stmts.getNodesByQualifiedNameExact = this.db.prepare(
        'SELECT * FROM nodes WHERE qualified_name = ?'
      );
    }
    const rows = this.stmts.getNodesByQualifiedNameExact.all(qualifiedName) as NodeRow[];
    return rows.map(rowToNode).sort(compareNodesDeterministically);
  }

  /**
   * Get nodes by lowercase name match (uses idx_nodes_lower_name expression index)
   */
  getNodesByLowerName(lowerName: string): Node[] {
    if (!this.stmts.getNodesByLowerName) {
      this.stmts.getNodesByLowerName = this.db.prepare(
        'SELECT * FROM nodes WHERE lower(name) = ?'
      );
    }
    const rows = this.stmts.getNodesByLowerName.all(lowerName) as NodeRow[];
    return rows.map(rowToNode).sort(compareNodesDeterministically);
  }

  /**
   * Enumerate every exact candidate for a bare or qualified symbol.
   *
   * Qualified lookups never go through FTS and therefore cannot lose the
   * wanted overload behind an arbitrary FTS/limit cut. Semantic qualified
   * names (`A::B::name`, `A.B.name`) use `qualified_name`; module-qualified
   * languages whose hierarchy lives in the path use exact tail-name
   * candidates followed by the shared path matcher.
   */
  getNodesBySymbolExact(symbol: string): Node[] {
    if (!isQualifiedSymbol(symbol)) return this.getNodesByName(symbol);

    const candidates = new Map<string, Node>();
    const directQualifiedIds = new Set<string>();
    const add = (nodes: Node[]) => {
      for (const node of nodes) candidates.set(node.id, node);
    };
    const addDirectQualified = (nodes: Node[]) => {
      for (const node of nodes) {
        candidates.set(node.id, node);
        directQualifiedIds.add(node.id);
      }
    };

    addDirectQualified(this.getNodesByQualifiedNameExact(symbol));
    const canonical = canonicalQualifiedName(symbol);
    if (canonical && canonical !== symbol) {
      addDirectQualified(this.getNodesByQualifiedNameExact(canonical));
    }

    // Namespace nodes produced from `namespace A::B` can retain the complete
    // qualifier in `name`; ordinary symbols use the final segment.
    add(this.getNodesByName(symbol));
    const tail = lastQualifierPart(symbol);
    if (tail && tail !== symbol) add(this.getNodesByName(tail));

    return [...candidates.values()]
      // An indexed byte-exact qualified name is authoritative. This also
      // covers C++ template spellings containing `...`, where the dots are
      // syntax rather than qualification separators.
      .filter((node) => directQualifiedIds.has(node.id) || matchesSymbol(node, symbol))
      .sort(compareNodesDeterministically);
  }

  /**
   * Search nodes by name using FTS with fallback to LIKE for better matching
   *
   * Search strategy:
   * 1. Try FTS5 prefix match (query*) for word-start matching
   * 2. If no results, try LIKE for substring matching (e.g., "signIn" finds "signInWithGoogle")
   * 3. Score results based on match quality
   */
  searchNodes(query: string, options: SearchOptions = {}): SearchResult[] {
    const { limit = 100, offset = 0 } = options;
    const pathHint = options.pathHint?.trim() || undefined;
    const pathPatternMatcher = createSearchPathMatcher(
      options.includePatterns,
      options.excludePatterns
    );
    const line = Number.isInteger(options.line) && options.line! > 0
      ? options.line
      : undefined;

    // Parse field-qualified bits out of the raw query (kind:, lang:,
    // path:, name:). Anything not recognised stays in `text` and goes
    // to FTS unchanged. Filters compose with the SearchOptions arg —
    // both are applied (intersection-style).
    const parsed = parseQuery(query);
    const mergedKinds = parsed.kinds.length > 0
      ? options.kinds && options.kinds.length > 0
        ? parsed.kinds.filter((kind) => options.kinds!.includes(kind))
        : parsed.kinds
      : options.kinds;
    const mergedLanguages = parsed.languages.length > 0
      ? options.languages && options.languages.length > 0
        ? parsed.languages.filter((language) => options.languages!.includes(language))
        : parsed.languages
      : options.languages;
    // Structured options and inline filters compose by intersection. An empty
    // intersection is a real conflict, not "no filter".
    if (
      (parsed.kinds.length > 0 && options.kinds?.length && mergedKinds?.length === 0) ||
      (parsed.languages.length > 0 && options.languages?.length && mergedLanguages?.length === 0)
    ) {
      return [];
    }
    const pathFilters = parsed.pathFilters;
    const nameFilters = parsed.nameFilters;
    // The text portion drives FTS/LIKE; if all the user typed was
    // filters (`kind:function`), we still need *some* candidate set,
    // so synthesise an empty-text path that returns everything matching
    // the filters.
    // With no inline fields, exact mode must preserve the query byte-for-byte
    // (apart from outer whitespace). C++ template qualified names can contain
    // spaces/newlines and `...`; tokenizing and joining them changes the
    // indexed qualified name and makes an otherwise exact lookup fail.
    const hasInlineFilters =
      parsed.kinds.length > 0 ||
      parsed.languages.length > 0 ||
      pathFilters.length > 0 ||
      nameFilters.length > 0;
    const text = options.exact && !hasInlineFilters ? query.trim() : parsed.text;
    const kinds = mergedKinds;
    const languages = mergedLanguages;

    // Strict exact-match mode: skip the FTS/LIKE/fuzzy chain entirely. Bare
    // names are byte-equal; qualified names use semantic/path qualification.
    // Used by the CLI `query` command so a symbol lookup is case-sensitive and
    // isn't buried under prefix / case-folded / fuzzy matches.
    if (options.exact) {
      return this.searchNodesExact(text, {
        kinds,
        languages,
        limit,
        offset,
        pathFilters,
        nameFilters,
        pathPatternMatcher,
        line,
        pathHint,
      });
    }

    // Globs and source-span checks are evaluated in JavaScript so they behave
    // identically on better-sqlite3 and sql.js. Pull a wider window and apply
    // caller-visible pagination only after these hard gates.
    const hasPostQueryFilters = pathPatternMatcher !== undefined || line !== undefined;
    const candidateLimit = hasPostQueryFilters
      ? Math.max((limit + offset) * 5, 100)
      : limit;
    const candidateOffset = hasPostQueryFilters ? 0 : offset;
    const candidateOptions: SearchOptions = {
      kinds,
      languages,
      limit: candidateLimit,
      offset: candidateOffset,
    };

    // First try FTS5 with prefix matching
    let results = text
      ? this.searchNodesFTS(text, candidateOptions, pathFilters, nameFilters)
      // Over-fetch by 5× when running filter-only (no text). The
      // post-scoring path: + name: filters can be very selective, so
      // a smaller multiplier risks returning fewer than `limit`
      // results despite the DB having plenty of matches.
      : this.searchAllByFilters({
          kinds,
          languages,
          pathFilters,
          nameFilters,
          limit: hasPostQueryFilters ? candidateLimit : limit * 5,
          offset: candidateOffset,
        });

    // If no FTS results, try LIKE-based substring search
    if (results.length === 0 && text.length >= 2) {
      results = this.searchNodesLike(
        text,
        candidateOptions,
        pathFilters,
        nameFilters
      );
    }

    // Final fuzzy fallback: scan all known names and keep those within
    // a tight Levenshtein distance. Only fires when both FTS and LIKE
    // returned nothing AND there's a text portion long enough to be
    // worth fuzzing (1-char queries would match too much).
    if (results.length === 0 && text.length >= 3) {
      results = this.searchNodesFuzzy(
        text,
        { kinds, languages, limit: candidateLimit },
        pathFilters,
        nameFilters
      );
    }

    // Supplement: ensure exact name matches are always candidates.
    // BM25 can bury short exact-match names (e.g. "getBean") under hundreds of
    // compound names (e.g. "getBeanDescriptor") in large codebases,
    // pushing them past the FTS fetch limit before post-hoc scoring can help.
    // Use the max BM25 score as the base so the nameMatchBonus (exact=30 vs
    // prefix=20) actually differentiates them after rescoring.
    if (results.length > 0 && query) {
      const existingIds = new Set(results.map(r => r.node.id));
      const maxFtsScore = Math.max(...results.map(r => r.score));
      const terms = query.split(/\s+/).filter(t => t.length >= 2);
      for (const term of terms) {
        let sql = 'SELECT * FROM nodes WHERE name = ? COLLATE NOCASE';
        const params: (string | number)[] = [term];
        if (kinds && kinds.length > 0) {
          sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
          params.push(...kinds);
        }
        if (languages && languages.length > 0) {
          sql += ` AND language IN (${languages.map(() => '?').join(',')})`;
          params.push(...languages);
        }
        if (pathFilters.length > 0) {
          sql += ` AND (${pathFilters.map(() => 'instr(lower(file_path), ?) > 0').join(' OR ')})`;
          params.push(...pathFilters.map((path) => path.toLowerCase()));
        }
        if (nameFilters.length > 0) {
          sql += ` AND (${nameFilters.map(() => 'instr(lower(name), ?) > 0').join(' OR ')})`;
          params.push(...nameFilters.map((name) => name.toLowerCase()));
        }
        sql += ` ORDER BY ${deterministicNodeOrderSql()} LIMIT 20`;
        const rows = this.db.prepare(sql).all(...params) as NodeRow[];
        for (const row of rows) {
          if (!existingIds.has(row.id)) {
            results.push({ node: rowToNode(row), score: maxFtsScore });
            existingIds.add(row.id);
          }
        }
      }
    }

    // Apply multi-signal scoring
    if (results.length > 0 && (text || query)) {
      const scoringQuery = text || query;
      results = results.map(r => ({
        ...r,
        score: r.score
          + kindBonus(r.node.kind)
          + scorePathRelevance(r.node.filePath, scoringQuery, this.projectNameTokens)
          + nameMatchBonus(r.node.name, scoringQuery),
      }));
      results.sort((left, right) => {
        if (left.score !== right.score) return right.score - left.score;
        const pathOrder = pathHint
          ? comparePathSimilarity(left.node.filePath, right.node.filePath, pathHint)
          : 0;
        return pathOrder || compareSearchResultsDeterministically(left, right);
      });
    }

    // Apply path: + name: filters AFTER scoring. Scoring already uses
    // path/name as a soft signal; the explicit filters here are a hard
    // gate. Done last so the FTS limit fetched plenty of candidates to
    // narrow from.
    if (pathFilters.length > 0) {
      const lowered = pathFilters.map((p) => p.toLowerCase());
      results = results.filter((r) => {
        const fp = r.node.filePath.toLowerCase();
        return lowered.some((p) => fp.includes(p));
      });
    }
    if (nameFilters.length > 0) {
      const lowered = nameFilters.map((n) => n.toLowerCase());
      results = results.filter((r) => {
        const nm = r.node.name.toLowerCase();
        return lowered.some((n) => nm.includes(n));
      });
    }

    if (pathPatternMatcher) {
      results = results.filter((result) => pathPatternMatcher(result.node.filePath));
    }
    if (line !== undefined) {
      results = results.filter((result) => nodeContainsLine(result.node, line));
    }

    results = hasPostQueryFilters
      ? results.slice(offset, offset + limit)
      : results.slice(0, limit);

    return results;
  }

  /**
   * Strict exact-match lookup used when `SearchOptions.exact` is set.
   *
   * Bare names use the case-sensitive `idx_nodes_name` equality probe.
   * Qualified names enumerate exact tail candidates and apply semantic/path
   * qualification before pagination. `kind`/`language`/`path:`/`name:` narrow
   * the set before LIMIT so selective filters cannot hide a valid result.
   */
  private searchNodesExact(
    text: string,
    options: {
      kinds?: NodeKind[];
      languages?: Language[];
      limit: number;
      offset: number;
      pathFilters: string[];
      nameFilters: string[];
      pathPatternMatcher?: (filePath: string) => boolean;
      line?: number;
      pathHint?: string;
    }
  ): SearchResult[] {
    const {
      kinds,
      languages,
      limit,
      offset,
      pathFilters,
      nameFilters,
      pathPatternMatcher,
      line,
      pathHint,
    } = options;

    const filterNodes = (input: Node[]): Node[] => {
      let nodes = input;
      if (kinds && kinds.length > 0) nodes = nodes.filter((node) => kinds.includes(node.kind));
      if (languages && languages.length > 0) {
        nodes = nodes.filter((node) => languages.includes(node.language));
      }
      if (pathFilters.length > 0) {
        const lowered = pathFilters.map((path) => path.toLowerCase());
        nodes = nodes.filter((node) => {
          const filePath = node.filePath.toLowerCase();
          return lowered.some((path) => filePath.includes(path));
        });
      }
      if (nameFilters.length > 0) {
        const lowered = nameFilters.map((name) => name.toLowerCase());
        nodes = nodes.filter((node) => {
          const name = node.name.toLowerCase();
          return lowered.some((filter) => name.includes(filter));
        });
      }
      if (pathPatternMatcher) {
        nodes = nodes.filter((node) => pathPatternMatcher(node.filePath));
      }
      if (line !== undefined) nodes = nodes.filter((node) => nodeContainsLine(node, line));
      if (!pathHint) return nodes.sort(compareNodesDeterministically);
      const pathScores = new Map<string, ReturnType<typeof scorePathSimilarity>>();
      const scoreFor = (filePath: string): ReturnType<typeof scorePathSimilarity> => {
        let score = pathScores.get(filePath);
        if (!score) {
          score = scorePathSimilarity(filePath, pathHint);
          pathScores.set(filePath, score);
        }
        return score;
      };
      return nodes.sort((left, right) => {
        const leftPathScore = scoreFor(left.filePath);
        const rightPathScore = scoreFor(right.filePath);
        const pathOrder = comparePathSimilarityScores(leftPathScore, rightPathScore);
        if (pathOrder !== 0) return pathOrder;
        const hasPathSignal = [leftPathScore, rightPathScore].some((score) =>
          score.completeSuffixMatch > 0 ||
          score.commonSuffixSegments > 0 ||
          score.sharedDirectorySegments > 0
        );
        if (!hasPathSignal) return compareNodesDeterministically(left, right);
        const declarationOrder = Number(left.isDeclaration === true) - Number(right.isDeclaration === true);
        if (declarationOrder !== 0) return declarationOrder;
        const generatedOrder = Number(isGeneratedFile(left.filePath)) - Number(isGeneratedFile(right.filePath));
        return generatedOrder || compareNodesDeterministically(left, right);
      });
    };

    // No text (e.g. `kind:function` alone) — reuse the filter-only path.
    if (!text) {
      const needsPostFilter = pathPatternMatcher !== undefined || line !== undefined;
      let results = this.searchAllByFilters({
        kinds,
        languages,
        pathFilters,
        nameFilters,
        limit: needsPostFilter ? Math.max((limit + offset) * 5, 100) : limit,
        offset: needsPostFilter ? 0 : offset,
      });
      if (pathPatternMatcher) {
        results = results.filter((result) => pathPatternMatcher(result.node.filePath));
      }
      if (line !== undefined) {
        results = results.filter((result) => nodeContainsLine(result.node, line));
      }
      return needsPostFilter ? results.slice(offset, offset + limit) : results;
    }

    // Enumerate every same-name candidate before hard filters and pagination.
    // This keeps a target reachable even for TEST_F-style names with thousands
    // of physical occurrences.
    const candidates = isQualifiedSymbol(text)
      ? this.getNodesBySymbolExact(text)
      : this.getNodesByName(text);
    return filterNodes(candidates)
      .slice(offset, offset + limit)
      .map((node) => ({ node, score: 1 }));
  }

  /**
   * Match-everything path used when the user supplied only field
   * filters (`kind:function lang:typescript`) with no text. Returns
   * candidates ordered by name; the caller's filter pass narrows to
   * what was asked for.
   */
  private searchAllByFilters(options: {
    kinds?: NodeKind[];
    languages?: Language[];
    pathFilters?: string[];
    nameFilters?: string[];
    limit: number;
    offset?: number;
  }): SearchResult[] {
    const {
      kinds,
      languages,
      pathFilters = [],
      nameFilters = [],
      limit,
      offset = 0,
    } = options;
    let sql = 'SELECT * FROM nodes WHERE 1=1';
    const params: (string | number)[] = [];
    if (kinds && kinds.length > 0) {
      sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }
    if (languages && languages.length > 0) {
      sql += ` AND language IN (${languages.map(() => '?').join(',')})`;
      params.push(...languages);
    }
    if (pathFilters.length > 0) {
      sql += ` AND (${pathFilters.map(() => 'instr(lower(file_path), ?) > 0').join(' OR ')})`;
      params.push(...pathFilters.map((path) => path.toLowerCase()));
    }
    if (nameFilters.length > 0) {
      sql += ` AND (${nameFilters.map(() => 'instr(lower(name), ?) > 0').join(' OR ')})`;
      params.push(...nameFilters.map((name) => name.toLowerCase()));
    }
    sql += ` ORDER BY ${deterministicNodeOrderSql()} LIMIT ? OFFSET ?`;
    params.push(limit, offset);
    const rows = this.db.prepare(sql).all(...params) as NodeRow[];
    return rows.map((row) => ({ node: rowToNode(row), score: 1 }));
  }

  /**
   * Fuzzy fallback: when zero FTS/LIKE hits, try an edit-distance
   * sweep over the distinct symbol-name set. Caps `maxDist` at 2 so
   * `getUssr` finds `getUser` but `process` doesn't match `prosody`.
   * Bounded edit distance keeps each comparison cheap; the per-query
   * scan is O(distinct-name-count) which is far smaller than total
   * node count on any real codebase.
   */
  private searchNodesFuzzy(
    text: string,
    options: { kinds?: NodeKind[]; languages?: Language[]; limit: number },
    pathFilters: string[] = [],
    nameFilters: string[] = []
  ): SearchResult[] {
    const { kinds, languages, limit } = options;
    const lowered = text.toLowerCase();
    const maxDist = lowered.length <= 4 ? 1 : 2;

    // Pull the distinct name list once. The set is cached on QueryBuilder
    // by getAllNodeNames(); even on a 200k-node project the distinct
    // name set is typically O(10k) because most names repeat. The
    // candidate-cap below bounds memory regardless.
    const allNames = this.getAllNodeNames();
    const candidates: Array<{ name: string; dist: number }> = [];
    for (const name of allNames) {
      const dist = boundedEditDistance(name.toLowerCase(), lowered, maxDist);
      if (dist <= maxDist) candidates.push({ name, dist });
    }
    candidates.sort((a, b) => {
      const distanceOrder = a.dist - b.dist;
      if (distanceOrder !== 0) return distanceOrder;
      if (a.name < b.name) return -1;
      if (a.name > b.name) return 1;
      return 0;
    });

    // Cap the per-name follow-up queries. Each survivor triggers a
    // separate `SELECT * FROM nodes WHERE name = ?`; without this cap
    // a project with many similar names (`getUser1`, `getUser2`...)
    // could fan out far beyond `limit` queries before the inner-loop
    // limit kicks in.
    const FUZZY_FOLLOWUP_CAP = Math.max(limit * 2, 50);
    const cappedCandidates = candidates.slice(0, FUZZY_FOLLOWUP_CAP);

    const results: SearchResult[] = [];
    const seen = new Set<string>();
    for (const c of cappedCandidates) {
      if (results.length >= limit) break;
      let sql = 'SELECT * FROM nodes WHERE name = ?';
      const params: (string | number)[] = [c.name];
      if (kinds && kinds.length > 0) {
        sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
        params.push(...kinds);
      }
      if (languages && languages.length > 0) {
        sql += ` AND language IN (${languages.map(() => '?').join(',')})`;
        params.push(...languages);
      }
      if (pathFilters.length > 0) {
        sql += ` AND (${pathFilters.map(() => 'instr(lower(file_path), ?) > 0').join(' OR ')})`;
        params.push(...pathFilters.map((path) => path.toLowerCase()));
      }
      if (nameFilters.length > 0) {
        sql += ` AND (${nameFilters.map(() => 'instr(lower(name), ?) > 0').join(' OR ')})`;
        params.push(...nameFilters.map((name) => name.toLowerCase()));
      }
      sql += ` ORDER BY ${deterministicNodeOrderSql()} LIMIT 5`;
      const rows = this.db.prepare(sql).all(...params) as NodeRow[];
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        // Lower the score for each edit step away from the query so
        // exact-match fallbacks (dist 0) outrank dist-2 typos.
        results.push({ node: rowToNode(row), score: 1 / (1 + c.dist) });
        if (results.length >= limit) break;
      }
    }
    return results;
  }

  /**
   * FTS5 search with prefix matching
   */
  private searchNodesFTS(
    query: string,
    options: SearchOptions,
    pathFilters: string[] = [],
    nameFilters: string[] = []
  ): SearchResult[] {
    const { kinds, languages, limit = 100, offset = 0 } = options;

    // Add prefix wildcard for better matching (e.g., "auth" matches "AuthService", "authenticate")
    // Escape special FTS5 characters and add prefix wildcard.
    //
    // `::` is a qualifier separator in Rust/C++/Ruby, not a token char,
    // so treat it as whitespace before the strip step. Otherwise queries
    // like `stage_apply::run` collapse to `stage_applyrun` (the colons
    // are stripped without splitting) and find nothing. See #173.
    const ftsQuery = query
      .replace(/::/g, ' ') // Rust/C++/Ruby qualifier separator
      .replace(/['"*():^]/g, '') // Remove FTS5 special chars
      .split(/\s+/)
      .filter(term => term.length > 0)
      // Strip FTS5 boolean operators to prevent query manipulation
      .filter(term => !/^(AND|OR|NOT|NEAR)$/i.test(term))
      .map(term => `"${term}"*`) // Prefix match each term
      .join(' OR ');

    if (!ftsQuery) {
      return [];
    }

    // BM25 column weights: id=0, name=20, qualified_name=5, docstring=1, signature=2
    // Heavy name weight ensures exact/prefix name matches rank above incidental
    // mentions in long docstrings or qualified names of nested symbols.
    // Fetch 5x requested limit so post-hoc rescoring (kindBonus, pathRelevance,
    // nameMatchBonus) can promote results that BM25 alone undervalues.
    const ftsLimit = Math.max(limit * 5, 100);

    let sql = `
      SELECT nodes.*, bm25(nodes_fts, 0, 20, 5, 1, 2) as score
      FROM nodes_fts
      JOIN nodes ON nodes_fts.id = nodes.id
      WHERE nodes_fts MATCH ?
    `;

    const params: (string | number)[] = [ftsQuery];

    if (kinds && kinds.length > 0) {
      sql += ` AND nodes.kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }

    if (languages && languages.length > 0) {
      sql += ` AND nodes.language IN (${languages.map(() => '?').join(',')})`;
      params.push(...languages);
    }
    if (pathFilters.length > 0) {
      sql += ` AND (${pathFilters.map(() => 'instr(lower(nodes.file_path), ?) > 0').join(' OR ')})`;
      params.push(...pathFilters.map((path) => path.toLowerCase()));
    }
    if (nameFilters.length > 0) {
      sql += ` AND (${nameFilters.map(() => 'instr(lower(nodes.name), ?) > 0').join(' OR ')})`;
      params.push(...nameFilters.map((name) => name.toLowerCase()));
    }

    sql += ` ORDER BY score, ${deterministicNodeOrderSql('nodes.')} LIMIT ? OFFSET ?`;
    params.push(ftsLimit, offset);

    try {
      const rows = this.db.prepare(sql).all(...params) as (NodeRow & { score: number })[];
      return rows.map((row) => ({
        node: rowToNode(row),
        score: Math.abs(row.score), // bm25 returns negative scores
      }));
    } catch {
      // FTS query failed, return empty
      return [];
    }
  }

  /**
   * LIKE-based substring search for cases where FTS doesn't match
   * Useful for camelCase matching (e.g., "signIn" finds "signInWithGoogle")
   */
  private searchNodesLike(
    query: string,
    options: SearchOptions,
    pathFilters: string[] = [],
    nameFilters: string[] = []
  ): SearchResult[] {
    const { kinds, languages, limit = 100, offset = 0 } = options;

    let sql = `
      SELECT nodes.*,
        CASE
          WHEN name = ? THEN 1.0
          WHEN name LIKE ? THEN 0.9
          WHEN name LIKE ? THEN 0.8
          WHEN qualified_name LIKE ? THEN 0.7
          ELSE 0.5
        END as score
      FROM nodes
      WHERE (
        name LIKE ? OR
        qualified_name LIKE ? OR
        name LIKE ?
      )
    `;

    // Pattern variants for better matching
    const exactMatch = query;
    const startsWith = `${query}%`;
    const contains = `%${query}%`;

    const params: (string | number)[] = [
      exactMatch,     // Exact match score
      startsWith,     // Starts with score
      contains,       // Contains score
      contains,       // Qualified name score
      contains,       // WHERE: name contains
      contains,       // WHERE: qualified_name contains
      startsWith,     // WHERE: name starts with
    ];

    if (kinds && kinds.length > 0) {
      sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }

    if (languages && languages.length > 0) {
      sql += ` AND language IN (${languages.map(() => '?').join(',')})`;
      params.push(...languages);
    }
    if (pathFilters.length > 0) {
      sql += ` AND (${pathFilters.map(() => 'instr(lower(file_path), ?) > 0').join(' OR ')})`;
      params.push(...pathFilters.map((path) => path.toLowerCase()));
    }
    if (nameFilters.length > 0) {
      sql += ` AND (${nameFilters.map(() => 'instr(lower(name), ?) > 0').join(' OR ')})`;
      params.push(...nameFilters.map((name) => name.toLowerCase()));
    }

    sql += ` ORDER BY score DESC, ${deterministicNodeOrderSql()} LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params) as (NodeRow & { score: number })[];

    return rows.map((row) => ({
      node: rowToNode(row),
      score: row.score,
    }));
  }

  /**
   * Find nodes by exact name match
   *
   * Used for hybrid search - looks up symbols by exact name or case-insensitive match.
   * Returns high-confidence matches for known symbol names extracted from query.
   *
   * @param names - Array of symbol names to look up
   * @param options - Search options (kinds, languages, limit)
   * @returns SearchResult array with exact matches scored at 1.0
   */
  findNodesByExactName(names: string[], options: SearchOptions = {}): SearchResult[] {
    if (names.length === 0) return [];

    const { kinds, languages, limit = 50 } = options;

    // Two-pass approach to handle common names (e.g., "run" has 40+ matches):
    // Pass 1: Find which files contain distinctive (rare) symbols from the query.
    // Pass 2: Query each name, boosting results that co-locate with distinctive symbols.

    // Pass 1: Find files containing each queried name, identify distinctive names
    const nameToFiles = new Map<string, Set<string>>();
    for (const name of names) {
      let sql = 'SELECT DISTINCT file_path FROM nodes WHERE name COLLATE NOCASE = ?';
      const params: (string | number)[] = [name];
      if (kinds && kinds.length > 0) {
        sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
        params.push(...kinds);
      }
      sql += ' LIMIT 100';
      const rows = this.db.prepare(sql).all(...params) as { file_path: string }[];
      nameToFiles.set(name.toLowerCase(), new Set(rows.map(r => r.file_path)));
    }

    // Distinctive names are those with fewer than 10 file matches (e.g., "scrapeLoop" = 1 file)
    const distinctiveFiles = new Set<string>();
    for (const [, files] of nameToFiles) {
      if (files.size > 0 && files.size < 10) {
        for (const f of files) distinctiveFiles.add(f);
      }
    }

    // Pass 2: Query each name with per-name limit, scoring by co-location
    const perNameLimit = Math.max(8, Math.ceil(limit / names.length));
    const allResults: SearchResult[] = [];
    const seenIds = new Set<string>();

    for (const name of names) {
      let sql = `
        SELECT nodes.*, 1.0 as score
        FROM nodes
        WHERE name COLLATE NOCASE = ?
      `;
      const params: (string | number)[] = [name];

      if (kinds && kinds.length > 0) {
        sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
        params.push(...kinds);
      }

      if (languages && languages.length > 0) {
        sql += ` AND language IN (${languages.map(() => '?').join(',')})`;
        params.push(...languages);
      }

      // Fetch enough to find co-located results among common names
      sql += ' LIMIT ?';
      params.push(Math.max(perNameLimit * 3, 50));

      const rows = this.db.prepare(sql).all(...params) as (NodeRow & { score: number })[];
      const nameResults: SearchResult[] = [];
      for (const row of rows) {
        const node = rowToNode(row);
        if (seenIds.has(node.id)) continue;
        // Boost results in files that also contain distinctive symbols
        const coLocationBoost = distinctiveFiles.has(node.filePath) ? 20 : 0;
        nameResults.push({ node, score: row.score + coLocationBoost });
      }

      // Sort by score (co-located first), take per-name limit
      nameResults.sort((a, b) => b.score - a.score);
      for (const r of nameResults.slice(0, perNameLimit)) {
        seenIds.add(r.node.id);
        allResults.push(r);
      }
    }

    // Sort all results by score so co-located results bubble up
    allResults.sort((a, b) => b.score - a.score);
    return allResults.slice(0, limit);
  }

  /**
   * Find nodes whose name contains a substring (LIKE-based).
   * Useful for CamelCase-part matching where FTS fails because
   * e.g. "TransportSearchAction" is one FTS token, not matchable by "Search"*.
   *
   * Results are ordered by name length (shorter = more likely to be the core type).
   */
  findNodesByNameSubstring(
    substring: string,
    options: SearchOptions & { excludePrefix?: boolean } = {}
  ): SearchResult[] {
    const { kinds, languages, limit = 30, excludePrefix } = options;

    let sql = `
      SELECT nodes.*, 1.0 as score
      FROM nodes
      WHERE name LIKE ?
    `;
    const params: (string | number)[] = [`%${substring}%`];

    // Exclude prefix matches (handled by FTS-based prefix search in Step 2b)
    if (excludePrefix) {
      sql += ` AND name NOT LIKE ?`;
      params.push(`${substring}%`);
    }

    if (kinds && kinds.length > 0) {
      sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }

    if (languages && languages.length > 0) {
      sql += ` AND language IN (${languages.map(() => '?').join(',')})`;
      params.push(...languages);
    }

    sql += ' ORDER BY length(name) ASC LIMIT ?';
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as (NodeRow & { score: number })[];
    return rows.map((row) => ({
      node: rowToNode(row),
      score: row.score,
    }));
  }

  // ===========================================================================
  // Edge Operations
  // ===========================================================================

  /**
   * Insert a new edge
   */
  insertEdge(edge: Edge): void {
    if (!this.stmts.insertEdge) {
      this.stmts.insertEdge = this.db.prepare(`
        INSERT OR IGNORE INTO edges (source, target, kind, metadata, line, col, provenance)
        VALUES (@source, @target, @kind, @metadata, @line, @col, @provenance)
      `);
    }

    this.stmts.insertEdge.run({
      source: edge.source,
      target: edge.target,
      kind: edge.kind,
      metadata: edge.metadata ? JSON.stringify(edge.metadata) : null,
      line: edge.line ?? null,
      col: edge.column ?? null,
      provenance: edge.provenance ?? null,
    });
  }

  /**
   * Insert multiple edges in a transaction
   */
  insertEdges(edges: Edge[]): void {
    if (edges.length === 0) return;

    this.db.transaction(() => {
      const endpointIds = new Set<string>();
      for (const edge of edges) {
        endpointIds.add(edge.source);
        endpointIds.add(edge.target);
      }
      const existingNodeIds = this.getExistingNodeIds([...endpointIds]);

      this.insertEdgesUnchecked(
        edges.filter(
          (edge) => existingNodeIds.has(edge.source) && existingNodeIds.has(edge.target)
        )
      );
    })();
  }

  /**
   * Stream nodes matching a language and decorator without hydrating the
   * entire node table. The LIKE is only a cheap JSON-text prefilter; callers
   * retain the exact `decorators.includes()` check.
   */
  *iterateNodesByLanguageWithDecorator(
    language: Language,
    decorator: string
  ): IterableIterator<Node> {
    const stmt = this.db.prepare(
      "SELECT * FROM nodes WHERE language = ? AND decorators LIKE '%' || ? || '%'"
    );
    for (const row of stmt.iterate(language, `"${decorator}"`)) {
      yield rowToNode(row as NodeRow);
    }
  }

  /**
   * Start a SQLite-backed staging area for optional synthesis edges. Main
   * synthesis passes must all read the same committed graph snapshot; staging
   * avoids retaining their results in JS while keeping them invisible until
   * every pass has run. The source/target uniqueness matches the synthesizer's
   * historical first-pass-wins deduplication.
   */
  beginSynthesisEdgeStaging(): void {
    // Prefer a temp file over SQLite's process heap for graph-sized staging.
    // Builds compiled with a fixed temp-store policy may ignore this pragma.
    try { this.db.pragma('temp_store = FILE'); } catch { /* best effort */ }
    this.db.exec(`
      DROP TABLE IF EXISTS _codegraph_synthesis_edges;
      CREATE TEMP TABLE _codegraph_synthesis_edges (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        target TEXT NOT NULL,
        kind TEXT NOT NULL,
        metadata TEXT,
        line INTEGER,
        col INTEGER,
        provenance TEXT,
        UNIQUE(source, target)
      )
    `);
  }

  /** Stage one bounded synthesis chunk; returns newly accepted edge count. */
  stageSynthesisEdges(edges: Edge[]): number {
    if (edges.length === 0) return 0;
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO _codegraph_synthesis_edges
        (source, target, kind, metadata, line, col, provenance)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    return this.db.transaction(() => {
      let changed = 0;
      for (const edge of edges) {
        changed += stmt.run(
          edge.source,
          edge.target,
          edge.kind,
          edge.metadata ? JSON.stringify(edge.metadata) : null,
          edge.line ?? null,
          edge.column ?? null,
          edge.provenance ?? null
        ).changes;
      }
      return changed;
    })();
  }

  /** Flush staged synthesis edges to the graph in bounded batches. */
  flushSynthesisEdgeStaging(batchSize: number = 1_000): number {
    const total = (
      this.db.prepare('SELECT COUNT(*) AS count FROM _codegraph_synthesis_edges').get() as {
        count: number;
      }
    ).count;
    let afterSeq = 0;
    while (true) {
      const rows = this.db
        .prepare(`
          SELECT seq AS id, source, target, kind, metadata, line, col, provenance
          FROM _codegraph_synthesis_edges
          WHERE seq > ?
          ORDER BY seq
          LIMIT ?
        `)
        .all(afterSeq, batchSize) as EdgeRow[];
      if (rows.length === 0) break;
      this.insertEdges(rows.map(rowToEdge));
      afterSeq = rows[rows.length - 1]!.id;
    }
    this.db.exec('DROP TABLE IF EXISTS _codegraph_synthesis_edges');
    try { this.db.pragma('temp_store = MEMORY'); } catch { /* best effort */ }
    return total;
  }

  /** Remove an abandoned staging area after a normal exception. */
  discardSynthesisEdgeStaging(): void {
    this.db.exec('DROP TABLE IF EXISTS _codegraph_synthesis_edges');
    // configureConnection() normally keeps transient query work in memory.
    // Restore that connection policy after the graph-sized staging table is
    // gone so later interactive queries do not inherit disk-backed temp work.
    try { this.db.pragma('temp_store = MEMORY'); } catch { /* best effort */ }
  }

  private insertEdgesUnchecked(edges: Edge[]): void {
    const rows = edges.map((edge) => [
      edge.source,
      edge.target,
      edge.kind,
      edge.metadata ? JSON.stringify(edge.metadata) : null,
      edge.line ?? null,
      edge.column ?? null,
      edge.provenance ?? null,
    ]);
    this.runBatched(
      'insertEdges',
      'INSERT OR IGNORE INTO edges (source, target, kind, metadata, line, col, provenance) VALUES ',
      '(?,?,?,?,?,?,?)',
      rows
    );
  }

  /**
   * Delete all edges from a source node
   */
  deleteEdgesBySource(sourceId: string): void {
    if (!this.stmts.deleteEdgesBySource) {
      this.stmts.deleteEdgesBySource = this.db.prepare('DELETE FROM edges WHERE source = ?');
    }
    this.stmts.deleteEdgesBySource.run(sourceId);
  }

  /**
   * Get outgoing edges from a node
   */
  getOutgoingEdges(sourceId: string, kinds?: EdgeKind[], provenance?: string): Edge[] {
    if ((kinds && kinds.length > 0) || provenance) {
      let sql = 'SELECT * FROM edges WHERE source = ?';
      const params: (string | number)[] = [sourceId];

      if (kinds && kinds.length > 0) {
        sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
        params.push(...kinds);
      }

      if (provenance) {
        sql += ' AND provenance = ?';
        params.push(provenance);
      }

      const rows = this.db.prepare(sql).all(...params) as EdgeRow[];
      return rows.map(rowToEdge);
    }

    if (!this.stmts.getEdgesBySource) {
      this.stmts.getEdgesBySource = this.db.prepare('SELECT * FROM edges WHERE source = ?');
    }
    const rows = this.stmts.getEdgesBySource.all(sourceId) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  /**
   * Get incoming edges to a node
   */
  getIncomingEdges(targetId: string, kinds?: EdgeKind[]): Edge[] {
    if (kinds && kinds.length > 0) {
      const sql = `SELECT * FROM edges WHERE target = ? AND kind IN (${kinds.map(() => '?').join(',')})`;
      const rows = this.db.prepare(sql).all(targetId, ...kinds) as EdgeRow[];
      return rows.map(rowToEdge);
    }

    if (!this.stmts.getEdgesByTarget) {
      this.stmts.getEdgesByTarget = this.db.prepare('SELECT * FROM edges WHERE target = ?');
    }
    const rows = this.stmts.getEdgesByTarget.all(targetId) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  /**
   * Find all edges where both source and target are in the given node set.
   * Useful for recovering inter-node connectivity after BFS.
   */
  findEdgesBetweenNodes(nodeIds: string[], kinds?: EdgeKind[]): Edge[] {
    if (nodeIds.length === 0) return [];

    const idsJson = JSON.stringify(nodeIds);
    let sql = `SELECT * FROM edges WHERE source IN (SELECT value FROM json_each(?)) AND target IN (SELECT value FROM json_each(?))`;
    const params: string[] = [idsJson, idsJson];

    if (kinds && kinds.length > 0) {
      sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }

    const rows = this.db.prepare(sql).all(...params) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  /**
   * Distinct file paths that DEPEND ON `filePath`: every file containing a
   * symbol with a cross-file edge (any kind except `contains`) into a symbol
   * of this file. This is the file-level projection of the symbol dependency
   * graph and the basis for blast-radius / `affected` test selection.
   *
   * It deliberately does NOT restrict to `imports` edges. In this graph an
   * `imports` edge connects a file to its own local import declarations
   * (it is always same-file), so an imports-only lookup returns zero
   * cross-file dependents for every file. The real cross-file dependency
   * signal is the resolved call/reference graph — calls, references,
   * instantiates, extends, implements, overrides, type_of, returns,
   * decorates — exactly what {@link GraphTraverser.getImpactRadius} traverses.
   * `contains` is excluded: a parent containing a symbol does not *depend* on
   * it. One indexed query (idx_nodes_file_path + idx_edges_target_kind).
   */
  getDependentFilePaths(filePath: string): string[] {
    const sql = `SELECT DISTINCT src.file_path AS fp
      FROM edges e
      JOIN nodes tgt ON tgt.id = e.target
      JOIN nodes src ON src.id = e.source
      WHERE tgt.file_path = ?
        AND e.kind != 'contains'
        AND src.file_path != ?`;
    const rows = this.db.prepare(sql).all(filePath, filePath) as Array<{ fp: string }>;
    return rows.map((r) => r.fp);
  }

  /**
   * Distinct file paths that `filePath` DEPENDS ON — the inverse of
   * {@link getDependentFilePaths}: every file containing a symbol that a
   * symbol of this file has a cross-file edge into. Same edge-kind rules
   * (all kinds except `contains`); same reason imports-only is insufficient.
   */
  getDependencyFilePaths(filePath: string): string[] {
    const sql = `SELECT DISTINCT tgt.file_path AS fp
      FROM edges e
      JOIN nodes src ON src.id = e.source
      JOIN nodes tgt ON tgt.id = e.target
      WHERE src.file_path = ?
        AND e.kind != 'contains'
        AND tgt.file_path != ?`;
    const rows = this.db.prepare(sql).all(filePath, filePath) as Array<{ fp: string }>;
    return rows.map((r) => r.fp);
  }

  // ===========================================================================
  // File Operations
  // ===========================================================================

  /**
   * Insert or update a file record
   */
  upsertFile(file: FileRecord): void {
    if (!this.stmts.upsertFile) {
      this.stmts.upsertFile = this.db.prepare(`
        INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at, node_count, errors)
        VALUES (@path, @contentHash, @language, @size, @modifiedAt, @indexedAt, @nodeCount, @errors)
        ON CONFLICT(path) DO UPDATE SET
          content_hash = @contentHash,
          language = @language,
          size = @size,
          modified_at = @modifiedAt,
          indexed_at = @indexedAt,
          node_count = @nodeCount,
          errors = @errors
      `);
    }

    this.stmts.upsertFile.run({
      path: file.path,
      contentHash: file.contentHash,
      language: file.language,
      size: file.size,
      modifiedAt: file.modifiedAt,
      indexedAt: file.indexedAt,
      nodeCount: file.nodeCount,
      errors: file.errors ? JSON.stringify(file.errors) : null,
    });
  }

  /**
   * Delete a file record and its nodes
   */
  deleteFile(filePath: string): void {
    this.db.transaction(() => {
      this.deleteNodesByFile(filePath);
      if (!this.stmts.deleteFile) {
        this.stmts.deleteFile = this.db.prepare('DELETE FROM files WHERE path = ?');
      }
      this.stmts.deleteFile.run(filePath);
    })();
  }

  /**
   * Get a file record by path
   */
  getFileByPath(filePath: string): FileRecord | null {
    if (!this.stmts.getFileByPath) {
      this.stmts.getFileByPath = this.db.prepare('SELECT * FROM files WHERE path = ?');
    }
    const row = this.stmts.getFileByPath.get(filePath) as FileRow | undefined;
    return row ? rowToFileRecord(row) : null;
  }

  /**
   * Get all tracked files
   */
  getAllFiles(): FileRecord[] {
    if (!this.stmts.getAllFiles) {
      this.stmts.getAllFiles = this.db.prepare('SELECT * FROM files ORDER BY path');
    }
    const rows = this.stmts.getAllFiles.all() as FileRow[];
    return rows.map(rowToFileRecord);
  }

  /**
   * Most recent index timestamp (ms since epoch) across all tracked files, or
   * null when nothing is indexed yet. One indexed aggregate, no per-row scan. (#329)
   */
  getLastIndexedAt(): number | null {
    const row = this.db
      .prepare('SELECT MAX(indexed_at) AS last FROM files')
      .get() as { last: number | null } | undefined;
    return row?.last ?? null;
  }

  /**
   * Get files that need re-indexing (hash changed)
   */
  getStaleFiles(currentHashes: Map<string, string>): FileRecord[] {
    const files = this.getAllFiles();
    return files.filter((f) => {
      const currentHash = currentHashes.get(f.path);
      return currentHash && currentHash !== f.contentHash;
    });
  }

  // ===========================================================================
  // Unresolved References
  // ===========================================================================

  /**
   * Insert an unresolved reference
   */
  insertUnresolvedRef(ref: UnresolvedReference): void {
    if (!this.stmts.insertUnresolved) {
      this.stmts.insertUnresolved = this.db.prepare(`
        INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, candidates, file_path, language)
        VALUES (@fromNodeId, @referenceName, @referenceKind, @line, @col, @candidates, @filePath, @language)
      `);
    }

    this.stmts.insertUnresolved.run({
      fromNodeId: ref.fromNodeId,
      referenceName: ref.referenceName,
      referenceKind: ref.referenceKind,
      line: ref.line,
      col: ref.column,
      candidates: ref.candidates ? JSON.stringify(ref.candidates) : null,
      filePath: ref.filePath ?? '',
      language: ref.language ?? 'unknown',
    });
  }

  /**
   * Insert multiple unresolved references in a transaction
   */
  insertUnresolvedRefsBatch(refs: UnresolvedReference[]): void {
    if (refs.length === 0) return;
    const insert = this.db.transaction(() => {
      const rows = refs.map((ref) => [
        ref.fromNodeId,
        ref.referenceName,
        ref.referenceKind,
        ref.line,
        ref.column,
        ref.candidates ? JSON.stringify(ref.candidates) : null,
        ref.filePath ?? '',
        ref.language ?? 'unknown',
      ]);
      this.runBatched(
        'insertUnresolvedRefs',
        'INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, candidates, file_path, language) VALUES ',
        '(?,?,?,?,?,?,?,?)',
        rows
      );
    });
    insert();
  }

  /**
   * Delete unresolved references from a node
   */
  deleteUnresolvedByNode(nodeId: string): void {
    if (!this.stmts.deleteUnresolvedByNode) {
      this.stmts.deleteUnresolvedByNode = this.db.prepare(
        'DELETE FROM unresolved_refs WHERE from_node_id = ?'
      );
    }
    this.stmts.deleteUnresolvedByNode.run(nodeId);
  }

  /**
   * Get unresolved references by name (for resolution)
   */
  getUnresolvedByName(name: string): UnresolvedReference[] {
    if (!this.stmts.getUnresolvedByName) {
      this.stmts.getUnresolvedByName = this.db.prepare(
        'SELECT * FROM unresolved_refs WHERE reference_name = ?'
      );
    }
    const rows = this.stmts.getUnresolvedByName.all(name) as UnresolvedRefRow[];
    return rows.map((row) => ({
      rowId: row.id,
      fromNodeId: row.from_node_id,
      referenceName: row.reference_name,
      referenceKind: row.reference_kind as EdgeKind,
      line: row.line,
      column: row.col,
      candidates: row.candidates ? safeJsonParse(row.candidates, undefined) : undefined,
      filePath: row.file_path,
      language: row.language as Language,
    }));
  }

  /**
   * Get all unresolved references
   */
  getUnresolvedReferences(): UnresolvedReference[] {
    const rows = this.db.prepare('SELECT * FROM unresolved_refs').all() as UnresolvedRefRow[];
    return rows.map((row) => ({
      rowId: row.id,
      fromNodeId: row.from_node_id,
      referenceName: row.reference_name,
      referenceKind: row.reference_kind as EdgeKind,
      line: row.line,
      column: row.col,
      candidates: row.candidates ? safeJsonParse(row.candidates, undefined) : undefined,
      filePath: row.file_path,
      language: row.language as Language,
    }));
  }

  /**
   * Get the count of unresolved references without loading them into memory
   */
  getUnresolvedReferencesCount(): number {
    if (!this.stmts.getUnresolvedCount) {
      this.stmts.getUnresolvedCount = this.db.prepare(
        "SELECT COUNT(*) as count FROM unresolved_refs WHERE status = 'pending'"
      );
    }
    const row = this.stmts.getUnresolvedCount.get() as { count: number };
    return row.count;
  }

  /**
   * Get a batch of unresolved references using LIMIT/OFFSET pagination.
   * Used to process references in bounded memory chunks.
   */
  getUnresolvedReferencesBatch(offset: number, limit: number): UnresolvedReference[] {
    if (!this.stmts.getUnresolvedBatch) {
      this.stmts.getUnresolvedBatch = this.db.prepare(
        "SELECT * FROM unresolved_refs WHERE status = 'pending' ORDER BY id LIMIT ? OFFSET ?"
      );
    }
    const rows = this.stmts.getUnresolvedBatch.all(limit, offset) as UnresolvedRefRow[];
    return rows.map((row) => ({
      rowId: row.id,
      fromNodeId: row.from_node_id,
      referenceName: row.reference_name,
      referenceKind: row.reference_kind as EdgeKind,
      line: row.line,
      column: row.col,
      candidates: row.candidates ? safeJsonParse(row.candidates, undefined) : undefined,
      filePath: row.file_path,
      language: row.language as Language,
    }));
  }

  /**
   * Get the next unresolved-reference batch by primary-key seek.
   *
   * This preserves the row order used by the legacy OFFSET reader while
   * avoiding repeated scans from the beginning of the table. The row id also
   * gives the resolver an exact cleanup key for duplicate same-name call sites.
   */
  getUnresolvedReferencesBatchAfter(afterRowId: number, limit: number): UnresolvedReference[] {
    if (!this.stmts.getUnresolvedBatchAfter) {
      this.stmts.getUnresolvedBatchAfter = this.db.prepare(
        "SELECT * FROM unresolved_refs WHERE status = 'pending' AND id > ? ORDER BY id LIMIT ?"
      );
    }
    const rows = this.stmts.getUnresolvedBatchAfter.all(afterRowId, limit) as UnresolvedRefRow[];
    return rows.map((row) => ({
      rowId: row.id,
      fromNodeId: row.from_node_id,
      referenceName: row.reference_name,
      referenceKind: row.reference_kind as EdgeKind,
      line: row.line,
      column: row.col,
      candidates: row.candidates ? safeJsonParse(row.candidates, undefined) : undefined,
      filePath: row.file_path,
      language: row.language as Language,
    }));
  }

  /**
   * Get all tracked file paths (lightweight — no full FileRecord objects)
   */
  getAllFilePaths(): string[] {
    if (!this.stmts.getAllFilePaths) {
      this.stmts.getAllFilePaths = this.db.prepare('SELECT path FROM files ORDER BY path');
    }
    const rows = this.stmts.getAllFilePaths.all() as Array<{ path: string }>;
    return rows.map((r) => r.path);
  }

  /**
   * Get all distinct node names (lightweight — just name strings for pre-filtering)
   */
  getAllNodeNames(): string[] {
    if (!this.stmts.getAllNodeNames) {
      this.stmts.getAllNodeNames = this.db.prepare('SELECT DISTINCT name FROM nodes');
    }
    const rows = this.stmts.getAllNodeNames.all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  /** Read the unpersisted inheritance of this exact source type. Failed rows
   * also matter: a newly restored base can be queried before its retry group. */
  getPendingSupertypes(nodeId: string): UnresolvedReference[] {
    if (!this.stmts.getPendingSupertypes) this.stmts.getPendingSupertypes = this.db.prepare(
      "SELECT * FROM unresolved_refs WHERE from_node_id=? AND status IN ('pending','failed') " +
      "AND reference_kind IN ('extends','implements') ORDER BY line,col,reference_name"
    );
    const rows = this.stmts.getPendingSupertypes.all(nodeId) as UnresolvedRefRow[];
    return rows.map(row => ({rowId:row.id, fromNodeId:row.from_node_id,
      referenceName:row.reference_name, referenceKind:row.reference_kind as EdgeKind,
      line:row.line, column:row.col, filePath:row.file_path, language:row.language as Language}));
  }

  /** Exact Set-like membership using idx_nodes_name; no full node materialization. */
  hasNodeName(name: string): boolean {
    if (!this.stmts.hasNodeName) {
      this.stmts.hasNodeName = this.db.prepare('SELECT 1 FROM nodes WHERE name = ? COLLATE BINARY LIMIT 1');
    }
    return Boolean(this.stmts.hasNodeName.get(name));
  }

  /**
   * Get unresolved references scoped to specific file paths.
   * Uses the idx_unresolved_file_path index for efficient lookup.
   */
  getUnresolvedReferencesByFiles(filePaths: string[]): UnresolvedReference[] {
    if (filePaths.length === 0) return [];

    // Chunk under SQLite's parameter limit: the first sync of a very large repo
    // passes every changed file here, which an unbounded `IN (...)` would bind
    // as one parameter each — exceeding MAX_VARIABLE_NUMBER and aborting with
    // "too many SQL variables". (#540)
    const rows: UnresolvedRefRow[] = [];
    for (let i = 0; i < filePaths.length; i += SQLITE_PARAM_CHUNK_SIZE) {
      const chunk = filePaths.slice(i, i + SQLITE_PARAM_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      const chunkRows = this.db
        .prepare(
          `SELECT * FROM unresolved_refs WHERE status = 'pending' AND file_path IN (${placeholders})`
        )
        .all(...chunk) as UnresolvedRefRow[];
      // This compatibility API still materializes the whole result. Never
      // expand an unbounded SQL result into function arguments; sync uses the
      // bounded readers below instead.
      for (const row of chunkRows) rows.push(row);
    }

    return rows.map((row) => ({
      rowId: row.id,
      fromNodeId: row.from_node_id,
      referenceName: row.reference_name,
      referenceKind: row.reference_kind as EdgeKind,
      line: row.line,
      column: row.col,
      candidates: row.candidates ? safeJsonParse(row.candidates, undefined) : undefined,
      filePath: row.file_path,
      language: row.language as Language,
    }));
  }

  /**
   * Snapshot incoming cross-file edges pointing TO nodes in `filePath`,
   * before those nodes are deleted.  These edges are from nodes in OTHER
   * files to nodes in THIS file — edge re-wiring will try to re-create them
   * after re-insertion by matching target (name, kind) to new node IDs.
   *
   * Returns an empty array when there are no incoming cross-file edges.
   */
  getIncomingCrossFileEdges(filePath: string): SavedCrossFileEdge[] {
    const sql = `SELECT e.source, e.kind, e.metadata, e.line, e.col, e.provenance,
       nt.name  AS target_name,
       nt.kind  AS target_kind,
       nt.id AS target_id,
       nt.qualified_name AS target_qualified_name,
       nt.signature AS target_signature,
       nt.is_declaration AS target_is_declaration,
       ns.file_path AS source_file_path,
       ns.language AS source_language
FROM nodes nt
JOIN edges e ON e.target = nt.id
JOIN nodes ns ON ns.id = e.source
WHERE nt.file_path = ?
  AND ns.file_path != ?`;

    const rows = this.db
      .prepare(sql)
      .all(filePath, filePath) as Array<{
      source: string;
      kind: string;
      metadata: string | null;
      line: number | null;
      col: number | null;
      provenance: string | null;
      target_name: string;
      target_kind: string;
      target_id: string;
      target_qualified_name: string;
      target_signature: string | null;
      target_is_declaration: number | null;
      source_file_path: string;
      source_language: string;
    }>;

    return rows.map((r) => ({
      sourceId: r.source,
      sourceFilePath: r.source_file_path,
      sourceLanguage: r.source_language as Language,
      targetName: r.target_name,
      targetKind: r.target_kind,
      targetId: r.target_id,
      targetQualifiedName: r.target_qualified_name,
      targetSignature: r.target_signature,
      targetIsDeclaration: Boolean(r.target_is_declaration),
      edgeKind: r.kind,
      metadata: r.metadata,
      line: r.line,
      col: r.col,
      provenance: r.provenance,
    }));
  }

  /**
   * Find files that should be re-resolved when the given files change.
   *
   * Strategy: for each changed file, find the headers it imports (outgoing
   * `imports` edges to file nodes), then find every other file that imports
   * those same headers. These co-importers share the same declaration surface
   * as the changed file — when a definition moves, their cross-file edges
   * (calls → function, references → variable) are cascade-deleted during
   * re-index and need to be restored.
   *
   * Returns file paths distinct from the input set.
   */
  getCoImporters(changedFilePaths: string[]): string[] {
    if (changedFilePaths.length === 0) return [];
    const fpPlaceholders = changedFilePaths.map(() => '?').join(',');
    const sql = `SELECT DISTINCT n.file_path
FROM edges e
JOIN nodes n ON n.id = e.source
WHERE e.kind = 'imports'
  AND e.target IN (
    SELECT DISTINCT e2.target
    FROM edges e2
    JOIN nodes s2 ON s2.id = e2.source
    WHERE e2.kind = 'imports'
      AND s2.file_path IN (${fpPlaceholders})
  )
  AND n.file_path NOT IN (${fpPlaceholders})`;
    const allPaths = changedFilePaths.concat(changedFilePaths); // for two IN clauses
    const rows = this.db.prepare(sql).all(...allPaths) as Array<{ file_path: string }>;
    return rows.map(r => r.file_path);
  }

  /**
   * Delete all unresolved references (after resolution)
   */
  clearUnresolvedReferences(): void {
    this.db.exec('DELETE FROM unresolved_refs');
  }

  /**
   * Delete resolved references by their IDs
   */
  deleteResolvedReferences(fromNodeIds: string[]): void {
    if (fromNodeIds.length === 0) return;
    const placeholders = fromNodeIds.map(() => '?').join(',');
    this.db.prepare(`DELETE FROM unresolved_refs WHERE from_node_id IN (${placeholders})`).run(...fromNodeIds);
  }

  /**
   * Delete specific resolved references by (fromNodeId, referenceName, referenceKind) tuples.
   * More precise than deleteResolvedReferences — only removes refs that were actually resolved.
   */
  deleteSpecificResolvedReferences(refs: Array<{ fromNodeId: string; referenceName: string; referenceKind: string }>): void {
    if (refs.length === 0) return;
    const stmt = this.db.prepare(
      'DELETE FROM unresolved_refs WHERE from_node_id = ? AND reference_name = ? AND reference_kind = ?'
    );
    const deleteMany = this.db.transaction((items: typeof refs) => {
      for (const ref of items) {
        stmt.run(ref.fromNodeId, ref.referenceName, ref.referenceKind);
      }
    });
    deleteMany(refs);
  }

  /**
   * Delete exactly the unresolved-reference rows that were processed.
   *
   * The legacy tuple delete intentionally remains for references constructed
   * outside SQLite, but database batches always carry row ids. A tuple omits
   * line/column and can therefore remove a same-key sibling that belongs to a
   * later batch, silently losing that sibling's edge.
   */
  deleteReferencesByRowIds(rowIds: number[]): number {
    if (rowIds.length === 0) return 0;

    let changed = 0;
    this.db.transaction(() => {
      for (let i = 0; i < rowIds.length; i += SQLITE_PARAM_CHUNK_SIZE) {
        const chunk = rowIds.slice(i, i + SQLITE_PARAM_CHUNK_SIZE);
        if (chunk.length === SQLITE_PARAM_CHUNK_SIZE) {
          if (!this.stmts.deleteRefsByRowIdsFull) {
            const placeholders = new Array(SQLITE_PARAM_CHUNK_SIZE).fill('?').join(',');
            this.stmts.deleteRefsByRowIdsFull = this.db.prepare(
              `DELETE FROM unresolved_refs WHERE id IN (${placeholders})`
            );
          }
          changed += this.stmts.deleteRefsByRowIdsFull.run(...chunk).changes;
        } else {
          const placeholders = chunk.map(() => '?').join(',');
          changed += this.db
            .prepare(`DELETE FROM unresolved_refs WHERE id IN (${placeholders})`)
            .run(...chunk).changes;
        }
      }
    })();
    return changed;
  }

  /** Park database-backed references that a completed pass could not resolve. */
  markReferencesFailedByRowIds(
    refs: Array<{ rowId: number; referenceName: string }>
  ): number {
    if (refs.length === 0) return 0;
    const statement = this.db.prepare(
      "UPDATE unresolved_refs SET status = 'failed', name_tail = CASE " +
      "WHEN reference_kind = 'imports' AND language IN ('c', 'cpp') THEN ? ELSE ? END WHERE id = ?"
    );
    let changed = 0;
    this.db.transaction(() => {
      for (const ref of refs) {
        changed += statement.run(ref.referenceName.split('/').pop()!, referenceNameTail(ref.referenceName), ref.rowId).changes;
      }
    })();
    return changed;
  }

  /** Tuple-key fallback for references constructed outside the database. */
  markReferencesFailed(
    refs: Array<{ fromNodeId: string; referenceName: string; referenceKind: string }>
  ): number {
    if (refs.length === 0) return 0;
    const statement = this.db.prepare(
      "UPDATE unresolved_refs SET status = 'failed', name_tail = CASE " +
        "WHEN reference_kind = 'imports' AND language IN ('c', 'cpp') THEN ? ELSE ? END " +
        'WHERE from_node_id = ? AND reference_name = ? AND reference_kind = ?'
    );
    let changed = 0;
    this.db.transaction(() => {
      for (const ref of refs) {
        changed += statement.run(
          ref.referenceName.split('/').pop()!,
          referenceNameTail(ref.referenceName),
          ref.fromNodeId,
          ref.referenceName,
          ref.referenceKind
        ).changes;
      }
    })();
    return changed;
  }

  /**
   * Plan a stable retry snapshot for failed references whose final name
   * segment matches symbols introduced by changed files.
   *
   * The old implementation skipped an entire name once it had more than 500
   * rows. That bounded memory by sacrificing correctness. The plan keeps only
   * per-name counts and high-water marks in memory; callers stream the rows in
   * bounded primary-key batches via getFailedReferenceRetryBatch().
   */
  getFailedReferenceRetryPlan(names: string[]): FailedReferenceRetryPlan {
    const uniqueNames = [...new Set(names.filter((name) => name.length > 0))];
    if (uniqueNames.length === 0) return { groups: [], total: 0 };

    const groups: FailedReferenceRetryGroup[] = [];
    let total = 0;
    for (let i = 0; i < uniqueNames.length; i += SQLITE_PARAM_CHUNK_SIZE) {
      const chunk = uniqueNames.slice(i, i + SQLITE_PARAM_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db
        .prepare(
          `SELECT name_tail, COUNT(*) AS count, MAX(id) AS max_id ` +
            `FROM unresolved_refs WHERE status = 'failed' ` +
            `AND name_tail IN (${placeholders}) GROUP BY name_tail`
        )
        .all(...chunk) as Array<{
          name_tail: string;
          count: number;
          max_id: number;
        }>;
      for (const row of rows) {
        const count = Number(row.count);
        groups.push({
          nameTail: row.name_tail,
          total: count,
          maxRowId: Number(row.max_id),
        });
        total += count;
      }
    }

    groups.sort((left, right) => left.nameTail.localeCompare(right.nameTail));
    return { groups, total };
  }

  /**
   * Snapshot only counts/high-water marks for a scoped resolution pass. The
   * caller holds the index mutex; later inserts cannot extend this pass.
   * Use the existing file index: scanning all pending rows for EVERY group of
   * 500 files makes a small sync depend on unrelated historical backlog.
   */
  planPendingReferencesByFiles(filePaths: readonly string[]): {
    chunks: PendingReferenceFileChunk[]; total: number;
  } {
    const files = [...new Set(filePaths)];
    const chunks: PendingReferenceFileChunk[] = [];
    let total = 0;
    // A recovered journal can contain thousands of files after all pending
    // refs were already consumed. Do not scan their historical failed rows.
    if (files.length === 0 || !this.scopedRefStatement('exists',
      "SELECT 1 FROM unresolved_refs WHERE status='pending' LIMIT 1"
    ).get()) return { chunks, total };
    for (let offset = 0; offset < files.length; offset += SQLITE_PARAM_CHUNK_SIZE) {
      const chunk = files.slice(offset, offset + SQLITE_PARAM_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      const row = this.scopedRefStatement(`count:${chunk.length}`,
        `SELECT COUNT(*) AS count, MAX(id) AS max_id FROM unresolved_refs ` +
        `INDEXED BY idx_unresolved_file_path ` +
        `WHERE status='pending' AND file_path IN (${placeholders})`
      ).get(...chunk) as { count: number; max_id: number | null };
      const count = Number(row.count);
      if (count > 0) {
        chunks.push({ filePaths: chunk, total: count, maxRowId: Number(row.max_id) });
        total += count;
      }
    }
    return { chunks, total };
  }

  /**
   * At most `limit` rows in (file_path BINARY, id) order within a file chunk.
   * SQLite's file_path index already orders equal paths by rowid. Finish the
   * current file with an id seek, then seek later paths; a single OR cursor or
   * ORDER BY id across many files can repeatedly scan/sort a giant macro file.
   * No live iterator/read transaction survives a returned page or its writes.
   */
  getPendingReferenceFileBatch(
    chunk: PendingReferenceFileChunk,
    after?: PendingReferenceCursor,
    limit: number = SCOPED_REFERENCE_BATCH_SIZE,
  ): UnresolvedReference[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > SCOPED_REFERENCE_BATCH_SIZE) {
      throw new Error(`Reference batch size must be between 1 and ${SCOPED_REFERENCE_BATCH_SIZE}`);
    }
    if (chunk.filePaths.length === 0) return [];
    if (chunk.filePaths.length > SQLITE_PARAM_CHUNK_SIZE ||
        (after && !chunk.filePaths.includes(after.filePath))) {
      throw new Error('Invalid scoped reference chunk/cursor');
    }
    const rows: UnresolvedRefRow[] = after ? this.scopedRefStatement('file',
      `SELECT * FROM unresolved_refs INDEXED BY idx_unresolved_file_path ` +
      `WHERE file_path=? AND id>? AND id<=? AND status='pending' ORDER BY id LIMIT ?`
    ).all(after.filePath, after.rowId, chunk.maxRowId, limit) as UnresolvedRefRow[] : [];
    if (rows.length < limit) {
      const placeholders = chunk.filePaths.map(() => '?').join(',');
      const laterRows = this.scopedRefStatement(`page:${chunk.filePaths.length}:${!!after}`,
        `SELECT * FROM unresolved_refs INDEXED BY idx_unresolved_file_path ` +
        `WHERE file_path IN (${placeholders}) ${after ? 'AND file_path>? ' : ''}` +
        `AND id<=? AND status='pending' ORDER BY file_path,id LIMIT ?`
      ).all(...chunk.filePaths, ...(after ? [after.filePath] : []),
        chunk.maxRowId, limit - rows.length) as UnresolvedRefRow[];
      for (const row of laterRows) rows.push(row);
    }
    return rows.map((row) => ({
      rowId: row.id, fromNodeId: row.from_node_id, referenceName: row.reference_name,
      referenceKind: row.reference_kind as EdgeKind, line: row.line, column: row.col,
      candidates: row.candidates ? safeJsonParse(row.candidates, undefined) : undefined,
      filePath: row.file_path, language: row.language as Language,
    }));
  }

  /**
   * One-time, transactional content repair for pre-fix C/C++ include edges.
   * Recreate only source-stamped references: never guess a lost include path.
   * The stamp is committed with the pending rows, so an interrupted resolver
   * is handled by the existing pending-reference recovery on the next sync.
   * No schema change or per-sync scan of the edge table is required.
   */
  repairLegacyCppIncludes(): string[] {
    const key = 'repair:cpp-include-targets-v1';
    if (this.getMetadata(key) === 'done') return [];
    const files = new Set<string>();
    this.db.transaction(() => {
      const invalid = this.db.prepare(`SELECT e.id,e.source,e.line,e.col,e.metadata,s.file_path,s.language
        FROM edges e JOIN nodes s ON s.id=e.source JOIN nodes t ON t.id=e.target
        WHERE e.kind='imports' AND s.kind='file' AND s.language IN ('c','cpp') AND t.kind!='file'`).all() as Array<{
        id:number; source:string; line:number|null; col:number|null; metadata:string|null; file_path:string; language:Language;
      }>;
      const remove = this.db.prepare('DELETE FROM edges WHERE id=?');
      for (const edge of invalid) {
        const metadata = edge.metadata ? safeJsonParse<Record<string, unknown>>(edge.metadata, {}) : {};
        if (typeof metadata.refName !== 'string' || !metadata.refName) continue;
        this.insertUnresolvedRefsBatch([{fromNodeId:edge.source, referenceName:metadata.refName,
          referenceKind:'imports', line:edge.line??0, column:edge.col??0,
          filePath:edge.file_path, language:edge.language}]);
        remove.run(edge.id);
        files.add(edge.file_path);
      }
      // The old generic tail key turned "dir/api.h" into "h". Only replay
      // stale keys: a fresh index already stores basenames, so replaying all
      // failed includes would make its first no-change sync resolve them again.
      const old = this.db.prepare(`SELECT id,file_path,reference_name,name_tail FROM unresolved_refs WHERE status='failed'
        AND reference_kind='imports' AND language IN ('c','cpp')`).all() as Array<{
          id:number; file_path:string; reference_name:string; name_tail:string;
        }>;
      const pending = this.db.prepare("UPDATE unresolved_refs SET status='pending',name_tail='' WHERE id=?");
      for (const row of old) {
        // Match both markReferencesFailed entry points exactly, including
        // extensionless headers and case. The normal sync retry path still
        // handles a missing header added after this repair has been stamped.
        if (row.name_tail === row.reference_name.split('/').pop()!) continue;
        pending.run(row.id);
        files.add(row.file_path);
      }
      this.setMetadata(key, 'done');
    })();
    return [...files];
  }

  /** Conservative recovery when a sync retry journal cannot be decoded. */
  getFailedReferenceNames(): string[] {
    const rows = this.db.prepare("SELECT DISTINCT name_tail FROM unresolved_refs WHERE status = 'failed'")
      .all() as Array<{ name_tail: string }>;
    return rows.map(row => row.name_tail);
  }

  /**
   * Read one bounded failed-reference retry batch using primary-key seek.
   * maxRowId fixes the plan's high-water mark, so rows written during a retry
   * cannot extend the current pass or cause an infinite loop.
   */
  getFailedReferenceRetryBatch(
    nameTail: string,
    afterRowId: number,
    maxRowId: number,
    limit: number = 500
  ): UnresolvedReference[] {
    if (!nameTail || afterRowId >= maxRowId) return [];
    const safeLimit = Math.max(1, Math.floor(limit));
    if (!this.stmts.getFailedRetryBatch) {
      this.stmts.getFailedRetryBatch = this.db.prepare(
        `SELECT * FROM unresolved_refs WHERE status = 'failed' ` +
          `AND name_tail = ? AND id > ? AND id <= ? ORDER BY id LIMIT ?`
      );
    }
    const rows = this.stmts.getFailedRetryBatch.all(
      nameTail,
      afterRowId,
      maxRowId,
      safeLimit
    ) as UnresolvedRefRow[];

    return rows.map((row) => ({
      rowId: row.id,
      fromNodeId: row.from_node_id,
      referenceName: row.reference_name,
      referenceKind: row.reference_kind as EdgeKind,
      line: row.line,
      column: row.col,
      candidates: row.candidates ? safeJsonParse(row.candidates, undefined) : undefined,
      filePath: row.file_path,
      language: row.language as Language,
    }));
  }

  /** Distinct symbol names currently contributed by changed files. */
  getNodeNamesByFiles(filePaths: string[]): string[] {
    if (filePaths.length === 0) return [];
    const names = new Set<string>();
    for (let i = 0; i < filePaths.length; i += SQLITE_PARAM_CHUNK_SIZE) {
      const chunk = filePaths.slice(i, i + SQLITE_PARAM_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db
        .prepare(`SELECT DISTINCT name FROM nodes WHERE file_path IN (${placeholders})`)
        .all(...chunk) as Array<{ name: string }>;
      for (const row of rows) names.add(row.name);
    }
    return [...names];
  }

  // ===========================================================================
  // Statistics
  // ===========================================================================

  /**
   * Lightweight (nodes, edges) count snapshot. Used around an index/sync
   * run to compute true additions across extraction + resolution +
   * synthesis — the per-phase counter in the orchestrator only sees
   * extraction's contribution, which is why the CLI summary under-reported
   * the edge count (resolution + synthesizer edges were invisible).
   */
  getNodeAndEdgeCount(): { nodes: number; edges: number } {
    return this.db
      .prepare('SELECT (SELECT COUNT(*) FROM nodes) AS nodes, (SELECT COUNT(*) FROM edges) AS edges')
      .get() as { nodes: number; edges: number };
  }

  /**
   * Languages present in the indexed file set. Dynamic-edge synthesis uses
   * this indexed query to skip passes whose result is provably empty.
   */
  getDistinctFileLanguages(): Set<string> {
    const rows = this.db
      .prepare('SELECT DISTINCT language FROM files')
      .all() as Array<{ language: string }>;
    return new Set(rows.map((row) => row.language));
  }

  /**
   * Get graph statistics
   */
  getStats(): GraphStats {
    // Single query for all three aggregate counts
    const counts = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM nodes) AS node_count,
        (SELECT COUNT(*) FROM edges) AS edge_count,
        (SELECT COUNT(*) FROM files) AS file_count
    `).get() as { node_count: number; edge_count: number; file_count: number };

    const nodesByKind = {} as Record<NodeKind, number>;
    const nodeKindRows = this.db
      .prepare('SELECT kind, COUNT(*) as count FROM nodes GROUP BY kind')
      .all() as Array<{ kind: string; count: number }>;
    for (const row of nodeKindRows) {
      nodesByKind[row.kind as NodeKind] = row.count;
    }

    const edgesByKind = {} as Record<EdgeKind, number>;
    const edgeKindRows = this.db
      .prepare('SELECT kind, COUNT(*) as count FROM edges GROUP BY kind')
      .all() as Array<{ kind: string; count: number }>;
    for (const row of edgeKindRows) {
      edgesByKind[row.kind as EdgeKind] = row.count;
    }

    const filesByLanguage = {} as Record<Language, number>;
    const languageRows = this.db
      .prepare('SELECT language, COUNT(*) as count FROM files GROUP BY language')
      .all() as Array<{ language: string; count: number }>;
    for (const row of languageRows) {
      filesByLanguage[row.language as Language] = row.count;
    }

    return {
      nodeCount: counts.node_count,
      edgeCount: counts.edge_count,
      fileCount: counts.file_count,
      nodesByKind,
      edgesByKind,
      filesByLanguage,
      dbSizeBytes: 0, // Set by caller using DatabaseConnection.getSize()
      lastUpdated: Date.now(),
    };
  }

  // ===========================================================================
  // Project Metadata
  // ===========================================================================

  /**
   * Get a metadata value by key
   */
  getMetadata(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM project_metadata WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  /**
   * Set a metadata key-value pair (upsert)
   */
  setMetadata(key: string, value: string): void {
    this.db.prepare(
      'INSERT INTO project_metadata (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    ).run(key, value, Date.now());
  }

  /**
   * Get all metadata as a key-value record
   */
  getAllMetadata(): Record<string, string> {
    const rows = this.db.prepare('SELECT key, value FROM project_metadata').all() as { key: string; value: string }[];
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }

  /** Indexed prefix range; do not load every per-file sync proof on a no-op. */
  getMetadataByPrefix(prefix: string): Array<{ key: string; value: string }> {
    if (!prefix) throw new Error('Metadata prefix must not be empty');
    const upper = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
    return this.db.prepare('SELECT key, value FROM project_metadata WHERE key >= ? AND key < ?')
      .all(prefix, upper) as Array<{ key: string; value: string }>;
  }

  /** Atomically promote completed work and remove its write-ahead journal. */
  applyMetadataChanges(changes: Record<string, string | null>): void {
    if (Object.keys(changes).length === 0) return;
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) this.db.prepare('DELETE FROM project_metadata WHERE key = ?').run(key);
        else this.setMetadata(key, value);
      }
    })();
  }

  /**
   * Clear all data from the database
   */
  clear(): void {
    this.nodeCache.clear();
    this.db.transaction(() => {
      this.db.exec('DELETE FROM unresolved_refs');
      this.db.exec('DELETE FROM edges');
      this.db.exec('DELETE FROM nodes');
      this.db.exec('DELETE FROM files');
      this.db.exec("DELETE FROM project_metadata WHERE key GLOB 'sync-retry:*'");
    })();
  }
}
