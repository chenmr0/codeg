import * as fs from 'fs';
import * as path from 'path';
import { existingPathIdentity, isWithinExistingDirectory } from '../path-identity';
import { validatePathWithinRoot } from '../utils';
import { ScanCoverageError } from './scan-coverage';

// Git for Windows may descend through a junction cycle before emitting its
// name-too-long warning. Ignore only a proven cycle, which the walker deduplicates.
export function isGitJunctionCycleWarning(root: string, warning: string): boolean {
  if (process.platform !== 'win32') return false;
  const match = /^warning: (?:unable to access|could not open directory) '(.+)': Filename too long$/.exec(warning);
  if (!match || path.isAbsolute(match[1]!)) return false;
  let current = root;
  const seen = new Set([existingPathIdentity(root)]);
  for (const part of match[1]!.split('/')) {
    if (!part || part === '.' || part === '..') return false;
    current = path.join(current, part);
    const id = existingPathIdentity(current);
    if (!id) return false;
    if (seen.has(id)) return true;
    seen.add(id);
  }
  return false;
}

/** Inspect directory entries once per parent, not lstat once per Git file.
 * Git for Windows can expand junctions itself: remove all such descendants and
 * let the bounded walker enumerate them once with authorization/ignore checks.
 */
export function separateGitDirectoryLinks(root: string, files: Set<string>): { ordinary: Set<string>; external: string[] } {
  const ordinary = new Set<string>();
  const external = new Set<string>();
  const entries = new Map<string, Map<string, fs.Dirent>>();
  const links = new Map<string, boolean>();
  const realRoot = fs.realpathSync(root);
  const getEntry = (parent: string, name: string) => {
    let map = entries.get(parent);
    if (!map) {
      try { map = new Map(fs.readdirSync(path.join(root, parent), { withFileTypes: true }).map(e => [e.name, e])); }
      catch (error) { throw new ScanCoverageError(path.join(root, parent), error); }
      entries.set(parent, map);
    }
    const exact = map.get(name);
    if (exact || process.platform !== 'win32') return exact;

    // Git can retain the previous spelling after a case-only rename. Ask
    // the filesystem instead of treating a cache miss as proof of deletion.
    const file = path.join(root, parent, name);
    const stat = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
    if (!stat) return undefined;
    if (!stat.isSymbolicLink()) {
      const actual = path.basename(fs.realpathSync.native(file));
      return map.get(actual) ?? stat;
    }
    if (!stat.ino) throw new ScanCoverageError(file, 'link identity unavailable');
    for (const candidate of map.values()) {
      if (!candidate.isSymbolicLink()) continue;
      const other = fs.lstatSync(path.join(root, parent, candidate.name), { bigint: true });
      if (other.dev === stat.dev && other.ino === stat.ino) return candidate;
    }
    throw new ScanCoverageError(file, 'directory entry changed while scanning');
  };
  for (const logical of files) {
    const parts = logical.split('/').filter(Boolean);
    let parent = '', intercepted = false;
    for (let i = 0; i < parts.length; i++) {
      const entry = getEntry(parent, parts[i]!);
      if (!entry) { intercepted = true; break; } // raced removal
      const name = 'name' in entry ? entry.name : parts[i]!;
      const current = parent ? path.posix.join(parent, name) : name;
      if (entry.isSymbolicLink()) {
        let directory = links.get(current);
        if (directory === undefined) {
          try {
            const target = fs.realpathSync(path.join(root, current));
            directory = fs.statSync(target).isDirectory();
            // Only explicit external opt-in may add new paths to Git's list.
            const rel = path.relative(realRoot, target);
            if (directory && process.env.CODEGRAPH_ALLOWED_SOURCE_ROOTS) {
              const outside = process.platform === 'win32' ? !isWithinExistingDirectory(target, realRoot, true) :
                rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel);
              if (outside && validatePathWithinRoot(root, current, true)) external.add(current);
            }
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'ELOOP') throw new ScanCoverageError(current, error);
            directory = true; // broken/cyclic links are not files or fallback triggers
          }
          links.set(current, directory);
        }
        if (directory) { intercepted = true; break; }
      }
      if (i < parts.length - 1 && !entry.isDirectory()) { intercepted = true; break; }
      parent = current;
    }
    if (!intercepted) ordinary.add(logical);
  }
  return { ordinary, external: [...external] };
}
