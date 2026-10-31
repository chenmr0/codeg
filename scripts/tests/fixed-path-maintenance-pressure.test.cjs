const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {once}=require('node:events'),{spawn}=require('node:child_process'),{performance}=require('node:perf_hooks');
const wt=require('node:worker_threads');
const {DatabaseSync}=require('node:sqlite');
const protocolFile=path.resolve(__dirname,'../../dist/sync/fixed-path/protocol.js');
const {initialize,Participant,paths,gate}=require(protocolFile);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){const end=Date.now()+10000;while(!check()){assert(Date.now()<end,'maintenance exceeded 10s pressure-test bound');await pause(10);}}
function setup(large=false){const dir=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'fixed-maint-pressure-'))),p=initialize(dir),d=new DatabaseSync(p.active);d.exec('CREATE TABLE value(n);INSERT INTO value VALUES(1)');if(large)d.exec('CREATE TABLE payload(blob);INSERT INTO payload VALUES(zeroblob(33554432))');d.close();return{dir,p};}
function participant(dir){return new Participant(dir,file=>new DatabaseSync(file,{readOnly:true}));}
function value(p){return p.requestSync(d=>d.prepare('SELECT n FROM value').get().n);}
function history(p,count){const d=new DatabaseSync(p.gate);try{d.exec('BEGIN');const insert=d.prepare('INSERT INTO operations VALUES(?,?)');for(let i=0;i<count;i++){const id=`00000000-0000-4000-8000-${i.toString(16).padStart(12,'0')}`,directory=path.join(p.runtime,id);insert.run(id,JSON.stringify({version:1,id,directory,active:p.active,candidate:path.join(directory,'candidate.db'),backup:path.join(directory,'old.db'),phase:'cleaned',oldIdentity:null,candidateIdentity:null}));}d.exec('COMMIT');}finally{d.close();}}
function child(dir,code){const c=spawn(process.execPath,['-e',`const p=require(${JSON.stringify(protocolFile)}),fs=require('node:fs'),{DatabaseSync}=require('node:sqlite');const dir=process.argv[1];${code}`,dir],{stdio:['ignore','ignore','pipe','ipc']});let stderr='';c.stderr.on('data',b=>stderr+=b);c.output=()=>stderr;return c;}
async function quiet(p){await p.whenMaintenanceIdle();}
function guardMainThread(){const prepare=DatabaseSync.prototype.prepare,read=fs.readSync;let scans=0,hashReads=0;
 DatabaseSync.prototype.prepare=function(sql){if(/\bFROM operations\b/i.test(sql)){scans++;throw Error('History scan on query thread');}return prepare.call(this,sql);};
 fs.readSync=function(...args){if(/\bat sha \(/.test(new Error().stack)){hashReads++;throw Error('Database hash on query thread');}return read.apply(this,args);};
 return{restore(){DatabaseSync.prototype.prepare=prepare;fs.readSync=read;},stats(){return{scans,hashReads};}};
}

test('100000 legacy cleaned records never scan on the query timer; unchanged data_version does not respawn work',{timeout:20000},async()=>{
 const {dir,p}=setup();const reader=participant(dir);let guard;const Worker=wt.Worker;let spawned=0;
 try{
  assert.equal(value(reader),1);history(p,100000);guard=guardMainThread();
  wt.Worker=class extends Worker{constructor(...args){super(...args);spawned++;}};
  reader.nextMaintenanceAt=0;const start=performance.now();reader.maintainIfNeeded();const dispatchMs=performance.now()-start;
  const gaps=[],queries=[];let previous=performance.now();
  for(let i=0;i<160;i++){await pause(5);const now=performance.now();gaps.push(now-previous);previous=now;const q=performance.now();assert.equal(value(reader),1);queries.push(performance.now()-q);}
  await quiet(reader);const initialWorkers=spawned;assert(initialWorkers>=1);
  for(let i=0;i<12;i++){reader.nextMaintenanceAt=0;reader.maintainIfNeeded();assert.equal(value(reader),1);}
  assert.equal(spawned,initialWorkers,'stable history must not cause repeated full sweeps');assert.deepEqual(guard.stats(),{scans:0,hashReads:0});
  queries.sort((a,b)=>a-b);gaps.sort((a,b)=>a-b);
  console.log('MAINTENANCE_PRESSURE '+JSON.stringify({history:100000,dispatchMs,workers:spawned,queryP99Ms:queries[Math.floor(queries.length*.99)],eventLoopP99Ms:gaps[Math.floor(gaps.length*.99)],eventLoopMaxMs:gaps.at(-1)}));
  // Retain the existing hard admission budget; deterministic SQL/IO guards
  // above establish that no O(history) operation runs on this event loop.
  assert(queries.every(ms=>ms<1000));reader.close();await quiet(reader);assert.deepEqual(guard.stats(),{scans:0,hashReads:0});
 }finally{guard?.restore();wt.Worker=Worker;reader.close();await quiet(reader);fs.rmSync(dir,{recursive:true,force:true});}
});

test('close reclaims a real 32MiB retired database off-thread while another SDK continues querying',{timeout:20000},async()=>{
 const {dir,p}=setup(true);const closing=participant(dir),other=participant(dir);let c,guard;
 try{
  assert.equal(value(closing),1);assert.equal(value(other),1);
  const closingMaintenance=closing.maintainIfNeeded,otherMaintenance=other.maintainIfNeeded;
  closing.maintainIfNeeded=()=>{};other.maintainIfNeeded=()=>{};
  c=child(dir,`(async()=>{const op=p.beginOperation(dir);const d=new DatabaseSync(op.record.candidate);d.exec('CREATE TABLE value(n);INSERT INTO value VALUES(2)');d.close();const result=await p.publish(op,{fail:'cleanup'});process.send({result,directory:op.record.directory,backup:op.record.backup});process.disconnect();})().catch(e=>{console.error(e);process.exit(1)});`);
  const exited=once(c,'exit');const [message]=await once(c,'message');const[code]=await exited;assert.equal(code,0,c.output());assert.equal(message.result.status,'published');
  // Retirement was live during drain, but ordinary maintenance was paused so
  // close must hand the real failed-publication backup to the recovery worker.
  clearInterval(closing.timer);clearInterval(other.timer);
  closing.maintainIfNeeded=closingMaintenance;other.maintainIfNeeded=otherMaintenance;
  assert(fs.statSync(message.backup).size>=33554432);guard=guardMainThread();
  const start=performance.now();closing.close();const closeMs=performance.now()-start;assert(closing.maintenanceWorker,'close must dispatch a final recovery worker');
  const queryTimes=[];while(closing.maintenanceWorker){const q=performance.now();assert.equal(value(other),2);queryTimes.push(performance.now()-q);await pause(2);}
  assert(!fs.existsSync(message.directory));assert.deepEqual(guard.stats(),{scans:0,hashReads:0});assert(queryTimes.length>0);
  console.log('MAINTENANCE_CLOSE '+JSON.stringify({bytes:33554432,closeMs,concurrentQueries:queryTimes.length,maxQueryMs:Math.max(...queryTimes)}));
  assert(queryTimes.every(ms=>ms<1000));other.close();await quiet(other);
 }finally{guard?.restore();c?.kill('SIGKILL');closing.close();other.close();await quiet(closing);await quiet(other);fs.rmSync(dir,{recursive:true,force:true});}
});

test('coordinator reconnect invalidates cached data_version and still collects an exited builder',{timeout:10000},async()=>{
 const {dir}=setup();const reader=participant(dir);let c;
 try{
  assert.equal(value(reader),1);assert.throws(()=>reader.readSnapshot(()=>{throw Error('Injected snapshot failure');}),/Injected/);assert.equal(reader.coordination,null);assert.equal(reader.lastMaintenanceVersion,undefined);assert.equal(reader.maintenancePending,true);
  c=child(dir,`const op=p.beginOperation(dir);fs.writeFileSync(op.record.candidate,'unfinished');process.send({directory:op.record.directory});process.disconnect();`);
  const exited=once(c,'exit');const[message]=await once(c,'message');const[code]=await exited;assert.equal(code,0,c.output());
  await until(()=>!fs.existsSync(message.directory));assert.equal(value(reader),1);reader.close();await quiet(reader);
 }finally{c?.kill('SIGKILL');reader.close();await quiet(reader);fs.rmSync(dir,{recursive:true,force:true});}
});

test('close failure while dispatching maintenance still releases native handles and keeper',async()=>{
 const {dir,p}=setup();const reader=participant(dir);
 try{
  assert.equal(value(reader),1);const keeper=reader.coordination;
  const maintain=reader.maintainIfNeeded;reader.maintainIfNeeded=()=>{throw Error('Injected worker construction failure');};
  assert.throws(()=>reader.close(),/Injected worker construction failure/);assert.equal(reader.closed,true);assert.equal(reader.coordination,null);assert.equal(reader.holder,null);assert.equal(reader.handle,null);
  assert.throws(()=>keeper.prepare('SELECT 1'),/closed|not open/);
  await assert.rejects(reader.whenMaintenanceIdle({timeoutMs:25}),/Injected worker construction failure/);
  reader.maintainIfNeeded=maintain;reader.close();await reader.whenMaintenanceIdle();
  const probe=require(protocolFile).lease(p.connections,true);assert(probe);probe.close();
  const reopened=participant(dir);try{assert.equal(value(reopened),1);}finally{reopened.close();await quiet(reopened);}
 }finally{reader.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('a pre-reconnect worker response cannot overwrite the new keeper epoch or lose pending cleanup',async()=>{
 const {dir}=setup();const reader=participant(dir);const Worker=wt.Worker;let fake;
 try{
  assert.equal(value(reader),1);
  const op=require(protocolFile).beginOperation(dir);fs.writeFileSync(op.record.candidate,'owned unfinished candidate');op.owner.close();
  class DelayedWorker extends require('node:events').EventEmitter {constructor(){super();fake=this;}ref(){return this;}unref(){return this;}}
  wt.Worker=DelayedWorker;reader.nextMaintenanceAt=0;reader.maintainIfNeeded();assert.equal(reader.maintenanceWorker,fake);const epoch=reader.coordinationEpoch;
  assert.throws(()=>reader.readSnapshot(()=>{throw Error('Injected keeper reset while worker is active');}),/keeper reset/);
  reader.readSnapshot(g=>g.prepare('SELECT mode FROM state').get());assert(reader.coordinationEpoch>epoch);
  fake.emit('message',{recovered:true,pending:false});fake.emit('exit',0);assert.equal(reader.lastMaintenanceVersion,undefined);assert.equal(reader.maintenancePending,true);
  wt.Worker=Worker;reader.nextMaintenanceAt=0;reader.maintainIfNeeded();await until(()=>!fs.existsSync(op.record.directory));await quiet(reader);assert.equal(value(reader),1);reader.close();await quiet(reader);
 }finally{wt.Worker=Worker;if(reader.maintenanceWorker===fake)fake.emit('exit',1);reader.close();await quiet(reader);fs.rmSync(dir,{recursive:true,force:true});}
});

test('closed participant maintenance wait has a finite timeout and resumes after genuine publisher exit',async()=>{
 const {dir,p}=setup();const reader=participant(dir);let c;
 try{
  assert.equal(value(reader),1);
  c=child(dir,`const op=p.beginOperation(dir);fs.writeFileSync(op.record.candidate,'owned unfinished candidate');process.send({directory:op.record.directory});setInterval(()=>{},1000);`);
  const[message]=await once(c,'message');reader.close();reader.close();
  await assert.rejects(reader.whenMaintenanceIdle({timeoutMs:60}),error=>error.code==='MAINTENANCE_TIMEOUT');assert(fs.existsSync(message.directory));
  const exited=once(c,'exit');c.kill('SIGKILL');await exited;
  await reader.whenMaintenanceIdle({timeoutMs:5000});assert(!fs.existsSync(message.directory));assert.equal(reader.maintenanceWorker,null);
  await require(protocolFile).whenMaintenanceIdle(dir,{timeoutMs:100});
  const check=new DatabaseSync(p.active,{readOnly:true});try{assert.equal(check.prepare('SELECT n FROM value').get().n,1);}finally{check.close();}
 }finally{c?.kill('SIGKILL');reader.close();await reader.whenMaintenanceIdle();fs.rmSync(dir,{recursive:true,force:true});}
});

test('SDK close remains synchronous and existing whenIdle waits final cleanup across multiple participants',async()=>{
 const dir=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'fixed-sdk-close-wait-'))),previous=process.env.CODEGRAPH_FIXED_PATH;
 process.env.CODEGRAPH_FIXED_PATH='1';let graph,other;
 try{
  const {CodeGraph}=require('../../dist');graph=CodeGraph.initSync(dir);other=CodeGraph.openSync(dir);
  const op=require(protocolFile).beginOperation(dir);fs.writeFileSync(op.record.candidate,'owned unfinished candidate');op.owner.close();
  assert.equal(graph.close(),undefined);assert.equal(other.close(),undefined);graph.close();other.close();
  await Promise.all([graph.whenIdle(),other.whenIdle()]);assert(!fs.existsSync(op.record.directory));
  await require(protocolFile).whenMaintenanceIdle(dir,{timeoutMs:0});
  const reopened=CodeGraph.openSync(dir);assert.equal(reopened.getFileCount(),0);reopened.close();await reopened.whenIdle();
 }finally{graph?.close();other?.close();await Promise.all([graph?.whenIdle(),other?.whenIdle()]);if(previous===undefined)delete process.env.CODEGRAPH_FIXED_PATH;else process.env.CODEGRAPH_FIXED_PATH=previous;fs.rmSync(dir,{recursive:true,force:true});}
});

test('close tail checkpoint failure is retained by the wait barrier and a repeated close can repair it',async()=>{
 const {dir}=setup();const reader=participant(dir),prepare=DatabaseSync.prototype.prepare;
 try{
  assert.equal(value(reader),1);
  DatabaseSync.prototype.prepare=function(sql){if(sql==='SELECT mode FROM state WHERE id=1')throw Error('Injected close-tail checkpoint failure');return prepare.call(this,sql);};
  assert.throws(()=>reader.close(),/close-tail checkpoint/);assert.equal(reader.closed,true);
  await assert.rejects(reader.whenMaintenanceIdle({timeoutMs:0}),/close-tail checkpoint/);
  await assert.rejects(require(protocolFile).whenMaintenanceIdle(dir,{timeoutMs:0}),/close-tail checkpoint/);
  DatabaseSync.prototype.prepare=prepare;reader.close();await reader.whenMaintenanceIdle();await require(protocolFile).whenMaintenanceIdle(dir,{timeoutMs:0});
 }finally{DatabaseSync.prototype.prepare=prepare;reader.close();await reader.whenMaintenanceIdle();fs.rmSync(dir,{recursive:true,force:true});}
});

test('close observes a newer publication than an in-flight worker and automatically completes a final pass',async()=>{
 const {dir}=setup();const reader=participant(dir);const Worker=wt.Worker;let fake;
 try{
  assert.equal(value(reader),1);reader.lastMaintenanceVersion=undefined;
  class DelayedWorker extends require('node:events').EventEmitter{constructor(){super();fake=this;}ref(){return this;}unref(){return this;}}
  wt.Worker=DelayedWorker;reader.nextMaintenanceAt=0;reader.maintainIfNeeded();assert.equal(reader.maintenanceWorker,fake);
  const op=require(protocolFile).beginOperation(dir);fs.writeFileSync(op.record.candidate,'owned unfinished candidate');op.owner.close();
  reader.close();wt.Worker=Worker;fake.emit('message',{recovered:true,pending:false});fake.emit('exit',0);
  assert(reader.maintenanceWorker,'stale completion must dispatch a final pass for the version close observed');
  await reader.whenMaintenanceIdle();assert(!fs.existsSync(op.record.directory));await require(protocolFile).whenMaintenanceIdle(dir,{timeoutMs:0});
 }finally{wt.Worker=Worker;if(reader.maintenanceWorker===fake)fake.emit('exit',1);reader.close();await reader.whenMaintenanceIdle();fs.rmSync(dir,{recursive:true,force:true});}
});
