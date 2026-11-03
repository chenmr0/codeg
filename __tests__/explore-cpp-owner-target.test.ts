import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src';
import { createUpstreamExploreGraph } from '../src/mcp/upstream-explore-adapter';
import { ToolHandler } from '../src/upstream-explore/mcp/tools';
import { coNamedCppMethodTarget } from '../src/upstream-explore/mcp/cpp-owner-target';
import * as ownerTargets from '../src/upstream-explore/mcp/cpp-owner-target';
import type { Node } from '../src/upstream-explore/types';

const type = (qualifiedName='work::SnapshotService'): Node => ({id:qualifiedName,name:qualifiedName.split('::').at(-1)!,qualifiedName,kind:'class',language:'cpp',filePath:'owner.h',startLine:1,endLine:20} as Node);
const method = (extra: Partial<Node>={}): Node => ({id:'body',name:'acquire_read_snapshot',qualifiedName:'work::SnapshotService::acquire_read_snapshot',kind:'method',language:'cpp',filePath:'owner.cpp',startLine:10,endLine:110,isDeclaration:false,signature:'int acquire_read_snapshot(LongType ...',...extra} as Node);
const roots:string[]=[], graphs:CodeGraph[]=[];
afterEach(()=>{for(const g of graphs.splice(0))g.close();for(const r of roots.splice(0))fs.rmSync(r,{recursive:true,force:true});vi.restoreAllMocks();vi.unstubAllEnvs();});

describe('co-named C++ owner/member exact body selection',()=>{
  it('selects a concrete body by complete owner evidence without merging its truncated declaration',()=>{
    const body=method(),decl=method({id:'decl',isDeclaration:true,filePath:'owner.h'});
    for(const owner of ['SnapshotService','work::SnapshotService']) expect(coNamedCppMethodTarget(body.name,[decl,body],[owner],()=>[type()])).toBe(body);
    expect(coNamedCppMethodTarget(body.name,[decl,body],['Snapshot'],()=>[type()])).toBeUndefined();
    expect(coNamedCppMethodTarget(body.name,[decl,body],['SnapshotService'],()=>[])).toBeUndefined();
  });
  it('refuses same-owner overloads, duplicate bodies, declarations only and ambiguous namespace owners',()=>{
    const body=method(),decl=method({id:'decl',isDeclaration:true});
    for(const family of [[decl],[body,method({id:'overload',signature:'int acquire_read_snapshot(double)'})],[body,method({id:'duplicate',filePath:'duplicate.cpp'})]]) {
      expect(coNamedCppMethodTarget(body.name,family,['SnapshotService'],()=>[type()])).toBeUndefined();
    }
    const other=method({id:'other',qualifiedName:'other::SnapshotService::acquire_read_snapshot'});
    expect(coNamedCppMethodTarget(body.name,[body],['SnapshotService'],()=>[type(),type('other::SnapshotService')])).toBeUndefined();
    expect(coNamedCppMethodTarget(body.name,[body,other],['SnapshotService'],()=>[type(),type('other::SnapshotService')])).toBeUndefined();
    expect(coNamedCppMethodTarget(body.name,[body,other],['work::SnapshotService'],()=>[type(),type('other::SnapshotService')])).toBe(body);
    const shortened=method({id:'short',qualifiedName:'SnapshotService::acquire_read_snapshot',signature:'int acquire_read_snapshot(double)'});
    expect(coNamedCppMethodTarget(body.name,[body,shortened],['work::SnapshotService'],()=>[type()])).toBeUndefined();
    expect(coNamedCppMethodTarget(body.name,[shortened],['work::SnapshotService'],()=>[type(),type('other::SnapshotService')])).toBeUndefined();
    const nested=method({qualifiedName:'outer::inner::SnapshotService::acquire_read_snapshot'});
    const relative=method({id:'relative',qualifiedName:'inner::SnapshotService::acquire_read_snapshot'});
    expect(coNamedCppMethodTarget(body.name,[nested,relative],['outer::inner::SnapshotService'],()=>[type('outer::inner::SnapshotService')])).toBeUndefined();
    expect(coNamedCppMethodTarget(body.name,[relative],['outer::inner::SnapshotService'],()=>[type('outer::inner::SnapshotService'),type('other::inner::SnapshotService')])).toBeUndefined();
  });
  it('does not promote prose, constructors, wrong owners, free functions or other languages',()=>{
    for(const extra of [
      {name:'process',qualifiedName:'work::SnapshotService::process'},
      {name:'SnapshotService',qualifiedName:'work::SnapshotService::SnapshotService'},
      {name:'~SnapshotService',qualifiedName:'work::SnapshotService::~SnapshotService'},
      {qualifiedName:'work::SnapshotServiceExtra::acquire_read_snapshot'},
      {kind:'function' as const}, {language:'typescript' as const},
    ]) {const node=method(extra);expect(coNamedCppMethodTarget(node.name,[node],['SnapshotService'],()=>[type()])).toBeUndefined();}
  });

  it('keeps the complete named body and another named file inside the unchanged budget after a crowded gather',async()=>{
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
    const disabled=vi.spyOn(ownerTargets,'coNamedCppMethodTarget').mockReturnValue(undefined);
    const baseline=await new ToolHandler(graph).execute('codegraph_explore',{query,maxFiles:12});
    disabled.mockRestore();
    expect(baseline.content[0]!.text).not.toContain('return 900017;');
    expect(baseline.content[0]!.text).toMatch(/lines \d+-\d+ of `acquire_read_snapshot` elided/);
    const result=await new ToolHandler(graph).execute('codegraph_explore',{query,maxFiles:12});
    const text=result.content[0]!.text;
    expect(result.isError).not.toBe(true);
    expect(text).toContain('return 900017;');
    expect(text).toContain('return 814229;');
    for(const name of peerNames) expect(text).toContain(`int ${name}() { return 814229; }`);
    expect(text).not.toMatch(/lines \d+-\d+ of `acquire_read_snapshot` elided/);
    expect(text.length).toBeLessThanOrEqual(25000);
    expect(graph.getNodesByName('acquire_read_snapshot')).toEqual(before);
  },30000);
});
