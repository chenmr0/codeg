import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { QueryBuilder } from '../src/upstream-explore/db/queries';
import { createDatabase } from '../src/upstream-explore/db/sqlite-adapter';
import type { NodeKind } from '../src/upstream-explore/types';

// Upstream's idx_nodes_kind has four columns; legacy native databases have
// only kind. Both must retain SQLite's own equal-length tie order, not merely
// return the same set. No source indexing, disk database or timing assertion.
describe('Explore query compatibility with native database layouts', () => {
  for (const shape of ['kind', 'kind,file_path,start_line,id', 'kind DESC']) {
    it(`matches 648 direct SQL lookups with ${shape}`, () => {
      const { db } = createDatabase(':memory:');
      try {
        db.exec(fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8'));
        db.exec(`DROP INDEX idx_nodes_kind; CREATE INDEX idx_nodes_kind ON nodes(${shape})`);
        const insert = db.prepare('INSERT INTO nodes(id,kind,name,qualified_name,file_path,language,start_line,end_line,start_column,end_column,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
        const add = (id: string, kind: string, name: string, file: string, line: number) =>
          insert.run(id, kind, name, name, file, 'typescript', line, 100, 0, 0, 1);
        const names = ['ItemOne', 'ItemTwo', 'itemXxx', 'ITEMxxx', 'Load_It', 'LoadXIt', 'Größe', 'größe', 'ÉtatLoader', 'étatLoader', '𝑥ItemOne'];
        const kinds: NodeKind[] = ['function', 'class', 'method'];
        for (let i = 0; i < 400; i++) add(`n${i}`, kinds[i % 3]!, names[i % names.length]!, `src/${(i * 17) % 43}.ts`, (i * 13) % 29);
        const queries = new QueryBuilder(db);
        let checks = 0;
        const verify = () => {
          for (const word of ['Item', 'item', '_', 'Lo_d', 'É', '𝑥', '%', 'Missing', 'Größe']) {
            for (const selected of [['function'], kinds, ['method', 'class']] as NodeKind[][]) {
              for (const excludePrefix of [false, true]) {
                for (const limit of [1, 5, 50]) {
                  let sql = 'SELECT id FROM nodes WHERE name LIKE ?';
                  const args: (string | number)[] = [`%${word}%`];
                  if (excludePrefix) { sql += ' AND name NOT LIKE ?'; args.push(`${word}%`); }
                  sql += ` AND kind IN (${selected.map(() => '?').join(',')}) ORDER BY length(name) ASC LIMIT ?`;
                  args.push(...selected, limit);
                  const expected = db.prepare(sql).all(...args).map(row => row.id);
                  const actual = queries.findNodesByNameSubstring(word, { kinds: selected, excludePrefix, limit }).map(row => row.node.id);
                  expect(actual, `${shape}: ${word}, ${selected}, prefix=${excludePrefix}, limit=${limit}`).toEqual(expected);
                  checks++;
                }
              }
            }
          }
        };
        verify();
        add('new', 'function', 'ItemAAa', '0.ts', 0);
        verify(); // A write invalidates the cached names and ordering.
        db.exec('BEGIN');
        verify(); // Transaction reads must not reuse a rollback-sensitive memo.
        db.exec('ROLLBACK');
        add('nul', 'function', 'Item\0tail', '0.ts', 0);
        verify(); // NUL cannot silently become a shortened cached name.
        expect(queries.getAllNodeNames()).toContain('Item\0tail');
        expect(checks).toBe(648);
      } finally { db.close(); }
    });
  }
  it('applies path/name filters before limits and reports only genuinely unseen names', () => {
    const { db } = createDatabase(':memory:');
    try {
      db.exec(fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8'));
      const insert = db.prepare('INSERT INTO nodes(id,kind,name,qualified_name,file_path,language,start_line,end_line,start_column,end_column,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
      let sequence = 0;
      const add = (name: string, file: string) => insert.run(String(sequence++), 'function', name, name, file, 'typescript', 1, 1, 0, 0, 1);
      for (let i = 0; i < 120; i++) {
        add(`authenticate${i}`, `noise/${i}.ts`);
        add(`aaaNeedle${i}`, `noise/${i}.ts`);
      }
      add('authenticateUserHandler', 'product/auth.ts');
      add('zzNeedleHandler', 'product/needle.ts');
      add('getUser', 'product/user.ts');
      add('leaf', 'product/flow.ts');
      add('entry', 'product/flow.ts');
      const queries = new QueryBuilder(db);
      const names = (query: string) => queries.searchNodes(query, { limit: 1 }).map(r => r.node.name);
      expect(names('authenticate path:product/')).toEqual(['authenticateUserHandler']);
      expect(names('needle path:product/')).toEqual(['zzNeedleHandler']);
      expect(names('getUsar path:product/')).toEqual(['getUser']);
      expect(names('kind:function name:zzNeedleHandler')).toEqual(['zzNeedleHandler']);
      expect(queries.searchNodes('leaf(entry)', { limit: 10 }).map(r => r.node.name)).toEqual(expect.arrayContaining(['leaf', 'entry']));
      expect(queries.getUnseenNames(['getUser', 'MissingHandler', 'Owner.getUser'])).toEqual(['MissingHandler']);
      expect(queries.getUnseenNames(['MissingHandler'])).toEqual(['MissingHandler']);
      add('MissingHandler', 'product/new.ts');
      expect(queries.getUnseenNames(['MissingHandler'])).toEqual([]);
      expect(names('kind:function name:MissingHandler')).toEqual(['MissingHandler']);
    } finally { db.close(); }
  });

});
