/** Filesystem identities, not Unicode string folding, define Windows equality. */
import * as fs from 'fs';
import * as path from 'path';

/** Returns the volume/device and file identifier. Never caches mutable paths. */
export function existingPathIdentity(value: string): string | null {
  try {
    const stat = fs.statSync(value, { bigint: true });
    // Some filesystems cannot supply an identifier. Fail closed for equality.
    return stat.ino === 0n ? null : `${stat.dev}:${stat.ino}`;
  } catch { return null; }
}

export function sameExistingPath(left: string, right: string): boolean {
  const id = existingPathIdentity(left);
  return id !== null && id === existingPathIdentity(right);
}

/** Call with resolved real paths. A lexical prefix is not an authorization. */
export function isWithinExistingDirectory(target: string, root: string): boolean {
  const rootId = existingPathIdentity(root);
  if (rootId === null) return false;
  let current = path.resolve(target);
  for (;;) {
    if (existingPathIdentity(current) === rootId) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/** Lexical guard only. Never applies Unicode folding (K and K may differ). */
export function asciiCaseKey(value: string): string {
  return value.replace(/[A-Z]/g, c => c.toLowerCase());
}
