import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { ReferenceResolver } from '../src/resolution';
import { ResolverPool } from '../src/resolution/resolver-pool';
import { withLanguageScope } from '../src/extraction/language-scope';
import {
  detectFrameworks, getAllFrameworkResolvers, getApplicableFrameworks,
} from '../src/resolution/frameworks';
import { synthesizeCallbackEdges } from '../src/resolution/callback-synthesizer';
import type { FrameworkResolver, ResolutionContext } from '../src/resolution/types';
import type { Language, Node } from '../src/types';

const disposers: Array<() => void> = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dispose of disposers.splice(0).reverse()) dispose();
});

function graph() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-resolution-scope-'));
  const connection = DatabaseConnection.initialize(path.join(directory, 'graph.db'));
  const queries = new QueryBuilder(connection.getDb());
  disposers.push(() => {
    connection.close();
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
        !path.basename(resolved).startsWith('cg-resolution-scope-')) {
      throw new Error('Unexpected test directory');
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const context: ResolutionContext = {
    getNodesInFile: (file) => queries.getNodesByFile(file),
    getNodesByName: (name) => queries.getNodesByName(name),
    getNodesByQualifiedName: (name) => queries.getNodesByQualifiedNameExact(name),
    getNodesByKind: (kind) => queries.getNodesByKind(kind),
    getNodesByLowerName: () => [],
    getAllFiles: () => queries.getAllFilePaths(),
    getProjectRoot: () => directory,
    getImportMappings: () => [], fileExists: () => false, readFile: () => null,
  };
  return { queries, context, directory };
}

describe('resolution language scope', () => {
  it('does not call disabled framework detectors and restores them in all mode', () => {
    const { context } = graph();
    const registry = getAllFrameworkResolvers();
    const detectors = new Map(registry.map((framework) => [
      framework.name, vi.spyOn(framework, 'detect').mockReturnValue(true),
    ]));
    vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', '0');
    expect(detectFrameworks(context).map((framework) => framework.name)).toEqual([
      'django', 'flask', 'fastapi', 'swift-objc-bridge', 'react-native-bridge', 'fabric-view',
    ]);
    for (const name of ['react', 'vue', 'svelte', 'nestjs', 'spring', 'rust', 'go', 'rails']) {
      expect(detectors.get(name)).not.toHaveBeenCalled();
    }
    // The ObjC half still needs native RN/Fabric macro extraction.
    expect(getApplicableFrameworks(registry, 'objc').map((framework) => framework.name)).toEqual([
      'swift-objc-bridge', 'react-native-bridge', 'fabric-view',
    ]);
    expect(getApplicableFrameworks(registry, 'typescript')).toEqual([]);
    vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', '1');
    expect(detectFrameworks(context)).toEqual(registry);
    for (const detector of detectors.values()) expect(detector).toHaveBeenCalled();
    // Vue's original universal applicability is preserved in all mode.
    expect(getApplicableFrameworks(registry, 'python').some((framework) => framework.name === 'vue')).toBe(true);
  });

  it('refreshes framework contexts on scope changes and filters post-extract output', () => {
    const { queries, directory } = graph();
    const registry = getAllFrameworkResolvers();
    const original = registry.slice();
    disposers.push(() => registry.splice(0, registry.length, ...original));
    const node = (id: string, language: Language): Node => ({
      id, language, name: id, qualifiedName: id, kind: 'function', filePath: `${id}.${language}`,
      startLine: 1, endLine: 1, startColumn: 0, endColumn: 1,
    });
    const python = node('python-handler', 'python');
    const javascript = node('javascript-handler', 'javascript');
    queries.insertNodes([python, javascript]);
    const universal: FrameworkResolver = {
      name: 'scope-test-universal', detect: () => true, resolve: () => null,
      postExtract: vi.fn(() => [python, javascript]),
    };
    const jsOnly: FrameworkResolver = {
      name: 'scope-test-js', languages: ['javascript'], detect: vi.fn(() => true),
      resolve: () => null, postExtract: vi.fn(() => [javascript]),
    };
    registry.splice(0, registry.length, universal, jsOnly);
    vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', '1');
    const resolver = new ReferenceResolver(directory, queries);
    resolver.initialize();
    const contextBefore = (resolver as unknown as { context: ResolutionContext }).context;
    expect(resolver.getDetectedFrameworks()).toEqual([universal.name, jsOnly.name]);
    expect(resolver.runPostExtract()).toBe(3);
    vi.mocked(jsOnly.detect).mockClear();
    vi.mocked(jsOnly.postExtract!).mockClear();
    const updates = vi.spyOn(queries, 'updateNode');
    vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', '0');
    expect(resolver.runPostExtract()).toBe(1);
    expect(updates.mock.calls.map(([updated]) => updated.language)).toEqual(['python']);
    expect(jsOnly.detect).not.toHaveBeenCalled();
    expect(jsOnly.postExtract).not.toHaveBeenCalled();
    expect((resolver as unknown as { context: ResolutionContext }).context).not.toBe(contextBefore);
    vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', '1');
    expect(resolver.getDetectedFrameworks()).toEqual([universal.name, jsOnly.name]);
    expect(jsOnly.detect).toHaveBeenCalledOnce();
  });

  it('skips disabled synthesis passes while keeping C/C++ and generic callbacks', async () => {
    const { queries, context } = graph();
    const languages: Language[] = [
      'c', 'cpp', 'objc', 'python', 'lua', 'swift', 'kotlin', 'javascript',
      'typescript', 'vue', 'svelte', 'dart', 'pascal', 'go', 'java', 'xml',
    ];
    for (const language of languages) {
      queries.upsertFile({ path: `input.${language}`, language, contentHash: language,
        size: 1, modifiedAt: 1, indexedAt: 1, nodeCount: 0 });
    }
    vi.stubEnv('CODEGRAPH_NO_SYNTHESIS', '0');
    vi.stubEnv('CODEGRAPH_SYNTH_TIMINGS', '1');
    vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', '0');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect((await synthesizeCallbackEdges(queries, context)).complete).toBe(true);
    const stages = () => log.mock.calls.map(([message]) =>
      String(message).match(/^\[synth-timing\] ([^:]+):/)?.[1]).filter(Boolean);
    expect(stages()).toEqual([
      'fieldEdges', 'emitterEdges', 'renderEdges', 'cppEdges', 'cppDeclDef',
      'cDeclDef', 'varDeclDef', 'fabricNativeEdges',
    ]);
    log.mockClear();
    vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', '1');
    expect((await synthesizeCallbackEdges(queries, context)).complete).toBe(true);
    expect(stages()).toEqual(expect.arrayContaining([
      'closureCollEdges', 'jsxEdges', 'vueEdges', 'svelteKitEdges', 'pascalEdges',
      'flutterEdges', 'ifaceEdges', 'kotlinExpectActual', 'goGrpcEdges',
      'rnEventEdgesList', 'expoXPlatEdges', 'rnXPlatEdges', 'mybatisEdges', 'ginEdges',
    ]));
  });

  it.each([['1', '0'], ['0', '1']])('keeps worker scope %s when ambient env changes to %s', async (captured, changed) => {
    const { directory } = graph();
    const workerPath = path.join(directory, 'scope-worker.cjs');
    fs.writeFileSync(workerPath, `
      const { parentPort } = require('node:worker_threads');
      parentPort.on('message', message => {
        if (message.type === 'open') parentPort.postMessage({ type: 'ready' });
        if (message.type === 'resolve') parentPort.postMessage({
          type: 'result', id: message.id, result: {
            resolved: [], deferredChain: [], byMethod: {},
            unresolved: [{ ...message.refs[0], referenceName: process.env.CODEGRAPH_ALL_LANGUAGES }],
          },
        });
      });
    `);
    vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', captured);
    await withLanguageScope(async () => {
      vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', changed);
      // Use the real pool constructor and worker message path with a tiny
      // fixture; automatic pool sizing/database startup is not under test.
      const Pool = ResolverPool as unknown as {
        new(script: string, database: string, root: string, size: number): ResolverPool;
      };
      const pool = new Pool(workerPath, 'unused', directory, 1);
      try {
        await pool.ready();
        const result = await pool.resolveBatch([{
          fromNodeId: 'source', referenceName: 'target', referenceKind: 'calls',
          line: 1, column: 0, filePath: 'source.cpp', language: 'cpp',
        }]);
        expect(result.unresolved[0]?.referenceName).toBe(captured);
      } finally {
        await pool.destroy();
      }
    });
  });
});
