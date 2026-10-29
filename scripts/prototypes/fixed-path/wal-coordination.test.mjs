/** WAL admission's cross-process invariants. Protocol adapters, not production MCP.
 * Pre-COMMIT holds below model transaction contention, not physical fsync latency.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {initialize,Participant,state,records,lease,recover} from './protocol.mjs';
import {fixture,snapshot} from './worker.mjs';
import {waitForChildClose} from './ipc.mjs';
const protocol=new URL('./protocol.mjs',import.meta.url).href;
const worker=new URL('./worker.mjs',import.meta.url).href;
const ipc=new URL('./ipc.mjs',import.meta.url).href;
const workerFile=fileURLToPath(new URL('./worker.mjs',import.meta.url));
async function until(fn,message='process barrier'){const end=Date.now()+10000;while(!fn()){if(Date.now()>end)throw Error(`Timed out: ${message}`);await delay(2);}}
function setup(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'wal-coordination-')),p=initialize(root),children=[],participants=[];fixture(p.active,'A');
 t.after(async()=>{for(const c of children)if(c.child.exitCode===null&&c.child.signalCode===null)c.child.kill('SIGKILL');await Promise.allSettled(children.map(c=>c.done));for(const v of participants)v.close();fs.rmSync(root,{recursive:true,force:true});});
 function spawn(file,args=[]){const child=fork(file,args,{execArgv:['--liftoff-only'],stdio:['ignore','ignore','pipe','ipc']}),messages=[];let stderr='';child.stderr.on('data',b=>stderr+=b);child.on('message',m=>messages.push(m));const done=waitForChildClose(child).then(exit=>({...exit,messages,stderr}));done.catch(()=>{});const value={child,messages,done};children.push(value);return value;}
 function participant(options={}){const v=new Participant(root,f=>new DatabaseSync(f),{pollMs:5,...options});participants.push(v);return v;}
 function publisher(config={}){return spawn(workerFile,['publisher',root,JSON.stringify(config)]);}
 function script(name,source){const file=path.join(p.runtime,name+'.mjs');fs.writeFileSync(file,source);return file;}
 return{root,p,spawn,participant,publisher,script};
}
async function result(child){const exit=await child.done;assert.equal(exit.code,0,`${exit.stderr}\n${JSON.stringify(exit.messages)}`);const response=exit.messages.find(m=>m.event==='result');assert(response,`child must deliver result before close: ${JSON.stringify(exit)}`);return response.result;}
function readerScript(ctx,{holdAt,marker,release,attempt}={}){
 return ctx.script('reader-'+Math.random().toString(16).slice(2),`import fs from 'node:fs';import{DatabaseSync}from'node:sqlite';import{Participant,state}from${JSON.stringify(protocol)};import{snapshot}from${JSON.stringify(worker)};import{createIpcChannel}from${JSON.stringify(ipc)};
 const channel=createIpcChannel();let armed=true;
 const participant=new Participant(${JSON.stringify(ctx.root)},f=>new DatabaseSync(f),{pollMs:5,hook(phase,s){
  if(phase==='before-read-lease'&&${JSON.stringify(attempt??'')})fs.writeFileSync(${JSON.stringify(attempt??'')},'attempt');
  if(armed&&phase===${JSON.stringify(holdAt??'never')}){armed=false;fs.writeFileSync(${JSON.stringify(marker??'')},JSON.stringify({phase,state:s??null}));const until=Date.now()+10000;while(!fs.existsSync(${JSON.stringify(release??'')})){if(Date.now()>until)throw Error('reader release timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1);}}
 }});
 const preliminary=state(participant.p);await channel.send({event:'ready',preliminary});
 process.on('message',async message=>{if(message.command!=='query')return;try{const value=await participant.request(db=>snapshot(db));participant.close();await channel.send({event:'result',result:value});await channel.close();}catch(error){process.exitCode=1;try{participant.close();}catch{}await channel.send({event:'fatal',error:error.stack});await channel.close();}});`);
}

test('WAL coordination is separate from DELETE-mode OS lease databases',t=>{
 const{p}=setup(t);for(const[file,expected]of[[p.gate,'wal'],[p.connections,'delete'],[p.owner,'delete'],[p.writers,'delete']]){const db=new DatabaseSync(file);try{assert.equal(Object.values(db.prepare('PRAGMA journal_mode').get())[0],expected,file);}finally{db.close();}}
});

test('lease-first WAL reader snapshot survives draining commit and finishes wholly on A',async t=>{
 const c=setup(t),marker=path.join(c.p.runtime,'reader-held'),release=path.join(c.p.runtime,'reader-release');
 const reader=c.spawn(readerScript(c,{holdAt:'read-state',marker,release}));await until(()=>reader.messages.some(m=>m.event==='ready'));reader.child.send({command:'query'});await until(()=>fs.existsSync(marker));assert.equal(JSON.parse(fs.readFileSync(marker)).state.mode,'idle');
 const pub=c.publisher();await until(()=>pub.messages.some(m=>m.phase==='draining'));assert.equal(state(c.p).mode,'draining');
 const fence=lease(c.p.connections,true);fence?.close();assert.equal(fence,null,'reader lease excludes replacement despite WAL publisher commit');
 fs.writeFileSync(release,'go');assert.deepEqual(await result(reader),{first:'A',second:'A'});assert.equal((await result(pub)).status,'published');assert.deepEqual(c.participant().requestSync(snapshot),{first:'B',second:'B'});
});

test('committed idle state cannot admit a cold reader before publisher fence release',async t=>{
 const c=setup(t),paused=path.join(c.p.runtime,'commit-held'),resume=path.join(c.p.runtime,'commit-release'),attempt=path.join(c.p.runtime,'reader-attempt');
 const reader=c.spawn(readerScript(c,{attempt}));await until(()=>reader.messages.some(m=>m.event==='ready'));
 const pub=c.publisher({pauseAt:'committed',pausedFile:paused,resumeFile:resume});await until(()=>fs.existsSync(paused));assert.equal(state(c.p).mode,'idle','commit and resumed state are one durable transaction');assert.equal(records(c.p).at(-1).phase,'committed');
 const fence=lease(c.p.connections,true);fence?.close();assert.equal(fence,null,'publisher fence still covers post-COMMIT availability');
 reader.child.send({command:'query'});await until(()=>fs.existsSync(attempt));assert.equal(reader.messages.some(m=>m.event==='result'),false);fs.writeFileSync(resume,'go');assert.equal((await result(pub)).status,'published');assert.deepEqual(await result(reader),{first:'B',second:'B'});
});

test('a connection opened before publication uses a fresh state snapshot after complete publication',async t=>{
 const c=setup(t),reader=c.spawn(readerScript(c));await until(()=>reader.messages.some(m=>m.event==='ready'));assert.equal(reader.messages.find(m=>m.event==='ready').preliminary.mode,'idle');
 assert.equal((await result(c.publisher())).status,'published');reader.child.send({command:'query'});assert.deepEqual(await result(reader),{first:'B',second:'B'});
});

for(const phase of ['prepared','cleaned'])test(`held ${phase} WAL metadata transaction does not block normal read admission`,async t=>{
 const c=setup(t),v=c.participant(),held=path.join(c.p.runtime,'writer-held'),resume=path.join(c.p.runtime,'writer-resume');assert.deepEqual(v.requestSync(snapshot),{first:'A',second:'A'});
 const script=c.script('held-transaction',`import fs from'node:fs';import{DatabaseSync}from'node:sqlite';import{beginOperation,publish}from${JSON.stringify(protocol)};import{fixture}from${JSON.stringify(worker)};import{createIpcChannel}from${JSON.stringify(ipc)};
 const channel=createIpcChannel(),op=beginOperation(${JSON.stringify(c.root)});fixture(op.record.candidate,'B');const prepare=DatabaseSync.prototype.prepare,exec=DatabaseSync.prototype.exec;let pending,used=false;
 DatabaseSync.prototype.prepare=function(sql){const statement=prepare.call(this,sql);if(sql!=='INSERT OR REPLACE INTO operations VALUES (?,?)')return statement;return new Proxy(statement,{get(target,key){if(key==='run')return(...args)=>{pending=JSON.parse(args[1]).phase;return target.run(...args);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});};
 DatabaseSync.prototype.exec=function(sql){if(sql==='COMMIT'&&pending===${JSON.stringify(phase)}&&!used){used=true;const started=Date.now();fs.writeFileSync(${JSON.stringify(held)},JSON.stringify({phase:pending,started}));const until=started+10000;while(!fs.existsSync(${JSON.stringify(resume)})||Date.now()-started<600){if(Date.now()>until)throw Error('writer release timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1);}}const r=exec.call(this,sql);if(sql==='COMMIT'||sql==='ROLLBACK')pending=null;return r;};
 try{const value=await publish(op);await channel.send({event:'result',result:{...value,heldTransaction:used}});await channel.close();}catch(error){process.exitCode=1;await channel.send({event:'fatal',error:error.stack});await channel.close();}`);
 const pub=c.spawn(script);await until(()=>fs.existsSync(held));const expected=phase==='prepared'?'A':'B',start=performance.now();assert.deepEqual(await v.request(snapshot),{first:expected,second:expected});const elapsed=performance.now()-start;
 assert(elapsed<1000,`normal query must not wait on ${phase} metadata transaction: ${elapsed}`);assert.equal(pub.messages.some(m=>m.event==='result'),false,'query completed while metadata transaction still held');t.diagnostic(`phase=${phase};queryMs=${elapsed}; injected pre-COMMIT hold >=600ms, not actual fsync emulation`);
 fs.writeFileSync(resume,'go');const published=await result(pub);assert.equal(published.status,'published');assert.equal(published.heldTransaction,true);
});

for(const crashAt of ['old-moved','new-moved'])test(`intent-only recovery restores A after crash at ${crashAt}`,async t=>{
 const c=setup(t),trace=path.join(c.p.runtime,'trace'),pub=c.publisher({crashAt,trace});const exited=await pub.done;assert(exited.code!==0||exited.signal,'forced process exit required');const reached=fs.readFileSync(trace,'utf8').trim().split('\n').map(JSON.parse);assert(reached.some(r=>r.phase===crashAt),'must reach exact hook');
 const record=records(c.p).at(-1);assert.equal(record.phase,'replacing','no redundant durable rename checkpoints');assert.equal(recover(c.root),true);assert.deepEqual(c.participant().requestSync(snapshot),{first:'A',second:'A'});
});

test('merged committed+idle crash preserves B and later confirmed writes across recovery',async t=>{
 const c=setup(t),trace=path.join(c.p.runtime,'trace'),pub=c.publisher({crashAt:'committed',trace});const exited=await pub.done;assert(exited.code!==0||exited.signal);assert(fs.readFileSync(trace,'utf8').includes('"phase":"committed"'));assert.equal(state(c.p).mode,'idle');assert.equal(records(c.p).at(-1).phase,'committed');assert.equal(recover(c.root),true);
 const v=c.participant();assert.deepEqual(v.requestSync(snapshot),{first:'B',second:'B'});await v.write(db=>db.prepare('INSERT INTO writes(value) VALUES(?)').run('confirmed-B'));v.close();assert.equal(recover(c.root),true);const check=new DatabaseSync(c.p.active);try{assert.equal(check.prepare('SELECT value FROM writes').get().value,'confirmed-B');assert.deepEqual(snapshot(check),{first:'B',second:'B'});}finally{check.close();}
});
