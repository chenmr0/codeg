/**
 * A source-only provenance guard for automatic rebuilds. It is not a security
 * boundary against hostile SQL: all writers must respect the project lock.
 * Legacy/custom databases are never adopted merely because their rows look
 * plausible. Only a freshly initialized, empty, exact stock schema can start
 * an ownership chain. Ordinary external SQL mutations break that chain.
 */
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import * as path from 'path';
import type { SqliteDatabase } from '../db/sqlite-adapter';
import { NODE_KINDS, LANGUAGES } from '../types';

const OWNER_KEY = 'adaptive:source-owner-v1';
const GUARDED_TABLES = ['nodes', 'edges', 'files', 'unresolved_refs', 'schema_versions', 'project_metadata'] as const;
const graphTables = ['nodes', 'edges', 'files', 'unresolved_refs'] as const;
let stockFingerprint: string | undefined;

function schemaFingerprint(db: Pick<SqliteDatabase, 'prepare'>): string {
  // ANALYZE is allowed to add SQLite's own statistics, not application data.
  const schema = db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_stat%' ORDER BY type, name`).all();
  return createHash('sha256').update(JSON.stringify(schema)).digest('hex');
}

function expectedStockFingerprint(): string {
  if (stockFingerprint !== undefined) return stockFingerprint;
  // Do not use the WASM adapter here: its close() persists even ':memory:' as
  // a file. Automatic rebuilds are native-only; this template never touches disk.
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:') as Pick<SqliteDatabase, 'exec' | 'prepare' | 'close'>;
  try {
    db.exec(readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
    stockFingerprint = schemaFingerprint(db);
    return stockFingerprint;
  } finally { db.close(); }
}

function marker(db: SqliteDatabase): string | null {
  const row = db.prepare('SELECT value FROM project_metadata WHERE key = ?').get(OWNER_KEY) as { value: string } | undefined;
  return row?.value ?? null;
}

function putMarker(db: SqliteDatabase, fingerprint: string): void {
  db.prepare('INSERT OR REPLACE INTO project_metadata (key, value, updated_at) VALUES (?, ?, ?)')
    .run(OWNER_KEY, fingerprint, Date.now());
}

function guardSql(): string {
  const statements: string[] = [];
  for (const table of GUARDED_TABLES) {
    for (const [suffix, operation] of [['ai', 'INSERT'], ['au', 'UPDATE'], ['ad', 'DELETE']] as const) {
      const metadataCondition = table !== 'project_metadata' ? '' : operation === 'INSERT'
        ? `NEW.key <> '${OWNER_KEY}' AND ` : operation === 'DELETE'
          ? `OLD.key <> '${OWNER_KEY}' AND `
          : `(OLD.key <> '${OWNER_KEY}' OR NEW.key <> '${OWNER_KEY}') AND `;
      statements.push(`CREATE TRIGGER adaptive_owner_${table}_${suffix} AFTER ${operation} ON ${table}
        WHEN ${metadataCondition}EXISTS (SELECT 1 FROM project_metadata WHERE key = '${OWNER_KEY}')
        BEGIN DELETE FROM project_metadata WHERE key = '${OWNER_KEY}'; END;`);
    }
  }
  return statements.join('\n');
}

/** Only call immediately after DatabaseConnection.initialize on a NEW database. */
export function installSourceOwnership(db: SqliteDatabase): boolean {
  if (process.env.CODEGRAPH_FORCE_WASM) return false;
  return db.transaction(() => {
    if (schemaFingerprint(db) !== expectedStockFingerprint()) return false;
    if ((db.prepare('SELECT count(*) AS n FROM project_metadata').get() as { n: number }).n !== 0) return false;
    for (const table of graphTables) {
      if (db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) return false;
    }
    db.exec(guardSql());
    putMarker(db, schemaFingerprint(db));
    return true;
  })();
}

/** Cheap in graph size: checks schema objects, never hashes all graph rows/files. */
export function isSourceOwned(db: SqliteDatabase): boolean {
  try {
    const fingerprint = marker(db);
    return fingerprint !== null && fingerprint === schemaFingerprint(db);
  } catch { return false; }
}

const tokenBrand: unique symbol = Symbol('SourceWriteToken');
export interface SourceWriteToken { readonly [tokenBrand]: true; }
interface TokenState { database: SqliteDatabase; fingerprint: string; }
const tokens = new WeakMap<SourceWriteToken, TokenState>();

/** Caller holds the root writer lock until finish, including async worker writes. */
export function beginSourceWrite(db: SqliteDatabase): SourceWriteToken | null {
  return db.transaction(() => {
    if (!isSourceOwned(db)) return null;
    const fingerprint = marker(db)!;
    db.prepare('DELETE FROM project_metadata WHERE key = ?').run(OWNER_KEY);
    const token: SourceWriteToken = Object.freeze({ [tokenBrand]: true as const });
    tokens.set(token, { database: db, fingerprint });
    return token;
  })();
}

/** An incomplete/failed operation permanently breaks eligibility until a fresh init. */
export function finishSourceWrite(db: SqliteDatabase, token: SourceWriteToken | null, complete: boolean): boolean {
  if (token === null) return false;
  const state = tokens.get(token);
  tokens.delete(token);
  if (!state || state.database !== db || complete !== true) return false;
  return db.transaction(() => {
    if (marker(db) !== null || schemaFingerprint(db) !== state.fingerprint) return false;
    putMarker(db, state.fingerprint);
    return true;
  })();
}


export interface LegacySourceProvenance { eligible: boolean; reason: string; }

/**
 * Read-only admission for the verified official 1.1.2 / extraction-36 format
 * (1765271 and e1c038a5). This is deliberately NOT an ownership installer.
 * Invoke in an isolated worker: validation scans graph rows and may be costly.
 *
 * The contract is an exclusively tool-managed official legacy index, not an
 * adversarial SQL store: a user who fabricates indistinguishable official rows
 * cannot be detected without retained original source/provenance. Unknown
 * schema, metadata, import provenance and graph extensions fail closed. A
 * damaged modern ownership chain is never relabeled as legacy.
 */
export function inspectLegacySourceProvenance(db: SqliteDatabase): LegacySourceProvenance {
  const deny = (reason: string): LegacySourceProvenance => ({ eligible: false, reason });
  const safePath = (value: unknown): value is string => typeof value === 'string' && value.length > 0 &&
    !value.includes('\\') && !value.includes('\0') && !value.includes(':') && !value.startsWith('/') &&
    value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
  const hash = (value: unknown): boolean => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
  const object = (value: string): Record<string, unknown> | null => {
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null; }
    catch { return null; }
  };
  try {
    if (schemaFingerprint(db) !== expectedStockFingerprint()) return deny('legacy-unknown-or-extended-schema');
    const metadata = new Map((db.prepare('SELECT key,value FROM project_metadata').all() as Array<{key:string;value:string}>)
      .map(row => [row.key, row.value]));
    if (metadata.get('indexed_with_version') !== '1.1.2' || metadata.get('indexed_with_extraction_version') !== '36') {
      return deny('legacy-unsupported-build-stamp');
    }
    if (metadata.get('index_completeness') !== 'complete' || metadata.get('index_synthesis_completed_version') !== '1' ||
        metadata.get('index_synthesis_verification_started') !== '1') return deny('legacy-incomplete-or-unverified');
    if (!['default-v1', 'all'].includes(metadata.get('indexed_language_scope') ?? '')) return deny('legacy-unknown-language-policy');
    const fixed = new Set(['indexed_with_version', 'indexed_with_extraction_version', 'indexed_language_scope',
      'index_completeness', 'index_synthesis_completed_version', 'index_synthesis_verification_started', 'index_diagnostics']);
    for (const [key, value] of metadata) {
      if (fixed.has(key)) continue;
      if (['resolution:cpp-macro-evidence-v1', 'resolution:cpp-macro-evidence-clean-v1'].includes(key) && hash(value)) continue;
      if (key === 'repair:cpp-include-targets-v1' && value === 'done') continue;
      if (key.startsWith('sync-retry:done:') && safePath(key.slice('sync-retry:done:'.length))) {
        const proof = object(value);
        if (proof && Object.keys(proof).every(k => ['version','contentHash','fingerprint'].includes(k)) &&
            proof.version === '1:36' && hash(proof.contentHash) && (proof.fingerprint === null || hash(proof.fingerprint))) continue;
      }
      return deny('legacy-unknown-or-pending-metadata');
    }
    let diagnostics: unknown;
    try { diagnostics = JSON.parse(metadata.get('index_diagnostics') ?? 'null'); } catch { return deny('legacy-invalid-diagnostics'); }
    if (!Array.isArray(diagnostics) || diagnostics.some(d => !d || d.code !== 'skipped_macro_data_header' || d.severity !== 'warning')) {
      return deny('legacy-unverified-diagnostics');
    }
    const versions = db.prepare('SELECT version,description FROM schema_versions ORDER BY version').all() as Array<{version:number;description:string}>;
    if (versions.length !== 2 || versions[0]?.version !== 1 || versions[0]?.description !== 'Initial schema' ||
        versions[1]?.version !== 9 || versions[1]?.description !== 'Initial schema includes all migrations') {
      return deny('legacy-unsupported-schema-history');
    }
    const files = new Map<string, { language: string; nodeCount: number }>();
    for (const file of db.prepare('SELECT path,content_hash,language,size,node_count,errors FROM files').iterate()) {
      if (!safePath(file.path) || !hash(file.content_hash) || !LANGUAGES.includes(file.language) ||
          !Number.isSafeInteger(file.size) || file.size < 0 || !Number.isSafeInteger(file.node_count) || file.node_count < 0) {
        return deny('legacy-invalid-file-provenance');
      }
      if (file.errors) {
        let errors: unknown; try { errors = JSON.parse(file.errors); } catch { return deny('legacy-invalid-file-diagnostics'); }
        if (!Array.isArray(errors) || errors.some(e => !e || e.code !== 'skipped_macro_data_header' || e.severity !== 'warning')) {
          return deny('legacy-incomplete-file');
        }
      }
      files.set(file.path, { language: file.language, nodeCount: file.node_count });
    }
    if (files.size === 0) return deny('legacy-no-source-provenance');
    const counts = new Map<string, number>();
    for (const node of db.prepare('SELECT id,kind,file_path,language,start_line,end_line,start_column,end_column FROM nodes').iterate()) {
      const file = files.get(node.file_path);
      if (!file || !NODE_KINDS.includes(node.kind) || !LANGUAGES.includes(node.language) ||
          ![node.start_line,node.end_line,node.start_column,node.end_column].every(n => Number.isSafeInteger(n) && n >= 0) ||
          node.end_line < node.start_line || (node.kind === 'file' ? node.id !== `file:${node.file_path}` :
            !new RegExp(`^${node.kind}:[0-9a-f]{32}$`).test(node.id))) return deny('legacy-custom-or-unanchored-node');
      counts.set(node.file_path, (counts.get(node.file_path) ?? 0) + 1);
    }
    if ([...files].some(([name, file]) => (counts.get(name) ?? 0) !== file.nodeCount)) return deny('legacy-node-count-mismatch');
    const kinds = new Set(['contains','calls','imports','exports','extends','implements','references','type_of','returns',
      'instantiates','overrides','decorates','defines']);
    // Narrow observed upstream payloads. Unrecognized optional extensions are
    // preserved by refusing replacement rather than silently discarding them.
    const edgeKeys = new Set(['confidence','resolvedBy','refName','refKind','synthesizedBy','framework','type','name',
      'event','registeredAt','callback','receiver','method','decorator','path','httpMethod','route','handler','source']);
    for (const edge of db.prepare('SELECT kind,provenance,metadata FROM edges').iterate()) {
      if (!kinds.has(edge.kind) || ![null,'tree-sitter','heuristic'].includes(edge.provenance)) return deny('legacy-custom-edge');
      if (edge.metadata) {
        const data = object(edge.metadata);
        if (!data || Object.keys(data).some(key => !edgeKeys.has(key))) return deny('legacy-custom-edge-metadata');
      }
    }
    for (const ref of db.prepare('SELECT reference_kind,file_path,language,status FROM unresolved_refs').iterate()) {
      if (!kinds.has(ref.reference_kind) || !files.has(ref.file_path) || !LANGUAGES.includes(ref.language) ||
          !['resolved','failed'].includes(ref.status)) return deny('legacy-unverified-reference');
    }
    if (db.prepare('PRAGMA foreign_key_check').get()) return deny('legacy-invalid-relationships');
    return { eligible: true, reason: 'supported-official-legacy-format' };
  } catch { return deny('legacy-inspection-unavailable'); }
}
