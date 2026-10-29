import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {initialize,gate} from './protocol.mjs';
import {waitForChildClose} from './ipc.mjs';
function setup(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'gate-reuse-')),p=initialize(root);p.gateMetrics=[];t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return p;}
function instrument({exec,prepare}={}){const originalExec=DatabaseSync.prototype.exec,originalPrepare=DatabaseSync.prototype.prepare,originalClose=DatabaseSync.prototype.close;const opened=[],closed=[],begins=[],events=[];
 DatabaseSync.prototype.exec=function(sql){if(sql==='PRAGMA busy_timeout=0; PRAGMA synchronous=FULL')opened.push(this);if(sql==='BEGIN'||sql==='BEGIN IMMEDIATE')begins.push(this);events.push(sql);return exec?exec.call(this,sql,originalExec):originalExec.call(this,sql);};
 DatabaseSync.prototype.prepare=function(sql){return prepare?prepare.call(this,sql,originalPrepare):originalPrepare.call(this,sql);};
 DatabaseSync.prototype.close=function(){if(opened.includes(this))closed.push(this);return originalClose.call(this);};
 return{opened,closed,begins,events,restore(){DatabaseSync.prototype.exec=originalExec;DatabaseSync.prototype.prepare=originalPrepare;DatabaseSync.prototype.close=originalClose;}};
}
const busy=()=>Object.assign(Error('database is locked'),{errcode:5});

test('real BEGIN contention reuses exactly one initialized connection and closes it once',async t=>{
 const p=setup(t),ready=path.join(p.runtime,'ready'),release=path.join(p.runtime,'release');const child=spawn(process.execPath,['-e',`const fs=require('node:fs'),{DatabaseSync}=require('node:sqlite'),d=new DatabaseSync(${JSON.stringify(p.gate)});d.exec('BEGIN IMMEDIATE');fs.writeFileSync(${JSON.stringify(ready)},'ready');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);setTimeout(()=>{d.exec('ROLLBACK');d.close();},40);}},2);`],{stdio:['ignore','ignore','ignore']});const done=waitForChildClose(child);t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();});const end=Date.now()+10000;while(!fs.existsSync(ready)){if(Date.now()>end)throw Error('lock child barrier timed out');await delay(2);}let signalled=false,actions=0;
 const traced=instrument({exec(sql,original){if(sql==='BEGIN IMMEDIATE'&&!signalled){signalled=true;fs.writeFileSync(release,'release');}return original.call(this,sql);}});
 try{assert.equal(gate(p,()=>{actions++;return 'ok';}),'ok');}finally{traced.restore();fs.writeFileSync(release,'release');}
 assert.equal(actions,1);assert(traced.begins.length>1);assert.equal(traced.opened.length,1);assert.equal(traced.closed.length,1);assert(traced.begins.every(db=>db===traced.opened[0]));assert.equal((await done).code,0);
});

test('readonly pre-action SELECT BUSY rolls back each transaction before same-connection retry',t=>{
 const p=setup(t);let failures=2,actions=0;const traced=instrument({prepare(sql,original){if(sql==='SELECT id FROM state WHERE id=1'&&failures-->0)return{get(){throw busy();}};return original.call(this,sql);}});
 try{assert.equal(gate(p,()=>{actions++;return 17;},{readOnly:true}),17);}finally{traced.restore();}
 assert.equal(actions,1);assert.deepEqual(traced.events.filter(sql=>['BEGIN','ROLLBACK','COMMIT'].includes(sql)),['BEGIN','ROLLBACK','BEGIN','ROLLBACK','BEGIN','COMMIT']);assert.equal(traced.opened.length,1);assert.equal(traced.closed.length,1);assert.equal(p.gateMetrics.at(-1).retries,2);
});

test('pre-action ROLLBACK IOERR immediately fails without reuse or action and closes connection',t=>{
 const p=setup(t),selectError=busy(),rollbackError=Object.assign(Error('rollback IOERR'),{errcode:10});let actions=0;const traced=instrument({exec(sql,original){if(sql==='ROLLBACK')throw rollbackError;return original.call(this,sql);},prepare(sql,original){if(sql==='SELECT id FROM state WHERE id=1')return{get(){throw selectError;}};return original.call(this,sql);}});
 try{assert.throws(()=>gate(p,()=>actions++,{readOnly:true}),e=>e instanceof AggregateError&&e.errors[0]===selectError&&e.errors[1]===rollbackError);}finally{traced.restore();}
 assert.equal(actions,0);assert.equal(traced.begins.length,1);assert.equal(traced.opened.length,1);assert.equal(traced.closed.length,1);assert.equal(p.gateMetrics.at(-1).retries,0);assert.equal(gate(p,()=>99),99,'a fresh call can acquire after failed rollback close');
});

for(const mode of ['timeout','non-BUSY'])test(`${mode} failure closes connection; next call opens a new one`,t=>{
 const p=setup(t),failure=mode==='timeout'?null:Object.assign(Error('injected BEGIN IOERR'),{errcode:10});let fail=true,actions=0;const traced=instrument({exec(sql,original){if(fail&&sql==='BEGIN IMMEDIATE')throw failure??busy();return original.call(this,sql);}});
 try{assert.throws(()=>gate(p,()=>actions++),e=>mode==='timeout'?e.errcode===5:e===failure);assert.equal(actions,0);assert.equal(traced.closed.length,1);if(mode==='timeout')assert(p.gateMetrics.at(-1).totalMs>=500,'unchanged 500ms retry deadline');else assert.equal(traced.begins.length,1);fail=false;assert.equal(gate(p,()=>{actions++;return 'fresh';}),'fresh');}finally{traced.restore();}
 assert.equal(actions,1);assert.equal(traced.opened.length,2);assert.equal(traced.closed.length,2);assert.notEqual(traced.opened[0],traced.opened[1]);assert.deepEqual(traced.closed,traced.opened);
});
