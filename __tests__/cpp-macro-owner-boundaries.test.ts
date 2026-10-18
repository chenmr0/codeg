import { beforeAll, expect, it } from 'vitest';
import { createParser, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { macroSemanticId } from '../src/extraction/c-cpp-macro-identity';
import type { Node } from '../src/types';

beforeAll(() => loadGrammarsForLanguages(['cpp']));
// Golden identities from 30d using the same real tree-sitter AST. Unsupported
// numeric spelling and ambiguous owner paths must keep their prior identity.
const cases = [
  {
    "name": "exponent",
    "source": "class 1e+2Foo { void run(); }; class 3e+2Foo { void run(); };",
    "keys": [
      "method:d53bc29825f0576528ae2231f10eeb40",
      "method:d53bc29825f0576528ae2231f10eeb40"
    ]
  },
  {
    "name": "separator",
    "source": "class 1'000Foo { void run(); }; class 2'000Foo { void run(); };",
    "keys": [
      "method:631c622b4505fd8b13bb415bf1c953a2",
      "method:631c622b4505fd8b13bb415bf1c953a2"
    ]
  },
  {
    "name": "unicode",
    "source": "class 1α000Foo { void run(); }; class 2α000Foo { void run(); };",
    "keys": [
      "method:25a01134f49d7d713ddfee2cab2e8f88",
      "method:25a01134f49d7d713ddfee2cab2e8f88"
    ]
  },
  {
    "name": "dollar",
    "source": "class 1$000Foo { void run(); }; class 2$000Foo { void run(); };",
    "keys": [
      "method:57479a286df49181d05399e4792e7b85",
      "method:57479a286df49181d05399e4792e7b85"
    ]
  },
  {
    "name": "escaped",
    "source": "class 1\\u0061000Foo { void run(); }; class 2\\u0061000Foo { void run(); };",
    "keys": [
      "method:69b0be5878d21b3bd20cdb0bc187610b",
      "method:69b0be5878d21b3bd20cdb0bc187610b"
    ]
  },
  {
    "name": "nestedSame",
    "source": "class 0x12Foo { struct x12Foo { void run(); }; };",
    "keys": [
      "method:f4e59f2136377cdaff35633e5aee371f"
    ]
  },
  {
    "name": "nestedSuffix",
    "source": "class 0x12Foo { struct Prefixx12Foo { void run(); }; };",
    "keys": [
      "method:e2d35d4a4a0f161c6573af6e7fee4085"
    ]
  }
];
it.each(cases)('keeps conservative identity for $name', ({ source, keys }) => {
  const parser = createParser('cpp')!;
  const tree = parser.parse(source)!;
  try {
    const actual = [];
    for (const node of tree.rootNode.descendantsOfType('field_declaration')) {
      if (node.childForFieldName('declarator')?.type !== 'function_declarator') continue;
      const owners: string[] = [];
      for (let owner = node.parent; owner; owner = owner.parent) {
        if (['class_specifier', 'struct_specifier'].includes(owner.type)) {
          const name = owner.childForFieldName('name');
          if (name) owners.unshift(name.text);
        }
      }
      const symbol: Node = {
        id: 'original', kind: 'method', name: 'run', qualifiedName: [...owners, 'run'].join('::'),
        filePath: 'probe.cpp', language: 'cpp', startLine: 1, endLine: 1,
        startColumn: node.startPosition.column, endColumn: node.endPosition.column,
        updatedAt: 0, isDeclaration: true,
      };
      actual.push(macroSemanticId(symbol, node, source));
    }
    expect(actual).toEqual(keys);
  } finally { tree.delete(); parser.delete(); }
});
