import { afterEach, describe, expect, it, vi } from 'vitest';
import { CppReceiverDeclarationCache, lastDeclarationBefore } from '../src/resolution/cpp-receiver-index';
import { matchMethodCall } from '../src/resolution/name-matcher';
import { ReferenceResolver } from '../src/resolution';
import type { QueryBuilder } from '../src/db/queries';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types';
import type { Node } from '../src/types';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

// The pre-index implementation is the equivalence oracle, including its
// permissive treatment of comments/strings and its first match on each line.
function legacyDeclarations(source: string, receiver: string) {
  const escaped = receiver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const word = new RegExp(`\\b${escaped}\\b`);
  const declarator = new RegExp(`([A-Za-z_][\\w:]*(?:\\s*<[^;=(){}]+>)?(?:\\s*[*&]+)?)\\s*\\b${escaped}\\b\\s*(?=[;=,)\\[{(]|$)`);
  return source.split(/\r?\n/).flatMap((text, line) => {
    const match = word.test(text) ? text.match(declarator) : null;
    return match ? [{ line, rawType: match[1] ?? '' }] : [];
  });
}

describe('compact C++ receiver evidence', () => {
  it('preserves line boundaries, raw matches and order across receiver shapes', () => {
    const cache = new CppReceiverDeclarationCache(1_000_000, 16, 64, 0);
    const lines = ['', 'Alpha obj;', 'Beta*obj = nullptr;', 'Gamma & obj, Other obj;',
      'void fn(ns::Thing<int> *obj) {}', 'obj.flush();', 'return obj->flush();',
      'auto obj = Factory::create();', 'int obj_suffix;', 'Type prefix_obj;',
      '// CommentType obj;', '"QuotedType obj;"', 'Type obj.part;', 'Type x$y;',
      '中文😀\rType obj;', 'obj', 'Last obj\r'];
    for (const newline of ['\n', '\r\n', '\r\r\n']) {
      const source = lines.join(newline);
      for (const receiver of ['obj', 'obj.part', 'x$y', 'missing', 'obj_suffix']) {
        const indexed = cache.get(source, receiver)!;
        const expected = legacyDeclarations(source, receiver);
        expect(indexed.declarations).toEqual(expected);
        expect(Array.from({ length: indexed.lineCount }, (_, line) => indexed.lineText(line))).toEqual(source.split(/\r?\n/));
        for (let line = -1; line < indexed.lineCount + 2; line++) {
          expect(lastDeclarationBefore(indexed.declarations, line)).toBe(expected.filter(item => item.line <= line).length - 1);
        }
      }
    }
    expect(cache.get('', 'obj')!.lineText(0)).toBe('');
    expect(lastDeclarationBefore([], 0)).toBe(-1);
  });

  it('bounds source count and retained bytes while returned evidence survives eviction', () => {
    const cache = new CppReceiverDeclarationCache(1024, 2, 2, 0);
    const first = cache.get('Alpha obj;', 'obj')!;
    expect(cache.get('Alpha obj;', 'obj')).toBe(first);
    for (let i = 0; i < 25; i++) {
      cache.get(`Type${i} obj;`, 'obj');
      expect(cache.size).toBeLessThanOrEqual(2);
      expect(cache.estimatedBytes).toBeLessThanOrEqual(1024);
    }
    expect(first.lineText(0)).toBe('Alpha obj;');
    expect(cache.get('Alpha obj;', 'obj')).not.toBe(first);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.estimatedBytes).toBe(0);
  });

  it('bounds receiver entries, including cached misses, and skips oversized retention', () => {
    const cache = new CppReceiverDeclarationCache(2048, 4, 2, 0);
    const source = 'Type first;\nType second;\nType third;';
    const first = cache.get(source, 'first');
    cache.get(source, 'second'); cache.get(source, 'missing');
    expect(cache.get(source, 'first')).not.toBe(first);
    const hot = cache.get(source, 'first');
    expect(cache.get('x'.repeat(5000), 'x')).toBeNull();
    expect(cache.get(source, 'first')).toBe(hot);
    const dense = 'Type obj;\n'.repeat(60);
    const largeResult = cache.get(dense, 'obj')!;
    expect(largeResult.declarations).toHaveLength(60);
    expect(cache.get(dense, 'obj')).not.toBe(largeResult);
    expect(cache.estimatedBytes).toBeLessThanOrEqual(2048);
  });

  it('keeps small files on the old path and follows the existing text-cache switch', () => {
    expect(new CppReceiverDeclarationCache().get('Type obj;', 'obj')).toBeNull();
    vi.stubEnv('CODEGRAPH_NO_RESOLVE_TEXT_CACHE', '1');
    expect(new CppReceiverDeclarationCache(2048, 2, 2, 0).get('Type obj;', 'obj')).toBeNull();
  });
});

function method(owner: string): Node {
  return { id: owner, name: 'flush', kind: 'method', qualifiedName: `${owner}::flush`, filePath: 'types.h',
    language: 'cpp', startLine: 1, endLine: 1, startColumn: 0, endColumn: 1, updatedAt: 1 };
}
function context(nodes: Node[], sources: Map<string, string>, indexed: boolean): ResolutionContext {
  const cache = new CppReceiverDeclarationCache(1_000_000, 16, 64, 0);
  return {
    getNodesInFile: file => nodes.filter(node => node.filePath === file),
    getNodesByName: name => nodes.filter(node => node.name === name),
    getNodesByQualifiedName: name => nodes.filter(node => node.qualifiedName === name),
    getNodesByKind: kind => nodes.filter(node => node.kind === kind),
    getNodesByLowerName: name => nodes.filter(node => node.name.toLowerCase() === name),
    getAllFiles: () => [...sources.keys()], getProjectRoot: () => '/test',
    getImportMappings: () => [], fileExists: file => sources.has(file),
    readFile: file => sources.get(file) ?? null,
    ...(indexed ? { getCppReceiverDeclarations: (file: string, receiver: string) =>
      sources.has(file) ? cache.get(sources.get(file)!, receiver) : null } : {}),
  };
}
const ref = (line: number): UnresolvedRef => ({ fromNodeId: 'caller', filePath: 'main.cpp', language: 'cpp',
  referenceName: 'obj.flush', referenceKind: 'calls', line, column: 0 });

describe('indexed inference preserves graph decisions', () => {
  it('preserves nearest earlier declarations, clamping and source replacement', () => {
    const nodes = [method('Alpha'), method('Beta')];
    const sources = new Map([['main.cpp', 'Alpha obj;\r\nobj.flush();\r\nBeta obj;\r\nobj.flush();']]);
    const plain = context(nodes, sources, false), indexed = context(nodes, sources, true);
    for (const line of [2, 4, 2, 999, -1]) expect(matchMethodCall(ref(line), indexed)).toEqual(matchMethodCall(ref(line), plain));
    expect(matchMethodCall(ref(2), indexed)?.targetNodeId).toBe('Alpha');
    sources.set('main.cpp', 'Beta obj;\nobj.flush();');
    expect(matchMethodCall(ref(2), indexed)?.targetNodeId).toBe('Beta');
  });

  it('keeps header precedence and forward order, skipping auto there', () => {
    const nodes = [method('Alpha'), method('Beta')];
    const sources = new Map([['main.cpp', 'obj.flush();'], ['main.h', 'auto obj = make();\nAlpha obj;\nBeta obj;'], ['main.hpp', 'Beta obj;']]);
    const plain = context(nodes, sources, false), indexed = context(nodes, sources, true);
    expect(matchMethodCall(ref(1), indexed)).toEqual(matchMethodCall(ref(1), plain));
    expect(matchMethodCall(ref(1), indexed)?.targetNodeId).toBe('Alpha');
    sources.delete('main.h');
    expect(matchMethodCall(ref(1), indexed)?.targetNodeId).toBe('Beta');
    for (const text of ['', '\r\n']) {
      sources.set('main.cpp', text);
      expect(matchMethodCall(ref(1), indexed)).toEqual(matchMethodCall(ref(1), plain));
    }
    sources.delete('main.cpp');
    expect(matchMethodCall(ref(1), indexed)).toEqual(matchMethodCall(ref(1), plain));
  });

  it('reevaluates auto return types and falls back past an unresolved auto declaration', () => {
    const factory = { ...method('Factory'), id: 'factory', name: 'create', qualifiedName: 'Factory::create', returnType: 'Alpha' };
    const nodes = [method('Alpha'), method('Beta'), factory];
    const sources = new Map([['main.cpp', 'Beta obj;\nauto obj = Factory::create();\nobj.flush();']]);
    const plain = context(nodes, sources, false), indexed = context(nodes, sources, true);
    expect(matchMethodCall(ref(3), indexed)?.targetNodeId).toBe('Alpha');
    factory.returnType = 'Beta';
    expect(matchMethodCall(ref(3), indexed)?.targetNodeId).toBe('Beta');
    factory.returnType = '';
    expect(matchMethodCall(ref(3), indexed)).toEqual(matchMethodCall(ref(3), plain));
    expect(matchMethodCall(ref(3), indexed)?.targetNodeId).toBe('Beta');
  });

  it('uses compact evidence for a large source and clears it with resolver caches', () => {
    const resolver = new ReferenceResolver('/test', {} as QueryBuilder);
    const ctx = (resolver as unknown as { context: ResolutionContext }).context;
    const read = vi.spyOn(ctx, 'readFile').mockReturnValue('// padding\n'.repeat(14000) + 'Alpha obj;');
    const split = vi.spyOn(ctx, 'getFileLines');
    const first = ctx.getCppReceiverDeclarations!('main.cpp', 'obj')!;
    expect(first.declarations).toEqual([{ line: 14000, rawType: 'Alpha' }]);
    expect(ctx.getCppReceiverDeclarations!('main.cpp', 'obj')).toBe(first);
    read.mockReturnValue('// padding\n'.repeat(14000) + 'Beta obj;');
    const changed = ctx.getCppReceiverDeclarations!('main.cpp', 'obj')!;
    expect(changed.declarations[0]!.rawType).toBe('Beta');
    resolver.clearCaches();
    expect(ctx.getCppReceiverDeclarations!('main.cpp', 'obj')).not.toBe(changed);
    expect(split).not.toHaveBeenCalled();
  });
});
