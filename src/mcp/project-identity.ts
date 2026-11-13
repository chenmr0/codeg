/** Normalize only for IPC identity/comparison, never for filesystem access. */
import * as fs from 'fs';
import * as path from 'path';
import { existingPathIdentity, sameExistingPath } from '../path-identity';

export function projectPathIdentity(value: string): string {
  const resolved = path.resolve(value);
  if (process.platform !== 'win32') return resolved;
  const identity = existingPathIdentity(resolved);
  if (identity !== null) return `file:${identity}`;
  // No Unicode case fold fallback: an unknown path must not alias another root.
  return `path:${resolved}`;
}

export function sameProjectPath(left: string, right: string): boolean {
  if (process.platform === 'win32') return sameExistingPath(left, right);
  const canonical = (value: string) => {
    try { return fs.realpathSync(value); } catch { return value; }
  };
  return projectPathIdentity(canonical(left)) === projectPathIdentity(canonical(right));
}
