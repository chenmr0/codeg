import { createHash } from 'node:crypto';
import type { QueryBuilder } from '../db/queries';
import type { ExtractionResult, FileRecord, Language, Node, UnresolvedReference } from '../types';
import { getParser, maskCStyleCommentsAndLiterals } from './grammars';
import type { SyncRetryState } from './sync-retry-state';
import { extractImportMappings } from '../resolution/import-resolver';

export const APPEND_DELTA_JOURNAL = 'sync-append-delta:pending:';
const JOURNAL = APPEND_DELTA_JOURNAL;
const MAX_SUFFIX = 128 * 1024;
const MAX_RETAINED_EDGES = 50_000;
const hash = (source: string) => createHash('sha256').update(source).digest('hex');
const refKey = (ref: UnresolvedReference) => JSON.stringify([
  ref.fromNodeId, ref.referenceName, ref.referenceKind, ref.line, ref.column,
]);

/** Normalize exactly the persisted fields; timestamps are not symbol facts. */
function nodeFacts(n: Node): string {
  return JSON.stringify([n.id, n.kind, n.name, n.qualifiedName ?? n.name, n.filePath, n.language,
    n.startLine ?? 0, n.endLine ?? 0, n.startColumn ?? 0, n.endColumn ?? 0,
    n.docstring ?? null, n.signature ?? null, n.visibility ?? null, !!n.isExported,
    !!n.isAsync, !!n.isStatic, !!n.isAbstract, !!n.isDeclaration,
    n.decorators ?? null, n.typeParameters ?? null, n.returnType ?? null]);
}

export interface AppendDeltaPlan { added: Node[]; fileNode: Node; }

/**
 * First delta admission: complete standalone function definitions appended to
 * byte-identical source. All old non-file facts must remain identical. This
 * deliberately excludes edits, removals, macros, includes, namespaces/types,
 * damaged syntax and context-changing declarations. Other edits retain the
 * full replacement path. It is not a general C/C++ semantic diff.
 */
function appendedDefinitions(content: string, language: Language, existing: FileRecord | null): number | null {
  if ((language !== 'c' && language !== 'cpp') || !existing || existing.language !== language ||
      existing.errors?.length || existing.size <= 0) return null;
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.length <= existing.size || bytes.length - existing.size > MAX_SUFFIX) return null;
  const prefix = bytes.subarray(0, existing.size).toString('utf8');
  if (hash(prefix) !== existing.contentHash) return null;
  const suffix = content.slice(prefix.length);
  if ((!/\n[ \t\r]*$/.test(prefix) && !/^\r?\n/.test(suffix)) ||
      /(?:\\|\?\?\/)[ \t\r\n]*$/.test(prefix)) return null;
  const lexical = maskCStyleCommentsAndLiterals(suffix);
  if (/[#\\]|\?\?|<%|%>|<:|:>|%:/.test(suffix) ||
      /\b(?:using|typedef|class|struct|union|enum|namespace|template|asm|__asm__)\b/.test(lexical)) return null;
  const tree = getParser(language)?.parse(suffix);
  if (!tree) return null;
  let definitions: number;
  try {
    const children = tree.rootNode.namedChildren.filter(n => n.type !== 'comment');
    if (tree.rootNode.hasError || !children.length || children.some(n => n.type !== 'function_definition')) return null;
    definitions = children.length;
  } finally { tree.delete(); }
  return definitions;
}

export function planAppendDelta(content: string, language: Language, existing: FileRecord | null,
  previous: Node[], result: ExtractionResult): AppendDeltaPlan | null {
  const definitions = appendedDefinitions(content, language, existing);
  if (definitions === null || !existing || result.errors.length) return null;
  const prefix = Buffer.from(content).subarray(0, existing.size).toString('utf8');
  const byId = new Map(result.nodes.map(n => [n.id, n]));
  if (byId.size !== result.nodes.length || result.nodes.some(n => !n.id || !n.kind || !n.name ||
      n.filePath !== existing.path || n.language !== language)) return null;
  const oldIds = new Set(previous.map(n => n.id));
  const files = previous.filter(n => n.kind === 'file');
  if (files.length !== 1) return null;
  const fileNode = byId.get(files[0]!.id);
  if (!fileNode || fileNode.kind !== 'file' || fileNode.name !== files[0]!.name ||
      fileNode.qualifiedName !== files[0]!.qualifiedName) return null;
  for (const old of previous) {
    if (old.kind === 'file') continue;
    const next = byId.get(old.id);
    if (!next || nodeFacts(old) !== nodeFacts(next)) return null;
  }
  const added = result.nodes.filter(n => !oldIds.has(n.id));
  const firstNewLine = prefix.split('\n').length;
  // Some existing recovery paths omit an appended declaration. An unchanged
  // extracted candidate set is also safe; do not manufacture the missing node.
  if (added.length > definitions || added.some(n => n.kind !== 'function' ||
      n.isDeclaration || n.startLine < firstNewLine || !/^[A-Za-z_]\w*$/.test(n.name) ||
      n.qualifiedName !== n.name)) return null;
  return { added, fileNode };
}

/** Crash recovery is conservative: make every retained resolution pending. */
export async function recoverAppendDeltas(queries: QueryBuilder): Promise<string[]> {
  const files: string[] = [];
  for (const { key } of queries.getMetadataByPrefix(JOURNAL)) {
    const file = key.slice(JOURNAL.length);
    await queries.requeueAppendDeltaEdges(file);
    queries.applyMetadataChanges({ [key]: null });
    files.push(file);
  }
  return files;
}

/**
 * Per-sync admission epoch. A later file may invalidate earlier retention, so
 * keep a durable marker until ALL changes have been classified. Recovery only
 * replays stamped edges; it never invents references from target names.
 */
export class AppendDeltaState {
  private safe = true;
  private readonly files: string[] = [];
  private readonly names = new Set<string>();
  private readonly dirtyNames = new Set<string>();
  private readonly nameProofs = new Map<string, string | null>();
  readonly counts = { files: 0, retainedNodes: 0, writtenNodes: 0, retainedRefs: 0, requeuedRefs: 0, fallbackFile: '' };
  constructor(private readonly queries: QueryBuilder, private readonly retry: SyncRetryState) {}

  invalidate(): void { this.safe = false; }

  private candidateHash(name: string): string | null {
    const candidates = this.queries.getAppendNameCandidates(name, 2001);
    // Member admission also reads inheritance/scope. Keep those references on
    // the ordinary resolver, even when their successful target is not a member.
    if (!candidates.length || candidates.length > 2000 ||
        candidates.some(n => n.kind === 'field' || n.kind === 'method')) return null;
    return hash(candidates.map(nodeFacts).sort().join('\n'));
  }

  private canRetainName(name: string): boolean {
    if (!this.nameProofs.has(name)) {
      // Never capture a supposed old proof after an earlier file mutated the
      // name. Bound fingerprints, not arrays of candidate nodes or source text.
      if (this.nameProofs.size >= 10_000 || this.dirtyNames.has(name.toLowerCase())) return false;
      this.nameProofs.set(name, this.candidateHash(name));
    }
    return this.nameProofs.get(name) !== null;
  }

  tryStore(filePath: string, content: string, language: Language, stats: { size: number; mtimeMs: number },
    result: ExtractionResult): boolean {
    if (!this.safe) return false;
    const existing = this.queries.getFileByPath(filePath);
    const previous = existing ? this.queries.getNodesByFile(filePath) : [];
    const plan = planAppendDelta(content, language, existing, previous, result);
    if (!plan) {
      this.counts.fallbackFile ||= filePath;
      // A pure append can expose old parser-recovery differences. Rebuild that
      // file and invalidate its candidate names; other exact bare references
      // may still be retained if their entire candidate set is proven stable.
      if (appendedDefinitions(content, language, existing) === null || result.errors.length ||
          result.nodes.some(n => n.filePath !== filePath)) this.invalidate();
      for (const node of [...previous, ...result.nodes]) this.dirtyNames.add(node.name.toLowerCase());
      return false;
    }
    for (const node of [plan.fileNode, ...plan.added]) this.dirtyNames.add(node.name.toLowerCase());
    const oldIds = new Set(previous.map(n => n.id));
    const counts = new Map<string, number>();
    const refs = result.unresolvedReferences.map(ref => ({ ...ref,
      filePath: ref.filePath ?? filePath, language: ref.language ?? language }));
    for (const ref of refs) {
      counts.set(refKey(ref), (counts.get(refKey(ref)) ?? 0) + 1 + (ref.candidates?.length ? 1 : 0));
    }
    const candidates = this.queries.getAppendResolutionEdges(filePath, MAX_RETAINED_EDGES + 1);
    if (candidates.length > MAX_RETAINED_EDGES) { this.invalidate(); return false; }
    const kept = new Map<string, number>();
    const duplicates = new Set<string>();
    // Include-dir/config changes are not necessarily indexed source changes.
    // A name eligible for import resolution must always be resolved normally.
    const importNames = new Set(extractImportMappings(filePath, content, language).map(imp => imp.localName));
    for (const candidate of candidates) {
      const key = refKey(candidate.ref);
      if (!oldIds.has(candidate.ref.fromNodeId) || counts.get(key) !== 1 ||
          importNames.has(candidate.ref.referenceName) ||
          !['calls', 'references', 'instantiates'].includes(candidate.ref.referenceKind) ||
          !/^[A-Za-z_]\w*$/.test(candidate.ref.referenceName) ||
          !this.canRetainName(candidate.ref.referenceName)) continue;
      if (kept.has(key)) duplicates.add(key);
      else kept.set(key, candidate.id);
    }
    for (const key of duplicates) kept.delete(key);
    for (const node of plan.added) this.names.add(node.name.toLowerCase());
    const contentHash = hash(content);
    // The owning sync's existing journal remains responsible for resolution
    // and historical retries; the delta marker is committed with graph writes.
    this.retry.beforeStore(filePath, contentHash, content, language, result, existing);
    const ids = new Set(result.nodes.map(n => n.id));
    this.queries.storeAppendDelta({
      file: { path: filePath, contentHash, language, size: stats.size, modifiedAt: stats.mtimeMs,
        indexedAt: Date.now(), nodeCount: result.nodes.length },
      fileNode: plan.fileNode, added: plan.added,
      edges: result.edges.filter(e => ids.has(e.source) && ids.has(e.target)),
      refs: refs.filter(ref => ids.has(ref.fromNodeId) && !kept.has(refKey(ref))),
      retainedEdgeIds: [...kept.values()], journalKey: JOURNAL + filePath,
    });
    this.files.push(filePath);
    this.counts.files++;
    this.counts.retainedNodes += previous.length - 1;
    this.counts.writtenNodes += plan.added.length + 1;
    this.counts.retainedRefs += kept.size;
    return true;
  }

  async finish(complete: boolean): Promise<string[]> {
    // Adding an overload or same-name candidate invalidates corresponding old
    // exact matches too. Any unproven change invalidates every retained match.
    const changed = new Set(this.files);
    const invalidNames = new Set(this.names);
    for (const [name, proof] of this.nameProofs) {
      if (proof !== null && this.dirtyNames.has(name.toLowerCase()) && this.candidateHash(name) !== proof) {
        invalidNames.add(name.toLowerCase());
      }
    }
    const affected = this.queries.getExactMatchSourceFilesForNames([...this.names]);
    const files = [...new Set([...this.files, ...affected])];
    for (const file of files) {
      // Same-name additions can affect callers whose source did not change.
      // Give these rows the same durable recovery as changed-file retention.
      if (!changed.has(file)) this.queries.setMetadata(JOURNAL + file, '1');
      this.counts.requeuedRefs += await this.queries.requeueAppendDeltaEdges(file,
        this.safe && complete ? [...invalidNames] : undefined);
      // Keep the marker until SyncRetryState.complete() atomically acknowledges
      // the WHOLE pipeline. A crash followed by different edits must replay it.
    }
    return affected.filter(file => !changed.has(file));
  }
}
