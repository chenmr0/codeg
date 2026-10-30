/** Internal fixed-path v1 coordination protocol. Controlled production integration.
 * Cooperative local-filesystem protocol. Unknown/legacy SQLite users are NOT fenced.
 * OS-backed SQLite leases, not PID/mtime, establish publisher/connection ownership.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
// Keep legacy/sql.js imports usable on runtimes without node:sqlite.
// Native capability is required only when the controlled protocol is entered.
const DatabaseSync = function(...args) { const Native = require('node:sqlite').DatabaseSync; return new Native(...args); };
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

const ID = /^[a-f0-9-]{36}$/;
const phasesBeforeRename = new Set(['building', 'prepared', 'draining']);
const pause = new Int32Array(new SharedArrayBuffer(4));
export const now = () => performance.now();
export function paths(project) {
  const requestedRoot = path.resolve(typeof project === 'string' ? project : project.project);
  const root = fs.existsSync(requestedRoot) ? fs.realpathSync(requestedRoot) : requestedRoot;
  let data = typeof project === 'string' ? path.join(root, '.codegraph-wx') : path.resolve(project.dataDirectory);
  // A project alias is supported; the data-directory leaf itself must remain a
  // real directory. Canonical paths give every participant one recovery domain.
  if (fs.existsSync(data)) { directory(data); data = fs.realpathSync(data); }
  else if (fs.existsSync(path.dirname(data))) data = path.join(fs.realpathSync(path.dirname(data)), path.basename(data));
  const runtime = path.join(data, '.runtime', 'fixed-path-v1');
  return { project: path.resolve(root), data, runtime, active: path.join(data, 'codegraph.db'), gate: path.join(runtime, 'gate.sqlite'), connections: path.join(runtime, 'connections.sqlite'), owner: path.join(runtime, 'publisher.sqlite'), writers: path.join(runtime, 'writers.sqlite'), mutations: path.join(runtime, 'mutations.sqlite') };
}
function regular(file, missing = false) {
  try { if (!fs.lstatSync(file).isFile()) throw new Error(`Unsafe non-regular file: ${file}`); }
  catch (e) { if (!(missing && e.code === 'ENOENT')) throw e; }
}
function directory(file) { if (!fs.lstatSync(file).isDirectory()) throw new Error(`Unsafe directory: ${file}`); }
function traceBootstrap(trace,phase,action){
  if(!trace)return action();
  const start=now(),record={phase,startedAtMs:Date.now()};trace.push(record);
  try{return action();}catch(error){record.code=error.code;record.errcode=error.errcode;record.error=error.message;throw error;}
  finally{record.elapsedMs=now()-start;}
}
function db(file, validateMode = true, busyMs = 25, trace) {
  regular(file, true); regular(file + '-journal', true);
  const connection = traceBootstrap(trace,'sqlite-open',()=>new DatabaseSync(file));
  try {
    if(trace){
      traceBootstrap(trace,'set-busy-timeout',()=>connection.exec(`PRAGMA busy_timeout=${busyMs}`));
      traceBootstrap(trace,'set-synchronous-full',()=>connection.exec('PRAGMA synchronous=FULL'));
    }else connection.exec(`PRAGMA busy_timeout=${busyMs}; PRAGMA synchronous=FULL`);
    if (validateMode && Object.values(connection.prepare('PRAGMA journal_mode').get())[0] !== 'delete') throw new Error('Coordination database must use DELETE journal mode');
    return connection;
  } catch (e) { traceBootstrap(trace,'close-after-config-error',()=>connection.close()); throw e; }
}
// Only the durable coordinator uses WAL. Lease files must remain DELETE.
function coordinatorDb(p, bootstrap=false, trace){
  if(!bootstrap)regular(p.gate);
  for(const suffix of ['', '-wal', '-shm', '-journal'])regular(p.gate+suffix,bootstrap||suffix!=='');
  const d=db(p.gate,false,0,trace);
  try{
    let mode=traceBootstrap(trace,'journal-mode',()=>d.prepare('PRAGMA journal_mode').get().journal_mode);
    if(mode!=='wal'){
      // The first PRAGMA can reflect this connection's cached empty DELETE
      // pager while another cold client has already bootstrapped WAL. A schema
      // read refreshes the pager; pair that read, mode and lease evidence in a
      // short read transaction so a concurrent DELETE->WAL bootstrap cannot
      // mix two epochs. No protocol action or mutation occurs in this probe.
      d.exec('BEGIN');
      try{
        const initialized=d.prepare("SELECT name FROM sqlite_master WHERE name='state'").get();
        mode=d.prepare('PRAGMA journal_mode').get().journal_mode;
        if(mode!=='wal' && (!bootstrap || initialized || [p.owner,p.connections,p.writers,p.mutations].some(f=>fs.existsSync(f))))throw new Error('Incompatible DELETE coordinator: offline isolated WAL experiment required; no live migration');
        d.exec('COMMIT');
      }catch(error){try{d.exec('ROLLBACK');}catch{}throw error;}
      if(mode!=='wal'){
        // Changing journal mode is forbidden inside the read transaction.
        // Another initializer may win after COMMIT; WAL is then already set,
        // or SQLite reports BUSY and the existing bounded preopen retry wins.
        mode=traceBootstrap(trace,'initialize-wal',()=>d.prepare('PRAGMA journal_mode=WAL').get().journal_mode);
        if(mode!=='wal')throw new Error('Unable to initialize WAL coordinator');
      }
    }
    traceBootstrap(trace,'disable-auto-checkpoint',()=>d.exec('PRAGMA wal_autocheckpoint=0'));
    return d;
  }catch(error){traceBootstrap(trace,'close-after-coordinator-error',()=>d.close());throw error;}
}
// Extended SQLite result codes retain the primary code in their low byte.
// This classifier is used ONLY before a coordinator/protocol action begins.
// https://www.sqlite.org/rescode.html#busy_recovery
function coordinatorOpenBusy(error){return Number.isInteger(error.errcode)&&error.errcode>=0&&(error.errcode&255)===5;}
function openCoordinatorBounded(p,deadline=now()+500){
  const end=Math.min(deadline,now()+500);
  while(true){
    if(now()>=end)throw admissionTimeout();
    try{return coordinatorDb(p);}catch(error){if(!coordinatorOpenBusy(error)||now()>=end)throw error;Atomics.wait(pause,0,0,2);}
  }
}
// A publisher/recovery keeps one initialized WAL connection alive while it
// owns the operation. It holds no read transaction: snapshots remain fresh.
// This prevents our short metadata connections from repeatedly becoming the
// last WAL client when another process exits during publication.
function coordinatedOwner(p){
  const lock=lease(p.owner,true);if(!lock)return null;
  let keeper;
  const diagnostic={openedAtMs:Date.now(),attachedAtMs:null,closedAtMs:null};
  try{
    keeper=openCoordinatorBounded(p,p.requestDeadline??Infinity);
    keeper.exec('PRAGMA query_only=ON');
    if(keeper.prepare('SELECT id FROM state WHERE id=1').get()?.id!==1)throw new Error('Coordination state row missing');
    diagnostic.attachedAtMs=Date.now();
  }catch(error){
    let failure=error;
    try{keeper?.close();}catch(closeError){failure=new AggregateError([error,closeError],'Owner keeper initialization cleanup failed');}
    finally{lock.close();}
    throw failure;
  }
  let keeperClosed=false,lockClosed=false;
  return {diagnostic,close(){
    let failure;
    if(!keeperClosed){try{keeper.close();keeperClosed=true;diagnostic.closedAtMs=Date.now();}catch(error){failure=error;diagnostic.closeError=error.message;}}
    if(!lockClosed){try{lock.close();lockClosed=true;}catch(error){failure=failure?new AggregateError([failure,error],'Publisher owner cleanup failed'):error;}}
    if(failure)throw failure;
  }};
}
export function checkpointCoordinator(projectOrPaths){
  const p=typeof projectOrPaths==='string'?paths(projectOrPaths):projectOrPaths;
  const d=coordinatorDb(p);
  try{
    const result=d.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
    return {...result,deferred:result.busy!==0 || result.checkpointed<result.log};
  }finally{d.close();}
}
// Keep one attached, transaction-free coordinator connection across bootstrap.
// Public standalone initialization closes it at the end; Participant transfers
// ownership rather than forcing a last-close/reopen recovery window.
export function initialize(project) {
  const initialized=initializeCoordinator(project);
  initialized.coordination.close();
  return initialized.p;
}
function initializeCoordinator(project) {
  const p=paths(project);
  fs.mkdirSync(p.runtime,{recursive:true});directory(p.data);directory(path.dirname(p.runtime));directory(p.runtime);
  // Established startup validates without taking a writer transaction. No online
  // DELETE->WAL conversion, and never recreate a missing established lease file.
  let established,coordination,probeAttempts=0;const bootstrapPhases=[],bootstrapWallStarted=Date.now();const bootstrapStarted=now(),bootstrapDeadline=bootstrapStarted+500;
  while(true){
    try{
      probeAttempts++;
      const trace=[];bootstrapPhases.push({attempt:probeAttempts,phases:trace});
      const d=coordinatorDb(p,true,trace);
      // Opening a WAL handle is not the end of pre-admission: this first
      // schema read can still encounter another client's recovery/last-close
      // lock. Close the failed handle before retrying the entire read-only
      // probe within the SAME 500 ms budget. No bootstrap action has begun.
      try{established=traceBootstrap(trace,'probe-state',()=>!!d.prepare("SELECT name FROM sqlite_master WHERE name='state'").get());coordination=d;}catch(error){try{traceBootstrap(trace,'close-after-failed-probe',()=>d.close());}catch(closeError){throw new AggregateError([error,closeError],'Bootstrap probe and close failed');}throw error;}
      break;
    }catch(error){
      if(!coordinatorOpenBusy(error)||now()>=bootstrapDeadline){
        // Preserve numeric SQLite codes through worker IPC's stack-only error
        // transport; diagnostics never change classification or retry policy.
        error.bootstrapProbeDiagnostic={attempts:probeAttempts,elapsedMs:now()-bootstrapStarted,code:error.code,errcode:error.errcode,phases:bootstrapPhases};
        gateDiagnostic(p,{label:'bootstrap-probe',readOnly:true,startedAtMs:bootstrapWallStarted,totalMs:now()-bootstrapStarted,attempts:bootstrapPhases},error);
        error.stack=`${error.stack??error.message}\nBootstrap probe diagnostic: ${JSON.stringify(error.bootstrapProbeDiagnostic)}`;
        throw error;
      }
      Atomics.wait(pause,0,0,2);
    }
  }
  gateDiagnostic(p,{label:'bootstrap-probe',readOnly:true,startedAtMs:bootstrapWallStarted,totalMs:now()-bootstrapStarted,attempts:bootstrapPhases});
  try {
  if(established){for(const file of[p.connections,p.owner,p.writers,p.mutations])regular(file);return {p,coordination};}
  // FULL-sync preparation must not hold the shared coordinator writer lock.
  // Each contender owns only its freshly allocated directory. A crash before
  // promotion leaves private evidence, never a partially initialized fixed lease.
  const prepared=fs.mkdtempSync(path.join(p.runtime,'bootstrap-'));
  const leaseFiles=[p.connections,p.owner,p.writers,p.mutations], attempted=new Set(), closed=new Set();
  let failure;
  try {
    for(const file of leaseFiles){
      attempted.add(file);
      const l=db(path.join(prepared,path.basename(file)));
      let prepareError;
      try{l.exec('BEGIN IMMEDIATE; CREATE TABLE lease(value INTEGER); INSERT INTO lease VALUES(1); COMMIT');}
      catch(error){prepareError=error;throw error;}
      finally{try{l.close();closed.add(file);}catch(closeError){throw prepareError?new AggregateError([prepareError,closeError],'Lease preparation and close both failed'):closeError;}}
    }
    gate(p,g=>{
      const exists=!!g.prepare("SELECT name FROM sqlite_master WHERE name='state'").get();
      if(!exists&&leaseFiles.some(file=>fs.existsSync(file)))throw new Error('Missing coordination state with existing leases; refusing to reconstruct protocol state');
      for(const file of leaseFiles){
        if(exists){regular(file);continue;}
        // No cooperative initializer can publish a fixed lease outside this gate.
        // A failure after any rename intentionally leaves fixed-path evidence;
        // later initialization must fail closed, not silently reconstruct it.
        fs.renameSync(path.join(prepared,path.basename(file)),file);
      }
      if(!exists)g.exec(`CREATE TABLE state(id INTEGER PRIMARY KEY CHECK(id=1), mode TEXT NOT NULL, operation TEXT, cancel INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0);
        INSERT INTO state(id,mode) VALUES(1,'idle');
        CREATE TABLE operations(id TEXT PRIMARY KEY, record TEXT NOT NULL);
        CREATE TABLE costs(identity TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    },{label:'bootstrap-install'});
  } catch(error){failure=error;throw error;} finally {
    // Do not sweep other bootstraps by age/PID. Only files allocated by this
    // invocation are eligible; a crashed invocation's directory is retained.
    const cleanupErrors=[];
    for(const file of closed){
      const own=path.join(prepared,path.basename(file));
      for(const suffix of ['', '-journal']){const target=own+suffix;try{if(fs.existsSync(target)){regular(target);fs.unlinkSync(target);}}catch(error){cleanupErrors.push(error);}}
    }
    // A close failure leaves ownership of the handle uncertain. In particular,
    // never unlink its potentially recoverable rollback journal.
    if([...attempted].every(file=>closed.has(file)))try{fs.rmdirSync(prepared);}catch(error){cleanupErrors.push(error);}
    if(cleanupErrors.length)throw new AggregateError([...(failure?[failure]:[]),...cleanupErrors],'Bootstrap preparation cleanup failed; evidence retained');
  }
  return {p,coordination};
  } catch(error) {
    try{coordination.close();}catch(closeError){throw new AggregateError([error,closeError],'Bootstrap initialization and keeper close failed');}
    throw error;
  }
}
function gateDiagnostic(p,metrics,error){
  const record={...metrics,pid:process.pid,project:p.project,finishedAtMs:Date.now(),error:error?.message,code:error?.code,errcode:error?.errcode};
  if(error)error.gateDiagnostic=record;
  if(error)error.stack=`${error.stack??error.message}\nGate diagnostic: ${JSON.stringify(record)}`;
  const directory=process.env.GATE_DIAGNOSTICS_DIR;
  if(!directory || (!error && record.totalMs<25))return;
  // Diagnostics only after lock release, never a recovery/admission authority.
  try{fs.mkdirSync(directory,{recursive:true});fs.appendFileSync(path.join(directory,`gate-${process.pid}.jsonl`),JSON.stringify(record)+'\n');}
  catch(diagnosticError){process.stderr.write(`Gate diagnostic write failed: ${diagnosticError.message}\n`);}
}
export function gate(p, action, options = {}) {
  // Retry lock acquisition / COMMIT only; never replay an action with side effects.
  const started=now(),metrics={label:options.label??'gate',readOnly:!!options.readOnly,startedAtMs:Date.now(),phase:'open',actionStarted:false,openMs:0,beginMs:0,actionMs:0,commitMs:0,closeMs:0,retries:0};
  const requestDeadline=options.deadline??p.requestDeadline;
  const deadline=Math.min(started+500,requestDeadline??Infinity);let g,transactionStarted=false;
  while(true){
    try{
      if(requestDeadline!==undefined && now()>=requestDeadline)throw admissionTimeout();
      metrics.phase='open';let t=now();if(!g){try{g=coordinatorDb(p);}finally{metrics.openMs+=now()-t;}}
      metrics.phase='begin';t=now();try{
        if(options.readOnly)g.exec('PRAGMA query_only=ON');
        g.exec(options.readOnly?'BEGIN':'BEGIN IMMEDIATE');transactionStarted=true;
        // Acquire SHARED before action, so retries cannot replay partial work.
        if(options.readOnly)g.prepare('SELECT id FROM state WHERE id=1').get();
      }finally{metrics.beginMs+=now()-t;}
      if(requestDeadline!==undefined && now()>=requestDeadline)throw admissionTimeout();
      metrics.acquiredAtMs=Date.now();break;
    }catch(error){
      // BEGIN contention does not require reopening the coordination file.
      // A read gate can BEGIN before its pre-action SELECT fails; roll that
      // transaction back before retry. Never reuse an uncertain transaction.
      let failure=error;
      if(transactionStarted){try{g.exec('ROLLBACK');transactionStarted=false;}catch(rollbackError){failure=new AggregateError([error,rollbackError],'Gate pre-action rollback failed');}}
      if(failure!==error || !String(error.message).includes('locked')||now()>=deadline){
        const t=now();g?.close();metrics.closeMs+=now()-t;g=null;
        metrics.totalMs=now()-started;gateDiagnostic(p,metrics,failure);p.gateMetrics?.push(metrics);throw failure;
      }
      metrics.retries++;Atomics.wait(pause,0,0,2);
    }
  }
  let failure;
  try{
    // Keep the existing action SQL wait policy, but do not stack SQLite's
    // internal busy handler with the outer BEGIN/COMMIT retry deadline.
    metrics.phase='action-setup';g.exec('PRAGMA busy_timeout=25');
    metrics.phase='action';metrics.actionStarted=true;let result;const t=now();
    try{result=action(g);}finally{metrics.actionMs=now()-t;metrics.actionEndedAtMs=Date.now();}
    metrics.phase='commit-setup';g.exec('PRAGMA busy_timeout=0');
    metrics.phase='commit';
    while(true){const t=now();try{g.exec('COMMIT');break;}catch(error){if(!String(error.message).includes('locked')||now()>=deadline)throw error;metrics.retries++;Atomics.wait(pause,0,0,2);}finally{metrics.commitMs+=now()-t;}}
    metrics.phase='complete';return result;
  }catch(error){failure=error;try{g.exec('ROLLBACK');}catch{}throw error;}
  finally{
    const t=now();g.close();metrics.closeMs+=now()-t;metrics.totalMs=now()-started;
    gateDiagnostic(p,metrics,failure);p.gateMetrics?.push(metrics);
  }
}
export function state(p) { return gate(p, g => g.prepare('SELECT * FROM state WHERE id=1').get(),{readOnly:true,label:'state'}); }
function put(g, record) { g.prepare('INSERT OR REPLACE INTO operations VALUES (?,?)').run(record.id, JSON.stringify(record)); }
export function records(p) { return gate(p, g => g.prepare('SELECT record FROM operations').all().map(r => JSON.parse(r.record)),{readOnly:true,label:'records'}); }
export function lease(file, exclusive = false) {
  regular(file);
  let d;
  try { d = db(file, false, 0); d.exec('PRAGMA busy_timeout=0'); d.exec(exclusive ? 'BEGIN EXCLUSIVE' : 'BEGIN'); if (!exclusive) d.prepare('SELECT value FROM lease').get(); if (Object.values(d.prepare('PRAGMA journal_mode').get())[0] !== 'delete') throw new Error('Lease database must use DELETE mode'); }
  catch (e) { d?.close(); if (String(e.message).includes('locked')) return null; throw e; }
  let closed = false;
  return { close() { if (!closed) { d.close(); closed = true; } } };
}
export function sha(file) {
  regular(file); const hash = crypto.createHash('sha256'), fd = fs.openSync(file, 'r'), buffer = Buffer.allocUnsafe(1024*1024);
  try { let n; while ((n=fs.readSync(fd,buffer,0,buffer.length,null)) > 0) hash.update(buffer.subarray(0,n)); return hash.digest('hex'); } finally { fs.closeSync(fd); }
}
function flush(file) { const fd = fs.openSync(file, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function flushDirectory(file) {
  if (process.platform === 'win32') return false; // No unverified power-loss claim on Windows.
  const fd = fs.openSync(file, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } return true;
}
function noSidecars(file) {
  // Never unlink SQLite logs to force a swap; close/checkpoint must remove them.
  for (const suffix of ['-wal', '-shm', '-journal']) if (fs.existsSync(file + suffix)) throw new Error(`Unresolved SQLite sidecar: ${file + suffix}`);
}
export function seal(file, { integrity = true, standalone = false } = {}) {
  regular(file);
  const d = new DatabaseSync(file);
  try {
    d.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=FULL');
    const result = d.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if (result.busy !== 0) throw new Error('Checkpoint blocked; publication not started');
    if (integrity && d.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Integrity check failed');
    if (standalone && Object.values(d.prepare('PRAGMA journal_mode=DELETE').get())[0] !== 'delete') throw new Error('Cannot seal standalone candidate');
  } finally { d.close(); }
  // Other live read connections may retain empty WAL/SHM until draining.
  flush(file);
  return sha(file);
}
function validateRecordPaths(p, record) {
  if (record.version !== 1) throw new Error('Unknown publication record version');
  if (!ID.test(record.id)) throw new Error('Invalid operation id');
  const dir = path.join(p.runtime, record.id);
  if (record.active !== p.active || record.directory !== dir || record.candidate !== path.join(dir, 'candidate.db') || record.backup !== path.join(dir, 'old.db')) throw new Error('Unsafe recovery paths');
  return dir;
}
function operationPaths(p, record) {
  const dir=validateRecordPaths(p,record);
  directory(dir);
  const marker = path.join(dir, 'owner.json'); regular(marker);
  if (fs.statSync(marker).size > 4096 || JSON.parse(fs.readFileSync(marker, 'utf8')).operation !== record.id) throw new Error('Ownership marker mismatch');
  return dir;
}
function checkpoint(p, record, phase, hook) {
  record.phase = phase;
  gate(p, g => put(g, record),{label:`publish-${phase}`});
  hook?.(phase);
}
function move(from, to, hook, point) {
  hook?.(`before-${point}`); fs.renameSync(from, to); flushDirectory(path.dirname(from)); flushDirectory(path.dirname(to)); hook?.(`after-${point}`);
}
function identityIfPresent(file) { return fs.existsSync(file) ? sha(file) : null; }
function setIdle(p, record) { gate(p, g => { put(g, record); g.prepare("UPDATE state SET mode='idle', operation=NULL, cancel=0 WHERE id=1").run(); }); }
export function cleanup(p, record, hook) {
  validateRecordPaths(p,record);
  if (!['committed', 'aborted', 'cleaned'].includes(record.phase)) throw new Error('Cannot clean an unresolved operation');
  if (record.phase === 'cleaned') {
    if (!fs.existsSync(record.directory)) return;
    directory(record.directory);
    if (fs.readdirSync(record.directory).length === 0) { fs.rmdirSync(record.directory); return; }
    operationPaths(p, record);
    if (fs.readdirSync(record.directory).join(',') !== 'owner.json') throw new Error('Unexpected cleaned artifacts');
    fs.unlinkSync(path.join(record.directory,'owner.json')); fs.rmdirSync(record.directory); return;
  }
  operationPaths(p, record);
  const names = fs.readdirSync(record.directory);
  const unsealed = record.phase === 'aborted' && !record.candidateIdentity;
  const allowed = new Set(['owner.json', 'candidate.db', 'old.db', ...(unsealed ? ['candidate.db-wal','candidate.db-shm','candidate.db-journal','codegraph.lock'] : [])]);
  // Unexpected sidecars or files preserve all evidence; no age-based rmtree.
  if (names.some(n => !allowed.has(n))) throw new Error('Unexpected operation artifacts; preserved for diagnosis');
  // The real indexer writes codegraph.lock beside this operation's candidate.
  // Only an unsealed aborted operation may retain it. Recovery holds the OS
  // publisher lease (the builder runs in that same process), not a PID/age guess.
  // Preflight every recognized artifact before deleting anything; symlinks and
  // unexpected files preserve the whole operation for diagnosis.
  for (const name of names) regular(path.join(record.directory, name));
  for (const [file, expected] of [[record.backup, record.oldIdentity], [record.candidate, record.candidateIdentity]]) {
    if (!fs.existsSync(file)) continue;
    if (file === record.candidate && unsealed) regular(file);
    else if (!expected || sha(file) !== expected) throw new Error('Refusing cleanup of an unknown artifact');
    hook?.('cleanup'); fs.unlinkSync(file);
  }
  if (unsealed) for (const suffix of ['-wal','-shm','-journal']) { const file=record.candidate+suffix; if(fs.existsSync(file)) { regular(file); fs.unlinkSync(file); } }
  if (unsealed && names.includes('codegraph.lock')) fs.unlinkSync(path.join(record.directory, 'codegraph.lock'));
  // Exclusive publisher ownership proves the unsealed candidate builder has exited.
  // Persist cleanup before removing the final marker; restart may remove empty owned dir.
  record.phase = 'cleaned'; gate(p, g => put(g, record));
  cleanup(p, record);
}
/** Exclusive publisher + connection leases are held here. No application may open yet. */
function resolveOperation(p, record, hook) {
  operationPaths(p, record);
  if (phasesBeforeRename.has(record.phase)) {
    regular(p.active); // No rename was authorized. Never restore a random backup.
    record.phase = 'aborted'; setIdle(p, record); return;
  }
  if (record.phase === 'committed') {
    regular(p.active); // May be a later offline replacement; never require candidate hash.
    const d = new DatabaseSync(p.active, { readOnly: true });
    try { if (d.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('Committed active database is corrupt'); } finally { d.close(); }
    setIdle(p, record); return;
  }
  if (!['replacing', 'old-moved', 'new-moved'].includes(record.phase)) throw new Error(`Unknown recovery phase: ${record.phase}`);
  for (const file of [p.active, record.backup, record.candidate]) noSidecars(file);
  const active = identityIfPresent(p.active), backup = identityIfPresent(record.backup), candidate = identityIfPresent(record.candidate);
  const old = record.oldIdentity, next = record.candidateIdentity;
  if (!old || !next || old === next) throw new Error('Ambiguous database identities');
  if (active === old && backup === null && candidate === next) { /* Rename never happened. */ }
  else if (active === null && backup === old && candidate === next) move(record.backup, p.active, hook, 'restore-old');
  else if (active === next && backup === old && candidate === null) {
    move(p.active, record.candidate, hook, 'unpublish-new'); move(record.backup, p.active, hook, 'restore-old');
  } else throw new Error('Unrecognized recovery identities; admission remains closed and evidence preserved');
  record.phase = 'aborted'; setIdle(p, record);
}
export function recover(project, options = {}) {
  const initialized=initializeCoordinator(project);
  let failure;
  try{return recoverInitialized(initialized.p,options);}
  catch(error){failure=error;throw error;}
  finally{try{initialized.coordination.close();}catch(closeError){throw failure?new AggregateError([failure,closeError],'Recovery and bootstrap keeper close failed'):closeError;}}
}
// Existing participants already validated the layout; do not acquire the gate
// merely to discover that a live publisher owns recovery. Missing lock files
// still fail in lease(), and external callers retain full initialize validation.
function recoverInitialized(p, options = {}) {
  const owner=coordinatedOwner(p);
  if(!owner)return false;
  let fence,recoveryCompleted=false;
  try {
    const s = state(p);
    if (s.mode !== 'idle') {
      // Persist closure before trying connection leases. Callers retry after idle holders drain.
      gate(p, g => g.prepare("UPDATE state SET mode='recovering' WHERE id=1").run());
      options.hook?.('recovering');
      const record = records(p).find(r => r.id === s.operation);
      if (!record) throw new Error('Recovery record missing; admission remains closed');
      if (!phasesBeforeRename.has(record.phase)) { fence = lease(p.connections, true); if (!fence) return false; }
      resolveOperation(p, record);
    }
    for (const r of records(p)) {
      if(['draining','replacing','old-moved','new-moved'].includes(r.phase))throw new Error('Orphaned unresolved publication record; admission denied');
      if (r.phase === 'building' || r.phase === 'prepared') { r.phase = 'aborted'; gate(p,g=>put(g,r)); }
      if (['committed', 'aborted', 'cleaned'].includes(r.phase)) { try { cleanup(p, r); } catch { /* preserve exact owned evidence for retry */ } }
    }
    recoveryCompleted=true;return true;
  } finally {
    fence?.close();
    try{
      if(recoveryCompleted&&!options.deferMaintenance){
        try{p.lastCoordinatorCheckpoint=checkpointCoordinator(p);if(options.maintenance)options.maintenance.checkpoint=p.lastCoordinatorCheckpoint;}
        catch(error){p.coordinatorMaintenanceError=error.message;if(options.maintenance)options.maintenance.error=error.message;else process.stderr.write(`Coordinator recovery maintenance deferred: ${error.message}\n`);}
      }
    }finally{owner.close();}
  }
}
export function beginOperation(project) {
  const initialized=initializeCoordinator(project),p=initialized.p;
  let owner;
  try{owner=coordinatedOwner(p);}
  catch(error){try{initialized.coordination.close();}catch(closeError){throw new AggregateError([error,closeError],'Owner handoff and bootstrap close failed');}throw error;}
  try{initialized.coordination.close();}catch(error){try{owner?.close();}catch(ownerCloseError){throw new AggregateError([error,ownerCloseError],'Bootstrap and owner keeper close failed');}throw error;}
  if (!owner) throw new Error('Another publisher/recovery owns this project');
  let baselineFence;
  try {
    baselineFence=lease(p.writers,true);
    if(!baselineFence)throw new Error('Cannot capture build baseline while a write is active');
    if (state(p).mode !== 'idle') throw new Error('Recovery required before building');
    const id = crypto.randomUUID(), directory = path.join(p.runtime, id);
    fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, 'owner.json'), JSON.stringify({ operation: id }), { flag: 'wx' });
    const record = { version: 1, id, directory, active: p.active, candidate: path.join(directory, 'candidate.db'), backup: path.join(directory, 'old.db'), phase: 'building', oldIdentity: null, candidateIdentity: null, baselineRevision: 0 };
    gate(p, g => { const s=g.prepare('SELECT * FROM state WHERE id=1').get(); if(s.mode!=='idle')throw new Error('Publication state changed'); record.baselineRevision=s.revision; put(g,record); });
    baselineFence.close(); baselineFence=null;
    return { p, record, owner };
  } catch (e) { baselineFence?.close(); owner.close(); throw e; }
}
/** Invoke in a distinct publisher process, never on a participant's event loop. */
export async function publish(op, options = {}) {
  const { p, record, owner } = op;
  const metrics = { coordinatorKeeper:owner.diagnostic, buildMs: options.buildMs ?? 0, validationMs: 0, checkpointMs: 0, drainMs: 0, replaceMs: 0, reopenMs: 0, resumeMs: 0 };
  const hook = options.hook; let writers, fence, preparedConnection; let committed = false, admissionClosed = false, drainStart;
  try {
    operationPaths(p, record);
    let t = now();
    if (options.fail === 'space') throw Object.assign(new Error('Injected insufficient space'), { code: 'ENOSPC' });
    const available = fs.statfsSync(p.runtime); if (available.bavail * available.bsize < fs.statSync(record.candidate).size + 1024 * 1024) throw new Error('Insufficient free space');
    record.candidateIdentity = seal(record.candidate, { standalone: true }); noSidecars(record.candidate);
    await options.validate?.(record.candidate);
    noSidecars(record.candidate);
    if(sha(record.candidate)!==record.candidateIdentity)throw new Error('Candidate changed during validation');
    metrics.validationMs = now() - t;
    checkpoint(p, record, 'prepared', hook);
    // Writer exclusion begins BEFORE the expensive preflight/checkpoint/hash; readers continue.
    writers = lease(p.writers, true); if (!writers) throw new Error('Active writer changed baseline; retry publication later');
    if(state(p).revision!==record.baselineRevision)throw new Error('Active database was modified during candidate build; publication cancelled');
    await options.validateSource?.();
    t = now(); record.oldIdentity = seal(p.active, { integrity: false }); metrics.checkpointMs = now() - t;
    if (record.oldIdentity === record.candidateIdentity) throw new Error('Candidate is byte-identical; no replacement necessary');
    record.expectedRevision = state(p).revision;
    preparedConnection = new DatabaseSync(p.active, { readOnly: true });
    preparedConnection.prepare('PRAGMA data_version').get();
    // Final cheap state check, full source hashing deliberately stays outside switch window.
    options.finalSourceFence?.();
    t = now(); drainStart = t; const deadline = drainStart + (options.drainBudgetMs ?? 1000);
    gate(p, g => {
      const s = g.prepare('SELECT * FROM state WHERE id=1').get();
      if (s.mode !== 'idle' || s.revision !== record.expectedRevision) throw new Error('Active database changed during preflight');
      record.phase = 'draining'; put(g, record); g.prepare("UPDATE state SET mode='draining', operation=?, cancel=0 WHERE id=1").run(record.id);
    },{label:'publish-draining'});
    admissionClosed = true; hook?.('draining'); preparedConnection.close(); preparedConnection = null;
    while (true) {
      const s = state(p);
      if (s.cancel || now() >= deadline) throw Object.assign(new Error(s.cancel ? (s.cancel===2?'Admission budget requested drain cancellation':'Synchronous caller cancelled drain to avoid self-deadlock') : 'Drain budget exceeded'), { code: 'DRAIN_CANCELLED' });
      fence = lease(p.connections, true); if (fence) break;
      await delay(5);
    }
    metrics.drainMs = now() - t;
    gate(p, g => {
      const s = g.prepare('SELECT * FROM state WHERE id=1').get();
      if (s.cancel || s.revision !== record.expectedRevision || now() >= deadline) throw Object.assign(new Error('Drain cancelled before replacement'), { code: 'DRAIN_CANCELLED' });
      record.phase = 'replacing'; put(g, record); g.prepare("UPDATE state SET mode='replacing' WHERE id=1").run();
    },{label:'publish-replacing'});
    hook?.('replacing');
    // Last readonly closer can leave empty WAL/SHM. Let SQLite remove its own
    // logs; heavy checkpoint ran before drain while writes were excluded.
    const checkpointStarted=now();
    const finalCheckpoint=new DatabaseSync(p.active);
    try { finalCheckpoint.exec('PRAGMA busy_timeout=0'); if(finalCheckpoint.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy!==0) throw new Error('Final checkpoint is blocked'); } finally { finalCheckpoint.close(); }
    metrics.checkpointFinalMs=now()-checkpointStarted;
    // Do not unlink or carry SQLite sidecars across identities.
    noSidecars(p.active); noSidecars(record.candidate);
    t = now();
    if (options.fail === 'rename') throw Object.assign(new Error('Injected rename permission failure'), { code: 'EACCES' });
    move(p.active, record.backup, hook, 'old-rename'); hook?.('old-moved');
    move(record.candidate, p.active, hook, 'new-rename'); hook?.('new-moved');
    metrics.replaceMs = now() - t; t = now();
    // Only cheap availability check in window; full integrity/index checks already completed.
    const check = new DatabaseSync(p.active, { readOnly: true });
    try { check.prepare('SELECT count(*) FROM sqlite_master').get(); } finally { check.close(); }
    metrics.reopenMs = now() - t;
    hook?.('before-commit');
    gate(p, g => {
      record.phase='committed';put(g,record);g.prepare('DELETE FROM costs').run();
      g.prepare("UPDATE state SET mode='idle', operation=NULL, cancel=0, revision=revision+1 WHERE id=1").run();
    },{label:'publish-committed'});
    committed=true;hook?.('committed');t=now();
    // Commit is durable before releasing the file fence, even though WAL readers
    // may already observe idle. They cannot acquire a connection lease yet.
    fence.close();fence=null;
    admissionClosed=false;writers.close();writers=null;
    metrics.resumeMs = now() - t; metrics.admissionPauseMs = now() - drainStart;
    hook?.('resumed');
    let cleanupError;
    try { cleanup(p, record, options.fail === 'cleanup' ? () => { throw new Error('Injected cleanup sharing violation'); } : hook); }
    catch (e) { cleanupError = e.message; }
    return { status: 'published', operation: record.id, metrics, cleanupError, directoryFsync: process.platform !== 'win32' };
  } catch (e) {
    preparedConnection?.close(); preparedConnection = null;
    if (admissionClosed) {
      // Committed is a one-way boundary, including exceptions after COMMIT succeeds.
      const persisted = records(p).find(r => r.id === record.id);
      if (persisted?.phase === 'committed') { committed = true; setIdle(p, persisted); }
      else if (phasesBeforeRename.has(persisted?.phase)) { persisted.phase = 'aborted'; setIdle(p, persisted); }
      else {
        fence ??= lease(p.connections, true);
        if (!fence) throw new Error(`Recovery blocked; evidence retained: ${e.message}`);
        resolveOperation(p, persisted);
      }
    } else if (!committed) { record.phase = 'aborted'; gate(p, g => put(g, record)); }
    const persisted = records(p).find(r => r.id === record.id);
    try { cleanup(p, persisted); } catch { /* evidence retained, retry after restart */ }
    if(drainStart!==undefined){ if(!metrics.drainMs)metrics.drainMs=now()-drainStart; metrics.admissionPauseMs=now()-drainStart; }
    return { status: committed ? 'published' : 'cancelled', error: e.message, code: e.code, operation: record.id, metrics };
  } finally {
    preparedConnection?.close();fence?.close();writers?.close();
    // Post-fence maintenance keeps the same WAL lifetime anchor, but never a
    // snapshot. Closing it afterward must not reinterpret an acknowledged B.
    try{
      try{if(state(p).mode==='idle')metrics.coordinatorCheckpoint=checkpointCoordinator(p);else metrics.coordinatorCheckpointDeferred='unresolved publication';}catch(error){metrics.coordinatorMaintenanceError=error.message;}
    }finally{
      try{owner.close();}catch(error){metrics.coordinatorKeeperCloseError=error.message;}
    }
  }
}

function preActionBusy(error){
  const d=error.gateDiagnostic;
  return error.errcode===5 && !!d && !d.actionStarted && ['open','begin'].includes(d.phase);
}
function admissionTimeout(){return Object.assign(new Error('Admission exceeded total 1000ms budget; no unsafe fallback'),{code:'ADMISSION_TIMEOUT'});}

/** All graph handles (including cached readers) MUST be owned by factory's close().
 * Factory is synchronous and must not reenter this Participant. If it throws,
 * it must close any internal native handles that it has not returned to us.
 */
export class Participant {
  constructor(project, factory, options = {}) {
    const initialized=initializeCoordinator(project);
    this.p=initialized.p;this.coordination=initialized.coordination;
    try{
      this.p.readGates=options.readGates??process.env.CODEGRAPH_FIXED_PATH_READ_GATES==='1';
      if(options.measureGates??process.env.CODEGRAPH_FIXED_PATH_MEASURE_GATES==='1')this.p.gateMetrics=[];
      this.factory=factory;this.options=options;this.active=0;this.handle=null;this.holder=null;this.closed=false;this.reopens=0;this.reopenDurationsMs=[];this.admissionWaitMs=[];
      recoverInitialized(this.p,{deferMaintenance:true});
      this.coordinationIdentity=fs.statSync(this.p.gate,{bigint:true});
      // Conservative startup invalidation is outside query admission. A missing
      // history never triggers indexing; publication invalidates in its commit.
      if(this.coordination.prepare('SELECT 1 FROM costs LIMIT 1').get())gate(this.p,g=>{if(g.prepare('SELECT 1 FROM costs LIMIT 1').get())g.prepare('DELETE FROM costs').run();},{label:'startup-cost-invalidation'});
      this.timer=setInterval(()=>{try{this.retireIfNeeded();}catch(e){this.backgroundError=e;}},options.pollMs??10);this.timer.unref();
    }catch(error){
      try{this.coordination.close();}catch(closeError){throw new AggregateError([error,closeError],'Participant startup and keeper close failed');}finally{this.coordination=null;}
      throw error;
    }
  }

  readSnapshot(action,deadline=Infinity,label='read-state') {
    const start=now(),metrics={label,readOnly:true,startedAtMs:Date.now(),phase:'begin',actionStarted:false,openMs:0,beginMs:0,actionMs:0,commitMs:0,closeMs:0,retries:0};
    regular(this.p.gate);const identity=fs.statSync(this.p.gate,{bigint:true});
    if(identity.dev!==this.coordinationIdentity.dev || identity.ino!==this.coordinationIdentity.ino)throw new Error('Coordination file identity changed; restart/recovery required');
    if(!this.coordination)this.coordination=openCoordinatorBounded(this.p,deadline);
    const d=this.coordination;let began=false,committed=false,failure;
    try{
      if(now()>=deadline)throw admissionTimeout();
      d.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=0');
      let t=now();d.exec('BEGIN');began=true;metrics.beginMs=now()-t;
      metrics.phase='action';metrics.actionStarted=true;t=now();const result=action(d);metrics.actionMs=now()-t;
      if(now()>=deadline)throw admissionTimeout();
      metrics.phase='commit';t=now();d.exec('COMMIT');committed=true;metrics.commitMs=now()-t;metrics.phase='complete';return result;
    }catch(error){failure=error;
      if(began&&!committed){try{d.exec('ROLLBACK');}catch(rollbackError){failure=new AggregateError([error,rollbackError],'WAL read rollback failed');}}
      try{d.close();this.coordination=null;}catch(closeError){failure=new AggregateError([failure,closeError],'WAL read connection close failed');}
      throw failure;
    }finally{metrics.totalMs=now()-start;gateDiagnostic(this.p,metrics,failure);this.p.gateMetrics?.push(metrics);}
  }
  retireIfNeeded(deadline) {
    if(this.active!==0 || (!this.handle && !this.holder))return;
    // A fresh WAL snapshot observes durable mode without taking a writer gate.
    // A concurrent uncommitted draining state is safe: our lease blocks rename.
    const observed=this.readSnapshot(g=>g.prepare('SELECT mode FROM state WHERE id=1').get(),deadline,'retire-state');
    if(observed.mode!=='idle')this.closeHandle();
  }
  closeHandle() {
    if (this.handle) { this.handle.close(); this.handle = null; }
    this.holder?.close(); this.holder = null;
  }
  admit(writing = false, deadline = Infinity) {
    if (this.closed) throw new Error('Participant closed');
    const previousHandle=this.handle, previousHolder=this.holder;
    // Only an existing native handle AND its real cross-process connection lease
    // permit read admission; cold admission/lease acquisition and durable writes
    // still use the exclusive gate (native opening follows gate COMMIT).
    let writeLease,counted=false;
    try {
      let admitted;
      if(!writing){
        // Lease first, then begin a NEW snapshot. A prior cached/preliminary idle
        // observation is never authority to open the graph after publication.
        this.options.hook?.('before-read-lease');
        if(!this.holder){this.holder=lease(this.p.connections);if(!this.holder)return false;}
        this.options.hook?.('after-read-lease');
        admitted=this.readSnapshot(g=>{
          const state=g.prepare('SELECT * FROM state WHERE id=1').get();
          this.options.hook?.('read-state',state);
          if(state.mode!=='idle')return false;
          this.active++;counted=true;return true;
        },deadline,'admit-wal-read');
        if(!admitted && !previousHolder){this.holder.close();this.holder=null;}
      }else{
        admitted=gate(this.p,g=>{
          const state=g.prepare('SELECT * FROM state WHERE id=1').get();
          if(state.mode!=='idle')return false;
          writeLease=lease(this.p.writers);if(!writeLease)return false;
          if(!this.holder){this.holder=lease(this.p.connections);if(!this.holder){writeLease.close();writeLease=null;return false;}}
          g.prepare('UPDATE state SET revision=revision+1 WHERE id=1').run();
          this.active++;counted=true;return writeLease;
        },{deadline,label:'admit-write'});
      }
      if(admitted && now()>=deadline)throw admissionTimeout();
      if (admitted && !this.handle) {
        // The committed admission already owns a real connection lease and is
        // counted active. A publisher may start draining, but cannot rename the
        // database until this operation and native handle release that lease.
        // Opening a large graph must NOT serialize every process under gate.
        // No await is allowed here: same-process retirement cannot interleave.
        regular(this.p.active);
        const openedAt=now();this.handle=this.factory(this.p.active);
        this.reopenDurationsMs.push(now()-openedAt); this.reopens++;
      }
      if(admitted && now()>=deadline)throw admissionTimeout();
      return admitted;
    } catch(error) {
      // A coordination COMMIT can fail AFTER action allocated native resources.
      // Undo only this admission; never close a handle borrowed by an older request.
      if(counted)this.active--;
      try {
        if(this.handle && this.handle!==previousHandle){this.handle.close();this.handle=previousHandle;}
        if(this.holder && this.holder!==previousHolder){this.holder.close();this.holder=previousHolder;}
      } catch(cleanupError){throw new AggregateError([error,cleanupError],'Admission failed; native handle retained under lease');}
      finally {writeLease?.close();}
      throw error;
    }
  }
  finish() { this.active--; this.retireIfNeeded(); }
  cancelDrainNearDeadline(deadline) {
    if(deadline-now()>250)return;
    // Cancel only before replacement, leaving time for the publisher to restore
    // admission. A timeout must never roll back a committed/new writable DB.
    gate(this.p,g=>{
      const s=g.prepare('SELECT mode,cancel FROM state WHERE id=1').get();
      if(s.mode==='draining' && !s.cancel)g.prepare('UPDATE state SET cancel=2 WHERE id=1').run();
    },{deadline,label:'admission-deadline-cancel'});
  }
  publisherContention(error) {
    if(!preActionBusy(error))return false;
    const owner=lease(this.p.owner,true);
    if(owner){owner.close();return false;}
    return true;
  }
  retryableAdmission(error, deadline) {
    // A held publisher/recovery OS lease authorizes only another bounded attempt,
    // never a fallback database or a change to persistent publication state.
    if(!preActionBusy(error))return false;
    if(now()>=deadline)throw admissionTimeout();
    const retry=this.publisherContention(error);
    if(now()>=deadline)throw admissionTimeout();
    return retry;
  }
  async request(action, writing = false) {
    const started=now(),deadline=started+Math.min(this.options.waitMs??1000,1000);let admission;
    while(!admission){
      if(now()>=deadline)throw admissionTimeout();
      try{admission=this.admit(writing,deadline);}catch(error){if(!this.retryableAdmission(error,deadline))throw error;}
      if(admission)break;
      try{this.cancelDrainNearDeadline(deadline);this.retireIfNeeded(deadline);recoverInitialized({...this.p,requestDeadline:deadline},{deferMaintenance:true});}catch(error){if(!this.retryableAdmission(error,deadline))throw error;}
      if(now()>=deadline)throw admissionTimeout();
      await delay(Math.min(5,deadline-now()));
    }
    this.admissionWaitMs.push(now()-started);
    try { return await action(this.handle); } finally {
      // Intent was durable before action. No post-COMMIT revision write is needed.
      try { if (writing) admission.close(); } finally { this.finish(); }
    }
  }
  requestSync(action, writing = false) {
    const started=now(),deadline=started+Math.min(this.options.waitMs??1000,1000);
    let admission;
    while(true){
      if(now()>=deadline)throw admissionTimeout();
      let admitted=false;
      try{admitted=this.admit(writing,deadline);admission=admitted;}catch(error){if(!this.retryableAdmission(error,deadline))throw error;}
      if(admitted)break;
      try{
      this.cancelDrainNearDeadline(deadline);
      // Never wait on this event loop's own unfinished async operation. Publication
      // is in another process and can cancel without waiting for us to finish.
      if (this.active > 0) gate(this.p, g => {
        const s = g.prepare('SELECT * FROM state WHERE id=1').get();
        if(s.mode==='idle')return; // Publisher may have cancelled since admit().
        if(s.mode==='recovering'){
          const row=g.prepare('SELECT record FROM operations WHERE id=?').get(s.operation);
          if(row && phasesBeforeRename.has(JSON.parse(row.record).phase))return;
        }
        if (s.mode !== 'draining') throw new Error('Illegal replacement with a live local request');
        g.prepare('UPDATE state SET cancel=1 WHERE id=1').run();
      },{deadline});
      else this.retireIfNeeded(deadline);
      recoverInitialized({...this.p,requestDeadline:deadline},{deferMaintenance:true});
      }catch(error){if(!this.retryableAdmission(error,deadline))throw error;}
      if(now()>=deadline)throw admissionTimeout();
      Atomics.wait(pause, 0, 0, 2);
    }
    this.admissionWaitMs.push(now()-started);
    try { const result = action(this.handle); if (result?.then) throw new Error('requestSync action returned a Promise'); return result; } finally { try { if(writing)admission.close(); } finally { this.finish(); } }
  }
  async write(action) { return this.request(action, true); }
  close() {
    if (this.active) throw new Error('Cannot close participant with active requests');
    clearInterval(this.timer);this.closeHandle();this.coordination?.close();this.coordination=null;this.closed=true;
    // Clean offline-overwrite shutdown includes SQLite-owned sidecar cleanup.
    // This is outside the cutover hot path and never deletes journal files itself.
    gate(this.p, g => {
      if(g.prepare('SELECT mode FROM state WHERE id=1').get().mode!=='idle')return;
      const fence=lease(this.p.connections,true); if(!fence)return;
      try {
        if(['-wal','-shm','-journal'].some(s=>fs.existsSync(this.p.active+s))){
          regular(this.p.active); const connection=new DatabaseSync(this.p.active);
          try{connection.exec('PRAGMA busy_timeout=0'); if(connection.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy!==0)throw new Error('Clean shutdown checkpoint blocked');}finally{connection.close();}
          noSidecars(this.p.active);
        }
      }finally{fence.close();}
    });
  }
}
