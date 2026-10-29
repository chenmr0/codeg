/** PHASE ONE ONLY. Not imported by production code.
 * Cooperative local-filesystem protocol. Unknown/legacy SQLite users are NOT fenced.
 * OS-backed SQLite leases, not PID/mtime, establish publisher/connection ownership.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

const ID = /^[a-f0-9-]{36}$/;
const phasesBeforeRename = new Set(['building', 'prepared', 'draining']);
const pause = new Int32Array(new SharedArrayBuffer(4));
export const now = () => performance.now();
export function paths(project) {
  const data = path.join(path.resolve(project), '.codegraph-wx');
  const runtime = path.join(data, '.runtime', 'fixed-path-prototype');
  return { project: path.resolve(project), data, runtime, active: path.join(data, 'codegraph.db'), gate: path.join(runtime, 'gate.sqlite'), connections: path.join(runtime, 'connections.sqlite'), owner: path.join(runtime, 'publisher.sqlite'), writers: path.join(runtime, 'writers.sqlite') };
}
function regular(file, missing = false) {
  try { if (!fs.lstatSync(file).isFile()) throw new Error(`Unsafe non-regular file: ${file}`); }
  catch (e) { if (!(missing && e.code === 'ENOENT')) throw e; }
}
function directory(file) { if (!fs.lstatSync(file).isDirectory()) throw new Error(`Unsafe directory: ${file}`); }
function db(file, validateMode = true, busyMs = 25) {
  regular(file, true); regular(file + '-journal', true);
  const connection = new DatabaseSync(file);
  try {
    connection.exec(`PRAGMA busy_timeout=${busyMs}; PRAGMA synchronous=FULL`);
    if (validateMode && Object.values(connection.prepare('PRAGMA journal_mode').get())[0] !== 'delete') throw new Error('Coordination database must use DELETE journal mode');
    return connection;
  } catch (e) { connection.close(); throw e; }
}
export function initialize(project) {
  const p = paths(project);
  fs.mkdirSync(p.runtime, { recursive: true });
  directory(p.data); directory(path.dirname(p.runtime)); directory(p.runtime);
  gate(p, g => {
    const established=!!g.prepare("SELECT name FROM sqlite_master WHERE name='state'").get();
    for (const file of [p.connections, p.owner, p.writers]) {
      if (fs.existsSync(file)) { regular(file); continue; }
      if(established)throw new Error('Missing protocol lease database; cannot safely reconstruct live locks');
      const d = db(file);
      try { d.exec('CREATE TABLE lease(value INTEGER); INSERT INTO lease VALUES(1)'); } finally { d.close(); }
    }
    if (!g.prepare("SELECT name FROM sqlite_master WHERE name='state'").get()) g.exec(`CREATE TABLE state(id INTEGER PRIMARY KEY CHECK(id=1), mode TEXT NOT NULL, operation TEXT, cancel INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0);
      INSERT INTO state(id,mode) VALUES(1,'idle');
      CREATE TABLE operations(id TEXT PRIMARY KEY, record TEXT NOT NULL);
      CREATE TABLE costs(identity TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  });
  return p;
}
function gateDiagnostic(p,metrics,error){
  const record={...metrics,pid:process.pid,project:p.project,finishedAtMs:Date.now(),error:error?.message,code:error?.code,errcode:error?.errcode};
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
  const deadline=started+500;let g;
  while(true){
    try{
      metrics.phase='open';let t=now();try{g=db(p.gate,true,0);}finally{metrics.openMs+=now()-t;}
      metrics.phase='begin';t=now();try{
        if(options.readOnly)g.exec('PRAGMA query_only=ON');
        g.exec(options.readOnly?'BEGIN':'BEGIN IMMEDIATE');
        // Acquire SHARED before action, so retries cannot replay partial work.
        if(options.readOnly)g.prepare('SELECT id FROM state WHERE id=1').get();
      }finally{metrics.beginMs+=now()-t;}
      metrics.acquiredAtMs=Date.now();break;
    }catch(error){
      const t=now();g?.close();metrics.closeMs+=now()-t;g=null;
      if(!String(error.message).includes('locked')||now()>=deadline){metrics.totalMs=now()-started;gateDiagnostic(p,metrics,error);p.gateMetrics?.push(metrics);throw error;}
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
export function state(p) { return gate(p, g => g.prepare('SELECT * FROM state WHERE id=1').get(),{readOnly:!!p.readGates,label:'state'}); }
function put(g, record) { g.prepare('INSERT OR REPLACE INTO operations VALUES (?,?)').run(record.id, JSON.stringify(record)); }
export function records(p) { return gate(p, g => g.prepare('SELECT record FROM operations').all().map(r => JSON.parse(r.record))); }
export function lease(file, exclusive = false) {
  regular(file);
  let d;
  try { d = db(file, false); d.exec('PRAGMA busy_timeout=0'); d.exec(exclusive ? 'BEGIN EXCLUSIVE' : 'BEGIN'); if (!exclusive) d.prepare('SELECT value FROM lease').get(); if (Object.values(d.prepare('PRAGMA journal_mode').get())[0] !== 'delete') throw new Error('Lease database must use DELETE mode'); }
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
  gate(p, g => put(g, record));
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
  const allowed = new Set(['owner.json', 'candidate.db', 'old.db', ...(unsealed ? ['candidate.db-wal','candidate.db-shm','candidate.db-journal'] : [])]);
  // Unexpected sidecars or files preserve all evidence; no age-based rmtree.
  if (names.some(n => !allowed.has(n))) throw new Error('Unexpected operation artifacts; preserved for diagnosis');
  for (const [file, expected] of [[record.backup, record.oldIdentity], [record.candidate, record.candidateIdentity]]) {
    if (!fs.existsSync(file)) continue;
    if (file === record.candidate && unsealed) regular(file);
    else if (!expected || sha(file) !== expected) throw new Error('Refusing cleanup of an unknown artifact');
    hook?.('cleanup'); fs.unlinkSync(file);
  }
  if (unsealed) for (const suffix of ['-wal','-shm','-journal']) { const file=record.candidate+suffix; if(fs.existsSync(file)) { regular(file); fs.unlinkSync(file); } }
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
  return recoverInitialized(initialize(project),options);
}
// Existing participants already validated the layout; do not acquire the gate
// merely to discover that a live publisher owns recovery. Missing lock files
// still fail in lease(), and external callers retain full initialize validation.
function recoverInitialized(p, options = {}) {
  const owner = lease(p.owner, true);
  if (!owner) return false;
  let fence;
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
    return true;
  } finally { fence?.close(); owner.close(); }
}
export function beginOperation(project) {
  const p = initialize(project), owner = lease(p.owner, true);
  if (!owner) throw new Error('Another publisher/recovery owns this project');
  let baselineFence;
  try {
    baselineFence=lease(p.writers,true);
    if(!baselineFence)throw new Error('Cannot capture build baseline while a write is active');
    if (state(p).mode !== 'idle') throw new Error('Recovery required before building');
    const id = crypto.randomUUID(), directory = path.join(p.runtime, id);
    fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, 'owner.json'), JSON.stringify({ operation: id }), { flag: 'wx' });
    const record = { version: 1, id, directory, active: p.active, candidate: path.join(directory, 'candidate.db'), backup: path.join(directory, 'old.db'), phase: 'building', oldIdentity: null, candidateIdentity: null };
    gate(p, g => { const s=g.prepare('SELECT * FROM state WHERE id=1').get(); if(s.mode!=='idle')throw new Error('Publication state changed'); record.baselineRevision=s.revision; put(g,record); });
    baselineFence.close(); baselineFence=null;
    return { p, record, owner };
  } catch (e) { baselineFence?.close(); owner.close(); throw e; }
}
/** Invoke in a distinct publisher process, never on a participant's event loop. */
export async function publish(op, options = {}) {
  const { p, record, owner } = op;
  const metrics = { buildMs: options.buildMs ?? 0, validationMs: 0, checkpointMs: 0, drainMs: 0, replaceMs: 0, reopenMs: 0, resumeMs: 0 };
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
    });
    admissionClosed = true; hook?.('draining'); preparedConnection.close(); preparedConnection = null;
    while (true) {
      const s = state(p);
      if (s.cancel || now() >= deadline) throw Object.assign(new Error(s.cancel ? 'Synchronous caller cancelled drain to avoid self-deadlock' : 'Drain budget exceeded'), { code: 'DRAIN_CANCELLED' });
      fence = lease(p.connections, true); if (fence) break;
      await delay(5);
    }
    metrics.drainMs = now() - t;
    gate(p, g => {
      const s = g.prepare('SELECT * FROM state WHERE id=1').get();
      if (s.cancel || s.revision !== record.expectedRevision || now() >= deadline) throw Object.assign(new Error('Drain cancelled before replacement'), { code: 'DRAIN_CANCELLED' });
      record.phase = 'replacing'; put(g, record); g.prepare("UPDATE state SET mode='replacing' WHERE id=1").run();
    });
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
    move(p.active, record.backup, hook, 'old-rename'); checkpoint(p, record, 'old-moved', hook);
    move(record.candidate, p.active, hook, 'new-rename'); checkpoint(p, record, 'new-moved', hook);
    metrics.replaceMs = now() - t; t = now();
    // Only cheap availability check in window; full integrity/index checks already completed.
    const check = new DatabaseSync(p.active, { readOnly: true });
    try { check.prepare('SELECT count(*) FROM sqlite_master').get(); } finally { check.close(); }
    metrics.reopenMs = now() - t;
    hook?.('before-commit');
    gate(p, g => { record.phase = 'committed'; put(g, record); g.prepare('DELETE FROM costs').run(); });
    committed = true; hook?.('committed'); t = now();
    gate(p, g => g.prepare("UPDATE state SET mode='idle', operation=NULL, cancel=0, revision=revision+1 WHERE id=1").run());
    admissionClosed = false; fence.close(); fence = null; writers.close(); writers = null;
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
  } finally { preparedConnection?.close(); fence?.close(); writers?.close(); owner.close(); }
}

/** All graph handles (including cached readers) MUST be owned by factory's close().
 * Factory is synchronous and must not reenter this Participant. If it throws,
 * it must close any internal native handles that it has not returned to us.
 */
export class Participant {
  constructor(project, factory, options = {}) {
    this.p = initialize(project);this.p.readGates=options.readGates??process.env.CODEGRAPH_PROTOTYPE_READ_GATES==='1';if(options.measureGates??process.env.CODEGRAPH_PROTOTYPE_MEASURE_GATES==='1')this.p.gateMetrics=[]; this.factory = factory; this.options = options; this.active = 0; this.handle = null; this.holder = null; this.closed = false; this.reopens = 0; this.reopenDurationsMs = []; this.admissionWaitMs = [];
    recoverInitialized(this.p);
    this.timer = setInterval(() => { try { this.retireIfNeeded(); } catch (e) { this.backgroundError = e; } }, options.pollMs ?? 10); this.timer.unref();
  }
  retireIfNeeded() {
    if(this.active!==0 || (!this.handle && !this.holder))return;
    // Observation cannot admit a request or release a live reader. It never needs
    // a reserved write lock, including in the exclusive-admission baseline.
    const observed=gate(this.p,g=>g.prepare('SELECT mode FROM state WHERE id=1').get(),{readOnly:true,label:'retire-state'});
    if(observed.mode!=='idle')this.closeHandle();
  }
  closeHandle() {
    if (this.handle) { this.handle.close(); this.handle = null; }
    this.holder?.close(); this.holder = null;
  }
  admit(writing = false) {
    if (this.closed) throw new Error('Participant closed');
    const previousHandle=this.handle, previousHolder=this.holder;
    // Only an existing native handle AND its real cross-process connection lease
    // permit read admission; cold admission/lease acquisition and durable writes
    // still use the exclusive gate (native opening follows gate COMMIT).
    let writeLease, counted=false;const warm=!!(this.handle&&this.holder),readOnly=!!(this.p.readGates&&!writing&&warm);
    try { const admitted=gate(this.p, g => {
      const s = g.prepare('SELECT * FROM state WHERE id=1').get();
      if (s.mode !== 'idle') return false;
      if (writing) { writeLease = lease(this.p.writers); if (!writeLease) return false; }
      if (!this.holder) { this.holder = lease(this.p.connections); if (!this.holder) { writeLease?.close(); writeLease=null; return false; } }
      if (!this.handle) { regular(this.p.active);
        // Empty DELETE still commits a SQLite write. The gate already excludes
        // concurrent insertions; only a nonempty history needs invalidation.
        if(g.prepare('SELECT 1 FROM costs LIMIT 1').get())g.prepare('DELETE FROM costs').run(); }
      // Durable intent precedes ANY application write. A crash after SQLite COMMIT
      // but before callback/finally cannot make the publisher miss that mutation.
      if(writing)g.prepare('UPDATE state SET revision=revision+1 WHERE id=1').run();
      this.active++; counted=true; return writing ? writeLease : true;
    },{readOnly,label:writing?'admit-write':readOnly?'admit-warm-read':warm?'admit-warm-exclusive':'admit-cold'});
      if (admitted && !this.handle) {
        // The committed admission already owns a real connection lease and is
        // counted active. A publisher may start draining, but cannot rename the
        // database until this operation and native handle release that lease.
        // Opening a large graph must NOT serialize every process under gate.
        // No await is allowed here: same-process retirement cannot interleave.
        const openedAt=now(); this.handle=this.factory(this.p.active);
        this.reopenDurationsMs.push(now()-openedAt); this.reopens++;
      }
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
  async request(action, writing = false) {
    const started = now(); let admission;
    while (!(admission = this.admit(writing))) { this.retireIfNeeded(); recoverInitialized(this.p); if (now()-started > (this.options.waitMs ?? 5000)) throw new Error('Admission timeout; no unsafe fallback'); await delay(5); }
    this.admissionWaitMs.push(now()-started);
    try { return await action(this.handle); } finally {
      // Intent was durable before action. No post-COMMIT revision write is needed.
      try { if (writing) admission.close(); } finally { this.finish(); }
    }
  }
  requestSync(action) {
    const started = now();
    while (!this.admit()) {
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
      });
      else this.retireIfNeeded();
      recoverInitialized(this.p);
      if (now()-started > (this.options.waitMs ?? 5000)) throw new Error('Synchronous admission timeout; publisher must be an independent process');
      Atomics.wait(pause, 0, 0, 2);
    }
    this.admissionWaitMs.push(now()-started);
    try { const result = action(this.handle); if (result?.then) throw new Error('requestSync action returned a Promise'); return result; } finally { this.finish(); }
  }
  async write(action) { return this.request(action, true); }
  close() {
    if (this.active) throw new Error('Cannot close participant with active requests');
    clearInterval(this.timer); this.closeHandle(); this.closed = true;
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
