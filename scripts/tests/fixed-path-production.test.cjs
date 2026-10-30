const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {CodeGraph, DatabaseConnection} = require('../../dist/index.js');
const {ToolHandler} = require('../../dist/mcp/tools.js');
const {records, paths, seal} = require('../../dist/sync/fixed-path/protocol.js');
process.env.CODEGRAPH_ALL_LANGUAGES = '1';
process.env.CODEGRAPH_FIXED_PATH = '1';
function root() { return fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-production-')); }
function source(dir, value=1, flask=false) {
  fs.writeFileSync(path.join(dir,'main.py'), `${flask?'from flask import Flask\napp = Flask(__name__)\n':'# stable line\n# stable line\n'}def stable(value=${value}):\n    return value\n`);
}
function addFiles(dir, prefix, count=140) { for(let i=0;i<count;i++) fs.writeFileSync(path.join(dir,`${prefix}${i}.py`),`def ${prefix}${i}():\n    return ${i}\n`); }
function cli(args, env={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--liftoff-only',path.resolve('dist/bin/codegraph.js'),...args],{env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.on('error',reject);
    child.on('close',code=>code===0?resolve(output):reject(new Error(`CLI ${code}: ${output}`)));
  });
}

test('real SDK fixed initialization, ordinary sync and marker authority with opt-in unset', async()=>{
  const dir=root();source(dir);let graph=await CodeGraph.init(dir,{index:true});
  try {
    assert.equal(graph.getDatabaseFilePath(),path.join(dir,'.codegraph-wx','codegraph.db'));
    const id=graph.searchNodes('stable')[0].node.id;
    assert.deepEqual(graph.getDetectedFrameworks(),[]);
    source(dir,2,true);await graph.indexAll();
    assert.match(graph.getNode(id).signature,/value=2/);assert(graph.getDetectedFrameworks().includes('flask'));
    source(dir,3);await graph.sync({adaptive:false});assert(!graph.getDetectedFrameworks().includes('flask'));
    assert.throws(()=>DatabaseConnection.openReadOnly(graph.getDatabaseFilePath()),/lifecycle admission/);
    graph.close();graph=null;
    fs.writeFileSync(path.join(dir,'.codegraph-wx','CURRENT'),'{invalid obsolete current}');
    delete process.env.CODEGRAPH_FIXED_PATH;
    graph=CodeGraph.openSync(dir);assert.match(graph.getNode(id).signature,/value=3/);
    graph.clear();assert.equal(graph.getNode(id),null);
  } finally { graph?.close();process.env.CODEGRAPH_FIXED_PATH='1';fs.rmSync(dir,{recursive:true,force:true}); }
});

test('real SDK and ToolHandler survive repeated automatic rebuilds at the same active path', {timeout:30000}, async()=>{
  const dir=root();source(dir);const graph=await CodeGraph.init(dir,{index:true});const handler=new ToolHandler(graph);
  try {
    const identity=graph.getDatabaseIdentity();const active=graph.getDatabaseFilePath();
    for(let n=0;n<2;n++) {
      // Remove previous additions so the second change is also structurally broad.
      for(const f of fs.readdirSync(dir))if(f!=='main.py'&&f.endsWith('.py'))fs.unlinkSync(path.join(dir,f));
      addFiles(dir,`round${n}_`);const result=await graph.sync();
      assert.equal(result.adaptive?.strategy,'rebuild');assert.equal(graph.getDatabaseFilePath(),active);
      assert.notEqual(graph.getDatabaseIdentity(),identity);
      assert.equal(graph.searchNodes(`round${n}_139`)[0].node.name,`round${n}_139`);
      const response=await handler.execute('search',{query:`round${n}_139`});assert.equal(response.isError,undefined);assert.match(JSON.stringify(response),new RegExp(`round${n}_139`));
      assert(records(paths(dir)).every(record=>record.phase==='cleaned'));
    }
  } finally {handler.closeAll();graph.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('long SDK read pin cancels bounded drain without closing or mixing the old request', {timeout:15000}, async()=>{
  const dir=root();source(dir);const graph=await CodeGraph.init(dir,{index:true});const pin=graph.acquireFixedPathRead();
  try {
    addFiles(dir,'blocked_');await assert.rejects(graph.sync(),/Drain|drain|cancelled/);
    assert.equal(pin.graph.searchNodes('stable').length,1);assert.equal(pin.graph.searchNodes('blocked_139').length,0);
    assert.equal(graph.searchNodes('stable').length,1);pin.release();
    assert.equal((await graph.sync()).adaptive.strategy,'rebuild');assert(graph.searchNodes('blocked_139').some(r=>r.node.name==='blocked_139'));
  } finally {pin.release();graph.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('single standalone public database repeats offline cover -> CLI increment -> rebuild -> cover -> sync', {timeout:40000}, async()=>{
  const producer=root(),consumer=root();source(producer);source(consumer);let p=await CodeGraph.init(producer,{index:true});p.close();
  const publicFile=path.join(producer,'.codegraph-wx','codegraph.db');seal(publicFile,{standalone:true});
  let graph=await CodeGraph.init(consumer,{index:true});graph.close();graph=null;
  const active=path.join(consumer,'.codegraph-wx','codegraph.db');
  try {
    for(let round=0;round<2;round++) {
      for(const f of fs.readdirSync(consumer))if(f.endsWith('.py'))fs.unlinkSync(path.join(consumer,f));source(consumer);
      fs.copyFileSync(publicFile,active);graph=CodeGraph.openSync(consumer);
      let decision;await graph.sync({onAdaptiveDecision:d=>decision=d});assert.equal(decision.strategy,'incremental');
      const id=graph.searchNodes('stable')[0].node.id;source(consumer,round+5,true);
      await cli(['sync',consumer,'--quiet']);assert.match(graph.getNode(id).signature,new RegExp(`value=${round+5}`));assert(graph.getDetectedFrameworks().includes('flask'));
      addFiles(consumer,`cycle${round}_`);assert.equal((await graph.sync()).adaptive.strategy,'rebuild');
      assert(graph.searchNodes(`cycle${round}_139`).some(r=>r.node.name===`cycle${round}_139`));graph.close();graph=null;
      assert(!fs.existsSync(active+'-wal'));assert(!fs.existsSync(active+'-shm'));
    }
    fs.writeFileSync(active,'corrupt public file');assert.throws(()=>CodeGraph.openSync(consumer));
  } finally {graph?.close();fs.rmSync(producer,{recursive:true,force:true});fs.rmSync(consumer,{recursive:true,force:true});}
});

test('real legacy generation migrates offline and normal open ignores the retired CURRENT', {timeout:15000}, async()=>{
  const dir=root();source(dir);delete process.env.CODEGRAPH_FIXED_PATH;
  let graph=await CodeGraph.init(dir,{index:true});const original=graph.getDatabaseFilePath();graph.close();graph=null;
  try {
    assert.match(original, /generations/);
    await CodeGraph.migrateStorage(dir,{offline:true});
    graph=CodeGraph.openSync(dir);assert.equal(graph.getDatabaseFilePath(),path.join(dir,'.codegraph-wx','codegraph.db'));
    assert.equal(graph.searchNodes('stable').length,1);source(dir,42);await graph.sync({adaptive:false});
    assert.match(graph.searchNodes('stable')[0].node.signature,/42/);
    assert(!fs.existsSync(original));
  } finally {graph?.close();process.env.CODEGRAPH_FIXED_PATH='1';fs.rmSync(dir,{recursive:true,force:true});}
});

test('real OS watcher triggers fixed-path sync and stays running through a rebuild', {timeout:20000}, async()=>{
  const dir=root();source(dir);const graph=await CodeGraph.init(dir,{index:true});
  try {
    let done,failed;const completed=new Promise((resolve,reject)=>{done=resolve;failed=reject;});
    graph.watch({debounceMs:100,onSyncComplete:done,onSyncError:failed});await graph.waitUntilWatcherReady();
    addFiles(dir,'watched_');await completed;
    assert(graph.searchNodes('watched_139').some(r=>r.node.name==='watched_139'));
    assert(graph.isWatching());assert(records(paths(dir)).some(record=>record.phase==='cleaned'));
    graph.unwatch();await graph.whenIdle();
  } finally {graph.unwatch();await graph.whenIdle();graph.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('whenIdle waits for retained SDK pin even without a promise query', async()=>{
  const dir=root();source(dir);const graph=await CodeGraph.init(dir,{index:true});const pin=graph.acquireFixedPathRead();
  try {
    let idle=false;const wait=graph.whenIdle().then(()=>idle=true);
    await new Promise(r=>setTimeout(r,20));assert.equal(idle,false);
    pin.release();await wait;assert.equal(idle,true);
  } finally {pin.release();graph.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('actual SDK mutator crash releases OS mutation ownership without stale root lock', {timeout:15000}, async()=>{
  const dir=root();source(dir);const graph=await CodeGraph.init(dir,{index:true});
  try {
    const code=`const {CodeGraph}=require(${JSON.stringify(path.resolve('dist/index.js'))});const {FixedPathWriterLock}=require(${JSON.stringify(path.resolve('dist/sync/fixed-path/writer-lock.js'))});const original=FixedPathWriterLock.prototype.acquire;FixedPathWriterLock.prototype.acquire=function(){original.call(this);process.send('locked');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};CodeGraph.openSync(process.argv[1]).clear();`;
    const child=spawn(process.execPath,['--liftoff-only','-e',code,dir],{env:process.env,stdio:['ignore','ignore','pipe','ipc']});
    const exited=new Promise(resolve=>child.once('close',resolve));
    await new Promise((resolve,reject)=>{child.once('error',reject);child.once('message',m=>m==='locked'?resolve():reject(new Error('unexpected child message')));});
    child.kill('SIGKILL');await exited;
    assert(!fs.existsSync(path.join(dir,'.codegraph-wx','codegraph.lock')));
    graph.clear();assert.equal(graph.searchNodes('stable').length,0);
  } finally {graph.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('scoped watcher sync rebuilds changed configuration then performs a full post-publication check', {timeout:15000}, async()=>{
  const dir=root();source(dir);const graph=await CodeGraph.init(dir,{index:true});
  try {
    fs.writeFileSync(path.join(dir,'.gitignore'),'ignored-new-file.py\n');
    source(dir,9);
    const result=await graph.sync({paths:['main.py']});
    assert.equal(result.adaptive?.strategy,'rebuild');assert.equal(result.complete,true);
    assert.match(graph.searchNodes('stable')[0].node.signature,/value=9/);
  } finally {graph.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('write committed after planning cannot be overwritten by a later candidate baseline', {timeout:15000}, async()=>{
  const dir=root();source(dir);const graph=await CodeGraph.init(dir,{index:true});
  try {
    addFiles(dir,'changed_');let cleared=false;
    await assert.rejects(graph.sync({onAdaptiveDecision(decision){if(decision.strategy==='rebuild'&&!cleared){cleared=true;graph.clear();}}}),/changed after planning/);
    assert(cleared);assert.equal(graph.getFiles().length,0);assert.equal(graph.searchNodes('stable').length,0);
    assert(records(paths(dir)).every(record=>record.phase==='cleaned'));
  } finally {graph.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('source edits immediately after actual publication converge automatically before sync completes', {timeout:15000}, async()=>{
  const dir=root();source(dir);const graph=await CodeGraph.init(dir,{index:true});
  const worker=require('../../dist/sync/fixed-path/rebuild.js'), original=worker.runFixedPathRebuild;
  let injected=false;
  worker.runFixedPathRebuild=async(...args)=>{
    const result=await original(...args);
    if(!injected){injected=true;source(dir,77);fs.writeFileSync(path.join(dir,'late.py'),'def late_added():\n    return 1\n');}
    return result;
  };
  try {
    addFiles(dir,'reconcile_');const result=await graph.sync();assert(injected);
    assert.equal(result.complete,true);assert.equal(result.adaptive.strategy,'rebuild');
    assert.match(graph.searchNodes('stable')[0].node.signature,/value=77/);
    assert(graph.searchNodes('late_added').some(r=>r.node.name==='late_added'));
  } finally {worker.runFixedPathRebuild=original;graph.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('project-directory aliases share one fixed database and recovery namespace', {timeout:15000}, async()=>{
  const dir=root(),alias=dir+'-alias';source(dir);const graph=await CodeGraph.init(dir,{index:true});let other;
  try {
    fs.symlinkSync(dir,alias,process.platform==='win32'?'junction':'dir');other=CodeGraph.openSync(alias);
    assert.equal(other.getProjectRoot(),fs.realpathSync(dir));assert.equal(other.getDatabaseFilePath(),graph.getDatabaseFilePath());
    addFiles(dir,'alias_');assert.equal((await other.sync()).adaptive.strategy,'rebuild');
    assert(graph.searchNodes('alias_139').some(r=>r.node.name==='alias_139'));
    assert.deepEqual(paths(alias),paths(dir));assert(records(paths(dir)).every(record=>record.phase==='cleaned'));
  } finally {other?.close();graph.close();fs.rmSync(alias,{force:true,recursive:true});fs.rmSync(dir,{recursive:true,force:true});}
});

test('real fixed indexing runs leased native store and parallel resolver workers through actual exit', {timeout:30000}, async()=>{
  const dir=root(),lifetime=require('../../dist/db/worker-lifetime');
  const original=lifetime.startDatabaseWorker,previous={min:process.env.CODEGRAPH_PARALLEL_RESOLVE_MIN,workers:process.env.CODEGRAPH_RESOLVE_WORKERS};
  const observations=[];let graph;
  process.env.CODEGRAPH_PARALLEL_RESOLVE_MIN='0';process.env.CODEGRAPH_RESOLVE_WORKERS='2';
  lifetime.startDatabaseWorker=function(script,file,factory,options){
    assert.equal(typeof factory,'function','production native worker must receive independent admission');
    const record={script:path.basename(script),released:false};observations.push(record);
    return original(script,file,()=>{const held=factory();return{release(){held.release();record.released=true;}};},options);
  };
  try{
    fs.writeFileSync(path.join(dir,'many.ts'),'export function target() { return 1; }\n'+Array.from({length:1200},(_,i)=>`export function caller${i}(){return target();}`).join('\n'));
    graph=await CodeGraph.init(dir,{index:true});await graph.whenIdle();
    assert(observations.some(r=>r.script==='store-worker.js'));
    assert.equal(observations.filter(r=>r.script==='resolver-worker.js').length,2);
    assert(observations.every(r=>r.released),'all actual worker threads exited before indexing returns');
    assert(graph.searchNodes('caller1199').some(r=>r.node.name==='caller1199'));
  } finally {
    lifetime.startDatabaseWorker=original;graph?.close();
    for(const [key,value] of [['CODEGRAPH_PARALLEL_RESOLVE_MIN',previous.min],['CODEGRAPH_RESOLVE_WORKERS',previous.workers]]){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('low-level filename symlinks cannot bypass registered fixed native admission',async()=>{
  const dir=root();let graph;
  try{
    graph=await CodeGraph.init(dir);const active=graph.getDatabaseFilePath(),alias=path.join(dir,'alias.sqlite');graph.close();graph=null;
    fs.symlinkSync(active,alias,'file');
    assert.throws(()=>DatabaseConnection.openReadOnly(alias),/lifecycle admission/);
    assert.throws(()=>DatabaseConnection.open(alias),/lifecycle admission/);
    assert.throws(()=>DatabaseConnection.initialize(alias),/lifecycle admission/);
    graph=CodeGraph.openSync(dir);assert.equal(graph.getDatabaseFilePath(),active);
  }finally{graph?.close();fs.rmSync(dir,{recursive:true,force:true});}
});
