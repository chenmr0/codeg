/** Cross-process leases use SQLite's OS locks, never PID/age-based liveness.
 * Only protocol-created, ownership-marked directories are eligible for GC.
 * The registry and lease databases MUST remain in rollback-journal mode.
 */
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

interface Sqlite {
  exec(sql: string): void;
  prepare(sql: string): { run(...args: unknown[]): unknown; get(...args: unknown[]): any; all(...args: unknown[]): any[] };
  close(): void;
}
const ID = /^g-[a-zA-Z0-9-]{1,100}$/;
const MARKER = '.generation-owner.json';
const FILES = new Set([MARKER, 'codegraph.db', 'codegraph.db-wal', 'codegraph.db-shm', 'codegraph.db-journal', 'READY.json', 'build.stdout.log', 'build.stderr.log', 'build-result.json', 'codegraph.lock']);
export interface LifecycleLease { release(): void; }
export interface LifecycleGate { db: Sqlite; root: string; }
function regularIfPresent(file: string): void {
  try { if (!fs.lstatSync(file).isFile()) throw new Error(`Unsafe lifecycle file: ${file}`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
function open(file: string): Sqlite {
  regularIfPresent(file);
  regularIfPresent(file + '-journal');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file) as Sqlite;
  try {
    // Gate sections contain no awaits. Bound contention rather than freezing MCP.
    db.exec('PRAGMA busy_timeout=25');
    const mode = db.prepare('PRAGMA journal_mode').get();
    if (Object.values(mode)[0] !== 'delete') throw new Error('Lifecycle databases require DELETE journal mode');
    return db;
  } catch (error) { db.close(); throw error; }
}
export function withLifecycleGate<T>(rootInput: string, action: (gate: LifecycleGate) => T): T {
  const root = path.resolve(rootInput);
  if (!fs.lstatSync(root).isDirectory()) throw new Error('Lifecycle root must be a real directory');
  const db = open(path.join(root, '.generation-lifecycle.sqlite'));
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec('CREATE TABLE IF NOT EXISTS generations (id TEXT PRIMARY KEY, token TEXT NOT NULL, state TEXT NOT NULL)');
    const result = action({ db, root });
    db.exec('COMMIT');
    return result;
  } catch (error) { try { db.exec('ROLLBACK'); } catch { /* no transaction */ } throw error; }
  finally { db.close(); }
}
function leasePath(gate: LifecycleGate, id: string): string {
  if (!ID.test(id)) throw new Error('Invalid generation lease ID');
  const dir = path.join(gate.root, '.generation-leases');
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.lstatSync(dir).isDirectory()) throw new Error('Lease directory must be a real directory');
  return path.join(dir, id + '.sqlite');
}
export function registerGeneration(gate: LifecycleGate, id: string, directory: string): void {
  const token = randomUUID();
  fs.writeFileSync(path.join(directory, MARKER), JSON.stringify({ version: 1, id, token }), { flag: 'wx', mode: 0o600 });
  const db = open(leasePath(gate, id));
  try { db.exec('CREATE TABLE lease (value INTEGER); INSERT INTO lease VALUES (1)'); }
  finally { db.close(); }
  gate.db.prepare('INSERT INTO generations VALUES (?, ?, ?)').run(id, token, 'live');
}
export function acquireLifecycleLease(gate: LifecycleGate, id: string, allowUnknown = false): LifecycleLease {
  const row = gate.db.prepare('SELECT state FROM generations WHERE id = ?').get(id);
  // Pre-protocol generations are never collected, including legacy flat DBs.
  if (!row) {
    if (allowUnknown) return { release() {} };
    throw new Error('Generation is not registered or has been reclaimed');
  }
  if (row.state !== 'live') throw new Error('Generation is being reclaimed');
  const file = leasePath(gate, id);
  if (!fs.existsSync(file)) throw new Error('Missing generation lease database');
  const db = open(file);
  try { db.exec('BEGIN'); db.prepare('SELECT value FROM lease').get(); }
  catch (error) { db.close(); throw error; }
  let released = false;
  return { release() {
    if (released) return;
    try { db.exec('ROLLBACK'); } finally { db.close(); released = true; }
  } };
}
/** Seal under the gate; slow directory deletion happens AFTER this transaction commits. */
export function collectLifecycleGenerations(gate: LifecycleGate, currentId: string | null): string[] {
  const sealed: string[] = [];
  for (const row of gate.db.prepare('SELECT id, token, state FROM generations').all()) {
    if (row.id === currentId || !ID.test(row.id)) continue;
    if (row.state === 'deleting') { sealed.push(row.id); continue; }
    let exclusive: Sqlite | undefined;
    try {
      if (!ownedDirectory(gate.root, row.id, row.token, false)) continue;
      const file = leasePath(gate, row.id);
      if (!fs.existsSync(file)) continue;
      exclusive = open(file);
      exclusive.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
      gate.db.prepare('UPDATE generations SET state = ? WHERE id = ?').run('deleting', row.id);
      sealed.push(row.id);
    } catch { /* Any live process's shared lock prevents reclamation. */ }
    finally { try { exclusive?.close(); } catch { /* conservatively retained */ } }
  }
  return sealed;
}
function ownedDirectory(root: string, id: string, token: string, deleting: boolean): boolean {
  const generations = path.join(root, 'generations');
  if (!fs.lstatSync(generations).isDirectory()) return false;
  const directory = path.join(generations, id);
  if (!fs.existsSync(directory)) return deleting;
  if (!fs.lstatSync(directory).isDirectory()) return false;
  const names = fs.readdirSync(directory);
  if (names.some(name => !FILES.has(name) || !fs.lstatSync(path.join(directory, name)).isFile())) return false;
  // A crash between marker unlink and rmdir leaves an empty sealed directory.
  if (deleting && names.length === 0) return true;
  const markerFile = path.join(directory, MARKER);
  if (fs.statSync(markerFile).size > 4096) return false;
  const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
  return marker.version === 1 && marker.id === id && marker.token === token;
}
export async function removeSealedGenerations(root: string, ids: string[]): Promise<void> {
  for (const id of ids) {
    try {
      const row = withLifecycleGate(root, gate => gate.db.prepare('SELECT token, state FROM generations WHERE id = ?').get(id));
      if (row?.state !== 'deleting' || !ownedDirectory(root, id, row.token, true)) continue;
      const directory = path.join(root, 'generations', id);
      if (fs.existsSync(directory)) {
        for (const name of (await fs.promises.readdir(directory)).filter(name => name !== MARKER)) await fs.promises.unlink(path.join(directory, name));
        await fs.promises.rm(path.join(directory, MARKER), { force: true });
        await fs.promises.rmdir(directory);
      }
      withLifecycleGate(root, gate => {
        // Registration is immutable: a sealed random ID can never be reacquired.
        const current = gate.db.prepare('SELECT state FROM generations WHERE id = ?').get(id);
        if (current?.state !== 'deleting') return;
        const file = leasePath(gate, id);
        fs.rmSync(file, { force: true });
        fs.rmSync(file + '-journal', { force: true });
        gate.db.prepare('DELETE FROM generations WHERE id = ?').run(id);
      });
    } catch { /* Sharing violations/partial deletion remain sealed for restart retry. */ }
  }
}
