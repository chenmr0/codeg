import { assertNoFixedPathInitialization } from '../fixed-path-initialization';
import { lease, paths } from './protocol';
import type { GenerationLease } from '../generation-store';
import * as fs from 'node:fs';
import * as path from 'node:path';
// Synchronous construction capability only. It never survives an await and is
// not itself a lease: callers already hold protocol admission before entering.
const admitted = new Map<string, number>();
/** Identify the actual target before applying fixed-root admission rules. A
 * filename alias must not turn a registered native connection into legacy. */
export function fixedPathDatabaseKey(file: string): string {
  const absolute = path.resolve(file);
  try { return fs.realpathSync.native(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try { if (fs.lstatSync(absolute).isSymbolicLink()) throw new Error('Dangling database symlink cannot acquire lifecycle admission'); }
    catch (linkError) { if ((linkError as NodeJS.ErrnoException).code !== 'ENOENT') throw linkError; }
    try { return path.join(fs.realpathSync.native(path.dirname(absolute)), path.basename(absolute)); }
    catch (parentError) { if ((parentError as NodeJS.ErrnoException).code !== 'ENOENT') throw parentError; return absolute; }
  }
}
export function withFixedPathOpen<T>(file: string, action: () => T): T {
  const key = fixedPathDatabaseKey(file), count = admitted.get(key) ?? 0;
  admitted.set(key, count + 1);
  try { return action(); }
  finally { if (count) admitted.set(key, count); else admitted.delete(key); }
}
export function assertFixedPathOpenAdmitted(file: string): void {
  const absolute = fixedPathDatabaseKey(file);
  if (path.basename(absolute) !== 'codegraph.db') return;
  assertNoFixedPathInitialization(path.dirname(absolute));
  if (!fs.existsSync(path.join(path.dirname(absolute), '.runtime', 'layout.json'))) return;
  if (!admitted.has(absolute)) throw new Error('Registered fixed-path database must be opened through CodeGraph lifecycle admission');
}

/** Independent storage ownership survives a failed constructor/close. The DB
 * wrapper retains this lease alongside DatabaseOpenError.connection. */
export function acquireAuthorizedFixedPathLease(file: string): GenerationLease | undefined {
  const absolute = fixedPathDatabaseKey(file);
  if (path.basename(absolute) === 'codegraph.db') assertNoFixedPathInitialization(path.dirname(absolute));
  if (path.basename(absolute) !== 'codegraph.db' || !fs.existsSync(path.join(path.dirname(absolute), '.runtime', 'layout.json'))) return undefined;
  assertFixedPathOpenAdmitted(absolute);
  const p = paths({ project: path.dirname(path.dirname(absolute)), dataDirectory: path.dirname(absolute) });
  const holder = lease(p.connections);
  if (!holder) throw new Error('Fixed-path native connection lost admission');
  let released = false;
  return { id: null, databasePath: absolute, release() { if (released) return; holder.close(); released = true; } };
}
