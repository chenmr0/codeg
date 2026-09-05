import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BoundedTextCache, ResolutionTextCache, splitNameWords } from '../src/resolution/text-cache';
import { ReferenceResolver } from '../src/resolution';
import { matchMethodCall } from '../src/resolution/name-matcher';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types';
import type { QueryBuilder } from '../src/db/queries';
import type { Node } from '../src/types';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('bounded pure resolution text results', () => {
  it('bounds entry count, reuses hits and safely recomputes evicted inputs', () => {
    const cache = new BoundedTextCache(2, 4096);
    const compute = vi.fn((text: string) => [text]);
    const first = cache.getOrCompute('first', compute);
    cache.getOrCompute('second', compute);
    expect(cache.getOrCompute('first', compute)).toBe(first);
    cache.getOrCompute('third', compute);
    expect(cache.size).toBe(2);
    // FIFO hits do not keep an old entry alive indefinitely.
    expect(cache.getOrCompute('first', compute)).toEqual(first);
    expect(compute).toHaveBeenCalledTimes(4);
    expect(cache.size).toBe(2);
  });

  it('bounds retained bytes and bypasses oversized inputs without flushing small entries', () => {
    const cache = new BoundedTextCache(20, 300);
    const compute = (text: string) => [text];
    const first = cache.getOrCompute('a', compute);
    const huge = '中'.repeat(500);
    expect(cache.getOrCompute(huge, compute)).toEqual([huge]);
    expect(cache.getOrCompute('a', compute)).toBe(first);
    for (let i = 0; i < 20; i++) {
      cache.getOrCompute(String(i).repeat(20), compute);
      expect(cache.estimatedBytes).toBeLessThanOrEqual(300);
    }
    expect(cache.size).toBeLessThan(20);
  });

  it('keeps derived arrays separate and releases retained entries on clear', () => {
    const cache = new BoundedTextCache(2, 4096);
    const result = cache.getOrCompute('a', text => [text]);
    const filtered = result.filter(word => word === 'a');
    filtered.push('separate result');
    expect(cache.getOrCompute('a', () => ['wrong'])).toEqual(['a']);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.estimatedBytes).toBe(0);
    expect(cache.getOrCompute('a', text => [text])).not.toBe(result);
  });

  it('preserves CRLF, lone CR, empty input, Unicode and exact word-splitting behavior', () => {
    const cache = new ResolutionTextCache();
    for (const source of ['', '中文😀\r\nBeta\rGamma\n', '\n\r\n', 'a\rb']) {
      expect(cache.fileLines(source)).toEqual(source.split(/\r?\n/));
      expect(cache.fileLines(source)).toBe(cache.fileLines(source));
    }
    expect(cache.nameWords('HTTPServer::fooBar_a/X.Y\\中文😀')).toEqual(['HTTP', 'Server', 'foo', 'Bar', '中文😀']);
    expect(cache.nameWords('x')).toEqual([]);
    expect(cache.nameWords('x')).toBe(cache.nameWords('x'));
  });

  it('the rollback switch disables reuse while keeping values identical', () => {
    const enabled = new ResolutionTextCache();
    vi.stubEnv('CODEGRAPH_NO_RESOLVE_TEXT_CACHE', '1');
    const disabled = new ResolutionTextCache();
    for (const source of ['Alpha obj;\r\nobj.flush();', '中文\n']) {
      expect(disabled.fileLines(source)).toEqual(enabled.fileLines(source));
      expect(disabled.fileLines(source)).not.toBe(disabled.fileLines(source));
    }
    expect(disabled.nameWords('AudioWriter::flush')).toEqual(enabled.nameWords('AudioWriter::flush'));
    expect(disabled.nameWords('AudioWriter::flush')).not.toBe(disabled.nameWords('AudioWriter::flush'));
  });
});

function method(owner: string, id = owner): Node {
  return { id, name: 'flush', kind: 'method', qualifiedName: `${owner}::flush`, filePath: 'types.h',
    language: 'cpp', startLine: 1, endLine: 1, startColumn: 0, endColumn: 1, updatedAt: 1 };
}
function context(nodes: Node[], sources: Map<string, string>, cached: boolean): ResolutionContext {
  const memo = new ResolutionTextCache();
  return {
    getNodesInFile: file => nodes.filter(n => n.filePath === file),
    getNodesByName: name => nodes.filter(n => n.name === name),
    getNodesByQualifiedName: name => nodes.filter(n => n.qualifiedName === name),
    getNodesByKind: kind => nodes.filter(n => n.kind === kind),
    getNodesByLowerName: name => nodes.filter(n => n.name.toLowerCase() === name),
    getAllFiles: () => [...sources.keys()], getProjectRoot: () => '/test',
    getImportMappings: () => [], fileExists: file => sources.has(file),
    readFile: file => sources.get(file) ?? null,
    ...(cached ? {
      getFileLines: (file: string) => sources.has(file) ? memo.fileLines(sources.get(file)!) : null,
      getNameWords: (name: string) => memo.nameWords(name),
    } : {}),
  };
}
function ref(line: number, filePath = 'main.cpp', name = 'obj.flush'): UnresolvedRef {
  return { fromNodeId: 'caller', filePath, language: 'cpp', referenceName: name,
    referenceKind: 'calls', line, column: 1 };
}

describe('text cache preserves resolution decisions', () => {
  it('preserves line-sensitive shadowing and notices a new source at the same path', () => {
    const nodes = [method('Alpha'), method('Beta')];
    const sources = new Map([['main.cpp', 'Alpha obj;\r\nobj.flush();\r\nBeta obj;\r\nobj.flush();']]);
    const plain = context(nodes, sources, false), cached = context(nodes, sources, true);
    for (const line of [4, 2, 4, 2]) {
      expect(matchMethodCall(ref(line), cached)).toEqual(matchMethodCall(ref(line), plain));
      expect(matchMethodCall(ref(line), cached)?.targetNodeId).toBe(line === 2 ? 'Alpha' : 'Beta');
    }
    sources.set('main.cpp', 'Beta obj;\nobj.flush();');
    expect(matchMethodCall(ref(2), cached)?.targetNodeId).toBe('Beta');
  });

  it('uses current header contents and preserves absent/empty-file fallback', () => {
    const nodes = [method('Alpha'), method('Beta')];
    const sources = new Map([['main.cpp', 'obj.flush();'], ['main.h', 'Alpha obj;']]);
    const plain = context(nodes, sources, false), cached = context(nodes, sources, true);
    expect(matchMethodCall(ref(1), cached)?.targetNodeId).toBe('Alpha');
    sources.set('main.h', 'Beta obj;');
    expect(matchMethodCall(ref(1), cached)?.targetNodeId).toBe('Beta');
    for (const value of ['', '\r\n']) {
      sources.set('main.cpp', value);
      expect(matchMethodCall(ref(1), cached)).toEqual(matchMethodCall(ref(1), plain));
    }
    sources.delete('main.cpp');
    expect(matchMethodCall(ref(1), cached)).toEqual(matchMethodCall(ref(1), plain));
  });

  it('does not cache graph-dependent auto receiver types or final targets', () => {
    const factory: Node = { ...method('Factory', 'factory'), name: 'create', qualifiedName: 'Factory::create', returnType: 'Alpha' };
    const nodes = [method('Alpha'), method('Beta'), factory];
    const sources = new Map([['main.cpp', 'auto obj = Factory::create();\nobj.flush();']]);
    const cached = context(nodes, sources, true);
    expect(matchMethodCall(ref(2), cached)?.targetNodeId).toBe('Alpha');
    factory.returnType = 'Beta';
    expect(matchMethodCall(ref(2), cached)?.targetNodeId).toBe('Beta');
  });

  it('preserves word case, candidate order and ties on repeated warm lookups', () => {
    const first = method('First::AudioWriter', 'first'), second = method('Second::AudioWriter', 'second');
    const sources = new Map<string, string>();
    for (const nodes of [[first, second], [second, first]]) {
      const plain = context(nodes, sources, false), cached = context(nodes, sources, true);
      const cachedWords = cached.getNameWords!('First::AudioWriter::flush');
      const originalWords = [...cachedWords];
      for (let i = 0; i < 4; i++) {
        const value = ref(1, 'main.cpp', 'audioWriter.flush');
        expect(matchMethodCall(value, cached)).toEqual(matchMethodCall(value, plain));
        expect(matchMethodCall(value, cached)?.targetNodeId).toBe(nodes[0]!.id);
      }
      expect(cachedWords).toEqual(originalWords);
    }
    expect(splitNameWords('XMLWriter_a')).toEqual(['XML', 'Writer']);
  });
});

describe('resolver text-cache lifecycle', () => {
  it('follows file-cache refill, missing-file changes and resolver invalidation', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-text-cache-'));
    const file = path.join(dir, 'main.cpp');
    const resolver = new ReferenceResolver(dir, {} as QueryBuilder);
    const internal = resolver as unknown as { context: ResolutionContext; fileCache: { clear(): void } };
    try {
      fs.writeFileSync(file, 'Alpha obj;\n');
      const first = internal.context.getFileLines!('main.cpp');
      expect(first).toEqual(['Alpha obj;', '']);
      expect(internal.context.getFileLines!('main.cpp')).toBe(first);
      fs.writeFileSync(file, 'Beta obj;\n');
      internal.fileCache.clear(); // A read cache eviction must not leave stale derived lines.
      expect(internal.context.getFileLines!('main.cpp')).toEqual(['Beta obj;', '']);
      const words = internal.context.getNameWords!('AudioWriter');
      resolver.clearCaches();
      expect(internal.context.getNameWords!('AudioWriter')).toEqual(words);
      expect(internal.context.getNameWords!('AudioWriter')).not.toBe(words);
      fs.unlinkSync(file);
      resolver.clearCaches();
      expect(internal.context.getFileLines!('main.cpp')).toBeNull();
    } finally {
      resolver.clearCaches();
      const resolved = path.resolve(dir);
      if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('cg-text-cache-')) throw new Error('Unsafe cleanup');
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  });
});
