import { describe, expect, it, vi } from 'vitest';
import type { Node } from '../src/types';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types';
import { isCppCallTargetAllowed, matchByExactName, matchByQualifiedName, matchReference } from '../src/resolution/name-matcher';
import { clearCppBindingEvidence } from '../src/resolution/cpp-binding-evidence';

// Independent synthetic owners/names: the cost bound must not depend on any
// repository, receiver spelling, or number of unrelated same-named methods.
function fixture(noise: number, name = 'calibrate', form = 'receiver') {
  let source = `void Gauge::invoke(Dial value) {\n  value.${name}(1);\n}`;
  const node = (id: string, qualifiedName: string, kind: Node['kind'], signature?: string): Node => ({
    id, name: qualifiedName.split('::').pop()!, qualifiedName, kind, signature,
    filePath: 'probe.cpp', language: 'cpp', startLine: 1, endLine: 3,
    startColumn: 0, endColumn: 1, updatedAt: 1,
  });
  const nodes = [node('dial', 'Dial', 'struct'), node('base', 'Instrument', 'struct'),
    node('gauge', 'Gauge', 'struct'), node('caller', 'Gauge::invoke', 'method'),
    node('zero', `Instrument::${name}`, 'method', `void ${name}()`),
    node('one', `Instrument::${name}`, 'method', `void ${name}(int value)`),
    ...Array.from({ length: noise }, (_, i) => node(`noise-${i}`, `Unrelated${i}::${name}`, 'method', `void ${name}(int value)`))];
  const ref: UnresolvedRef = { fromNodeId: 'caller', referenceName: `value.${name}`, referenceKind: 'calls',
    filePath: 'probe.cpp', language: 'cpp', line: 2, column: 2 };
  if (form === 'bare') { ref.referenceName = name; source = `void Gauge::invoke() {\n  ${name}(1);\n}`; }
  if (form === 'qualified') { ref.referenceName = `Dial::${name}`; source = `void Gauge::invoke() {\n  Dial::${name}(1);\n}`; }
  const getMethodMatches = vi.fn((type: string, method: string, language: string) =>
    nodes.filter(n => n.kind === 'method' && n.language === language && n.qualifiedName === `${type}::${method}`));
  const getCppReceiverDeclarations = vi.fn(() => null);
  const context: ResolutionContext = {
    getNodesByName: name => nodes.filter(n => n.name === name),
    getNodesByQualifiedName: name => nodes.filter(n => n.qualifiedName === name),
    getNodesByLowerName: name => nodes.filter(n => n.name.toLowerCase() === name),
    getNodesInFile: file => nodes.filter(n => n.filePath === file),
    getNodesByKind: kind => nodes.filter(n => n.kind === kind),
    getMethodMatches, getCppReceiverDeclarations,
    getSupertypes: type => type === 'Dial' || type === 'Gauge' ? ['Instrument'] : [],
    readFile: file => file === 'probe.cpp' ? source : null,
    getFileLines: file => file === 'probe.cpp' ? source.split('\n') : null,
    fileExists: file => file === 'probe.cpp', getAllFiles: () => ['probe.cpp'],
    getProjectRoot: () => '.', getImportMappings: () => [],
  };
  return { nodes, ref, context, getMethodMatches, getCppReceiverDeclarations,
    setSource(text: string) { source = text; clearCppBindingEvidence(context); } };
}

describe('C++ per-filter member scope evidence', () => {
  it.each(['calibrate', 'drain'])('keeps %s receiver/inheritance work constant as unrelated candidates grow', name => {
    const costs: number[][] = [];
    for (const noise of [1, 160]) {
      const f = fixture(noise, name);
      // Qualified-name fallback scans every same-named candidate once. It does
      // not resolve a dotted spelling itself, but must apply the member gate.
      expect(matchByQualifiedName(f.ref, f.context)).toBeNull();
      expect(f.getCppReceiverDeclarations).toHaveBeenCalledTimes(1);
      expect(f.getMethodMatches).toHaveBeenCalledTimes(4); // two owners × C/C++
      costs.push([f.getCppReceiverDeclarations.mock.calls.length, f.getMethodMatches.mock.calls.length]);
      expect(matchReference(f.ref, f.context)?.targetNodeId).toBe('one');
      expect(isCppCallTargetAllowed(f.nodes.find(n => n.id === 'zero')!, f.ref, f.context)).toBe(false);
      expect(isCppCallTargetAllowed(f.nodes.find(n => n.id === 'noise-0')!, f.ref, f.context)).toBe(false);
    }
    expect(costs[0]).toEqual(costs[1]);
  });

  it.each(['bare', 'qualified'])('shares the %s owner walk, preserving inherited overload admission', form => {
    for (const noise of [1, 160]) {
      const f = fixture(noise, 'polish', form);
      if (form === 'bare') expect(matchByExactName(f.ref, f.context)?.targetNodeId).toBe('one');
      else expect(matchByQualifiedName(f.ref, f.context)).toBeNull();
      expect(f.getMethodMatches).toHaveBeenCalledTimes(4);
      expect(f.getCppReceiverDeclarations).not.toHaveBeenCalled();
      expect(isCppCallTargetAllowed(f.nodes.find(n => n.id === 'one')!, f.ref, f.context)).toBe(true);
    }
  });

  it('shares bare-name hiding evidence without admitting a same-named free helper', () => {
    const f = fixture(0, 'polish', 'bare');
    // An incompatible direct member still hides free functions. The inherited
    // compatible overload must also remain hidden without a using declaration.
    f.nodes.push({ ...f.nodes.find(n => n.id === 'zero')!, id: 'own', qualifiedName: 'Gauge::polish' });
    for (let i = 0; i < 80; i++) f.nodes.push({ ...f.nodes.find(n => n.id === 'one')!,
      id: `free-${i}`, kind: 'function', qualifiedName: 'polish' });
    expect(matchByExactName(f.ref, f.context)).toBeNull();
    // One direct lookup for the method gate and one for free-function hiding.
    expect(f.getMethodMatches).toHaveBeenCalledTimes(4);
  });

  it('retains unknown arity but does not choose an ambiguous overload', () => {
    const f = fixture(80);
    f.setSource('void Gauge::invoke(Dial value) {\n  value.calibrate(values...);\n}');
    const zero = f.nodes.find(n => n.id === 'zero')!, one = f.nodes.find(n => n.id === 'one')!;
    expect(isCppCallTargetAllowed(zero, f.ref, f.context)).toBe(true);
    expect(isCppCallTargetAllowed(one, f.ref, f.context)).toBe(true);
    expect(matchReference(f.ref, f.context)).toBeNull();
  });

  it('keeps unknown receiver evidence local and retries after the source snapshot changes', () => {
    const f = fixture(160);
    f.setSource('void Gauge::invoke() {\n  missing.calibrate(1);\n}');
    f.ref.referenceName = 'missing.calibrate';
    expect(matchByQualifiedName(f.ref, f.context)).toBeNull();
    expect(f.getCppReceiverDeclarations).toHaveBeenCalledTimes(1);
    expect(f.getMethodMatches).not.toHaveBeenCalled();
    f.setSource('void Gauge::invoke(Dial missing) {\n  missing.calibrate(1);\n}');
    expect(matchReference(f.ref, f.context)?.targetNodeId).toBe('one');
  });

  it('does not retain an empty method set across inheritance updates or final admission', () => {
    const f = fixture(40);
    f.context.getSupertypes = () => [];
    expect(matchByQualifiedName(f.ref, f.context)).toBeNull();
    expect(f.getMethodMatches).toHaveBeenCalledTimes(2);
    f.context.getSupertypes = type => type === 'Dial' ? ['Instrument'] : [];
    expect(matchReference(f.ref, f.context)?.targetNodeId).toBe('one');
    f.context.getSupertypes = () => [];
    expect(isCppCallTargetAllowed(f.nodes.find(n => n.id === 'one')!, f.ref, f.context)).toBe(false);
  });

  it('discards partial evidence after a failed walk and succeeds on retry', () => {
    const f = fixture(40);
    f.getMethodMatches.mockImplementationOnce(() => { throw new Error('interrupted member lookup'); });
    expect(() => matchByQualifiedName(f.ref, f.context)).toThrow('interrupted member lookup');
    expect(matchReference(f.ref, f.context)?.targetNodeId).toBe('one');
  });

  it('does not reuse a prior reference or source snapshot with the same receiver spelling', () => {
    const f = fixture(1);
    expect(matchReference(f.ref, f.context)?.targetNodeId).toBe('one');
    f.setSource('void Gauge::invoke(Unrelated0 value) {\n  value.calibrate(1);\n}');
    expect(matchReference({ ...f.ref }, f.context)?.targetNodeId).toBe('noise-0');
    f.setSource('void Gauge::invoke(Dial value) {\n  value.calibrate(1);\n}');
    expect(matchReference(f.ref, f.context)?.targetNodeId).toBe('one');
  });

  it('leaves receiver lookup lazy when every candidate fails arity or is an exact qualified match', () => {
    const f = fixture(0);
    f.nodes.splice(f.nodes.findIndex(n => n.id === 'one'), 1);
    expect(matchByQualifiedName(f.ref, f.context)).toBeNull();
    expect(f.getCppReceiverDeclarations).not.toHaveBeenCalled();
    expect(f.getMethodMatches).not.toHaveBeenCalled();
    f.ref.referenceName = 'Instrument::calibrate';
    f.setSource('void invoke() {\n  Instrument::calibrate();\n}');
    expect(matchByQualifiedName(f.ref, f.context)?.targetNodeId).toBe('zero');
    expect(f.getMethodMatches).not.toHaveBeenCalled();
  });
});
