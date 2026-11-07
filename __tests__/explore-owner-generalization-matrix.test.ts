import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src';
import { ToolHandler as ProductionToolHandler, type ToolResult } from '../src/mcp/tools';
import * as adapter from '../src/mcp/upstream-explore-adapter';
import { ExploreSessionState } from '../src/upstream-explore/mcp/explore-session-state';
import { cppLogicalCallTarget } from '../src/upstream-explore/graph/cpp-logical-calls';
import { resolveNamedSymbolFlow } from '../src/upstream-explore/graph/named-symbol-flow';
import type { ExploreGraph } from '../src/upstream-explore';
import type { Node, Edge } from '../src/upstream-explore/types';

const method = (id: string, owner: string, extra: Partial<Node> = {}): Node => ({
  id, name: 'load_state', qualifiedName: `${owner}::load_state`, kind: 'method', language: 'cpp',
  filePath: `${id}.cpp`, startLine: 1, endLine: 5, startColumn: 0, endColumn: 1,
  signature: 'int load_state(int value)', isDeclaration: false, updatedAt: 0, ...extra,
});
const graphFixture = (extra: Edge[] = []) => {
  const decl = method('decl', 'Owner', {isDeclaration: true});
  const def = method('def', 'Owner');
  const start = method('start', 'Owner', {name:'startFlow', qualifiedName:'Owner::startFlow'});
  const end = method('end', 'Owner', {name:'endFlow', qualifiedName:'Owner::endFlow'});
  const nodes = [decl, def, start, end];
  const edges: Edge[] = [
    {source:'def',target:'decl',kind:'defines',provenance:'heuristic',metadata:{synthesizedBy:'cpp-decl-def'}},
    {source:'start',target:'decl',kind:'calls',line:3,column:7},
    {source:'def',target:'end',kind:'calls',line:4,column:9}, ...extra,
  ];
  const incoming = vi.fn((id:string) => edges.filter(e=>e.target===id));
  const outgoing = vi.fn((id:string) => edges.filter(e=>e.source===id));
  const graph = {
    getNode:(id:string)=>nodes.find(n=>n.id===id), getNodesByName:(name:string)=>nodes.filter(n=>n.name===name),
    generatedFilePredicate:()=>()=>false, getIncomingEdges:incoming, getOutgoingEdges:outgoing,
    getCallees:(id:string)=>edges.filter(e=>e.source===id&&e.kind==='calls').map(edge=>({edge,node:nodes.find(n=>n.id===edge.target)!})),
  } as unknown as ExploreGraph;
  return {graph,decl,def,nodes,edges,incoming,outgoing};
};
describe('logical Flow interaction and evidence matrix', () => {
  it('caches a proven target and leaves every stored edge untouched', () => {
    const {graph,decl,def,edges,incoming,outgoing} = graphFixture();
    const before = structuredClone(edges); const target = cppLogicalCallTarget(graph);
    expect(target(decl)).toBe(def);
    const counts = [incoming.mock.calls.length, outgoing.mock.calls.length];
    for(let i=0;i<100;i++) expect(target(decl)).toBe(def);
    expect([incoming.mock.calls.length,outgoing.mock.calls.length]).toEqual(counts);
    const flow=resolveNamedSymbolFlow(graph,'startFlow load_state endFlow',{maxHops:3,maxBridge:0});
    expect(flow.chains[0]?.steps.map(s=>s.node.id)).toEqual(['start','def','end']);
    expect(flow.chains[0]?.steps[1]?.edge).toEqual(edges[1]);
    expect(flow.chains[0]?.callSites.get('def')).toBe(4);
    expect(edges).toEqual(before);
  });
  it.each(['calls','references','defines','navigates'] as const)('preserves incoming heuristic %s evidence on the declaration', kind => {
    const {graph,decl} = graphFixture([{source:'end',target:'decl',kind,provenance:'heuristic',metadata:{synthesizedBy:'other-evidence'}}]);
    expect(cppLogicalCallTarget(graph)(decl)).toBe(decl);
    expect(resolveNamedSymbolFlow(graph,'startFlow load_state endFlow').named.has('decl')).toBe(true);
  });
  it.each(['java','typescript','csharp','go','rust'] as const)('does not connect split %s prototype-like nodes', language => {
    const {graph,nodes,decl} = graphFixture(); nodes.forEach(n=>{n.language=language;});
    expect(cppLogicalCallTarget(graph)(decl)).toBe(decl);
    const flow=resolveNamedSymbolFlow(graph,'startFlow load_state endFlow',{maxHops:3,maxBridge:0});
    expect(flow.chains.some(c=>c.steps[0]?.node.id==='start'&&c.steps.some(s=>s.node.id==='end'))).toBe(false);
  });
  it('fails closed when declaration adjacency is unavailable', () => {
    const {graph,decl,outgoing}=graphFixture(); outgoing.mockImplementation(()=>{throw new Error('unavailable');});
    expect(cppLogicalCallTarget(graph)(decl)).toBe(decl);
  });
});


// The co-named owner exact enhancement was withdrawn after holdout regressions.
// These tests cover retained Flow and empty-gather behavior, NOT complete
// oversized owner-method delivery. Weak-read completeness remains unresolved.
// Real production dispatch/index/source/renderer/session. Only ranked gather is
// fault-injected to empty; exact lookup and all subsequent stages stay real.
const integrationFixtures: Array<{root:string; cg:CodeGraph; handler:ProductionToolHandler}> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for(const f of integrationFixtures.splice(0)) { f.handler.closeAll(); f.cg.close(); fs.rmSync(f.root,{recursive:true,force:true}); }
  vi.unstubAllEnvs();
});
async function productionFixture() {
  vi.stubEnv('CODEGRAPH_ENABLE_EXPLORE','1'); vi.stubEnv('CODEGRAPH_NO_DAEMON','1'); vi.stubEnv('CODEGRAPH_EXPLORE_DEDUP','1');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cg-owner-combination-'));
  const params=Array.from({length:8},(_,i)=>`const int parameter_name_long_${i}`).join(', ');
  const header=`class ArchiveOwner { public: int load_state(${params}); };\n`;
  const body=`#include "owner.h"\nint ArchiveOwner::load_state(${params}) {\n int value=0;\n`
    +Array.from({length:60},(_,i)=>` value += parameter_name_long_0 + ${i};`).join('\n')
    +'\n return value + 986521; // owner late marker\n}\n';
  const peer='int fetchPeerState() {\n int value=0;\n'+Array.from({length:35},(_,i)=>` value += ${i};`).join('\n')+'\n return value + 732459;\n}\n';
  fs.writeFileSync(path.join(root,'owner.h'),header); fs.writeFileSync(path.join(root,'owner.cpp'),body); fs.writeFileSync(path.join(root,'peer.cpp'),peer);
  const writer=CodeGraph.initSync(root); try {await writer.indexAll();} finally {writer.close();}
  const cg=CodeGraph.openReadOnlySync(root),handler=new ProductionToolHandler(cg);
  integrationFixtures.push({root,cg,handler});
  const original=adapter.createUpstreamExploreGraph;
  const gathers=vi.fn(async()=>({nodes:new Map<string,Node>(),edges:[],roots:[]}));
  vi.spyOn(adapter,'createUpstreamExploreGraph').mockImplementation(native=>{
    const graph=original(native); graph.findRelevantContext=gathers; return graph;
  });
  const session=new ExploreSessionState();
  const call=(query='ArchiveOwner load_state fetchPeerState',maxFiles=3)=>handler.execute('explore',{query,maxFiles},{exploreSession:session});
  return {root,cg,handler,session,call,body,header,gathers};
}
function productionText(result:ToolResult):string {
  expect(result.isError).not.toBe(true); expect(result).not.toHaveProperty('_cgExploreEmission');
  const text=result.content.map(c=>c.text??'').join('\n'); expect(text.length).toBeLessThanOrEqual(25000); return text;
}
describe('production named-symbol interactions with empty gather (owner boost withdrawn)',()=>{
  it('recovers owner and peer, then accounts a deduplicated second call without an empty-source answer',async()=>{
    const f=await productionFixture();
    const first=productionText(await f.call());
    expect(first).toContain('986521'); expect(first).toContain('732459');
    const second=productionText(await f.call());
    expect(second).not.toContain('No relevant code found');
    expect(second).toMatch(/```(?:cpp|c)/);
    expect(f.session.callCount(f.root)).toBe(2);
    expect(f.gathers).toHaveBeenCalledTimes(2);
    const calls=f.session.snapshot()[0]!.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1]!.sourceBytes).toBeGreaterThan(0);
    expect(calls[1]!.sourceBytes).toBeLessThan(calls[0]!.sourceBytes);
  },30000);
  it('keeps explicit header intent alongside separately named owner/member tokens and a one-file budget',async()=>{
    const f=await productionFixture();
    const text=productionText(await f.call('owner.h ArchiveOwner load_state',1));
    expect(text).toContain('class ArchiveOwner');
    expect(text).not.toContain('986521');
    expect(f.session.snapshot()[0]!.calls[0]!.files.map(file=>file.path)).toEqual(['owner.h']);
    expect(f.gathers).toHaveBeenCalledTimes(1);
  },30000);
  it.each(['insert','same-size','delete'])('refreshes source safely rather than reusing stale owner back-references after %s drift',async mode=>{
    const f=await productionFixture(); productionText(await f.call());
    const file=path.join(f.root,'owner.cpp'); const stat=fs.statSync(file);
    if(mode==='insert') fs.writeFileSync(file,'int unrelatedInserted() { return 164093; }\n'+f.body);
    if(mode==='same-size') {fs.writeFileSync(file,f.body.replace('986521','111333'));fs.utimesSync(file,stat.atime,stat.mtime);}
    if(mode==='delete') fs.unlinkSync(file);
    const text=productionText(await f.call());
    if(mode!=='same-size') expect(text).toMatch(/changed since|missing|unavailable|drift|re-index/i);
    expect(f.session.callCount(f.root)).toBe(2);
    const calls=f.session.snapshot()[0]!.calls;
    const owner=calls[1]!.files.find(entry=>entry.path==='owner.cpp');
    if(mode==='delete') {
      expect(text).not.toContain('986521'); expect(owner).toBeUndefined();
    } else {
      // Drift intentionally permits safe current-file fallback, not slicing
      // stale indexed ranges. Check source text AND its current line numbers.
      // The public drift banner is stat-based; same-size/restored-mtime
      // edits must still invalidate content-hash-based dedup independently.
      if(mode==='insert') expect(text).toContain('changed since last index sync');
      const section=text.split('**`owner.cpp`**')[1]!.split('**`')[0]!;
      expect(section).not.toContain('Already sent earlier');
      const block=/```cpp\n([\s\S]*?)```/.exec(section)![1]!;
      const current=fs.readFileSync(file,'utf8').split('\n');
      for(const line of block.trimEnd().split('\n')) {
        const match=/^(\d+)\t(.*)$/.exec(line)!;
        expect(match).not.toBeNull(); expect(match[2]).toBe(current[Number(match[1])-1]);
      }
      expect(owner!.bytes).toBeGreaterThan(0);
      expect(owner!.fingerprint).not.toBe(calls[0]!.files.find(entry=>entry.path==='owner.cpp')!.fingerprint);
      if(mode==='same-size') {expect(text).toContain('111333');expect(text).not.toContain('986521');}
      else {expect(text).toContain('164093');expect(text).toContain('986521');}
    }
  },30000);
});
