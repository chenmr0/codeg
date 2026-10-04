import {afterEach,expect,it} from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
import {ToolHandler} from '../src/mcp/tools';
import {EXTRACTION_VERSION} from '../src/extraction/extraction-version';

type Fixture={name:string; file:string; source:string; expected:string|null; legacy:string|null};
const fixtures:Fixture[]=[
  {name:'declaration terminator',file:'probe.cpp',expected:'int run(int (*p)(int))',legacy:null,
    source:'struct C {int f(int);}; int free_fn(int);\n#define MAKE() int run(int (C::*p)(int)) {return 1;} int run(int (*p)(int)) {return 2;}\nMAKE()\nint caller(){return run(&free_fn);}\nint C::f(int x){return x;} int free_fn(int x){return x;}\nint main(){return caller()!=2;}\n'},
  {name:'macro-expanded member',file:'api.cpp',expected:null,legacy:'int run(int (C::*p)(int))',
    source:'struct C {int f(int x){return x;} int g(double x){return int(x);} };\n#define MAKE() int run(int (C::*p)(int)){return 1;} int run(int (C::*p)(double)){return 2;}\nMAKE()\n#define f g\nint caller(){return run(&C::f);}\nint main(){return caller()!=2;}\n'},
  {name:'implicit const object',file:'api.cpp',expected:null,legacy:'int run(int (*p)(int) noexcept)',
    source:'int f(int x) noexcept {return x;}\nstruct C {\n#define MAKE() int run(int (*p)(int)) const {return 1;} int run(int (*p)(int) noexcept){return 2;}\nMAKE()\nint caller() const {return run(&::f);}\n};\nint main(){return C{}.caller()!=1;}\n'},
  {name:'incomplete address overload set',file:'sample.cpp',expected:null,legacy:'int run(bool p)',
    source:'int f(int x){return x;} double f(double x){return x;}\n#define MAKE() int run(bool p){return 1;} int run(int (*p)(int)){return 2;}\nMAKE()\nint caller(){return run(&f);}\nint main(){return caller()!=2;}\n'},
];
const roots:string[]=[], graphs:CodeGraph[]=[];
afterEach(()=>{
  for(const g of graphs.splice(0))g.close();
  for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});
});
function project(f:Fixture){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cg-overload-evidence-'));roots.push(root);
  fs.writeFileSync(path.join(root,f.file),f.source);return root;
}
function open(root:string,existing=false){const g=existing?CodeGraph.openSync(root):CodeGraph.initSync(root);graphs.push(g);return g;}
function calls(g:CodeGraph){return (g as any).db.db.prepare("SELECT t.signature FROM edges e JOIN nodes s ON s.id=e.source JOIN nodes t ON t.id=e.target WHERE s.name='caller' AND t.name='run' AND e.kind='calls'").all().map((r:any)=>r.signature);}
function snapshot(g:CodeGraph){
  return Object.fromEntries(['nodes','edges','unresolved_refs','files'].map(table=>[table,
    (g as any).db.db.prepare(`SELECT * FROM ${table}`).all().map((row:any)=>Object.fromEntries(Object.keys(row).sort()
      .filter(k=>!['updated_at','modified_at','indexed_at'].includes(k)&&!(['edges','unresolved_refs'].includes(table)&&k==='id'))
      .map(k=>[k,row[k]]))).sort((a:any,b:any)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))]));
}
async function verify(g:CodeGraph,f:Fixture){
  expect(calls(g)).toEqual(f.expected?[f.expected]:[]);
  const nodes=g.getNodesByName('run');expect(nodes).toHaveLength(2);
  for(const node of nodes){
    const response=JSON.stringify(await new ToolHandler(g).execute('callers',{symbol:node.qualifiedName,signature:node.signature}));
    if(node.signature===f.expected)expect(response).toContain('- caller (function)');
    else expect(response).toContain('No callers found');
  }
  const unresolved=(g as any).db.db.prepare("SELECT reference_name FROM unresolved_refs WHERE reference_name='run' AND reference_kind='calls'").all();
  expect(unresolved).toHaveLength(f.expected?0:1);
}

for(const f of fixtures){
  it(`preserves the ${f.name} outcome through index, MCP, reopen, changed sync and fresh`,async()=>{
    const root=project(f);let g=open(root);
    const indexed=await g.indexAll();expect(indexed.complete).toBe(true);expect(indexed.errors).toEqual([]);await verify(g,f);
    g.close();graphs.pop();g=open(root,true);await verify(g,f);
    expect((await g.sync()).filesModified).toBe(0);await verify(g,f);
    fs.appendFileSync(path.join(root,f.file),'\nint unrelated(){return 0;}\n');
    expect((await g.sync({paths:[f.file]})).filesErrored).toBe(0);await verify(g,f);
    const fresh=open(project({...f,source:fs.readFileSync(path.join(root,f.file),'utf8')}));await fresh.indexAll();await verify(fresh,f);
    expect(snapshot(g)).toEqual(snapshot(fresh));
  },30000);

  it(`rebuilds the persisted v32 ${f.name} result without changing source`,async()=>{
    const root=project(f);let g=open(root);await g.indexAll();
    const caller=g.getNodesByName('caller')[0]!, db=(g as any).db.db;
    db.prepare("DELETE FROM edges WHERE source=? AND kind='calls' AND target IN (SELECT id FROM nodes WHERE name='run')").run(caller.id);
    db.prepare("DELETE FROM unresolved_refs WHERE from_node_id=? AND reference_name='run' AND reference_kind='calls'").run(caller.id);
    if(f.legacy){
      const target=g.getNodesByName('run').find(n=>n.signature===f.legacy)!;
      db.prepare("INSERT INTO edges(source,target,kind,line,col,metadata) VALUES(?,?,'calls',?,0,?)")
        .run(caller.id,target.id,caller.startLine,JSON.stringify({confidence:0.4,resolvedBy:'exact-match',refName:'run'}));
    }
    (g as any).queries.setMetadata('indexed_with_extraction_version','32');
    g.close();graphs.pop();g=open(root,true);
    expect(g.isIndexStale()).toBe(true);expect((await g.sync()).filesModified).toBe(0);
    expect(g.getIndexBuildInfo().extractionVersion).toBe(32);expect(calls(g)).toEqual(f.legacy?[f.legacy]:[]);
    const rebuilt=await g.indexAll();expect(rebuilt.complete).toBe(true);expect(rebuilt.errors).toEqual([]);
    expect(g.getIndexBuildInfo().extractionVersion).toBe(EXTRACTION_VERSION);expect(g.isIndexStale()).toBe(false);await verify(g,f);
    const fresh=open(project(f));await fresh.indexAll();expect(snapshot(g)).toEqual(snapshot(fresh));
  },30000);
}

it.each(['int free_fn(int named);','int free_fn(int); int free_fn(int);'])('accepts a complete forward declaration: %s',async declaration=>{
  const f={...fixtures[0]!,source:fixtures[0]!.source.replace('int free_fn(int);',declaration)};
  const g=open(project(f));await g.indexAll();await verify(g,f);
});

it('does not discard unsupported exception specifications along with the semicolon',async()=>{
  const f={...fixtures[0]!,expected:null,source:fixtures[0]!.source.replace('int free_fn(int);','int free_fn(int) noexcept(sizeof(int)>0);')
    .replace('int free_fn(int x){','int free_fn(int x) noexcept(sizeof(int)>0){')};
  const g=open(project(f));await g.indexAll();await verify(g,f);
});

it.each(['#define f g\n#undef f\n','#define f (g)\n#undef f\n'])('does not infer an active object macro from an uncertain environment: %s',async directive=>{
  const f={...fixtures[1]!,source:fixtures[1]!.source.replace('#define f g\n',directive).replace('caller()!=2','caller()!=1')};
  const g=open(project(f));await g.indexAll();await verify(g,f);
});

it('does not treat a non-invoked function-like macro as an expanded member name',async()=>{
  const f={...fixtures[1]!,expected:'int run(int (C::*p)(int))',source:fixtures[1]!.source.replace('#define f g','#define f(x) g(x)').replace('caller()!=2','caller()!=1')};
  const g=open(project(f));await g.indexAll();await verify(g,f);
});

it('checks an intermediate component of an absolute member name for macros',async()=>{
  const f={...fixtures[1]!,source:'namespace real { struct C {int f(int x){return x;} }; }\n'
    +'namespace different { struct C {int f(double x){return int(x);} }; }\n'
    +'#define MAKE() int run(int (real::C::*p)(int)){return 1;} int run(int (different::C::*p)(double)){return 2;}\nMAKE()\n'
    +'#define real different\nint caller(){return run(&::real::C::f);}\nint main(){return caller()!=2;}\n'};
  const g=open(project(f));await g.indexAll();await verify(g,f);
});

it('checks the final member component even in an absolute address',async()=>{
  const f={...fixtures[1]!,source:fixtures[1]!.source.replace('&C::f','&::C::f')};
  const g=open(project(f));await g.indexAll();await verify(g,f);
});

it('keeps object-macro applicability uncertain when its definition follows the call',async()=>{
  const f={...fixtures[1]!,source:fixtures[1]!.source.replace('#define f g\n','')
    .replace('int main()','#define f g\nint main()').replace('caller()!=2','caller()!=1')};
  const g=open(project(f));await g.indexAll();await verify(g,f);
});

it('keeps static member callees supported without an implicit object',async()=>{
  const f:Fixture={name:'static callees',file:'static.cpp',expected:'int run(int (*p)(int))',legacy:null,
    source:'int f(int x){return x;}\nstruct C {\n#define MAKE() static int run(int (*p)(double)){return 1;} static int run(int (*p)(int)){return 2;}\nMAKE()\n};\nint caller(){return C::run(&::f);}\nint main(){return caller()!=2;}\n'};
  const g=open(project(f));await g.indexAll();await verify(g,f);
});

it('still selects bool for a bool value, rather than a function address',async()=>{
  const f={...fixtures[3]!,expected:'int run(bool p)',source:fixtures[3]!.source.replace('run(&f)','run(true)').replace('caller()!=2','caller()!=1')};
  const g=open(project(f));await g.indexAll();await verify(g,f);
});

it('keeps conversion-only callback evidence unresolved',async()=>{
  const f:Fixture={name:'noexcept conversion',file:'convert.cpp',expected:null,legacy:null,
    source:'struct C { int f(int x){return x;} };\nint f(int x) noexcept {return x;}\n#define MAKE() int run(int (C::*p)(int)){return 1;} int run(int (*p)(int)){return 2;}\nMAKE()\nint caller(){return run(&::f);}\nint main(){return caller()!=2;}\n'};
  const g=open(project(f));await g.indexAll();await verify(g,f);
});
