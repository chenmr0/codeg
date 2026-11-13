/** Normalize only for IPC identity/comparison, never for filesystem access. */
import * as fs from 'fs';
import * as path from 'path';

export function projectPathIdentity(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function sameProjectPath(left: string, right: string): boolean {
  const canonical = (value: string) => {
    try { return fs.realpathSync(value); } catch { return value; }
  };
  return projectPathIdentity(canonical(left)) === projectPathIdentity(canonical(right));
}
