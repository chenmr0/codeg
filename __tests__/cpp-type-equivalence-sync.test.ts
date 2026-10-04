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
type Fixture = {name:string; symbol:string; source:string; type?:string; variable?:string;
 kind?:'function'|'method'|'variable'; count?:number};
const cases: Fixture[] = [
 {name:'unicode_enum',symbol:'object',source:'enum class 状态 { ON };\n状态 object(状态::ON);\n', type:'状态'},
 {name:'unicode_member',symbol:'object',source:'enum class Mode { 启用 };\nMode object(Mode::启用);\n', type:'Mode'},
 {name:'unicode_namespace',symbol:'object',source:'namespace 状态空间 { enum class Mode { ON }; }\n状态空间::Mode object(状态空间::Mode::ON);\n',type:'状态空间::Mode'},
 {name:'same_scope_using',symbol:'object',source:'enum class Mode { ON };\nusing ::Mode;\nMode object(Mode::ON);\n',type:'Mode'},
 {name:'same_namespace_using',symbol:'object',source:'namespace actual {\nenum class Mode { ON };\nusing actual::Mode;\nMode object(actual::Mode::ON);\n}\n',type:'actual::Mode',variable:'actual::object'},
 {name:'nested_builtin_renamed',symbol:'run',source:'int identity(int x) { return x; }\n#define MAKE() template<class T> auto run(T) -> int (*)(signed); template<class U> auto run(U) -> int (*)(int) { return identity; }\nMAKE()\nint main() { return run(1)(7) == 7 ? 0 : 1; }\n'},
 {name:'nested_builtin_same_name',symbol:'run',source:'int identity(int x) { return x; }\n#define MAKE() template<class T> auto run(T) -> int (*)(signed); template<class T> auto run(T) -> int (*)(int) { return identity; }\nMAKE()\nint main() { return run(1)(7) == 7 ? 0 : 1; }\n'},
 {name:'return_alias',symbol:'run',source:'using Int = int;\n#define MAKE() template<class T> Int run(T); template<class U> int run(U) { return 1; }\nMAKE()\nint main() { return run(1) == 1 ? 0 : 1; }\n'},
 {name:'nested_return_alias',symbol:'run',source:'using Int = int;\nint identity(int x) { return x; }\n#define MAKE() template<class T> auto run(T) -> int (*)(Int); template<class U> auto run(U) -> int (*)(int) { return identity; }\nMAKE()\nint main() { return run(1)(7) == 7 ? 0 : 1; }\n'},
 {name:'return_qualification',symbol:'run',source:'struct C {};\n#define MAKE() template<class T> C run(T); template<class U> ::C run(U) { return {}; }\nMAKE()\nint main() { C value = run(1); return 0; }\n'},
 {name:'template_alias_binding',symbol:'run',count:2,source:'#define MAKE() struct A { using type = int; }; struct B { using type = double; }; template<class T> using Select = typename T::type; using Current = A; using Result = Select<Current>; namespace inner { using Current = B; constexpr int run(Result) { return 1; } constexpr int run(Select<Current>) { return 2; } }\nMAKE()\nstatic_assert(inner::run(1) == 1);\nstatic_assert(inner::run(1.0) == 2);\n'},
 {name:'array_alias_binding',symbol:'run',count:2,source:'#define MAKE() constexpr int N = 2; using Result = int (*)[N]; namespace inner { constexpr int N = 3; constexpr int run(Result) { return 1; } constexpr int run(int (*value)[N]) { return 2; } }\nMAKE()\nstatic_assert(inner::run(static_cast<int(*)[2]>(nullptr)) == 1);\nstatic_assert(inner::run(static_cast<int(*)[3]>(nullptr)) == 2);\n'},
 ...[
  ['inline_namespace','namespace local {\ninline namespace v1 { using Number = double; }\n','\n}','local'],
  ['anonymous_namespace','namespace local {\nnamespace { using Number = double; }\n','\n}','local'],
  ['inherited_alias','struct Base { using Number = double; };\nstruct Derived : Base {\n','\n};','Derived'],
 ].map(([name,prefix,suffix,owner]): Fixture => ({name:name!,symbol:'run',count:2,
  kind:name==='inherited_alias'?'method':'function',
  source:'#define MAKE() template<class T> static constexpr int run(Number) { return 1; } template<class U> static constexpr int run(int) { return 2; }\n'
   +`using Number = int;\n${prefix}MAKE()${suffix}\nstatic_assert(${owner}::run<void>(1.0) == 1);\nstatic_assert(${owner}::run<void>(1) == 2);\n`,
 })),
];

const roots: string[] = [];
const graphs: CodeGraph[] = [];
afterEach(()=>{
 for(const graph of graphs.splice(0)) graph.close();
 for(const root of roots.splice(0)) fs.rmSync(root,{recursive:true,force:true});
});
function project(source: string) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cg-type-equivalence-')); roots.push(root);
 fs.writeFileSync(path.join(root,'sample.cpp'),source); return root;
}
function verifyNodes(fixture: Fixture, nodes: any[]) {
 const object = fixture.name.startsWith('unicode_') || fixture.name.startsWith('same_');
 expect(nodes).toHaveLength(fixture.count ?? 1);
 for(const node of nodes) {
  expect(node.kind).toBe(fixture.kind ?? (object ? 'variable' : 'function'));
  expect(node.isDeclaration).not.toBe(true);
 }
}
for(const fixture of cases) {
 it(`extracts the correct identities for ${fixture.name}`,()=>{
  const context=scanMacroContribution(fixture.source);
  const result=extractFromSource('sample.cpp',fixture.source,'cpp',undefined,new Set(context.names),new Set(context.bodyless),selectUnambiguousCppMacroDefinitions(context.definitions));
  expect(result.errors).toEqual([]);
  verifyNodes(fixture,result.nodes.filter(n=>n.name===fixture.symbol));
 });
 it(`persists ${fixture.name} across MCP, reopen and changed-file sync`,async()=>{
  const root=project(fixture.source);
  let graph=CodeGraph.initSync(root); graphs.push(graph);
  const indexed=await graph.indexAll(); expect(indexed.complete).toBe(true); expect(indexed.errors).toEqual([]);
  const verify=async()=>{
   const nodes=graph.getNodesByName(fixture.symbol); verifyNodes(fixture,nodes);
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
