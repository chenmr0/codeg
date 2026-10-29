/** Failure diagnostics must observe, never alter gate admission or outcomes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {initialize,gate} from './protocol.mjs';
const pause=new Int32Array(new SharedArrayBuffer(4));
function setup(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'gate-diagnostics-')),p=initialize(root),directory=path.join(root,'diagnostics'),previous=process.env.GATE_DIAGNOSTICS_DIR;process.env.GATE_DIAGNOSTICS_DIR=directory;t.after(()=>{if(previous===undefined)delete process.env.GATE_DIAGNOSTICS_DIR;else process.env.GATE_DIAGNOSTICS_DIR=previous;fs.rmSync(root,{recursive:true,force:true});});return{p,directory};}
function records(directory){return fs.readFileSync(path.join(directory,`gate-${process.pid}.jsonl`),'utf8').trim().split('\n').map(JSON.parse);}

test('BEGIN locked exhausts existing 500ms gate budget without action or error-code loss',t=>{
 const {p,directory}=setup(t),original=DatabaseSync.prototype.exec;let actionCalls=0,beginAttempts=0,error;
 try{DatabaseSync.prototype.exec=function(sql){if(sql==='BEGIN IMMEDIATE'){beginAttempts++;throw Object.assign(Error('database is locked: injected BEGIN'),{code:'ERR_SQLITE_ERROR',errcode:5,errstr:'database is locked'});}return original.call(this,sql);};try{gate(p,()=>{actionCalls++;},{label:'diagnostic-begin-locked'});}catch(e){error=e;}}
 finally{DatabaseSync.prototype.exec=original;}
 assert(error);assert.equal(actionCalls,0);assert(beginAttempts>1);assert.equal(error.code,'ERR_SQLITE_ERROR');assert.equal(error.errcode,5);assert.equal(error.errstr,'database is locked');assert.match(error.stack,/Gate diagnostic:/);const [record]=records(directory);assert.equal(record.label,'diagnostic-begin-locked');assert.equal(record.phase,'begin');assert.equal(record.actionStarted,false);assert.equal(record.errcode,5);assert.equal(record.retries,beginAttempts-1);assert(record.totalMs>=500,'original deadline is still 500ms');assert.match(error.stack,/"actionStarted":false/);assert.match(error.stack,/"phase":"begin"/);assert.match(error.stack,/"retries":\d+/);
 // Scheduling may delay return after deadline; do not replace the production budget with a flaky wall-time assertion.
});

test('successful slow action diagnostic is emitted only after releasing its gate',t=>{
 const {p,directory}=setup(t),append=fs.appendFileSync;let appended=0,exclusiveProven=false;
 try{fs.appendFileSync=function(file,...args){if(file===path.join(directory,`gate-${process.pid}.jsonl`)){appended++;const probe=new DatabaseSync(p.gate);try{probe.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');exclusiveProven=true;probe.exec('ROLLBACK');}finally{probe.close();}}return append.call(this,file,...args);};const result=gate(p,g=>{g.prepare('UPDATE state SET revision=revision+1 WHERE id=1').run();Atomics.wait(pause,0,0,35);return 'committed-result';},{label:'diagnostic-slow-success'});assert.equal(result,'committed-result');}
 finally{fs.appendFileSync=append;}
 assert.equal(appended,1);assert.equal(exclusiveProven,true);const [record]=records(directory);assert.equal(record.phase,'complete');assert.equal(record.actionStarted,true);assert(record.actionMs>=25);assert.equal(record.error,undefined);const db=new DatabaseSync(p.gate);try{assert.equal(db.prepare('SELECT revision FROM state').get().revision,1);}finally{db.close();}
});

test('diagnostic write failure preserves successful result and original operation failure',t=>{
 const {p}=setup(t),append=fs.appendFileSync,write=process.stderr.write;let warnings='';const originalFailure=Object.assign(Error('application action failed'),{code:'APPLICATION_FAILURE'});
 try{fs.appendFileSync=()=>{throw Object.assign(Error('injected diagnostic ENOSPC'),{code:'ENOSPC'});};process.stderr.write=function(chunk){warnings+=chunk;return true;};assert.equal(gate(p,()=>{Atomics.wait(pause,0,0,35);return 42;},{label:'diagnostic-output-failed-success'}),42);assert.throws(()=>gate(p,()=>{throw originalFailure;},{label:'diagnostic-output-failed-error'}),error=>error===originalFailure&&error.code==='APPLICATION_FAILURE');}
 finally{fs.appendFileSync=append;process.stderr.write=write;}
 assert.equal((warnings.match(/Gate diagnostic write failed/g)??[]).length,2);assert.match(warnings,/injected diagnostic ENOSPC/);
});
