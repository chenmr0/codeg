import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
import { loadGrammarsForLanguages } from '../src/extraction/grammars';

beforeAll(() => loadGrammarsForLanguages(['c', 'cpp']));

describe('extended sync graph integrity scenarios', () => {
  let directory: string | undefined;
  let cg: CodeGraph | undefined;
  afterEach(() => {
    vi.restoreAllMocks();
    cg?.destroy();
    cg = undefined;
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });
  const db = () => (cg as any).db.db;
  const write = (file: string, source: string) => {
    const target = path.join(directory!, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
  };
  async function setup(files: Record<string, string>) {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-integrity-matrix-'));
    for (const [file, source] of Object.entries(files)) write(file, source);
    cg = CodeGraph.initSync(directory);
    await cg.indexAll();
  }
  const edges = () => db().prepare(`SELECT source,target,kind,line,col,metadata,provenance
    FROM edges ORDER BY source,target,kind,line,col,metadata,provenance`).all();
  const calls = (caller: string) => db().prepare(`SELECT t.name,t.signature,t.file_path,t.qualified_name
    FROM edges e JOIN nodes s ON s.id=e.source JOIN nodes t ON t.id=e.target
    WHERE s.name=? AND e.kind='calls' ORDER BY t.name,t.file_path,t.signature`).all(caller);
  const healthy = () => {
    expect(db().prepare('PRAGMA quick_check').get().quick_check).toBe('ok');
    expect(db().prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db().prepare("SELECT COUNT(*) n FROM unresolved_refs WHERE status='pending'").get().n).toBe(0);
    expect(db().prepare("SELECT COUNT(*) n FROM project_metadata WHERE key GLOB 'sync-retry:pending:*'").get().n).toBe(0);
  };
  function reopen() {
    cg!.close();
    cg = CodeGraph.openSync(directory!);
  }

  it('reorders overloads at reused line IDs without changing the selected signature', async () => {
    await setup({
      'api.cpp': 'int api(int x) { return x; }\nint api(double x) { return 2; }\n',
      'caller.cpp': 'int invoke() { return api(1); }\n',
    });
    const before = calls('invoke');
    expect(before).toHaveLength(1);
    write('api.cpp', 'int api(double x) { return 2; }\nint api(int x) { return x; }\n');
    expect((await cg!.sync({ paths: ['api.cpp'] })).filesModified).toBe(1);
    expect(calls('invoke')).toEqual(before);
    healthy();
  });

  it('preserves both ends of a three-file call chain when every file gains comments', async () => {
    await setup({
      'a.cpp': 'int entry() { return middle(); }\n',
      'b.cpp': 'int middle() { return leaf(); }\n',
      'c.cpp': 'int leaf() { return 1; }\n',
    });
    const before = edges();
    expect(calls('entry')[0].name).toBe('middle');
    expect(calls('middle')[0].name).toBe('leaf');
    for (const file of ['a.cpp', 'b.cpp', 'c.cpp']) fs.appendFileSync(path.join(directory!, file), '/* revision */\n');
    const result = await cg!.sync({ paths: ['c.cpp', 'a.cpp', 'b.cpp'] });
    expect(result.filesModified).toBe(3);
    expect(edges()).toEqual(before);
    healthy();
  });

  it('rebinds an unchanged caller when its provider moves across directories', async () => {
    const provider = 'int moved_api() { return 7; }\n';
    await setup({ 'old/api.cpp': provider, 'caller.cpp': 'int invoke() { return moved_api(); }\n' });
    write('new/api.cpp', provider);
    fs.unlinkSync(path.join(directory!, 'old/api.cpp'));
    const result = await cg!.sync();
    expect(result.filesAdded).toBe(1);
    expect(result.filesRemoved).toBe(1);
    expect(result.filesModified).toBe(0);
    expect(calls('invoke')).toEqual([expect.objectContaining({ name: 'moved_api', file_path: 'new/api.cpp' })]);
    healthy();
  });

  it('retains a deleted target reference across restart and heals it after restoration', async () => {
    const provider = 'int recover_api() { return 7; }\n';
    await setup({ 'api.cpp': provider, 'caller.cpp': 'int invoke() { return recover_api(); }\n' });
    fs.unlinkSync(path.join(directory!, 'api.cpp'));
    await cg!.sync();
    expect(calls('invoke')).toEqual([]);
    expect(db().prepare("SELECT status FROM unresolved_refs WHERE reference_name='recover_api'").get().status).toBe('failed');
    reopen();
    await cg!.sync();
    write('api.cpp', provider);
    await cg!.sync();
    expect(calls('invoke')).toEqual([expect.objectContaining({ name: 'recover_api', file_path: 'api.cpp' })]);
    healthy();
  });

  it.each(['c', 'cpp'])('does not bind a deleted %s header to an import placeholder, and heals it after restart', async (language) => {
    const caller = '#include "api.h"\nint invoke(void) { return declared_api(); }\n';
    await setup({
      'api.h': 'int declared_api(void);\n',
      [`left.${language}`]: caller,
      [`right.${language}`]: caller.replace('invoke', 'invoke_right'),
    });
    const imports = () => db().prepare(`SELECT s.file_path source,t.kind,t.file_path target FROM edges e
      JOIN nodes s ON s.id=e.source JOIN nodes t ON t.id=e.target WHERE e.kind='imports' ORDER BY source`).all();
    const before = imports();
    expect(before).toEqual([
      {source:`left.${language}`,kind:'file',target:'api.h'},
      {source:`right.${language}`,kind:'file',target:'api.h'},
    ]);
    fs.unlinkSync(path.join(directory!, 'api.h'));
    await cg!.sync();
    expect(imports()).toEqual([]);
    expect(db().prepare("SELECT COUNT(*) n FROM unresolved_refs WHERE reference_name='api.h' AND status='failed'").get().n).toBe(2);
    reopen();
    await cg!.sync();
    write('api.h', 'int declared_api(void);\n');
    await cg!.sync();
    expect(imports()).toEqual(before);
    const restored = edges();
    await cg!.sync();
    expect(edges()).toEqual(restored);
    healthy();
  });

  it('renames a unique API and its caller in the same update without stale edges', async () => {
    await setup({ 'api.cpp': 'int api_old() { return 1; }\n', 'caller.cpp': 'int invoke() { return api_old(); }\n' });
    write('api.cpp', 'int api_new() { return 2; }\n');
    write('caller.cpp', 'int invoke() { return api_new(); }\n');
    await cg!.sync();
    expect(cg!.getNodesByName('api_old')).toEqual([]);
    expect(calls('invoke')).toEqual([expect.objectContaining({ name: 'api_new' })]);
    healthy();
  });

  it('repairs a legacy successful include-to-import edge during no-change sync', async () => {
    await setup({'api.h':'int declared_api(void);\n','caller.cpp':'#include "api.h"\nint invoke() { return declared_api(); }\n'});
    const correct = edges();
    const placeholder = cg!.getNodesByName('api.h').find(n => n.kind === 'import')!;
    expect(placeholder).toBeTruthy();
    db().prepare("UPDATE edges SET target=?,metadata=? WHERE kind='imports'").run(placeholder.id,
      JSON.stringify({confidence:0.7,resolvedBy:'exact-match',refName:'api.h'}));
    reopen();
    const result = await cg!.sync();
    expect(result.filesModified).toBe(0);
    expect(edges()).toEqual(correct);
    expect(db().prepare("SELECT value FROM project_metadata WHERE key='repair:cpp-include-targets-v1'").get().value).toBe('done');
    await cg!.sync();
    expect(edges()).toEqual(correct);
    healthy();
  });

  it('migrates legacy extension-only failed include keys without retrying every .h on future additions', async () => {
    await setup({'caller.cpp':'#include "nested/api.h"\n#include "absent.h"\nint invoke() { return 1; }\n'});
    db().prepare("UPDATE unresolved_refs SET name_tail='h' WHERE reference_kind='imports'").run();
    await cg!.sync();
    const keys = db().prepare("SELECT name_tail FROM unresolved_refs WHERE reference_kind='imports' ORDER BY name_tail").all();
    expect(keys).toEqual([{name_tail:'absent.h'},{name_tail:'api.h'}]);
    write('nested/api.h','int declared_api(void);\n');
    await cg!.sync();
    expect(db().prepare("SELECT COUNT(*) n FROM edges e JOIN nodes t ON t.id=e.target WHERE e.kind='imports' AND t.file_path='nested/api.h'").get().n).toBe(1);
    expect(db().prepare("SELECT reference_name,status FROM unresolved_refs WHERE reference_kind='imports'").all()).toEqual([
      {reference_name:'absent.h',status:'failed'},
    ]);
    healthy();
  });

  it('rolls back legacy include repair if its completion stamp cannot be committed', async () => {
    await setup({'api.h':'int declared_api(void);\n','caller.cpp':'#include "api.h"\n'});
    const correct = edges();
    const placeholder = cg!.getNodesByName('api.h').find(n => n.kind === 'import')!;
    db().prepare("UPDATE edges SET target=?,metadata=? WHERE kind='imports'").run(placeholder.id,
      JSON.stringify({confidence:0.7,resolvedBy:'exact-match',refName:'api.h'}));
    const damaged = edges();
    const stamp = vi.spyOn((cg as any).queries, 'setMetadata').mockImplementationOnce(() => {throw new Error('repair-stamp-failure');});
    await expect(cg!.sync()).rejects.toThrow('repair-stamp-failure');
    expect(edges()).toEqual(damaged);
    expect(db().prepare("SELECT value FROM project_metadata WHERE key='repair:cpp-include-targets-v1'").get()).toBeUndefined();
    stamp.mockRestore();
    await cg!.sync();
    expect(edges()).toEqual(correct);
    healthy();
  });

  it('keeps same-leaf namespace owners distinct when one provider moves lines', async () => {
    await setup({
      'api.cpp': 'namespace left { int value() { return 1; } }\nnamespace right { int value() { return 2; } }\n',
      'caller.cpp': 'int invoke_left() { return left::value(); }\nint invoke_right() { return right::value(); }\n',
    });
    expect(calls('invoke_left')[0].qualified_name).toBe('left::value');
    expect(calls('invoke_right')[0].qualified_name).toBe('right::value');
    write('api.cpp', '\nnamespace right { int value() { return 2; } }\nnamespace left { int value() { return 1; } }\n');
    await cg!.sync({ paths: ['api.cpp'] });
    expect(calls('invoke_left')[0].qualified_name).toBe('left::value');
    expect(calls('invoke_right')[0].qualified_name).toBe('right::value');
    healthy();
  });

  it('resolves an inherited C++ method identically before and after a caller-only comment', async () => {
    await setup({
      'a_wrong.h':'class HeapPool { public: void recycle(); };\n',
      'z_base.h':'class Resource { public: void recycle() const; };\n',
      'derived.h':'class Descriptor : public Resource {};\n',
      'caller.cpp':'void invoke(Descriptor* ptr) { ptr->recycle(); }\n',
    });
    const before = calls('invoke');
    const beforeEdges = edges();
    fs.appendFileSync(path.join(directory!, 'caller.cpp'), '/* revision */\n');
    await cg!.sync();
    expect(calls('invoke')).toEqual([expect.objectContaining({qualified_name:'Resource::recycle'})]);
    expect(calls('invoke')).toEqual(before);
    expect(edges()).toEqual(beforeEdges);
    healthy();
  });

  it.each([['Resource* ptr','ptr->recycle()'],['Resource& ptr','ptr.recycle()'],['Resource ptr','ptr.recycle()']])(
    'does not replace a known C++ receiver (%s) method with an unrelated same-name method while its header is absent', async (parameter, call) => {
    const header='class Resource { public: void recycle(); };\n';
    await setup({
      'resource.h':header,
      'other.h':'class HeapPool { public: void recycle(); };\n',
      'caller.cpp':`class Resource;\nvoid invoke(${parameter}) { ${call}; }\n`,
    });
    const before=calls('invoke');
    expect(before).toEqual([expect.objectContaining({qualified_name:'Resource::recycle'})]);
    fs.unlinkSync(path.join(directory!,'resource.h'));
    await cg!.sync();
    expect(calls('invoke')).toEqual([]);
    write('resource.h',header);
    reopen();
    await cg!.sync();
    expect(calls('invoke')).toEqual(before);
    healthy();
  });

  it('does not resolve bare identifiers to unrelated cross-file fields or methods, but keeps real member scope', async () => {
    await setup({
      'unrelated.h':'class Other { public: int g; int r() const; };\n',
      'owner.h':'class Owner { public: int g; int r() const; int read() const; };\n',
      'caller.cpp':'int unknown() { return g + r; }\nint Owner::read() const { return g + r(); }\n',
    });
    const targets = (name:string) => db().prepare(`SELECT e.kind,t.qualified_name FROM edges e
      JOIN nodes s ON s.id=e.source JOIN nodes t ON t.id=e.target WHERE s.name=? AND e.kind IN ('references','calls')`).all(name);
    expect(targets('unknown')).toEqual([]);
    expect(targets('read')).toEqual(expect.arrayContaining([
      expect.objectContaining({qualified_name:'Owner::g'}),expect.objectContaining({qualified_name:'Owner::r'}),
    ]));
    const before=edges();
    fs.unlinkSync(path.join(directory!,'unrelated.h'));await cg!.sync();
    write('unrelated.h','class Other { public: int g; int r() const; };\n');await cg!.sync();
    expect(edges()).toEqual(before);
    healthy();
  });

  it('restores inherited fields even when their retry group sorts before the missing base type', async () => {
    const base='class ZBase { public: int aValue; };\n';
    await setup({'base.h':base,'child.cpp':'class Child : public ZBase { public: int read() { return aValue; } };\n'});
    const before=edges();
    const fieldEdges=()=>db().prepare(`SELECT t.qualified_name FROM edges e JOIN nodes s ON s.id=e.source
      JOIN nodes t ON t.id=e.target WHERE s.name='read' AND e.kind='references'`).all();
    expect(fieldEdges()).toContainEqual({qualified_name:'ZBase::aValue'});
    fs.unlinkSync(path.join(directory!,'base.h'));await cg!.sync();
    expect(fieldEdges()).toEqual([]);
    reopen();write('base.h',base);await cg!.sync();
    expect(fieldEdges()).toContainEqual({qualified_name:'ZBase::aValue'});
    expect(edges()).toEqual(before);
    healthy();
  });

  it('never binds a C++ base class to its same-file constructor, including on caller-only reparse', async () => {
    await setup({
      'base.h':'class Base { public: Base(); int field; };\n',
      'derived.cpp':'Base::Base() {}\nclass Child : public Base { public: int read() { return field; } };\n',
    });
    const bases=()=>db().prepare(`SELECT t.kind,t.qualified_name FROM edges e JOIN nodes s ON s.id=e.source
      JOIN nodes t ON t.id=e.target WHERE s.name='Child' AND e.kind='extends'`).all();
    expect(bases()).toEqual([{kind:'class',qualified_name:'Base'}]);
    const before=edges();
    fs.appendFileSync(path.join(directory!,'derived.cpp'),'/* revision */\n');
    await cg!.sync();
    expect(bases()).toEqual([{kind:'class',qualified_name:'Base'}]);
    expect(edges()).toEqual(before);
    healthy();
  });

  it('keeps an explicit C++ class owner when a same-name static factory exists elsewhere', async () => {
    const target='class Target { public: static int Make(); };\n';
    await setup({'target.h':target,'other.h':'class Other { public: static int Make(); };\n',
      'caller.cpp':'int invoke() { return Target::Make(); }\n'});
    const before=calls('invoke');
    expect(before).toEqual([expect.objectContaining({qualified_name:'Target::Make'})]);
    fs.unlinkSync(path.join(directory!,'target.h'));await cg!.sync();
    expect(calls('invoke')).toEqual([]);
    write('target.h',target);await cg!.sync();
    expect(calls('invoke')).toEqual(before);
    healthy();
  });

  it('does not borrow inheritance from an unrelated C++ class with the same leaf name', async () => {
    await setup({
      'base.h':'class Base { public: int field; };\n',
      'left.cpp':'namespace left { class Block { public: int read_left() { return field; } }; }\n',
      'right.cpp':'namespace right { class Block : public Base { public: int read_right() { return field; } }; }\n',
    });
    const fields=(name:string)=>db().prepare(`SELECT t.qualified_name FROM edges e JOIN nodes s ON s.id=e.source
      JOIN nodes t ON t.id=e.target WHERE s.name=? AND e.kind='references'`).all(name);
    expect(fields('read_left')).toEqual([]);
    expect(fields('read_right')).toContainEqual({qualified_name:'Base::field'});
    healthy();
  });

  it('keeps prototype/definition edges and callers when both C files change', async () => {
    await setup({
      'api.h': 'int declared_api(int value);\n',
      'api.c': '#include "api.h"\nint declared_api(int value) { return value; }\n',
      'caller.c': '#include "api.h"\nint invoke(void) { return declared_api(3); }\n',
    });
    const before = edges();
    for (const file of ['api.h', 'api.c']) fs.appendFileSync(path.join(directory!, file), '/* safe comment */\n');
    await cg!.sync();
    expect(edges()).toEqual(before);
    expect(calls('invoke')[0].name).toBe('declared_api');
    healthy();
  });

  it('handles Unicode paths and CRLF source without drifting symbols or edges', async () => {
    await setup({
      '模块/api.cpp': 'int unicode_api() { return 1; }\r\n',
      '模块/caller.cpp': 'int invoke() { return unicode_api(); }\r\n',
    });
    const before = edges();
    for (const file of ['模块/api.cpp', '模块/caller.cpp']) fs.appendFileSync(path.join(directory!, file), '/* 中文注释 */\r\n');
    await cg!.sync();
    expect(edges()).toEqual(before);
    expect(cg!.getNodesByName('unicode_api')[0]).toMatchObject({ startLine: 1, endLine: 1, startColumn: 0 });
    healthy();
  });

  it('survives four restart/update cycles on a 40-file ring without graph drift', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 40; i++) files[`unit${i}.cpp`] = `int unit_${i}() { return unit_${(i + 1) % 40}(); }\n`;
    await setup(files);
    const before = edges();
    expect(before.filter((e: any) => e.kind === 'calls')).toHaveLength(40);
    for (let round = 0; round < 4; round++) {
      const changed = Object.keys(files).filter((_, index) => index % 2 === round % 2);
      for (const file of changed) fs.appendFileSync(path.join(directory!, file), `/* revision ${round} */\n`);
      reopen();
      expect((await cg!.sync()).filesModified).toBe(20);
      expect(edges()).toEqual(before);
      expect((await cg!.sync()).filesModified).toBe(0);
      healthy();
    }
  }, 30000);
});
