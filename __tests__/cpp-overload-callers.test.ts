import {afterEach,expect,it} from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
import {ToolHandler} from '../src/mcp/tools';

const roots:string[]=[];
const graphs:CodeGraph[]=[];
afterEach(()=>{
  for(const g of graphs.splice(0))g.close();
  for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});
});
function project(source:string,file='probe.cpp') {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cg-cpp-overload-'));roots.push(root);
  fs.writeFileSync(path.join(root,file),source);return root;
}
function calls(g:CodeGraph) {
  return (g as any).db.db.prepare("SELECT s.name caller,t.signature target,e.line,e.col FROM edges e JOIN nodes s ON s.id=e.source JOIN nodes t ON t.id=e.target WHERE e.kind='calls' AND t.name='run' ORDER BY s.name,e.line,e.col").all();
}
function snapshot(g:CodeGraph) {
  const db=(g as any).db.db;
  return Object.fromEntries(['nodes','edges','unresolved_refs','files'].map(table=>[table,
    db.prepare(`SELECT * FROM ${table}`).all().map((row:any)=>Object.fromEntries(Object.keys(row).sort()
      .filter(k=>!['updated_at','modified_at','indexed_at'].includes(k)&&!(['edges','unresolved_refs'].includes(table)&&k==='id'))
      .map(k=>[k,row[k]]))).sort((a:any,b:any)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))]));
}
const owners='struct C {int f(int);};\nstruct D {int f(int);};\n'
  +'#define MAKE() int run(int (C::*p)(int)) {return 1;} int run(int (D::*p)(int)) {return 2;}\nMAKE()\n'
  +'int caller_c(){return run(&C::f);}\nint caller_d(){return run(&D::f);}\n'
  +'int C::f(int x){return x;}\nint D::f(int x){return x;}\n';
const free='struct C {int f(int);};\nint free_fn(int x){return x;}\n'
  +'#define MAKE() int run(int (C::*p)(int)) {return 1;} int run(int (*p)(int)) {return 2;}\nMAKE()\n'
  +'int caller_c(){return run(&C::f);}\nint caller_free(){return run(&free_fn);}\nint C::f(int x){return x;}\n';

it('fixes the exact D-member pointer report fixture',async()=>{
  const source=owners.replace('};\nstruct D','}; struct D').replace(';}\nint D::f',';} int D::f')
    .replace('int caller_c(){return run(&C::f);}\n','');
  const g=CodeGraph.initSync(project(source));graphs.push(g);await g.indexAll();
  expect(calls(g).map((e:any)=>e.target)).toEqual(['int run(int (D::*p)(int))']);
});

it.each(['sample.cpp','probe.cpp','main.cpp'])('chooses each member-pointer overload regardless of ID order (%s)',async file=>{
  const g=CodeGraph.initSync(project(owners,file));graphs.push(g);await g.indexAll();
  expect(calls(g).map((e:any)=>[e.caller,e.target])).toEqual([
    ['caller_c','int run(int (C::*p)(int))'],['caller_d','int run(int (D::*p)(int))'],
  ]);
});

it.each([['owners',owners],['free',free]])('preserves correct calls and exact MCP callers across the %s lifecycle',async(_,source)=>{
  const root=project(source!);let g=CodeGraph.initSync(root);graphs.push(g);
  const indexed=await g.indexAll();expect(indexed.complete).toBe(true);expect(indexed.errors).toEqual([]);
  const verify=async()=>{
    const nodes=g.getNodesByName('run');expect(nodes).toHaveLength(2);
    for(const node of nodes) {
      const expected=node.signature?.includes('C::*')?'caller_c':source===owners?'caller_d':'caller_free';
      expect(calls(g).filter((e:any)=>e.target===node.signature).map((e:any)=>e.caller)).toEqual([expected]);
      const output=JSON.stringify(await new ToolHandler(g).execute('callers',{symbol:'run',signature:node.signature}));
      expect(output).toContain(`- ${expected} (function)`);expect(output).not.toContain('No callers found');
      for(const other of ['caller_c','caller_d','caller_free'].filter(n=>n!==expected))expect(output).not.toContain(`- ${other} (function)`);
    }
  };
  await verify();g.close();graphs.pop();g=CodeGraph.openSync(root);graphs.push(g);await verify();
  expect((await g.sync()).filesModified).toBe(0);
  fs.appendFileSync(path.join(root,'probe.cpp'),'\nint unrelated(){return 0;}\n');
  expect((await g.sync({paths:['probe.cpp']})).filesErrored).toBe(0);await verify();
  const fresh=CodeGraph.initSync(project(fs.readFileSync(path.join(root,'probe.cpp'),'utf8')));graphs.push(fresh);await fresh.indexAll();
  expect(snapshot(g)).toEqual(snapshot(fresh));
},30000);

it.each([
  ['unknown expression','int caller(int (D::*p)(int)){return run(p);}'],
  ['null pointer','int caller(){return run(nullptr);}'],
  ['local alias','int caller(){using D=C; return run(&D::f);}'],
])('keeps unsupported %s ambiguous instead of choosing an ID',async(_,caller)=>{
  const source=owners.replace(/int caller_c\(\).*\nint caller_d\(\).*\n/,caller+'\n');
  const g=CodeGraph.initSync(project(source));graphs.push(g);await g.indexAll();
  expect(calls(g)).toEqual([]);
  const unresolved=(g as any).db.db.prepare("SELECT reference_name FROM unresolved_refs WHERE reference_name='run' AND reference_kind='calls'").all();
  expect(unresolved).toHaveLength(1);
});

it('uses call-site columns when a caller addresses two different owners on one line',async()=>{
  const source=owners.replace(/int caller_c\(\).*\nint caller_d\(\).*\n/,'int caller(){return run(&C::f)+run(&D::f);}\n');
  const g=CodeGraph.initSync(project(source));graphs.push(g);await g.indexAll();
  expect(calls(g).map((e:any)=>e.target)).toEqual(['int run(int (C::*p)(int))','int run(int (D::*p)(int))']);
});

it('does not treat a static member address as a member-function pointer',async()=>{
  const source=free.replace('int free_fn(int x){return x;}','struct S { static int f(int x){return x;} };')
    .replace('run(&free_fn)','run(&S::f)');
  const g=CodeGraph.initSync(project(source));graphs.push(g);await g.indexAll();
  expect(calls(g).filter((e:any)=>e.caller==='caller_free').map((e:any)=>e.target)).toEqual(['int run(int (*p)(int))']);
});

it.each([
  ['parameters','struct C { int f(double x){return 1;} };','int (C::*p)(int)','int (C::*p)(double)'],
  ['return','struct C { long f(int x){return x;} };','int (C::*p)(int)','long (C::*p)(int)'],
  ['const','struct C { int f(int x) const {return x;} };','int (C::*p)(int)','int (C::*p)(int) const'],
  ['ref','struct C { int f(int x) & {return x;} };','int (C::*p)(int) &&','int (C::*p)(int) &'],
  ['noexcept','struct C { int f(int x) noexcept {return x;} };','int (C::*p)(int)','int (C::*p)(int) noexcept'],
  ['mixed static members','struct C {\nstatic int f(int x){return x;}\nint f(double x){return 1;}\n};',
    'int (*p)(double)','int (C::*p)(double)'],
])('compares callback %s instead of just the member owner',async(_,prefix,wrong,right)=>{
  const source=`${prefix}\n#define MAKE() int run(${wrong}){return 1;} int run(${right}){return 2;}\nMAKE()\nint caller(){return run(&C::f);}\n`;
  const g=CodeGraph.initSync(project(source));graphs.push(g);await g.indexAll();
  expect(calls(g).map((e:any)=>e.target)).toEqual([`int run(${right})`]);
  const output=JSON.stringify(await new ToolHandler(g).execute('callers',{symbol:'run',signature:`int run(${wrong})`}));
  expect(output).toContain('No callers found');
});

it('retains ambiguity for an explicit cast until its type is supported',async()=>{
  const source=owners.replace(/int caller_c\(\).*\nint caller_d\(\).*\n/,
    'int caller(){return run(static_cast<int (D::*)(int)>(&D::f));}\n');
  const g=CodeGraph.initSync(project(source));graphs.push(g);await g.indexAll();expect(calls(g)).toEqual([]);
});

it('uses absolute owner names without confusing the caller namespace',async()=>{
  const source=owners.replaceAll('C::*','::C::*').replaceAll('D::*','::D::*')
    .replace('int caller_c(){return run(&C::f);}', 'namespace local { int caller_c(){return run(&::C::f);} }')
    .replace('int caller_d(){return run(&D::f);}', 'namespace other { int caller_d(){return run(&::D::f);} }');
  const g=CodeGraph.initSync(project(source));graphs.push(g);await g.indexAll();
  expect(calls(g).map((e:any)=>e.target)).toEqual(['int run(int (::C::*p)(int))','int run(int (::D::*p)(int))']);
});

it('rebuilds persisted v31 wrong call targets even when the source is unchanged',async()=>{
  const root=project(free);let g=CodeGraph.initSync(root);graphs.push(g);await g.indexAll();
  const wrong=g.getNodesByName('run').find(n=>n.signature?.includes('C::*'))!;
  const caller=g.getNodesByName('caller_free')[0]!;
  // Persist the v31 failure without requiring a historical engine in CI. The
  // independent acceptance script also generates these databases with real v31.
  (g as any).db.db.prepare("UPDATE edges SET target=? WHERE source=? AND kind='calls'").run(wrong.id,caller.id);
  (g as any).queries.setMetadata('indexed_with_extraction_version','31');
  g.close();graphs.pop();g=CodeGraph.openSync(root);graphs.push(g);
  expect(g.isIndexStale()).toBe(true);
  expect((await g.sync()).filesModified).toBe(0);
  expect(g.getIndexBuildInfo().extractionVersion).toBe(31);
  expect(calls(g).filter((e:any)=>e.caller==='caller_free').map((e:any)=>e.target)).toEqual([wrong.signature]);
  const rebuilt=await g.indexAll();expect(rebuilt.complete).toBe(true);expect(rebuilt.errors).toEqual([]);
  expect(g.isIndexStale()).toBe(false);
  expect(calls(g).filter((e:any)=>e.caller==='caller_free').map((e:any)=>e.target)).toEqual(['int run(int (*p)(int))']);
  const fresh=CodeGraph.initSync(project(free));graphs.push(fresh);await fresh.indexAll();expect(snapshot(g)).toEqual(snapshot(fresh));
});
