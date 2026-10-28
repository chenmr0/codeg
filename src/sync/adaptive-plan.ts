/** Read-only planning and bounded, local empirical cost estimates for sync.
 * Estimates are heuristics, not timing guarantees or statistical confidence bounds.
 * No profile from a different machine, extraction policy or project is reused.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import { scanDirectoryAsync, hashContent } from '../extraction';
import { EXTRACTION_VERSION } from '../extraction/extraction-version';
import { getLanguageScopeKey } from '../extraction/language-scope';
import { getSupportedLanguages, resolveWasmPath, type GrammarLanguage } from '../extraction/grammars';
import { rustScanBinaryPath, automaticRustScanStatus } from '../extraction/rust-scan';
import { rustMacroBinaryPath, automaticRustMacroStatus } from '../extraction/rust-macros';
import { getCodeGraphDir } from '../directory';
import type { FileRecord } from '../types';

const HISTORY_VERSION = 1;
const MAX_SAMPLES = 24;
const HISTORY_FILE = 'adaptive-cost-history.json';
const digest = (value: unknown): string => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export type AdaptiveShape = 'modified-only' | 'added-only' | 'removed-only' | 'mixed';
export interface AdaptiveInventoryEntry {
  path: string; contentHash: string; size: number; mtimeMs: number; ctimeMs: number; ino: number;
}
export interface AdaptiveSnapshot {
  files: AdaptiveInventoryEntry[];
  configFingerprint: string;
  contentFingerprint: string;
  /** Retain former source ancestors when checking removals. */
  configSourcePaths: string[];
}
export interface AdaptivePlan {
  snapshot: AdaptiveSnapshot;
  added: string[]; modified: string[]; removed: string[];
  changedFiles: number; affectedOldNodes: number; changedBytes: number;
  totalFiles: number; totalBytes: number; totalNodes: number;
  shape: AdaptiveShape; planningMs: number;
  runtimeKey: string;
}
export interface AdaptiveCostSample {
  kind: 'full' | 'incremental';
  runtimeKey: string; configFingerprint: string;
  totalFiles: number; totalBytes: number; totalNodes: number;
  durationMs: number;
  changedFiles: number; affectedOldNodes: number; changedBytes: number;
  addedFiles: number; modifiedFiles: number; removedFiles: number;
  shape: AdaptiveShape;
  recordedAt: number;
}
export interface AdaptiveCostHistory { version: 1; samples: AdaptiveCostSample[] }
export interface AdaptiveDecision {
  strategy: 'incremental' | 'rebuild';
  reason: string;
  estimatedIncrementalMs?: number; estimatedRebuildMs?: number;
}
export interface AdaptiveEligibility {
  /** All blockers are conservative: legacy, recovery, custom data, unsupported backend, etc. */
  blockedReason?: string;
  configFingerprint?: string;
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

/** Include controls in every source ancestor, including nested gitignore files. */
export function adaptiveConfigFingerprint(root: string, files: ReadonlyArray<{ path: string }>): string {
  const rootControls = ['.gitignore', '.codegraphignore', '.git/info/exclude', 'compile_commands.json',
    'compile_flags.txt', 'tsconfig.json', 'jsconfig.json', 'package.json', 'CMakeLists.txt'];
  const controls = new Set(rootControls);
  for (const file of files) {
    let dir = path.posix.dirname(file.path.replace(/\\/g, '/'));
    while (dir !== '.') {
      controls.add(`${dir}/.gitignore`);
      controls.add(`${dir}/.codegraphignore`);
      const next = path.posix.dirname(dir);
      if (next === dir) throw new Error('Invalid source path in adaptive planner');
      dir = next;
    }
  }
  return digest([getLanguageScopeKey(), [...controls].sort().map(relative => {
    const absolute = path.resolve(root, relative);
    if (!absolute.startsWith(path.resolve(root) + path.sep)) throw new Error('Adaptive control path escapes root');
    try { return [relative, crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')]; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return rootControls.includes(relative) ? [relative, null] : null;
      throw error;
    }
  }).filter(value => value !== null)]);
}
function shape(added: number, modified: number, removed: number): AdaptiveShape {
  if (added && !modified && !removed) return 'added-only';
  if (removed && !added && !modified) return 'removed-only';
  if (modified && !added && !removed) return 'modified-only';
  return 'mixed';
}

/** The ordinary plan uses the same size/mtime shortcut as sync. Publication rehashes all source. */
export async function createAdaptivePlan(root: string, tracked: ReadonlyArray<FileRecord>,
  options: { runtimeKey: string; fullHash?: boolean; configSourcePaths?: string[] } ): Promise<AdaptivePlan> {
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
    const before = fs.lstatSync(absolute);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error(`Unsupported adaptive source: ${relative}`);
    // A directory symlink can otherwise hide an external or alias source.
    if (fs.realpathSync(absolute) !== absolute) throw new Error(`Symlink source is not eligible: ${relative}`);
    const prior = old.get(relative);
    let contentHash: string;
    if (!options.fullHash && prior && before.size === prior.size &&
        Math.floor(before.mtimeMs) === Math.floor(prior.modifiedAt)) contentHash = prior.contentHash;
    else contentHash = hashContent(fs.readFileSync(absolute, 'utf8'));
    const after = fs.statSync(absolute);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.ino !== after.ino) {
      throw new Error(`Source changed during adaptive planning: ${relative}`);
    }
    files.push({ path: relative, contentHash, size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, ino: after.ino });
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
  const configSourcePaths = [...new Set([...tracked.map(file => file.path), ...files.map(file => file.path), ...(options.configSourcePaths ?? [])])].sort();
  const configFingerprint = adaptiveConfigFingerprint(root, configSourcePaths.map(path => ({ path })));
  const snapshot = { files, configFingerprint, configSourcePaths,
    contentFingerprint: digest([configFingerprint, files.map(file => [file.path, file.contentHash])]) };
  return { snapshot, added, modified, removed, changedFiles: added.length + modified.length + removed.length,
    affectedOldNodes, changedBytes, totalFiles: files.length, totalBytes: files.reduce((n, file) => n + file.size, 0),
    totalNodes: tracked.reduce((n, file) => n + file.nodeCount, 0), shape: shape(added.length, modified.length, removed.length),
    planningMs: performance.now() - started, runtimeKey: options.runtimeKey };
}

/** Finite validation catches observed edits; it is not an immutable filesystem snapshot. */
export async function validateAdaptiveSnapshot(root: string, snapshot: AdaptiveSnapshot): Promise<boolean> {
  const tracked: FileRecord[] = snapshot.files.map(file => ({ path: file.path, contentHash: file.contentHash,
    size: file.size, modifiedAt: file.mtimeMs, indexedAt: 0, nodeCount: 0, language: 'unknown' }));
  const after = await createAdaptivePlan(root, tracked, { runtimeKey: '', fullHash: true, configSourcePaths: snapshot.configSourcePaths });
  return after.snapshot.contentFingerprint === snapshot.contentFingerprint;
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function validSample(value: unknown): value is AdaptiveCostSample {
  if (!value || typeof value !== 'object') return false;
  const sample = value as AdaptiveCostSample;
  return ['full', 'incremental'].includes(sample.kind) && typeof sample.runtimeKey === 'string' &&
    typeof sample.configFingerprint === 'string' && ['modified-only', 'added-only', 'removed-only', 'mixed'].includes(sample.shape) &&
    [sample.totalFiles, sample.totalBytes, sample.totalNodes, sample.durationMs, sample.changedFiles,
      sample.affectedOldNodes, sample.changedBytes, sample.addedFiles, sample.modifiedFiles, sample.removedFiles, sample.recordedAt].every(finite) && sample.durationMs > 0;
}
export function readAdaptiveHistory(root: string): AdaptiveCostHistory {
  try {
    const filename = path.join(getCodeGraphDir(root), HISTORY_FILE);
    if (fs.statSync(filename).size > 256 * 1024) return { version: HISTORY_VERSION, samples: [] };
    const history = JSON.parse(fs.readFileSync(filename, 'utf8')) as AdaptiveCostHistory;
    if (history.version !== HISTORY_VERSION || !Array.isArray(history.samples) || !history.samples.every(validSample)) {
      return { version: HISTORY_VERSION, samples: [] };
    }
    return { version: HISTORY_VERSION, samples: history.samples.slice(-MAX_SAMPLES) };
  } catch { return { version: HISTORY_VERSION, samples: [] }; }
}
/** Caller must hold the project writer lock; this file is a performance hint, never correctness authority. */
export function recordAdaptiveSample(root: string, sample: Omit<AdaptiveCostSample, 'recordedAt'>,
  complete: boolean): void {
  if (!complete) return;
  const recorded = { ...sample, recordedAt: Date.now() };
  if (!validSample(recorded)) return;
  const history = readAdaptiveHistory(root);
  // Keep some full observations even after a long run of incremental syncs.
  const matching = history.samples.filter(previous => previous.runtimeKey === recorded.runtimeKey &&
    previous.configFingerprint === recorded.configFingerprint);
  const full = matching.filter(previous => previous.kind === 'full');
  const incremental = matching.filter(previous => previous.kind === 'incremental');
  (recorded.kind === 'full' ? full : incremental).push(recorded);
  history.samples = [...full.slice(-4), ...incremental.slice(-(MAX_SAMPLES - 4))];
  const target = path.join(getCodeGraphDir(root), HISTORY_FILE);
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(history), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, target);
  } finally { try { fs.unlinkSync(temporary); } catch { /* rename already consumed it */ } }
}
export function hasAdaptiveCalibration(history: AdaptiveCostHistory, runtimeKey: string): boolean {
  const matching = history.samples.filter(sample => sample.runtimeKey === runtimeKey);
  return matching.some(sample => sample.kind === 'full') && matching.filter(sample => sample.kind === 'incremental' && sample.changedFiles > 0).length >= 3;
}

/** Cheap negative-only gate. Never authorizes rebuilding or supplies cached scan
 * data to ordinary sync: that path must rescan after its recovery/callbacks.
 * The minimum across ALL runtime-matched samples cannot exceed the minimum
 * of the compatible subset used by chooseAdaptiveStrategy. Stat mismatches
 * upper-bound changes discoverable by that planner's same stat shortcut
 * (not size/mtime-preserving edits); errors make this gate inconclusive.
 */
export async function adaptiveChangeGate(root: string, tracked: ReadonlyArray<FileRecord>,
  history: AdaptiveCostHistory, runtimeKey: string): Promise<{ belowRange: boolean; candidates: number; minimum: number }> {
  const samples = history.samples.filter(sample => validSample(sample) && sample.kind === 'incremental' &&
    sample.runtimeKey === runtimeKey && sample.changedFiles > 0);
  const minimum = samples.length ? Math.min(...samples.map(sample => sample.changedFiles)) : 0;
  if (!minimum) return { belowRange: false, candidates: 0, minimum };
  // If only modified-only has three observations, every other shape is
  // ineligible even before configuration/size filtering. A tracked-file stat
  // upper bound below its minimum therefore rules out EVERY eligible rebuild:
  // newly added/ignored/removed files could change the shape, but cannot make
  // an uncalibrated shape eligible. Do not apply this shortcut once another
  // shape has three observations (even incompatible ones: fail conservatively).
  const modifications = samples.filter(sample => sample.shape === 'modified-only');
  if (modifications.length >= 3 && (['added-only', 'removed-only', 'mixed'] as const)
    .every(shape => samples.filter(sample => sample.shape === shape).length < 3)) {
    const modifiedMinimum = Math.min(...modifications.map(sample => sample.changedFiles));
    let candidates = 0;
    for (let i = 0; i < tracked.length; i++) {
      const prior = tracked[i]!;
      const absolute = path.resolve(root, prior.path);
      if (!absolute.startsWith(path.resolve(root) + path.sep)) throw new Error('Tracked source path escapes root');
      const stat = fs.statSync(absolute);
      if (stat.size !== prior.size || Math.floor(stat.mtimeMs) !== Math.floor(prior.modifiedAt)) candidates++;
      if (candidates >= modifiedMinimum) return { belowRange: false, candidates, minimum: modifiedMinimum };
      if ((i + 1) % 100 === 0) await new Promise<void>(resolve => setImmediate(resolve));
    }
    if (candidates < modifiedMinimum) return { belowRange: true, candidates, minimum: modifiedMinimum };
  }
  const old = new Map(tracked.map(file => [file.path, file]));
  const visible = await scanDirectoryAsync(root);
  let candidates = 0;
  for (let i = 0; i < visible.length; i++) {
    const relative = visible[i]!;
    const absolute = path.resolve(root, relative);
    if (!absolute.startsWith(path.resolve(root) + path.sep)) throw new Error('Adaptive source path escapes root');
    const prior = old.get(relative);
    const stat = fs.statSync(absolute); // Any access/race error aborts the gate, never claims unchanged.
    if (!prior || stat.size !== prior.size || Math.floor(stat.mtimeMs) !== Math.floor(prior.modifiedAt)) candidates++;
    old.delete(relative);
    if (candidates >= minimum) return { belowRange: false, candidates, minimum };
    if ((i + 1) % 100 === 0) await new Promise<void>(resolve => setImmediate(resolve));
  }
  candidates += old.size; // Includes removed or newly ignored tracked files.
  return { belowRange: candidates < minimum, candidates, minimum };
}

export function chooseAdaptiveStrategy(plan: AdaptivePlan, history: AdaptiveCostHistory,
  eligibility: AdaptiveEligibility = {}): AdaptiveDecision {
  const incremental = (reason: string): AdaptiveDecision => ({ strategy: 'incremental', reason });
  if (eligibility.blockedReason) return incremental(eligibility.blockedReason);
  if (eligibility.configFingerprint && eligibility.configFingerprint !== plan.snapshot.configFingerprint) return incremental('configuration-changed');
  if (plan.changedFiles === 0) return incremental('no-content-changes');
  if (!plan.totalFiles || !plan.totalBytes) return incremental('empty-target');
  const samples = history.samples.filter(sample => validSample(sample) && sample.runtimeKey === plan.runtimeKey &&
    sample.configFingerprint === plan.snapshot.configFingerprint);
  const within = (value: number, reference: number): boolean => reference > 0 && value >= reference * 0.8 && value <= reference * 1.2;
  const full = samples.filter(sample => sample.kind === 'full' && within(plan.totalBytes, sample.totalBytes) && within(plan.totalFiles, sample.totalFiles));
  // A branch switch can mix adds/removes/modifications. Only compare with
  // observed mixes having a similar composition, not arbitrary changed-file %.
  const matchingMix = (sample: AdaptiveCostSample): boolean => plan.shape !== 'mixed' ||
    [[plan.added.length, sample.addedFiles], [plan.modified.length, sample.modifiedFiles],
      [plan.removed.length, sample.removedFiles]].every(([current, prior]) =>
      Math.abs(current! / plan.changedFiles - prior! / sample.changedFiles) <= 0.05);
  const measured = samples.filter(sample => sample.kind === 'incremental' && sample.shape === plan.shape &&
    within(plan.totalFiles, sample.totalFiles) && within(plan.totalBytes, sample.totalBytes) && sample.changedFiles > 0 && matchingMix(sample));
  if (!full.length || measured.length < 3) return incremental('insufficient-local-calibration');
  const work = (entry: Pick<AdaptiveCostSample, 'affectedOldNodes' | 'changedBytes'>): number =>
    plan.shape === 'added-only' ? entry.changedBytes : entry.affectedOldNodes;
  const useful = measured.filter(sample => work(sample) > 0);
  const units = work(plan);
  if (useful.length < 3 || units === 0) return incremental('insufficient-measured-work');
  const maxUnits = Math.max(...useful.map(work)), minUnits = Math.min(...useful.map(work));
  const maxFiles = Math.max(...useful.map(sample => sample.changedFiles));
  const minFiles = Math.min(...useful.map(sample => sample.changedFiles));
  if (units < minUnits || units > maxUnits * 2 || plan.changedFiles < minFiles || plan.changedFiles > maxFiles * 2) {
    return incremental('outside-calibrated-work-range');
  }
  // These modest margins combine with the separate 20%/10s savings gate.
  // They are engineering guardrails, not measured confidence intervals.
  const estimatedIncrementalMs = Math.min(...useful.map(sample => sample.durationMs / work(sample))) * units * 0.9;
  const estimatedRebuildMs = Math.max(...full.map(sample => sample.durationMs * Math.max(1, plan.totalBytes / sample.totalBytes))) * 1.15;
  const saving = estimatedIncrementalMs - estimatedRebuildMs;
  const beneficial = saving >= 10_000 && estimatedRebuildMs <= estimatedIncrementalMs * 0.8;
  return { strategy: beneficial ? 'rebuild' : 'incremental', reason: beneficial ? 'local-cost-estimate-favors-rebuild' : 'insufficient-estimated-savings',
    estimatedIncrementalMs, estimatedRebuildMs };
}

/** Build an observation from ordinary operations without an extra source scan. */
export function adaptiveSampleFromFiles(input: {
  kind: 'full' | 'incremental'; runtimeKey: string; configFingerprint: string;
  before: ReadonlyArray<FileRecord>; after: ReadonlyArray<FileRecord>;
  /** Accepted for callers' convenience; reindexed unchanged importers are NOT primary work units. */
  changedFilePaths?: ReadonlyArray<string>; durationMs: number;
}): Omit<AdaptiveCostSample, 'recordedAt'> {
  const before = new Map(input.before.map(file => [file.path, file]));
  const after = new Map(input.after.map(file => [file.path, file]));
  let added = 0, modified = 0, removed = 0, affectedOldNodes = 0, changedBytes = 0;
  for (const file of input.after) {
    const old = before.get(file.path);
    if (!old) { added++; changedBytes += file.size; }
    else if (old.contentHash !== file.contentHash) {
      modified++; affectedOldNodes += old.nodeCount; changedBytes += file.size;
    }
  }
  for (const file of input.before) if (!after.has(file.path)) { removed++; affectedOldNodes += file.nodeCount; }
  return { kind: input.kind, runtimeKey: input.runtimeKey, configFingerprint: input.configFingerprint,
    totalFiles: input.after.length, totalBytes: input.after.reduce((n, file) => n + file.size, 0),
    totalNodes: input.before.reduce((n, file) => n + file.nodeCount, 0), durationMs: input.durationMs,
    changedFiles: added + modified + removed, affectedOldNodes, changedBytes,
    addedFiles: added, modifiedFiles: modified, removedFiles: removed, shape: shape(added, modified, removed) };
}
