// Exercise the actual fs.watch callback with deterministic overflow/null delivery.
// Real SQLite, scanner and fixed-path publisher are used for the source test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {FileWatcher} = require('../../dist/sync/watcher.js');
const {CodeGraph} = require('../../dist/index.js');
process.env.CODEGRAPH_ALL_LANGUAGES='1';
process.env.CODEGRAPH_FIXED_PATH='1';
const sleep = ms => new Promise(r=>setTimeout(r,ms));
async function until(fn) {const deadline=Date.now()+10000;while(!fn()){if(Date.now()>deadline)throw Error('watcher did not reconcile ambiguous event');await sleep(10);}}
function recursiveCallback(watcher) {
  // Capture only registration, not sync/indexing behavior. Works on Linux too,
  // so the Windows recursive callback remains covered on every CI platform.
  const original=fs.watch;let callback;
  fs.watch=(_root,_options,cb)=>{callback=cb;const handle=new EventEmitter();handle.close=()=>{};return handle;};
  try{watcher.startRecursive();}finally{fs.watch=original;}
  assert.equal(typeof callback,'function');return callback;
}

test('recursive overflow after partial filenames performs full real fixed-path sync', {timeout:20000}, async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cg-watch-overflow-'));
 fs.writeFileSync(path.join(dir,'main.py'),'def stable():\n    return 1\n');
 const graph=await CodeGraph.init(dir,{index:true});const calls=[];let error;
 const watcher=new FileWatcher(dir,async paths=>{calls.push(paths);const r=await graph.sync({paths});return {filesChanged:r.filesAdded+r.filesModified+r.filesRemoved,durationMs:r.durationMs};},{inertForTests:true,debounceMs:10,onSyncError:e=>error=e});
 try{
  assert(watcher.start());const event=recursiveCallback(watcher);const old=graph.getDatabaseIdentity();
  for(let i=0;i<140;i++)fs.writeFileSync(path.join(dir,`added_${i}.py`),`def added_${i}():\n    return ${i}\n`);
  event('rename','added_0.py');event('rename',null);
  await until(()=>calls.length>0&&!watcher.syncing);
  if(error)throw error;
  assert.equal(calls[0],undefined,'ambiguous notification requires full reconcile, not partial scope');
  assert(graph.searchNodes('added_139').some(r=>r.node.name==='added_139'));
  assert.notEqual(graph.getDatabaseIdentity(),old,'large unseen tail still triggers rebuild');
 }finally{watcher.stop();await graph.whenIdle();graph.close();fs.rmSync(dir,{recursive:true,force:true});}
});

for(const strategy of ['recursive','per-directory']) test(`${strategy}: null during a full scan preserves a follow-up and stopped events do nothing`,async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cg-watch-null-'));const calls=[];let release;
 const watcher=new FileWatcher(dir,async paths=>{calls.push(paths);if(calls.length===1)await new Promise(r=>release=r);return {filesChanged:1,durationMs:1};},{inertForTests:true,debounceMs:10});
 try{
  watcher.start();const event=strategy==='recursive'?recursiveCallback(watcher):(_type,name)=>watcher.handleDirEvent(dir,name);
  event('rename',null);await until(()=>calls.length===1);
  event('change',null);release();await until(()=>calls.length===2&&!watcher.syncing);
  assert.deepEqual(calls,[undefined,undefined]);watcher.stop();event('rename',null);await sleep(150);assert.equal(calls.length,2);
 }finally{release?.();watcher.stop();fs.rmSync(dir,{recursive:true,force:true});}
});
