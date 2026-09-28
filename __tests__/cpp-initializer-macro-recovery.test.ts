import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
import { scanCppMacroDefinitions, preservesInitializerBoundary } from '../src/extraction/declaration-macros';
import { extractFromSource } from '../src/extraction/tree-sitter';
import { loadGrammarsForLanguages } from '../src/extraction/grammars';

beforeAll(async () => { await loadGrammarsForLanguages(['c', 'cpp']); });
const poison = '#define illegal util::stream_format(stream, "Illegal")';
const defs = scanCppMacroDefinitions(poison);
const names = new Set(['OP', 'illegal', 'BRIDGE', 'DECL']);
const source = '#define OP(x) &Device::x\nconst void *table[] = { OP(illegal), OP(legal) };\n';
const extract = (code: string, language: 'c' | 'cpp' = 'cpp') =>
  extractFromSource(`table.${language}`, code, language, undefined, names, new Set(), defs);

describe('initializer macro declaration recovery boundary', () => {
  it('keeps the T11 expression table on the primary parse under unrelated project macros', () => {
    const before = extractFromSource('table.cpp', source, 'cpp', undefined, names, new Set());
    const result = extract(source);
    expect(result.errors).toEqual([]);
    expect(result.timings?.declarationMacroAuxParseMs).toBeUndefined();
    expect(result.timings?.declarationMacroRecoverySourceMs).toBeUndefined();
    const stable = (r: typeof result) => ({
      nodes: r.nodes.map(({ updatedAt, ...node }) => node),
      edges: r.edges, refs: r.unresolvedReferences,
    });
    expect(stable(result)).toEqual(stable(before));
    expect(result.nodes.some(n => n.name === 'table')).toBe(true);
  });

  it.each(['c', 'cpp'] as const)('preserves a structural bridge out of a healthy %s initializer', language => {
    const result = extract('#define BRIDGE(name) 0 }; int name; int more[] = { 0\nint table[] = { BRIDGE(real), 1 };', language);
    expect(result.nodes.map(n => n.name)).toEqual(expect.arrayContaining(['table', 'real', 'more']));
    expect(result.errors).toEqual([]);
  });

  it('keeps same-line and namespace declaration macros beside nested expression tables', () => {
    const result = extract('#define OP(x) &Device::x\n#define DECL(n) int n;\nnamespace demo {\nint keep; DECL(real)\nconst void *table[][2] = { { OP(illegal), OP(legal) } };\nDECL(after)\n}');
    for (const name of ['keep', 'real', 'table', 'after']) {
      expect(result.nodes.some(n => n.name === name && n.qualifiedName === `demo::${name}`)).toBe(true);
    }
    expect(result.nodes.some(n => n.name === 'stream_format')).toBe(false);
    expect(result.errors).toEqual([]);
  });

  it.each([
    '&Device::util::stream_format(stream, "Illegal")',
    '((foo[2]) + 1)', 'call("} ; #", 1)', 'a /* } ; */ + b',
  ])('proves a bounded replacement: %s', replacement => {
    expect(preservesInitializerBoundary(replacement)).toBe(true);
  });
  it.each([
    '0 }; int real; int more[] = { 0', 'int real;', '[] { return 1; }()',
    'foo)', '(foo', '[foo)', 'foo[1', '"unterminated', '/* unterminated',
    'foo // tail', 'R"(raw)"', 'foo\\\nbar', '??> int real;',
    '0 %>; int real; int more[] = <%', ':> + foo<:', '#include "more.h"', '',
    '%:include "more.h"',
  ])('retains recovery for structural or uncertain replacement: %s', replacement => {
    expect(preservesInitializerBoundary(replacement)).toBe(false);
  });
});

let directory: string | undefined;
let graph: CodeGraph | undefined;
afterEach(() => {
  graph?.close(); graph = undefined;
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

it('indexes a polluted table, then completes repeated no-change syncs without re-extraction', async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-initializer-retry-'));
  fs.writeFileSync(path.join(directory, 'table.cpp'), source);
  fs.writeFileSync(path.join(directory, 'unrelated.cpp'), poison + '\nint other;\n');
  graph = CodeGraph.initSync(directory);
  const initial = await graph.indexAll();
  expect(initial.complete).toBe(true);
  expect(initial.errors).toEqual([]);
  // An existing incomplete index is allowed one real recovery, not silently
  // marked complete or permanently skipped just because source bytes match.
  const queries = (graph as any).queries;
  queries.upsertFile({ ...queries.getFileByPath('table.cpp'), errors: [{ severity: 'warning',
    code: 'declaration_macro_recovery_skipped', message: 'Previous timeout' }] });
  const recovered = await graph.sync();
  expect(recovered.filesModified).toBe(1);
  expect(recovered.complete).toBe(true);
  expect(queries.getFileByPath('table.cpp').errors ?? []).toEqual([]);
  for (let i = 0; i < 2; i++) {
    graph.close();
    graph = CodeGraph.openSync(directory);
    const sync = await graph.sync();
    expect(sync.complete).toBe(true);
    expect(sync.filesModified + sync.filesAdded + sync.filesErrored).toBe(0);
  }
  // A real input change must still re-extract and recover a structural macro.
  fs.writeFileSync(path.join(directory, 'table.cpp'), source +
    '#define BRIDGE(n) 0 }; int n; int more[] = { 0\nint next[] = { BRIDGE(recovered), 1 };\n');
  const changed = await graph.sync();
  expect(changed.filesModified).toBe(1);
  expect(changed.complete).toBe(true);
  expect(graph.getNodesByName('recovered')).toHaveLength(1);
});
