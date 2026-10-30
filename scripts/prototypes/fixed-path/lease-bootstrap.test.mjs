/** Bootstrap fault injection occurs BEFORE the named SQLite statement. */
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';import {DatabaseSync} from 'node:sqlite';import{setTimeout as delay}from 'node:timers/promises';
import{paths,initialize,lease,sha}from './protocol.mjs';import{waitForChildClose}from './ipc.mjs';
const fields=['connections','owner','writers'];
function root(t){const project=fs.mkdtempSync(path.join(os.tmpdir(),'lease-bootstrap-'));t.after(()=>fs.rmSync(project,{recursive:true,force:true}));return project;}
function noState(p){const db=new DatabaseSync(p.gate);try{assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='state'").get(),undefined,'coordination state must not commit after a failed lease');}finally{db.close();}}
for(const target of fields)for(const phase of ['CREATE','INSERT','COMMIT'])test(`${target} private preparation ${phase} error never publishes a fixed lease`,t=>{
 const project=root(t),p=paths(project),original=DatabaseSync.prototype.exec,targetIndex=fields.indexOf(target),failure=Object.assign(Error(`injected ${target} ${phase} IOERR`),{errcode:10});let transactions=0,injected=0;
 try{DatabaseSync.prototype.exec=function(sql){if(sql.includes('CREATE TABLE lease(value INTEGER)')){const index=transactions++;if(index===targetIndex){for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean)){if(statement.startsWith(phase)){injected++;throw failure;}original.call(this,statement);}return;} }return original.call(this,sql);};assert.throws(()=>initialize(project),e=>e===failure);}finally{DatabaseSync.prototype.exec=original;}
 assert.equal(injected,1);assert.equal(transactions,targetIndex+1);noState(p);
 for(const field of fields)assert.equal(fs.existsSync(p[field]),false,'private failed preparation must not publish fixed lease evidence');
 assert.deepEqual(fs.readdirSync(p.runtime).filter(n=>n.startsWith('bootstrap-')),[],'own closed candidates are removed');
 assert.doesNotThrow(()=>initialize(project),'failure before promotion leaves shared bootstrap untouched');

});

test('lease probes begin at busy_timeout=0 and still honor independent-process exclusion',async t=>{
 const project=root(t),p=initialize(project),ready=path.join(p.runtime,'ready'),release=path.join(p.runtime,'release');
 const child=spawn(process.execPath,['-e',`const fs=require('node:fs'),{DatabaseSync}=require('node:sqlite');const ds=${JSON.stringify(fields.map(f=>p[f]))}.map(f=>{const d=new DatabaseSync(f);d.exec('BEGIN EXCLUSIVE');return d;});fs.writeFileSync(${JSON.stringify(ready)},'ready');const end=Date.now()+10000,timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);for(const d of ds)d.close();}else if(Date.now()>end){clearInterval(timer);for(const d of ds)d.close();process.exitCode=1;}},2);`],{stdio:['ignore','ignore','ignore']});const done=waitForChildClose(child);t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();});const end=Date.now()+10000;while(!fs.existsSync(ready)){if(Date.now()>end)throw Error('lease lock child did not become ready');await delay(2);}const original=DatabaseSync.prototype.exec,pragmas=[];
 try{DatabaseSync.prototype.exec=function(sql){if(sql.includes('PRAGMA synchronous=FULL'))pragmas.push(sql);return original.call(this,sql);};for(const field of fields){assert.equal(lease(p[field]),null,`${field} must reject SHARED under real EXCLUSIVE`);assert.equal(lease(p[field],true),null,`${field} must reject second EXCLUSIVE`);}}finally{DatabaseSync.prototype.exec=original;fs.writeFileSync(release,'release');await done;}
 assert.equal(pragmas.length,6);assert(pragmas.every(sql=>sql==='PRAGMA busy_timeout=0; PRAGMA synchronous=FULL'));for(const field of fields){const held=lease(p[field]);assert(held);held.close();}assert.equal((await done).code,0);
});
