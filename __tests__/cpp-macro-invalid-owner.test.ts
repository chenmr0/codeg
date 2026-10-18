import { beforeAll, expect, it } from 'vitest';
import { extractFromSource } from '../src/extraction/tree-sitter';
import { loadGrammarsForLanguages } from '../src/extraction/grammars';
import { scanMacroContribution } from '../src/extraction/macro-scan';
import { selectUnambiguousCppMacroDefinitions } from '../src/extraction/declaration-macros';

beforeAll(() => loadGrammarsForLanguages(['cpp']));
function extract(source: string, other = '') {
  const c = scanMacroContribution(source + '\n' + other);
  return extractFromSource('case.cpp', source, 'cpp', undefined, new Set(c.names), new Set(c.bodyless),
    selectUnambiguousCppMacroDefinitions(c.definitions));
}

it.each(['0x123_Name', '123_Name', '1e3_Name'])('pairs the same callable under a split numeric owner: %s', name => {
  const source = `#define MAKE() class ${name} { public: void invoke(); }; void ${name}::invoke() {}\nMAKE()\n`;
  const result = extract(source);
  expect(result.nodes.filter(n => n.name === 'invoke' && n.isDeclaration)).toEqual([]);
});

it('does not merge different numeric owners, overloads, or unmatched declarations', () => {
  const source = '#define MAKE() class 0x123_Name { void invoke(int); void invoke(double); void unmatched(); }; void 0x123_Name::invoke(int) {} class 0x456_Name { void invoke(int); };\nMAKE()\n';
  const result = extract(source);
  expect(result.nodes.filter(n => n.name === 'invoke')).toHaveLength(3);
  expect(result.nodes.filter(n => n.name === 'invoke' && n.isDeclaration)).toHaveLength(2);
  expect(result.nodes.filter(n => n.name === 'unmatched' && n.isDeclaration)).toHaveLength(1);
});

it('removes only the newly admitted declaration in the unrelated-header reproduction', () => {
  const source = '#define NAME(s,n) s##_##n##_Type\n#define IMPL(s,n) class NAME(s,n) { public: void invoke(); }; void NAME(s,n)::invoke()\n#define BUILD(s,n) IMPL(s,n)\nBUILD(Tag, Case) {}\n';
  const clean = extract(source).nodes.filter(n => n.name === 'invoke');
  const poisoned = extract(source, '#define Tag 0x123\n').nodes.filter(n => n.name === 'invoke');
  expect(clean).toHaveLength(1);
  expect(clean[0].qualifiedName).toBe('Tag_Case_Type::invoke');
  expect(poisoned.filter(n => n.isDeclaration)).toEqual([]);
  // The pre-289 erroneous definition is intentionally outside this fix.
  expect(poisoned.filter(n => !n.isDeclaration)).toHaveLength(1);
});

it('retains valid digit-bearing owners, overloads, and implicit helper recovery', () => {
  const result = extract('#define DECL(n) HELPER(n)\nDECL(A1)\n',
    '#define HELPER(n) struct n { void invoke(int); void invoke(double); };\n');
  expect(result.nodes.filter(n => n.name === 'invoke').map(n => n.qualifiedName))
    .toEqual(['A1::invoke', 'A1::invoke']);
});
