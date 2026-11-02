import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { PortableCoordinator, type PortableLease } from '../src/sync/portable/protocol';
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});
const { DatabaseSync } = require('node:sqlite');
const roots: string[] = [], leases: PortableLease[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const lease of leases.splice(0).reverse()) lease.release();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function database(file: string, value: number) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE facts(value); INSERT INTO facts VALUES (${value})`);
  db.close();
}
function replacing(moveNew = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-wal-recovery-')); roots.push(root);
  const coordinator = new PortableCoordinator(root); leases.push(coordinator.acquireWriter());
  database(coordinator.active, 1);
  const candidate = coordinator.beginCandidate(); database(candidate.path, 2);
  const record = { ...candidate, phase: 'replacing', oldHash: hash(coordinator.active), newHash: hash(candidate.path) };
  (coordinator as any).save('draining', candidate.baselineRevision, record);
  fs.renameSync(coordinator.active, candidate.backup);
  if (moveNew) fs.renameSync(candidate.path, coordinator.active);
  return { coordinator, candidate, record };
}
function abruptOpen(file: string, write = false) {
  const result = spawnSync(process.execPath, ['-e', `
    const {DatabaseSync}=require('node:sqlite');
    const db=new DatabaseSync(process.argv[1], {readOnly:${!write}});
    db.exec(${JSON.stringify(write ? 'INSERT INTO facts VALUES (3)' : 'SELECT * FROM facts')});
    process.exit(0);
  `, file], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
}
it('recovers empty WAL/SHM left by an abruptly exited read-only verifier, preserving WAL mode and identity', () => {
  const { coordinator, record } = replacing();
  abruptOpen(coordinator.active);
  expect(fs.statSync(coordinator.active + '-wal').size).toBe(0);
  expect(fs.existsSync(coordinator.active + '-shm')).toBe(true);
  coordinator.recover();
  expect(coordinator.snapshot().mode).toBe('idle');
  expect(hash(coordinator.active)).toBe(record.newHash);
  expect(fs.existsSync(coordinator.active + '-wal')).toBe(false);
  expect(fs.existsSync(coordinator.active + '-shm')).toBe(false);
  coordinator.recover();
  const db = new DatabaseSync(coordinator.active);
  try {
    expect(db.prepare('PRAGMA journal_mode').get().journal_mode).toBe('wal');
    expect(db.prepare('SELECT value FROM facts').get().value).toBe(2);
  } finally { db.close(); }
});
it('retains nonempty WAL transactions and all publication evidence instead of discarding them', () => {
  const { coordinator, candidate, record } = replacing();
  abruptOpen(coordinator.active, true);
  const wal = fs.readFileSync(coordinator.active + '-wal');
  expect(wal.length).toBeGreaterThan(0);
  expect(hash(coordinator.active)).toBe(record.newHash);
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(() => coordinator.recover()).toThrow(/Unproven SQLite sidecars/);
    expect(fs.readFileSync(coordinator.active + '-wal')).toEqual(wal);
    expect(hash(candidate.backup)).toBe(record.oldHash);
    expect(coordinator.snapshot().mode).toBe('draining');
  }
  const db = new DatabaseSync(coordinator.active);
  try { expect(db.prepare('SELECT count(*) AS n FROM facts').get().n).toBe(2); }
  finally { db.close(); }
});
it('does not open a known database with a linked recovery sidecar', () => {
  const { coordinator, record } = replacing();
  abruptOpen(coordinator.active);
  const shm = coordinator.active + '-shm', retained = path.join(path.dirname(coordinator.active), 'retained-shm');
  fs.linkSync(shm, retained);
  expect(() => coordinator.recover()).toThrow(/Linked SQLite recovery artifact/);
  expect(hash(coordinator.active)).toBe(record.newHash);
  expect(fs.existsSync(coordinator.active + '-wal')).toBe(true);
  expect(coordinator.snapshot().mode).toBe('draining');
});
it('preserves an unknown imported WAL database and its transactions', () => {
  const { coordinator, candidate } = replacing();
  const replacement = path.join(path.dirname(coordinator.active), 'import.db');
  database(replacement, 42); fs.copyFileSync(replacement, coordinator.active);
  abruptOpen(coordinator.active, true);
  const before = fs.readFileSync(coordinator.active), wal = fs.readFileSync(coordinator.active + '-wal');
  expect(() => coordinator.recover()).toThrow(/Unproven SQLite sidecars/);
  expect(fs.readFileSync(coordinator.active)).toEqual(before);
  expect(fs.readFileSync(coordinator.active + '-wal')).toEqual(wal);
  expect(fs.existsSync(candidate.backup)).toBe(true);
});

it('rolls back the old-moved crash window even when verification left empty sidecars on the backup', () => {
  const { coordinator, candidate, record } = replacing(false);
  abruptOpen(candidate.backup);
  coordinator.recover();
  expect(hash(coordinator.active)).toBe(record.oldHash);
  expect(coordinator.snapshot().mode).toBe('idle');
  coordinator.recover();
  expect(hash(coordinator.active)).toBe(record.oldHash);
});
it('retains the durable recovery intent after a SQLite lock/sharing failure and permits a later retry', () => {
  const { coordinator, candidate, record } = replacing();
  abruptOpen(coordinator.active);
  const prepare = DatabaseSync.prototype.prepare;
  const spy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function(this: any, sql: string) {
    if (/wal_checkpoint/.test(sql)) throw new Error('database is locked (simulated sharing failure)');
    return prepare.call(this, sql);
  });
  expect(() => coordinator.recover()).toThrow(/locked/);
  expect(coordinator.snapshot().mode).toBe('draining');
  expect(hash(coordinator.active)).toBe(record.newHash);
  expect(hash(candidate.backup)).toBe(record.oldHash);
  spy.mockRestore();
  coordinator.recover();
  expect(coordinator.snapshot().mode).toBe('idle');
  expect(hash(coordinator.active)).toBe(record.newHash);
});
it('can retry an old-moved recovery rename rejected with Windows-style EPERM', () => {
  const { coordinator, candidate, record } = replacing(false);
  abruptOpen(candidate.backup);
  const rename = require('node:fs').renameSync;
  const spy = vi.mocked(fs.renameSync).mockImplementation((source, destination) => {
    if (source === candidate.backup && destination === coordinator.active) {
      const error = new Error('sharing violation') as NodeJS.ErrnoException;
      error.code = 'EPERM'; throw error;
    }
    return rename(source, destination);
  });
  expect(() => coordinator.recover()).toThrow(/sharing violation/);
  expect(coordinator.snapshot().mode).toBe('draining');
  expect(fs.existsSync(coordinator.active)).toBe(false);
  expect(hash(candidate.backup)).toBe(record.oldHash);
  expect(hash(candidate.path)).toBe(record.newHash);
  spy.mockRestore();
  coordinator.recover();
  expect(coordinator.snapshot().mode).toBe('idle');
  expect(hash(coordinator.active)).toBe(record.oldHash);
});

/** Run the real coordinator in a separate process and terminate without closing
 * any SQLite handles at a precisely selected recovery boundary. */
function interruptRecovery(root: string, boundary: 'validate' | 'open' | 'checkpoint' | 'before-close' | 'after-close') {
  const result = spawnSync(process.execPath, ['-e', `
    const fs=require('node:fs'), ts=require('typescript'), path=require('node:path');
    require.extensions['.ts']=(module,file)=>module._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),
      {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);
    const {DatabaseSync}=require('node:sqlite');
    const prepare=DatabaseSync.prototype.prepare, exec=DatabaseSync.prototype.exec, close=DatabaseSync.prototype.close;
    const active=path.join(process.argv[1],'codegraph.db'), boundary=process.argv[2];
    const target=db=>prepare.call(db,'PRAGMA database_list').all().some(row=>row.name==='main'&&row.file===active);
    DatabaseSync.prototype.exec=function(sql){const result=exec.call(this,sql);if(boundary==='open'&&/busy_timeout/.test(sql)&&target(this))process.exit(86);return result;};
    DatabaseSync.prototype.prepare=function(sql){
      const statement=prepare.call(this,sql);
      if(target(this)&&((boundary==='validate'&&/quick_check/.test(sql))||(boundary==='checkpoint'&&/wal_checkpoint/.test(sql))))
        return {get(...args){statement.get(...args);process.exit(86);}};
      return statement;
    };
    DatabaseSync.prototype.close=function(){
      const match=target(this);
      if(match&&boundary==='before-close')process.exit(86);
      const result=close.call(this);
      if(match&&boundary==='after-close')process.exit(86);
      return result;
    };
    const {PortableCoordinator}=require(process.argv[3]);
    new PortableCoordinator(process.argv[1]).recover();
    process.exit(0);
  `, root, boundary, path.resolve(__dirname, '../src/sync/portable/protocol.ts')], {
    encoding: 'utf8', cwd: path.resolve(__dirname, '..'),
  });
  expect(result.status, result.stderr).toBe(86);
}
it('retries interrupted validation of an offline WAL import without deleting old publication evidence', () => {
  const { coordinator, candidate, record } = replacing();
  const imported = path.join(path.dirname(coordinator.active), 'import.db');
  database(imported, 42); fs.copyFileSync(imported, coordinator.active);
  const importedHash = hash(coordinator.active);
  leases[leases.length - 1].release();
  for (let attempt = 0; attempt < 2; attempt++) {
    interruptRecovery(path.dirname(coordinator.active), 'validate');
    expect((coordinator as any).journal().importValidationHash).toBe(importedHash);
    expect(hash(coordinator.active)).toBe(importedHash);
    expect(fs.statSync(coordinator.active + '-wal').size).toBe(0);
    expect(hash(candidate.backup)).toBe(record.oldHash);
  }
  coordinator.recover(); coordinator.recover();
  expect(coordinator.snapshot().mode).toBe('idle');
  expect(hash(candidate.backup)).toBe(record.oldHash);
  const db = new DatabaseSync(coordinator.active);
  try { expect(db.prepare('SELECT value FROM facts').get().value).toBe(42); }
  finally { db.close(); }
});
it.each(['open', 'checkpoint', 'before-close', 'after-close'] as const)(
  'retries a real process interruption at recovery SQLite %s', boundary => {
    const { coordinator, candidate, record } = replacing();
    abruptOpen(coordinator.active);
    leases[leases.length - 1].release();
    interruptRecovery(path.dirname(coordinator.active), boundary);
    expect(coordinator.snapshot().mode).toBe('draining');
    expect(hash(coordinator.active)).toBe(record.newHash);
    expect(hash(candidate.backup)).toBe(record.oldHash);
    coordinator.recover(); coordinator.recover();
    expect(coordinator.snapshot().mode).toBe('idle');
    expect(hash(coordinator.active)).toBe(record.newHash);
  },
);
it('does not use an interrupted import validation identity to normalize a different import', () => {
  const { coordinator, candidate, record } = replacing();
  const imported = path.join(path.dirname(coordinator.active), 'import.db');
  database(imported, 42); fs.copyFileSync(imported, coordinator.active);
  leases[leases.length - 1].release();
  interruptRecovery(path.dirname(coordinator.active), 'validate');
  const originalImportHash = (coordinator as any).journal().importValidationHash;
  // An offline user replaces the snapshot after SQLite legitimately closes its
  // earlier sidecars. The second import's verifier is not our recorded intent.
  const old = new DatabaseSync(coordinator.active); old.exec('PRAGMA wal_checkpoint(TRUNCATE)'); old.close();
  const second = path.join(path.dirname(coordinator.active), 'second-import.db');
  database(second, 99); fs.copyFileSync(second, coordinator.active);
  abruptOpen(coordinator.active);
  const secondHash = hash(coordinator.active), shm = fs.readFileSync(coordinator.active + '-shm');
  expect(secondHash).not.toBe(originalImportHash);
  expect(() => coordinator.recover()).toThrow(/Unproven SQLite sidecars/);
  expect(hash(coordinator.active)).toBe(secondHash);
  expect(fs.readFileSync(coordinator.active + '-shm')).toEqual(shm);
  expect(hash(candidate.backup)).toBe(record.oldHash);
  // Once the external connection is properly closed, the new sidecar-free
  // import may establish a fresh validation intent and safely win recovery.
  const external = new DatabaseSync(coordinator.active); external.exec('PRAGMA wal_checkpoint(TRUNCATE)'); external.close();
  coordinator.recover();
  expect(coordinator.snapshot().mode).toBe('idle');
  expect(hash(coordinator.active)).toBe(secondHash);
  expect(hash(candidate.backup)).toBe(record.oldHash);
});
it('retains SHM-only evidence rather than assuming a platform-specific cleanup order', () => {
  const { coordinator, record } = replacing();
  abruptOpen(coordinator.active);
  fs.renameSync(coordinator.active + '-wal', coordinator.active + '.retained-wal');
  const shm = fs.readFileSync(coordinator.active + '-shm');
  expect(() => coordinator.recover()).toThrow(/Unproven SQLite sidecars/);
  expect(fs.readFileSync(coordinator.active + '-shm')).toEqual(shm);
  expect(hash(coordinator.active)).toBe(record.newHash);
  expect(coordinator.snapshot().mode).toBe('draining');
});
