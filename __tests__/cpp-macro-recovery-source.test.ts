import { beforeAll, describe, expect, it, vi } from 'vitest';
import { getParser, initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { TreeSitterExtractor } from '../src/extraction/tree-sitter';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['cpp']);
});

/** Exercise source pruning independently of which macros the expander selects. */
function recover(source: string, invocationLines: number[], expanded = source): string {
  const tree = getParser('cpp')!.parse(source)!;
  const extractor = new TreeSitterExtractor('recovery.cpp', source, 'cpp');
  extractor['tree'] = tree;
  try {
    return extractor['buildDeclarationMacroRecoverySource'](expanded, new Set(invocationLines));
  } finally {
    tree.delete();
  }
}

describe('C++ declaration macro recovery context', () => {
  it('preserves nested template containers and the access section of each invocation', () => {
    const lines = [
      'namespace outer {',
      'int unrelated;',
      'template <typename T>',
      'class Box {',
      '  int default_private;',
      'public:',
      '  int public_value;',
      '  int omitted_public;',
      'protected:',
      '  int protected_value;',
      'private:',
      '  int private_value;',
      '  struct Nested {',
      '    int nested_value;',
      '  };',
      '};',
      '}',
    ];
    const expected = lines.map((line, i) => [2, 8].includes(i + 1) ? '' : line).join('\n');
    // Invocation order must not affect the selected access section.
    expect(recover(lines.join('\n'), [14, 12, 5, 10, 7])).toBe(expected);
    expect(recover(lines.join('\n'), [5, 7, 10, 12, 14])).toBe(expected);
  });

  it('keeps only the latest preceding access label and preserves linkage boundaries', () => {
    const lines = [
      'extern "C++" {',
      'class Box {',
      'public:',
      '  int omitted;',
      'protected:',
      'private: public:',
      '  int selected;',
      'private:',
      '  int later;',
      '};',
      '}',
    ];
    const kept = new Set([1, 2, 6, 7, 10, 11]);
    expect(recover(lines.join('\n'), [7])).toBe(
      lines.map((line, i) => kept.has(i + 1) ? line : '').join('\n'),
    );
  });

  it('retains expanded split declarations, comments and quoted delimiters', () => {
    const lines = [
      'namespace demo {',
      'int discarded;',
      'int run()',
      '{',
      '  const char *text = "};"; // }',
      '  /* } */ return 1;',
      '}',
      '}',
    ];
    const expanded = lines.map((line, i) => i === 2 ? 'int recovered()' : line);
    expect(recover(lines.join('\n'), [3], expanded.join('\n'))).toBe(
      expanded.map((line, i) => i === 1 ? '' : line).join('\n'),
    );
  });

  it('reads a shared container body once even when parent lookups create new wrappers', () => {
    const declarations = Array.from({ length: 200 }, (_, i) => `int value_${i};`);
    const source = ['namespace demo {', ...declarations, '}'].join('\n');
    const tree = getParser('cpp')!.parse(source)!;
    const body = tree.rootNode.namedChildren[0]!.childForFieldName('body')!;
    const prototype = Object.getPrototypeOf(body);
    const getter = Object.getOwnPropertyDescriptor(prototype, 'namedChildren')!.get!;
    let bodyReads = 0;
    const spy = vi.spyOn(prototype, 'namedChildren', 'get').mockImplementation(function (this: typeof body) {
      if (this.id === body.id) bodyReads++;
      return getter.call(this);
    });
    const extractor = new TreeSitterExtractor('many.cpp', source, 'cpp');
    extractor['tree'] = tree;
    try {
      expect(extractor['buildDeclarationMacroRecoverySource'](
        source, new Set(declarations.map((_, i) => i + 2)),
      )).toBe(source);
      expect(bodyReads).toBe(1);
    } finally {
      spy.mockRestore();
      tree.delete();
    }
    // A later parse owns a different tree and must not reuse cached context.
    expect(recover('namespace next {\nint next_value;\n}', [2])).toBe(
      'namespace next {\nint next_value;\n}',
    );
  });
});
