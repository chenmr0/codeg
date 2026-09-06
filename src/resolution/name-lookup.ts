/** Exact, epoch-scoped membership checks, not a partial set of known names. */
import { LRUCache } from './lru-cache';
import type { ResolutionDiagnostics } from './diagnostics';

export type NameLookupMode = 'full' | 'indexed';
export const MAX_INDEXED_SYNC_REFS = 512;

/** Only the small changed-file sync pass opts in. Bulk/API callers stay full. */
export function syncNameLookupMode(refCount: number): NameLookupMode {
  const setting = process.env.CODEGRAPH_SYNC_NAME_LOOKUP ?? 'auto';
  return ['', 'auto', '1', 'indexed'].includes(setting) &&
    Number.isInteger(refCount) && refCount >= 0 && refCount <= MAX_INDEXED_SYNC_REFS ? 'indexed' : 'full';
}

export class IndexedNameLookup {
  private readonly cache: LRUCache<string, boolean>;
  private queries = 0;
  private hits = 0;
  private queryMs = 0;

  constructor(private readonly exists: (name: string) => boolean, limit = 4096) {
    this.cache = new LRUCache(Math.min(limit, 4096));
  }

  has(name: string): boolean {
    // SQLite returns valid Unicode strings. A lone UTF-16 surrogate cannot be
    // in that Set, but binding it as UTF-8 could substitute U+FFFD and falsely
    // match a different stored name. Valid astral symbols still query normally.
    if (/[\uD800-\uDFFF]/.test(name) && Buffer.from(name, 'utf8').toString('utf8') !== name) return false;
    const cached = this.cache.get(name);
    if (cached !== undefined) { this.hits++; return cached; }
    this.queries++;
    const started = performance.now();
    let found: boolean;
    try { found = this.exists(name); }
    finally { this.queryMs += performance.now() - started; }
    // Do not turn a query failure into a negatively cached answer.
    this.cache.set(name, found);
    return found;
  }

  get size(): number { return this.cache.size; }

  capture<T>(diagnostics: ResolutionDiagnostics | undefined, operation: () => T): T {
    if (!diagnostics) return operation();
    const queries = this.queries, hits = this.hits, queryMs = this.queryMs;
    try { return operation(); }
    finally {
      diagnostics.nameQueries += this.queries - queries;
      diagnostics.nameCacheHits += this.hits - hits;
      diagnostics.nameCacheEntries = this.cache.size;
      // Nested within matchMs; never add it again when computing wall time.
      diagnostics.timings.nameProbeMs += this.queryMs - queryMs;
    }
  }
}
