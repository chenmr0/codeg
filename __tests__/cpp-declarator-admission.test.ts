import { beforeAll, describe, expect, it } from 'vitest';
import { extractFromSource } from '../src/extraction/tree-sitter';
import { loadGrammarsForLanguages } from '../src/extraction/grammars';
import { scanMacroContribution } from '../src/extraction/macro-scan';
import { selectUnambiguousCppMacroDefinitions } from '../src/extraction/declaration-macros';

beforeAll(async () => { await loadGrammarsForLanguages(['c', 'cpp']); });
function extract(source: string, extraNames: string[] = []) {
  const context = scanMacroContribution(source);
  return extractFromSource('neutral.hpp', source, 'cpp', undefined,
    new Set([...context.names, ...extraNames]), new Set(context.bodyless),
    selectUnambiguousCppMacroDefinitions(context.definitions));
}

describe('C/C++ declarator slots, independent of macro spelling', () => {
  it('does not promote a type alias or template parameter to a field on a global macro collision', () => {
    const nodes = extract('typedef unsigned Word;\nstruct Packet { Word value; Word *next; };\n'
      + 'template<class T> struct Box { T item; };', ['Word', 'T']).nodes;
    expect(nodes.filter(n => n.kind === 'field').map(n => n.qualifiedName)).toEqual([
      'Packet::value', 'Packet::next', 'Box::item',
    ]);
  });

  it('keeps genuine declarators sharing names with unrelated macros', () => {
    const nodes = extract('struct Packet { int Word; int (*invoke)(int); };\n'
      + 'typedef int Result; Result (invoke)(int value);', ['Word', 'invoke']).nodes;
    expect(nodes).toContainEqual(expect.objectContaining({kind:'field', name:'Word'}));
    expect(nodes).toContainEqual(expect.objectContaining({kind:'field', name:'invoke'}));
    expect(nodes).toContainEqual(expect.objectContaining({kind:'function', name:'invoke'}));
  });

  it.each(['int', 'Result'])('keeps a valid fully parenthesized %s function declarator', type => {
    const nodes = extract(`typedef int Result;\n${type} (invoke(int));`, ['invoke']).nodes;
    expect(nodes).toContainEqual(expect.objectContaining({kind:'function', name:'invoke'}));
  });

  it('keeps generated methods and members instead of object-macro placeholders', () => {
    const nodes = extract('#define DECL_QUERY int query() const\n#define MEMBERS int first; int second;\n'
      + 'struct Packet {\n DECL_QUERY;\n MEMBERS\n int tail;\n};').nodes;
    expect(nodes.filter(n => ['DECL_QUERY','MEMBERS'].includes(n.name)).every(n => n.kind === 'macro')).toBe(true);
    for (const name of ['first','second','tail']) expect(nodes).toContainEqual(expect.objectContaining({kind:'field', name}));
    expect(nodes).toContainEqual(expect.objectContaining({kind:'method', qualifiedName:'Packet::query'}));
  });

  it('does not invent fields for unresolved standalone member macros', () => {
    const nodes = extract('struct Packet {\n HEADER_A\n HEADER_B\n unsigned char tail;\n};\nint after;', ['HEADER_A','HEADER_B']).nodes;
    expect(nodes.filter(n => n.kind === 'field').map(n => n.name)).toEqual(['tail']);
    expect(nodes).toContainEqual(expect.objectContaining({kind:'struct', name:'Packet'}));
    expect(nodes).toContainEqual(expect.objectContaining({kind:'variable', name:'after'}));
  });

  it('rejects a macro argument misparsed as a function prototype', () => {
    const nodes = extract('#define INNER_KEY(x) (x + 1)\nOPTION(INNER_KEY(CODE))\n0;\nint after;').nodes;
    expect(nodes.filter(n => n.name === 'INNER_KEY').map(n => n.kind)).toEqual(['macro']);
    expect(nodes).toContainEqual(expect.objectContaining({kind:'variable', name:'after'}));
  });

  it('does not accept an empty preceding macro as the return type of a generated function', () => {
    const nodes = extract('#define END_CASE\n#define BEGIN_CASE(name) void name()\nEND_CASE\nBEGIN_CASE(check) {}').nodes;
    expect(nodes.filter(n => n.name === 'BEGIN_CASE').map(n => n.kind)).toEqual(['macro']);
    expect(nodes).toContainEqual(expect.objectContaining({kind:'function', name:'check', startLine:4}));
  });

  it('preserves declarations inside namespace and class templates', () => {
    const nodes = extract('namespace sample {\ntemplate<class T> struct Box { T get(); };\n'
      + 'template<class T> T Box<T>::get() { return {}; }\n}').nodes;
    expect(nodes).toContainEqual(expect.objectContaining({kind:'method', qualifiedName:'sample::Box<T>::get', startLine:3}));
  });

  it.each(['Box', 'inner::Box', 'outer::inner::Box'])('qualifies %s without duplicating namespace prefixes', owner => {
    const nodes = extract('namespace outer { namespace inner {\nstruct Box { int get(); };\n'
      + `int ${owner}::get() { return 1; }\n}}`).nodes;
    expect(nodes).toContainEqual(expect.objectContaining({kind:'method', qualifiedName:'outer::inner::Box::get', startLine:3}));
  });

  it('keeps an explicitly global receiver global', () => {
    const nodes = extract('struct Box { int get(); };\nnamespace unrelated {\nint ::Box::get() { return 1; }\n}').nodes;
    expect(nodes).toContainEqual(expect.objectContaining({kind:'method', qualifiedName:'Box::get', startLine:3}));
  });

  it('does not duplicate qualified definitions in a namespace when a damaged tree triggers text recovery', () => {
    const nodes = extract('namespace sample {\nstruct Box { int get(); };\n  int Box::get() { return 1; }\nint damaged = ;\n}').nodes;
    const definitions = nodes.filter(n => n.name === 'get' && !n.isDeclaration);
    expect(definitions).toHaveLength(1);
    expect(definitions[0]?.qualifiedName).toBe('sample::Box::get');
  });
});
