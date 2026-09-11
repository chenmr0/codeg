/** Optional subprocess transport for the Rust scan prototype (not N-API yet). */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { isSourceFile } from './grammars';
import { codeGraphDirName } from '../directory';
import { checkRustScanArtifact } from './rust-scan-artifact';

export { RUST_SCAN_PROTOCOL } from './rust-scan-artifact';
import { RUST_SCAN_PROTOCOL } from './rust-scan-artifact';
export interface RustScanRequest {
  protocol: number;
  root: string;
  rootRules: string[];
  extensions: string[];
  dataDir: string;
}
export interface RustFileStat { path: string; size: number; mtimeMs: number }
export interface RustScanSnapshot {
  paths: string[];
  stats: Map<string, RustFileStat>;
  directories: number;
  entries: number;
  metadata: number;
  kernelMs: number;
}
export interface RustScanCapture { snapshot?: RustScanSnapshot }
export interface RustGitFilterResult { included: number[]; deferred: number[]; kernelMs: number }

export function rustScanMode(): 'off' | 'verify' | 'on' | 'auto' {
  const value = process.env.CODEGRAPH_RUST_SCAN;
  if (value === undefined || value === '' || value === 'auto') return 'auto';
  return value === '1' ? 'on' : value === 'verify' ? 'verify' : 'off';
}

export function rustScanBinaryPath(): string {
  return process.env.CODEGRAPH_RUST_SCAN_PATH ?? path.join(__dirname, '..', 'native-scan',
    `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'codegraph-scan.exe' : 'codegraph-scan');
}

export function automaticRustScanStatus(): { ready: boolean; reason: string } {
  try { checkRustScanArtifact(rustScanBinaryPath()); return { ready: true, reason: 'none' }; }
  catch (error) {
    const reason = error instanceof Error ? error.message : '';
    return { ready: false, reason: /^[a-z-]+$/.test(reason) ? reason : 'artifact-error' };
  }
}

/** Strict transport validation: malformed/partial output never becomes deletions. */
export function decodeRustSnapshot(value: unknown): RustScanSnapshot {
  if (!value || typeof value !== 'object') throw new Error('invalid-response');
  const raw = value as Record<string, unknown>;
  if (raw.protocol !== RUST_SCAN_PROTOCOL) throw new Error('protocol');
  if (raw.ok !== true) throw new Error(typeof raw.reason === 'string' && /^[a-z-]+$/.test(raw.reason)
    ? raw.reason : 'native-rejected');
  if (!Array.isArray(raw.files) || raw.files.length > 250_000) throw new Error('invalid-files');
  const paths: string[] = [];
  const stats = new Map<string, RustFileStat>();
  const identities = new Set<string>();
  const dataDir = codeGraphDirName();
  for (const item of raw.files) {
    if (!item || typeof item !== 'object') throw new Error('invalid-file');
    const file = item as RustFileStat;
    if (typeof file.path !== 'string' || !/^[\x20-\x7e]+$/.test(file.path) ||
        file.path.includes('\\') || path.isAbsolute(file.path) || file.path.includes(':') ||
        file.path.split('/').some(part => !part || part === '.' || part === '..' || part === '.git' ||
          part === '.codegraph' || part.startsWith('.codegraph-') || part === dataDir) ||
        !isSourceFile(file.path, 'all') || stats.has(file.path) ||
        !Number.isSafeInteger(file.size) || file.size < 0 ||
        !Number.isSafeInteger(file.mtimeMs) || file.mtimeMs < 0) throw new Error('invalid-file');
    const identity = process.platform === 'win32' ? file.path.toLowerCase() : file.path;
    if (identities.has(identity)) throw new Error('case-collision');
    identities.add(identity);
    paths.push(file.path);
    stats.set(file.path, { path: file.path, size: file.size, mtimeMs: file.mtimeMs });
  }
  const counters = raw.counters as Record<string, unknown> | undefined;
  if (!counters || !['directories', 'entries', 'metadata'].every(key =>
    typeof counters[key] === 'number' && Number.isSafeInteger(counters[key]) && (counters[key] as number) >= 0) ||
    (counters.directories as number) < 1 || (counters.entries as number) < paths.length ||
    counters.metadata !== paths.length || typeof raw.elapsedMs !== 'number' ||
    !Number.isFinite(raw.elapsedMs) || raw.elapsedMs < 0) throw new Error('invalid-counters');
  // The helper also emits legacy extensionless/routes/Shopify special cases.
  // Validate its entire response before filtering; excluded rows must still
  // participate in duplicate, identity and counter validation.
  const selectedPaths = paths.filter(file => isSourceFile(file));
  const selectedStats = new Map(selectedPaths.map(file => [file, stats.get(file)!]));
  return { paths: selectedPaths, stats: selectedStats, directories: counters.directories as number, entries: counters.entries as number,
    metadata: counters.metadata as number, kernelMs: raw.elapsedMs };
}

export function runRustScan(request: RustScanRequest): RustScanSnapshot {
  const binary = rustScanBinaryPath();
  if (!fs.existsSync(binary)) throw new Error('binary-missing');
  const root = path.resolve(request.root);
  // Root aliases and every link encountered by Rust defer to the existing
  // canonicalization implementation; do not invent new graph identities.
  if (path.relative(fs.realpathSync(root), root) !== '') throw new Error('root-alias');
  const configured = Number(process.env.CODEGRAPH_RUST_SCAN_TIMEOUT_MS);
  const timeout = Number.isFinite(configured) && configured >= 100 && configured <= 60_000 ? configured : 15_000;
  let output: string;
  try {
    output = execFileSync(binary, [], { input: JSON.stringify(request), encoding: 'utf8',
      timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch { throw new Error('process-failed'); }
  let value: unknown;
  try { value = JSON.parse(output); } catch { throw new Error('response-json'); }
  return decodeRustSnapshot(value);
}

/** Apply only the validated root matcher to an already-authoritative Git list. */
export function decodeRustGitFilter(value: unknown, candidateCount: number): RustGitFilterResult {
  if (!value || typeof value !== 'object') throw new Error('invalid-response');
  const raw = value as Record<string, unknown>;
  if (raw.protocol !== RUST_SCAN_PROTOCOL) throw new Error('protocol');
  if (raw.ok !== true) throw new Error(typeof raw.reason === 'string' && /^[a-z-]+$/.test(raw.reason)
    ? raw.reason : 'native-rejected');
  if (raw.operation !== 'filter' || !Array.isArray(raw.included) || !Array.isArray(raw.deferred) ||
      raw.included.length + raw.deferred.length > candidateCount ||
      !Array.isArray(raw.files) || raw.files.length !== 0 || typeof raw.elapsedMs !== 'number' ||
      !Number.isFinite(raw.elapsedMs) || raw.elapsedMs < 0) throw new Error('invalid-filter');
  const indexes = (rawIndexes: unknown[]): number[] => {
    let previous = -1;
    return rawIndexes.map(index => {
      if (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) >= candidateCount ||
          (index as number) <= previous) throw new Error('invalid-filter');
      previous = index as number;
      return previous;
    });
  };
  const included = indexes(raw.included), deferred = indexes(raw.deferred);
  const includedSet = new Set(included);
  if (deferred.some(index => includedSet.has(index))) throw new Error('invalid-filter');
  return { included, deferred, kernelMs: raw.elapsedMs };
}

export function runRustGitFilter(rootDir: string, rootRules: string[], candidates: string[]): RustGitFilterResult {
  const binary = rustScanBinaryPath();
  checkRustScanArtifact(binary);
  const root = path.resolve(rootDir);
  if (path.relative(fs.realpathSync(root), root) !== '') throw new Error('root-alias');
  if (candidates.length > 250_000) throw new Error('file-limit');
  const configured = Number(process.env.CODEGRAPH_RUST_GIT_IGNORE_TIMEOUT_MS);
  const timeout = Number.isFinite(configured) && configured >= 100 && configured <= 60_000 ? configured : 15_000;
  let output: string;
  try {
    output = execFileSync(binary, [], { input: JSON.stringify({ protocol: RUST_SCAN_PROTOCOL,
      operation: 'filter', root, rootRules, candidates }), encoding: 'utf8', timeout,
      maxBuffer: 16 * 1024 * 1024, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch { throw new Error('process-failed'); }
  let value: unknown;
  try { value = JSON.parse(output); } catch { throw new Error('response-json'); }
  return decodeRustGitFilter(value, candidates.length);
}

/** Verification is intentionally read-only and never returns native stats for reuse. */
export function verifyRustSnapshot(root: string, snapshot: RustScanSnapshot, baseline: string[]): boolean {
  if (baseline.length !== snapshot.paths.length || baseline.some((file, i) => file !== snapshot.paths[i])) return false;
  try {
    return baseline.every(file => {
      const expected = snapshot.stats.get(file)!;
      const actual = fs.statSync(path.join(root, file));
      return actual.isFile() && actual.size === expected.size && Math.floor(actual.mtimeMs) === expected.mtimeMs;
    });
  } catch { return false; }
}
