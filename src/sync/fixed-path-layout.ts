/** Explicit, offline-only migration. This does not fence old binaries or external
 * SQLite tools: the caller must first stop them. Normal opens recover a recorded
 * migration before admitting connections. No production entrypoint is enabled here. */
import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { resolveGeneration } from './generation-store';
import { withLifecycleGate, collectLifecycleGenerations, removeSealedGenerations } from './generation-lifecycle';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
interface LayoutMarker { version: 1; layout: 'fixed-path-v1'; migrationId: string; }
interface RecordState {
  version: 1; id: string; offlineAuthorized: true; outcome: 'committed' | 'aborted' | null; phase: 'preparing' | 'installing' | 'committed' | 'aborted' | 'cleaned';
  source: string; sourceIdentity: string; writerToken: string; generation: string | null; candidateIdentity: string | null;
}
interface Sqlite {
  exec(sql: string): void;
  prepare(sql: string): { run(...args: unknown[]): unknown; get(...args: unknown[]): any; all(...args: unknown[]): any[] };
  close(): void;
}
export interface FixedPathMigrationOptions {
  /** Explicit attestation that all old CodeGraph processes and external tools are stopped. */
  offline: true;
  /** Additional CodeGraph version/completeness validation. Must not modify the database. */
  validateDatabase?: (databasePath: string) => void;
  /** Fault injection/diagnostics; never used as an authority. */
  hook?: (phase: string) => void;
}
export interface FixedPathMigrationResult {
  databasePath: string;
  layout: 'fixed';
  /** Reclamation is conservative; unmanaged legacy directories are retained. */
  cleanup: Promise<void>;
  cleanupWarnings: readonly string[];
}
function names(dataDir: string) {
  const root = path.resolve(dataDir), runtime = path.join(root, '.runtime');
  const migrations = path.join(runtime, 'layout-migrations');
  return { root, runtime, migrations, active: path.join(root, 'codegraph.db'), marker: path.join(runtime, 'layout.json'),
    journal: path.join(migrations, 'state.sqlite'), lock: path.join(migrations, 'owner.sqlite') };
}
function exists(file: string): boolean {
  try { fs.lstatSync(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function regular(file: string): void { if (!fs.lstatSync(file).isFile()) throw new Error(`Unsafe migration file: ${file}`); }
function directory(file: string): void { if (!fs.lstatSync(file).isDirectory()) throw new Error(`Unsafe migration directory: ${file}`); }
function directories(p: ReturnType<typeof names>, create: boolean): void {
  directory(p.root);
  for (const dir of [p.runtime, p.migrations]) {
    if (create && !exists(dir)) fs.mkdirSync(dir);
    if (exists(dir)) directory(dir);
  }
}
function sqlite(file: string, readOnly = false): Sqlite {
  if (exists(file)) regular(file);
  for (const suffix of ['-journal','-wal','-shm']) if (exists(file + suffix)) regular(file + suffix);
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly }) as Sqlite;
  try {
    db.exec('PRAGMA busy_timeout=0');
    if (!readOnly) db.exec('PRAGMA synchronous=FULL');
    if (Object.values(db.prepare('PRAGMA journal_mode').get())[0] !== 'delete') throw new Error('Migration metadata must use DELETE journal mode');
    return db;
  } catch (error) { db.close(); throw error; }
}
function hash(file: string): string {
  regular(file); const fd = fs.openSync(file, 'r'), digest = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
  try { let size: number; while ((size = fs.readSync(fd, buffer, 0, buffer.length, null)) !== 0) digest.update(buffer.subarray(0, size)); }
  finally { fs.closeSync(fd); }
  return digest.digest('hex');
}
function syncFile(file: string): void { const fd = fs.openSync(file, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function syncDirectory(dir: string): void {
  // Process-crash recovery is tested separately from unproven power-loss durability.
  if (process.platform === 'win32') return;
  const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function noSidecars(file: string): void {
  for (const suffix of ['-wal','-shm','-journal']) if (exists(file + suffix)) throw new Error(`Unresolved SQLite sidecar; close/checkpoint normally first: ${file + suffix}`);
}
function validate(file: string, extra?: (file: string) => void): void {
  regular(file); noSidecars(file);
  const header=Buffer.alloc(16), fd=fs.openSync(file,'r');
  try { if (fs.statSync(file).size < 100 || fs.readSync(fd,header,0,16,0) !== 16 || header.toString('binary') !== 'SQLite format 3\0') throw new Error('Invalid SQLite snapshot header'); }
  finally { fs.closeSync(fd); }
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=FULL');
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('Invalid migration database');
    const checkpoint=db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if (checkpoint.busy !== 0) throw new Error('Migration checkpoint blocked');
    if (Object.values(db.prepare('PRAGMA journal_mode=DELETE').get())[0] !== 'delete') throw new Error('Cannot seal migration snapshot');
  }
  finally { db.close(); }
  noSidecars(file); extra?.(file);
}
function marker(p: ReturnType<typeof names>): LayoutMarker | null {
  if (!exists(p.marker)) return null;
  regular(p.marker);
  if (fs.statSync(p.marker).size > 4096) throw new Error('Fixed layout marker too large');
  const value = JSON.parse(fs.readFileSync(p.marker, 'utf8')) as Partial<LayoutMarker>;
  if (value.version !== 1 || value.layout !== 'fixed-path-v1' || typeof value.migrationId !== 'string' || !UUID.test(value.migrationId) ||
      Object.keys(value).some(key => !['version','layout','migrationId'].includes(key))) throw new Error('Invalid fixed layout marker');
  return value as LayoutMarker;
}
function records(p: ReturnType<typeof names>, readOnly = true): RecordState[] {
  if (!exists(p.journal)) return [];
  const db = sqlite(p.journal, readOnly);
  try { return db.prepare('SELECT record FROM migrations').all().map(row => parseRecord(p, JSON.parse(row.record))); }
  finally { db.close(); }
}
function parseRecord(p: ReturnType<typeof names>, value: RecordState): RecordState {
  if (!value || value.version !== 1 || !UUID.test(value.id) || value.offlineAuthorized !== true ||
      !['preparing','installing','committed','aborted','cleaned'].includes(value.phase) || ![null,'committed','aborted'].includes(value.outcome) || !UUID.test(value.writerToken) ||
      !/^[a-f0-9]{64}$/.test(value.sourceIdentity) ||
      (value.candidateIdentity !== null && !/^[a-f0-9]{64}$/.test(value.candidateIdentity))) throw new Error('Invalid migration recovery record');
  if ((['preparing','installing'].includes(value.phase) && value.outcome !== null) ||
      (value.phase === 'committed' && value.outcome !== 'committed') ||
      (value.phase === 'aborted' && value.outcome !== 'aborted') ||
      (value.phase === 'cleaned' && value.outcome === null)) throw new Error('Inconsistent migration phase/outcome');
  if (value.generation !== null && !/^g-[a-zA-Z0-9-]{1,100}$/.test(value.generation)) throw new Error('Unsafe migration generation');
  const expected = value.generation === null ? p.active : path.join(p.root,'generations',value.generation,'codegraph.db');
  if (value.source !== expected) throw new Error('Unsafe migration source');
  return value;
}
function save(p: ReturnType<typeof names>, record: RecordState): void {
  parseRecord(p, record); const db = sqlite(p.journal);
  try {
    db.exec('BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS migrations(id TEXT PRIMARY KEY, record TEXT NOT NULL)');
    db.prepare('INSERT OR REPLACE INTO migrations VALUES (?,?)').run(record.id, JSON.stringify(record)); db.exec('COMMIT');
  } finally { db.close(); }
}
function ownedPaths(p: ReturnType<typeof names>, record: RecordState) {
  const dir = path.join(p.migrations, record.id);
  return { dir, candidate: path.join(dir, 'candidate.db'), owner: path.join(dir, 'owner.json'), stagedMarker: path.join(dir,'layout.json') };
}
function checkOwned(p: ReturnType<typeof names>, record: RecordState): ReturnType<typeof ownedPaths> {
  const files = ownedPaths(p, record); directory(files.dir); regular(files.owner);
  if (fs.statSync(files.owner).size > 4096 || fs.readFileSync(files.owner,'utf8') !== JSON.stringify({version:1,operation:record.id})) throw new Error('Migration owner mismatch');
  for (const name of fs.readdirSync(files.dir)) {
    if (!['owner.json','candidate.db','layout.json'].includes(name)) throw new Error('Unknown migration artifacts preserved');
    regular(path.join(files.dir,name));
  }
  return files;
}
function mutex<T>(p: ReturnType<typeof names>, action: () => T): T {
  directories(p, true);
  const db = sqlite(p.lock);
  try {
    db.exec('CREATE TABLE IF NOT EXISTS owner(value INTEGER); BEGIN EXCLUSIVE');
    return action();
  } finally { db.close(); }
}
function cleanupOperation(p: ReturnType<typeof names>, record: RecordState): void {
  const files = ownedPaths(p, record);
  if (!exists(files.dir)) { if (record.phase === 'cleaned') return; throw new Error('Migration evidence directory missing'); }
  if (record.phase === 'cleaned' && fs.readdirSync(files.dir).length === 0) { fs.rmdirSync(files.dir); return; }
  checkOwned(p, record);
  if (exists(files.candidate)) {
    // A partial copy belongs exclusively to this offline operation. Never follow links.
    if (record.candidateIdentity !== null && hash(files.candidate) !== record.candidateIdentity) throw new Error('Unknown candidate retained');
    fs.unlinkSync(files.candidate);
  }
  if (exists(files.stagedMarker)) {
    if (fs.readFileSync(files.stagedMarker,'utf8') !== JSON.stringify({version:1,layout:'fixed-path-v1',migrationId:record.id})) throw new Error('Unknown staged marker retained');
    fs.unlinkSync(files.stagedMarker);
  }
  record.phase = 'cleaned'; save(p, record);
  fs.unlinkSync(files.owner); fs.rmdirSync(files.dir);
}
const deferredCleanups = new Map<string, Map<string, string>>();
function deferCommittedCleanup(p: ReturnType<typeof names>, record: RecordState, error: unknown): void {
  const warnings=deferredCleanups.get(p.root) ?? new Map<string,string>();
  const message=`Fixed-path migration ${record.id} committed; cleanup deferred: ${String(error)}`;
  if (!warnings.has(record.id)) console.warn(`[codegraph] ${message}`);
  warnings.set(record.id,message); deferredCleanups.set(p.root,warnings);
}
function finishCommittedCleanup(p: ReturnType<typeof names>, record: RecordState): boolean {
  try {
    cleanupOperation(p,record);
    const writerPath=path.join(p.root,'codegraph.lock');
    if (!exists(writerPath) || fs.readFileSync(writerPath,'utf8') !== record.writerToken) deferredCleanups.get(p.root)?.delete(record.id);
    return true;
  }
  catch (error) { deferCommittedCleanup(p,record,error); return false; }
}
const reclamations = new Map<string, Promise<void>>();
function reclaim(p: ReturnType<typeof names>): Promise<void> {
  if (!exists(path.join(p.root, '.generation-lifecycle.sqlite'))) return Promise.resolve();
  const previous = reclamations.get(p.root) ?? Promise.resolve();
  const task = previous.then(async () => {
    try {
      const ids = withLifecycleGate(p.root, gate => collectLifecycleGenerations(gate, null));
      await removeSealedGenerations(p.root, ids);
    } catch { /* Known old readers delay GC; never invalidate active root. */ }
  });
  reclamations.set(p.root, task);
  void task.finally(() => { if (reclamations.get(p.root) === task) reclamations.delete(p.root); });
  return task;
}
/** Cheap authoritative layout selection; no CURRENT parsing after fixed commit.
 * Call recoverFixedPathMigration first if this reports pending recovery. */
export function inspectFixedPathLayout(dataDir: string): 'legacy' | 'fixed' {
  const p = names(dataDir);
  if (!exists(p.root)) return 'legacy';
  directories(p, false);
  if (marker(p)) return 'fixed';
  if (records(p).some(record => record.outcome === 'committed' || !['aborted','cleaned'].includes(record.phase))) throw new Error('Fixed-path migration recovery required before database open');
  return 'legacy';
}
const startupReclamationScheduled = new Set<string>();
function scheduleStartupReclamation(p: ReturnType<typeof names>): void {
  if (startupReclamationScheduled.has(p.root)) return;
  startupReclamationScheduled.add(p.root); void reclaim(p);
}
function settled(p: ReturnType<typeof names>, current: LayoutMarker | null, all: RecordState[]): boolean {
  if (all.length === 0) return false;
  const writerPath=path.join(p.root,'codegraph.lock');
  let writer: string | null=null;
  if (exists(writerPath)) { regular(writerPath); if (fs.statSync(writerPath).size === 36) writer=fs.readFileSync(writerPath,'utf8'); }
  for (const record of all) {
    if (record.outcome === 'committed' && current?.migrationId !== record.id) throw new Error('Committed migration lost authoritative layout marker');
    if (current?.migrationId === record.id && record.outcome === 'aborted') throw new Error('Layout marker conflicts with aborted migration');
    const deferred = current?.migrationId === record.id && deferredCleanups.get(p.root)?.has(record.id);
    if (((record.phase !== 'cleaned' || exists(ownedPaths(p,record).dir)) && !deferred) || (writer === record.writerToken && !deferred)) return false;
  }
  return true;
}
/** Recover only previously authorized operations. No new migration is authorized
 * by calling this method. All participating opens must call it before SQLite. */
export function recoverFixedPathMigration(dataDir: string): void {
  const p = names(dataDir);
  if (!exists(p.root)) return;
  directories(p,false);
  if (!exists(p.journal)) { marker(p); return; }
  // Completed migrations need no exclusive recovery lock on each SDK/MCP probe.
  // Readonly hot-journal recovery and genuine lock contention enter the owner path;
  // malformed metadata and all other errors remain explicit failures.
  try {
    const current=marker(p);
    if (settled(p,current,records(p))) { if (current) scheduleStartupReclamation(p); return; }
  } catch (error) {
    const code=(error as {errcode?:number}).errcode;
    if (code !== 776 && !(typeof code === 'number' && (code & 255) === 5)) throw error;
  }
  mutex(p, () => {
    const current = marker(p);
    for (const record of records(p, false)) {
      if ((record.outcome === 'committed' || !['cleaned','aborted'].includes(record.phase)) && current && current.migrationId !== record.id) throw new Error('Layout marker does not match migration evidence');
      if (record.outcome === 'committed' && !current) throw new Error('Committed migration lost authoritative layout marker');
      const writerPath=path.join(p.root,'codegraph.lock');
      if (exists(writerPath)) {
        regular(writerPath);
        const sameOwner=fs.readFileSync(writerPath,'utf8') === record.writerToken;
        if (!sameOwner && current?.migrationId !== record.id && !['cleaned','aborted'].includes(record.phase)) throw new Error('Foreign writer lock blocks migration recovery');
        // Exclusive OS migration owner proves this exact recorded migrator exited.
        if (sameOwner) {
          try { fs.unlinkSync(writerPath); }
          catch (error) { if (current?.migrationId === record.id) deferCommittedCleanup(p,record,error); else throw error; }
        }
      }
      if (record.phase === 'cleaned' || record.phase === 'aborted') {
        if (record.outcome === 'committed') finishCommittedCleanup(p,record); else cleanupOperation(p,record);
        continue;
      }
      if (current?.migrationId === record.id || record.phase === 'committed') {
        if (!current || current.migrationId !== record.id) throw new Error('Committed migration lost authoritative layout marker');
        // Root may now be a different public DB. Never compare to old candidate or restore source.
        regular(p.active); record.phase='committed'; record.outcome='committed';
        try { save(p,record); } catch (error) { deferCommittedCleanup(p,record,error); continue; }
        finishCommittedCleanup(p,record); continue;
      }
      const files = checkOwned(p,record);
      if (hash(record.source) !== record.sourceIdentity) throw new Error('Migration source changed; evidence preserved');
      if (record.generation !== null && exists(p.active)) {
        if (record.phase !== 'installing' || !record.candidateIdentity || exists(files.candidate) || hash(p.active) !== record.candidateIdentity) throw new Error('Unknown root database during migration; evidence preserved');
        noSidecars(p.active); fs.renameSync(p.active,files.candidate); syncDirectory(p.root); syncDirectory(files.dir);
      }
      record.phase='aborted'; record.outcome='aborted'; save(p,record); cleanupOperation(p,record);
    }
  });
  if (marker(p)) scheduleStartupReclamation(p);
}
/** Register a new/flat standalone DB, or migrate a generation-only store.
 * A root plus CURRENT is an explicit conflict even when contents appear equal.
 * Content equality alone does not establish which layout the user intended. */
export function migrateToFixedPath(dataDir: string, options: FixedPathMigrationOptions): FixedPathMigrationResult {
  if (options.offline !== true) throw new Error('Explicit offline migration acknowledgement required');
  const p = names(dataDir); deferredCleanups.delete(p.root); recoverFixedPathMigration(dataDir);
  const result = mutex(p, () => {
    if (marker(p)) { validate(p.active,options.validateDatabase); return; }
    const rootPresent = exists(p.active), currentPresent = exists(path.join(p.root,'CURRENT'));
    // Resolve first: malformed manifests never become permission to fall back.
    const source = resolveGeneration(p.root);
    if (rootPresent && currentPresent) throw new Error('Fixed-path migration conflict: root database and CURRENT both exist; preserve both and explicitly resolve offline');
    if (!rootPresent && !currentPresent) throw new Error('No database to register or migrate');
    if (!rootPresent) noSidecars(p.active);
    const writerPath=path.join(p.root,'codegraph.lock');
    if (exists(writerPath)) throw new Error('Existing writer lock blocks offline migration');
    validate(source.databasePath,options.validateDatabase); syncFile(source.databasePath);
    let writerToken: string | null = null;
    let operation: RecordState | undefined;
    try {
      const record: RecordState = operation = {version:1,id:randomUUID(),offlineAuthorized:true,outcome:null,phase:'preparing',source:source.databasePath,
        sourceIdentity:hash(source.databasePath),writerToken:randomUUID(),generation:source.id,candidateIdentity:null};
      const files = ownedPaths(p,record); fs.mkdirSync(files.dir);
      fs.writeFileSync(files.owner,JSON.stringify({version:1,operation:record.id}),{flag:'wx',mode:0o600}); syncFile(files.owner); syncDirectory(files.dir);
      save(p,record);
      fs.writeFileSync(writerPath,record.writerToken,{flag:'wx',mode:0o600}); writerToken=record.writerToken; syncFile(writerPath);
      options.hook?.('preparing');
      if (source.id !== null) {
        fs.copyFileSync(source.databasePath,files.candidate,fs.constants.COPYFILE_EXCL);
        validate(files.candidate,options.validateDatabase); syncFile(files.candidate);
        record.candidateIdentity=hash(files.candidate);
        if (record.candidateIdentity !== record.sourceIdentity) throw new Error('Source changed while copying migration snapshot');
      }
      if (hash(source.databasePath) !== record.sourceIdentity || resolveGeneration(p.root).databasePath !== record.source) throw new Error('Source changed before migration commit');
      record.phase='installing'; save(p,record); options.hook?.('installing');
      if (source.id !== null) {
        if (exists(p.active)) throw new Error('Root appeared during migration; preserved');
        noSidecars(p.active); fs.renameSync(files.candidate,p.active); syncDirectory(p.root); syncDirectory(files.dir); options.hook?.('root-installed');
      }
      validate(p.active,options.validateDatabase);
      fs.writeFileSync(files.stagedMarker,JSON.stringify({version:1,layout:'fixed-path-v1',migrationId:record.id}),{flag:'wx',mode:0o600}); syncFile(files.stagedMarker);
      if (exists(p.marker)) throw new Error('Layout changed during migration');
      fs.renameSync(files.stagedMarker,p.marker); syncDirectory(p.runtime); options.hook?.('layout-committed');
      record.phase='committed'; record.outcome='committed';
      try { save(p,record); } catch (error) { deferCommittedCleanup(p,record,error); return; }
      options.hook?.('committed');
      if (finishCommittedCleanup(p,record)) options.hook?.('cleaned');
    } finally {
      if (writerToken !== null && exists(writerPath)) {
        regular(writerPath);
        if (fs.readFileSync(writerPath,'utf8') === writerToken) {
          try { fs.unlinkSync(writerPath); }
          catch (error) {
            if (operation && marker(p)?.migrationId === operation.id) deferCommittedCleanup(p,operation,error); else throw error;
          }
        }
      }
    }
  });
  void result;
  return {databasePath:p.active,layout:'fixed',cleanup:reclaim(p),cleanupWarnings:[...(deferredCleanups.get(p.root)?.values() ?? [])]};
}
export const registerFixedPathLayout = migrateToFixedPath;
