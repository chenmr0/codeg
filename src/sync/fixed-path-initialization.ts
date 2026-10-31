/** Fresh fixed storage is built privately. A durable intent fences known-version
 * legacy opens BEFORE root appears. Old binaries/external SQLite users remain
 * outside this cooperative protocol; callers must keep them offline. */
import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { canonicalFixedPathDataDirectory, inspectFixedPathLayout, migrateToFixedPath, recoverFixedPathMigration } from './fixed-path-layout';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
interface Intent { version:1; id:string; root:string; writerToken:string; phase:'allocating'|'building'|'sealed'|'installed'|'committed'|'cleaning'; identity:string|null; outcome:'committed'|'aborted'|null; }
export interface FixedPathInitializationOptions {
  hook?:(phase:string)=>void;
  /** Optional exceptional-path proof from the constructor/close owner. Never
   * return true merely because a Promise settled or close() was attempted. */
  builderClosedOnError?:()=>boolean;
}
type Options=FixedPathInitializationOptions;
function exists(file:string):boolean { try{fs.lstatSync(file);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;} }
function regular(file:string):void { if(!fs.lstatSync(file).isFile())throw new Error(`Unsafe initialization file: ${file}`); }
function directory(file:string):void { if(!fs.lstatSync(file).isDirectory())throw new Error(`Unsafe initialization directory: ${file}`); }
function paths(dataDir:string) {
  const root=canonicalFixedPathDataDirectory(dataDir),runtime=path.join(root,'.runtime'),home=path.join(runtime,'fixed-initialization');
  return {root,runtime,home,intent:path.join(home,'intent.json'),lock:path.join(home,'owner.sqlite'),active:path.join(root,'codegraph.db'),writer:exists(path.join(root,'codegraph.lock'))?path.join(root,'codegraph.lock'):path.join(runtime,'initialization-writer.lock')};
}
function checkDirectories(p:ReturnType<typeof paths>,create=false):void {
  directory(p.root);
  for(const dir of [p.runtime,p.home]){if(create&&!exists(dir))fs.mkdirSync(dir);if(exists(dir))directory(dir);}
}
function flush(file:string):void {const fd=fs.openSync(file,'r+');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function flushDirectory(dir:string):void {if(process.platform==='win32')return;const fd=fs.openSync(dir,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function hash(file:string):string {regular(file);const h=createHash('sha256'),fd=fs.openSync(file,'r'),buffer=Buffer.allocUnsafe(1024*1024);try{let n;while((n=fs.readSync(fd,buffer,0,buffer.length,null)))h.update(buffer.subarray(0,n));}finally{fs.closeSync(fd);}return h.digest('hex');}
function noLogs(file:string):void {for(const suffix of ['-wal','-shm','-journal'])if(exists(file+suffix))throw new Error(`Unresolved initialization SQLite log: ${file+suffix}`);}
function operation(p:ReturnType<typeof paths>,r:Intent){const dir=path.join(p.home,r.id);return{dir,candidate:path.join(dir,'candidate.db'),owner:path.join(dir,'owner.json'),next:path.join(dir,'intent.next')};}
function read(p:ReturnType<typeof paths>):Intent|null {
  if(!exists(p.intent))return readAllocation(p);regular(p.intent);if(fs.statSync(p.intent).size>8192)throw new Error('Initialization intent too large');
  const r=JSON.parse(fs.readFileSync(p.intent,'utf8')) as Intent;
  if(!r||r.version!==1||!UUID.test(r.id)||!UUID.test(r.writerToken)||r.root!==p.root||!['allocating','building','sealed','installed','committed','cleaning'].includes(r.phase)||![null,'committed','aborted'].includes(r.outcome)||
     (r.identity!==null&&!/^[a-f0-9]{64}$/.test(r.identity))||(['allocating','building'].includes(r.phase)&&(r.identity!==null||r.outcome!==null))||(['sealed','installed'].includes(r.phase)&&(r.identity===null||r.outcome!==null))||(r.phase==='committed'&&(r.identity===null||r.outcome!=='committed'))||(r.phase==='cleaning'&&r.outcome===null)||
     Object.keys(r).some(k=>!['version','id','root','writerToken','phase','identity','outcome'].includes(k)))throw new Error('Invalid initialization intent');
  return r;
}
/** Allocation authority is committed before any per-operation filesystem entry.
 * The pending file is only a fast-path hint; SQLite is the durable authority. */
function allocationDb(p:ReturnType<typeof paths>):any {
  const file=path.join(p.home,'allocation.sqlite');
  for(const suffix of ['','-journal','-wal','-shm'])if(exists(file+suffix))regular(file+suffix);
  const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(file);
  try{db.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=FULL');if(db.prepare('PRAGMA journal_mode').get().journal_mode!=='delete')throw new Error('Allocation journal must use DELETE mode');db.exec('CREATE TABLE IF NOT EXISTS allocation(id INTEGER PRIMARY KEY CHECK(id=1),record TEXT NOT NULL)');return db;}
  catch(error){db.close();throw error;}
}
function readAllocation(p:ReturnType<typeof paths>):Intent|null {
  const flag=path.join(p.home,'allocation.pending');if(!exists(flag))return null;
  regular(flag);if(fs.statSync(flag).size!==0)throw new Error('Unknown initialization allocation marker');
  if(!exists(path.join(p.home,'allocation.sqlite')))return null;
  const db=allocationDb(p);let value:string|undefined;
  try{value=db.prepare('SELECT record FROM allocation WHERE id=1').get()?.record;}finally{db.close();}
  if(!value)return null;
  const r=JSON.parse(value) as Intent;
  if(r.version!==1||!UUID.test(r.id)||!UUID.test(r.writerToken)||r.root!==p.root||r.phase!=='allocating'||r.identity!==null||r.outcome!==null||Object.keys(r).some(k=>!['version','id','root','writerToken','phase','identity','outcome'].includes(k)))throw new Error('Invalid initialization allocation authority');
  return r;
}
function recordAllocation(p:ReturnType<typeof paths>,r:Intent):void {
  const flag=path.join(p.home,'allocation.pending');
  if(!exists(flag)){fs.writeFileSync(flag,'',{flag:'wx',mode:0o600});flush(flag);flushDirectory(p.home);}
  const db=allocationDb(p);try{db.prepare('INSERT INTO allocation VALUES(1,?)').run(JSON.stringify(r));}finally{db.close();}
}
function clearAllocation(p:ReturnType<typeof paths>,r:Intent):void {
  const allocation=readAllocation(p);if(allocation&&allocation.id!==r.id)throw new Error('Conflicting initialization allocation authority');
  if(allocation){const db=allocationDb(p);try{db.exec('DELETE FROM allocation WHERE id=1');}finally{db.close();}}
  const flag=path.join(p.home,'allocation.pending');if(exists(flag)){regular(flag);fs.unlinkSync(flag);flushDirectory(p.home);}
}
function abortAllocation(p:ReturnType<typeof paths>,r:Intent):void {
  if(exists(p.active)||exists(path.join(p.root,'CURRENT'))||exists(path.join(p.runtime,'layout.json')))throw new Error('Unexpected active storage during allocation; evidence retained');
  noLogs(p.active);const o=operation(p,r);
  if(exists(o.dir)){
    directory(o.dir);
    const expectedOwner=JSON.stringify({version:1,operation:r.id});
    const expectedIntent=JSON.stringify({...r,phase:'building'});
    for(const name of fs.readdirSync(o.dir)){
      if(!['owner.json','intent.next'].includes(name))throw new Error('Unknown allocation artifact retained');
      const file=path.join(o.dir,name);regular(file);const expected=name==='owner.json'?expectedOwner:expectedIntent;
      if(fs.statSync(file).size>Buffer.byteLength(expected)||!expected.startsWith(fs.readFileSync(file,'utf8')))throw new Error('Unknown allocation metadata retained');
    }
    for(const name of fs.readdirSync(o.dir))fs.unlinkSync(path.join(o.dir,name));
    fs.rmdirSync(o.dir);flushDirectory(p.home);
  }
  clearAllocation(p,r);
}
function owned(p:ReturnType<typeof paths>,r:Intent):ReturnType<typeof operation>{
  const o=operation(p,r);directory(o.dir);regular(o.owner);
  if(fs.statSync(o.owner).size>4096||fs.readFileSync(o.owner,'utf8')!==JSON.stringify({version:1,operation:r.id}))throw new Error('Initialization ownership mismatch');
  return o;
}
function save(p:ReturnType<typeof paths>,r:Intent):void {
  const o=owned(p,r);
  // A staged next record is operation-owned evidence; a crash before rename
  // leaves the old authoritative intent intact. Never overwrite unknown bytes.
  if(exists(o.next)){regular(o.next);const next=JSON.parse(fs.readFileSync(o.next,'utf8'));if(next.id!==r.id||next.root!==p.root)throw new Error('Unknown staged initialization intent');fs.unlinkSync(o.next);}
  fs.writeFileSync(o.next,JSON.stringify(r),{flag:'wx',mode:0o600});flush(o.next);fs.renameSync(o.next,p.intent);flushDirectory(p.home);
}
function owner(p:ReturnType<typeof paths>):{close():void}{
  checkDirectories(p,true);for(const suffix of ['','-journal','-wal','-shm'])if(exists(p.lock+suffix))regular(p.lock+suffix);
  const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(p.lock);
  try{db.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=FULL');if(Object.values(db.prepare('PRAGMA journal_mode').get())[0]!=='delete')throw new Error('Initialization owner must use DELETE journal mode');db.exec('CREATE TABLE IF NOT EXISTS owner(value INTEGER); BEGIN EXCLUSIVE');return{close:()=>db.close()};}
  catch(error){db.close();throw error;}
}
function releaseWriter(p:ReturnType<typeof paths>,r:Intent):void {
  if(!exists(p.writer))return;regular(p.writer);
  if(fs.readFileSync(p.writer,'utf8')!==r.writerToken)throw new Error('Foreign writer blocks fixed initialization');
  fs.unlinkSync(p.writer);
}
function seal(file:string,onUnclosed:()=>void):string {
  regular(file);noLogs(file);const fd=fs.openSync(file,'r'),header=Buffer.alloc(16);try{if(fs.readSync(fd,header,0,16,0)!==16||header.toString('binary')!=='SQLite format 3\0')throw new Error('Invalid initialized SQLite snapshot');}finally{fs.closeSync(fd);}
  const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(file);
  try{db.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=FULL');if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw new Error('Initialized snapshot validation failed');if(db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy!==0)throw new Error('Initialization checkpoint blocked');if(Object.values(db.prepare('PRAGMA journal_mode=DELETE').get())[0]!=='delete')throw new Error('Initialization snapshot not standalone');}finally{try{db.close();}catch(error){onUnclosed();throw error;}}
  noLogs(file);flush(file);return hash(file);
}
const cleanupRetries=new Map<string,NodeJS.Timeout>();
function stopCleanupRetry(p:ReturnType<typeof paths>):void {
  const timer=cleanupRetries.get(p.root);if(timer)clearInterval(timer);cleanupRetries.delete(p.root);
  const diagnostic=path.join(p.home,'cleanup-diagnostic.json');
  if(exists(diagnostic)){regular(diagnostic);fs.unlinkSync(diagnostic);}
}
function recordCleanupFailure(p:ReturnType<typeof paths>,error:unknown):void {
  const file=path.join(p.home,'cleanup-diagnostic.json');
  try {
    let attempts=0;
    if(exists(file)){regular(file);try{attempts=JSON.parse(fs.readFileSync(file,'utf8')).attempts??0;}catch{/* Diagnostics never grant recovery authority. */}}
    fs.writeFileSync(file,JSON.stringify({root:p.root,attempts:attempts+1,lastAttemptAt:Date.now(),
      error:String(error),code:(error as NodeJS.ErrnoException).code??null}),{mode:0o600});flush(file);
  }catch(diagnosticError){console.warn(`[codegraph] Initialization cleanup diagnostic could not be persisted: ${String(diagnosticError)}`);}
}
function scheduleCleanupRetry(p:ReturnType<typeof paths>):void {
  if(cleanupRetries.has(p.root))return;
  const timer=setInterval(()=>{
    try {
      // Interval is scheduling only. Recovery must reacquire the real SQLite
      // owner on every attempt; a live/retained builder cannot be reclaimed.
      if(!exists(p.intent)&&!readAllocation(p)){stopCleanupRetry(p);return;}
      recoverFixedPathInitialization(p.root);
      if(!exists(p.intent)&&!readAllocation(p))stopCleanupRetry(p);
    }catch(error){recordCleanupFailure(p,error);}
  },250);timer.unref();cleanupRetries.set(p.root,timer);
}
function cleanup(p:ReturnType<typeof paths>,r:Intent,committed:boolean):void {
  const o=operation(p,r);
  // Durable cleaning state survives owner unlink/rmdir failures. Missing or
  // empty owned directories are accepted only in this terminal cleanup phase.
  if(r.phase==='cleaning') {
    if(!exists(o.dir)){fs.unlinkSync(p.intent);flushDirectory(p.home);return;}
    directory(o.dir);
    if(fs.readdirSync(o.dir).length===0){fs.rmdirSync(o.dir);fs.unlinkSync(p.intent);flushDirectory(p.home);return;}
  }
  owned(p,r);
  const allowed=new Set(['owner.json','candidate.db','intent.next',...(r.identity===null?['candidate.db-wal','candidate.db-shm','candidate.db-journal','codegraph.lock']:[])]);
  for(const name of fs.readdirSync(o.dir)){if(!allowed.has(name))throw new Error('Unknown initialization artifact retained');regular(path.join(o.dir,name));}
  if(exists(o.candidate)&&r.identity!==null&&hash(o.candidate)!==r.identity)throw new Error('Unknown initialization candidate identity');
  if(exists(p.writer)){regular(p.writer);if(fs.readFileSync(p.writer,'utf8')===r.writerToken)fs.unlinkSync(p.writer);else if(!committed)throw new Error('Foreign writer blocks initialization cleanup');}
  r.phase='cleaning';r.outcome=committed?'committed':'aborted';save(p,r);
  for(const name of fs.readdirSync(o.dir).filter(n=>n!=='owner.json'))fs.unlinkSync(path.join(o.dir,name));
  fs.unlinkSync(o.owner);fs.rmdirSync(o.dir);flushDirectory(p.home);
  // Only now remove the admission/recovery pointer. A crash before this line
  // can safely finish from its durable terminal state without an owner marker.
  fs.unlinkSync(p.intent);flushDirectory(p.home);
}
function finishCleanup(p:ReturnType<typeof paths>,r:Intent):void {
  try{cleanup(p,r,true);stopCleanupRetry(p);}catch(error){recordCleanupFailure(p,error);if(!cleanupRetries.has(p.root))console.warn(`[codegraph] Fixed initialization committed; cleanup deferred: ${String(error)}`);scheduleCleanupRetry(p);}
}
/** Existence only: damaged/symlink intents must still select this data directory. */
export function hasFixedPathInitializationIntent(dataDir:string):boolean {const p=paths(dataDir);if(!exists(p.root))return false;checkDirectories(p);return exists(p.intent)||readAllocation(p)!==null;}
/** All current-version discovery/open paths must call this before legacy admission.
 * The private candidate is not the root database and is intentionally exempt. */
export function assertNoFixedPathInitialization(dataDir:string):void {
  const p=paths(dataDir);if(!exists(p.root))return;checkDirectories(p);const r=read(p);if(!r)return;
  if(inspectFixedPathLayout(p.root)==='fixed')return;
  throw new Error('Fixed-path storage initialization is pending; database admission is closed');
}
function complete(p:ReturnType<typeof paths>,r:Intent,options:Options,onRegistrationFailure:()=>void):void {
  if(r.phase==='allocating'){abortAllocation(p,r);return;}
  clearAllocation(p,r);
  recoverFixedPathMigration(p.root);
  if(r.phase==='cleaning') {
    const fixed=inspectFixedPathLayout(p.root)==='fixed';
    if(r.outcome==='committed'&&!fixed)throw new Error('Committed initialization lost fixed marker');
    if(r.outcome==='aborted'&&(fixed||exists(p.active)))throw new Error('Unknown root after aborted initialization');
    if(r.outcome==='aborted')noLogs(p.active);
    if(fixed)finishCleanup(p,r);else cleanup(p,r,false);return;
  }
  const o=owned(p,r);
  if(inspectFixedPathLayout(p.root)==='fixed'){finishCleanup(p,r);return;}
  if(exists(path.join(p.root,'CURRENT')))throw new Error('CURRENT conflicts with pending fixed initialization');
  if(r.phase==='building') {
    if(exists(p.active))throw new Error('Unknown root during incomplete initialization');noLogs(p.active);cleanup(p,r,false);return;
  }
  noLogs(p.active);noLogs(o.candidate);
  if(exists(p.active)) {
    if(exists(o.candidate)||hash(p.active)!==r.identity)throw new Error('Unknown installed initialization root; evidence preserved');
  } else {
    if(!exists(o.candidate)||hash(o.candidate)!==r.identity)throw new Error('Missing or changed initialization candidate');
    options.hook?.('before-install');if(exists(p.active))throw new Error('Root appeared before initialization install; preserved');noLogs(p.active);fs.renameSync(o.candidate,p.active);flushDirectory(o.dir);flushDirectory(p.root);options.hook?.('root-installed');
  }
  r.phase='installed';save(p,r);options.hook?.('installed');
  // Intent remains an admission fence while the existing migration registrar
  // transfers the legacy writer token into its own persistent protocol.
  releaseWriter(p,r);
  recoverFixedPathMigration(p.root);
  try{migrateToFixedPath(p.root,{offline:true});}
  catch(error){
    // Registration validation owns native root handles too. Before its marker
    // commits, an exceptional close is not proof that those handles are gone.
    if(!exists(path.join(p.runtime,'layout.json')))onRegistrationFailure();
    throw error;
  }
  options.hook?.('layout-committed');
  r.phase='committed';r.outcome='committed';try{save(p,r);}catch(error){console.warn(`[codegraph] Fixed initialization marker committed; intent update deferred: ${String(error)}`);}
  finishCleanup(p,r);options.hook?.('cleaned');
}
/** A prior initializer's OS owner lease must be gone; never infer this from PID. */
export function recoverFixedPathInitialization(dataDir:string,options:Options={}):void {
  const p=paths(dataDir);if(!exists(p.root))return;checkDirectories(p);const r=read(p);if(!r)return;
  const fixed=exists(path.join(p.runtime,'layout.json'))&&inspectFixedPathLayout(p.root)==='fixed';
  let lock:{close():void};
  try{lock=owner(p);}catch(error){
    const code=(error as {errcode?:number}).errcode;
    // The marker commits root authority before cleanup. A live initializer
    // still owning cleanup must not block the new fixed admission domain.
    if(fixed&&typeof code==='number'&&(code&255)===5)return;
    throw error;
  }
  let retainOwner=false;
  try{const current=read(p);if(current)complete(p,current,options,()=>{retainOwner=true;});}
  finally{if(retainOwner)retainedOwners.add(lock);else lock.close();}
}
// Retaining the actual native handle prevents GC from silently releasing the
// lease while a failed builder's database may still be open. Process exit is
// the default release proof; no PID, timeout or Promise settlement is used.
const retainedOwners=new Set<{close():void}>();
/** Schema creation only, not source indexing. The callback must close every
 * candidate connection before returning; asynchronous builders are rejected. */
export function initializeFixedPathStorage(dataDir:string,buildClosedCandidate:(file:string)=>void,options:Options={}):string {
  canonicalFixedPathDataDirectory(dataDir);fs.mkdirSync(dataDir,{recursive:true});const p=paths(dataDir);recoverFixedPathInitialization(p.root);checkDirectories(p,true);
  const lock=owner(p);let retainOwner=false;
  try{
    if(read(p)||exists(p.active)||exists(path.join(p.root,'CURRENT'))||exists(path.join(p.runtime,'layout.json')))throw new Error('Fixed storage already exists or initialization is pending');noLogs(p.active);
    if(exists(p.writer)||exists(path.join(p.root,'codegraph.lock')))throw new Error('Existing legacy writer blocks fixed initialization');
    const r:Intent={version:1,id:randomUUID(),root:p.root,writerToken:randomUUID(),phase:'allocating',identity:null,outcome:null},o=operation(p,r);
    recordAllocation(p,r);options.hook?.('allocation-recorded');
    fs.mkdirSync(o.dir);flushDirectory(p.home);options.hook?.('directory-created');fs.writeFileSync(o.owner,JSON.stringify({version:1,operation:r.id}),{flag:'wx',mode:0o600});flush(o.owner);flushDirectory(o.dir);options.hook?.('owner-created');
    r.phase='building';save(p,r);clearAllocation(p,r);options.hook?.('intent-recorded');
    fs.writeFileSync(p.writer,r.writerToken,{flag:'wx',mode:0o600});flush(p.writer);options.hook?.('writer-acquired');
    try {
      const returned=buildClosedCandidate(o.candidate) as unknown;
      if(returned&&typeof(returned as {then?:unknown}).then==='function'){
        retainOwner=true;void Promise.resolve(returned).catch(()=>{});
        throw new Error('Fixed initialization callback must be synchronous and closed');
      }
    } catch(error) {
      // Constructor failure and post-return validation (including a throwing
      // then getter) are equally insufficient evidence of native close.
      try { retainOwner=retainOwner||options.builderClosedOnError?.()!==true; } catch { retainOwner=true; }
      throw error;
    }
    options.hook?.('candidate-built');r.identity=seal(o.candidate,()=>{retainOwner=true;});r.phase='sealed';save(p,r);options.hook?.('sealed');
    complete(p,r,options,()=>{retainOwner=true;});return p.active;
  }finally{if(retainOwner)retainedOwners.add(lock);else {lock.close();if(exists(p.intent)||readAllocation(p))scheduleCleanupRetry(p);}}
}

/** Guard a low-level legacy root CREATE against concurrent first fixed init.
 * This does not initialize/register fixed storage and never silently falls back
 * when node:sqlite is unavailable. Managed generations/private candidates need
 * their existing ownership instead. The caller must not use this for an already
 * registered fixed root; that belongs to normal fixed lifecycle admission. */
export function withFixedPathInitializationCreationGate<T>(dataDir:string,action:()=>T,options:{closedOnError?:()=>boolean}={}):T {
  canonicalFixedPathDataDirectory(dataDir);fs.mkdirSync(dataDir,{recursive:true});const p=paths(dataDir);
  const lock=owner(p);let retainOwner=false;
  try{
    if(read(p))throw new Error('Fixed initialization intent blocks legacy root creation');
    if(inspectFixedPathLayout(p.root)==='fixed')throw new Error('Registered fixed root requires lifecycle admission, not legacy creation');
    try{
      const result=action();
      if(result&&typeof(result as {then?:unknown}).then==='function'){
        retainOwner=true;void Promise.resolve(result).catch(()=>{});
        throw new Error('Legacy root creation gate requires a synchronous constructor');
      }
      // sql.js constructors may still be entirely in memory. Releasing here would
      // let fixed init publish a root that a later WASM flush overwrites.
      if(!exists(p.active)){
        retainOwner=true;
        throw new Error('Legacy constructor must materialize root storage before releasing creation admission');
      }
      regular(p.active);
      return result;
    }catch(error){
      try{retainOwner=retainOwner||options.closedOnError?.()!==true;}catch{retainOwner=true;}
      throw error;
    }
  }finally{if(retainOwner)retainedOwners.add(lock);else lock.close();}
}
