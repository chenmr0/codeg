/**
 * Grammar Loading and Caching
 *
 * Uses web-tree-sitter (WASM) for universal cross-platform support.
 * Grammars are loaded lazily — only languages actually present in the project
 * are compiled, keeping V8 WASM memory pressure low on large codebases.
 */

import * as path from 'path';
import * as fsp from 'fs/promises';
import { Parser, Language as WasmLanguage } from 'web-tree-sitter';
import { Language } from '../types';
import { getLanguageScope, isLanguageEnabled, type LanguageScope } from './language-scope';

export type GrammarLanguage = Exclude<Language, 'svelte' | 'vue' | 'liquid' | 'razor' | 'yaml' | 'twig' | 'xml' | 'properties' | 'unknown'>;

/**
 * WASM filename map — maps each language to its .wasm grammar file
 * in the tree-sitter-wasms package.
 */
const WASM_GRAMMAR_FILES: Record<GrammarLanguage, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  jsx: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
  rust: 'tree-sitter-rust.wasm',
  java: 'tree-sitter-java.wasm',
  c: 'tree-sitter-c.wasm',
  cpp: 'tree-sitter-cpp.wasm',
  csharp: 'tree-sitter-c_sharp.wasm',
  php: 'tree-sitter-php.wasm',
  ruby: 'tree-sitter-ruby.wasm',
  swift: 'tree-sitter-swift.wasm',
  kotlin: 'tree-sitter-kotlin.wasm',
  dart: 'tree-sitter-dart.wasm',
  pascal: 'tree-sitter-pascal.wasm',
  scala: 'tree-sitter-scala.wasm',
  lua: 'tree-sitter-lua.wasm',
  luau: 'tree-sitter-luau.wasm',
  objc: 'tree-sitter-objc.wasm',
};

/**
 * File extension to Language mapping
 */
export const EXTENSION_MAP: Record<string, Language> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  // ESM/CJS TypeScript module extensions — parsed as TS (no JSX). (#366)
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  // SAP HANA XS Classic server-side JavaScript. (#556)
  '.xsjs': 'javascript',
  '.xsjslib': 'javascript',
  '.jsx': 'jsx',
  '.py': 'python',
  '.pyw': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c',
  '.h': 'c', // Could also be C++, defaulting to C
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hxx': 'cpp',
  // Common C++ header/template implementation extensions. These files contain
  // real declarations and frequently own macros consumed by .cpp/.h files.
  '.hh': 'cpp',
  '.ipp': 'cpp',
  '.inl': 'cpp',
  '.tcc': 'cpp',
  '.cs': 'csharp',
  // ASP.NET Razor / Blazor markup — custom RazorExtractor (links @model/@inject/
  // component tags to their C# types; markup isn't a tree-sitter grammar).
  '.cshtml': 'razor',
  '.razor': 'razor',
  '.php': 'php',
  // Drupal-specific PHP file extensions
  '.module': 'php',
  '.install': 'php',
  '.theme': 'php',
  '.inc': 'php',
  // YAML (used for Drupal routing files; no symbol extraction, file-level tracking only)
  '.yml': 'yaml',
  '.yaml': 'yaml',
  // Twig templates (file-level tracking only, no symbol extraction)
  '.twig': 'twig',
  '.rb': 'ruby',
  '.rake': 'ruby',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.dart': 'dart',
  '.liquid': 'liquid',
  '.svelte': 'svelte',
  '.vue': 'vue',
  '.pas': 'pascal',
  '.dpr': 'pascal',
  '.dpk': 'pascal',
  '.lpr': 'pascal',
  '.dfm': 'pascal',
  '.fmx': 'pascal',
  '.scala': 'scala',
  '.sc': 'scala',
  '.lua': 'lua',
  '.luau': 'luau',
  '.m': 'objc',
  '.mm': 'objc',
  // XML: file-level tracking; the MyBatis extractor matches `<mapper namespace="...">`
  // shape and emits SQL-statement nodes (other XML returns empty).
  '.xml': 'xml',
  // Spring config: `application.properties` / `application-*.properties`. Same
  // shape as the `.yml` variants — the YAML/properties extractor emits one node
  // per leaf key, and the Spring resolver links `@Value("${k}")` references.
  '.properties': 'properties',
};

/**
 * Whether a recognized source file belongs to the current indexing scope.
 * Grammar availability and explicit low-level extraction stay independent.
 */
export function isSourceFile(filePath: string, scope: LanguageScope = getLanguageScope()): boolean {
  if (isPlayRoutesFile(filePath)) return isLanguageEnabled('yaml', scope);
  if (isShopifyLiquidJson(filePath)) return isLanguageEnabled('liquid', scope);
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return false;
  const language = EXTENSION_MAP[filePath.slice(dot).toLowerCase()];
  return language !== undefined && isLanguageEnabled(language, scope);
}

/**
 * Shopify OS 2.0 JSON template (`templates/*.json`) or section group
 * (`sections/*.json`) — these reference sections by `"type"`, so the Liquid
 * extractor links them. (config/ + locales/ JSON have no section refs.)
 */
export function isShopifyLiquidJson(filePath: string): boolean {
  // Allow nested template dirs (`templates/customers/login.json`), not just
  // top-level (`templates/product.json`).
  return /(^|\/)(templates|sections)\/.+\.json$/i.test(filePath);
}

/**
 * Play Framework routes file: the extensionless `conf/routes` (and included
 * `conf/*.routes`). No grammar — route extraction is done by the Play framework
 * resolver, so it's processed through the no-grammar (`yaml`-style) path.
 */
export function isPlayRoutesFile(filePath: string): boolean {
  return (
    filePath === 'conf/routes' ||
    filePath.endsWith('/conf/routes') ||
    filePath.endsWith('.routes')
  );
}

/**
 * Caches for loaded grammars and parsers
 */
const parserCache = new Map<Language, Parser>();
const languageCache = new Map<Language, WasmLanguage>();
const unavailableGrammarErrors = new Map<Language, string>();

let parserInitialized = false;

/**
 * Initialize the tree-sitter WASM runtime. Must be called before loading grammars.
 * Does NOT load any grammar WASM files — use loadGrammarsForLanguages() for that.
 * Idempotent — safe to call multiple times.
 */
export async function initGrammars(): Promise<void> {
  if (parserInitialized) return;

  await Parser.init();

  parserInitialized = true;
}

/**
 * Resolve the on-disk path of a language's grammar WASM file.
 *
 * Some grammars ship their own WASMs (not in tree-sitter-wasms, or the
 * tree-sitter-wasms build is too old). Lua: tree-sitter-wasms ships an
 * ABI-13 build that corrupts the shared WASM heap under web-tree-sitter
 * 0.25 (drops nested calls/imports on every file after the first); we
 * vendor the upstream ABI-15 wasm instead. C#: the tree-sitter-wasms
 * build (ABI 13) has no primary-constructor support and parses
 * `class Foo(...)` as an ERROR that swallows the whole class (#237); we
 * vendor the upstream ABI-15 tree-sitter-c-sharp 0.23.5 wasm, which parses
 * primary constructors natively.
 */
export function resolveWasmPath(lang: GrammarLanguage): string {
  const wasmFile = WASM_GRAMMAR_FILES[lang];
  // tree-sitter-wasms' old C++ grammar mistakes member comparisons such as
  // `a.x < 1 || a.y < 1` for template arguments, swallowing later functions.
  // Vendor upstream 0.23.4; see docs/grammars/tree-sitter-cpp.md.
  return (lang === 'cpp' || lang === 'pascal' || lang === 'scala' || lang === 'lua' || lang === 'luau' || lang === 'csharp')
    ? path.join(__dirname, 'wasm', wasmFile)
    : require.resolve(`tree-sitter-wasms/out/${wasmFile}`);
}

/**
 * Pre-read grammar WASM bytes for the given languages, keyed by language.
 * Forwarding these to a worker's `load-grammars` message lets a spawn/respawn
 * load grammars from memory instead of re-reading them from disk — on slow
 * storage each respawn's grammar re-read otherwise amplifies the very I/O
 * contention that caused the respawn (#1231). Best-effort: a language whose
 * WASM can't be read is simply omitted, and the worker falls back to its own
 * disk read via {@link resolveWasmPath}.
 */
export async function readGrammarWasmBytes(languages: Language[]): Promise<Record<string, Uint8Array>> {
  const out: Record<string, Uint8Array> = {};
  const langs = [...new Set(languages)].filter(
    (lang): lang is GrammarLanguage => lang in WASM_GRAMMAR_FILES
  );
  await Promise.all(langs.map(async (lang) => {
    try {
      out[lang] = await fsp.readFile(resolveWasmPath(lang));
    } catch {
      // best-effort — worker falls back to its own disk read
    }
  }));
  return out;
}

/**
 * Load grammar WASM files for specific languages only.
 * Skips languages that are already loaded or have no WASM grammar.
 * Must be called after initGrammars().
 *
 * `wasmBytes` (when provided) supplies in-memory WASM bytes keyed by language,
 * so a worker that already has the bytes can load from memory instead of
 * re-reading the file from disk — see {@link readGrammarWasmBytes}.
 */
export async function loadGrammarsForLanguages(
  languages: Language[],
  wasmBytes?: Record<string, Uint8Array>
): Promise<void> {
  if (!parserInitialized) {
    await initGrammars();
  }

  // Deduplicate and filter to languages that have WASM grammars and aren't already loaded
  const toLoad = [...new Set(languages)].filter(
    (lang): lang is GrammarLanguage =>
      lang in WASM_GRAMMAR_FILES &&
      !languageCache.has(lang) &&
      !unavailableGrammarErrors.has(lang)
  );

  // Load grammars sequentially to avoid web-tree-sitter WASM race condition on Node 20+
  // See: https://github.com/tree-sitter/tree-sitter/issues/2338
  for (const lang of toLoad) {
    try {
      const language = await WasmLanguage.load(wasmBytes?.[lang] ?? resolveWasmPath(lang));
      languageCache.set(lang, language);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[CodeGraph] Failed to load ${lang} grammar — parsing will be unavailable: ${message}`);
      unavailableGrammarErrors.set(lang, message);
    }
  }
}

/**
 * Load ALL grammar WASM files. Convenience function for tests and
 * backward compatibility. Prefer loadGrammarsForLanguages() in production.
 */
export async function loadAllGrammars(): Promise<void> {
  const allLanguages = Object.keys(WASM_GRAMMAR_FILES) as GrammarLanguage[];
  await loadGrammarsForLanguages(allLanguages);
}

/**
 * Check if grammars have been initialized
 */
export function isGrammarsInitialized(): boolean {
  return parserInitialized;
}

/**
 * Get a parser for the specified language.
 * Returns synchronously from pre-loaded cache.
 */
export function getParser(language: Language): Parser | null {
  if (parserCache.has(language)) {
    return parserCache.get(language)!;
  }

  const parser = createParser(language);
  if (!parser) return null;
  parserCache.set(language, parser);
  return parser;
}

/**
 * Create an uncached parser for an isolated auxiliary parse.
 *
 * Declaration-macro recovery may need to parse transformed source while the
 * primary extraction is still active. Giving that work its own Parser keeps a
 * failure from corrupting the long-lived parser cached by the worker.
 * The immutable Language and underlying WASM instance are still shared; a
 * runtime-level trap is therefore handled by terminating and retrying with a
 * fresh worker (see wasm-errors.ts and parse-worker.ts).
 * The caller owns the returned parser and must delete it.
 */
export function createParser(language: Language): Parser | null {
  const lang = languageCache.get(language);
  if (!lang) {
    return null;
  }

  const parser = new Parser();
  parser.setLanguage(lang);
  return parser;
}

/**
 * Detect language from file extension
 */
export function detectLanguage(filePath: string, source?: string): Language {
  // Play `conf/routes` has no grammar — route through the no-symbol path; the
  // Play framework resolver extracts route nodes from it.
  if (isPlayRoutesFile(filePath)) return 'yaml';
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
  // Shopify OS 2.0 JSON templates / section groups → the Liquid extractor (it
  // links each section `"type"` to its `sections/<type>.liquid`).
  if (isShopifyLiquidJson(filePath)) return 'liquid';
  const lang = EXTENSION_MAP[ext] || 'unknown';

  // .h files could be C, C++, or Objective-C — check source content
  if (lang === 'c' && ext === '.h' && source) {
    // Mask once: a C header that matches neither heuristic should not pay for
    // two complete lexical scans now that detection covers the whole file.
    const code = maskCStyleCommentsAndLiterals(source);
    if (looksLikeCpp(code)) return 'cpp';
    if (looksLikeObjc(code)) return 'objc';
  }

  return lang;
}

/**
 * Mask comments and literals before applying content-based language heuristics.
 *
 * `.h` files can be very large generated/macro tables, so looking only at a
 * prefix misses real C++ declarations later in the file. Scanning the complete
 * source is still linear and cheap compared with parsing it, but only if words
 * such as `namespace` in a license comment, diagnostic string, or raw string do
 * not promote an otherwise-C header to C++. Newlines are retained for future
 * line-oriented heuristics and diagnostics.
 *
 * The mask is length-preserving in JavaScript UTF-16 CODE UNITS (each
 * comment/literal code unit becomes one space, `\r\n` kept) — NOT in UTF-8
 * bytes, which shrink when multi-byte characters are replaced. String
 * indexes in the masked text therefore address the original source
 * identically, which is what web-tree-sitter's `startIndex` and the regex
 * match offsets use. `isPureMacroDataHeader` / `extractMacrosByRegex` in
 * tree-sitter.ts rely on that invariant to detect pure-macro data headers
 * whose semicolons live only inside comments and to keep ghost `#define`s in
 * comments out of the graph. Do not reuse this function where real byte
 * offsets are required.
 */
export function maskCStyleCommentsAndLiterals(source: string): string {
  let out = '';
  let codeStart = 0;
  let i = 0;

  const appendMasked = (start: number, end: number): void => {
    out += source.slice(codeStart, start);
    out += source.slice(start, end).replace(/[^\r\n]/g, ' ');
    codeStart = end;
  };

  while (i < source.length) {
    const c = source[i]!;
    const next = source[i + 1] ?? '';

    if (c === '/' && next === '/') {
      const newline = source.indexOf('\n', i + 2);
      const end = newline === -1 ? source.length : newline;
      appendMasked(i, end);
      i = end;
      continue;
    }

    if (c === '/' && next === '*') {
      const close = source.indexOf('*/', i + 2);
      const end = close === -1 ? source.length : close + 2;
      appendMasked(i, end);
      i = end;
      continue;
    }

    // C++ raw string: R"delimiter(contents)delimiter". Prefixes such as u8R
    // are harmless because the scanner reaches R after copying `u8` as code.
    if (c === 'R' && next === '"') {
      const openParen = source.indexOf('(', i + 2);
      if (openParen !== -1 && openParen - (i + 2) <= 16) {
        const delimiter = source.slice(i + 2, openParen);
        if (!/[\s\\()]/.test(delimiter)) {
          const terminator = `)${delimiter}"`;
          const close = source.indexOf(terminator, openParen + 1);
          if (close !== -1) {
            const end = close + terminator.length;
            appendMasked(i, end);
            i = end;
            continue;
          }
        }
      }
    }

    if (c === '"' || c === "'") {
      const quote = c;
      let end = i + 1;
      while (end < source.length) {
        const q = source[end]!;
        if (q === '\\') {
          end = Math.min(source.length, end + 2);
          continue;
        }
        end++;
        if (q === quote) break;
      }
      appendMasked(i, end);
      i = end;
      continue;
    }

    i++;
  }

  out += source.slice(codeStart);
  return out;
}

/**
 * Heuristic: does a .h file contain C++ constructs?
 * Scans the complete file after masking comments and literals. A large macro
 * data table before the first namespace/class must not select the C grammar.
 */
function looksLikeCpp(code: string): boolean {
  return /\bnamespace\b|\bclass\s+\w+(?:\s+final)?\s*[:{;]|\btemplate\s*<|\b(?:public|private|protected)\s*:|\bvirtual\b|\busing\s+(?:namespace\b|\w+\s*=|\w+::)|\b(?:constexpr|consteval|constinit|noexcept|decltype|nullptr)\b|\benum\s+(?:class|struct)\s+\w+|\b(?:static_cast|reinterpret_cast|const_cast|dynamic_cast)\s*<|\bstd::/.test(code);
}

/**
 * Heuristic: does a .h file contain Objective-C constructs?
 */
function looksLikeObjc(code: string): boolean {
  return /@(?:interface|implementation|protocol|synthesize)\b/.test(code);
}

/**
 * Check if a language is supported (has a grammar defined).
 * Returns true if the grammar exists, even if not yet loaded.
 */
export function isLanguageSupported(language: Language): boolean {
  if (language === 'svelte') return true; // custom extractor (script block delegation)
  if (language === 'vue') return true; // custom extractor (script block delegation)
  if (language === 'liquid') return true; // custom regex extractor
  if (language === 'razor') return true; // custom RazorExtractor (.cshtml/.razor markup)
  if (language === 'yaml') return true; // file-level tracking only; Drupal routing extraction via framework resolver
  if (language === 'twig') return true; // file-level tracking only
  if (language === 'xml') return true; // MyBatis mapper extractor
  if (language === 'properties') return true; // Spring config keys
  if (language === 'unknown') return false;
  return language in WASM_GRAMMAR_FILES;
}

/**
 * Check if a grammar has been loaded and is ready for parsing.
 */
export function isGrammarLoaded(language: Language): boolean {
  if (language === 'svelte' || language === 'vue' || language === 'liquid' || language === 'razor') return true;
  if (language === 'yaml' || language === 'twig') return true; // no WASM grammar needed
  if (language === 'xml' || language === 'properties') return true; // no WASM grammar needed
  return languageCache.has(language);
}

/**
 * Languages tracked at the file-record level only: parsing emits zero symbol
 * nodes, but the file is still stored (and framework resolvers may add per-file
 * references later, e.g. Drupal routing yml, Spring `@Value` against
 * application.properties). This is the canonical set behind the no-symbol
 * branch in `tree-sitter.ts`; `xml` is intentionally excluded because its
 * MyBatis extractor emits a file node. Callers use this to count such files as
 * indexed rather than skipped, so it must stay in sync with that branch.
 */
export function isFileLevelOnlyLanguage(language: Language): boolean {
  return language === 'yaml' || language === 'twig' || language === 'properties';
}

/**
 * Get all supported languages (those with grammar definitions).
 */
export function getSupportedLanguages(): Language[] {
  return [...(Object.keys(WASM_GRAMMAR_FILES) as GrammarLanguage[]), 'svelte', 'vue', 'liquid'];
}

/**
 * Reset the cached parser for a language to reclaim WASM heap memory.
 * The tree-sitter WASM runtime accumulates fragmented memory over thousands
 * of parses. Deleting and recreating the Parser instance forces the WASM
 * heap to reset, preventing "memory access out of bounds" crashes in
 * large repos.
 */
export function resetParser(language: Language): void {
  const old = parserCache.get(language);
  if (old) {
    old.delete();
    parserCache.delete(language);
  }
}

/**
 * Clear parser/grammar caches (useful for testing)
 */
export function clearParserCache(): void {
  for (const parser of parserCache.values()) {
    parser.delete();
  }
  parserCache.clear();
  // Note: languageCache is NOT cleared — WASM languages persist.
  // To fully re-init, set parserInitialized = false and call initGrammars() again.
  unavailableGrammarErrors.clear();
}

/**
 * Report grammars that failed to load.
 */
export function getUnavailableGrammarErrors(): Partial<Record<Language, string>> {
  const out: Partial<Record<Language, string>> = {};
  for (const [language, message] of unavailableGrammarErrors.entries()) {
    out[language] = message;
  }
  return out;
}

/**
 * Get language display name
 */
export function getLanguageDisplayName(language: Language): string {
  const names: Record<Language, string> = {
    typescript: 'TypeScript',
    javascript: 'JavaScript',
    tsx: 'TypeScript (TSX)',
    jsx: 'JavaScript (JSX)',
    python: 'Python',
    go: 'Go',
    rust: 'Rust',
    java: 'Java',
    c: 'C',
    cpp: 'C++',
    csharp: 'C#',
    razor: 'Razor/Blazor',
    php: 'PHP',
    ruby: 'Ruby',
    swift: 'Swift',
    kotlin: 'Kotlin',
    dart: 'Dart',
    svelte: 'Svelte',
    vue: 'Vue',
    liquid: 'Liquid',
    pascal: 'Pascal / Delphi',
    scala: 'Scala',
    lua: 'Lua',
    luau: 'Luau',
    objc: 'Objective-C',
    yaml: 'YAML',
    twig: 'Twig',
    xml: 'XML',
    properties: 'Java properties',
    unknown: 'Unknown',
  };
  return names[language] || language;
}
