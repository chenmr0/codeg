/** Stateless project macro context. The TS scanner remains the parity oracle. */
import * as fsp from 'fs/promises';
import { scanLiteralIncludes, type MacroProjectEvidence } from './macro-visibility';
import { performance } from 'perf_hooks';
import { validatePathWithinRoot } from '../utils';
import { scanCppMacroDefinitions, selectUnambiguousCppMacroDefinitions, type CppMacroDefinition } from './declaration-macros';
import { automaticRustMacroStatus, rustMacroMode, streamRustMacros, type NativeMacroRow } from './rust-macros';

export interface MacroContribution {
  names: string[];
  bodyless: string[];
  definitions: CppMacroDefinition[];
}
export interface MacroScanMetrics {
  mode: string; reason: string; files: number; readFiles: number; readErrors: number;
  bytes: number; provenanceReadFiles: number; provenanceBytes: number; fallbackFiles: number; readWallMs: number; namesMs: number;
  bodylessMs: number; definitionsMs: number; mergeMs: number;
  nativeWallMs: number; nativeReadSumMs: number; nativeScanSumMs: number; totalMs: number;
}
export interface MacroContext {
  names: Set<string>; bodyless: Set<string>; definitions: CppMacroDefinition[];
  metrics: MacroScanMetrics;
  project: MacroProjectEvidence;
}

/**
 * Regex captures and slices can retain the entire source as their V8 parent
 * string. Detach strings that outlive this file before accumulating the global
 * context (also used by native per-file/full fallback and verify mode).
 * UTF-16 preserves every JS code unit, including unpaired surrogates; UTF-8
 * would replace those. slice/concat alone do not guarantee an independent copy.
 */
function detachMacroString(value: string): string {
  return value.length === 0 ? '' : Buffer.from(value, 'utf16le').toString('utf16le');
}

export function scanMacroContribution(source: string, metrics?: MacroScanMetrics): MacroContribution {
  // Preserve the original regexes, including their whitespace/matching quirks.
  // A performance port must not silently change macro recovery semantics.
  const names: string[] = [], bodyless: string[] = [];
  let started = performance.now();
  const nameRegex = /^\s*#\s*define\s+([A-Za-z_]\w*)/gm;
  for (let m; (m = nameRegex.exec(source)) !== null;) names.push(detachMacroString(m[1]!));
  if (metrics) metrics.namesMs += performance.now() - started;
  started = performance.now();
  const bodylessRegex = /^\s*#\s*define\s+([A-Za-z_]\w*)(?!\s*\()(?:[ \t]*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/[ \t]*)?)?[ \t]*$/gm;
  for (let m; (m = bodylessRegex.exec(source)) !== null;) bodyless.push(detachMacroString(m[1]!));
  if (metrics) metrics.bodylessMs += performance.now() - started;
  started = performance.now();
  const definitions = scanCppMacroDefinitions(source).map(({ name, parameters, variadicParameter, replacement }) =>
    ({ name: detachMacroString(name), parameters: parameters?.map(detachMacroString) ?? null,
      ...(variadicParameter === undefined ? {} : { variadicParameter: detachMacroString(variadicParameter) }),
      replacement: detachMacroString(replacement) }));
  if (metrics) metrics.definitionsMs += performance.now() - started;
  return { names, bodyless, definitions };
}

function emptyMetrics(files: number): MacroScanMetrics {
  return { mode: 'ts', reason: 'disabled', files, readFiles: 0, readErrors: 0,
    bytes: 0, provenanceReadFiles: 0, provenanceBytes: 0, fallbackFiles: 0, readWallMs: 0, namesMs: 0, bodylessMs: 0,
    definitionsMs: 0, mergeMs: 0, nativeWallMs: 0, nativeReadSumMs: 0, nativeScanSumMs: 0, totalMs: 0 };
}

/** No persistent cache: every build observes files again, including failed reads. */
export async function buildMacroContext(root: string, files: string[]): Promise<MacroContext> {
  const started = performance.now();
  let metrics = emptyMetrics(files.length);
  let names = new Set<string>(), bodyless = new Set<string>();
  let definitions: CppMacroDefinition[] = [];
  let project: MacroProjectEvidence = Object.create(null);
  const add = (part: MacroContribution, file: string, source: string): void => {
    project[file] = { definitions: part.definitions, includes: scanLiteralIncludes(source).map(item => detachMacroString(item.name)) };
    const t = performance.now();
    for (const name of part.names) names.add(name);
    for (const name of part.bodyless) bodyless.add(name);
    // Avoid argument-count limits on generated macro-heavy sources.
    for (const definition of part.definitions) definitions.push(definition);
    metrics.mergeMs += performance.now() - t;
  };
  const read = async (file: string, provenance = false): Promise<string | null> => {
    const full = validatePathWithinRoot(root, file);
    try {
      if (!full) throw new Error('outside-root');
      const bytes = await fsp.readFile(full);
      metrics.readFiles++; metrics.bytes += bytes.length;
      if (provenance) { metrics.provenanceReadFiles++; metrics.provenanceBytes += bytes.length; }
      return bytes.toString('utf8');
    } catch { metrics.readErrors++; return null; }
  };
  const baseline = async (): Promise<void> => {
    for (let i = 0; i < files.length; i += 50) {
      const t = performance.now();
      const contents = await Promise.all(files.slice(i, i + 50).map(file => read(file)));
      metrics.readWallMs += performance.now() - t;
      for (let j = 0; j < contents.length; j++) {
        const source = contents[j];
        if (source !== null) add(scanMacroContribution(source!, metrics), files[i + j]!, source!);
      }
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
      const rows: NativeMacroRow[] = [];
      for await (const row of streamRustMacros(root, files)) rows.push(row);
      // Bound provenance I/O like the TS scanner. Waiting for each file inside
      // the native stream serializes otherwise independent filesystem reads.
      for (let i = 0; i < rows.length; i += 50) {
        const batch = rows.slice(i, i + 50);
        const readStarted = performance.now();
        const sources = await Promise.all(batch.map(row => read(row.path, row.status === 'ok' && mode !== 'verify')));
        metrics.readWallMs += performance.now() - readStarted;
        for (let j = 0; j < batch.length; j++) {
          const row = batch[j]!, source = sources[j]!;
          metrics.nativeReadSumMs += row.readMs;
          metrics.nativeScanSumMs += row.scanMs;
          if (row.status === 'ok' || row.bytes > 0) { metrics.readFiles++; metrics.bytes += row.bytes; }
          if (row.status === 'fallback' || mode === 'verify') {
            const oracle = scanMacroContribution(source ?? '', metrics);
            if (row.status === 'fallback') metrics.fallbackFiles++;
            else if (JSON.stringify(row.contribution) !== JSON.stringify(oracle)) throw new Error('parity-mismatch');
            add(oracle, row.path, source ?? '');
          } else if (source !== null) add(row.contribution!, row.path, source);
        }
      }
      metrics.mode = mode === 'verify' ? 'verify' : 'rust'; metrics.reason = 'none';
      metrics.nativeWallMs = performance.now() - t;
    } catch (error) {
      const nativeWallMs = performance.now() - t;
      const reason = error instanceof Error && /^[a-z-]+$/.test(error.message) ? error.message : 'native-error';
      // Never retain a partial native context after a crash or malformed stream.
      metrics = { ...emptyMetrics(files.length), mode: 'fallback', reason, nativeWallMs };
      names = new Set(); bodyless = new Set(); definitions = []; project = Object.create(null);
      await baseline();
    }
  } else await baseline();
  const mergeStarted = performance.now();
  const selected = selectUnambiguousCppMacroDefinitions(definitions);
  metrics.mergeMs += performance.now() - mergeStarted;
  metrics.totalMs = performance.now() - started;
  return { names, bodyless, definitions: selected, metrics, project };
}

export function formatMacroScanMetrics(m: MacroScanMetrics): string {
  return Object.entries(m).map(([key, value]) => `${key}=${typeof value === 'number' ? Math.round(value) : value}${key.endsWith('Ms') ? 'ms' : ''}`).join(' ');
}
