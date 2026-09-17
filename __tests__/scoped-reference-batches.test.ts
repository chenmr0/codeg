import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase, ensureSqlJsReady, type SqliteDatabase } from '../src/db/sqlite-adapter';
import { QueryBuilder, SCOPED_REFERENCE_BATCH_SIZE, type PendingReferenceCursor } from '../src/db/queries';
import { ReferenceResolver } from '../src/resolution';
import { ResolutionDiagnostics } from '../src/resolution/diagnostics';
import CodeGraph from '../src/index';

const databases: SqliteDatabase[] = [];
const roots: string[] = [];
const graphs: CodeGraph[] = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const graph of graphs.splice(0)) graph.close();
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) {
    const resolved = fs.realpathSync(root);
    if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) ||
        !path.basename(resolved).startsWith('cg-scoped-refs-')) throw new Error('Unsafe test cleanup');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
function fixture(databasePath = ':memory:') {
  const { db } = createDatabase(databasePath); databases.push(db);
  db.exec(`CREATE TABLE unresolved_refs(id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_node_id TEXT,reference_name TEXT,reference_kind TEXT,line INTEGER,col INTEGER,
    candidates TEXT,file_path TEXT,language TEXT,status TEXT);
    CREATE INDEX idx_unresolved_file_path ON unresolved_refs(file_path);
    CREATE INDEX idx_unresolved_status ON unresolved_refs(status);`);
  const insert = db.prepare(`INSERT INTO unresolved_refs(from_node_id,reference_name,reference_kind,
    line,col,candidates,file_path,language,status) VALUES ('caller','target','calls',?,0,NULL,?,'c',?)`);
  return { db, queries: new QueryBuilder(db), seed: (file: string, count: number, status = 'pending') => {
    db.transaction(() => { for (let i = 0; i < count; i++) insert.run(i + 1, file, status); })();
  } };
}
function temporary() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-scoped-refs-')); roots.push(root); return root;
}
const internal = (cg: CodeGraph) => cg as unknown as {
  queries: QueryBuilder; resolver: ReferenceResolver; db: { db: SqliteDatabase };
};

describe('scoped reference keyset reader', () => {
  it('lets the event loop respond before a modest sync finishes reference resolution', async () => {
    const root = temporary();
    fs.writeFileSync(path.join(root, 'calls.c'), 'int target(void) { return 1; }\n' +
      Array.from({ length: 1001 }, (_, i) => `int caller_${i}(void) { return target(); }`).join('\n'));
    const cg = CodeGraph.initSync(root); graphs.push(cg);
    const { queries, db } = internal(cg);
    let scheduled = false;
    let pendingAtHeartbeat: number | undefined;
    await cg.sync({ onProgress: progress => {
      if (progress.phase !== 'resolving' || scheduled) return;
      scheduled = true;
      setImmediate(() => { pendingAtHeartbeat = queries.getUnresolvedReferencesCount(); });
    } });
    expect(pendingAtHeartbeat).toBeGreaterThan(0);
    expect(pendingAtHeartbeat).toBeLessThan(1001);
    expect(queries.getUnresolvedReferencesCount()).toBe(0);
    expect(db.db.prepare("SELECT COUNT(*) n FROM edges WHERE kind='calls'").get().n).toBe(1001);
  });

  it('supports sql.js fallback with bounded prepared-statement reuse across many pages', async () => {
    // This bundled Emscripten loader otherwise passes a Windows filesystem
    // path to Node's fetch. Use its local fs loader for this offline test.
    vi.stubGlobal('fetch',undefined);
    await ensureSqlJsReady(); vi.unstubAllGlobals();
    vi.stubEnv('CODEGRAPH_FORCE_WASM','1');
    const {db,queries,seed} = fixture(path.join(temporary(),'wasm.db'));
    seed('a.c',37); seed('中文.c',20); seed('z.c',2,'failed');
    const prepare = vi.spyOn(db,'prepare');
    const plan = queries.planPendingReferencesByFiles(['a.c','中文.c','z.c']);
    const ids = new Set<number>();
    let cursor: PendingReferenceCursor | undefined;
    while (ids.size < plan.total) {
      const batch = queries.getPendingReferenceFileBatch(plan.chunks[0]!,cursor,3);
      expect(batch.length).toBeGreaterThan(0);
      for (const row of batch) ids.add(row.rowId!);
      const last = batch[batch.length-1]!;
      cursor = {filePath:last.filePath!,rowId:last.rowId!};
    }
    expect(ids.size).toBe(57);
    expect(prepare).toHaveBeenCalledTimes(5);
  });

  it('bounds a 150,001-reference SINGLE file, deleting/parking each page without skips', () => {
    expect(SCOPED_REFERENCE_BATCH_SIZE).toBe(10_000);
    const { db, queries, seed } = fixture(); seed('huge.c', 150_001); seed('unrelated.c', 3);
    const plan = queries.planPendingReferencesByFiles(['huge.c', 'huge.c', 'empty.c']);
    expect(plan.total).toBe(150_001);
    let after: PendingReferenceCursor | undefined;
    let count = 0;
    const seen = new Set<number>();
    const remove = db.prepare('DELETE FROM unresolved_refs WHERE id=?');
    const park = db.prepare("UPDATE unresolved_refs SET status='failed' WHERE id=?");
    while (count < plan.total) {
      const batch = queries.getPendingReferenceFileBatch(plan.chunks[0]!, after);
      if (count === 0) expect(batch).toHaveLength(10_000);
      expect(batch.length).toBeGreaterThan(0);
      expect(batch.length).toBeLessThanOrEqual(SCOPED_REFERENCE_BATCH_SIZE);
      db.transaction(() => {
        for (const row of batch) {
          expect(seen.has(row.rowId!)).toBe(false); seen.add(row.rowId!);
          (row.rowId! % 2 ? remove : park).run(row.rowId);
        }
      })();
      count += batch.length;
      const last = batch[batch.length - 1]!;
      after = { filePath: last.filePath!, rowId: last.rowId! };
    }
    expect(count).toBe(150_001);
    expect(queries.getUnresolvedReferencesCount()).toBe(3);
    expect(db.prepare("SELECT COUNT(*) n FROM unresolved_refs WHERE status='failed'").get().n).toBe(75_000);
  }, 30_000);

  it('keeps the legacy materializing API usable beyond the argument limit', () => {
    const { queries, seed } = fixture(); seed('huge.c', 150_001);
    expect(queries.getUnresolvedReferencesByFiles(['huge.c'])).toHaveLength(150_001);
  }, 30_000);

  it('handles >500 files, duplicate input paths and empty/non-pending files', () => {
    const { queries, seed } = fixture();
    const files = Array.from({length: 1103}, (_, i) => `f${i}.c`);
    for (const file of files) seed(file, 2);
    seed('failed.c', 8, 'failed');
    const plan = queries.planPendingReferencesByFiles([...files, 'failed.c', '', ...files]);
    expect(plan.chunks).toHaveLength(3); expect(plan.total).toBe(2206);
    const ids = new Set<number>();
    for (const chunk of plan.chunks) {
      let cursor: PendingReferenceCursor | undefined;
      let count = 0;
      while (count < chunk.total) {
        const batch = queries.getPendingReferenceFileBatch(chunk, cursor, 73);
        expect(batch.length).toBeGreaterThan(0);
        for (const ref of batch) { expect(ids.has(ref.rowId!)).toBe(false); ids.add(ref.rowId!); }
        count += batch.length;
        const last = batch[batch.length - 1]!;
        cursor = {filePath:last.filePath!, rowId:last.rowId!};
      }
      expect(count).toBe(chunk.total);
    }
    expect(ids.size).toBe(plan.total);
  });

  it('uses SQLite binary path ordering for quoted/Unicode names, with a fixed high-water mark', () => {
    const { db, queries, seed } = fixture();
    const files = ['😀.c', '\uE000.c', "a'b.c", '中文.c', 'z.c', 'a.c'];
    for (const file of files) { seed(file, 3); seed(file, 2, 'failed'); }
    const expected = db.prepare("SELECT id FROM unresolved_refs WHERE status='pending' ORDER BY file_path,id").all().map(r => r.id);
    const plan = queries.planPendingReferencesByFiles(files);
    seed('a.c', 2); seed('😀.c', 2);
    const ids: number[] = [];
    let cursor: PendingReferenceCursor | undefined;
    while (ids.length < plan.total) {
      const batch = queries.getPendingReferenceFileBatch(plan.chunks[0]!, cursor, 4);
      for (const ref of batch) ids.push(ref.rowId!);
      const last = batch[batch.length - 1]!;
      cursor = {filePath:last.filePath!, rowId:last.rowId!};
    }
    expect(ids).toEqual(expected);
    expect(queries.getPendingReferenceFileBatch(plan.chunks[0]!, cursor, 4)).toEqual([]);
  });

  it('seeks through the existing file index without a temporary sort', () => {
    const { db } = fixture();
    for (const [sql, args] of [
      ["SELECT * FROM unresolved_refs INDEXED BY idx_unresolved_file_path WHERE file_path=? AND id>? AND id<=? AND status='pending' ORDER BY id LIMIT ?", ['a.c', 50, 100, 5]],
      ["SELECT * FROM unresolved_refs INDEXED BY idx_unresolved_file_path WHERE file_path IN (?,?) AND file_path>? AND id<=? AND status='pending' ORDER BY file_path,id LIMIT ?", ['a.c', 'b.c', 'a.c', 100, 5]],
    ] as Array<[string, (string | number)[]]>) {
      const details = db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...args).map(r => r.detail).join('\n');
      expect(details).toContain('idx_unresolved_file_path');
      expect(details).not.toContain('TEMP B-TREE');
      if (sql.includes('id>?')) expect(details).toContain('rowid>?');
    }
  });

  it('rejects unbounded batch sizes before issuing a query', () => {
    const { queries } = fixture();
    for (const limit of [0, -1, Infinity, NaN, 1.5, SCOPED_REFERENCE_BATCH_SIZE + 1]) {
      expect(() => queries.getPendingReferenceFileBatch({filePaths:['a.c'],total:1,maxRowId:1}, undefined, limit)).toThrow('batch size');
    }
    expect(queries.planPendingReferencesByFiles([])).toEqual({chunks:[],total:0});
  });

  it('does not recount historical failed rows when a recovered scope has no pending refs', () => {
    const {db,queries,seed} = fixture(); seed('failed.c',1000,'failed');
    const prepare = vi.spyOn(db,'prepare');
    expect(queries.planPendingReferencesByFiles(['failed.c'])).toEqual({chunks:[],total:0});
    expect(prepare.mock.calls.map(([sql])=>sql)).toEqual([
      "SELECT 1 FROM unresolved_refs WHERE status='pending' LIMIT 1",
    ]);
  });
});

describe('scoped sync resolution and recovery', () => {
  it('prefetches bounded pages, yields after 250 writes, and recovers the unused part of a page', async () => {
    const root = temporary();
    fs.writeFileSync(path.join(root, 'a.c'), 'int caller(void) { return 0; }\nint target(void) { return 1; }\n');
    const cg = CodeGraph.initSync(root); graphs.push(cg); await cg.indexAll();
    const {queries, resolver, db} = internal(cg);
    const caller = cg.getNodesByName('caller')[0]!;
    queries.insertUnresolvedRefsBatch(Array.from({length: 2101}, (_, i) => ({
      fromNodeId: caller.id, referenceName: 'target', referenceKind: 'calls',
      filePath: 'a.c', language: 'c', line: i + 10, column: 0,
    })));
    const reads = vi.spyOn(queries, 'getPendingReferenceFileBatch');
    const persist = resolver.resolveAndPersist.bind(resolver);
    const batches: number[] = [];
    let heartbeatPending: number | undefined;
    const fault = vi.spyOn(resolver, 'resolveAndPersist').mockImplementation((...args) => {
      batches.push(args[0].length);
      if (batches.length === 3) throw new Error('prefetch interruption');
      const result = persist(...args);
      if (batches.length === 1) setImmediate(() => { heartbeatPending = queries.getUnresolvedReferencesCount(); });
      return result;
    });
    const detail = new ResolutionDiagnostics();
    await expect(resolver.resolveFilesAndPersist(['a.c'], undefined, {batchSize:250, diagnostics:detail}))
      .rejects.toThrow('prefetch interruption');
    expect(batches).toEqual([250, 250, 250]);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(reads.mock.calls[0]![2]).toBe(2000);
    expect(detail).toMatchObject({readPages:1, maxReadRefs:2000, maxBatchRefs:250});
    expect(heartbeatPending).toBe(1851);
    expect(queries.getUnresolvedReferencesCount()).toBe(1601);
    fault.mockRestore();
    expect(await resolver.resolveFilesAndPersist(['a.c'], undefined, {batchSize:250})).toBe(1601);
    expect(queries.getUnresolvedReferencesCount()).toBe(0);
    expect(db.db.prepare("SELECT COUNT(*) n FROM edges WHERE kind='calls'").get().n).toBe(2101);
  });

  it('completes the original 501-file / 150,000-call sync failure shape', async () => {
    vi.stubEnv('CODEGRAPH_PARSE_WORKERS','2');
    const root = temporary();
    fs.writeFileSync(path.join(root,'target.c'),'int target(void) { return 1; }\n');
    for (let i=0;i<500;i++) fs.writeFileSync(path.join(root,`unit${i}.c`),
      `int caller_${i}(void) {\n${'target();\n'.repeat(300)}return 0;\n}\n`);
    const cg = CodeGraph.initSync(root); graphs.push(cg);
    const {queries,db} = internal(cg);
    vi.spyOn(queries,'getUnresolvedReferencesByFiles').mockImplementation(()=>{throw new Error('unbounded reader used');});
    const result = await cg.sync();
    expect(result).toMatchObject({filesAdded:501,complete:true});
    expect(queries.getUnresolvedReferencesCount()).toBe(0);
    expect(queries.getMetadataByPrefix('sync-retry:pending:')).toHaveLength(0);
    expect(db.db.prepare("SELECT COUNT(*) n FROM edges WHERE kind='calls'").get().n).toBe(150_000);
    expect(db.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  },60_000);

  it.each([
    { name:'C++ inheritance and overloads', files:{
      'a.cpp':'#include "z.h"\nint use(Derived &value) { return value.ping(1); }\n',
      'z.h':'struct Base { int ping(int x) { return x; } int ping() { return 2; } };\nstruct Derived : Base {};\n',
    } },
    { name:'TypeScript imports and inheritance', files:{
      'a.ts':'import { Child, helper } from "./z";\nexport function use() { const c = new Child(); return c.ping() + helper(); }\n',
      'z.ts':'export class Parent { ping() { return 1; } }\nexport class Child extends Parent {}\nexport function helper() { return 2; }\n',
    } },
  ])('preserves complete sync graph at one-row boundaries: $name', async ({files}) => {
    const run = async (legacy: boolean) => {
      const root = temporary();
      for (const [file, source] of Object.entries(files)) fs.writeFileSync(path.join(root,file),source);
      const cg = CodeGraph.initSync(root); graphs.push(cg);
      const {queries,resolver,db} = internal(cg);
      const paged = resolver.resolveFilesAndPersist.bind(resolver);
      vi.spyOn(resolver,'resolveFilesAndPersist').mockImplementation(async (paths, progress, options) => {
        if (legacy) return resolver.resolveAndPersist(queries.getUnresolvedReferencesByFiles([...paths]), progress).stats.total;
        return paged(paths,progress,{...options,batchSize:1});
      });
      await cg.sync();
      expect(queries.getUnresolvedReferencesCount()).toBe(0);
      return {
        edges:db.db.prepare('SELECT source,target,kind,line,col,metadata FROM edges ORDER BY source,target,kind,line,col,metadata').all(),
        failed:db.db.prepare('SELECT from_node_id,reference_name,reference_kind,line,col,status,name_tail FROM unresolved_refs ORDER BY from_node_id,reference_name,reference_kind,line,col').all(),
      };
    };
    expect(await run(false)).toEqual(await run(true));
  }, 30_000);

  it('does not silently advance past a no-op cleanup, even when every match fails', async () => {
    const root = temporary();
    fs.writeFileSync(path.join(root,'a.c'),'int caller(void) { return 0; }\n');
    const cg = CodeGraph.initSync(root); graphs.push(cg); await cg.indexAll();
    const {queries,resolver} = internal(cg);
    const caller = cg.getNodesByName('caller')[0]!;
    queries.insertUnresolvedRefsBatch(Array.from({length:11}, (_,i)=>({
      fromNodeId:caller.id,referenceName:'missing',referenceKind:'calls',filePath:'a.c',language:'c',line:i+1,column:0,
    })));
    const noop = vi.spyOn(queries,'markReferencesFailedByRowIds').mockReturnValue(0);
    const detail = new ResolutionDiagnostics();
    await expect(resolver.resolveFilesAndPersist(['a.c'],undefined,{batchSize:3,diagnostics:detail}))
      .rejects.toThrow('cleanup incomplete');
    expect(detail.failedPhase).toBe('failedCleanupMs');
    expect(queries.getUnresolvedReferencesCount()).toBe(11);
    noop.mockRestore();
    expect(await resolver.resolveFilesAndPersist(['a.c'],undefined,{batchSize:3})).toBe(11);
    expect(queries.getUnresolvedReferencesCount()).toBe(0);
  });

  it('matches legacy graph/failed rows across page boundaries and reuses global caches', async () => {
    const run = async (size?: number) => {
      const root = temporary();
      fs.writeFileSync(path.join(root,'a.c'), 'int caller(void) { return target(); }\nint target(void) { return 1; }\n');
      const cg = CodeGraph.initSync(root); graphs.push(cg); await cg.indexAll();
      const {queries,resolver,db} = internal(cg);
      const caller = cg.getNodesByName('caller')[0]!;
      queries.insertUnresolvedRefsBatch(Array.from({length:113}, (_, i) => ({
        fromNodeId:caller.id, referenceName:i % 3 ? 'target' : 'missing', referenceKind:'calls',
        filePath:'a.c', language:'c', line:i+5, column:0,
      })));
      resolver.clearCaches();
      const files = vi.spyOn(queries,'getAllFilePaths');
      const names = vi.spyOn(queries,'getAllNodeNames');
      const detail = new ResolutionDiagnostics();
      const progress: number[] = [];
      if (size) {
        expect(await resolver.resolveFilesAndPersist(['a.c'], (n,total) => {
          expect(total).toBe(113); progress.push(n);
        }, {batchSize:size, diagnostics:detail})).toBe(113);
        expect(detail).toMatchObject({refs:113,plannedRefs:113,batches:Math.ceil(113/size),maxBatchRefs:size,cache:'cold'});
        expect(progress[progress.length-1]).toBe(113);
        expect(progress.every((n,i)=>i===0 || n>progress[i-1]!)).toBe(true);
      } else resolver.resolveAndPersist(queries.getUnresolvedReferencesByFiles(['a.c']));
      expect(files).toHaveBeenCalledTimes(1); expect(names).toHaveBeenCalledTimes(1);
      expect(queries.getUnresolvedReferencesCount()).toBe(0);
      return {
        edges:db.db.prepare('SELECT source,target,kind,line,col,metadata FROM edges ORDER BY source,target,kind,line,col').all(),
        failed:db.db.prepare('SELECT reference_name,line,col,status,name_tail FROM unresolved_refs ORDER BY line,col').all(),
      };
    };
    expect(await run(7)).toEqual(await run());
  }, 30_000);

  it('resumes an interrupted real sync from its journal without reparsing stored files', async () => {
    vi.stubEnv('CODEGRAPH_PARSE_WORKERS','2');
    const root = temporary();
    const calls = 3 * SCOPED_REFERENCE_BATCH_SIZE + 23;
    fs.writeFileSync(path.join(root,'a.c'), 'int target(void) { return 1; }\nint caller(void) {\n' +
      'target();\n'.repeat(calls) + 'return 0;\n}\n');
    let cg = CodeGraph.initSync(root); graphs.push(cg);
    const first = internal(cg);
    vi.spyOn(first.queries,'getUnresolvedReferencesByFiles').mockImplementation(() => { throw new Error('unbounded reader used'); });
    const read = first.queries.getPendingReferenceFileBatch.bind(first.queries);
    let pages = 0;
    vi.spyOn(first.queries,'getPendingReferenceFileBatch').mockImplementation((...args) => {
      if (++pages === 2) throw new Error('interrupted-after-first-page');
      return read(...args);
    });
    const logs: string[] = [];
    vi.spyOn(console,'log').mockImplementation((...args)=>logs.push(args.join(' ')));
    await expect(cg.sync({verbose:true})).rejects.toThrow('interrupted-after-first-page');
    expect(logs.find(line=>line.includes('refs-detail scope=changed'))).toContain('failedPhase=loadRefsMs');
    expect(first.queries.getUnresolvedReferencesCount()).toBeGreaterThan(2 * SCOPED_REFERENCE_BATCH_SIZE);
    expect(first.queries.getMetadataByPrefix('sync-retry:pending:')).toHaveLength(1);
    const indexedAt = cg.getFile('a.c')!.indexedAt;
    cg.close();
    cg = await CodeGraph.open(root); graphs.push(cg);
    const second = internal(cg);
    const source = fs.readFileSync(path.join(root,'a.c'),'utf8');
    const result = await cg.sync({verbose:true});
    expect(result).toMatchObject({filesAdded:0, filesModified:0});
    expect(cg.getFile('a.c')!.indexedAt).toBe(indexedAt);
    expect(fs.readFileSync(path.join(root,'a.c'),'utf8')).toBe(source);
    expect(second.queries.getUnresolvedReferencesCount()).toBe(0);
    expect(second.queries.getMetadataByPrefix('sync-retry:pending:')).toHaveLength(0);
    expect(second.db.db.prepare("SELECT COUNT(*) n FROM edges WHERE kind='calls'").get().n).toBe(calls);
    expect(second.db.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  }, 60_000);
});
