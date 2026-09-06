import * as fs from 'fs';
import * as path from 'path';
import ignore, { type Ignore } from 'ignore';
import { canonicalFilePath, normalizePath } from '../utils';
import { isCodeGraphDataDir } from '../directory';
import { isSourceFile } from './grammars';
import type { ScanDiagnostics } from './sync-diagnostics';

/** undefined: no negations; null: needs the established full-walk semantics. */
export function planSupplementRoots(patterns: string): string[] | null | undefined {
  const roots: string[] = [];
  for (const raw of patterns.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('!') || line.length < 2) continue;
    // Start with literal, root-anchored DIRECTORY rules only. Escapes, globs,
    // file-vs-directory ambiguity and Unicode case folding stay on full walk.
    if (line !== raw || !/^!\/[A-Za-z0-9_ .\/-]+\/$/.test(line)) return null;
    const root = line.slice(2, -1);
    if (root.split('/').some(part => !part || part === '.' || part === '..')) return null;
    roots.push(root.toLowerCase());
    if (roots.length > 32) return null;
  }
  if (roots.length === 0) return undefined;
  const unique = [...new Set(roots)];
  return unique.filter(root => !unique.some(other => root !== other && root.startsWith(other + '/')));
}

export class HybridScanFallback extends Error {}

interface ScopedIgnore { dir: string; ig: Ignore }
interface DirectoryInfo {
  relative: string;
  real: string;
  entries: fs.Dirent[];
  byName: Map<string, fs.Dirent>;
  matchers: ScopedIgnore[];
}

interface HybridOptions {
  rootIgnore: Ignore;
  readPatterns: (file: string) => string;
  git: (args: string[]) => string;
  supplement: () => string[];
  diagnostics?: ScanDiagnostics;
}

/**
 * Git is a candidate enumerator, NEVER a clean-working-tree oracle. Reapply
 * precisely the walk's root + nested matcher chain; directory entries prove
 * presence/type and supply the same spelling/order as the filesystem walk.
 * Unsupported repository/link shapes throw before any index mutation.
 */
export function collectHybridFiles(rootDir: string, roots: string[], options: HybridOptions): Set<string> {
  const diagnostics = options.diagnostics;
  const candidates = new Set<string>();
  const tracked = options.git(['ls-files', '-z', '--stage']);
  for (const row of tracked.split('\0')) {
    if (!row) continue;
    const match = /^(\d+) [a-f0-9]+ ([0-3])\t([\s\S]+)$/.exec(row);
    if (!match || match[2] !== '0') throw new HybridScanFallback('unmerged-index');
    if (match[1] === '120000') throw new HybridScanFallback('symlink');
    if (match[1] === '160000') throw new HybridScanFallback('submodule');
    if (match[1] !== '100644' && match[1] !== '100755') throw new HybridScanFallback('index-mode');
    candidates.add(normalizePath(match[3]!));
  }
  // Full walk does NOT honor the user's global Git excludes. Do not use
  // --exclude-standard here: opt into only the rules that the walk uses.
  const args = ['ls-files', '-z', '-o', '--exclude-per-directory=.gitignore'];
  const exclude = path.join(rootDir, '.git', 'info', 'exclude');
  if (fs.existsSync(exclude)) args.push('--exclude-from=' + exclude);
  for (const raw of options.git(args).split('\0')) {
    if (!raw) continue;
    if (raw.endsWith('/')) throw new HybridScanFallback('embedded-repository');
    const file = normalizePath(raw);
    try {
      if (fs.lstatSync(path.join(rootDir, file)).isSymbolicLink()) throw new HybridScanFallback('symlink');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    candidates.add(file);
  }
  if (diagnostics) diagnostics.gitCandidates = candidates.size;

  const started = performance.now();
  const reuse = process.env.CODEGRAPH_NO_SCAN_PATH_REUSE !== '1';
  const key = (name: string) => process.platform === 'win32' ? name.toLowerCase() : name;
  const directories = new Map<string, DirectoryInfo | null>();
  const ignored = (file: string, isDir: boolean, matchers: ScopedIgnore[]) => matchers.some(({ dir, ig }) => {
    const relative = dir ? file.slice(dir.length + 1) : file;
    return ig.ignores(relative + (isDir ? '/' : ''));
  });
  const directory = (relative: string): DirectoryInfo | null => {
    const cached = directories.get(key(relative));
    if (cached !== undefined) return cached;
    let matchers: ScopedIgnore[];
    if (!relative) matchers = [{ dir: '', ig: options.rootIgnore }];
    else {
      const parentName = path.posix.dirname(relative);
      const parent = directory(parentName === '.' ? '' : parentName);
      const entry = parent?.byName.get(key(path.posix.basename(relative)));
      if (!parent || !entry || isCodeGraphDataDir(entry.name) || entry.name === '.git') {
        directories.set(key(relative), null); return null;
      }
      if (entry.isSymbolicLink()) throw new HybridScanFallback('symlink');
      if (!entry.isDirectory() || ignored(relative, true, parent.matchers)) {
        directories.set(key(relative), null); return null;
      }
      relative = parent.relative ? parent.relative + '/' + entry.name : entry.name;
      matchers = parent.matchers;
    }
    const full = path.join(rootDir, relative);
    const real = fs.realpathSync(full);
    const entries = fs.readdirSync(full, { withFileTypes: true });
    if (diagnostics) diagnostics.gitDirectories++;
    if (relative && entries.some(entry => entry.name === '.gitignore')) {
      const ignoreStarted = diagnostics ? performance.now() : 0;
      try {
        const patterns = options.readPatterns(path.join(full, '.gitignore'));
        if (patterns) matchers = [...matchers, { dir: relative, ig: ignore().add(patterns) }];
      } finally {
        if (diagnostics) diagnostics.ignoreBuildMs += performance.now() - ignoreStarted;
      }
    }
    // A link may hide source behind a non-source-looking name. Do not rely on
    // Git's candidate suffixes to decide whether it needs directory traversal.
    if (entries.some(entry => entry.isSymbolicLink())) throw new HybridScanFallback('symlink');
    const value = { relative, real, entries, byName: new Map(entries.map(entry => [key(entry.name), entry])), matchers };
    directories.set(key(relative), value);
    return value;
  };

  interface Tree { children: Map<string, Tree>; file?: string }
  const tree: Tree = { children: new Map() };
  const add = (file: string) => {
    let node = tree;
    for (const segment of file.split('/')) {
      let child = node.children.get(key(segment));
      if (!child) { child = { children: new Map() }; node.children.set(key(segment), child); }
      node = child;
    }
    node.file = file;
  };
  try {
    for (const file of candidates) {
      if (!isSourceFile(file)) continue;
      if (file.split('/').some(part => !part || part === '.' || part === '..' || part === '.git' || isCodeGraphDataDir(part))) continue;
      // Included subtrees are enumerated by the original walker below, so
      // ignored files and case variants receive exactly its matcher semantics.
      if (roots.some(root => file.toLowerCase().startsWith(root + '/'))) continue;
      const parentName = path.posix.dirname(file);
      const parent = directory(parentName === '.' ? '' : parentName);
      if (!parent) continue;
      const entry = parent.byName.get(key(path.posix.basename(file)));
      if (!entry) continue; // Git may still list a deleted tracked file.
      if (entry.isSymbolicLink()) throw new HybridScanFallback('symlink');
      if (!entry.isFile()) continue;
      const logical = parent.relative ? parent.relative + '/' + entry.name : entry.name;
      if (!ignored(logical, false, parent.matchers)) add(logical);
    }
  } finally {
    if (diagnostics) diagnostics.filterCanonicalMs += performance.now() - started;
  }

  for (const file of options.supplement()) add(file);
  // Preserve readdir depth-first order, not Git's order or locale sorting:
  // candidate insertion order can affect existing equal-score heuristics.
  const result = new Set<string>();
  const emit = (relative: string, branch: Tree): void => {
    const parent = directory(relative);
    if (!parent) return;
    for (const entry of parent.entries) {
      const child = branch.children.get(key(entry.name));
      if (!child) continue;
      const logical = parent.relative ? parent.relative + '/' + entry.name : entry.name;
      if (child.file && entry.isFile()) {
        result.add(canonicalFilePath(rootDir, logical, reuse ? path.join(parent.real, entry.name) : undefined));
        if (reuse && diagnostics) diagnostics.canonicalFromParent++;
      }
      if (child.children.size && entry.isDirectory()) emit(logical, child);
    }
  };
  const emitStarted = performance.now();
  try { emit('', tree); }
  finally { if (diagnostics) diagnostics.filterCanonicalMs += performance.now() - emitStarted; }
  return result;
}
