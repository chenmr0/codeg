import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { synthesizeCallbackEdges } from '../src/resolution/callback-synthesizer';
import type { ResolutionContext } from '../src/resolution/types';
import type { Language, Node } from '../src/types';

describe('synthesis language gates in mixed projects', () => {
  it('retains trailing closures and JSX/templates without treating C++ text as either', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-synthesis-gates-'));
    const connection = DatabaseConnection.initialize(path.join(directory, 'graph.db'));
    const queries = new QueryBuilder(connection.getDb());
    const sources = new Map<string, string>();
    const nodes: Node[] = [];
    const add = (name: string, language: Language, source: string) => {
      const filePath = `${name}.${language}`;
      const node: Node = { id: name, name, qualifiedName: name, language, filePath,
        kind: 'function', startLine: 1, endLine: 1, startColumn: 0,
        endColumn: source.length, updatedAt: 1 };
      nodes.push(node);
      sources.set(filePath, source);
      queries.upsertFile({ path: filePath, language, size: source.length,
        contentHash: name, modifiedAt: 1, indexedAt: 1, nodeCount: 1 });
    };
    add('swiftDispatch', 'swift', 'callbacks.forEach { $0() }');
    add('swiftRegister', 'swift', 'callbacks.append(handler)');
    add('kotlinDispatch', 'kotlin', 'actions.forEach { it() }');
    add('kotlinRegister', 'kotlin', 'actions.add(handler)');
    add('cppRegister', 'cpp', 'callbacks.push(handler); actions.push(handler);');
    add('cppTemplate', 'cpp', 'const char *example = "<Child/>";');
    add('Child', 'tsx', 'function Child() {}');
    for (const language of ['typescript', 'javascript', 'tsx', 'jsx', 'vue', 'svelte'] as const) {
      add(`parent_${language}`, language, '<Child/>');
    }
    queries.insertNodes(nodes);
    const ctx: ResolutionContext = {
      getNodesInFile: file => nodes.filter(n => n.filePath === file),
      getNodesByName: name => nodes.filter(n => n.name === name),
      getNodesByQualifiedName: name => nodes.filter(n => n.qualifiedName === name),
      getNodesByKind: kind => nodes.filter(n => n.kind === kind),
      getNodesByLowerName: name => nodes.filter(n => n.name.toLowerCase() === name),
      getAllFiles: () => [...sources.keys()], getProjectRoot: () => directory,
      getImportMappings: () => [], fileExists: file => sources.has(file),
      readFile: file => sources.get(file) ?? null,
    };
    try {
      const result = await synthesizeCallbackEdges(queries, ctx);
      expect(result.complete).toBe(true);
      const rows = connection.getDb().prepare(
        `SELECT source, target, json_extract(metadata, '$.synthesizedBy') AS pass
         FROM edges WHERE json_extract(metadata, '$.synthesizedBy') IN ('closure-collection', 'jsx-render')`
      ).all();
      expect(rows.filter((row: any) => row.pass === 'closure-collection')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: 'swiftDispatch', target: 'swiftRegister' }),
          expect.objectContaining({ source: 'kotlinDispatch', target: 'kotlinRegister' }),
        ])
      );
      expect(rows.some((row: any) => row.target === 'cppRegister' || row.source === 'cppTemplate')).toBe(false);
      for (const language of ['typescript', 'javascript', 'tsx', 'jsx', 'vue', 'svelte']) {
        expect(rows).toContainEqual({ source: `parent_${language}`, target: 'Child', pass: 'jsx-render' });
      }
    } finally {
      connection.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
