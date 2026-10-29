/** Coordinator WAL maintenance is best-effort, never a publication rollback.
 * Process kills test OS/process recovery, not power-loss durability.
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
import {initialize,beginOperation,publish,checkpointCoordinator,Participant,recover,state,records} from './protocol.mjs';
import {fixture,snapshot} from './worker.mjs';
import {waitForChildClose} from './ipc.mjs';
const protocol=new URL('./protocol.mjs',import.meta.url).href,worker=new URL('./worker.mjs',import.meta.url).href;
async function until(f){const end=Date.now()+10000;while(!f()){if(Date.now()>end)throw Error('IPC barrier timeout');await delay(2);}}
function setup(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'wal-maintenance-')),p=initialize(root),children=[];fixture(p.active,'A');
 t.after(async()=>{for(const c of children)if(c.child.exitCode===null&&c.child.signalCode===null)c.child.kill('SIGKILL');await Promise.allSettled(children.map(c=>c.done));fs.rmSync(root,{recursive:true,force:true});});
 function spawn(source){const file=path.join(p.runtime,`child-${children.length}.mjs`);fs.writeFileSync(file,source);const child=fork(file,[],{execArgv:['--liftoff-only'],stdio:['ignore','ignore','pipe','ipc']}),messages=[];let stderr='';child.stderr.on('data',b=>stderr+=b);child.on('message',m=>messages.push(m));const done=waitForChildClose(child).then(exit=>({...exit,stderr}));done.catch(()=>{});const c={child,messages,done};children.push(c);return c;}
 return {root,p,spawn};}
function query(root){const v=new Participant(root,f=>new DatabaseSync(f));try{return v.requestSync(snapshot);}finally{v.close();}}

test('PASSIVE checkpoint defers for an old process snapshot without blocking reads, then advances',async t=>{
 const c=setup(t);const reader=c.spawn(`import{DatabaseSync}from'node:sqlite';const d=new DatabaseSync(${JSON.stringify(c.p.gate)});d.exec('BEGIN');const before=d.prepare('SELECT revision FROM state').get().revision;process.send({event:'held',before});process.on('message',()=>{const after=d.prepare('SELECT revision FROM state').get().revision;d.exec('ROLLBACK');d.close();process.send({event:'released',before,after},()=>process.disconnect());});`);
 await until(()=>reader.messages.some(m=>m.event==='held'));const op=beginOperation(c.root);fixture(op.record.candidate,'B');const published=await publish(op);assert.equal(published.status,'published');
 const start=performance.now(),partial=checkpointCoordinator(c.p),elapsed=performance.now()-start;assert.equal(partial.deferred,true);assert(partial.log>partial.checkpointed,JSON.stringify(partial));assert(elapsed<1000,`PASSIVE waited ${elapsed}ms`);assert.deepEqual(query(c.root),{first:'B',second:'B'});
 reader.child.send('release');assert.equal((await reader.done).code,0);const message=reader.messages.find(m=>m.event==='released');assert(message);assert.equal(message.after,message.before,'old snapshot remains internally valid');const complete=checkpointCoordinator(c.p);assert.equal(complete.deferred,false);assert.equal(complete.log,complete.checkpointed);t.diagnostic(JSON.stringify({partial,complete,elapsed}));
});

test('PASSIVE IOERR after publication is reported but B and subsequent confirmed writes survive',async t=>{
 const c=setup(t),op=beginOperation(c.root);fixture(op.record.candidate,'B');const original=DatabaseSync.prototype.prepare;let injected=0,result;
 try{DatabaseSync.prototype.prepare=function(sql){if(sql==='PRAGMA wal_checkpoint(PASSIVE)'){injected++;throw Object.assign(new Error('injected coordinator checkpoint IOERR'),{errcode:10});}return original.call(this,sql);};result=await publish(op);}finally{DatabaseSync.prototype.prepare=original;}
 assert.equal(result.status,'published');assert.equal(injected,1);assert.match(result.metrics.coordinatorMaintenanceError,/IOERR/);assert.equal(state(c.p).mode,'idle');assert.deepEqual(query(c.root),{first:'B',second:'B'});
 const v=new Participant(c.root,f=>new DatabaseSync(f));try{await v.write(d=>d.prepare('INSERT INTO writes VALUES(?)').run('confirmed-after-maintenance-error'));}finally{v.close();}
 assert.equal(recover(c.root),true);const d=new DatabaseSync(c.p.active);try{assert.equal(d.prepare('SELECT value FROM writes').get().value,'confirmed-after-maintenance-error');assert.deepEqual(snapshot(d),{first:'B',second:'B'});}finally{d.close();}
});

for(const corrupt of [false,true])test(`real process kill leaves required WAL recovery record ${corrupt?'corruption fail-closed':'recoverable after all handles close'}`,async t=>{
 const c=setup(t),trace=path.join(c.p.runtime,'crashed');const child=c.spawn(`import fs from'node:fs';import{DatabaseSync}from'node:sqlite';import{beginOperation,publish}from${JSON.stringify(protocol)};import{fixture}from${JSON.stringify(worker)};const pin=new DatabaseSync(${JSON.stringify(c.p.gate)});pin.exec('PRAGMA wal_autocheckpoint=0; BEGIN');pin.prepare('SELECT * FROM state').get();const op=beginOperation(${JSON.stringify(c.root)});fixture(op.record.candidate,'B');await publish(op,{hook(phase){if(phase==='new-moved'){fs.writeFileSync(${JSON.stringify(trace)},op.record.id);process.kill(process.pid,'SIGKILL');}}});`);
 const exit=await child.done;assert(exit.code!==0||exit.signal,exit.stderr);assert(fs.existsSync(trace),'actual rename stage must have been reached');assert(fs.statSync(c.p.gate+'-wal').size>0,'unclean process exit left durable coordination WAL');const record=records(c.p).find(r=>r.id===fs.readFileSync(trace,'utf8'));assert.equal(record.phase,'replacing');
 if(corrupt){const d=new DatabaseSync(c.p.gate);try{d.prepare('DELETE FROM operations WHERE id=?').run(record.id);}finally{d.close();}assert.throws(()=>recover(c.root),/Recovery record missing/);assert.notEqual(state(c.p).mode,'idle');assert(fs.existsSync(record.backup));assert(fs.existsSync(c.p.active));assert.throws(()=>query(c.root),/Recovery record missing/);}
 else{assert.equal(recover(c.root),true);assert.deepEqual(query(c.root),{first:'A',second:'A'});assert.equal(state(c.p).mode,'idle');}
});

for(const sync of [false,true])test(`${sync?'sync':'async'} retry recovery defers checkpoint; explicit recovery reports maintenance failure without rollback`,async t=>{
 const c=setup(t),original=DatabaseSync.prototype.prepare;let attempts=0,v;
 try{
  DatabaseSync.prototype.prepare=function(sql){if(sql==='PRAGMA wal_checkpoint(PASSIVE)'){attempts++;throw Object.assign(new Error('injected explicit recovery maintenance IOERR'),{errcode:10});}return original.call(this,sql);};
  v=new Participant(c.root,f=>new DatabaseSync(f));const admit=v.admit.bind(v);let first=true;v.admit=(...args)=>{if(first){first=false;return false;}return admit(...args);};
  assert.deepEqual(sync?v.requestSync(snapshot):await v.request(snapshot),{first:'A',second:'A'});assert.equal(first,false);assert.equal(attempts,0,'construction and request retry must not perform WAL maintenance');
  v.close();v=null;const maintenance={};assert.equal(recover(c.root,{maintenance}),true);assert.equal(attempts,1);assert.match(maintenance.error,/IOERR/);assert.equal(state(c.p).mode,'idle');assert.deepEqual(query(c.root),{first:'A',second:'A'});assert.equal(attempts,1);
 }finally{v?.close();DatabaseSync.prototype.prepare=original;}
});
