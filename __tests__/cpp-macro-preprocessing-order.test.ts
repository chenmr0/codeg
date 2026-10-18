import { expect, it } from 'vitest';
import { expandDeclarationMacros } from '../src/extraction/declaration-macros';

// Expected spellings independently confirmed with g++ -E -P. These distinguish
// argument prescan from #/## substitution and the subsequent token rescan.
const cases = [
  ['direct paste', '#define CLASS(x) struct x##_Probe_Test {};\nCLASS(CRC)', 'struct CRC_Probe_Test {};'],
  ['ordinary wrapper before paste', '#define CLASS(x) struct x##_Probe_Test {};\n#define WRAP(x) CLASS(x)\nWRAP(CRC)', 'struct 0x1edc6f41_Probe_Test {};'],
  ['rescan the pasted token', '#define CRC_Probe_Test Rescanned\n#define CLASS(x) struct x##_Probe_Test {};\nCLASS(CRC)', 'struct Rescanned {};'],
  ['direct stringification', '#define TEXT(x) const char* text = #x;\nTEXT(CRC)', 'const char* text = "CRC";'],
  ['ordinary wrapper before stringification', '#define TEXT(x) const char* text = #x;\n#define WRAP(x) TEXT(x)\nWRAP(CRC)', 'const char* text = "0x1edc6f41";'],
];

it.each(cases)('preserves compiler argument ordering: %s', (_name, source, expected) => {
  const expanded = expandDeclarationMacros(`#define CRC 0x1edc6f41\n${source}\n`, []);
  expect(expanded.source.trim().split('\n').at(-1)).toBe(expected);
});

it('does not treat an outer ordinary argument as protected by a nested paste', () => {
  const source = `#define NAME(s,n) s##_##n##_Test
#define IMPL(s,n) class NAME(s,n) { void TestBody(); }; void NAME(s,n)::TestBody()
#define PUBLIC(s,n) IMPL(s,n)
#define TEST(s,n) PUBLIC(s,n)
TEST(CRC, Sample) {}
`;
  expect(expandDeclarationMacros(source, []).source).toContain('class CRC_Sample_Test');
  expect(expandDeclarationMacros(`#define CRC 0x1edc6f41\n${source}`, []).source)
    .toContain('class 0x1edc6f41_Sample_Test');
});
