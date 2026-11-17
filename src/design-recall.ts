import { ChineseTextIndex, termCounts } from './chinese-text-index';
import type { SqliteDatabase } from './db/sqlite-adapter';
import { designModulePrefix, type TermMappings, type TermMappingRule } from './term-mappings';

export const MAX_DESIGN_SEEDS = 24;

const cache = new WeakMap<TermMappings, ChineseTextIndex<TermMappingRule>>();
export function designSeedIds(
  db: SqliteDatabase, query: string, config: TermMappings,
  onMatch?: (rule: TermMappingRule, terms: string[], ids: string[]) => void,
): string[] {
  if (!/\p{Script=Han}/u.test(query)) return [];
  let index = cache.get(config);
  if (!index) {
    index = new ChineseTextIndex(config.rules.filter(rule => rule.design), rule => rule.terms.join(' '));
    cache.set(config, index);
  }
  const ranked = index.match(query);
  if (!ranked.length) return [];
  const definition = db.prepare("SELECT id FROM nodes WHERE substr(file_path,1,length(?))=? AND (name=? OR qualified_name=?) AND kind NOT IN ('file','import') LIMIT 2");
  const ids = new Set<string>();
  const queryTerms = onMatch && termCounts(query);
  for (const { value: rule } of ranked) {
    const prefix = designModulePrefix(rule.design!.document);
    const ruleIds = onMatch ? [] as string[] : undefined;
    for (const symbol of rule.symbols) {
      if (ids.size >= MAX_DESIGN_SEEDS) break;
      const matches = definition.all(prefix, prefix, symbol, symbol);
      if (matches.length !== 1) continue;
      ids.add(matches[0].id);
      ruleIds?.push(matches[0].id);
      if (!onMatch && ids.size === MAX_DESIGN_SEEDS) return [...ids];
    }
    if (onMatch && ruleIds && queryTerms) {
      // A document rule is scored as one vector. Only name aliases whose words
      // actually contributed to its score, even when several aliases share it.
      const terms = rule.terms.filter(term => [...termCounts(term).keys()].some(word => queryTerms.has(word)));
      onMatch(rule, terms, ruleIds);
    }
  }
  return [...ids];
}
