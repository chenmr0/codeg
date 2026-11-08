import { describe, expect, it, vi } from 'vitest';
import type { Node } from '../src/types';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types';
import { isCppBindingTargetAllowed } from '../src/resolution/cpp-binding-evidence';

function symbol(filePath: string, name: string, signature: string, extra: Partial<Node> = {}): Node {
  return { id: `${filePath}:${name}`, name, qualifiedName: name, filePath, language: 'cpp',
    kind: 'function', startLine: 1, endLine: 1, startColumn: 0, endColumn: signature.length,
    signature, updatedAt: 0, ...extra };
}

function fixture(name: string, files: Record<string, string>, nodes: Node[]) {
  const getNodesByName = vi.fn((name: string) => nodes.filter(node => node.name === name));
  const readFile = vi.fn((file: string) => files[file] ?? null);
  const context: ResolutionContext = {
    getNodesInFile: file => nodes.filter(node => node.filePath === file),
    getNodesByName,
    getNodesByQualifiedName: name => nodes.filter(node => node.qualifiedName === name),
    getNodesByKind: kind => nodes.filter(node => node.kind === kind),
    getNodesByLowerName: name => nodes.filter(node => node.name.toLowerCase() === name),
    readFile, fileExists: file => file in files,
    getAllFiles: () => Object.keys(files), getProjectRoot: () => '/project',
    getImportMappings: () => [],
  };
  const ref: UnresolvedRef = { fromNodeId: 'caller', referenceName: name, referenceKind: 'calls',
    filePath: 'caller.cpp', language: 'cpp', line: files['caller.cpp']!.split('\n').length, column: 20 };
  return { context, ref, getNodesByName, readFile };
}

describe.each(['measureFlux', 'settleWave'])('C/C++ linkage witness cost for %s', name => {
  it.each(['variable', 'constant'] as const)('skips same-name lookup for a %s target', kind => {
    const target = symbol('target.cpp', name, `int ${name} = 1;`, { kind });
    const other = symbol('unrelated.cpp', name, `int ${name}();`);
    const f = fixture(name, { 'caller.cpp': `int caller(){return ${name};}`,
      'target.cpp': target.signature!, 'unrelated.cpp': other.signature! }, [target, other]);
    f.ref.referenceKind = 'references';
    expect(isCppBindingTargetAllowed(target, f.ref, f.context)).toBe(true);
    expect(f.getNodesByName).not.toHaveBeenCalled();
    expect(f.readFile.mock.calls.map(([file]) => file).sort()).toEqual(['caller.cpp', 'target.cpp']);
  });

  it.each([1, 160])('does not read %s nonfunction witnesses for a function target', count => {
    const target = symbol('target.cpp', name, `int ${name}(){return 1;}`);
    const others = Array.from({ length: count }, (_, i) => symbol(`unrelated-${i}.cpp`, name,
      `int ${name} = 2;`, { kind: i % 2 ? 'constant' : 'variable' }));
    const f = fixture(name, { 'caller.cpp': `int caller(){return ${name}();}`,
      'target.cpp': target.signature!, ...Object.fromEntries(others.map(node => [node.filePath, node.signature!])) },
    [target, ...others]);
    expect(isCppBindingTargetAllowed(target, f.ref, f.context)).toBe(true);
    expect(f.getNodesByName).toHaveBeenCalledTimes(1);
    expect(f.getNodesByName).toHaveBeenCalledWith(name);
    expect(f.readFile.mock.calls.map(([file]) => file).sort()).toEqual(['caller.cpp', 'target.cpp']);
  });

  it.each(['Widget', 'PUBLIC int', 'auto'])('skips same-name lookup for a %s return prefix', prefix => {
    const target = symbol('target.cpp', name, `${prefix} ${name}(){return {};}`);
    const other = symbol('unrelated.cpp', name, `extern "C" int ${name}();`);
    const f = fixture(name, { 'caller.cpp': `void caller(){${name}();}`,
      'target.cpp': target.signature!, 'unrelated.cpp': other.signature! }, [target, other]);
    expect(isCppBindingTargetAllowed(target, f.ref, f.context)).toBe(true);
    expect(f.getNodesByName).not.toHaveBeenCalled();
    expect(f.readFile.mock.calls.map(([file]) => file).sort()).toEqual(['caller.cpp', 'target.cpp']);
  });

  it.each(['c', 'cpp'] as const)('still rejects a simple %s function with conflicting visible linkage', language => {
    const file = language === 'c' ? 'target.c' : 'target.cpp';
    const target = symbol(file, name, `int ${name}(int value){return value;}`, { language });
    const witness = symbol('api.h', name, `${language === 'cpp' ? 'extern "C" ' : ''}int ${name}(int value);`,
      { isDeclaration: true });
    const unrelated = symbol('unrelated.cpp', name, `int ${name} = 2;`, { kind: 'variable' });
    const f = fixture(name, { 'caller.cpp': `#include "api.h"\nint caller(){return ${name}(1);}`,
      [file]: target.signature!, 'api.h': witness.signature!, 'unrelated.cpp': unrelated.signature! },
    [target, unrelated, witness]);
    expect(isCppBindingTargetAllowed(target, f.ref, f.context)).toBe(false);
    expect(f.getNodesByName).toHaveBeenCalledWith(name);
    expect(f.readFile).toHaveBeenCalledWith('api.h');
    expect(f.readFile).not.toHaveBeenCalledWith('unrelated.cpp');
  });

  it('keeps a complex-prefix witness unknown even when its C linkage is visible', () => {
    const target = symbol('target.cpp', name, `int ${name}(){return 1;}`);
    const witness = symbol('api.h', name, `extern "C" PUBLIC int ${name}();`, { isDeclaration: true });
    const f = fixture(name, { 'caller.cpp': `#include "api.h"\nint caller(){return ${name}();}`,
      'target.cpp': target.signature!, 'api.h': witness.signature! }, [target, witness]);
    expect(isCppBindingTargetAllowed(target, f.ref, f.context)).toBe(true);
    expect(f.readFile).toHaveBeenCalledWith('api.h');
  });

  it('still propagates a required witness lookup failure and allows retry', () => {
    const target = symbol('target.cpp', name, `int ${name}(){return 1;}`);
    const f = fixture(name, { 'caller.cpp': `int caller(){return ${name}();}`,
      'target.cpp': target.signature! }, [target]);
    f.getNodesByName.mockImplementationOnce(() => { throw new Error('interrupted witness lookup'); });
    expect(() => isCppBindingTargetAllowed(target, f.ref, f.context)).toThrow('interrupted witness lookup');
    expect(isCppBindingTargetAllowed(target, f.ref, f.context)).toBe(true);
    expect(f.getNodesByName).toHaveBeenCalledTimes(2);
  });
});
