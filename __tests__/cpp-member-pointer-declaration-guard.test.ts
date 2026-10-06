import {afterEach, beforeAll, expect, it} from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
import {ToolHandler} from '../src/mcp/tools';
import {extractFromSource} from '../src/extraction/tree-sitter';
import {loadGrammarsForLanguages} from '../src/extraction/grammars';

const roots:string[]=[], graphs:CodeGraph[]=[];
beforeAll(async()=>{await loadGrammarsForLanguages(['cpp']);});
afterEach(()=>{for(const g of graphs.splice(0))g.close();for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
function project(source:string){const root=fs.mkdtempSync(path.join(os.tmpdir(),'cg-member-guard-'));roots.push(root);fs.writeFileSync(path.join(root,'api.cpp'),source);return root;}
function open(root:string,existing=false){const g=existing?CodeGraph.openSync(root):CodeGraph.initSync(root);graphs.push(g);return g;}
function snapshot(g:CodeGraph){return Object.fromEntries(['nodes','edges','unresolved_refs','files'].map(table=>[table,(g as any).db.db.prepare(`SELECT * FROM ${table}`).all().map((row:any)=>Object.fromEntries(Object.keys(row).sort().filter(k=>!['updated_at','modified_at','indexed_at'].includes(k)&&!(['edges','unresolved_refs'].includes(table)&&k==='id')).map(k=>[k,row[k]]))).sort((a:any,b:any)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))]));}
const variants=[
 ['namespace-internal','namespace N { struct C {int value;};\nstruct Holder {static int C::*ptr; int f(int x){return x;}};','C','Holder'],
 ['plain','struct C {int value;};\nstruct Holder {static int C::*ptr; int f(int x){return x;}};','C','Holder'],
 ['namespace','namespace N {struct C {int value;}; struct Holder {static int C::*ptr; int f(int x){return x;}};}','N::C','N::Holder'],
] as const;
for(const [label,types,c,h] of variants){
 const signature=`int run(int (${h}::*p)(int))`;
 const source=`${types}\nint ${c}::*${h}::ptr = &${c}::value;\n#define MAKE() ${signature}{return 1;} int run(int (${c}::*p)(int)){return 2;}\nMAKE()\nint caller(){return run(&${h}::f);}\n${label==='namespace-internal'?'}\nint main(){return N::caller()!=1;}':'int main(){return caller()!=1;}'}\n`;
 async function verify(g:CodeGraph){
  expect(g.getNodesByName('Holder').map(n=>n.kind)).toEqual(['struct']);
  const calls=(g as any).db.db.prepare("SELECT t.signature FROM edges e JOIN nodes s ON s.id=e.source JOIN nodes t ON t.id=e.target WHERE e.kind='calls' AND s.name='caller' AND t.name='run'").all();
  // Namespace-internal macro overload lookup is also unresolved in the baseline.
  expect(calls).toEqual(label==='namespace-internal'?[]:[{signature}]);
  expect(JSON.stringify(await new ToolHandler(g).execute('callers',{symbol:'run',signature}))).toContain(label==='namespace-internal'?'No callers found':'- caller (function)');
 }
 it(`${label}: rejects the owner pseudo-variable and preserves callers through sync and fresh`,async()=>{
  const root=project(source);let g=open(root);expect((await g.indexAll()).complete).toBe(true);await verify(g);
  g.close();graphs.pop();g=open(root,true);await verify(g);expect((await g.sync()).complete).toBe(true);await verify(g);
  const changed=source+'\nint unrelated(){return 0;}\n';fs.writeFileSync(path.join(root,'api.cpp'),changed);
  expect((await g.sync()).complete).toBe(true);await verify(g);
  const fresh=open(project(changed));expect((await fresh.indexAll()).complete).toBe(true);await verify(fresh);expect(snapshot(g)).toEqual(snapshot(fresh));
 },30000);
}
it.each([
 ['uninitialized data pointer','struct C {int value;}; int C::*ptr;'],
 ['initialized data pointer','struct C {int value;}; int C::*ptr = &C::value;'],
 ['function member pointer','struct C {int f(int);}; int (C::*ptr)(int) = &C::f;'],
 ['ordinary pointer','int value; int *ptr = &value;'],
])('preserves a complete %s declaration',(_,source)=>{
 const result=extractFromSource('api.cpp',source,'cpp');expect(result.nodes.find(n=>n.name==='ptr')?.kind).toBe('variable');
});
it.each([
 ['missing declaration terminator','struct C {}; int C::*ptr'],
 ['missing nested initializer delimiter','struct C {}; int C::*ptr = (nullptr;'],
])('rejects a type-identifier name with a %s',(_,source)=>{
 const result=extractFromSource('api.cpp',source,'cpp');
 expect(result.nodes.some(n=>n.name==='ptr'&&n.kind==='variable')).toBe(false);
});
it('does not let an error in a different declaration suppress a complete member pointer',()=>{
 const result=extractFromSource('api.cpp','struct C {}; int C::*ptr; int ordinary =','cpp');
 expect(result.nodes.find(n=>n.name==='ptr')?.kind).toBe('variable');
});
it('checks the complete declaration while retaining ordinary identifier recovery',()=>{
 const result=extractFromSource('api.cpp','struct C {}; int C::*ptr, ordinary = (0;','cpp');
 expect(result.nodes.some(n=>n.name==='ptr'&&n.kind==='variable')).toBe(false);
 expect(result.nodes.find(n=>n.name==='ordinary')?.kind).toBe('variable');
});
