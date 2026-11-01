const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const workers = require('node:worker_threads');
const { CodeGraph } = require('../../dist');
const { QueryBuilder } = require('../../dist/db/queries');
const { beginSourceWrite, finishSourceWrite } = require('../../dist/sync/source-ownership');
const { withFixedPathOpen } = require('../../dist/sync/fixed-path/open-context');
const { DatabaseConnection } = require('../../dist/db');
const { GenerationWriterLock } = require('../../dist/sync/generation-store');
const { whenMaintenanceIdle } = require('../../dist/sync/fixed-path/protocol');
process.execArgv = ['--liftoff-only'];
process.env.CODEGRAPH_FIXED_PATH = '1';
delete process.env.NODE_OPTIONS;
delete process.env.CODEGRAPH_ADAPTIVE_SYNC;

// Observe the real built worker, its source scan and its response. No production
// fast-path result is mocked; hooks only count work or mutate real fixture files.
const OriginalWorker = workers.Worker;
let traceFile, fault, scans = 0, evaluations = [];
workers.Worker = class extends OriginalWorker {
  constructor(script, options) {
    if (String(script).endsWith('scan-worker.js')) scans++;
    if (!String(script).endsWith('rebuild-validation-worker.js') || !traceFile) {
      super(script, options); return;
    }
    const code = `
      const fs=require('node:fs'),path=require('node:path');
      const {workerData}=require('node:worker_threads');
      const log=event=>fs.appendFileSync(workerData.traceFile,JSON.stringify(event)+'\\n');
      const planner=require(${JSON.stringify(path.resolve(__dirname, '../../dist/sync/adaptive-plan.js'))});
      const extraction=require(${JSON.stringify(path.resolve(__dirname, '../../dist/extraction/index.js'))});
      const key=planner.adaptiveRuntimeKey,scan=extraction.scanDirectoryAsync;
      const gate=planner.createAdaptivePlanOrUnchanged;
      if(gate)planner.createAdaptivePlanOrUnchanged=async(...args)=>{const result=await gate(...args);log({event:'unchanged-gate',hint:result===undefined});return result;};
      planner.adaptiveRuntimeKey=(...args)=>{log({event:'fingerprint'});return key(...args);};
      extraction.scanDirectoryAsync=async(...args)=>{log({event:'plan-scan',fullHash:!!workerData.job.fullHash});return scan(...args);};
      const lstat=fs.lstatSync,read=fs.readFileSync;
      let observed=false,fired=false;
      fs.lstatSync=function(file,...args){
        const result=lstat(file,...args);
        if(String(file)===path.join(workerData.job.root,'keep.c')) {
          observed=true;
          if(workerData.fault==='add-during-plan'&&!fired){fired=true;
            fs.writeFileSync(path.join(workerData.job.root,'new.c'),'int added_symbol(void){return 33;}\\n');}
        }
        return result;
      };
      fs.readFileSync=function(file,...args){
        if(workerData.fault==='delete-during-read'&&observed&&!fired&&String(file)===path.join(workerData.job.root,'keep.c')){
          fired=true;fs.unlinkSync(file);
        }
        return read(file,...args);
      };
      require(${JSON.stringify(String(script))});`;
    super(code, { ...options, eval: true, workerData: { ...options.workerData, traceFile, fault } });
    this.on('message', value => {
      if (options.workerData.job.type === 'evaluate') evaluations.push({
        fullHash: !!options.workerData.job.fullHash,
        decision: value.result?.decision,
        hasPlan: !!value.result?.plan,
        runtimeKey: value.result?.plan?.runtimeKey,
        error: value.error,
      });
    });
  }
};
test.after(() => { workers.Worker = OriginalWorker; });

const names = graph => graph.getNodesByKind('function').map(n => n.name).sort();
const events = () => fs.existsSync(traceFile) ? fs.readFileSync(traceFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
function read(graph, action) {
  const pin = graph.acquireFixedPathRead();
  try { return action(pin.graph.db.getDb()); } finally { pin.release(); }
}
function semanticSnapshot(graph) {
  return read(graph, db => ['files','nodes','edges','unresolved_refs'].map(table =>
    db.prepare(`SELECT * FROM ${table}`).all().map(row => JSON.stringify(row)).sort()));
}
async function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fixed-noop-plan-')));
  cp.execFileSync('git',['init','-q'],{cwd:root});
  fs.writeFileSync(path.join(root,'keep.c'),'int kept_symbol(void){return 1;}\n');
  fs.writeFileSync(path.join(root,'caller.c'),'#include "keep.c"\nint caller_symbol(void){return kept_symbol();}\n');
  for(const file of ['keep.c','caller.c'])fs.utimesSync(path.join(root,file),new Date(1700000000000),new Date(1700000000000));
  cp.execFileSync('git',['add','.'],{cwd:root});
  let graph = await CodeGraph.init(root,{index:true});
  assert.equal(graph.getBackend(),'node-sqlite');
  traceFile = path.join(root,'trace.jsonl'); scans=0; evaluations=[]; fault=undefined;
  t.after(async()=>{
    traceFile=undefined;fault=undefined;
    graph.abortActiveWork();await graph.whenIdle();graph.close();await graph.whenIdle();
    await whenMaintenanceIdle(root,{timeoutMs:5000});
    fs.rmSync(root,{recursive:true,force:true});
  });
  return {root,graph,async reopen(){await graph.whenIdle();graph.close();await graph.whenIdle();graph=CodeGraph.openSync(root);return graph;}};
}
function mutateOwned(graph, action) {
  const data=graph.getDataDirectory(), lock=new GenerationWriterLock(data);lock.acquire();
  let connection;
  try {
    connection=withFixedPathOpen(graph.getDatabaseFilePath(),()=>DatabaseConnection.open(graph.getDatabaseFilePath()));
    const db=connection.getDb(), token=beginSourceWrite(db);
    assert(token);action(db);assert(finishSourceWrite(db,token,true));
  } finally {connection?.close();lock.release();}
}
function assertCall(graph, target='kept_symbol') {
  assert.equal(read(graph,db=>db.prepare(`SELECT count(*) AS n FROM edges e
    JOIN nodes s ON s.id=e.source JOIN nodes t ON t.id=e.target
    WHERE e.kind='calls' AND s.name='caller_symbol' AND t.name=?`).get(target).n),1);
  assert.deepEqual(read(graph,db=>db.prepare('PRAGMA foreign_key_check').all()),[]);
}

test('unchanged default sync avoids unused fingerprints, inventory transfer and cost-baseline table read, but runs reconciliation',async t=>{
  const {graph}=await fixture(t),before=semanticSnapshot(graph);
  let fileReads=0;const getFiles=QueryBuilder.prototype.getAllFiles;
  QueryBuilder.prototype.getAllFiles=function(...args){fileReads++;return getFiles.apply(this,args);};
  let result;
  try {result=await graph.sync();} finally {QueryBuilder.prototype.getAllFiles=getFiles;}
  assert.equal(result.complete,true);assert.equal(result.filesChecked,2);
  assert.equal(result.filesAdded+result.filesModified+result.filesRemoved,0);
  assert.equal(fileReads,1,'only the authoritative reconciliation reads all files on the main thread');
  assert.equal(scans,1,'ordinary sync still performs a fresh source scan');
  assert.equal(events().filter(e=>e.event==='plan-scan').length,1);
  assert.equal(events().filter(e=>e.event==='fingerprint').length,0);
  assert(events().some(e=>e.event==='unchanged-gate'&&e.hint),'the real fixed-layout preflight avoids the full no-op inventory');
  assert(evaluations.some(e=>e.decision?.reason==='no-content-changes'&&!e.hasPlan));
  assert.deepEqual(semanticSnapshot(graph),before);assertCall(graph);
});

for(const change of ['add','modify','delete','ignore']) test(`fresh execution scan sees ${change} after zero-change planning`,async t=>{
  const {root,graph,reopen}=await fixture(t);let injected=false;
  const result=await graph.sync({onAdaptiveDecision(decision){
    if(injected)return;assert.equal(decision.reason,'no-content-changes');injected=true;
    if(change==='add')fs.writeFileSync(path.join(root,'new.c'),'int added_symbol(void){return 33;}\n');
    if(change==='modify')fs.writeFileSync(path.join(root,'keep.c'),'int changed_symbol(void){return 333;}\n');
    if(change==='delete')fs.unlinkSync(path.join(root,'keep.c'));
    if(change==='ignore')fs.writeFileSync(path.join(root,'.codegraphignore'),'keep.c\n');
  }});
  assert(injected);assert.equal(result.complete,true);assert.equal(scans,1);
  const latest=await reopen();
  assert(names(latest).includes('caller_symbol'));
  if(change==='add'){assert.equal(result.filesAdded,1);assert(names(latest).includes('added_symbol'));assertCall(latest);}
  else {assert(!names(latest).includes('kept_symbol'));if(change==='modify'){assert.equal(result.filesModified,1);assert(names(latest).includes('changed_symbol'));}else assert.equal(result.filesRemoved,1);}
  assert.deepEqual(read(latest,db=>db.prepare('PRAGMA foreign_key_check').all()),[]);
});

test('a file added after planning enumeration is caught by the execution scan',async t=>{
  const {graph}=await fixture(t);fault='add-during-plan';
  const result=await graph.sync();assert.equal(result.complete,true);assert.equal(result.filesAdded,1);
  assert(names(graph).includes('added_symbol'));assertCall(graph);
});

test('observed source disappearing during planner read still rejects without touching the graph or leaking admission',async t=>{
  const {root,graph}=await fixture(t),before=semanticSnapshot(graph);
  fs.appendFileSync(path.join(root,'keep.c'),'// force planner read\n');fault='delete-during-read';
  await assert.rejects(graph.sync(),/ENOENT/);assert.deepEqual(semanticSnapshot(graph),before);
  fault=undefined;fs.writeFileSync(path.join(root,'keep.c'),'int kept_symbol(void){return 1;}\n');
  assert.equal((await graph.sync()).complete,true);assertCall(graph);
});

for(const reason of ['config','version']) test(`${reason} changes still select rebuild and compute its real runtime key`,async t=>{
  const {root,graph}=await fixture(t);
  if(reason==='config')fs.writeFileSync(path.join(root,'.codegraphignore'),'caller.c\n');
  else mutateOwned(graph,db=>db.prepare("UPDATE project_metadata SET value='0' WHERE key='indexed_with_extraction_version'").run());
  const result=await graph.sync();assert.equal(result.complete,true);assert.equal(result.adaptive?.strategy,'rebuild');
  assert(evaluations.some(e=>e.decision?.strategy==='rebuild'&&e.hasPlan&&/^[a-f0-9]{64}$/.test(e.runtimeKey)));
  assert(events().some(e=>e.event==='fingerprint'));
  if(reason==='config')assert.deepEqual(names(graph),['kept_symbol']);else assertCall(graph);
});

test('pending full-hash catchup fixes a same-size/restored-mtime edit and keeps its inventory',async t=>{
  const {root,graph}=await fixture(t);
  mutateOwned(graph,db=>db.prepare("INSERT OR REPLACE INTO project_metadata(key,value,updated_at) VALUES('fixed-path:source-catchup-v1','test-catchup',?)").run(Date.now()));
  const file=path.join(root,'keep.c'),stat=fs.statSync(file);
  fs.writeFileSync(file,'int kept_symbol(void){return 9;}\n');fs.utimesSync(file,stat.atime,stat.mtime);
  assert.equal(fs.statSync(file).size,stat.size);assert.equal(fs.statSync(file).mtimeMs,stat.mtimeMs);
  const result=await graph.sync({adaptive:false});assert.equal(result.complete,true);assert.equal(result.filesModified,1);
  assert(evaluations.every(e=>e.fullHash&&e.hasPlan));
  assert.equal(events().filter(e=>e.event==='unchanged-gate').length,0);
  assert.equal(read(graph,db=>db.prepare("SELECT value FROM project_metadata WHERE key='fixed-path:source-catchup-v1'").get()),undefined);
  assert.equal(read(graph,db=>db.prepare("SELECT content_hash FROM files WHERE path='keep.c'").get().content_hash),require('../../dist/extraction').hashContent(fs.readFileSync(file,'utf8')));
  assertCall(graph);
});

test('no-content-change planning still runs pending reference recovery',async t=>{
  const {graph}=await fixture(t);
  mutateOwned(graph,db=>{
    const caller=db.prepare("SELECT id FROM nodes WHERE name='caller_symbol'").get().id;
    db.prepare("DELETE FROM edges WHERE source=? AND kind='calls'").run(caller);
    db.prepare(`INSERT INTO unresolved_refs(from_node_id,reference_name,reference_kind,line,col,file_path,language,status,name_tail)
      VALUES(?,'kept_symbol','calls',2,32,'caller.c','c','pending','kept_symbol')`).run(caller);
  });
  const result=await graph.sync();assert.equal(result.complete,true);assertCall(graph);
  assert.equal(read(graph,db=>db.prepare("SELECT count(*) AS n FROM unresolved_refs WHERE status='pending'").get().n),0);
});

test('no-content-change planning retains forced extraction requests',async t=>{
  const {root,graph}=await fixture(t),file=path.join(root,'keep.c'),before=fs.statSync(file);
  fs.writeFileSync(file,'int kept_symbol(void){return 9;}\n');fs.utimesSync(file,before.atime,before.mtime);
  const result=await graph.sync({forceReindexPaths:['keep.c']});assert.equal(result.complete,true);assert.equal(result.filesModified,1);assertCall(graph);
  assert.equal(read(graph,db=>db.prepare("SELECT content_hash FROM files WHERE path='keep.c'").get().content_hash),require('../../dist/extraction').hashContent(fs.readFileSync(file,'utf8')));
});

test('sync admission remains cancellable while another process owns it, then releases for retry',async t=>{
  const {root,graph}=await fixture(t);
  const child=cp.spawn(process.execPath,['--liftoff-only','-e',`
    const {acquireFixedSyncAdmission}=require(${JSON.stringify(path.resolve(__dirname,'../../dist/sync/fixed-path/sync-admission'))});
    (async()=>{const lease=await acquireFixedSyncAdmission(${JSON.stringify({project:root,dataDirectory:graph.getDataDirectory()})},{});process.send('locked');process.on('message',()=>{lease.close();process.exit(0);});})().catch(e=>{console.error(e);process.exit(1);});
  `],{stdio:['ignore','pipe','pipe','ipc']});
  t.after(()=>{if(child.exitCode===null)child.kill();});
  await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);child.once('exit',()=>reject(new Error('child exited before admission')));});
  const cancel=new AbortController(),sync=graph.sync({signal:cancel.signal});setTimeout(()=>cancel.abort(),50);
  await assert.rejects(sync,/abort|cancel/i);assert.equal(evaluations.length,0);
  child.send('release');await new Promise(resolve=>child.once('exit',resolve));
  assert.equal((await graph.sync()).complete,true);assertCall(graph);
});

test('an unchanged incomplete index still runs synthesis recovery',async t=>{
  const {graph}=await fixture(t);
  mutateOwned(graph,db=>db.prepare("INSERT OR REPLACE INTO project_metadata(key,value,updated_at) VALUES('index_synthesis_pending','complete',?)").run(Date.now()));
  assert.equal(graph.getIndexCompleteness().status,'incomplete');
  const result=await graph.sync();assert.equal(result.complete,true);assertCall(graph);
  assert.equal(read(graph,db=>db.prepare("SELECT value FROM project_metadata WHERE key='index_synthesis_pending'").get()),undefined);
  assert.equal(graph.getIndexCompleteness().status,'complete');
});

test('legacy history evaluation still computes and returns its runtime key and plan',async t=>{
  process.env.CODEGRAPH_FIXED_PATH='0';
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'legacy-noop-plan-')));
  fs.writeFileSync(path.join(root,'keep.c'),'int kept_symbol(void){return 1;}\n');
  const graph=await CodeGraph.init(root,{index:true});
  traceFile=path.join(root,'trace.jsonl');evaluations=[];scans=0;fault=undefined;
  t.after(async()=>{traceFile=undefined;await graph.whenIdle();graph.close();fs.rmSync(root,{recursive:true,force:true});process.env.CODEGRAPH_FIXED_PATH='1';});
  const {runAdaptiveReadWorker}=require('../../dist/sync/rebuild-controller');
  const result=await runAdaptiveReadWorker({type:'evaluate',root,databasePath:graph.getDatabaseFilePath(),eligibility:{}});
  assert.equal(result.decision.strategy,'incremental');assert(result.plan);assert.match(result.plan.runtimeKey,/^[a-f0-9]{64}$/);
  assert.equal(events().filter(e=>e.event==='fingerprint').length,1);
});

test('scoped small-change evaluation avoids the unused fingerprint and retains scope boundaries',async t=>{
  const {root,graph}=await fixture(t);
  fs.writeFileSync(path.join(root,'outside.c'),'int outside_symbol(void){return 42;}\n');
  const result=await graph.sync({paths:['keep.c']});
  assert.equal(result.complete,true);assert.equal(result.filesChecked,1);
  assert(!names(graph).includes('outside_symbol'));assertCall(graph);
  assert(evaluations.some(e=>e.decision?.reason==='scoped-small-change'&&!e.hasPlan),JSON.stringify(evaluations));
  assert.equal(events().filter(e=>e.event==='fingerprint').length,0);
  assert.equal(events().filter(e=>e.event==='plan-scan').length,0);
  assert.equal(scans,0);
  assert.equal((await graph.sync()).filesAdded,1);assert(names(graph).includes('outside_symbol'));
});


test('a custom low structural threshold still rebuilds after an inconclusive unchanged gate',async t=>{
  const {root,graph}=await fixture(t);
  fs.appendFileSync(path.join(root,'keep.c'),'int extra_symbol(void){return 123;}\n');
  const result=await graph.sync({adaptiveFallback:{minChangedFiles:1,minChangedFraction:.1,minWorkFraction:.1,
    minAffectedOldNodes:1,minAffectedOldNodeFraction:.1}});
  assert.equal(result.complete,true);assert.equal(result.adaptive?.strategy,'rebuild');
  assert(events().some(e=>e.event==='unchanged-gate'&&!e.hint));
  assert(names(graph).includes('extra_symbol'));assertCall(graph);
});
