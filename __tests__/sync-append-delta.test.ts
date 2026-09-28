import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import CodeGraph from '../src/index';
import { APPEND_DELTA_JOURNAL, AppendDeltaState } from '../src/extraction/append-delta';
import { createDatabase, ensureSqlJsReady } from '../src/db/sqlite-adapter';
import { QueryBuilder } from '../src/db/queries';
import { SyncRetryState } from '../src/extraction/sync-retry-state';
import { extractFromSource } from '../src/extraction/tree-sitter';

const graphs: CodeGraph[] = [], dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const cg of graphs.splice(0)) cg.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const base = {
  'a.cpp': 'int helper() { return 1; }\nint first() { return helper(); }\n',
  'b.cpp': 'int second() { return helper(); }\n',
};
async function fixture(files: Record<string, string> = base) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-append-delta-')); dirs.push(dir);
  for (const [name, source] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), source);
  let cg = CodeGraph.initSync(dir); graphs.push(cg); await cg.indexAll();
  const q = (cg as any).queries, db = (cg as any).db.db;
  return { dir, cg, q, db, write: (name: string, source: string) => fs.writeFileSync(path.join(dir, name), source) };
}
function snapshot(cg: CodeGraph) {
  const db = (cg as any).db.db;
  return {
    nodes: db.prepare('SELECT id,kind,name,qualified_name,file_path,language,start_line,end_line,start_column,end_column,docstring,signature,is_declaration,is_static,return_type FROM nodes ORDER BY id').all(),
    edges: db.prepare('SELECT source,target,kind,line,col,metadata,provenance FROM edges ORDER BY source,target,kind,line,col,metadata,provenance').all(),
    refs: db.prepare('SELECT from_node_id,reference_name,reference_kind,line,col,candidates,file_path,language,status,name_tail FROM unresolved_refs ORDER BY from_node_id,reference_name,reference_kind,line,col').all(),
  };
}
async function assertFresh(f: Awaited<ReturnType<typeof fixture>>, files: Record<string, string>) {
  expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  const fresh = await fixture(files);
  expect(snapshot(f.cg)).toEqual(snapshot(fresh.cg));
}
const append = '\nstatic int added() { return helper(); }\n';

describe('append-only extraction delta', () => {
  it('supports atomic delta storage and retention on the WASM database backend', async () => {
    const f = await fixture();
    vi.stubGlobal('fetch', undefined);
    try { await ensureSqlJsReady(); } finally { vi.unstubAllGlobals(); }
    vi.stubEnv('CODEGRAPH_FORCE_WASM', '1');
    const { db } = createDatabase(path.join(f.dir, 'wasm.db'));
    try {
      db.exec(fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8'));
      const q = new QueryBuilder(db), nodes = f.q.getAllNodes();
      q.insertNodes(nodes);
      for (const node of nodes) q.insertEdges(f.q.getOutgoingEdges(node.id));
      for (const file of f.q.getAllFiles()) q.upsertFile(file);
      const first = f.cg.getNodesByName('first')[0]!;
      const before = db.prepare("SELECT * FROM edges WHERE source=? AND kind='calls'").all(first.id);
      const retry = new SyncRetryState(q), delta = new AppendDeltaState(q, retry), source = base['a.cpp'] + append;
      expect(delta.tryStore('a.cpp', source, 'cpp', {size:Buffer.byteLength(source), mtimeMs:2},
        extractFromSource('a.cpp', source, 'cpp'))).toBe(true);
      await delta.finish(true); retry.complete();
      expect(db.prepare("SELECT * FROM edges WHERE source=? AND kind='calls'").all(first.id)).toEqual(before);
      expect(q.getNodesByName('added')).toHaveLength(1);
      expect(q.getMetadataByPrefix(APPEND_DELTA_JOURNAL)).toEqual([]);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { db.close(); }
  });

  it('rebuilds legacy edges without original reference stamps', async () => {
    const f = await fixture();
    f.db.exec("UPDATE edges SET metadata=NULL WHERE kind='calls'");
    f.write('a.cpp', base['a.cpp'] + append);
    f.write('b.cpp', base['b.cpp'] + '\nint another() { return 0; }\n');
    await f.cg.sync();
    await assertFresh(f, { 'a.cpp': base['a.cpp'] + append, 'b.cpp': base['b.cpp'] + '\nint another() { return 0; }\n' });
  });

  it('does not retain names that can be rebound through include configuration', async () => {
    const files = { ...base, 'a.cpp': '#include "helper.h"\n' + base['a.cpp'] };
    const f = await fixture(files), first = f.cg.getNodesByName('first')[0]!;
    const old = f.db.prepare("SELECT id FROM edges WHERE source=? AND kind='calls'").get(first.id).id;
    files['a.cpp'] += append; f.write('a.cpp', files['a.cpp']);
    await f.cg.sync();
    expect(f.db.prepare("SELECT id FROM edges WHERE source=? AND kind='calls'").get(first.id).id).not.toBe(old);
    await assertFresh(f, files);
  });

  it('rechecks candidate facts when another pure append exposes a recovery difference', async () => {
    const sources = { 'a.cpp': 'int first() { return helper(); }\n', 'b.cpp': 'int helper() { return 1; }\n' };
    const f = await fixture(sources), retry = new SyncRetryState(f.q), delta = new AppendDeltaState(f.q, retry);
    const first = f.cg.getNodesByName('first')[0]!;
    const a = sources['a.cpp'] + '\nint added_a() { return 2; }\n';
    expect(delta.tryStore('a.cpp', a, 'cpp', {size:Buffer.byteLength(a),mtimeMs:2}, extractFromSource('a.cpp', a, 'cpp'))).toBe(true);
    const b = sources['b.cpp'] + '\nint added_b() { return 2; }\n';
    const result = extractFromSource('b.cpp', b, 'cpp');
    result.nodes.find(n => n.name === 'helper')!.returnType = 'long';
    expect(delta.tryStore('b.cpp', b, 'cpp', {size:Buffer.byteLength(b),mtimeMs:2}, result)).toBe(false);
    (f.cg as any).orchestrator.storeParsedReplacement({ filePath:'b.cpp',content:b,language:'cpp',
      stats:{size:Buffer.byteLength(b),mtimeMs:2},result });
    expect(f.db.prepare("SELECT count(*) n FROM edges WHERE source=? AND kind='calls'").get(first.id).n).toBe(1);
    await delta.finish(true);
    expect(f.db.prepare("SELECT count(*) n FROM unresolved_refs WHERE from_node_id=? AND reference_name='helper' AND status='pending'").get(first.id).n).toBe(1);
    expect(delta.counts.requeuedRefs).toBeGreaterThan(0);
  });

  it('does not reuse an exact match when its candidate group includes class members', async () => {
    const files = { ...base, 'b.cpp': 'struct Other { int helper() { return 3; } };\n' + base['b.cpp'] };
    const f = await fixture(files), first = f.cg.getNodesByName('first')[0]!;
    const old = f.db.prepare("SELECT id FROM edges WHERE source=? AND kind='calls'").get(first.id).id;
    files['a.cpp'] += append; f.write('a.cpp', files['a.cpp']);
    await f.cg.sync();
    expect(f.db.prepare("SELECT id FROM edges WHERE source=? AND kind='calls'").get(first.id).id).not.toBe(old);
    await assertFresh(f, files);
  });

  it('admits a file without a final newline when the append supplies a new line', async () => {
    const files = { ...base, 'a.cpp': base['a.cpp'].trimEnd() };
    const f = await fixture(files), store = vi.spyOn(f.q, 'storeAppendDelta');
    files['a.cpp'] += append; f.write('a.cpp', files['a.cpp']);
    await f.cg.sync();
    expect(store).toHaveBeenCalledTimes(1);
    await assertFresh(f, files);
  });

  it('invalidates unchanged caller files when an appended overload changes their candidates', async () => {
    const f = await fixture(), files = { ...base, 'a.cpp': base['a.cpp'] + '\nint helper(int x) { return x; }\n' };
    f.write('a.cpp', files['a.cpp']);
    const result = await f.cg.sync();
    expect(result.filesModified).toBe(1);
    await assertFresh(f, files);
    expect(f.q.getMetadataByPrefix(APPEND_DELTA_JOURNAL)).toEqual([]);
  });

  it('keeps raw directive-looking strings on the conservative path', async () => {
    const f = await fixture(), store = vi.spyOn(f.q, 'storeAppendDelta');
    f.write('a.cpp', base['a.cpp'] + '\nconst char *added() { return "#define POISON 1"; }\n');
    await f.cg.sync();
    expect(store).not.toHaveBeenCalled();
  });

  it('requeues more than one page without losing repeated call sites', async () => {
    const files = { 'a.cpp': 'int helper() { return 1; }\nint first() {\n' + 'helper();\n'.repeat(1100) + 'return 0; }\n', 'b.cpp': base['b.cpp'] };
    const f = await fixture(files);
    files['a.cpp'] += '\nint helper(int x) { return x; }\n'; f.write('a.cpp', files['a.cpp']);
    await f.cg.sync();
    await assertFresh(f, files);
  });

  it('preserves old node/edge rows and resolves only new calls, including non-ASCII prefixes', async () => {
    const files = { ...base, 'a.cpp': '// 原始源码\n' + base['a.cpp'] };
    const f = await fixture(files), store = vi.spyOn(f.q, 'storeAppendDelta');
    const first = f.cg.getNodesByName('first')[0]!;
    const old = f.db.prepare("SELECT * FROM edges WHERE source=? AND kind='calls'").all(first.id);
    const nodes = f.db.prepare("SELECT * FROM nodes WHERE file_path='a.cpp' AND kind!='file' ORDER BY id").all();
    files['a.cpp'] += append; f.write('a.cpp', files['a.cpp']);
    const resolve = vi.spyOn((f.cg as any).resolver, 'resolveAndPersist');
    const result = await f.cg.sync();
    expect(result.complete).toBe(true); expect(store).toHaveBeenCalledTimes(1);
    expect(f.db.prepare("SELECT * FROM edges WHERE source=? AND kind='calls'").all(first.id)).toEqual(old);
    const after = f.db.prepare("SELECT * FROM nodes WHERE file_path='a.cpp' AND kind!='file' AND name!='added' ORDER BY id").all();
    expect(after).toEqual(nodes);
    expect(resolve.mock.calls.flatMap(call => call[0]).some(ref => ref.fromNodeId === first.id)).toBe(false);
    expect(f.q.getMetadataByPrefix(APPEND_DELTA_JOURNAL)).toEqual([]);
    await assertFresh(f, files);
    expect((await f.cg.sync()).filesModified).toBe(0);
  });

  it('invalidates retained matches when a later appended function adds a same-name candidate', async () => {
    const f = await fixture(), files = { ...base };
    const store = vi.spyOn(f.q, 'storeAppendDelta');
    files['a.cpp'] += append;
    files['b.cpp'] += '\nint helper(int value) { return value; }\n';
    for (const [file, source] of Object.entries(files)) f.write(file, source);
    const requeue = vi.spyOn(f.q, 'requeueAppendDeltaEdges');
    await f.cg.sync();
    expect(store).toHaveBeenCalledTimes(2);
    expect(requeue.mock.calls.some(call => call[1]?.includes('helper'))).toBe(true);
    await assertFresh(f, files);
  });

  it.each([
    ['macro', '#define CHANGED 2\nint second() { return helper(); }\n'],
    ['include', '#include "missing.h"\nint second() { return helper(); }\n'],
    ['namespace', 'namespace changed { int second() { return helper(); } }\n'],
    ['body', 'int second() { return 234; }\n'],
  ])('replays retained references if another file has a %s edit', async (_name, source) => {
    const f = await fixture(), files = { ...base, 'a.cpp': base['a.cpp'] + append, 'b.cpp': source };
    const store = vi.spyOn(f.q, 'storeAppendDelta');
    const requeue = vi.spyOn(f.q, 'requeueAppendDeltaEdges');
    for (const [file, text] of Object.entries(files)) f.write(file, text);
    await f.cg.sync();
    expect(store).toHaveBeenCalledTimes(1);
    expect(requeue.mock.calls.some(call => call[0] === 'a.cpp' && call[1] === undefined)).toBe(true);
    await assertFresh(f, files);
  });

  it.each(['scoped', 'disabled', 'old-version', 'incomplete'] as const)('retains the old path for %s admission', async mode => {
    const f = await fixture(), store = vi.spyOn(f.q, 'storeAppendDelta');
    if (mode === 'disabled') vi.stubEnv('CODEGRAPH_NO_APPEND_DELTA', '1');
    if (mode === 'old-version') f.q.setMetadata('indexed_with_extraction_version', '24');
    if (mode === 'incomplete') f.q.upsertFile({ ...f.q.getFileByPath('a.cpp'), errors: [{ severity:'warning', message:'unknown' }] });
    f.write('a.cpp', base['a.cpp'] + append);
    await f.cg.sync(mode === 'scoped' ? { paths: ['a.cpp'] } : undefined);
    expect(store).not.toHaveBeenCalled();
    await assertFresh(f, { ...base, 'a.cpp': base['a.cpp'] + append });
  });

  it('rolls back all file writes after a delta insertion failure', async () => {
    const f = await fixture(), before = snapshot(f.cg), file = f.cg.getFile('a.cpp');
    f.db.exec("CREATE TRIGGER fail_append BEFORE INSERT ON nodes WHEN NEW.name='added' BEGIN SELECT RAISE(ABORT,'append failed'); END");
    f.write('a.cpp', base['a.cpp'] + append);
    await expect(f.cg.sync()).rejects.toThrow('append failed');
    expect(snapshot(f.cg)).toEqual(before);
    expect(f.cg.getFile('a.cpp')).toEqual(file);
    expect(f.q.getMetadataByPrefix(APPEND_DELTA_JOURNAL)).toEqual([]);
    f.db.exec('DROP TRIGGER fail_append');
    await f.cg.sync();
    await assertFresh(f, { ...base, 'a.cpp': base['a.cpp'] + append });
  });

  it.each(['after-store', 'before-ack'] as const)('recovers %s interruption with a newly changed dependency', async stage => {
    const f = await fixture();
    f.write('a.cpp', base['a.cpp'] + append);
    let fault;
    if (stage === 'after-store') fault = vi.spyOn(f.q, 'requeueAppendDeltaEdges').mockRejectedValueOnce(new Error('interrupted'));
    else {
      const apply = f.q.applyMetadataChanges.bind(f.q);
      fault = vi.spyOn(f.q, 'applyMetadataChanges').mockImplementation((changes: any) => {
        if (changes['sync-retry:pending:a.cpp'] === null) throw new Error('interrupted');
        return apply(changes);
      });
    }
    await expect(f.cg.sync()).rejects.toThrow('interrupted');
    expect(f.q.getMetadataByPrefix(APPEND_DELTA_JOURNAL)).toHaveLength(1);
    fault.mockRestore(); f.cg.close();
    f.cg = CodeGraph.openSync(f.dir); graphs.push(f.cg);
    f.write('b.cpp', base['b.cpp'] + '\nint helper(int value) { return value; }\n');
    await f.cg.sync();
    expect((f.cg as any).queries.getMetadataByPrefix(APPEND_DELTA_JOURNAL)).toEqual([]);
    const fresh = await fixture({ ...base, 'a.cpp': base['a.cpp'] + append,
      'b.cpp': base['b.cpp'] + '\nint helper(int value) { return value; }\n' });
    expect(snapshot(f.cg)).toEqual(snapshot(fresh.cg));
  });
});
