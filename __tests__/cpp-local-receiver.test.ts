import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
import * as grammars from '../src/extraction/grammars';
import { hasSimpleCppLocalReceiver } from '../src/resolution/cpp-local-receiver';
import { matchMethodCall } from '../src/resolution/name-matcher';
import type { Node } from '../src/types';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types';

function site(text: string) {
  const lines = text.split(/\r?\n/);
  const row = lines.findLastIndex(line => /data(?:\.|->)flatten/.test(line));
  const column = Math.max(lines[row]!.lastIndexOf('data.flatten'), lines[row]!.lastIndexOf('data->flatten'));
  const source: Node = { id:'fn',name:'invoke',kind:'function',qualifiedName:'invoke',filePath:'caller.cpp',
    language:'cpp',startLine:1,endLine:lines.length,startColumn:0,endColumn:1,updatedAt:1 };
  const ref: UnresolvedRef = {fromNodeId:'fn',filePath:'caller.cpp',language:'cpp',referenceKind:'calls',
    referenceName:'data.flatten',line:row+1,column};
  return {lines,source,ref};
}
function check(text: string) {
  const {lines,source,ref} = site(text);
  return hasSimpleCppLocalReceiver('data','PictureData',ref,source,lines);
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe('bounded C++ local receiver evidence', () => {
  it.each([
    'PictureData data;', 'PictureData data(record);', 'PictureData data{record};',
    'PictureData data = create();', 'const PictureData data(record);',
    'PictureData*data = create();', 'PictureData &data = existing;',
    'ns::PictureData data;',
  ])('accepts an explicit local: %s', declaration => {
    expect(check(`void invoke() { ${declaration} data.flatten(); }`)).toBe(true);
  });
  it('allows actual pointers but not value/reference operator-> proxies', () => {
    expect(check('void invoke() { PictureData* data = create(); data->flatten(); }')).toBe(true);
    expect(check('void invoke() { PictureData data; data->flatten(); }')).toBe(false);
    expect(check('void invoke() { PictureData& data = other; data->flatten(); }')).toBe(false);
  });
  it('keeps an active enclosing declaration across repeated member uses and inner blocks', () => {
    expect(check('void invoke() { PictureData data; data.prepare(); { data.flatten(); } }')).toBe(true);
  });
  it.each([
    'void invoke() { { PictureData data; } data.flatten(); }',
    'void invoke() { PictureData data; { Other data; data.flatten(); } }',
    'void invoke() { for (; PictureData data = create(); ) {} data.flatten(); }',
    'void invoke() { if (PictureData data = create()) {} data.flatten(); }',
    'void invoke() { using PictureData = Proxy; PictureData data; data.flatten(); }',
    'void invoke() { auto data = create(); data.flatten(); }',
    'void invoke() { PictureData data; use(data); data.flatten(); }',
    'void invoke() { auto f = [] { PictureData data; }; data.flatten(); }',
    'void invoke() {\n#if ACTIVE\nPictureData data;\n#endif\ndata.flatten(); }',
    'void invoke() { /* PictureData data; */ data.flatten(); }',
    'void invoke() { const char* x = "PictureData data;"; data.flatten(); }',
    'void invoke() { const char* x = R"raw(PictureData data;)raw"; data.flatten(); }',
  ])('leaves uncertain/inactive evidence on the old path: %s', text => expect(check(text)).toBe(false));
  it('handles comments, raw literals, CRLF and Unicode without shifting the receiver', () => {
    expect(check('void invoke() {\r\n/* 中文 { */ PictureData data;\r\nconst char* t = R"x(})x"; data.flatten();\r\n}')).toBe(true);
  });
  it('memoizes only immutable text, and recomputes same-path changed source', () => {
    const mask = vi.spyOn(grammars,'maskCStyleCommentsAndLiterals');
    const first = site('void invoke() { PictureData data; data.flatten(); }');
    for (let i=0;i<20;i++) expect(hasSimpleCppLocalReceiver('data','PictureData',first.ref,first.source,first.lines)).toBe(true);
    expect(mask).toHaveBeenCalledTimes(1);
    expect(check('void invoke() { OtherThing  data; data.flatten(); }')).toBe(false);
    expect(mask).toHaveBeenCalledTimes(2);
  });
  it('declines huge prefixes before masking or scanning their contents', () => {
    const mask = vi.spyOn(grammars,'maskCStyleCommentsAndLiterals');
    expect(check('void invoke() {\n'+'\n'.repeat(300)+'PictureData data; data.flatten(); }')).toBe(false);
    expect(check('void invoke() {'+' '.repeat(17000)+'PictureData data; data.flatten(); }')).toBe(false);
    expect(mask).not.toHaveBeenCalled();
  });
  it('bounds per-text memo entries and recomputes evicted sites without changing answers', () => {
    const mask = vi.spyOn(grammars,'maskCStyleCommentsAndLiterals');
    const {lines,source,ref} = site('void invoke() { PictureData data;\n'+'data.flatten();\n'.repeat(140)+'}');
    for(let line=2;line<=141;line++) expect(hasSimpleCppLocalReceiver('data','PictureData',{...ref,line,column:0},source,lines)).toBe(true);
    expect(mask).toHaveBeenCalledTimes(140);
    expect(hasSimpleCppLocalReceiver('data','PictureData',{...ref,line:2,column:0},source,lines)).toBe(true);
    expect(mask).toHaveBeenCalledTimes(141);
  });
  it.each(['macro','type_alias','template'] as const)('keeps existing fallback when the apparent type also names a %s', kind => {
    const {source,ref,lines} = site('void invoke() { PictureData data; data.flatten(); }');
    source.signature='void invoke()';
    const type: Node={...source,id:'type',name:'PictureData',kind:'class',qualifiedName:'PictureData',filePath:'type.hpp'};
    const other: Node={...source,id:'other',name:'flatten',kind:'method',qualifiedName:'OtherData::flatten',filePath:'other.hpp'};
    const nodes=[source,type,other];
    const context: ResolutionContext={
      getNodesInFile:file=>nodes.filter(n=>n.filePath===file),getNodesByName:name=>nodes.filter(n=>n.name===name),
      getNodesByQualifiedName:name=>nodes.filter(n=>n.qualifiedName===name),getNodesByKind:kind=>nodes.filter(n=>n.kind===kind),
      getNodesByLowerName:()=>[],fileExists:()=>false,readFile:()=>lines.join('\n'),getFileLines:()=>lines,
      getProjectRoot:()=>'.',getAllFiles:()=>[],getImportMappings:()=>[],getSupertypes:()=>[],hasCppInheritance:()=>false,
    };
    expect(matchMethodCall(ref,context)).toBeNull();
    nodes.push({...type,id:'indirect',kind:kind==='template'?'class':kind,...(kind==='template'?{typeParameters:['T']}: {})});
    expect(matchMethodCall(ref,context)?.targetNodeId).toBe('other');
  });
});

beforeAll(() => grammars.loadGrammarsForLanguages(['c','cpp']));
describe('local C++ receiver delete/restart/restore', () => {
  it.each([false,true])('preserves fallback for a declared but unresolved base (cache off=%s)', async off => {
    if(off) vi.stubEnv('CODEGRAPH_NO_RESOLVE_EQUIVALENCE_CACHE','1');
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'cg-local-unknown-base-'));
    let cg: CodeGraph | undefined;
    try {
      fs.writeFileSync(path.join(root,'types.hpp'),'class PictureData : public UnindexedBase { };\nclass OtherData { public: void flatten(); };\n');
      fs.writeFileSync(path.join(root,'caller.cpp'),'void invoke() { PictureData data; data.flatten(); }\n');
      cg=CodeGraph.initSync(root);await cg.indexAll();
      const db=(cg as any).db.db;
      expect(db.prepare("SELECT COUNT(*) n FROM unresolved_refs WHERE reference_kind='extends' AND status='failed'").get().n).toBeGreaterThan(0);
      expect(db.prepare(`SELECT t.qualified_name target FROM edges e JOIN nodes s ON s.id=e.source
        JOIN nodes t ON t.id=e.target WHERE s.name='invoke' AND e.kind='calls'`).all()).toEqual([{target:'OtherData::flatten'}]);
      // Unknown inheritance deliberately retains the pre-existing heuristic;
      // this test proves no new tightening, not semantic correctness of that guess.
    } finally {cg?.close();fs.rmSync(root,{recursive:true,force:true});}
  });
  it('keeps the existing fallback for inheritance beyond the typed lookup depth bound', async () => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'cg-local-deep-base-'));
    let cg: CodeGraph | undefined;
    try {
      fs.writeFileSync(path.join(root,'types.hpp'),'class B0 { public: void flatten(); };\n'+
        Array.from({length:5},(_,i)=>`class B${i+1} : public B${i} {};\n`).join(''));
      fs.writeFileSync(path.join(root,'caller.cpp'),'void invoke() { B5 data; data.flatten(); }\n');
      cg=CodeGraph.initSync(root);await cg.indexAll();
      const calls=(cg as any).db.db.prepare(`SELECT t.qualified_name target FROM edges e
        JOIN nodes s ON s.id=e.source JOIN nodes t ON t.id=e.target WHERE s.name='invoke' AND e.kind='calls'`).all();
      expect(calls).toEqual([{target:'B0::flatten'}]);
    } finally {cg?.close();fs.rmSync(root,{recursive:true,force:true});}
  });
  it.each(['PictureData data;', 'PictureData data(42);', 'PictureData data{42};',
    'PictureData* data = make_data();'])('does not guess a different class after %s', async declaration => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(),'cg-local-receiver-'));
    let cg: CodeGraph | undefined;
    const provider='class PictureData { public: PictureData(int); void flatten(); };\n';
    try {
      fs.writeFileSync(path.join(root,'provider.hpp'),provider);
      fs.writeFileSync(path.join(root,'other.hpp'),'class OtherData { public: void flatten(); };\n');
      fs.writeFileSync(path.join(root,'caller.cpp'),`class PictureData;\nvoid invoke() { ${declaration} data${declaration.includes('*')?'->':'.'}flatten(); }\n`);
      cg=CodeGraph.initSync(root); await cg.indexAll();
      const calls=()=> (cg as any).db.db.prepare(`SELECT t.qualified_name target FROM edges e
        JOIN nodes s ON s.id=e.source JOIN nodes t ON t.id=e.target
        WHERE s.name='invoke' AND e.kind='calls' AND t.name='flatten'`).all();
      expect(calls()).toEqual([{target:'PictureData::flatten'}]);
      fs.unlinkSync(path.join(root,'provider.hpp')); await cg.sync();
      expect(calls()).toEqual([]);
      cg.close(); cg=CodeGraph.openSync(root);
      fs.writeFileSync(path.join(root,'provider.hpp'),provider); await cg.sync();
      expect(calls()).toEqual([{target:'PictureData::flatten'}]);
      await cg.sync(); expect(calls()).toEqual([{target:'PictureData::flatten'}]);
    } finally { cg?.close(); fs.rmSync(root,{recursive:true,force:true}); }
  });
});
