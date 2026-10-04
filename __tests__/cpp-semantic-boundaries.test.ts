import {afterEach,beforeAll,expect,it} from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {extractFromSource} from '../src/extraction/tree-sitter';
import {loadGrammarsForLanguages} from '../src/extraction/grammars';
import {scanMacroContribution} from '../src/extraction/macro-scan';
import {selectUnambiguousCppMacroDefinitions} from '../src/extraction/declaration-macros';
import CodeGraph from '../src/index';
import {ToolHandler} from '../src/mcp/tools';
beforeAll(()=>loadGrammarsForLanguages(['cpp']));
const cases = [
 {name:'using_same_enum', symbol:'object', source:'enum class Mode { ON };\nnamespace local {\nusing ::Mode;\nMode object(Mode::ON);\n}\nint main() { return local::object == Mode::ON ? 0 : 1; }'},
 {name:'using_enum', symbol:'object', source:'enum class Mode { ON };\nnamespace local {\nusing enum ::Mode;\nMode object(Mode::ON);\n}\nint main() { return local::object == Mode::ON ? 0 : 1; }'},
 {name:'member_pointer', symbol:'run', source:'struct C { int member(int) { return 1; } };\nstruct D { int member(int) { return 2; } };\n#define MAKE() int run(int (C::*p)(int)) { return 1; } int run(int (D::*p)(int)) { return 2; }\nMAKE()\nint main() { return run(&C::member) == 1 && run(&D::member) == 2 ? 0 : 1; }'},
 {name:'member_vs_function_pointer', symbol:'run', source:'struct C { int member(int) { return 1; } };\nint ordinary(int) { return 0; }\n#define MAKE() int run(int (C::*p)(int)) { return 1; } int run(int (*p)(int)) { return 2; }\nMAKE()\nint main() { return run(&C::member) == 1 && run(&ordinary) == 2 ? 0 : 1; }'},
 {name:'dependent_return', symbol:'run', source:'struct A { using type = int; };\nstruct B { using other = int; };\n#define MAKE() template<class T> typename T::type run(T) { return 1; } template<class U> typename U::other run(U) { return 2; }\nMAKE()\nint main() { return run(A{}) == 1 && run(B{}) == 2 ? 0 : 1; }'},
 {name:'trailing_return', symbol:'run', source:'struct A { using type = int; };\nstruct B { using other = int; };\n#define MAKE() template<class T> auto run(T) -> typename T::type { return 1; } template<class U> auto run(U) -> typename U::other { return 2; }\nMAKE()\nint main() { return run(A{}) == 1 && run(B{}) == 2 ? 0 : 1; }'},
 {name:'same_name_dependent_return', symbol:'run', source:'struct A { using type = int; };\nstruct B { using other = int; };\n#define MAKE() template<class T> typename T::type run(T) { return 1; } template<class T> typename T::other run(T) { return 2; }\nMAKE()\nint main() { return run(A{}) == 1 && run(B{}) == 2 ? 0 : 1; }'},
 {name:'data_member_default', symbol:'run', source:'struct C { int value; };\n#define MAKE() int run(int C::*p = nullptr); int run(int C::*p) { return 1; }\nMAKE()\nint main() { return run() == 1 ? 0 : 1; }'},
 {name:'using_multiple', symbol:'api', source:'enum class Mode { ON };\nnamespace actual { struct Other {}; struct Mode { using ON = int; }; }\nnamespace local {\nusing actual::Other, actual::Mode;\nint api(Mode::ON);\n}\nint caller() { return local::api(1); }'},
 {name:'using_directive', symbol:'api', source:'enum class Mode { ON };\nnamespace local {\nnamespace actual { struct Mode { using ON = int; }; }\nusing namespace actual;\nint api(Mode::ON);\n}\nint caller() { return local::api(1); }'},
];

const roots: string[] = [];
const graphs: CodeGraph[] = [];
afterEach(()=>{
 for(const graph of graphs.splice(0)) graph.close();
 for(const root of roots.splice(0)) fs.rmSync(root,{recursive:true,force:true});
});
function project(source: string) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cg-semantic-boundary-')); roots.push(root);
 fs.writeFileSync(path.join(root,'sample.cpp'),source); return root;
}
function verifyNodes(name: string, nodes: any[]) {
 const count = name.includes('pointer') || name.includes('return') ? 2 : 1;
 const kind = name.startsWith('using_') && name !== 'using_multiple' && name !== 'using_directive' ? 'variable' : 'function';
 expect(nodes).toHaveLength(count);
 expect(nodes.every(n=>n.kind===kind)).toBe(true);
 if(name!=='using_multiple' && name!=='using_directive') expect(nodes.every(n=>!n.isDeclaration)).toBe(true);
}
for(const fixture of cases) {
 it(`extracts the correct identities for ${fixture.name}`,()=>{
  const context=scanMacroContribution(fixture.source);
  const result=extractFromSource('sample.cpp',fixture.source,'cpp',undefined,new Set(context.names),new Set(context.bodyless),selectUnambiguousCppMacroDefinitions(context.definitions));
  expect(result.errors).toEqual([]);
  verifyNodes(fixture.name,result.nodes.filter(n=>n.name===fixture.symbol));
 });
 it(`persists ${fixture.name} across MCP, reopen and changed-file sync`,async()=>{
  const root=project(fixture.source);
  let graph=CodeGraph.initSync(root); graphs.push(graph);
  const indexed=await graph.indexAll(); expect(indexed.complete).toBe(true); expect(indexed.errors).toEqual([]);
  const verify=async()=>{
   const nodes=graph.getNodesByName(fixture.symbol); verifyNodes(fixture.name,nodes);
   expect(graph.searchNodes(fixture.symbol,{kinds:[nodes[0]!.kind]})).toHaveLength(nodes.length);
   const output=JSON.stringify(await new ToolHandler(graph).execute('node',{symbol:fixture.symbol,includeCode:true}));
   if(fixture.name!=='using_multiple' && fixture.name!=='using_directive') expect(output).not.toContain('No indexed definition');
   if(nodes.length===2) expect(output).toContain('2 definitions named');
  };
  await verify(); graph.close(); graphs.pop(); graph=CodeGraph.openSync(root); graphs.push(graph); await verify();
  expect((await graph.sync()).filesModified).toBe(0);
  fs.appendFileSync(path.join(root,'sample.cpp'),'\nint unrelated() { return 0; }\n');
  expect((await graph.sync({paths:['sample.cpp']})).filesErrored).toBe(0); await verify();
  const snapshot=(cg: CodeGraph)=>{
   const db=(cg as any).db.db;
   return {nodes:db.prepare('SELECT id,kind,name,signature,is_declaration FROM nodes ORDER BY id').all(),
    edges:db.prepare('SELECT source,target,kind,line,col,provenance FROM edges ORDER BY source,target,kind,line,col,provenance').all()};
  };
  const fresh=CodeGraph.initSync(project(fs.readFileSync(path.join(root,'sample.cpp'),'utf8'))); graphs.push(fresh); await fresh.indexAll();
  expect(snapshot(graph)).toEqual(snapshot(fresh));
 },30000);
}