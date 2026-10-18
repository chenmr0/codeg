import { beforeAll, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src';
import { buildMacroContext } from '../src/extraction/macro-scan';
import { extractFromSource } from '../src/extraction/tree-sitter';
import { expandDeclarationMacros } from '../src/extraction/declaration-macros';
import { visibleMacroDefinitions } from '../src/extraction/macro-visibility';
import { loadGrammarsForLanguages } from '../src/extraction/grammars';

beforeAll(() => loadGrammarsForLanguages(['cpp']));

// Reconstructed from the readable release supplement; original tar unavailable.
const source = `#define TEST_CLASS(suite, name) suite##_##name##_Test
#define TEST_IMPL(suite, name) class TEST_CLASS(suite, name) { public: void TestBody(); }; void TEST_CLASS(suite, name)::TestBody()
#define TEST(suite, name) TEST_IMPL(suite, name)
namespace rocksdb { namespace crc32c {
class CRC {};
TEST(CRC, StandardResults) {}
}}
`;

it('unrelated header addition and removal do not change legal TestBody symbols', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-macro-visibility-'));
  try {
    fs.writeFileSync(path.join(root, 'test.cpp'), source);
    const snapshots = [];
    for (const poison of [false, true, false]) {
      const header = path.join(root, 'unrelated.h');
      if (poison) fs.writeFileSync(header, '#define CRC 0x1edc6f41\n');
      else if (fs.existsSync(header)) fs.unlinkSync(header);
      fs.rmSync(path.join(root, '.codegraph-wx'), { recursive: true, force: true });
      const cg = CodeGraph.initSync(root);
      try {
        await cg.indexAll();
        snapshots.push(cg.getNodesByName('TestBody').map(n => ({ name: n.qualifiedName, declaration: !!n.isDeclaration })));
      } finally { cg.close(); }
    }
    expect(snapshots[0]).toEqual([{ name: 'rocksdb::crc32c::CRC_StandardResults_Test::TestBody', declaration: false }]);
    expect(snapshots[1]).toEqual(snapshots[0]);
    expect(snapshots[2]).toEqual(snapshots[0]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 30000);

async function withProject(files: Record<string, string>, check: (source: string, context: Awaited<ReturnType<typeof buildMacroContext>>) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-visible-'));
  try {
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    }
    check(files['main.cpp']!, await buildMacroContext(root, Object.keys(files)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

it('retains included nested helpers despite unrelated same-name conflicts', async () => {
  await withProject({
    'main.cpp': '#include "api.h"\nBUILD(Widget)\n',
    'api.h': '#include "detail.h"\n#define BUILD(x) HELPER(x)\n',
    'detail.h': '#define HELPER(x) struct x { int field; };\n',
    'unrelated.h': '#define HELPER(x) struct Wrong {};\n',
  }, (source, context) => {
    const result = extractFromSource('main.cpp', source, 'cpp', undefined, context.names, context.bodyless,
      context.definitions, undefined, context.project);
    expect(result.nodes.filter(n => n.kind === 'struct').map(n => n.name)).toEqual(['Widget']);
    expect(result.nodes.some(n => n.name === 'field')).toBe(true);
  });
});

it('does not import macros from comments, computed includes or ambiguous suffixes', async () => {
  await withProject({
    'main.cpp': 'const char *text = R"tag(\n#include "poison.h"\n)tag";\n/*\n#include "poison.h"\n*/\n#include HEADER\n#include <same.h>\nBUILD(Widget)\n',
    'poison.h': '#define BUILD(x) struct x {};\n',
    'a/same.h': '#define BUILD(x) struct x {};\n',
    'b/same.h': '#define BUILD(x) struct Wrong {};\n',
  }, (source, context) => {
    expect(visibleMacroDefinitions(context.project, 'main.cpp', source)).toEqual([]);
  });
});

it('resolves unique include roots and terminates include cycles', async () => {
  await withProject({
    'main.cpp': '#include <lib/api.h>\nBUILD(Widget)\n',
    'vendor/lib/api.h': '#include "loop.h"\n#define BUILD(x) struct x {};\n',
    'vendor/lib/loop.h': '#include "api.h"\n',
  }, (source, context) => {
    expect(expandDeclarationMacros(source, visibleMacroDefinitions(context.project, 'main.cpp', source)).source)
      .toContain('struct Widget {};');
  });
});

it('keeps included conflicting definitions ambiguous', async () => {
  await withProject({
    'main.cpp': '#include "a.h"\n#include "b.h"\nBUILD(Widget)\n',
    'a.h': '#define BUILD(x) struct x {};\n',
    'b.h': '#define BUILD(x) struct Wrong {};\n',
  }, (source, context) => {
    expect(expandDeclarationMacros(source, visibleMacroDefinitions(context.project, 'main.cpp', source)).source).toBe(source);
  });
});

it('uses local helper definitions at each invocation and honors undef', () => {
  const source = '#define BUILD(x) struct x {};\nBUILD(ALIAS)\n#define ALIAS First\nBUILD(ALIAS)\n#undef ALIAS\nBUILD(ALIAS)\n#define ALIAS Second\nBUILD(ALIAS)\n#undef BUILD\nBUILD(NoExpansion)\n';
  const expanded = expandDeclarationMacros(source, []).source;
  expect(expanded.match(/struct ALIAS/g)).toHaveLength(2);
  expect(expanded).toContain('struct First {};');
  expect(expanded).toContain('struct Second {};');
  expect(expanded).toContain('BUILD(NoExpansion)');
});

it('does not expose included macros before the include and respects local undef', async () => {
  await withProject({
    'main.cpp': 'BUILD(Before)\n#include "api.h"\nBUILD(After)\n#undef BUILD\nBUILD(Undefined)\n',
    'api.h': '#define BUILD(x) struct x {};\n',
  }, (source, context) => {
    const expanded = expandDeclarationMacros(source, visibleMacroDefinitions(context.project, 'main.cpp', source)).source;
    expect(expanded).toContain('BUILD(Before)');
    expect(expanded).toContain('struct After {};');
    expect(expanded).toContain('BUILD(Undefined)');
  });
});

it('preserves overloads, owners, qualifiers and constructors with local-only macros', async () => {
  const source = '#define BUILD() struct A { A(); void run(int); void run(double); void get() const &; void get() &; }; struct B { void run(int); };\nBUILD()\n';
  await withProject({ 'main.cpp': source }, (source, context) => {
    const result = extractFromSource('main.cpp', source, 'cpp', undefined, context.names, context.bodyless,
      context.definitions, undefined, context.project);
    expect(result.nodes.filter(n => n.name === 'run')).toHaveLength(3);
    expect(result.nodes.filter(n => n.name === 'get')).toHaveLength(2);
    expect(result.nodes.some(n => n.kind === 'constructor' || n.name === 'A' && n.qualifiedName === 'A::A')).toBe(true);
    expect(new Set(result.nodes.map(n => n.id)).size).toBe(result.nodes.length);
  });
});

it('pre-expands object-like arguments from real includes through nested wrappers', async () => {
  await withProject({
    'main.cpp': '#include "api.h"\nBUILD(NAME)\n',
    'api.h': '#define NAME Included\n#define INNER(x) struct x##_Type {};\n#define BUILD(x) INNER(x)\n',
    'unrelated.h': '#define NAME Wrong\n',
  }, (source, context) => {
    const expanded = expandDeclarationMacros(source, visibleMacroDefinitions(context.project, 'main.cpp', source));
    expect(expanded.source).toContain('struct Included_Type {};');
  });
});
