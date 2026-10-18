/**
 * Parse Worker
 *
 * Runs tree-sitter parsing in a separate thread so the main thread
 * stays unblocked and the UI animation renders smoothly.
 */

try {
  // Repeated pool-worker startup benefits from Node's compile cache. Older
  // supported Node versions simply do not expose this API.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  (require('node:module') as { enableCompileCache?: () => void }).enableCompileCache?.();
} catch {
  // best-effort
}

import { parentPort } from 'worker_threads';
import { performance } from 'node:perf_hooks';
import { extractFromSource } from './tree-sitter';
import { detectLanguage, loadGrammarsForLanguages, resetParser } from './grammars';
import type { Language, ExtractionResult } from '../types';
import type { CppMacroDefinition } from './declaration-macros';
import { isWasmRuntimeCorruptionError } from './wasm-errors';

// Emscripten prints `Aborted()` (and a follow-up RuntimeError diag
// line) directly to stderr when WASM aborts — before the JS catch
// runs. Worker stderr is inherited by the parent, so each crash leaks
// a noise line to the user's terminal even though the JS layer
// already handles the failure cleanly. Filter these specific lines
// out at the source. Real diagnostic output (anything we log
// ourselves) goes through console.* / parentPort and is unaffected.
//
// Caveats deliberately accepted:
//   - Per-call match: each `write()` call is matched in isolation.
//     If Emscripten ever splits `Aborted(` across two write()s (it
//     doesn't today — synchronous abort prints the whole line at
//     once via libc puts) the first fragment would leak. Buffering
//     across calls would add complexity for a hypothetical case.
//   - Substring exactness: the prefix `Aborted(` is the literal
//     Emscripten signature. Any user code that legitimately writes
//     a stderr line starting with that prefix would also be filtered;
//     in practice no real diagnostic does.
{
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void
  ): boolean => {
    const s = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
    if (
      s.startsWith('Aborted(') ||
      s.includes('Build with -sASSERTIONS for more info')
    ) {
      // Honour the Writable stream contract: callbacks must always
      // fire even when the write is suppressed, or upstream code
      // waiting on the drain signal would hang. Both overload forms
      // are handled (`(chunk, cb)` and `(chunk, encoding, cb)`).
      if (typeof encoding === 'function') encoding();
      else if (cb) cb();
      return true;
    }
    return realWrite(chunk as never, encoding as never, cb as never);
  }) as typeof process.stderr.write;
}

const PARSER_RESET_INTERVAL = 5000;
const parseCounts = new Map<Language, number>();

// Project-wide macro names sent once by the orchestrator (avoids serializing
// 10k+ names with every parse message). Persists for the worker's lifetime;
// on recycle/crash, ensureWorker() re-sends it.
let globalMacroNames: Set<string> | undefined = undefined;
// Bodyless object-like macro names (`#define NAME` with empty body) collected
// by the orchestrator's pre-scan. Passed to extractFromSource so the C/C++
// preParse transform can blank them. See c-cpp.ts preprocessStatementMacros.
let globalBodylessMacroNames: Set<string> | undefined = undefined;
let globalMacroDefinitions: CppMacroDefinition[] | undefined = undefined;

parentPort!.on('message', async (msg: { type: string; id?: number; filePath?: string; content?: string; language?: Language; languages?: Language[]; frameworkNames?: string[]; macroNames?: string[]; bodylessMacroNames?: string[]; macroDefinitions?: CppMacroDefinition[]; grammarBuffers?: Record<string, Uint8Array>; skipDeclarationMacroRecovery?: boolean }) => {
  if (msg.type === 'load-grammars') {
    // grammarBuffers (when the orchestrator pre-read them) let a spawn/respawn
    // load grammars from memory instead of re-reading from disk — on slow
    // storage each respawn's grammar re-read otherwise amplifies the very I/O
    // contention that caused the respawn (#1231). Missing languages fall back
    // to the worker's own disk read inside loadGrammarsForLanguages.
    await loadGrammarsForLanguages(msg.languages!, msg.grammarBuffers);
    // The fork's C/C++ macro pre-scan is part of parsing semantics. Initialize
    // it on every pool worker before that worker is declared ready.
    globalMacroNames = new Set(msg.macroNames ?? []);
    globalBodylessMacroNames = new Set(msg.bodylessMacroNames ?? []);
    globalMacroDefinitions = msg.macroDefinitions ?? [];
    parentPort!.postMessage({ type: 'grammars-loaded' });
  } else if (msg.type === 'set-global-macros') {
    globalMacroNames = new Set(msg.macroNames);
    globalBodylessMacroNames = new Set(msg.bodylessMacroNames);
    globalMacroDefinitions = msg.macroDefinitions ?? [];
    parentPort!.postMessage({ type: 'global-macros-set' });
  } else if (msg.type === 'parse') {
    const { id, filePath, content, frameworkNames } = msg;
    // The worker's own clock for the parse — immune to main-thread stalls
    // (sync SQLite store on slow disks) that make the main-thread timer fire
    // before an already-delivered result is processed. Surfaced as `parseMs`
    // so the orchestrator can tell a real timeout from a stalled main thread
    // and accept the late result instead of false-rejecting (#1231).
    const t0 = performance.now();
    try {
      const language = msg.language ?? detectLanguage(filePath!, content);
      const result: ExtractionResult = extractFromSource(
        filePath!,
        content!,
        language,
        frameworkNames,
        globalMacroNames,
        globalBodylessMacroNames,
        msg.skipDeclarationMacroRecovery ? undefined : globalMacroDefinitions,
      );

      // Periodic parser reset to reclaim WASM heap memory
      const count = (parseCounts.get(language) ?? 0) + 1;
      parseCounts.set(language, count);
      if (count % PARSER_RESET_INTERVAL === 0) {
        resetParser(language);
      }

      parentPort!.postMessage({ type: 'parse-result', id, result, parseMs: performance.now() - t0 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // WASM runtime corruption leaves the module unsafe for all subsequent
      // parses (cascading failures). Crash the worker so the main thread
      // spawns a fresh one with a clean heap and retries this file.
      if (isWasmRuntimeCorruptionError(message)) {
        process.exit(1);
      }

      parentPort!.postMessage({
        type: 'parse-result',
        id,
        parseMs: performance.now() - t0,
        result: {
          nodes: [],
          edges: [],
          unresolvedReferences: [],
          errors: [{ message: `Parse worker error: ${message}`, filePath: filePath!, severity: 'error', code: 'parse_error' }],
          durationMs: 0,
        } satisfies ExtractionResult,
      });
    }
  } else if (msg.type === 'shutdown') {
    parentPort!.postMessage({ type: 'shutdown-ack' });
  }
});
