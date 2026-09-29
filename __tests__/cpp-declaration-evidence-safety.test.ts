import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import CodeGraph from '../src';
import { extractFromSource } from '../src/extraction/tree-sitter';
import { loadGrammarsForLanguages } from '../src/extraction/grammars';
import { scanMacroContribution } from '../src/extraction/macro-scan';
import { selectUnambiguousCppMacroDefinitions } from '../src/extraction/declaration-macros';

beforeAll(async () => { await loadGrammarsForLanguages(['c', 'cpp']); });
function extract(source: string, language: 'c' | 'cpp' = 'cpp', external = '') {
  const context = scanMacroContribution(source + '\n' + external);
  return extractFromSource(`neutral.${language === 'c' ? 'c' : 'hpp'}`, source, language, undefined,
    new Set(context.names), new Set(context.bodyless), selectUnambiguousCppMacroDefinitions(context.definitions));
}
const unrelated = '#define Result\n#define api(x) ((x) + 1)\n';

describe('C/C++ callable admission needs local macro evidence', () => {
  it.each(['c', 'cpp'] as const)('keeps declarations and definitions despite unrelated macro names (%s)', language => {
    const r = extract('typedef int Result;\nResult api(int);\nResult api(int x) { return x; }\n', language, unrelated);
    expect(r.nodes.filter(n => n.name === 'api' && n.kind === 'function')).toHaveLength(2);
  });
  it.each(['c', 'cpp'] as const)('keeps real API declarations with empty export prefixes (%s)', language => {
    const r = extract('#define API_EXPORT\nAPI_EXPORT int api(int value);\nAPI_EXPORT int api(int value) { return value; }', language,
      '#define api(value) external_api(value)\n');
    expect(r.nodes.filter(n => n.name === 'api' && n.kind === 'function')).toHaveLength(2);
  });
  it('keeps a real method with a return type colliding with an unrelated empty macro', () => {
    const r = extract('typedef int Result;\nstruct Box { Result api(int x) { return x; } };', 'cpp', unrelated);
    expect(r.nodes).toContainEqual(expect.objectContaining({kind:'method',qualifiedName:'Box::api'}));
  });
  it.each([
    '#define Result\n#define api(x) ((x)+1)\n#undef Result\n#undef api\n',
    '#if 0\n#define Result\n#define api(x) ((x)+1)\n#endif\n',
    '#define Result\n#define api(x) ((x)+1)\n#include "reset_macros.h"\n',
  ])('does not treat undef, conditional or include effects as proof (%s)', prefix => {
    const r = extract(prefix + 'typedef int Result;\nResult api(int x) { return x; }', 'cpp', unrelated);
    expect(r.nodes).toContainEqual(expect.objectContaining({kind:'function',name:'api'}));
  });
  it('does not borrow later macro definitions', () => {
    const r = extract('typedef int Result;\nResult api(int x) { return x; }\n' + unrelated);
    expect(r.nodes).toContainEqual(expect.objectContaining({kind:'function',name:'api'}));
  });
  it('still rejects a proven local closing macro wrapper and recovers the generated function', () => {
    const r = extract('#define END_CASE\n#define BEGIN_CASE(name) void name()\nEND_CASE\nBEGIN_CASE(check) {}');
    expect(r.nodes.filter(n => n.name === 'BEGIN_CASE').every(n => n.kind === 'macro')).toBe(true);
    expect(r.nodes).toContainEqual(expect.objectContaining({kind:'function',name:'check'}));
  });
});

describe('enum initializer evidence respects preprocessor branches', () => {
  it.each(['0','FEATURE'])('keeps a callable when enum and type appear in alternative branches (%s)', condition => {
    const r = extract(`#if ${condition}\nenum class Mode { ON };\n#else\nstruct Mode { using ON = int; };\n#endif\nvoid api(Mode::ON);`);
    expect(r.nodes).toContainEqual(expect.objectContaining({kind:'function',name:'api'}));
    expect(r.nodes.some(n => n.name === 'api' && n.kind === 'variable')).toBe(false);
  });
  it.each(['#else','#elif OTHER'])('does not carry enum evidence into a sibling branch (%s)', branch => {
    const r = extract(`#if FEATURE\nenum class Mode { ON };\n${branch}\nvoid api(Mode::ON);\n#endif`);
    expect(r.nodes).toContainEqual(expect.objectContaining({kind:'function',name:'api'}));
  });
  it('does not use a conditional enum outside its branch, including absolute qualification', () => {
    const r = extract('#if FEATURE\nnamespace n { enum class Mode { ON }; }\n#endif\nvoid api(::n::Mode::ON);');
    expect(r.nodes).toContainEqual(expect.objectContaining({kind:'function',name:'api'}));
  });
  it.each([
    'enum class Mode { ON };\nint object(Mode::ON);',
    '#ifndef API_H\n#define API_H\nenum class Mode { ON };\nint object(Mode::ON);\n#endif',
    '#if FEATURE\nenum class Mode { ON };\n#if DETAIL\nint object(Mode::ON);\n#endif\n#endif',
    '#if FEATURE\nint unrelated;\n#else\nenum class Mode { ON };\nint object(Mode::ON);\n#endif',
    '#if FEATURE\nint unrelated;\n#elif OTHER\nenum class Mode { ON };\nint object(Mode::ON);\n#endif',
  ])('retains valid enum-initializer recovery with compatible branch evidence (%s)', source => {
    expect(extract(source).nodes).toContainEqual(expect.objectContaining({kind:'variable',name:'object'}));
  });
});

describe('evidence safety through persisted init and sync', () => {
  it('preserves the real call target across index, no-change sync and source edits', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-evidence-'));
    let graph: CodeGraph | undefined;
    try {
      fs.writeFileSync(path.join(root,'unrelated.h'), unrelated);
      const write = (number: number) => fs.writeFileSync(path.join(root,'api.cpp'),
        `typedef int Result;\nResult api(int value) { return value + ${number}; }\nint caller() { return api(1); }\n`);
      write(0); graph = CodeGraph.initSync(root);
      const indexed = await graph.indexAll(); expect(indexed.complete).not.toBe(false);
      const verify = () => {
        const db = (graph as any).db.db;
        const targets = db.prepare("SELECT n.kind,n.file_path FROM edges e JOIN nodes n ON n.id=e.target WHERE e.kind='calls'").all();
        expect(targets).toEqual([expect.objectContaining({kind:'function',file_path:'api.cpp'})]);
      };
      verify(); const noop = await graph.sync(); expect(noop.filesModified).toBe(0); verify();
      write(1); const synced = await graph.sync({paths:['api.cpp']}); expect(synced.filesErrored).toBe(0); verify();
    } finally { graph?.close(); fs.rmSync(root,{recursive:true,force:true}); }
  });
  it('retains conditional type declarations through index and changed-file sync', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-enum-evidence-'));
    let graph: CodeGraph | undefined;
    try {
      const file = path.join(root,'api.hpp');
      const source = '#if 0\nenum class Mode { ON };\n#else\nstruct Mode { using ON = int; };\n#endif\nvoid api(Mode::ON);\n';
      fs.writeFileSync(file,source); graph=CodeGraph.initSync(root); await graph.indexAll();
      expect(graph.getNodesByName('api')).toContainEqual(expect.objectContaining({kind:'function'}));
      fs.writeFileSync(file,source+'int extra;\n'); await graph.sync({paths:['api.hpp']});
      expect(graph.getNodesByName('api')).toContainEqual(expect.objectContaining({kind:'function'}));
      expect(graph.getNodesByName('api').some(n=>n.kind==='variable')).toBe(false);
    } finally { graph?.close(); fs.rmSync(root,{recursive:true,force:true}); }
  });
});
