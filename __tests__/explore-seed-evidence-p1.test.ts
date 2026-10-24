import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import CodeGraph from '../src/index';
import { retrieveExploreContext } from '../src/mcp/explore-retrieval';

describe('seed intent on real C++ and TypeScript indexes', () => {
  let root:string,cg:CodeGraph;
  beforeAll(async()=>{
    vi.stubEnv('CODEGRAPH_ENABLE_EXPLORE','1');
    root=fs.mkdtempSync(path.join(os.tmpdir(),'cg-intent-p1-'));
    fs.writeFileSync(path.join(root,'worker.h'),`namespace sample {
class PacketWorker { public: int run(int value); int run(double value); int save(); int unrelated(); };
}
`);
    fs.writeFileSync(path.join(root,'worker.cpp'),`#include "worker.h"
namespace sample {
int PacketWorker::run(int value) { return save()+value; }
int PacketWorker::run(double value) { return 7; }
int PacketWorker::save() { return 91; }
int PacketWorker::unrelated() { return 999; }
}
`);
    fs.writeFileSync(path.join(root,'incidental.ts'),'export function task(){return 1;}\n');
    fs.writeFileSync(path.join(root,'unrelated.ts'),'export function rate(){return 2;}\n');
    fs.writeFileSync(path.join(root,'siblings.ts'),'export function check(){return drain();}\nexport function drain(){return fire();}\nexport function fire(){return 3;}\n');
    fs.writeFileSync(path.join(root,'literal.cpp'),'int read_budget(Config *cfg) { return cfg->packet_budget_ceiling; }\n');
    fs.writeFileSync(path.join(root,'solo.cpp'),'int run(int x) { return x; }\n');
    for (const [type,folder] of [['CedarFlow','first'],['AzurePump','renamed']]) {
      fs.mkdirSync(path.join(root,folder!));
      const names=Array.from({length:75},(_,i)=>`step${i}`);
      fs.writeFileSync(path.join(root,folder!,'engine.h'),`class ${type} { public:\n${names.map(x=>`int ${x}();`).join('\n')}\n};\n`);
      fs.writeFileSync(path.join(root,folder!,'engine.cpp'),`#include "engine.h"\n${names.map((x,i)=>`int ${type}::${x}(){return ${i};}`).join('\n')}\n`);
    }
    fs.writeFileSync(path.join(root,'tiny.cpp'),'int SoloSeedOne(){return 1;}\nint SoloSeedTwo(){return 2;}\nint SoloSeedThree(){return 3;}\n');
    cg=CodeGraph.initSync(root,{config:{include:['**/*.ts','**/*.cpp','**/*.h'],exclude:[]}});
    await cg.indexAll();
  });
  afterAll(()=>{cg?.close();fs.rmSync(root,{recursive:true,force:true});vi.unstubAllEnvs();});
  const roots=(r:Awaited<ReturnType<typeof retrieveExploreContext>>)=>r.graph.roots.map(id=>r.graph.nodes.get(id)!);

  it('does not promote isolated prose collisions even if each has only one exact match',async()=>{
    const base=await retrieveExploreContext(cg,'PacketWorker');
    const noisy=await retrieveExploreContext(cg,'PacketWorker task rate');
    expect(roots(noisy).map(n=>n.id)).toEqual(roots(base).map(n=>n.id));
    expect(noisy.diagnostics.seeds.filter(s=>['task','rate'].includes(s.token)).every(s=>s.kind==='uncorroborated')).toBe(true);
    expect(noisy.lookup('rate')).toEqual([]);
    expect([...noisy.graph.nodes.values()].some(n=>n.name==='unrelated'&&!n.isDeclaration)).toBe(true);
  });
  it('retains single lowercase symbols, same-file symbol bags and stopword member names',async()=>{
    expect(roots(await retrieveExploreContext(cg,'task')).map(n=>n.name)).toEqual(['task']);
    expect(roots(await retrieveExploreContext(cg,'check drain fire')).map(n=>n.name).sort()).toEqual(['check','drain','fire']);
    const r=await retrieveExploreContext(cg,'PacketWorker run save');
    const runs=r.lookup('run');
    expect(runs).toHaveLength(2);
    expect(runs.every(n=>!n.isDeclaration&&n.qualifiedName==='sample::PacketWorker::run')).toBe(true);
    expect(r.diagnostics.seeds.find(s=>s.token==='run')?.kind).toBe('owner-member');
    expect(roots(await retrieveExploreContext(cg,'run save')).some(n=>n.name==='save')).toBe(true);
  });
  it('keeps literal recovery distinct from explicitly named implementation roots',async()=>{
    const r=await retrieveExploreContext(cg,'PacketWorker packet_budget_ceiling');
    const recovered=roots(r).find(n=>n.name==='read_budget')!;
    expect(recovered).toBeTruthy();
    expect(r.namedNodeIds.has(recovered.id)).toBe(false);
    expect(r.diagnostics.seeds.find(s=>s.token==='packet_budget_ceiling')?.kind).toBe('literal');
    expect(r.fileEvidence.get('literal.cpp')).toBe(1);
  });
  it('does not call an uncorroborated exact match absent',async()=>{
    const r=await retrieveExploreContext(cg,'task approximate behavior');
    expect(r.graph.nodes.size).toBe(0);
    expect(r.diagnostics.seeds.find(s=>s.token==='task')?.exactMatchCount).toBe(1);
    expect(r.note).toContain('does not establish symbol absence');
  });
  it('reports scope exclusions separately from node-budget omissions',async()=>{
    const r=await retrieveExploreContext(cg,'PacketWorker run');
    const other=cg.getNodesByName('unrelated').find(n=>!n.isDeclaration)!;
    expect(r.diagnostics.members.find(m=>m.nodeId===other.id)?.reason).toBe('not-requested-member');
    expect(r.graph.nodes.size).toBeLessThanOrEqual(200);
  });
  it.each(['CedarFlow','AzurePump'])('reclaims exhausted roots for late C++ members after renaming: %s',async type=>{
    const r=await retrieveExploreContext(cg,`${type} SoloSeedOne SoloSeedTwo SoloSeedThree`);
    expect(r.graph.roots).toHaveLength(4);
    const last=[...r.graph.nodes.values()].find(n=>n.qualifiedName===`${type}::step74`&&!n.isDeclaration);
    expect(last).toBeTruthy();
    expect(r.diagnostics.admission.reclaimedNodes).toBeGreaterThan(0);
    expect(r.diagnostics.members.find(m=>m.nodeId===last!.id)?.reason).toBe('admitted');
    expect(r.graph.nodes.size).toBeLessThanOrEqual(200);
  });
});
