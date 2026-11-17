/** Lexical index shared by design-document terms and source comments. */
export function termCounts(text: string): Map<string, number> {
  const terms = new Map<string, number>();
  function count(term: string) { terms.set(term, (terms.get(term) ?? 0) + 1); }
  for (const [word] of text.normalize('NFKC').toLowerCase().matchAll(/\p{Script=Han}+|[a-z][a-z0-9_]*/gu)) {
    if (/^[a-z]/.test(word)) count(word);
    else {
      const chars = [...word];
      for (let i = 1; i < chars.length; i++) count(chars[i - 1]! + chars[i]!);
    }
  }
  return terms;
}

export class ChineseTextIndex<T> {
  private readonly vocabulary = new Map<string, { idf: number; postings: { i: number; weight: number }[] }>();
  private readonly docs: { value: T; norm: number }[] = [];

  constructor(entries: Iterable<T>, text: (entry: T) => string) {
    for (const value of entries) {
      const i = this.docs.length;
      this.docs.push({ value, norm: 0 });
      for (const [term, tf] of termCounts(text(value))) {
        let word = this.vocabulary.get(term);
        if (!word) this.vocabulary.set(term, word = { idf: 0, postings: [] });
        word.postings.push({ i, weight: tf });
      }
    }
    for (const word of this.vocabulary.values()) {
      word.idf = 1 + Math.log((1 + this.docs.length) / (1 + word.postings.length));
      for (const posting of word.postings) {
        posting.weight *= word.idf;
        this.docs[posting.i]!.norm += posting.weight ** 2;
      }
    }
    for (const doc of this.docs) doc.norm = Math.sqrt(doc.norm);
  }

  match(query: string, allowRarePair = false): { value: T; score: number }[] {
    const words = termCounts(query);
    // A standalone two-character lookup such as 背压 has only one feature.
    // Admit literal matches only if the entire field has very few such entries.
    if (allowRarePair && /^\p{Script=Han}{2}$/u.test(query.trim()) && words.size === 1) {
      const postings = this.vocabulary.get(words.keys().next().value!)?.postings;
      if (!postings || postings.length > 4) return [];
      return postings.map(({ i }) => ({ value: this.docs[i]!.value, score: 1 }));
    }
    if (words.size < 2) return [];
    const candidates = new Map<number, { dot: number; overlap: number }>();
    let squares = 0;
    for (const [term, tf] of words) {
      const word = this.vocabulary.get(term);
      if (!word) continue;
      const weight = tf * word.idf;
      squares += weight * weight;
      for (const posting of word.postings) {
        let candidate = candidates.get(posting.i);
        if (!candidate) candidates.set(posting.i, candidate = { dot: 0, overlap: 0 });
        candidate.dot += weight * posting.weight;
        candidate.overlap++;
      }
    }
    const ranked: { i: number; score: number }[] = [];
    const norm = Math.sqrt(squares);
    let best = 0;
    for (const [i, candidate] of candidates) {
      if (candidate.overlap < 2) continue;
      const score = candidate.dot / (this.docs[i]!.norm * norm);
      if (score >= 0.4) { ranked.push({ i, score }); best = Math.max(best, score); }
    }
    return ranked.filter(hit => hit.score >= best * 0.9)
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .map(({ i, score }) => ({ value: this.docs[i]!.value, score }));
  }
}
