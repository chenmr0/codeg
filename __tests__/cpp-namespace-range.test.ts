import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph, { QueryBuilder } from '../src/index';
import { CCppSourceScope } from '../src/extraction/c-cpp-source-scope';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { extractFromSource, TreeSitterExtractor } from '../src/extraction/tree-sitter';
import { expandDeclarationMacros, scanCppMacroDefinitions } from '../src/extraction/declaration-macros';
import { synthesizeIncrementalCCppEdges } from '../src/resolution/callback-synthesizer';

describe('source-proven C++ namespace body boundaries', () => {
  it('keeps nested, anonymous, compact and reopened namespaces distinct', () => {
    const source = `namespace outer {
namespace {
int hidden;
} // anonymous
inline namespace inner {
int value;
} // inner
} // outer
namespace outer::inner {
int again;
} // compact
namespace outer {
int reopened;
} // reopened`;
    const scope = new CCppSourceScope(source);
    const cases: Array<[string, string, string]> = [
      ['namespace outer {', '} // outer', 'outer'],
      ['namespace {', '} // anonymous', ''],
      ['inline namespace inner {', '} // inner', 'inner'],
      ['namespace outer::inner {', '} // compact', 'outer::inner'],
      ['namespace outer {\nint reopened;', '} // reopened', 'outer'],
    ];
    for (const [header, close, name] of cases) {
      const opening = source.indexOf('{', source.indexOf(header));
      expect(scope.namespaceBodyAt(opening)).toEqual({ start: opening, end: source.indexOf(close) + 1, name });
    }
  });

  it('ignores comments, escaped/raw literals and preprocessor replacement braces', () => {
    const source = `namespace api {
#define CLOSE_SCOPE } \\
  namespace fake {
const char *quoted = "} namespace phantom { \\\"";
const char *raw = R"tag(} namespace ghost {\n#if UNKNOWN\n})tag";
char close = '}';
/* } namespace comment { */
// } namespace line_comment {
int after;
} // actual`;
    const opening = source.indexOf('{');
    expect(new CCppSourceScope(source).namespaceBodyAt(opening))
      .toEqual({ start: opening, end: source.indexOf('} // actual') + 1, name: 'api' });
  });

  it('accepts balanced alternative function bodies inside a namespace', () => {
    const source = `namespace api {
void work() {
#if FLAG
  if (ready()) {
#else
  if (fallback()) {
#endif
    call();
  }
}
int after;
} // api`;
    expect(new CCppSourceScope(source).namespaceBodyAt(source.indexOf('{'))?.end)
      .toBe(source.indexOf('} // api') + 1);
  });

  it.each([
    'namespace api {\n#if FLAG\n}\n#endif\nint after;',
    'namespace api {\n#if FLAG\n}\n#else\n}\n#endif',
    'namespace api {\n#if FLAG\nvoid work() {\n#endif\n}\n}',
    'namespace api {\n#if FLAG\ncall(\n#endif\n}\n',
    'namespace api {\nint after;',
  ])('does not invent a unique close across ambiguous or incomplete scopes: %s', source => {
    expect(new CCppSourceScope(source).namespaceBodyAt(source.indexOf('{'))).toBeUndefined();
  });

  it('does not equate same-name namespace openings in separate branches', () => {
    const source = '#if FLAG\nnamespace api {\n#else\nnamespace api {\n#endif\nint item;\n}';
    const scope = new CCppSourceScope(source);
    const first = source.indexOf('{'), second = source.indexOf('{', first + 1);
    expect(scope.namespaceBodyAt(first)).toBeUndefined();
    expect(scope.namespaceBodyAt(second)).toBeUndefined();
  });

  it('retains complete namespace definitions local to separate branches', () => {
    const source = '#if FLAG\nnamespace left { int a; }\n#else\nnamespace right { int b; }\n#endif';
    const scope = new CCppSourceScope(source);
    const first = source.indexOf('{'), second = source.indexOf('{', first + 1);
    expect(scope.namespaceBodyAt(first)?.end).toBe(source.indexOf('}') + 1);
    expect(scope.namespaceBodyAt(second)?.end).toBe(source.lastIndexOf('}') + 1);
  });

  it('does not infer a namespace from a macro-generated header', () => {
    const source = 'BEGIN_SCOPE(api) {\nint value;\n}';
    expect(new CCppSourceScope(source).namespaceBodyAt(source.indexOf('{'))).toBeUndefined();
  });
});

describe('persisted C++ namespace source ranges', () => {
  beforeAll(async () => { await initGrammars(); await loadGrammarsForLanguages(['cpp']); });

  it('preserves exact ranges and owner names for ordinary namespaces', () => {
    const source = `namespace root {
namespace child {
class Worker { public: int run(); };
int Worker::run() { return 1; }
} // child
} // root
namespace root::child { int later; }`;
    const result = extractFromSource('namespace.cpp', source, 'cpp');
    const namespaces = result.nodes.filter(node => node.kind === 'namespace');
    expect(namespaces.map(node => [node.qualifiedName, node.startLine, node.endLine, node.endColumn]))
      .toEqual([['root', 1, 6, 1], ['root::child', 2, 5, 1], ['root::child', 7, 7, 36]]);
    expect(result.nodes.find(node => node.name === 'run' && !node.isDeclaration)?.qualifiedName)
      .toBe('root::child::Worker::run');
  });

  it('restores a source-proven outer prefix when AST recovery retains only nested namespaces', () => {
    // This namespace attribute placement is a C++ grammar gap: recovery drops
    // the outer wrapper but retains middle/inner namespace entities. Their
    // repaired ranges must not make method identities lose the source prefix.
    const source = `namespace outer __attribute__((visibility("default"))) {
namespace middle {
namespace inner {
int Worker::run() { return 1; }
}
}
}`;
    const result = extractFromSource('annotated-namespace.cpp', source, 'cpp');
    expect(new CCppSourceScope(source).namespaceAt(source.indexOf('int Worker')))
      .toBe('outer::middle::inner');
    expect(result.nodes.find(node => node.name === 'run' && !node.isDeclaration)?.qualifiedName)
      .toBe('outer::middle::inner::Worker::run');
  });

  it('still restores missing inner namespace suffixes from source scope', () => {
    const source = `namespace outer {
namespace inner __attribute__((visibility("default"))) {
int Worker::run() { return 1; }
}
}`;
    const result = extractFromSource('annotated-inner.cpp', source, 'cpp');
    expect(result.nodes.find(node => node.name === 'run' && !node.isDeclaration)?.qualifiedName)
      .toBe('outer::inner::Worker::run');
  });

  it('does not duplicate an explicitly qualified receiver when restoring its outer namespace', () => {
    const source = `namespace outer __attribute__((visibility("default"))) {
namespace inner {
int outer::inner::Worker::run() { return 1; }
}
}`;
    const result = extractFromSource('qualified-receiver.cpp', source, 'cpp');
    expect(result.nodes.find(node => node.name === 'run' && !node.isDeclaration)?.qualifiedName)
      .toBe('outer::inner::Worker::run');
  });

  it('keeps explicitly global receivers independent of the recovered namespace', () => {
    const source = `namespace outer __attribute__((visibility("default"))) {
namespace inner {
int ::external::Worker::run() { return 1; }
}
}`;
    const result = extractFromSource('global-receiver.cpp', source, 'cpp');
    expect(result.nodes.find(node => node.name === 'run' && !node.isDeclaration)?.qualifiedName)
      .toBe('external::Worker::run');
  });

  it('does not replace unrelated AST owners when the source namespace conflicts', () => {
    // An unsupported header may be recovered with a different owner entirely.
    // A shared inner segment does not prove which outer identity is correct.
    const source = `namespace actual __declspec(generated) {
namespace inner {
int Worker::run() { return 1; }
}
}`;
    const result = extractFromSource('conflicting-owner.cpp', source, 'cpp');
    expect(new CCppSourceScope(source).namespaceAt(source.indexOf('int Worker')))
      .toBe('actual::inner');
    expect(result.nodes.find(node => node.name === 'run' && !node.isDeclaration)?.qualifiedName)
      .toBe('generated::inner::Worker::run');
  });

  it('does not persist a function closing brace as a namespace end after type-macro errors', () => {
    const source = `namespace root {
namespace service {
class Worker { public: int prepare(); int process(); int after(); };
int Worker::prepare() {
  if (active()) {
    if (FAILED(LOOKUP(Registry*)->prepare(key))) {
      report();
    }
  }
  return 0;
}
int Worker::process() {
  int status = 0;
  if (active()) {
    if (local()) {
      process_local();
    } else {
      CONTEXT_SWITCH(context) {
        if (finished()) {
          status = 1;
        } else if (FAILED(LOOKUP(Registry*)->fetch(key, guard))) {
          if (retry()) {
            status = 2;
          } else if (ignore()) {
            status = 0;
          } else {
            report();
          }
          trace();
        } else if (!valid()) {
          status = 3;
        } else {
          consume();
        }
      }
      if (!finished()) {
        consume();
      }
    }
  }
  return status;
}
int Worker::after() { return 4; }
} // service
} // root`;
    const result = extractFromSource('macro-types.cpp', source, 'cpp');
    for (const name of ['root', 'root::service']) {
      const ns = result.nodes.find(node => node.kind === 'namespace' && node.qualifiedName === name)!;
      expect(ns).toBeDefined();
      const marker = name === 'root' ? '} // root' : '} // service';
      const close = source.indexOf(marker);
      expect(ns.endLine).toBe(source.slice(0, close).split('\n').length);
      expect(ns.endColumn).toBe(1);
    }
    const after = result.nodes.find(node => node.name === 'after' && !node.isDeclaration)!;
    expect(after?.qualifiedName).toBe('root::service::Worker::after');
    const owner = result.nodes.find(node => node.qualifiedName === 'root::service::Worker' && !node.isDeclaration)!;
    expect(result.edges.some(edge => edge.kind === 'contains' && edge.source === owner.id && edge.target === after.id))
      .toBe(true);
  });
});

describe('namespace provenance for macro-generated callables', () => {
  beforeAll(async () => { await initGrammars(); await loadGrammarsForLanguages(['cpp']); });

  it('tracks replacement tokens separately from a native callable on the same line', () => {
    const source = '#define MAKE() int generated();\nMAKE() int native();\n';
    const expanded = expandDeclarationMacros(source, scanCppMacroDefinitions(source));
    expect(expanded.sourceRanges).toHaveLength(1);
    const range = expanded.sourceRanges![0]!;
    expect(source.slice(range.sourceStart, range.sourceEnd)).toBe('MAKE()');
    expect(expanded.source.slice(range.expandedStart, range.expandedEnd)).toBe('int generated();');
    expect(expanded.source.indexOf('int native()')).toBeGreaterThanOrEqual(range.expandedEnd);
  });

  it('does not borrow another declarator macro provenance before source aliases are merged', () => {
    const source = '#define HEAD int generated()\nnamespace outer {\nHEAD, native();\n}\n';
    const expanded = expandDeclarationMacros(source, scanCppMacroDefinitions(source));
    const sparse = expanded.source.split('\n').map((line, row) => row === 1 || row === 3
      ? line.replace(/[^\r\n]/g, ' ') : line).join('\n');
    const extractor = new TreeSitterExtractor('multi-declarator.cpp', source, 'cpp');
    type Recovery = { extractDeclarationRecoverySource(source: string, expansion: typeof expanded, scope: CCppSourceScope): ReturnType<typeof extractFromSource> };
    const recovered = (extractor as unknown as Recovery).extractDeclarationRecoverySource(
      sparse, expanded, new CCppSourceScope(expanded.source));
    // Inspect the auxiliary result before sourceAliases can restore native
    // identities: only the macro-produced name token may use full-source scope.
    expect(recovered.nodes.find(node => node.name === 'generated')?.qualifiedName).toBe('outer::generated');
    expect(recovered.nodes.find(node => node.name === 'native')?.qualifiedName).toBe('native');
  });

  it('keeps macro member declarations and definitions paired when an auxiliary fragment loses namespace shells', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpp-macro-namespace-'));
    const wrap = (body: string) => `namespace outer {
namespace middle {
namespace inner {
${body}
} // source-namespace-close
} // source-namespace-close
} // source-namespace-close
`;
    fs.writeFileSync(path.join(root, 'macros.h'), `#define DECLARE_MEMBER() int encode(); int decode(); int size();
#define DEFINE_MEMBER(Type) int Type::encode() { TYPE_ONLY(Type*); return 1; } int Type::decode() { return 2; } int Type::size() { return 3; }
#define MAKE_NESTED() namespace generated { int helper() { return 2; } }
#define DEFINE_GLOBAL() int ::outside::Codec::absolute() { return 3; }
`);
    fs.writeFileSync(path.join(root, 'api.h'), '#include "macros.h"\n' + wrap(`class Codec {
public:
DECLARE_MEMBER()
};`));
    fs.writeFileSync(path.join(root, 'api.cpp'), '#include "api.h"\n' + wrap(`DEFINE_MEMBER(Codec)
MAKE_NESTED() int native() { return 4; }
DEFINE_GLOBAL()`));
    // Reproduce the observed intermediate failure directly: damaged AST
    // ancestry can prune namespace shells out of an auxiliary source. Keep
    // expansion and the public index pipeline real; only inject that loss.
    // This avoids making the regression depend on one large error-recovery
    // parse or an implementation-specific project macro spelling.
    type Recovery = { buildDeclarationMacroRecoverySource(source: string, lines: Set<number>): string;
      isolatedDeclarationSource: string | null; useMacroSemanticIds: boolean;
      extractMethod(node: { type: string; text: string }, isDeclaration?: boolean): void;
      createSyntheticNode(...args: unknown[]): unknown };
    const prototype = TreeSitterExtractor.prototype as unknown as Recovery;
    const original = prototype.buildDeclarationMacroRecoverySource;
    const spy = vi.spyOn(prototype, 'buildDeclarationMacroRecoverySource').mockImplementation(function (this: Recovery, source, lines) {
      const recovered = original.call(this, source, lines);
      this.isolatedDeclarationSource = null;
      return recovered.split('\n').map(line => /^namespace (?:outer|middle|inner)\s*\{/.test(line)
        || /^}\s*\/\/ source-namespace-close/.test(line) ? line.replace(/[^\r\n]/g, ' ') : line).join('\n');
    });
    // TYPE_ONLY(Type*) leaves a genuine grammar error in the expanded source,
    // satisfying the production text-recovery gate (rootNode.hasError).
    // The real regression's first generated definition is rescued by
    // cpp-qualified-definition-recovery. Inject that lost AST method here;
    // declarations and the other two definitions still use normal traversal.
    const extractMethod = prototype.extractMethod;
    const lostMethod = vi.spyOn(prototype, 'extractMethod').mockImplementation(function (this: Recovery, node, isDeclaration) {
      if (this.useMacroSemanticIds && node.type === 'function_definition' && /\bCodec::encode\s*\(/.test(node.text)) return;
      return extractMethod.call(this, node, isDeclaration);
    });
    let textRecoveries = 0;
    const createSynthetic = prototype.createSyntheticNode;
    const observeRecovery = vi.spyOn(prototype, 'createSyntheticNode').mockImplementation(function (this: Recovery, ...args) {
      if (args[1] === 'encode' && args.at(-1) === 'cpp-qualified-definition-recovery') textRecoveries++;
      return createSynthetic.apply(this, args);
    });
    let graph: CodeGraph | undefined;
    try {
      // The injected source-pruning seam is process-local. Invoke the actual
      // extractor here, then persist its nodes and run the normal synthesizer.
      const definitions = scanCppMacroDefinitions(fs.readFileSync(path.join(root, 'macros.h'), 'utf8'));
      const names = new Set(definitions.map(d => d.name));
      const results = ['api.h', 'api.cpp'].map(file => extractFromSource(file,
        fs.readFileSync(path.join(root, file), 'utf8'), 'cpp', [], names, new Set(), definitions));
      const nodes = results.flatMap(result => result.nodes);
      expect(textRecoveries, 'the malformed expanded source must enter text recovery').toBeGreaterThan(0);
      for (const name of ['encode', 'decode', 'size']) {
        const methods = nodes.filter(node => node.name === name);
        expect(methods, name).toHaveLength(2);
        expect(methods.every(node => node.qualifiedName === `outer::middle::inner::Codec::${name}`)).toBe(true);
        expect(methods.map(node => !!node.isDeclaration).sort()).toEqual([false, true]);
      }
      expect(nodes.find(node => node.name === 'helper')?.qualifiedName).toBe('outer::middle::inner::generated::helper');
      expect(nodes.find(node => node.name === 'absolute')?.qualifiedName).toBe('outside::Codec::absolute');
      expect(nodes.find(node => node.name === 'native')?.qualifiedName).toBe('outer::middle::inner::native');

      spy.mockRestore();
      lostMethod.mockRestore();
      observeRecovery.mockRestore();
      // Persist these exact fault-injected extraction results, then run the
      // production C/C++ bridge. Do not substitute a healthy re-extraction.
      graph = await CodeGraph.init(root, { index: false });
      graph.close();
      // This fixture exclusively persists fault-injected extraction results.
      graph = CodeGraph.openPortableRaw(root, path.join(root, '.codegraph-wx', 'codegraph.db'), false);
      const queries = new QueryBuilder(graph.getExploreQueryConnection());
      queries.insertNodes(results.flatMap(result => result.nodes));
      queries.insertEdges(results.flatMap(result => result.edges));
      await synthesizeIncrementalCCppEdges(queries, ['api.h', 'api.cpp']);
      graph.close();
      graph = CodeGraph.openSync(root);
      const db = graph.getExploreQueryConnection();
      expect(() => db.prepare('UPDATE nodes SET name = name').run()).toThrow(/readonly|read.only/i);
      const pairs = db.prepare(`SELECT s.qualified_name source, t.qualified_name target
        FROM edges e JOIN nodes s ON e.source=s.id JOIN nodes t ON e.target=t.id
        WHERE e.kind='defines' AND s.name IN ('encode','decode','size') AND t.name=s.name ORDER BY s.name`).all();
      expect(pairs).toEqual(['decode', 'encode', 'size'].map(name => ({
        source: `outer::middle::inner::Codec::${name}`, target: `outer::middle::inner::Codec::${name}`,
      })));
    } finally {
      spy.mockRestore();
      lostMethod.mockRestore();
      observeRecovery.mockRestore();
      graph?.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
