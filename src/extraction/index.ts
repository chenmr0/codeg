/**
 * Extraction Orchestrator
 *
 * Coordinates file scanning, parsing, and database storage.
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import { execFileSync } from 'child_process';
import {
  Language,
  FileRecord,
  ExtractionResult,
  ExtractionTimings,
  ExtractionError,
  SavedCrossFileEdge,
  UnresolvedReference,
  EdgeKind,
} from '../types';
import {
  DEFAULT_WRITE_BATCH_SIZES,
  NATIVE_STORE_WRITE_BATCH_SIZES,
  QueryBuilder,
} from '../db/queries';
import { extractFromSource } from './tree-sitter';
import { detectLanguage, isSourceFile, isLanguageSupported, isFileLevelOnlyLanguage, initGrammars, loadGrammarsForLanguages, readGrammarWasmBytes } from './grammars';
import { isCodeGraphDataDir } from '../directory';
import { logDebug, logWarn } from '../errors';
import { validatePathWithinRoot, normalizePath, canonicalFilePath, clearCanonicalCache } from '../utils';
import ignore, { Ignore } from 'ignore';
import { detectFrameworks } from '../resolution/frameworks';
import type { ResolutionContext } from '../resolution/types';
import { ParseWorkerPool, resolveParsePoolSize } from './parse-pool';
import type { CppMacroDefinition } from './declaration-macros';
import {
  CPP_MACRO_CONTEXT_PENDING_METADATA_KEY,
  CPP_MACRO_MANIFEST_METADATA_KEY,
  CPP_MACRO_MANIFEST_READY_METADATA_KEY,
  buildCppMacroContext,
  cppMacroManifestFromMap,
  cppMacroManifestToMap,
  diffCppMacroContexts,
  isCppMacroContributionEmpty,
  mayContainCppMacroDirective,
  parseCppMacroManifest,
  scanCppMacroFileContribution,
  serializeCppMacroManifest,
  sourceReferencesAnyCppMacro,
  type CppMacroFileContribution,
  type CppMacroManifest,
} from './macro-context';
import { isRetryableParseWorkerError } from './wasm-errors';
import { runOrderedTaskWindow } from './ordered-task-window';
import {
  DEFAULT_STORE_BATCH_LIMITS,
  StoreWriter,
  type StoreBundle,
  batchStoreBundles,
  finalizeStoreBundle,
} from './store-writer';
import {
  hasDeclarationMacroRecoverySkipped,
  replaceWithDeclarationMacroRecoverySkipped,
} from './diagnostics';
import type {
  InitProfile,
  InitProfileParseFileSample,
  InitProfileRecorder,
} from '../performance/init-profile';

/**
 * Number of files to read in parallel during indexing.
 * File reads are I/O-bound; batching overlaps I/O wait with CPU parse work.
 */
const FILE_IO_BATCH_SIZE = 10;
const STREAMING_TASK_MULTIPLIER = 8;
const STREAMING_TASK_MIN = 16;
const STREAMING_TASK_MAX = 64;
const STREAMING_SOURCE_BYTE_LIMIT = 64 * 1024 * 1024;
// C/C++ calibration: OceanBase retained 138,112 completed graph rows at its
// 56-task high-water mark. Leave deliberate headroom while preventing another
// long sequence straggler from admitting unbounded additional parse work.
const STREAMING_C_CPP_RESULT_ROW_LIMIT = 256 * 1024;
const STREAMING_METADATA_BATCH_SIZE = 128;

/**
 * Number of filesystem reconciliation checks between cooperative event-loop
 * yields during sync. Large repositories otherwise run two uninterrupted O(N)
 * loops of synchronous exists/stat calls, which can starve MCP requests and
 * the daemon liveness heartbeat even though the sync itself is healthy.
 */
const SYNC_RECONCILE_YIELD_INTERVAL = 1000;

function isCppMacroLanguage(language: Language): boolean {
  return language === 'c' || language === 'cpp' || language === 'objc';
}

function isCppMacroFilePath(filePath: string): boolean {
  return isCppMacroLanguage(detectLanguage(filePath));
}

const EXTRACTION_TIMING_KEYS: ReadonlyArray<keyof ExtractionTimings> = [
  'primaryParseMs',
  'primaryExtractionMs',
  'declarationMacroExpansionMs',
  'declarationMacroRecoverySourceMs',
  'declarationMacroAuxParseMs',
  'declarationMacroMergeMs',
];

function accumulateExtractionTimings(
  totals: ExtractionTimings,
  timings: ExtractionTimings | undefined,
): void {
  if (!timings) return;
  for (const key of EXTRACTION_TIMING_KEYS) {
    const value = timings[key];
    if (value !== undefined) totals[key] = (totals[key] ?? 0) + value;
  }
}

function formatExtractionTimings(timings: ExtractionTimings): string {
  return EXTRACTION_TIMING_KEYS
    .filter((key) => timings[key] !== undefined)
    .map((key) => `${key}=${Math.round(timings[key] ?? 0)}ms`)
    .join(' ');
}

// PARSER_RESET_INTERVAL moved to parse-worker.ts (runs in worker thread)

/**
 * Maximum time (ms) to wait for a single file to parse in the worker thread.
 * If tree-sitter hangs or WASM runs out of memory, this prevents the entire
 * indexing run from freezing. The worker is restarted after a timeout.
 *
 * Slow storage (HDD, network folders) can need a larger budget; override with
 * the `CODEGRAPH_PARSE_TIMEOUT_MS` env var (non-numeric / non-positive falls
 * back to the default 10s).
 */
const PARSE_TIMEOUT_MS = resolveParseTimeoutMs(process.env.CODEGRAPH_PARSE_TIMEOUT_MS);

/**
 * A worker is only killed once a parse has gone this many × its budget with no
 * result. The base timer firing is NOT proof the parse is still running: after
 * a long synchronous main-thread stretch (the SQLite store on slow disks,
 * issue #1231) Node runs the timers phase before the poll phase, so the
 * expired timer fires BEFORE an already-delivered `parse-result` is processed.
 * Killing at the base timeout therefore produced false timeouts on parses that
 * finished instantly (even 0-byte files). Instead the base timer only marks
 * the job late; a result that arrives before this backstop is accepted, and
 * only a worker that stays silent the whole window is treated as hung.
 */
const HARD_KILL_MULTIPLIER = 3;

function resolveParseTimeoutMs(envVal: string | undefined): number {
  if (envVal !== undefined && envVal !== '') {
    const n = Number(envVal);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return 10_000;
}

/**
 * Number of files to parse before recycling the worker thread.
 * WASM linear memory can grow but NEVER shrink (WebAssembly spec limitation).
 * The only way to reclaim tree-sitter's WASM heap is to destroy the entire
 * V8 isolate by terminating the worker thread and spawning a fresh one.
 * This interval balances memory usage against the cost of reloading grammars.
 */
const WORKER_RECYCLE_INTERVAL = 250;

/**
 * Progress callback for indexing operations
 */
export interface IndexProgress {
  phase: 'scanning' | 'parsing' | 'storing' | 'resolving' | 'synthesizing';
  current: number;
  total: number;
  currentFile?: string;
}

/**
 * Result of an indexing operation
 */
export interface IndexResult {
  /** True when a valid, queryable index was produced, even if coverage is incomplete. */
  success: boolean;
  /** False when any file or recoverable post-processing phase was skipped/failed. */
  complete?: boolean;
  filesIndexed: number;
  filesSkipped: number;
  filesErrored: number;
  nodesCreated: number;
  edgesCreated: number;
  errors: ExtractionError[];
  durationMs: number;
  /** Structured diagnostics collected only when IndexOptions.profile is true. */
  profile?: InitProfile;
}

/**
 * Result of a sync operation
 */
export interface SyncResult {
  /** False when one or more changed files could not be read or parsed. */
  complete?: boolean;
  filesChecked: number;
  filesAdded: number;
  filesModified: number;
  filesRemoved: number;
  /** Number of changed files that were left on their previous index state. */
  filesErrored?: number;
  nodesUpdated: number;
  durationMs: number;
  /** Per-file failures collected while the remaining sync work continued. */
  errors?: ExtractionError[];
  /** Files that must remain pending and be retried by watcher/catch-up sync. */
  failedFilePaths?: string[];
  /** Added/modified files successfully stored and safe for downstream resolution. */
  changedFilePaths?: string[];
  /** Files whose incoming cross-file edges couldn't be fully rewired —
   *  they need co-importer re-indexing as a fallback.  undefined means
   *  edge re-wiring ran and all edges were restored; an empty array
   *  means no rewiring was needed (0 incoming edges). */
  failedRewireSourceFiles?: string[];
  /** Unchanged caller files whose dropped cross-file edges became pending refs. */
  resurrectedReferenceSourceFiles?: string[];
}

/**
 * Calculate SHA256 hash of file contents
 */
export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Rebuild the exact extracted reference stamped on a resolution edge. Edges
 * without a stamp predate this feature or were synthesized; recreating those
 * from the target's plain name could lose C++ namespace/receiver context and
 * bind incorrectly, so they are deliberately skipped.
 */
function resurrectReferenceFromEdge(
  edge: SavedCrossFileEdge
): UnresolvedReference | null {
  let metadata: Record<string, unknown> | undefined;
  if (edge.metadata) {
    try {
      const parsed = JSON.parse(edge.metadata) as unknown;
      if (parsed && typeof parsed === 'object') {
        metadata = parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }

  const referenceName = metadata?.refName;
  if (typeof referenceName !== 'string' || referenceName.length === 0) return null;
  const referenceKind =
    typeof metadata?.refKind === 'string'
      ? (metadata.refKind as EdgeKind)
      : (edge.edgeKind as EdgeKind);
  return {
    fromNodeId: edge.sourceId,
    referenceName,
    referenceKind,
    line: edge.line ?? 0,
    column: edge.col ?? 0,
    filePath: edge.sourceFilePath,
    language: edge.sourceLanguage,
  };
}

/**
 * Absolute upper bound for parse timeout (ms). The per-file timeout scales with
 * file size (base 10s + 10s per 100KB), but is clamped at this ceiling so a
 * single pathological 50MB file can't stall indexing for hours.
 */
const PARSE_TIMEOUT_MAX_MS = 180_000;

/**
 * Files above this size (bytes) log a warning. The preemptive size-based skip
 * was removed — large files are now parsed and only skipped if they actually
 * time out or OOM in the worker. This threshold is diagnostic only.
 */
const FILE_SIZE_WARN_THRESHOLD = 5 * 1024 * 1024;

/**
 * Directory names that are dependency, build, cache, or tooling output across the
 * languages/frameworks CodeGraph supports — curated from the canonical
 * github/gitignore templates. Excluded by default so the graph reflects your code,
 * not third-party noise, without requiring a `.gitignore` (issue #407). The
 * exclusion applies uniformly (git or not, tracked or not); the only opt-in is an
 * explicit `.gitignore` negation (e.g. `!vendor/`). First-party-prone or generic
 * names (`packages`, `lib`, `app`, `bin`, `src`, `deps`, `env`, `tmp`, `storage`,
 * `Library`) are deliberately NOT listed, to avoid ever hiding real source.
 *
 * Only dirs that actually contain *indexable source* (or are enormous) earn a slot
 * — IDE/state dirs like `.idea`/`.vs` are omitted because CodeGraph indexes only
 * recognized source extensions, so they produce no symbols regardless.
 */
const DEFAULT_IGNORE_DIRS: ReadonlySet<string> = new Set([
  // JS / TS — dependency directories
  'node_modules', 'bower_components', 'jspm_packages', 'web_modules',
  '.yarn', '.pnpm-store',
  // JS / TS — framework & bundler build / cache / deploy output
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.vite', '.parcel-cache', '.angular',
  '.docusaurus', 'storybook-static', '.vinxi', '.nitro', 'out-tsc',
  '.vercel', '.netlify', '.wrangler',
  // Build output (common across ecosystems)
  'dist', 'build', 'out', '.output',
  // Test / coverage
  'coverage', '.nyc_output',
  // Python
  '__pycache__', '__pypackages__', '.venv', 'venv', '.pixi', '.pdm-build',
  '.mypy_cache', '.pytest_cache', '.ruff_cache', '.tox', '.nox', '.hypothesis',
  '.ipynb_checkpoints', '.eggs',
  // Rust / JVM (Maven, Gradle, Scala)
  '.gradle',
  // Vendored deps (Go, PHP/Composer, Ruby/Bundler)
  'vendor',
  // Swift / iOS
  '.build', 'Pods', 'Carthage', 'DerivedData', '.swiftpm',
  // Dart / Flutter
  '.dart_tool', '.pub-cache',
  // Native (Android NDK, C/C++ deps)
  '.cxx', '.externalNativeBuild', 'vcpkg_installed',
  // Scala tooling
  '.bloop', '.metals',
  // Lua / Luau (LuaRocks)
  'lua_modules', '.luarocks',
  // Delphi / RAD Studio IDE backups (duplicate .pas source — would double-count)
  '__history', '__recovery',
  // Generic cache
  '.cache',
]);

/** Gitignore-style patterns for the `ignore` matcher: the dirs above plus a few globs. */
const DEFAULT_IGNORE_PATTERNS: string[] = [
  ...Array.from(DEFAULT_IGNORE_DIRS, (d) => `${d}/`),
  '*.egg-info/',     // Python packaging metadata
  'cmake-build-*/',  // CLion / CMake build trees
  'bazel-*/',        // Bazel output symlink trees
];

/** True if `buf` decodes as strict UTF-8 (no invalid byte sequences). */
function isValidUtf8(buf: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a `.gitignore` and return patterns safe to hand to the `ignore` matcher —
 * never throwing, even when the file isn't real gitignore text. Two failure
 * modes, both seen in the wild (issue #682):
 *
 *  - The file isn't valid UTF-8 — e.g. transparently encrypted in place by
 *    corporate DLP / endpoint-security software, leaving a UTF-16 header plus
 *    ciphertext. None of it is meaningful patterns, so the whole file is skipped.
 *  - The file is text but a single line can't be compiled to a regex by the
 *    `ignore` library — `\\[` and friends throw "Unterminated character class".
 *    Crucially the throw is LAZY (at match time, not `.add()`), so it would
 *    otherwise escape mid-scan. That one pattern is dropped; the rest are kept.
 *
 * Either way a warning that NAMES the file is logged (the reporter couldn't tell
 * which `.gitignore` was at fault) and indexing continues instead of aborting.
 * Returns '' when there's nothing usable.
 */
function readGitignorePatterns(giPath: string): string {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(giPath);
  } catch {
    return ''; // unreadable (permissions / race) — treat as absent
  }
  // A NUL byte never appears in real gitignore text, and a fatal UTF-8 decode
  // catches the rest. Such a file isn't ignore patterns at all.
  if (buf.includes(0) || !isValidUtf8(buf)) {
    logWarn(
      'Ignoring a .gitignore that is not valid UTF-8 text — it may have been encrypted ' +
        'in place by endpoint-security software. Indexing continues without it.',
      { file: giPath },
    );
    return '';
  }
  const content = buf.toString('utf-8');
  // Fast path: one `.ignores()` call forces the library to compile EVERY rule,
  // so if it doesn't throw, the whole file is safe to use verbatim.
  try {
    ignore().add(content).ignores('.codegraph-probe');
    return content;
  } catch {
    // Fall through: a line is uncompilable — keep the good ones, drop the bad.
  }
  const kept: string[] = [];
  let dropped = 0;
  for (const line of content.split(/\r?\n/)) {
    try {
      ignore().add(line).ignores('.codegraph-probe');
      kept.push(line);
    } catch {
      dropped++;
    }
  }
  if (dropped > 0) {
    logWarn(
      `Skipped ${dropped} unparseable pattern(s) in a .gitignore; the rest are applied.`,
      { file: giPath },
    );
  }
  return kept.join('\n');
}

/**
 * An `ignore` matcher seeded with the built-in defaults, merged with the project's
 * root .gitignore so a negation there (e.g. `!vendor/`) overrides a default, then
 * merged with `.git/info/exclude` (the repo-local uncommitted exclude file), and
 * finally merged with `.codegraphignore` (if present) as the top layer — the user's
 * explicit extra excludes or overrides scoped to CodeGraph. Shared by both
 * enumeration paths so behavior is identical with or without git — and so the
 * defaults apply to tracked files too (committing a dependency dir doesn't make it
 * project code).
 */
export function buildDefaultIgnore(rootDir: string): Ignore {
  const ig = ignore().add(DEFAULT_IGNORE_PATTERNS);
  const rootGitignore = path.join(rootDir, '.gitignore');
  if (fs.existsSync(rootGitignore)) ig.add(readGitignorePatterns(rootGitignore));
  const gitExclude = path.join(rootDir, '.git', 'info', 'exclude');
  if (fs.existsSync(gitExclude)) ig.add(readGitignorePatterns(gitExclude));
  const cgIgnore = path.join(rootDir, '.codegraphignore');
  if (fs.existsSync(cgIgnore)) ig.add(readGitignorePatterns(cgIgnore));
  return ig;
}

/**
 * Check whether the project's `.codegraphignore` (if present) contains any
 * negation rule (`!` prefix).  Negations re-include files that `.gitignore`
 * already excludes — but `git ls-files` won't report those files at all, so
 * the git fast-path can't surface them.  Callers that detect a negation must
 * fall back to a filesystem walk, which correctly applies the full ignore
 * chain (built-in → .gitignore → .codegraphignore).
 */
function hasCodegraphIgnoreNegation(rootDir: string): boolean {
  const cgIgnore = path.join(rootDir, '.codegraphignore');
  if (!fs.existsSync(cgIgnore)) return false;

  const patterns = readGitignorePatterns(cgIgnore);
  if (!patterns) return false;

  for (const line of patterns.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('!') && trimmed.length > 1) {
      return true;
    }
  }
  return false;
}

/**
 * Collect git-visible files (tracked + untracked, .gitignore-respected) from the
 * git repository rooted at `repoDir`, adding each to `files` with `prefix`
 * prepended so paths stay relative to the original scan root.
 *
 * Recurses into embedded git repositories — nested repos that are NOT submodules
 * (independent clones living inside the workspace, common in CMake "super-repo"
 * layouts). The parent repo's `git ls-files` cannot see into them: tracked output
 * skips them entirely, and untracked output reports them only as an opaque
 * "subdir/" entry (trailing slash) rather than expanding their files. Each
 * embedded repo is its own git boundary, so we re-run `git ls-files` inside it.
 * (See issue #193.)
 */
function collectGitFiles(repoDir: string, prefix: string, files: Set<string>): void {
  const gitOpts = { cwd: repoDir, encoding: 'utf-8' as const, timeout: 30000, maxBuffer: 50 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'], windowsHide: true };

  // Tracked files. --recurse-submodules pulls in files from active submodules,
  // which the index would otherwise represent only as a commit pointer.
  // Without this, monorepos using submodules index 0 files. (See issue #147.)
  // Note: --recurse-submodules only supports -c/--cached and --stage modes — it
  // can't be combined with -o, so untracked files are gathered separately below.
  // -z gives NUL-separated, unquoted output so non-ASCII (e.g. CJK) paths
  // survive verbatim. Without it git octal-escapes and double-quotes such paths
  // (the core.quotepath default), and the quoted form never matches a real file
  // on disk → those files are silently dropped from the index. (#541)
  const tracked = execFileSync('git', ['ls-files', '-z', '-c', '--recurse-submodules'], gitOpts);
  for (const rel of tracked.split('\0')) {
    if (rel) files.add(normalizePath(prefix + rel));
  }

  // Untracked files (submodules manage their own untracked state). Embedded git
  // repos surface here as a single "subdir/" entry that git refuses to descend
  // into — recurse into those as their own repos so their source gets indexed.
  const untracked = execFileSync('git', ['ls-files', '-z', '-o', '--exclude-standard'], gitOpts);
  for (const rel of untracked.split('\0')) {
    if (!rel) continue;
    if (rel.endsWith('/')) {
      // git only emits a trailing-slash directory entry for an embedded repo.
      // Guard with a .git check anyway, and skip anything else exactly as git
      // itself skips it (we never descend into a non-repo opaque dir).
      const childDir = path.join(repoDir, rel);
      if (fs.existsSync(path.join(childDir, '.git'))) {
        collectGitFiles(childDir, prefix + rel, files);
      }
      continue;
    }
    files.add(normalizePath(prefix + rel));
  }
}

/**
 * Get all files visible to git (tracked + untracked but not ignored).
 * Respects .gitignore at all levels (root, subdirectories) and descends into
 * embedded (nested, non-submodule) git repos. Returns null on failure
 * (non-git project) so callers can fall back to a filesystem walk.
 */
function getGitVisibleFiles(rootDir: string): Set<string> | null {
  // .codegraphignore negation rules re-include files git has already excluded,
  // so `git ls-files` never reports them.  Fall back to a filesystem walk.
  if (hasCodegraphIgnoreNegation(rootDir)) return null;

  try {
    // Check if the project directory is gitignored by a parent repo.
    // When rootDir lives inside a parent git repo that ignores it,
    // `git ls-files` returns nothing — fall back to filesystem walk.
    const gitRoot = execFileSync(
      'git',
      ['rev-parse', '--show-toplevel'],
      { cwd: rootDir, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    ).trim();

    if (path.resolve(gitRoot) !== path.resolve(rootDir)) {
      try {
        // git check-ignore exits 0 if the path IS ignored, 1 if not
        execFileSync(
          'git',
          ['check-ignore', '-q', path.resolve(rootDir)],
          { cwd: rootDir, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
        );
        // Directory is gitignored by parent repo — fall back to filesystem walk
        return null;
      } catch {
        // Not ignored — safe to use git ls-files
      }
    }

    const files = new Set<string>();
    collectGitFiles(rootDir, '', files);
    // Apply built-in default ignores uniformly — to tracked files too, since
    // committing a dependency/build dir doesn't make it project code. A
    // `.gitignore` negation (e.g. `!vendor/`) is the explicit opt-in. (issue #407)
    // Filter on the LOGICAL path first (a user's .codegraphignore rule targets
    // the symlink name they see), THEN canonicalize+dedup so the same physical
    // file reached via its real path or a symlink collapses to one entry.
    const ig = buildDefaultIgnore(rootDir);
    const canonical = new Set<string>();
    for (const f of files) {
      // Most Git-visible files in a large repository are documentation,
      // assets, or build metadata. They can never reach the extractor, so
      // avoid a realpath/canonicalization round trip before discarding them.
      // The filesystem-walk fallback already applies this same source filter
      // before pushCanonical().
      if (!isSourceFile(f)) continue;
      if (ig.ignores(f)) continue;
      canonical.add(canonicalFilePath(rootDir, f));
    }
    return canonical;
  } catch {
    return null;
  }
}

/**
 * Result of git-based change detection.
 * Returns null when git is unavailable (non-git project or command failure),
 * signaling the caller to fall back to full filesystem scan.
 */
interface GitChanges {
  modified: string[];  // M, MM, AM — files to re-hash + re-index
  added: string[];     // ?? — new untracked files to index
  deleted: string[];   // D — files to remove from DB
}

/**
 * Use `git status` to detect changed files instead of scanning every file.
 * Returns null on failure so callers fall back to full scan.
 */
function getGitChangedFiles(rootDir: string): GitChanges | null {
  try {
    const output = execFileSync(
      'git',
      ['status', '--porcelain', '--no-renames'],
      { cwd: rootDir, encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    );

    const modified: string[] = [];
    const added: string[] = [];
    const deleted: string[] = [];

    for (const line of output.split('\n')) {
      if (line.length < 4) continue; // Minimum: "XY file"

      const statusCode = line.substring(0, 2);
      const filePath = normalizePath(line.substring(3));

      // Skip non-source files (git status already omits .gitignored paths).
      if (!isSourceFile(filePath)) continue;

      if (statusCode === '??') {
        added.push(filePath);
      } else if (statusCode.includes('D')) {
        deleted.push(filePath);
      } else {
        // M, MM, AM, A (staged), etc. — treat as modified
        modified.push(filePath);
      }
    }

    return { modified, added, deleted };
  } catch {
    return null;
  }
}

/**
 * Recursively scan a directory for source files.
 *
 * In git repos, uses `git ls-files` (inherently respects .gitignore at all
 * levels), then keeps files with a supported source extension. For non-git
 * projects, falls back to a filesystem walk that parses .gitignore itself.
 */
export function scanDirectory(
  rootDir: string,
  onProgress?: (current: number, file: string) => void
): string[] {
  // Fast path: use git to get all visible files (respects .gitignore everywhere)
  const gitFiles = getGitVisibleFiles(rootDir);
  if (gitFiles) {
    const files: string[] = [];
    let count = 0;
    for (const filePath of gitFiles) {
      if (isSourceFile(filePath)) {
        files.push(filePath);
        count++;
        onProgress?.(count, filePath);
      }
    }
    return files;
  }

  // Fallback: walk filesystem for non-git projects
  return scanDirectoryWalk(rootDir, onProgress);
}

/**
 * Async variant of scanDirectory that yields to the event loop periodically,
 * allowing worker threads to receive and render progress messages.
 */
export async function scanDirectoryAsync(
  rootDir: string,
  onProgress?: (current: number, file: string) => void
): Promise<string[]> {
  const gitFiles = getGitVisibleFiles(rootDir);
  if (gitFiles) {
    const files: string[] = [];
    let count = 0;
    for (const filePath of gitFiles) {
      if (isSourceFile(filePath)) {
        files.push(filePath);
        count++;
        onProgress?.(count, filePath);
        // Yield every 100 files so worker threads can render progress
        if (count % 100 === 0) {
          await new Promise<void>(r => setImmediate(r));
        }
      }
    }
    return files;
  }

  return scanDirectoryWalk(rootDir, onProgress);
}

/**
 * Filesystem walk fallback for non-git projects.
 */
function scanDirectoryWalk(
  rootDir: string,
  onProgress?: (current: number, file: string) => void
): string[] {
  const files: string[] = [];
  let count = 0;
  const visitedDirs = new Set<string>();
  // File-level canonical dedup (visitedDirs dedups directories by realpath; this
  // dedups files so a file reachable via its real path and a symlink, or via
  // several symlinks, is emitted once under its canonical realpath-relative path).
  const seenCanonical = new Set<string>();
  const pushCanonical = (logicalRel: string) => {
    const c = canonicalFilePath(rootDir, logicalRel);
    if (seenCanonical.has(c)) return;
    seenCanonical.add(c);
    files.push(c);
    count++;
    onProgress?.(count, c);
  };

  // A .gitignore matcher scoped to the directory that declared it. Patterns in
  // a nested .gitignore are relative to that directory, so we keep the dir
  // alongside the matcher and test paths relative to it — mirroring how git
  // applies .gitignore files at every level.
  interface ScopedIgnore {
    dir: string;
    ig: Ignore;
  }

  const loadIgnore = (dir: string): ScopedIgnore | null => {
    const giPath = path.join(dir, '.gitignore');
    if (!fs.existsSync(giPath)) return null;
    // readGitignorePatterns is defensive: a non-UTF-8 (DLP-encrypted) or
    // uncompilable .gitignore is skipped/filtered with a warning, never thrown
    // (issue #682) — so the per-file `.ignores()` calls below can't crash.
    const patterns = readGitignorePatterns(giPath);
    return patterns ? { dir, ig: ignore().add(patterns) } : null;
  };

  const isIgnored = (fullPath: string, isDir: boolean, matchers: ScopedIgnore[]): boolean => {
    for (const { dir, ig } of matchers) {
      let rel = normalizePath(path.relative(dir, fullPath));
      if (!rel || rel.startsWith('..')) continue; // not under this matcher's dir
      if (isDir) rel += '/'; // dir-only rules (e.g. `build/`) only match with the slash
      if (ig.ignores(rel)) return true;
    }
    return false;
  };

  function walk(dir: string, matchers: ScopedIgnore[]): void {
    let realDir: string;
    try {
      realDir = fs.realpathSync(dir);
    } catch {
      logDebug('Skipping unresolvable directory', { dir });
      return;
    }

    if (visitedDirs.has(realDir)) {
      logDebug('Skipping already-visited directory (symlink cycle)', { dir, realDir });
      return;
    }
    visitedDirs.add(realDir);

    // This directory's own .gitignore (if present) applies to everything below it.
    // The root's .gitignore is already merged into the seeded base matcher (so a
    // negation there can override a built-in default), so skip it here.
    const own = dir === rootDir ? null : loadIgnore(dir);
    const active = own ? [...matchers, own] : matchers;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      logDebug('Skipping unreadable directory', { dir, error: String(error) });
      return;
    }

    for (const entry of entries) {
      // Never descend into git internals or any CodeGraph data directory
      // (the active one or a sibling another environment created — #636).
      if (entry.name === '.git' || isCodeGraphDataDir(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);
      const relativePath = normalizePath(path.relative(rootDir, fullPath));

      if (entry.isSymbolicLink()) {
        try {
          const realTarget = fs.realpathSync(fullPath);
          const stat = fs.statSync(realTarget);
          if (stat.isDirectory()) {
            if (!isIgnored(fullPath, true, active)) {
              walk(fullPath, active);
            }
          } else if (stat.isFile()) {
            if (!isIgnored(fullPath, false, active) && isSourceFile(relativePath)) {
              pushCanonical(relativePath);
            }
          }
        } catch {
          logDebug('Skipping broken symlink', { path: fullPath });
        }
        continue;
      }

      if (entry.isDirectory()) {
        if (!isIgnored(fullPath, true, active)) {
          walk(fullPath, active);
        }
      } else if (entry.isFile()) {
        if (!isIgnored(fullPath, false, active) && isSourceFile(relativePath)) {
          pushCanonical(relativePath);
        }
      }
    }
  }

  // Seed a base matcher with the built-in default ignores (merged with the root
  // .gitignore so a negation can override). Nested .gitignores still layer per-dir.
  walk(rootDir, [{ dir: rootDir, ig: buildDefaultIgnore(rootDir) }]);
  return files;
}

/**
 * Extraction orchestrator
 */
export class ExtractionOrchestrator {
  private rootDir: string;
  private queries: QueryBuilder;
  /**
   * Names of frameworks detected for this project, populated by indexAll().
   * Passed to extractFromSource so framework-specific extractors (route nodes,
   * middleware, etc.) run after the tree-sitter pass. Cleared if detection
   * hasn't run yet so single-file re-index paths can detect on the spot.
   */
  private detectedFrameworkNames: string[] | null = null;
  private frameworkDetectionErrors: ExtractionError[] = [];
  /**
   * Project-wide `#define` macro names collected by a regex pre-scan over
   * all C/C++/ObjC files. Passed to extractFromSource so isMisparsedFunction
   * can suppress spurious function nodes from macros defined in OTHER files
   * (via #include). Cached on the orchestrator; reset each indexAll run.
   */
  private globalMacroNames: Set<string> | null = null;
  // Project-wide bodyless object-like macro names (`#define NAME` with empty
  // body, NOT function-like). Collected in the same pre-scan as
  // globalMacroNames and passed to extractFromSource so the C/C++ preParse
  // transform can blank them (they expand to nothing), unbreaking
  // `typedef SAFE TYPE (*FnPtr)(...)` style declarations. Cached/reset
  // alongside globalMacroNames.
  private globalBodylessMacroNames: Set<string> | null = null;
  /**
   * Unambiguous project-wide macro definitions used only by the auxiliary
   * declaration-macro recovery parse. Conflicting platform/config spellings
   * are excluded; same-file definitions can still override them safely.
   */
  private globalMacroDefinitions: CppMacroDefinition[] | null = null;
  /**
   * Per-file inputs from which the three effective global macro views above
   * were derived. Persisting this manifest lets sync update only changed macro
   * contributors while still comparing semantics across process restarts.
   */
  private globalMacroManifest: CppMacroManifest | null = null;
  // A source file without `#` cannot contribute a C/C++ preprocessor macro.
  // Keep an exact diagnostic rollback for same-build performance comparison.
  private readonly macroCandidatePrefilter =
    process.env.CODEGRAPH_NO_MACRO_CANDIDATE_PREFILTER !== '1';
  /**
   * Accumulates source file paths of nodes whose incoming edges couldn't be
   * re-wired during a sync pass. Populated by storeExtractionResult, consumed
   * and cleared by sync().
   */
  private syncRewireFailures: string[] = [];

  constructor(rootDir: string, queries: QueryBuilder) {
    this.rootDir = rootDir;
    this.queries = queries;
  }

  /**
   * Build a filesystem-backed ResolutionContext sufficient for framework
   * detection. Graph-query methods (getNodesByName etc.) return empty because
   * the DB hasn't been populated yet, but detect() only uses readFile,
   * fileExists, and getAllFiles, so that's fine.
   */
  private buildDetectionContext(files: string[]): ResolutionContext {
    const rootDir = this.rootDir;
    return {
      getNodesInFile: () => [],
      getNodesByName: () => [],
      getNodesByQualifiedName: () => [],
      getNodesByKind: () => [],
      getNodesByLowerName: () => [],
      getImportMappings: () => [],
      getAllFiles: () => files,
      getProjectRoot: () => rootDir,
      fileExists: (relativePath: string) => {
        const full = validatePathWithinRoot(rootDir, relativePath);
        if (!full) return false;
        try {
          return fs.existsSync(full);
        } catch {
          return false;
        }
      },
      readFile: (relativePath: string) => {
        const full = validatePathWithinRoot(rootDir, relativePath);
        if (!full) return null;
        try {
          return fs.readFileSync(full, 'utf-8');
        } catch {
          return null;
        }
      },
      // Monorepo support — needed by framework detect()s that probe
      // subpackage manifests (e.g. fabric-view looking at
      // packages/<sub>/package.json when the root manifest is just a
      // workspace declaration). Matches the resolver-context shape.
      listDirectories: (relativePath: string) => {
        const target =
          relativePath === '.' || relativePath === ''
            ? rootDir
            : path.join(rootDir, relativePath);
        try {
          return fs
            .readdirSync(target, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);
        } catch {
          return [];
        }
      },
    };
  }

  /**
   * Detect frameworks on demand using the current scanned files (or a fresh
   * scan if none are provided). Cached on the orchestrator so repeat calls
   * inside a single run don't re-scan.
   */
  private ensureDetectedFrameworks(files?: string[]): string[] {
    if (this.detectedFrameworkNames !== null) return this.detectedFrameworkNames;
    const fileList = files ?? scanDirectory(this.rootDir);
    const context = this.buildDetectionContext(fileList);
    this.frameworkDetectionErrors = [];
    this.detectedFrameworkNames = detectFrameworks(context, (framework, error) => {
      this.frameworkDetectionErrors.push({
        severity: 'error',
        code: 'framework_detection_failed',
        message: `Framework detection '${framework}' failed: ` +
          `${error instanceof Error ? error.message : String(error)}. ` +
          `The index may be incomplete.`,
      });
    }).map((r) => r.name);
    return this.detectedFrameworkNames;
  }

  /**
   * Pre-scan all C/C++/ObjC files with a regex to collect project-wide
   * `#define` macro names. This is ~100x faster than a full tree-sitter
   * parse and catches macros inside `#if` blocks (the regex is
   * context-blind, which is the conservative direction for filtering).
   *
   * The resulting set is passed to extractFromSource and merged into each
   * file's fileMacroNames so isMisparsedFunction can suppress spurious
   * function nodes from macros defined in OTHER files (via #include) —
   * tree-sitter has no preprocessor, so a macro invocation
   * `MACRO(args){body}` in file B, where MACRO is defined in header A,
   * would otherwise produce a fake function node in B.
   *
   * Cached on the orchestrator for the lifetime of the run. Call with
   * the scanned file list to avoid re-scanning the directory.
   */
  private installGlobalMacroManifest(manifest: CppMacroManifest): void {
    const context = buildCppMacroContext(manifest);
    this.globalMacroManifest = manifest;
    this.globalMacroNames = context.names;
    this.globalBodylessMacroNames = context.bodylessNames;
    this.globalMacroDefinitions = context.definitions;
  }

  private clearGlobalMacroContext(): void {
    this.globalMacroNames = null;
    this.globalBodylessMacroNames = null;
    this.globalMacroDefinitions = null;
    this.globalMacroManifest = null;
  }

  /**
   * Build the per-file macro manifest from source. This is the full-scan path
   * used by indexAll, by old indexes that predate manifest persistence, and as
   * the recovery path after an interrupted macro-dependent sync.
   */
  private async scanGlobalMacroManifest(
    files?: string[],
    profile?: InitProfileRecorder,
  ): Promise<CppMacroManifest> {
    const fileList = files ?? await scanDirectoryAsync(this.rootDir);
    const cLikeFiles = fileList.filter(isCppMacroFilePath);
    const contributions = new Map<string, CppMacroFileContribution>();

    // Batch reads to overlap I/O. 50 files per batch balances throughput
    // against memory for very large projects. Only files that actually
    // contribute a macro are retained in the persisted manifest.
    const BATCH = 50;
    for (let i = 0; i < cLikeFiles.length; i += BATCH) {
      const batch = cLikeFiles.slice(i, i + BATCH);
      const contents = await Promise.all(
        batch.map(async (relPath) => {
          const full = validatePathWithinRoot(this.rootDir, relPath);
          if (!full) return { relPath, content: null as string | null };
          try {
            return { relPath, content: await fsp.readFile(full, 'utf-8') };
          } catch {
            return { relPath, content: null as string | null };
          }
        })
      );
      for (const { relPath, content } of contents) {
        if (content === null) continue;
        const sizeBytes = Buffer.byteLength(content, 'utf-8');
        profile?.recordMacroFile(sizeBytes);
        if (
          this.macroCandidatePrefilter &&
          !mayContainCppMacroDirective(content)
        ) {
          continue;
        }
        profile?.recordMacroFileParsed(sizeBytes);
        const contribution = scanCppMacroFileContribution(content);
        if (!isCppMacroContributionEmpty(contribution)) {
          contributions.set(relPath, contribution);
        }
      }
    }

    return cppMacroManifestFromMap(contributions);
  }

  private async ensureGlobalMacroNames(
    files?: string[],
    profile?: InitProfileRecorder,
  ): Promise<Set<string>> {
    if (this.globalMacroNames !== null) return this.globalMacroNames;
    const manifest = await this.scanGlobalMacroManifest(files, profile);
    this.installGlobalMacroManifest(manifest);
    return this.globalMacroNames!;
  }

  /**
   * Index all files in the project
   */
  async indexAll(
    onProgress?: (progress: IndexProgress) => void,
    signal?: AbortSignal,
    verbose?: boolean,
    /**
     * Writer-side WAL backpressure gate from {@link WalCheckpointValve}. Called
     * at a between-transactions boundary (before each store); returns null
     * while WAL growth is under the hard cap, or a promise the writer awaits
     * when the disk is saturated and the WAL needs a full backfill (#1231).
     */
    walBackpressure?: () => Promise<void> | null,
    /**
     * Fresh node:sqlite database store offload. Existing databases keep all
     * reads, deletes and cross-file rewiring on the main connection.
     */
    storeWriterOpts?: {
      dbPath: string;
      fastInit: boolean;
      useWorker: boolean;
    } | null,
    profile?: InitProfileRecorder,
  ): Promise<IndexResult> {
    await initGrammars();
    // A fresh full index must not reuse a stale canonical-path cache from a
    // prior run (a repointed symlink would otherwise serve the old canonical).
    clearCanonicalCache();
    const startTime = Date.now();
    const errors: ExtractionError[] = [];
    let filesIndexed = 0;
    let filesSkipped = 0;
    let filesErrored = 0;
    let totalNodes = 0;
    let totalEdges = 0;
    const extractionTimingTotals: ExtractionTimings = {};
    let fileReadMs = 0;
    let fileMetadataMs = 0;
    let fileReadServiceMs = 0;
    let parseWallMs = 0;
    let bundleBuildMs = 0;
    let walBackpressureMs = 0;
    let walBackpressureCount = 0;
    let writerMessageSendMs = 0;
    let writerWindowWaitMs = 0;
    let storeAdmissionMs = 0;
    let writerDrainMs = 0;

    const log = verbose
      ? (msg: string) => { console.log(`[worker] ${msg}`); }
      : (_msg: string) => {};

    // Phase 1: Scan for files
    onProgress?.({
      phase: 'scanning',
      current: 0,
      total: 0,
    });

    const scanStarted = performance.now();
    const files = await scanDirectoryAsync(this.rootDir, (current, file) => {
      onProgress?.({
        phase: 'scanning',
        current,
        total: 0,
        currentFile: file,
      });
    });
    const scanMs = performance.now() - scanStarted;
    profile?.recordSourceManifest(files.length);
    profile?.recordPhase('scan', scanMs);

    // Detect frameworks once per indexAll run using the scanned file list.
    // Names are passed to each parse call so framework-specific extractors
    // (route nodes, middleware, etc.) run after the tree-sitter pass.
    // Framework detection is reset each run so adding e.g. requirements.txt
    // between runs is picked up without restarting the process.
    const frameworkDetectionStarted = performance.now();
    this.detectedFrameworkNames = null;
    const frameworkNames = this.ensureDetectedFrameworks(files);
    errors.push(...this.frameworkDetectionErrors);
    const frameworkDetectionMs = performance.now() - frameworkDetectionStarted;
    profile?.recordPhase('frameworkDetection', frameworkDetectionMs);

    // Pre-scan C/C++/ObjC files for project-wide #define macro names so
    // isMisparsedFunction can filter cross-file macro misparses (macro
    // defined in header A, used in file B → tree-sitter has no
    // preprocessor and would otherwise emit a fake function node in B).
    const macroScanStarted = performance.now();
    this.clearGlobalMacroContext();
    const globalMacroNames = await this.ensureGlobalMacroNames(files, profile);
    const globalBodylessMacroNames = this.globalBodylessMacroNames!;
    const globalMacroDefinitions = this.globalMacroDefinitions!;
    const macroScanMs = performance.now() - macroScanStarted;
    profile?.recordPhase('macroScan', macroScanMs);

    if (signal?.aborted) {
      return {
        success: false,
        filesIndexed: 0,
        filesSkipped: 0,
        filesErrored: 0,
        nodesCreated: 0,
        edgesCreated: 0,
        errors: [{ message: 'Aborted', severity: 'error' }],
        durationMs: Date.now() - startTime,
      };
    }

    // Phase 2: Parse files in a worker thread (keeps main thread unblocked for UI)
    const total = files.length;
    let processed = 0;

    // Emit parsing phase immediately so the progress bar appears during worker setup.
    // The yield lets the shimmer worker flush the phase transition to stdout before
    // the main thread starts synchronous grammar detection work.
    onProgress?.({
      phase: 'parsing',
      current: 0,
      total,
    });
    await new Promise(resolve => setImmediate(resolve));

    const workerSetupStarted = performance.now();

    // Detect needed languages and load grammars in the parse worker
    const neededLanguages = [...new Set(files.map((f) => detectLanguage(f)))];
    // .h files default to 'c' but may be C++ — ensure cpp grammar is loaded when c is needed
    if (neededLanguages.includes('c') && !neededLanguages.includes('cpp')) {
      neededLanguages.push('cpp');
    }

    // Try to use a worker thread for parsing (keeps main thread unblocked for UI).
    // Falls back to in-process parsing if the compiled worker is unavailable (e.g. tests).
    const parseWorkerPath = path.join(__dirname, 'parse-worker.js');
    const useWorker = fs.existsSync(parseWorkerPath);
    let WorkerClass: typeof import('worker_threads').Worker | null = null;
    // Pre-read grammar WASM bytes once so every (re)spawn loads grammars from
    // memory instead of re-reading from disk — on slow storage each respawn's
    // grammar re-read otherwise amplifies the very I/O contention that caused
    // the respawn (#1231). Best-effort: a missing language falls back to the
    // worker's own disk read. Reused across spawns by closure.
    let grammarBuffers: Record<string, Uint8Array> | undefined;

    if (useWorker) {
      const { Worker } = await import('worker_threads');
      WorkerClass = Worker;
      try {
        grammarBuffers = await readGrammarWasmBytes(neededLanguages);
      } catch {
        grammarBuffers = undefined; // best-effort — worker reads from disk
      }
    } else {
      // In-process fallback: load grammars locally
      await loadGrammarsForLanguages(neededLanguages);
    }

    let parsePool: ParseWorkerPool | null = null;
    if (useWorker) {
      const cpuCount =
        typeof os.availableParallelism === 'function'
          ? os.availableParallelism()
          : os.cpus().length;
      const requestedPoolSize = resolveParsePoolSize(
        process.env.CODEGRAPH_PARSE_WORKERS,
        cpuCount
      );
      // Worker startup and grammar compilation dominate tiny repositories.
      // Preserve explicit overrides, but keep the automatic path conservative
      // until there is enough work to amortize a full pool.
      const hasExplicitPoolSize =
        process.env.CODEGRAPH_PARSE_WORKERS !== undefined &&
        process.env.CODEGRAPH_PARSE_WORKERS !== '';
      const poolSize = hasExplicitPoolSize
        ? requestedPoolSize
        : files.length < 32
          ? 1
          : files.length < 128
            ? Math.min(4, requestedPoolSize)
            : requestedPoolSize;
      parsePool = new ParseWorkerPool({
        languages: neededLanguages,
        size: poolSize,
        workerScriptPath: parseWorkerPath,
        recycleInterval: WORKER_RECYCLE_INTERVAL,
        parseTimeoutMs: PARSE_TIMEOUT_MS,
        log,
        grammarBuffers,
        macroNames: [...globalMacroNames],
        bodylessMacroNames: [...globalBodylessMacroNames],
        macroDefinitions: globalMacroDefinitions,
        onStateChange: profile
          ? (state) => profile.recordParsePoolState(state)
          : undefined,
      });
      const workerReadyStarted = profile ? performance.now() : 0;
      parsePool.prewarm();
      if (profile) {
        void parsePool.waitUntilReady().then(
          () => profile.recordPhase(
            'workerReady',
            performance.now() - workerReadyStarted,
          ),
          () => undefined,
        );
      }
      profile?.recordConfiguration({ parseWorkers: poolSize });
      log(`Parse worker pool: ${poolSize} worker(s)`);
    } else {
      profile?.recordConfiguration({ parseWorkers: 0 });
    }

    const storeWorkerPath = path.join(__dirname, 'store-worker.js');
    let storeWriter: StoreWriter | null = null;
    if (
      storeWriterOpts &&
      storeWriterOpts.useWorker &&
      process.env.CODEGRAPH_NO_STORE_WORKER !== '1' &&
      fs.existsSync(storeWorkerPath)
    ) {
      storeWriter = new StoreWriter(
        storeWorkerPath,
        storeWriterOpts.dbPath,
        storeWriterOpts.fastInit
      );
      log('Store writer thread active');
    }
    const storeBatching =
      storeWriter !== null && process.env.CODEGRAPH_NO_STORE_BATCHING !== '1';
    const storeNodeDedupe =
      storeWriter !== null && process.env.CODEGRAPH_NO_STORE_NODE_DEDUPE !== '1';
    const storeRowBatchMax = storeWriter === null
      ? undefined
      : process.env.CODEGRAPH_NO_BATCH_WRITES === '1'
        ? 1
        : process.env.CODEGRAPH_NO_NATIVE_STORE_ROW_BATCH === '1'
          ? DEFAULT_WRITE_BATCH_SIZES[0]
          : NATIVE_STORE_WRITE_BATCH_SIZES[0];
    const streamingExtraction =
      storeWriter !== null &&
      process.env.CODEGRAPH_NO_STREAMING_EXTRACTION !== '1';
    const streamingTaskLimit = Math.min(
      STREAMING_TASK_MAX,
      Math.max(
        STREAMING_TASK_MIN,
        (parsePool?.size ?? 1) * STREAMING_TASK_MULTIPLIER,
      ),
    );
    const streamingResultRowLimit =
      streamingExtraction &&
      neededLanguages.some(
        (language) => language === 'c' || language === 'cpp',
      )
        ? STREAMING_C_CPP_RESULT_ROW_LIMIT
        : undefined;
    profile?.recordConfiguration({
      storeBatching,
      storeNodeDedupe,
      storeRowBatchMax,
      macroCandidatePrefilter: this.macroCandidatePrefilter,
      streamingExtraction,
      streamingTaskLimit: streamingExtraction
        ? streamingTaskLimit
        : undefined,
      streamingSourceByteLimit: streamingExtraction
        ? STREAMING_SOURCE_BYTE_LIMIT
        : undefined,
      streamingResultRowLimit,
    });
    profile?.recordPhase('workerSetup', performance.now() - workerSetupStarted);
    const STORE_WRITER_WINDOW = 64;

    // --- Worker lifecycle management ---
    // The worker can crash (OOM in WASM) or hang on pathological files.
    // We track pending parse promises and handle both cases:
    //   - Timeout: the base timer marks the job late and arms a hard-kill
    //     backstop; a late result that arrives in the grace window is
    //     ACCEPTED (the main thread was stalled, not the parse — #1231).
    //     Only a worker silent past the full window is killed + the request
    //     rejected and re-attempted in the retry pass.
    //   - Crash: reject all pending promises, restart for remaining files
    let parseWorker: import('worker_threads').Worker | null = null;
    let nextId = 0;
    let workerParseCount = 0;
    const pendingParses = new Map<number, {
      resolve: (result: ExtractionResult) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      /** The base timer fired with no result yet — accept a late result, kill at the backstop. */
      timerExpired: boolean;
      hardKillTimer?: ReturnType<typeof setTimeout>;
      /** Full budget for this parse (base timeout + size scaling), for late-result logging. */
      budgetMs?: number;
      filePath: string;
    }>();

    function rejectAllPending(reason: string): void {
      for (const [id, pending] of pendingParses) {
        clearTimeout(pending.timer);
        if (pending.hardKillTimer) clearTimeout(pending.hardKillTimer);
        pendingParses.delete(id);
        pending.reject(new Error(reason));
      }
    }

    function attachWorkerHandlers(w: import('worker_threads').Worker): void {
      w.on('message', (msg: { type: string; id?: number; result?: ExtractionResult; parseMs?: number }) => {
        if (msg.type === 'parse-result' && msg.id !== undefined) {
          const pending = pendingParses.get(msg.id);
          if (!pending) return; // stale (post-recycle / already settled)
          pendingParses.delete(msg.id);
          clearTimeout(pending.timer);
          if (pending.hardKillTimer) clearTimeout(pending.hardKillTimer);
          if (pending.timerExpired) {
            // The base timer fired before this result was processed. That almost
            // always means the MAIN THREAD was stalled (sync SQLite store on
            // slow disks) while the parse itself finished long ago — the worker's
            // own clock (parseMs) tells the two apart. Either way the result is
            // here and valid: accept it instead of the old behaviour (kill worker
            // + reject), which turned every main-thread stall into false
            // timeouts and dropped files (#1231).
            const parseMs = typeof msg.parseMs === 'number' ? Math.round(msg.parseMs) : undefined;
            const detail = parseMs === undefined
              ? ''
              : parseMs < (pending.budgetMs ?? PARSE_TIMEOUT_MS)
                ? ` (parse took ${parseMs}ms in-worker — the main thread was stalled, not the parse)`
                : ` (parse genuinely took ${parseMs}ms)`;
            log(`Late parse-result accepted: ${pending.filePath}${detail}`);
          }
          pending.resolve(msg.result!);
        }
      });

      w.on('error', (err) => {
        logWarn('Parse worker error', { error: err.message });
        rejectAllPending(`Worker error: ${err.message}`);
      });

      w.on('exit', (code) => {
        if (code !== 0 && pendingParses.size > 0) {
          logWarn('Parse worker exited unexpectedly', { code });
          rejectAllPending(`Worker exited with code ${code}`);
        }
        // Clear reference so we know to respawn, reset count so
        // the fresh worker gets a full cycle before recycling.
        if (parseWorker === w) {
          parseWorker = null;
          workerParseCount = 0;
        }
      });
    }

    async function ensureWorker(): Promise<import('worker_threads').Worker> {
      if (parseWorker) return parseWorker;
      log('Spawning new parse worker...');
      parseWorker = new WorkerClass!(parseWorkerPath);
      attachWorkerHandlers(parseWorker);

      // Load grammars in the new worker. grammarBuffers (pre-read above) make
      // this a memory load instead of a per-spawn disk read.
      await new Promise<void>((resolve, reject) => {
        parseWorker!.once('message', (msg: { type: string }) => {
          if (msg.type === 'grammars-loaded') resolve();
          else reject(new Error(`Unexpected message: ${msg.type}`));
        });
        parseWorker!.postMessage({ type: 'load-grammars', languages: neededLanguages, grammarBuffers });
      });

      // Send project-wide macro names once to the new worker. On
      // recycle/crash the worker is destroyed and ensureWorker() respawns,
      // so this re-sends automatically. Sending once (rather than with
      // every parse message) avoids serializing 10k+ names per file.
      if (globalMacroNames.size > 0 || globalBodylessMacroNames.size > 0) {
        await new Promise<void>((resolve, reject) => {
          parseWorker!.once('message', (msg: { type: string }) => {
            if (msg.type === 'global-macros-set') resolve();
            else reject(new Error(`Unexpected message: ${msg.type}`));
          });
          parseWorker!.postMessage({
            type: 'set-global-macros',
            macroNames: [...globalMacroNames],
            bodylessMacroNames: [...globalBodylessMacroNames],
            macroDefinitions: globalMacroDefinitions,
          });
        });
      }

      return parseWorker;
    }

    if (WorkerClass && !parsePool) {
      await ensureWorker();
    }

    /**
     * Recycle the worker thread to reclaim WASM memory.
     * Terminates the current worker and clears the reference so
     * ensureWorker() will spawn a fresh one on the next call.
     */
    function recycleWorker(): void {
      if (parsePool) {
        parsePool.recycleAll();
        return;
      }
      if (!parseWorker) return;
      log(`Recycling worker after ${workerParseCount} parses (heap: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB RSS)`);
      const w = parseWorker;
      parseWorker = null;
      workerParseCount = 0;
      // Fire-and-forget: worker.terminate() can hang if WASM is stuck
      w.terminate().catch(() => {});
    }

    async function requestParse(
      filePath: string,
      content: string,
      skipDeclarationMacroRecovery = false,
    ): Promise<ExtractionResult> {
      if (parsePool) {
        return parsePool.requestParse({
          filePath,
          content,
          language: detectLanguage(filePath, content),
          frameworkNames,
          skipDeclarationMacroRecovery,
        });
      }
      if (!WorkerClass) {
        // In-process fallback
        return extractFromSource(
          filePath,
          content,
          detectLanguage(filePath, content),
          frameworkNames,
          globalMacroNames,
          globalBodylessMacroNames,
          skipDeclarationMacroRecovery ? undefined : globalMacroDefinitions,
        );
      }

      // Recycle the worker before the next parse if we've hit the threshold.
      // This destroys the WASM linear memory (which can grow but never shrink)
      // and starts a fresh worker with a clean heap.
      if (workerParseCount >= WORKER_RECYCLE_INTERVAL) {
        await recycleWorker();
      }

      const worker = await ensureWorker();
      const id = nextId++;
      workerParseCount++;

      // Scale timeout for large files: base 10s + 10s per 100KB, capped at 3 min
      const timeoutMs = Math.min(
        PARSE_TIMEOUT_MS + Math.floor(content.length / 100_000) * 10_000,
        PARSE_TIMEOUT_MAX_MS,
      );

      return new Promise<ExtractionResult>((resolve, reject) => {
        const entry = { resolve, reject, timer: null as unknown as ReturnType<typeof setTimeout>, timerExpired: false, budgetMs: timeoutMs, filePath, hardKillTimer: undefined as ReturnType<typeof setTimeout> | undefined };

        // Base timer: does NOT prove the parse is still running. After a long
        // synchronous main-thread stretch (the SQLite store on slow disks),
        // Node services the timers phase before the poll phase, so this fires
        // BEFORE an already-delivered `parse-result` is processed. Mark the
        // job late (a result that shows up is accepted in attachWorkerHandlers)
        // and arm the hard-kill backstop for a worker that's genuinely hung.
        const timer = setTimeout(() => {
          if (!pendingParses.has(id)) return;
          const graceMs = timeoutMs * (HARD_KILL_MULTIPLIER - 1);
          log(`TIMEOUT: ${filePath} exceeded ${timeoutMs}ms with no result — waiting up to ${graceMs}ms more for a late result before killing the worker`);
          entry.timerExpired = true;
          entry.hardKillTimer = setTimeout(() => {
            if (!pendingParses.has(id)) return;
            log(`TIMEOUT: ${filePath} got no result after ${timeoutMs * HARD_KILL_MULTIPLIER}ms — killing worker`);
            pendingParses.delete(id);
            // Reject FIRST — worker.terminate() can hang if WASM is stuck
            parseWorker = null;
            workerParseCount = 0;
            reject(new Error(`Parse timed out after ${timeoutMs * HARD_KILL_MULTIPLIER}ms`));
            // Fire-and-forget: kill the stuck worker in the background
            worker.terminate().catch(() => {});
          }, graceMs);
          entry.hardKillTimer.unref?.();
        }, timeoutMs);
        timer.unref?.();
        entry.timer = timer;

        pendingParses.set(id, entry);
        worker.postMessage({
          type: 'parse',
          id,
          filePath,
          content,
          frameworkNames,
          skipDeclarationMacroRecovery,
        });
      });
    }

    type ParsedFileItem = {
      filePath: string;
      content: string | null;
      stats: fs.Stats | null;
      error: unknown;
      language?: Language;
      result: ExtractionResult | null;
      parseError: unknown;
      parseTurnaroundMs?: number;
      resultRows: number;
    };

    const abortedResult = (): IndexResult => ({
      success: false,
      filesIndexed,
      filesSkipped,
      filesErrored,
      nodesCreated: totalNodes,
      edgesCreated: totalEdges,
      errors: [{ message: 'Aborted', severity: 'error' }, ...errors],
      durationMs: Date.now() - startTime,
    });

    const admitParsedBatch = async (
      parsedBatch: readonly ParsedFileItem[],
    ): Promise<boolean> => {
      const storeAdmissionStarted = performance.now();
      const pendingStoreBundles: StoreBundle[] = [];
      for (const {
        filePath,
        content,
        stats,
        error,
        result,
        parseError,
      } of parsedBatch) {
        if (signal?.aborted) return false;

        onProgress?.({
          phase: 'parsing',
          current: processed,
          total,
          currentFile: filePath,
        });

        if (error || content === null || stats === null) {
          processed++;
          filesErrored++;
          errors.push({
            message: `Failed to read file: ${
              error instanceof Error ? error.message : String(error)
            }`,
            filePath,
            severity: 'error',
            code: 'read_error',
          });
          continue;
        }

        if (parseError || !result) {
          processed++;
          filesErrored++;
          errors.push({
            message:
              parseError instanceof Error
                ? parseError.message
                : String(parseError),
            filePath,
            severity: 'error',
            code: 'parse_error',
          });
          continue;
        }

        processed++;
        accumulateExtractionTimings(extractionTimingTotals, result.timings);

        const bp = walBackpressure?.();
        if (bp) {
          const walBackpressureStarted = performance.now();
          walBackpressureCount++;
          await bp;
          walBackpressureMs += performance.now() - walBackpressureStarted;
        }

        if (result.nodes.length > 0 || result.errors.length === 0) {
          const language = detectLanguage(filePath, content);
          const bundleBuildStarted = performance.now();
          const bundle = this.buildFreshStoreBundle(
            filePath,
            content,
            language,
            stats,
            result,
          );
          bundleBuildMs += performance.now() - bundleBuildStarted;
          if (storeWriter) {
            pendingStoreBundles.push(bundle);
          } else if (storeWriterOpts) {
            this.queries.storeFileBundle(bundle);
          } else {
            this.storeExtractionResult(
              filePath,
              content,
              language,
              stats,
              result,
            );
          }
        }

        if (result.errors.length > 0) {
          for (const extractionError of result.errors) {
            if (!extractionError.filePath) extractionError.filePath = filePath;
          }
          errors.push(...result.errors);
        }

        if (result.nodes.length > 0) {
          filesIndexed++;
          totalNodes += result.nodes.length;
          totalEdges += result.edges.length;
        } else if (result.errors.some((error) => error.severity === 'error')) {
          filesErrored++;
        } else if (isFileLevelOnlyLanguage(detectLanguage(filePath, content))) {
          filesIndexed++;
        } else {
          filesSkipped++;
        }
      }

      if (storeWriter) {
        const storeBatches = storeBatching
          ? batchStoreBundles(pendingStoreBundles)
          : pendingStoreBundles.map((bundle) => [bundle]);
        for (const storeBatch of storeBatches) {
          const sendStarted = performance.now();
          storeWriter.sendMany(storeBatch);
          writerMessageSendMs += performance.now() - sendStarted;
          writerWindowWaitMs += await storeWriter.waitBelow(
            STORE_WRITER_WINDOW,
          );
        }
      }
      storeAdmissionMs += performance.now() - storeAdmissionStarted;
      return true;
    };

    try {
    if (streamingExtraction) {
      const metadataStarted = performance.now();
      const scannedFiles: Array<{
        filePath: string;
        fullPath: string | null;
        stats: fs.Stats | null;
        error: unknown;
      }> = [];
      for (
        let offset = 0;
        offset < files.length;
        offset += STREAMING_METADATA_BATCH_SIZE
      ) {
        const metadataBatch = files.slice(
          offset,
          offset + STREAMING_METADATA_BATCH_SIZE,
        );
        scannedFiles.push(...await Promise.all(metadataBatch.map(
          async (filePath) => {
            const fullPath = validatePathWithinRoot(this.rootDir, filePath);
            if (!fullPath) {
              logWarn('Path traversal blocked in streaming reader', {
                filePath,
              });
              return {
                filePath,
                fullPath: null,
                stats: null,
                error: new Error('Path traversal blocked'),
              };
            }
            try {
              return {
                filePath,
                fullPath,
                stats: await fsp.stat(fullPath),
                error: null,
              };
            } catch (error) {
              return { filePath, fullPath, stats: null, error };
            }
          },
        )));
      }
      fileMetadataMs += performance.now() - metadataStarted;

      const tasks = scannedFiles.map((scanned) => ({
        weight: scanned.stats?.size ?? 0,
        run: async (): Promise<ParsedFileItem> => {
          if (
            scanned.error ||
            scanned.fullPath === null ||
            scanned.stats === null
          ) {
            return {
              filePath: scanned.filePath,
              content: null,
              stats: null,
              error: scanned.error,
              result: null,
              parseError: null,
              resultRows: 0,
            };
          }

          let content: string;
          const readStarted = performance.now();
          try {
            content = await fsp.readFile(scanned.fullPath, 'utf-8');
          } catch (error) {
            fileReadServiceMs += performance.now() - readStarted;
            return {
              filePath: scanned.filePath,
              content: null,
              stats: scanned.stats,
              error,
              result: null,
              parseError: null,
              resultRows: 0,
            };
          }
          fileReadServiceMs += performance.now() - readStarted;

          const language = detectLanguage(scanned.filePath, content);
          profile?.recordSourceFile(language, scanned.stats.size);
          if (scanned.stats.size > FILE_SIZE_WARN_THRESHOLD) {
            logWarn(
              `Large file may take longer to parse: ${scanned.filePath} ` +
              `(${(scanned.stats.size / 1024 / 1024).toFixed(1)}MB)`,
            );
          }

          const parseStarted = performance.now();
          try {
            const result = await requestParse(scanned.filePath, content);
            const parseTurnaroundMs = performance.now() - parseStarted;
            profile?.recordParseFiles([{
              filePath: scanned.filePath,
              language,
              sizeBytes: scanned.stats.size,
              turnaroundMs: parseTurnaroundMs,
              extractorDurationMs: result.durationMs,
              success: true,
            }]);
            return {
              filePath: scanned.filePath,
              content,
              stats: scanned.stats,
              error: null,
              language,
              result,
              parseError: null,
              parseTurnaroundMs,
              resultRows:
                result.nodes.length +
                result.edges.length +
                result.unresolvedReferences.length +
                1,
            };
          } catch (parseError) {
            const parseTurnaroundMs = performance.now() - parseStarted;
            profile?.recordParseFiles([{
              filePath: scanned.filePath,
              language,
              sizeBytes: scanned.stats.size,
              turnaroundMs: parseTurnaroundMs,
              success: false,
            }]);
            return {
              filePath: scanned.filePath,
              content,
              stats: scanned.stats,
              error: null,
              language,
              result: null,
              parseError,
              parseTurnaroundMs,
              resultRows: 0,
            };
          }
        },
      }));

      const iterator = runOrderedTaskWindow(tasks, {
        maxTasks: streamingTaskLimit,
        maxWeight: STREAMING_SOURCE_BYTE_LIMIT,
        getResultWeight: (item) => item.resultRows,
        maxResultWeight: streamingResultRowLimit,
        onStateChange: profile
          ? (state) => profile.recordParseWindowState(state)
          : undefined,
      })[Symbol.asyncIterator]();
      let commitGroup: ParsedFileItem[] = [];
      let commitGroupSourceBytes = 0;
      try {
        while (true) {
          if (signal?.aborted) return abortedResult();
          const orderedWaitStarted = performance.now();
          const next = await iterator.next();
          parseWallMs += performance.now() - orderedWaitStarted;
          if (next.done) break;

          const item = next.value.value;
          const itemSourceBytes = item.stats?.size ?? 0;
          if (
            commitGroup.length > 0 &&
            (
              commitGroup.length >= DEFAULT_STORE_BATCH_LIMITS.maxBundles ||
              commitGroupSourceBytes + itemSourceBytes >
                DEFAULT_STORE_BATCH_LIMITS.maxSourceBytes
            )
          ) {
            if (!(await admitParsedBatch(commitGroup))) return abortedResult();
            commitGroup = [];
            commitGroupSourceBytes = 0;
          }
          commitGroup.push(item);
          commitGroupSourceBytes += itemSourceBytes;
        }
        if (
          commitGroup.length > 0 &&
          !(await admitParsedBatch(commitGroup))
        ) {
          return abortedResult();
        }
      } finally {
        // A cancellation or store failure can leave this consumer before the
        // generator reaches its next yield. Close it explicitly so it releases
        // its ordered window instead of retaining completed task results.
        await iterator.return?.();
      }
    } else {
    for (let i = 0; i < files.length; i += FILE_IO_BATCH_SIZE) {
      if (signal?.aborted) {
        if (storeWriter) await storeWriter.close();
        if (parsePool) await parsePool.destroy();
        if (parseWorker) {
          (parseWorker as import('worker_threads').Worker).terminate().catch(() => {});
        }
        return {
          success: false,
          filesIndexed,
          filesSkipped,
          filesErrored,
          nodesCreated: totalNodes,
          edgesCreated: totalEdges,
          errors: [{ message: 'Aborted', severity: 'error' }, ...errors],
          durationMs: Date.now() - startTime,
        };
      }

      const batch = files.slice(i, i + FILE_IO_BATCH_SIZE);

      // Read files in parallel (with path validation before any I/O)
      const fileReadStarted = performance.now();
      const fileContents = await Promise.all(
        batch.map(async (fp) => {
          try {
            const fullPath = validatePathWithinRoot(this.rootDir, fp);
            if (!fullPath) {
              logWarn('Path traversal blocked in batch reader', { filePath: fp });
              return { filePath: fp, content: null as string | null, stats: null as fs.Stats | null, error: new Error('Path traversal blocked') };
            }
            const content = await fsp.readFile(fullPath, 'utf-8');
            const stats = await fsp.stat(fullPath);
            profile?.recordSourceFile(
              detectLanguage(fp, content),
              stats.size,
            );
            return { filePath: fp, content, stats, error: null as Error | null };
          } catch (err) {
            return { filePath: fp, content: null as string | null, stats: null as fs.Stats | null, error: err as Error };
          }
        })
      );
      fileReadMs += performance.now() - fileReadStarted;

      // Parse the whole I/O batch concurrently across the pool. Promise.all
      // preserves array order, and the following loop stores in that same
      // order, so graph insertion/disambiguation stays deterministic.
      const parseBatchStarted = performance.now();
      const parsedBatch = await Promise.all(
        fileContents.map(async (item) => {
          if (item.error || item.content === null || item.stats === null) {
            return {
              ...item,
              language: undefined as Language | undefined,
              result: null as ExtractionResult | null,
              parseError: null as unknown,
              parseTurnaroundMs: undefined as number | undefined,
              resultRows: 0,
            };
          }
          if (item.stats.size > FILE_SIZE_WARN_THRESHOLD) {
            logWarn(
              `Large file may take longer to parse: ${item.filePath} (${(item.stats.size / 1024 / 1024).toFixed(1)}MB)`
            );
          }
          const language = detectLanguage(item.filePath, item.content);
          const parseFileStarted = profile ? performance.now() : 0;
          try {
            const result = await requestParse(item.filePath, item.content);
            return {
              ...item,
              language,
              result,
              parseError: null as unknown,
              parseTurnaroundMs: profile
                ? performance.now() - parseFileStarted
                : undefined,
              resultRows:
                result.nodes.length +
                result.edges.length +
                result.unresolvedReferences.length +
                1,
            };
          } catch (parseError) {
            return {
              ...item,
              language,
              result: null as ExtractionResult | null,
              parseError,
              parseTurnaroundMs: profile
                ? performance.now() - parseFileStarted
                : undefined,
              resultRows: 0,
            };
          }
        })
      );
      const parseBatchWallMs = performance.now() - parseBatchStarted;
      parseWallMs += parseBatchWallMs;
      if (profile) {
        const parseSamples: InitProfileParseFileSample[] = [];
        for (const item of parsedBatch) {
          if (
            item.content === null ||
            item.stats === null ||
            item.parseTurnaroundMs === undefined ||
            item.language === undefined
          ) {
            continue;
          }
          parseSamples.push({
            filePath: item.filePath,
            language: item.language,
            sizeBytes: item.stats.size,
            turnaroundMs: item.parseTurnaroundMs,
            extractorDurationMs: item.result?.durationMs,
            success: item.parseError === null && item.result !== null,
          });
        }
        profile.recordParseBatch(parseSamples, parseBatchWallMs);
      }

      if (!(await admitParsedBatch(parsedBatch))) return abortedResult();

    }
    }

    // The worker applies queued bundles in message order. Close its connection
    // before retries and resolution return to the main database connection.
    if (storeWriter) {
      const writerDrainStarted = performance.now();
      const writer = storeWriter;
      try {
        await writer.drain();
      } finally {
        profile?.recordWriter({
          ...writer.getStats(),
          walBackpressureCount,
        });
        await writer.close();
        storeWriter = null;
        writerDrainMs += performance.now() - writerDrainStarted;
      }
    }

    // Report 100% so the progress bar doesn't hang at 99%
    onProgress?.({
      phase: 'parsing',
      current: total,
      total,
    });

    // Yield so the shimmer worker's buffered stdout writes can flush.
    // Worker thread stdout is proxied through the main thread's event loop,
    // so synchronous work here blocks the animation from rendering.
    await new Promise(resolve => setImmediate(resolve));

    // Retry pass: files that failed due to WASM runtime corruption may succeed
    // on a fresh worker. Recycle before each attempt so every file gets an
    // uncontaminated parser/runtime state.
    const retryableErrors = errors.filter(
      (e) => e.code === 'parse_error' && e.filePath &&
        isRetryableParseWorkerError(e.message)
    );

    if (retryableErrors.length > 0 && (parsePool || WorkerClass)) {
      log(`Retrying ${retryableErrors.length} files that failed due to worker/WASM runtime errors...`);

      const stillFailing: typeof retryableErrors = [];

      for (const errEntry of retryableErrors) {
        const filePath = errEntry.filePath!;
        if (signal?.aborted) break;

        // Fresh worker for every retry — maximum WASM headroom
        recycleWorker();

        let content: string;
        try {
          const fullPath = validatePathWithinRoot(this.rootDir, filePath);
          if (!fullPath) continue;
          content = await fsp.readFile(fullPath, 'utf-8');
        } catch {
          continue;
        }

        let result: ExtractionResult;
        try {
          // The first attempt already failed in a fresh isolated auxiliary
          // parser. Preserve the primary AST on retry by omitting optional
          // declaration-macro replay.
          result = await requestParse(filePath, content, true);
        } catch {
          stillFailing.push(errEntry);
          continue;
        }

        if (result.nodes.length > 0 || result.errors.length === 0) {
          const degradation = replaceWithDeclarationMacroRecoverySkipped(
            errors,
            errEntry,
            filePath,
            false,
          );
          // Store the same diagnostic on the file record as well as in the
          // top-level IndexResult, so SDK file inspection and persisted index
          // completeness agree about this file's reduced coverage.
          result.errors.push(degradation);
          const language = detectLanguage(filePath, content);
          const stats = await fsp.stat(path.join(this.rootDir, filePath));
          const bp = walBackpressure?.();
          if (bp) await bp;
          if (storeWriterOpts) {
            this.queries.storeFileBundle(
              this.buildFreshStoreBundle(filePath, content, language, stats, result)
            );
          } else {
            this.storeExtractionResult(filePath, content, language, stats, result);
          }

          filesErrored--;
          filesIndexed++;
          totalNodes += result.nodes.length;
          totalEdges += result.edges.length;
          accumulateExtractionTimings(extractionTimingTotals, result.timings);
          log(
            `Retry base-only OK: ${filePath} (${result.nodes.length} nodes; ` +
            `declaration-macro recovery skipped, coverage incomplete)`
          );
        }
      }

      // Last resort: for files that still crash on a clean worker, strip
      // comment-only lines to reduce WASM memory pressure. Many compiler
      // test files are 90%+ comments (CHECK directives) that don't contribute
      // code nodes but consume parser memory.
      if (stillFailing.length > 0) {
        log(`${stillFailing.length} files still failing — retrying with comments stripped...`);

        for (const errEntry of stillFailing) {
          const filePath = errEntry.filePath!;
          if (signal?.aborted) break;

          recycleWorker();

          let fullContent: string;
          try {
            const fullPath = validatePathWithinRoot(this.rootDir, filePath);
            if (!fullPath) continue;
            fullContent = await fsp.readFile(fullPath, 'utf-8');
          } catch {
            continue;
          }

          // Strip lines that are entirely comments (preserving line numbers
          // by replacing with empty lines so node positions stay correct)
          const stripped = fullContent
            .split('\n')
            .map(line => /^\s*\/\//.test(line) ? '' : line)
            .join('\n');

          let result: ExtractionResult;
          try {
            result = await requestParse(filePath, stripped, true);
          } catch {
            continue;
          }

          if (result.nodes.length > 0 || result.errors.length === 0) {
            const degradation = replaceWithDeclarationMacroRecoverySkipped(
              errors,
              errEntry,
              filePath,
              true,
            );
            result.errors.push(degradation);
            const language = detectLanguage(filePath, fullContent);
            const stats = await fsp.stat(path.join(this.rootDir, filePath));
            const bp = walBackpressure?.();
            if (bp) await bp;
            if (storeWriterOpts) {
              this.queries.storeFileBundle(
                this.buildFreshStoreBundle(filePath, fullContent, language, stats, result)
              );
            } else {
              this.storeExtractionResult(filePath, fullContent, language, stats, result);
            }

            filesErrored--;
            filesIndexed++;
            totalNodes += result.nodes.length;
            totalEdges += result.edges.length;
            accumulateExtractionTimings(extractionTimingTotals, result.timings);
            log(
              `Retry (comments stripped, base-only) OK: ${filePath} ` +
              `(${result.nodes.length} nodes; declaration-macro recovery skipped, ` +
              `coverage incomplete)`
            );
          }
        }
      }
    }

    log(
      `Index phases: scan=${Math.round(scanMs)}ms ` +
      `framework=${Math.round(frameworkDetectionMs)}ms ` +
      `macroScan=${Math.round(macroScanMs)}ms ` +
      `read=${Math.round(fileReadMs)}ms ` +
      `parseWall=${Math.round(parseWallMs)}ms ` +
      `storeAdmission=${Math.round(storeAdmissionMs)}ms`,
    );
    const extractionTimingSummary = formatExtractionTimings(extractionTimingTotals);
    if (extractionTimingSummary) log(`Extraction totals: ${extractionTimingSummary}`);

    // Publish the macro inputs only after the extraction phase has reached its
    // normal terminal point. A killed/aborted build must never make a later
    // sync believe the old graph was produced with a newer macro context.
    if (this.globalMacroManifest) {
      try {
        this.queries.setMetadata(
          CPP_MACRO_MANIFEST_METADATA_KEY,
          serializeCppMacroManifest(this.globalMacroManifest),
        );
        this.queries.setMetadata(CPP_MACRO_MANIFEST_READY_METADATA_KEY, '1');
        this.queries.setMetadata(CPP_MACRO_CONTEXT_PENDING_METADATA_KEY, '0');
      } catch (error) {
        logDebug('Could not persist C/C++ macro manifest after full index', {
          error: String(error),
        });
      }
    }

    return {
      success: filesIndexed > 0 || errors.filter((e) => e.severity === 'error').length === 0,
      filesIndexed,
      filesSkipped,
      filesErrored,
      nodesCreated: totalNodes,
      edgesCreated: totalEdges,
      errors,
      durationMs: Date.now() - startTime,
    };
    } finally {
      try {
        // Covers success, abort and any unexpected store/parse exception. Worker
        // lifetimes must never outlive the indexing call or hold the DB open.
        rejectAllPending('Indexing complete');
        if (storeWriter) {
          const writerCloseStarted = performance.now();
          try {
            await storeWriter.close();
          } finally {
            profile?.recordWriter({
              ...storeWriter.getStats(),
              walBackpressureCount,
            });
            writerDrainMs += performance.now() - writerCloseStarted;
          }
        }
        if (parsePool) await parsePool.destroy();
        if (parseWorker) {
          (parseWorker as import('worker_threads').Worker)
            .terminate()
            .catch(() => {});
        }
      } finally {
        profile?.recordPhase('fileRead', fileReadMs);
        profile?.recordPhase('fileMetadata', fileMetadataMs);
        profile?.recordPhase('fileReadService', fileReadServiceMs);
        profile?.recordPhase('parseWall', parseWallMs);
        profile?.recordPhase('bundleBuild', bundleBuildMs);
        profile?.recordPhase('walBackpressure', walBackpressureMs);
        profile?.recordPhase('writerMessageSend', writerMessageSendMs);
        profile?.recordPhase('writerWindowWait', writerWindowWaitMs);
        profile?.recordPhase('storeAdmission', storeAdmissionMs);
        profile?.recordPhase('writerDrain', writerDrainMs);
        profile?.recordExtractorTimings(extractionTimingTotals);
      }
    }
  }

  /**
   * Index specific files
   */
  async indexFiles(filePaths: string[]): Promise<IndexResult> {
    const startTime = Date.now();
    const errors: ExtractionError[] = [];
    let filesIndexed = 0;
    let filesSkipped = 0;
    let filesErrored = 0;
    let totalNodes = 0;
    let totalEdges = 0;

    for (const filePath of filePaths) {
      const result = await this.indexFile(filePath);

      if (result.errors.length > 0) {
        errors.push(...result.errors);
      }

      if (result.nodes.length > 0) {
        filesIndexed++;
        totalNodes += result.nodes.length;
        totalEdges += result.edges.length;
      } else if (result.errors.some((e) => e.severity === 'error')) {
        filesErrored++;
      } else {
        const tracked = this.queries.getFileByPath(filePath);
        if (tracked && isFileLevelOnlyLanguage(tracked.language)) {
          filesIndexed++;
        } else {
          filesSkipped++;
        }
      }
    }

    return {
      success: filesIndexed > 0 || errors.filter((e) => e.severity === 'error').length === 0,
      filesIndexed,
      filesSkipped,
      filesErrored,
      nodesCreated: totalNodes,
      edgesCreated: totalEdges,
      errors,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Index a single file
   */
  async indexFile(relativePath: string, options?: { force?: boolean }): Promise<ExtractionResult> {
    // Canonicalize at the public entry: CLI/watcher/sync callers may pass a
    // logical symlink path. The file is stored under its canonical
    // (realpath-relative) path so the same physical file is indexed once.
    relativePath = canonicalFilePath(this.rootDir, relativePath);
    const fullPath = validatePathWithinRoot(this.rootDir, relativePath);

    if (!fullPath) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [{ message: `Path traversal blocked: ${relativePath}`, filePath: relativePath, severity: 'error', code: 'path_traversal' }],
        durationMs: 0,
      };
    }

    // Read file content and stats
    let content: string;
    let stats: fs.Stats;
    try {
      stats = await fsp.stat(fullPath);
      content = await fsp.readFile(fullPath, 'utf-8');
    } catch (error) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [
          {
            message: `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
            filePath: relativePath,
            severity: 'error',
            code: 'read_error',
          },
        ],
        durationMs: 0,
      };
    }

    return this.indexFileWithContent(relativePath, content, stats, options);
  }

  /**
   * Index a single file with pre-read content and stats.
   * Used by the parallel batch reader to avoid redundant file I/O.
   */
  async indexFileWithContent(
    relativePath: string,
    content: string,
    stats: fs.Stats,
    options?: { force?: boolean }
  ): Promise<ExtractionResult> {
    // Prevent path traversal
    const fullPath = validatePathWithinRoot(this.rootDir, relativePath);
    if (!fullPath) {
      logWarn('Path traversal blocked in indexFileWithContent', { relativePath });
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [{ message: 'Path traversal blocked', filePath: relativePath, severity: 'error', code: 'path_traversal' }],
        durationMs: 0,
      };
    }

    if (stats.size > FILE_SIZE_WARN_THRESHOLD) {
      logWarn(`Large file may take longer to parse: ${relativePath} (${(stats.size / 1024 / 1024).toFixed(1)}MB)`);
    }

    // Detect language
    const language = detectLanguage(relativePath, content);
    if (!isLanguageSupported(language)) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [],
        durationMs: 0,
      };
    }

    // Extract from source. Use cached framework names if indexAll has run,
    // otherwise detect on the spot so single-file re-index paths still emit
    // route nodes / middleware / etc.
    const frameworkNames = this.ensureDetectedFrameworks();
    const globalMacroNames = await this.ensureGlobalMacroNames();
    const result = extractFromSource(
      relativePath,
      content,
      language,
      frameworkNames,
      globalMacroNames,
      this.globalBodylessMacroNames ?? undefined,
      this.globalMacroDefinitions ?? undefined,
    );

    // Store in database
    if (result.nodes.length > 0 || result.errors.length === 0) {
      this.storeExtractionResult(relativePath, content, language, stats, result, options);
    }

    return result;
  }

  /**
   * Build the fresh-database payload shared by the main-thread and worker
   * stores. The validation/filtering is centralized so both paths preserve
   * the fork's node fields and reference context identically.
   */
  private buildFreshStoreBundle(
    filePath: string,
    content: string,
    language: Language,
    stats: fs.Stats,
    result: ExtractionResult
  ): StoreBundle {
    const file: FileRecord = {
      path: filePath,
      contentHash: hashContent(content),
      language,
      size: stats.size,
      modifiedAt: stats.mtimeMs,
      indexedAt: Date.now(),
      nodeCount: result.nodes.length,
      errors: result.errors.length > 0 ? result.errors : undefined,
    };
    return finalizeStoreBundle(result, filePath, language, file);
  }

  /**
   * Store extraction result in database.
   *
   * Before deleting old nodes, incoming cross-file edges are snapshotted and
   * then re-wired to new node IDs after insertion (by matching target name +
   * kind). This avoids expensive co-importer re-indexing for the common case
   * where symbols moved position but kept their name and kind.
   */
  private storeExtractionResult(
    filePath: string,
    content: string,
    language: Language,
    stats: fs.Stats,
    result: ExtractionResult,
    options?: { force?: boolean }
  ): void {
    // Defensive: callers (scan, indexFile, batch reader) already pass canonical
    // paths, but canonicalize once more so getFileByPath/deleteFile/upsertFile key
    // on the canonical path even if a future caller passes a logical symlink path.
    filePath = canonicalFilePath(this.rootDir, filePath);
    const contentHash = hashContent(content);

    // Check if file already exists and hasn't changed. A base-only fallback
    // deliberately stores the current content hash together with an incomplete
    // declaration-macro diagnostic. The next full parse must be allowed to
    // replace that record even though the source bytes are identical.
    const existingFile = this.queries.getFileByPath(filePath);
    const needsDeclarationMacroRecovery = hasDeclarationMacroRecoverySkipped(
      existingFile?.errors,
    );
    if (
      !options?.force &&
      existingFile &&
      existingFile.contentHash === contentHash &&
      !needsDeclarationMacroRecovery
    ) {
      return; // No changes
    }

    // Snapshot incoming cross-file edges before deleting old nodes.
    // These are edges from nodes in OTHER files → nodes in THIS file.
    // After re-insertion we'll re-wire them to the new node IDs.
    let savedEdges: SavedCrossFileEdge[] = [];
    if (existingFile) {
      savedEdges = this.queries.getIncomingCrossFileEdges(filePath);
      this.queries.deleteFile(filePath);
    }

    // Filter out nodes with missing required fields before insertion.
    // This prevents FK violations when edges reference nodes that would
    // be silently skipped by insertNode() (see issue #42).
    const validNodes = result.nodes.filter((n) => n.id && n.kind && n.name && n.filePath && n.language);

    // Insert nodes
    if (validNodes.length > 0) {
      this.queries.insertNodes(validNodes);
    }

    // Filter edges to only reference nodes that were actually inserted
    if (result.edges.length > 0) {
      const insertedIds = new Set(validNodes.map((n) => n.id));
      const validEdges = result.edges.filter(
        (e) => insertedIds.has(e.source) && insertedIds.has(e.target)
      );
      if (validEdges.length > 0) {
        this.queries.insertEdges(validEdges);
      }
    }

    // Insert unresolved references in batch with denormalized filePath/language
    if (result.unresolvedReferences.length > 0) {
      const insertedIds = new Set(validNodes.map((n) => n.id));
      const refsWithContext = result.unresolvedReferences
        .filter((ref) => insertedIds.has(ref.fromNodeId))
        .map((ref) => ({
          ...ref,
          filePath: ref.filePath ?? filePath,
          language: ref.language ?? language,
        }));
      if (refsWithContext.length > 0) {
        this.queries.insertUnresolvedRefsBatch(refsWithContext);
      }
    }

    // Re-wire saved incoming cross-file edges to new node IDs
    if (savedEdges.length > 0 && validNodes.length > 0) {
      this.rewireEdges(savedEdges, validNodes);
    } else if (savedEdges.length > 0) {
      // File was emptied (all symbols removed) — all incoming edges are
      // legitimately orphaned. Record source files so they get re-indexed
      // (which will surface the now-unresolved references).
      const sourceFiles = [...new Set(savedEdges.map((e) => e.sourceFilePath))];
      this.syncRewireFailures.push(...sourceFiles);
    }

    // Insert file record
    const fileRecord: FileRecord = {
      path: filePath,
      contentHash,
      language,
      size: stats.size,
      modifiedAt: stats.mtimeMs,
      indexedAt: Date.now(),
      nodeCount: result.nodes.length,
      errors: result.errors.length > 0 ? result.errors : undefined,
    };
    this.queries.upsertFile(fileRecord);
  }

  /**
   * Re-wire saved incoming cross-file edges to new node IDs by matching
   * target (name, kind). Edges that can't be matched (symbol removed or
   * renamed) record their source file so co-importer fallback can run.
   */
  private rewireEdges(
    savedEdges: SavedCrossFileEdge[],
    newNodes: ExtractionResult['nodes']
  ): void {
    // Index new nodes by "name|kind" → [nodeId, ...]
    const nameIndex = new Map<string, string[]>();
    for (const node of newNodes) {
      const key = `${node.name}|${node.kind}`;
      const ids = nameIndex.get(key);
      if (ids) {
        ids.push(node.id);
      } else {
        nameIndex.set(key, [node.id]);
      }
    }

    const rewired: Array<{
      source: string;
      target: string;
      kind: import('../types').EdgeKind;
      metadata?: Record<string, unknown>;
      line?: number;
      column?: number;
      provenance?: 'tree-sitter' | 'scip' | 'heuristic';
    }> = [];
    const failedSourceFiles = new Set<string>();

    for (const saved of savedEdges) {
      const key = `${saved.targetName}|${saved.targetKind}`;
      const matches = nameIndex.get(key);

      if (matches && matches.length === 1) {
        rewired.push({
          source: saved.sourceId,
          target: matches[0]!,
          kind: saved.edgeKind as import('../types').EdgeKind,
          metadata: saved.metadata
            ? (JSON.parse(saved.metadata) as Record<string, unknown>)
            : undefined,
          line: saved.line ?? undefined,
          column: saved.col ?? undefined,
          provenance: (saved.provenance as 'tree-sitter' | 'scip' | 'heuristic') ?? undefined,
        });
      } else {
        // 0 matches → symbol removed; >1 matches → ambiguous overload, defer
        // to co-importer fallback (conservative — no wrong edges).
        failedSourceFiles.add(saved.sourceFilePath);
      }
    }

    if (rewired.length > 0) {
      this.queries.insertEdges(rewired as import('../types').Edge[]);
    }

    if (failedSourceFiles.size > 0) {
      this.syncRewireFailures.push(...failedSourceFiles);
    }
  }

  /**
   * Sync the index with the current file state.
   *
   * Change detection is filesystem-based, never git: a (size, mtime) stat
   * pre-filter skips unchanged files, then a content-hash compare confirms real
   * changes. This works in non-git projects and catches committed changes from
   * `git pull`/`checkout`/`merge`/`rebase` that `git status` cannot see.
   */
  async sync(
    onProgress?: (progress: IndexProgress) => void,
    /**
     * Exact watcher paths. Undefined keeps the full filesystem reconcile as
     * the source of truth for manual sync and uncertain watcher events.
     */
    scopedPaths?: string[],
    verbose?: boolean,
  ): Promise<SyncResult> {
    await initGrammars(); // Initialize WASM runtime (grammars loaded lazily below)
    // Sync rescans; clear the canonical-path cache so repointed symlinks are seen.
    clearCanonicalCache();
    const startTime = Date.now();
    let filesChecked = 0;
    let filesAdded = 0;
    let filesModified = 0;
    let filesRemoved = 0;
    let filesErrored = 0;
    let nodesUpdated = 0;
    const syncErrors: ExtractionError[] = [];
    const failedFilePaths = new Set<string>();
    // Only successfully stored files belong here. Detection counts above still
    // report every observed add/modify, but downstream resolution must never
    // run against a file whose old index was deliberately retained.
    const changedFilePaths: string[] = [];
    const resurrectedReferenceSourceFiles = new Set<string>();
    // Actual source-byte changes are kept separately from files that are being
    // retried for incomplete declaration-macro recovery. Only the former can
    // change their contribution to the project-wide macro context.
    const changedSourceContents = new Map<string, string>();
    const removedCppMacroFiles = new Set<string>();
    // The ready flag is intentionally separate and tiny. A zero-change sync
    // can establish that a versioned manifest exists without loading and
    // JSON-parsing its potentially large payload from SQLite.
    const macroManifestWasReady = this.queries.getMetadata(
      CPP_MACRO_MANIFEST_READY_METADATA_KEY,
    ) === '1';
    const macroContextWasPending = this.queries.getMetadata(
      CPP_MACRO_CONTEXT_PENDING_METADATA_KEY,
    ) === '1';
    let macroPendingMarked = macroContextWasPending;
    const markMacroContextPending = (): void => {
      if (macroPendingMarked) return;
      // This marker is written before any macro-dependent graph replacement.
      // If the process dies later, the next process performs a full source scan
      // instead of trusting a manifest whose graph update may be only partial.
      this.queries.setMetadata(CPP_MACRO_CONTEXT_PENDING_METADATA_KEY, '1');
      macroPendingMarked = true;
    };
    this.syncRewireFailures = [];
    const log = verbose
      ? (message: string) => console.log(`[sync] ${message}`)
      : (_message: string) => {};
    const reconcileStarted = performance.now();

    onProgress?.({
      phase: 'scanning',
      current: 0,
      total: 0,
    });

    const filesToIndex: string[] = [];
    // === Filesystem reconcile (git-independent) ===
    // The source of truth for "what changed" is the filesystem vs the indexed
    // state — never git. We enumerate the current source files and reconcile
    // each against the DB. A cheap (size, mtime) stat pre-filter skips unchanged
    // files without reading or hashing them, so the expensive read+hash+parse
    // only runs for files that actually changed. This catches edits/adds/deletes
    // whether or not the project uses git, and crucially also catches committed
    // changes from `git pull`/`checkout`/`merge`/`rebase` — which `git status`
    // cannot see, because the working tree is clean afterward.
    let currentFiles: string[];
    let trackedFiles: FileRecord[];
    if (scopedPaths && scopedPaths.length > 0) {
      // Watcher paths are already filtered and canonicalized. Validate again
      // at this API boundary so a direct caller cannot make the pre-hash read
      // escape the project root.
      const unique = new Set<string>();
      let safe = true;
      for (const rawPath of scopedPaths) {
        const normalized = normalizePath(rawPath);
        if (!normalized || normalized === '.' || normalized.startsWith('..')) {
          safe = false;
          break;
        }
        if (!validatePathWithinRoot(this.rootDir, normalized)) {
          safe = false;
          break;
        }
        unique.add(canonicalFilePath(this.rootDir, normalized));
      }

      if (safe && unique.size > 0) {
        const paths = [...unique];
        currentFiles = paths.filter((filePath) =>
          fs.existsSync(path.join(this.rootDir, filePath))
        );
        trackedFiles = [];
        for (const filePath of paths) {
          const tracked = this.queries.getFileByPath(filePath);
          if (tracked) trackedFiles.push(tracked);
        }
        // Count examined paths, including deletions, so a successful scoped
        // delete cannot resemble the zero-shape used for lock contention.
        filesChecked = paths.length;
      } else {
        currentFiles = await scanDirectoryAsync(this.rootDir);
        trackedFiles = this.queries.getAllFiles();
        filesChecked = currentFiles.length;
      }
    } else {
      currentFiles = await scanDirectoryAsync(this.rootDir);
      trackedFiles = this.queries.getAllFiles();
      filesChecked = currentFiles.length;
    }
    const currentSet = new Set(currentFiles);

    const trackedMap = new Map<string, FileRecord>();
    for (const f of trackedFiles) {
      trackedMap.set(f.path, f);
    }

    // Removals: tracked in the DB but no longer a present source file. Check the
    // filesystem directly — `scanDirectory` (via `git ls-files`) still lists a
    // file deleted from disk but not yet staged, so set membership alone misses it.
    let reconcileChecks = 0;
    for (const tracked of trackedFiles) {
      if (!currentSet.has(tracked.path) || !fs.existsSync(path.join(this.rootDir, tracked.path))) {
        if (isCppMacroLanguage(tracked.language)) {
          markMacroContextPending();
          removedCppMacroFiles.add(tracked.path);
        }
        // Deleting the target cascades its incoming edges even though callers
        // in other files are unchanged. Preserve stamped resolution edges as
        // pending refs so this same sync can rebind them or park them for a
        // later symbol-driven retry.
        const resurrected = this.queries
          .getIncomingCrossFileEdges(tracked.path)
          .map(resurrectReferenceFromEdge)
          .filter((ref): ref is UnresolvedReference => ref !== null);
        if (resurrected.length > 0) {
          this.queries.insertUnresolvedRefsBatch(resurrected);
          for (const ref of resurrected) {
            if (ref.filePath) resurrectedReferenceSourceFiles.add(ref.filePath);
          }
        }
        this.queries.deleteFile(tracked.path);
        filesRemoved++;
      }
      if (++reconcileChecks % SYNC_RECONCILE_YIELD_INTERVAL === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }

    // Adds / modifications.
    for (const filePath of currentFiles) {
      // Keep the unchanged-file fast path cooperative too: most entries leave
      // through `continue` after stat, so the yield must happen at loop entry.
      if (++reconcileChecks % SYNC_RECONCILE_YIELD_INTERVAL === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const fullPath = path.join(this.rootDir, filePath);
      const tracked = trackedMap.get(filePath);
      const needsDeclarationMacroRecovery = hasDeclarationMacroRecoverySkipped(
        tracked?.errors,
      );

      // Cheap pre-filter: an already-indexed file whose size AND mtime both match
      // the DB is unchanged — skip it without reading or hashing. (A content
      // change that preserves both exactly is the blind spot every mtime-based
      // incremental tool accepts; `index --force` is the escape hatch. Git bumps
      // mtime on every file it writes during checkout/merge, so pulls are caught.)
      // A base-only file is intentionally exempt: unchanged source bytes do not
      // mean its graph coverage is complete, so a later sync must retry it.
      if (tracked && !needsDeclarationMacroRecovery) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size === tracked.size && Math.floor(stat.mtimeMs) === Math.floor(tracked.modifiedAt)) {
            continue;
          }
        } catch (error) {
          logDebug('Skipping unstattable file during sync', { filePath, error: String(error) });
          continue;
        }
      }

      // New, or size/mtime changed — read + hash to confirm a real content change.
      let content: string;
      try {
        content = fs.readFileSync(fullPath, 'utf-8');
      } catch (error) {
        logDebug('Skipping unreadable file during sync', { filePath, error: String(error) });
        continue;
      }
      const contentHash = hashContent(content);

      if (!tracked) {
        filesToIndex.push(filePath);
        changedSourceContents.set(filePath, content);
        filesAdded++;
      } else if (
        needsDeclarationMacroRecovery ||
        tracked.contentHash !== contentHash
      ) {
        filesToIndex.push(filePath);
        if (tracked.contentHash !== contentHash) {
          changedSourceContents.set(filePath, content);
        }
        filesModified++;
      }
    }

    const reconcileMs = performance.now() - reconcileStarted;
    let macroScanMs = 0;
    let macroManifestCandidate: CppMacroManifest | null = null;
    let macroManifestCandidateSerialized: string | null = null;
    let macroSemanticsChanged = false;
    let macroInvalidatedFiles = 0;
    const macroInvalidatedFilePaths = new Set<string>();

    const filesToIndexSet = new Set(filesToIndex);
    const enqueueMacroInvalidatedFile = (filePath: string): void => {
      if (filesToIndexSet.has(filePath)) return;
      filesToIndexSet.add(filePath);
      filesToIndex.push(filePath);
      macroInvalidatedFilePaths.add(filePath);
      macroInvalidatedFiles++;
    };

    const changedCppMacroSources = [...changedSourceContents.entries()].filter(
      ([filePath]) => isCppMacroFilePath(filePath),
    );
    const projectHasCppFiles =
      currentFiles.some(isCppMacroFilePath) ||
      (!macroManifestWasReady && this.queries.getAllFiles().some((file) =>
        isCppMacroLanguage(file.language)
      ));
    const needsPersistedMacroManifest =
      macroContextWasPending ||
      changedCppMacroSources.length > 0 ||
      removedCppMacroFiles.size > 0 ||
      filesToIndex.some(isCppMacroFilePath) ||
      (!macroManifestWasReady && projectHasCppFiles);
    const persistedMacroManifest = needsPersistedMacroManifest
      ? (this.globalMacroManifest ?? parseCppMacroManifest(
          this.queries.getMetadata(CPP_MACRO_MANIFEST_METADATA_KEY),
        ))
      : null;
    const hasPersistedMacroManifest = persistedMacroManifest !== null;
    const needsMacroManifestWork =
      macroContextWasPending ||
      changedCppMacroSources.length > 0 ||
      removedCppMacroFiles.size > 0 ||
      (!macroManifestWasReady && projectHasCppFiles);

    if (needsMacroManifestWork) {
      const macroStarted = performance.now();
      let forceAllCppConsumers = false;

      if (!hasPersistedMacroManifest || macroContextWasPending) {
        // Missing manifests predate this correctness contract. Pending means a
        // previous process may have updated some file rows without publishing
        // the matching context, so reconstruct exclusively from current bytes.
        this.clearGlobalMacroContext();
        macroManifestCandidate = await this.scanGlobalMacroManifest();
        forceAllCppConsumers = !hasPersistedMacroManifest;
      } else {
        const contributions = cppMacroManifestToMap(persistedMacroManifest);
        for (const filePath of removedCppMacroFiles) contributions.delete(filePath);
        for (const [filePath, content] of changedCppMacroSources) {
          const contribution = scanCppMacroFileContribution(content);
          if (isCppMacroContributionEmpty(contribution)) contributions.delete(filePath);
          else contributions.set(filePath, contribution);
        }
        macroManifestCandidate = cppMacroManifestFromMap(contributions);
      }

      macroManifestCandidateSerialized = serializeCppMacroManifest(
        macroManifestCandidate,
      );
      const macroManifestChanged = !persistedMacroManifest ||
        macroManifestCandidateSerialized !== serializeCppMacroManifest(
          persistedMacroManifest,
        );
      // Even a semantically neutral contribution change matters to a future
      // diff (for example, adding an identical duplicate definition and later
      // removing the original). Protect publication of that structural state
      // with the same crash marker used for consumer invalidation.
      if (macroManifestChanged) markMacroContextPending();

      this.installGlobalMacroManifest(macroManifestCandidate);
      const currentMacroContext = buildCppMacroContext(macroManifestCandidate);
      let affectedMacroNames = new Set<string>();
      if (persistedMacroManifest) {
        affectedMacroNames = diffCppMacroContexts(
          buildCppMacroContext(persistedMacroManifest),
          currentMacroContext,
        ).affectedNames;
      }
      macroSemanticsChanged = forceAllCppConsumers || affectedMacroNames.size > 0;

      if (macroSemanticsChanged) {
        markMacroContextPending();
        const allCppFiles = (await scanDirectoryAsync(this.rootDir)).filter(
          isCppMacroFilePath,
        );
        for (let index = 0; index < allCppFiles.length; index++) {
          const filePath = allCppFiles[index]!;
          if (filesToIndexSet.has(filePath)) continue;
          if (forceAllCppConsumers) {
            enqueueMacroInvalidatedFile(filePath);
          } else {
            const fullPath = validatePathWithinRoot(this.rootDir, filePath);
            if (!fullPath) {
              enqueueMacroInvalidatedFile(filePath);
              continue;
            }
            try {
              const content = await fsp.readFile(fullPath, 'utf-8');
              if (sourceReferencesAnyCppMacro(content, affectedMacroNames)) {
                enqueueMacroInvalidatedFile(filePath);
              }
            } catch {
              // An unreadable candidate cannot be proven unaffected. Queue it
              // so the normal per-file error path marks the sync incomplete.
              enqueueMacroInvalidatedFile(filePath);
            }
          }
          if ((index + 1) % SYNC_RECONCILE_YIELD_INTERVAL === 0) {
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
        }
        log(
          `macro context changed; invalidated ${macroInvalidatedFiles} unchanged ` +
          `C/C++/ObjC consumer(s)`
        );
      }
      macroScanMs = performance.now() - macroStarted;
    } else if (
      persistedMacroManifest &&
      filesToIndex.some(isCppMacroFilePath)
    ) {
      // Base-only recovery retries and other forced C-family parses still need
      // the exact context that produced the last complete graph.
      this.installGlobalMacroManifest(persistedMacroManifest);
    }

    const total = filesToIndex.length;
    let frameworkDetectionMs = 0;
    let workerSetupMs = 0;
    let readMs = 0;
    let parseWallMs = 0;
    let storeMs = 0;
    const extractionTimingTotals: ExtractionTimings = {};

    if (total > 0) {
      const neededLanguages = [...new Set(filesToIndex.map((filePath) => detectLanguage(filePath)))];
      if (neededLanguages.includes('c') && !neededLanguages.includes('cpp')) {
        neededLanguages.push('cpp');
      }

      const frameworkStarted = performance.now();
      const frameworkNames = this.ensureDetectedFrameworks();
      frameworkDetectionMs = performance.now() - frameworkStarted;

      const needsCppMacroContext = neededLanguages.some(
        (language) => language === 'c' || language === 'cpp' || language === 'objc',
      );
      let globalMacroNames = new Set<string>();
      let globalBodylessMacroNames = new Set<string>();
      let globalMacroDefinitions: CppMacroDefinition[] = [];
      if (needsCppMacroContext) {
        const macroStarted = performance.now();
        globalMacroNames = await this.ensureGlobalMacroNames();
        globalBodylessMacroNames = this.globalBodylessMacroNames ?? new Set<string>();
        globalMacroDefinitions = this.globalMacroDefinitions ?? [];
        macroScanMs += performance.now() - macroStarted;
      }

      const setupStarted = performance.now();
      const parseWorkerPath = path.join(__dirname, 'parse-worker.js');
      const useWorker = fs.existsSync(parseWorkerPath);
      let parsePool: ParseWorkerPool | null = null;
      if (useWorker) {
        const cpuCount = typeof os.availableParallelism === 'function'
          ? os.availableParallelism()
          : os.cpus().length;
        const requestedPoolSize = resolveParsePoolSize(
          process.env.CODEGRAPH_PARSE_WORKERS,
          cpuCount,
        );
        const poolSize = Math.max(1, Math.min(total, requestedPoolSize));
        let grammarBuffers: Record<string, Uint8Array> | undefined;
        try {
          grammarBuffers = await readGrammarWasmBytes(neededLanguages);
        } catch {
          grammarBuffers = undefined;
        }
        parsePool = new ParseWorkerPool({
          languages: neededLanguages,
          size: poolSize,
          workerScriptPath: parseWorkerPath,
          recycleInterval: WORKER_RECYCLE_INTERVAL,
          parseTimeoutMs: PARSE_TIMEOUT_MS,
          log: (message) => log(`worker ${message}`),
          grammarBuffers,
          macroNames: [...globalMacroNames],
          bodylessMacroNames: [...globalBodylessMacroNames],
          macroDefinitions: globalMacroDefinitions,
        });
        parsePool.prewarm();
        await parsePool.waitUntilReady();
        log(`parse worker pool=${poolSize}`);
      } else {
        await loadGrammarsForLanguages(neededLanguages);
        log('parse worker unavailable; using in-process fallback');
      }
      workerSetupMs = performance.now() - setupStarted;

      let processed = 0;
      onProgress?.({ phase: 'parsing', current: 0, total });
      try {
        for (let offset = 0; offset < filesToIndex.length; offset += FILE_IO_BATCH_SIZE) {
          const batch = filesToIndex.slice(offset, offset + FILE_IO_BATCH_SIZE);
          const readStarted = performance.now();
          const items = await Promise.all(batch.map(async (filePath) => {
            const fullPath = validatePathWithinRoot(this.rootDir, filePath);
            if (!fullPath) {
              return { filePath, content: null, stats: null, error: new Error('Path traversal blocked') };
            }
            try {
              const [content, stats] = await Promise.all([
                fsp.readFile(fullPath, 'utf-8'),
                fsp.stat(fullPath),
              ]);
              return { filePath, content, stats, error: null };
            } catch (error) {
              return { filePath, content: null, stats: null, error };
            }
          }));
          readMs += performance.now() - readStarted;

          const parseStarted = performance.now();
          const parsed = await Promise.all(items.map(async (item) => {
            if (item.error || item.content === null || item.stats === null) {
              return {
                ...item,
                result: null as ExtractionResult | null,
                parseError: null as unknown,
              };
            }
            if (item.stats.size > FILE_SIZE_WARN_THRESHOLD) {
              logWarn(
                `Large file may take longer to parse: ${item.filePath} ` +
                `(${(item.stats.size / 1024 / 1024).toFixed(1)}MB)`,
              );
            }
            const language = detectLanguage(item.filePath, item.content);
            try {
              const result = parsePool
                ? await parsePool.requestParse({
                    filePath: item.filePath,
                    content: item.content,
                    language,
                    frameworkNames,
                  })
                : extractFromSource(
                    item.filePath,
                    item.content,
                    language,
                    frameworkNames,
                    globalMacroNames,
                    globalBodylessMacroNames,
                    globalMacroDefinitions,
                  );
              return { ...item, language, result, parseError: null as unknown };
            } catch (parseError) {
              return { ...item, language, result: null as ExtractionResult | null, parseError };
            }
          }));
          parseWallMs += performance.now() - parseStarted;

          const storeStarted = performance.now();
          for (const item of parsed) {
            processed++;
            onProgress?.({
              phase: 'parsing',
              current: processed,
              total,
              currentFile: item.filePath,
            });
            if (item.error || item.content === null || item.stats === null) {
              const error: ExtractionError = {
                message: `Failed to read file: ${item.error instanceof Error ? item.error.message : String(item.error)}`,
                filePath: item.filePath,
                severity: 'error',
                code: 'read_error',
              };
              syncErrors.push(error);
              failedFilePaths.add(item.filePath);
              filesErrored++;
              log(`skipped ${item.filePath}: ${error.message}`);
              continue;
            }
            if (item.parseError || !item.result) {
              const error: ExtractionError = {
                message: item.parseError instanceof Error
                  ? item.parseError.message
                  : String(item.parseError ?? 'parse failed'),
                filePath: item.filePath,
                severity: 'error',
                code: 'parse_error',
              };
              syncErrors.push(error);
              failedFilePaths.add(item.filePath);
              filesErrored++;
              log(`skipped ${item.filePath}: ${error.message}`);
              continue;
            }
            const language = 'language' in item
              ? item.language
              : detectLanguage(item.filePath, item.content);
            if (item.result.nodes.length > 0 || item.result.errors.length === 0) {
              this.storeExtractionResult(
                item.filePath,
                item.content,
                language,
                item.stats,
                item.result,
                macroInvalidatedFilePaths.has(item.filePath) ? { force: true } : undefined,
              );
              changedFilePaths.push(item.filePath);
            } else {
              const resultErrors = item.result.errors.length > 0
                ? item.result.errors
                : [{
                    message: 'Parse produced no storable result',
                    filePath: item.filePath,
                    severity: 'error' as const,
                    code: 'parse_error',
                  }];
              syncErrors.push(...resultErrors.map((error) => ({
                ...error,
                filePath: error.filePath ?? item.filePath,
              })));
              failedFilePaths.add(item.filePath);
              filesErrored++;
              log(`skipped ${item.filePath}: parse produced no storable result`);
              continue;
            }
            nodesUpdated += item.result.nodes.length;
            accumulateExtractionTimings(extractionTimingTotals, item.result.timings);
            if (verbose && item.result.timings) {
              log(`timing ${item.filePath} ${formatExtractionTimings(item.result.timings)}`);
            }
          }
          storeMs += performance.now() - storeStarted;
        }
      } finally {
        if (parsePool) await parsePool.destroy();
      }
    }

    log(
      `phases reconcile=${Math.round(reconcileMs)}ms ` +
      `framework=${Math.round(frameworkDetectionMs)}ms ` +
      `macroScan=${Math.round(macroScanMs)}ms ` +
      `workerSetup=${Math.round(workerSetupMs)}ms read=${Math.round(readMs)}ms ` +
      `parseWall=${Math.round(parseWallMs)}ms store=${Math.round(storeMs)}ms`,
    );
    const extractionTimingSummary = formatExtractionTimings(extractionTimingTotals);
    if (extractionTimingSummary) log(`extraction totals ${extractionTimingSummary}`);

    if (
      macroManifestCandidate &&
      (!macroSemanticsChanged || syncErrors.length === 0)
    ) {
      try {
        this.queries.setMetadata(
          CPP_MACRO_MANIFEST_METADATA_KEY,
          macroManifestCandidateSerialized ?? serializeCppMacroManifest(
            macroManifestCandidate,
          ),
        );
        this.queries.setMetadata(CPP_MACRO_MANIFEST_READY_METADATA_KEY, '1');
        this.queries.setMetadata(CPP_MACRO_CONTEXT_PENDING_METADATA_KEY, '0');
      } catch (error) {
        // The pending marker (when semantics changed) deliberately remains set;
        // a later process will rebuild from source instead of trusting a graph
        // whose manifest publication did not finish.
        logDebug('Could not persist updated C/C++ macro manifest', {
          error: String(error),
        });
      }
    }

    const failedFiles = [...new Set(this.syncRewireFailures)];
    this.syncRewireFailures = [];

    return {
      complete: syncErrors.length === 0,
      filesChecked,
      filesAdded,
      filesModified,
      filesRemoved,
      filesErrored,
      nodesUpdated,
      durationMs: Date.now() - startTime,
      errors: syncErrors,
      failedFilePaths: failedFilePaths.size > 0 ? [...failedFilePaths] : undefined,
      changedFilePaths: changedFilePaths.length > 0 ? changedFilePaths : undefined,
      failedRewireSourceFiles: failedFiles.length > 0 ? failedFiles : undefined,
      resurrectedReferenceSourceFiles:
        resurrectedReferenceSourceFiles.size > 0
          ? [...resurrectedReferenceSourceFiles]
          : undefined,
    };
  }

  /**
   * Get files that have changed since last index.
   * Uses git status as a fast path when available, falling back to full scan.
   */
  getChangedFiles(): { added: string[]; modified: string[]; removed: string[] } {
    // .codegraphignore negation rules re-include files git has already excluded,
    // so `git status` never reports them.  Fall back to a full filesystem scan.
    const gitChanges = hasCodegraphIgnoreNegation(this.rootDir) ? null : getGitChangedFiles(this.rootDir);

    if (gitChanges) {
      // === Git fast path ===
      const added: string[] = [];
      const modified: string[] = [];
      const removed: string[] = [];

      // Apply built-in + .gitignore + .codegraphignore filters on the LOGICAL path
      // (a user's rule targets the symlink name they see), then canonicalize so a
      // symlink path and its real path collapse to one canonical change. Git status
      // only respects .gitignore, so the supplement layers are applied here.
      const ig = buildDefaultIgnore(this.rootDir);
      const canonOf = (f: string) => canonicalFilePath(this.rootDir, f);
      const dedup = (arr: string[]) => [...new Set(arr)];
      const modifiedCanons = dedup(gitChanges.modified.filter((f) => !ig.ignores(f)).map(canonOf));
      const addedCanons = dedup(gitChanges.added.filter((f) => !ig.ignores(f)).map(canonOf));
      const deletedCanons = dedup(gitChanges.deleted.map(canonOf));

      // Deleted — only report if tracked in DB AND the canonical file is really
      // gone from disk. A symlink deletion with the real file still present must
      // NOT remove the canonical row (the file still exists at its real path).
      for (const canon of deletedCanons) {
        if (!this.queries.getFileByPath(canon)) continue;
        if (fs.existsSync(path.join(this.rootDir, canon))) continue;
        removed.push(canon);
      }

      // Modified + added files — read + hash, compare with DB. Untracked (`??`)
      // files stay untracked in git even after indexing, so they must be
      // hash-compared like modified files instead of always counting as added —
      // otherwise status reports them as pending forever. (See issue #206.)
      for (const canon of [...modifiedCanons, ...addedCanons]) {
        const fullPath = path.join(this.rootDir, canon);
        let content: string;
        try {
          content = fs.readFileSync(fullPath, 'utf-8');
        } catch (error) {
          logDebug('Skipping unreadable file while detecting changes', { filePath: canon, error: String(error) });
          continue;
        }

        const contentHash = hashContent(content);
        const tracked = this.queries.getFileByPath(canon);

        if (!tracked) {
          added.push(canon);
        } else if (tracked.contentHash !== contentHash) {
          modified.push(canon);
        }
      }

      return { added, modified, removed };
    }

    // === Fallback: full scan (non-git project or git failure) ===
    const currentFiles = new Set(scanDirectory(this.rootDir));
    const trackedFiles = this.queries.getAllFiles();

    // Build Map for O(1) lookups
    const trackedMap = new Map<string, FileRecord>();
    for (const f of trackedFiles) {
      trackedMap.set(f.path, f);
    }

    const added: string[] = [];
    const modified: string[] = [];
    const removed: string[] = [];

    // Find removed files
    for (const tracked of trackedFiles) {
      if (!currentFiles.has(tracked.path)) {
        removed.push(tracked.path);
      }
    }

    // Find added and modified files
    for (const filePath of currentFiles) {
      const fullPath = path.join(this.rootDir, filePath);
      let content: string;
      try {
        content = fs.readFileSync(fullPath, 'utf-8');
      } catch (error) {
        logDebug('Skipping unreadable file while detecting changes', { filePath, error: String(error) });
        continue;
      }

      const contentHash = hashContent(content);
      const tracked = trackedMap.get(filePath);

      if (!tracked) {
        added.push(filePath);
      } else if (tracked.contentHash !== contentHash) {
        modified.push(filePath);
      }
    }

    return { added, modified, removed };
  }
}

// Re-export useful types and functions
export { extractFromSource } from './tree-sitter';
export { detectLanguage, isSourceFile, isLanguageSupported, isGrammarLoaded, getSupportedLanguages, initGrammars, loadGrammarsForLanguages, loadAllGrammars } from './grammars';
