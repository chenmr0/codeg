/** Source-only C++ declaration evidence; graph-dependent type inference stays live. */
export interface CppReceiverDeclaration {
  line: number;
  rawType: string;
}

export interface CppReceiverDeclarations {
  lineCount: number;
  declarations: readonly CppReceiverDeclaration[];
  lineText(line: number): string;
}

/** Keep exactly the declarator pattern used by the legacy backward line scan. */
export function cppDeclaratorRegex(escapedReceiver: string): RegExp {
  return new RegExp(
    `([A-Za-z_][\\w:]*(?:\\s*<[^;=(){}]+>)?(?:\\s*[*&]+)?)\\s*\\b${escapedReceiver}\\b\\s*(?=[;=,)\\[{(]|$)`,
  );
}

interface SourceEntry {
  starts: Uint32Array;
  lineText(line: number): string;
  bytes: number;
  baseBytes: number;
  receivers: Map<string, { result: CppReceiverDeclarations; bytes: number }>;
}

/** Index after the last item at or before `line` (also accepts Uint32Array). */
function upperBound(length: number, at: (index: number) => number, line: number): number {
  let lo = 0, hi = length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (at(mid) <= line) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function lastDeclarationBefore(declarations: readonly CppReceiverDeclaration[], line: number): number {
  return upperBound(declarations.length, index => declarations[index]!.line, line) - 1;
}

/**
 * Large generated files exceed the ordinary split-line cache's byte budget.
 * Retain compact offsets and only lines that match a receiver's declarator,
 * instead of repeatedly splitting/scanning hundreds of thousands of lines.
 * Keys are immutable source text, so source changes cannot reuse old evidence.
 */
export class CppReceiverDeclarationCache {
  private readonly sources = new Map<string, SourceEntry>();
  private bytes = 0;
  private readonly enabled = process.env.CODEGRAPH_NO_RESOLVE_TEXT_CACHE !== '1';

  constructor(
    private readonly maxBytes = 32 * 1024 * 1024,
    private readonly maxSources = 16,
    private readonly maxReceivers = 64,
    private readonly minSourceLength = 128 * 1024,
  ) {
    if (![maxBytes, maxSources, maxReceivers].every(value => Number.isSafeInteger(value) && value > 0) ||
        !Number.isSafeInteger(minSourceLength) || minSourceLength < 0) {
      throw new Error('Invalid C++ declaration cache limits');
    }
  }

  get estimatedBytes(): number { return this.bytes; }
  get size(): number { return this.sources.size; }

  get(source: string, receiver: string): CppReceiverDeclarations | null {
    if (!this.enabled || source.length < this.minSourceLength || !receiver || receiver.length > 256 ||
        /[\r\n]/.test(receiver)) return null;
    let entry = this.sources.get(source);
    if (!entry) {
      // Reject before allocating offsets when the source alone cannot fit.
      if (source.length * 2 + 132 > this.maxBytes) return null;
      let lineCount = 1;
      for (let at = source.indexOf('\n'); at !== -1; at = source.indexOf('\n', at + 1)) lineCount++;
      const bytes = 128 + source.length * 2 + lineCount * 4;
      if (bytes > this.maxBytes) return null;
      const starts = new Uint32Array(lineCount);
      let next = 1;
      for (let at = source.indexOf('\n'); at !== -1; at = source.indexOf('\n', at + 1)) starts[next++] = at + 1;
      const lineText = (line: number): string => {
        const start = starts[line]!;
        let end = line + 1 < starts.length ? starts[line + 1]! - 1 : source.length;
        // Match split(/\r?\n/): strip CR only when immediately before LF.
        if (line + 1 < starts.length && end > start && source.charCodeAt(end - 1) === 13) end--;
        return source.slice(start, end);
      };
      while (this.sources.size >= this.maxSources || this.bytes + bytes > this.maxBytes) this.evictOldest();
      entry = { starts, lineText, bytes, baseBytes: bytes, receivers: new Map() };
      this.sources.set(source, entry);
      this.bytes += bytes;
    }
    const cached = entry.receivers.get(receiver);
    if (cached) return cached.result;

    const escaped = receiver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const occurrences = new RegExp(`\\b${escaped}\\b`, 'g');
    const declarator = cppDeclaratorRegex(escaped);
    const declarations: CppReceiverDeclaration[] = [];
    let occurrence: RegExpExecArray | null;
    while ((occurrence = occurrences.exec(source))) {
      const line = upperBound(entry.starts.length, index => entry!.starts[index]!, occurrence.index) - 1;
      const match = declarator.exec(entry.lineText(line));
      if (match) declarations.push({ line, rawType: match[1] ?? '' });
      // The old scan tests each line once, even with multiple receiver uses.
      occurrences.lastIndex = line + 1 < entry.starts.length ? entry.starts[line + 1]! : source.length;
    }
    const result = { lineCount: entry.starts.length, declarations, lineText: entry.lineText };
    const bytes = 96 + receiver.length * 2 + declarations.reduce((sum, item) => sum + 32 + item.rawType.length * 2, 0);
    if (bytes > this.maxBytes - entry.baseBytes) return result;
    while (entry.receivers.size >= this.maxReceivers) {
      const oldest = entry.receivers.keys().next().value!;
      const removed = entry.receivers.get(oldest)!.bytes;
      entry.receivers.delete(oldest); entry.bytes -= removed; this.bytes -= removed;
    }
    while (this.bytes + bytes > this.maxBytes) this.evictOldest();
    // Eviction may have dropped this source. Its live result is still valid,
    // but do not retain an unaccounted entry outside the source budget.
    if (this.sources.get(source) === entry) {
      entry.receivers.set(receiver, { result, bytes });
      entry.bytes += bytes; this.bytes += bytes;
    }
    return result;
  }

  private evictOldest(): void {
    const key = this.sources.keys().next().value!;
    this.bytes -= this.sources.get(key)!.bytes;
    this.sources.delete(key);
  }

  clear(): void { this.sources.clear(); this.bytes = 0; }
}
