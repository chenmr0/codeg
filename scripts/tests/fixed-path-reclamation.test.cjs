// Real process/worker ownership and idle reclamation. No test-side cleanup is
// permitted before the assertions and directory evidence have been recorded.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {DatabaseSync}=require('node:sqlite');
const protocolPath=path.resolve(__dirname,'../../dist/sync/fixed-path/protocol.js');
const {Participant,initialize,paths,records,gate,recover}=require(protocolPath);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function make(file,value){const d=new DatabaseSync(file);try{d.exec('CREATE TABLE value(n INTEGER)');d.prepare('INSERT INTO value VALUES(?)').run(value);}finally{d.close();}}
function reader(dir){return new Participant(dir,file=>new DatabaseSync(file,{readOnly:true}));}
function value(p){return p.requestSync(d=>d.prepare('SELECT n FROM value').get().n);}
function snapshot(dir,label){const p=paths(dir),files=[];function walk(root){for(const n of fs.readdirSync(root).sort()){const f=path.join(root,n),s=fs.lstatSync(f);files.push({path:path.relative(p.data,f).replaceAll('\\','/'),bytes:s.size,directory:s.isDirectory()});if(s.isDirectory())walk(f);}}walk(p.data);console.log('DIRECTORY_SNAPSHOT '+JSON.stringify({label,root:fs.readdirSync(p.data).sort(),files}));assert.deepEqual(fs.readdirSync(p.data).sort(),['.runtime','codegraph.db']);return files;}
async function until(action){const end=Date.now()+5000;while(!action()){assert(Date.now()<end,'automatic reclamation exceeded 5000ms');await pause(20);}}
function child(dir,body){const c=spawn(process.execPath,['-e',`const fs=require('node:fs');const {DatabaseSync}=require('node:sqlite');const p=require(${JSON.stringify(protocolPath)});const dir=process.argv[1];${body}`,dir],{stdio:['ignore','pipe','pipe','ipc']});let stderr='';c.stderr.on('data',b=>stderr+=b);c.failureOutput=()=>stderr;return c;}
function setup(){const dir=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'fixed-reclamation-')));const p=initialize(dir);make(p.active,1);return {dir,p};}

test('live child and native worker prevent reclamation; idle participant collects after actual exit without a query',async()=>{
 const {dir,p}=setup();let participant=reader(dir),c;
 try{
  assert.equal(value(participant),1);
  c=child(dir,`const {Worker}=require('node:worker_threads');const op=p.beginOperation(dir);const worker=new Worker(\`const {parentPort,workerData}=require('node:worker_threads');const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(workerData);d.exec('CREATE TABLE unfinished(n);INSERT INTO unfinished VALUES(2)');parentPort.postMessage('ready');setInterval(()=>{},1000);\`,{eval:true,workerData:op.record.candidate});worker.on('message',()=>process.send({directory:op.record.directory}));setInterval(()=>{},1000);`);
  const [message]=await once(c,'message');snapshot(dir,'builder-and-worker-live');
  await pause(600);assert(fs.existsSync(message.directory),'live worker candidate must not be collected');assert.equal(records(p)[0].phase,'building');
  const exited=once(c,'exit');c.kill('SIGKILL');await exited;
  await until(()=>!fs.existsSync(message.directory));snapshot(dir,'worker-exited-idle-reclaimed');assert.equal(value(participant),1);
  participant.close();participant=null;snapshot(dir,'closed');participant=reader(dir);assert.equal(value(participant),1);snapshot(dir,'reopened');
 }finally{c?.kill('SIGKILL');participant?.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('cleanup error is durable and automatically retried; three publications do not accumulate task databases',async()=>{
 const {dir,p}=setup();let participant=reader(dir);
 try{
  for(let round=2;round<=4;round++){
   const c=child(dir,`(async()=>{const op=p.beginOperation(dir);const d=new DatabaseSync(op.record.candidate);d.exec('CREATE TABLE value(n INTEGER); INSERT INTO value VALUES(${round})');d.close();const result=await p.publish(op,{fail:'cleanup'});process.send({result,records:p.records(op.p)});process.disconnect();})().catch(e=>{console.error(e);process.exit(1)});`);
   const exited=once(c,'exit');const [message]=await once(c,'message');
   assert.equal(message.result.status,'published',JSON.stringify(message));assert.match(message.result.cleanupError,/sharing/);assert.match(message.records.at(-1).cleanupDiagnostic.error,/sharing/);
   const [code]=await exited;assert.equal(code,0,c.failureOutput());
   await until(()=>records(p).every(r=>r.phase==='cleaned'&&!r.cleanupDiagnostic&&!fs.existsSync(r.directory)));
   const files=snapshot(dir,`round-${round}-idle-reclaimed`);assert.equal(files.filter(f=>/\/(candidate|old)\.db$/.test(f.path)).length,0);assert.equal(value(participant),round);
   participant.close();snapshot(dir,`round-${round}-closed`);participant=reader(dir);assert.equal(value(participant),round);snapshot(dir,`round-${round}-reopened`);
  }
 }finally{participant.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('an in-flight reader finishes on its original image before publication and idle collection',async()=>{
 const {dir,p}=setup();let participant=reader(dir),release,c;
 try{
  const held=new Promise(resolve=>release=resolve);
  const request=participant.request(async d=>{await held;return d.prepare('SELECT n FROM value').get().n;});
  c=child(dir,`(async()=>{const op=p.beginOperation(dir);const d=new DatabaseSync(op.record.candidate);d.exec('CREATE TABLE value(n);INSERT INTO value VALUES(2)');d.close();const result=await p.publish(op,{drainBudgetMs:3000,hook(phase){if(phase==='draining')process.send({phase});}});if(result.status!=='published')throw new Error(JSON.stringify(result));process.disconnect();})().catch(e=>{console.error(e);process.exit(1)});`);
  const exited=once(c,'exit');await once(c,'message');snapshot(dir,'reader-in-flight-draining');
  assert.equal(records(p).at(-1).phase,'draining');release();assert.equal(await request,1);
  const [code]=await exited;assert.equal(code,0,c.failureOutput());await until(()=>records(p).every(r=>r.phase==='cleaned'&&!fs.existsSync(r.directory)));
  snapshot(dir,'reader-released-idle-collected');assert.equal(value(participant),2);
 }finally{release?.();c?.kill('SIGKILL');participant.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('offline public replacement preserves runtime but never revives retired content or costs',async()=>{
 const {dir,p}=setup();let participant=reader(dir);
 try{
  assert.equal(value(participant),1);participant.close();participant=null;
  // Leave a committed retired database behind, then replace only the public
  // file. Recovery must collect the retired image, never restore it over 77.
  const publisher=child(dir,`(async()=>{const op=p.beginOperation(dir);const d=new DatabaseSync(op.record.candidate);d.exec('CREATE TABLE value(n); INSERT INTO value VALUES(2)');d.close();await p.publish(op,{fail:'cleanup'});process.disconnect();})().catch(e=>{console.error(e);process.exit(1)});`);
  const [publisherCode]=await once(publisher,'exit');assert.equal(publisherCode,0,publisher.failureOutput());
  assert(records(p).some(r=>r.phase==='committed'&&fs.existsSync(r.backup)));
  gate(p,g=>g.prepare('INSERT INTO costs VALUES(?,?)').run('old-library','{"confirmed":true}'));
  // In-place overwrite, not inode replacement, reproduces the supported copy workflow.
  const external=path.join(dir,'public.db');make(external,77);fs.copyFileSync(external,p.active);
  participant=reader(dir);assert.equal(value(participant),77);assert.equal(gate(p,g=>g.prepare('SELECT count(*) n FROM costs').get().n),0);snapshot(dir,'public-overwrite-runtime-preserved');
  participant.close();participant=null;recover(dir);participant=reader(dir);assert.equal(value(participant),77);snapshot(dir,'public-recovered');
  participant.close();participant=null;fs.writeFileSync(p.active,'not a database');participant=reader(dir);assert.throws(()=>value(participant),/database/);participant.close();participant=null;
  fs.unlinkSync(p.active);participant=reader(dir);assert.throws(()=>value(participant),/ENOENT/);assert(!fs.existsSync(p.active),'missing public image must not be created or resurrected');
 }finally{participant?.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('initialization sharing failure records diagnostics and retries without reopening or queries',async()=>{
 const dir=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'fixed-init-retry-'))),data=path.join(dir,'.codegraph-wx');
 const {initializeFixedPathStorage}=require('../../dist/sync/fixed-path-initialization.js');
 const original=fs.unlinkSync;let injected=false;
 try{
  fs.unlinkSync=function(file){if(!injected&&String(file).includes('fixed-initialization')&&path.basename(String(file))==='owner.json'){injected=true;throw Object.assign(new Error('Injected Windows sharing violation'),{code:'EBUSY'});}return original.apply(this,arguments);};
  initializeFixedPathStorage(data,file=>make(file,99));fs.unlinkSync=original;assert(injected);
  const home=path.join(data,'.runtime','fixed-initialization'),intent=path.join(home,'intent.json'),diagnostic=path.join(home,'cleanup-diagnostic.json');
  assert(fs.existsSync(intent));assert.match(JSON.parse(fs.readFileSync(diagnostic,'utf8')).error,/sharing violation/);snapshot(dir,'initialization-cleanup-deferred');
  await until(()=>!fs.existsSync(intent)&&!fs.existsSync(diagnostic));snapshot(dir,'initialization-idle-reclaimed');
  assert.equal(fs.readdirSync(home).filter(n=>/^[a-f0-9-]{36}$/.test(n)).length,0);
  const d=new DatabaseSync(path.join(data,'codegraph.db'),{readOnly:true});try{assert.equal(d.prepare('SELECT n FROM value').get().n,99);}finally{d.close();}
 }finally{fs.unlinkSync=original;fs.rmSync(dir,{recursive:true,force:true});}
});

for(const phase of ['allocation-recorded','allocation-directory-created','allocation-marker-opened','allocation-marker-created','allocation-building']) {
 test(`durable task allocation recovers actual process kill at ${phase}`,async()=>{
  const {dir,p}=setup();let c,participant;
  try{
   c=child(dir,`p.beginOperation(dir,{hook(phase,record){if(phase===${JSON.stringify(phase)}){process.send({directory:record.directory});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}}});`);
   const [message]=await Promise.race([once(c,'message'),once(c,'exit').then(()=>{throw new Error(c.failureOutput());})]);snapshot(dir,`${phase}-live`);
   const exit=once(c,'exit');c.kill('SIGKILL');await exit;
   recover(dir);assert(!fs.existsSync(message.directory));assert(records(p).every(r=>r.phase==='cleaned'));
   snapshot(dir,`${phase}-recovered`);participant=reader(dir);assert.equal(value(participant),1);
  }finally{c?.kill('SIGKILL');participant?.close();fs.rmSync(dir,{recursive:true,force:true});}
 });
}

const bootstrapCrashes=[{phase:'bootstrap-intent'},{phase:'bootstrap-installed'},
 ...['connections.sqlite','publisher.sqlite','writers.sqlite','mutations.sqlite'].flatMap(file=>
  ['bootstrap-lease-open','bootstrap-lease-transaction','bootstrap-lease-closed'].map(phase=>({phase,file})))];
for(const point of bootstrapCrashes) {
 test(`bootstrap durable intent recovers kill at ${point.phase}/${point.file??'-'}`,async()=>{
  const dir=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'fixed-bootstrap-crash-'))),data=path.join(dir,'.codegraph-wx');fs.mkdirSync(data);make(path.join(data,'codegraph.db'),1);
  let c,participant;
  try{
   c=child(dir,`p.initialize(dir,{hook(phase,info){if(phase===${JSON.stringify(point.phase)}&&(!${JSON.stringify(point.file??null)}||require('node:path').basename(info.file??'')===${JSON.stringify(point.file??null)})){process.send({phase});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}}});`);
   await Promise.race([once(c,'message'),once(c,'exit').then(()=>{throw new Error(c.failureOutput());})]);snapshot(dir,`${point.phase}-${point.file??'state'}-live`);
   const exit=once(c,'exit');c.kill('SIGKILL');await exit;
   recover(dir);participant=reader(dir);assert.equal(value(participant),1);participant.close();participant=null;
   const files=snapshot(dir,`${point.phase}-${point.file??'state'}-recovered`);
   assert.equal(files.filter(f=>f.directory&&/bootstrap-/.test(f.path)).length,0);
   const p=paths(dir);assert.equal(gate(p,g=>g.prepare('SELECT phase FROM bootstrap_intent WHERE id=1').get().phase),'completed');
  }finally{c?.kill('SIGKILL');participant?.close();fs.rmSync(dir,{recursive:true,force:true});}
 });
}

test('incomplete allocation and legacy bootstrap unknown files are retained with diagnostics',async()=>{
 const {dir,p}=setup();let c;
 try{
  c=child(dir,`p.beginOperation(dir,{hook(phase,record){if(phase==='allocation-directory-created'){fs.writeFileSync(require('node:path').join(record.directory,'foreign.db'),'user-custom-data');process.send({directory:record.directory});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}}});`);
  const [message]=await once(c,'message');const exit=once(c,'exit');c.kill('SIGKILL');await exit;
  const maintenance={};recover(dir,{maintenance});assert.equal(fs.readFileSync(path.join(message.directory,'foreign.db'),'utf8'),'user-custom-data');
  assert.match(maintenance.cleanupDeferred[0].error,/Unknown incomplete allocation/);assert(records(p)[0].cleanupDiagnostic);
  const legacy=path.join(p.runtime,'bootstrap-legacy-unrecorded');fs.mkdirSync(legacy);fs.writeFileSync(path.join(legacy,'unknown.sqlite'),'unknown-old-owner');
  initialize(dir);assert.equal(fs.readFileSync(path.join(legacy,'unknown.sqlite'),'utf8'),'unknown-old-owner');
  const diagnostic=JSON.parse(fs.readFileSync(path.join(p.runtime,'bootstrap-diagnostic.json'),'utf8'));assert(diagnostic.artifacts.includes(path.basename(legacy)));snapshot(dir,'unknown-artifacts-preserved-diagnosed');
 }finally{c?.kill('SIGKILL');fs.rmSync(dir,{recursive:true,force:true});}
});

test('unrecorded partial old bootstrap fails closed and established old schema remains compatible',async()=>{
 const dir=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'fixed-bootstrap-old-'))),data=path.join(dir,'.codegraph-wx');fs.mkdirSync(data);make(path.join(data,'codegraph.db'),1);
 let c,participant;
 try{
  c=child(dir,`p.initialize(dir,{hook(phase,info){if(phase==='bootstrap-lease-closed'){process.send({file:info.file});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}}});`);
  const [message]=await once(c,'message');const exit=once(c,'exit');c.kill('SIGKILL');await exit;
  const p=paths(dir),d=new DatabaseSync(p.gate);d.exec('DROP TABLE bootstrap_intent');d.close();
  const before=fs.readFileSync(message.file);assert.throws(()=>initialize(dir),/Missing coordination state with existing leases/);assert.deepEqual(fs.readFileSync(message.file),before);snapshot(dir,'legacy-unrecorded-partial-preserved');
 }finally{c?.kill('SIGKILL');participant?.close();fs.rmSync(dir,{recursive:true,force:true});}
 const established=setup();
 try{
  const d=new DatabaseSync(established.p.gate);d.exec('DROP TABLE bootstrap_intent');d.close();fs.unlinkSync(path.join(established.p.runtime,'bootstrap-owner.sqlite'));
  participant=reader(established.dir);assert.equal(value(participant),1);assert(!fs.existsSync(path.join(established.p.runtime,'bootstrap-owner.sqlite')));participant.close();participant=null;snapshot(established.dir,'old-established-state-compatible');
 }finally{participant?.close();fs.rmSync(established.dir,{recursive:true,force:true});}
});

for(const file of ['connections.sqlite','publisher.sqlite','writers.sqlite','mutations.sqlite'])for(const statement of ['CREATE','INSERT','COMMIT']) {
 test(`bootstrap ${file} ${statement} IOERR retains intent and recovers without task debris`,()=>{
  const dir=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'fixed-bootstrap-ioerr-'))),data=path.join(dir,'.codegraph-wx');fs.mkdirSync(data);make(path.join(data,'codegraph.db'),1);
  const exec=DatabaseSync.prototype.exec;let injected=false;
  try{
   DatabaseSync.prototype.exec=function(sql){
    if(!injected&&path.basename(this.prepare('PRAGMA database_list').get().file)===file){
     for(const part of sql.split(';').map(s=>s.trim()).filter(Boolean)){
      if(part.startsWith(statement)){injected=true;throw Object.assign(new Error(`Injected ${statement} IOERR`),{errcode:10});}
      exec.call(this,part);
     }return;
    }return exec.call(this,sql);
   };
   assert.throws(()=>initialize(dir),/Injected/);DatabaseSync.prototype.exec=exec;assert(injected);
   const p=paths(dir);assert.equal(gate(p,g=>g.prepare("SELECT name FROM sqlite_master WHERE name='state'").get()),undefined);
   assert.equal(gate(p,g=>g.prepare('SELECT phase FROM bootstrap_intent').get().phase),'preparing');
   initialize(dir);assert.equal(gate(p,g=>g.prepare('SELECT mode FROM state').get().mode),'idle');snapshot(dir,`${file}-${statement}-IOERR-recovered`);
  }finally{DatabaseSync.prototype.exec=exec;fs.rmSync(dir,{recursive:true,force:true});}
 });
}

test('uncertain bootstrap native close retains OS ownership until actual process exit',async()=>{
 const dir=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'fixed-bootstrap-close-'))),data=path.join(dir,'.codegraph-wx');fs.mkdirSync(data);make(path.join(data,'codegraph.db'),1);
 let c;
 try{
  c=child(dir,`const close=DatabaseSync.prototype.close;let failed=false;DatabaseSync.prototype.close=function(){if(!failed&&require('node:path').basename(this.prepare('PRAGMA database_list').get().file)==='connections.sqlite'){failed=true;throw new Error('Injected uncertain native close');}return close.call(this);};try{p.initialize(dir);}catch(error){process.send({error:error.message});setInterval(()=>{},1000);}`);
  const [message]=await once(c,'message');assert.match(message.error,/uncertain native close/);
  const started=Date.now();assert.throws(()=>initialize(dir),error=>(error.errcode&255)===5);assert(Date.now()-started<1000);
  snapshot(dir,'bootstrap-uncertain-close-live-retained');const exit=once(c,'exit');c.kill('SIGKILL');await exit;
  recover(dir);const participant=reader(dir);try{assert.equal(value(participant),1);}finally{participant.close();}snapshot(dir,'bootstrap-uncertain-close-exited-recovered');
 }finally{c?.kill('SIGKILL');fs.rmSync(dir,{recursive:true,force:true});}
});
