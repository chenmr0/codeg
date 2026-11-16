import type { SqliteDatabase } from './db/sqlite-adapter';
import type { TermMappings, TermMappingRule } from './term-mappings';

export const MAX_DESIGN_SEEDS = 24;

function counts(text: string): Map<string, number> {
  const terms = new Map<string, number>();
  for (const match of text.normalize('NFKC').toLowerCase().matchAll(/\p{Script=Han}+|[a-z][a-z0-9_]*/gu)) {
    const word = match[0];
    if (/^[a-z]/.test(word)) terms.set(word, (terms.get(word) ?? 0) + 1);
    else {
      const chars = [...word];
      for (let i = 1; i < chars.length; i++) {
        const gram = chars[i - 1]! + chars[i]!;
        terms.set(gram, (terms.get(gram) ?? 0) + 1);
      }
    }
  }
  return terms;
}

function compile(entries: TermMappingRule[]) {
  const vectors = entries.map(entry => {
    const terms = counts(entry.terms.join(' '));
    for (const [term, n] of counts(entry.design!.heading)) terms.set(term, (terms.get(term) ?? 0) + 0.25 * n);
    return { terms, rule: entry, norm: 0 };
  });
  const idf = new Map<string, number>();
  for (const { terms } of vectors) for (const term of terms.keys()) idf.set(term, (idf.get(term) ?? 0) + 1);
  for (const [term, df] of idf) idf.set(term, 1 + Math.log((1 + entries.length) / (1 + df)));
  for (const v of vectors) {
    let squares = 0;
    for (const [term, tf] of v.terms) {
      const weight = tf * idf.get(term)!;
      v.terms.set(term, weight);
      squares += weight * weight;
    }
    v.norm = Math.sqrt(squares);
  }
  return { vectors, idf };
}

const cache = new WeakMap<TermMappings, ReturnType<typeof compile>>();
export function designSeedIds(db: SqliteDatabase, query: string, config: TermMappings): string[] {
  if (!/\p{Script=Han}/u.test(query)) return [];
  let index = cache.get(config);
  if (!index) {
    index = compile(config.rules.filter(rule => rule.design));
    cache.set(config, index);
  }
  const weights = new Map<string, number>();
  let squares = 0;
  for (const [term, tf] of counts(query)) {
    const idf = index.idf.get(term);
    if (!idf) continue;
    const weight = tf * idf;
    weights.set(term, weight);
    squares += weight * weight;
  }
  if (!squares) return [];
  const ranked: { score: number; rule: TermMappingRule }[] = [];
  for (const vector of index.vectors) {
    let dot = 0, overlap = 0;
    for (const [term, weight] of weights) {
      const v = vector.terms.get(term);
      if (v) { dot += v * weight; overlap++; }
    }
    const score = dot / (vector.norm * Math.sqrt(squares));
    if (overlap >= 2 && score >= 0.4) ranked.push({ score, rule: vector.rule });
  }
  ranked.sort((a, b) => b.score - a.score);
  if (!ranked.length) return [];
  const definition = db.prepare("SELECT id FROM nodes WHERE file_path=? AND (name=? OR qualified_name=?) AND kind NOT IN ('file','import') LIMIT 2");
  const ids = new Set<string>();
  for (const row of ranked) {
    if (row.score < ranked[0]!.score * 0.9) break;
    for (const symbol of row.rule.symbols) {
      const matches = definition.all(row.rule.design!.file, symbol, symbol);
      if (matches.length !== 1) continue;
      ids.add(matches[0].id);
      if (ids.size === MAX_DESIGN_SEEDS) return [...ids];
    }
  }
  return [...ids];
}
