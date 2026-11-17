import type { SqliteDatabase } from './db/sqlite-adapter';
import { CHINESE_COMMENT_PREFIX, type ChineseComment } from './types';
import { ChineseTextIndex } from './chinese-text-index';

interface CommentIndex {
  head: ChineseTextIndex<ChineseComment>;
  body: ChineseTextIndex<ChineseComment>;
}
const cache = new WeakMap<SqliteDatabase, { stamp: string; index: CommentIndex }>();

function readIndex(db: SqliteDatabase): CommentIndex {
  // A rollback does not rewind total_changes. Never publish an index built from
  // an uncommitted view, or reuse one across an external commit/connection swap.
  const cacheable = db.inTransaction === false;
  const stamp = cacheable ? JSON.stringify(db.prepare(
    'SELECT total_changes() AS writes, (SELECT data_version FROM pragma_data_version) AS version'
  ).get()) : '';
  const previous = cache.get(db);
  if (cacheable && previous?.stamp === stamp) return previous.index;
  const head: ChineseComment[] = [], body: ChineseComment[] = [];
  for (const row of db.prepare('SELECT value FROM project_metadata WHERE key GLOB ? ORDER BY key')
    .iterate(CHINESE_COMMENT_PREFIX + '*')) {
    const entries: ChineseComment[] = JSON.parse(row.value);
    for (const entry of entries) (entry.field === 'head' ? head : body).push(entry);
  }
  const index = { head: new ChineseTextIndex(head, e => e.text), body: new ChineseTextIndex(body, e => e.text) };
  if (cacheable) cache.set(db, { stamp, index });
  return index;
}

export interface CommentMatch { comment: ChineseComment; clause: string; }

/** A clause contributes at most one vote to each function across both fields. */
export function matchChineseComments(db: SqliteDatabase, query: string): CommentMatch[] {
  if (!/\p{Script=Han}/u.test(query)) return [];
  const index = readIndex(db);
  const clauses = new Set(query.split(/以及|[。！？?!；;，,、|\r\n]+/u).map(s => s.trim()).filter(s => /\p{Script=Han}/u.test(s)));
  const owners = new Map<string, { votes: number; best: number; match: CommentMatch }>();
  for (const clause of clauses) {
    const hits = new Map<string, { value: ChineseComment; score: number }>();
    for (const field of [index.head, index.body]) {
      for (const hit of field.match(clause, clause === query.trim()).slice(0, 24)) {
        const old = hits.get(hit.value.nodeId);
        if (!old || old.score < hit.score) hits.set(hit.value.nodeId, hit);
      }
    }
    for (const [id, { value, score }] of hits) {
      const owner = owners.get(id);
      if (!owner) owners.set(id, { votes: 1, best: score, match: { comment: value, clause } });
      else {
        owner.votes++;
        if (score > owner.best) { owner.best = score; owner.match = { comment: value, clause }; }
      }
    }
  }
  const ranked = [...owners.values()].sort((a, b) => b.votes - a.votes || b.best - a.best);
  const covered = new Set<string>();
  const selected: CommentMatch[] = [];
  const alternatives: CommentMatch[] = [];
  // Preserve evidence for distinct behaviours before filling spare slots with
  // alternatives for one clause that appears in several similar functions.
  for (const { match } of ranked) {
    if (covered.has(match.clause)) alternatives.push(match);
    else {
      selected.push(match);
      covered.add(match.clause);
      if (selected.length === 4) break;
    }
  }
  return selected.concat(alternatives.slice(0, 4 - selected.length));
}
