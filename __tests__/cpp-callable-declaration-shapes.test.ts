import { beforeAll, describe, expect, it } from 'vitest';
import { extractFromSource } from '../src/extraction/tree-sitter';
import { loadGrammarsForLanguages } from '../src/extraction/grammars';
import { scanMacroContribution } from '../src/extraction/macro-scan';
import { selectUnambiguousCppMacroDefinitions } from '../src/extraction/declaration-macros';

beforeAll(async () => { await loadGrammarsForLanguages(['cpp']); });
function extract(source: string) {
  const context = scanMacroContribution(source);
  return extractFromSource('callables.cpp', source, 'cpp', undefined, new Set(context.names),
    new Set(context.bodyless), selectUnambiguousCppMacroDefinitions(context.definitions));
}
const fixtures = [
  ['array reference', '', 'template<class T> int run(T (&p)[3]);', 'template<class U> int run(U (&q)[3]){return q[0];}'],
  ['callback alias', 'using Int=int;', 'int run(int (*p)(Int));', 'int run(int (*q)(signed)){return q(7);}'],
  ['callback builtin', '', 'int run(int (*p)(signed));', 'int run(int (*q)(int)){return q(7);}'],
  ['member callback alias', 'struct C{}; using Owner=C;', 'int run(int (Owner::*p)(signed));', 'int run(int (::C::*q)(int)){return 7;}'],
];
describe('C++ callable declaration grammar ambiguities', () => {
  it.each(fixtures)('extracts the plain %s declaration as a callable', (_, prefix, declaration, definition) => {
    const result = extract(`${prefix}\n${declaration}\n${definition}\n`);
    expect(result.errors).toEqual([]);
    const nodes = result.nodes.filter(n => n.name === 'run');
    expect(nodes).toHaveLength(2);
    expect(nodes.map(n => n.kind)).toEqual(['function', 'function']);
    expect(nodes[0].isDeclaration).toBe(true);
    expect(nodes[0].startLine).toBe(2);
    expect(nodes[0].signature).toContain('run(');
  });
  it.each(fixtures)('coalesces the macro %s declaration with its definition', (_, prefix, declaration, definition) => {
    const result = extract(`${prefix}\n#define MAKE() ${declaration} ${definition}\nMAKE()\n`);
    expect(result.errors).toEqual([]);
    const nodes = result.nodes.filter(n => n.name === 'run');
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe('function');
    expect(nodes[0].isDeclaration).not.toBe(true);
  });
  it('keeps member callback cv overloads with anonymous parameters', () => {
    const result = extract('struct C{int f(int); int g(int)const;}; using Owner=C;\n'
      + '#define MAKE() constexpr int run(int (Owner::*)(int)){return 1;} constexpr int run(int (C::*)(int)const){return 2;}\nMAKE()\n');
    const nodes = result.nodes.filter(n => n.name === 'run');
    expect(nodes).toHaveLength(2);
    expect(nodes.every(n => n.kind === 'function' && !n.isDeclaration)).toBe(true);
    expect(new Set(nodes.map(n => n.id)).size).toBe(2);
    expect(nodes.some(n => n.signature?.includes('(C::*)(int)const'))).toBe(true);
  });
  it('preserves class methods with array and callback parameters', () => {
    const result = extract('using Int=int; struct C { int run(int (*p)(Int)); int array(int (&p)[3]); };');
    expect(result.nodes.filter(n => n.kind === 'method').map(n => n.name)).toEqual(['run', 'array']);
  });
  it('retains comment gaps and UTF-16 source positions after multiple repairs', () => {
    const source = 'const char* label="中文";\n'
      + 'template<class T> int run(T /*a*/ (/*b*/ &p /*c*/)[3]); '
      + 'template<class U> int other(U (&q)[4]); int tail;\nstruct Later {};\n';
    const nodes = extract(source).nodes;
    expect(nodes.filter(n => ['run', 'other'].includes(n.name)).every(n => n.kind === 'function' && n.isDeclaration)).toBe(true);
    expect(nodes.find(n => n.name === 'run')?.signature).toContain('/*b*/ &p /*c*/');
    expect(nodes.find(n => n.name === 'tail')).toMatchObject({kind:'variable', startLine:2,
      startColumn:source.split('\n')[1].indexOf('tail')});
    expect(nodes.find(n => n.name === 'Later')).toMatchObject({kind:'struct', startLine:3});
  });
  it('keeps function and member-pointer objects as variables', () => {
    const nodes = extract('struct C {}; int (*callback)(int); int (C::*member)(int);').nodes;
    for (const name of ['callback', 'member']) expect(nodes.find(n => n.name === name)?.kind, name).toBe('variable');
  });
  it.each([
    'namespace inner { int* T(int*); } namespace inner { int x; int direct(T(&x)[3]); }',
    'namespace inner {\n#if 1\nint* T(int*);\n#endif\nint x; int direct(T(&x)[3]); }',
  ])('does not use an outer alias across reopened/conditional value scope: %s', body => {
    const nodes = extract(`using T=int; ${body}`).nodes;
    expect(nodes.find(n => n.name === 'direct')?.kind).toBe('variable');
  });
  it('does not reinterpret real direct initializers or locally shadowed values', () => {
    const source = 'struct Callable { int operator()(int); }; Callable maker(int);\n'
      + 'int value=1; int result((maker(value)(value)));\n'
      + 'enum class Mode{ON}; struct Widget{Widget(Mode);}; Widget selected(Mode::ON);\n'
      + 'using T=int; namespace inner { int* T(int*); int x; int direct(T(&x)[3]); }\n';
    const nodes = extract(source).nodes;
    for (const name of ['result', 'selected', 'direct']) {
      expect(nodes.find(n => n.name === name)?.kind, name).toBe('variable');
    }
  });
});
