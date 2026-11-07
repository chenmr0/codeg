import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src';
import { createDatabase, ensureSqlJsReady, type SqliteDatabase } from '../src/db/sqlite-adapter';
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
  const initialized = CodeGraph.initSync(root);
  const native = initialized.getBackend() === 'node-sqlite';
  if (native) initialized.close();
  // This unit fixture injects names/DDL and owns its isolated writable handle.
  const cg = native ? CodeGraph.openPortableRaw(root, path.join(root, '.codegraph-wx', 'codegraph.db'), false) : initialized;
  graphs.push(cg);
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
  // Independent full-scan oracle: hex avoids the TEXT reader's NUL truncation
  // without sharing the product's blob transport or keyset pagination.
  return db.prepare("SELECT DISTINCT hex(name) AS name_hex FROM nodes WHERE kind NOT IN ('file','import') ORDER BY name COLLATE BINARY")
    .all().map((r: { name_hex: string }) => Buffer.from(r.name_hex, 'hex').toString('utf8'));
}
function vocab(db: SqliteDatabase): Array<{ segment: string; name: string }> {
  return db.prepare('SELECT segment, hex(name) AS name_hex FROM temp.name_segment_vocab ORDER BY segment COLLATE BINARY, name COLLATE BINARY')
    .all().map((r: { segment: string; name_hex: string }) => ({ segment: r.segment, name: Buffer.from(r.name_hex, 'hex').toString('utf8') }));
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

async function wasmFixture() {
  // Exercise the real fallback, not a native connection with a mocked
  // inTransaction getter. Source tests need the installed WASM binary.
  const fsModule = require('fs') as typeof fs;
  const originalRead = fsModule.readFileSync;
  const wasm = originalRead(require.resolve('sql.js-fts5/dist/sql-wasm.wasm'));
  const read = vi.spyOn(fsModule, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: any[]) =>
    typeof file === 'string' && file.endsWith('sql-wasm.wasm') ? wasm : (originalRead as any)(file, ...args)) as any);
  try { await ensureSqlJsReady(); } finally { read.mockRestore(); }
  vi.stubEnv('CODEGRAPH_FORCE_WASM', '1');
  const result = fixture();
  expect(result.db.inTransaction).toBeUndefined();
  return result;
}

function assertIndexedPages(db: SqliteDatabase) {
  const prepared = vi.spyOn(db, 'prepare');
  const queries = new QueryBuilder(db);
  queries.getDistinctNodeNamesAfter(2);
  queries.getDistinctNodeNamesAfter(2, 'A\u0000Tail');
  const statements = prepared.mock.calls.map(([sql]) => sql).filter(sql => /SELECT CAST\(name AS BLOB\) AS name_bytes/.test(sql));
  expect(statements).toHaveLength(2);
  for (const sql of statements) {
    const laterPage = sql.includes('name COLLATE BINARY > ?');
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(laterPage ? ['A\u0000Tail', 2] : [2]));
    const details = plan.map(row => row.detail as string).join('\n');
    expect(details).toMatch(laterPage ? /SEARCH (?:TABLE )?nodes USING INDEX idx_nodes_name \(name>\?\)/ : /SCAN (?:TABLE )?nodes USING INDEX idx_nodes_name/);
    expect(details).not.toMatch(/TEMP B-TREE/i);
  }
}

describe('keyset name pages', () => {
  it.each([1, 2, 7, 2000])('matches one full DISTINCT BINARY scan for page size %i', limit => {
    const { db } = fixture();
    seed(db, ['', '', '\u0000', 'A\u0000', 'A\u0000Tail', 'A\u0000Tail\u0000', 'AlphaState', 'AlphaState', 'alphaState', 'ZetaState', 'ÉclairStore',
      'e\u0301clairStore', '中文Store', '\ue000Store', '𐀀Store', '𐀀Store', '💡Factory', '\ufeffStore', '123', '_']);
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

  it.each([1, 2, 2000])('preserves NUL names at page boundaries and inside pages while rebuilding (%i)', pageSize => {
    const { db, build } = fixture(); seed(db, ['StableOrderStore']); build();
    seed(db, ['A', 'A\u0000Tail', 'A\u0000Tail\u0000Store', '\u0000PrefixStore', 'Z\u0000LastStore', '\ufeffBomStore']);
    const queries = new QueryBuilder(db);
    queries.rebuildTemporaryNameSegmentVocab(pageSize);
    expect(db.inTransaction).toBe(false);
    expect(vocab(db)).toEqual(expectedVocab(db));
    expect(vocab(db).some(row => row.name === 'A\u0000Tail\u0000Store')).toBe(true);
    expect(db.prepare('SELECT hex(?) AS value').get('A\u0000Tail').value).toBe('41005461696C');
  });

  it('retains indexed keyset seeks and does not add a temporary DISTINCT or ORDER BY tree', () => {
    const { db } = fixture(); seed(db, ['A', 'A\u0000Tail', 'BStore']);
    assertIndexedPages(db);
  });

  it.each(['UTF-16le', 'UTF-16be'])('decodes blob names in the database encoding without stripping a BOM (%s)', encoding => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-explore-vocabulary-encoding-')); roots.push(root);
    const db = createDatabase(path.join(root, 'encoding.db')).db; writers.push(db);
    db.exec(`PRAGMA encoding='${encoding}'; CREATE TABLE nodes(name TEXT,kind TEXT); CREATE INDEX idx_nodes_name ON nodes(name);`);
    const names = ['', 'A\u0000Tail', 'ÉclairStore', '\ufeffBomStore', '💡Factory'];
    for (const name of names) db.prepare('INSERT INTO nodes VALUES (?,?)').run(name, 'function');
    const queries = new QueryBuilder(db);
    const first = queries.getDistinctNodeNamesAfter(100);
    const paged: string[] = [];
    let after: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = queries.getDistinctNodeNamesAfter(1, after);
      if (!page.length) break;
      paged.push(...page); after = page[0];
    }
    expect(paged).toEqual(first);
    expect(new Set(paged)).toEqual(new Set(names));
  });

  it('rejects invalid encoded TEXT atomically instead of silently substituting another identifier', () => {
    const { db, build } = fixture(); seed(db, ['StableOrderStore']); build(); const previous = vocab(db);
    addNames(db, ['DamagedOrderStore']);
    db.prepare("UPDATE nodes SET name=CAST(X'80' AS TEXT) WHERE name=?").run('DamagedOrderStore');
    const queries = new QueryBuilder(db);
    expect(() => queries.rebuildTemporaryNameSegmentVocab(1)).toThrow();
    expect(db.inTransaction).toBe(false); expect(vocab(db)).toEqual(previous);
    db.prepare("DELETE FROM nodes WHERE hex(name)='80'").run();
    queries.rebuildTemporaryNameSegmentVocab(1);
    expect(vocab(db)).toEqual(expectedVocab(db));
  });
});

describe('real sql.js vocabulary construction', () => {
  it('builds the complete TEMP vocabulary through the adapter with lossless names and indexed keyset pages', async () => {
    const { db, build } = await wasmFixture();
    seed(db, Array.from({ length: 2105 }, (_, i) => `Order${i.toString().padStart(5, '0')}Store`));
    seed(db, ['', '\u0000', 'A\u0000Tail', 'A\u0000Tail\u0000Store', 'ÉclairStore', 'e\u0301clairStore', '中文Store', '💡Factory', '\ufeffBomStore']);
    seed(db, ['ImportOnlyName'], 'import'); seed(db, ['FileOnlyName'], 'file');
    build(); expect(vocab(db)).toEqual(expectedVocab(db));
    expect(vocab(db).some(row => row.name === 'A\u0000Tail\u0000Store')).toBe(true);
    expect(db.prepare("SELECT name FROM main.sqlite_master WHERE name='name_segment_vocab'").get()).toBeUndefined();
    assertIndexedPages(db);
    const queries = new QueryBuilder(db);
    expect(queries.getDistinctNodeNamesAfter(2, 'A\u0000Tail')).toEqual(sourceNames(db).filter(name => Buffer.compare(Buffer.from(name), Buffer.from('A\u0000Tail')) > 0).slice(0, 2));
  });

  it.each(['BEGIN', 'SAVEPOINT caller_scope'])('keeps the real WASM caller transaction open and removes rolled-back names (%s)', async command => {
    const { db, build } = await wasmFixture(); seed(db, ['StableOrderStore']); build(); const previous = vocab(db);
    db.exec(command); addNames(db, ['Uncommitted\u0000OrderStore']);
    const exec = vi.spyOn(db, 'exec');
    build(); expect(vocab(db)).toEqual(expectedVocab(db));
    expect(exec.mock.calls.some(([sql]) => /^BEGIN\b/i.test(sql))).toBe(false);
    if (command === 'BEGIN') db.exec('ROLLBACK');
    else { db.exec('ROLLBACK TO caller_scope'); db.exec('RELEASE caller_scope'); }
    expect(vocab(db)).toEqual(previous);
    build(); expect(vocab(db)).toEqual(expectedVocab(db));
    expect(vocab(db).some(row => row.name === 'Uncommitted\u0000OrderStore')).toBe(false);
  });

  it('restores the previous complete table after a real WASM rebuild failure and retries every name', async () => {
    const { db, build } = await wasmFixture(); seed(db, ['StableOrderStore']); build(); const previous = vocab(db);
    seed(db, Array.from({ length: 2105 }, (_, i) => `AddedOrder${i.toString().padStart(5, '0')}Store`));
    seed(db, ['A\u0000Tail']);
    const original = QueryBuilder.prototype.getDistinctNodeNamesAfter;
    let pages = 0;
    const fault = vi.spyOn(QueryBuilder.prototype, 'getDistinctNodeNamesAfter').mockImplementation(function(limit, after) {
      if (++pages === 2) throw new Error('injected WASM vocabulary page failure');
      return original.call(this, limit, after);
    });
    expect(() => build()).toThrow('injected WASM vocabulary page failure');
    expect(vocab(db)).toEqual(previous);
    fault.mockRestore(); build(); expect(vocab(db)).toEqual(expectedVocab(db));
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
    const fixtureState = fixture();
    const { root } = fixtureState;
    fixtureState.cg.close();
    const cg = CodeGraph.openSync(root); graphs.push(cg);
    fs.writeFileSync(path.join(root, 'service.ts'), 'export function loadOrder() { return saveOrder(); }\nexport function saveOrder() { return 1; }\n');
    await cg.indexAll();
    const db = cg.getExploreQueryConnection();
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
