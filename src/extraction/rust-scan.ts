/** Optional subprocess transport for the Rust scan prototype (not N-API yet). */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { isSourceFile } from './grammars';
import { codeGraphDirName } from '../directory';

export const RUST_SCAN_PROTOCOL = 1;
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

export function rustScanMode(): 'off' | 'verify' | 'on' {
  const value = process.env.CODEGRAPH_RUST_SCAN;
  return value === '1' ? 'on' : value === 'verify' ? 'verify' : 'off';
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
        !isSourceFile(file.path) || stats.has(file.path) ||
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
  return { paths, stats, directories: counters.directories as number, entries: counters.entries as number,
    metadata: counters.metadata as number, kernelMs: raw.elapsedMs };
}

export function runRustScan(request: RustScanRequest): RustScanSnapshot {
  const binary = process.env.CODEGRAPH_RUST_SCAN_PATH ?? path.join(__dirname, '..', 'native-scan',
    `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'codegraph-scan.exe' : 'codegraph-scan');
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
