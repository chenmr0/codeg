/** Correctness invalidation is independent of the incremental/rebuild cost decision. */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { loadWorkspacePackages } from '../resolution/workspace-packages';
import { getLanguageScopeKey } from '../extraction/language-scope';

// The published 1765271 release has neither a semantic nor a broad fingerprint.
// Establish this baseline only after a complete refresh. Keep the existing key:
// later development commits were never released, so healthy v1 indexes do not
// need an unconditional v2 migration for their development-only predecessor bug.
export const SEMANTIC_CONFIG_KEY = 'index:semantic-config-v1';
export const SEMANTIC_REINDEX_PENDING = 'index:semantic-reindex-pending-v1';

const inventoryControls = ['.gitignore', '.codegraphignore', '.git/info/exclude', 'compile_commands.json',
  'compile_flags.txt', 'tsconfig.json', 'jsconfig.json', 'package.json', 'CMakeLists.txt'];
const semanticControls = ['tsconfig.json', 'jsconfig.json', 'package.json', 'pnpm-workspace.yaml',
  'go.mod', 'Cargo.toml', 'requirements.txt', 'pyproject.toml', 'Pipfile', 'Gemfile',
  'composer.json', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'build.sbt', 'compile_commands.json', 'build/compile_commands.json',
  'cmake-build-debug/compile_commands.json', 'cmake-build-release/compile_commands.json', 'out/compile_commands.json'];

type SourceFiles = ReadonlyArray<{ path: string }>;
type ControlRow = [path: string, hash: string | null];
const byPath = ([a]: ControlRow, [b]: ControlRow) => a < b ? -1 : a > b ? 1 : 0;
const digest = (inputs: unknown) => crypto.createHash('sha256').update(JSON.stringify(inputs)).digest('hex');

/** Re-read control bytes at each checkpoint, even for same-size, same-mtime edits. */
function fingerprints(root: string, files: SourceFiles, broad: boolean, semantic: boolean) {
  const inventory: ControlRow[] = [], policy: ControlRow[] = [];
  const directories = new Set<string>();
  for (const file of files) {
    let dir = path.posix.dirname(file.path.replace(/\\/g, '/'));
    while (dir !== '.' && !directories.has(dir)) {
      directories.add(dir);
      const parent = path.posix.dirname(dir);
      if (parent === dir) throw new Error('Invalid indexed source path');
      dir = parent;
    }
  }
  const base = path.resolve(root);
  const read = (relative: string): string | null => {
    const absolute = path.resolve(base, relative);
    if (!absolute.startsWith(base + path.sep)) throw new Error('Index policy path escapes root');
    try {
      // On the common missing-file path, avoid allocating an Error and its stack
      // for each control. lstat keeps dangling links on the normal read path.
      const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
      if (!stat || stat.isDirectory()) return null;
      return crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
    }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // A branch switch can replace a tracked directory with a regular file.
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return null;
      throw error;
    }
  };
  const controls = new Set([...(broad ? inventoryControls : []), ...(semantic ? semanticControls : [])]);
  for (const name of controls) {
    const inventoryInput = broad && inventoryControls.includes(name);
    const hash = read(name);
    if (inventoryInput) inventory.push([name, hash]);
    if (semantic && semanticControls.includes(name) && hash !== null) policy.push([name, hash]);
  }
  const nestedControls = [...(broad ? ['.gitignore', '.codegraphignore'] : []),
    ...(semantic ? ['package.json', 'Cargo.toml'] : [])];
  for (const dir of directories) {
    for (const name of nestedControls) {
      const relative = `${dir}/${name}`;
      const inventoryInput = name.startsWith('.');
      const hash = read(relative);
      if (hash !== null) (inventoryInput ? inventory : policy).push([relative, hash]);
    }
  }
  const members = semantic ? [...(loadWorkspacePackages(root)?.byName ?? [])].sort(([a], [b]) => a.localeCompare(b)) : [];
  return { configFingerprint: broad ? digest([getLanguageScopeKey(), inventory.sort(byPath)]) : '',
    semanticConfigFingerprint: semantic ? digest([policy.sort(byPath), members]) : '' };
}

export function indexConfigFingerprints(root: string, files: SourceFiles) {
  return fingerprints(root, files, true, true);
}
export function adaptiveConfigFingerprint(root: string, files: SourceFiles): string {
  return fingerprints(root, files, true, false).configFingerprint;
}
export function semanticConfigFingerprint(root: string, files: SourceFiles): string {
  return fingerprints(root, files, false, true).semanticConfigFingerprint;
}

export function requiresSemanticReindex(indexedSemantic: string | null, currentSemantic: string,
  _indexedConfig: string | null, _currentConfig: string, upgradeRequired: boolean, pending = false): boolean {
  if (upgradeRequired || pending) return true;
  if (indexedSemantic !== null) return indexedSemantic !== currentSemantic;
  // Neither a missing semantic baseline nor an equal broad fingerprint proves
  // that stored references were resolved with the current semantic configuration.
  // Re-extract once; the cost planner remains free to choose incremental/rebuild.
  return true;
}
