import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'fs'; import os from 'os'; import path from 'path';
const { CodeGraph } = require('../dist') as typeof import('../src');
const { resolveGeneration } = require('../dist/sync/generation-store') as typeof import('../src/sync/generation-store');
let savedArgs: string[]; beforeEach(()=>{savedArgs=process.execArgv;process.execArgv=['--liftoff-only'];});
let root: string; const graphs: import('../src').CodeGraph[] = [];
afterEach(() => { vi.restoreAllMocks(); process.execArgv=savedArgs; for (const g of graphs.splice(0)) g.close(); if (root) fs.rmSync(root, { recursive:true, force:true }); });
async function fixture() { root=fs.mkdtempSync(path.join(os.tmpdir(),'cg-sdk-retire-')); fs.writeFileSync(path.join(root,'a.c'),'int original(void){return 1;}'); const g=await CodeGraph.init(root,{index:true});graphs.push(g);return g; }
async function until(check:()=>boolean) { const deadline=Date.now()+5000; while(!check()) { if(Date.now()>deadline)throw Error('retirement deadline exceeded'); await new Promise(r=>setTimeout(r,20)); } }
it('retires multiple generations while the SDK facade remains open without explicit collection',async()=>{
 const g=await fixture();const data=g.getDataDirectory();const ids=[resolveGeneration(data).id!];
 for(let i=1;i<=2;i++){fs.writeFileSync(path.join(root,'.gitignore'),`# configuration ${i}\n`);expect((await g.sync()).adaptive?.strategy).toBe('rebuild');ids.push(resolveGeneration(data).id!);expect(g.searchNodes('original').length).toBeGreaterThan(0);}
 await until(()=>ids.slice(0,-1).every(id=>!fs.existsSync(path.join(data,'generations',id))));
 expect(g.searchNodes('original').length).toBeGreaterThan(0);expect((await g.sync()).filesModified).toBe(0);
},30000);
it('keeps a whole asynchronous read pinned until completion and then automatically retires it',async()=>{
 const g=await fixture();const data=g.getDataDirectory();const old=resolveGeneration(data);
 let release!:()=>void;const pause=new Promise<void>(r=>release=r);let entered!:()=>void;const ready=new Promise<void>(r=>entered=r);
 const reading=(g as any).withReadView(async(view:import('../src').CodeGraph)=>{const before=view.searchNodes('original');entered();await pause;return [before,view.searchNodes('original'),view.searchNodes('replacement')];});
 await ready;fs.writeFileSync(path.join(root,'a.c'),'int replacement(void){return 2;}');fs.writeFileSync(path.join(root,'.gitignore'),'# rebuild\n');await g.sync();
 expect(g.searchNodes('replacement').length).toBeGreaterThan(0);expect(fs.existsSync(old.databasePath)).toBe(true);
 release();const [before,after,newHits]=await reading;expect(before.length).toBeGreaterThan(0);expect(after).toEqual(before);expect(newHits).toEqual([]);
 await until(()=>!fs.existsSync(path.dirname(old.databasePath)));expect(g.searchNodes('replacement').length).toBeGreaterThan(0);
},30000);
it('retires an idle default facade after another facade publishes without any new read',async()=>{
 const idle=await fixture();const data=idle.getDataDirectory();const old=resolveGeneration(data);
 expect(idle.searchNodes('original').length).toBeGreaterThan(0);
 const writer=CodeGraph.openSync(root);graphs.push(writer);fs.writeFileSync(path.join(root,'.gitignore'),'# external writer\n');await writer.sync();
 await until(()=>!fs.existsSync(path.dirname(old.databasePath)));
 expect(idle.searchNodes('original').length).toBeGreaterThan(0);
},30000);
it('parent close does not close a pinned asynchronous operation; rejection releases its old generation',async()=>{
 const g=await fixture();const data=g.getDataDirectory();const old=resolveGeneration(data);
 let release!:()=>void;const pause=new Promise<void>(r=>release=r);let entered!:()=>void;const ready=new Promise<void>(r=>entered=r);
 const reading=(g as any).withReadView(async(view:import('../src').CodeGraph)=>{entered();await pause;expect(view.searchNodes('original').length).toBeGreaterThan(0);throw Error('expected query failure');});
 const rejected=expect(reading).rejects.toThrow('expected query failure');await ready;
 const writer=CodeGraph.openSync(root);graphs.push(writer);fs.writeFileSync(path.join(root,'.gitignore'),'# next generation\n');await writer.sync();g.close();expect(fs.existsSync(old.databasePath)).toBe(true);
 release();await rejected;await until(()=>!fs.existsSync(path.dirname(old.databasePath)));expect(writer.searchNodes('original').length).toBeGreaterThan(0);
},30000);
it('bounds background CURRENT observation and still rejects invalid manifests on actual reads',async()=>{
 const g=await fixture();const current=path.join(g.getDataDirectory(),'CURRENT');const original=fs.readFileSync(current);
 try {
  fs.writeFileSync(current,'x'.repeat(8192));
  expect((CodeGraph as any).readRetirementManifest(g.getDataDirectory())).toBeNull();
  await new Promise(r=>setTimeout(r,350));
  expect(()=>g.searchNodes('original')).toThrow(/manifest too large/i);
  fs.unlinkSync(current);fs.mkdirSync(current);
  expect((CodeGraph as any).readRetirementManifest(g.getDataDirectory())).toBeNull();
  await new Promise(r=>setTimeout(r,350));
  expect(()=>g.searchNodes('original')).toThrow();
  fs.rmdirSync(current);fs.writeFileSync(current,original);
  expect(g.searchNodes('original').length).toBeGreaterThan(0);
 } finally { if(fs.existsSync(current)&&fs.statSync(current).isDirectory())fs.rmdirSync(current);fs.writeFileSync(current,original); }
},30000);

it('reuses only the current native reader across nonoverlapping reads',async()=>{
 const g=await fixture();const open=vi.spyOn(CodeGraph,'openReadOnlyAtLease');
 for(let i=0;i<100;i++) expect(g.searchNodes('original').length).toBeGreaterThan(0);
 expect(open).toHaveBeenCalledTimes(1);
 const first=(g as any).generationReaders.values().next().value;
 expect(first.references).toBe(0);expect(first.retired).toBe(false);
 fs.writeFileSync(path.join(root,'.gitignore'),'# second hot generation\n');await g.sync();
 for(let i=0;i<100;i++) expect(g.searchNodes('original').length).toBeGreaterThan(0);
 expect(open).toHaveBeenCalledTimes(2);expect(first.retired).toBe(true);
 expect((g as any).generationReaders.size).toBe(1);
},30000);
