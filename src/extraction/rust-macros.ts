/** Opt-in macro scanner transport; independent of the validated directory helper. */
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { TextDecoder } from 'util';
import type { MacroContribution } from './macro-scan';

const MAX_LINE = 32 * 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });
export interface NativeMacroRow {
  protocol: number; path: string; status: 'ok' | 'fallback'; reason: string;
  bytes: number; readMs: number; scanMs: number; contribution?: MacroContribution;
}
export function rustMacroMode(): 'off' | 'on' | 'verify' {
  // Prototype is deliberately independent from CODEGRAPH_RUST_SCAN=auto.
  return process.env.CODEGRAPH_RUST_MACROS === '1' ? 'on'
    : process.env.CODEGRAPH_RUST_MACROS === 'verify' ? 'verify' : 'off';
}
export function rustMacroBinaryPath(): string {
  return process.env.CODEGRAPH_RUST_MACROS_PATH ?? path.join(__dirname, '..', '..', 'dist', 'native-macros',
    `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'codegraph-macros.exe' : 'codegraph-macros');
}
export function decodeNativeMacroRow(raw: unknown, expectedPath: string): NativeMacroRow {
  const row = raw as NativeMacroRow;
  const ident = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z_]\w*$/.test(s);
  if (!row || row.protocol !== 1 || row.path !== expectedPath ||
    !['ok', 'fallback'].includes(row.status) || typeof row.reason !== 'string' || !/^[a-z][a-z0-9-]*$/.test(row.reason) ||
    !Number.isSafeInteger(row.bytes) || row.bytes < 0 ||
    ![row.readMs, row.scanMs].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)) throw new Error('invalid-row');
  if (row.status === 'ok') {
    const c = row.contribution;
    if (!c || !Array.isArray(c.names) || !c.names.every(ident) || !Array.isArray(c.bodyless) ||
      !c.bodyless.every(ident) || !Array.isArray(c.definitions)) throw new Error('invalid-contribution');
    for (const d of c.definitions) {
      if (!d || !ident(d.name) || (d.parameters !== null && (!Array.isArray(d.parameters) || !d.parameters.every(ident))) ||
        (d.variadicParameter !== undefined && !ident(d.variadicParameter)) ||
        typeof d.replacement !== 'string' || d.replacement.length > 64 * 1024 || d.start !== undefined || d.end !== undefined) throw new Error('invalid-definition');
    }
  } else if (row.contribution !== undefined) throw new Error('invalid-fallback');
  return row;
}

/** One process per context; bounded NDJSON records and stdout backpressure. */
export async function* streamRustMacros(root: string, files: string[]): AsyncGenerator<NativeMacroRow> {
  const binary = rustMacroBinaryPath();
  if (!fs.existsSync(binary)) throw new Error('binary-missing');
  const requestedWorkers = Number(process.env.CODEGRAPH_RUST_MACROS_WORKERS);
  const workers = Number.isInteger(requestedWorkers) && requestedWorkers >= 1 && requestedWorkers <= 8 ? requestedWorkers : 4;
  const request = JSON.stringify({ protocol: 1, root: path.resolve(root), paths: files, workers });
  if (Buffer.byteLength(request) > 8 * 1024 * 1024 || files.length > 250_000) throw new Error('request-limit');
  const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let failure: Error | undefined;
  const stop = (reason: string): void => { failure ??= new Error(reason); child.kill(); };
  child.on('error', () => stop('process-failed'));
  child.stdin.on('error', () => stop('input-failed'));
  child.stderr.resume(); // Never log raw source or arbitrary helper output.
  const exited = new Promise<void>(resolve => child.once('close', code => {
    if (code !== 0) failure ??= new Error('process-failed');
    resolve();
  }));
  const configured = Number(process.env.CODEGRAPH_RUST_MACROS_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configured) && configured >= 100 && configured <= 120_000 ? configured : 60_000;
  const timer = setTimeout(() => stop('timeout'), timeoutMs);
  child.stdin.end(request);
  let parts: Buffer[] = [], size = 0, index = 0;
  try {
    for await (const chunk of child.stdout) {
      const bytes = chunk as Buffer;
      let offset = 0;
      while (offset < bytes.length) {
        const newline = bytes.indexOf(10, offset);
        const piece = bytes.subarray(offset, newline < 0 ? bytes.length : newline);
        size += piece.length;
        if (size > MAX_LINE) throw new Error('response-limit');
        parts.push(piece);
        if (newline < 0) break;
        if (index >= files.length) throw new Error('response-limit');
        // Concatenate once per record, not once per pipe chunk (quadratic for
        // large generated macro tables). Decode only after UTF-8 chunks join.
        let line: string;
        try { line = utf8.decode(Buffer.concat(parts, size)); } catch { throw new Error('response-encoding'); }
        parts = []; size = 0; offset = newline + 1;
        let value: unknown;
        try { value = JSON.parse(line); } catch { throw new Error('response-json'); }
        if (failure) throw failure;
        yield decodeNativeMacroRow(value, files[index++]!);
      }
    }
    await exited;
    if (failure) throw failure;
    if (size || index !== files.length) throw new Error('incomplete-stream');
  } finally {
    clearTimeout(timer);
    child.kill();
    await exited;
  }
}
