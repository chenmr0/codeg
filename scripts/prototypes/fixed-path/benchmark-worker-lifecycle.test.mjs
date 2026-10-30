/** Exercise the actual benchmark worker, including its post-operation stats. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { paths, lease, state } from './protocol.mjs';
const worker=fileURLToPath(new URL('./real-benchmark/worker.mjs',import.meta.url));
function invoke(root,mode,destination,preload){
 const output=path.join(root,`${mode}-report.json`);
 const child=spawnSync(process.execPath,['--liftoff-only',...preload?['--import',pathToFileURL(preload).href]:[],worker,mode,root,output,...destination?[destination]:[]],{encoding:'utf8',timeout:30000,env:{...process.env,CODEGRAPH_ALL_LANGUAGES:'1'}});
 assert.equal(child.status,0,`${mode}: ${child.stderr}`);const report=JSON.parse(fs.readFileSync(output,'utf8'));assert.equal(report.completeness.status,'complete');return report;
}
function offlineReady(root){
 const p=paths(root);for(const suffix of ['-wal','-shm','-journal'])assert.equal(fs.existsSync(p.active+suffix),false,`normal worker shutdown must remove ${suffix} via SQLite`);
 assert.equal(state(p).mode,'idle');for(const file of [p.owner,p.connections,p.writers]){const held=lease(file,true);assert(held,'all worker leases must be released');held.close();}
}
function symbol(file){const db=new DatabaseSync(file,{readOnly:true});try{return db.prepare('SELECT signature FROM nodes WHERE name=\'stable\'').get()?.signature;}finally{db.close();}}

test('benchmark worker completes two offline overwrite / sync / rebuild / plan / check loops without a manual journal cleanup',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'benchmark-worker-lifecycle-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source=path.join(root,'main.py'),publicFile=path.join(root,'public.db');
 fs.writeFileSync(source,'def stable(value=1):\n    return value\n');invoke(root,'init',publicFile);
 const preload=path.join(paths(root).runtime,'assert-stats-lease.mjs'),proof=path.join(paths(root).runtime,'stats-lease-proof');
 fs.writeFileSync(preload,`import fs from 'node:fs';import{createRequire}from'node:module';import{lease,paths}from ${JSON.stringify(new URL('./protocol.mjs',import.meta.url).href)};const{CodeGraph}=createRequire(import.meta.url)(${JSON.stringify(fileURLToPath(new URL('../../../dist/index.js',import.meta.url)))});const original=CodeGraph.prototype.getStats;CodeGraph.prototype.getStats=function(...args){const held=lease(paths(${JSON.stringify(root)}).connections,true);if(held){held.close();throw Error('benchmark stats bypassed connection lease');}fs.writeFileSync(${JSON.stringify(proof)},'protected');return original.apply(this,args);};`);
 assert.equal(symbol(publicFile),'(value=1)');for(const suffix of ['-wal','-shm','-journal'])assert.equal(fs.existsSync(publicFile+suffix),false,'public snapshot remains self-contained after statistics');
 for(let iteration=0;iteration<2;iteration++){
  // No unlink of WAL/SHM, no direct checkpoint, no runtime reset. If the
  // previous real worker left a sidecar, this existing offline workflow fails.
  if(iteration)offlineReady(root);
  fs.copyFileSync(publicFile,paths(root).active);
  fs.writeFileSync(source,`def stable(value=${iteration+2}):\n    return value\n`);
  const sync=invoke(root,'sync',undefined,preload);assert.equal(fs.readFileSync(proof,'utf8'),'protected');assert.equal(sync.result.complete,true);assert(sync.stats);offlineReady(root);
  invoke(root,'plan');offlineReady(root);
  fs.writeFileSync(path.join(root,'added.py'),`def added(value=${iteration}):\n    return value\n`);
  const rebuilt=invoke(root,'rebuild');assert.equal(rebuilt.result.builds,1,'actual rebuild rather than no-change shortcut');offlineReady(root);
  assert.equal(invoke(root,'check').result.status,'verified-observation');offlineReady(root);
 }
});
