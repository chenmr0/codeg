/**
 * Generation publication protocol. CURRENT is the only file replaced: an open
 * SQLite database, its WAL and its SHM are never renamed or deleted. Retired
 * generations are retained until an explicit offline cleanup.
 *
 * All writers must use this version of the protocol. Older binaries cannot be
 * made safe by a manifest they do not understand.
 */
import fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

const GENERATION_ID = /^g-[a-zA-Z0-9-]{1,100}$/;
const MAX_MANIFEST_BYTES = 4096;
export interface GenerationLocation { id: string | null; databasePath: string; }
export interface GenerationCandidate extends GenerationLocation { id: string; directory: string; }
interface GenerationManifest { version: 1; generation: string; token: string; complete: true; }

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
  if (!value || value.version !== 1 || typeof value.generation !== 'string' ||
      !GENERATION_ID.test(value.generation) || value.complete !== true ||
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
  if (ready.generation !== manifest.generation || ready.token !== manifest.token) {
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
  fs.mkdirSync(candidate.directory);
  return candidate;
}
function assertRootLock(dataDir: string, lock: GenerationWriterLock): void {
  if (lock.lockPath !== getGenerationRootLockPath(dataDir)) throw new Error('Wrong generation root lock');
  lock.assertHeld();
}
function syncFile(file: string): void {
  const fd = fs.openSync(file, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function syncDirectory(directory: string): void {
  // Windows cannot open directories with fs.open. Atomic rename remains the
  // visibility boundary, but durable directory fsync is not promised there.
  if (process.platform !== 'win32') syncFile(directory);
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
  syncFile(candidate.databasePath);
  const manifest: GenerationManifest = { version: 1, generation: candidate.id, token: randomUUID(), complete: true };
  exclusiveJson(path.join(candidate.directory, 'READY.json'), manifest);
  syncDirectory(candidate.directory);
  syncDirectory(path.join(root, 'generations'));
  const temporary = path.join(root, `.CURRENT-${manifest.token}.tmp`);
  let published = false;
  try {
    exclusiveJson(temporary, manifest);
    if (await options.sourceUnchanged() !== true) throw new Error('Source changed while building; retaining old generation');
    compare();
    // Never unlink CURRENT before rename: readers see the old or new manifest.
    fs.renameSync(temporary, path.join(root, 'CURRENT'));
    published = true;
    syncDirectory(root);
    return { id: candidate.id, databasePath: candidate.databasePath };
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* already renamed or absent */ }
    throw new GenerationPublicationError(
      published ? 'New generation is visible, but publication durability is uncertain' : String(error),
      published, error,
    );
  }
}

/** Unknown filesystem capacity is not permission to start a large rebuild. */
export function hasRebuildDiskSpace(dataDir: string, estimatedBytes: number): boolean {
  if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes <= 0) return false;
  try {
    const stat = fs.statfsSync(dataDir, { bigint: true });
    return stat.bavail * stat.bsize >= BigInt(estimatedBytes);
  } catch { return false; }
}
