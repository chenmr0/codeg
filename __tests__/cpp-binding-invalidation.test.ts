import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { QueryBuilder } from '../src/db/queries';
import { createDatabase, type SqliteDatabase } from '../src/db/sqlite-adapter';
import type { Node } from '../src/types';
import { acknowledgeCppBindingRefresh, cppBindingEvidenceDigest, establishCppBindingBaseline,
  invalidateCppBindingChanges } from '../src/resolution/cpp-binding-invalidation';

const roots: string[] = [], databases: SqliteDatabase[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-binding-invalidation-')); roots.push(root);
  const { db } = createDatabase(':memory:'); databases.push(db);
  db.exec(fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8'));
  const queries = new QueryBuilder(db);
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text);
    queries.upsertFile({ path: file, contentHash: hash(text), language: 'cpp', size: text.length, modifiedAt: 1, indexedAt: 1, nodeCount: 1 });
  };
  Object.entries(files).forEach(([file, text]) => write(file, text));
  const node = (filePath: string, name: string, kind: Node['kind'] = 'function'): Node => {
    const value: Node = { id: filePath + ':' + name, name, qualifiedName: name, kind, filePath, language: 'cpp',
      startLine: 1, endLine: 1, startColumn: 0, endColumn: 1, updatedAt: 1 };
    queries.insertNode(value); return value;
  };
  return { root, db, queries, write, node };
}

describe('C++ binding evidence fingerprints', () => {
  it('ignores pure executable edits and preserves declaration, literal and directive evidence', () => {
    expect(cppBindingEvidenceDigest('int run(int x) { return x; }')).toBe(cppBindingEvidenceDigest('int run(int x) {\n int y = x + 2; return y;\n}'));
    for (const [a, b] of [
      ['#include "a b.h"', '#include "ab.h"'], ['extern "C" int f();', 'extern "C++" int f();'],
      ['int f(int x=1);', 'int f(int x=2);'], ['struct D : A {};', 'struct D : B {};'],
      ['struct D { using A::f; };', 'struct D {};'],
      ['int f(){\n#define MODE 1\nreturn 1;}', 'int f(){\n#define MODE 2\nreturn 1;}'],
      ['#define CALL(x) x', '#define CALL (x) x'],
    ]) expect(cppBindingEvidenceDigest(a!)).not.toBe(cppBindingEvidenceDigest(b!));
  });
  it('uses complete source when scope is damaged', () => {
    expect(cppBindingEvidenceDigest('int f() { return 1;')).not.toBe(cppBindingEvidenceDigest('int f() { return 2;'));
    expect(cppBindingEvidenceDigest('int f() { return 1; }}')).not.toBe(cppBindingEvidenceDigest('int f() { return 2; }}'));
    expect(cppBindingEvidenceDigest('DECLARE_TYPE(Box) { int step(); };')).not.toBe(cppBindingEvidenceDigest('DECLARE_TYPE(Box) { int step(int); };'));
  });
  it('retains macro-generated type members after a preceding preprocessor definition', () => {
    const before = '#define MAKE_CLASS(T) struct T\nMAKE_CLASS(Rotor) { void step(); };';
    const after = '#define MAKE_CLASS(T) struct T\nMAKE_CLASS(Rotor) { void step(int); };';
    expect(cppBindingEvidenceDigest(before)).not.toBe(cppBindingEvidenceDigest(after));
  });
});

describe('targeted C++ binding replay', () => {
  it('requeues stamped receiver, qualified and reference strategies through reverse includes', async () => {
    const f = fixture({ 'owners.h': 'struct A {}; struct B {};', 'bridge.h': '#include "owners.h"\nstruct R : A {};',
      'main.cpp': '#include "bridge.h"\nint caller(){ return 1; }', 'unrelated.cpp': 'int elsewhere(){return 3;}' });
    const target = f.node('owners.h', 'step'), caller = f.node('main.cpp', 'caller'), other = f.node('unrelated.cpp', 'elsewhere');
    for (const [kind, refName, resolvedBy] of [['calls', 'r.step', 'instance-method'], ['references', 'ns::Value', 'qualified-name']] as const)
      f.queries.insertEdge({ source: caller.id, target: target.id, kind, line: 2, column: 4, metadata: { refName, resolvedBy, confidence: 0.9 } });
    f.queries.insertEdge({ source: other.id, target: other.id, kind: 'calls', line: 1, column: 0, metadata: { refName: 'elsewhere', resolvedBy: 'exact-match' } });
    await establishCppBindingBaseline(f.root, f.queries);
    f.write('bridge.h', '#include "owners.h"\nstruct R : B {};');
    const result = await invalidateCppBindingChanges(f.root, f.queries);
    expect(result.files).toContain('main.cpp'); expect(result.refreshFiles).toEqual([]);
    expect(f.db.prepare('SELECT reference_name FROM unresolved_refs ORDER BY reference_name').all()).toEqual([{ reference_name: 'ns::Value' }, { reference_name: 'r.step' }]);
    expect(f.db.prepare('SELECT source FROM edges').all()).toEqual([{ source: other.id }]);
  });
  it('preserves successful inbound edges for a pure target body edit', async () => {
    const f = fixture({ 'api.cpp': 'int step(){ return 1; }', 'main.cpp': 'int caller(){return step();}' });
    const target = f.node('api.cpp', 'step'), caller = f.node('main.cpp', 'caller');
    f.queries.insertEdge({ source: caller.id, target: target.id, kind: 'calls', line: 1, column: 0, metadata: { refName: 'step', resolvedBy: 'exact-match' } });
    await establishCppBindingBaseline(f.root, f.queries);
    f.write('api.cpp', 'int step(){ return 2; }');
    const replay = vi.spyOn(f.queries, 'requeueCppBindingEdges');
    expect(await invalidateCppBindingChanges(f.root, f.queries)).toEqual({ files: [], refreshFiles: [] });
    expect(replay).not.toHaveBeenCalled(); expect(f.db.prepare('SELECT COUNT(*) n FROM edges').get()).toEqual({ n: 1 });
  });
  it('finds old successes through name indexes when a new candidate is added', async () => {
    const f = fixture({ 'old.cpp': 'int step(int x){return x;}', 'main.cpp': 'int caller(){return step(1);}' });
    const target = f.node('old.cpp', 'step'), caller = f.node('main.cpp', 'caller');
    f.queries.insertEdge({ source: caller.id, target: target.id, kind: 'calls', line: 1, column: 0, metadata: { refName: 'api::step', resolvedBy: 'qualified-name' } });
    await establishCppBindingBaseline(f.root, f.queries);
    f.write('new.cpp', 'int step(int x=1){return x;}'); f.node('new.cpp', 'step');
    expect((await invalidateCppBindingChanges(f.root, f.queries)).files).toContain('main.cpp');
    expect(f.db.prepare('SELECT reference_name FROM unresolved_refs').all()).toEqual([{ reference_name: 'api::step' }]);
  });
  it('retains a durable job across interrupted pages and publishes only after replay', async () => {
    const f = fixture({ 'api.h': 'int step(int);', 'main.cpp': '#include "api.h"\nint caller(){return step(1);}' });
    const target = f.node('api.h', 'step'), caller = f.node('main.cpp', 'caller');
    f.queries.insertEdge({ source: caller.id, target: target.id, kind: 'calls', line: 2, column: 0, metadata: { refName: 'step', resolvedBy: 'exact-match' } });
    await establishCppBindingBaseline(f.root, f.queries);
    f.write('api.h', 'int step(int=1);');
    const replay = vi.spyOn(f.queries, 'requeueCppBindingEdges').mockRejectedValueOnce(new Error('interrupted'));
    await expect(invalidateCppBindingChanges(f.root, f.queries)).rejects.toThrow('interrupted'); replay.mockRestore();
    expect(f.queries.getMetadata('resolution:cpp-binding-job-v1')).not.toBeNull();
    expect((await invalidateCppBindingChanges(f.root, f.queries)).files).toContain('main.cpp');
    expect(f.queries.getMetadata('resolution:cpp-binding-job-v1')).toBeNull();
    expect(f.db.prepare('SELECT COUNT(*) n FROM unresolved_refs').get()).toEqual({ n: 1 });
  });
  it('keeps unstampable work durable until its caller is re-extracted', async () => {
    const f = fixture({ 'api.h': 'int step(int);', 'main.cpp': '#include "api.h"\nint caller(){return step(1);}' });
    const target = f.node('api.h', 'step'), caller = f.node('main.cpp', 'caller');
    f.queries.insertEdge({ source: caller.id, target: target.id, kind: 'calls', line: 2, column: 0 });
    await establishCppBindingBaseline(f.root, f.queries); f.write('api.h', 'int step(int=1);');
    expect((await invalidateCppBindingChanges(f.root, f.queries)).refreshFiles).toEqual(['main.cpp']);
    expect((await invalidateCppBindingChanges(f.root, f.queries)).refreshFiles).toEqual(['main.cpp']);
    acknowledgeCppBindingRefresh(f.queries, ['main.cpp']);
    expect((await invalidateCppBindingChanges(f.root, f.queries)).refreshFiles).toEqual([]);
  });
  it('cleans a deleted caller refresh marker only at successful acknowledgment', async () => {
    const f = fixture({});
    const key = 'resolution:cpp-binding-refresh-v1:deleted.cpp';
    f.queries.setMetadata(key, '1');
    expect((await invalidateCppBindingChanges(f.root, f.queries)).refreshFiles).toEqual([]);
    expect(f.queries.getMetadata(key)).toBe('1');
    acknowledgeCppBindingRefresh(f.queries, [], f.root);
    expect(f.queries.getMetadata(key)).toBeNull();
  });
  it('keeps a missing-row caller refresh marker when its source still exists', () => {
    const f = fixture({ 'interrupted.cpp': 'int f(){return 1;}' });
    const key = 'resolution:cpp-binding-refresh-v1:interrupted.cpp';
    f.queries.deleteFile('interrupted.cpp');
    f.queries.setMetadata(key, '1');
    acknowledgeCppBindingRefresh(f.queries, [], f.root);
    expect(f.queries.getMetadata(key)).toBe('1');
    expect(fs.existsSync(path.join(f.root, 'interrupted.cpp'))).toBe(true);
  });
  it.each(['null', '[]', 'false', '0', '"text"'])('preserves non-object metadata %s for source refresh', async metadata => {
    const f = fixture({ 'api.h': 'int step(int);', 'main.cpp': '#include "api.h"\nint caller(){return step(1);}' });
    const target = f.node('api.h', 'step'), caller = f.node('main.cpp', 'caller');
    f.queries.insertEdge({ source: caller.id, target: target.id, kind: 'calls', line: 2, column: 0 });
    f.db.prepare('UPDATE edges SET metadata=?').run(metadata);
    await establishCppBindingBaseline(f.root, f.queries); f.write('api.h', 'int step(int=1);');
    expect((await invalidateCppBindingChanges(f.root, f.queries)).refreshFiles).toEqual(['main.cpp']);
    expect(f.db.prepare('SELECT metadata FROM edges').all()).toEqual([{ metadata }]);
    expect(f.db.prepare('SELECT COUNT(*) n FROM unresolved_refs').get()).toEqual({ n: 0 });
  });
  it('atomically requeues multiple edge pages without duplicating an existing failed site', async () => {
    const f = fixture({ 'api.h': 'int step(int);', 'main.cpp': '#include "api.h"\nint caller(){return step(1);}' });
    const target = f.node('api.h', 'step'), caller = f.node('main.cpp', 'caller');
    for (let line = 1; line <= 1005; line++) f.queries.insertEdge({ source: caller.id, target: target.id,
      kind: 'instantiates', line, column: 0, metadata: { refName: 'step', refKind: 'calls', resolvedBy: 'qualified-name' } });
    f.queries.insertUnresolvedRef({ fromNodeId: caller.id, referenceName: 'step', referenceKind: 'calls', line: 1, column: 0, filePath: 'main.cpp', language: 'cpp' });
    f.db.prepare("UPDATE unresolved_refs SET status='failed', name_tail='step'").run();
    await establishCppBindingBaseline(f.root, f.queries); f.write('api.h', 'int step(int=1);');
    const oldInventory = f.queries.getMetadata('resolution:cpp-binding-inventory-v1');
    const prepare = f.db.prepare.bind(f.db);
    const interrupt = vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
      const statement = prepare(sql);
      if (!sql.includes('FROM edges e INDEXED BY idx_edges_source_kind JOIN nodes t')) return statement;
      return new Proxy(statement, { get(target, property) {
        if (property === 'all') return (...args: unknown[]) => {
          if (args[0] === caller.id && Number(args[2]) > 0) throw new Error('between pages');
          return statement.all(...args);
        };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    });
    await expect(invalidateCppBindingChanges(f.root, f.queries)).rejects.toThrow('between pages');
    interrupt.mockRestore();
    expect(f.db.prepare('SELECT COUNT(*) n FROM edges').get()).toEqual({ n: 5 });
    expect(f.db.prepare('SELECT COUNT(*) n FROM unresolved_refs').get()).toEqual({ n: 1000 });
    expect(f.queries.getMetadata('resolution:cpp-binding-inventory-v1')).toBe(oldInventory);
    expect(f.queries.getMetadata('resolution:cpp-binding-job-v1')).not.toBeNull();
    await invalidateCppBindingChanges(f.root, f.queries);
    expect(f.db.prepare('SELECT COUNT(*) n FROM edges').get()).toEqual({ n: 0 });
    expect(f.db.prepare("SELECT COUNT(*) n FROM unresolved_refs WHERE status='pending' AND reference_kind='calls'").get()).toEqual({ n: 1005 });
  });
  it('uses rowid seeks on the existing file/source-kind indexes without per-page sorting', async () => {
    const f = fixture({ 'main.cpp': 'int a(); int b(); int step();' });
    const a = f.node('main.cpp', 'a'), b = f.node('main.cpp', 'b'), target = f.node('main.cpp', 'step');
    for (const source of [a, b]) for (const kind of ['calls', 'references'] as const)
      f.queries.insertEdge({ source: source.id, target: target.id, kind, line: 1, column: 0, metadata: { refName: 'step', resolvedBy: 'qualified-name' } });
    const statements: string[] = [], prepare = f.db.prepare.bind(f.db);
    const watch = vi.spyOn(f.db, 'prepare').mockImplementation(sql => { statements.push(sql); return prepare(sql); });
    await f.queries.requeueCppBindingEdges('main.cpp'); watch.mockRestore();
    const sourceSql = statements.find(sql => sql.includes('rowid AS node_rowid'))!;
    const edgeSql = statements.find(sql => sql.includes('FROM edges e INDEXED BY idx_edges_source_kind JOIN nodes t'))!;
    const sourcePlan = (prepare('EXPLAIN QUERY PLAN ' + sourceSql).all('main.cpp', 0) as Array<{ detail: string }>).map(row => row.detail).join('\n');
    const edgePlan = (prepare('EXPLAIN QUERY PLAN ' + edgeSql).all(a.id, 'calls', 0) as Array<{ detail: string }>).map(row => row.detail).join('\n');
    expect(sourcePlan).toMatch(/idx_nodes_file_path.*file_path=\?.*rowid>\?/);
    expect(edgePlan).toMatch(/idx_edges_source_kind.*source=\?.*kind=\?.*rowid>\?/);
    expect(sourcePlan + edgePlan).not.toMatch(/TEMP B-TREE|SCAN edges/);
    expect(f.db.prepare('SELECT COUNT(*) n FROM unresolved_refs').get()).toEqual({ n: 4 });
  });
  it('retries failed receivers after reverse include changes, and handles deleted evidence files', async () => {
    const f = fixture({ 'api.h': 'struct R {};', 'main.cpp': '#include "api.h"\nint caller(){return 1;}' });
    const caller = f.node('main.cpp', 'caller'); f.node('api.h', 'R', 'struct');
    f.queries.insertUnresolvedRef({ fromNodeId: caller.id, referenceName: 'value.step', referenceKind: 'calls', line: 2, column: 0, filePath: 'main.cpp', language: 'cpp' });
    f.db.prepare("UPDATE unresolved_refs SET status='failed',name_tail='step'").run();
    await establishCppBindingBaseline(f.root, f.queries);
    f.queries.deleteFile('api.h'); fs.unlinkSync(path.join(f.root, 'api.h'));
    expect((await invalidateCppBindingChanges(f.root, f.queries)).files).toContain('main.cpp');
    expect(f.db.prepare('SELECT status FROM unresolved_refs').all()).toEqual([{ status: 'pending' }]);
  });
});
