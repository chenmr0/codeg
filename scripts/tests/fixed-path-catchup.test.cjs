const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {CodeGraph} = require('../../dist/index.js');
const rebuild = require('../../dist/sync/fixed-path/rebuild.js');
const {records, paths} = require('../../dist/sync/fixed-path/protocol.js');
process.env.CODEGRAPH_ALL_LANGUAGES = '1';
process.env.CODEGRAPH_FIXED_PATH = '1';
// Node test runners may expand default flags; exercise the supported production runtime.
process.execArgv = ['--liftoff-only'];
const pendingKey = 'fixed-path:source-catchup-v1';
function root() { return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-catchup-'))); }
function source(dir, name='before_symbol') { const file=path.join(dir, 'main.py');fs.writeFileSync(file, `def ${name}():\n    return 1\n`);fs.utimesSync(file,1700000000,1700000000); }
function addFiles(dir) { for (let i=0;i<140;i++) fs.writeFileSync(path.join(dir,`extra_${i}.py`),`def extra_${i}():\n    return ${i}\n`); }
function changeWithoutStat(dir) {
  const file=path.join(dir,'main.py'), before=fs.statSync(file);
  source(dir,'after__symbol'); fs.utimesSync(file,before.atime,before.mtime);
  const after=fs.statSync(file);
  assert.equal(after.size,before.size);assert.equal(Math.floor(after.mtimeMs),Math.floor(before.mtimeMs));
}
function pending(graph) {
  const pin=graph.acquireFixedPathRead();
  try { return pin.graph.db.getDb().prepare('SELECT value FROM project_metadata WHERE key=?').get(pendingKey)?.value ?? null; }
  finally { pin.release(); }
}
function updated(graph) {
  assert(graph.searchNodes('after__symbol').some(r=>r.node.name==='after__symbol'));
  assert(!graph.searchNodes('before_symbol').some(r=>r.node.name==='before_symbol'));
}
async function dispose(graph,dir) { if(graph){graph.abortActiveWork();await graph.whenIdle();graph.close();}fs.rmSync(dir,{recursive:true,force:true}); }

// Guard against the original endless loop without depending on a wall-clock race.
test('same-size/restored-mtime edit after publication converges, removes old symbol and becomes a stable no-op', {timeout:20000}, async()=>{
  const dir=root();source(dir);const graph=await CodeGraph.init(dir,{index:true});
  const original=rebuild.runFixedPathRebuild;let injected=false,checks=0;const cancel=new AbortController();
  rebuild.runFixedPathRebuild=async(...args)=>{const result=await original(...args);if(!injected){injected=true;assert.match(pending(graph),/^[a-f0-9-]{36}$/);changeWithoutStat(dir);}return result;};
  try {
    addFiles(dir);
    const result=await graph.sync({signal:cancel.signal,onAdaptiveDecision(){if(injected&&++checks>3)cancel.abort();}});
    assert(injected);assert.equal(result.complete,true);assert.equal(result.adaptive?.strategy,'rebuild');assert.equal(result.filesAdded,140);assert.equal(result.filesModified,1);updated(graph);
    assert.equal(pending(graph),null);assert(checks<=3);
    const stable=await graph.sync();assert.equal(stable.filesModified,0);assert.equal(stable.filesAdded,0);assert.equal(stable.filesRemoved,0);
  } finally {rebuild.runFixedPathRebuild=original;await dispose(graph,dir);}
});

for(const options of [{}, {adaptive:false,paths:['extra_0.py']}, {disableAdaptiveEnv:true}]) {
  test(`cancelled post-publication catchup survives reopen and ${options.disableAdaptiveEnv?'environment-disabled':options.adaptive===false?'scoped nonadaptive':'ordinary'} sync`, {timeout:20000}, async()=>{
    const dir=root();source(dir);let graph=await CodeGraph.init(dir,{index:true});
    const original=rebuild.runFixedPathRebuild, priorAdaptive=process.env.CODEGRAPH_ADAPTIVE_SYNC;const cancel=new AbortController();let published=false,token;
    rebuild.runFixedPathRebuild=async(...args)=>{const result=await original(...args);published=true;token=pending(graph);changeWithoutStat(dir);cancel.abort();return result;};
    try {
      addFiles(dir);await assert.rejects(graph.sync({signal:cancel.signal}),/cancel|abort/i);assert(published);assert(token);
      await graph.whenIdle();graph.close();graph=CodeGraph.openSync(dir);assert.equal(pending(graph),token);
      rebuild.runFixedPathRebuild=original;
      if(options.disableAdaptiveEnv)process.env.CODEGRAPH_ADAPTIVE_SYNC='0';
      const result=await graph.sync(options);assert.notEqual(result.complete,false);updated(graph);assert.equal(pending(graph),null);
      const stable=await graph.sync();assert.equal(stable.filesModified+stable.filesAdded+stable.filesRemoved,0);
    } finally {rebuild.runFixedPathRebuild=original;if(priorAdaptive===undefined)delete process.env.CODEGRAPH_ADAPTIVE_SYNC;else process.env.CODEGRAPH_ADAPTIVE_SYNC=priorAdaptive;await dispose(graph,dir);}
  });
}

// The publisher itself exits after the durable protocol COMMIT, before it can
// return a result. This covers the old crash window before facade.published was set.
test('publisher process exits after durable commit: reopened sync recovers pending hash catchup', {timeout:25000}, async()=>{
  const dir=root();source(dir);let graph=await CodeGraph.init(dir,{index:true});graph.close();graph=null;addFiles(dir);
  const fixture=path.join(dir,'publisher-crash.cjs');
  const protocol=path.resolve('dist/sync/fixed-path/protocol.js'), worker=path.resolve('dist/sync/fixed-path/rebuild-worker.js');
  fs.writeFileSync(fixture,`const fs=require('node:fs'),path=require('node:path');const protocol=require(${JSON.stringify(protocol)});const original=protocol.publish;protocol.publish=(op,options={})=>original(op,{...options,hook(phase){options.hook?.(phase);if(phase==='committed'){const file=path.join(op.p.project,'main.py'),s=fs.statSync(file);fs.writeFileSync(file,'def after__symbol():\\n    return 1\\n');fs.utimesSync(file,s.atime,s.mtime);process.exit(73);}}});require(${JSON.stringify(worker)});`);
  const code=`process.execArgv=['--liftoff-only'];const cp=require('node:child_process'),original=cp.fork;cp.fork=function(file,args,options){return original(file.endsWith('rebuild-worker.js')?${JSON.stringify(fixture)}:file,args,options);};const {CodeGraph}=require(${JSON.stringify(path.resolve('dist/index.js'))});const graph=CodeGraph.openSync(process.argv[1]);graph.sync().then(()=>process.exit(2),async error=>{console.error(error.message);await graph.whenIdle();graph.close();process.exit(0);});`;
  try {
    const result=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--liftoff-only','-e',code,dir],{env:process.env,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.once('error',reject);child.once('close',code=>resolve({code,output}));});
    assert.equal(result.code,0,result.output);assert.match(result.output,/73/);
    graph=CodeGraph.openSync(dir);assert(pending(graph));assert(records(paths(dir)).some(r=>r.phase==='cleaned'));
    assert(graph.searchNodes('before_symbol').some(r=>r.node.name==='before_symbol'));
    const recovered=await graph.sync();assert.notEqual(recovered.complete,false);updated(graph);assert.equal(pending(graph),null);
    assert.equal((await graph.sync()).filesModified,0);
  } finally {await dispose(graph,dir);}
});

test('failed incremental catchup retains durable intent and concurrent retries converge once', {timeout:25000}, async()=>{
  const dir=root();source(dir);let graph=await CodeGraph.init(dir,{index:true});
  const original=rebuild.runFixedPathRebuild,originalSync=CodeGraph.prototype.sync;let injected=false;
  rebuild.runFixedPathRebuild=async(...args)=>{const result=await original(...args);injected=true;changeWithoutStat(dir);return result;};
  CodeGraph.prototype.sync=async function(options){if(injected)throw new Error('Injected catchup failure');return originalSync.call(this,options);};
  try {
    addFiles(dir);await assert.rejects(graph.sync(),/Injected catchup failure/);assert(injected);const token=pending(graph);assert(token);
    CodeGraph.prototype.sync=originalSync;rebuild.runFixedPathRebuild=original;
    await graph.whenIdle();graph.close();graph=CodeGraph.openSync(dir);assert.equal(pending(graph),token);
    const other=CodeGraph.openSync(dir);
    try {
      const results=await Promise.all([graph.sync(),other.sync({adaptive:false,paths:['extra_0.py']})]);
      assert(results.every(r=>r.complete!==false));updated(graph);updated(other);assert.equal(pending(graph),null);assert.equal(pending(other),null);
    } finally {await other.whenIdle();other.close();}
  } finally {CodeGraph.prototype.sync=originalSync;rebuild.runFixedPathRebuild=original;await dispose(graph,dir);}
});

test('offline database replacement owns its own catchup intent, not the retired publication record', {timeout:25000}, async()=>{
  const dir=root(),replacement=root();source(dir);source(replacement);let graph=await CodeGraph.init(dir,{index:true}),other=await CodeGraph.init(replacement,{index:true});
  const original=rebuild.runFixedPathRebuild;const cancel=new AbortController();
  rebuild.runFixedPathRebuild=async(...args)=>{const result=await original(...args);changeWithoutStat(dir);cancel.abort();return result;};
  try {
    addFiles(dir);await assert.rejects(graph.sync({signal:cancel.signal}),/cancel|abort/i);const retiredToken=pending(graph);assert(retiredToken);
    rebuild.runFixedPathRebuild=original;
    await graph.whenIdle();const active=graph.getDatabaseFilePath();graph.close();graph=null;
    const clean=other.getDatabaseFilePath();other.close();other=null;
    fs.copyFileSync(clean,active);source(dir);
    graph=CodeGraph.openSync(dir);assert.equal(pending(graph),null,'retired publication cannot inject pending state into an offline replacement');
    // A new rebuild must establish its own UUID, and clear only that obligation.
    let token;
    rebuild.runFixedPathRebuild=async(...args)=>{const result=await original(...args);token=pending(graph);changeWithoutStat(dir);return result;};
    const result=await graph.sync();assert.equal(result.adaptive?.strategy,'rebuild');assert(token);assert.notEqual(token,retiredToken);updated(graph);assert.equal(pending(graph),null);
  } finally {rebuild.runFixedPathRebuild=original;await dispose(graph,dir);await dispose(other,replacement);}
});

test('cancellation during mismatch parsing keeps catchup pending until a reopened sync finishes', {timeout:25000}, async()=>{
  const dir=root();source(dir);let graph=await CodeGraph.init(dir,{index:true});
  const original=rebuild.runFixedPathRebuild;const cancel=new AbortController();let injected=false,cancelledParsing=false;
  rebuild.runFixedPathRebuild=async(...args)=>{const result=await original(...args);injected=true;changeWithoutStat(dir);return result;};
  try {
    addFiles(dir);
    await assert.rejects(graph.sync({signal:cancel.signal,onProgress(progress){if(injected&&progress.phase==='parsing'){cancelledParsing=true;cancel.abort();}}}),/cancel|abort/i);
    assert(cancelledParsing,'cancellation must occur after hash mismatch admitted the changed source for parsing');assert(pending(graph));
    rebuild.runFixedPathRebuild=original;await graph.whenIdle();graph.close();graph=CodeGraph.openSync(dir);assert(pending(graph));
    const result=await graph.sync();assert.notEqual(result.complete,false);updated(graph);assert.equal(pending(graph),null);
  } finally {rebuild.runFixedPathRebuild=original;await dispose(graph,dir);}
});

test('configuration-only edit after publication re-extracts and converges its config fingerprint', {timeout:25000}, async()=>{
  const dir=root();source(dir);const graph=await CodeGraph.init(dir,{index:true});
  const original=rebuild.runFixedPathRebuild,originalIndex=CodeGraph.prototype.indexAll;let catchupIndexes=0;
  rebuild.runFixedPathRebuild=async(...args)=>{const result=await original(...args);fs.writeFileSync(path.join(dir,'compile_flags.txt'),'-DPOST_PUBLICATION=1\n');return result;};
  CodeGraph.prototype.indexAll=function(options){if(options?.fixedPathCatchupConfig)catchupIndexes++;return originalIndex.call(this,options);};
  try {
    addFiles(dir);const result=await graph.sync();assert.notEqual(result.complete,false);assert.equal(catchupIndexes,1);
    const pin=graph.acquireFixedPathRead();
    try {
      const indexed=pin.graph.db.getDb().prepare('SELECT value FROM project_metadata WHERE key=?').get('adaptive:index-config-v1').value;
      const {adaptiveConfigFingerprint}=require('../../dist/sync/adaptive-plan.js');
      assert.equal(indexed,adaptiveConfigFingerprint(dir,graph.getFiles()));
    } finally {pin.release();}
    assert.equal(pending(graph),null);assert(graph.searchNodes('before_symbol').some(r=>r.node.name==='before_symbol'));
    assert.equal((await graph.sync()).filesModified,0);assert.equal(catchupIndexes,1);
  } finally {rebuild.runFixedPathRebuild=original;CodeGraph.prototype.indexAll=originalIndex;await dispose(graph,dir);}
});

test('pending catchup resumes in a real input-type module caller using an isolated worker runtime', {timeout:25000}, async()=>{
  const dir=root();source(dir);let graph=await CodeGraph.init(dir,{index:true});
  const original=rebuild.runFixedPathRebuild;const cancel=new AbortController();
  rebuild.runFixedPathRebuild=async(...args)=>{const result=await original(...args);changeWithoutStat(dir);cancel.abort();return result;};
  try {
    addFiles(dir);await assert.rejects(graph.sync({signal:cancel.signal}),/cancel|abort/i);assert(pending(graph));
    rebuild.runFixedPathRebuild=original;await graph.whenIdle();graph.close();graph=null;
    const code=`import {createRequire} from 'node:module';const require=createRequire(import.meta.url);const assert=require('node:assert/strict');assert(process.execArgv.some(arg=>arg.startsWith('--input-type')));const {CodeGraph}=require(${JSON.stringify(path.resolve('dist/index.js'))});const graph=CodeGraph.openSync(${JSON.stringify(dir)});try{const result=await graph.sync({adaptive:false,paths:['extra_0.py']});assert.notEqual(result.complete,false);assert(graph.searchNodes('after__symbol').some(r=>r.node.name==='after__symbol'));assert(!graph.searchNodes('before_symbol').some(r=>r.node.name==='before_symbol'));await graph.whenIdle();}finally{graph.close();}`;
    const result=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--liftoff-only','--input-type=module','--eval',code],{env:process.env,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.once('error',reject);child.once('close',code=>resolve({code,output}));});
    assert.equal(result.code,0,result.output);graph=CodeGraph.openSync(dir);updated(graph);assert.equal(pending(graph),null);
  } finally {rebuild.runFixedPathRebuild=original;await dispose(graph,dir);}
});

test('failure after source storage cannot clear pending catchup before the resolution tail is retried', {timeout:25000}, async()=>{
  const dir=root();source(dir);fs.writeFileSync(path.join(dir,'main.py'),'def before_symbol():\n    return extra_0()\n');
  let graph=await CodeGraph.init(dir,{index:true});
  const {ReferenceResolver}=require('../../dist/resolution/index.js');
  const original=rebuild.runFixedPathRebuild,resolve=ReferenceResolver.prototype.resolveFilesAndPersist;let injected=false,retried=false;
  rebuild.runFixedPathRebuild=async(...args)=>{const result=await original(...args);injected=true;const file=path.join(dir,'main.py'),before=fs.statSync(file);fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('before_symbol','after__symbol'));fs.utimesSync(file,before.atime,before.mtime);return result;};
  ReferenceResolver.prototype.resolveFilesAndPersist=function(...args){if(injected)throw new Error('Injected resolution tail failure');return resolve.apply(this,args);};
  try {
    addFiles(dir);await assert.rejects(graph.sync(),/Injected resolution tail failure/);updated(graph);assert(pending(graph));
    const pin=graph.acquireFixedPathRead();
    try {assert(pin.graph.db.getDb().prepare("SELECT count(*) AS n FROM project_metadata WHERE key LIKE 'sync-retry:pending:%' OR key LIKE 'sync-retry:rewire:%'").get().n>0);} finally {pin.release();}
    assert(graph.getPendingReferenceCount()>0);
    rebuild.runFixedPathRebuild=original;
    ReferenceResolver.prototype.resolveFilesAndPersist=function(...args){retried=true;return resolve.apply(this,args);};
    await graph.whenIdle();graph.close();graph=CodeGraph.openSync(dir);
    const {createAdaptivePlan}=require('../../dist/sync/adaptive-plan.js');
    const plan=await createAdaptivePlan(dir,graph.getFiles(),{runtimeKey:'test',fullHash:true});assert.equal(plan.changedFiles,0,'source bytes already committed before resolver failed');
    const result=await graph.sync();assert.notEqual(result.complete,false);assert(retried);updated(graph);assert.equal(pending(graph),null);assert.equal(graph.getPendingReferenceCount(),0);
    const finalPin=graph.acquireFixedPathRead();
    try {assert.equal(finalPin.graph.db.getDb().prepare("SELECT count(*) AS n FROM project_metadata WHERE key LIKE 'sync-retry:pending:%' OR key LIKE 'sync-retry:rewire:%'").get().n,0);} finally {finalPin.release();}
  } finally {rebuild.runFixedPathRebuild=original;ReferenceResolver.prototype.resolveFilesAndPersist=resolve;await dispose(graph,dir);}
});

test('module-parent catchup runs real fan-in store and parallel resolver workers', {timeout:45000}, async()=>{
  const dir=root();source(dir);let graph=await CodeGraph.init(dir,{index:true});
  const original=rebuild.runFixedPathRebuild;const cancel=new AbortController();
  rebuild.runFixedPathRebuild=async(...args)=>{const result=await original(...args);const file=path.join(dir,'target.ts'),stat=fs.statSync(file);fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('return 1','return 2'));fs.utimesSync(file,stat.atime,stat.mtime);cancel.abort();return result;};
  try {
    addFiles(dir);
    fs.writeFileSync(path.join(dir,'target.ts'),'export function target(){return 1;}\n');
    fs.writeFileSync(path.join(dir,'many.ts'),"import {target} from './target';\n"+Array.from({length:2200},(_,i)=>`export function caller${i}(){return target();}`).join('\n'));
    await assert.rejects(graph.sync({signal:cancel.signal}),/cancel|abort/i);assert(pending(graph));
    rebuild.runFixedPathRebuild=original;await graph.whenIdle();graph.close();graph=null;
    const code=`
      import {createRequire} from 'node:module';const require=createRequire(import.meta.url);
      const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
      assert(process.execArgv.some(arg=>arg.startsWith('--input-type')));
      const lifetime=require(${JSON.stringify(path.resolve('dist/db/worker-lifetime.js'))});
      const original=lifetime.startDatabaseWorker,observations=[];let configChanged=false;
      lifetime.startDatabaseWorker=function(script,file,factory,options){
        const record={script:path.basename(script),released:false};observations.push(record);
        return original(script,file,()=>{const held=factory();return {release(){held.release();record.released=true;if(record.script==='store-worker.js'&&!configChanged){configChanged=true;fs.writeFileSync(path.join(${JSON.stringify(dir)},'compile_flags.txt'),'-DPOST_PUBLICATION=1\\n');}}};},options);
      };
      const {CodeGraph}=require(${JSON.stringify(path.resolve('dist/index.js'))});
      const graph=CodeGraph.openSync(${JSON.stringify(dir)});
      try {
        const result=await graph.sync({adaptive:false,paths:['extra_0.py']});assert.notEqual(result.complete,false);await graph.whenIdle();
        assert(graph.searchNodes('caller2199').some(r=>r.node.name==='caller2199'));
        assert(observations.some(r=>r.script==='store-worker.js'),JSON.stringify(observations));
        assert(observations.filter(r=>r.script==='resolver-worker.js').length>=2,JSON.stringify(observations));
        assert(observations.every(r=>r.released),'all native database workers must actually exit before acknowledgement');
      } finally {graph.close();}
    `;
    const result=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--liftoff-only','--input-type=module','--eval',code],{env:{...process.env,CODEGRAPH_PARALLEL_RESOLVE_MIN:'0',CODEGRAPH_RESOLVE_WORKERS:'2'},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.once('error',reject);child.once('close',code=>resolve({code,output}));});
    assert.equal(result.code,0,result.output);graph=CodeGraph.openSync(dir);assert.equal(pending(graph),null);assert.equal((await graph.sync()).filesModified,0);
  } finally {rebuild.runFixedPathRebuild=original;await dispose(graph,dir);}
});

test('already-open module facade waits for a crashed committed publisher and runs off-thread recovery before catchup', {timeout:30000}, async()=>{
  const dir=root();source(dir);let graph=await CodeGraph.init(dir,{index:true});graph.close();graph=null;addFiles(dir);
  const release=path.join(dir,'.release-publisher'),fixture=path.join(dir,'queued-publisher-crash.cjs');
  const protocol=path.resolve('dist/sync/fixed-path/protocol.js'),worker=path.resolve('dist/sync/fixed-path/rebuild-worker.js');
  fs.writeFileSync(fixture,`const fs=require('node:fs'),path=require('node:path');const protocol=require(${JSON.stringify(protocol)}),original=protocol.publish;protocol.publish=(op,options={})=>original(op,{...options,hook(phase){options.hook?.(phase);if(phase==='prepared'){process.send({type:'test-prepared'});while(!fs.existsSync(${JSON.stringify(release)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}if(phase==='committed'){const file=path.join(op.p.project,'main.py'),s=fs.statSync(file);fs.writeFileSync(file,'def after__symbol():\\n    return 1\\n');fs.utimesSync(file,s.atime,s.mtime);process.exit(73);}}});require(${JSON.stringify(worker)});`);
  const children=[];
  const launch=(args)=>{
    const child=spawn(process.execPath,args,{env:process.env,stdio:['ignore','pipe','pipe','ipc']});children.push(child);
    let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
    child.result=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve({code,output}));});
    return child;
  };
  const message=(child,wanted)=>new Promise((resolve,reject)=>{
    const got=value=>{if(value?.type===wanted){cleanup();resolve(value);}};
    const exited=code=>{cleanup();reject(new Error(`Child exited ${code} before ${wanted}`));};
    const cleanup=()=>{child.off('message',got);child.off('exit',exited);};child.on('message',got);child.once('exit',exited);
  });
  const moduleCode=`
    import {createRequire} from 'node:module';const require=createRequire(import.meta.url);
    const assert=require('node:assert/strict'),path=require('node:path'),wt=require('node:worker_threads');
    const Worker=wt.Worker;let recoveryWorkers=0;
    wt.Worker=class extends Worker {constructor(file,options){super(file,options);if(path.basename(String(file))==='sync-recovery-worker.js')recoveryWorkers++;}};
    const admission=require(${JSON.stringify(path.resolve('dist/sync/fixed-path/sync-admission.js'))}),original=admission.acquireFixedSyncAdmission;
    admission.acquireFixedSyncAdmission=function(...args){const work=original(...args);process.send({type:'admission-entered'});return work;};
    const {CodeGraph}=require(${JSON.stringify(path.resolve('dist/index.js'))});const graph=CodeGraph.openSync(${JSON.stringify(dir)});
    process.send({type:'ready'});process.once('message',async()=>{try{
      const result=await graph.sync({adaptive:false,paths:['extra_0.py']});assert.notEqual(result.complete,false);
      assert(recoveryWorkers>0,'queued sync must launch the recovery worker, not rely on openSync recovery');
      assert(graph.searchNodes('after__symbol').some(r=>r.node.name==='after__symbol'));
      assert(!graph.searchNodes('before_symbol').some(r=>r.node.name==='before_symbol'));
      await graph.whenIdle();graph.close();process.disconnect();
    }catch(error){console.error(error.stack);process.exit(1);}});
  `;
  const publisherCode=`process.execArgv=['--liftoff-only'];const cp=require('node:child_process'),original=cp.fork;cp.fork=function(file,args,options){const child=original(file.endsWith('rebuild-worker.js')?${JSON.stringify(fixture)}:file,args,options);child.on('message',m=>{if(m?.type==='test-prepared')process.send(m);});return child;};const {CodeGraph}=require(${JSON.stringify(path.resolve('dist/index.js'))});const graph=CodeGraph.openSync(${JSON.stringify(dir)});graph.sync().then(()=>process.exit(2),async error=>{console.error(error.message);await graph.whenIdle();graph.close();process.exit(0);});`;
  try {
    const waiting=launch(['--liftoff-only','--input-type=module','--eval',moduleCode]);await message(waiting,'ready');
    const publisher=launch(['--liftoff-only','--eval',publisherCode]);await message(publisher,'test-prepared');
    const entered=message(waiting,'admission-entered');waiting.send({type:'sync'});await entered;
    fs.writeFileSync(release,'release');
    const [published,recovered]=await Promise.all([publisher.result,waiting.result]);assert.equal(published.code,0,published.output);assert.match(published.output,/73/);assert.equal(recovered.code,0,recovered.output);
    graph=CodeGraph.openSync(dir);updated(graph);assert.equal(pending(graph),null);assert.equal((await graph.sync()).filesModified,0);
  } finally {
    for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
    await Promise.allSettled(children.map(child=>child.result));await dispose(graph,dir);
  }
});
