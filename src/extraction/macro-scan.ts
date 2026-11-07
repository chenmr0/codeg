/** Stateless project macro context. The TS scanner remains the parity oracle. */
import * as fsp from 'fs/promises';
import { performance } from 'perf_hooks';
import { createHash } from 'node:crypto';
import { validatePathWithinRoot } from '../utils';
import { EXTENSION_MAP } from './grammars';
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
export interface ParserMacroContext {
  names: Set<string>; bodyless: Set<string>; definitions: CppMacroDefinition[];
}
export interface MacroContext extends ParserMacroContext {
  metrics: MacroScanMetrics;
}

export function isMacroSource(file: string): boolean {
  const language = EXTENSION_MAP[file.slice(file.lastIndexOf('.')).toLowerCase()];
  return language === 'c' || language === 'cpp' || language === 'objc';
}

/** The parser looks up macro names and definitions independently of their insertion order. */
export function macroContextFingerprint({ names, bodyless, definitions }: ParserMacroContext): string {
  const hash = createHash('sha256');
  // Macro names are ASCII identifiers. JSON escapes line breaks in definitions,
  // so a record separator cannot collide with source text.
  for (const name of [...names].sort()) hash.update('name:' + name + '\n');
  for (const name of [...bodyless].sort()) hash.update('bodyless:' + name + '\n');
  for (const definition of [...definitions].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    hash.update(JSON.stringify([definition.name, definition.parameters, definition.variadicParameter ?? null, definition.replacement]));
    hash.update('\n');
  }
  return hash.digest('hex');
}

export class MacroContextBuilder {
  private names = new Set<string>();
  private bodyless = new Set<string>();
  private definitions: CppMacroDefinition[] = [];

  add(part: MacroContribution): void {
    for (const name of part.names) this.names.add(name);
    for (const name of part.bodyless) this.bodyless.add(name);
    for (const definition of part.definitions) this.definitions.push(definition);
  }

  finish(): ParserMacroContext {
    return { names: this.names, bodyless: this.bodyless, definitions: selectUnambiguousCppMacroDefinitions(this.definitions) };
  }
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
    bytes: 0, fallbackFiles: 0, readWallMs: 0, namesMs: 0, bodylessMs: 0,
    definitionsMs: 0, mergeMs: 0, nativeWallMs: 0, nativeReadSumMs: 0, nativeScanSumMs: 0, totalMs: 0 };
}

/** No persistent cache: every build observes files again, including failed reads. */
export async function buildMacroContext(root: string, files: string[]): Promise<MacroContext> {
  const started = performance.now();
  let metrics = emptyMetrics(files.length);
  let builder = new MacroContextBuilder();
  const add = (part: MacroContribution): void => {
    const t = performance.now();
    builder.add(part);
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
      builder = new MacroContextBuilder();
      await baseline();
    }
  } else await baseline();
  const mergeStarted = performance.now();
  const context = builder.finish();
  metrics.mergeMs += performance.now() - mergeStarted;
  metrics.totalMs = performance.now() - started;
  return { ...context, metrics };
}

export function formatMacroScanMetrics(m: MacroScanMetrics): string {
  return Object.entries(m).map(([key, value]) => `${key}=${typeof value === 'number' ? Math.round(value) : value}${key.endsWith('Ms') ? 'ms' : ''}`).join(' ');
}
