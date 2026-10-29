/** Recovery retry and idle-observer regressions. No production behavior changes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {initialize,Participant,gate,lease} from './protocol.mjs';
import {fixture,snapshot} from './worker.mjs';
function setup(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'recovery-observer-')),p=initialize(root);fixture(p.active,'A');const participant=new Participant(root,f=>new DatabaseSync(f),{readGates:false,measureGates:true,pollMs:100000});t.after(()=>{clearInterval(participant.timer);participant.closeHandle();fs.rmSync(root,{recursive:true,force:true});});return{root,p,participant};}

test('live publisher makes participant recovery retries skip initialization SQL and DDL',async t=>{
 const {p,participant}=setup(t);participant.requestSync(snapshot);const owner=lease(p.owner,true);assert(owner);gate(p,g=>g.exec("UPDATE state SET mode='draining' WHERE id=1"));
 const prepare=DatabaseSync.prototype.prepare,exec=DatabaseSync.prototype.exec;let admissionAttempts=0,ran=false,query;
 try{
  DatabaseSync.prototype.prepare=function(sql){assert(!/sqlite_master|sqlite_schema/i.test(sql),'retry must not rerun initialize schema lookup');if(sql==='SELECT * FROM state WHERE id=1')admissionAttempts++;return prepare.call(this,sql);};
  DatabaseSync.prototype.exec=function(sql){assert(!/CREATE\s+(?:TABLE|INDEX)|ALTER\s+TABLE/i.test(sql),'retry must not initialize DDL');return exec.call(this,sql);};
  query=participant.request(db=>{ran=true;return snapshot(db);});query.catch(()=>{});await delay(35);assert.equal(ran,false);assert(admissionAttempts>=2,'exercised multiple denied admissions');assert.equal(participant.active,0);gate(p,g=>g.exec("UPDATE state SET mode='idle' WHERE id=1"));assert.deepEqual(await query,{first:'A',second:'A'});
 }finally{DatabaseSync.prototype.prepare=prepare;DatabaseSync.prototype.exec=exec;gate(p,g=>g.exec("UPDATE state SET mode='idle' WHERE id=1"));owner.close();if(query)await query;}
});

test('idle retirement reads old committed state under publisher RESERVED lock then retires after commit',t=>{
 const {p,participant}=setup(t);participant.requestSync(snapshot);const handle=participant.handle,holder=participant.holder,writer=new DatabaseSync(p.gate);
 try{writer.exec("BEGIN IMMEDIATE; UPDATE state SET mode='draining' WHERE id=1");participant.retireIfNeeded();assert.equal(participant.handle,handle,'uncommitted draining cannot retire old handle');assert.equal(participant.holder,holder);assert(participant.p.gateMetrics.some(m=>m.label==='retire-state'&&m.readOnly));writer.exec('COMMIT');participant.retireIfNeeded();assert.equal(participant.handle,null);assert.equal(participant.holder,null);const exclusive=lease(p.connections,true);assert(exclusive,'idle connection lease released after committed draining');exclusive.close();}
 finally{try{writer.exec('ROLLBACK');}catch{}writer.close();gate(p,g=>g.exec("UPDATE state SET mode='idle' WHERE id=1"));}
});

test('initialized participant fails closed on missing publisher lease without recreating it',async t=>{
 const {p,participant}=setup(t);gate(p,g=>g.exec("UPDATE state SET mode='draining' WHERE id=1"));const backup=p.owner+'.evidence';fs.renameSync(p.owner,backup);let ran=false;
 await assert.rejects(participant.request(()=>{ran=true;}),error=>error.code==='ENOENT');assert.equal(ran,false);assert.equal(participant.active,0);assert.equal(fs.existsSync(p.owner),false,'must not repair missing coordination identity');assert.equal(fs.existsSync(backup),true,'preserve original evidence');const d=new DatabaseSync(p.gate);try{assert.equal(d.prepare('SELECT mode FROM state').get().mode,'draining');}finally{d.close();}
});

test('initialized participant rejects a corrupt/missing state table without recreating schema',async t=>{
 const {p,participant}=setup(t);const d=new DatabaseSync(p.gate);d.exec('DROP TABLE state');d.close();let ran=false;
 await assert.rejects(participant.request(()=>{ran=true;}),/no such table: state/);assert.equal(ran,false);assert.equal(participant.active,0);assert.equal(participant.handle,null);const evidence=new DatabaseSync(p.gate);try{assert.equal(evidence.prepare("SELECT name FROM sqlite_master WHERE name='state'").get(),undefined,'missing state must not be rebuilt implicitly');}finally{evidence.close();}
});
