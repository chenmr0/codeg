/** Deterministic bootstrap preparation interleavings and process-crash boundaries. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {initialize,paths,state,sha} from './protocol.mjs';
const protocol=new URL('./protocol.mjs',import.meta.url).href;
const fields=['connections','owner','writers'];
function root(t){const p=fs.mkdtempSync(path.join(os.tmpdir(),'bootstrap-preparation-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;}
function child(project,inject){return spawnSync(process.execPath,['--input-type=module','-e',`import fs from 'node:fs';import{DatabaseSync}from 'node:sqlite';import{initialize}from ${JSON.stringify(protocol)};${inject};initialize(${JSON.stringify(project)});`],{encoding:'utf8',timeout:10000});}
test('a contender can finish while another spends over 500 ms preparing a lease, without widening gate budget',t=>{
 const project=root(t),original=DatabaseSync.prototype.exec;let armed=true,other,winner;
 try{DatabaseSync.prototype.exec=function(sql){if(armed&&sql.includes('CREATE TABLE lease')){armed=false;other=child(project,'');assert.equal(other.status,0,other.stderr);winner=fields.map(f=>[paths(project)[f],fs.statSync(paths(project)[f]).ino,sha(paths(project)[f])]);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,550);}return original.call(this,sql);};initialize(project);}finally{DatabaseSync.prototype.exec=original;}
 assert.equal(other.status,0);for(const[file,ino,hash]of winner){assert.equal(fs.statSync(file).ino,ino);assert.equal(sha(file),hash);}assert.equal(state(paths(project)).mode,'idle');assert.deepEqual(fs.readdirSync(paths(project).runtime).filter(n=>n.startsWith('bootstrap-')),[]);
});
for(const count of [1,2,3])test(`crash after private lease ${count} commit leaves unadopted evidence; fresh bootstrap succeeds`,t=>{
 const project=root(t),p=paths(project),result=child(project,`const exec=DatabaseSync.prototype.exec;let n=0;DatabaseSync.prototype.exec=function(sql){const r=exec.call(this,sql);if(sql.includes('CREATE TABLE lease')&&++n===${count})process.exit(71);return r;}`);
 assert.equal(result.status,71,result.stderr);for(const field of fields)assert.equal(fs.existsSync(p[field]),false);
 const leftovers=fs.readdirSync(p.runtime).filter(n=>n.startsWith('bootstrap-'));assert.equal(leftovers.length,1);const dir=path.join(p.runtime,leftovers[0]),files=fs.readdirSync(dir).map(n=>[n,sha(path.join(dir,n))]);
 initialize(project);assert.equal(state(p).mode,'idle');assert.deepEqual(fs.readdirSync(dir).map(n=>[n,sha(path.join(dir,n))]),files,'new bootstrap must neither adopt nor clean another invocation');
});
for(const count of [1,2,3])test(`crash after promoted lease ${count} remains fail-closed with unchanged evidence`,t=>{
 const project=root(t),p=paths(project),result=child(project,`const rename=fs.renameSync;let n=0;fs.renameSync=function(...args){const r=rename(...args);if(++n===${count})process.exit(72);return r;}`);
 assert.equal(result.status,72,result.stderr);const evidence=fields.slice(0,count).map(f=>[p[f],sha(p[f])]);
 assert.throws(()=>initialize(project),/Missing coordination state with existing leases/);for(const[file,hash]of evidence)assert.equal(sha(file),hash);
 const d=new DatabaseSync(p.gate);try{assert.equal(d.prepare("SELECT name FROM sqlite_master WHERE name='state'").get(),undefined);}finally{d.close();}
});
test('failure creating bootstrap state preserves promoted lease evidence',t=>{
 const project=root(t),p=paths(project),original=DatabaseSync.prototype.exec;let injected=false;
 try{DatabaseSync.prototype.exec=function(sql){if(sql.includes('CREATE TABLE state')){injected=true;throw Object.assign(Error('state IOERR'),{errcode:10});}return original.call(this,sql);};assert.throws(()=>initialize(project),/state IOERR/);}finally{DatabaseSync.prototype.exec=original;}
 assert(injected);for(const field of fields)assert(fs.existsSync(p[field]));assert.throws(()=>initialize(project),/Missing coordination state with existing leases/);
});

test('private cleanup preserves an unexpected file instead of recursively sweeping the directory',t=>{
 const project=root(t),p=paths(project),original=DatabaseSync.prototype.exec;let extra;
 try{DatabaseSync.prototype.exec=function(sql){if(!extra&&sql.includes('CREATE TABLE lease')){const dir=fs.readdirSync(p.runtime).find(n=>n.startsWith('bootstrap-'));extra=path.join(p.runtime,dir,'unknown-evidence');fs.writeFileSync(extra,'retain');}return original.call(this,sql);};assert.throws(()=>initialize(project),e=>e instanceof AggregateError&&e.errors.some(x=>x.code==='ENOTEMPTY'||x.code==='EEXIST'));}finally{DatabaseSync.prototype.exec=original;}
 assert.equal(fs.readFileSync(extra,'utf8'),'retain');assert.equal(state(p).mode,'idle');assert.doesNotThrow(()=>initialize(project));
});

test('uncertain candidate close retains database and journal evidence',t=>{
 const project=root(t),p=paths(project),exec=DatabaseSync.prototype.exec,close=DatabaseSync.prototype.close;let candidate,dbFile,journal;
 try{DatabaseSync.prototype.exec=function(sql){if(sql.includes('CREATE TABLE lease')){candidate=this;const dir=fs.readdirSync(p.runtime).find(n=>n.startsWith('bootstrap-'));dbFile=path.join(p.runtime,dir,'connections.sqlite');journal=dbFile+'-journal';}return exec.call(this,sql);};DatabaseSync.prototype.close=function(){if(this===candidate){fs.writeFileSync(journal,'recovery evidence');throw Error('uncertain close');}return close.call(this);};assert.throws(()=>initialize(project),/uncertain close/);}finally{DatabaseSync.prototype.exec=exec;DatabaseSync.prototype.close=close;candidate&&close.call(candidate);}
 assert(fs.existsSync(dbFile));assert.equal(fs.readFileSync(journal,'utf8'),'recovery evidence');for(const field of fields)assert.equal(fs.existsSync(p[field]),false);
});

for(const after of [false,true])test(`process crash ${after?'after':'before'} state COMMIT respects committed authority`,t=>{
 const project=root(t),p=paths(project),result=child(project,`const exec=DatabaseSync.prototype.exec;let gate;DatabaseSync.prototype.exec=function(sql){if(sql.includes('CREATE TABLE state'))gate=this;if(this===gate&&sql==='COMMIT'){if(${after})exec.call(this,sql);process.exit(73);}return exec.call(this,sql);}`);
 assert.equal(result.status,73,result.stderr);for(const field of fields)assert(fs.existsSync(p[field]));
 if(after){initialize(project);assert.equal(state(p).mode,'idle');}else assert.throws(()=>initialize(project),/Missing coordination state with existing leases/);
});
