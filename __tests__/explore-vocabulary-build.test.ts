import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src';
import { createDatabase, type SqliteDatabase } from '../src/db/sqlite-adapter';
import { QueryBuilder } from '../src/upstream-explore/db/queries';
import { createUpstreamExploreGraph } from '../src/mcp/upstream-explore-adapter';
import { ToolHandler } from '../src/mcp/tools';
import { splitIdentifierSegments } from '../src/upstream-explore/search/identifier-segments';

const roots: string[] = [];
const graphs: CodeGraph[] = [];
const writers: SqliteDatabase[] = [];
let nextId = 0;

beforeEach(() => {
  vi.stubEnv('CODEGRAPH_ENABLE_EXPLORE', '1');
  vi.stubEnv('CODEGRAPH_MCP_TOOLS', 'explore');
  vi.stubEnv('CODEGRAPH_EXPLORE_DEDUP', '0');
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of writers.splice(0)) if (db.open) db.close();
  for (const cg of graphs.splice(0)) cg.close();
  for (const root of roots.splice(0)) {
    const absolute = path.resolve(root);
    if (!absolute.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unsafe fixture cleanup');
    fs.rmSync(absolute, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-explore-vocabulary-'));
  roots.push(root);
  const cg = CodeGraph.initSync(root); graphs.push(cg);
  const db = cg.getExploreQueryConnection();
  const api = createUpstreamExploreGraph(cg);
  // The public adapter's beforeQuery guard executes even for an empty probe;
  // no ranking/BFS or test-only product hook is needed to exercise the build.
  const build = () => api.getSegmentMatches([], 1);
  return { root, cg, db, api, build };
}

function addNames(db: SqliteDatabase, names: string[], kind = 'function') {
  const stmt = db.prepare(`INSERT INTO nodes
    (id, kind, name, qualified_name, file_path, language, start_line, end_line,
     start_column, end_column, updated_at)
    VALUES (?, ?, ?, ?, 'fixture.ts', 'typescript', 1, 1, 0, 1, 0)`);
  for (const name of names) stmt.run(`vocabulary-${++nextId}`, kind, name, name);
}
function seed(db: SqliteDatabase, names: string[], kind = 'function') {
  db.transaction(() => addNames(db, names, kind))();
}
function sourceNames(db: SqliteDatabase): string[] {
  return db.prepare("SELECT DISTINCT name FROM nodes WHERE kind NOT IN ('file','import') ORDER BY name COLLATE BINARY")
    .all().map((r: { name: string }) => r.name);
}
function vocab(db: SqliteDatabase): Array<{ segment: string; name: string }> {
  return db.prepare('SELECT segment, name FROM temp.name_segment_vocab ORDER BY segment COLLATE BINARY, name COLLATE BINARY').all();
}
function expectedVocab(db: SqliteDatabase) {
  return sourceNames(db).flatMap(name => splitIdentifierSegments(name).map(segment => ({ segment, name })))
    .sort((a, b) => Buffer.compare(Buffer.from(a.segment), Buffer.from(b.segment))
      || Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
}
function writer(root: string) {
  const db = createDatabase(path.join(root, '.codegraph-wx', 'codegraph.db')).db;
  writers.push(db); return db;
}
function buildCounter() {
  const original = QueryBuilder.prototype.getDistinctNodeNamesAfter;
  const counter = { builds: 0, pages: 0 };
  vi.spyOn(QueryBuilder.prototype, 'getDistinctNodeNamesAfter').mockImplementation(function(limit, after) {
    if (after === undefined) counter.builds++;
    counter.pages++;
    return original.call(this, limit, after);
  });
  return counter;
}

describe('keyset name pages', () => {
  it.each([1, 2, 7, 2000])('matches one full DISTINCT BINARY scan for page size %i', limit => {
    const { db } = fixture();
    seed(db, ['', '', 'AlphaState', 'AlphaState', 'alphaState', 'ZetaState', 'ÉclairStore',
      'e\u0301clairStore', '中文Store', '\ue000Store', '𐀀Store', '𐀀Store', '💡Factory', '123', '_']);
    seed(db, ['ImportOnlyName', 'AlphaState'], 'import'); seed(db, ['FileOnlyName'], 'file');
    const queries = new QueryBuilder(db);
    const all: string[] = [];
    let after: string | undefined;
    for (let guard = 0; guard < 100; guard++) {
      const page = queries.getDistinctNodeNamesAfter(limit, after);
      if (!page.length) break;
      all.push(...page); after = page.at(-1)!;
      if (guard === 99) throw new Error('Keyset cursor did not advance');
    }
    expect(all).toEqual(sourceNames(db));
    expect(all[0]).toBe('');
    expect(new Set(all).size).toBe(all.length);
  });

  it('builds exactly the existing segmenter rows without OFFSET or per-page transactions', () => {
    const { db, build } = fixture();
    seed(db, Array.from({ length: 4201 }, (_, i) => `OrderState${i.toString().padStart(5, '0')}Machine`));
    seed(db, ['OrderState00000Machine', 'HTTPParser', '中文Store', '']);
    seed(db, ['ImportOnlyName'], 'import'); seed(db, ['FileOnlyName'], 'file');
    const sql = vi.spyOn(db, 'prepare'); const exec = vi.spyOn(db, 'exec');
    build();
    expect(vocab(db)).toEqual(expectedVocab(db));
    expect(sql.mock.calls.some(([s]) => /SELECT DISTINCT name FROM nodes/i.test(s) && /OFFSET/i.test(s))).toBe(false);
    expect(exec.mock.calls.filter(([s]) => /^SAVEPOINT\b/i.test(s.trim()))).toHaveLength(1);
    expect(exec.mock.calls.some(([s]) => /^BEGIN\b/i.test(s.trim()))).toBe(false);
    expect(db.prepare("SELECT name FROM main.sqlite_schema WHERE name='name_segment_vocab'").get()).toBeUndefined();
  });

  it('fails and rolls back instead of looping when a damaged name cannot round-trip as a keyset cursor', () => {
    const { db, build } = fixture(); seed(db, ['StableOrderStore']); build(); const previous = vocab(db);
    // node:sqlite currently reads this TEXT as "A" while SQLite compares the
    // stored bytes 41005461696C. Returning "A" again must not hang the build.
    addNames(db, ['A\u0000Tail']);
    const queries = new QueryBuilder(db);
    expect(() => queries.rebuildTemporaryNameSegmentVocab(1)).toThrow();
    expect(db.inTransaction).toBe(false);
    expect(vocab(db)).toEqual(previous);
    db.prepare('DELETE FROM nodes WHERE hex(name)=?').run('41005461696C');
    queries.rebuildTemporaryNameSegmentVocab(1);
    expect(vocab(db)).toEqual(expectedVocab(db));
  });
});

describe('atomic request-time vocabulary', () => {
  it('builds once, then refreshes new earlier names, rename and deletion after an external commit', () => {
    const { db, root, build } = fixture();
    seed(db, ['MiddleOrderStore', 'ZebraOrderStore', 'RemovedOrderStore']);
    const counts = buildCounter();
    build(); expect(counts.builds).toBe(1); expect(vocab(db)).toEqual(expectedVocab(db));
    build(); expect(counts.builds).toBe(1);
    const external = writer(root);
    external.transaction(() => {
      addNames(external, ['AppleOrderStore']);
      external.prepare('UPDATE nodes SET name=?, qualified_name=? WHERE name=?').run('RenamedOrderStore', 'RenamedOrderStore', 'MiddleOrderStore');
      external.prepare('DELETE FROM nodes WHERE name=?').run('RemovedOrderStore');
    })();
    build(); expect(counts.builds).toBe(2); expect(vocab(db)).toEqual(expectedVocab(db));
    expect(vocab(db).some(r => r.name === 'AppleOrderStore')).toBe(true);
    expect(vocab(db).some(r => ['MiddleOrderStore', 'RemovedOrderStore'].includes(r.name))).toBe(false);
    build(); expect(counts.builds).toBe(2);
  });

  it('rolls a failed rebuild back to the prior complete table and retries every name', () => {
    const { db, build } = fixture(); seed(db, ['ExistingOrderStore']); build(); const previous = vocab(db);
    seed(db, Array.from({ length: 2105 }, (_, i) => `AddedOrder${i.toString().padStart(5, '0')}Store`));
    const original = QueryBuilder.prototype.getDistinctNodeNamesAfter;
    let pages = 0;
    const fault = vi.spyOn(QueryBuilder.prototype, 'getDistinctNodeNamesAfter').mockImplementation(function(limit, after) {
      if (++pages === 2) throw new Error('injected vocabulary page failure');
      return original.call(this, limit, after);
    });
    expect(() => build()).toThrow('injected vocabulary page failure');
    expect(db.inTransaction).toBe(false); expect(vocab(db)).toEqual(previous);
    fault.mockRestore();
    build(); expect(vocab(db)).toEqual(expectedVocab(db));
  });

  it.each(['BEGIN', 'SAVEPOINT caller_scope'])('does not commit its caller transaction (%s) or cache rolled-back names', command => {
    const { db, build } = fixture(); seed(db, ['StableOrderStore']); build(); const previous = vocab(db);
    db.exec(command); addNames(db, ['UncommittedOrderStore']);
    build(); expect(db.inTransaction).toBe(true); expect(vocab(db)).toEqual(expectedVocab(db));
    if (command === 'BEGIN') db.exec('ROLLBACK');
    else { db.exec('ROLLBACK TO caller_scope'); db.exec('RELEASE caller_scope'); }
    expect(db.inTransaction).toBe(false); expect(vocab(db)).toEqual(previous);
    build(); expect(vocab(db)).toEqual(expectedVocab(db));
    expect(vocab(db).some(r => r.name === 'UncommittedOrderStore')).toBe(false);
  });

  it('keeps each paged build on one source snapshot when another connection commits between pages', () => {
    const { db, root, build } = fixture();
    seed(db, Array.from({ length: 2105 }, (_, i) => `MiddleOrder${i.toString().padStart(5, '0')}Store`));
    const external = writer(root); const passes: string[][] = [];
    const original = QueryBuilder.prototype.getDistinctNodeNamesAfter; let committed = false;
    vi.spyOn(QueryBuilder.prototype, 'getDistinctNodeNamesAfter').mockImplementation(function(limit, after) {
      if (after === undefined) passes.push([]);
      const names = original.call(this, limit, after); passes.at(-1)!.push(...names);
      if (!committed && names.length) {
        committed = true;
        external.transaction(() => {
          addNames(external, ['AppleConcurrentStore', 'ZebraConcurrentStore']);
          external.prepare('UPDATE nodes SET name=?,qualified_name=? WHERE name=?')
            .run('RenamedConcurrentStore', 'RenamedConcurrentStore', 'MiddleOrder02001Store');
        })();
      }
      return names;
    });
    build();
    expect(committed).toBe(true); expect(passes.length).toBeGreaterThanOrEqual(2);
    expect(passes[0]).toContain('MiddleOrder02001Store');
    expect(passes[0]).not.toContain('ZebraConcurrentStore');
    expect(vocab(db)).toEqual(expectedVocab(db));
    const built = passes.length; build(); expect(passes).toHaveLength(built);
  });

  it('does not publish a fresh stamp for old vocabulary when a commit lands immediately after RELEASE', () => {
    const { db, root, build } = fixture(); seed(db, ['OriginalOrderStore']); const external = writer(root);
    const originalExec = db.exec.bind(db); let committed = false;
    vi.spyOn(db, 'exec').mockImplementation(sql => {
      originalExec(sql);
      if (!committed && /^RELEASE\b/i.test(sql.trim())) {
        committed = true; addNames(external, ['AfterReleaseOrderStore']);
      }
    });
    build(); expect(committed).toBe(true); expect(vocab(db)).toEqual(expectedVocab(db));
    build(); expect(vocab(db)).toEqual(expectedVocab(db));
  });

  it('bounds retries under repeated publication races and never marks a stale table ready', () => {
    const { db, root, build } = fixture(); seed(db, ['OriginalOrderStore']); const external = writer(root);
    const originalExec = db.exec.bind(db); let commits = 0;
    const race = vi.spyOn(db, 'exec').mockImplementation(sql => {
      originalExec(sql);
      if (/^RELEASE\b/i.test(sql.trim())) addNames(external, [`ConcurrentOrder${++commits}Store`]);
    });
    expect(() => build()).toThrow();
    expect(commits).toBe(2);
    expect(db.inTransaction).toBe(false);
    race.mockRestore();
    build(); expect(vocab(db)).toEqual(expectedVocab(db));
  });

  it('keeps unknown transaction-state backends conservative without nested BEGIN or stale rollback results', () => {
    const { db, build } = fixture(); seed(db, ['StableOrderStore']); build();
    vi.spyOn(db, 'inTransaction', 'get').mockReturnValue(undefined);
    db.exec('BEGIN'); addNames(db, ['UnknownStateOrderStore']);
    expect(() => build()).not.toThrow(); expect(vocab(db)).toEqual(expectedVocab(db));
    db.exec('ROLLBACK');
    build(); expect(vocab(db)).toEqual(expectedVocab(db));
    expect(vocab(db).some(r => r.name === 'UnknownStateOrderStore')).toBe(false);
  });

  it('rebuilds after TEMP schema removal and does not reuse a vocabulary on another connection', () => {
    const a = fixture(); seed(a.db, ['FirstConnectionStore']); a.build();
    a.db.exec('DROP TABLE temp.name_segment_vocab'); a.build();
    expect(vocab(a.db)).toEqual(expectedVocab(a.db));
    const b = fixture(); seed(b.db, ['SecondConnectionStore']);
    vi.spyOn(a.cg, 'getExploreQueryConnection').mockReturnValue(b.db);
    createUpstreamExploreGraph(a.cg).getSegmentMatches([], 1);
    expect(vocab(b.db)).toEqual(expectedVocab(b.db));
    expect(vocab(b.db).some(r => r.name === 'FirstConnectionStore')).toBe(false);
  });

  it('preserves the first/second/external-commit lifecycle through the real MCP handler', async () => {
    const { cg, db, root } = fixture();
    fs.writeFileSync(path.join(root, 'service.ts'), 'export function loadOrder() { return saveOrder(); }\nexport function saveOrder() { return 1; }\n');
    await cg.indexAll();
    const counts = buildCounter(); const handler = new ToolHandler(cg);
    const explore = () => handler.execute('explore', { query: 'loadOrder saveOrder', maxFiles: 2 });
    const first = await explore(); expect(first.isError).not.toBe(true); expect(counts.builds).toBe(1);
    const second = await explore(); expect(second).toEqual(first); expect(counts.builds).toBe(1);
    const external = writer(root);
    external.prepare('UPDATE nodes SET docstring=? WHERE name=?').run('External revision', 'loadOrder');
    const third = await explore(); expect(third.isError).not.toBe(true); expect(counts.builds).toBe(2);
    expect(vocab(db)).toEqual(expectedVocab(db));
  });
});
