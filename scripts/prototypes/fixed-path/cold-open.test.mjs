import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fork} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {initialize,Participant,lease,state} from './protocol.mjs';
import {fixture,snapshot} from './worker.mjs';
import {waitForChildClose} from './ipc.mjs';
const pause=new Int32Array(new SharedArrayBuffer(4));
function setup(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'cold-open-')),p=initialize(root);fixture(p.active,'A');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return{root,p};}
function free(file){const held=lease(file,true);assert(held,'exclusive lease must be available');held.close();}

test('slow cold factory holds no gate; independent publisher drains but waits for old request lease',async t=>{
 const {root,p}=setup(t),trace=path.join(p.runtime,'publication-trace');let pub,done,participant,release,opens=0;const messages=[],hold=new Promise(r=>release=r);
 participant=new Participant(root,file=>{opens++;if(opens===1){const gateProbe=new DatabaseSync(p.gate);try{gateProbe.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; ROLLBACK');}finally{gateProbe.close();}assert.equal(participant.active,1);assert(participant.holder);
 pub=fork(new URL('./worker.mjs',import.meta.url),['publisher',root,JSON.stringify({trace})],{execArgv:['--liftoff-only'],stdio:['ignore','ignore','pipe','ipc']});pub.stderr.resume();pub.on('message',m=>messages.push(m));done=waitForChildClose(pub);const end=Date.now()+5000;while(!fs.existsSync(trace)||!fs.readFileSync(trace,'utf8').includes('"phase":"draining"')){if(Date.now()>end)throw Error('publisher cannot drain during cold open');Atomics.wait(pause,0,0,2);}assert(!fs.readFileSync(trace,'utf8').includes('"phase":"replacing"'),'holder protects old file during slow factory');}
 return new DatabaseSync(file);});
 let old;try{old=participant.request(async db=>{const before=snapshot(db);await hold;return{before,after:snapshot(db)};});old.catch(()=>{});assert.equal(state(p).mode,'draining');assert.equal(participant.active,1);release();assert.deepEqual(await old,{before:{first:'A',second:'A'},after:{first:'A',second:'A'}});assert.equal((await done).code,0);assert.equal(messages.find(m=>m.event==='result')?.result.status,'published');assert.deepEqual(await participant.request(snapshot),{first:'B',second:'B'});}finally{release();if(old)await old.catch(()=>{});if(pub&&pub.exitCode===null&&pub.signalCode===null)pub.kill();participant.close();}
});
for(const writing of [false,true])test(`${writing?'write':'read'} cold factory failure releases active and every admitted lease`,async t=>{
 const {root,p}=setup(t),error=Error('factory failed');let factories=0,actions=0;const participant=new Participant(root,()=>{factories++;throw error;});try{await assert.rejects(writing?participant.write(()=>actions++):participant.request(()=>actions++),e=>e===error);assert.equal(factories,1);assert.equal(actions,0);assert.equal(participant.active,0);assert.equal(participant.handle,null);assert.equal(participant.holder,null);free(p.connections);free(p.writers);assert.equal(state(p).revision,writing?1:0,'durable pre-write intent remains conservative even if factory fails');}finally{participant.close();}
});
test('admission COMMIT failure must never invoke cold factory',async t=>{
 const {root,p}=setup(t);let factories=0;const participant=new Participant(root,()=>{factories++;throw Error('factory must not execute');}),original=DatabaseSync.prototype.exec,error=Object.assign(Error('admission IOERR'),{errcode:10});let armed=true;try{DatabaseSync.prototype.exec=function(sql){if(armed&&sql==='COMMIT'){armed=false;throw error;}return original.call(this,sql);};await assert.rejects(participant.write(()=>assert.fail('callback executed')),e=>e===error);}finally{DatabaseSync.prototype.exec=original;}try{assert.equal(factories,0);assert.equal(participant.active,0);assert.equal(participant.holder,null);assert.equal(state(p).revision,0);free(p.connections);free(p.writers);}finally{participant.close();}
});
test('write intent is committed before cold factory and gate is independently accessible',async t=>{
 const {root,p}=setup(t);let participant;participant=new Participant(root,file=>{assert.equal(state(p).revision,1);assert.equal(participant.active,1);const probe=new DatabaseSync(p.gate);try{probe.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; ROLLBACK');}finally{probe.close();}const blocked=lease(p.writers,true);blocked?.close();assert.equal(blocked,null,'write lease covers factory');return new DatabaseSync(file);});try{assert.deepEqual(await participant.write(snapshot),{first:'A',second:'A'});assert.equal(state(p).revision,1);assert.equal(participant.active,0);free(p.writers);}finally{participant.close();}
});

test('factory exceeding drain budget does not hold gate and cancels publication without breaking old request',async t=>{
 const {root,p}=setup(t),proof=path.join(p.runtime,'cold-timeout-result'),gateProof=path.join(p.runtime,'independent-gate-access'),script=path.join(p.runtime,'cold-publisher.mjs');
 fs.writeFileSync(script,`import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';import{beginOperation,publish}from ${JSON.stringify(new URL('./protocol.mjs',import.meta.url).href)};const probe=new DatabaseSync(${JSON.stringify(p.gate)});probe.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; ROLLBACK');probe.close();fs.writeFileSync(${JSON.stringify(gateProof)},'independent gate acquired');const op=beginOperation(${JSON.stringify(root)}),db=new DatabaseSync(op.record.candidate);db.exec("CREATE TABLE snapshot(id INTEGER PRIMARY KEY, first TEXT,second TEXT);INSERT INTO snapshot VALUES(1,'B','B')");db.close();const result=await publish(op);fs.writeFileSync(${JSON.stringify(proof)},JSON.stringify(result));`);
 let child,done,opens=0;const participant=new Participant(root,file=>{if(++opens===1){child=fork(script,[],{execArgv:['--liftoff-only'],stdio:['ignore','ignore','pipe','ipc']});child.stderr.resume();done=waitForChildClose(child);const end=Date.now()+10000;while(!fs.existsSync(proof)){if(Date.now()>end)throw Error('publisher did not cancel bounded drain');Atomics.wait(pause,0,0,2);}assert(fs.existsSync(gateProof),'independent process acquired gate while factory paused');const result=JSON.parse(fs.readFileSync(proof,'utf8'));assert.equal(result.status,'cancelled');assert.equal(result.code,'DRAIN_CANCELLED');assert.match(result.error,/budget/);assert(result.metrics.drainMs>=1000);}return new DatabaseSync(file);});
 try{assert.deepEqual(await participant.request(snapshot),{first:'A',second:'A'});assert.equal((await done).code,0);assert.equal(state(p).mode,'idle');assert.deepEqual(participant.requestSync(snapshot),{first:'A',second:'A'});assert.equal(participant.active,0);}finally{if(child&&child.exitCode===null&&child.signalCode===null)child.kill();participant.close();}
});
