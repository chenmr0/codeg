/**
 * Generation publication protocol. CURRENT is the only file replaced: an open
 * SQLite database, its WAL and its SHM are never renamed or deleted. Retired
 * managed generations are reclaimed only after all cross-process leases close.
 *
 * All writers must use this version of the protocol. Older binaries cannot be
 * made safe by a manifest they do not understand.
 */
import fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { withLifecycleGate, registerGeneration, acquireLifecycleLease, collectLifecycleGenerations, removeSealedGenerations, LifecycleLease } from './generation-lifecycle';

const GENERATION_ID = /^g-[a-zA-Z0-9-]{1,100}$/;
const MAX_MANIFEST_BYTES = 4096;
export interface GenerationLocation { id: string | null; databasePath: string; }
export interface GenerationCandidate extends GenerationLocation { id: string; directory: string; buildLease?: LifecycleLease; }
export interface GenerationLease extends GenerationLocation { release(): void; }
type GenerationManifest = { version: 1; generation: string; token: string } & (
  { complete: true; storageReady?: never; purpose?: never } |
  { complete: false; storageReady: true; purpose: 'initial-storage' }
);

function regularFile(file: string): void {
  if (!fs.lstatSync(file).isFile()) throw new Error(`Expected a regular file: ${file}`);
}
function realDirectory(directory: string): void {
  if (!fs.lstatSync(directory).isDirectory()) throw new Error(`Expected a real directory: ${directory}`);
}
function readManifest(file: string): GenerationManifest {
  regularFile(file);
  if (fs.statSync(file).size > MAX_MANIFEST_BYTES) throw new Error('Generation manifest too large');
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<GenerationManifest>;
  const readiness = value && ((value.complete === true && value.storageReady === undefined && value.purpose === undefined) ||
    (value.complete === false && value.storageReady === true && value.purpose === 'initial-storage'));
  if (!readiness || value.version !== 1 || typeof value.generation !== 'string' ||
      !GENERATION_ID.test(value.generation) ||
      typeof value.token !== 'string' || !/^[a-f0-9-]{36}$/.test(value.token)) {
    throw new Error(`Invalid generation manifest: ${file}`);
  }
  return value as GenerationManifest;
}
function candidatePath(dataDir: string, id: string): GenerationCandidate {
  if (!GENERATION_ID.test(id)) throw new Error('Invalid generation ID');
  const directory = path.join(path.resolve(dataDir), 'generations', id);
  return { id, directory, databasePath: path.join(directory, 'codegraph.db') };
}
function verifyCandidatePath(dataDir: string, candidate: GenerationCandidate): void {
  const actual = candidatePath(dataDir, candidate.id);
  if (actual.directory !== candidate.directory || actual.databasePath !== candidate.databasePath) {
    throw new Error('Candidate does not belong to this generation store');
  }
  realDirectory(path.resolve(dataDir));
  realDirectory(path.join(path.resolve(dataDir), 'generations'));
  realDirectory(actual.directory);
  regularFile(actual.databasePath);
}

/** Read-only lookup. A malformed or missing published target never falls back. */
export function resolveGeneration(dataDir: string): GenerationLocation {
  const root = path.resolve(dataDir);
  const currentPath = path.join(root, 'CURRENT');
  let manifest: GenerationManifest;
  try { manifest = readManifest(currentPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !fs.existsSync(currentPath)) {
      return { id: null, databasePath: path.join(root, 'codegraph.db') };
    }
    throw error;
  }
  const candidate = candidatePath(root, manifest.generation);
  verifyCandidatePath(root, candidate);
  const ready = readManifest(path.join(candidate.directory, 'READY.json'));
  if (ready.generation !== manifest.generation || ready.token !== manifest.token ||
      ready.complete !== manifest.complete || ready.storageReady !== manifest.storageReady || ready.purpose !== manifest.purpose) {
    throw new Error('CURRENT does not identify a validated generation');
  }
  return { id: candidate.id, databasePath: candidate.databasePath };
}

export function getGenerationRootLockPath(dataDir: string): string {
  return path.join(path.resolve(dataDir), 'codegraph.lock');
}

/** No timeout or automatic stale takeover. PID namespaces make death ambiguous. */
export class GenerationWriterLock {
  private owner: string | null = null;
  readonly lockPath: string;
  constructor(dataDir: string) { this.lockPath = getGenerationRootLockPath(dataDir); }
  acquire(): void {
    if (this.owner !== null) throw new Error('Writer lock is not reentrant');
    const owner = `${process.pid}\n${randomUUID()}\n`;
    let fd: number;
    try { fd = fs.openSync(this.lockPath, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error('CodeGraph database is locked by another process. ' +
          'Existing locks are never removed by age; stop all writers before explicit offline unlock.');
      }
      throw error;
    }
    try { fs.writeFileSync(fd, owner); fs.fsyncSync(fd); this.owner = owner; }
    catch (error) {
      // An incomplete lock is deliberately retained: another process cannot
      // distinguish partial creation from a live owner in a different namespace.
      throw error;
    } finally { fs.closeSync(fd); }
  }
  assertHeld(): void {
    if (this.owner === null || fs.readFileSync(this.lockPath, 'utf8') !== this.owner) {
      throw new Error('Root writer lock ownership was lost');
    }
  }
  release(): void {
    if (this.owner === null) return;
    try {
      // Never unlink a replacement lock, even if it belongs to the same PID.
      if (fs.readFileSync(this.lockPath, 'utf8') === this.owner) fs.unlinkSync(this.lockPath);
    } finally { this.owner = null; }
  }
}

export function createGeneration(dataDir: string, lock: GenerationWriterLock): GenerationCandidate {
  assertRootLock(dataDir, lock);
  realDirectory(path.resolve(dataDir));
  const generations = path.join(path.resolve(dataDir), 'generations');
  fs.mkdirSync(generations, { recursive: true });
  realDirectory(generations);
  const candidate = candidatePath(dataDir, `g-${Date.now()}-${randomUUID()}`);
  return withLifecycleGate(dataDir, gate => {
    fs.mkdirSync(candidate.directory);
    registerGeneration(gate, candidate.id, candidate.directory);
    candidate.buildLease = acquireLifecycleLease(gate, candidate.id);
    return candidate;
  });
}
function assertRootLock(dataDir: string, lock: GenerationWriterLock): void {
  if (lock.lockPath !== getGenerationRootLockPath(dataDir)) throw new Error('Wrong generation root lock');
  lock.assertHeld();
}
async function syncFile(file: string): Promise<void> {
  // The potentially large DB flush must not block the MCP event loop.
  const handle = await fs.promises.open(file, 'r+'); // Windows needs GENERIC_WRITE.
  try { await handle.sync(); } finally { await handle.close(); }
}
function syncDirectory(directory: string): void {
  // Windows cannot open directories with fs.open. Atomic rename remains the
  // visibility boundary, but durable directory fsync is not promised there.
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function exclusiveJson(file: string, manifest: GenerationManifest): void {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(manifest) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
export interface GenerationPublicationOptions {
  lock: GenerationWriterLock;
  expectedPreviousId: string | null;
  success: boolean;
  complete: boolean;
  validate: () => boolean | Promise<boolean>;
  sourceUnchanged: () => boolean | Promise<boolean>;
}
/** Error after rename means new generation is visible, not a rolled-back build. */
export class GenerationPublicationError extends Error {
  constructor(message: string, readonly published: boolean, readonly cause: unknown) {
    super(message); this.name = 'GenerationPublicationError';
  }
}
export async function publishGeneration(
  dataDir: string, candidate: GenerationCandidate, options: GenerationPublicationOptions,
): Promise<GenerationLocation> {
  const root = path.resolve(dataDir);
  const compare = (): void => {
    assertRootLock(root, options.lock);
    if (resolveGeneration(root).id !== options.expectedPreviousId) throw new Error('CURRENT generation changed');
  };
  compare();
  if (options.success !== true || options.complete !== true) throw new Error('Incomplete build cannot publish');
  verifyCandidatePath(root, candidate);
  if (await options.validate() !== true) throw new Error('Candidate database validation failed');
  verifyCandidatePath(root, candidate);
  const wal = `${candidate.databasePath}-wal`;
  try {
    regularFile(wal);
    if (fs.statSync(wal).size !== 0) throw new Error('Candidate WAL is nonempty; close and checkpoint before publication');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await syncFile(candidate.databasePath);
  const manifest: GenerationManifest = { version: 1, generation: candidate.id, token: randomUUID(), complete: true };
  exclusiveJson(path.join(candidate.directory, 'READY.json'), manifest);
  syncDirectory(candidate.directory);
  syncDirectory(path.join(root, 'generations'));
  const temporary = path.join(root, `.CURRENT-${manifest.token}.tmp`);
  let published = false;
  try {
    exclusiveJson(temporary, manifest);
    if (await options.sourceUnchanged() !== true) throw new Error('Source changed while building; retaining old generation');
    withLifecycleGate(root, gate => {
      const lease = acquireLifecycleLease(gate, candidate.id);
      lease.release();
      compare();
      // Lease acquisition and GC cannot interleave with this visibility boundary.
      fs.renameSync(temporary, path.join(root, 'CURRENT'));
      published = true;
    });
    syncDirectory(root);
    collectRetiredGenerations(root);
    return { id: candidate.id, databasePath: candidate.databasePath };
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* already renamed or absent */ }
    throw new GenerationPublicationError(
      published ? 'New generation is visible, but publication durability is uncertain' : String(error),
      published, error,
    );
  }
}

/** Initial storage readiness is deliberately NOT a completed source rebuild.
 * Caller owns a newly initialized, closed/checkpointed candidate and its build lease.
 * Historical flat databases are never adopted, replaced, or deleted here.
 */
export interface InitialGenerationPublicationOptions {
  lock: GenerationWriterLock;
  signal?: AbortSignal;
  validate: () => boolean | Promise<boolean>;
}
function assertEmptyInitialStore(root: string, lock: GenerationWriterLock): void {
  assertRootLock(root, lock);
  for (const name of ['CURRENT', 'codegraph.db', 'codegraph.db-wal', 'codegraph.db-shm', 'codegraph.db-journal']) {
    try { fs.lstatSync(path.join(root, name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    throw new Error(`Initial generation requires an empty store; found ${name}`);
  }
}
function assertCheckpointedInitialCandidate(root: string, candidate: GenerationCandidate): void {
  verifyCandidatePath(root, candidate);
  try {
    regularFile(candidate.databasePath + '-wal');
    if (fs.statSync(candidate.databasePath + '-wal').size !== 0) throw new Error('Candidate WAL is nonempty; close and checkpoint before publication');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
function publishInitialManifest(root: string, candidate: GenerationCandidate, options: InitialGenerationPublicationOptions): GenerationLocation {
  const manifest: GenerationManifest = { version: 1, generation: candidate.id, token: randomUUID(),
    complete: false, storageReady: true, purpose: 'initial-storage' };
  exclusiveJson(path.join(candidate.directory, 'READY.json'), manifest);
  syncDirectory(candidate.directory);
  syncDirectory(path.join(root, 'generations'));
  const temporary = path.join(root, `.CURRENT-${manifest.token}.tmp`);
  let published = false;
  try {
    exclusiveJson(temporary, manifest);
    withLifecycleGate(root, gate => {
      const lease = acquireLifecycleLease(gate, candidate.id);
      lease.release();
      assertEmptyInitialStore(root, options.lock);
      if (options.signal?.aborted) throw new Error('Initial storage publication cancelled');
      fs.renameSync(temporary, path.join(root, 'CURRENT'));
      published = true;
    });
    syncDirectory(root);
    void collectRetiredGenerations(root);
    return { id: candidate.id, databasePath: candidate.databasePath };
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* renamed or absent */ }
    throw new GenerationPublicationError(published ? 'Initial storage is visible, but publication durability is uncertain' : String(error), published, error);
  }
}
/** For async initialization, including large initial indexes: DB flush is off-thread. */
export async function publishInitialGeneration(dataDir: string, candidate: GenerationCandidate,
  options: InitialGenerationPublicationOptions): Promise<GenerationLocation> {
  const root = path.resolve(dataDir);
  assertEmptyInitialStore(root, options.lock);
  if (options.signal?.aborted) throw new Error('Initial storage publication cancelled');
  assertCheckpointedInitialCandidate(root, candidate);
  if (await options.validate() !== true) throw new Error('Initial storage validation failed');
  assertCheckpointedInitialCandidate(root, candidate);
  await syncFile(candidate.databasePath);
  return publishInitialManifest(root, candidate, options);
}
/** Synchronous schema-only initialization. Never use this to flush a large initial index. */
export function publishInitialGenerationSync(dataDir: string, candidate: GenerationCandidate,
  options: Omit<InitialGenerationPublicationOptions, 'validate'> & { validate: () => boolean }): GenerationLocation {
  const root = path.resolve(dataDir);
  assertEmptyInitialStore(root, options.lock);
  if (options.signal?.aborted) throw new Error('Initial storage publication cancelled');
  assertCheckpointedInitialCandidate(root, candidate);
  if (options.validate() !== true) throw new Error('Initial storage validation failed');
  assertCheckpointedInitialCandidate(root, candidate);
  const fd = fs.openSync(candidate.databasePath, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return publishInitialManifest(root, candidate, options);
}

/** Unknown filesystem capacity is not permission to start a large rebuild. */
export function hasRebuildDiskSpace(dataDir: string, estimatedBytes: number): boolean {
  if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes <= 0) return false;
  try {
    const stat = fs.statfsSync(dataDir, { bigint: true });
    return stat.bavail * stat.bsize >= BigInt(estimatedBytes);
  } catch { return false; }
}

/** Pin the exact resolved path BEFORE opening its SQLite connection. */
export function acquireCurrentGenerationLease(dataDir: string): GenerationLease {
  // Legacy flat databases are never collected; avoid requiring native SQLite for WASM.
  try { fs.lstatSync(path.join(dataDir, 'CURRENT')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { id: null, databasePath: path.join(path.resolve(dataDir), 'codegraph.db'), release() {} };
  }
  return withLifecycleGate(dataDir, gate => {
    const location = resolveGeneration(dataDir);
    const lease = location.id === null ? { release() {} } : acquireLifecycleLease(gate, location.id, true);
    return wrapLease(dataDir, location, lease);
  });
}
export function acquireGenerationLease(dataDir: string, id: string, options: { allowUnmanaged?: boolean } = {}): GenerationLease {
  return withLifecycleGate(dataDir, gate => {
    const candidate = candidatePath(dataDir, id);
    const lease = acquireLifecycleLease(gate, id, options.allowUnmanaged === true);
    return wrapLease(dataDir, candidate, lease);
  });
}
function wrapLease(dataDir: string, location: GenerationLocation, lease: LifecycleLease): GenerationLease {
  let released = false;
  return { id: location.id, databasePath: location.databasePath, release() {
    if (released) return;
    lease.release(); released = true;
    collectRetiredGenerations(dataDir);
  } };
}
/** Safe to invoke on startup and after close. Busy/unknown state never authorizes deletion. */
const collections = new Map<string, Promise<void>>();
export function collectRetiredGenerations(dataDir: string): Promise<void> {
  const root = path.resolve(dataDir);
  const previous = collections.get(root) ?? Promise.resolve();
  const task = previous.then(async () => {
    if (!fs.existsSync(path.join(root, '.generation-lifecycle.sqlite'))) return;
    try {
      const sealed = withLifecycleGate(root, gate => collectLifecycleGenerations(gate, resolveGeneration(root).id));
      await removeSealedGenerations(root, sealed);
    } catch { /* Collection is best effort and cannot invalidate a query/publication. */ }
  });
  collections.set(root, task);
  void task.finally(() => { if (collections.get(root) === task) collections.delete(root); });
  return task;
}
/** Wait only for already-scheduled reclamation before a process exits. Close all
 * readers/builders first; this neither expires live leases nor retries busy IDs.
 */
export async function drainGenerationCollections(): Promise<void> {
  while (collections.size > 0) await Promise.all([...collections.values()]);
}

/** Call only after the build child has exited and validation connections closed. */
export function cleanupGenerationCandidate(dataDir: string, candidate: GenerationCandidate): void {
  const expected = candidatePath(dataDir, candidate.id);
  if (expected.directory !== candidate.directory || expected.databasePath !== candidate.databasePath) throw new Error('Foreign generation candidate');
  candidate.buildLease?.release();
  candidate.buildLease = undefined;
  collectRetiredGenerations(dataDir);
}
