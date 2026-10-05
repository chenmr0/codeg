import {afterEach,expect,it} from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
import {ToolHandler} from '../src/mcp/tools';

const roots:string[]=[],graphs:CodeGraph[]=[];
afterEach(()=>{
  for(const graph of graphs.splice(0))graph.close();
  for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});
});
function project(files:Record<string,string>){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cg-callback-identity-'));roots.push(root);
  for(const [file,source] of Object.entries(files)){
    fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),source);
  }
  return root;
}
function open(root:string,existing=false){const graph=existing?CodeGraph.openSync(root):CodeGraph.initSync(root);graphs.push(graph);return graph;}
function raw(graph:CodeGraph){return (graph as any).db.db;}
function snapshot(graph:CodeGraph){
  return Object.fromEntries(['nodes','edges','unresolved_refs','files'].map(table=>[table,
    raw(graph).prepare(`SELECT * FROM ${table}`).all().map((row:any)=>Object.fromEntries(Object.keys(row).sort()
      .filter(key=>!['updated_at','modified_at','indexed_at'].includes(key)&&!(['edges','unresolved_refs'].includes(table)&&key==='id'))
      .map(key=>[key,row[key]]))).sort((a:any,b:any)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))]));
}
async function verify(graph:CodeGraph,expected:string|null){
  const calls=raw(graph).prepare("SELECT target.signature FROM edges e JOIN nodes caller ON caller.id=e.source JOIN nodes target ON target.id=e.target WHERE caller.name='caller' AND target.name='run' AND e.kind='calls'").all();
  expect(calls.map((row:any)=>row.signature)).toEqual(expected?[expected]:[]);
  expect(raw(graph).prepare("SELECT u.id FROM unresolved_refs u JOIN nodes caller ON caller.id=u.from_node_id WHERE caller.name='caller' AND reference_name='run' AND reference_kind='calls'").all()).toHaveLength(expected?0:1);
  expect(graph.getNodesByName('run')).toHaveLength(2);
  for(const node of graph.getNodesByName('run')){
    const output=JSON.stringify(await new ToolHandler(graph).execute('callers',{symbol:'run',signature:node.signature}));
    expect(output).toContain(node.signature===expected?'- caller (function)':'No callers found');
  }
  expect(raw(graph).prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  expect(raw(graph).prepare('PRAGMA quick_check').get().quick_check).toBe('ok');
}
const ordinary='int run(int (*p)(int))',member='int run(int (C::*p)(int))';
function source(prefix:string,reverse=false,address='&::C::f',first='int (*p)(int)',second='int (C::*p)(int)'){
  const definitions=[`int run(${first}){return 1;}`,`int run(${second}){return 2;}`];
  if(reverse)definitions.reverse();
  return `${prefix}\n#define MAKE() ${definitions.join(' ')}\nMAKE()\nint caller(){return run(${address});}\n`;
}

for(const isStatic of [true,false])for(const reverse of [false,true]){
  it(`keeps unproved header member identity unresolved across the lifecycle (static=${isStatic}, reverse=${reverse})`,async()=>{
    const files={'callback.hpp':`struct C {${isStatic?'static ':''}int f(int);};\n`,
      'api.cpp':source('#include "callback.hpp"\nint C::f(int value){return value;}',reverse)};
    const root=project(files),expected=null;let graph=open(root);
    expect((await graph.indexAll()).complete).toBe(true);await verify(graph,expected);
    const indexed=snapshot(graph);graph.close();graphs.pop();graph=open(root,true);
    await verify(graph,expected);expect(snapshot(graph)).toEqual(indexed);
    expect((await graph.sync()).filesModified).toBe(0);await verify(graph,expected);expect(snapshot(graph)).toEqual(indexed);
    files['api.cpp']+='\nint unrelated(){return 0;}\n';fs.writeFileSync(path.join(root,'api.cpp'),files['api.cpp']);
    expect((await graph.sync({paths:['api.cpp']})).complete).toBe(true);await verify(graph,expected);
    const fresh=open(project(files));expect((await fresh.indexAll()).complete).toBe(true);await verify(fresh,expected);
    expect(snapshot(graph)).toEqual(snapshot(fresh));
  },30000);
}

it.each([
  ['parameter names and signed spelling','struct C {static signed int f(signed int renamed);};','int C::f(int value){return value;}','C','int (*p)(int)','int (C::*p)(int)'],
  ['noexcept','struct C {static int f(int) noexcept;};','int C::f(int value) noexcept {return value;}','C','int (*p)(int) noexcept','int (C::*p)(int) noexcept'],
  ['qualified namespace','namespace N {struct C {static int f(int);};}','int N::C::f(int value){return value;}','N::C','int (*p)(int)','int (::N::C::*p)(int)'],
])('matches same-file declaration identity with %s',async(_,declaration,definition,owner,first,second)=>{
  const graph=open(project({'nested/api.cpp':source(`${declaration}\n${definition}`,false,`&::${owner}::f`,first,second)}));
  expect((await graph.indexAll()).complete).toBe(true);await verify(graph,`int run(${first})`);
});

it('does not transfer static identity to another overload of the same member',async()=>{
  const graph=open(project({'api.cpp':source('struct C {\nstatic int f(int);\nint f(double);\n};\nint C::f(int x){return x;}\nint C::f(double x){return int(x);}',false,'&::C::f','int (*p)(double)','int (C::*p)(double)')}));
  await graph.indexAll();await verify(graph,'int run(int (C::*p)(double))');
});

it('keeps same-line static and non-static declarations distinct',async()=>{
  const graph=open(project({'api.cpp':source('struct C {static int f(int); int f(double);};\nint C::f(int x){return x;}\nint C::f(double x){return int(x);}',false,'&::C::f','int (*p)(double)','int (C::*p)(double)')}));
  await graph.indexAll();
  const declarations=graph.getNodesByName('f').filter(node=>node.isDeclaration);
  expect(declarations).toHaveLength(2);expect(declarations.filter(node=>node.isStatic)).toHaveLength(1);
  await verify(graph,'int run(int (C::*p)(double))');
});

it('does not let another translation unit change same-file static identity',async()=>{
  const graph=open(project({'api.cpp':source('struct C {static int f(int);};\nint C::f(int x){return x;}',false,'&::C::f','int (*p)(int)','int (*p)(double)'),
    'other.cpp':'namespace {struct C {int f(double);};}\n'}));
  await graph.indexAll();await verify(graph,ordinary);
});

it('does not transfer noexcept identity to a mismatching declaration',async()=>{
  // The incomplete/inconsistent graph must not manufacture a member type.
  const graph=open(project({'api.cpp':source('struct C {static int f(int) noexcept;};\nint C::f(int x){return x;}')}));
  await graph.indexAll();await verify(graph,null);
});

it('keeps distinct class owners separate after matching their declarations',async()=>{
  const graph=open(project({'api.cpp':source('struct C {int f(int);};\nstruct D {int f(int);};\nint C::f(int x){return x;}\nint D::f(int x){return x;}',false,'&::D::f','int (C::*p)(int)','int (D::*p)(int)')}));
  await graph.indexAll();await verify(graph,'int run(int (D::*p)(int))');
});

it('does not infer non-static identity when the declaration is missing',async()=>{
  const graph=open(project({'api.cpp':source('struct C {};\nint C::f(int x){return x;}')}));
  await graph.indexAll();await verify(graph,null);
});

it.each([
  ['unrelated header',''],
  ['later include','\n#include "callback.hpp"\n'],
  ['conditional include',''],
])('does not recover identity from an %s',async(label,after)=>{
  const prefix=label==='conditional include'?'#ifdef SELECT_CALLBACK\n#include "callback.hpp"\n#endif\n':'';
  const graph=open(project({'callback.hpp':'struct C {static int f(int);};\n',
    'api.cpp':source(prefix+'int C::f(int x){return x;}')+after}));
  await graph.indexAll();await verify(graph,null);
});

it('does not merge same-named owner classes from different translation units',async()=>{
  const graph=open(project({'callback.hpp':'struct C {static int f(int);};\n',
    'other.cpp':'namespace {struct C {int f(int);};}\n',
    'api.cpp':source('#include "callback.hpp"\nint C::f(int x){return x;}')}));
  await graph.indexAll();await verify(graph,null);
});

it('keeps a header-only callback outside the visible witness set',async()=>{
  const graph=open(project({'callback.hpp':'struct C {static int f(int x){return x;}};\n',
    'api.cpp':source('#include "callback.hpp"')}));
  await graph.indexAll();await verify(graph,null);
});

it('uses an earlier static member declaration with a later out-of-line definition',async()=>{
  const graph=open(project({'api.cpp':source('struct C {static int f(int);};')+'int C::f(int x){return x;}\n'}));
  await graph.indexAll();await verify(graph,ordinary);
});

it('uses an earlier non-static declaration for an out-of-line definition',async()=>{
  const graph=open(project({'api.cpp':source('struct C {int f(int);};\nint C::f(int x){return x;}')}));
  await graph.indexAll();await verify(graph,member);
});

it.each(['ordinary','scoped','index'] as const)('keeps header identity edits safe without reinterpreting unchanged callbacks (%s)',async mode=>{
  const files={'callback.hpp':'struct C {static int f(int);};\n',
    'api.cpp':source('#include "callback.hpp"\nint C::f(int x){return x;}')};
  const root=project(files);let graph=open(root);expect((await graph.indexAll()).complete).toBe(true);
  const callerHash=graph.getFile('api.cpp')!.contentHash;
  for(const isStatic of [false,true,false]){
    files['callback.hpp']=`struct C {${isStatic?'static ':''}int f(int);};\n`;
    fs.writeFileSync(path.join(root,'callback.hpp'),files['callback.hpp']);
    const result=mode==='index'?await graph.indexAll():await graph.sync(mode==='scoped'?{paths:['callback.hpp']}:{});
    expect(result.complete).toBe(true);await verify(graph,null);
    expect(graph.getFile('api.cpp')!.contentHash).toBe(callerHash);
    const fresh=open(project(files));expect((await fresh.indexAll()).complete).toBe(true);await verify(fresh,null);
    expect(snapshot(graph)).toEqual(snapshot(fresh));fresh.close();graphs.pop();
    graph.close();graphs.pop();graph=open(root,true);await verify(graph,null);
    expect((await graph.sync()).filesModified).toBe(0);await verify(graph,null);
  }
},30000);

it.each([false,true])('keeps a later free overload outside the witness set (same line=%s)',async sameLine=>{
  const graph=open(project({'api.cpp':source('int f(int) noexcept;',false,'&::f','int (*p)(int)','double (*p)(double)').trimEnd()
    +(sameLine?' ':'\n')+'double f(double x){return x;}\nint f(int x) noexcept{return x;}\n',
    'other.cpp':'double f(double);\n'}));
  await graph.indexAll();await verify(graph,null);
});

it('keeps an earlier free declaration usable without importing a later overload',async()=>{
  const graph=open(project({'api.cpp':source('int f(int);',false,'&::f','int (*p)(int)','double (*p)(double)')
    +'double f(double x){return x;}\nint f(int x){return x;}\n'}));
  await graph.indexAll();await verify(graph,ordinary);
});
