import { beforeAll, describe, expect, it } from 'vitest';
import { extractFromSource } from '../src/extraction/tree-sitter';
import { loadGrammarsForLanguages } from '../src/extraction/grammars';

beforeAll(async () => { await loadGrammarsForLanguages(['c', 'cpp']); });
const extract = (source: string, language: 'c' | 'cpp' = 'cpp') =>
  extractFromSource(`neutral.${language === 'c' ? 'c' : 'hpp'}`, source, language).nodes;

describe('declaration names backed by their own declarators', () => {
  it.each(['c', 'cpp'] as const)('preserves pointer, array and function aliases without inventing the source type (%s)', language => {
    const nodes = extract('typedef unsigned Word;\ntypedef Word A, *B, C[4], (*Fn)(int arg);', language);
    expect(nodes.filter(n => n.kind === 'type_alias').map(n => n.name).sort()).toEqual(['A','B','C','Fn','Word']);
    expect(nodes.filter(n => n.name === 'Word')).toHaveLength(1);
  });
  it.each(['c', 'cpp'] as const)('unwraps the first array and function-pointer alias (%s)', language => {
    const nodes = extract('typedef int Values[4];\ntypedef int (*Callback)(int arg);', language);
    expect(nodes.filter(n => n.kind === 'type_alias').map(n => n.name)).toEqual(['Values','Callback']);
  });
  it('preserves tags as types instead of aliases', () => {
    const nodes = extract('typedef struct Tag *Ptr, **PP;\ntypedef union Choice { int x; } Alias, Other;');
    expect(nodes).toContainEqual(expect.objectContaining({kind:'struct',name:'Tag',isDeclaration:true}));
    expect(nodes).toContainEqual(expect.objectContaining({kind:'struct',name:'Choice'}));
    expect(nodes.filter(n => n.kind === 'type_alias').map(n => n.name).sort()).toEqual(['Other','PP','Ptr']);
    expect(nodes).toContainEqual(expect.objectContaining({kind:'field',qualifiedName:'Alias::x'}));
  });
  it('retains each name in a multi-function declaration', () => {
    const nodes = extract('int first(int), second(double);\nint *third(), *fourth();', 'c');
    for (const name of ['first','second','third','fourth']) {
      expect(nodes.filter(n => n.name === name && n.kind === 'function')).toHaveLength(1);
    }
  });
  it('does not reuse the first name for prototypes in a damaged declaration', () => {
    const source = 'static void clear(int *p) {\n *p = 0;\n}\n'
      + '#if defined(A)\nstatic int ABI compare(void *ctx, const void *a, const void *b) {\n'
      + '#elif defined(B)\nstatic int compare(const void *a, const void *b, void *ctx) {\n'
      + '#else\nstatic int compare(const void *a, const void *b) {\n#endif\nreturn 0;\n}';
    const nodes = extract(source, 'c');
    expect(nodes.filter(n => n.name === 'clear')).toHaveLength(1);
    expect(nodes.filter(n => n.name === 'compare').length).toBeGreaterThan(0);
    for (const n of nodes.filter(n => n.kind === 'function')) {
      expect(source.split('\n')[n.startLine - 1]).toContain(n.name);
    }
  });
});

describe('enum-value initialization versus callable declarations', () => {
  it('keeps directly initialized objects with known scoped enum arguments', () => {
    const nodes = extract('namespace sample {\nstruct Item { enum Mode { ON, OFF }; };\n'
      + 'static const Item active(Item::Mode::ON);\nItem other(Item::Mode::OFF);\n'
      + 'void accept(Item::Mode);\nvoid accept(Item::Mode value);\nItem factory();\n}');
    expect(nodes).toContainEqual(expect.objectContaining({kind:'constant',qualifiedName:'sample::active'}));
    expect(nodes).toContainEqual(expect.objectContaining({kind:'variable',qualifiedName:'sample::other'}));
    expect(nodes.filter(n => ['active','other'].includes(n.name)).every(n => n.kind !== 'function')).toBe(true);
    expect(nodes.filter(n => n.name === 'accept' && n.kind === 'function')).toHaveLength(2);
    expect(nodes).toContainEqual(expect.objectContaining({kind:'function',name:'factory'}));
  });
  it('does not confuse a different scope with an enum value, and handles absolute qualification', () => {
    const nodes = extract('namespace a { enum class Mode { ON }; }\n'
      + 'namespace b { struct Mode { using ON = int; };\nint valid(Mode::ON);\n'
      + 'int initialized(::a::Mode::ON);\n}');
    expect(nodes).toContainEqual(expect.objectContaining({kind:'function',name:'valid'}));
    expect(nodes).toContainEqual(expect.objectContaining({kind:'variable',name:'initialized'}));
  });
  it('preserves unknown qualified parameter types and normal direct initialization', () => {
    const nodes = extract('Item api(External::Type);\nItem item(42);');
    expect(nodes).toContainEqual(expect.objectContaining({kind:'function',name:'api'}));
    expect(nodes).toContainEqual(expect.objectContaining({kind:'variable',name:'item'}));
  });
  it('respects a nearer type shadowing an outer enum owner', () => {
    const nodes = extract('enum class Mode { ON };\nnamespace local {\n'
      + 'struct Mode { using ON = int; };\nint api(Mode::ON);\n}');
    expect(nodes).toContainEqual(expect.objectContaining({kind:'function',name:'api'}));
    expect(nodes.some(n => n.name === 'api' && n.kind === 'variable')).toBe(false);
  });
});
