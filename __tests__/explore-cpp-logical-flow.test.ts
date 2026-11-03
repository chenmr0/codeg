import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src';
import { ToolHandler } from '../src/mcp/tools';
import { createUpstreamExploreGraph } from '../src/mcp/upstream-explore-adapter';
import { resolveNamedSymbolFlow } from '../src/upstream-explore/graph/named-symbol-flow';
import { cppLogicalCallTarget } from '../src/upstream-explore/graph/cpp-logical-calls';
import type { ExploreGraph } from '../src/upstream-explore';
import type { Edge, Node } from '../src/upstream-explore/types';

const roots: string[] = [];
const opened: CodeGraph[] = [];
afterEach(() => { for (const g of opened.splice(0)) g.close(); for (const r of roots.splice(0)) fs.rmSync(r, {recursive:true,force:true}); vi.unstubAllEnvs(); });

describe('proven C/C++ prototype identities in named Flow', () => {
  it('preserves raw-family owner admission before collapsing real overload pairs', async () => {
    vi.stubEnv('CODEGRAPH_ENABLE_EXPLORE','1'); vi.stubEnv('CODEGRAPH_NO_DAEMON','1');
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'cg-logical-owners-')); roots.push(root);
    fs.writeFileSync(path.join(root,'api.h'),[
      'class Worker { public: int stepFlow(int value); int stepFlow(const char *value); };',
      'class Other { public: int stepFlow(int value); };','',
    ].join('\n'));
    fs.writeFileSync(path.join(root,'api.cpp'),[
      '#include "api.h"','int Worker::stepFlow(int value) { return value + 1; }',
      'int Worker::stepFlow(const char *value) { return value ? 2 : 0; }',
      'int Other::stepFlow(int value) { return value + 3; }',
      'int otherFlow(int value) { return value + 4; }','',
    ].join('\n'));
    let cg=CodeGraph.initSync(root); await cg.indexAll(); cg.close();
    cg=CodeGraph.openSync(root); opened.push(cg); const graph=createUpstreamExploreGraph(cg);
    expect(graph.getNodesByName('stepFlow')).toHaveLength(6);
    const scoped=resolveNamedSymbolFlow(graph,'Worker stepFlow otherFlow');
    const picked=(scoped.tokenNodes.get('stepFlow')??[]).map(id=>graph.getNode(id)!);
    expect(picked).toHaveLength(2);
    expect(picked.every(n=>n.qualifiedName.includes('Worker::') && !n.isDeclaration)).toBe(true);
    expect(resolveNamedSymbolFlow(graph,'stepFlow otherFlow').tokenNodes.get('stepFlow')).toEqual([]);
    const response=await new ToolHandler(cg).execute('explore',{query:'Worker stepFlow otherFlow',maxFiles:2});
    expect(response.isError).not.toBe(true);
    const narrative=response.content[0]!.text.split('**Exploration:')[0]!;
    expect(narrative).toContain('Worker.stepFlow');
    expect(narrative).not.toContain('Other.stepFlow');
  },30000);

  it('retains an incoming native override link when its derived prototype is named', async () => {
    vi.stubEnv('CODEGRAPH_ENABLE_EXPLORE', '1'); vi.stubEnv('CODEGRAPH_NO_DAEMON', '1');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-logical-override-')); roots.push(root);
    fs.writeFileSync(path.join(root,'api.h'), [
      'class Base { public: virtual int runFlow(int value); };',
      'class Derived : public Base { public: int runFlow(int value) override; };', '',
    ].join('\n'));
    fs.writeFileSync(path.join(root,'api.cpp'), [
      '#include "api.h"', 'int Derived::runFlow(int value) { return value + 1; }',
      'int otherFlow(int value) { return value + 2; }', '',
    ].join('\n'));
    let cg = CodeGraph.initSync(root); await cg.indexAll(); cg.close();
    cg = CodeGraph.openSync(root); opened.push(cg);
    const graph = createUpstreamExploreGraph(cg);
    const declaration = graph.getNodesByName('runFlow').find(n=>n.isDeclaration && n.qualifiedName.includes('Derived'))!;
    expect(declaration).toBeDefined();
    const before = graph.getIncomingEdges(declaration.id);
    expect(before.some(e=>e.kind==='calls' && e.metadata?.synthesizedBy==='cpp-override')).toBe(true);
    expect(before.some(e=>e.kind==='defines' && e.metadata?.synthesizedBy==='cpp-decl-def')).toBe(true);
    expect(cppLogicalCallTarget(graph)(declaration)).toBe(declaration);
    const flow=resolveNamedSymbolFlow(graph,'Derived::runFlow otherFlow');
    expect(flow.named.has(declaration.id)).toBe(true);
    const result=await new ToolHandler(cg).execute('explore',{query:'Derived::runFlow otherFlow',maxFiles:2});
    expect(result.isError).not.toBe(true);
    expect(result.content[0]!.text).toContain('cpp override');
    expect(result.content[0]!.text).toContain('Base.runFlow → Derived.runFlow   [dynamic: cpp override @api.h:2]');
    expect(graph.getIncomingEdges(declaration.id)).toEqual(before);
  }, 30000);

  it.each(['c', 'cpp'])('continues a real indexed %s call through its prototype without another hop', async language => {
    vi.stubEnv('CODEGRAPH_ENABLE_EXPLORE', '1');
    vi.stubEnv('CODEGRAPH_NO_DAEMON', '1');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-logical-flow-')); roots.push(root);
    const cpp = language === 'cpp';
    fs.writeFileSync(path.join(root, 'api.h'), cpp ? 'class Worker { public: static int stepFlow(int value); };\n' : 'int stepFlow(int value);\n');
    fs.writeFileSync(path.join(root, `api.${language}`), `#include "api.h"\nint finishFlow(int value) { return value + 1; }\nint ${cpp ? 'Worker::' : ''}stepFlow(int value) { return finishFlow(value); }\n`);
    fs.writeFileSync(path.join(root, `driver.${language}`), `#include "api.h"\nint startFlow(int value) {\n  if (value > 0) {\n    return ${cpp ? 'Worker::' : ''}stepFlow(value);\n  }\n  return 0;\n}\n`);
    let cg = CodeGraph.initSync(root); await cg.indexAll(); cg.close();
    cg = CodeGraph.openPortableRaw(root, path.join(root,'.codegraph-wx','codegraph.db'), false);
    let graph = createUpstreamExploreGraph(cg);
    const declaration = graph.getNodesByName('stepFlow').find(n => n.isDeclaration)!;
    const definition = graph.getNodesByName('stepFlow').find(n => !n.isDeclaration)!;
    const caller = graph.getNodesByName('startFlow')[0]!;
    expect(declaration).toBeDefined(); expect(definition).toBeDefined();
    const calls = graph.getOutgoingEdges(caller.id).filter(e => e.kind === 'calls' && graph.getNode(e.target)?.name === 'stepFlow');
    expect(calls.length).toBeGreaterThan(0);
    // Both native target choices are legitimate. Pin the real parsed call to
    // the header without fabricating a call or changing its source location.
    for (const edge of calls) cg.getExploreQueryConnection().prepare("UPDATE edges SET target = ? WHERE source = ? AND target = ? AND kind = 'calls' AND line = ?")
      .run(declaration.id, caller.id, edge.target, edge.line);
    cg.close(); cg = CodeGraph.openSync(root); opened.push(cg); graph = createUpstreamExploreGraph(cg);
    const before = graph.getOutgoingEdges(caller.id);
    const flow = resolveNamedSymbolFlow(graph, 'startFlow stepFlow finishFlow', {maxHops:3,maxBridge:0});
    expect(flow.chains[0]?.steps.map(s => s.node.name)).toEqual(['startFlow','stepFlow','finishFlow']);
    expect(flow.chains[0]?.steps[1]?.node.id).toBe(definition.id);
    expect(flow.chains[0]?.steps[1]?.edge).toEqual(before.find(e => e.kind === 'calls' && e.target === declaration.id));
    expect(flow.chains[0]?.steps[1]?.edge?.line).toBe(4);
    expect(flow.chains[0]?.steps[1]?.edge?.column).toBe(calls[0]!.column);
    expect(flow.chains[0]?.callSites.get(caller.id)).toBe(calls[0]!.line);
    const result = await new ToolHandler(cg).execute('explore', {query:'startFlow stepFlow finishFlow', maxFiles:3});
    expect(result.isError).not.toBe(true);
    expect(result.content[0]!.text).toContain('**Flow (call path among the symbols you queried)**');
    expect(result.content[0]!.text).toMatch(/↓ calls \(when .*value > 0/);
    expect(graph.getOutgoingEdges(caller.id)).toEqual(before);
    expect(resolveNamedSymbolFlow(graph, 'startFlow stepFlow finishFlow', {maxHops:2}).chains[0]?.steps.length).toBeLessThanOrEqual(2);
    expect(resolveNamedSymbolFlow(graph, '', {mode:'directed',from:'startFlow',to:'finishFlow'}).chains).toEqual([]);
  }, 30000);

  it('fails closed for dispatch-bearing declarations, ambiguous definitions and cv overloads', () => {
    const node = (id:string, declaration:boolean, signature='int run(int value)'): Node => ({id,name:'run',kind:'method',language:'cpp',qualifiedName:'Worker::run',filePath:declaration?'api.h':`${id}.cpp`,startLine:1,endLine:3,startColumn:0,endColumn:1,isDeclaration:declaration,signature} as Node);
    const decl=node('decl',true), def=node('def',false), alt=node('alt',false);
    const nodes=new Map([decl,def,alt].map(n=>[n.id,n]));
    let edges: Edge[]=[{source:def.id,target:decl.id,kind:'defines',metadata:{synthesizedBy:'cpp-decl-def'}}];
    const graph={getNode:(id:string)=>nodes.get(id), getIncomingEdges:(id:string)=>edges.filter(e=>e.target===id),getOutgoingEdges:(id:string)=>edges.filter(e=>e.source===id)} as ExploreGraph;
    expect(cppLogicalCallTarget(graph)(decl)).toBe(def);
    edges.push({source:decl.id,target:alt.id,kind:'calls',provenance:'heuristic'});
    expect(cppLogicalCallTarget(graph)(decl)).toBe(decl);
    edges=edges.slice(0,1); edges.push({source:alt.id,target:decl.id,kind:'defines',metadata:{synthesizedBy:'cpp-decl-def'}});
    expect(cppLogicalCallTarget(graph)(decl)).toBe(decl);
    edges=edges.slice(0,1); def.signature='int run(int value) const';
    expect(cppLogicalCallTarget(graph)(decl)).toBe(decl);
    def.signature='int run(const char *value)';
    expect(cppLogicalCallTarget(graph)(decl)).toBe(decl);
    def.signature='int run(int value)'; edges[0]!.metadata={synthesizedBy:'untrusted'};
    expect(cppLogicalCallTarget(graph)(decl)).toBe(decl);
  });

  it('keeps two proven overload pairs distinct rather than joining their routes', () => {
    const make = (id:string, name:string, declaration=false, stringArg=false): Node => ({
      id,name,kind:'method',language:'cpp',qualifiedName:`Worker::${name}`,
      filePath:declaration?'api.h':`${id}.cpp`,startLine:1,endLine:3,
      signature:`int ${name}(${stringArg?'const char *':'int '}value)`,isDeclaration:declaration,
    } as Node);
    const nodes=[make('start','startFlow'),make('d1','stepFlow',true),make('f1','stepFlow'),
      make('d2','stepFlow',true,true),make('f2','stepFlow',false,true),make('end1','finishInt'),make('end2','finishText'),
      {...make('owner','Worker'),kind:'class' as const}];
    const edges:Edge[]=[{source:'start',target:'d1',kind:'calls',line:2},
      {source:'f1',target:'d1',kind:'defines',metadata:{synthesizedBy:'cpp-decl-def'}},
      {source:'f2',target:'d2',kind:'defines',metadata:{synthesizedBy:'cpp-decl-def'}},
      {source:'f1',target:'end1',kind:'calls',line:2},{source:'f2',target:'end2',kind:'calls',line:2}];
    const graph={getNode:(id:string)=>nodes.find(n=>n.id===id),getNodesByName:(name:string)=>nodes.filter(n=>n.name===name),
      generatedFilePredicate:()=>()=>false,getIncomingEdges:(id:string)=>edges.filter(e=>e.target===id),getOutgoingEdges:(id:string)=>edges.filter(e=>e.source===id),
      getCallees:(id:string)=>edges.filter(e=>e.source===id&&e.kind==='calls').map(edge=>({edge,node:nodes.find(n=>n.id===edge.target)!})),
    } as unknown as ExploreGraph;
    const flow=resolveNamedSymbolFlow(graph,'Worker startFlow stepFlow finishInt finishText',{maxChains:4});
    expect(flow.tokenNodes.get('stepFlow')).toEqual(['f1','f2']);
    expect(flow.chains.some(c=>c.steps.map(s=>s.node.id).join(',')==='start,f1,end1')).toBe(true);
    expect(flow.chains.some(c=>c.steps[0]?.node.id==='start' && c.steps.some(s=>s.node.id==='end2'))).toBe(false);
    // The identity view must not reinterpret similarly shaped non-C-family
    // nodes or their edges. They retain the original split route.
    for (const n of nodes) n.language='typescript';
    const unchanged=resolveNamedSymbolFlow(graph,'Worker startFlow stepFlow finishInt finishText',{maxChains:4});
    expect(unchanged.chains.some(c=>c.steps[0]?.node.id==='start' && c.steps.some(s=>s.node.id==='end1'))).toBe(false);
    expect(cppLogicalCallTarget(graph)(nodes[1]!)).toBe(nodes[1]);
  });
});
