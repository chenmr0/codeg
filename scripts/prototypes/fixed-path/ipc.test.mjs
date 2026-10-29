import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fork} from 'node:child_process';
import {createIpcChannel} from './ipc.mjs';

test('IPC close waits for every phase and terminal transport callback',async()=>{
 const callbacks=[];let disconnected=false;const ipc=createIpcChannel({connected:true,send(message,callback){callbacks.push(callback);return false;},disconnect(){disconnected=true;}});
 ipc.send({event:'phase'});const terminal=ipc.send({event:'result'});let closed=false;const closing=ipc.close().then(()=>closed=true);
 await Promise.resolve();assert.equal(disconnected,false);callbacks[1]();await terminal;await Promise.resolve();assert.equal(disconnected,false,'terminal callback alone cannot bypass older queued send');callbacks[0]();await closing;assert.equal(closed,true);assert.equal(disconnected,true);
});
test('IPC hook callback errors are surfaced at close, never successful silent shutdown',async()=>{
 const failure=Error('injected IPC transport failure');let callback,disconnected=false;const ipc=createIpcChannel({connected:true,send(message,cb){callback=cb;},disconnect(){disconnected=true;}});
 ipc.send({event:'phase'});callback(failure);await assert.rejects(ipc.close(),e=>e===failure);assert.equal(disconnected,true);
});
test('IPC child drains large buffered messages before disconnect and exit',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'fixed-ipc-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const file=path.join(root,'child.mjs');
 fs.writeFileSync(file,`import {createIpcChannel} from ${JSON.stringify(new URL('./ipc.mjs',import.meta.url).href)};const {send,close}=createIpcChannel();for(let i=0;i<4;i++)send({event:'phase',i,payload:'x'.repeat(1024*1024)});await send({event:'result',value:'complete'});await close();`);
 const child=fork(file,[],{stdio:['ignore','ignore','pipe','ipc']}),messages=[];let stderr='';child.stderr.on('data',b=>stderr+=b);child.on('message',m=>messages.push(m));t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();});
 const {code,signal}=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',(code,signal)=>resolve({code,signal}));});assert.equal(code,0,stderr);assert.equal(signal,null);assert.deepEqual(messages.map(m=>m.event),['phase','phase','phase','phase','result']);for(let i=0;i<4;i++){assert.equal(messages[i].i,i);assert.equal(messages[i].payload.length,1024*1024);}assert.equal(messages[4].value,'complete');
});
