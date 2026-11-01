const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn, spawnSync} = require('node:child_process');
const {once} = require('node:events');
const {DatabaseSync} = require('node:sqlite');
const {CodeGraph} = require('../../dist/index.js');
const {PORTABLE_INDEX_KEY, PORTABLE_IMPORT_KEY} = require('../../dist/sync/portable-index.js');
process.env.CODEGRAPH_ALL_LANGUAGES = '1';
process.env.CODEGRAPH_FIXED_PATH = '1';
process.execArgv = ['--liftoff-only'];
const root = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'portable-single-db-')));
const data = dir => path.join(dir,'.codegraph-wx');
const file = dir => path.join(data(dir),'codegraph.db');
const runtime = dir => path.join(data(dir),'.runtime');
function source(dir,name='before_symbol') { fs.writeFileSync(path.join(dir,'main.py'),`def ${name}():\n    return 1\n`); }
function meta(dir,key) { const db=new DatabaseSync(file(dir),{readOnly:true});try{return db.prepare('SELECT value FROM project_metadata WHERE key=?').get(key)?.value??null;}finally{db.close();} }
async function close(graph) { if(graph){await graph.whenIdle();graph.close();await graph.whenIdle();} }
async function init(dir,name) {source(dir,name);const graph=await CodeGraph.init(dir,{index:true});await close(graph);assert(!fs.existsSync(file(dir)+'-wal')||fs.statSync(file(dir)+'-wal').size===0);}
function copy(from,to) {fs.mkdirSync(data(to),{recursive:true});fs.copyFileSync(file(from),file(to));}
function found(graph,name) {assert(graph.searchNodes(name).some(r=>r.node.name===name),name);}
function changed(dir) {const f=path.join(dir,'main.py'),st=fs.statSync(f);source(dir,'after__symbol');fs.utimesSync(f,st.atime,st.mtime);assert.equal(fs.statSync(f).size,st.size);}
async function clean(...dirs) {for(const dir of dirs){await require('../../dist/sync/fixed-path/protocol.js').whenMaintenanceIdle(dir,{timeoutMs:5000});fs.rmSync(dir,{recursive:true,force:true});}}

for(const mode of ['copied DB only','runtime removed after close'])test(`${mode}: queries remain available, writes require offline registration, hash catchup converges`,{timeout:20000},async()=>{
 const original=root(),target=mode==='copied DB only'?root():original;let graph;
 try {await init(original);if(target!==original){source(target);copy(original,target);}else fs.rmSync(runtime(target),{recursive:true});
  changed(target);const before=fs.readFileSync(file(target));graph=CodeGraph.openSync(target);found(graph,'before_symbol');
  await assert.rejects(graph.sync(),/migrate-storage --offline/);assert.deepEqual(fs.readFileSync(file(target)),before);
  assert(fs.readdirSync(data(target)).every(n=>/^codegraph\.db(?:-wal|-shm)?$/.test(n)));await close(graph);graph=null;
  await CodeGraph.migrateStorage(target,{offline:true});assert(meta(target,PORTABLE_IMPORT_KEY));
  graph=CodeGraph.openSync(target);const result=await graph.sync({adaptive:false,paths:['unrelated.py']});assert.equal(result.complete,true);found(graph,'after__symbol');assert.equal(graph.searchNodes('before_symbol').length,0);assert.equal(meta(target,PORTABLE_IMPORT_KEY),null);
  assert.equal((await graph.sync()).filesModified,0);await close(graph);graph=null;
  graph=CodeGraph.openSync(target);found(graph,'after__symbol');assert.equal((await graph.sync()).filesModified,0);
 } finally {await close(graph);await clean(...new Set([original,target]));}
});

test('offline replacement in existing runtime invalidates identity and retains automatic rebuild after catchup',{timeout:25000},async()=>{
 const a=root(),b=root();let graph;
 try {await init(a,'target_symbol');await init(b);const old=meta(a,PORTABLE_INDEX_KEY);copy(b,a);source(a);changed(a);
 graph=CodeGraph.openSync(a);found(graph,'before_symbol');assert.notEqual(meta(a,PORTABLE_INDEX_KEY),old);assert(meta(a,PORTABLE_IMPORT_KEY));
 await graph.sync();found(graph,'after__symbol');assert.equal(meta(a,PORTABLE_IMPORT_KEY),null);
 for(let n=0;n<140;n++)fs.writeFileSync(path.join(a,`added_${n}.py`),`def added_${n}():\n    return ${n}\n`);
 const rebuilt=await graph.sync();assert.equal(rebuilt.adaptive?.strategy,'rebuild');assert.equal(graph.getFileCount(),141);found(graph,'after__symbol');
 } finally {await close(graph);await clean(a,b);}
});

test('same index identity with a different revision is reconciled instead of reusing local acknowledgement',{timeout:20000},async()=>{
 const a=root(),b=root();let graph;
 try {await init(a);copy(a,b);source(b);await CodeGraph.migrateStorage(b,{offline:true});graph=CodeGraph.openSync(b);await graph.sync();changed(b);await graph.sync();await close(graph);graph=null;
 const left=JSON.parse(meta(a,PORTABLE_INDEX_KEY)),right=JSON.parse(meta(b,PORTABLE_INDEX_KEY));assert.equal(left.id,right.id);assert.notEqual(left.revision,right.revision);
 copy(b,a);graph=CodeGraph.openSync(a);found(graph,'after__symbol');assert(meta(a,PORTABLE_IMPORT_KEY));await graph.sync();found(graph,'before_symbol');assert.equal(meta(a,PORTABLE_IMPORT_KEY),null);
 } finally {await close(graph);await clean(a,b);}
});

test('import with missing source refuses sync and preserves nodes and pending verification',{timeout:15000},async()=>{
 const a=root(),b=root();let graph;
 try {await init(a);copy(a,b);await CodeGraph.migrateStorage(b,{offline:true});const token=meta(b,PORTABLE_IMPORT_KEY);graph=CodeGraph.openSync(b);const count=graph.getStats().nodeCount;assert(count>0);
 await assert.rejects(graph.sync(),/no source files.*index retained/);found(graph,'before_symbol');assert.equal(graph.getStats().nodeCount,count);assert.equal(meta(b,PORTABLE_IMPORT_KEY),token);
 source(b);await graph.sync();found(graph,'before_symbol');assert.equal(meta(b,PORTABLE_IMPORT_KEY),null);
 } finally {await close(graph);await clean(a,b);}
});

test('existing cooperative reader blocks replacement adaptation until its process closes',{timeout:20000},async()=>{
 const a=root(),b=root();let child,graph;
 try {await init(a);await init(b);const code=`const {CodeGraph}=require(${JSON.stringify(path.resolve('dist/index.js'))});const g=CodeGraph.openSync(process.argv[1]);g.getStats();process.stdout.write('ready');process.stdin.once('data',async()=>{g.close();await g.whenIdle();process.exit(0)});`;
 child=spawn(process.execPath,['--liftoff-only','-e',code,a],{stdio:['pipe','pipe','pipe'],env:process.env});await once(child.stdout,'data');
 // Model an unsupported external overwrite while a reader is alive. Admission
 // must refuse adaptation, not claim that external raw file writes are safe.
 copy(b,a);assert.throws(()=>CodeGraph.openSync(a),/all managed connections/);
 const exited=once(child,'exit');child.stdin.write('close');assert.equal((await exited)[0],0);child=null;
 graph=CodeGraph.openSync(a);assert(meta(a,PORTABLE_IMPORT_KEY));await graph.sync();found(graph,'before_symbol');
 }finally{child?.kill();await close(graph);await clean(a,b);}
});

test('missing runtime sync CLI reports failure with a nonzero exit status',{timeout:15000},async()=>{
 const a=root();try{await init(a);fs.rmSync(runtime(a),{recursive:true});const result=spawnSync(process.execPath,['--liftoff-only',path.resolve('dist/bin/codegraph.js'),'sync',a],{encoding:'utf8',env:{...process.env,CODEGRAPH_NO_DAEMON:'1'}});assert.notEqual(result.status,0,result.stdout+result.stderr);assert.match(result.stdout+result.stderr,/migrate-storage --offline/);}finally{await clean(a);}
});

test('partial runtime loss never silently recreates portable coordination',{timeout:15000},async()=>{
 const a=root();try{await init(a);const gate=path.join(runtime(a),'fixed-path-v1','gate.sqlite');fs.rmSync(gate);assert.throws(()=>CodeGraph.openSync(a),/migrate-storage --offline/);assert(!fs.existsSync(gate));}finally{await clean(a);}
});

test('unknown replacement identity requires offline acknowledgement and preserves custom content',{timeout:20000},async()=>{
 const a=root(),b=root();let graph;
 try{await init(a);await init(b);const db=new DatabaseSync(file(b));db.prepare('DELETE FROM project_metadata WHERE key=?').run(PORTABLE_INDEX_KEY);db.exec("CREATE TABLE user_notes(note TEXT); INSERT INTO user_notes VALUES('keep me')");db.close();copy(b,a);
 assert.throws(()=>CodeGraph.openSync(a),/identity is missing.*migrate-storage --offline/);
 await CodeGraph.migrateStorage(a,{offline:true});graph=CodeGraph.openSync(a);await graph.sync();
 for(let n=0;n<140;n++)fs.writeFileSync(path.join(a,`new_${n}.py`),`def new_${n}():\n    return 1\n`);
 const result=await graph.sync();assert.notEqual(result.adaptive?.strategy,'rebuild');assert.equal(graph.getFileCount(),141);await close(graph);graph=null;
 const checked=new DatabaseSync(file(a),{readOnly:true});try{assert.equal(checked.prepare('SELECT note FROM user_notes').get().note,'keep me');}finally{checked.close();}
 }finally{await close(graph);await clean(a,b);}
});

test('invalid portable identity and corrupt replacement fail without resurrecting an old image',{timeout:15000},async()=>{
 const a=root(),b=root();try{await init(a);await init(b);const db=new DatabaseSync(file(b));db.prepare('UPDATE project_metadata SET value=? WHERE key=?').run('{"version":1,"id":"invalid"}',PORTABLE_INDEX_KEY);db.close();copy(b,a);const invalid=fs.readFileSync(file(a));assert.throws(()=>CodeGraph.openSync(a),/Invalid portable index identity/);assert.deepEqual(fs.readFileSync(file(a)),invalid);
 fs.writeFileSync(file(a),'not sqlite');assert.throws(()=>CodeGraph.openSync(a));assert.equal(fs.readFileSync(file(a),'utf8'),'not sqlite');
 }finally{await clean(a,b);}
});

test('replacement with an unresolved WAL is refused and its recovery bytes retained',{timeout:15000},async()=>{
 const a=root(),b=root();let db;
 try{await init(a);await init(b);db=new DatabaseSync(file(b));db.exec("PRAGMA journal_mode=WAL; INSERT INTO project_metadata VALUES('extra','retain',1)");copy(b,a);fs.copyFileSync(file(b)+'-wal',file(a)+'-wal');const wal=fs.readFileSync(file(a)+'-wal');assert(wal.length>0);
 assert.throws(()=>CodeGraph.openSync(a),/unresolved SQLite log/);assert.deepEqual(fs.readFileSync(file(a)+'-wal'),wal);
 }finally{db?.close();await clean(a,b);}
});

test('incomplete incoming index is rejected without changing its graph',{timeout:15000},async()=>{
 const a=root(),b=root();try{await init(a);await init(b);const db=new DatabaseSync(file(b));db.prepare("UPDATE project_metadata SET value='incomplete' WHERE key='index_completeness'").run();db.close();copy(b,a);const before=fs.readFileSync(file(a));assert.throws(()=>CodeGraph.openSync(a),/index is incomplete/);assert.deepEqual(fs.readFileSync(file(a)),before);}finally{await clean(a,b);}
});

test('process exit after import marker but before local binding preserves a recoverable obligation',{timeout:20000},async()=>{
 const a=root(),b=root();let graph;
 try{await init(a);await init(b);copy(b,a);changed(a);
 const code=`const p=require(${JSON.stringify(path.resolve('dist/sync/portable-index.js'))}),{DatabaseSync}=require('node:sqlite');const original=p.readPortableFile;p.readPortableFile=function(file){const result=original(file);const d=new DatabaseSync(file,{readOnly:true});const pending=d.prepare('SELECT value FROM project_metadata WHERE key=?').get(p.PORTABLE_IMPORT_KEY);d.close();if(pending)process.exit(73);return result};require(${JSON.stringify(path.resolve('dist/index.js'))}).CodeGraph.openSync(process.argv[1]);process.exit(2);`;
 const child=spawnSync(process.execPath,['--liftoff-only','-e',code,a],{encoding:'utf8',env:process.env});assert.equal(child.status,73,child.stderr);const token=meta(a,PORTABLE_IMPORT_KEY);assert(token);
 graph=CodeGraph.openSync(a);assert.equal(meta(a,PORTABLE_IMPORT_KEY),token);await graph.sync();found(graph,'after__symbol');assert.equal(meta(a,PORTABLE_IMPORT_KEY),null);
 }finally{await close(graph);await clean(a,b);}
});

test('pending publication travels with imported DB and is acknowledged only after full-hash catchup',{timeout:15000},async()=>{
 const a=root(),b=root();let graph;
 try{await init(a);await init(b);const {createDatabase}=require('../../dist/db/sqlite-adapter.js');const {beginSourceWrite,finishSourceWrite}=require('../../dist/sync/source-ownership.js');const {db}=createDatabase(file(b),{nativeOnly:true});const token=require('node:crypto').randomUUID();db.transaction(()=>{const owner=beginSourceWrite(db);db.prepare('INSERT INTO project_metadata VALUES(?,?,?)').run('fixed-path:source-catchup-v1',token,Date.now());assert(finishSourceWrite(db,owner,true));})();db.close();copy(b,a);changed(a);
 graph=CodeGraph.openSync(a);assert.equal(meta(a,PORTABLE_IMPORT_KEY),token);assert.equal(meta(a,'fixed-path:source-catchup-v1'),token);await graph.sync({adaptive:false});found(graph,'after__symbol');assert.equal(meta(a,PORTABLE_IMPORT_KEY),null);assert.equal(meta(a,'fixed-path:source-catchup-v1'),null);
 }finally{await close(graph);await clean(a,b);}
});

test('new reader during a real managed writer is admitted without misclassifying its revision',{timeout:15000},async()=>{
 const a=root();let child,graph;
 try{await init(a);const code=`const {CodeGraph}=require(${JSON.stringify(path.resolve('dist/index.js'))});const original=CodeGraph.prototype.indexAll;CodeGraph.prototype.indexAll=async function(...args){process.stdout.write('writer-ready');await new Promise(r=>process.stdin.once('data',r));return original.apply(this,args)};(async()=>{const g=CodeGraph.openSync(process.argv[1]);await g.indexAll();g.close();await g.whenIdle();process.exit(0)})();`;
 child=spawn(process.execPath,['--liftoff-only','-e',code,a],{env:process.env,stdio:['pipe','pipe','pipe']});await once(child.stdout,'data');graph=CodeGraph.openSync(a);found(graph,'before_symbol');assert.equal(meta(a,PORTABLE_IMPORT_KEY),null);await close(graph);graph=null;const exited=once(child,'exit');child.stdin.write('continue');assert.equal((await exited)[0],0);child=null;
 graph=CodeGraph.openSync(a);assert.equal(meta(a,PORTABLE_IMPORT_KEY),null);assert.equal((await graph.sync()).filesModified,0);
 }finally{child?.kill();await close(graph);await clean(a);}
});

test('runtime deleted while an older handle lives cannot grant a new mutable domain',{timeout:15000},async()=>{
 const a=root();let child,graph;
 try{await init(a);const code=`const {CodeGraph}=require(${JSON.stringify(path.resolve('dist/index.js'))});const g=CodeGraph.openSync(process.argv[1]);g.getStats();process.stdout.write('ready');process.stdin.once('data',async()=>{try{g.close();await g.whenIdle()}catch(e){console.error(e.message)}process.exit(0)});`;
 child=spawn(process.execPath,['--liftoff-only','-e',code,a],{env:process.env,stdio:['pipe','pipe','pipe']});await once(child.stdout,'data');
 try{fs.rmSync(runtime(a),{recursive:true});}catch(error){
   // Windows can enforce a stronger boundary by refusing to unlink open leases.
   if(process.platform!=='win32'||!['EPERM','EACCES','EBUSY'].includes(error.code))throw error;
   const exited=once(child,'exit');child.stdin.write('close');await exited;child=null;return;
 }
 graph=CodeGraph.openSync(a);found(graph,'before_symbol');await assert.rejects(graph.sync(),/migrate-storage --offline/);await close(graph);graph=null;
 const exited=once(child,'exit');child.stdin.write('close');assert.equal((await exited)[0],0);child=null;
 await CodeGraph.migrateStorage(a,{offline:true});graph=CodeGraph.openSync(a);await graph.sync();found(graph,'before_symbol');
 }finally{child?.kill();await close(graph);await clean(a);}
});

for(const mode of ['read','import-write'])test(`uncertain native ${mode} close retains OS admission until process exit`,{timeout:15000},async()=>{
 const a=root(),b=root();let child,graph;
 try{await init(a);if(mode==='import-write'){await init(b);copy(b,a);}
 const code=`const sqlite=require('node:sqlite'),active=process.argv[1],original=sqlite.DatabaseSync.prototype.close;let injected=false;sqlite.DatabaseSync.prototype.close=function(){const file=this.prepare('PRAGMA database_list').all().find(r=>r.name==='main')?.file;if(!injected&&file===active&&(${JSON.stringify(mode)}==='read'||this.prepare('SELECT value FROM project_metadata WHERE key=?').get('portable:import-pending-v1'))){injected=true;throw Error('injected native close failure')}return original.call(this)};try{require(${JSON.stringify(path.resolve('dist/index.js'))}).CodeGraph.openSync(process.argv[2]);process.exit(2)}catch(e){if(!injected||!/native close is uncertain/.test(e.message))throw e;process.stdout.write('retained')}process.stdin.once('data',()=>process.exit(0));`;
 child=spawn(process.execPath,['--liftoff-only','-e',code,file(a),a],{env:process.env,stdio:['pipe','pipe','pipe']});await once(child.stdout,'data');const protocol=require('../../dist/sync/fixed-path/protocol.js');assert.equal(protocol.lease(protocol.paths(a).connections,true),null);
 const exited=once(child,'exit');child.stdin.write('exit');assert.equal((await exited)[0],0);child=null;const available=protocol.lease(protocol.paths(a).connections,true);assert(available);available.close();
 if(mode==='import-write') {
   assert.throws(()=>CodeGraph.openSync(a),/unresolved SQLite log/);
   assert(meta(a,PORTABLE_IMPORT_KEY),'the committed obligation survived the uncertain close');
   // The fixture knows these sidecars belong to this exact image. Explicitly
   // recover that bundle offline; production must not guess this provenance.
   const recovered=new DatabaseSync(file(a));try{assert.equal(recovered.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy,0);}finally{recovered.close();}
 }
 graph=CodeGraph.openSync(a);await graph.sync();found(graph,'before_symbol');
 }finally{child?.kill();await close(graph);await clean(a,b);}
});

for(const target of ['database','sidecar'])test(`portable ${target} symlink is rejected before SQLite touches its target`,{timeout:15000},async()=>{
 const a=root(),b=root();try{await init(a);await init(b);const before=fs.readFileSync(file(b));const link=target==='database'?file(a):file(a)+'-wal';if(target==='database')fs.unlinkSync(link);fs.symlinkSync(file(b),link,'file');assert.throws(()=>CodeGraph.openSync(a),/regular file.*symlink/);assert.deepEqual(fs.readFileSync(file(b)),before);}finally{await clean(a,b);}
});
