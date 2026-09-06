import { createHash } from 'crypto';
import type { QueryBuilder } from '../db/queries';
import type { ExtractionResult, FileRecord, Language, UnresolvedReference } from '../types';
import { EXTRACTION_VERSION } from './extraction-version';

const VERSION = `1:${EXTRACTION_VERSION}`;
const DONE = 'sync-retry:done:';
const PENDING = 'sync-retry:pending:';

interface Proof {
  version: string;
  contentHash: string;
  fingerprint: string | null;
}

interface Pending extends Proof {
  names: string[];
  historical: boolean;
}

/**
 * Deliberately NOT a C preprocessor or a general semantic fingerprint. Remove
 * only standalone, single-line block comments with harmless prose. Keep inline,
 * multiline, directive-like and declaration-shaped comments byte-for-byte:
 * receiver inference currently reads raw text, including header comments.
 * Ambiguous lexical features fall back to the unfiltered retry path.
 */
export function normalizeRetrySafeComments(source: string): string | null {
  if (source.length > 8 * 1024 * 1024 ||
      /R"|\?\?[=/]|\b__(?:LINE|FILE|COUNTER)__\b/.test(source)) return null;
  // Lexical overlay only: a splice preceded by whitespace cannot join tokens,
  // quotes or comment delimiters. Hide its physical newline to preserve the
  // logical-line state, keeping UTF-16 offsets into the ORIGINAL source. More
  // unusual splices (split identifiers/delimiters, GCC whitespace extension)
  // are not normalized. The fingerprint still hashes every original splice.
  let uncertainSplice = false;
  const lexical = source.replace(/\\[ \t]*\r?\n/g, (splice, offset: number) => {
    if (!/^\\\r?\n$/.test(splice) ||
        !/[ \t]/.test(source[offset - 1] ?? '')) uncertainSplice = true;
    return ' '.repeat(splice.length);
  });
  if (uncertainSplice) return null;
  const parts: string[] = [];
  let retained = 0;
  let lineStart = 0;
  let lineHasCode = false;
  for (let i = 0; i < source.length;) {
    const c = lexical[i];
    if (c === '\n') { lineStart = ++i; lineHasCode = false; continue; }
    if (c === '"' || c === "'") {
      lineHasCode = true;
      const quote = c;
      let closed = false;
      for (i++; i < source.length; i++) {
        if (lexical[i] === '\n' || lexical[i] === '\r') return null;
        if (lexical[i] === '\\') { i++; continue; }
        if (lexical[i] === quote) { i++; closed = true; break; }
      }
      if (!closed) return null;
      continue;
    }
    if (c === '/' && lexical[i + 1] === '/') {
      const end = lexical.indexOf('\n', i + 2);
      i = end < 0 ? source.length : end;
      continue;
    }
    if (c === '/' && lexical[i + 1] === '*') {
      const end = lexical.indexOf('*/', i + 2);
      if (end < 0) return null;
      const after = end + 2;
      const standaloneProse = !lineHasCode && /^[ \t]*$/.test(source.slice(lineStart, i)) &&
        /^[A-Za-z0-9_ .\t-]*$/.test(source.slice(i + 2, end));
      // Do not scan to the end of a potentially huge logical macro line for
      // every inline comment. Only its first standalone candidate needs that
      // lookahead, keeping this walk linear in source length.
      const newline = standaloneProse ? lexical.indexOf('\n', after) : -1;
      const lineEnd = newline < 0 ? source.length : newline + 1;
      if (standaloneProse &&
          /^[ \t\r\n]*$/.test(source.slice(after, lineEnd))) {
        parts.push(source.slice(retained, lineStart));
        retained = lineEnd;
        i = lineEnd;
        lineStart = lineEnd;
      } else {
        const lastNewline = lexical.slice(i, after).lastIndexOf('\n');
        if (lastNewline >= 0) lineStart = i + lastNewline + 1;
        lineHasCode = true;
        i = after;
      }
      continue;
    }
    if (c !== ' ' && c !== '\t' && c !== '\r') lineHasCode = true;
    i++;
  }
  parts.push(source.slice(retained));
  return parts.join('').replace(/[\r\n]+$/, '');
}

export function retryFingerprint(source: string, language: Language, result: ExtractionResult): string | null {
  if ((language !== 'c' && language !== 'cpp') || result.errors.length) return null;
  if (result.nodes.some(node => !node.id || !node.kind || !node.name || !node.filePath || !node.language)) return null;
  const normalized = normalizeRetrySafeComments(source);
  if (normalized === null) return null;
  // Include extraction facts, not just source/name sets: global macro context
  // can change the extracted signatures, kinds, ownership or return types.
  const byId = new Map<string, string>();
  const facts = result.nodes.map(node => {
    const { id, startLine, endLine, startColumn, endColumn, updatedAt, docstring, ...fact } = node;
    const text = JSON.stringify(fact);
    byId.set(id, text);
    return text;
  }).sort();
  const edges = result.edges.map(edge => JSON.stringify([
    byId.get(edge.source) ?? edge.source, byId.get(edge.target) ?? edge.target,
    edge.kind, edge.metadata, edge.provenance,
  ])).sort();
  return createHash('sha256').update(JSON.stringify([normalized, facts, edges])).digest('hex');
}

function readProof(text: string | null): Proof | null {
  try {
    const value = JSON.parse(text ?? 'null');
    return value?.version === VERSION && typeof value.contentHash === 'string' &&
      (value.fingerprint === null || typeof value.fingerprint === 'string') ? value : null;
  } catch { return null; }
}

function readPending(text: string): Pending | null {
  const proof = readProof(text);
  if (!proof) return null;
  const value = JSON.parse(text);
  return typeof value.historical === 'boolean' && Array.isArray(value.names) && value.names.every((name: unknown) => typeof name === 'string')
    ? value : null;
}

/**
 * Per-sync, write-ahead retry journal in existing project_metadata (no schema
 * upgrade). A proof becomes reusable only AFTER successful resolution. A crash
 * after file upsert therefore cannot turn outstanding retries into a no-op.
 * Recovered work always retries conservatively, never using the skip gate.
 */
export class SyncRetryState {
  private readonly entries: Map<string, Pending | null>;
  private readonly safeFiles = new Set<string>();
  private readonly disabled = process.env.CODEGRAPH_NO_SYNC_RETRY_FILTER === '1';
  private primaryExtraction = true;

  constructor(private readonly queries: QueryBuilder) {
    this.entries = new Map(queries.getMetadataByPrefix(PENDING)
      .map(({ key, value }) => [key.slice(PENDING.length), readPending(value)]));
  }

  get hasWork(): boolean { return this.entries.size > 0; }
  get filePaths(): string[] { return [...this.entries.keys()]; }

  finishPrimaryExtraction(): void { this.primaryExtraction = false; }

  beforeStore(filePath: string, contentHash: string, source: string, language: Language,
    result: ExtractionResult, existing: FileRecord | null | undefined): void {
    // Forced co-importer re-indexing historically resolves its own references,
    // not a second global failed-name sweep. Journal that scoped work without
    // introducing new global retries (or a reusable global proof).
    const fingerprint = this.primaryExtraction ? retryFingerprint(source, language, result) : null;
    const done = readProof(this.queries.getMetadata(DONE + filePath));
    // A pre-existing journal (even for the same hash) is unconsumed work. Keep
    // its contributed names and never relabel it as a harmless comment edit.
    const hadPending = this.entries.has(filePath);
    const old = this.entries.get(filePath);
    const safe = !hadPending && !!existing && !existing.errors?.length &&
      done?.contentHash === existing.contentHash && fingerprint !== null &&
      done.fingerprint === fingerprint;
    const names = new Set(old?.names ?? []);
    if (this.primaryExtraction) {
      for (const node of result.nodes) {
        if (typeof node.name === 'string' && node.name.length > 0) names.add(node.name);
      }
    }
    if (hadPending && !old) {
      for (const name of this.queries.getNodeNamesByFiles([filePath])) names.add(name);
      for (const name of this.queries.getFailedReferenceNames()) names.add(name);
    }
    const pending: Pending = { version: VERSION, contentHash, fingerprint, names: [...names],
      historical: this.primaryExtraction || old?.historical === true || (hadPending && !old) };
    this.queries.setMetadata(PENDING + filePath, JSON.stringify(pending));
    this.entries.set(filePath, pending);
    if (safe) this.safeFiles.add(filePath);
    else this.safeFiles.delete(filePath);
  }

  beforeDelete(filePath: string): void {
    // Invalidate before removing the graph, including a delete/re-add with
    // identical bytes. Any previous unconsumed retry journal must survive.
    this.queries.applyMetadataChanges({ [DONE + filePath]: null });
    this.safeFiles.delete(filePath);
  }

  plan(allowFilter: boolean, forceFiles: string[] = []): {
    names: string[]; shouldRetry: (ref: UnresolvedReference) => boolean;
    filtered: boolean; proofFiles: number; safeFiles: number;
  } {
    const paths = this.filePaths;
    const historicalPaths = paths.filter(file => this.entries.get(file)?.historical !== false);
    const names = new Set(this.queries.getNodeNamesByFiles(historicalPaths));
    for (const pending of this.entries.values()) {
      for (const name of pending?.names ?? []) names.add(name);
    }
    // Corrupt/unknown-version journals cannot prove which names were lost in
    // a partial store. Recover all failed name groups rather than guessing.
    if ([...this.entries.values()].some(pending => pending === null)) {
      for (const name of this.queries.getFailedReferenceNames()) names.add(name);
    }
    // Mixed changes, new files, old databases, recovery and parse errors all
    // retain the old complete retry. This is intentionally a whole-sync gate.
    const filtered = allowFilter && !this.disabled && paths.length > 0 &&
      paths.every(file => this.safeFiles.has(file));
    const touched = new Set([...paths, ...forceFiles]);
    return {
      names: [...names], filtered, proofFiles: paths.length, safeFiles: this.safeFiles.size,
      shouldRetry: ref => !filtered || !ref.filePath || touched.has(ref.filePath) ||
        (ref.language !== 'c' && ref.language !== 'cpp'),
    };
  }

  complete(): void {
    const changes: Record<string, string | null> = {};
    for (const [filePath, pending] of this.entries) {
      const file = this.queries.getFileByPath(filePath);
      const valid = pending && file?.contentHash === pending.contentHash && !file.errors?.length;
      changes[DONE + filePath] = valid ? JSON.stringify({
        version: VERSION, contentHash: pending.contentHash, fingerprint: pending.fingerprint,
      }) : null;
      changes[PENDING + filePath] = null;
    }
    // Atomic promotion + journal removal. Failure leaves recoverable work.
    this.queries.applyMetadataChanges(changes);
  }
}
