import { readFileSync } from 'node:fs';
import * as ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import type { Node } from '../src/types';
import type { ResolutionContext } from '../src/resolution/types';
import * as grammars from '../src/extraction/grammars';
import { maskCStyleCommentsAndLiterals } from '../src/extraction/grammars';
import { CppIncludeDirectory, normalizeCppIndexedPath } from '../src/resolution/cpp-include-directory';
import { isCppBindingTargetAllowed } from '../src/resolution/cpp-binding-evidence';
import { cppParameterKey } from '../src/resolution/cpp-signature';

type Dialect = 'c' | 'cpp';
interface Scope { namespace: string; anonymous: boolean; ordinary: boolean; namespaceScope: boolean; linkage: Dialect | null }
interface Source { text: string; code: string; scopes: { offset: number; scope: Scope }[] }
interface Declaration { source: Source; offset: number; prefix: string; text: string; scope: Scope; active: boolean | null; linkage: Dialect | null }
interface Cache<T> { has(key: string): boolean; get(key: string): T | undefined; set(key: string, value: T): void }
interface Implementation {
  sourceFor(file: string, dialect: Dialect, context: ResolutionContext, required?: (text: string) => boolean): Source | null | false;
  parseBindingSource(text: string, dialect: Dialect): Source;
  storageLinkage(node: Node, decl: Declaration, context: ResolutionContext): 'internal' | 'external' | 'unknown';
  cacheFor(context: ResolutionContext): { text: Cache<string | null>; sources: Cache<Source | null> };
}

// Exercise the actual private parser/cache path without test-only product exports
// or global loader changes. Reachability is supplied explicitly to isolate a
// source-cache miss from the include walk that normally fills that cache first.
function implementation() {
  const source = readFileSync(new URL('../src/resolution/cpp-binding-evidence.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('binding.ts', source, ts.ScriptTarget.Latest, true);
  const wanted = new Set(['EvidenceCache', 'caches', 'sourceWeights', 'MAX_SOURCE_LENGTH', 'sourceWeight', 'cacheFor',
    'sourceFor', 'parseBindingSource', 'and', 'not', 'condition', 'scopeAt', 'conditionAt', 'simpleTypePrefix',
    'bindingParameterKey', 'priorParameterKey', 'hasPriorExtern', 'storageLinkage']);
  const found = new Set<string>();
  const definitions = ast.statements.filter(node => {
    const name = (ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name ? node.name.text
      : ts.isVariableStatement(node) && node.declarationList.declarations.length === 1
        ? node.declarationList.declarations[0]!.name.getText(ast) : '';
    if (!wanted.has(name)) return false;
    found.add(name); return true;
  });
  expect(found).toEqual(wanted);
  const mask = vi.fn(maskCStyleCommentsAndLiterals);
  const reachable = vi.fn(() => ({ possible: new Set(['prior.h']), definite: new Set(['prior.h']), open: false }));
  const body = definitions.map(node => node.getText(ast)).join('\n')
    + '\nreturn { sourceFor, parseBindingSource, storageLinkage, cacheFor };';
  const compiled = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const api = new Function('maskCStyleCommentsAndLiterals', 'CppIncludeDirectory', 'fileKey', 'cppParameterKey', 'reachable', compiled)(
    mask, CppIncludeDirectory, normalizeCppIndexedPath, cppParameterKey, reachable) as Implementation;
  return { ...api, mask, reachable };
}

function fixture(name = 'measureFlux', language: Dialect = 'cpp', text: string | null = '') {
  const api = implementation();
  const signature = `int ${name}(int value){return value;}`;
  const node: Node = { id: 'target', name, qualifiedName: name, kind: 'function', language,
    filePath: `target.${language}`, startLine: 1, endLine: 1, startColumn: 0, endColumn: signature.length, signature, updatedAt: 0 };
  const source = api.parseBindingSource(signature, language);
  const decl: Declaration = { source, offset: 0, prefix: 'int', text: signature,
    scope: source.scopes[0]!.scope, active: true, linkage: language };
  const readFile = vi.fn((_file: string): string | null => text);
  const context: ResolutionContext = { readFile, getAllFiles: () => ['prior.h'],
    getNodesByName: () => [], getNodesByQualifiedName: () => [], getNodesByLowerName: () => [],
    getNodesByKind: () => [], getNodesInFile: () => [], fileExists: () => true,
    getProjectRoot: () => '/project', getImportMappings: () => [] };
  api.mask.mockClear();
  return { ...api, node, decl, context, readFile, linkage: () => api.storageLinkage(node, decl, context) };
}

describe.each(['measureFlux', 'settleWave'])('prior-static raw source filtering for %s', name => {
  describe.each(['c', 'cpp'] as const)('%s linkage', language => {
    it.each(['static', 'name'])('avoids parsing when the raw source lacks %s', missing => {
      const raw = missing === 'static' ? `int ${name}(int value);` : 'static int unrelated(int value);';
      const f = fixture(name, language, raw);
      expect(f.linkage()).toBe('external');
      expect(f.readFile).toHaveBeenCalledTimes(1);
      expect(f.mask).not.toHaveBeenCalled();
      expect(f.cacheFor(f.context).sources.has(`${language}:prior.h`)).toBe(false);
      expect(f.cacheFor(f.context).text.get('prior.h')).toBe(raw);
    });

    it.each([
      ['static', (name: string) => `static int ${name}(int value);`, 'internal'],
      ['different overload', (name: string) => `static int ${name}(double value);`, 'external'],
      ['conditional', (name: string) => `#ifdef FEATURE\nstatic int ${name}(int value);\n#endif`, 'unknown'],
      ['comment', (name: string) => `/* static int ${name}(int value); */`, 'external'],
      ['string', (name: string) => `const char *note = "static int ${name}(int value);";`, 'external'],
      ['raw string', (name: string) => `const char *note = R"(static int ${name}(int value);)";`, 'external'],
      ['inactive', (name: string) => `#if 0\nstatic int ${name}(int value);\n#endif`, 'external'],
      ['directive', (name: string) => `#define TOKEN static int ${name}(int value);`, 'external'],
    ] as const)('retains the parsed %s evidence', (_label, source, expected) => {
      const raw = source(name), f = fixture(name, language, raw);
      expect(f.linkage()).toBe(expected);
      expect(f.mask).toHaveBeenCalledTimes(1);
      expect(f.mask).toHaveBeenCalledWith(raw);
    });
  });
});

describe('prior-static source cache and uncertainty boundaries', () => {
  it.each(['operator+', 'metric[ab]', 'sample.name'])('keeps the unfiltered parser path for %s', name => {
    const raw = 'static int unrelated(int value);', f = fixture(name, 'cpp', raw);
    expect(f.linkage()).toBe('external');
    expect(f.mask).toHaveBeenCalledWith(raw);
    const absent = fixture(name, 'cpp', 'int unrelated(int value);');
    expect(absent.linkage()).toBe('external');
    expect(absent.mask).toHaveBeenCalledWith('int unrelated(int value);');
  });

  it('does not assume static is necessary when a name alternation bypasses it', () => {
    const raw = 'int measureFlux(int value);', f = fixture('absent|measureFlux', 'cpp', raw);
    expect(f.linkage()).toBe('unknown');
    expect(f.mask).toHaveBeenCalledWith(raw);
  });

  it.each([null, 'x'.repeat(4 * 1024 * 1024 + 1)])('keeps missing/oversized source uncertainty before filtering', raw => {
    const f = fixture('measureFlux', 'cpp', raw), required = vi.fn(() => false);
    expect(f.sourceFor('prior.h', 'cpp', f.context, required)).toBeNull();
    expect(required).not.toHaveBeenCalled();
    expect(f.linkage()).toBe('unknown');
    expect(f.linkage()).toBe('unknown');
    expect(f.readFile).toHaveBeenCalledTimes(1);
    expect(f.mask).not.toHaveBeenCalled();
  });

  it('reads an unadmitted raw text once per request without converting its skip to null', () => {
    // At the source length limit, key/entry overhead puts this text over its
    // separate 8 MiB budget. The negative parse result must not trigger a reread.
    const f = fixture('measureFlux', 'cpp', 'x'.repeat(4 * 1024 * 1024));
    expect(f.linkage()).toBe('external');
    expect(f.readFile).toHaveBeenCalledTimes(1);
    expect(f.cacheFor(f.context).text.has('prior.h')).toBe(false);
    expect(f.cacheFor(f.context).sources.has('cpp:prior.h')).toBe(false);
    expect(f.linkage()).toBe('external');
    expect(f.readFile).toHaveBeenCalledTimes(2);
    expect(f.mask).not.toHaveBeenCalled();
  });

  it('does not cache a skipped parse as missing and lets a later ordinary request parse', () => {
    const raw = 'int measureFlux(int value);', f = fixture('measureFlux', 'cpp', raw);
    expect(f.linkage()).toBe('external');
    expect(f.mask).not.toHaveBeenCalled();
    const source = f.sourceFor('prior.h', 'cpp', f.context);
    expect(source && source.text).toBe(raw);
    expect(f.mask).toHaveBeenCalledTimes(1);
    expect(f.readFile).toHaveBeenCalledTimes(1);
  });

  it.each([null, 'static int measureFlux(int value);', 'int measureFlux(int value);'])
  ('honors a cached source including null after its text has been evicted', raw => {
    const f = fixture('measureFlux', 'cpp', raw);
    const cached = f.sourceFor('prior.h', 'cpp', f.context);
    const cache = f.cacheFor(f.context);
    for (let i = 0; i < 64; i++) cache.text.set(`evict-${i}.h`, 'int unrelated;');
    expect(cache.text.has('prior.h')).toBe(false);
    expect(cache.sources.has('cpp:prior.h')).toBe(true);
    f.readFile.mockImplementation(() => { throw new Error('must not reread cached source'); });
    const required = vi.fn(() => false);
    expect(f.sourceFor('prior.h', 'cpp', f.context, required)).toBe(cached);
    expect(required).not.toHaveBeenCalled();
    expect(f.linkage()).toBe(raw === null ? 'unknown' : raw.includes('static') ? 'internal' : 'external');
    expect(f.readFile).toHaveBeenCalledTimes(1);
  });

  it('propagates source-read failure without a partial cache entry and retries', () => {
    const f = fixture('settleWave', 'cpp', 'static int settleWave(int value);');
    f.readFile.mockImplementationOnce(() => { throw new Error('interrupted source read'); });
    expect(f.linkage).toThrow('interrupted source read');
    expect(f.cacheFor(f.context).text.has('prior.h')).toBe(false);
    expect(f.cacheFor(f.context).sources.has('cpp:prior.h')).toBe(false);
    expect(f.linkage()).toBe('internal');
    expect(f.readFile).toHaveBeenCalledTimes(2);
  });

  it('retries a failed parse from the same cached raw text', () => {
    const raw = 'static int settleWave(int value);', f = fixture('settleWave', 'cpp', raw);
    f.mask.mockImplementationOnce(() => { throw new Error('interrupted parse'); });
    expect(f.linkage).toThrow('interrupted parse');
    expect(f.cacheFor(f.context).text.get('prior.h')).toBe(raw);
    expect(f.cacheFor(f.context).sources.has('cpp:prior.h')).toBe(false);
    expect(f.linkage()).toBe('internal');
    expect(f.readFile).toHaveBeenCalledTimes(1);
    expect(f.mask).toHaveBeenCalledTimes(2);
  });

  it('preserves invalid-name regex failure before a source read', () => {
    const f = fixture('[', 'cpp', 'int unrelated(int value);');
    expect(f.linkage).toThrow(SyntaxError);
    expect(f.readFile).not.toHaveBeenCalled();
  });

  it('keeps the same-file declaration source without rereading it', () => {
    const f = fixture();
    const raw = 'static int measureFlux(int value);\nint measureFlux(int value){return value;}';
    f.decl.source = f.parseBindingSource(raw, 'cpp');
    f.decl.offset = raw.indexOf('\n') + 1;
    f.reachable.mockReturnValue({ possible: new Set([f.node.filePath]), definite: new Set([f.node.filePath]), open: false });
    f.readFile.mockImplementation(() => { throw new Error('must not reread declaration source'); });
    expect(f.linkage()).toBe('internal');
    expect(f.readFile).not.toHaveBeenCalled();
  });

  it('keeps dialect-specific parsed evidence separate while sharing raw text', () => {
    const raw = '#ifdef __cplusplus\nstatic int measureFlux(int value);\n#endif';
    const f = fixture('measureFlux', 'cpp', raw);
    expect(f.linkage()).toBe('internal');
    f.node.language = 'c';
    expect(f.linkage()).toBe('external');
    expect(f.mask).toHaveBeenCalledTimes(2);
    expect(f.readFile).toHaveBeenCalledTimes(1);
  });
});

describe.each(['measureFlux', 'settleWave'])('public binding cache eviction for %s', name => {
  it.each(['static', 'name'])('does not reparse included headers lacking %s after the include walk', missing => {
    const headers = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`part-${i}.h`,
      missing === 'static' ? `int ${name}(int value); // ${i}` : `static int unrelated_${i}(int value);`]));
    const signature = `int ${name}(int value){return value;}`;
    const node: Node = { id: 'target', name, qualifiedName: name, kind: 'function', language: 'cpp',
      filePath: 'target.cpp', startLine: 71, endLine: 71, startColumn: 0, endColumn: signature.length, signature, updatedAt: 0 };
    const files: Record<string, string> = { ...headers,
      'target.cpp': Object.keys(headers).map(file => `#include "${file}"`).join('\n') + '\n' + signature,
      'caller.cpp': `int caller(){return ${name}(1);}` };
    const context: ResolutionContext = { readFile: file => files[file] ?? null,
      getAllFiles: () => Object.keys(files), getNodesByName: () => [node],
      getNodesByQualifiedName: () => [], getNodesByLowerName: () => [], getNodesByKind: () => [], getNodesInFile: () => [],
      fileExists: file => file in files, getProjectRoot: () => '/project', getImportMappings: () => [] };
    const mask = vi.spyOn(grammars, 'maskCStyleCommentsAndLiterals');
    try {
      expect(isCppBindingTargetAllowed(node, { fromNodeId: 'caller', referenceName: name, referenceKind: 'calls',
        filePath: 'caller.cpp', language: 'cpp', line: 1, column: 20 }, context)).toBe(true);
      // The real include walk parses all 70 headers, exceeding the 64-source
      // cache. The prior-static scan must not restart that parsing eviction loop.
      for (const raw of Object.values(headers)) {
        expect(mask.mock.calls.filter(([text]) => text === raw)).toHaveLength(1);
      }
    } finally { mask.mockRestore(); }
  });
});
