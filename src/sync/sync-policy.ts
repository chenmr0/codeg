import fs from 'node:fs';
import * as path from 'node:path';
import { logWarn } from '../errors';
import { DEFAULT_ADAPTIVE_FALLBACK, type AdaptiveFallbackPolicy, type AdaptiveRuleSelection } from './adaptive-plan';

export const SYNC_POLICY_FILE = '.codegraphrc.json';
export const MAX_SYNC_POLICY_BYTES = 64 * 1024;
export const resolvedSyncPolicy: unique symbol = Symbol('resolvedSyncPolicy');

export interface ResolvedSyncPolicy {
  readonly enabled: boolean;
  readonly thresholds: Readonly<AdaptiveFallbackPolicy>;
  readonly rules: Readonly<{ fileScale: boolean; oldNodeScale: boolean }>;
  readonly source: 'default' | 'project' | 'sdk';
  readonly disabledReason?: string;
}

export interface SyncPolicyOptions {
  adaptive?: boolean;
  adaptiveFallback?: Partial<AdaptiveFallbackPolicy>;
  adaptiveRules?: AdaptiveRuleSelection;
  [resolvedSyncPolicy]?: ResolvedSyncPolicy;
}

const fileThresholds = ['minChangedFiles', 'minChangedFraction', 'minWorkFraction'] as const;
const nodeThresholds = ['minAffectedOldNodes', 'minAffectedOldNodeFraction'] as const;
const thresholdNames = [...fileThresholds, ...nodeThresholds];

function object(value: unknown, location: string, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${location} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Unknown field ${location}.${key}`);
  }
  return value as Record<string, unknown>;
}

function boolean(value: unknown, location: string): boolean | undefined {
  if (value !== undefined && typeof value !== 'boolean') throw new Error(`${location} must be a boolean`);
  return value as boolean | undefined;
}

function threshold(value: unknown, key: keyof AdaptiveFallbackPolicy, location: string): number {
  const count = key === 'minChangedFiles' || key === 'minAffectedOldNodes';
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 ||
      (count ? !Number.isSafeInteger(value) : value > 1)) {
    throw new Error(`${location} must be ${count ? 'a positive safe integer' : 'a number in (0, 1]'}`);
  }
  return value;
}

/** One descriptor and a bounded buffer also bound a file that grows during the read. */
function readProjectPolicy(filename: string): unknown | undefined {
  let fd: number;
  try { fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('Policy must be a regular file');
    if (stat.size > MAX_SYNC_POLICY_BYTES) throw new Error(`Policy exceeds ${MAX_SYNC_POLICY_BYTES} bytes`);
    const buffer = Buffer.allocUnsafe(MAX_SYNC_POLICY_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const read = fs.readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (read === 0) break;
      bytes += read;
    }
    if (bytes > MAX_SYNC_POLICY_BYTES) throw new Error(`Policy exceeds ${MAX_SYNC_POLICY_BYTES} bytes`);
    return JSON.parse(buffer.subarray(0, bytes).toString('utf8')) as unknown;
  } finally { fs.closeSync(fd); }
}

function freezePolicy(policy: ResolvedSyncPolicy): ResolvedSyncPolicy {
  return Object.freeze({ ...policy, thresholds: Object.freeze({ ...policy.thresholds }), rules: Object.freeze({ ...policy.rules }) });
}

/** Resolve once at the public sync boundary. Forward the symbol-keyed result
 * to nested sync calls, and the plain policy explicitly over worker IPC. */
export function resolveSyncPolicy(root: string, options: SyncPolicyOptions = {}): ResolvedSyncPolicy {
  const inherited = options[resolvedSyncPolicy];
  const forcedReason = process.env.CODEGRAPH_ADAPTIVE_SYNC === '0' ? 'disabled-by-environment'
    : options.adaptive === false ? 'disabled-by-option' : undefined;
  if (inherited) {
    return forcedReason && inherited.enabled
      ? freezePolicy({ ...inherited, enabled: false, disabledReason: forcedReason }) : inherited;
  }

  const filename = path.resolve(root, SYNC_POLICY_FILE);
  const thresholds = { ...DEFAULT_ADAPTIVE_FALLBACK };
  const rules = { fileScale: true, oldNodeScale: true };
  let source: ResolvedSyncPolicy['source'] = 'default';
  let enabled = true;
  try {
    const raw = readProjectPolicy(filename);
    if (raw !== undefined) {
      source = 'project';
      const document = object(raw, SYNC_POLICY_FILE, ['sync']);
      const sync = object(document.sync === undefined ? {} : document.sync, 'sync', ['adaptive']);
      const adaptive = object(sync.adaptive === undefined ? {} : sync.adaptive, 'sync.adaptive', ['enabled', 'rules']);
      enabled = boolean(adaptive.enabled, 'sync.adaptive.enabled') ?? true;
      const selection = object(adaptive.rules === undefined ? {} : adaptive.rules, 'sync.adaptive.rules', ['fileScale', 'oldNodeScale']);
      for (const [name, keys] of [['fileScale', fileThresholds], ['oldNodeScale', nodeThresholds]] as const) {
        const location = `sync.adaptive.rules.${name}`;
        const rule = object(selection[name] === undefined ? {} : selection[name], location, ['enabled', ...keys]);
        rules[name] = boolean(rule.enabled, `${location}.enabled`) ?? true;
        for (const key of keys) if (rule[key] !== undefined) thresholds[key] = threshold(rule[key], key, `${location}.${key}`);
      }
    }
  } catch (error) {
    logWarn(`Invalid sync policy in ${filename}: ${error instanceof Error ? error.message : String(error)}. Automatic rebuilding is disabled for this sync.`);
    return freezePolicy({ enabled: false, thresholds, rules, source: 'project', disabledReason: 'invalid-project-config' });
  }

  try {
    if (options.adaptive !== undefined) {
      enabled = boolean(options.adaptive, 'adaptive')!;
      source = 'sdk';
    }
    if (options.adaptiveFallback !== undefined) {
      const values = object(options.adaptiveFallback, 'adaptiveFallback', thresholdNames);
      for (const key of thresholdNames) if (values[key] !== undefined) thresholds[key] = threshold(values[key], key, `adaptiveFallback.${key}`);
      source = 'sdk';
    }
    if (options.adaptiveRules !== undefined) {
      const values = object(options.adaptiveRules, 'adaptiveRules', ['fileScale', 'oldNodeScale']);
      for (const key of ['fileScale', 'oldNodeScale'] as const) rules[key] = boolean(values[key], `adaptiveRules.${key}`) ?? rules[key];
      source = 'sdk';
    }
  } catch (error) {
    logWarn(`Invalid sync options: ${error instanceof Error ? error.message : String(error)}. Automatic rebuilding is disabled for this sync.`);
    return freezePolicy({ enabled: false, thresholds, rules, source: 'sdk', disabledReason: 'invalid-sdk-options' });
  }
  const disabledReason = forcedReason ?? (!enabled ? 'disabled-by-project'
    : !rules.fileScale && !rules.oldNodeScale ? 'all-rules-disabled' : undefined);
  return freezePolicy({ enabled: disabledReason === undefined, thresholds, rules, source,
    ...(disabledReason ? { disabledReason } : {}) });
}
