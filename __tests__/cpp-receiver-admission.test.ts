import { describe, expect, it } from 'vitest';
import type { Node } from '../src/types';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types';
import { isCppCallTargetAllowed, matchReference } from '../src/resolution/name-matcher';
import { cppCallArityCompatibility } from '../src/resolution/cpp-call-admission';

function fixture(declaration: string, expression: string, methods: Array<[string, string]>, owner = '') {
  const source = `${declaration}\n${expression};`;
  const nodes: Node[] = methods.map(([qualifiedName, signature], i) => ({ id: String(i), name: 'step', signature,
    kind: 'method', qualifiedName, language: 'cpp', filePath: 'a.cpp',
    startLine: 1, endLine: 1, startColumn: 0, endColumn: 1, updatedAt: 1 }));
  const caller: Node = { ...nodes[0]!, id: 'caller', name: 'invoke', kind: owner ? 'method' : 'function',
    qualifiedName: owner ? owner + '::invoke' : 'invoke', startLine: 1, endLine: 2, signature: declaration };
  nodes.push(caller);
  const ref: UnresolvedRef = { fromNodeId: 'caller', referenceName: expression.replace(/\([^)]*\)$/, '').replace('->', '.'),
    referenceKind: 'calls', filePath: 'a.cpp', language: 'cpp', line: 2, column: 0 };
  const context: ResolutionContext = {
    getNodesByName: name => nodes.filter(n => n.name === name),
    getNodesByQualifiedName: name => nodes.filter(n => n.qualifiedName === name),
    getNodesByLowerName: name => nodes.filter(n => n.name.toLowerCase() === name),
    getNodesInFile: file => nodes.filter(n => n.filePath === file), getNodesByKind: kind => nodes.filter(n => n.kind === kind),
    readFile: file => file === 'a.cpp' ? source : null, getFileLines: () => source.split('\n'),
    fileExists: file => file === 'a.cpp', getAllFiles: () => ['a.cpp'], getProjectRoot: () => '.', getImportMappings: () => [],
    getSupertypes: type => type === 'Derived' ? ['Base'] : [],
  };
  return { nodes, ref, context };
}

function mixedHeaderFixture(language: Node['language'] = 'c') {
  const files: Record<string, string> = {
    'owners.h': 'struct Left { void step(); void step(int value); };\nstruct Right { void step(int value); };',
    'receiver.h': '#include "owners.h"\nstruct Receiver : Left {};',
    'main.cpp': '#include "receiver.h"\nvoid invoke(Receiver &value) {\n  value.step(1);\n}',
  };
  const base: Node = { id: 'left', name: 'Left', qualifiedName: 'Left', kind: 'struct', language,
    filePath: 'owners.h', startLine: 1, endLine: 1, startColumn: 0, endColumn: 54, updatedAt: 1 };
  const nodes: Node[] = [base,
    { ...base, id: 'left-zero', name: 'step', qualifiedName: 'Left::step', kind: 'method', signature: 'void step()' },
    { ...base, id: 'left-one', name: 'step', qualifiedName: 'Left::step', kind: 'method', signature: 'void step(int value)' },
    { ...base, id: 'right', name: 'Right', qualifiedName: 'Right', startLine: 2, endLine: 2 },
    { ...base, id: 'right-one', name: 'step', qualifiedName: 'Right::step', kind: 'method',
      signature: 'void step(int value)', startLine: 2, endLine: 2 },
    { ...base, id: 'receiver', name: 'Receiver', qualifiedName: 'Receiver', language: 'cpp',
      filePath: 'receiver.h', startLine: 2, endLine: 2 },
    { ...base, id: 'caller', name: 'invoke', qualifiedName: 'invoke', kind: 'function', language: 'cpp',
      filePath: 'main.cpp', startLine: 2, endLine: 4 },
    // An unrelated language's same-named generic owner must not suppress Left.
    { ...base, id: 'unrelated-left', language: 'java', filePath: 'Left.java', typeParameters: ['T'] },
  ];
  const ref: UnresolvedRef = { fromNodeId: 'caller', referenceName: 'value.step', referenceKind: 'calls',
    filePath: 'main.cpp', language: 'cpp', line: 3, column: 2 };
  const context: ResolutionContext = {
    getNodesByName: name => nodes.filter(n => n.name === name),
    getNodesByQualifiedName: name => nodes.filter(n => n.qualifiedName === name),
    getNodesByLowerName: name => nodes.filter(n => n.name.toLowerCase() === name),
    getNodesInFile: file => nodes.filter(n => n.filePath === file), getNodesByKind: kind => nodes.filter(n => n.kind === kind),
    getMethodMatches: (type, method, tag) => nodes.filter(n => n.kind === 'method' && n.language === tag && n.qualifiedName === `${type}::${method}`),
    getSupertypes: (type, tag) => type === 'Receiver' && tag === 'cpp' ? ['Left'] : [],
    readFile: file => files[file] ?? null, getFileLines: file => files[file]?.split('\n') ?? [],
    fileExists: file => file in files, getAllFiles: () => Object.keys(files), getProjectRoot: () => '.', getImportMappings: () => [],
  };
  return { nodes, ref, context, files };
}

describe('C++ receiver admission before name heuristics', () => {
  it.each([false, true])('resolves C-tagged header methods through a C++ receiver (indexed lookup=%s)', indexed => {
    const f = mixedHeaderFixture();
    if (!indexed) delete f.context.getMethodMatches;
    expect(matchReference(f.ref, f.context)?.targetNodeId).toBe('left-one');
    expect(isCppCallTargetAllowed(f.nodes.find(n => n.id === 'right-one')!, f.ref, f.context)).toBe(false);
    expect(cppCallArityCompatibility(f.nodes.find(n => n.id === 'left-zero')!, f.ref, f.context)).toBe('incompatible');
  });
  it('does not use an unrelated language family as the receiver base', () => {
    const f = mixedHeaderFixture('java');
    expect(matchReference(f.ref, f.context)).toBeNull();
    expect(isCppCallTargetAllowed(f.nodes.find(n => n.id === 'left-one')!, f.ref, f.context)).toBe(false);
  });
  it.each(['Left()', 'make()'])('infers an auto receiver from C-tagged header evidence for %s', initializer => {
    const f = mixedHeaderFixture();
    f.files['owners.h'] += '\nLeft make();';
    f.nodes.push({ ...f.nodes[0]!, id: 'factory', name: 'make', qualifiedName: 'make', kind: 'function',
      signature: 'Left make()', returnType: 'Left', startLine: 3, endLine: 3 });
    f.files['main.cpp'] = `#include "receiver.h"\nvoid invoke() {\n  auto value = ${initializer};\n  value.step(1);\n}`;
    f.ref.line = 4;
    expect(matchReference(f.ref, f.context)?.targetNodeId).toBe('left-one');
  });
  it('infers a receiver field from its C-tagged owning header', () => {
    const f = mixedHeaderFixture();
    f.files['main.cpp'] = '#include "receiver.h"\nvoid Receiver::invoke() {\n  value.step(1);\n}';
    const caller = f.nodes.find(n => n.id === 'caller')!;
    caller.kind = 'method';
    caller.qualifiedName = 'Receiver::invoke';
    f.nodes.push({ ...f.nodes[0]!, id: 'receiver-field', name: 'value', qualifiedName: 'Receiver::value',
      kind: 'field', signature: 'Left value;' });
    expect(matchReference(f.ref, f.context)?.targetNodeId).toBe('left-one');
  });
  it('preserves unknown arity for an empty C function parameter list', () => {
    const f = fixture('', 'step(1)', [['step', 'void step()']]);
    f.nodes[0]!.kind = 'function';
    f.nodes[0]!.language = 'c';
    expect(cppCallArityCompatibility(f.nodes[0]!, f.ref, f.context)).toBe('unknown');
  });
  it('chooses an arity-compatible method on the actual typed owner', () => {
    const f = fixture('Rotor value;', 'value.step(1)', [['Rotor::step', 'void step()'], ['Rotor::step', 'void step(int value)']]);
    expect(matchReference(f.ref, f.context)?.targetNodeId).toBe('1');
  });
  it('preserves namespace-qualified receiver types', () => {
    const f = fixture('right::Rotor value;', 'value.step()', [['wrong::Rotor::step', 'void step()'], ['right::Rotor::step', 'void step()']]);
    expect(matchReference(f.ref, f.context)?.targetNodeId).toBe('1');
  });
  it('does not mistake a return expression for a newer receiver declaration', () => {
    const f = fixture('Rotor invoke(Rotor value, bool early) { if (early) return value;',
      'value.step()', [['Rotor::step', 'void step()']]);
    expect(matchReference(f.ref, f.context)?.targetNodeId).toBe('0');
  });
  it.each(['Rotor value;', 'auto value = TYPE_GET(Rotor*);', ''])('does not invent an unrelated receiver after %s', declaration => {
    const f = fixture(declaration, 'value.step()', [['Value::step', 'void step()']]);
    expect(matchReference(f.ref, f.context)).toBeNull();
    expect(isCppCallTargetAllowed(f.nodes[0]!, f.ref, f.context)).toBe(false);
  });
  it.each(['step()', 'this->step()'])('excludes unrelated same-file owners from %s', expression => {
    const f = fixture('void Owner::invoke() {', expression, [['Other::step', 'void step()']], 'Owner');
    expect(matchReference(f.ref, f.context)).toBeNull();
  });
  it('retains a free helper from a method', () => {
    const f = fixture('void Owner::invoke() {', 'step()', [['step', 'void step()']], 'Owner');
    f.nodes[0]!.kind = 'function';
    expect(matchReference(f.ref, f.context)?.targetNodeId).toBe('0');
  });
  it('recognizes this at the source location when extraction kept only the method name', () => {
    const f = fixture('void Owner::invoke() {', 'this->step()', [['Owner::step', 'void step()'], ['Other::step', 'void step()']], 'Owner');
    f.ref.referenceName = 'step';
    expect(matchReference(f.ref, f.context)?.targetNodeId).toBe('0');
  });
  it.each([['cpp', false], ['cpp', true], ['c', false], ['c', true]] as const)(
    'respects hiding in a %s-tagged owner; using declaration present=%s', (language, using) => {
    const f = fixture(`struct Derived : Base { ${using ? 'using Base::step;' : ''} void step(int); }; Derived value;`,
      'value.step()', [['Derived::step', 'void step(int)'], ['Base::step', 'void step()']]);
    f.nodes[0]!.language = language;
    f.nodes.push({ ...f.nodes[0]!, id: 'derived', name: 'Derived', qualifiedName: 'Derived', kind: 'struct' });
    expect(matchReference(f.ref, f.context)?.targetNodeId ?? null).toBe(using ? '1' : null);
  });
  it('does not arbitrarily choose between unresolved const overloads', () => {
    const f = fixture('Rotor value;', 'value.step()', [['Rotor::step', 'void step()'], ['Rotor::step', 'void step() const']]);
    expect(matchReference(f.ref, f.context)).toBeNull();
  });
  it.each(['c', 'cpp'] as const)('does not bind a base method when a %s-tagged derived callback field hides its name', language => {
    const f = fixture('struct Derived : Base { void (*step)(); }; Derived value;',
      'value.step()', [['Base::step', 'void step()']]);
    f.nodes.push({ ...f.nodes[0]!, id: 'callback', kind: 'field', language, qualifiedName: 'Derived::step', signature: 'void (*step)();' });
    expect(matchReference(f.ref, f.context)).toBeNull();
    expect(isCppCallTargetAllowed(f.nodes[0]!, f.ref, f.context)).toBe(false);
  });
  it('does not import an overload through a using declaration in a nested class', () => {
    const f = fixture('struct Derived : Base { struct Nested : Base { using Base::step; }; void step(int); }; Derived value;',
      'value.step()', [['Derived::step', 'void step(int)'], ['Base::step', 'void step()']]);
    f.nodes.push({ ...f.nodes[0]!, id: 'derived', name: 'Derived', qualifiedName: 'Derived', kind: 'struct' });
    expect(matchReference(f.ref, f.context)).toBeNull();
  });
  it('does not turn an erased template base into a unique ordinary overload', () => {
    const f = fixture('Derived value;', 'value.step()', [['Base::step', 'void step()']]);
    f.nodes.push({ ...f.nodes[0]!, id: 'base', name: 'Base', qualifiedName: 'Base', kind: 'struct', typeParameters: ['T'] });
    expect(matchReference(f.ref, f.context)).toBeNull();
  });
  it('preserves name-based receiver heuristics in other languages', () => {
    const f = fixture('', 'value.step()', [['Value::step', 'void step()']]);
    f.ref.language = 'java';
    f.nodes.forEach(n => { n.language = 'java'; });
    expect(matchReference(f.ref, f.context)?.targetNodeId).toBe('0');
  });
});
