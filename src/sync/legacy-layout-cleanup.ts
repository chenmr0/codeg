/** Durable, explicitly offline legacy-layout reclamation. No PID/age inference. */
import fs from 'node:fs';
import path from 'node:path';
import { resolveGeneration } from './generation-store';
import { createHash } from 'node:crypto';
import { migrateLegacyRuntimeArtifacts, ensureFixedPathGitProtection } from '../runtime-paths';

const ROOT_FILES = new Set(['CURRENT', '.generation-lifecycle.sqlite']);
const TREE_FILES = new Set(['.generation-owner.json', 'codegraph.db', 'READY.json', 'build.stdout.log', 'build.stderr.log', 'build-result.json']);
const ROOT_ALLOWED = new Set(['codegraph.db', 'codegraph.db-wal', 'codegraph.db-shm', '.runtime', 'CURRENT', 'generations', '.generation-leases', '.generation-lifecycle.sqlite', '.generation-lifecycle.sqlite-journal', '.gitignore', 'errors.log', 'daemon.log', 'daemon.pid', 'daemon.sock', 'adaptive-sync.log', 'adaptive-sync.log.1', 'adaptive-cost-history.json']);
interface Inventory { version: 1; files: { name: string; hash: string }[]; directories: string[]; }
const pendingName = 'legacy-layout-cleanup.sqlite';
function journal(root: string): any {
  const file = path.join(root, '.runtime', pendingName);
  if (exists(file)) regular(file);
  for (const suffix of ['-journal', '-wal', '-shm']) if (exists(file + suffix)) regular(file + suffix);
  const { DatabaseSync } = require('node:sqlite'), db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=FULL');
    if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'delete') throw new Error('Legacy cleanup journal must use DELETE mode');
    db.exec('CREATE TABLE IF NOT EXISTS cleanup (id INTEGER PRIMARY KEY CHECK(id=1), inventory TEXT NOT NULL)');
    return db;
  } catch (error) { db.close(); throw error; }
}
function exists(file: string): boolean {
  try { fs.lstatSync(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function regular(file: string): void { if (!fs.lstatSync(file).isFile()) throw new Error(`Unsafe legacy file retained: ${file}`); }
function digest(file: string): string {
  regular(file); const h = createHash('sha256'), fd = fs.openSync(file, 'r'), buffer = Buffer.allocUnsafe(1024 * 1024);
  try { let n: number; while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) h.update(buffer.subarray(0, n)); }
  finally { fs.closeSync(fd); }
  return h.digest('hex');
}
function allowed(name: string): boolean {
  if (ROOT_FILES.has(name)) return true;
  const segments = name.split('/');
  return (segments.length === 2 && segments[0] === '.generation-leases' && /^g-[a-zA-Z0-9-]{1,100}\.sqlite$/.test(segments[1]!)) ||
    (segments.length === 3 && segments[0] === 'generations' && /^g-[a-zA-Z0-9-]{1,100}$/.test(segments[1]!) && TREE_FILES.has(segments[2]!));
}
export function assertLegacyRootNames(root: string, allowWriter = false): void {
  for (const name of fs.readdirSync(root)) if (!ROOT_ALLOWED.has(name) && !(allowWriter && name === 'codegraph.lock')) throw new Error(`Unknown legacy root artifact retained: ${name}`);
}
/** Exclusive SQLite locks test every registered lease, not just one daemon PID.
 * The caller's offline acknowledgement is still required for old/unmanaged tools. */
export function holdLegacyLeasesClosed(root: string): { close(): void } {
  const files: string[] = [];
  if (exists(path.join(root, '.generation-lifecycle.sqlite-journal')) && !exists(path.join(root, '.generation-lifecycle.sqlite'))) throw new Error('Orphan lifecycle journal retained');
  if (exists(path.join(root, '.generation-lifecycle.sqlite'))) files.push(path.join(root, '.generation-lifecycle.sqlite'));
  const leases = path.join(root, '.generation-leases');
  if (exists(leases)) {
    if (!fs.lstatSync(leases).isDirectory()) throw new Error('Unsafe legacy leases directory');
    for (const name of fs.readdirSync(leases)) {
      if (name.endsWith('.sqlite-journal') && exists(path.join(leases, name.slice(0, -8)))) { regular(path.join(leases, name)); continue; }
      if (!/^g-[a-zA-Z0-9-]{1,100}\.sqlite$/.test(name)) throw new Error(`Unknown legacy lease artifact retained: ${name}`);
      files.push(path.join(leases, name));
    }
  }
  const held: { close(): void }[] = [];
  try {
    for (const file of files) {
      regular(file);
      if (exists(file + '-journal')) regular(file + '-journal');
      for (const suffix of ['-wal', '-shm']) if (exists(file + suffix)) throw new Error(`Unresolved legacy lease sidecar retained: ${file + suffix}`);
      const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(file); held.push(db);
      db.exec('PRAGMA busy_timeout=0');
      db.exec(path.basename(file) === '.generation-lifecycle.sqlite' ? 'BEGIN IMMEDIATE' : 'BEGIN EXCLUSIVE');
    }
    return { close() { for (const db of held.splice(0).reverse()) db.close(); } };
  } catch (error) { for (const db of held.reverse()) db.close(); throw new Error(`Offline migration requires every legacy reader/writer to close: ${String(error)}`); }
}
export function assertLegacyLeasesClosed(root: string): void { holdLegacyLeasesClosed(root).close(); }
function read(root: string): Inventory | null {
  const file = path.join(root, '.runtime', pendingName);
  const flag = file + '.pending';
  if (!exists(flag)) return null;
  regular(flag); if (fs.statSync(flag).size !== 0) throw new Error('Unknown cleanup pending marker retained');
  if (!exists(file)) return null;
  const db = journal(root); let raw: string | undefined;
  try { raw = db.prepare('SELECT inventory FROM cleanup WHERE id=1').get()?.inventory; } finally { db.close(); }
  if (!raw) return null;
  const value = JSON.parse(raw) as Inventory;
  if (value.version !== 1 || !Array.isArray(value.files) || !Array.isArray(value.directories) ||
      value.files.some(row => !allowed(row.name) || !/^[a-f0-9]{64}$/.test(row.hash)) ||
      value.directories.some(name => name !== 'generations' && name !== '.generation-leases' && !/^generations\/g-[a-zA-Z0-9-]{1,100}$/.test(name))) throw new Error('Invalid legacy cleanup inventory; evidence retained');
  return value;
}
/** Call before layout commit, after all source validation. Existing evidence is never overwritten. */
export function prepareLegacyLayoutCleanup(root: string, authorizedSource: string | null = null, sourceIdentity?: string): void {
  if (read(root)) return;
  const inventory: Inventory = { version: 1, files: [], directories: [] };
  let selected: string | null = null;
  const current = path.join(root, 'CURRENT');
  if (exists(current)) {
    regular(current); const manifest = JSON.parse(fs.readFileSync(current, 'utf8'));
    if (manifest.version !== 1 || !/^g-[a-zA-Z0-9-]{1,100}$/.test(manifest.generation)) throw new Error('Unknown legacy manifest retained');
    if (authorizedSource !== null && manifest.generation === authorizedSource) {
      const resolved = resolveGeneration(root);
      if (resolved.id !== authorizedSource || !sourceIdentity || digest(resolved.databasePath) !== sourceIdentity) throw new Error('Legacy source authority or identity changed; evidence retained');
      selected = authorizedSource;
    }
  }

  const add = (name: string): void => { if (!allowed(name)) throw new Error(`Unknown legacy artifact retained: ${name}`); inventory.files.push({ name, hash: digest(path.join(root, name)) }); };
  for (const name of ROOT_FILES) if (exists(path.join(root, name))) add(name);
  for (const parent of ['generations', '.generation-leases']) {
    const dir = path.join(root, parent); if (!exists(dir)) continue;
    if (!fs.lstatSync(dir).isDirectory()) throw new Error(`Unsafe legacy directory retained: ${dir}`);
    inventory.directories.push(parent);
    for (const child of fs.readdirSync(dir)) {
      if (parent === '.generation-leases') {
        const registry = path.join(root, '.generation-lifecycle.sqlite');
        if (!exists(registry)) throw new Error(`Unregistered legacy lease retained: ${child}`);
        const { DatabaseSync } = require('node:sqlite'), db = new DatabaseSync(registry, { readOnly: true });
        let registered: unknown;
        try { registered = db.prepare('SELECT id FROM generations WHERE id=?').get(child.replace(/\.sqlite$/, '')); } finally { db.close(); }
        if (!registered) throw new Error(`Unregistered legacy lease retained: ${child}`);
        add(`${parent}/${child}`); continue;
      }
      const sub = `${parent}/${child}`, full = path.join(root, sub);
      if (!/^g-[a-zA-Z0-9-]{1,100}$/.test(child) || !fs.lstatSync(full).isDirectory()) throw new Error(`Unknown legacy generation retained: ${full}`);
      // Only the CURRENT-selected, separately validated legacy source may
      // predate ownership markers. Extra g-* directories are not permission.
      const owner = path.join(full, '.generation-owner.json');
      if (child !== selected || exists(owner)) {
        if (!exists(owner)) throw new Error(`Unowned legacy generation retained: ${sub}`);
        regular(owner); const ownership = JSON.parse(fs.readFileSync(owner, 'utf8'));
        const registry = path.join(root, '.generation-lifecycle.sqlite');
        if (!exists(registry)) throw new Error(`Unregistered legacy generation retained: ${sub}`);
        const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(registry, { readOnly: true });
        let row: { token: string } | undefined;
        try { row = db.prepare('SELECT token FROM generations WHERE id=?').get(child); } finally { db.close(); }
        if (ownership.version !== 1 || ownership.id !== child || !row || row.token !== ownership.token) throw new Error(`Legacy generation ownership mismatch retained: ${sub}`);
      }
      inventory.directories.push(sub);
      for (const name of fs.readdirSync(full)) add(`${sub}/${name}`);
    }
  }
  const flag = path.join(root, '.runtime', pendingName + '.pending');
  if (!exists(flag)) { const fd = fs.openSync(flag, 'wx', 0o600); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
  const db = journal(root);
  try { db.prepare('INSERT INTO cleanup(id,inventory) VALUES (1,?)').run(JSON.stringify(inventory)); } finally { db.close(); }
}
/** Only a committed fixed marker grants deletion. Missing files are an idempotent partial cleanup. */
export function finishLegacyLayoutCleanup(root: string): void {
  const inventory = read(root); if (!inventory) return;
  if (!exists(path.join(root, '.runtime', 'layout.json'))) return;
  ensureFixedPathGitProtection(root);
  const held = holdLegacyLeasesClosed(root);
  const coordination = (name: string): boolean => name === '.generation-lifecycle.sqlite' || name.startsWith('.generation-leases/');
  try {
  // Verify the entire surviving inventory before deleting any item.
  for (const row of inventory.files) { const file = path.join(root, row.name); if (exists(file) && digest(file) !== row.hash) throw new Error(`Changed legacy artifact retained: ${row.name}`); }
  for (const dir of inventory.directories) {
    const full = path.join(root, dir); if (!exists(full)) continue;
    if (!fs.lstatSync(full).isDirectory()) throw new Error(`Unsafe legacy directory retained: ${dir}`);
    for (const name of fs.readdirSync(full)) {
      const child = `${dir}/${name}`;
      if (!inventory.files.some(row => row.name === child) && !inventory.directories.includes(child)) throw new Error(`Unknown legacy artifact retained: ${child}`);
    }
  }
    for (const row of inventory.files.filter(row => !coordination(row.name))) { const file = path.join(root, row.name); if (exists(file)) fs.unlinkSync(file); }
  } finally { held.close(); }
  // Windows cannot unlink our own open lease files. CURRENT and every retired
  // business file are already gone; fixed-aware admission uses the committed
  // marker. Older/unmanaged binaries remain subject to the offline attestation.
  for (const row of inventory.files.filter(row => coordination(row.name))) { const file = path.join(root, row.name); if (exists(file)) fs.unlinkSync(file); }
  for (const dir of [...inventory.directories].sort((a, b) => b.length - a.length)) { const full = path.join(root, dir); if (exists(full)) fs.rmdirSync(full); }
  migrateLegacyRuntimeArtifacts(root);
  const db = journal(root); try { db.exec('DELETE FROM cleanup WHERE id=1'); } finally { db.close(); }
  fs.unlinkSync(path.join(root, '.runtime', pendingName + '.pending'));
}

export function hasLegacyLayoutCleanup(root: string): boolean { return read(root) !== null; }
