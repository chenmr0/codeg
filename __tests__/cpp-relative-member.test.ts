import { describe, expect, it } from 'vitest';
import type { Node } from '../src/types';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types';
import { matchReference, isCppCallTargetAllowed } from '../src/resolution/name-matcher';
import { clearCppReceiverLookup } from '../src/resolution/cpp-receiver-lookup';
import { cppFieldReceiverType, cppRecoveredCallerOwner } from '../src/resolution/cpp-receiver-lookup';
import { clearCppBindingEvidence, isCppFileDefinitelyVisible, cppSourceNamespaceName } from '../src/resolution/cpp-binding-evidence';

function fixture() {
  const files: Record<string, string> = {
    'types.h': [
      'namespace atlas {',
      'namespace storage {',
      'struct Base { int read(int value) const; };',
      'struct Store : Base {};',
      '}',
      'namespace service {',
      'class Manager {',
      'storage::Store store_;',
      'public: int run(int value);',
      '};',
      '}',
      '}',
    ].join('\n'),
    'caller.cpp': '#include "types.h"\nusing namespace atlas;\nusing namespace service;\nint Manager::run(int value) {\n  return store_.read(value);\n}',
  };
  function node(id: string, kind: Node['kind'], name: string, qualifiedName: string,
    line: number, signature?: string, filePath = 'types.h'): Node {
    return { id, kind, name, qualifiedName, language: 'cpp', filePath, startLine: line, endLine: line,
      startColumn: 0, endColumn: 0, signature, updatedAt: 0 };
  }
  const caller = node('caller', 'method', 'run', 'Manager::run', 4, 'int Manager::run(int value)', 'caller.cpp');
  caller.endLine = 6;
  const declaration = node('declaration', 'method', 'run', 'atlas::service::Manager::run', 9, 'int run(int value)');
  declaration.isDeclaration = true;
  const field = node('field', 'field', 'store_', 'atlas::service::Manager::store_', 8, 'storage::Store store_;');
  const target = node('target', 'method', 'read', 'atlas::storage::Base::read', 3, 'int read(int value) const');
  target.isDeclaration = true;
  const nodes: Node[] = [caller, declaration, field, target,
    node('atlas', 'namespace', 'atlas', 'atlas', 1),
    node('storage', 'namespace', 'storage', 'atlas::storage', 2),
    node('service', 'namespace', 'service', 'atlas::service', 6),
    node('manager', 'class', 'Manager', 'atlas::service::Manager', 7),
    node('store', 'struct', 'Store', 'atlas::storage::Store', 4),
    node('base', 'struct', 'Base', 'atlas::storage::Base', 3),
  ];
  const bases = new Map([['atlas::storage::Store', ['atlas::storage::Base']]]);
  const context: ResolutionContext = {
    getNodesByName: name => nodes.filter(n => n.name === name),
    getNodesByQualifiedName: name => nodes.filter(n => n.qualifiedName === name),
    getNodesByLowerName: name => nodes.filter(n => n.name.toLowerCase() === name),
    getNodesByKind: kind => nodes.filter(n => n.kind === kind),
    getNodesInFile: file => nodes.filter(n => n.filePath === file),
    getMethodMatches: (type, method, language) => nodes.filter(n => n.kind === 'method'
      && n.language === language && n.qualifiedName === `${type}::${method}`),
    getSupertypes: type => bases.get(type) ?? [],
    readFile: file => files[file] ?? null,
    getFileLines: file => files[file]?.split('\n') ?? null,
    fileExists: file => file in files,
    getAllFiles: () => Object.keys(files),
    getProjectRoot: () => '/project',
    getImportMappings: () => [],
  };
  const ref: UnresolvedRef = { fromNodeId: caller.id, referenceName: 'store_.read', referenceKind: 'calls',
    filePath: 'caller.cpp', line: 5, column: 9, language: 'cpp' };
  function source(text: string) {
    files['caller.cpp'] = text;
    const lines = text.split('\n');
    caller.startLine = lines.findIndex(x => x.includes('Manager::run')) + 1;
    caller.endLine = lines.length;
    ref.line = lines.findIndex(x => x.includes('return store_.read')) + 1;
    ref.column = lines[ref.line - 1]!.indexOf('store_');
  }
  function clear() { clearCppBindingEvidence(context); clearCppReceiverLookup(context); }
  return { files, nodes, caller, declaration, field, target, context, ref, node, source, clear, bases };
}

describe('C++ out-of-line owner and relative field receiver lookup', () => {
  it('resolves a chained namespace import and relative field type before synthesized bridges exist', () => {
    const f = fixture();
    expect(matchReference(f.ref, f.context)?.targetNodeId).toBe('target');
    expect(isCppCallTargetAllowed(f.target, f.ref, f.context)).toBe(true);
  });

  it('requires a visible matching owner instead of accepting a unique global suffix', () => {
    const f = fixture();
    f.source(f.files['caller.cpp']!.replace('using namespace service;', ''));
    expect(matchReference(f.ref, f.context)).toBeNull();
  });

  it('rejects ambiguous visible classes before trying their overload signatures', () => {
    const f = fixture();
    f.nodes.push(f.node('other', 'namespace', 'other', 'atlas::other', 1),
      f.node('other-manager', 'class', 'Manager', 'atlas::other::Manager', 1));
    f.source(f.files['caller.cpp']!.replace('using namespace service;', 'using namespace service;\nusing namespace other;'));
    expect(matchReference(f.ref, f.context)).toBeNull();
  });

  it.each(['int run(double value)', 'int run(int value) const', 'int run(int value) &']) (
    'does not use an incompatible member declaration %s to identify the owner', signature => {
      const f = fixture(); f.declaration.signature = signature;
      expect(matchReference(f.ref, f.context)).toBeNull();
    },
  );

  it('accepts matching const/ref-qualified declarations and definitions', () => {
    const f = fixture();
    f.declaration.signature += ' const &'; f.caller.signature += ' const &';
    f.source(f.files['caller.cpp']!.replace('run(int value) {', 'run(int value) const & {'));
    expect(matchReference(f.ref, f.context)?.targetNodeId).toBe('target');
  });

  it.each(['#if 0', '#ifdef OPTIONAL'])('does not promote uncertain namespace imports (%s)', start => {
    const f = fixture();
    f.source(f.files['caller.cpp']!.replace('using namespace service;', `${start}\nusing namespace service;\n#endif`));
    expect(matchReference(f.ref, f.context)).toBeNull();
  });

  it('does not let a function-local namespace directive qualify a later definition', () => {
    const f = fixture();
    f.source(f.files['caller.cpp']!.replace('using namespace service;', 'void unrelated() { using namespace service; }'));
    expect(matchReference(f.ref, f.context)).toBeNull();
  });

  it('supports ordinary lexical namespaces without a using directive', () => {
    const f = fixture();
    f.source('#include "types.h"\nnamespace atlas { namespace service {\nint Manager::run(int value) {\nreturn store_.read(value);\n}\n}}');
    expect(matchReference(f.ref, f.context)?.targetNodeId).toBe('target');
  });

  it('keeps explicitly global field types out of the declaring namespace', () => {
    const f = fixture();
    f.files['types.h'] += '\nnamespace storage { struct Store { int read(int) const; }; }';
    f.nodes.push(f.node('global-storage', 'namespace', 'storage', 'storage', 13),
      f.node('global-store', 'struct', 'Store', 'storage::Store', 13),
      f.node('global-read', 'method', 'read', 'storage::Store::read', 13, 'int read(int value) const'));
    f.field.signature = '::storage::Store store_;';
    f.files['types.h'] = f.files['types.h']!.replace('storage::Store store_;', '::storage::Store store_;');
    expect(matchReference(f.ref, f.context)?.targetNodeId).toBe('global-read');
  });

  it('explicitly global field lookup ignores an unrelated unknown using directive', () => {
    const f = fixture();
    f.files['types.h'] = '#ifdef OPTIONAL\nusing namespace external;\n#endif\n' + f.files['types.h'];
    f.field.startLine += 3;
    const result = cppFieldReceiverType(f.field, '::atlas::storage::Store', f.context);
    expect(result).toBe('atlas::storage::Store');
  });

  it('an inline owner remains identified by its class even with unknown outer imports', () => {
    const f = fixture();
    f.files['caller.cpp'] = 'using namespace external;\nclass Local { int run(int value) { return value; } };';
    f.caller.qualifiedName = 'Local::run'; f.caller.startLine = 2; f.caller.endLine = 2;
    f.nodes.push(f.node('local', 'class', 'Local', 'Local', 2, undefined, 'caller.cpp'));
    expect(cppRecoveredCallerOwner(f.caller, f.context)).toBe('Local');
  });

  it('a direct global class conflicts with a class imported at the same lookup level', () => {
    const f = fixture();
    f.nodes.push(f.node('global-manager', 'class', 'Manager', 'Manager', 1));
    expect(cppRecoveredCallerOwner(f.caller, f.context)).toBe('');
    expect(matchReference(f.ref, f.context)).toBeNull();
  });

  it('a nearer lexical class takes precedence over an import introduced at an outer common ancestor', () => {
    const f = fixture();
    f.nodes.push(f.node('other', 'namespace', 'other', 'other', 1),
      f.node('other-manager', 'class', 'Manager', 'other::Manager', 1));
    f.source('#include "types.h"\nnamespace atlas { namespace service {\nusing namespace other;\nint Manager::run(int value) {\nreturn store_.read(value);\n}\n}}');
    expect(matchReference(f.ref, f.context)?.targetNodeId).toBe('target');
  });

  it('leaves unsupported nearer aliases unresolved', () => {
    const f = fixture();
    f.nodes.push(f.node('near-storage', 'struct', 'storage', 'atlas::service::Manager::storage', 8));
    f.nodes.push(f.node('near-alias', 'type_alias', 'Store', 'atlas::service::Manager::storage::Store', 8));
    expect(matchReference(f.ref, f.context)).toBeNull();
  });

  it('does not skip a nearer first qualifier that lacks the requested type', () => {
    const f = fixture();
    f.nodes.push(f.node('near-storage', 'namespace', 'storage', 'atlas::service::storage', 8));
    expect(matchReference(f.ref, f.context)).toBeNull();
  });

  it('keeps a local receiver declaration ahead of a same-named field', () => {
    const f = fixture();
    f.nodes.push(f.node('local-type', 'struct', 'Local', 'Local', 13),
      f.node('local-read', 'method', 'read', 'Local::read', 13, 'int read(int value) const'));
    f.files['types.h'] += '\nstruct Local { int read(int value) const; };';
    f.source(f.files['caller.cpp']!.replace('  return store_.read', '  Local store_;\n  return store_.read'));
    expect(matchReference(f.ref, f.context)?.targetNodeId).toBe('local-read');
  });

  it('does not infer an owner after incompatible conditional namespace openings', () => {
    const f = fixture();
    f.nodes.push(f.node('other-manager', 'class', 'Manager', 'atlas::other::Manager', 1));
    f.source('#include "types.h"\nnamespace atlas {\n#if FLAG\nnamespace service {\n#else\nnamespace other {\n#endif\nint Manager::run(int value) {\nreturn store_.read(value);\n}\n}}');
    expect(cppRecoveredCallerOwner(f.caller, f.context)).toBe('');
    expect(matchReference(f.ref, f.context)).toBeNull();
  });

  it('rechecks imports after a resolver cache epoch is cleared', () => {
    const f = fixture();
    expect(matchReference(f.ref, f.context)?.targetNodeId).toBe('target');
    f.source(f.files['caller.cpp']!.replace('using namespace service;', ''));
    f.clear();
    expect(matchReference(f.ref, f.context)).toBeNull();
  });

  it('namespace-name lookup considers namespace nodes despite an ordinary same-named value', () => {
    const f = fixture();
    const recovered = f.node('old-tag', 'variable', 'atlas', 'atlas', 1);
    recovered.startColumn = 10;
    f.nodes.push(recovered);
    expect(matchReference(f.ref, f.context)?.targetNodeId).toBe('target');
  });

  it('a qualifier before :: ignores an ordinary value with the same name', () => {
    const f = fixture();
    f.nodes.push(f.node('ordinary-value', 'variable', 'storage', 'atlas::service::storage', 8, 'int storage;'));
    expect(matchReference(f.ref, f.context)?.targetNodeId).toBe('target');
  });

  it('discards a conflicting namespace QName only when its exact source proves a different parent', () => {
    const f = fixture();
    f.files['other.h'] = 'namespace elsewhere {\nnamespace service {}\n}';
    f.nodes.push(f.node('wrong-namespace', 'namespace', 'service', 'service', 2, undefined, 'other.h'));
    expect(matchReference(f.ref, f.context)?.targetNodeId).toBe('target');
  });

  it.each(['namespace service {}', null])('retains a true or unverifiable conflicting namespace (%s)', text => {
    const f = fixture();
    if (text !== null) f.files['other.h'] = text;
    f.nodes.push(f.node('namespace-conflict', 'namespace', 'service', 'service', 1, undefined, 'other.h'));
    expect(matchReference(f.ref, f.context)).toBeNull();
  });

  it('keeps namespace ambiguity when the bounded source confirmation cannot inspect every candidate', () => {
    const f = fixture();
    f.files['other.h'] = 'namespace elsewhere {\nnamespace service {}\n}';
    for (let i = 0; i < 9; i++) f.nodes.push(f.node(`wrong-namespace-${i}`, 'namespace', 'service', 'service', 2, undefined, 'other.h'));
    expect(matchReference(f.ref, f.context)).toBeNull();
  });

  it('keeps a namespace anchor result unchanged by a huge unrelated suffix', () => {
    const f = fixture();
    const node = f.node('prefix-namespace', 'namespace', 'service', 'service', 2, undefined, 'other.h');
    f.files['other.h'] = 'namespace elsewhere {\nnamespace service {\n}\n}';
    expect(cppSourceNamespaceName(node, f.context)).toBe('elsewhere::service');
    f.files['other.h'] += '\n/*' + 'z'.repeat(512 * 1024) + '*/';
    f.clear();
    expect(cppSourceNamespaceName(node, f.context)).toBe('elsewhere::service');
    f.nodes.push(node);
    expect(matchReference(f.ref, f.context)?.targetNodeId).toBe('target');
  });

  it('keeps an anchor beyond the source prefix budget unknown', () => {
    const f = fixture();
    f.files['other.h'] = '/*' + 'z'.repeat(256 * 1024) + '*/\nnamespace elsewhere {\nnamespace service {}}';
    const node = f.node('late-namespace', 'namespace', 'service', 'service', 3, undefined, 'other.h');
    expect(cppSourceNamespaceName(node, f.context)).toBeNull();
  });

  it('keeps an anchor after incompatible conditional namespace openings unknown', () => {
    const f = fixture();
    f.files['other.h'] = '#if FLAG\nnamespace one {\n#else\nnamespace two {\n#endif\nnamespace service {';
    const node = f.node('uncertain-namespace', 'namespace', 'service', 'service', 6, undefined, 'other.h');
    expect(cppSourceNamespaceName(node, f.context)).toBeNull();
  });

  it.each([
    '#define OPEN_NS(x) namespace x {\nOPEN_NS(elsewhere);',
    '#define OPEN_NS(x) namespace x\nOPEN_NS(elsewhere) {',
    '#define OPEN_NS namespace elsewhere\nOPEN_NS {',
    '#define OPEN_NS(x) namespace x {\nstatic_assert(true); OPEN_NS(elsewhere);',
    '#define OPEN_NS namespace elsewhere {\nOPEN_NS;',
    '#define OPEN_NS(x) namespace x {\nOPEN_NS(elsewhere)',
    '#define OPEN_NS namespace elsewhere {\nOPEN_NS',
    '#include "macro.h"\nopen_scope(elsewhere);',
    '#include "macro.h"\nopen_scope;',
  ])('does not disprove a namespace QName across an unexplained namespace-scope macro: %s', prefix => {
    const f = fixture();
    f.files['other.h'] = prefix + '\nnamespace service {\n}\n}';
    const node = f.node('macro-namespace', 'namespace', 'service', 'elsewhere::service', 3, undefined, 'other.h');
    expect(cppSourceNamespaceName(node, f.context)).toBeNull();
  });

  it('does not mistake a standard assertion or a proven function-body call for a namespace macro', () => {
    const f = fixture();
    f.files['other.h'] = 'static_assert(true);\nvoid unrelated() { work(); }\nnamespace elsewhere {\nnamespace service {}}';
    const node = f.node('ordinary-namespace', 'namespace', 'service', 'service', 4, undefined, 'other.h');
    expect(cppSourceNamespaceName(node, f.context)).toBe('elsewhere::service');
  });

  it('keeps ordinary function and class constructor bodies ahead of a namespace anchor', () => {
    const f = fixture();
    f.files['other.h'] = '#ifndef TYPES_H\n#define TYPES_H\nstruct Box { Box(int) {} };\nint\nordinary(int value) { return value; }\nnamespace elsewhere {\nnamespace service {}}\n#endif';
    const node = f.node('after-function-namespace', 'namespace', 'service', 'service', 7, undefined, 'other.h');
    expect(cppSourceNamespaceName(node, f.context)).toBe('elsewhere::service');
  });

  it('keeps a macro-provided namespace header with a source brace unknown under a header guard', () => {
    const f = fixture();
    f.files['other.h'] = '#ifndef TYPES_H\n#define TYPES_H\n#define Open(x) namespace x\nOpen(elsewhere) {\nnamespace service {}}\n#endif';
    const node = f.node('guarded-macro-namespace', 'namespace', 'service', 'elsewhere::service', 5, undefined, 'other.h');
    expect(cppSourceNamespaceName(node, f.context)).toBeNull();
  });

  it('keeps a later direct include visible after a preceding transitive include fills the traversal budget', () => {
    const f = fixture();
    f.source('#include "fan0.h"\n' + f.files['caller.cpp']);
    for (let i = 0; i < 300; i++) f.files[`fan${i}.h`] = i < 299 ? `#include "fan${i + 1}.h"` : '';
    expect(isCppFileDefinitelyVisible('types.h', f.ref, f.context)).toBe(true);
    expect(matchReference(f.ref, f.context)?.targetNodeId).toBe('target');
  });

  it.each(['#if 0', '#ifdef OPTIONAL'])('does not turn a conditional direct include into positive visibility (%s)', conditional => {
    const f = fixture();
    f.source(f.files['caller.cpp']!.replace('#include "types.h"', `${conditional}\n#include "types.h"\n#endif`));
    expect(isCppFileDefinitelyVisible('types.h', f.ref, f.context)).toBe(false);
    expect(matchReference(f.ref, f.context)).toBeNull();
  });
});
