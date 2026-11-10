import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, type SqliteDatabase } from '../src/db/sqlite-adapter';
import { QueryBuilder } from '../src/upstream-explore/db/queries';

describe('Explore LIKE fallback', () => {
  let db: SqliteDatabase;
  let queries: QueryBuilder;
  beforeEach(() => {
    db = createDatabase(':memory:', { nativeOnly: true }).db;
    db.exec('CREATE TABLE nodes(id TEXT, name TEXT NOT NULL, qualified_name TEXT, kind TEXT, language TEXT, file_path TEXT)');
    const insert = db.prepare("INSERT INTO nodes VALUES (?, ?, ?, 'function', 'cpp', 'impl.cpp')");
    for (const [id, name, qualified] of [
      ['1', 'ReadΔΣand', '命名空間::读记录'],
      ['2', 'ReadΔΣand', 'scope::Écrire'],
      ['3', 'FindÉtat', 'scope::İndex'],
      ['4', 'Cafe\u0301', 'scope::𐐀Name'],
      ['5', '📚', null],
      ['6', 'hidden\0Tail', 'scope.with.dot'],
    ]) insert.run(id, name, qualified);
    queries = new QueryBuilder(db);
  });
  afterEach(() => { vi.restoreAllMocks(); db.close(); });

  function search(pattern: string, offset = 0) {
    return queries['searchNodesLike'](pattern, { limit: 2, offset }).map(r => [r.node.id, r.score]);
  }

  it('preserves SQLite scores, order and pagination across scripts and wildcards', () => {
    for (const pattern of [
      'READδ', 'ΔΣ', 'rEAd', '读记', 'Écri', 'İn', 'ind', 'e\u0301', '𐐀n',
      '未收录', '命名%读', '命名_間', '_ΔΣ%', '%_','📚', 'scope.with', 'hidden\0Absent',
    ]) {
      for (const offset of [0, 1]) {
        // Within the transaction the fallback always executes the original SQL.
        const oracle = db.transaction(() => search(pattern, offset))();
        expect(search(pattern, offset), pattern).toEqual(oracle);
      }
    }
  });

  it('skips an impossible literal and observes inserts and rolled-back writes', () => {
    const prepare = vi.spyOn(db, 'prepare');
    const scans = () => prepare.mock.calls.filter(([sql]) => sql.includes('WHEN name LIKE')).length;
    expect(search('scope_%新条目')).toEqual([]);
    expect(scans()).toBe(0);
    db.exec("INSERT INTO nodes VALUES ('7','other','scope::新条目','function','cpp','impl.cpp')");
    expect(search('scope_%新条目')).toEqual([['7', 0.7]]);
    expect(scans()).toBe(1);
    db.exec('SAVEPOINT temp_change');
    db.exec("UPDATE nodes SET qualified_name='scope::新记录' WHERE id='7'");
    expect(search('新记录')).toHaveLength(1);
    db.exec('ROLLBACK TO temp_change');
    db.exec('RELEASE temp_change');
    expect(search('新记录')).toEqual([]);
    expect(search('新条目')).toHaveLength(1);
  });
});
