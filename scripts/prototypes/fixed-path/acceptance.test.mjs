/** Run: node --liftoff-only --test scripts/prototypes/fixed-path/acceptance.test.mjs
 * Fixture-SQL acceptance tests. Real CodeGraph adapters are tested separately.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { initialize, paths, recover, records, state, gate, sha, cleanup, beginOperation, Participant, lease } from './protocol.mjs';
import { fixture, snapshot } from './worker.mjs';

const worker = fileURLToPath(new URL('./worker.mjs', import.meta.url));
const roots=[]; const evidence={platform:process.platform,arch:process.arch,node:process.version,startedAt:new Date().toISOString(),scope:'isolated cooperative protocol adapters; NOT production CLI/MCP coverage',cases:[],switches:[],queries:[]};
const evidenceDir=process.env.FIXED_PATH_EVIDENCE_DIR || path.resolve('artifacts/fixed-path-prototype',`${process.platform}-${Date.now()}`);
fs.mkdirSync(evidenceDir,{recursive:true});
let sequence=0;
function root() {const p=fs.mkdtempSync(path.join(os.tmpdir(),'fixed-path-prototype-')); roots.push(p); initialize(p); fixture(paths(p).active,'A'); return p;}
function direct(project) {const d=new DatabaseSync(paths(project).active,{readOnly:true}); try{return snapshot(d);}finally{d.close();}}
function writeRows(project) {const d=new DatabaseSync(paths(project).active,{readOnly:true});try{return d.prepare('SELECT value FROM writes').all().map(x=>x.value);}finally{d.close();}}
function launch(mode, project, config={}) {
  const child=fork(worker,[mode,project,JSON.stringify(config)],{execArgv:['--liftoff-only'],stdio:['ignore','pipe','pipe','ipc']});
  let out='',err='',ended=false; const messages=[],pending=new Map(), waiters=[];
  child.stdout.on('data',b=>out+=b); child.stderr.on('data',b=>err+=b);
  child.on('message',m=>{messages.push(m); if(m.id&&!m.event&&pending.has(m.id)){const p=pending.get(m.id); pending.delete(m.id);m.error?p.reject(new Error(m.error)):p.resolve(m.value);} for(const w of [...waiters])if(w.predicate(m)){waiters.splice(waiters.indexOf(w),1);clearTimeout(w.timer);w.resolve(m);}});
  const exited=new Promise(resolve=>child.on('close',(code,signal)=>{ended=true;for(const p of pending.values())p.reject(new Error(`Child exited ${code}/${signal}: ${err}`));pending.clear();resolve({code,signal,out,err,messages});}));
  return {child,messages,exited, request(command,args={}){const id=String(++sequence);return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});child.send({id,command,...args});});},
    wait(predicate,timeout=10000){const found=messages.find(predicate);if(found)return Promise.resolve(found);return new Promise((resolve,reject)=>{const entry={predicate,resolve,reject,timer:setTimeout(()=>{waiters.splice(waiters.indexOf(entry),1);reject(new Error(`Message wait timed out (${mode}): ${err}; messages=${JSON.stringify(messages)}`));},timeout)};waiters.push(entry);});},
    async stop(){if(!ended){await this.request('close');await exited;}}, kill(){if(!ended)child.kill('SIGKILL');}};
}
async function client(project,role='SDK',options={}){const c=launch('client',project,{role,...options});await c.wait(m=>m.event==='ready'||m.event==='fatal').then(m=>{if(m.event==='fatal')throw new Error(m.error);});return c;}
async function published(project,config={}){const p=launch('publisher',project,config);const end=await p.exited;const result=end.messages.find(m=>m.event==='result')?.result;assert.ok(result,`Publisher missing result: ${JSON.stringify(end)}`);evidence.switches.push(result);return result;}
function noOld(project){for(const r of records(paths(project))){assert.equal(fs.existsSync(r.backup),false,`Old DB retained: ${r.backup}`);assert.equal(fs.existsSync(r.candidate),false,`Candidate retained: ${r.candidate}`);}}
function quantiles(samples){const a=[...samples].sort((a,b)=>a-b);const q=p=>a[Math.min(a.length-1,Math.ceil(p*a.length)-1)]??0;return {count:a.length,p50Ms:q(.50),p95Ms:q(.95),p99Ms:q(.99),maxMs:a.at(-1)??0};}
async function record(name,fn){const start=performance.now();try{await fn();evidence.cases.push({name,status:'pass',durationMs:performance.now()-start});}catch(e){evidence.cases.push({name,status:'fail',durationMs:performance.now()-start,error:e.stack});throw e;}}
after(()=>{evidence.completedAt=new Date().toISOString();const failed=evidence.cases.some(c=>c.status==='fail');if(failed)evidence.retainedFixtureRoots=roots;fs.writeFileSync(path.join(evidenceDir,'acceptance.json'),JSON.stringify(evidence,null,2));console.log(`FIXED_PATH_EVIDENCE=${path.join(evidenceDir,'acceptance.json')}`);if(!failed)for(const r of roots)fs.rmSync(r,{recursive:true,force:true});});

test('no readers: actual fixed path publishes and old/candidate are reclaimed',()=>record('no-readers',async()=>{
  const p=root();const result=await published(p);assert.equal(result.status,'published');assert.deepEqual(direct(p),{first:'B',second:'B'});assert.equal(fs.lstatSync(paths(p).active).isSymbolicLink(),false);assert.equal(state(paths(p)).mode,'idle');noOld(p);
}));

test('five independent prototype participant processes remain consistent across repeated switches',()=>record('multi-process-query-and-idle',async()=>{
 const p=root(), clients=[], roles=['CLI','MCP','daemon','SDK','worker'], explicitObserved=roles.map(role=>({role,tags:[]})), explicitSamples=[];
 async function observeAll(tag){await Promise.all(clients.map(async(c,index)=>{const started=performance.now(),value=await c.request('query');explicitSamples.push(performance.now()-started);assert.deepEqual(value,{first:tag,second:tag},`${roles[index]} must explicitly observe published ${tag} before the next publication`);explicitObserved[index].tags.push(tag);}));}
 try{
  for(const role of roles)clients.push(await client(p,role));
  await observeAll('A');
  await Promise.all(clients.map(c=>c.request('startLoop',{intervalMs:2})));await delay(200);
  // A fixed sleep cannot prove that every process visited an intermediate database.
  // Keep background traffic running, but require explicit per-process acknowledgement.
  for(const tag of ['B','C','D']){const result=await published(p,{tag});assert.equal(result.status,'published',JSON.stringify(result));assert.ok(result.metrics.admissionPauseMs<=1000,`Switch pause exceeded 1s: ${result.metrics.admissionPauseMs}`);await observeAll(tag);}
  const results=await Promise.all(clients.map(c=>c.request('stopLoop')));
  for(const [index,r] of results.entries()){assert.deepEqual(r.errors,[]);assert.equal(r.backgroundError,undefined);assert.ok(r.reopens>=4,`Expected reopen after each explicitly observed cutover: ${r.reopens}`);assert.deepEqual(explicitObserved[index].tags,['A','B','C','D']);assert(r.tags.every(tag=>['A','B','C','D'].includes(tag)),'Background observations remain valid even if they skip a generation');}
  const q=quantiles(results.flatMap(r=>r.samples)), explicitQueries=quantiles(explicitSamples);evidence.queries.push({scenario:'five-process repeated switch',...q,explicitObserved,explicitQueries,explicitTimingScope:'parent request-to-reply including IPC'});assert.ok(q.maxMs<=1000,`Observed short query wait exceeds 1s: ${q.maxMs}`);assert.ok(explicitQueries.maxMs<=1000,`Explicit query acknowledgement exceeds 1s: ${explicitQueries.maxMs}`);
  // Leave all five native handles idle and prove automatic closure, no EOF/restart/GC.
  const last=await published(p,{tag:'E'});assert.equal(last.status,'published');for(const c of clients)assert.equal((await c.request('query')).first,'E');noOld(p);
 }finally{await Promise.all(clients.map(c=>c.stop().catch(()=>c.kill())));}
}));

test('long request cancels bounded drain; old request and queued new request complete',()=>record('long-request-timeout',async()=>{
 const p=root(),c=await client(p);try{
  const held=c.request('hold',{ms:1500});held.catch(()=>{});await c.wait(m=>m.event==='held');const pub=launch('publisher',p);await pub.wait(m=>m.phase==='draining');const started=performance.now();const queued=c.request('query');queued.catch(()=>{});
  const result=(await pub.wait(m=>m.event==='result')).result;await pub.exited;assert.equal(result.status,'cancelled');assert.equal(result.code,'DRAIN_CANCELLED');assert.match(result.error,/budget/);assert.ok(performance.now()-started<1350,'Drain cancellation was unbounded');
  assert.equal((await queued).first,'A');assert.deepEqual(await held,{before:{first:'A',second:'A'},after:{first:'A',second:'A'}});assert.equal((await c.request('query')).first,'A');noOld(p);
 }finally{await c.stop().catch(()=>c.kill());}
}));

test('sync SDK call while same process owns async request cancels rather than self-deadlocking',()=>record('sync-sdk-self-deadlock',async()=>{
 const p=root(),c=await client(p);try{
  const held=c.request('hold',{ms:1500});held.catch(()=>{});await c.wait(m=>m.event==='held');const pub=launch('publisher',p);await pub.wait(m=>m.phase==='draining');const started=performance.now();assert.equal((await c.request('querySync')).first,'A');assert.ok(performance.now()-started<1000);
  const result=(await pub.wait(m=>m.event==='result')).result;await pub.exited;assert.equal(result.status,'cancelled');assert.match(result.error,/Synchronous caller/);assert.equal((await held).after.first,'A');noOld(p);
 }finally{await c.stop().catch(()=>c.kill());}
}));

for(const [name,config] of [['candidate-validation',{failValidation:true}],['candidate-corruption',{corruptCandidate:true}],['source-change',{failSource:true}],['space',{fail:'space'}],['rename',{fail:'rename'}]])test(`failure ${name} leaves old active`,()=>record(`failure-${name}`,async()=>{
 const p=root(),before=sha(paths(p).active);const r=await published(p,config);assert.equal(r.status,'cancelled');assert.equal(sha(paths(p).active),before);assert.equal(direct(p).first,'A');assert.equal(state(paths(p)).mode,'idle');noOld(p);
}));

test('cleanup failure never rolls back committed data; restart retries collection',()=>record('cleanup-restart',async()=>{
 const p=root();const r=await published(p,{fail:'cleanup'});assert.equal(r.status,'published');assert.match(r.cleanupError,/sharing/);assert.ok(records(paths(p)).some(x=>fs.existsSync(x.backup)));
 const c=await client(p);try{assert.equal((await c.request('query')).first,'B');}finally{await c.stop();}noOld(p);
}));

const crashPhases=['building','prepared','draining','replacing','before-old-rename','after-old-rename','old-moved','before-new-rename','after-new-rename','new-moved','before-commit','committed','resumed'];
for(const phase of crashPhases)test(`crash at ${phase} recovers exact old/new authority`,()=>record(`crash-${phase}`,async()=>{
 const p=root(),trace=path.join(evidenceDir,`crash-${phase}.jsonl`);const pub=launch('publisher',p,{crashAt:phase,trace});const end=await pub.exited;assert.ok(end.signal||end.code!==0,`Expected forced exit: ${JSON.stringify(end)}`);
 assert.equal(recover(p),true);assert.equal(state(paths(p)).mode,'idle');assert.equal(direct(p).first,['committed','resumed'].includes(phase)?'B':'A');noOld(p);
}));

test('confirmed write after publication survives publisher crash and subsequent recovery',()=>record('post-commit-write-preserved',async()=>{
 const p=root(),proof=path.join(p,'write-confirmed');const pub=launch('publisher',p,{writeAfterResume:true,crashAfterWrite:true,writeProof:proof});await pub.exited;assert.equal(fs.readFileSync(proof,'utf8'),'confirmed-after-publish');assert.equal(recover(p),true);assert.equal(direct(p).first,'B');assert.deepEqual(writeRows(p),['confirmed-after-publish']);noOld(p);
}));

test('unknown identities after crash fail closed and preserve files',()=>record('ambiguous-recovery-preserves',async()=>{
 const p=root();const pub=launch('publisher',p,{crashAt:'after-new-rename'});await pub.exited;const r=records(paths(p)).at(-1);const d=new DatabaseSync(paths(p).active);d.prepare('UPDATE snapshot SET first=?,second=?').run('UNKNOWN','UNKNOWN');d.close();
 assert.throws(()=>recover(p),/Unrecognized recovery identities/);assert.notEqual(state(paths(p)).mode,'idle');assert.ok(fs.existsSync(r.backup));assert.equal(direct(p).first,'UNKNOWN');
}));

test('offline public overwrite -> incremental write -> rebuild -> overwrite repeats without deleting internal state',()=>record('offline-overwrite-cycle',async()=>{
 const p=root(),pub1=path.join(p,'public-one.db'),pub2=path.join(p,'public-two.db');fixture(pub1,'PUBLIC1');fixture(pub2,'PUBLIC2');
 fs.writeFileSync(path.join(paths(p).data,'CURRENT'),JSON.stringify({generation:'stale-different-generation'}));
 for(let round=0;round<3;round++){
  // Every client is stopped before a complete standalone file is copied.
  fs.copyFileSync(pub1,paths(p).active);let c=await client(p);assert.equal((await c.request('query')).first,'PUBLIC1');await c.request('write',{tag:`LOCAL${round}`});assert.equal((await c.request('query')).first,`LOCAL${round}`);
  const r=await published(p,{tag:`REBUILT${round}`,fail:round===1?'cleanup':undefined});assert.equal(r.status,'published');assert.equal((await c.request('query')).first,`REBUILT${round}`);await c.stop();
  fs.copyFileSync(pub2,paths(p).active);c=await client(p);assert.equal((await c.request('query')).first,'PUBLIC2');await c.request('write',{tag:`AFTER${round}`});assert.equal((await c.request('query')).first,`AFTER${round}`);await c.stop();noOld(p);
 }
 assert.ok(fs.existsSync(path.join(paths(p).data,'CURRENT')),'Test must not remove stale CURRENT');
}));

test('corrupt offline overwrite is an error, never a fallback to old backup',()=>record('corrupt-public-file',async()=>{
 const p=root();await published(p,{fail:'cleanup'});fs.writeFileSync(paths(p).active,'corrupt public database');const c=await client(p);try{await assert.rejects(c.request('query'),/not a database|malformed/);}finally{await c.stop().catch(()=>c.kill());}assert.equal(fs.readFileSync(paths(p).active,'utf8'),'corrupt public database');
}));


test('crashed registered reader releases OS lease and cannot permanently block publisher',()=>record('reader-process-crash',async()=>{
 const p=root(),c=await client(p);const held=c.request('hold',{ms:10000});held.catch(()=>{});await c.wait(m=>m.event==='held');const pub=launch('publisher',p);await pub.wait(m=>m.phase==='draining');c.kill();await c.exited;const result=(await pub.wait(m=>m.event==='result')).result;await pub.exited;assert.equal(result.status,'published',JSON.stringify(result));assert.equal(direct(p).first,'B');noOld(p);
}));

test('committed old WAL is checkpointed before switching; sidecars are never assigned to candidate',()=>record('wal-pairing',async()=>{
 const p=root(),c=await client(p,'MCP',{wal:true});try{await c.request('write',{tag:'OLD-WAL'});assert.equal((await c.request('query')).first,'OLD-WAL');const r=await published(p,{tag:'NEW-CLEAN'});assert.equal(r.status,'published',JSON.stringify(r));assert.equal((await c.request('query')).first,'NEW-CLEAN');}finally{await c.stop().catch(()=>c.kill());}noOld(p);
}));

test('new process cannot reopen active database while admission is draining',()=>record('cold-admission-during-drain',async()=>{
 const p=root(),old=await client(p);let newcomer;
 try{const held=old.request('hold',{ms:1500});held.catch(()=>{});await old.wait(m=>m.event==='held');const pub=launch('publisher',p);await pub.wait(m=>m.phase==='draining');newcomer=await client(p,'new-SDK');let resolved=false;const queued=newcomer.request('query').then(r=>{resolved=true;return r;});queued.catch(()=>{});await delay(100);assert.equal(resolved,false,'Cold request reopened during drain');const result=(await pub.wait(m=>m.event==='result')).result;await pub.exited;assert.equal(result.status,'cancelled');assert.equal((await queued).first,'A');await held;}
 finally{await old.stop().catch(()=>old.kill());await newcomer?.stop().catch(()=>newcomer.kill());}
}));

for(const phase of ['after-old-rename','after-new-rename'])test(`file operation error at ${phase} restores old without deleting evidence early`,()=>record(`rename-error-${phase}`,async()=>{
 const p=root();const r=await published(p,{throwAt:phase});assert.equal(r.status,'cancelled');assert.equal(direct(p).first,'A');assert.equal(state(paths(p)).mode,'idle');noOld(p);
}));

test('unsafe recovery paths are rejected before touching unrelated files',()=>record('unsafe-recovery-path',async()=>{
 const p=root();const pub=launch('publisher',p,{crashAt:'after-old-rename'});await pub.exited;const r=records(paths(p)).at(-1),unrelated=path.join(p,'keep-me.db');fixture(unrelated,'UNRELATED');const before=sha(unrelated);gate(paths(p),g=>g.prepare('UPDATE operations SET record=? WHERE id=?').run(JSON.stringify({...r,backup:unrelated}),r.id));assert.throws(()=>recover(p),/Unsafe recovery paths/);assert.equal(sha(unrelated),before);assert.ok(fs.existsSync(r.backup));assert.notEqual(state(paths(p)).mode,'idle');
}));

test('single standalone public file opens on different project path without producer runtime',()=>record('public-file-different-project',async()=>{
 const source=root();await published(source,{tag:'PUBLIC-RELOCATED'});const target=root();fs.copyFileSync(paths(source).active,paths(target).active);const c=await client(target);try{assert.equal((await c.request('query')).first,'PUBLIC-RELOCATED');await c.request('write',{tag:'TARGET-SYNC'});assert.equal((await c.request('query')).first,'TARGET-SYNC');}finally{await c.stop();}
}));

test('simultaneous cold clients initialize protocol metadata without a partially-created lease database',()=>record('concurrent-cold-bootstrap',async()=>{
 for(let round=0;round<5;round++){
  const p=fs.mkdtempSync(path.join(os.tmpdir(),'fixed-path-cold-'));roots.push(p);fixture(paths(p).active,'COLD');const startFile=path.join(p,'start'),children=['CLI','MCP','daemon','SDK','worker'].map(role=>launch('client',p,{role,startFile}));
  try{await Promise.all(children.map(c=>c.wait(m=>m.event==='boot-waiting')));fs.writeFileSync(startFile,'go');const results=await Promise.allSettled(children.map(async c=>{const ready=await c.wait(m=>m.event==='ready'||m.event==='fatal');if(ready.event==='fatal')throw new Error(ready.error);return c.request('query');}));for(const r of results){assert.equal(r.status,'fulfilled',r.reason?.stack);assert.equal(r.value.first,'COLD');}}
  finally{await Promise.all(children.map(c=>c.stop().catch(()=>c.kill())));}
 }
}));

for(const phase of ['after-old-rename','new-moved'])test(`cold admission cannot observe replacement gap at ${phase}`,()=>record(`cold-admission-${phase}`,async()=>{
 const p=root(),pausedFile=path.join(p,'paused'),resumeFile=path.join(p,'resume');const pub=launch('publisher',p,{pauseAt:phase,pausedFile,resumeFile});let c;
 try{const until=performance.now()+5000;while(!fs.existsSync(pausedFile)){if(performance.now()>until)throw new Error('Publisher did not enter pause');await delay(5);}c=await client(p,'cold-SDK');let resolved=false;const query=c.request('query').then(r=>{resolved=true;return r;});query.catch(()=>{});await delay(100);assert.equal(resolved,false,'Request admitted before publication committed');fs.writeFileSync(resumeFile,'go');assert.equal((await query).first,'B');const result=(await pub.wait(m=>m.event==='result')).result;await pub.exited;assert.equal(result.status,'published');noOld(p);}
 finally{if(!fs.existsSync(resumeFile))fs.writeFileSync(resumeFile,'go');await c?.stop().catch(()=>c.kill());await pub.exited;}
}));

test('failed candidate WAL and SHM are reclaimed only after builder OS lease is gone',()=>record('dirty-builder-crash-cleanup',async()=>{
 const p=root();const pub=launch('publisher',p,{dirtyBuildCrash:true});await pub.exited;const r=records(paths(p)).at(-1);assert.ok(fs.existsSync(r.candidate+'-wal'),'Fault must leave a real candidate WAL');assert.equal(recover(p),true);assert.equal(direct(p).first,'A');for(const suffix of ['','-wal','-shm','-journal'])assert.equal(fs.existsSync(r.candidate+suffix),false);noOld(p);
}));

test('unknown files in an operation directory prevent cleanup rather than age-based deletion',()=>record('unknown-cleanup-artifact',async()=>{
 const p=root();await published(p,{fail:'cleanup'});const r=records(paths(p)).at(-1);const unknown=path.join(r.directory,'unrecognized-evidence.txt');fs.writeFileSync(unknown,'keep this');assert.equal(recover(p),true);assert.equal(direct(p).first,'B');assert.equal(fs.readFileSync(unknown,'utf8'),'keep this');assert.ok(fs.existsSync(r.backup));
}));

test('participating mutation after candidate construction invalidates build baseline',()=>record('write-during-build-baseline',async()=>{
 const p=root(),c=await client(p),pausedFile=path.join(p,'paused'),resumeFile=path.join(p,'resume');const pub=launch('publisher',p,{pauseAt:'prepared',pausedFile,resumeFile});
 try{const until=performance.now()+5000;while(!fs.existsSync(pausedFile)){if(performance.now()>until)throw new Error('Publisher did not enter prepared pause');await delay(5);}await c.request('write',{tag:'NEWER-WRITE'});fs.writeFileSync(resumeFile,'go');const result=(await pub.wait(m=>m.event==='result')).result;await pub.exited;assert.equal(result.status,'cancelled','Publishing stale candidate would overwrite a completed newer write');assert.equal((await c.request('query')).first,'NEWER-WRITE');noOld(p);}
 finally{if(!fs.existsSync(resumeFile))fs.writeFileSync(resumeFile,'go');await c.stop().catch(()=>c.kill());await pub.exited;}
}));

for(const field of ['connections','owner'])test(`established metadata missing ${field} lease database fails closed without recreating live locks`,()=>record(`missing-${field}-lease-database`,async()=>{
 const project=root(),p=paths(project),before=sha(p.active);fs.unlinkSync(p[field]);assert.throws(()=>initialize(project),/Missing protocol lease database/);assert.equal(fs.existsSync(p[field]),false,'Initialize must not recreate a missing lease');assert.throws(()=>recover(project),/Missing protocol lease database|ENOENT|no such file/i);assert.equal(fs.existsSync(p[field]),false,'Recovery must not recreate a missing lease');assert.equal(sha(p.active),before);
}));

test('tampered cleaned tombstone cannot delete an unrelated empty directory outside runtime',()=>record('cleaned-tombstone-unsafe-directory',async()=>{
 const project=root();await published(project);const p=paths(project),record=records(p).at(-1);assert.equal(record.phase,'cleaned');const unrelated=path.join(project,'unrelated-empty-directory');fs.mkdirSync(unrelated);const tampered={...record,directory:unrelated,candidate:path.join(unrelated,'candidate.db'),backup:path.join(unrelated,'old.db')};gate(p,g=>g.prepare('UPDATE operations SET record=? WHERE id=?').run(JSON.stringify(tampered),record.id));assert.throws(()=>cleanup(p,tampered),/Unsafe recovery paths/);assert.equal(fs.lstatSync(unrelated).isDirectory(),true);assert.equal(recover(project),true);assert.equal(fs.lstatSync(unrelated).isDirectory(),true,'Startup cleanup must preserve unrelated directory');assert.equal(direct(project).first,'B');
}));

test('writer COMMIT followed by SIGKILL before finally cannot be lost to a stale candidate',()=>record('crashed-writer-committed-mutation',async()=>{
 const project=root(),p=paths(project),c=await client(project),pausedFile=path.join(project,'paused'),resumeFile=path.join(project,'resume'),proof=path.join(project,'write-confirmed');const pub=launch('publisher',project,{pauseAt:'prepared',pausedFile,resumeFile});
 try{const until=performance.now()+5000;while(!fs.existsSync(pausedFile)){if(performance.now()>until)throw new Error('Publisher did not enter prepared pause');await delay(5);}const baseline=records(p).at(-1).baselineRevision;const killed=c.request('writeAndCrash',{proof});killed.catch(()=>{});await c.exited;assert.equal(fs.readFileSync(proof,'utf8'),'CONFIRMED-WRITE');assert.equal(direct(project).first,'CONFIRMED-WRITE');assert.ok(state(p).revision>baseline,'Mutation intent must be durable before callback executes');fs.writeFileSync(resumeFile,'go');const result=(await pub.wait(m=>m.event==='result')).result;await pub.exited;assert.equal(result.status,'cancelled');assert.equal(direct(project).first,'CONFIRMED-WRITE');assert.equal(recover(project),true);assert.equal(direct(project).first,'CONFIRMED-WRITE');noOld(project);}
 finally{if(!fs.existsSync(resumeFile))fs.writeFileSync(resumeFile,'go');c.kill();await pub.exited;}
}));

test('build baseline is rejected while a participating writer is active without creating an operation',()=>record('active-writer-baseline-rejection',async()=>{
 const project=root(),p=paths(project),c=await client(project);try{const held=c.request('holdWrite',{ms:400});held.catch(()=>{});await c.wait(m=>m.event==='writer-held');const before=records(p);const names=fs.readdirSync(p.runtime).filter(n=>fs.statSync(path.join(p.runtime,n)).isDirectory());assert.throws(()=>beginOperation(project),/baseline.*write is active/i);assert.deepEqual(records(p),before);assert.deepEqual(fs.readdirSync(p.runtime).filter(n=>fs.statSync(path.join(p.runtime,n)).isDirectory()),names,'Rejected baseline must not leave half-created operation directories');assert.equal((await held).first,'ACTIVE-WRITER');const result=await published(project,{tag:'AFTER-WRITER'});assert.equal(result.status,'published','Rejected baseline must release publisher ownership');assert.equal((await c.request('query')).first,'AFTER-WRITER');noOld(project);}
 finally{await c.stop().catch(()=>c.kill());}
}));

test('same-client sync query waits through pre-rename recovery while async old request remains active',()=>record('sync-during-abandoned-drain-recovery',async()=>{
 const project=root(),p=paths(project),c=await client(project),pausedFile=path.join(project,'recovery-paused'),resumeFile=path.join(project,'recovery-resume');let recovery;
 try{const held=c.request('hold',{ms:1500});held.catch(()=>{});await c.wait(m=>m.event==='held');const pub=launch('publisher',project,{crashAt:'draining'});await pub.exited;assert.equal(state(p).mode,'draining');recovery=launch('recover',project,{pauseAt:'recovering',pausedFile,resumeFile});const deadline=performance.now()+5000;while(!fs.existsSync(pausedFile)){if(performance.now()>deadline)throw new Error('Recovery did not enter pause');await delay(5);}assert.equal(state(p).mode,'recovering','Pause must occur after durable mode transition, outside gate');let settled=false;const query=c.request('querySync').then(v=>{settled=true;return v;},e=>{settled=true;throw e;});query.catch(()=>{});await delay(100);assert.equal(settled,false,'Synchronous request must not reject or escape while pre-rename recovery owns admission');fs.writeFileSync(resumeFile,'resume');assert.equal((await query).first,'A');const result=(await recovery.wait(m=>m.event==='result')).result;assert.equal(result,true);await recovery.exited;assert.deepEqual(await held,{before:{first:'A',second:'A'},after:{first:'A',second:'A'}});assert.equal(state(p).mode,'idle');assert.equal((await c.request('query')).first,'A');noOld(project);}
 finally{if(!fs.existsSync(resumeFile))fs.writeFileSync(resumeFile,'resume');await recovery?.exited;await c.stop().catch(()=>c.kill());}
}));

for(const kind of ['read','write'])test(`fresh ${kind} admission COMMIT failure unwinds only allocated handles and leases`,()=>record(`admission-commit-failure-${kind}`,async()=>{
 const project=root(),p=paths(project),original=DatabaseSync.prototype.exec;let armed=false,ran=false,closes=0,factories=0,participant;
 DatabaseSync.prototype.exec=function(sql){if(armed&&sql==='COMMIT'){armed=false;throw Object.assign(new Error('Injected coordination COMMIT disk I/O error'),{code:'SQLITE_IOERR'});}return original.call(this,sql);};
 try{participant=new Participant(project,file=>{factories++;const db=new DatabaseSync(file);return {prepare:(...args)=>db.prepare(...args),close(){closes++;db.close();}};});armed=true;const action=db=>{ran=true;return snapshot(db);};await assert.rejects(kind==='write'?participant.write(action):participant.request(action),/Injected coordination COMMIT/);DatabaseSync.prototype.exec=original;assert.equal(ran,false,'Callback must not execute before admission COMMIT succeeds');assert.equal(participant.active,0);assert.equal(participant.handle,null);assert.equal(participant.holder,null);assert.equal(closes,0);assert.equal(factories,0,'COMMIT failure must precede factory');const connections=lease(p.connections,true);assert.ok(connections,'Failed admission leaked connection lease');connections.close();const writers=lease(p.writers,true);assert.ok(writers,'Failed write admission leaked writer lease');writers.close();assert.equal(state(p).revision,0,'Uncommitted intent must roll back');participant.close();}
 finally{DatabaseSync.prototype.exec=original;if(participant&&!participant.closed)participant.close();}
}));

test('failed reused-handle admission preserves an older asynchronous request and its lease',()=>record('admission-commit-failure-keeps-existing-request',async()=>{
 const project=root(),p=paths(project),original=DatabaseSync.prototype.exec;let closes=0,ran=false,release,start;const started=new Promise(resolve=>start=resolve),blocked=new Promise(resolve=>release=resolve);
 const participant=new Participant(project,file=>{const db=new DatabaseSync(file);return {prepare:(...args)=>db.prepare(...args),close(){closes++;db.close();}};});
 const earlier=participant.request(async db=>{const before=snapshot(db);start();await blocked;return {before,after:snapshot(db)};});earlier.catch(()=>{});
 try{await started;const handle=participant.handle;let armed=true;DatabaseSync.prototype.exec=function(sql){if(armed&&sql==='COMMIT'){armed=false;throw Object.assign(new Error('Injected reused admission COMMIT error'),{code:'SQLITE_IOERR'});}return original.call(this,sql);};assert.throws(()=>participant.requestSync(db=>{ran=true;return snapshot(db);}),/Injected reused admission/);DatabaseSync.prototype.exec=original;assert.equal(ran,false);assert.equal(participant.active,1,'Failure must not decrement the older operation');assert.equal(participant.handle,handle);assert.equal(closes,0,'Failure must not close shared older handle');const fence=lease(p.connections,true);if(fence)fence.close();assert.equal(fence,null,'Older request must retain its OS lease');release();assert.deepEqual(await earlier,{before:{first:'A',second:'A'},after:{first:'A',second:'A'}});assert.equal(participant.active,0);assert.equal(participant.requestSync(db=>snapshot(db)).first,'A');participant.close();assert.equal(closes,1);}
 finally{DatabaseSync.prototype.exec=original;release();await earlier.catch(()=>{});if(!participant.closed)participant.close();}
}));
