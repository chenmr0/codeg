/** Filesystem identities, not Unicode string folding, define Windows equality. */
import * as fs from 'fs';
import * as path from 'path';

/** Returns the volume/device and file identifier. Never caches mutable paths. */
function requireIdentity(value: string): string {
  const stat = fs.statSync(value, { bigint: true });
  if (!(stat.ino > 0n && stat.dev >= 0n)) throw new Error('Filesystem identity unavailable: ' + value);
  return stat.dev + ':' + stat.ino;
}

export function existingPathIdentity(value: string): string | null {
  try { return requireIdentity(value); } catch { return null; }
}

/** Snapshot at open time. Re-resolving a cached handle's path can describe a different directory. */
export function openedDirectoryIdentity(root: string, dataDir: string) {
  return Object.freeze({ rootId: existingPathIdentity(root), dataId: existingPathIdentity(dataDir) });
}

export function sameExistingPath(left: string, right: string): boolean {
  const id = existingPathIdentity(left);
  return id !== null && id === existingPathIdentity(right);
}

/** Call with resolved real paths. A lexical prefix is not an authorization. */
export function isWithinExistingDirectory(target: string, root: string, requireKnown = false): boolean {
  const identity = requireKnown ? requireIdentity : existingPathIdentity;
  const rootId = identity(root);
  if (rootId === null) return false;
  let current = path.resolve(target);
  for (;;) {
    if (identity(current) === rootId) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/** Lexical guard only. Never applies Unicode folding (K and K may differ). */
export function asciiCaseKey(value: string): string {
  return value.replace(/[A-Z]/g, c => c.toLowerCase());
}
