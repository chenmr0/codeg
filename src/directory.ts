/**
 * Directory Management
 *
 * Manages the .codegraph/ directory structure for CodeGraph data.
 */

import * as fs from 'fs';
import * as path from 'path';
import { acquireCurrentGenerationLease } from './sync/generation-store';
import { PortableCoordinator } from './sync/portable/protocol';
function hasPortableRuntime(directory: string): boolean { return fs.existsSync(path.join(directory, '.runtime', 'portable', 'gate.sqlite')); }

/** New indexes use wx; existing indexes remain readable during the transition. */
const DEFAULT_CODEGRAPH_DIR = '.codegraph-wx';
const LEGACY_CODEGRAPH_DIR = '.codegraph';

let warnedBadDirName = false;

// A dangling/symlink CURRENT still selects this directory and must fail closed
// during resolution, rather than silently exposing a different legacy index.
function hasCurrentManifest(directory: string): boolean {
  try { fs.lstatSync(path.join(directory, 'CURRENT')); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Resolve the per-project data directory name, honoring the `CODEGRAPH_DIR`
 * environment override (default `.codegraph-wx`). The override is a single path
 * segment that lives in the project root.
 *
 * Why this exists: two environments that share one working tree must NOT share
 * one `.codegraph/` — most concretely Windows-native and WSL (issue #636). The
 * daemon lockfile (`.codegraph/daemon.pid`) records a platform-specific pid and
 * socket path (a Windows named pipe vs a WSL Unix socket), and SQLite file
 * locking across the WSL2 ↔ Windows filesystem boundary is unreliable, so two
 * daemons sharing one index risks corruption. Setting `CODEGRAPH_DIR=.codegraph-win`
 * on one side gives each environment its own index in the same tree.
 *
 * Read live (not captured at load) so it is both process-accurate and testable.
 * An override that isn't a plain directory name — empty, containing a path
 * separator, `.`, `..`/traversal, or absolute — is ignored (we keep the
 * default) rather than risk writing the index outside the project or into the
 * project root itself; we warn once to stderr so the misconfiguration is seen.
 */
function configuredDirName(): string | undefined {
  const raw = process.env.CODEGRAPH_DIR?.trim();
  if (!raw) return undefined;
  if (!validDirName(raw)) {
    if (!warnedBadDirName) {
      warnedBadDirName = true;
      // stderr only — stdout is the MCP protocol channel.
      console.warn(
        `[codegraph] Ignoring invalid CODEGRAPH_DIR="${raw}" — it must be a plain ` +
          `directory name (no path separators, no "..", not absolute). Using "${DEFAULT_CODEGRAPH_DIR}".`
      );
    }
    return undefined;
  }
  return raw;
}

function validDirName(name: string): boolean {
  return !!name && name !== '.' && !name.includes('..') &&
    !name.includes('/') && !name.includes('\\') && !path.isAbsolute(name);
}

/** Preferred directory for new indexes; explicit CODEGRAPH_DIR stays authoritative. */
export function codeGraphDirName(): string {
  return configuredDirName() ?? DEFAULT_CODEGRAPH_DIR;
}

/** Set CODEGRAPH_LEGACY_COMPAT=0 (or false) to stop automatic old-path discovery. */
export function legacyCompatibilityEnabled(): boolean {
  const value = process.env.CODEGRAPH_LEGACY_COMPAT?.trim().toLowerCase();
  return value !== '0' && value !== 'false';
}

/**
 * CodeGraph directory name — a load-time snapshot of {@link codeGraphDirName}.
 * A running process's environment is fixed, so this equals the live value;
 * it's kept as a stable string export for backward compatibility. Internal code
 * resolves the name through {@link codeGraphDirName} / {@link getCodeGraphDir}
 * so the `CODEGRAPH_DIR` override always applies.
 */
export const CODEGRAPH_DIR = codeGraphDirName();

/**
 * Is `name` (a single path segment) a CodeGraph data directory? Matches the
 * default `.codegraph`, the active `CODEGRAPH_DIR` override, and any
 * `.codegraph-*` sibling. File-watching and the indexer skip ALL of these, so
 * when two environments share one working tree (Windows + WSL, issue #636)
 * neither indexes or watches the other's index directory.
 */
export function isCodeGraphDataDir(name: string): boolean {
  return (
    name === LEGACY_CODEGRAPH_DIR ||
    name === codeGraphDirName() ||
    name.startsWith(LEGACY_CODEGRAPH_DIR + '-')
  );
}

/**
 * Resolve the active data directory. Prefer the new database, then optionally
 * use an existing legacy database in place. An empty new directory does not
 * hide the old index; an existing but corrupt new database never falls back.
 * Explicit CODEGRAPH_DIR selects exactly that directory, without fallback.
 */
export function getCodeGraphDir(projectRoot: string): string {
  const configured = configuredDirName();
  const preferred = path.join(projectRoot, configured ?? DEFAULT_CODEGRAPH_DIR);
  if (configured || !legacyCompatibilityEnabled() ||
      (hasPortableRuntime(preferred) || fs.existsSync(path.join(preferred, 'codegraph.db')) || hasCurrentManifest(preferred))) return preferred;
  const legacy = path.join(projectRoot, LEGACY_CODEGRAPH_DIR);
  return (hasPortableRuntime(legacy) || fs.existsSync(path.join(legacy, 'codegraph.db')) || hasCurrentManifest(legacy)) ? legacy : preferred;
}

/**
 * Check if a project has been initialized with CodeGraph
 * Requires both .codegraph/ directory AND codegraph.db to exist
 */
export function isInitialized(projectRoot: string): boolean {
  const codegraphDir = getCodeGraphDir(projectRoot);
  if (!fs.existsSync(codegraphDir) || !fs.statSync(codegraphDir).isDirectory()) {
    return false;
  }
  if (hasPortableRuntime(codegraphDir)) {
    const coordinator = new PortableCoordinator(codegraphDir);
    if (!fs.existsSync(coordinator.active) || coordinator.snapshot().mode !== 'idle') coordinator.recover();
    return fs.existsSync(coordinator.active);
  }
  // A published target must remain pinned through the existence check.
  // Callers opening a DB subsequently acquire their own fresh CURRENT lease;
  // this probe never hands an unprotected generation path to them.
  const lease = acquireCurrentGenerationLease(codegraphDir);
  try { return fs.existsSync(lease.databasePath); }
  finally { lease.release(); }
}

/** Discovery before an actual open: a managed active file identifies the
 * project. The facade recovers and admits the connection under its lease.
 * An absent active file still requires checking for interrupted publication. */
export function hasIndexForOpen(projectRoot: string): boolean {
  const dir = getCodeGraphDir(projectRoot);
  return (hasPortableRuntime(dir) && fs.existsSync(path.join(dir, 'codegraph.db'))) || isInitialized(projectRoot);
}

/**
 * Find the nearest parent directory containing .codegraph/
 *
 * Walks up from the given path to find a CodeGraph-initialized project,
 * similar to how git finds .git/ directories.
 *
 * @param startPath - Directory to start searching from
 * @returns The project root containing .codegraph/, or null if not found
 */
export function findNearestCodeGraphRoot(startPath: string): string | null {
  let current = path.resolve(startPath);
  const root = path.parse(current).root;

  while (current !== root) {
    if (isInitialized(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break; // Reached filesystem root
    current = parent;
  }

  // Check root as well
  if (isInitialized(current)) {
    return current;
  }

  return null;
}

/**
 * Create the .codegraph directory structure
 * Note: Only throws if codegraph.db already exists, not just if .codegraph/ exists.
 */
export function createDirectory(projectRoot: string): void {
  const codegraphDir = getCodeGraphDir(projectRoot);
  // The probe must pin its resolved generation until validation finishes.
  // A concurrent publication may retire it immediately after this check.
  const lease = acquireCurrentGenerationLease(codegraphDir);
  try {
    if (fs.existsSync(lease.databasePath)) {
      throw new Error(`CodeGraph already initialized in ${projectRoot}`);
    }
  } finally { lease.release(); }

  // Create main directory (if it doesn't exist)
  fs.mkdirSync(codegraphDir, { recursive: true });

  // Git ignore rules belong to the user; never create or alter .gitignore.
}

/**
 * Remove the .codegraph directory
 */
export function removeDirectory(projectRoot: string, directoryName?: string): void {
  // A live CodeGraph instance pins the directory it actually opened, so a
  // newly created preferred index cannot redirect deletion of an old one.
  if (directoryName !== undefined && !validDirName(directoryName)) {
    throw new Error(`Invalid subdirectory name: ${directoryName}`);
  }
  const codegraphDir = directoryName === undefined
    ? getCodeGraphDir(projectRoot) : path.join(projectRoot, directoryName);

  if (!fs.existsSync(codegraphDir)) {
    return;
  }

  // Verify .codegraph is a real directory, not a symlink pointing elsewhere
  const lstat = fs.lstatSync(codegraphDir);
  if (lstat.isSymbolicLink()) {
    // Only remove the symlink itself, never follow it for recursive delete
    fs.unlinkSync(codegraphDir);
    return;
  }

  if (!lstat.isDirectory()) {
    // Not a directory - remove the single file
    fs.unlinkSync(codegraphDir);
    return;
  }

  // Maintainer-owned query policy is not index data. Leave it in place so
  // uninit/re-init does not silently discard project terminology. Do not read
  // or follow it here (even malformed configuration must be preserved).
  const mappingFile = 'term-mappings.json';
  const entries = fs.readdirSync(codegraphDir);
  if (entries.includes(mappingFile)) {
    for (const entry of entries) {
      if (entry !== mappingFile) fs.rmSync(path.join(codegraphDir, entry), { recursive: true, force: true });
    }
  } else {
    fs.rmSync(codegraphDir, { recursive: true, force: true });
  }
}

/**
 * Get all files in the .codegraph directory
 */
export function listDirectoryContents(projectRoot: string): string[] {
  const codegraphDir = getCodeGraphDir(projectRoot);

  if (!fs.existsSync(codegraphDir)) {
    return [];
  }

  const files: string[] = [];

  function walkDir(dir: string, prefix: string = ''): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

      // Skip symlinks to prevent following links outside .codegraph
      if (entry.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        walkDir(path.join(dir, entry.name), relativePath);
      } else {
        files.push(relativePath);
      }
    }
  }

  walkDir(codegraphDir);
  return files;
}

/**
 * Get the total size of the .codegraph directory in bytes
 */
export function getDirectorySize(projectRoot: string): number {
  const codegraphDir = getCodeGraphDir(projectRoot);

  if (!fs.existsSync(codegraphDir)) {
    return 0;
  }

  let totalSize = 0;

  function walkDir(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      // Skip symlinks to prevent following links outside .codegraph
      if (entry.isSymbolicLink()) {
        continue;
      }

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else {
        const stats = fs.statSync(fullPath);
        totalSize += stats.size;
      }
    }
  }

  walkDir(codegraphDir);
  return totalSize;
}

/**
 * Ensure a subdirectory exists within .codegraph
 */
export function ensureSubdirectory(projectRoot: string, subdirName: string): string {
  if (subdirName.includes('..') || subdirName.includes(path.sep) || subdirName.includes('/')) {
    throw new Error(`Invalid subdirectory name: ${subdirName}`);
  }

  const subdirPath = path.join(getCodeGraphDir(projectRoot), subdirName);

  if (!fs.existsSync(subdirPath)) {
    fs.mkdirSync(subdirPath, { recursive: true });
  }

  return subdirPath;
}

/**
 * Check if the .codegraph directory has valid structure
 */
export function validateDirectory(projectRoot: string): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const codegraphDir = getCodeGraphDir(projectRoot);

  if (!fs.existsSync(codegraphDir)) {
    errors.push('CodeGraph directory does not exist');
    return { valid: false, errors };
  }

  if (!fs.statSync(codegraphDir).isDirectory()) {
    errors.push('.codegraph exists but is not a directory');
    return { valid: false, errors };
  }

  // Published state is strict: malformed CURRENT/READY or a genuinely missing
  // target is corruption, not an uninitialized project or a legacy fallback.
  // Pin before validating so normal concurrent GC cannot cause ENOENT.
  if (!hasPortableRuntime(codegraphDir) && hasCurrentManifest(codegraphDir)) {
    const lease = acquireCurrentGenerationLease(codegraphDir);
    lease.release();
  }

  // Missing .gitignore is valid: Git exclusions are managed by the user.

  return {
    valid: errors.length === 0,
    errors,
  };
}
