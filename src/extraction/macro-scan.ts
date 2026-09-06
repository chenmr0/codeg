/** Stateless project macro context. The TS scanner remains the parity oracle. */
import * as fsp from 'fs/promises';
import { performance } from 'perf_hooks';
import { validatePathWithinRoot } from '../utils';
import { scanCppMacroDefinitions, selectUnambiguousCppMacroDefinitions, type CppMacroDefinition } from './declaration-macros';
import { automaticRustMacroStatus, rustMacroMode, streamRustMacros } from './rust-macros';

export interface MacroContribution {
  names: string[];
  bodyless: string[];
  definitions: CppMacroDefinition[];
}
export interface MacroScanMetrics {
  mode: string; reason: string; files: number; readFiles: number; readErrors: number;
  bytes: number; fallbackFiles: number; readWallMs: number; namesMs: number;
  bodylessMs: number; definitionsMs: number; mergeMs: number;
  nativeWallMs: number; nativeReadSumMs: number; nativeScanSumMs: number; totalMs: number;
}
export interface MacroContext {
  names: Set<string>; bodyless: Set<string>; definitions: CppMacroDefinition[];
  metrics: MacroScanMetrics;
}

export function scanMacroContribution(source: string, metrics?: MacroScanMetrics): MacroContribution {
  // Preserve the original regexes, including their whitespace/matching quirks.
  // A performance port must not silently change macro recovery semantics.
  const names: string[] = [], bodyless: string[] = [];
  let started = performance.now();
  const nameRegex = /^\s*#\s*define\s+([A-Za-z_]\w*)/gm;
  for (let m; (m = nameRegex.exec(source)) !== null;) names.push(m[1]!);
  if (metrics) metrics.namesMs += performance.now() - started;
  started = performance.now();
  const bodylessRegex = /^\s*#\s*define\s+([A-Za-z_]\w*)(?!\s*\()(?:[ \t]*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/[ \t]*)?)?[ \t]*$/gm;
  for (let m; (m = bodylessRegex.exec(source)) !== null;) bodyless.push(m[1]!);
  if (metrics) metrics.bodylessMs += performance.now() - started;
  started = performance.now();
  const definitions = scanCppMacroDefinitions(source).map(({ name, parameters, variadicParameter, replacement }) =>
    ({ name, parameters, ...(variadicParameter === undefined ? {} : { variadicParameter }), replacement }));
  if (metrics) metrics.definitionsMs += performance.now() - started;
  return { names, bodyless, definitions };
}

function emptyMetrics(files: number): MacroScanMetrics {
  return { mode: 'ts', reason: 'disabled', files, readFiles: 0, readErrors: 0,
    bytes: 0, fallbackFiles: 0, readWallMs: 0, namesMs: 0, bodylessMs: 0,
    definitionsMs: 0, mergeMs: 0, nativeWallMs: 0, nativeReadSumMs: 0, nativeScanSumMs: 0, totalMs: 0 };
}

/** No persistent cache: every build observes files again, including failed reads. */
export async function buildMacroContext(root: string, files: string[]): Promise<MacroContext> {
  const started = performance.now();
  let metrics = emptyMetrics(files.length);
  let names = new Set<string>(), bodyless = new Set<string>();
  let definitions: CppMacroDefinition[] = [];
  const add = (part: MacroContribution): void => {
    const t = performance.now();
    for (const name of part.names) names.add(name);
    for (const name of part.bodyless) bodyless.add(name);
    // Avoid argument-count limits on generated macro-heavy sources.
    for (const definition of part.definitions) definitions.push(definition);
    metrics.mergeMs += performance.now() - t;
  };
  const read = async (file: string): Promise<string | null> => {
    const full = validatePathWithinRoot(root, file);
    try {
      if (!full) throw new Error('outside-root');
      const bytes = await fsp.readFile(full);
      metrics.readFiles++; metrics.bytes += bytes.length;
      return bytes.toString('utf8');
    } catch { metrics.readErrors++; return null; }
  };
  const baseline = async (): Promise<void> => {
    for (let i = 0; i < files.length; i += 50) {
      const t = performance.now();
      const contents = await Promise.all(files.slice(i, i + 50).map(read));
      metrics.readWallMs += performance.now() - t;
      for (const source of contents) if (source) add(scanMacroContribution(source, metrics));
    }
  };
  const requestedMode = rustMacroMode(files.length);
  let mode: 'off' | 'on' | 'verify' = requestedMode === 'auto' ? 'on' : requestedMode;
  if (requestedMode === 'auto') {
    const status = automaticRustMacroStatus();
    if (!status.ready) { mode = 'off'; metrics.reason = status.reason; }
  }
  if (mode !== 'off' && files.length) {
    const t = performance.now();
    try {
      for await (const row of streamRustMacros(root, files)) {
        metrics.nativeReadSumMs += row.readMs;
        metrics.nativeScanSumMs += row.scanMs;
        if (row.status === 'fallback' || mode === 'verify') {
          const readStarted = performance.now();
          const source = await read(row.path);
          metrics.readWallMs += performance.now() - readStarted;
          const oracle = scanMacroContribution(source ?? '', metrics);
          if (row.status === 'fallback') metrics.fallbackFiles++;
          else if (JSON.stringify(row.contribution) !== JSON.stringify(oracle)) throw new Error('parity-mismatch');
          add(oracle);
        } else {
          metrics.readFiles++; metrics.bytes += row.bytes;
          add(row.contribution!);
        }
      }
      metrics.mode = mode === 'verify' ? 'verify' : 'rust'; metrics.reason = 'none';
      metrics.nativeWallMs = performance.now() - t;
    } catch (error) {
      const nativeWallMs = performance.now() - t;
      const reason = error instanceof Error && /^[a-z-]+$/.test(error.message) ? error.message : 'native-error';
      // Never retain a partial native context after a crash or malformed stream.
      metrics = { ...emptyMetrics(files.length), mode: 'fallback', reason, nativeWallMs };
      names = new Set(); bodyless = new Set(); definitions = [];
      await baseline();
    }
  } else await baseline();
  const mergeStarted = performance.now();
  const selected = selectUnambiguousCppMacroDefinitions(definitions);
  metrics.mergeMs += performance.now() - mergeStarted;
  metrics.totalMs = performance.now() - started;
  return { names, bodyless, definitions: selected, metrics };
}

export function formatMacroScanMetrics(m: MacroScanMetrics): string {
  return Object.entries(m).map(([key, value]) => `${key}=${typeof value === 'number' ? Math.round(value) : value}${key.endsWith('Ms') ? 'ms' : ''}`).join(' ');
}
