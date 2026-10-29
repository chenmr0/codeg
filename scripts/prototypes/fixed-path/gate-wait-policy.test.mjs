import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {initialize,gate,lease,Participant} from './protocol.mjs';
import {fixture,snapshot} from './worker.mjs';
import {waitForChildClose} from './ipc.mjs';
function setup(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'gate-policy-')),p=initialize(root);fixture(p.active,'A');p.gateMetrics=[];t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return{root,p};}
async function lockedChild(t,p,mode){const ready=path.join(p.runtime,'ready'),release=path.join(p.runtime,'release');const code=`const fs=require('node:fs'),{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(${JSON.stringify(p.gate)});d.exec(${JSON.stringify(mode==='BEGIN'?'BEGIN IMMEDIATE':'BEGIN; SELECT * FROM state')});fs.writeFileSync(${JSON.stringify(ready)},'ready');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);setTimeout(()=>{d.exec('ROLLBACK');d.close();},40);}},2);`;
 const child=spawn(process.execPath,['-e',code],{stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.on('data',b=>stderr+=b);const done=waitForChildClose(child);t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();});const end=Date.now()+10000;while(!fs.existsSync(ready)){if(Date.now()>end)throw Error('lock child not ready: '+stderr);await delay(2);}return{release,done};}

test('gate uses SQLite busy 0 for BEGIN/COMMIT and 25 for action; lease policy unchanged',t=>{
 const {p}=setup(t),original=DatabaseSync.prototype.exec,seen=[];try{DatabaseSync.prototype.exec=function(sql){if(sql==='BEGIN IMMEDIATE'||sql==='COMMIT')seen.push({sql,busy:this.prepare('PRAGMA busy_timeout').get().timeout});return original.call(this,sql);};gate(p,g=>assert.equal(g.prepare('PRAGMA busy_timeout').get().timeout,25));}finally{DatabaseSync.prototype.exec=original;}assert.deepEqual(seen,[{sql:'BEGIN IMMEDIATE',busy:0},{sql:'COMMIT',busy:0}]);
 const leaseCalls=[];try{DatabaseSync.prototype.exec=function(sql){leaseCalls.push(sql);return original.call(this,sql);};const held=lease(p.connections);assert(held);held.close();}finally{DatabaseSync.prototype.exec=original;}assert(leaseCalls.includes('PRAGMA busy_timeout=25; PRAGMA synchronous=FULL'));assert(leaseCalls.includes('PRAGMA busy_timeout=0'));assert(leaseCalls.includes('BEGIN'));
});
for(const phase of ['BEGIN','COMMIT'])test(`${phase} retries a real short cross-process lock without replaying action`,async t=>{
 const {p}=setup(t),blocker=await lockedChild(t,p,phase),original=DatabaseSync.prototype.exec;let attempts=0,actions=0;
 try{DatabaseSync.prototype.exec=function(sql){if(sql===(phase==='BEGIN'?'BEGIN IMMEDIATE':'COMMIT')){attempts++;if(attempts===1)fs.writeFileSync(blocker.release,'release after contention');}return original.call(this,sql);};assert.equal(gate(p,g=>{actions++;g.exec('UPDATE state SET revision=revision+1');return 7;},{label:'real-'+phase}),7);}finally{DatabaseSync.prototype.exec=original;fs.writeFileSync(blocker.release,'release');}
 assert.equal(actions,1);assert(attempts>1);assert(p.gateMetrics.at(-1).retries>0);assert.equal((await blocker.done).code,0);const db=new DatabaseSync(p.gate);try{assert.equal(db.prepare('SELECT revision FROM state').get().revision,1);}finally{db.close();}
});
test('COMMIT busy still exhausts original 500ms then rolls back once and frees gate',t=>{
 const {p}=setup(t),original=DatabaseSync.prototype.exec;let actions=0,attempts=0,rollbacks=0,error;
 try{DatabaseSync.prototype.exec=function(sql){if(sql==='COMMIT'){attempts++;throw Object.assign(Error('database is locked injected COMMIT'),{errcode:5,code:'ERR_SQLITE_ERROR'});}if(sql==='ROLLBACK')rollbacks++;return original.call(this,sql);};try{gate(p,g=>{actions++;g.exec('UPDATE state SET revision=99');});}catch(e){error=e;}}finally{DatabaseSync.prototype.exec=original;}
 assert.equal(error?.errcode,5);assert.equal(actions,1);assert.equal(rollbacks,1);assert(attempts>1);assert(p.gateMetrics.at(-1).totalMs>=500);const db=new DatabaseSync(p.gate);try{db.exec('BEGIN EXCLUSIVE');assert.equal(db.prepare('SELECT revision FROM state').get().revision,0);db.exec('ROLLBACK');}finally{db.close();}
});
test('cold empty costs does not change gate data_version; populated costs are cleared',t=>{
 const {root,p}=setup(t);let participant=new Participant(root,f=>new DatabaseSync(f));const observer=new DatabaseSync(p.gate);try{const before=observer.prepare('PRAGMA data_version').get().data_version;assert.deepEqual(participant.requestSync(snapshot),{first:'A',second:'A'});assert.equal(observer.prepare('PRAGMA data_version').get().data_version,before);participant.close();participant=null;gate(p,g=>g.exec("INSERT INTO costs VALUES('identity','value')"));participant=new Participant(root,f=>new DatabaseSync(f));const populatedVersion=observer.prepare('PRAGMA data_version').get().data_version;participant.requestSync(snapshot);assert.equal(observer.prepare('SELECT COUNT(*) AS n FROM costs').get().n,0);assert.notEqual(observer.prepare('PRAGMA data_version').get().data_version,populatedVersion);}finally{participant?.close();observer.close();}
});
for(const failingSql of ['SELECT 1 FROM costs LIMIT 1','DELETE FROM costs'])test(`cold ${failingSql.startsWith('SELECT')?'cost lookup':'cost deletion'} failure precisely unwinds handles and write admission`,async t=>{
 const {root,p}=setup(t);if(failingSql.startsWith('DELETE'))gate(p,g=>g.exec("INSERT INTO costs VALUES('identity','value')"));let closes=0;const participant=new Participant(root,file=>{const db=new DatabaseSync(file);return{prepare:db.prepare.bind(db),close(){closes++;db.close();}};}),original=DatabaseSync.prototype.prepare,error=Object.assign(Error('injected cost SQL IOERR'),{errcode:10});let executed=0,attempts=0;
 try{DatabaseSync.prototype.prepare=function(sql){if(sql===failingSql){attempts++;throw error;}return original.call(this,sql);};await assert.rejects(participant.write(()=>executed++),e=>e===error);}finally{DatabaseSync.prototype.prepare=original;}
 try{assert.equal(attempts,1,'non-BUSY SQL failure must not replay');assert.equal(executed,0);assert.equal(closes,1);assert.equal(participant.active,0);assert.equal(participant.handle,null);assert.equal(participant.holder,null);for(const file of [p.connections,p.writers]){const exclusive=lease(file,true);assert(exclusive,'no leaked lease after SQL failure');exclusive.close();}const db=new DatabaseSync(p.gate);try{assert.equal(db.prepare('SELECT revision FROM state').get().revision,0);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM costs').get().n,failingSql.startsWith('DELETE')?1:0);}finally{db.close();}}finally{participant.close();}
});
