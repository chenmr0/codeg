import { describe, expect, it, vi } from 'vitest';
import type { Node } from '../src/types';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types';
import {
  clearCppBindingEvidence, filterCppBindingCandidates, isCppBindingTargetAllowed,
} from '../src/resolution/cpp-binding-evidence';

function symbol(filePath: string, name: string, text: string, extra: Partial<Node> = {}): Node {
  return { id: `${filePath}:${name}`, name, qualifiedName: name, filePath, language: 'cpp',
    kind: 'function', startLine: 1, endLine: 1, startColumn: 0, endColumn: text.length,
    signature: text, updatedAt: 0, ...extra };
}

function fixture(files: Record<string, string>, nodes: Node[], includeDirs: string[] = []) {
  const context: ResolutionContext = {
    getNodesInFile: file => nodes.filter(n => n.filePath === file),
    getNodesByName: name => nodes.filter(n => n.name === name),
    getNodesByQualifiedName: name => nodes.filter(n => n.qualifiedName === name),
    getNodesByKind: kind => nodes.filter(n => n.kind === kind),
    getNodesByLowerName: name => nodes.filter(n => n.name.toLowerCase() === name),
    readFile: vi.fn(file => files[file] ?? null), fileExists: file => file in files,
    getAllFiles: () => Object.keys(files), getProjectRoot: () => '/project',
    getImportMappings: () => [], getCppIncludeDirs: () => includeDirs,
  };
  const ref: UnresolvedRef = { fromNodeId: 'caller', referenceName: 'pick', referenceKind: 'calls',
    filePath: 'caller.cpp', language: 'cpp', line: files['caller.cpp']!.split('\n').length, column: 20 };
  return { context, ref };
}

describe('C/C++ binding evidence (frozen positive and negative controls)', () => {
  it('keeps a visible header static and rejects a foreign TU static without path/name heuristics', () => {
    const header = symbol('api.h', 'pick', 'static int pick() { return 1; }', { language: 'c', isStatic: true });
    const foreign = symbol('nested/caller.cpp', 'pick', 'static int pick() { return 2; }', { isStatic: true });
    const { context, ref } = fixture({ 'caller.cpp': '#include "api.h"\nint caller(){return pick();}',
      'api.h': header.signature!, 'nested/caller.cpp': foreign.signature! }, [header, foreign]);
    expect(filterCppBindingCandidates([foreign, header], ref, context)).toEqual([header]);
    expect(isCppBindingTargetAllowed(foreign, ref, context)).toBe(false);
  });

  it('does not bind an extern declaration to a foreign static definition', () => {
    const decl = symbol('caller.cpp', 'pick', 'extern int pick();', { isDeclaration: true });
    const foreign = symbol('other.cpp', 'pick', 'static int pick() { return 2; }', { isStatic: true });
    const { context, ref } = fixture({ 'caller.cpp': 'extern int pick();\nint caller(){return pick();}',
      'other.cpp': foreign.signature! }, [decl, foreign]);
    expect(filterCppBindingCandidates([foreign, decl], ref, context)).toEqual([decl]);
  });

  it('recognizes internal linkage inherited from an included static declaration', () => {
    const def = symbol('other.cpp', 'pick', 'int pick(){return 1;}', { startLine: 2 });
    const { context, ref } = fixture({ 'caller.cpp': 'int caller(){return pick();}',
      'private.h': 'static int pick();', 'other.cpp': '#include "private.h"\nint pick(){return 1;}' }, [def]);
    expect(isCppBindingTargetAllowed(def, ref, context)).toBe(false);
  });

  it('keeps linkage unknown after a conditional static declaration', () => {
    const def = symbol('other.cpp', 'pick', 'int pick(){return 1;}', { startLine: 4 });
    const { context, ref } = fixture({ 'caller.cpp': 'int caller(){return pick();}',
      'other.cpp': '#ifdef FEATURE\nstatic int pick();\n#endif\nint pick(){return 1;}' }, [def]);
    expect(isCppBindingTargetAllowed(def, ref, context)).toBe(true);
  });

  it.each([false, true])('does not inherit static from a different overload (included=%s)', included => {
    const decl = symbol('caller.cpp', 'pick', 'int pick(double value);', { isDeclaration: true });
    const def = symbol('other.cpp', 'pick', 'int pick(double value){return 1;}', { startLine: 2 });
    const { context, ref } = fixture({ 'caller.cpp': 'int pick(double value);\nint caller(){return pick(1.5);}',
      'private.h': 'static int pick(int value);',
      'other.cpp': (included ? '#include "private.h"' : 'static int pick(int value);') + '\n' + def.signature! }, [decl, def]);
    expect(isCppBindingTargetAllowed(def, ref, context)).toBe(true);
    expect(filterCppBindingCandidates([def, decl], ref, context)).toContain(def);
  });

  it.each(['int value', 'const int value', 'signed int value'])('inherits static for the same builtin parameter identity: %s', parameter => {
    const def = symbol('other.cpp', 'pick', 'int pick(int value){return value;}', { startLine: 2 });
    const { context, ref } = fixture({ 'caller.cpp': 'int caller(){return pick(1);}',
      'other.cpp': `static int pick(${parameter});\n${def.signature}` }, [def]);
    expect(isCppBindingTargetAllowed(def, ref, context)).toBe(false);
  });

  it('keeps unsupported prior parameter identities unknown', () => {
    const def = symbol('other.cpp', 'pick', 'int pick(int value){return value;}', { startLine: 2 });
    const { context, ref } = fixture({ 'caller.cpp': 'int caller(){return pick(1);}',
      'other.cpp': 'static int pick(ParameterType value);\n' + def.signature! }, [def]);
    expect(isCppBindingTargetAllowed(def, ref, context)).toBe(true);
  });

  it('does not infer static from an incomplete prior parameter list', () => {
    const def = symbol('other.cpp', 'pick', 'int pick(int value){return value;}', { startLine: 2 });
    const { context, ref } = fixture({ 'caller.cpp': 'int caller(){return pick(1);}',
      'other.cpp': 'static int pick(UNSUPPORTED_PARAMETER_LIST;\n' + def.signature! }, [def]);
    expect(isCppBindingTargetAllowed(def, ref, context)).toBe(true);
  });

  it('keeps an extern C header declaration ahead of an unrelated C++ namesake', () => {
    const decl = symbol('api.h', 'pick', 'int pick();', { language: 'c', startLine: 2, isDeclaration: true });
    const foreign = symbol('other.cpp', 'pick', 'int pick() {return 2;}');
    const { context, ref } = fixture({ 'caller.cpp': '#include "api.h"\nint caller(){return pick();}',
      'api.h': 'extern "C" {\nint pick();\n}', 'other.cpp': foreign.signature! }, [decl, foreign]);
    expect(filterCppBindingCandidates([foreign, decl], ref, context)).toEqual([decl]);
    expect(isCppBindingTargetAllowed(foreign, ref, context)).toBe(false);
  });

  it('does not let a C-linkage overload veto a distinct visible C++ overload', () => {
    const cDecl = symbol('api.h', 'pick', 'extern "C" int pick(int value);', { isDeclaration: true });
    const cppDecl = symbol('api2.h', 'pick', 'int pick(double value);', { isDeclaration: true });
    const def = symbol('other.cpp', 'pick', 'int pick(double value){return 1;}');
    const { context, ref } = fixture({ 'caller.cpp': '#include "api.h"\n#include "api2.h"\nint caller(){return pick(1.5);}',
      'api.h': cDecl.signature!, 'api2.h': cppDecl.signature!, 'other.cpp': def.signature! }, [cDecl, cppDecl, def]);
    expect(isCppBindingTargetAllowed(def, ref, context)).toBe(true);
    expect(filterCppBindingCandidates([def, cDecl, cppDecl], ref, context)).toContain(def);
  });

  it.each(['static int pick = 1;', 'constexpr int pick = 1;', 'const int pick = 1;',
    'namespace { int pick = 1; }'])('rejects an un-included internal variable: %s', declaration => {
    const variable = symbol('other.cpp', 'pick', '1', { kind: 'variable', startColumn: declaration.indexOf('pick') });
    const { context, ref } = fixture({ 'caller.cpp': 'int caller(){return pick;}', 'other.cpp': declaration }, [variable]);
    ref.referenceKind = 'references';
    expect(isCppBindingTargetAllowed(variable, ref, context)).toBe(false);
  });

  it.each(['const char *pick = nullptr;', 'inline constexpr int pick = 1;', 'extern const int pick = 1;',
    'extern const int pick;\nconst int pick = 1;', 'struct Owner { static constexpr int pick = 1; };'])
  ('does not infer internal linkage from insufficient const evidence: %s', declaration => {
    const at = declaration.lastIndexOf('pick');
    const variable = symbol('other.cpp', 'pick', '1', { kind: 'variable',
      startLine: declaration.slice(0, at).split('\n').length,
      startColumn: at - declaration.lastIndexOf('\n', at) - 1 });
    const { context, ref } = fixture({ 'caller.cpp': 'int caller(){return pick;}', 'other.cpp': declaration }, [variable]);
    ref.referenceKind = 'references';
    expect(isCppBindingTargetAllowed(variable, ref, context)).toBe(true);
  });

  it('recovers the declared builtin type when a variable signature contains only its initializer', () => {
    const variable = symbol('other.cpp', 'pick', '42', { kind: 'variable' });
    const { context, ref } = fixture({ 'caller.cpp': '#define pick(x) (x)\nint caller(){return pick(1);}',
      'other.cpp': 'int pick = 42;' }, [variable]);
    expect(isCppBindingTargetAllowed(variable, ref, context)).toBe(false);
    ref.referenceKind = 'references';
    expect(isCppBindingTargetAllowed(variable, ref, context)).toBe(true);
  });

  it.each(['int (*pick)(int) = target;', 'int (&pick)(int) = target;', 'Callable pick;',
    'auto pick = [](int value) { return value; };'])('preserves callable or unknown objects: %s', declaration => {
    const variable = symbol('caller.cpp', 'pick', 'target', { kind: 'variable' });
    const { context, ref } = fixture({ 'caller.cpp': `${declaration}\nint caller(){return pick(1);}` }, [variable]);
    expect(isCppBindingTargetAllowed(variable, ref, context)).toBe(true);
  });

  it.each(['api.h', 'implementation.cpp'])('preserves directly included static definitions in %s', file => {
    const target = symbol(file, 'pick', 'static int pick(){return 1;}', { isStatic: true });
    const { context, ref } = fixture({ 'caller.cpp': `#include "${file}"\nint caller(){return pick();}`,
      [file]: target.signature! }, [target]);
    expect(isCppBindingTargetAllowed(target, ref, context)).toBe(true);
  });

  it('preserves a matching external definition behind a visible declaration', () => {
    const decl = symbol('api.h', 'pick', 'extern int pick(int argument);', { isDeclaration: true });
    const def = symbol('other.cpp', 'pick', 'int pick(int value){return value;}');
    const { context, ref } = fixture({ 'caller.cpp': '#include "api.h"\nint caller(){return pick(1);}',
      'api.h': decl.signature!, 'other.cpp': def.signature! }, [decl, def]);
    expect(filterCppBindingCandidates([def, decl], ref, context)).toContain(def);
  });

  it('preserves a C definition behind the usual __cplusplus linkage wrapper', () => {
    const decl = symbol('api.h', 'pick', 'int pick(int argument);', { language: 'c', startLine: 4, isDeclaration: true });
    const def = symbol('implementation.c', 'pick', 'int pick(int value){return value;}', { language: 'c' });
    const { context, ref } = fixture({ 'caller.cpp': '#include "api.h"\nint caller(){return pick(1);}',
      'api.h': '#ifdef __cplusplus\nextern "C" {\n#endif\nint pick(int argument);\n#ifdef __cplusplus\n}\n#endif',
      'implementation.c': def.signature! }, [decl, def]);
    expect(filterCppBindingCandidates([def, decl], ref, context)).toContain(def);
    expect(isCppBindingTargetAllowed(def, ref, context)).toBe(true);
  });

  it('inherits C linkage for a C++ definition that includes the C API declaration', () => {
    const decl = symbol('api.h', 'pick', 'extern "C" int pick(int argument);', { isDeclaration: true });
    const def = symbol('implementation.cpp', 'pick', 'int pick(int value){return value;}', { startLine: 2 });
    const foreign = symbol('other.cpp', 'pick', 'int pick(int value){return value + 1;}');
    const { context, ref } = fixture({ 'caller.cpp': '#include "api.h"\nint caller(){return pick(1);}',
      'api.h': decl.signature!, 'implementation.cpp': '#include "api.h"\n' + def.signature!,
      'other.cpp': foreign.signature! }, [decl, def, foreign]);
    expect(filterCppBindingCandidates([def, foreign, decl], ref, context)).toEqual([def, decl]);
    expect(isCppBindingTargetAllowed(def, ref, context)).toBe(true);
    expect(isCppBindingTargetAllowed(foreign, ref, context)).toBe(false);
  });

  it('keeps header inline functions and transitive quoted includes', () => {
    const target = symbol('include/detail/leaf.h', 'pick', 'inline int pick(){return 1;}');
    const { context, ref } = fixture({ 'caller.cpp': '#include "include/api.h"\nint caller(){return pick();}',
      'include/api.h': '#include "detail/leaf.h"', 'include/detail/leaf.h': target.signature! }, [target]);
    expect(filterCppBindingCandidates([target], ref, context)).toEqual([target]);
  });

  it('does not infer C internal linkage from an ordinary const object', () => {
    const variable = symbol('other.c', 'pick', '1', { language: 'c', kind: 'variable' });
    const { context, ref } = fixture({ 'caller.cpp': 'int caller(){return pick;}', 'other.c': 'const int pick = 1;' }, [variable]);
    ref.referenceKind = 'references';
    expect(isCppBindingTargetAllowed(variable, ref, context)).toBe(true);
  });

  it('retains same-file variable references regardless of test-looking path', () => {
    const variable = symbol('tests/caller.cpp', 'pick', 'int pick = 3;', { kind: 'variable' });
    const { context, ref } = fixture({ 'caller.cpp': '', 'tests/caller.cpp': 'int pick = 3;\nint caller(){return pick;}' }, [variable]);
    Object.assign(ref, { referenceKind: 'references', filePath: 'tests/caller.cpp', line: 2 });
    expect(filterCppBindingCandidates([variable], ref, context)).toEqual([variable]);
  });

  it('keeps possibly included definitions unknown but excludes unrelated static files', () => {
    const possible = symbol('possible.h', 'pick', 'static int pick(){return 1;}', { isStatic: true });
    const foreign = symbol('other.cpp', 'pick', 'static int pick(){return 2;}', { isStatic: true });
    const { context, ref } = fixture({ 'caller.cpp': '#ifdef FEATURE\n#include "possible.h"\n#endif\nint caller(){return pick();}',
      'possible.h': '#ifndef GUARD\n#define GUARD\n' + possible.signature! + '\n#endif',
      'other.cpp': foreign.signature! }, [{ ...possible, startLine: 3 }, foreign]);
    expect(isCppBindingTargetAllowed({ ...possible, startLine: 3 }, ref, context)).toBe(true);
    expect(isCppBindingTargetAllowed(foreign, ref, context)).toBe(false);
  });

  it('does not turn a global include-directory first hit into a definite visible candidate', () => {
    const a = symbol('variant-a/api.h', 'pick', 'int pick();', { isDeclaration: true });
    const b = symbol('variant-b/api.h', 'pick', 'int pick();', { isDeclaration: true });
    const { context, ref } = fixture({ 'caller.cpp': '#include <api.h>\nint caller(){return pick();}',
      'variant-a/api.h': a.signature!, 'variant-b/api.h': b.signature! }, [a, b], ['variant-a', 'variant-b']);
    expect(filterCppBindingCandidates([b, a], ref, context)).toEqual([b, a]);
  });

  it('treats missing source and macro includes as unknown rather than proven invisibility', () => {
    const target = symbol('other.cpp', 'pick', 'static int pick(){return 1;}', { isStatic: true });
    const { context, ref } = fixture({ 'caller.cpp': '#include SELECT_HEADER\nint caller(){return pick();}',
      'other.cpp': target.signature! }, [target]);
    expect(isCppBindingTargetAllowed(target, ref, context)).toBe(true);
    expect(isCppBindingTargetAllowed({ ...target, filePath: 'missing.cpp' }, ref, context)).toBe(true);
  });

  it('does not use an inactive or later include as a positive witness', () => {
    const target = symbol('other.cpp', 'pick', 'static int pick(){return 1;}', { isStatic: true });
    const { context, ref } = fixture({ 'caller.cpp': '#if 0\n#include "other.cpp"\n#endif\nint caller(){return pick();}\n#include "other.cpp"',
      'other.cpp': target.signature! }, [target]);
    ref.line = 4;
    expect(isCppBindingTargetAllowed(target, ref, context)).toBe(false);
  });

  it('does not invent external linkage from missing flags and an unsupported macro declaration', () => {
    const decl = symbol('api.h', 'pick', 'extern "C" int pick();', { isDeclaration: true });
    const unknown = symbol('other.cpp', 'pick', 'API int pick(){return 1;}');
    const { context, ref } = fixture({ 'caller.cpp': '#include "api.h"\nint caller(){return pick();}',
      'api.h': decl.signature!, 'other.cpp': unknown.signature! }, [decl, unknown]);
    expect(isCppBindingTargetAllowed(unknown, ref, context)).toBe(true);
  });

  it('invalidates source evidence explicitly and does not share evidence between contexts', () => {
    const target = symbol('other.cpp', 'pick', '1', { kind: 'variable' });
    const files = { 'caller.cpp': 'int caller(){return pick();}', 'other.cpp': 'int pick = 1;' };
    const { context, ref } = fixture(files, [target]);
    expect(isCppBindingTargetAllowed(target, ref, context)).toBe(false);
    isCppBindingTargetAllowed(target, ref, context);
    expect(vi.mocked(context.readFile).mock.calls.filter(([file]) => file === 'other.cpp')).toHaveLength(1);
    files['other.cpp'] = 'Callable pick;';
    expect(isCppBindingTargetAllowed(target, ref, fixture(files, [target]).context)).toBe(true);
    clearCppBindingEvidence(context);
    expect(isCppBindingTargetAllowed(target, ref, context)).toBe(true);
  });

  it('recomputes identical evidence after bounded cache eviction', () => {
    const nodes = Array.from({ length: 600 }, (_, index) => symbol(`file-${index}.cpp`, 'pick', '1', { kind: 'variable' }));
    const files = Object.fromEntries(nodes.map(node => [node.filePath, 'int pick = 1;']));
    files['caller.cpp'] = 'int caller(){return pick();}';
    const { context, ref } = fixture(files, nodes);
    for (const node of nodes) expect(isCppBindingTargetAllowed(node, ref, context)).toBe(false);
    expect(isCppBindingTargetAllowed(nodes[0]!, ref, context)).toBe(false);
    expect(vi.mocked(context.readFile).mock.calls.filter(([file]) => file === nodes[0]!.filePath)).toHaveLength(2);
  });
});
