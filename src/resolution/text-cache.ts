/**
 * Pure text results, bounded independently of graph caches. Use one instance
 * per transform; compute must always have the same meaning for a given input.
 * Returned arrays are read-only; cached results may be shared between callers.
 */
export class BoundedTextCache {
  private readonly entries = new Map<string, { value: readonly string[]; bytes: number }>();
  private bytes = 0;

  constructor(private readonly maxEntries: number, private readonly maxEstimatedBytes: number) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0 ||
        !Number.isSafeInteger(maxEstimatedBytes) || maxEstimatedBytes <= 0) {
      throw new Error('Text cache limits must be positive safe integers');
    }
  }

  get size(): number { return this.entries.size; }
  get estimatedBytes(): number { return this.bytes; }

  getOrCompute(input: string, compute: (input: string) => string[]): readonly string[] {
    const cached = this.entries.get(input);
    if (cached) return cached.value;

    // Read-only by contract: every consumer only iterates/filters these arrays.
    // Do not freeze them: V8's frozen-array access paths noticeably slow the
    // millions of indexed reads and some/filter calls this cache accelerates.
    const value: readonly string[] = compute(input);
    // Charge both the key and result strings plus array/entry overhead. This
    // is a retention budget, not an exact V8 heap measurement. A split may
    // retain its source string, which is already charged as the key here.
    const bytes = 96 + input.length * 2 + value.length * 24 +
      value.reduce((sum, part) => sum + part.length * 2, 0);
    // Large one-off inputs still produce the exact result, without displacing
    // the small working set or retaining an oversized cache entry.
    if (bytes > this.maxEstimatedBytes) return value;

    // FIFO deliberately does not mutate the Map on millions of cache hits.
    // Eviction only repeats a pure computation; it cannot change resolution.
    while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxEstimatedBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.bytes -= this.entries.get(oldest.value)!.bytes;
      this.entries.delete(oldest.value);
    }
    this.entries.set(input, { value, bytes });
    this.bytes += bytes;
    return value;
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }
}

function splitLines(source: string): string[] {
  return source.split(/\r?\n/);
}

/** Same case, separators, order and short-word filtering as the name matcher. */
export function splitNameWords(name: string): string[] {
  return name.replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s._:\/\\]+/)
    .filter(word => word.length > 1);
}

/** Split before lowercasing: lowercasing first would erase camel-case boundaries. */
export function splitLowerNameWords(name: string): string[] {
  return splitNameWords(name).map(word => word.toLowerCase());
}

/**
 * Per-resolver caches. Keys are actual immutable text, never just paths or
 * symbol names standing in for mutable graph results. The switch is captured
 * at construction, avoiding an environment lookup in the hot candidate loop.
 */
export class ResolutionTextCache {
  private readonly enabled = process.env.CODEGRAPH_NO_RESOLVE_TEXT_CACHE !== '1';
  private readonly lines = new BoundedTextCache(64, 16 * 1024 * 1024);
  private readonly words = new BoundedTextCache(8192, 4 * 1024 * 1024);
  // Large method-name candidate sets can exceed the old 8K working set in a
  // single scoring pass. Keep normalized scoring words separately so the
  // case-preserving API remains unchanged, with both caches still bounded.
  private readonly lowerWords = new BoundedTextCache(65_536, 32 * 1024 * 1024);

  fileLines(source: string): readonly string[] {
    return this.enabled ? this.lines.getOrCompute(source, splitLines) : splitLines(source);
  }

  nameWords(name: string): readonly string[] {
    return this.enabled ? this.words.getOrCompute(name, splitNameWords) : splitNameWords(name);
  }

  lowerNameWords(name: string): readonly string[] {
    return this.enabled ? this.lowerWords.getOrCompute(name, splitLowerNameWords) : splitLowerNameWords(name);
  }

  clear(): void {
    this.lines.clear();
    this.words.clear();
    this.lowerWords.clear();
  }
}
