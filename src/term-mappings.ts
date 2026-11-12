/** Project-maintained lexical hints. Query policy only: never part of index semantics. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SqliteDatabase } from './db/sqlite-adapter';

export const TERM_MAPPINGS_FILE = 'term-mappings.json';
export const MAX_MAPPING_SEEDS = 16;
const MAX_BYTES = 256 * 1024;
const MAX_RULES = 1000;
export interface TermMappingRule { terms: string[]; symbols: string[] }
export interface TermMappings {
  path: string;
  exists: boolean;
  rules: TermMappingRule[];
  errors: string[];
  warnings: string[];
}
const cache = new Map<string, { stamp: string; value: TermMappings }>();

export function loadTermMappings(dataDir: string): TermMappings {
  const file = path.join(dataDir, TERM_MAPPINGS_FILE);
  const empty = (exists: boolean, errors: string[] = []): TermMappings => ({ path: file, exists, rules: [], errors, warnings: [] });
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return empty(true, ['Mapping configuration must be a regular file, not a symlink.']);
    if (stat.size > MAX_BYTES) return empty(true, [`Mapping configuration exceeds ${MAX_BYTES} bytes.`]);
    const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const hit = cache.get(file);
    if (hit?.stamp === stamp) return hit.value;
    // Bounded read even when the file grows between stat and read.
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    let content: string;
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.size > MAX_BYTES) return empty(true, ['Mapping configuration must be a regular file of at most 256 KiB.']);
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const n = fs.readSync(fd, buffer, length, buffer.length - length, null);
        if (!n) break;
        length += n;
      }
      if (length > MAX_BYTES) return empty(true, [`Mapping configuration exceeds ${MAX_BYTES} bytes.`]);
      content = buffer.subarray(0, length).toString('utf8');
    } finally { fs.closeSync(fd); }
    const result = parseTermMappings(content, file);
    if (cache.size >= 32) cache.delete(cache.keys().next().value!);
    cache.set(file, { stamp, value: result });
    return result;
  } catch (error) {
    cache.delete(file);
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty(false);
    return empty(true, [`Cannot read mapping configuration: ${(error as Error).message}`]);
  }
}

export function parseTermMappings(content: string, file = TERM_MAPPINGS_FILE): TermMappings {
  const result: TermMappings = { path: file, exists: true, rules: [], errors: [], warnings: [] };
  let value: unknown;
  try { value = JSON.parse(content); }
  catch { result.errors.push('Invalid JSON.'); return result; }
  if (!value || typeof value !== 'object' || !Array.isArray((value as { rules?: unknown }).rules)) {
    result.errors.push('Expected an object containing a rules array.'); return result;
  }
  const input = (value as { rules: unknown[] }).rules;
  if (input.length > MAX_RULES) { result.errors.push(`At most ${MAX_RULES} rules are supported.`); return result; }
  const seenTerms = new Map<string, number>();
  input.forEach((rule, index) => {
    const label = `Rule ${index + 1}`;
    if (!rule || typeof rule !== 'object') { result.errors.push(`${label}: expected an object.`); return; }
    const { terms, symbols } = rule as { terms?: unknown; symbols?: unknown };
    const valid = (list: unknown, max: number): list is string[] => Array.isArray(list) && list.length > 0 && list.length <= max
      && list.every(s => typeof s === 'string' && s.trim().length > 0 && s.length <= 256 && !/[\u0000-\u001f]/.test(s));
    if (!valid(terms, 20) || !valid(symbols, 32)) {
      result.errors.push(`${label}: terms (1–20) and symbols (1–32) must contain nonempty strings of at most 256 characters.`); return;
    }
    const uniqueTerms = [...new Set(terms.map(normalizeTerm))];
    const uniqueSymbols = [...new Set(symbols.map(s => s.trim()))];
    if (uniqueTerms.length < terms.length || uniqueSymbols.length < symbols.length) result.warnings.push(`${label}: duplicate entries were deduplicated.`);
    if (uniqueSymbols.length > MAX_MAPPING_SEEDS) result.warnings.push(`${label}: queries use at most ${MAX_MAPPING_SEEDS} mapped names in configuration order; later names may not participate.`);
    for (const term of uniqueTerms) {
      const previous = seenTerms.get(term);
      if (previous !== undefined) result.warnings.push(`${label}: term "${term}" also occurs in rule ${previous + 1}; matching rules are merged.`);
      else seenTerms.set(term, index);
    }
    result.rules.push({ terms: uniqueTerms, symbols: uniqueSymbols });
  });
  return result;
}

function normalizeTerm(text: string): string { return text.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim(); }
function containsTerm(query: string, term: string): boolean {
  let start = 0;
  while (start <= query.length) {
    const index = query.indexOf(term, start);
    if (index < 0) return false;
    // English identifiers require boundaries; CJK phrases can occur within prose.
    const word = (c: string | undefined): boolean => !!c && /[a-z0-9_]/.test(c);
    if (!(word(term[0]) && word(query[index - 1]))
      && !(word(term[term.length - 1]) && word(query[index + term.length]))) return true;
    start = index + 1;
  }
  return false;
}

/** Invalid individual rules are ignored; valid rules remain usable. */
export function matchTermMappingSymbols(config: TermMappings, query: string): string[] {
  const normalized = normalizeTerm(query);
  const names = new Set<string>();
  for (const rule of config.rules) {
    if (!rule.terms.some(term => containsTerm(normalized, term))) continue;
    for (const symbol of rule.symbols) {
      names.add(symbol);
      if (names.size >= MAX_MAPPING_SEEDS) return [...names];
    }
  }
  return [...names];
}

export interface MappingSymbolCandidate {
  id: string; name: string; qualifiedName?: string; kind: string; filePath: string; startLine: number;
}
export interface MappingSymbolMatch { count: number; candidates: MappingSymbolCandidate[] }
/** Shared by Explore and the maintainer CLI. Exact, case-sensitive, index-backed
 * lookup; total counts are not inferred from a truncated display list. */
export function getTermMappingSymbolMatches(
  db: Pick<SqliteDatabase, 'prepare'>, names: readonly string[], limitPerSymbol = 20,
): Map<string, MappingSymbolMatch> {
  const matches = new Map<string, MappingSymbolMatch>();
  if (!names.length) return matches;
  const predicate = "(name = ? OR qualified_name = ?) AND kind NOT IN ('file', 'import')";
  const count = db.prepare(`SELECT count(*) AS count FROM nodes WHERE ${predicate}`);
  const select = db.prepare(`SELECT id, name, qualified_name, kind, file_path, start_line FROM nodes WHERE ${predicate} ORDER BY file_path, start_line, id LIMIT ?`);
  const limit = Math.min(100, Math.max(1, Math.floor(limitPerSymbol) || 20));
  for (const name of new Set(names)) {
    const total = Number(count.get(name, name).count);
    const candidates = select.all(name, name, limit).map(row => ({
      id: String(row.id), name: String(row.name), qualifiedName: row.qualified_name ?? undefined,
      kind: String(row.kind), filePath: String(row.file_path), startLine: Number(row.start_line),
    }));
    matches.set(name, { count: total, candidates });
  }
  return matches;
}
