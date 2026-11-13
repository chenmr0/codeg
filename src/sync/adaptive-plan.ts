/** Read-only source planning and structural sync decisions. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import { scanDirectoryAsync, hashContent } from '../extraction';
import { EXTRACTION_VERSION } from '../extraction/extraction-version';
import { hasDeclarationMacroRecoverySkipped } from '../extraction/diagnostics';
import { getLanguageScopeKey } from '../extraction/language-scope';
import { getSupportedLanguages, resolveWasmPath, type GrammarLanguage } from '../extraction/grammars';
import { rustScanBinaryPath, automaticRustScanStatus } from '../extraction/rust-scan';
import { rustMacroBinaryPath, automaticRustMacroStatus } from '../extraction/rust-macros';
import type { FileRecord } from '../types';
import { indexConfigFingerprints } from './index-policy';
import { validatePathWithinRoot } from '../utils';
export { adaptiveConfigFingerprint } from './index-policy';

const digest = (value: unknown): string => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface AdaptiveInventoryEntry {
  path: string; size: number;
}
export interface AdaptiveSnapshot {
  files: AdaptiveInventoryEntry[];
  configFingerprint: string;
  /** Extraction and resolution inputs, tracked independently of inventory controls. */
  semanticConfigFingerprint: string;
}
export interface AdaptivePlan {
  snapshot: AdaptiveSnapshot;
  added: string[]; modified: string[]; removed: string[];
  changedFiles: number; affectedOldNodes: number; changedBytes: number;
  totalFiles: number; totalBytes: number; totalNodes: number;
  planningMs: number;
  runtimeKey: string;
}
export interface AdaptiveRuleSelection {
  fileScale?: boolean;
  oldNodeScale?: boolean;
}
export interface AdaptiveDecisionMetrics {
  changedFiles: number;
  totalFiles: number;
  oldFiles: number;
  changedFileFraction: number;
  affectedOldNodes: number;
  totalOldNodes: number;
  affectedOldNodeFraction: number;
  changedBytes: number;
  totalBytes: number;
  changedByteFraction: number;
}
export interface AdaptiveDecision {
  strategy: 'incremental' | 'rebuild';
  reason: string;
  /** @deprecated Structural decisions do not produce timing estimates. */
  estimatedIncrementalMs?: number;
  /** @deprecated Structural decisions do not produce timing estimates. */
  estimatedRebuildMs?: number;
  metrics?: AdaptiveDecisionMetrics;
  matchedRule?: 'fileScale' | 'oldNodeScale' | 'both';
}
export interface AdaptiveEligibility {
  /** Storage/source restrictions that cannot be overridden by strategy configuration. */
  blockedReason?: string;
  /** Fingerprint persisted with the currently published index, if available. */
  configFingerprint?: string;
  /** Actual policy changes, not merely missing cost observations. */
  configurationChanged?: boolean;
  upgradeRequired?: boolean;
  /** Explicit coverage policy, not a claim of optimal measured cost. */
  fallback?: Partial<AdaptiveFallbackPolicy>;
  rules?: AdaptiveRuleSelection;
  enabled?: boolean;
  disabledReason?: string;
}
export interface AdaptiveFallbackPolicy {
  minChangedFiles: number;
  minChangedFraction: number;
  minWorkFraction: number;
  minAffectedOldNodes: number;
  minAffectedOldNodeFraction: number;
}
export const DEFAULT_ADAPTIVE_FALLBACK: Readonly<AdaptiveFallbackPolicy> = Object.freeze({
  minChangedFiles: 128, minChangedFraction: 0.25, minWorkFraction: 0.25,
  minAffectedOldNodes: 10_000, minAffectedOldNodeFraction: 0.25,
});
function fallbackPolicy(overrides: Partial<AdaptiveFallbackPolicy> = {}): AdaptiveFallbackPolicy {
  const policy = { ...DEFAULT_ADAPTIVE_FALLBACK, ...overrides };
  if (!Number.isSafeInteger(policy.minChangedFiles) || policy.minChangedFiles < 1 ||
    !Number.isSafeInteger(policy.minAffectedOldNodes) || policy.minAffectedOldNodes < 1 ||
    ![policy.minChangedFraction, policy.minWorkFraction, policy.minAffectedOldNodeFraction].every(value => Number.isFinite(value) && value > 0 && value <= 1)) {
    throw new Error('Invalid adaptive fallback policy');
  }
  return policy;
}
type StructuralWork = Pick<AdaptivePlan, 'added' | 'removed' | 'changedFiles' | 'affectedOldNodes' |
  'changedBytes' | 'totalFiles' | 'totalBytes' | 'totalNodes'>;

function structuralRules(work: StructuralWork, overrides?: Partial<AdaptiveFallbackPolicy>, rules: AdaptiveRuleSelection = {}) {
  const policy = fallbackPolicy(overrides);
  const oldFiles = work.totalFiles - work.added.length + work.removed.length;
  const fileBase = Math.max(oldFiles, work.totalFiles);
  const metrics: AdaptiveDecisionMetrics = {
    changedFiles: work.changedFiles, totalFiles: work.totalFiles, oldFiles,
    changedFileFraction: fileBase > 0 ? work.changedFiles / fileBase : 0,
    affectedOldNodes: work.affectedOldNodes, totalOldNodes: work.totalNodes,
    affectedOldNodeFraction: work.totalNodes > 0 ? work.affectedOldNodes / work.totalNodes : 0,
    changedBytes: work.changedBytes, totalBytes: work.totalBytes,
    changedByteFraction: work.totalBytes > 0 ? work.changedBytes / work.totalBytes : 0,
  };
  const oldNodeScale = rules.oldNodeScale !== false && work.changedFiles > 0 &&
    work.affectedOldNodes >= policy.minAffectedOldNodes &&
    metrics.affectedOldNodeFraction >= policy.minAffectedOldNodeFraction;
  const fileScale = rules.fileScale !== false && work.changedFiles >= policy.minChangedFiles &&
    metrics.changedFileFraction >= policy.minChangedFraction &&
    (metrics.changedByteFraction >= policy.minWorkFraction ||
      metrics.affectedOldNodeFraction >= policy.minWorkFraction);
  return { metrics, fileScale, oldNodeScale };
}

/** Broad file/work coverage or substantial old-node coverage. Removed files
 * contribute old nodes; additions contribute their current source bytes. */
export function hasStructuralRebuildWork(work: StructuralWork, overrides?: Partial<AdaptiveFallbackPolicy>,
  rules?: AdaptiveRuleSelection): boolean {
  const matched = structuralRules(work, overrides, rules);
  return matched.fileScale || matched.oldNodeScale;
}

/** One policy applies to both the portable and generation-based stores. */
export function chooseStructuralStrategy(work: StructuralWork, eligibility: AdaptiveEligibility = {}): AdaptiveDecision {
  const { metrics, fileScale, oldNodeScale } = structuralRules(work, eligibility.fallback, eligibility.rules);
  const incremental = (reason: string): AdaptiveDecision => ({ strategy: 'incremental', reason, metrics });
  if (eligibility.blockedReason) return incremental(eligibility.blockedReason);
  if (work.changedFiles === 0) return incremental('no-content-changes');
  if (eligibility.enabled === false) return incremental(eligibility.disabledReason ?? 'disabled');
  if (eligibility.rules?.fileScale === false && eligibility.rules.oldNodeScale === false) return incremental('rules-disabled');
  if (!work.totalFiles || !work.totalBytes) return incremental('empty-target');
  if (!fileScale && !oldNodeScale) return incremental('below-rebuild-range');
  const matchedRule = fileScale ? (oldNodeScale ? 'both' : 'fileScale') : 'oldNodeScale';
  return { strategy: 'rebuild', reason: 'structural-large-change', metrics, matchedRule };
}

let implementationFingerprint: string | undefined;
/** Cache the loaded implementation identity, but read runtime options on every operation. */
function implementationKey(): string {
  if (implementationFingerprint) return implementationFingerprint;
  const root = path.resolve(__dirname, '..');
  const rows: Array<[string, string]> = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && /\.(?:js|ts|sql)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        rows.push([path.relative(root, absolute), crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')]);
      }
    }
  };
  visit(root);
  // Grammar packages can change without changing this package's version. Hash
  // the actual bundled/package grammar bytes once, not just package metadata.
  for (const language of getSupportedLanguages().filter(value => !['svelte', 'vue', 'liquid'].includes(value)).sort()) {
    try { rows.push([`grammar:${language}`, crypto.createHash('sha256').update(fs.readFileSync(resolveWasmPath(language as GrammarLanguage))).digest('hex')]); }
    catch (error) { rows.push([`grammar:${language}`, `unavailable:${(error as NodeJS.ErrnoException).code ?? 'unknown'}`]); }
  }
  implementationFingerprint = digest(rows);
  return implementationFingerprint;
}
const helperIdentities = new Map<string, { signature: string; identity: string }>();
function nativeHelperIdentity(binary: string, status: () => { ready: boolean; reason: string }): string {
  const manifest = path.join(path.dirname(binary), 'manifest.json');
  const statKey = (filename: string): unknown => {
    try { const stat = fs.statSync(filename); return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode]; }
    catch (error) { return (error as NodeJS.ErrnoException).code ?? 'unknown'; }
  };
  const signature = digest([statKey(binary), statKey(manifest)]);
  const cached = helperIdentities.get(binary);
  if (cached?.signature === signature) return cached.identity;
  const bytes = (filename: string): string => {
    try { return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex'); }
    catch (error) { return `unavailable:${(error as NodeJS.ErrnoException).code ?? 'unknown'}`; }
  };
  const identity = digest([binary, status(), bytes(binary), bytes(manifest)]);
  helperIdentities.set(binary, { signature, identity });
  return identity;
}
export function adaptiveRuntimeKey(root: string, backend: string): string {
  const env = Object.entries(process.env).filter(([key]) => key.startsWith('CODEGRAPH_') &&
    !['CODEGRAPH_ADAPTIVE_SYNC', 'CODEGRAPH_ADAPTIVE_CHILD'].includes(key)).sort(([a], [b]) => a.localeCompare(b));
  return digest({ root: fs.realpathSync(root), backend, implementation: implementationKey(),
    nativeScan: nativeHelperIdentity(rustScanBinaryPath(), automaticRustScanStatus),
    nativeMacros: nativeHelperIdentity(rustMacroBinaryPath(), automaticRustMacroStatus),
    extraction: EXTRACTION_VERSION, language: getLanguageScopeKey(), node: process.version,
    platform: process.platform, arch: process.arch, cpus: os.cpus().map(cpu => cpu.model),
    memory: os.totalmem(), execArgv: process.execArgv, nodeOptions: process.env.NODE_OPTIONS ?? '', env });
}

/** Count policy-required extraction even when source hashes are unchanged. */
export function includeAdaptiveReindexWork(plan: AdaptivePlan, tracked: ReadonlyArray<FileRecord>,
  paths: ReadonlyArray<string>): AdaptivePlan {
  const old = new Map(tracked.map(file => [file.path, file]));
  const visible = new Map(plan.snapshot.files.map(file => [file.path, file]));
  const modified = new Set(plan.modified);
  const excluded = new Set([...plan.added, ...plan.removed]);
  let affectedOldNodes = plan.affectedOldNodes, changedBytes = plan.changedBytes;
  for (const relative of paths) {
    const prior = old.get(relative), current = visible.get(relative);
    if (!prior || !current || excluded.has(relative) || modified.has(relative)) continue;
    modified.add(relative);
    affectedOldNodes += prior.nodeCount;
    changedBytes += current.size;
  }
  const updated = [...modified].sort();
  return { ...plan, modified: updated,
    changedFiles: plan.added.length + updated.length + plan.removed.length,
    affectedOldNodes, changedBytes };
}

/** A source inventory can be safe for incremental sync without being eligible
 * for atomic replacement. Do not turn this into permission to publish it. */
export class AdaptiveSourceIneligibleError extends Error {}

/** Recheck immediately before switching the active database. Source mutations
 * cannot be locked by the DB writer lease, so catch-up still handles later edits. */
export async function assertRebuildSourceEligibility(root: string): Promise<void> {
  for (const relative of await scanDirectoryAsync(root)) {
    const absolute = path.resolve(root, relative);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(absolute); }
    catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
      throw error;
    }
    if (stat.isSymbolicLink() || fs.realpathSync(absolute) !== absolute) {
      throw new AdaptiveSourceIneligibleError(`Symlink source is not eligible: ${relative}`);
    }
    if (!stat.isFile()) throw new Error(`Unsupported adaptive source: ${relative}`);
  }
}

/** Ordinary planning uses sync's size/mtime shortcut. Post-publication catch-up hashes every source. */
export async function createAdaptivePlan(root: string, tracked: ReadonlyArray<FileRecord>,
  options: { runtimeKey: string; fullHash?: boolean; reconcileAuthorizedLinks?: boolean; observeContent?: (relative: string, content: string) => void } ): Promise<AdaptivePlan> {
  const started = performance.now();
  for (const file of tracked) {
    if (!path.resolve(root, file.path).startsWith(path.resolve(root) + path.sep)) {
      throw new Error('Tracked source path escapes root');
    }
  }
  const old = new Map(tracked.map(file => [file.path, file]));
  const files: AdaptiveInventoryEntry[] = [];
  const added: string[] = [], modified: string[] = [];
  let affectedOldNodes = 0, changedBytes = 0;
  const visible = (await scanDirectoryAsync(root)).sort();
  for (let i = 0; i < visible.length; i++) {
    const relative = visible[i]!;
    const absolute = path.resolve(root, relative);
    if (!absolute.startsWith(path.resolve(root) + path.sep)) throw new Error('Adaptive source path escapes root');
    let before: fs.Stats;
    try { before = fs.lstatSync(absolute); }
    catch (error) {
      // Git may enumerate a tracked but unstaged deletion. Keep its indexed
      // record in old so it contributes to removals. Other I/O failures abort.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      throw error;
    }
    const realSource = fs.realpathSync(absolute);
    const linked = before.isSymbolicLink() || realSource !== absolute;
    if (linked) {
      // Recovery is NOT publication admission. A DB already marked pending
      // must be reconciled with all currently authorized bytes, not remain
      // permanently stuck merely because the source tree gained a link.
      if (!options.fullHash || !options.reconcileAuthorizedLinks) {
        throw new AdaptiveSourceIneligibleError(`Symlink source is not eligible: ${relative}`);
      }
      if (validatePathWithinRoot(root, absolute, true) !== realSource) {
        throw new Error(`Source is not authorized for reconciliation: ${relative}`);
      }
      before = fs.statSync(realSource);
    }
    if (!before.isFile()) throw new Error(`Unsupported adaptive source: ${relative}`);
    const prior = old.get(relative);
    let contentHash: string;
    // Ordinary sync re-reads incomplete macro extractions even with matching
    // stat metadata. Count a recovery file only when those bytes really changed.
    if (!options.fullHash && prior && !hasDeclarationMacroRecoverySkipped(prior.errors) && before.size === prior.size &&
        Math.floor(before.mtimeMs) === Math.floor(prior.modifiedAt)) contentHash = prior.contentHash;
    else {
      const content = fs.readFileSync(realSource, 'utf8');
      contentHash = hashContent(content);
      options.observeContent?.(relative, content);
    }
    const after = fs.statSync(realSource);
    if (linked && (fs.realpathSync(absolute) !== realSource || validatePathWithinRoot(root, absolute, true) !== realSource)) {
      throw new Error(`Source link changed during reconciliation: ${relative}`);
    }
    if (before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.ino !== after.ino) {
      throw new Error(`Source changed during adaptive planning: ${relative}`);
    }
    files.push({ path: relative, size: after.size });
    if (!prior) { added.push(relative); changedBytes += after.size; }
    else if (prior.contentHash !== contentHash) {
      modified.push(relative); affectedOldNodes += prior.nodeCount; changedBytes += after.size;
    }
    old.delete(relative);
    if ((i + 1) % 100 === 0) await new Promise<void>(resolve => setImmediate(resolve));
  }
  const removed = [...old.keys()].sort();
  for (const previous of old.values()) {
    // Distinguish a filtered file from denied access. Neither stat errors nor a
    // missing traversal permission may authorize an adaptive full replacement.
    try { fs.statSync(path.resolve(root, previous.path)); }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    affectedOldNodes += previous.nodeCount;
  }
  const snapshot = { files, ...indexConfigFingerprints(root, [...tracked, ...files]) };
  return { snapshot, added, modified, removed, changedFiles: added.length + modified.length + removed.length,
    affectedOldNodes, changedBytes, totalFiles: files.length, totalBytes: files.reduce((n, file) => n + file.size, 0),
    totalNodes: tracked.reduce((n, file) => n + file.nodeCount, 0),
    planningMs: performance.now() - started, runtimeKey: options.runtimeKey };
}

/** The indexed rows use canonical paths. Verify that assumption before using
 * this upper bound to skip a wider scan for authoritative watcher events. */
export function scopedCandidateCounts(paths: string[], prior: Map<string, FileRecord>) {
  let totalOldNodes = 0;
  for (const file of prior.values()) totalOldNodes += file.nodeCount;
  return { pathsCount: paths.length, totalOldFiles: prior.size, totalOldNodes,
    affectedOldNodes: paths.reduce((n, file) => n + (prior.get(file)?.nodeCount ?? 0), 0) };
}

export async function hasCanonicalScope(root: string, paths: string[], prior: Map<string, FileRecord>): Promise<boolean> {
  const base = path.resolve(root);
  for (const [i, relative] of paths.entries()) {
    const absolute = path.resolve(base, relative);
    if (!absolute.startsWith(base + path.sep) || path.relative(base, absolute).split(path.sep).join('/') !== relative) return false;
    try { if (fs.realpathSync(absolute) !== absolute || !fs.statSync(absolute).isFile()) return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !prior.has(relative)) return false; }
    if ((i + 1) % 100 === 0) await new Promise<void>(resolve => setImmediate(resolve));
  }
  return true;
}

/** Skip a full source plan only if even the complete reported scope cannot
 * satisfy either enabled rule. The caller verifies source paths and policy.
 * Old file count is a lower bound on max(old, target), including additions. */
export function canSkipScopedAdaptivePlan(
  scope: { pathsCount: number; affectedOldNodes: number; totalOldNodes: number; totalOldFiles: number },
  eligibility: AdaptiveEligibility = {},
): boolean {
  if (eligibility.configurationChanged || eligibility.upgradeRequired || eligibility.blockedReason) return false;
  const { pathsCount, affectedOldNodes, totalOldNodes, totalOldFiles } = scope;
  if (![pathsCount, affectedOldNodes, totalOldNodes, totalOldFiles].every(value => Number.isSafeInteger(value) && value >= 0) ||
      affectedOldNodes > totalOldNodes) return false;
  if (pathsCount === 0 || eligibility.enabled === false) return true;
  const policy = fallbackPolicy(eligibility.fallback);
  const possibleFileScale = eligibility.rules?.fileScale !== false && pathsCount >= policy.minChangedFiles &&
    (totalOldFiles === 0 || pathsCount / totalOldFiles >= policy.minChangedFraction);
  const possibleOldNodeScale = eligibility.rules?.oldNodeScale !== false && affectedOldNodes >= policy.minAffectedOldNodes &&
    totalOldNodes > 0 && affectedOldNodes / totalOldNodes >= policy.minAffectedOldNodeFraction;
  return !possibleFileScale && !possibleOldNodeScale;
}
