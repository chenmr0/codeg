import type { SqliteDatabase } from './db/sqlite-adapter';

export const DESIGN_INDEX_KEY = 'explore:design-documents-v1';
export const MAX_DESIGN_SEEDS = 24;
export interface DesignEntry {
  document: string;
  heading: string;
  text: string;
  evidence: string;
  symbol: string;
  file: string;
  ids: string[];
}

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

function compile(entries: DesignEntry[]) {
  const vectors = entries.map(entry => {
    const terms = counts(entry.text);
    for (const [term, n] of counts(entry.heading)) terms.set(term, (terms.get(term) ?? 0) + 0.25 * n);
    return { terms, ids: entry.ids, norm: 0 };
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

const cache = new WeakMap<SqliteDatabase, { value: string; index: ReturnType<typeof compile> }>();
export function designSeedIds(db: SqliteDatabase, query: string): string[] {
  if (!/\p{Script=Han}/u.test(query)) return [];
  const value = db.prepare('SELECT value FROM project_metadata WHERE key=?').get(DESIGN_INDEX_KEY)?.value;
  if (!value) return [];
  let hit = cache.get(db);
  if (!hit || hit.value !== value) {
    hit = { value, index: compile(JSON.parse(value)) };
    cache.set(db, hit);
  }
  const weights = new Map<string, number>();
  let squares = 0;
  for (const [term, tf] of counts(query)) {
    const idf = hit.index.idf.get(term);
    if (!idf) continue;
    const weight = tf * idf;
    weights.set(term, weight);
    squares += weight * weight;
  }
  if (!squares) return [];
  const ranked: { score: number; ids: string[] }[] = [];
  for (const vector of hit.index.vectors) {
    let dot = 0, overlap = 0;
    for (const [term, weight] of weights) {
      const v = vector.terms.get(term);
      if (v) { dot += v * weight; overlap++; }
    }
    const score = dot / (vector.norm * Math.sqrt(squares));
    if (overlap >= 2 && score >= 0.4) ranked.push({ score, ids: vector.ids });
  }
  ranked.sort((a, b) => b.score - a.score);
  const ids = new Set<string>();
  for (const row of ranked) {
    if (row.score < ranked[0]!.score * 0.9) break;
    for (const id of row.ids) {
      ids.add(id);
      if (ids.size === MAX_DESIGN_SEEDS) return [...ids];
    }
  }
  return [...ids];
}
