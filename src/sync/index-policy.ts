/** Correctness invalidation is independent of the incremental/rebuild cost decision. */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { loadWorkspacePackages } from '../resolution/workspace-packages';

// v1 could acknowledge an unverified legacy graph without re-extraction. A new
// key deliberately invalidates every v1 baseline once, including already-poisoned
// databases that are indistinguishable from healthy ones. Only complete indexing
// or synchronization may stamp v2; the existing pending key survives interruptions.
export const SEMANTIC_CONFIG_KEY = 'index:semantic-config-v2';
export const SEMANTIC_REINDEX_PENDING = 'index:semantic-reindex-pending-v1';

/** Inputs consumed by extraction/resolution, not inventory-only controls such as ignores/CMake. */
export function semanticConfigFingerprint(root: string, files: ReadonlyArray<{ path: string }>): string {
  const controls = new Set(['tsconfig.json', 'jsconfig.json', 'package.json', 'pnpm-workspace.yaml',
    'go.mod', 'Cargo.toml', 'requirements.txt', 'pyproject.toml', 'Pipfile', 'Gemfile',
    'composer.json', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'build.sbt', 'compile_commands.json', 'build/compile_commands.json',
    'cmake-build-debug/compile_commands.json', 'cmake-build-release/compile_commands.json', 'out/compile_commands.json']);
  for (const file of files) {
    let dir = path.posix.dirname(file.path.replace(/\\/g, '/'));
    while (dir !== '.') {
      controls.add(`${dir}/package.json`);
      controls.add(`${dir}/Cargo.toml`);
      const parent = path.posix.dirname(dir);
      if (parent === dir) throw new Error('Invalid indexed source path');
      dir = parent;
    }
  }
  const inputs = [...controls].sort().map(relative => {
    const absolute = path.resolve(root, relative);
    if (!absolute.startsWith(path.resolve(root) + path.sep)) throw new Error('Index policy path escapes root');
    try { return [relative, crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')]; }
    catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
      throw error;
    }
  }).filter(value => value !== null);
  // Include discovered workspace members, including newly created packages not yet indexed.
  const workspaces = [...(loadWorkspacePackages(root)?.byName ?? [])].sort(([a], [b]) => a.localeCompare(b));
  return crypto.createHash('sha256').update(JSON.stringify([inputs, workspaces])).digest('hex');
}

export function requiresSemanticReindex(indexedSemantic: string | null, currentSemantic: string,
  _indexedConfig: string | null, _currentConfig: string, upgradeRequired: boolean, pending = false): boolean {
  if (upgradeRequired || pending) return true;
  if (indexedSemantic !== null) return indexedSemantic !== currentSemantic;
  // Neither a missing legacy baseline nor an equal broad/v1 fingerprint proves
  // that stored references were resolved with the current semantic configuration.
  // Re-extract once; the cost planner remains free to choose incremental/rebuild.
  return true;
}
