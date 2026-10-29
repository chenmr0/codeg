/** Opt-in read-gate protocol tests; fixture adapters, not production integration. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {initialize,Participant,state,lease} from './protocol.mjs';
import {fixture,snapshot} from './worker.mjs';
const worker=fileURLToPath(new URL('./worker.mjs',import.meta.url));
function setup(t,options={}){const root=fs.mkdtempSync(path.join(os.tmpdir(),'read-gate-')),p=initialize(root);fixture(p.active,'A');const participant=new Participant(root,f=>new DatabaseSync(f),{readGates:true,measureGates:true,pollMs:5,...options});t.after(()=>{participant.close();fs.rmSync(root,{recursive:true,force:true});});return{root,p,participant};}
function publisher(t,root,config={}){const c=fork(config.workerFile??worker,['publisher',root,JSON.stringify(config)],{execArgv:['--liftoff-only'],stdio:['ignore','ignore','pipe','ipc']});const messages=[];let stderr='';c.stderr.on('data',b=>stderr+=b);c.on('message',m=>messages.push(m));const done=new Promise((resolve,reject)=>{c.on('error',reject);c.on('exit',(code,signal)=>{const r=messages.find(m=>m.event==='result')?.result;if(code!==0||!r)reject(new Error(`publisher ${code}/${signal} ${stderr} ${JSON.stringify(messages)}`));else resolve(r);});});done.catch(()=>{});t.after(()=>{if(c.exitCode===null&&c.signalCode===null)c.kill('SIGKILL');});return{done,messages};}
async function until(fn){const end=Date.now()+10000;while(!fn()){if(Date.now()>end)throw Error('deterministic barrier timeout');await delay(2);}}
function warm(participant){assert.deepEqual(participant.requestSync(snapshot),{first:'A',second:'A'});assert.deepEqual(participant.requestSync(snapshot),{first:'A',second:'A'});assert(participant.p.gateMetrics.some(m=>m.label==='admit-warm-read'&&m.readOnly));}

test('read gates: reader-first warm request keeps old lease through independent publication',async t=>{
 const {root,p,participant}=setup(t);warm(participant);let release;const held=new Promise(r=>release=r);let started;const entered=new Promise(r=>started=r);
 const old=participant.request(async db=>{const before=snapshot(db);started();await held;return{before,after:snapshot(db)};});await entered;
 const pub=publisher(t,root);try{await until(()=>pub.messages.some(m=>m.phase==='draining'));assert.equal(state(p).mode,'draining');const exclusive=lease(p.connections,true);exclusive?.close();assert.equal(exclusive,null,'live old request retains cross-process lease');assert.equal(participant.active,1);release();assert.deepEqual(await old,{before:{first:'A',second:'A'},after:{first:'A',second:'A'}});assert.equal((await pub.done).status,'published');assert.deepEqual(await participant.request(snapshot),{first:'B',second:'B'});assert.equal(participant.active,0);}finally{release();await old;}
});

test('read gates: publisher-first blocks warm request and it reads only new database',async t=>{
 const {root,p,participant}=setup(t);warm(participant);const paused=path.join(p.runtime,'paused'),resume=path.join(p.runtime,'resume');const pub=publisher(t,root,{pauseAt:'draining',pausedFile:paused,resumeFile:resume});await until(()=>fs.existsSync(paused));let ran=false;const query=participant.request(db=>{ran=true;return snapshot(db);});query.catch(()=>{});
 try{await delay(20);assert.equal(ran,false,'callback cannot execute during closed admission');assert.equal(participant.active,0,'rejected attempts cannot count as live requests');assert.equal(participant.holder,null,'idle warm handle retired');}finally{fs.writeFileSync(resume,'go');}
 assert.equal((await pub.done).status,'published');assert.deepEqual(await query,{first:'B',second:'B'});assert.equal(participant.active,0);
});

test('read gates keep writes exclusive with durable intent and explicit off keeps original gate mode',async t=>{
 const {p,participant}=setup(t);warm(participant);const revision=state(p).revision;await participant.write(db=>{assert.equal(state(p).revision,revision+1,'intent durable before action');db.prepare('UPDATE snapshot SET first=?,second=?').run('W','W');});assert.equal(state(p).revision,revision+1);assert(participant.p.gateMetrics.some(m=>m.label==='admit-write'&&!m.readOnly));assert.deepEqual(participant.requestSync(snapshot),{first:'W',second:'W'});assert.equal(state(p).revision,revision+1,'reads do not increment revision');
 const legacy=new Participant(p.project,f=>new DatabaseSync(f),{readGates:false,measureGates:true});try{legacy.requestSync(snapshot);legacy.requestSync(snapshot);assert(!legacy.p.gateMetrics.some(m=>m.label.startsWith('admit-')&&m.readOnly));assert(legacy.p.gateMetrics.some(m=>m.label==='retire-state'&&m.readOnly));}finally{legacy.close();}
});

test('read-only admission COMMIT failure does not replay callback or release older request',async t=>{
 const {p,participant}=setup(t);warm(participant);let release;const held=new Promise(r=>release=r);const old=participant.request(async db=>{const before=snapshot(db);await held;return{before,after:snapshot(db)};});assert.equal(participant.active,1);const handle=participant.handle,holder=participant.holder,original=DatabaseSync.prototype.exec;let armed=true,ran=0;
 try{DatabaseSync.prototype.exec=function(sql){if(armed&&sql==='COMMIT'){armed=false;throw Object.assign(Error('injected readonly COMMIT error'),{code:'SQLITE_IOERR'});}return original.call(this,sql);};assert.throws(()=>participant.requestSync(()=>{ran++;}),/injected readonly COMMIT/);assert.equal(armed,false);}finally{DatabaseSync.prototype.exec=original;}
 try{assert.equal(ran,0);assert.equal(participant.active,1);assert.equal(participant.handle,handle);assert.equal(participant.holder,holder);const exclusive=lease(p.connections,true);exclusive?.close();assert.equal(exclusive,null);assert(participant.p.gateMetrics.some(m=>m.label==='admit-warm-read'&&m.readOnly));}finally{release();}
 assert.deepEqual(await old,{before:{first:'A',second:'A'},after:{first:'A',second:'A'}});assert.equal(participant.active,0);assert.deepEqual(participant.requestSync(snapshot),{first:'A',second:'A'});
});


test('warm SHARED admission blocks draining COMMIT until its own admission completes',async t=>{
 const {root,p,participant}=setup(t);warm(participant);
 const ready=path.join(p.runtime,'preflight-ready'),go=path.join(p.runtime,'preflight-go'),attempt=path.join(p.runtime,'drain-commit-attempt'),committed=path.join(p.runtime,'drain-committed'),script=path.join(p.runtime,'gate-writer.mjs');
 const protocol=new URL('./protocol.mjs',import.meta.url).href;
 fs.writeFileSync(script,`import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';import {beginOperation,publish} from ${JSON.stringify(protocol)};
 const op=beginOperation(${JSON.stringify(root)});{const d=new DatabaseSync(op.record.candidate);d.exec("CREATE TABLE snapshot(id INTEGER PRIMARY KEY,first TEXT,second TEXT);INSERT INTO snapshot VALUES(1,'B','B')");d.close();}let draining=false;const prepare=DatabaseSync.prototype.prepare,exec=DatabaseSync.prototype.exec;
 DatabaseSync.prototype.prepare=function(sql){if(sql.includes("UPDATE state SET mode='draining'"))draining=true;return prepare.call(this,sql);};
 DatabaseSync.prototype.exec=function(sql){if(draining&&sql==='COMMIT')fs.writeFileSync(${JSON.stringify(attempt)},'attempt');const r=exec.call(this,sql);if(draining&&sql==='COMMIT'){draining=false;fs.writeFileSync(${JSON.stringify(committed)},'committed');}return r;};
 const result=await publish(op,{finalSourceFence(){fs.writeFileSync(${JSON.stringify(ready)},'ready');const end=Date.now()+5000;while(!fs.existsSync(${JSON.stringify(go)})){if(Date.now()>end)throw Error('preflight barrier timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1);}}});await new Promise((resolve,reject)=>process.send({event:'result',result},error=>error?reject(error):resolve()));process.disconnect();`);
 const pub=publisher(t,root,{workerFile:script});await until(()=>fs.existsSync(ready));
 const prepare=DatabaseSync.prototype.prepare;let armed=true,sawCommitBlocked=false,release;const hold=new Promise(r=>release=r);let old;
 try{
  DatabaseSync.prototype.prepare=function(sql){const statement=prepare.call(this,sql);if(sql!=='SELECT * FROM state WHERE id=1'||!armed)return statement;return new Proxy(statement,{get(target,key){if(key==='get')return(...args)=>{const value=target.get(...args);armed=false;assert.equal(value.mode,'idle');fs.writeFileSync(go,'go');const end=Date.now()+400;while(!fs.existsSync(attempt)){if(Date.now()>end)throw Error('publisher did not attempt draining COMMIT');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1);}assert.equal(fs.existsSync(committed),false,'publisher cannot commit past live SHARED gate');sawCommitBlocked=true;return value;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});};
  old=participant.request(async db=>{const before=snapshot(db);await hold;return{before,after:snapshot(db)};});old.catch(()=>{});
 }finally{DatabaseSync.prototype.prepare=prepare;}
 try{assert.equal(sawCommitBlocked,true);await until(()=>fs.existsSync(committed));assert.equal(participant.active,1);const fence=lease(p.connections,true);fence?.close();assert.equal(fence,null,'admitted request retains its lease after gate COMMIT');release();assert.deepEqual(await old,{before:{first:'A',second:'A'},after:{first:'A',second:'A'}});assert.equal((await pub.done).status,'published');assert.deepEqual(participant.requestSync(snapshot),{first:'B',second:'B'});}finally{release();if(old)await old;}
});
