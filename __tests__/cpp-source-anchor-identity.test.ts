import { afterEach, beforeAll, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
import { extractFromSource } from '../src/extraction/tree-sitter';
import { loadGrammarsForLanguages } from '../src/extraction/grammars';

const roots: string[] = [], graphs: CodeGraph[] = [];
beforeAll(async () => { await loadGrammarsForLanguages(['c', 'cpp']); });
afterEach(() => {
  for (const graph of graphs.splice(0)) graph.close();
  for (const root of roots.splice(0)) fs.rmSync(root, {recursive:true, force:true});
});
const bindings = [
  ['using namespace actual;', 'Mode'],
  ['using actual::Mode;', 'Mode'],
  ['namespace view=actual;', 'view::Mode'],
];
it.each(bindings)('keeps a same-line nested namespace separate after %s', (binding, type) => {
  const source = `namespace actual { enum class Mode { ON }; } namespace local { ${binding} namespace actual { struct Mode { using ON=int; }; } ${type} object(${type}::ON); }`;
  const result = extractFromSource('api.cpp', source, 'cpp');
  expect(result.errors).toEqual([]);
  expect(result.nodes.filter(n => n.kind === 'namespace').map(n => n.qualifiedName))
    .toEqual(['actual', 'local', 'local::actual']);
  const modes = result.nodes.filter(n => n.name === 'Mode');
  expect(modes.map(n => n.qualifiedName)).toEqual(['actual::Mode', 'local::actual::Mode']);
  expect(new Set(result.nodes.map(n => n.id)).size).toBe(result.nodes.length);
  expect(result.nodes.find(n => n.qualifiedName === 'local::object')?.kind).toBe('variable');
});
it('retains same-line C++ overload declarations with distinct columns', () => {
  const result = extractFromSource('api.cpp', 'struct C {static int f(int); int f(double);};', 'cpp');
  const methods = result.nodes.filter(n => n.qualifiedName === 'C::f');
  expect(methods).toHaveLength(2);
  expect(new Set(methods.map(n => n.id)).size).toBe(2);
  expect(methods.map(n => n.isStatic)).toEqual([true, false]);
});
it('persists both overloads through reopen, changed sync, and fresh indexing', async () => {
  const source = 'struct C {static int f(int); int f(double);};\n';
  function open(contents: string) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-anchor-identity-')); roots.push(root);
    fs.writeFileSync(path.join(root, 'api.cpp'), contents);
    const g = CodeGraph.initSync(root); graphs.push(g); return g;
  }
  let g = open(source); expect((await g.indexAll()).complete).toBe(true);
  const before = g.getNodesByName('f').map(n => ({id:n.id, qualifiedName:n.qualifiedName, signature:n.signature, isStatic:n.isStatic}));
  expect(before).toHaveLength(2);
  const root = g.getProjectRoot(); g.close(); graphs.pop();
  g = CodeGraph.openSync(root); graphs.push(g);
  expect((await g.sync()).filesModified).toBe(0);
  const changed = source + 'int unrelated(){return 0;}\n';
  fs.writeFileSync(path.join(root, 'api.cpp'), changed);
  expect((await g.sync()).complete).toBe(true);
  const facts = (graph:CodeGraph) => graph.getNodesByName('f').map(n => ({id:n.id, qualifiedName:n.qualifiedName, signature:n.signature, isStatic:n.isStatic}));
  expect(facts(g)).toEqual(before);
  const fresh = open(changed); expect((await fresh.indexAll()).complete).toBe(true);
  expect(facts(g)).toEqual(facts(fresh));
  expect((g as any).db.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

const macroOwners: Array<[string,string,string[],Array<[string,string]>]> = [
  ['namespace','#define MAKE() int f(){return 1;}\nnamespace N {\nMAKE()\n}\n',['N','N::f'],[['N','N::f']]],
  ['class','#define MAKE() int f(){return 1;}\nstruct C {\nMAKE()\n};\n',['C','C::f'],[['C','C::f']]],
  ['nested owners','#define MAKE() int f(){return 1;}\nnamespace N {\nstruct C {\nMAKE()\n};\n}\n',['N','N::C','N::C::f'],[['N','N::C'],['N::C','N::C::f']]],
  ['same-line namespace','#define MAKE() int f(){return 1;}\nnamespace N { MAKE() }\n',['N','N::f'],[['N','N::f']]],
  ['same-line class','#define MAKE() int f(){return 1;}\nstruct C { MAKE() };\n',['C','C::f'],[['C','C::f']]],
  ['variable','#define MAKE() int x=1;\nnamespace N {\nMAKE()\n}\n',['N','N::x'],[['N','N::x']]],
  ['generated nested type','#define TYPE(n) struct n\nTYPE(C)\n{\nstruct Inner { int nested; };\n};\n',['C','C::Inner','C::Inner::nested'],[['C','C::Inner'],['C::Inner','C::Inner::nested']]],
  ['generated type in namespace','#define TYPE(n) struct n\nnamespace N {\nTYPE(C)\n{\nint x;\nstruct Inner { int nested; };\n};\n}\n',['N','N::C','N::C::x','N::C::Inner','N::C::Inner::nested'],[['N','N::C'],['N::C','N::C::Inner'],['N::C::Inner','N::C::Inner::nested']]],
  ['generated child in source class','#define MAKE() struct Child { int generated; };\nstruct C {\nint x;\nMAKE()\n};\n',['C','C::x','C::Child','C::Child::generated'],[['C','C::Child'],['C::Child','C::Child::generated']]],
];
it.each(macroOwners)('preserves exact macro/source containment without ghost owners: %s', async (_, source, names, relationships) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-anchor-macro-')); roots.push(root);
  fs.writeFileSync(path.join(root, 'api.cpp'), source);
  const graph=CodeGraph.initSync(root); graphs.push(graph);
  expect((await graph.indexAll()).complete).toBe(true);
  const db=(graph as any).db.db;
  const actual=db.prepare("SELECT qualified_name FROM nodes WHERE kind NOT IN ('file','macro','import') ORDER BY qualified_name").all().map((row:any)=>row.qualified_name);
  expect(actual).toEqual([...names].sort());
  const edges=db.prepare("SELECT s.qualified_name AS source,t.qualified_name AS target FROM edges e JOIN nodes s ON s.id=e.source JOIN nodes t ON t.id=e.target WHERE e.kind='contains'").all();
  for(const [from,to] of relationships)expect(edges).toContainEqual({source:from,target:to});
  for(const name of names.filter(n=>n.includes('::'))){
    const expectedOwner=name.slice(0,name.lastIndexOf('::'));
    expect(edges.filter((edge:any)=>edge.target===name).map((edge:any)=>edge.source)).toEqual([expectedOwner]);
  }
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});
