import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
import { EXTRACTION_VERSION } from '../src/extraction/extraction-version';

const roots: string[] = [], graphs: CodeGraph[] = [];
const proof = 'index_synthesis_completed_version';
const legacy = 'index_legacy_synthesis_unverified';
const started = 'index_synthesis_verification_started';
afterEach(() => { vi.restoreAllMocks(); for (const g of graphs.splice(0)) g.close(); for (const r of roots.splice(0)) fs.rmSync(r,{recursive:true,force:true}); });
async function buildFixture(extractionVersion: number) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cg-legacy-')); roots.push(root);
  fs.writeFileSync(path.join(root,'api.h'),'#define FLAG 1\nint api(void);\n');
  fs.writeFileSync(path.join(root,'api.c'),'#include "api.h"\nint api(void){return FLAG;}\n');
  const graph=CodeGraph.initSync(root); graphs.push(graph); await graph.indexAll();
  const internal=graph as any, q=internal.queries;
  // Unit-model a known successful pre-proof build. Actual 69643/28910-generated DB
  // integration is separate; never claim this metadata fixture is historical.
  q.applyMetadataChanges({[proof]:null,[started]:null,[legacy]:null,
    indexed_with_version:'1.1.1',indexed_with_extraction_version:String(extractionVersion),
    index_completeness:'complete',index_diagnostics:'[]',
    'resolution:cpp-macro-evidence-v1':null,'resolution:cpp-macro-evidence-clean-v1':null});
  return {root,graph,q,internal};
}
function edges(g: any) { return g.db.getDb().prepare('SELECT source,target,kind,line,col,metadata,provenance FROM edges ORDER BY source,target,kind,line,col,metadata').all(); }

describe.each([22, 24])('known legacy extraction %i stays usable without inventing verification',extractionVersion=>{
  const fixture = () => buildFixture(extractionVersion);
  it('does not mutate on status; repeated/reopened no-op skips full synthesis and first macro scan',async()=>{
    const f=await fixture(), before=edges(f.internal);
    expect(f.graph.getIndexCompleteness()).toMatchObject({status:'unknown',legacyUnverified:true});
    expect(f.q.getMetadata(legacy)).toBeNull();
    const full=vi.spyOn(f.graph,'resolveReferencesBatched');
    const macro=vi.spyOn(f.q,'invalidateCppMacroCalls');
    for(let i=0;i<2;i++) expect(await f.graph.sync()).toMatchObject({filesModified:0,filesRemoved:0});
    expect(full).not.toHaveBeenCalled(); expect(macro).not.toHaveBeenCalled();
    expect(edges(f.internal)).toEqual(before); expect(f.q.getMetadata(proof)).toBeNull();
    expect(f.q.getMetadata(legacy)).toBe('1'); expect(f.graph.getIndexBuildInfo().extractionVersion).toBe(extractionVersion);
    expect(f.graph.getIndexDataReadiness()).toMatchObject({symbolsReady:true,relationshipsReady:true});
    f.graph.close(); graphs.splice(graphs.indexOf(f.graph),1);
    const reopened=CodeGraph.openSync(f.root); graphs.push(reopened);
    const again=vi.spyOn(reopened,'resolveReferencesBatched'); await reopened.sync();
    expect(again).not.toHaveBeenCalled(); expect(reopened.getIndexCompleteness()).toMatchObject({status:'unknown',legacyUnverified:true});
  });

  it('captures old macro evidence before the first legacy deletion and rechecks afterwards',async()=>{
    const f=await fixture(); await f.graph.sync();
    const seen:number[]=[]; const original=f.q.invalidateCppMacroCalls.bind(f.q);
    vi.spyOn(f.q,'invalidateCppMacroCalls').mockImplementation(async()=>{seen.push(f.q.getNodesByKind('macro').length); return original();});
    fs.unlinkSync(path.join(f.root,'api.h'));
    expect((await f.graph.sync()).filesRemoved).toBe(1);
    expect(seen[0]).toBeGreaterThan(0); expect(seen.at(-1)).toBe(0);
    expect(f.q.getMetadata('resolution:cpp-macro-evidence-v1')).not.toBeNull();
  });

  it.each([false,true])('keeps a real edit incremental and preserves legacy coverage (enrolled=%s)',async enrolled=>{
    const f=await fixture(); if(enrolled) await f.graph.sync();
    fs.writeFileSync(path.join(f.root,'api.c'),'#include "api.h"\nint api(void){return FLAG+2345;}\n');
    const full=vi.spyOn(f.graph,'resolveReferencesBatched');
    expect(await f.graph.sync()).toMatchObject({filesModified:1, complete:true});
    expect(full).not.toHaveBeenCalled(); expect(f.q.getMetadata(proof)).toBeNull();
    expect(f.graph.getIndexCompleteness()).toMatchObject({status:'unknown',legacyUnverified:true});
    expect(f.q.getMetadataByPrefix('sync-retry:pending:')).toHaveLength(0);
  });

  it('retracts stale synthesized edges when enrolled legacy enters full recovery', async()=>{
    const f=await fixture(); await f.graph.sync();
    const raw=f.internal.db.getDb();
    const expected=edges(f.internal);
    const node=f.graph.getNodesByName('api')[0]!;
    raw.prepare(`INSERT INTO edges (source,target,kind,line,col,metadata,provenance)
      VALUES (?,?,'calls',999,0,?,'heuristic')`).run(node.id,node.id,JSON.stringify({synthesizedBy:'event-emitter'}));
    raw.prepare(`INSERT INTO unresolved_refs
      (from_node_id,reference_name,reference_kind,line,col,file_path,language,status,name_tail)
      VALUES (?, 'missing', 'calls', 999, 0, 'api.c', 'c', 'pending', 'missing')`).run(node.id);
    expect(f.graph.getIndexCompleteness().status).toBe('incomplete');
    expect((await f.graph.sync()).complete).toBe(true);
    expect(edges(f.internal)).toEqual(expected);
    expect(f.q.getMetadata(proof)).toBe('1');
  });

  it('retains unfinished journals if final acknowledgment fails, then recovers on reopen',async()=>{
    const f=await fixture(); await f.graph.sync();
    fs.appendFileSync(path.join(f.root,'api.c'),'\n/* edit */\n');
    const original=f.q.applyMetadataChanges.bind(f.q);
    const fault=vi.spyOn(f.q,'applyMetadataChanges').mockImplementation((...args:any[])=>{
      if(Object.entries(args[0]).some(([key,value])=>key.startsWith('sync-retry:pending:') && value===null))
        throw new Error('ack interrupted');
      return original(...args);
    });
    await expect(f.graph.sync()).rejects.toThrow('ack interrupted');
    expect(f.q.getMetadataByPrefix('sync-retry:pending:').length).toBeGreaterThan(0);
    expect(f.graph.getIndexCompleteness().status).toBe('incomplete');
    fault.mockRestore(); f.graph.close(); graphs.splice(graphs.indexOf(f.graph),1);
    const reopened=CodeGraph.openSync(f.root); graphs.push(reopened);
    expect((await reopened.sync()).complete).toBe(true);
    expect(reopened.getIndexCompleteness()).toMatchObject({status:'unknown',legacyUnverified:true});
  });

  it('explicit index verifies and upgrades unchanged extraction without --force',async()=>{
    const f=await fixture(); await f.graph.sync();
    const result=await f.graph.indexAll(); expect(result.complete).toBe(true);
    expect(f.q.getMetadata(proof)).toBe('1'); expect(f.q.getMetadata(legacy)).toBeNull();
    expect(f.graph.getIndexBuildInfo().extractionVersion).toBe(EXTRACTION_VERSION);
    expect(f.graph.getIndexCompleteness()).toEqual({status:'complete',diagnostics:[]});
  });

  it('persists full-index intent before failure so old stamps cannot re-admit a partial rebuild',async()=>{
    const f=await fixture(); await f.graph.sync();
    const attempt=vi.spyOn(f.internal.orchestrator,'indexAll').mockRejectedValueOnce(new Error('interrupted full index'));
    await expect(f.graph.indexAll()).rejects.toThrow('interrupted full index');
    expect(f.q.getMetadata(started)).toBe('1'); expect(f.q.getMetadata(legacy)).toBeNull();
    expect(f.graph.getIndexCompleteness().legacyUnverified).toBeUndefined();
    attempt.mockRestore(); await f.graph.indexAll(); expect(f.q.getMetadata(proof)).toBe('1');
  });

  it('real scoped synthesis failure overrides compatibility and retries on unchanged source',async()=>{
    const f=await fixture(); await f.graph.sync();
    fs.appendFileSync(path.join(f.root,'api.c'),'\n/* changed */\n');
    vi.spyOn(f.internal.resolver,'synthesizeIncrementalCCpp').mockRejectedValueOnce(new Error('synthesis fault'));
    expect((await f.graph.sync()).complete).toBe(false);
    expect(f.graph.getIndexCompleteness().status).toBe('incomplete');
    expect(f.q.getMetadata('index_synthesis_pending')).not.toBeNull();
    expect(f.q.getMetadataByPrefix('sync-retry:pending:').length).toBeGreaterThan(0);
    expect((await f.graph.sync()).complete).not.toBe(false);
    expect(f.q.getMetadata(proof)).toBe('1'); expect(f.q.getMetadata(legacy)).toBeNull();
  });

  it('never hides explicit incomplete/unknown state after compatibility enrollment',async()=>{
    const f=await fixture(); await f.graph.sync();
    for(const status of ['incomplete','unknown']) {
      f.q.setMetadata('index_completeness',status);
      expect(f.graph.getIndexCompleteness()).toEqual({status,diagnostics:[]});
    }
    f.q.setMetadata('index_completeness','incomplete');
    expect((await f.graph.sync()).complete).toBe(false);
    expect(f.graph.getIndexCompleteness().legacyUnverified).toBeUndefined();
  });

  it('rejects unknown/new/malformed provenance and every durable recovery marker',async()=>{
    const f=await fixture();
    for(const value of ['21','23','35','36','22junk','022','34junk','024','NaN','',null]) {
      f.q.applyMetadataChanges({ indexed_with_extraction_version: value });
      expect(f.graph.getIndexCompleteness().legacyUnverified,value??'null').toBeUndefined();
    }
    f.q.setMetadata('indexed_with_extraction_version',String(extractionVersion));
    const cases:Record<string,string>={ [proof]:'corrupt',[started]:'',index_synthesis_pending:'',index_conformance_pending:'',language_scope_pending:'',index_sync_failure_baseline:'',
      'sync-retry:pending:api.c':'{}','sync-append-delta:pending:api.c':'{}','resolution-deferred:1':'1',index_diagnostics:'bad'};
    for(const [key,value] of Object.entries(cases)) {
      f.q.setMetadata(key,value); expect(f.graph.getIndexCompleteness().legacyUnverified,key).toBeUndefined();
      f.q.applyMetadataChanges({[key]:key==='index_diagnostics'?'[]':null});
    }
    f.q.setMetadata('index_completeness','incomplete'); expect(f.graph.getIndexCompleteness().legacyUnverified).toBeUndefined();
  });
});
