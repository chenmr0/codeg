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
    ['using Int = int;\n', 'Int', 'int'],
    ['namespace n { using Int = int; }\n', 'n::Int', 'int'],
    ['struct C {};\nnamespace n { using Result = C; struct C {}; }\n', 'n::Result', '::C'],
    ['#if FEATURE\nusing Int = int;\n', 'Int', 'int'],
  ])('retains source type evidence outside the invocation: %s', (prefix, left, right) => {
    const result = extract(`template<class T> ${left} run(T); template<class U> ${right} run(U) { return {}; }`,
      `${prefix}MAKE()\n${prefix.startsWith('#if') ? '#endif' : ''}`);
    expect(result.nodes.filter(n => n.name === 'run')).toHaveLength(1);
  });

  it('retains using-directive barriers when pruning macro context', () => {
    const result = extract('template<class T> C run(T); template<class U> ::C run(U);',
      'struct C {};\nnamespace n {\nnamespace actual { struct C {}; }\nusing namespace actual;\nMAKE()\n}');
    expect(result.nodes.filter(n => n.name === 'run')).toHaveLength(2);
  });

  it.each([
    ['namespace local {\ninline namespace v1 { using Number = double; }\n', '\n}'],
    ['namespace local {\nnamespace { using Number = double; }\n', '\n}'],
    ['struct Base { using Number = double; };\nstruct Derived : Base {\n', '\n};'],
  ])('preserves overloads with implicitly introduced nearer types: %s', (prefix, suffix) => {
    const result = extract('template<class T> static constexpr int run(Number) { return 1; } '
      + 'template<class U> static constexpr int run(int) { return 2; }',
    `using Number = int;\n${prefix}MAKE()${suffix}`);
    expect(result.nodes.filter(n => n.name === 'run')).toHaveLength(2);
  });

  it('looks up out-of-line member parameters in their class scope', () => {
    const result = extract('template<class T> constexpr int C::run(Number) { return 1; } '
      + 'template<class U> constexpr int C::run(int) { return 2; }',
    'using Number = int;\nstruct C { using Number = double;\ntemplate<class T> static constexpr int run(Number);\n'
      + 'template<class U> static constexpr int run(int);\n};\nMAKE()');
    const definitions = result.nodes.filter(n => n.name === 'run' && !n.isDeclaration);
    expect(definitions).toHaveLength(2);
  });

  it('keeps leading return lookup outside an out-of-line member scope', () => {
    const result = extract('struct C { using Number = double; template<class T> static int run(Number); }; '
      + 'template<class U> Number C::run(Number) { return 1; }', 'using Number = int;\nMAKE()');
    const methods = result.nodes.filter(n => n.name === 'run');
    expect(methods).toHaveLength(1);
    expect(methods[0]?.isDeclaration).not.toBe(true);
  });

  it.each([
    'struct A { using type = int; }; struct B { using type = double; }; '
      + 'template<class T> using Select = typename T::type; using Current = A; using Result = Select<Current>; '
      + 'namespace inner { using Current = B; int run(Result) { return 1; } int run(Select<Current>) { return 2; } }',
    'constexpr int N = 2; using Result = int (*)[N]; namespace inner { constexpr int N = 3; '
      + 'int run(Result) { return 1; } int run(int (*value)[N]) { return 2; } }',
  ])('does not expand an alias through unproven bound names: %s', replacement => {
    expect(extract(replacement).nodes.filter(n => n.name === 'run')).toHaveLength(2);
  });

  it.each([
    'using 整数 = int; template<class 类型> 整数 run(类型); template<class Type> int run(Type) { return 1; }',
    'struct C {}; using Owner = C; template<class T> int run(int (Owner::*value)(int)); template<class U> int run(int (::C::*input)(signed)) { return 1; }',
    'template<class T> auto run(T) -> int (*)(signed); template<class U> auto run(U) -> int (*)(int) { return {}; }',
    'template<class T> auto run(T) -> int (*)(long unsigned int); template<class U> auto run(U) -> int (*)(unsigned long) { return {}; }',
    'using Int = int; template<class T> Int run(T); template<class U> int run(U) { return 1; }',
    'using Int = int; template<class T> auto run(T) -> int (*)(Int); template<class U> auto run(U) -> int (*)(int) { return {}; }',
    'using Int = int; using Number = Int; template<class T> Number run(T); template<class U> signed run(U) { return 1; }',
    'using Pointer = const int*; template<class T> Pointer run(T); template<class U> const int* run(U) { return {}; }',
    'typedef int Number, *Pointer; template<class T> Pointer run(T); template<class U> int* run(U) { return {}; }',
    'using Callback = int(*)(signed); template<class T> Callback run(T); template<class U> auto run(U) -> int (*)(int) { return {}; }',
    'using Pointer = int*; template<class T> const Pointer* run(T); template<class U> auto run(U) -> int* const* { return {}; }',
    'using Ref = int&; template<class T> Ref&& run(T); template<class U> int& run(U) { return *static_cast<int*>(nullptr); }',
    'struct C {}; template<class T> C run(T); template<class U> ::C run(U) { return {}; }',
    'namespace n { struct C {}; } template<class T> n::C run(T); template<class U> ::n::C run(U) { return {}; }',
    'struct C {}; using Result = C; template<class C> Result run(C); template<class T> ::C run(T) { return {}; }',
    'namespace n { using Int = int; template<class T> Int run(T); template<class U> int run(U) { return 1; } }',
  ])('normalizes proven aliases and nested type equivalence: %s', replacement => {
    const nodes = extract(replacement).nodes.filter(n => n.name === 'run');
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.isDeclaration).not.toBe(true);
  });

  it.each([
    'using Int = long; template<class T> Int run(T); template<class U> int run(U);',
    'using Int = int; namespace n { using Int = long; template<class T> Int run(T); template<class U> ::Int run(U); }',
    'struct C {}; namespace n { struct C {}; template<class T> C run(T); template<class U> ::C run(U); }',
    'struct C {}; namespace n { template<class T> C run(T); struct C {}; template<class U> C run(U); }',
    'struct C {}; template<class C> C run(C); template<class T> ::C run(T);',
    'using Pointer = int*; template<class T> const Pointer run(T); template<class U> const int* run(U);',
    'using Result = External; template<class T> Result run(T); template<class U> int run(U);',
    'template<class T> auto run(T) -> int(*)(signed char); template<class U> auto run(U) -> int(*)(char);',
    'template<class T> auto run(T) -> int(*)(long); template<class U> auto run(U) -> int(*)(int);',
  ])('does not infer unsupported or conflicting type equivalence: %s', replacement => {
    expect(extract(replacement).nodes.filter(n => n.name === 'run')).toHaveLength(2);
  });

  it('uses alias declaration-time bindings and does not retain state between parses', () => {
    const source = 'struct C {}; namespace n { using Result = C; struct C {}; '
      + 'template<class T> Result run(T); template<class U> ::C run(U) { return {}; } }';
    expect(extract(source).nodes.filter(n => n.name === 'run')).toHaveLength(1);
    expect(extract('using Result = long; template<class T> Result run(T); template<class U> int run(U);')
      .nodes.filter(n => n.name === 'run')).toHaveLength(2);
  });

  it('does not use a conditional alias outside its proven branch', () => {
    const result = extract('template<class T> Result run(T); template<class U> int run(U);',
      '#if FEATURE\nusing Result = int;\n#else\nusing Result = long;\n#endif\nMAKE()');
    expect(result.nodes.filter(n => n.name === 'run')).toHaveLength(2);
  });

  it.each(['Result', 'Result*', 'int C::*'])('keeps leading return bindings outside parameter scope: %s', result => {
    const parameter = result === 'int C::*' ? 'C' : 'Result';
    const nodes = extract(`struct Result {}; struct C { int value; }; template<class T> ${result} run(T ${parameter}); `
      + `template<class U> ${result} run(U input) { return {}; }`).nodes.filter(n => n.name === 'run');
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.isDeclaration).not.toBe(true);
  });

  it.each([
    'template<class T> typename T::type run(T); template<class U> auto run(U) -> U::type { return {}; }',
    'template<class T> long int run(T); template<class U> long run(U) { return 1; }',
    'template<class T> signed run(T); template<class U> int run(U) { return 1; }',
    'template<class T> long unsigned int run(T); template<class U> unsigned long run(U) { return 1; }',
    'struct Result {}; template<class T> struct Result run(T); template<class U> Result run(U) { return {}; }',
    'template<class T> auto run(T value) -> decltype(value); template<class U> auto run(U input) -> decltype(input) { return input; }',
    'template<class T> auto run(T value) -> decltype(value.first); template<class U> auto run(U input) -> decltype(input.first) { return input.first; }',
    'int run(int C::*p = nullptr); int run(int C::*value) { return 1; }',
    'int run(int C::* const p); int run(int C::*value) { return 1; }',
    'int run(int (C::*p)(int) = nullptr); int run(int (C::*value)(int)) { return 1; }',
    'int run(int (ns::C::*p)(int)); int run(int (ns::C::*value)(int)) { return 1; }',
    'int run(int (C:: /* owner */ *p)(int)); int run(int (C::*value)(int)) { return 1; }',
    'template<class T> typename T::type run(T); template<class U> auto run(U) -> typename U::type { return {}; }',
    'template<class T> typename T::type* run(T); template<class U> auto run(U) -> typename U::type* { return {}; }',
    'template<class T> const T& run(T); template<class U> auto run(U) -> const U& { return {}; }',
    'template<class T> int run(T value); template<class U> int run(U value) { return 1; }',
    'template<class T = int> int run(T); template<typename U> int run(U) { return 1; }',
    'template<int N = 2> int run(); template<int M> int run() { return M; }',
    'template<class... T> int run(T...); template<typename... U> int run(U...) { return 1; }',
    'template<template<class> class C> int run(C<int>); template<template<typename> class D> int run(D<int>) { return 1; }',
    'int run(int values[3]); int run(int *values) { return 1; }',
    'int run(const int values[3]); int run(const int *values) { return 1; }',
    'int run(int values[2][3]); int run(int (*values)[3]) { return 1; }',
    'int run(int *values[3]); int run(int **values) { return 1; }',
    'int run(int callback(double)); int run(int (*callback)(double)) { return 1; }',
    'int run(int (*callback)(int a[3])); int run(int (*cb)(int *a)) { return 1; }',
    'template<class T> int run(T) requires Good<T>; template<class U> int run(U) requires Good<U> { return 1; }',
    'template<class T> requires Good<T> int run(T); template<class U> requires Good<U> int run(U) { return 1; }',
  ])('merges equivalent macro redeclarations: %s', replacement => {
    const nodes = extract(replacement).nodes.filter(n => n.name === 'run');
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.isDeclaration).not.toBe(true);
  });

  it.each([
    'template<class T> struct Box { static int run(T); }; template<class U> int Box<U>::run(U value) { return 1; }',
    'template<class T> struct Box { template<class U> static int run(T, U); }; template<class V> template<class W> int Box<V>::run(V, W) { return 1; }',
    'template<class T> struct Box; template<> struct Box<int> { template<class U> static int run(U); }; template<class V> int Box<int>::run(V) { return 1; }',
  ])('matches renamed class template parameters: %s', replacement => {
    const methods = extract(replacement).nodes.filter(n => n.kind === 'method');
    expect(methods).toHaveLength(1);
    expect(methods[0]?.isDeclaration).not.toBe(true);
    expect(methods[0]?.isStatic).toBe(true);
  });

  it.each([
    'template<class T> int run(); template<int N> int run();',
    'template<int N> int run(); template<long N> int run();',
    'template<class T> int run(); template<class... T> int run();',
    'int run(int (*)[3]); int run(int (*)[4]);',
    'int run(int (&)[3]); int run(int*);',
    'int run(int (&)(double)); int run(int (*)(double));',
    'int run(const int&); int run(int&);',
    'int run(int (*)(double) noexcept); int run(int (*)(double));',
    'template<class T> int run(T) requires Good<T>; template<class U> int run(U) requires Other<U>;',
    'template<class T> requires Good<T> int run(T); template<class U> requires Other<U> int run(U);',
    'template<class T> int run(T, foreign::T); template<class U> int run(U, foreign::U);',
  ])('preserves real type, binding and constraint distinctions: %s', replacement => {
    expect(extract(replacement).nodes.filter(n => n.name === 'run')).toHaveLength(2);
  });

  it.each([
    'int run(int C::*p); int run(int D::*p);',
    'template<class T> char run(T); template<class U> signed char run(U);',
    'template<class T> int run(T); template<class U> long run(U);',
    'template<class T> auto run(T value) -> decltype(value.first); template<class U> auto run(U input) -> decltype(input.second);',
    'int run(int (C::*p)(int) const); int run(int (C::*p)(int));',
    'int run(int (C::*p)(int) &); int run(int (C::*p)(int) &&);',
    'int run(int (C::*p)(int) noexcept); int run(int (C::*p)(int));',
    'template<class T> int run(int (T::*p)(int)); template<class T> int run(int (*p)(int));',
    'template<class T> typename T::type* run(T); template<class U> typename U::type run(U);',
  ])('keeps member-pointer and template return-type distinctions: %s', replacement => {
    expect(extract(replacement).nodes.filter(n => n.name === 'run')).toHaveLength(2);
  });

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
