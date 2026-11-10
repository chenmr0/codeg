import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src';
import { createDatabase, ensureSqlJsReady, type SqliteDatabase } from '../src/db/sqlite-adapter';
import { createUpstreamExploreGraph } from '../src/mcp/upstream-explore-adapter';
import { ToolHandler as ExploreHandler } from '../src/upstream-explore/mcp/tools';
// Unit-level writable cache tests; real portable MCP routing is covered by
// upstream-native-integration and explore-production-acceptance.
class ToolHandler {
  constructor(private cg: CodeGraph) {}
  execute(_tool: string, args: Record<string, unknown>) {
    return new ExploreHandler(createUpstreamExploreGraph(this.cg)).execute('codegraph_explore', args);
  }
}
import { QueryBuilder as UpstreamQueries } from '../src/upstream-explore/db/queries';

const roots: string[] = [];
const graphs: CodeGraph[] = [];
const connections: SqliteDatabase[] = [];
beforeEach(() => {
  vi.stubEnv('CODEGRAPH_ENABLE_EXPLORE', '1');
  vi.stubEnv('CODEGRAPH_MCP_TOOLS', 'explore');
  vi.stubEnv('CODEGRAPH_EXPLORE_DEDUP', '0');
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of connections.splice(0)) if (db.open) db.close();
  for (const cg of graphs.splice(0)) cg.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function fixture(body = 'export function loadOrder() { return saveOrder(); }\nexport function saveOrder() { return 1; }\n') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-explore-query-cache-')); roots.push(root);
  fs.writeFileSync(path.join(root, 'service.ts'), body);
  const initialized = CodeGraph.initSync(root); await initialized.indexAll(); initialized.close();
  // Low-level cache mutation tests intentionally own a writable handle; the
  // portable public facade exposes a read-only request connection instead.
  const cg = CodeGraph.openPortableRaw(root, path.join(root, '.codegraph-wx', 'codegraph.db'), false);
  graphs.push(cg);
  return { cg, root, db: cg.getExploreQueryConnection() };
}

function observe(db: SqliteDatabase) {
  const counts = { dominant: 0, nodePreparations: 0 };
  const exec = db.exec.bind(db);
  vi.spyOn(db, 'exec').mockImplementation(sql => {
    if (sql === 'SAVEPOINT explore_dominant_counts') counts.dominant++;
    return exec(sql);
  });
  const prepare = db.prepare.bind(db);
  vi.spyOn(db, 'prepare').mockImplementation(sql => {
    const stmt = prepare(sql);
    if (sql === 'SELECT * FROM nodes WHERE id = ?') counts.nodePreparations++;
    return stmt;
  });
  return counts;
}

describe('Explore query caches with request-local source verification', () => {
  it('reuses the full-graph aggregation across calls on the same MCP handler', async () => {
    const { cg, db } = await fixture(); const counts = observe(db);
    const handler = new ToolHandler(cg);
    const first = await handler.execute('explore', { query: 'loadOrder saveOrder', maxFiles: 2 });
    expect(first.isError).not.toBe(true);
    expect(counts.dominant).toBe(1);
    const second = await handler.execute('explore', { query: 'loadOrder saveOrder', maxFiles: 2 });
    expect(second).toEqual(first);
    expect(counts.dominant).toBe(1);
    // Also covers clients that replace their handler but retain the graph.
    await new ToolHandler(cg).execute('explore', { query: 'loadOrder saveOrder', maxFiles: 2 });
    expect(counts.dominant).toBe(1);
  });

  it('retains prepared statements but refreshes cached nodes on same-connection and external writes', async () => {
    const { cg, db, root } = await fixture(); const counts = observe(db);
    const api = createUpstreamExploreGraph(cg);
    const id = api.getNodesByName('loadOrder')[0]!.id;
    expect(api.getNode(id)!.name).toBe('loadOrder');
    createUpstreamExploreGraph(cg).getNode(id);
    expect(counts.nodePreparations).toBe(1);
    db.prepare('UPDATE nodes SET name = ? WHERE id = ?').run('sameConnection', id);
    expect(api.getNode(id)!.name).toBe('sameConnection');
    const writer = createDatabase(path.join(root, '.codegraph-wx', 'codegraph.db')).db; connections.push(writer);
    writer.prepare('UPDATE nodes SET name = ? WHERE id = ?').run('externalCommit', id);
    expect(createUpstreamExploreGraph(cg).getNode(id)!.name).toBe('externalCommit');
    expect(counts.nodePreparations).toBe(1);
  });

  it('recomputes graph aggregation after same-connection and external commits', async () => {
    const { cg, db, root } = await fixture(); const counts = observe(db);
    const handler = new ToolHandler(cg);
    const explore = () => handler.execute('explore', { query: 'loadOrder saveOrder', maxFiles: 2 });
    await explore(); expect(counts.dominant).toBe(1);
    db.prepare('UPDATE nodes SET docstring = ? WHERE name = ?').run('first revision', 'loadOrder');
    await explore(); expect(counts.dominant).toBe(2);
    const writer = createDatabase(path.join(root, '.codegraph-wx', 'codegraph.db')).db; connections.push(writer);
    writer.prepare('UPDATE nodes SET docstring = ? WHERE name = ?').run('external revision', 'loadOrder');
    await explore(); expect(counts.dominant).toBe(3);
    await explore(); expect(counts.dominant).toBe(3);
  });

  it('never retains nodes read inside BEGIN or SAVEPOINT after rollback', async () => {
    const { cg, db } = await fixture(); const api = createUpstreamExploreGraph(cg);
    const id = api.getNodesByName('loadOrder')[0]!.id;
    expect(db.inTransaction).toBe(false); expect(api.getNode(id)!.name).toBe('loadOrder');
    db.exec('BEGIN'); expect(db.inTransaction).toBe(true);
    db.prepare('UPDATE nodes SET name = ? WHERE id = ?').run('temporary', id);
    expect(api.getNode(id)!.name).toBe('temporary');
    db.exec('ROLLBACK'); expect(db.inTransaction).toBe(false);
    expect(api.getNode(id)!.name).toBe('loadOrder');
    db.exec('SAVEPOINT nested'); expect(db.inTransaction).toBe(true);
    db.prepare('UPDATE nodes SET name = ? WHERE id = ?').run('savepointOnly', id);
    expect(api.getNode(id)!.name).toBe('savepointOnly');
    db.exec('ROLLBACK TO nested');
    expect(api.getNode(id)!.name).toBe('loadOrder');
    db.exec('RELEASE nested'); expect(db.inTransaction).toBe(false);
    expect(api.getNode(id)!.name).toBe('loadOrder');
  });

  it('does not reuse transaction-local aggregation after rollback', async () => {
    const { cg, db } = await fixture(); const counts = observe(db);
    const api = createUpstreamExploreGraph(cg);
    await api.findRelevantContext('loadOrder saveOrder'); expect(counts.dominant).toBe(1);
    db.exec('BEGIN');
    db.prepare('UPDATE nodes SET docstring = ? WHERE name = ?').run('not committed', 'loadOrder');
    await api.findRelevantContext('loadOrder saveOrder'); expect(counts.dominant).toBe(2);
    db.exec('ROLLBACK');
    await api.findRelevantContext('loadOrder saveOrder'); expect(counts.dominant).toBe(3);
    await api.findRelevantContext('loadOrder saveOrder'); expect(counts.dominant).toBe(3);
  });

  it('refreshes statements on schema change and never transfers node caches to another connection', async () => {
    const first = await fixture(); const counts = observe(first.db);
    const api = createUpstreamExploreGraph(first.cg); const node = api.getNodesByName('loadOrder')[0]!;
    api.getNode(node.id); expect(counts.nodePreparations).toBe(1);
    first.db.exec('ALTER TABLE nodes ADD COLUMN cache_fixture_marker TEXT');
    api.getNode(node.id); expect(counts.nodePreparations).toBe(2);
    await api.findRelevantContext('loadOrder saveOrder');
    first.db.exec('DROP TABLE temp.name_segment_vocab');
    await api.findRelevantContext('loadOrder saveOrder');
    expect(first.db.prepare('SELECT COUNT(*) AS n FROM temp.name_segment_vocab').get().n).toBeGreaterThan(0);
    const second = await fixture();
    const secondId = createUpstreamExploreGraph(second.cg).getNodesByName('loadOrder')[0]!.id;
    second.db.prepare('UPDATE nodes SET name = ? WHERE id = ?').run('replacementConnection', secondId);
    vi.spyOn(first.cg, 'getExploreQueryConnection').mockReturnValue(second.db);
    expect(createUpstreamExploreGraph(first.cg).getNode(secondId)!.name).toBe('replacementConnection');
    // An old facade does not silently switch databases.
    expect(api.getNode(node.id)!.name).toBe('loadOrder');
    first.cg.close();
    expect(() => api.getNode(node.id)).toThrow(/closed/i);
  });

  it('redetects FTS after same-connection schema repair and removal', async () => {
    const { cg, db } = await fixture('/** cacheDocNeedle */\nexport function loadOrder() { return 1; }\n');
    // Query-cache contract, independent of the optional TypeScript docstring
    // extractor migration. Seed known indexed documentation and prove that the
    // FTS fixture contains it before exercising schema removal and repair.
    db.prepare("UPDATE nodes SET docstring = ? WHERE name = ?").run('cacheDocNeedle', 'loadOrder');
    expect(createUpstreamExploreGraph(cg).searchNodes('cacheDocNeedle').map(r => r.node.name)).toContain('loadOrder');
    const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'nodes_fts'").get().sql as string;
    db.exec('DROP TABLE nodes_fts');
    const api = createUpstreamExploreGraph(cg);
    // The term occurs only in documentation; LIKE/name fallback cannot find it.
    expect(api.searchNodes('cacheDocNeedle')).toHaveLength(0);
    db.exec(ddl);
    db.exec("INSERT INTO nodes_fts(nodes_fts) VALUES ('rebuild')");
    expect(api.searchNodes('cacheDocNeedle').map(r => r.node.name)).toContain('loadOrder');
    const prepare = vi.spyOn(db, 'prepare');
    db.exec('DROP TABLE nodes_fts');
    expect(api.searchNodes('cacheDocNeedle')).toHaveLength(0);
    expect(prepare.mock.calls.some(([sql]) => sql.includes('WHERE nodes_fts MATCH'))).toBe(false);
  });

  it('keeps interleaved requests source-local, including lazily evaluated generated flags', async () => {
    const body = '// Code generated by fixture. DO NOT EDIT.\nexport function loadOrder() { return 1; }\n';
    const { cg, root } = await fixture(body);
    const first = createUpstreamExploreGraph(cg);
    expect(first.getVerifiedSource!('service.ts')).toBe(body);
    const delayedFiles = first.getFiles();
    fs.writeFileSync(path.join(root, 'service.ts'), body.replace('return 1', 'return 2'));
    const second = createUpstreamExploreGraph(cg);
    await Promise.all([
      Promise.resolve().then(() => expect(second.getVerifiedSource!('service.ts')).toBeUndefined()),
      Promise.resolve().then(() => expect(first.getVerifiedSource!('service.ts')).toBe(body)),
    ]);
    expect(second.generatedFilePredicate(['service.ts'])('service.ts')).toBe(false);
    expect(delayedFiles.find(f => f.path === 'service.ts')!.generated).toBe(true);
    expect(first.generatedFilePredicate(['service.ts'])('service.ts')).toBe(true);
  });

  it('caches dominant aggregation without caching its source-dependent generated filter', async () => {
    const body = '// Code generated by fixture. DO NOT EDIT.\nexport function loadOrder() { return 1; }\n'
      + Array.from({ length: 24 }, (_, i) => `export function sibling${i}() { return loadOrder(); }`).join('\n');
    const { cg, db, root } = await fixture(body); const counts = observe(db);
    const dominant = vi.spyOn(UpstreamQueries.prototype, 'getDominantFile');
    await createUpstreamExploreGraph(cg).findRelevantContext('loadOrder');
    expect(dominant.mock.results.at(-1)!.value).toBeNull();
    expect(counts.dominant).toBe(1);
    fs.writeFileSync(path.join(root, 'service.ts'), body.replace('return 1', 'return 2'));
    await createUpstreamExploreGraph(cg).findRelevantContext('loadOrder');
    // Changed bytes cannot prove the indexed generated header. Match the old
    // adapter's conservative source verifier instead of reusing its old flag.
    expect(dominant.mock.results.at(-1)!.value).toMatchObject({ filePath: 'service.ts' });
    expect(counts.dominant).toBe(1);
  });

  it('does not memoize aggregation when a backend cannot report transaction state', async () => {
    const { cg, db } = await fixture(); const counts = observe(db);
    vi.spyOn(db, 'inTransaction', 'get').mockReturnValue(undefined);
    await createUpstreamExploreGraph(cg).findRelevantContext('loadOrder');
    const first = counts.dominant; expect(first).toBeGreaterThan(0);
    await createUpstreamExploreGraph(cg).findRelevantContext('loadOrder');
    expect(counts.dominant).toBeGreaterThan(first);
  });

  it('keeps independent projects isolated even when their symbol IDs and database stamps coincide', async () => {
    const a = await fixture(); const b = await fixture();
    const apiA = createUpstreamExploreGraph(a.cg); const apiB = createUpstreamExploreGraph(b.cg);
    const idA = apiA.getNodesByName('loadOrder')[0]!.id;
    const idB = apiB.getNodesByName('loadOrder')[0]!.id;
    b.db.prepare('UPDATE nodes SET name = ? WHERE id = ?').run('otherProject', idB);
    expect(apiA.getNode(idA)!.name).toBe('loadOrder');
    expect(apiB.getNode(idB)!.name).toBe('otherProject');
  });
});

describe('native transaction state bridge', () => {
  it('exposes real helper nesting and savepoints, and does not invent state for sql.js', async () => {
    const primary = createDatabase(':memory:').db; connections.push(primary);
    expect(primary.inTransaction).toBe(false);
    primary.transaction(() => {
      expect(primary.inTransaction).toBe(true);
      primary.transaction(() => expect(primary.inTransaction).toBe(true))();
    })();
    expect(primary.inTransaction).toBe(false);
    // Source tests do not run copy-assets; supply the installed WASM binary
    // to the existing loader without writing a build asset into the worktree.
    const fsModule = require('fs') as typeof fs;
    const originalRead = fsModule.readFileSync;
    const wasm = originalRead(require.resolve('sql.js-fts5/dist/sql-wasm.wasm'));
    const read = vi.spyOn(fsModule, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: any[]) =>
      typeof file === 'string' && file.endsWith('sql-wasm.wasm') ? wasm : (originalRead as any)(file, ...args)) as any);
    await ensureSqlJsReady(); read.mockRestore(); vi.stubEnv('CODEGRAPH_FORCE_WASM', '1');
    const fallbackRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-explore-cache-wasm-')); roots.push(fallbackRoot);
    const fallback = createDatabase(path.join(fallbackRoot, 'fallback.db')).db; connections.push(fallback);
    expect(fallback.inTransaction).toBeUndefined();
    fallback.exec('BEGIN'); expect(fallback.inTransaction).toBeUndefined(); fallback.exec('ROLLBACK');
  });
});
