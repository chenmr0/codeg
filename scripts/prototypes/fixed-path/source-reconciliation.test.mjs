/** Follow-up source TOCTOU experiment; does not replace the delivered protocol suite.
 * Run after npm run build, with Node 22/24:
 * CODEGRAPH_ALL_LANGUAGES=1 node --liftoff-only --test scripts/prototypes/fixed-path/source-reconciliation.test.mjs
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { Participant, paths, seal, records } from './protocol.mjs';
import { buildGraph, graphAt, prepareGrammars } from './graph-adapter.mjs';
import { initializeSource, sourceState, checkSource, reconcileSource, publishObserved } from './source-reconciliation.mjs';

process.env.CODEGRAPH_ALL_LANGUAGES='1';
const worker=fileURLToPath(new URL('./source-worker.mjs',import.meta.url));
const roots=[],report={platform:process.platform,node:process.version,startedAt:new Date().toISOString(),scope:'real CodeGraph source reconciliation prototype; conditional convergence, not atomic source snapshot',cases:[],workers:[]};
const evidenceDir=process.env.FIXED_PATH_EVIDENCE_DIR??path.resolve('artifacts/fixed-path-prototype',`source-reconciliation-${process.platform}-${Date.now()}`);
fs.mkdirSync(evidenceDir,{recursive:true});
const fixedTime=new Date('2020-01-02T03:04:05.000Z');
function source(value){return `def stable(value=${value}):\n    return value\n`;}
function setMain(root,value,{preserve=false}={}){const file=path.join(root,'main.py'),before=fs.existsSync(file)?fs.statSync(file,{bigint:true}):null;fs.writeFileSync(file,source(value));fs.utimesSync(file,fixedTime,fixedTime);if(preserve){const after=fs.statSync(file,{bigint:true});assert.equal(after.size,before.size,'Same-size edit precondition');assert.equal(after.mtimeNs,before.mtimeNs,'Preserved-mtime edit precondition');}}
function openReader(root){return new Participant(root,file=>graphAt(root,file,{readOnly:true}));}
async function fixture(){await prepareGrammars();const root=fs.mkdtempSync(path.join(os.tmpdir(),'fixed-source-reconcile-'));roots.push(root);setMain(root,1);fs.writeFileSync(path.join(root,'removed.py'),'def removed_api():\n    return 0\n');const p=initializeSource(root);await buildGraph(root,p.active);seal(p.active,{standalone:true});return {root,p,reader:openReader(root)};}
async function signature(reader){return reader.request(g=>{const hit=g.searchNodes('stable').find(r=>r.node.name==='stable');return hit?g.getNode(hit.node.id)?.signature:null;});}
async function symbol(reader,name){return reader.request(g=>g.searchNodes(name).filter(r=>r.node.name===name));}
async function code(reader,name){return reader.request(async g=>{const hit=g.searchNodes(name).find(r=>r.node.name===name);return hit?await g.getCode(hit.node.id):null;});}
function controls(p,label){const dir=path.join(p.runtime,'source-test-controls',label);fs.mkdirSync(dir,{recursive:true});return {pausedFile:path.join(dir,'paused'),resumeFile:path.join(dir,'resume')};}
async function until(predicate,label,timeout=20000){const end=performance.now()+timeout;while(performance.now()<end){if(await predicate())return;await delay(15);}throw new Error(`Timed out: ${label}`);}
function launch(mode,root,config={}){
 const child=fork(worker,[mode,root,JSON.stringify(config)],{execArgv:['--liftoff-only'],env:{...process.env,CODEGRAPH_ALL_LANGUAGES:'1'},stdio:['ignore','pipe','pipe','ipc']});let stdout='',stderr='',ended=false;const messages=[];child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);child.on('message',m=>messages.push(m));
 const exited=new Promise(resolve=>child.on('close',(exitCode,signal)=>{ended=true;const result={mode,exitCode,signal,stdout,stderr,messages};report.workers.push(result);resolve(result);}));
 return {child,messages,exited,async wait(predicate,timeout=20000){await until(()=>messages.some(predicate),`${mode} message: ${JSON.stringify(config)}`,timeout);return messages.find(predicate);},async stop(){if(!ended){child.send('stop');await exited;}},kill(){if(!ended)child.kill('SIGKILL');}};
}
async function oneShot(mode,root,config={}){const task=launch(mode,root,config),end=await task.exited;const result=end.messages.find(m=>m.event==='result')?.result;assert.equal(end.exitCode,0,JSON.stringify(end));assert.ok(result,JSON.stringify(end));return result;}
async function caseRun(name,action){const started=performance.now();try{await action();report.cases.push({name,status:'pass',durationMs:performance.now()-started});}catch(error){report.cases.push({name,status:'fail',durationMs:performance.now()-started,error:error.stack});throw error;}}
after(()=>{report.completedAt=new Date().toISOString();const failed=report.cases.some(r=>r.status==='fail');if(failed)report.retainedFixtures=roots;fs.writeFileSync(path.join(evidenceDir,'source-reconciliation.json'),JSON.stringify(report,null,2));console.log(`SOURCE_RECONCILIATION_EVIDENCE=${path.join(evidenceDir,'source-reconciliation.json')}`);if(!failed)for(const root of roots)fs.rmSync(root,{recursive:true,force:true});});

test('edit/add/delete after final fence: stale publish is detected and autonomous watcher compensates',{timeout:60000},()=>caseRun('post-fence-same-size-mtime-add-delete',async()=>{
 const {root,p,reader}=await fixture(),control=controls(p,'post-fence');let watcher;const publisher=launch('publish',root,{pauseAt:'draining',...control});
 try{await until(()=>fs.existsSync(control.pausedFile),'draining after final fence');setMain(root,2,{preserve:true});fs.unlinkSync(path.join(root,'removed.py'));fs.writeFileSync(path.join(root,'added.py'),'def added_api():\n    return 42\n');fs.writeFileSync(control.resumeFile,'resume');const end=await publisher.exited;assert.equal(end.exitCode,0,JSON.stringify(end));assert.equal(end.messages.find(m=>m.event==='result')?.result.status,'published');assert.equal(await signature(reader),'(value=1)','This experiment must actually publish the stale pre-edit index');assert.equal((await symbol(reader,'removed_api')).length,1);assert.equal((await symbol(reader,'added_api')).length,0);assert.equal(sourceState(root).status,'needs-check','Publishing must not assert source current');assert.equal(sourceState(root).matches,null);
  watcher=launch('watch',root,{pollMs:30,maxBuilds:2});await watcher.wait(m=>m.event==='ready');await until(async()=>await signature(reader)==='(value=2)'&&(await symbol(reader,'removed_api')).length===0&&(await symbol(reader,'added_api')).length===1,'autonomous compensation updates real graph');await watcher.wait(m=>m.event==='tick'&&m.result.status==='verified-observation');assert.match(await code(reader,'stable'),/def stable\(value=2\)/);assert.match(await code(reader,'added_api'),/return 42/);assert.ok(watcher.messages.some(m=>m.event==='tick'&&m.result.outcomes.some(o=>o.type==='publish'&&o.status==='published')));
 }finally{if(!fs.existsSync(control.resumeFile))fs.writeFileSync(control.resumeFile,'resume');await publisher.exited;await watcher?.stop();reader.close();}
}));

test('crash after publication resumes: restart watcher finds queued postcheck and converges without init',{timeout:60000},()=>caseRun('crash-resumed-restart-convergence',async()=>{
 const {root,p,reader}=await fixture(),control=controls(p,'crash-resumed');let watcher;const publisher=launch('publish',root,{pauseAt:'draining',crashAt:'resumed',...control});
 try{await until(()=>fs.existsSync(control.pausedFile),'draining crash case');setMain(root,3,{preserve:true});fs.writeFileSync(control.resumeFile,'resume');const end=await publisher.exited;assert.ok(end.signal||end.exitCode!==0,'Publisher must actually die after resumed');assert.equal(await signature(reader),'(value=1)');assert.equal(sourceState(root).status,'needs-check');watcher=launch('watch',root,{pollMs:30,maxBuilds:2});await until(async()=>await signature(reader)==='(value=3)','restart autonomous repair');await watcher.wait(m=>m.event==='tick'&&m.result.status==='verified-observation');assert.match(await code(reader,'stable'),/value=3/);
 }finally{if(!fs.existsSync(control.resumeFile))fs.writeFileSync(control.resumeFile,'resume');await publisher.exited;await watcher?.stop();reader.close();}
}));

test('unconditional polling detects edits after a verified observation with no dirty notification',{timeout:60000},()=>caseRun('edit-after-verified-observation',async()=>{
 const {root,p,reader}=await fixture(),control=controls(p,'observed');const watcher=launch('watch',root,{pollMs:30,maxBuilds:2,pauseAt:'observed',...control});
 try{await until(()=>fs.existsSync(control.pausedFile),'first matching observation persisted');assert.equal(sourceState(root).status,'verified-observation');setMain(root,4,{preserve:true});assert.equal(sourceState(root).status,'verified-observation','Test must not manually mark dirty or trigger a watcher event');fs.writeFileSync(control.resumeFile,'resume');await until(async()=>await signature(reader)==='(value=4)','poll after a clean observation');await watcher.wait(m=>m.event==='tick'&&m.result.outcomes.some(o=>o.type==='publish'&&o.status==='published'));assert.match(await code(reader,'stable'),/value=4/);assert.ok(sourceState(root).checks>=2);
 }finally{if(!fs.existsSync(control.resumeFile))fs.writeFileSync(control.resumeFile,'resume');await watcher.stop();reader.close();}
}));

test('continuous post-fence changes remain pending at work budget, then converge after quiescence',{timeout:60000},()=>caseRun('continuous-change-bounded-pending',async()=>{
 const {root,reader}=await fixture();let value=2,changes=0;setMain(root,value,{preserve:true});
 try{const result=await reconcileSource(root,{maxBuilds:2,hook(phase){if(phase==='draining'){changes++;setMain(root,++value,{preserve:true});}}});assert.equal(changes,2);assert.equal(result.builds,2);assert.equal(result.status,'pending');assert.equal(result.nextCheckRequired,true);assert.notEqual(sourceState(root).status,'verified-observation');assert.notEqual(await signature(reader),`(value=${value})`,'Must demonstrate the last post-fence edit is still pending');const quiet=await reconcileSource(root,{maxBuilds:2});assert.equal(quiet.status,'verified-observation');assert.equal(await signature(reader),`(value=${value})`);assert.match(await code(reader,'stable'),new RegExp(`value=${value}`));}
 finally{reader.close();}
}));

test('hash inspection failure remains pending and later autonomous retry repairs the index',{timeout:60000},()=>caseRun('hash-failure-pending-retry',async()=>{
 const {root,reader}=await fixture();let watcher;
 try{assert.equal((await checkSource(root)).status,'verified-observation');setMain(root,5,{preserve:true});const blocked=await oneShot('reconcile',root,{failHash:true,maxBuilds:2});assert.equal(blocked.status,'pending');assert.equal(blocked.builds,0);assert.equal(blocked.outcomes[0].status,'blocked');assert.equal(sourceState(root).status,'blocked');assert.equal(sourceState(root).matches,null,'Failed check must not retain a stale matches:true field');assert.match(sourceState(root).error,/hash I\/O failure/);assert.equal(await signature(reader),'(value=1)');watcher=launch('watch',root,{pollMs:30,maxBuilds:2});await until(async()=>await signature(reader)==='(value=5)','retry after inspection failure');await watcher.wait(m=>m.event==='tick'&&m.result.status==='verified-observation');}
 finally{await watcher?.stop();reader.close();}
}));

test('gitignore/config edits after final fence cause removal and later re-inclusion to be reconciled',{timeout:60000},()=>caseRun('post-fence-ignore-config',async()=>{
 const {root,p,reader}=await fixture();let watcher;fs.writeFileSync(path.join(root,'ignored.py'),'def ignored_api():\n    return 7\n');fs.writeFileSync(path.join(root,'.gitignore'),'');const control=controls(p,'ignore');const publisher=launch('publish',root,{pauseAt:'draining',...control});
 try{await until(()=>fs.existsSync(control.pausedFile),'ignore draining');fs.writeFileSync(path.join(root,'.gitignore'),'ignored.py\n');fs.writeFileSync(control.resumeFile,'resume');await publisher.exited;assert.equal((await symbol(reader,'ignored_api')).length,1);watcher=launch('watch',root,{pollMs:30,maxBuilds:2});await until(async()=>(await symbol(reader,'ignored_api')).length===0,'ignore removal compensation');await watcher.wait(m=>m.event==='tick'&&m.result.status==='verified-observation');assert.ok(watcher.messages.some(m=>m.event==='tick'&&m.result.outcomes.some(o=>o.type==='check'&&o.configChanged)));fs.writeFileSync(path.join(root,'.gitignore'),'');await until(async()=>(await symbol(reader,'ignored_api')).length===1,'unconditional polling observes ignore removal');assert.match(await code(reader,'ignored_api'),/return 7/);}
 finally{if(!fs.existsSync(control.resumeFile))fs.writeFileSync(control.resumeFile,'resume');await publisher.exited;await watcher?.stop();reader.close();}
}));

test('compatible offline public replacement is checked against the new file despite old observation state',{timeout:60000},()=>caseRun('offline-public-replace-source-observation',async()=>{
 const fixtureData=await fixture(),{root,p}=fixtureData;let reader=fixtureData.reader;const producer=fs.mkdtempSync(path.join(os.tmpdir(),'source-public-producer-'));roots.push(producer);setMain(producer,6);fs.writeFileSync(path.join(producer,'removed.py'),'def removed_api():\n    return 0\n');const publicFile=path.join(initializeSource(producer).runtime,'public.db');await buildGraph(producer,publicFile);seal(publicFile,{standalone:true});
 try{assert.equal((await checkSource(root)).status,'verified-observation');const before=sourceState(root);reader.close();reader=null;setMain(root,6,{preserve:true});fs.copyFileSync(publicFile,p.active);assert.equal(sourceState(root).status,'verified-observation','Old observation must actually survive offline overwrite');const checked=await oneShot('reconcile',root,{maxBuilds:2});assert.equal(checked.status,'verified-observation');assert.equal(checked.builds,0,'Compatible standalone public file should not require full rebuild');reader=openReader(root);assert.equal(await signature(reader),'(value=6)');assert.match(await code(reader,'stable'),/value=6/);assert.ok(sourceState(root).checks>before.checks);}
 finally{reader?.close();}
}));

test('post-publication observation UPDATE failure never replays a consumed publication or rolls back new graph',{timeout:60000},()=>caseRun('post-publication-observation-ioerr',async()=>{
 const {root,p,reader}=await fixture(),original=DatabaseSync.prototype.prepare;let injected=false;setMain(root,7,{preserve:true});
 DatabaseSync.prototype.prepare=function(sql){const statement=original.call(this,sql);if(sql.startsWith('UPDATE source_observation SET record=')){const run=statement.run.bind(statement);statement.run=(value,...args)=>{if(!injected&&JSON.parse(value).reason==='publication-finished-requires-independent-observation'){injected=true;throw Object.assign(new Error('Injected post-publication observation IOERR'),{code:'SQLITE_IOERR'});}return run(value,...args);};}return statement;};
 try{const result=await publishObserved(root);DatabaseSync.prototype.prepare=original;assert.equal(injected,true,'Must fault the actual durable observation UPDATE after publication');assert.equal(result.status,'pending');assert.equal(result.publicationResult.status,'published');assert.equal(result.nextCheckRequired,true);assert.match(result.error,/observation IOERR/);assert.equal(await signature(reader),'(value=7)');assert.match(await code(reader,'stable'),/value=7/);assert.deepEqual(records(p).map(r=>r.phase),['cleaned'],'A consumed cleaned operation must not be replayed or falsely changed to aborted');assert.equal(sourceState(root).status,'needs-check','Pre-publication durable check obligation must survive reporting failure');assert.equal(sourceState(root).matches,null);const checked=await reconcileSource(root,{maxBuilds:2});assert.equal(checked.status,'verified-observation');assert.equal(checked.builds,0,'Successful published graph needs only a check, not another build');assert.deepEqual(records(p).map(r=>r.phase),['cleaned']);assert.equal(await signature(reader),'(value=7)');}
 finally{DatabaseSync.prototype.prepare=original;reader.close();}
}));

test('ordinary independent sync overlapping full hashing invalidates observation without blocking the writer',{timeout:60000},()=>caseRun('writer-overlaps-source-check',async()=>{
 const {root,reader}=await fixture();let writerResult;
 const protocolUrl=new URL('./protocol.mjs',import.meta.url).href,adapterUrl=new URL('./graph-adapter.mjs',import.meta.url).href;
 try{const checked=await checkSource(root,{beforeHash(){fs.writeFileSync(path.join(root,'main.py'),source(8));const script=`import {Participant} from ${JSON.stringify(protocolUrl)}; import {graphAt,prepareGrammars} from ${JSON.stringify(adapterUrl)}; await prepareGrammars(); const p=new Participant(${JSON.stringify(root)},file=>graphAt(${JSON.stringify(root)},file)); try {const result=await p.write(graph=>graph.sync({adaptive:false})); process.stdout.write(JSON.stringify(result));} finally {p.close();}`;writerResult=spawnSync(process.execPath,['--liftoff-only','--input-type=module','-e',script],{env:{...process.env,CODEGRAPH_ALL_LANGUAGES:'1'},encoding:'utf8',timeout:15000,maxBuffer:1024*1024});assert.equal(writerResult.status,0,`Independent writer must proceed while checker hashes: ${writerResult.error?.message??''} ${writerResult.stderr}`);}});assert.equal(writerResult.status,0);assert.equal(checked.status,'needs-check');assert.equal(checked.reason,'database-write-overlapped-observation');assert.equal(checked.matches,null);assert.equal(sourceState(root).status,'needs-check');assert.equal(await signature(reader),'(value=8)','Independent ordinary sync must really commit new graph data');assert.match(await code(reader,'stable'),/value=8/);const later=await reconcileSource(root,{maxBuilds:2});assert.equal(later.status,'verified-observation');assert.equal(later.builds,0,'Recheck should verify writer result, not compensate with another full rebuild');}
 finally{reader.close();}
}));

test('unreadable newly added directory blocks observation without publishing an empty or partial graph',{timeout:60000},()=>caseRun('unreadable-new-directory',async()=>{
 const {root,p,reader}=await fixture(),dir=path.join(root,'new-unreadable'),original=fs.readdirSync;fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'new.py'),'def newly_visible_api():\n    return 9\n');let injected=0;
 fs.readdirSync=function(target,...args){if(path.resolve(String(target))===dir){injected++;throw Object.assign(new Error('EACCES: injected unreadable newly added source directory'),{code:'EACCES'});}return original.call(this,target,...args);};
 try{const result=await reconcileSource(root,{maxBuilds:2});assert.ok(injected>0,'Must attempt exhaustive enumeration of the new directory');assert.equal(result.status,'pending');assert.equal(result.builds,0);assert.equal(result.outcomes[0].status,'blocked');assert.equal(result.outcomes[0].matches,null);assert.equal(sourceState(root).status,'blocked');assert.equal(sourceState(root).matches,null);assert.match(sourceState(root).error,/EACCES/);assert.deepEqual(records(p),[],'Read failure must not produce a partial replacement');assert.equal(await signature(reader),'(value=1)');assert.equal((await symbol(reader,'removed_api')).length,1,'Old usable graph must not be mistaken for source deletion');fs.readdirSync=original;const retried=await reconcileSource(root,{maxBuilds:2});assert.equal(retried.status,'verified-observation');assert.equal((await symbol(reader,'newly_visible_api')).length,1);assert.match(await code(reader,'newly_visible_api'),/return 9/);}
 finally{fs.readdirSync=original;reader.close();}
}));


test('dirty observation cannot authorize replacing an active index whose ownership changed before build',{timeout:60000},()=>caseRun('dirty-to-build-ownership-change',async()=>{
 const {root,p,reader}=await fixture();let writer;
 try{
  setMain(root,7);assert.equal((await checkSource(root)).status,'dirty');
  writer=new Participant(root,file=>graphAt(root,file));
  await writer.write(g=>{g.db.getDb().exec("CREATE TABLE custom_payload(value TEXT); INSERT INTO custom_payload VALUES('must-survive')");});writer.close();writer=null;
  const result=await oneShot('publish',root);assert.equal(result.status,'cancelled');assert.match(result.error,/ownership changed/);
  assert.equal(await signature(reader),'(value=1)');
  await reader.request(g=>assert.equal(g.db.getDb().prepare('SELECT value FROM custom_payload').get().value,'must-survive'));
  assert.equal((await checkSource(root)).status,'blocked');
 }finally{writer?.close();reader.close();}
}));
