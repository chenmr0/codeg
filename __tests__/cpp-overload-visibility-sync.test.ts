import {afterEach, expect, it, vi} from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
import {ToolHandler} from '../src/mcp/tools';
import {EXTRACTION_VERSION} from '../src/extraction/extraction-version';

const roots:string[]=[], graphs:CodeGraph[]=[];
afterEach(()=>{
  vi.restoreAllMocks();
  for(const g of graphs.splice(0))g.close();
  for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});
});
function project(files:Record<string,string>){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cg-cpp-visible-'));roots.push(root);
  for(const [file,source] of Object.entries(files)){
    fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),source);
  }
  return root;
}
function open(root:string,existing=false){const g=existing?CodeGraph.openSync(root):CodeGraph.initSync(root);graphs.push(g);return g;}
function raw(g:CodeGraph){return (g as any).db.db;}
function snapshot(g:CodeGraph){
  return Object.fromEntries(['nodes','edges','unresolved_refs','files'].map(table=>[table,
    raw(g).prepare(`SELECT * FROM ${table}`).all().map((row:any)=>Object.fromEntries(Object.keys(row).sort()
      .filter(k=>!['updated_at','modified_at','indexed_at'].includes(k)&&!(['edges','unresolved_refs'].includes(table)&&k==='id'))
      .map(k=>[k,row[k]]))).sort((a:any,b:any)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))]));
}
async function verify(g:CodeGraph,expected:string|null){
  const calls=raw(g).prepare("SELECT t.signature FROM edges e JOIN nodes s ON s.id=e.source JOIN nodes t ON t.id=e.target WHERE s.name='caller' AND t.name='run' AND e.kind='calls'").all();
  expect(calls.map((r:any)=>r.signature)).toEqual(expected?[expected]:[]);
  expect(raw(g).prepare("SELECT id FROM unresolved_refs WHERE reference_name='run' AND reference_kind='calls'").all()).toHaveLength(expected?0:1);
  expect(g.getNodesByName('run')).toHaveLength(2);
  for(const node of g.getNodesByName('run')){
    const output=JSON.stringify(await new ToolHandler(g).execute('callers',{symbol:'run',signature:node.signature}));
    expect(output).toContain(node.signature===expected?'- caller (function)':'No callers found');
  }
  expect(raw(g).prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  expect(raw(g).prepare('PRAGMA quick_check').get().quick_check).toBe('ok');
}
async function freshEquals(g:CodeGraph,files:Record<string,string>,expected:string|null){
  const fresh=open(project(files));expect((await fresh.indexAll()).complete).toBe(true);
  await verify(fresh,expected);expect(snapshot(g)).toEqual(snapshot(fresh));
  fresh.close();graphs.pop();
}

function late(reverse=false,declaration='int f(int) noexcept;',sameLine=false){
  const overloads=['int run(int (*p)(int)){return 1;}','int run(double (*p)(double)){return 2;}'];
  if(reverse)overloads.reverse();
  return declaration+'\n#define MAKE() '+overloads.join(' ')+'\nMAKE()\n'
    +'int caller(){return run(&::f);}'+(sameLine?' ':'\n')+'double f(double x){return x;}\n'
    +'int f(int x) noexcept {return x;}\nint main(){return caller()!=1;}\n';
}
for(const file of ['api.cpp','probe.cpp','src/sample.cpp'])for(const reverse of [false,true]){
  it(`does not use a later callback overload (${file}, reverse=${reverse})`,async()=>{
    let source=late(reverse);const root=project({[file]:source});let g=open(root);
    expect((await g.indexAll()).complete).toBe(true);await verify(g,null);
    g.close();graphs.pop();g=open(root,true);await verify(g,null);
    source+='\nint unrelated(){return 0;}\n';fs.writeFileSync(path.join(root,file),source);
    expect((await g.sync({paths:[file]})).complete).toBe(true);await verify(g,null);
    await freshEquals(g,{[file]:source},null);
  },30000);
}
it('uses columns to reject a later callback on the same line',async()=>{
  const g=open(project({'api.cpp':late(false,undefined,true)}));await g.indexAll();await verify(g,null);
});
it('keeps a visible forward declaration as evidence for its later definition',async()=>{
  const source=late().replaceAll(' noexcept','');
  const g=open(project({'api.cpp':source}));await g.indexAll();await verify(g,'int run(int (*p)(int))');
});
it('does not treat an unrelated translation unit as visible callback evidence',async()=>{
  const source=late().replace('double f(double x){return x;}\n','');
  const g=open(project({'api.cpp':source,'other.cpp':'double f(double x){return x;}\n'}));
  await g.indexAll();await verify(g,null);
});
it('does not filter a callback overload which really precedes the call',async()=>{
  const source=late().replace('int f(int) noexcept;','double f(double);').replace('caller()!=1','caller()!=2');
  const g=open(project({'api.cpp':source}));await g.indexAll();await verify(g,'int run(double (*p)(double))');
});

const api='struct C {int f(int x){return x;} int g(double x){return int(x);} };\n'
  +'#define MAKE() int run(int (C::*p)(int)){return 1;} int run(int (C::*p)(double)){return 2;}\nMAKE()\n'
  +'#include "map.h"\nint caller(){return run(&C::f);}\nint main(){return caller()!=EXPECTED;}\n';
const headers={plain:'#define EXPECTED 1\n',object:'#define f g\n#define EXPECTED 2\n',
  undef:'#define f g\n#undef f\n#define EXPECTED 1\n',function:'#define f(x) g(x)\n#define EXPECTED 1\n'};
const member='int run(int (C::*p)(int))';
for(const mode of ['ordinary','scoped','index'] as const){
  it(`rechecks unchanged callers in both directions after header-only edits (${mode})`,async()=>{
    const root=project({'api.cpp':api,'map.h':headers.plain});let g=open(root);await g.indexAll();
    const original=g.getFile('api.cpp')!;
    for(const state of ['plain','object','undef','plain','object','function','object','plain'] as const){
      fs.writeFileSync(path.join(root,'map.h'),headers[state]);
      const result=mode==='index'?await g.indexAll():await g.sync(mode==='scoped'?{paths:['map.h']}:{});
      expect(result.complete).toBe(true);expect(result.errors ?? []).toEqual([]);
      const expected=state==='plain'||state==='function'?member:null;
      await verify(g,expected);
      expect(g.getFile('api.cpp')!.contentHash).toBe(original.contentHash);
      expect(g.getFile('api.cpp')!.indexedAt).toBe(original.indexedAt);
      await freshEquals(g,{'api.cpp':api,'map.h':headers[state]},expected);
      g.close();graphs.pop();g=open(root,true);
      expect((await g.sync()).filesModified).toBe(0);await verify(g,expected);
      expect(g.isIndexStale()).toBe(false);
    }
  },60000);
}
it.each([false,true])('invalidates graph-wide macro evidence on header addition and deletion (scoped=%s)',async scoped=>{
  // The guard is graph-wide today: even a header without an import edge is
  // part of its evidence. Keep invalidation and fresh behavior in agreement.
  const files:Record<string,string>={'api.cpp':api,'map.h':headers.plain};
  const root=project(files),g=open(root);await g.indexAll();await verify(g,member);
  for(const add of [true,false]){
    if(add){files['other.h']='#define f g\n';fs.writeFileSync(path.join(root,'other.h'),files['other.h']);}
    else{delete files['other.h'];fs.unlinkSync(path.join(root,'other.h'));}
    expect((await g.sync(scoped?{paths:['other.h']}:{})).complete).toBe(true);
    await verify(g,add?null:member);await freshEquals(g,files,add?null:member);
  }
},30000);

it.each(['before-invalidation','after-invalidation'] as const)('recovers a header-only update interrupted %s',async stage=>{
  const root=project({'api.cpp':api,'map.h':headers.plain});let g=open(root);await g.indexAll();
  fs.writeFileSync(path.join(root,'map.h'),headers.object);
  const queries=(g as any).queries,original=queries.invalidateCppMacroCalls.bind(queries);let count=0;
  vi.spyOn(queries,'invalidateCppMacroCalls').mockImplementation(async()=>{
    count++;
    if(count===2&&stage==='before-invalidation')throw new Error('injected before invalidation');
    const result=await original();
    if(count===2&&stage==='after-invalidation')throw new Error('injected after invalidation');
    return result;
  });
  await expect(g.sync({paths:['map.h']})).rejects.toThrow('injected');
  vi.restoreAllMocks();g.close();graphs.pop();g=open(root,true);
  expect((await g.sync()).complete).toBe(true);await verify(g,null);
  await freshEquals(g,{'api.cpp':api,'map.h':headers.object},null);
});
it('drains durable invalidation references during an unchanged indexAll retry',async()=>{
  const root=project({'api.cpp':api,'map.h':headers.plain});let g=open(root);await g.indexAll();
  fs.writeFileSync(path.join(root,'map.h'),headers.object);
  vi.spyOn((g as any).resolver,'resolveFilesAndPersist').mockRejectedValue(new Error('injected resolver failure'));
  await expect(g.sync({paths:['map.h']})).rejects.toThrow('injected');
  vi.restoreAllMocks();g.close();graphs.pop();g=open(root,true);
  expect((await g.indexAll()).complete).toBe(true);await verify(g,null);
  await freshEquals(g,{'api.cpp':api,'map.h':headers.object},null);
});
it('rebuilds a persisted v33 later-declaration wrong edge without source edits',async()=>{
  const source=late(),root=project({'api.cpp':source});let g=open(root);await g.indexAll();
  const caller=g.getNodesByName('caller')[0]!,wrong=g.getNodesByName('run').find(n=>n.signature!.includes('double'))!;
  raw(g).prepare("DELETE FROM unresolved_refs WHERE reference_name='run' AND reference_kind='calls'").run();
  raw(g).prepare("INSERT INTO edges(source,target,kind,line,col,metadata) VALUES(?,?,'calls',4,20,?)")
    .run(caller.id,wrong.id,JSON.stringify({confidence:0.4,resolvedBy:'exact-match',refName:'run'}));
  (g as any).queries.setMetadata('indexed_with_extraction_version','33');
  g.close();graphs.pop();g=open(root,true);expect(g.isIndexStale()).toBe(true);
  await g.sync();expect(g.getIndexBuildInfo().extractionVersion).toBe(33);
  expect((await g.indexAll()).complete).toBe(true);await verify(g,null);
  expect(g.getIndexBuildInfo().extractionVersion).toBe(EXTRACTION_VERSION);
  await freshEquals(g,{'api.cpp':source},null);
});
