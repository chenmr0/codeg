import { beforeAll, describe, expect, it } from 'vitest';
import { extractFromSource } from '../src/extraction/tree-sitter';
import { loadGrammarsForLanguages } from '../src/extraction/grammars';

beforeAll(() => loadGrammarsForLanguages(['c', 'cpp', 'go']));

describe('inheritance syntax stays language-scoped', () => {
  it('does not treat a C++ friend or a recovered type-only member as a base class', () => {
    const result = extractFromSource('friends.hpp',
      'class Base {};\nclass Friend {};\nclass Owner : public Base { friend class Friend; Friend; };\n', 'cpp');
    expect(result.unresolvedReferences.filter(r => r.referenceKind === 'extends').map(r => r.referenceName)).toEqual(['Base']);
  });
  it('retains real Go embedded struct types', () => {
    const result = extractFromSource('embed.go', 'package p\ntype Base struct {}\ntype Owner struct { Base }\n', 'go');
    expect(result.unresolvedReferences.filter(r => r.referenceKind === 'extends').map(r => r.referenceName)).toContain('Base');
  });
  it('preserves the scope of qualified identifier references and does not duplicate qualified calls as bare refs', () => {
    const result=extractFromSource('scoped.cpp',
      'int read() { ns::invoke(); return static_cast<int>(Color::kFloat) + ns::value; }\n','cpp');
    const names=result.unresolvedReferences.filter(r=>r.referenceKind==='references').map(r=>r.referenceName);
    expect(names).toContain('Color::kFloat');
    expect(names).toContain('ns::value');
    expect(names).not.toContain('kFloat');
    expect(names).not.toContain('value');
    expect(names).not.toContain('invoke');
    expect(result.unresolvedReferences.filter(r=>r.referenceKind==='calls').map(r=>r.referenceName)).toContain('ns::invoke');
  });
});
