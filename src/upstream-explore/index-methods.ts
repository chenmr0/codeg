/** Ported from CodeGraph v1.6.2 (6560052a6f856855d3f71eee838fd66ccfa4285d). MIT; see UPSTREAM_LICENSE. */
import type { QueryBuilder } from './db/queries';
import type { ContextBuilder } from './context';
import type { FindRelevantContextOptions, Subgraph, SegmentMatch } from './types';
import { extractSegmentSearchWords, segmentLookupVariants, splitIdentifierSegments } from './search/identifier-segments';

export class UpstreamIndexMethods {
  constructor(private queries: QueryBuilder, private contextBuilder: ContextBuilder) {}


  /**
   * Graph-derived prompt matching for the front-load hook's MEDIUM tier:
   * which indexed symbols do these prose words name? "state machine des
   * commandes" → `OrderStateMachine`, in any human language whose technical
   * nouns are Latin script — no keyword list involved.
   *
   * Precision comes from the repo's own naming statistics, not vocabulary:
   * - CO-OCCURRENCE: ≥2 words that are segments of the SAME name ("state" +
   *   "machine" → OrderStateMachine) is strong evidence and always qualifies.
   * - RARITY: a single matched word qualifies only when its segment is
   *   discriminative here (≤ {@link SEGMENT_RARITY_CEILING} distinct names) —
   *   "checkout" in a shop backend yes, "state" in a react app no.
   * Every candidate is re-verified against `nodes` before being returned
   * (vocab rows are proposals; deletions leave orphans by design), so a
   * returned symbol is guaranteed to exist right now.
   */
  getSegmentMatches(words: string[], limit: number = 6): SegmentMatch[] {
    if (words.length === 0) return [];
    // Variant → original word (plural folding), for coverage accounting.
    const variantToWord = new Map<string, string>();
    for (const word of words) {
      for (const variant of segmentLookupVariants(word)) {
        if (!variantToWord.has(variant)) variantToWord.set(variant, word);
      }
    }
    const variants = [...variantToWord.keys()];

    // Tier A: co-occurrence. The SQL folds variants back to their original
    // word (#1146), so minWords=2 means two distinct PROMPT WORDS — a name
    // matching both `service` and `services` can't tie with (or crowd past
    // the LIMIT) a genuine two-word match. The JS re-check below recomputes
    // the fold from live segments as the honesty layer.
    const variantPairs = [...variantToWord.entries()].map(([segment, word]) => ({ segment, word }));
    const candidates: Array<{ name: string; matchedWords: Set<string> }> = [];
    for (const hit of this.queries.getSegmentCoOccurrence(variantPairs, 2, 24)) {
      const matched = this.wordsMatchingName(hit.name, variantToWord);
      if (matched.size >= 2) candidates.push({ name: hit.name, matchedWords: matched });
    }

    // Tier B: single rare word. Only when co-occurrence found nothing — a
    // co-occurring name is categorically stronger evidence — and under
    // stricter rules, because one word is thin: the word must be ≥5 chars
    // (measured FPs: "this", "typo"); the segment must appear in AT LEAST TWO
    // names (a concept the codebase is about clusters across names —
    // CheckoutService/CheckoutController — while a prose coincidence is a
    // singleton: measured FP "deploy to PRODUCTION" → the one name
    // matchesNonProductionDir); and the candidate name must have ≥2 segments
    // (a bare common verb matching a bare function name — "write" → `write` —
    // is prose coincidence, not the user naming a symbol).
    if (candidates.length === 0) {
      const singleWordVariants = variants.filter((v) => variantToWord.get(v)!.length >= 5);
      const counts = this.queries.getSegmentNameCounts(singleWordVariants);
      const rare = [...counts.entries()]
        .filter(([, n]) => n >= 2 && n <= UpstreamIndexMethods.SEGMENT_RARITY_CEILING)
        .sort((a, b) => a[1] - b[1])
        .slice(0, 2);
      for (const [variant] of rare) {
        const word = variantToWord.get(variant)!;
        for (const name of this.queries.getNamesForSegment(variant, 12)) {
          if (splitIdentifierSegments(name).length < 2) continue;
          candidates.push({ name, matchedWords: new Set([word]) });
        }
      }
    }

    // Verify against nodes (the honesty gate) and pick a representative
    // definition per name. A name whose only nodes are file/import kind has
    // no real definition to point at — surfacing the import statement instead
    // reads as a matched symbol but isn't one (#1144) — so it's skipped, the
    // same way an orphaned vocab row is. (Import names no longer enter the
    // vocab at write time, but rows written before that exclusion persist
    // until the next full index.)
    const out: SegmentMatch[] = [];
    const seen = new Set<string>();
    candidates.sort((a, b) => b.matchedWords.size - a.matchedWords.size || a.name.length - b.name.length);
    for (const candidate of candidates) {
      if (out.length >= limit) break;
      if (seen.has(candidate.name)) continue;
      seen.add(candidate.name);
      const nodes = this.queries.getNodesByName(candidate.name);
      if (nodes.length === 0) continue; // orphaned vocab row — name no longer exists
      const rep = nodes.find((n) => n.kind !== 'file' && n.kind !== 'import');
      if (!rep) continue; // no real definition — don't surface an import/file as one
      out.push({
        name: candidate.name,
        kind: rep.kind,
        filePath: rep.filePath,
        startLine: rep.startLine ?? 0,
        matchedWords: [...candidate.matchedWords].sort(),
      });
    }
    return out;
  }


  /** A single word ("state") can match hundreds of names in a big repo — that
   *  is noise, not signal. Ceiling for the single-word tier; co-occurrence is
   *  exempt because two words on one name is already discriminative. */
  private static readonly SEGMENT_RARITY_CEILING = 25;


  /** Which of the prompt's original words match `name`'s segments (via
   *  variants). Segments are recomputed in JS — a name-keyed vocab lookup
   *  would scan the (segment, name) primary key. */
  private wordsMatchingName(name: string, variantToWord: Map<string, string>): Set<string> {
    const segments = new Set(splitIdentifierSegments(name));
    const matched = new Set<string>();
    for (const [variant, word] of variantToWord) {
      if (segments.has(variant)) matched.add(word);
    }
    return matched;
  }


  /**
   * Find relevant subgraph for a query
   *
   * Combines semantic search with graph traversal to find the most
   * relevant nodes and their relationships for a given query.
   *
   * @param query - Natural language query describing the task
   * @param options - Search and traversal options
   * @returns Subgraph of relevant nodes and edges
   */
  async findRelevantContext(
    query: string,
    options?: FindRelevantContextOptions
  ): Promise<Subgraph> {
    // Segment-vocab supplement: FTS keeps camelCase names as single tokens,
    // so a word-level query ("auto-scroll to bottom") can never reach
    // `pinFeedIfNearBottom` through search alone. Resolve the query's words
    // against name_segment_vocab (same precision rules as the prompt hook:
    // co-occurrence, else rare singles, verified against live nodes) and hand
    // the names down as dampened exact-name seeds. Callers that pass their
    // own seedNames keep them; failures degrade to no supplement.
    let seedNames = options?.seedNames;
    if (seedNames === undefined) {
      try {
        seedNames = this.getSegmentMatches(extractSegmentSearchWords(query), 8)
          .map((m) => m.name);
      } catch {
        seedNames = [];
      }
    }
    return this.contextBuilder.findRelevantContext(query, { ...options, seedNames });
  }
}