import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src';
import { createUpstreamExploreGraph } from '../src/mcp/upstream-explore-adapter';
import { ToolHandler } from '../src/upstream-explore/mcp/tools';

const roots:string[]=[], graphs:CodeGraph[]=[];
afterEach(()=>{for(const g of graphs.splice(0))g.close();for(const r of roots.splice(0))fs.rmSync(r,{recursive:true,force:true});vi.restoreAllMocks();vi.unstubAllEnvs();});

// Owner-wide exact promotion was withdrawn: it displaced directly called
// locking evidence in other files. This fixture records the remaining body
// completeness problem without asserting that unsafe priority fixes solved it.
async function crowdedOwnerResult() {
    vi.stubEnv('CODEGRAPH_NO_DAEMON','1');
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'cg-owner-budget-'));roots.push(root);
    const params=Array.from({length:8},(_,i)=>`const int extremely_long_parameter_name_${i}`).join(', ');
    fs.writeFileSync(path.join(root,'owner.h'),`class SnapshotService { public: SnapshotService(); int acquire_read_snapshot(${params}); };\n`);
    const body=[`#include "owner.h"`,`SnapshotService::SnapshotService() {}`,`int SnapshotService::acquire_read_snapshot(${params}) {`,'  int value = 0;',
      ...Array.from({length:95},(_,i)=>`  value += extremely_long_parameter_name_0 + ${i};`),
      '  if (value == 17) { return 900017; } // critical late alternative', '  return value;', '}',''].join('\n');
    // Keep the file outside the whole-file buy path: the regression concerns
    // a named body inside a large implementation, not a small file bargain.
    fs.writeFileSync(path.join(root,'owner.cpp'),body+'\nint unrelatedPadding() {\n  int padding = 0;\n'
      +Array.from({length:300},(_,i)=>`  padding += ${i};`).join('\n')+'\n  return padding;\n}\n');
    const peerNames=['loadPeerState','savePeerState','fetchPeerState','writePeerState','readPeerState'];
    for(const name of peerNames) fs.writeFileSync(path.join(root,`${name}.cpp`),`int ${name}() { return 814229; }\n`);
    const query='SnapshotService acquire_read_snapshot '+peerNames.join(' ');
    for(let i=0;i<10;i++)fs.writeFileSync(path.join(root,`forward${i}.h`),`class SnapshotService;\nstruct Forward${i} { int unrelated_${i}; };\n`);
    const cg=CodeGraph.initSync(root);graphs.push(cg);await cg.indexAll();
    const graph=createUpstreamExploreGraph(cg);
    const actualStats=graph.getStats();vi.spyOn(graph,'getStats').mockReturnValue({...actualStats,fileCount:15000});
    const forwarded=graph.getNodesByName('SnapshotService').filter(n=>n.kind==='class'&&n.isDeclaration);
    expect(forwarded.length).toBeGreaterThanOrEqual(8);
    vi.spyOn(graph,'findRelevantContext').mockImplementation(async()=>({nodes:new Map(forwarded.slice(0,8).map(n=>[n.id,n])),edges:[],roots:forwarded.slice(0,8).map(n=>n.id)}));
    const before=graph.getNodesByName('acquire_read_snapshot');
    expect(before.some(n=>n.signature?.endsWith('...'))).toBe(true);

    const result=await new ToolHandler(graph).execute('codegraph_explore',{query,maxFiles:12});
    return {result, before, graph, peerNames};
}
describe('unresolved co-named C++ method completeness under budget pressure',()=>{
  it('records the current elision while retaining peer bodies and raw graph evidence',async()=>{
    const {result,before,graph,peerNames}=await crowdedOwnerResult();
    const text=result.content[0]!.text;
    expect(result.isError).not.toBe(true);
    expect(text).not.toContain('return 900017;');
    expect(text).toMatch(/lines \d+-\d+ of `acquire_read_snapshot` elided/);
    for(const name of peerNames) expect(text).toContain(`int ${name}() { return 814229; }`);
    expect(text.length).toBeLessThanOrEqual(25000);
    expect(graph.getNodesByName('acquire_read_snapshot')).toEqual(before);
  },30000);
  it.fails('UNRESOLVED: separately named owner/member should retain the complete weak-read-like method',async()=>{
    const {result}=await crowdedOwnerResult();
    expect(result.content[0]!.text).toContain('return 900017;');
  },30000);
});
