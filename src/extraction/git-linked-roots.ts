import * as fs from 'fs';
import * as path from 'path';
import { validatePathWithinRoot } from '../utils';
import { ScanCoverageError } from './scan-coverage';

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
    return map.get(name);
  };
  for (const logical of files) {
    const parts = logical.split('/').filter(Boolean);
    let parent = '', intercepted = false;
    for (let i = 0; i < parts.length; i++) {
      const current = parent ? `${parent}/${parts[i]}` : parts[i]!;
      const entry = getEntry(parent, parts[i]!);
      if (!entry) { intercepted = true; break; } // raced removal
      if (entry.isSymbolicLink()) {
        let directory = links.get(current);
        if (directory === undefined) {
          try {
            const target = fs.realpathSync(path.join(root, current));
            directory = fs.statSync(target).isDirectory();
            // Only explicit external opt-in may add new paths to Git's list.
            const rel = path.relative(realRoot, target);
            const outside = rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel);
            if (directory && outside && validatePathWithinRoot(root, current, true)) external.add(current);
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'ELOOP') throw new ScanCoverageError(current, error);
            directory = true; // broken/cyclic links are not files or fallback triggers
          }
          links.set(current, directory);
        }
        if (directory) { intercepted = true; break; }
      }
      parent = current;
    }
    if (!intercepted) ordinary.add(logical);
  }
  return { ordinary, external: [...external] };
}
