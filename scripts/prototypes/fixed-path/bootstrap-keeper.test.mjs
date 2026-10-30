/** Real WAL attachments and cross-process handoffs; not power-loss guarantees. */
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync,spawn} from 'node:child_process';import{setTimeout as delay}from'node:timers/promises';import{waitForChildClose}from'./ipc.mjs';import {DatabaseSync} from 'node:sqlite';
import{initialize,paths,Participant,beginOperation,recover,lease}from'./protocol.mjs';
const protocol=new URL('./protocol.mjs',import.meta.url).href;
function root(t){const p=fs.mkdtempSync(path.join(os.tmpdir(),'bootstrap-keeper-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;}
function track(){const prepare=DatabaseSync.prototype.prepare,close=DatabaseSync.prototype.close;const probes=[],closed=new Set();DatabaseSync.prototype.prepare=function(sql){const stmt=prepare.call(this,sql);if(sql!=="SELECT name FROM sqlite_master WHERE name='state'")return stmt;const d=this;return{get(...args){const r=stmt.get(...args);if(!d.isTransaction&&prepare.call(d,'PRAGMA journal_mode').get().journal_mode==='wal'&&!probes.includes(d))probes.push(d);return r;}};};DatabaseSync.prototype.close=function(){const r=close.call(this);closed.add(this);return r;};return{probes,closed,restore(){DatabaseSync.prototype.prepare=prepare;DatabaseSync.prototype.close=close;}};}
function child(project,body){const r=spawnSync(process.execPath,['--input-type=module','-e',`import{initialize,gate}from ${JSON.stringify(protocol)};const p=initialize(${JSON.stringify(project)});${body}`],{encoding:'utf8',timeout:10000});assert.equal(r.status,0,r.stderr);}
test('cold private preparation retains attached WAL while another process installs and writes',t=>{
 const project=root(t),p=paths(project),x=track(),exec=DatabaseSync.prototype.exec;let visited=false;
 try{DatabaseSync.prototype.exec=function(sql){if(!visited&&sql.includes('CREATE TABLE lease')){visited=true;assert.equal(x.probes.length,1);assert.equal(x.closed.has(x.probes[0]),false,'bootstrap must not close before lease preparation');assert.equal(x.probes[0].isTransaction,false);assert(fs.existsSync(p.gate+'-wal'));assert(fs.existsSync(p.gate+'-shm'));const inode=fs.statSync(p.gate+'-shm').ino;child(project,"gate(p,d=>d.exec('UPDATE state SET revision=revision+1'));");assert.equal(fs.statSync(p.gate+'-shm').ino,inode,'child must not last-close/delete/recreate shared memory');assert.equal(x.probes[0].prepare('SELECT revision FROM state').get().revision,1,'keeper must see fresh commits, not pin a read transaction');}return exec.call(this,sql);};initialize(project);assert(visited);assert.equal(x.closed.has(x.probes[0]),true,'standalone initialize releases its keeper at completion');}finally{DatabaseSync.prototype.exec=exec;x.restore();}
});
test('Participant directly adopts probe through recovery; independent writes stay visible',t=>{
 const project=root(t),x=track();let v;
 try{v=new Participant(project,()=>{throw Error('not needed');});assert.equal(v.coordination,x.probes[0]);assert.equal(x.closed.has(v.coordination),false);assert.equal(v.coordination.isTransaction,false);child(project,"gate(p,d=>d.exec('UPDATE state SET revision=revision+1'));");assert.equal(v.coordination.prepare('SELECT revision FROM state').get().revision,1);v.close();assert.equal(x.closed.has(x.probes[0]),true);}finally{v?.close();x.restore();}
});
for(const failureAt of ['options','recovery','costs'])test(`Participant ${failureAt} startup failure closes the transferred probe`,t=>{
 const project=root(t);initialize(project);const x=track(),prepare=DatabaseSync.prototype.prepare,expected=Error(`injected ${failureAt}`);let options={};
 if(failureAt==='options')options={get readGates(){throw expected;}};
 try{DatabaseSync.prototype.prepare=function(sql){if((failureAt==='recovery'&&sql==='SELECT id FROM state WHERE id=1')||(failureAt==='costs'&&sql==='SELECT 1 FROM costs LIMIT 1'))throw expected;return prepare.call(this,sql);};assert.throws(()=>new Participant(project,()=>{},options),e=>e===expected);assert.equal(x.probes.length,1);assert.equal(x.closed.has(x.probes[0]),true);const held=lease(paths(project).owner,true);assert(held);held.close();}finally{DatabaseSync.prototype.prepare=prepare;x.restore();}
});
test('publisher bootstrap closes only after owner keeper is attached',t=>{
 const project=root(t),x=track(),prepare=DatabaseSync.prototype.prepare;let attached=false,op;
 try{DatabaseSync.prototype.prepare=function(sql){if(sql==='SELECT id FROM state WHERE id=1'&&new Error().stack.includes('at coordinatedOwner (')){assert.equal(x.closed.has(x.probes[0]),false);attached=true;}return prepare.call(this,sql);};op=beginOperation(project);assert(attached);assert.equal(x.closed.has(x.probes[0]),true);assert(fs.existsSync(paths(project).gate+'-shm'));op.owner.close();}finally{op?.owner.close();DatabaseSync.prototype.prepare=prepare;x.restore();}
});
test('recovery retains the probe until owner keeper work has finished',t=>{
 const project=root(t);initialize(project);const x=track(),prepare=DatabaseSync.prototype.prepare;let seen=false;
 try{DatabaseSync.prototype.prepare=function(sql){if(sql==='SELECT id FROM state WHERE id=1'){seen=true;assert.equal(x.closed.has(x.probes[0]),false);}return prepare.call(this,sql);};assert.equal(recover(project),true);assert(seen);assert.equal(x.closed.has(x.probes[0]),true);}finally{DatabaseSync.prototype.prepare=prepare;x.restore();}
});

test('another process bootstraps while sole initial keeper is paused; killing keeper preserves committed state',async t=>{
 const project=root(t),p=paths(project),ready=path.join(project,'ready');
 const source=`import fs from 'node:fs';import{DatabaseSync}from'node:sqlite';import{initialize}from ${JSON.stringify(protocol)};const exec=DatabaseSync.prototype.exec;let paused=false;DatabaseSync.prototype.exec=function(sql){if(!paused&&sql.includes('CREATE TABLE lease')){paused=true;fs.writeFileSync(${JSON.stringify(ready)},'ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20000);}return exec.call(this,sql);};initialize(${JSON.stringify(project)});`;
 const c=spawn(process.execPath,['--input-type=module','-e',source],{stdio:'ignore'}),done=waitForChildClose(c);t.after(()=>{if(c.exitCode===null&&c.signalCode===null)c.kill();});const deadline=Date.now()+10000;while(!fs.existsSync(ready)){if(Date.now()>deadline)throw Error('keeper child never paused');await delay(2);}
 assert(fs.existsSync(p.gate+'-shm'));child(project,"gate(p,d=>d.exec('UPDATE state SET revision=revision+7'));");c.kill('SIGKILL');await done;
 const v=new Participant(project,()=>{});try{assert.equal(v.coordination.prepare('SELECT revision FROM state').get().revision,7);assert.equal(v.coordination.isTransaction,false);}finally{v.close();}
});
