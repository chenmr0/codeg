import { beforeAll, describe, expect, it } from 'vitest';
import { extractFromSource } from '../src/extraction/tree-sitter';
import { loadGrammarsForLanguages } from '../src/extraction/grammars';
import { scanMacroContribution } from '../src/extraction/macro-scan';
import { selectUnambiguousCppMacroDefinitions } from '../src/extraction/declaration-macros';

beforeAll(() => loadGrammarsForLanguages(['cpp']));

function extract(replacement: string, invocation = 'MAKE()') {
  const source = `#define MAKE() ${replacement}\n${invocation}\n`;
  const context = scanMacroContribution(source);
  const result = extractFromSource('identity.hpp', source, 'cpp', undefined,
    new Set(context.names), new Set(context.bodyless), selectUnambiguousCppMacroDefinitions(context.definitions));
  expect(result.errors).toEqual([]);
  expect(new Set(result.nodes.map(n => n.id)).size).toBe(result.nodes.length);
  const ids = new Set(result.nodes.map(n => n.id));
  for (const edge of result.edges) {
    expect(ids.has(edge.source)).toBe(true);
    expect(ids.has(edge.target)).toBe(true);
  }
  return result;
}

describe('identities of symbols sharing a macro invocation line', () => {
  it.each([
    'int run(int value) { return value; } int run(double value);',
    'int run(double value); int run(int value) { return value; }',
    'int run(int value) { return value; } double run(double value) { return value; }',
  ])('keeps distinct overloads: %s', replacement => {
    const functions = extract(replacement).nodes.filter(n => n.name === 'run');
    expect(functions).toHaveLength(2);
    expect(functions.filter(n => n.signature?.includes('int value'))).toHaveLength(1);
    expect(functions.filter(n => n.signature?.includes('double value'))).toHaveLength(1);
  });

  it('keeps a constructor definition and a distinct copy-constructor declaration', () => {
    const nodes = extract('struct Item { Item() {} Item(const Item&); };').nodes.filter(n => n.kind === 'method');
    expect(nodes).toHaveLength(2);
    expect(nodes).toContainEqual(expect.objectContaining({signature:'Item()', isDeclaration:undefined}));
    expect(nodes).toContainEqual(expect.objectContaining({signature:'Item(const Item&)', isDeclaration:true}));
  });

  it('merges static information only into the matching overload', () => {
    const result = extract('class Owner { static int run(int); int run(double); }; '
      + 'int Owner::run(int value) { return value; } int Owner::run(double value) { return 0; }');
    const methods = result.nodes.filter(n => n.kind === 'method');
    expect(methods).toHaveLength(2);
    expect(methods.find(n => n.signature?.includes('int value'))).toMatchObject({isStatic:true});
    expect(methods.find(n => n.signature?.includes('double value'))?.isStatic).not.toBe(true);
    expect(methods.every(n => n.isDeclaration !== true)).toBe(true);
  });

  it('keeps same-name methods and fields under their own classes', () => {
    const result = extract('struct A { int field; void run(); }; struct B { int field; void run(); };');
    for (const owner of ['A','B']) {
      const parent = result.nodes.find(n => n.qualifiedName === owner)!;
      const children = result.edges.filter(e => e.kind === 'contains' && e.source === parent.id)
        .map(e => result.nodes.find(n => n.id === e.target)!.qualifiedName).sort();
      expect(children).toEqual([`${owner}::field`,`${owner}::run`]);
    }
  });

  it('matches a specialized template member definition to its static declaration', () => {
    const methods = extract('template<class T, class U> struct Owner; '
      + 'template<class U> struct Owner<int, U> { static int run(U value); }; '
      + 'template<class U> int Owner<int, U>::run(U input) { return 1; }').nodes.filter(n => n.kind === 'method');
    expect(methods).toHaveLength(1);
    expect(methods[0]?.isStatic).toBe(true);
    expect(methods[0]?.isDeclaration).not.toBe(true);
  });

  it('matches a primary template member to its out-of-line definition', () => {
    const methods = extract('template<class T> struct Box { static int run(T); }; '
      + 'template<class T> int Box<T>::run(T value) { return 1; }').nodes.filter(n => n.kind === 'method');
    expect(methods).toHaveLength(1);
    expect(methods[0]?.isStatic).toBe(true);
    expect(methods[0]?.isDeclaration).not.toBe(true);
  });

  it.each([
    'int run(const int value); int run(int input) { return input; }',
    'int run(int *const value); int run(int *input) { return 0; }',
  ])('ignores top-level parameter cv in redeclarations: %s', replacement => {
    const nodes = extract(replacement).nodes.filter(n => n.name === 'run');
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.isDeclaration).not.toBe(true);
  });

  it('preserves pointed-to cv and function-template overloads', () => {
    expect(extract('int run(const int*); int run(int*);').nodes.filter(n => n.name === 'run')).toHaveLength(2);
    expect(extract('template<class T> int run(int); int run(int);').nodes.filter(n => n.name === 'run')).toHaveLength(2);
  });

  it('separates template specializations and their members', () => {
    const result = extract('template<class T> struct Box; '
      + 'template<> struct Box<int> { int value; void run(); }; '
      + 'template<> struct Box<double> { int value; void run(); };');
    for (const owner of ['Box<int>','Box<double>']) {
      const parent = result.nodes.find(n => n.qualifiedName === owner)!;
      expect(parent).toBeDefined();
      const children = result.edges.filter(e => e.kind === 'contains' && e.source === parent.id)
        .map(e => result.nodes.find(n => n.id === e.target)!.qualifiedName).sort();
      expect(children).toEqual([`${owner}::run`,`${owner}::value`]);
    }
  });

  it('keeps const and reference-qualified overloads separate', () => {
    const methods = extract('struct Owner { int get() &; int get() const &; int get() &&; };').nodes
      .filter(n => n.kind === 'method');
    expect(methods).toHaveLength(3);
  });

  it('merges renamed parameters and defaults into the definition', () => {
    const nodes = extract('int run(int value = 1); int run(int input) { return input; }').nodes.filter(n => n.name === 'run');
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.isDeclaration).not.toBe(true);
    expect(nodes[0]?.signature).toBe('int run(int input)');
  });

  it('merges renamed callback parameters without merging different callback types', () => {
    const nodes = extract('int run(int (*cb)(double)); int run(int (*callback)(double)) { return 0; } '
      + 'int run(int (*cb)(int));').nodes.filter(n => n.name === 'run');
    expect(nodes).toHaveLength(2);
    expect(nodes.filter(n => n.isDeclaration !== true)).toHaveLength(1);
  });

  it('uses full parameter lists beyond the displayed signature limit', () => {
    const prefix = Array.from({length:35}, (_, i) => `int parameter_${i}`).join(', ');
    const nodes = extract(`int run(${prefix}, int last); int run(${prefix}, double last);`).nodes.filter(n => n.name === 'run');
    expect(nodes).toHaveLength(2);
  });

  it('keeps collision identities stable when overload order changes', () => {
    const ids = (replacement: string) => extract(replacement).nodes.filter(n => n.name === 'run')
      .map(n => [n.signature, n.id]).sort();
    expect(ids('int run(int); int run(double);')).toEqual(ids('int run(double); int run(int);'));
  });

  it('does not duplicate a source-written symbol on an expanded invocation line', () => {
    const nodes = extract('int run(int);', 'MAKE() int run(double);').nodes.filter(n => n.name === 'run');
    expect(nodes).toHaveLength(2);
  });

  it('does not alias a generated member to a source-written member in another namespace', () => {
    const result = extract('namespace first { struct Owner { void run(); }; }',
      'MAKE() namespace second { struct Owner { void run(); }; }');
    const methods = result.nodes.filter(n => n.kind === 'method');
    expect(methods.map(n => n.qualifiedName).sort()).toEqual(['first::Owner::run','second::Owner::run']);
    for (const method of methods) {
      const parent = result.nodes.find(n => n.qualifiedName === method.qualifiedName.replace(/::run$/, ''))!;
      expect(result.edges).toContainEqual(expect.objectContaining({kind:'contains',source:parent.id,target:method.id}));
    }
  });
});
