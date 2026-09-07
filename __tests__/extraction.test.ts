/**
 * Extraction Tests
 *
 * Tests for the tree-sitter extraction system.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { extractFromSource, scanDirectory, buildDefaultIgnore, expandAnchoredNegations } from '../src/extraction';
import { detectLanguage, isLanguageSupported, getSupportedLanguages, initGrammars, loadAllGrammars, isSourceFile } from '../src/extraction/grammars';
import { cppExtractor } from '../src/extraction/languages/c-cpp';
import { normalizePath } from '../src/utils';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

// Create a temporary directory for each test
function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-test-'));
}

// Clean up temporary directory
function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('Language Detection', () => {
  it('should detect TypeScript files', () => {
    expect(detectLanguage('src/index.ts')).toBe('typescript');
    expect(detectLanguage('components/Button.tsx')).toBe('tsx');
  });

  it('should detect JavaScript files', () => {
    expect(detectLanguage('index.js')).toBe('javascript');
    expect(detectLanguage('App.jsx')).toBe('jsx');
    expect(detectLanguage('config.mjs')).toBe('javascript');
  });

  it('should detect Python files', () => {
    expect(detectLanguage('main.py')).toBe('python');
  });

  it('should detect Go files', () => {
    expect(detectLanguage('main.go')).toBe('go');
  });

  it('should detect Rust files', () => {
    expect(detectLanguage('lib.rs')).toBe('rust');
  });

  it('should detect Java files', () => {
    expect(detectLanguage('Main.java')).toBe('java');
  });

  it('should detect C files', () => {
    expect(detectLanguage('main.c')).toBe('c');
    expect(detectLanguage('utils.h')).toBe('c');
  });

  it('should detect C++ files', () => {
    expect(detectLanguage('main.cpp')).toBe('cpp');
    expect(detectLanguage('class.hpp')).toBe('cpp');
  });

  it('should detect C# files', () => {
    expect(detectLanguage('Program.cs')).toBe('csharp');
  });

  it('should detect PHP files', () => {
    expect(detectLanguage('index.php')).toBe('php');
  });

  it('should detect Ruby files', () => {
    expect(detectLanguage('app.rb')).toBe('ruby');
  });

  it('should detect Swift files', () => {
    expect(detectLanguage('ViewController.swift')).toBe('swift');
  });

  it('should detect Kotlin files', () => {
    expect(detectLanguage('MainActivity.kt')).toBe('kotlin');
    expect(detectLanguage('build.gradle.kts')).toBe('kotlin');
  });

  it('should detect Dart files', () => {
    expect(detectLanguage('main.dart')).toBe('dart');
  });

  it('should detect Objective-C files', () => {
    expect(detectLanguage('AppDelegate.m')).toBe('objc');
    expect(detectLanguage('ViewController.mm')).toBe('objc');
    const objcHeader = '@interface Foo : NSObject\n@end\n';
    expect(detectLanguage('Foo.h', objcHeader)).toBe('objc');
    expect(detectLanguage('stdio.h', '#ifndef STDIO_H\nvoid printf();\n#endif\n')).toBe('c');
  });

  describe('.h file C/C++ disambiguation', () => {
    it('detects C++ using-declaration (using std::isinf;)', () => {
      const src = '#ifndef OB_DEFINE_H\n#define OB_DEFINE_H\n#include <cstdint>\nusing std::isinf;\nnamespace oceanbase { namespace share { class ObLSID {}; }\n#endif\n';
      expect(detectLanguage('ob_define.h', src)).toBe('cpp');
    });

    it('detects C++ namespace', () => {
      const src = 'namespace oceanbase {\nnamespace share {\nvoid foo();\n}\n}\n';
      expect(detectLanguage('foo.h', src)).toBe('cpp');
    });

    it('detects C++ class definition', () => {
      const src = 'class Foo {\npublic:\n  int bar();\n};\n';
      expect(detectLanguage('foo.h', src)).toBe('cpp');
    });

    it('detects constexpr', () => {
      const src = '#ifndef FOO_H\nconstexpr int kSize = 64;\n#endif\n';
      expect(detectLanguage('foo.h', src)).toBe('cpp');
    });

    it('detects enum class', () => {
      const src = 'enum class Color { Red, Green, Blue };\n';
      expect(detectLanguage('foo.h', src)).toBe('cpp');
    });

    it('detects static_cast', () => {
      const src = 'template <typename T>\nT convert(int x) { return static_cast<T>(x); }\n';
      expect(detectLanguage('foo.h', src)).toBe('cpp');
    });

    it('detects std:: usage', () => {
      const src = '#include <vector>\nstd::vector<int> v;\n';
      expect(detectLanguage('foo.h', src)).toBe('cpp');
    });

    it('detects template declaration', () => {
      const src = 'template <typename T>\nclass Vec { T data[8]; };\n';
      expect(detectLanguage('foo.h', src)).toBe('cpp');
    });

    it('detects using type alias (existing pattern)', () => {
      const src = 'using IntVec = std::vector<int>;\n';
      expect(detectLanguage('foo.h', src)).toBe('cpp');
    });

    it('detects C++ constructs after a large macro-data prefix', () => {
      const prefix = '#define ROW(x) x\n'.repeat(600);
      const src = `${prefix}namespace late { class Widget {}; }\n`;
      expect(src.indexOf('namespace')).toBeGreaterThan(8192);
      expect(detectLanguage('generated_table.h', src)).toBe('cpp');
    });

    it('detects a C++ forward class declaration', () => {
      expect(detectLanguage('forward.h', 'class Widget;\nWidget *make_widget();\n')).toBe('cpp');
    });

    it('ignores C++ marker words in comments and literals across the whole file', () => {
      const src = [
        '/* namespace fake { class CommentOnly {}; } */',
        'const char *message = "template <class StringOnly>";',
        'const char *raw = R"tag(namespace raw { class RawOnly {}; })tag";',
        '#define C_DATA_ROW(x) x',
        'typedef struct c_record { int value; } c_record;',
      ].join('\n');
      expect(detectLanguage('c_data.h', src)).toBe('c');
    });

    it('preserves C for typedef struct + prototypes', () => {
      const src = '#ifndef FOO_H\ntypedef struct foo_s {\n  int x;\n} foo_t;\nfoo_t *foo_new(void);\nvoid foo_free(foo_t *p);\n#endif\n';
      expect(detectLanguage('foo.h', src)).toBe('c');
    });

    it('preserves C for #define + static __inline__', () => {
      const src = '#ifndef EASY_ATOMIC_H\n#define EASY_ATOMIC_H\n#define easy_atomic_t int\ntypedef easy_atomic_t easy_atomic64_t;\nstatic __inline__ void easy_atomic_set(easy_atomic_t *v, int x) { *v = x; }\n#endif\n';
      expect(detectLanguage('easy_atomic.h', src)).toBe('c');
    });

    it('preserves C for extern "C" guard + prototypes', () => {
      const src = '#ifdef __cplusplus\nextern "C" {\n#endif\nvoid foo_init(void);\nint bar_count(void);\n#ifdef __cplusplus\n}\n#endif\n';
      expect(detectLanguage('foo.h', src)).toBe('c');
    });

    it('preserves C for pure C with // comments', () => {
      const src = '// pure C header\n#ifndef FOO_H\n#define FOO_H\nint foo(void);\n// returns bar\nint bar(void);\n#endif\n';
      expect(detectLanguage('foo.h', src)).toBe('c');
    });
  });

  it('should return unknown for unsupported extensions', () => {
    expect(detectLanguage('styles.css')).toBe('unknown');
    expect(detectLanguage('data.json')).toBe('unknown');
  });
});

describe('Language Support', () => {
  it('should report supported languages', () => {
    expect(isLanguageSupported('typescript')).toBe(true);
    expect(isLanguageSupported('python')).toBe(true);
    expect(isLanguageSupported('go')).toBe(true);
    expect(isLanguageSupported('unknown')).toBe(false);
  });

  it('should list all supported languages', () => {
    const languages = getSupportedLanguages();
    expect(languages).toContain('typescript');
    expect(languages).toContain('javascript');
    expect(languages).toContain('python');
    expect(languages).toContain('go');
    expect(languages).toContain('rust');
    expect(languages).toContain('java');
    expect(languages).toContain('csharp');
    expect(languages).toContain('php');
    expect(languages).toContain('ruby');
    expect(languages).toContain('swift');
    expect(languages).toContain('kotlin');
    expect(languages).toContain('dart');
  });
});

describe('TypeScript Extraction', () => {
  it('should extract function declarations', () => {
    const code = `
export function processPayment(amount: number): Promise<Receipt> {
  return stripe.charge(amount);
}
`;
    const result = extractFromSource('payment.ts', code);

    // File node + function node
    const fileNode = result.nodes.find((n) => n.kind === 'file');
    expect(fileNode).toBeDefined();
    expect(fileNode?.name).toBe('payment.ts');

    const funcNode = result.nodes.find((n) => n.kind === 'function');
    expect(funcNode).toMatchObject({
      kind: 'function',
      name: 'processPayment',
      language: 'typescript',
      isExported: true,
    });
    expect(funcNode?.signature).toContain('amount: number');
  });

  it('should extract class declarations', () => {
    const code = `
export class PaymentService {
  private stripe: StripeClient;

  constructor(apiKey: string) {
    this.stripe = new StripeClient(apiKey);
  }

  async charge(amount: number): Promise<Receipt> {
    return this.stripe.charge(amount);
  }
}
`;
    const result = extractFromSource('service.ts', code);

    const classNode = result.nodes.find((n) => n.kind === 'class');
    const methodNodes = result.nodes.filter((n) => n.kind === 'method');

    expect(classNode).toBeDefined();
    expect(classNode?.name).toBe('PaymentService');
    expect(classNode?.isExported).toBe(true);

    expect(methodNodes.length).toBeGreaterThanOrEqual(1);
    const chargeMethod = methodNodes.find((m) => m.name === 'charge');
    expect(chargeMethod).toBeDefined();
  });

  it('should extract interfaces', () => {
    const code = `
export interface User {
  id: string;
  name: string;
  email: string;
}
`;
    const result = extractFromSource('types.ts', code);

    const fileNode = result.nodes.find((n) => n.kind === 'file');
    expect(fileNode).toBeDefined();

    const ifaceNode = result.nodes.find((n) => n.kind === 'interface');
    expect(ifaceNode).toMatchObject({
      kind: 'interface',
      name: 'User',
      isExported: true,
    });
  });

  it('should extract type references from interface property signatures', () => {
    const code = `
import type { IPage } from '../PromoterList';
import type { IOrderField } from '../types';

interface Hprops {
  value?: Partial<IPage> & Partial<IOrderField>;
}
`;
    const result = extractFromSource('HeaderFilter.ts', code);

    const refs = result.unresolvedReferences.filter((r) => r.referenceKind === 'references');
    expect(refs.some((r) => r.referenceName === 'IPage')).toBe(true);
    expect(refs.some((r) => r.referenceName === 'IOrderField')).toBe(true);
  });

  it('should extract type references from interface method signatures', () => {
    const code = `
import type { IPage } from '../PromoterList';
import type { IOrderField } from '../types';

interface MethodForm {
  fetchPage(arg: IPage): IOrderField;
}
`;
    const result = extractFromSource('MethodForm.ts', code);

    const refs = result.unresolvedReferences.filter((r) => r.referenceKind === 'references');
    expect(refs.some((r) => r.referenceName === 'IPage')).toBe(true);
    expect(refs.some((r) => r.referenceName === 'IOrderField')).toBe(true);
  });

  it('extracts type references from in-body local variable annotations', () => {
    // A function that uses a type ONLY in its body — `const items: Foo[] = []` —
    // still depends on Foo. The body walker used to capture calls but never type
    // annotations, so impact / `affected` missed the dependency. Must cover
    // function, class-method, and object-literal-method bodies — and must NOT
    // turn the locals themselves into graph nodes (that would explode the graph).
    const code = `
import { Foo } from './types';

export function build(): void {
  const items: Foo[] = [];
  void items;
}

export class K {
  run(): void {
    const a: Foo = { x: 1 };
    void a;
  }
}

export const handler = {
  handle(): void {
    const b: Foo = { x: 1 };
    void b;
  },
};
`;
    const result = extractFromSource('inbody.ts', code);

    const fooRefs = result.unresolvedReferences.filter(
      (r) => r.referenceKind === 'references' && r.referenceName === 'Foo'
    );
    // One per body scope: build(), K.run(), handler.handle().
    expect(fooRefs.length).toBeGreaterThanOrEqual(3);

    // Each reference is attributed to its enclosing function/method node — never
    // to a local-variable node, because locals are intentionally not extracted.
    const byId = new Map(result.nodes.map((n) => [n.id, n]));
    for (const ref of fooRefs) {
      const owner = byId.get(ref.fromNodeId);
      expect(owner).toBeDefined();
      expect(['function', 'method']).toContain(owner!.kind);
    }
    // The locals (items/a/b) must not leak in as symbols.
    expect(result.nodes.some((n) => ['items', 'a', 'b'].includes(n.name))).toBe(false);
  });

  it('should track function calls', () => {
    const code = `
function main() {
  const result = processData();
  console.log(result);
}
`;
    const result = extractFromSource('main.ts', code);

    expect(result.unresolvedReferences.length).toBeGreaterThan(0);
    const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls');
    expect(calls.some((c) => c.referenceName === 'processData')).toBe(true);
  });
});

describe('Arrow Function Export Extraction', () => {
  it('should extract exported arrow functions assigned to const', () => {
    const code = `
export const useAuth = (): AuthContextValue => {
  return useContext(AuthContext);
};
`;
    const result = extractFromSource('hooks.ts', code);

    const funcNode = result.nodes.find((n) => n.kind === 'function' && n.name === 'useAuth');
    expect(funcNode).toBeDefined();
    expect(funcNode).toMatchObject({
      kind: 'function',
      name: 'useAuth',
      isExported: true,
    });
  });

  it('should extract exported function expressions assigned to const', () => {
    const code = `
export const processData = function(input: string): string {
  return input.trim();
};
`;
    const result = extractFromSource('utils.ts', code);

    const funcNode = result.nodes.find((n) => n.kind === 'function' && n.name === 'processData');
    expect(funcNode).toBeDefined();
    expect(funcNode).toMatchObject({
      kind: 'function',
      name: 'processData',
      isExported: true,
    });
  });

  it('should not extract non-exported arrow functions as exported', () => {
    const code = `
const internalHelper = () => {
  return 42;
};
`;
    const result = extractFromSource('internal.ts', code);

    const helperNode = result.nodes.find((n) => n.name === 'internalHelper');
    expect(helperNode).toBeDefined();
    expect(helperNode?.isExported).toBeFalsy();
  });

  it('should still skip truly anonymous arrow functions', () => {
    const code = `
const items = [1, 2, 3].map((x) => x * 2);
`;
    const result = extractFromSource('anon.ts', code);

    // The inline arrow function passed to .map() has no variable_declarator parent
    // and should remain anonymous (skipped)
    const anonFunctions = result.nodes.filter(
      (n) => n.kind === 'function' && n.name === '<anonymous>'
    );
    expect(anonFunctions).toHaveLength(0);
  });

  it('should extract multiple exported arrow functions from the same file', () => {
    const code = `
export const add = (a: number, b: number): number => a + b;

export const subtract = (a: number, b: number): number => a - b;

const internal = () => 'not exported';
`;
    const result = extractFromSource('math.ts', code);

    const exported = result.nodes.filter((n) => n.kind === 'function' && n.isExported);
    expect(exported).toHaveLength(2);
    expect(exported.map((n) => n.name).sort()).toEqual(['add', 'subtract']);

    const internalNode = result.nodes.find((n) => n.name === 'internal');
    expect(internalNode).toBeDefined();
    expect(internalNode?.isExported).toBeFalsy();
  });

  it('should extract arrow functions in JavaScript files', () => {
    const code = `
export const fetchData = async () => {
  const response = await fetch('/api/data');
  return response.json();
};
`;
    const result = extractFromSource('api.js', code);

    const funcNode = result.nodes.find((n) => n.kind === 'function' && n.name === 'fetchData');
    expect(funcNode).toBeDefined();
    expect(funcNode).toMatchObject({
      kind: 'function',
      name: 'fetchData',
      isExported: true,
    });
  });
});

describe('Type Alias Extraction', () => {
  it('should extract exported type aliases in TypeScript', () => {
    const code = `
export type AuthContextValue = {
  user: User | null;
  login: () => void;
  logout: () => void;
};
`;
    const result = extractFromSource('types.ts', code);

    const typeNode = result.nodes.find((n) => n.kind === 'type_alias');
    expect(typeNode).toMatchObject({
      kind: 'type_alias',
      name: 'AuthContextValue',
      isExported: true,
    });
  });

  it('should extract non-exported type aliases', () => {
    const code = `
type InternalState = {
  loading: boolean;
  error: string | null;
};
`;
    const result = extractFromSource('internal.ts', code);

    const typeNode = result.nodes.find((n) => n.kind === 'type_alias');
    expect(typeNode).toMatchObject({
      kind: 'type_alias',
      name: 'InternalState',
      isExported: false,
    });
  });

  it('should extract multiple type aliases from the same file', () => {
    const code = `
export type UnitSystem = 'metric' | 'imperial';
export type DateFormat = 'ISO' | 'US' | 'EU';
type Internal = string;
`;
    const result = extractFromSource('config.ts', code);

    const typeAliases = result.nodes.filter((n) => n.kind === 'type_alias');
    expect(typeAliases).toHaveLength(3);

    const exported = typeAliases.filter((n) => n.isExported);
    expect(exported).toHaveLength(2);
    expect(exported.map((n) => n.name).sort()).toEqual(['DateFormat', 'UnitSystem']);
  });

  // A service/contract registry written as a tuple of generic instantiations —
  // the names are string-literal type arguments, not declarations, so static
  // extraction otherwise never indexes them (issue #634).
  it('extracts string-literal contract names from a generic tuple type alias (#634)', () => {
    const code = `
interface Service<Name extends string, Req, Resp> { name: Name; }
export type MyServiceList = [
  Service<'query_apply_record', { pageNo: number }, { ok: boolean }>,
  Service<'apply_confirm', { code: string }, { ok: boolean }>
];
`;
    const result = extractFromSource('services/api.ts', code);

    const names = result.nodes.filter(
      (n) => n.kind === 'method' && n.qualifiedName.startsWith('MyServiceList::')
    );
    expect(names.map((n) => n.name).sort()).toEqual(['apply_confirm', 'query_apply_record']);

    const queryNode = names.find((n) => n.name === 'query_apply_record');
    expect(queryNode?.qualifiedName).toBe('MyServiceList::query_apply_record');
    // Signature carries the full contract entry so search results show context.
    expect(queryNode?.signature).toContain("Service<'query_apply_record'");

    // The string-literal name is contained by the type alias.
    const alias = result.nodes.find((n) => n.kind === 'type_alias' && n.name === 'MyServiceList');
    const containsEdge = result.edges.find(
      (e) => e.kind === 'contains' && e.source === alias?.id && e.target === queryNode?.id
    );
    expect(containsEdge).toBeDefined();
  });

  it('does not extract string literals from utility types or nested generics (#634)', () => {
    const code = `
interface User { id: string; name: string; }
interface Service<Name extends string, Req, Resp> { name: Name; }
export type Picked = Pick<User, 'id' | 'name'>;
export type Rec = Record<'foo' | 'bar', number>;
// Tuple entry, but the name is a non-identifier route path; the nested Pick's
// 'id' must also stay out (only DIRECT literal args of a tuple's generic count).
export type Routes = [Service<'/api/users', Pick<User, 'id'>, {}>];
// Bare string-literal tuple — not generic type arguments.
export type Names = ['alpha', 'beta'];
`;
    const result = extractFromSource('noise.ts', code);

    const leaked = result.nodes.filter(
      (n) =>
        (n.kind === 'method' || n.kind === 'property') &&
        ['id', 'name', 'foo', 'bar', 'alpha', 'beta'].includes(n.name)
    );
    expect(leaked).toEqual([]);
  });
});

describe('Exported Variable Extraction', () => {
  it('should extract exported const with call expression (Zustand store)', () => {
    const code = `
export const useUIStore = create<UIState>((set) => ({
  isOpen: false,
  toggle: () => set((s) => ({ isOpen: !s.isOpen })),
}));
`;
    const result = extractFromSource('store.ts', code);

    const varNode = result.nodes.find((n) => n.kind === 'constant' && n.name === 'useUIStore');
    expect(varNode).toBeDefined();
    expect(varNode?.isExported).toBe(true);
  });

  it('should extract exported const with object literal', () => {
    const code = `
export const config = {
  apiUrl: 'https://api.example.com',
  timeout: 5000,
};
`;
    const result = extractFromSource('config.ts', code);

    const varNode = result.nodes.find((n) => n.kind === 'constant' && n.name === 'config');
    expect(varNode).toBeDefined();
    expect(varNode?.isExported).toBe(true);
  });

  it('should extract exported const with array literal', () => {
    const code = `
export const SCREEN_NAMES = ['home', 'settings', 'profile'] as const;
`;
    const result = extractFromSource('constants.ts', code);

    const varNode = result.nodes.find((n) => n.kind === 'constant' && n.name === 'SCREEN_NAMES');
    expect(varNode).toBeDefined();
    expect(varNode?.isExported).toBe(true);
  });

  it('should extract exported const with primitive value', () => {
    const code = `
export const MAX_RETRIES = 3;
export const API_VERSION = "v2";
`;
    const result = extractFromSource('constants.ts', code);

    const variables = result.nodes.filter((n) => n.kind === 'constant');
    expect(variables).toHaveLength(2);
    expect(variables.map((n) => n.name).sort()).toEqual(['API_VERSION', 'MAX_RETRIES']);
  });

  it('should NOT duplicate arrow functions as both function and variable', () => {
    const code = `
export const useAuth = () => {
  return useContext(AuthContext);
};
`;
    const result = extractFromSource('hooks.ts', code);

    // Should be extracted as function (from arrow function handler), NOT as variable
    const funcNodes = result.nodes.filter((n) => n.kind === 'function' && n.name === 'useAuth');
    const varNodes = result.nodes.filter((n) => n.kind === 'variable' && n.name === 'useAuth');
    expect(funcNodes).toHaveLength(1);
    expect(varNodes).toHaveLength(0);
  });

  it('should extract non-exported const as non-exported variable', () => {
    const code = `
const internalConfig = {
  debug: true,
};
`;
    const result = extractFromSource('internal.ts', code);

    // Non-exported const at file level should be extracted as a constant (not exported)
    const varNodes = result.nodes.filter((n) => (n.kind === 'variable' || n.kind === 'constant') && n.name === 'internalConfig');
    expect(varNodes).toHaveLength(1);
    expect(varNodes[0]?.isExported).toBeFalsy();
  });

  it('should extract Zod schema exports', () => {
    const code = `
export const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
});
`;
    const result = extractFromSource('schemas.ts', code);

    const varNode = result.nodes.find((n) => n.kind === 'constant' && n.name === 'userSchema');
    expect(varNode).toBeDefined();
    expect(varNode?.isExported).toBe(true);
  });

  it('should extract XState machine exports', () => {
    const code = `
export const authMachine = createMachine({
  id: "auth",
  initial: "idle",
  states: {
    idle: {},
    authenticated: {},
  },
});
`;
    const result = extractFromSource('machine.ts', code);

    const varNode = result.nodes.find((n) => n.kind === 'constant' && n.name === 'authMachine');
    expect(varNode).toBeDefined();
    expect(varNode?.isExported).toBe(true);
  });

  it('should extract calls from a top-level variable initializer (issue #425)', () => {
    const code = `
import { getTokenMp } from './api/upload';

const token = getTokenMp();
`;
    const result = extractFromSource('app.ts', code);

    const call = result.unresolvedReferences.find(
      (ref) => ref.referenceKind === 'calls' && ref.referenceName === 'getTokenMp'
    );
    expect(call).toBeDefined();
  });
});

describe('File Node Extraction', () => {
  it('should create a file-kind node for each parsed file', () => {
    const code = `
export function greet(name: string): string {
  return "Hello " + name;
}
`;
    const result = extractFromSource('greeter.ts', code);

    const fileNode = result.nodes.find((n) => n.kind === 'file');
    expect(fileNode).toBeDefined();
    expect(fileNode?.name).toBe('greeter.ts');
    expect(fileNode?.filePath).toBe('greeter.ts');
    expect(fileNode?.language).toBe('typescript');
    expect(fileNode?.startLine).toBe(1);
  });

  it('should create file nodes for Python files', () => {
    const code = `
def main():
    pass
`;
    const result = extractFromSource('main.py', code);

    const fileNode = result.nodes.find((n) => n.kind === 'file');
    expect(fileNode).toBeDefined();
    expect(fileNode?.name).toBe('main.py');
    expect(fileNode?.language).toBe('python');
  });

  it('should create containment edges from file node to top-level declarations', () => {
    const code = `
export function foo() {}
export function bar() {}
`;
    const result = extractFromSource('fns.ts', code);

    const fileNode = result.nodes.find((n) => n.kind === 'file');
    expect(fileNode).toBeDefined();

    // There should be contains edges from the file node to each function
    const containsEdges = result.edges.filter(
      (e) => e.source === fileNode?.id && e.kind === 'contains'
    );
    expect(containsEdges.length).toBeGreaterThanOrEqual(2);
  });
});

describe('Python Extraction', () => {
  it('should extract function definitions', () => {
    const code = `
def calculate_total(items: list, tax_rate: float) -> float:
    """Calculate total with tax."""
    subtotal = sum(item.price for item in items)
    return subtotal * (1 + tax_rate)
`;
    const result = extractFromSource('calc.py', code);

    const fileNode = result.nodes.find((n) => n.kind === 'file');
    expect(fileNode).toBeDefined();

    const funcNode = result.nodes.find((n) => n.kind === 'function');
    expect(funcNode).toMatchObject({
      kind: 'function',
      name: 'calculate_total',
      language: 'python',
    });
  });

  it('should extract class definitions', () => {
    const code = `
class UserService:
    """Service for managing users."""

    def __init__(self, db):
        self.db = db

    def get_user(self, user_id: str) -> User:
        return self.db.find_user(user_id)
`;
    const result = extractFromSource('service.py', code);

    const classNode = result.nodes.find((n) => n.kind === 'class');
    expect(classNode).toBeDefined();
    expect(classNode?.name).toBe('UserService');
  });
});

describe('Go Extraction', () => {
  it('should extract function declarations', () => {
    const code = `
package main

func ProcessOrder(order Order) (Receipt, error) {
    // Process the order
    return Receipt{}, nil
}
`;
    const result = extractFromSource('main.go', code);

    const funcNode = result.nodes.find((n) => n.kind === 'function');
    expect(funcNode).toBeDefined();
    expect(funcNode?.name).toBe('ProcessOrder');
  });

  it('should extract method declarations', () => {
    const code = `
package main

type Service struct {
    db *Database
}

func (s *Service) GetUser(id string) (*User, error) {
    return s.db.FindUser(id)
}
`;
    const result = extractFromSource('service.go', code);

    const methodNode = result.nodes.find((n) => n.kind === 'method');
    expect(methodNode).toBeDefined();
    expect(methodNode?.name).toBe('GetUser');
  });
});

describe('Rust Extraction', () => {
  it('should extract function declarations', () => {
    const code = `
pub fn process_data(input: &str) -> Result<Output, Error> {
    // Process data
    Ok(Output::new())
}
`;
    const result = extractFromSource('lib.rs', code);

    const funcNode = result.nodes.find((n) => n.kind === 'function');
    expect(funcNode).toBeDefined();
    expect(funcNode?.name).toBe('process_data');
    expect(funcNode?.visibility).toBe('public');
  });

  it('should extract struct declarations', () => {
    const code = `
pub struct User {
    pub id: String,
    pub name: String,
    email: String,
}
`;
    const result = extractFromSource('models.rs', code);

    const structNode = result.nodes.find((n) => n.kind === 'struct');
    expect(structNode).toBeDefined();
    expect(structNode?.name).toBe('User');
  });

  it('should extract trait declarations', () => {
    const code = `
pub trait Repository {
    fn find(&self, id: &str) -> Option<Entity>;
    fn save(&mut self, entity: Entity) -> Result<(), Error>;
}
`;
    const result = extractFromSource('traits.rs', code);

    const traitNode = result.nodes.find((n) => n.kind === 'trait');
    expect(traitNode).toBeDefined();
    expect(traitNode?.name).toBe('Repository');
  });

  it('should extract impl Trait for Type as implements edges', () => {
    const code = `
pub struct MyCache {}

pub trait Cache {
    fn get(&self, key: &str) -> Option<String>;
}

impl Cache for MyCache {
    fn get(&self, key: &str) -> Option<String> {
        None
    }
}
`;
    const result = extractFromSource('cache.rs', code);

    // Should have an unresolved reference for implements
    const implRef = result.unresolvedReferences.find(
      (r) => r.referenceKind === 'implements' && r.referenceName === 'Cache'
    );
    expect(implRef).toBeDefined();

    // The struct MyCache should be the source
    const myCacheNode = result.nodes.find((n) => n.name === 'MyCache' && n.kind === 'struct');
    expect(myCacheNode).toBeDefined();
    expect(implRef?.fromNodeId).toBe(myCacheNode?.id);
  });

  it('should extract trait supertraits as extends references', () => {
    const code = `
pub trait Display {}

pub trait Error: Display {
    fn description(&self) -> &str;
}
`;
    const result = extractFromSource('error.rs', code);

    const extendsRef = result.unresolvedReferences.find(
      (r) => r.referenceKind === 'extends' && r.referenceName === 'Display'
    );
    expect(extendsRef).toBeDefined();

    const errorTrait = result.nodes.find((n) => n.name === 'Error' && n.kind === 'trait');
    expect(errorTrait).toBeDefined();
    expect(extendsRef?.fromNodeId).toBe(errorTrait?.id);
  });

  it('should not create implements edges for plain impl blocks', () => {
    const code = `
pub struct Counter {
    count: u32,
}

impl Counter {
    pub fn new() -> Counter {
        Counter { count: 0 }
    }
    pub fn increment(&mut self) {
        self.count += 1;
    }
}
`;
    const result = extractFromSource('counter.rs', code);

    // Should have no implements references (no trait involved)
    const implRefs = result.unresolvedReferences.filter(
      (r) => r.referenceKind === 'implements'
    );
    expect(implRefs).toHaveLength(0);
  });
});

describe('Java Extraction', () => {
  it('should extract class declarations', () => {
    const code = `
public class UserService {
    private final UserRepository repository;

    public UserService(UserRepository repository) {
        this.repository = repository;
    }

    public User getUser(String id) {
        return repository.findById(id);
    }
}
`;
    const result = extractFromSource('UserService.java', code);

    const classNode = result.nodes.find((n) => n.kind === 'class');
    expect(classNode).toBeDefined();
    expect(classNode?.name).toBe('UserService');
    expect(classNode?.visibility).toBe('public');
  });

  it('should extract method declarations', () => {
    const code = `
public class Calculator {
    public static int add(int a, int b) {
        return a + b;
    }
}
`;
    const result = extractFromSource('Calculator.java', code);

    const methodNode = result.nodes.find((n) => n.kind === 'method' && n.name === 'add');
    expect(methodNode).toBeDefined();
    expect(methodNode?.isStatic).toBe(true);
  });

  it('wraps top-level declarations in a namespace from package_declaration', () => {
    const code = `
package com.example.foo;

public class Bar {
    public String greet() { return "hi"; }
}
`;
    const result = extractFromSource('Bar.java', code);

    const ns = result.nodes.find((n) => n.kind === 'namespace');
    expect(ns?.name).toBe('com.example.foo');

    const cls = result.nodes.find((n) => n.kind === 'class' && n.name === 'Bar');
    expect(cls?.qualifiedName).toBe('com.example.foo::Bar');

    const greet = result.nodes.find((n) => n.kind === 'method' && n.name === 'greet');
    expect(greet?.qualifiedName).toBe('com.example.foo::Bar::greet');
  });

  it('does not wrap when no package is declared', () => {
    const code = `
public class Bar {
    public String greet() { return "hi"; }
}
`;
    const result = extractFromSource('Bar.java', code);
    expect(result.nodes.find((n) => n.kind === 'namespace')).toBeUndefined();
    const cls = result.nodes.find((n) => n.kind === 'class' && n.name === 'Bar');
    expect(cls?.qualifiedName).toBe('Bar');
  });

  it('extracts anonymous-class overrides from `new T() { ... }`', () => {
    // The pattern that breaks the trace through `strategy.foo()` in
    // libraries like guava's Splitter: the lambda-returned anonymous
    // class overrides abstract methods on the base, but without
    // extracting those overrides the interface→impl synthesizer has
    // nothing to bridge.
    const code = `
package com.example;

abstract class Base {
  abstract int compute(int x);
}

public class Factory {
  public Base make() {
    return new Base() {
      @Override
      int compute(int x) { return x + 1; }
    };
  }
}
`;
    const result = extractFromSource('Factory.java', code);

    const anon = result.nodes.find((n) => n.kind === 'class' && /Base\$anon@/.test(n.name));
    expect(anon, 'anonymous Base subclass should be extracted as a class').toBeDefined();

    const compute = result.nodes.find(
      (n) => n.kind === 'method' && n.name === 'compute' && n.qualifiedName.includes('$anon@')
    );
    expect(compute, 'override method should be a method on the anon class').toBeDefined();
    expect(compute!.qualifiedName).toContain('Factory::make::<Base$anon@');
    expect(compute!.qualifiedName.endsWith('::compute')).toBe(true);

    // Anon class must extend Base so Phase 5.5 (interface-impl) can bridge.
    const extendsRef = result.unresolvedReferences.find(
      (r) => r.referenceKind === 'extends' && r.referenceName === 'Base' && r.fromNodeId === anon!.id
    );
    expect(extendsRef, 'anon class should carry an `extends Base` reference').toBeDefined();

    // The enclosing `make` method still emits an instantiates edge to Base —
    // anon extraction must not swallow that signal.
    const instantiatesRef = result.unresolvedReferences.find(
      (r) => r.referenceKind === 'instantiates' && r.referenceName === 'Base'
    );
    expect(instantiatesRef, 'enclosing method should still instantiate Base').toBeDefined();
  });

  it('extracts anonymous-class overrides inside a lambda body', () => {
    // The exact guava pattern: a lambda is passed to a constructor, and the
    // lambda body returns `new T() { @Override ... }`. The anon class must
    // still surface even though it sits inside a lambda_expression node.
    const code = `
package com.example;

interface Strategy {
  java.util.Iterator<String> iterator(String s);
}

abstract class BaseIter implements java.util.Iterator<String> {
  abstract int separatorStart(int start);
}

public class Splitter {
  private final Strategy strategy;
  public Splitter(Strategy s) { this.strategy = s; }

  public static Splitter on(char c) {
    return new Splitter((seq) ->
        new BaseIter() {
          @Override
          int separatorStart(int start) { return start + 1; }
          @Override public boolean hasNext() { return false; }
          @Override public String next() { return null; }
        });
  }
}
`;
    const result = extractFromSource('Splitter.java', code);

    const anon = result.nodes.find((n) => n.kind === 'class' && /BaseIter\$anon@/.test(n.name));
    expect(anon, 'anon BaseIter inside the lambda body should be extracted').toBeDefined();

    const sepStart = result.nodes.find(
      (n) =>
        n.kind === 'method' &&
        n.name === 'separatorStart' &&
        n.qualifiedName.includes('$anon@')
    );
    expect(sepStart, 'override inside the lambda-returned anon class should be a method node').toBeDefined();
  });
});

describe('C# Extraction', () => {
  it('should extract class declarations', () => {
    const code = `
public class OrderService
{
    private readonly IOrderRepository _repository;

    public OrderService(IOrderRepository repository)
    {
        _repository = repository;
    }

    public async Task<Order> GetOrderAsync(string id)
    {
        return await _repository.FindByIdAsync(id);
    }
}
`;
    const result = extractFromSource('OrderService.cs', code);

    const classNode = result.nodes.find((n) => n.kind === 'class');
    expect(classNode).toBeDefined();
    expect(classNode?.name).toBe('OrderService');
    expect(classNode?.visibility).toBe('public');
  });

  it('indexes primary-constructor classes, including keyed-DI attribute params (#237)', () => {
    // C# 12 primary constructors (`class Foo(IDep dep) { … }`) are parsed
    // natively by the vendored tree-sitter-c-sharp 0.23.x grammar. The worst
    // shape under the previous (older) grammar — an attribute-with-args on a
    // ctor param (`[FromKeyedServices("primary")] …`, the ASP.NET keyed-DI
    // pattern) — used to parse as an ERROR that swallowed the whole class, so
    // the class and all its methods vanished. They now index in every case.
    const code = `
public class DataService(IMemoryCache cache)
{
    public void Warm() { }
}

public class InstanceService(InstanceManager m, ProfileManager p)
{
    public void DeployAndLaunchAsync() { }
    public void Deploy() { }
}

public partial class UpdateService(int x) : ILifetimeService
{
    public void Run() { }
}

public class K1KeyedDi([FromKeyedServices("primary")] IMemoryCache cache)
{
    public void Warm() { }
}

public record CatalogBrand(int Id, string Name);
`;
    const result = extractFromSource('Services.cs', code);
    const classNames = result.nodes.filter((n) => n.kind === 'class').map((n) => n.name);
    expect(classNames).toContain('DataService');
    expect(classNames).toContain('InstanceService');
    expect(classNames).toContain('UpdateService'); // partial + base list
    expect(classNames).toContain('K1KeyedDi'); // attribute-arg ctor param — used to vanish entirely
    expect(classNames).toContain('CatalogBrand'); // record

    const methods = result.nodes.filter((n) => n.kind === 'method').map((n) => n.name);
    expect(methods).toContain('DeployAndLaunchAsync');
    expect(methods).toContain('Deploy');
    expect(methods).toContain('Run');
  });

  it('keeps a class indexable when a nested enum has #if-guarded members (#237)', () => {
    // A `#if` directive inside an enum member list (the multi-targeting pattern
    // in libraries like Newtonsoft.Json) makes the grammar emit an ERROR that,
    // for a nested enum, detaches the enclosing class's member list — dropping
    // most of the class's methods. A pre-parse pass blanks the directive lines
    // (keeping both branches), so the class and all its methods still index.
    const code = `
public class Reader
{
    private enum ReadType
    {
#if HAVE_DATE_TIME_OFFSET
        ReadAsDateTimeOffset,
#endif
        ReadAsDouble,
        ReadAsString,
    }

    public void Open() { }
    public void Close() { }
    public int ReadInt() { return 0; }
}
`;
    const result = extractFromSource('Reader.cs', code);
    const methods = result.nodes.filter((n) => n.kind === 'method').map((n) => n.name);
    // All three methods after the #if-bearing enum must survive.
    expect(methods).toContain('Open');
    expect(methods).toContain('Close');
    expect(methods).toContain('ReadInt');
    // Both enum branches are kept.
    const enumMembers = result.nodes.filter((n) => n.kind === 'enum_member').map((n) => n.name);
    expect(enumMembers).toContain('ReadAsDateTimeOffset');
    expect(enumMembers).toContain('ReadAsDouble');
  });
});

describe('PHP Extraction', () => {
  it('should extract class declarations', () => {
    const code = `<?php

class UserController
{
    private UserService $userService;

    public function __construct(UserService $userService)
    {
        $this->userService = $userService;
    }

    public function show(string $id): User
    {
        return $this->userService->find($id);
    }
}
`;
    const result = extractFromSource('UserController.php', code);

    const classNode = result.nodes.find((n) => n.kind === 'class');
    expect(classNode).toBeDefined();
    expect(classNode?.name).toBe('UserController');
  });

  it('should extract class inheritance (extends) and interface implementation', () => {
    const code = `<?php

class ChildController extends BaseController implements Serializable, JsonSerializable
{
    public function serialize(): string
    {
        return json_encode($this);
    }
}
`;
    const result = extractFromSource('ChildController.php', code);

    const classNode = result.nodes.find((n) => n.kind === 'class');
    expect(classNode).toBeDefined();
    expect(classNode?.name).toBe('ChildController');

    const extendsRef = result.unresolvedReferences.find(
      (r) => r.referenceKind === 'extends'
    );
    expect(extendsRef).toBeDefined();
    expect(extendsRef?.referenceName).toBe('BaseController');

    const implementsRefs = result.unresolvedReferences.filter(
      (r) => r.referenceKind === 'implements'
    );
    expect(implementsRefs.length).toBe(2);
    expect(implementsRefs.map((r) => r.referenceName)).toContain('Serializable');
    expect(implementsRefs.map((r) => r.referenceName)).toContain('JsonSerializable');
  });
});

describe('Swift Extraction', () => {
  it('should extract class declarations', () => {
    const code = `
public class NetworkManager {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func fetchData(from url: URL) async throws -> Data {
        let (data, _) = try await session.data(from: url)
        return data
    }
}
`;
    const result = extractFromSource('NetworkManager.swift', code);

    const classNode = result.nodes.find((n) => n.kind === 'class');
    expect(classNode).toBeDefined();
    expect(classNode?.name).toBe('NetworkManager');
  });

  it('should extract function declarations', () => {
    const code = `
func calculateSum(_ numbers: [Int]) -> Int {
    return numbers.reduce(0, +)
}

public func formatCurrency(amount: Double) -> String {
    return String(format: "$%.2f", amount)
}
`;
    const result = extractFromSource('utils.swift', code);

    const functions = result.nodes.filter((n) => n.kind === 'function');
    expect(functions.length).toBeGreaterThanOrEqual(1);
  });

  it('should extract struct declarations', () => {
    const code = `
public struct User {
    let id: UUID
    var name: String
    var email: String

    func displayName() -> String {
        return name
    }
}
`;
    const result = extractFromSource('User.swift', code);

    const structNode = result.nodes.find((n) => n.kind === 'struct');
    expect(structNode).toBeDefined();
    expect(structNode?.name).toBe('User');
  });

  it('should extract protocol declarations', () => {
    const code = `
public protocol Repository {
    associatedtype Entity

    func find(id: String) async throws -> Entity?
    func save(_ entity: Entity) async throws
}
`;
    const result = extractFromSource('Repository.swift', code);

    const protocolNode = result.nodes.find((n) => n.kind === 'interface');
    expect(protocolNode).toBeDefined();
    expect(protocolNode?.name).toBe('Repository');
  });

  it('should extract class inheritance and protocol conformance', () => {
    const code = `
class DataRequest: Request {
    func validate() {}
}

class UploadRequest: DataRequest, Sendable {
    func upload() {}
}

enum AFError: Error {
    case invalidURL
}

struct HTTPMethod: RawRepresentable {
    let rawValue: String
}

protocol UploadConvertible: URLRequestConvertible {
    func asURLRequest() throws -> URLRequest
}
`;
    const result = extractFromSource('Inheritance.swift', code);

    const extendsRefs = result.unresolvedReferences.filter(
      (r) => r.referenceKind === 'extends'
    );

    // DataRequest extends Request
    expect(extendsRefs.find((r) => r.referenceName === 'Request')).toBeDefined();
    // UploadRequest extends DataRequest and Sendable
    expect(extendsRefs.find((r) => r.referenceName === 'DataRequest')).toBeDefined();
    expect(extendsRefs.find((r) => r.referenceName === 'Sendable')).toBeDefined();
    // AFError extends Error
    expect(extendsRefs.find((r) => r.referenceName === 'Error')).toBeDefined();
    // HTTPMethod extends RawRepresentable
    expect(extendsRefs.find((r) => r.referenceName === 'RawRepresentable')).toBeDefined();
    // UploadConvertible extends URLRequestConvertible
    expect(extendsRefs.find((r) => r.referenceName === 'URLRequestConvertible')).toBeDefined();
  });
});

describe('Kotlin Extraction', () => {
  it('should extract class declarations', () => {
    const code = `
class UserRepository(private val database: Database) {
    fun findById(id: String): User? {
        return database.query("SELECT * FROM users WHERE id = ?", id)
    }

    suspend fun save(user: User) {
        database.insert(user)
    }
}
`;
    const result = extractFromSource('UserRepository.kt', code);

    const classNode = result.nodes.find((n) => n.kind === 'class');
    expect(classNode).toBeDefined();
    expect(classNode?.name).toBe('UserRepository');
  });

  it('should extract function declarations', () => {
    const code = `
fun calculateTotal(items: List<Item>): Double {
    return items.sumOf { it.price }
}

suspend fun fetchUserData(userId: String): User {
    return api.getUser(userId)
}
`;
    const result = extractFromSource('utils.kt', code);

    const functions = result.nodes.filter((n) => n.kind === 'function');
    expect(functions.length).toBeGreaterThanOrEqual(1);
  });

  it('should detect suspend functions as async', () => {
    const code = `
suspend fun loadData(): List<String> {
    delay(1000)
    return listOf("a", "b", "c")
}
`;
    const result = extractFromSource('loader.kt', code);

    const funcNode = result.nodes.find((n) => n.kind === 'function');
    expect(funcNode).toBeDefined();
    expect(funcNode?.isAsync).toBe(true);
  });

  it('should extract fun interface declarations', () => {
    const code = `
fun interface OnObjectRetainedListener {
  fun onObjectRetained()
}
`;
    const result = extractFromSource('listener.kt', code);

    const ifaceNode = result.nodes.find((n) => n.kind === 'interface');
    expect(ifaceNode).toBeDefined();
    expect(ifaceNode?.name).toBe('OnObjectRetainedListener');

    const methodNode = result.nodes.find((n) => n.kind === 'method');
    expect(methodNode).toBeDefined();
    expect(methodNode?.name).toBe('onObjectRetained');
    expect(methodNode?.qualifiedName).toBe('OnObjectRetainedListener::onObjectRetained');
  });

  it('should extract complex fun interface with nested classes', () => {
    const code = `
fun interface EventListener {
  fun onEvent(event: Event)

  sealed class Event {
    class DumpingHeap : Event()
  }
}
`;
    const result = extractFromSource('events.kt', code);

    const ifaceNode = result.nodes.find((n) => n.kind === 'interface');
    expect(ifaceNode).toBeDefined();
    expect(ifaceNode?.name).toBe('EventListener');

    // Nested sealed class should still be extracted (as sibling due to grammar limitations)
    const eventClass = result.nodes.find((n) => n.kind === 'class' && n.name === 'Event');
    expect(eventClass).toBeDefined();

    const dumpingHeap = result.nodes.find((n) => n.kind === 'class' && n.name === 'DumpingHeap');
    expect(dumpingHeap).toBeDefined();
  });

  it('should not affect regular function declarations', () => {
    const code = `
fun interface MyCallback {
  fun invoke(value: Int)
}

fun regularFunction(): String {
  return "hello"
}
`;
    const result = extractFromSource('mixed.kt', code);

    const ifaceNode = result.nodes.find((n) => n.kind === 'interface');
    expect(ifaceNode).toBeDefined();
    expect(ifaceNode?.name).toBe('MyCallback');

    const funcNode = result.nodes.find((n) => n.kind === 'function');
    expect(funcNode).toBeDefined();
    expect(funcNode?.name).toBe('regularFunction');
  });

  it('should extract fun interface with annotation on method (Pattern 2b)', () => {
    // When the SAM method has annotations like @Throws, tree-sitter produces a different
    // misparse: function_declaration > ERROR("interface Name {") instead of
    // function_declaration > user_type("interface"). This is the OkHttp Interceptor pattern.
    const code = `
import java.io.IOException

fun interface Interceptor {
  @Throws(IOException::class)
  fun intercept(chain: Chain): Response
}
`;
    const result = extractFromSource('interceptor.kt', code);

    const ifaceNode = result.nodes.find((n) => n.kind === 'interface');
    expect(ifaceNode).toBeDefined();
    expect(ifaceNode?.name).toBe('Interceptor');
  });

  it('should extract methods from interface with nested fun interface', () => {
    // When an interface contains a nested `fun interface`, tree-sitter misparsed
    // the parent body as ERROR. Methods inside should still be extracted.
    const code = `
interface WebSocket {
  fun request(): Request
  fun send(text: String): Boolean
  fun cancel()
  fun interface Factory {
    fun newWebSocket(request: Request): WebSocket
  }
}
`;
    const result = extractFromSource('websocket.kt', code);

    const wsIface = result.nodes.find((n) => n.kind === 'interface' && n.name === 'WebSocket');
    expect(wsIface).toBeDefined();

    const methods = result.nodes.filter((n) => n.kind === 'method' && n.qualifiedName?.startsWith('WebSocket::'));
    const methodNames = methods.map((m) => m.name);
    expect(methodNames).toContain('request');
    expect(methodNames).toContain('send');
    expect(methodNames).toContain('cancel');
  });

  it('wraps top-level declarations in a namespace from package_header', () => {
    const code = `
package com.example.foo

class Bar {
  fun greet(): String = "hi"
}

fun util(): Int = 42
`;
    const result = extractFromSource('Bar.kt', code);

    const ns = result.nodes.find((n) => n.kind === 'namespace');
    expect(ns?.name).toBe('com.example.foo');

    const cls = result.nodes.find((n) => n.kind === 'class' && n.name === 'Bar');
    expect(cls?.qualifiedName).toBe('com.example.foo::Bar');

    const greet = result.nodes.find((n) => n.kind === 'method' && n.name === 'greet');
    expect(greet?.qualifiedName).toBe('com.example.foo::Bar::greet');

    const util = result.nodes.find((n) => n.kind === 'function' && n.name === 'util');
    expect(util?.qualifiedName).toBe('com.example.foo::util');
  });

  it('handles a single-segment package', () => {
    const code = `
package foo

class Bar
`;
    const result = extractFromSource('Bar.kt', code);
    const cls = result.nodes.find((n) => n.kind === 'class' && n.name === 'Bar');
    expect(cls?.qualifiedName).toBe('foo::Bar');
  });

  it('does not wrap when no package is declared', () => {
    const code = `
class Bar {
  fun greet() = "hi"
}
`;
    const result = extractFromSource('Bar.kt', code);
    expect(result.nodes.find((n) => n.kind === 'namespace')).toBeUndefined();
    const cls = result.nodes.find((n) => n.kind === 'class' && n.name === 'Bar');
    expect(cls?.qualifiedName).toBe('Bar');
  });
});

describe('Dart Extraction', () => {
  it('should extract class declarations', () => {
    const code = `
class UserService {
  final Database _db;

  Future<User> findById(String id) async {
    return await _db.query(id);
  }

  void _privateMethod() {}
}
`;
    const result = extractFromSource('service.dart', code);

    const classNode = result.nodes.find((n) => n.kind === 'class');
    expect(classNode).toBeDefined();
    expect(classNode?.name).toBe('UserService');
    expect(classNode?.visibility).toBe('public');

    const methodNodes = result.nodes.filter((n) => n.kind === 'method');
    expect(methodNodes.length).toBeGreaterThanOrEqual(2);

    const findById = methodNodes.find((m) => m.name === 'findById');
    expect(findById).toBeDefined();
    expect(findById?.isAsync).toBe(true);

    const privateMethod = methodNodes.find((m) => m.name === '_privateMethod');
    expect(privateMethod).toBeDefined();
    expect(privateMethod?.visibility).toBe('private');

    // Dart models a method body as a SIBLING of the signature, so the method
    // node must be extended to span its body (not just the signature line) —
    // required for body-level analysis (callees, the callback synthesizer).
    expect(findById!.endLine).toBeGreaterThan(findById!.startLine);
  });

  it('should extract top-level function declarations', () => {
    const code = `
void topLevelFunction(String name) {
  print(name);
}
`;
    const result = extractFromSource('utils.dart', code);

    const funcNode = result.nodes.find((n) => n.kind === 'function');
    expect(funcNode).toBeDefined();
    expect(funcNode?.name).toBe('topLevelFunction');
    expect(funcNode?.language).toBe('dart');
  });

  it('should extract enum declarations', () => {
    const code = `
enum Status { active, inactive, pending }
`;
    const result = extractFromSource('models.dart', code);

    const enumNode = result.nodes.find((n) => n.kind === 'enum');
    expect(enumNode).toBeDefined();
    expect(enumNode?.name).toBe('Status');
  });

  it('should extract mixin declarations', () => {
    const code = `
mixin LoggerMixin {
  void log(String message) {}
}
`;
    const result = extractFromSource('mixins.dart', code);

    const classNode = result.nodes.find((n) => n.kind === 'class');
    expect(classNode).toBeDefined();
    expect(classNode?.name).toBe('LoggerMixin');

    const methodNode = result.nodes.find((n) => n.kind === 'method');
    expect(methodNode).toBeDefined();
    expect(methodNode?.name).toBe('log');
  });

  it('should extract extension declarations', () => {
    const code = `
extension StringExt on String {
  bool get isBlank => trim().isEmpty;
}
`;
    const result = extractFromSource('extensions.dart', code);

    const classNode = result.nodes.find((n) => n.kind === 'class');
    expect(classNode).toBeDefined();
    expect(classNode?.name).toBe('StringExt');
  });

  it('should detect static methods', () => {
    const code = `
class Utils {
  static void doWork() {}
}
`;
    const result = extractFromSource('utils.dart', code);

    const methodNode = result.nodes.find((n) => n.kind === 'method');
    expect(methodNode).toBeDefined();
    expect(methodNode?.name).toBe('doWork');
    expect(methodNode?.isStatic).toBe(true);
  });

  it('should detect async functions', () => {
    const code = `
Future<String> fetchData() async {
  return await http.get('/data');
}
`;
    const result = extractFromSource('api.dart', code);

    const funcNode = result.nodes.find((n) => n.kind === 'function');
    expect(funcNode).toBeDefined();
    expect(funcNode?.name).toBe('fetchData');
    expect(funcNode?.isAsync).toBe(true);
  });

  it('should detect private visibility via underscore convention', () => {
    const code = `
void _privateHelper() {}

void publicFunction() {}
`;
    const result = extractFromSource('helpers.dart', code);

    const functions = result.nodes.filter((n) => n.kind === 'function');
    const privateFunc = functions.find((f) => f.name === '_privateHelper');
    const publicFunc = functions.find((f) => f.name === 'publicFunction');

    expect(privateFunc?.visibility).toBe('private');
    expect(publicFunc?.visibility).toBe('public');
  });
});

describe('Import Extraction', () => {
  describe('TypeScript/JavaScript imports', () => {
    it('should extract default imports', () => {
      const code = `import React from 'react';`;
      const result = extractFromSource('app.tsx', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('react');
      expect(importNode?.signature).toBe("import React from 'react';");
    });

    it('should extract named imports', () => {
      const code = `import { Bug, Database } from '@phosphor-icons/react';`;
      const result = extractFromSource('icons.tsx', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('@phosphor-icons/react');
      expect(importNode?.signature).toContain('Bug');
      expect(importNode?.signature).toContain('Database');
    });

    it('should extract namespace imports', () => {
      const code = `import * as Icons from '@phosphor-icons/react';`;
      const result = extractFromSource('icons.tsx', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('@phosphor-icons/react');
      expect(importNode?.signature).toContain('* as Icons');
    });

    it('should extract side-effect imports', () => {
      const code = `import './styles.css';`;
      const result = extractFromSource('app.tsx', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('./styles.css');
    });

    it('should extract mixed imports (default + named)', () => {
      const code = `import React, { useState, useEffect } from 'react';`;
      const result = extractFromSource('app.tsx', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('react');
      expect(importNode?.signature).toContain('React');
      expect(importNode?.signature).toContain('useState');
      expect(importNode?.signature).toContain('useEffect');
    });

    it('should extract multiple import statements', () => {
      const code = `
import React from 'react';
import { Button } from './components';
import './styles.css';
`;
      const result = extractFromSource('app.tsx', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('react');
      expect(names).toContain('./components');
      expect(names).toContain('./styles.css');
    });

    it('should extract type imports', () => {
      const code = `import type { FC, ReactNode } from 'react';`;
      const result = extractFromSource('types.ts', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('react');
      expect(importNode?.signature).toContain('type');
      expect(importNode?.signature).toContain('FC');
    });

    it('should extract aliased named imports', () => {
      const code = `import { useState as useStateAlias } from 'react';`;
      const result = extractFromSource('hooks.ts', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('react');
      expect(importNode?.signature).toContain('useState');
      expect(importNode?.signature).toContain('useStateAlias');
    });

    it('should extract relative path imports', () => {
      const code = `import { helper } from '../utils/helper';`;
      const result = extractFromSource('components/Button.tsx', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('../utils/helper');
      expect(importNode?.signature).toContain('helper');
    });
  });

  describe('Python imports', () => {
    it('should extract simple import statement', () => {
      const code = `import json`;
      const result = extractFromSource('utils.py', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('json');
    });

    it('should extract from import statement', () => {
      const code = `from os import path`;
      const result = extractFromSource('utils.py', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('os');
      expect(importNode?.signature).toContain('path');
    });

    it('should extract multiple imports from same module', () => {
      const code = `from typing import List, Dict, Optional`;
      const result = extractFromSource('types.py', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('typing');
      expect(importNode?.signature).toContain('List');
      expect(importNode?.signature).toContain('Dict');
    });

    it('should extract multiple import statements', () => {
      const code = `
import os
import sys
`;
      const result = extractFromSource('main.py', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(2);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('os');
      expect(names).toContain('sys');
    });

    it('should extract aliased import', () => {
      const code = `import numpy as np`;
      const result = extractFromSource('data.py', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('numpy');
      expect(importNode?.signature).toContain('as np');
    });

    it('should extract relative import', () => {
      const code = `from .utils import helper`;
      const result = extractFromSource('module.py', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('.utils');
      expect(importNode?.signature).toContain('helper');
    });

    it('should extract wildcard import', () => {
      const code = `from typing import *`;
      const result = extractFromSource('types.py', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('typing');
      expect(importNode?.signature).toContain('*');
    });
  });

  describe('Rust imports', () => {
    it('should extract simple use declaration', () => {
      const code = `use std::io;`;
      const result = extractFromSource('main.rs', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('std');
      expect(importNode?.signature).toBe('use std::io;');
    });

    it('should extract scoped use list', () => {
      const code = `use std::{ffi::OsStr, io, path::Path};`;
      const result = extractFromSource('main.rs', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('std');
      expect(importNode?.signature).toContain('ffi::OsStr');
      expect(importNode?.signature).toContain('path::Path');
    });

    it('should extract crate imports', () => {
      const code = `use crate::error::Error;`;
      const result = extractFromSource('lib.rs', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('crate');
    });

    it('should extract super imports', () => {
      const code = `use super::utils;`;
      const result = extractFromSource('submod.rs', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('super');
    });

    it('should extract external crate imports', () => {
      const code = `use serde::{Serialize, Deserialize};`;
      const result = extractFromSource('types.rs', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('serde');
      expect(importNode?.signature).toContain('Serialize');
      expect(importNode?.signature).toContain('Deserialize');
    });
  });

  describe('Go imports', () => {
    it('should extract single import', () => {
      const code = `
package main

import "fmt"
`;
      const result = extractFromSource('main.go', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('fmt');
    });

    it('should extract grouped imports', () => {
      const code = `
package main

import (
	"fmt"
	"os"
	"encoding/json"
)
`;
      const result = extractFromSource('main.go', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('fmt');
      expect(names).toContain('os');
      expect(names).toContain('encoding/json');
    });

    it('should extract aliased import', () => {
      const code = `
package main

import f "fmt"
`;
      const result = extractFromSource('main.go', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('fmt');
      expect(importNode?.signature).toContain('f');
    });

    it('should extract dot import', () => {
      const code = `
package main

import . "math"
`;
      const result = extractFromSource('main.go', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('math');
      expect(importNode?.signature).toContain('.');
    });

    it('should extract blank import', () => {
      const code = `
package main

import _ "github.com/go-sql-driver/mysql"
`;
      const result = extractFromSource('main.go', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('github.com/go-sql-driver/mysql');
      expect(importNode?.signature).toContain('_');
    });
  });

  describe('Swift imports', () => {
    it('should extract simple import', () => {
      const code = `import Foundation`;
      const result = extractFromSource('main.swift', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('Foundation');
      expect(importNode?.signature).toBe('import Foundation');
    });

    it('should extract @testable import', () => {
      const code = `@testable import Alamofire`;
      const result = extractFromSource('Tests.swift', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('Alamofire');
      expect(importNode?.signature).toContain('@testable');
    });

    it('should extract @preconcurrency import', () => {
      const code = `@preconcurrency import Security`;
      const result = extractFromSource('Auth.swift', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('Security');
    });

    it('should extract multiple imports', () => {
      const code = `
import Foundation
import UIKit
import Alamofire
`;
      const result = extractFromSource('App.swift', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('Foundation');
      expect(names).toContain('UIKit');
      expect(names).toContain('Alamofire');
    });
  });

  describe('Kotlin imports', () => {
    it('should extract simple import', () => {
      const code = `import java.io.IOException`;
      const result = extractFromSource('Main.kt', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('java.io.IOException');
      expect(importNode?.signature).toBe('import java.io.IOException');
    });

    it('should extract aliased import', () => {
      const code = `import okhttp3.Request.Builder as RequestBuilder`;
      const result = extractFromSource('Utils.kt', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('okhttp3.Request.Builder');
      expect(importNode?.signature).toContain('as RequestBuilder');
    });

    it('should extract wildcard import', () => {
      const code = `import java.util.concurrent.TimeUnit.*`;
      const result = extractFromSource('Time.kt', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('java.util.concurrent.TimeUnit');
      expect(importNode?.signature).toContain('.*');
    });

    it('should extract multiple imports', () => {
      const code = `
import java.io.IOException
import kotlin.test.assertFailsWith
import okhttp3.OkHttpClient
`;
      const result = extractFromSource('Test.kt', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('java.io.IOException');
      expect(names).toContain('kotlin.test.assertFailsWith');
      expect(names).toContain('okhttp3.OkHttpClient');
    });
  });

  describe('Java imports', () => {
    it('should extract simple import', () => {
      const code = `import java.util.List;`;
      const result = extractFromSource('Main.java', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('java.util.List');
      expect(importNode?.signature).toBe('import java.util.List;');
    });

    it('should extract static import', () => {
      const code = `import static java.util.Collections.emptyList;`;
      const result = extractFromSource('Utils.java', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('java.util.Collections.emptyList');
      expect(importNode?.signature).toContain('static');
    });

    it('should extract wildcard import', () => {
      const code = `import java.util.*;`;
      const result = extractFromSource('App.java', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('java.util');
      expect(importNode?.signature).toContain('.*');
    });

    it('should extract nested class import', () => {
      const code = `import java.util.Map.Entry;`;
      const result = extractFromSource('MapUtil.java', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('java.util.Map.Entry');
    });

    it('should extract multiple imports', () => {
      const code = `
import java.util.List;
import java.util.Map;
import java.io.IOException;
`;
      const result = extractFromSource('Service.java', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('java.util.List');
      expect(names).toContain('java.util.Map');
      expect(names).toContain('java.io.IOException');
    });
  });

  describe('C# imports', () => {
    it('should extract simple using', () => {
      const code = `using System;`;
      const result = extractFromSource('Program.cs', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('System');
      expect(importNode?.signature).toBe('using System;');
    });

    it('should extract qualified using', () => {
      const code = `using System.Collections.Generic;`;
      const result = extractFromSource('Utils.cs', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('System.Collections.Generic');
    });

    it('should extract static using', () => {
      const code = `using static System.Console;`;
      const result = extractFromSource('App.cs', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('System.Console');
      expect(importNode?.signature).toContain('static');
    });

    it('should extract alias using', () => {
      const code = `using MyList = System.Collections.Generic.List<int>;`;
      const result = extractFromSource('Types.cs', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('System.Collections.Generic.List<int>');
      expect(importNode?.signature).toContain('MyList =');
    });

    it('should extract multiple usings', () => {
      const code = `
using System;
using System.Threading.Tasks;
using Microsoft.Extensions.DependencyInjection;
`;
      const result = extractFromSource('Service.cs', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('System');
      expect(names).toContain('System.Threading.Tasks');
      expect(names).toContain('Microsoft.Extensions.DependencyInjection');
    });
  });

  describe('PHP imports', () => {
    it('should extract simple use', () => {
      const code = `<?php use PHPUnit\\Framework\\TestCase;`;
      const result = extractFromSource('Test.php', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('PHPUnit\\Framework\\TestCase');
    });

    it('should extract aliased use', () => {
      const code = `<?php use Mockery as m;`;
      const result = extractFromSource('Test.php', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('Mockery');
      expect(importNode?.signature).toContain('as m');
    });

    it('should extract function use', () => {
      const code = `<?php use function Illuminate\\Support\\env;`;
      const result = extractFromSource('helpers.php', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('Illuminate\\Support\\env');
      expect(importNode?.signature).toContain('function');
    });

    it('should extract grouped use', () => {
      const code = `<?php use Illuminate\\Database\\{Model, Builder};`;
      const result = extractFromSource('Models.php', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(2);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('Illuminate\\Database\\Model');
      expect(names).toContain('Illuminate\\Database\\Builder');
    });

    it('should extract multiple uses', () => {
      const code = `<?php
use Illuminate\\Support\\Collection;
use Illuminate\\Support\\Str;
use Closure;
`;
      const result = extractFromSource('Service.php', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('Illuminate\\Support\\Collection');
      expect(names).toContain('Illuminate\\Support\\Str');
      expect(names).toContain('Closure');
    });

    it('should extract include/require (+_once) static paths as imports (#660)', () => {
      const code = `<?php
require_once("lib.php");
include 'other.php';
require 'r.php';
include_once("io.php");
`;
      const result = extractFromSource('page.php', code);
      const names = result.nodes.filter((n) => n.kind === 'import').map((n) => n.name);
      expect(names).toContain('lib.php');
      expect(names).toContain('other.php');
      expect(names).toContain('r.php');
      expect(names).toContain('io.php');
    });

    it('should skip dynamic include/require with no static path (#660)', () => {
      const code = `<?php
require_once(__DIR__ . '/dyn.php');
include $file;
include "tpl/{$name}.php";
`;
      const result = extractFromSource('page.php', code);
      const imports = result.nodes.filter((n) => n.kind === 'import');
      expect(imports).toHaveLength(0);
    });

    it('should extract include alongside namespace use without interference (#660)', () => {
      const code = `<?php
use App\\Service\\Mailer;
require_once("bootstrap.php");
`;
      const result = extractFromSource('page.php', code);
      const names = result.nodes.filter((n) => n.kind === 'import').map((n) => n.name);
      expect(names).toContain('App\\Service\\Mailer');
      expect(names).toContain('bootstrap.php');
    });
  });

  describe('Ruby imports', () => {
    it('should extract require', () => {
      const code = `require 'json'`;
      const result = extractFromSource('app.rb', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('json');
      expect(importNode?.signature).toBe("require 'json'");
    });

    it('should extract require with path', () => {
      const code = `require 'active_support/core_ext/string'`;
      const result = extractFromSource('config.rb', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('active_support/core_ext/string');
    });

    it('should extract require_relative', () => {
      const code = `require_relative '../test_helper'`;
      const result = extractFromSource('test/my_test.rb', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('../test_helper');
      expect(importNode?.signature).toContain('require_relative');
    });

    it('should not extract non-require calls', () => {
      const code = `puts 'hello'`;
      const result = extractFromSource('app.rb', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeUndefined();
    });

    it('should extract multiple requires', () => {
      const code = `
require 'json'
require 'yaml'
require_relative 'helper'
`;
      const result = extractFromSource('lib.rb', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('json');
      expect(names).toContain('yaml');
      expect(names).toContain('helper');
    });
  });

  describe('Ruby modules', () => {
    it('should extract module as module node with containment', () => {
      const code = `
module CachedCounting
  def self.disable
    @enabled = false
  end

  def perform_increment!(key, count)
    write_cache!(key, count)
  end
end
`;
      const result = extractFromSource('concerns/cached_counting.rb', code);

      const moduleNode = result.nodes.find((n) => n.kind === 'module' && n.name === 'CachedCounting');
      expect(moduleNode).toBeDefined();
      expect(moduleNode?.qualifiedName).toBe('CachedCounting');

      // Methods inside module should have module-qualified names
      const disableMethod = result.nodes.find((n) => n.name === 'disable' && n.kind === 'method');
      expect(disableMethod).toBeDefined();
      expect(disableMethod?.qualifiedName).toBe('CachedCounting::disable');

      const incrementMethod = result.nodes.find((n) => n.name === 'perform_increment!' && n.kind === 'method');
      expect(incrementMethod).toBeDefined();
      expect(incrementMethod?.qualifiedName).toBe('CachedCounting::perform_increment!');

      // Containment edge from module to methods
      const containsEdges = result.edges.filter((e) => e.source === moduleNode?.id && e.kind === 'contains');
      expect(containsEdges.length).toBeGreaterThanOrEqual(2);
    });

    it('should handle nested modules with classes', () => {
      const code = `
module Discourse
  module Auth
    class AuthProvider
      def authenticate(params)
        validate(params)
      end
    end
  end
end
`;
      const result = extractFromSource('lib/auth.rb', code);

      const discourseModule = result.nodes.find((n) => n.kind === 'module' && n.name === 'Discourse');
      expect(discourseModule).toBeDefined();

      const authModule = result.nodes.find((n) => n.kind === 'module' && n.name === 'Auth');
      expect(authModule).toBeDefined();
      expect(authModule?.qualifiedName).toBe('Discourse::Auth');

      const authProvider = result.nodes.find((n) => n.kind === 'class' && n.name === 'AuthProvider');
      expect(authProvider).toBeDefined();
      expect(authProvider?.qualifiedName).toBe('Discourse::Auth::AuthProvider');

      const authMethod = result.nodes.find((n) => n.name === 'authenticate');
      expect(authMethod).toBeDefined();
      expect(authMethod?.qualifiedName).toBe('Discourse::Auth::AuthProvider::authenticate');
    });
  });

  describe('PHP return type capture (#608)', () => {
    it('captures self/static factory returns as the `self` marker; primitives as undefined', () => {
      const code = `<?php
class ApiClient {
    public static function for(string $c): self { return new self; }
    public static function make(): static { return new static; }
    public function send(array $p): array { return []; }
}`;
      const result = extractFromSource('ApiClient.php', code);
      expect(result.nodes.find((n) => n.name === 'for' && n.kind === 'method')?.returnType).toBe('self');
      expect(result.nodes.find((n) => n.name === 'make' && n.kind === 'method')?.returnType).toBe('self');
      // `array` is not a class to chain on → no return type recorded.
      expect(result.nodes.find((n) => n.name === 'send' && n.kind === 'method')?.returnType).toBeUndefined();
    });

    it('captures a concrete return type as its short class name', () => {
      const code = `<?php
namespace App;
class WidgetFactory { public static function make(): Widget { return new Widget(); } }`;
      const result = extractFromSource('WidgetFactory.php', code);
      expect(result.nodes.find((n) => n.name === 'make' && n.kind === 'method')?.returnType).toBe('Widget');
    });
  });

  describe('C/C++ return type capture (#645)', () => {
    it('captures the normalized return type of a C++ method/function', () => {
      const code = `
struct Widget { void draw(); };
class Factory { public: static Widget create(); };
Widget Factory::create() { return Widget(); }
void doNothing() {}
`;
      const result = extractFromSource('f.cpp', code);

      const create = result.nodes.find(
        (n) => n.name === 'create' && (n.kind === 'method' || n.kind === 'function')
      );
      expect(create?.returnType).toBe('Widget');

      // A `void` return records no type, so resolution never tries to resolve a
      // method on it.
      const doNothing = result.nodes.find((n) => n.name === 'doNothing');
      expect(doNothing).toBeDefined();
      expect(doNothing?.returnType).toBeUndefined();
    });

    it('unwraps a smart-pointer return type to its pointee', () => {
      const code = `
#include <memory>
struct Widget {};
std::unique_ptr<Widget> makeWidget() { return nullptr; }
`;
      const result = extractFromSource('f.cpp', code);

      const make = result.nodes.find((n) => n.name === 'makeWidget');
      expect(make?.returnType).toBe('Widget');
    });
  });

  describe('C/C++ function with unrecognized macros before name', () => {
    it('extracts function name from type field when multiple macros confuse tree-sitter', () => {
      // tree-sitter misparses 2+ unknown identifiers before the function name:
      // the first two tokens become a spurious declaration, and the real
      // function name ends up in the type field with parameters wrapped in a
      // parenthesized_declarator.
      const code = `
RRE_ATTRIBUTE_VISIBILITY VOS_UINT32 ctraRegisterClassAcl6(VOS_VOID)
{
    return VOS_OK;
}
`;
      const result = extractFromSource('eacl_acl6.c', code);

      const func = result.nodes.find((n) => n.kind === 'function'
        && n.name === 'ctraRegisterClassAcl6');
      expect(func).toBeDefined();
      // In the misparse the type field holds the function name, not the real
      // return type — tree-sitter already misplaced VOS_UINT32 into a separate
      // spurious declaration node.  The key win is that the function node now
      // carries the correct name.
    });

    it('does not regress single-macro parsing', () => {
      // One unknown macro is handled correctly by tree-sitter
      const code = `
VOS_UINT32 normalFunc(VOS_VOID)
{
    return VOS_OK;
}
`;
      const result = extractFromSource('normal.c', code);

      const func = result.nodes.find((n) => n.kind === 'function'
        && n.name === 'normalFunc');
      expect(func).toBeDefined();
    });

    it('extracts function name when parenthesized_declarator wraps function_declarator', () => {
      // Valid C: parenthesized function name
      const code = `int (legit)(int a) { return a; }`;
      const result = extractFromSource('legit.c', code);

      const func = result.nodes.find((n) => n.kind === 'function'
        && n.name === 'legit');
      expect(func).toBeDefined();
    });
  });

  describe('C/C++ variable with unrecognized macros before name', () => {
    it('extracts variable name when 2+ macros precede variable with initializer (Pattern A)', () => {
      // tree-sitter splits 2+ unknown identifiers before a variable with an
      // initializer: the first N tokens become a spurious declaration, and the
      // real assignment lands in an orphaned expression_statement.
      const code = `
RRE_ATTRIBUTE_VISIBILITY VOS_UINT32 g_DEV_ulFrameType = VOS_NULL_LONG;
`;
      const result = extractFromSource('test.c', code);

      const variable = result.nodes.find((n) => n.kind === 'variable'
        && n.name === 'g_DEV_ulFrameType');
      expect(variable).toBeDefined();
      expect(variable?.signature).toMatch(/^= VOS_NULL_LONG/);
    });

    it('extracts variable name when 2+ macros precede variable with numeric init (Pattern A)', () => {
      const code = `
RRE_ATTRIBUTE_VISIBILITY VOS_UINT32 g_CDEV_ulMaxRruCount = 342;
`;
      const result = extractFromSource('test2.c', code);

      const variable = result.nodes.find((n) => n.kind === 'variable'
        && n.name === 'g_CDEV_ulMaxRruCount');
      expect(variable).toBeDefined();
    });

    it('extracts variable name when 2+ macros precede pointer variable (Pattern A)', () => {
      const code = `
RRE_ATTRIBUTE_VISIBILITY HTIMER g_CDEV_hEqmtRegElblBinTimer = VOS_NULL_PTR;
`;
      const result = extractFromSource('test3.c', code);

      const variable = result.nodes.find((n) => n.kind === 'variable'
        && n.name === 'g_CDEV_hEqmtRegElblBinTimer');
      expect(variable).toBeDefined();
    });

    it('extracts variable name from ERROR node when macros before array variable (Pattern B)', () => {
      // When a macro appears before an array variable, tree-sitter misparses
      // the macro as the declarator identifier and puts the real variable name
      // inside an ERROR child of the array_declarator.
      const code = `
EXTERN_STDC_BEGIN ADA_DEV_IDCVT_TABLE_STRU g_DEV_astRruDlIdCvtTbl[] = { { 0, 1 } };
`;
      const result = extractFromSource('test4.c', code);

      const variable = result.nodes.find((n) => n.kind === 'variable'
        && n.name === 'g_DEV_astRruDlIdCvtTbl');
      expect(variable).toBeDefined();
    });

    it('extracts variable name from init_declarator ERROR when type is a macro (Pattern C)', () => {
      // When tree-sitter keeps a single declaration but the init_declarator
      // has a conflicting ERROR identifier (macro misparsed as the name),
      // the ERROR child should be preferred.
      // Simulate with a pattern that produces this AST without 'extern'.
      const code = `
RRE_ATTRIBUTE_VISIBILITY VOS_UINT32 g_var = 0;
`;
      const result = extractFromSource('test5.c', code);

      // For this 2-macro + init case, Pattern A recovery kicks in from the
      // expression_statement. The variable should be found.
      const variable = result.nodes.find((n) => n.kind === 'variable'
        && n.name === 'g_var');
      expect(variable).toBeDefined();
    });

    it('regression: single macro before variable still works', () => {
      const code = `
VOS_UINT32 g_normalVar = 0;
`;
      const result = extractFromSource('normal_var.c', code);

      const variable = result.nodes.find((n) => n.kind === 'variable'
        && n.name === 'g_normalVar');
      expect(variable).toBeDefined();
    });

    it('regression: no macros before variable still works', () => {
      const code = `
int g_counter = 0;
`;
      const result = extractFromSource('int_var.c', code);

      const variable = result.nodes.find((n) => n.kind === 'variable'
        && n.name === 'g_counter');
      expect(variable).toBeDefined();
    });

    it('does not extract variables from expression_statement inside function body', () => {
      const code = `
void func(void) {
  int x = 1;
  x = 42;
}
`;
      const result = extractFromSource('func_body.c', code);

      // The assignment inside the function should NOT be extracted as a global
      const globalX = result.nodes.find((n) => n.kind === 'variable'
        && n.name === '42');
      expect(globalX).toBeUndefined();
    });
  });

  describe('C/C++ macro misparse filtering', () => {
    // Tree-sitter C/C++ parsers lack a preprocessor. When a macro invocation
    // has the shape MACRO_NAME(params) { body }, it matches the
    // function_definition grammar rule and produces a spurious function node
    // for each call site. The extractor collects `#define` names from
    // preproc_def / preproc_function_def nodes and filters out any "function"
    // whose name matches a known macro.

    it('filters FOREACH_X macro invocations (for-loop macro)', () => {
      const code = `
#define FOREACH_X(it, container, cond) \\
  for (auto it = (container).begin(); (cond) && (it != (container).end()); ++it)

void process() {
  FOREACH_X(it, items, true) {
    doWork(*it);
  }
}
`;
      const result = extractFromSource('test.cpp', code);
      const func = result.nodes.find((n) => n.kind === 'function' && n.name === 'FOREACH_X');
      expect(func).toBeUndefined();
      // The real function should still be extracted
      const realFunc = result.nodes.find((n) => n.kind === 'function' && n.name === 'process');
      expect(realFunc).toBeDefined();
    });

    it('filters ARRAY_FOREACH_NORET macro invocations', () => {
      const code = `
#define ARRAY_FOREACH_NORET(it, arr) \\
  for (int64_t it = 0; it < (arr).count(); ++it)

void scan() {
  ARRAY_FOREACH_NORET(i, table_array) {
    check(i);
  }
}
`;
      const result = extractFromSource('test.cpp', code);
      const func = result.nodes.find((n) => n.kind === 'function' && n.name === 'ARRAY_FOREACH_NORET');
      expect(func).toBeUndefined();
    });

    it('filters PS_DEFENSE_CHECK macro invocations (if-else macro)', () => {
      const code = `
#define PS_DEFENSE_CHECK(len)                              \\
  if (OB_FAIL(ret)) {                                       \\
  } else if (OB_FAIL(checker.detection(len))) {              \\
    LOG_WARN("out of bounds", K(ret));                      \\
  } else

void execute() {
  PS_DEFENSE_CHECK(length) {
    sql.assign_ptr(buf, length);
  }
}
`;
      const result = extractFromSource('test.cpp', code);
      const func = result.nodes.find((n) => n.kind === 'function' && n.name === 'PS_DEFENSE_CHECK');
      expect(func).toBeUndefined();
    });

    it('filters CREATE_WITH_TEMP_ENTITY macro invocations (for+if macro)', () => {
      const code = `
#define CREATE_WITH_TEMP_ENTITY(entity_type, ...) \\
  CREATE_WITH_TEMP_ENTITY_P(true, entity_type, __VA_ARGS__)

void worker() {
  CREATE_WITH_TEMP_ENTITY(RESOURCE_OWNER, tenant_id) {
    allocator.alloc();
  }
}
`;
      const result = extractFromSource('test.cpp', code);
      const func = result.nodes.find((n) => n.kind === 'function' && n.name === 'CREATE_WITH_TEMP_ENTITY');
      expect(func).toBeUndefined();
    });

    it('filters OB_SUCC macro invocation (boolean expression macro)', () => {
      const code = `
#define OB_SUCC(statement) \\
  (OB_LIKELY(::oceanbase::common::OB_SUCCESS == (ret = (statement))))

void check() {
  if OB_SUCC(ret) {
    doSomething();
  }
}
`;
      const result = extractFromSource('test.cpp', code);
      const func = result.nodes.find((n) => n.kind === 'function' && n.name === 'OB_SUCC');
      expect(func).toBeUndefined();
    });

    it('does not filter real functions that happen to match #define name keywords', () => {
      // "if", "for", "while" are not macro names — they're keywords.
      // If someone defines a macro named IF_DEBUG, it should be filtered,
      // but the keyword check should not accidentally filter it.
      const code = `
#define IF_DEBUG(code) if (debug_enabled) { code; }

void run() {
  IF_DEBUG(log("debug");) {
    // tree-sitter may misparse this as a function
  }
}
`;
      const result = extractFromSource('test.cpp', code);
      const func = result.nodes.find((n) => n.kind === 'function' && n.name === 'IF_DEBUG');
      expect(func).toBeUndefined();
      // "run" should still be found
      const realFunc = result.nodes.find((n) => n.kind === 'function' && n.name === 'run');
      expect(realFunc).toBeDefined();
    });

    it('does not filter real functions with non-macro ALL_CAPS names', () => {
      // A real function named in ALL_CAPS (unconventional but valid C)
      // should not be filtered just because some macros also use that style.
      const code = `
#define LOG_WARN(fmt, ...) fprintf(stderr, fmt, __VA_ARGS__)

int INNER_LOOP(int n) {
  return n * 2;
}
`;
      const result = extractFromSource('test.cpp', code);
      // INNER_LOOP is a real function, not a macro
      const func = result.nodes.find((n) => n.kind === 'function' && n.name === 'INNER_LOOP');
      expect(func).toBeDefined();
      // LOG_WARN is a macro and its invocations should not become functions
      const macroFunc = result.nodes.find((n) => n.kind === 'function' && n.name === 'LOG_WARN');
      expect(macroFunc).toBeUndefined();
    });

    it('filters cross-file macro invocations via globalMacroNames', () => {
      // Macro FOREACH_X is defined in another file (a header) and #included
      // here. Tree-sitter has no preprocessor, so the file's AST has no
      // #define for FOREACH_X — the globalMacroNames parameter carries it.
      const code = `
void foo() {
  FOREACH_X(it, items, true) {
    doWork(*it);
  }
}
`;
      const globalMacroNames = new Set(['FOREACH_X']);
      const result = extractFromSource('test.cpp', code, undefined, undefined, globalMacroNames);
      const func = result.nodes.find((n) => n.kind === 'function' && n.name === 'FOREACH_X');
      expect(func).toBeUndefined();
      // The real function should still be extracted
      const realFunc = result.nodes.find((n) => n.kind === 'function' && n.name === 'foo');
      expect(realFunc).toBeDefined();
    });

    it('filters cross-file macro misparsed as function declaration', () => {
      // When tree-sitter parses SWITCH(args) CASE(args) {body} as a
      // declaration with a function_declarator (not a function_definition),
      // the isMisparsedFunction check at the declaration path must still
      // filter it using globalMacroNames.
      const code = `
void process() {
  SWITCH(message->field)
  CASE(RESOURCE_NAME)
    if (cond) {
      doWork();
    }
}
`;
      const globalMacroNames = new Set(['SWITCH', 'CASE']);
      const result = extractFromSource('test.c', code, undefined, undefined, globalMacroNames);
      const switchFunc = result.nodes.find((n) => n.kind === 'function' && n.name === 'SWITCH');
      expect(switchFunc).toBeUndefined();
      const caseFunc = result.nodes.find((n) => n.kind === 'function' && n.name === 'CASE');
      expect(caseFunc).toBeUndefined();
      const realFunc = result.nodes.find((n) => n.kind === 'function' && n.name === 'process');
      expect(realFunc).toBeDefined();
    });

    it('keeps real function sharing a name with a cross-file #define wrapper macro', () => {
      // C debug wrapper pattern: a real function `TlmDynamicMemAlloc` and a
      // same-named `#define` that adds __FILE__/__LINE__ args. The #define
      // lives in a header (simulated via globalMacroNames); the .c file has
      // the real definition. The form check must keep both the function
      // definition and declaration — only the macro node should be filtered
      // as a function. Regression for commit d96678f which suppressed every
      // name matching a global macro.
      const code = `
void* TlmDynamicMemAlloc(int pid, int size);

void* TlmDynamicMemAlloc(int pid, int size) {
  return (void*)0;
}
`;
      const globalMacroNames = new Set(['TlmDynamicMemAlloc']);
      const result = extractFromSource('impl.c', code, undefined, undefined, globalMacroNames);
      const funcDef = result.nodes.find(
        (n) => n.kind === 'function' && n.name === 'TlmDynamicMemAlloc' && !n.isDeclaration
      );
      expect(funcDef).toBeDefined();
      const funcDecl = result.nodes.find(
        (n) => n.kind === 'function' && n.name === 'TlmDynamicMemAlloc' && n.isDeclaration
      );
      expect(funcDecl).toBeDefined();
    });

    it('keeps real function sharing a name with a same-file #define wrapper macro', () => {
      // Same wrapper-macro pattern but the #define is in the same file as
      // the real function (fileMacroNames path, not globalMacroNames).
      const code = `
#define TlmDynamicMemAlloc(pid, size) \\
  TlmDynamicMemAlloc((pid), (size), __FILE__, __LINE__)

void* TlmDynamicMemAlloc(int pid, int size, const char* file, int line) {
  return (void*)0;
}
`;
      const result = extractFromSource('impl.c', code);
      const funcDef = result.nodes.find(
        (n) => n.kind === 'function' && n.name === 'TlmDynamicMemAlloc'
      );
      expect(funcDef).toBeDefined();
      const macroNode = result.nodes.find(
        (n) => n.kind === 'macro' && n.name === 'TlmDynamicMemAlloc'
      );
      expect(macroNode).toBeDefined();
    });

    it('does not regress the e7ef006 multi-prefix form when name is in macroNames', () => {
      // `RRE_ATTRIBUTE_VISIBILITY VOS_UINT32 normalFunc(VOS_VOID){}` — with
      // 2+ unrecognized macro prefixes tree-sitter produces a real function
      // node (declarator wrapped in parenthesized_declarator) carrying a real
      // return type. Even when normalFunc is in macroNames, the form check
      // must keep it: the type field holds a real type, not the function name.
      const code = `
RRE_ATTRIBUTE_VISIBILITY VOS_UINT32 normalFunc(VOS_VOID) {
  return 0;
}
`;
      const globalMacroNames = new Set(['normalFunc', 'RRE_ATTRIBUTE_VISIBILITY', 'VOS_UINT32']);
      const result = extractFromSource('test.cpp', code, undefined, undefined, globalMacroNames);
      const func = result.nodes.find((n) => n.kind === 'function' && n.name === 'normalFunc');
      expect(func).toBeDefined();
    });
  });

  describe('C/C++ statement-level macro preParse (SWITCH/CASE/DEFAULT/END)', () => {
    // open5gs defines statement-level macros SWITCH/CASE/DEFAULT/END in
    // lib/core/ogs-macros.h that expand to brace-balanced code WITHOUT a
    // trailing semicolon. Tree-sitter's C/C++ grammars lack a preprocessor,
    // so a bare `SWITCH(x)` triggers error recovery and eventually closes the
    // enclosing compound_statement early, dropping every subsequent call
    // into the translation_unit. preParse rewrites these invocations to
    // `0;` (length-preserving) before parsing so the body stays open.
    it('keeps all calls inside a SWITCH/CASE/DEFAULT/END body attributed to the enclosing function', () => {
      const code = `
int handle(oid_t id) {
  int rv = 0;
  SWITCH(id)
  CASE(RESOURCE_A)
    parse_a();
    rv = 1;
    break;
  CASE(RESOURCE_B)
    parse_b();
    add_client();
    rv = 2;
    break;
  DEFAULT
    ogs_error("unknown");
    rv = -1;
    break;
  END
  return rv;
}
`;
      const globalMacroNames = new Set(['SWITCH', 'CASE', 'DEFAULT', 'END', 'RESOURCE_A', 'RESOURCE_B']);
      const result = extractFromSource('test.c', code, undefined, undefined, globalMacroNames);
      const fn = result.nodes.find((n) => n.kind === 'function' && n.name === 'handle');
      expect(fn).toBeDefined();
      // All four case-body calls must appear as callees of handle().
      const callees = result.unresolvedReferences
        .filter((r) => r.fromNodeId === fn!.id && r.referenceKind === 'calls')
        .map((r) => r.referenceName);
      expect(callees).toContain('parse_a');
      expect(callees).toContain('parse_b');
      expect(callees).toContain('add_client');
      expect(callees).toContain('ogs_error');
    });

    it('does not replace macro calls that have a trailing semicolon', () => {
      // SWITCH(x); has a `;` → tree-sitter already parses it as a normal
      // call_expression; preParse must leave it untouched.
      const code = `
int f() {
  SWITCH(x);
  return 0;
}
`;
      const globalMacroNames = new Set(['SWITCH']);
      const result = extractFromSource('test.c', code, undefined, undefined, globalMacroNames);
      const fn = result.nodes.find((n) => n.kind === 'function' && n.name === 'f');
      expect(fn).toBeDefined();
      // SWITCH must appear as a callee (it was not blanked to `0;`).
      const callees = result.unresolvedReferences
        .filter((r) => r.fromNodeId === fn!.id && r.referenceKind === 'calls')
        .map((r) => r.referenceName);
      expect(callees).toContain('SWITCH');
    });

    it('does not replace MACRO(params) { body } (isMisparsedFunction pattern)', () => {
      // When a macro invocation is followed by `{`, the existing
      // isMisparsedFunction mechanism handles it; preParse must NOT blank
      // it (doing so would break the `{ body }` association).
      const code = `
void g() {
  FOREACH_X(items)
  {
    process_item();
  }
}
`;
      const globalMacroNames = new Set(['FOREACH_X']);
      const result = extractFromSource('test.c', code, undefined, undefined, globalMacroNames);
      // FOREACH_X must still be filtered as a misparsed function, and the
      // real function g must survive with its body call attributed.
      const forEachFunc = result.nodes.find((n) => n.kind === 'function' && n.name === 'FOREACH_X');
      expect(forEachFunc).toBeUndefined();
      const g = result.nodes.find((n) => n.kind === 'function' && n.name === 'g');
      expect(g).toBeDefined();
      const callees = result.unresolvedReferences
        .filter((r) => r.fromNodeId === g!.id && r.referenceKind === 'calls')
        .map((r) => r.referenceName);
      expect(callees).toContain('process_item');
    });

    it('does not touch macro constants used as call arguments (paren depth > 0)', () => {
      // RESOURCE_A appears inside CASE(...) at paren depth 1 — preParse
      // must not blank it. (It's not in the macro set's "statement-like"
      // position so even if it were in macroNames it should be left alone.)
      const code = `
int h() {
  CASE(RESOURCE_A)
    do_work();
    break;
  END
  return 0;
}
`;
      const globalMacroNames = new Set(['CASE', 'END', 'RESOURCE_A']);
      const result = extractFromSource('test.c', code, undefined, undefined, globalMacroNames);
      const fn = result.nodes.find((n) => n.kind === 'function' && n.name === 'h');
      expect(fn).toBeDefined();
      const callees = result.unresolvedReferences
        .filter((r) => r.fromNodeId === fn!.id && r.referenceKind === 'calls')
        .map((r) => r.referenceName);
      expect(callees).toContain('do_work');
    });

    it('leaves string literals, comments, and preprocessor directives untouched', () => {
      // The text "SWITCH(x)" inside a string, comment, and #define must
      // NOT be blanked. preParse only rewrites statement-level macro
      // invocations at paren depth 0 outside strings/comments/directives.
      const code = `
#define MSG "SWITCH(x) is a macro"
/* CASE(foo) in a comment */
void k() {
  const char *s = "END is here";
  SWITCH(x)
  CASE(y)
    real_call();
    break;
  END
}
`;
      const globalMacroNames = new Set(['SWITCH', 'CASE', 'END']);
      const result = extractFromSource('test.c', code, undefined, undefined, globalMacroNames);
      const fn = result.nodes.find((n) => n.kind === 'function' && n.name === 'k');
      expect(fn).toBeDefined();
      const callees = result.unresolvedReferences
        .filter((r) => r.fromNodeId === fn!.id && r.referenceKind === 'calls')
        .map((r) => r.referenceName);
      expect(callees).toContain('real_call');
      // The macro definition must still be extracted from the #define line
      // (proves the preprocessor directive was copied verbatim, not blanked).
      const macro = result.nodes.find((n) => n.kind === 'macro' && n.name === 'MSG');
      expect(macro).toBeDefined();
    });
  });

  describe('C function declaration isDeclaration flag', () => {
    it('marks a header prototype as isDeclaration=true', () => {
      // `int add(int a, int b);` is a function_declarator inside a
      // declaration (no body) — must be flagged isDeclaration=true so
      // cDeclDefEdges pairs it with the .c definition without relying
      // on the buggy endLine>startLine heuristic.
      const result = extractFromSource('foo.h', 'int add(int a, int b);\n');
      const fn = result.nodes.find((n) => n.kind === 'function' && n.name === 'add');
      expect(fn).toBeDefined();
      expect(fn!.isDeclaration).toBe(true);
    });

    it('leaves a function definition (with body) unflagged', () => {
      // `int add(int a, int b) { ... }` is a function_definition with a
      // body — isDeclaration must be unset (falsy) so cDeclDefEdges treats
      // it as the definition side of the pair.
      const result = extractFromSource(
        'foo.c',
        'int add(int a, int b) {\n  return a + b;\n}\n'
      );
      const fn = result.nodes.find((n) => n.kind === 'function' && n.name === 'add');
      expect(fn).toBeDefined();
      expect(fn!.isDeclaration).toBeFalsy();
    });

    it('marks a multi-line prototype as isDeclaration regardless of line span', () => {
      // A prototype that wraps its parameter list across multiple lines
      // — the exact case the old endLine>startLine heuristic misclassified
      // as a definition. The flag is set from the AST shape (declaration
      // node containing a function_declarator), not from line counting.
      const result = extractFromSource(
        'multi.h',
        'void draw(\n    int x,\n    int y);\n'
      );
      const fn = result.nodes.find((n) => n.kind === 'function' && n.name === 'draw');
      expect(fn).toBeDefined();
      expect(fn!.isDeclaration).toBe(true);
      // The prototype spans 3 lines — this is what tripped the old heuristic.
      expect(fn!.endLine).toBeGreaterThan(fn!.startLine);
    });
  });

  describe('C++ class member function declaration isDeclaration flag', () => {
    it('marks a class-internal member function declaration as isDeclaration=true', () => {
      // `void foo();` inside a class body is parsed by tree-sitter-cpp as a
      // field_declaration with a function_declarator. Must be flagged
      // isDeclaration=true so cppDeclDefEdges pairs it with the out-of-line
      // .cpp definition (and so codegraph_search shows it as a declaration).
      const result = extractFromSource(
        'foo.h',
        'class Foo {\npublic:\n  void bar();\n};\n'
      );
      const m = result.nodes.find((n) => n.kind === 'method' && n.name === 'bar');
      expect(m).toBeDefined();
      expect(m!.isDeclaration).toBe(true);
    });

    it('leaves an out-of-line .cpp method definition unflagged', () => {
      // The matching .cpp definition `void Foo::bar() { ... }` is a
      // function_definition and must leave isDeclaration falsy so it is the
      // definition side of the cppDeclDefEdges pair.
      const result = extractFromSource(
        'foo.cpp',
        'void Foo::bar() {\n  // body\n}\n'
      );
      const m = result.nodes.find((n) => n.kind === 'method' && n.name === 'bar');
      expect(m).toBeDefined();
      expect(m!.isDeclaration).toBeFalsy();
    });

    it('marks a multi-line class member declaration regardless of line span', () => {
      // The exact case the old endLine>startLine heuristic misclassified:
      // a class member declaration whose parameter list wraps across lines
      // would look like a definition. The flag is set from the AST shape
      // (field_declaration + function_declarator), not line counting.
      const result = extractFromSource(
        'foo.h',
        'class Foo {\npublic:\n  void bar(\n      int a,\n      int b);\n};\n'
      );
      const m = result.nodes.find((n) => n.kind === 'method' && n.name === 'bar');
      expect(m).toBeDefined();
      expect(m!.isDeclaration).toBe(true);
      // Declaration spans 4 lines — this is what tripped the old heuristic.
      expect(m!.endLine).toBeGreaterThan(m!.startLine);
    });
  });

  describe('C++ parser recovery regressions', () => {
    it('does not let project-wide macro collisions rewrite final or class bodies', () => {
      const code = `
class VCL_DLLPUBLIC Job final {
public:
  Job();
  ~Job();
  void SAL_CALL run();
private:
  int value_;
};
`;
      // `final` simulates an unrelated lower-case macro from a C-only utility.
      const projectMacros = new Set(['final', 'VCL_DLLPUBLIC', 'SAL_CALL']);
      const result = extractFromSource('job.hpp', code, undefined, undefined, projectMacros);

      const cls = result.nodes.find((n) => n.kind === 'class' && n.name === 'Job');
      expect(cls).toBeDefined();
      expect(result.nodes.some((n) => n.name === 'final')).toBe(false);
      expect(result.nodes.some((n) => n.kind === 'field' && n.name === 'value_')).toBe(true);
      expect(result.nodes.some((n) => n.kind === 'method' && n.name === 'run')).toBe(true);
    });

    it('extracts constructor and destructor declarations as methods', () => {
      const result = extractFromSource(
        'renderer.hpp',
        'class GridTableRenderer {\npublic:\n  GridTableRenderer(int);\n  ~GridTableRenderer();\n};\n'
      );
      const ctor = result.nodes.find((n) => n.kind === 'method' && n.name === 'GridTableRenderer');
      const dtor = result.nodes.find((n) => n.kind === 'method' && n.name === '~GridTableRenderer');
      expect(ctor?.isDeclaration).toBe(true);
      expect(dtor?.isDeclaration).toBe(true);
      expect(ctor?.qualifiedName).toBe('GridTableRenderer::GridTableRenderer');
      expect(dtor?.qualifiedName).toBe('GridTableRenderer::~GridTableRenderer');
    });

    it('preserves qualified nested type definitions and scopes their members', () => {
      const result = extractFromSource(
        'parser.cpp',
        'class XSecParser { public: class Context; };\nclass XSecParser::Context { public: void parse(); int state_; };\n'
      );
      const contextDef = result.nodes.find(
        (n) => n.kind === 'class' && n.name === 'Context' && !n.isDeclaration
      );
      expect(contextDef?.qualifiedName).toBe('XSecParser::Context');
      expect(result.nodes.find((n) => n.kind === 'method' && n.name === 'parse')?.qualifiedName)
        .toBe('XSecParser::Context::parse');
      expect(result.nodes.find((n) => n.kind === 'field' && n.name === 'state_')?.qualifiedName)
        .toBe('XSecParser::Context::state_');
    });

    it('indexes explicit type forwards but not elaborated type uses', () => {
      const result = extractFromSource(
        'types.hpp',
        'class Widget;\nstruct State;\nenum class IOErrorCode;\nvoid consume(struct Payload*);\n'
      );
      expect(result.nodes.find((n) => n.kind === 'class' && n.name === 'Widget')?.isDeclaration).toBe(true);
      expect(result.nodes.find((n) => n.kind === 'struct' && n.name === 'State')?.isDeclaration).toBe(true);
      expect(result.nodes.find((n) => n.kind === 'enum' && n.name === 'IOErrorCode')?.isDeclaration).toBe(true);
      expect(result.nodes.some((n) => n.name === 'Payload' && (n.kind === 'struct' || n.kind === 'class'))).toBe(false);
    });

    it('indexes forward declarations inside nested namespaces', () => {
      const result = extractFromSource(
        'namespaced-types.hpp',
        'namespace com::sun::star::ucb { enum class IOErrorCode; }\n' +
        'namespace com::sun::star { namespace uno { class Any; } }\n'
      );
      const error = result.nodes.find((n) => n.kind === 'enum' && n.name === 'IOErrorCode');
      const any = result.nodes.find((n) => n.kind === 'class' && n.name === 'Any');
      expect(error?.isDeclaration).toBe(true);
      expect(error?.qualifiedName).toBe('com::sun::star::ucb::IOErrorCode');
      expect(any?.isDeclaration).toBe(true);
      expect(any?.qualifiedName).toBe('com::sun::star::uno::Any');
    });

    it('indexes explicit type forwards inside preprocessor conditionals', () => {
      const code = `
#ifndef PROJECT_TYPES_HPP
#define PROJECT_TYPES_HPP
class GuardedClass;
struct GuardedStruct;
enum class GuardedEnum : unsigned int;
#if FEATURE_ENABLED
class FeatureClass;
#else
struct FallbackStruct;
#endif
void consume(struct ElaboratedOnly* value);
#endif
`;
      const result = extractFromSource('guarded-types.hpp', code);
      for (const [kind, name] of [
        ['class', 'GuardedClass'],
        ['struct', 'GuardedStruct'],
        ['enum', 'GuardedEnum'],
        ['class', 'FeatureClass'],
        ['struct', 'FallbackStruct'],
      ] as const) {
        expect(result.nodes.find((n) => n.kind === kind && n.name === name)?.isDeclaration).toBe(true);
      }
      expect(result.nodes.some((n) => n.name === 'ElaboratedOnly'
        && (n.kind === 'class' || n.kind === 'struct'))).toBe(false);
    });

    it('recovers unknown function-like modifier macros in class heads', () => {
      const code = `
class UNLESS_MERGELIBS(API_EXPORT) Widget final {
public:
  Widget();
  int value_;
};
class [[nodiscard]] AttributedWidget {
  int attributedValue_;
};
`;
      // The modifier itself is deliberately absent: generated macro definitions
      // are not always available to the project-wide macro scan.
      const result = extractFromSource('widget.hpp', code, undefined, undefined, new Set(['UNRELATED_MACRO']));
      expect(result.nodes.some((n) => n.kind === 'class' && n.name === 'Widget')).toBe(true);
      expect(result.nodes.some((n) => n.kind === 'method' && n.name === 'Widget')).toBe(true);
      expect(result.nodes.some((n) => n.kind === 'field' && n.name === 'value_')).toBe(true);
      expect(result.nodes.some((n) => n.kind === 'class' && n.name === 'AttributedWidget')).toBe(true);
      expect(result.nodes.some((n) => n.kind === 'field' && n.name === 'attributedValue_')).toBe(true);
      expect(result.nodes.some((n) => n.name === 'final')).toBe(false);
    });

    it('treats SAL_NOEXCEPT as a declaration modifier', () => {
      const code = `
template<typename... Ifc>
class SAL_NO_VTABLE SAL_DLLPUBLIC_TEMPLATE Impl : public Ifc... {
public:
  void SAL_CALL acquire() SAL_NOEXCEPT override {}
};
`;
      const macros = new Set(['SAL_CALL', 'SAL_NOEXCEPT', 'SAL_NO_VTABLE', 'SAL_DLLPUBLIC_TEMPLATE']);
      const result = extractFromSource('impl.hpp', code, undefined, undefined, macros);
      expect(result.nodes.filter((n) => n.kind === 'method' && n.name === 'acquire')).toHaveLength(1);
      expect(result.nodes.some((n) => n.name === 'override')).toBe(false);
    });

    it('preserves a trailing-return method that collides with a macro elsewhere', () => {
      const code = `
class Session {
public:
  virtual auto PUT(int value) -> void override;
};
`;
      const result = extractFromSource('session.hpp', code, undefined, undefined, new Set(['PUT']));
      const put = result.nodes.find((n) => n.kind === 'method' && n.name === 'PUT');
      expect(put?.isDeclaration).toBe(true);
      expect(result.nodes.some((n) => n.name === 'override')).toBe(false);
    });

    it('keeps declaration scope through class heads longer than the look-behind window', () => {
      const bases = Array.from({ length: 60 }, (_, i) => `public VeryLongGeneratedBaseName${i}`).join(',\n');
      const code = `
class Model :
${bases}
{
public:
  void SAL_CALL acquire() SAL_NOEXCEPT override {}
};
`;
      expect(code.indexOf('{') - code.indexOf('class')).toBeGreaterThan(512);
      const macros = new Set(['SAL_CALL', 'SAL_NOEXCEPT']);
      const result = extractFromSource('model.hpp', code, undefined, undefined, macros);
      expect(result.nodes.some((n) => n.kind === 'class' && n.name === 'Model')).toBe(true);
      expect(result.nodes.filter((n) => n.kind === 'method' && n.name === 'acquire')).toHaveLength(1);
      expect(result.nodes.some((n) => n.name === 'override')).toBe(false);
    });

    it('keeps split conditional declarations inside their class', () => {
      const code = `
class WARN_UNUSED DLL_PUBLIC ConditionalValue {
public:
#if HAVE_CONSTEXPR
  constexpr
#endif
  ConditionalValue() {
#if HAVE_RUNTIME_CHECK
    if (value_ > 0) {}
    else
#endif
      value_ = 1;
  }
#if HAVE_EXTRA_MEMBER
  void extra();
#else
  void fallback();
#endif
  int value_;
};
class FollowingType {};
`;
      const result = extractFromSource('conditional-value.hpp', code);
      expect(result.nodes.some((n) => n.kind === 'class' && n.name === 'ConditionalValue')).toBe(true);
      expect(result.nodes.some((n) => n.kind === 'method' && n.name === 'ConditionalValue')).toBe(true);
      expect(result.nodes.some((n) => n.kind === 'method' && n.name === 'extra')).toBe(true);
      expect(result.nodes.some((n) => n.kind === 'method' && n.name === 'fallback')).toBe(true);
      expect(result.nodes.some((n) => n.kind === 'field' && n.name === 'value_')).toBe(true);
      expect(result.nodes.some((n) => n.kind === 'class' && n.name === 'FollowingType')).toBe(true);
    });

    it('recovers following declarations after member comparisons in operator less-than', () => {
      const code = `
struct Position { int row; int column; };
inline bool operator<(const Position& left, const Position& right) {
  return (left.row < right.row)
      || ((left.row == right.row) && (left.column < right.column));
}
class FirstFollowingType {};
class SecondFollowingType {};
`;
      const result = extractFromSource('ordered-position.hpp', code);
      expect(result.nodes.some((n) => n.kind === 'function' && n.name.includes('operator'))).toBe(true);
      expect(result.nodes.some((n) => n.kind === 'class' && n.name === 'FirstFollowingType')).toBe(true);
      expect(result.nodes.some((n) => n.kind === 'class' && n.name === 'SecondFollowingType')).toBe(true);
    });

    it('does not rewrite a member template call inside operator less-than', () => {
      const code = `
struct Value {
  template<typename T> T convert() const;
};
inline bool operator<(const Value& left, const Value& right) {
  return left.convert<int>() < right.convert<int>();
}
class TypeAfterTemplateComparison {};
`;
      const result = extractFromSource('templated-order.hpp', code);
      const transformed = cppExtractor.preParse!(code);
      expect(transformed).toContain('left.convert<int>()');
      expect(transformed).toContain('right.convert<int>()');
      expect(result.nodes.some((n) => n.kind === 'class' && n.name === 'TypeAfterTemplateComparison')).toBe(true);
    });

    it('extracts a type definition used directly as a function return type', () => {
      const code = `
struct InlineRecord { int value; } makeRecord() { return {}; }
`;
      const result = extractFromSource('inline-record.cpp', code);
      expect(result.nodes.some((n) => n.kind === 'struct' && n.name === 'InlineRecord')).toBe(true);
      expect(result.nodes.some((n) => n.kind === 'function' && n.name === 'makeRecord')).toBe(true);
    });
  });

  describe('C/C++ macro extraction', () => {
    it('extracts object-like macro (simple constant)', () => {
      const code = `#define FOO 42\n`;
      const result = extractFromSource('test.c', code);

      const macro = result.nodes.find((n) => n.kind === 'macro' && n.name === 'FOO');
      expect(macro).toBeDefined();
      expect(macro?.kind).toBe('macro');
      expect(macro?.name).toBe('FOO');
      expect(macro?.signature).toContain('#define FOO 42');
      expect(macro?.isExported).toBe(true);
    });

    it('extracts function-like macro', () => {
      const code = `#define MAX(a,b) ((a)>(b)?(a):(b))\n`;
      const result = extractFromSource('test.c', code);

      const macro = result.nodes.find((n) => n.kind === 'macro' && n.name === 'MAX');
      expect(macro).toBeDefined();
      expect(macro?.signature).toContain('#define MAX(a,b)');
    });

    it('extracts multi-line macro with backslash continuation', () => {
      const code = `#define FOREACH_X(it, container, cond) \\
  for (auto it = (container).begin(); (cond) && (it != (container).end()); ++it)
`;
      const result = extractFromSource('test.cpp', code);

      const macro = result.nodes.find((n) => n.kind === 'macro' && n.name === 'FOREACH_X');
      expect(macro).toBeDefined();
      expect(macro?.signature).toContain('\\');
    });

    it('preserves multi-line macro body with CRLF line continuation', () => {
      // Regression: on CRLF files, the backslash before \r\n was not
      // recognized as a line continuation — the continuation line was
      // split from the #directive and its macro invocations (CK_0 here)
      // were replaced with `0;`, corrupting the macro body.
      // globalMacroNames is required so preprocessStatementMacros runs.
      const code = '#define CK_0(x, y) x y\r\n' +
                   '#define CK_1(a1) \\\r\n' +
                   '  CK_0(#a1, a1)\r\n';
      const macroNames = new Set(['CK_0', 'CK_1']);
      const result = extractFromSource('test.c', code, undefined, undefined, macroNames);

      const ck1 = result.nodes.find((n) => n.kind === 'macro' && n.name === 'CK_1');
      expect(ck1).toBeDefined();
      expect(ck1?.signature).toContain('CK_0(#a1, a1)');
      expect(ck1?.signature).not.toContain('0;');
    });

    it('extracts macro inside #ifdef conditional', () => {
      const code = `
#ifdef DEBUG
#define LOG_LEVEL 3
#endif
`;
      const result = extractFromSource('test.c', code);

      const macro = result.nodes.find((n) => n.kind === 'macro' && n.name === 'LOG_LEVEL');
      expect(macro).toBeDefined();
    });

    it('extracts multiple macros from a single file', () => {
      const code = `#define PI 3.14159\n#define SQUARE(x) ((x)*(x))\n`;
      const result = extractFromSource('math.c', code);

      const macros = result.nodes.filter((n) => n.kind === 'macro');
      expect(macros.length).toBe(2);
      expect(macros.map(m => m.name).sort()).toEqual(['PI', 'SQUARE']);
    });

    it('still filters macro invocations as misparsed functions (no regression)', () => {
      const code = `
#define FOREACH_X(it, container, cond) \\
  for (auto it = (container).begin(); (cond) && (it != (container).end()); ++it)

void process() {
  FOREACH_X(it, items, true) {
    doWork(*it);
  }
}
`;
      const result = extractFromSource('test.cpp', code);

      // Macro node should exist (new behavior)
      const macro = result.nodes.find((n) => n.kind === 'macro' && n.name === 'FOREACH_X');
      expect(macro).toBeDefined();

      // Macro should NOT appear as a function (existing behavior preserved)
      const func = result.nodes.find((n) => n.kind === 'function' && n.name === 'FOREACH_X');
      expect(func).toBeUndefined();

      // The real function should still be extracted
      const realFunc = result.nodes.find((n) => n.kind === 'function' && n.name === 'process');
      expect(realFunc).toBeDefined();
    });
  });

  describe('C/C++ imports', () => {
    it('should extract system include', () => {
      const code = `#include <iostream>`;
      const result = extractFromSource('main.cpp', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('iostream');
      expect(importNode?.signature).toBe('#include <iostream>');
    });

    it('should extract system include with path', () => {
      const code = `#include <nlohmann/json.hpp>`;
      const result = extractFromSource('app.cpp', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('nlohmann/json.hpp');
    });

    it('should extract local include', () => {
      const code = `#include "myheader.h"`;
      const result = extractFromSource('main.cpp', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('myheader.h');
    });

    it('should extract C header', () => {
      const code = `#include <stdio.h>`;
      const result = extractFromSource('main.c', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('stdio.h');
    });

    it('should extract multiple includes', () => {
      const code = `
#include <iostream>
#include <vector>
#include "config.h"
`;
      const result = extractFromSource('app.cpp', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('iostream');
      expect(names).toContain('vector');
      expect(names).toContain('config.h');
    });

    it('should create unresolved references for local includes', () => {
      const code = `#include "myheader.h"`;
      const result = extractFromSource('main.cpp', code);

      const importRef = result.unresolvedReferences.find(
        (r) => r.referenceKind === 'imports' && r.referenceName === 'myheader.h'
      );
      expect(importRef).toBeDefined();
      expect(importRef?.line).toBe(1);
    });

    it('should create unresolved references for system includes', () => {
      const code = `#include <iostream>`;
      const result = extractFromSource('main.cpp', code);

      const importRef = result.unresolvedReferences.find(
        (r) => r.referenceKind === 'imports' && r.referenceName === 'iostream'
      );
      expect(importRef).toBeDefined();
    });
  });

  describe('C/C++ variable extraction', () => {
    it('extracts a global int variable', () => {
      const result = extractFromSource('foo.c', 'int g_counter = 0;');
      const varNode = result.nodes.find(n => n.kind === 'variable' && n.name === 'g_counter');
      expect(varNode).toBeDefined();
      expect(varNode?.signature).toBe('= 0');
      expect(varNode?.isExported).toBe(true);
    });

    it('extracts a static int variable as non-exported', () => {
      const result = extractFromSource('foo.c', 'static int s_counter = 0;');
      const varNode = result.nodes.find(n => n.kind === 'variable' && n.name === 's_counter');
      expect(varNode).toBeDefined();
      expect(varNode?.isExported).toBe(false);
    });

    it('extracts a const int as constant', () => {
      const result = extractFromSource('foo.c', 'const int MAX = 100;');
      const constNode = result.nodes.find(n => n.kind === 'constant' && n.name === 'MAX');
      expect(constNode).toBeDefined();
    });

    it('extracts multi-declarator variables', () => {
      const result = extractFromSource('foo.c', 'int x, y, z;');
      expect(result.nodes.find(n => n.kind === 'variable' && n.name === 'x')).toBeDefined();
      expect(result.nodes.find(n => n.kind === 'variable' && n.name === 'y')).toBeDefined();
      expect(result.nodes.find(n => n.kind === 'variable' && n.name === 'z')).toBeDefined();
    });

    it('extracts pointer variable', () => {
      const result = extractFromSource('foo.c', 'int *ptr = 0;');
      const varNode = result.nodes.find(n => n.kind === 'variable' && n.name === 'ptr');
      expect(varNode).toBeDefined();
    });

    it('skips forward function declaration', () => {
      const result = extractFromSource('foo.c', 'int forwardDeclared(int a, int b);');
      const varNode = result.nodes.find(n => n.kind === 'variable');
      expect(varNode).toBeUndefined();
    });

    it('extracts extern declaration as a declaration node', () => {
      const result = extractFromSource('foo.h', 'extern int g_barcode;');
      const varNode = result.nodes.find(n => n.kind === 'variable');
      expect(varNode).toBeDefined();
      // A bodiless `extern` declaration is kept as a declaration node (the
      // definition lives elsewhere); the header↔.c pair is bridged by a
      // `defines` edge at resolution time. Previously skipped entirely, which
      // lost the symbol when the definition file wasn't indexed.
      expect(varNode!.isDeclaration).toBe(true);
    });

    it('extracts extern definition with initializer as a definition', () => {
      // `extern T g_x = ...;` is a definition in C, not a declaration.
      const result = extractFromSource('foo.c', 'extern int g_barcode = 5;');
      const varNode = result.nodes.find(n => n.kind === 'variable' && n.name === 'g_barcode');
      expect(varNode).toBeDefined();
      expect(varNode!.isDeclaration).not.toBe(true);
    });

    it('does not extract local variable inside function', () => {
      const result = extractFromSource('foo.c', 'void foo() { int local = 5; }');
      const varNode = result.nodes.find(n => n.kind === 'variable' && n.name === 'local');
      expect(varNode).toBeUndefined();
    });
  });

  describe('C/C++ struct/class field extraction', () => {
    it('extracts struct fields', () => {
      const result = extractFromSource('foo.c', 'struct S { int id; char name[32]; };');
      expect(result.nodes.find(n => n.kind === 'field' && n.name === 'id')).toBeDefined();
      expect(result.nodes.find(n => n.kind === 'field' && n.name === 'name')).toBeDefined();
    });

    it('extracts pointer fields', () => {
      const result = extractFromSource('foo.c', 'struct S { int *data; };');
      expect(result.nodes.find(n => n.kind === 'field' && n.name === 'data')).toBeDefined();
    });

    it('extracts C++ class member fields', () => {
      const result = extractFromSource('foo.cpp', 'class Widget { int m_width; int *m_data; };');
      expect(result.nodes.find(n => n.kind === 'field' && n.name === 'm_width')).toBeDefined();
      expect(result.nodes.find(n => n.kind === 'field' && n.name === 'm_data')).toBeDefined();
    });
  });

  describe('C/C++ X-macro struct/enum rescue (field_declaration leak)', () => {
    // Fixture: a 502-line slice of libuv's uv.h (lines 940-1441) that triggers
    // the X-macro leak — `struct uv_timer_s { UV_HANDLE_FIELDS UV_TIMER_PRIVATE_FIELDS };`
    // leaves tree-sitter-c unable to close the field_declaration_list, so ERROR
    // recovery folds the following ~470 lines of top-level declarations into one
    // giant field_declaration wrapping a struct_specifier. The swallowed content
    // includes 14 plain struct definitions, 1 plain enum (uv_process_flags), and
    // many function prototypes. Without the rescue, only the functions surface
    // (via extractNestedStructFunctions); the structs/enums vanish entirely.
    const fixturePath = path.join(__dirname, 'fixtures', 'uv-xmacro.c');

    it('rescues swallowed struct definitions from the X-macro leak', () => {
      const code = fs.readFileSync(fixturePath, 'utf8');
      const result = extractFromSource('uv-xmacro.c', code);
      const structs = result.nodes.filter(n => n.kind === 'struct').map(n => n.name);
      // Sample of the 14 swallowed structs — each was completely absent before.
      for (const name of [
        'uv_getaddrinfo_s', 'uv_getnameinfo_s', 'uv_process_s', 'uv_work_s',
        'uv_cpu_info_s', 'uv_passwd_s', 'uv_group_s', 'uv_metrics_s',
      ]) {
        expect(structs).toContain(name);
      }
    });

    it('rescues the swallowed uv_process_flags enum and its members', () => {
      const code = fs.readFileSync(fixturePath, 'utf8');
      const result = extractFromSource('uv-xmacro.c', code);
      expect(result.nodes.find(n => n.kind === 'enum' && n.name === 'uv_process_flags'))
        .toBeDefined();
      // The rescued enum's members are extracted via extractEnum's body walk.
      expect(result.nodes.find(n => n.kind === 'enum_member' && n.name === 'UV_PROCESS_SETUID'))
        .toBeDefined();
      expect(result.nodes.find(n => n.kind === 'enum_member' && n.name === 'UV_PROCESS_DETACHED'))
        .toBeDefined();
    });

    it('still rescues swallowed function prototypes (no regression)', () => {
      const code = fs.readFileSync(fixturePath, 'utf8');
      const result = extractFromSource('uv-xmacro.c', code);
      // Functions are rescued by the pre-existing extractNestedStructFunctions;
      // verify they still surface alongside the newly rescued structs/enums.
      expect(result.nodes.find(n => n.kind === 'function' && n.name === 'uv_timer_init'))
        .toBeDefined();
      expect(result.nodes.find(n => n.kind === 'function' && n.name === 'uv_async_send'))
        .toBeDefined();
    });
  });

  describe('C/C++ global variable reference tracking', () => {
    it('emits references edge for global variable read in same file', () => {
      const result = extractFromSource('foo.c', 'int g_counter = 0;\nint get(void) { return g_counter; }');
      const refs = result.unresolvedReferences.filter(
        r => r.referenceKind === 'references' && r.referenceName === 'g_counter'
      );
      expect(refs.length).toBe(1);
    });

    it('emits references edge for global variable write in same file', () => {
      const result = extractFromSource('foo.c', 'int g_counter = 0;\nvoid set(int v) { g_counter = v; }');
      const refs = result.unresolvedReferences.filter(
        r => r.referenceKind === 'references' && r.referenceName === 'g_counter'
      );
      expect(refs.length).toBe(1);
    });

    it('does NOT emit references edge for local variable', () => {
      const result = extractFromSource('foo.c', 'int g_var = 0;\nvoid test(void) { int g_var; g_var = 5; }');
      const refs = result.unresolvedReferences.filter(
        r => r.referenceKind === 'references' && r.referenceName === 'g_var'
      );
      expect(refs.length).toBe(0);
    });

    it('does NOT emit references edge for parameter that shadows global', () => {
      const result = extractFromSource('foo.c', 'int g_val = 0;\nvoid set(int g_val) { g_val = 42; }');
      const refs = result.unresolvedReferences.filter(
        r => r.referenceKind === 'references' && r.referenceName === 'g_val'
      );
      expect(refs.length).toBe(0);
    });

    it('does NOT emit references edge for callee inside call_expression', () => {
      const result = extractFromSource('foo.c', 'void helper(void) {}\nvoid caller(void) { helper(); }');
      const refs = result.unresolvedReferences.filter(
        r => r.referenceKind === 'references' && r.referenceName === 'helper'
      );
      expect(refs.length).toBe(0);
    });

    it('emits references for global, not for shadowed local, in mixed function', () => {
      const result = extractFromSource('foo.c', 'int g_x = 0;\nvoid foo(void) { int g_x; g_x = 1; }\nvoid bar(void) { g_x = 2; }');
      const refs = result.unresolvedReferences.filter(
        r => r.referenceKind === 'references' && r.referenceName === 'g_x'
      );
      expect(refs.length).toBe(1); // only bar, not foo
    });

    it('preserves local names across nested function extraction', () => {
      const result = extractFromSource('foo.c',
        'int g_x = 0;\nvoid outer(void) { int outer_var; void inner(void) {} outer_var = 1; g_x = 2; }');
      // g_x should have a references edge (from outer, after nested inner returns)
      const refs = result.unresolvedReferences.filter(
        r => r.referenceKind === 'references' && r.referenceName === 'g_x'
      );
      expect(refs.length).toBe(1);
      // outer_var should NOT emit a references edge (it's a local, not a global)
      const outerRefs = result.unresolvedReferences.filter(
        r => r.referenceKind === 'references' && r.referenceName === 'outer_var'
      );
      expect(outerRefs.length).toBe(0);
    });

    it('collects multi-declarator local names for shadow detection', () => {
      const result = extractFromSource('foo.c', 'int g_a = 0;\nint g_b = 0;\nvoid foo(void) { int g_a, g_b; g_a = 1; g_b = 2; }');
      const refs = result.unresolvedReferences.filter(
        r => r.referenceKind === 'references'
      );
      expect(refs.length).toBe(0);
    });

    it('does not emit references for non-C/C++ files', () => {
      const result = extractFromSource('foo.ts', 'let g_counter = 0;\nfunction get() { return g_counter; }');
      const refs = result.unresolvedReferences.filter(
        r => r.referenceKind === 'references' && r.referenceName === 'g_counter'
      );
      expect(refs.length).toBe(0);
    });
  });

  describe('C/C++ global variable extraction with misparsed function body', () => {
    // Layer 1: ob_backtrace.cpp pattern — function with macros leaks
    // subsequent global variable declarations past the compound_statement
    it('extracts global variable after function with preprocessor directives', () => {
      const result = extractFromSource('test.c',
        'void light_backtrace(int fd) {\n' +
        '  int level = 0;\n' +
        '  #define LIGHT(flag) ((flag) & 1)\n' +
        '  level = LIGHT(fd);\n' +
        '  (void)level;\n' +
        '}\n' +
        'int g_backtrace_fd = -1;\n'
      );
      const varNode = result.nodes.find(
        n => n.kind === 'variable' && n.name === 'g_backtrace_fd'
      );
      expect(varNode).toBeDefined();
      expect(varNode?.signature).toBe('= -1');
    });

    // Layer 1: genuine local variables inside the same function should
    // still NOT be extracted
    it('does not extract genuine local variable inside leaked function body', () => {
      const result = extractFromSource('test.c',
        'void light_backtrace(int fd) {\n' +
        '  int local_level = 0;\n' +
        '  #define LIGHT(flag) ((flag) & 1)\n' +
        '  local_level = LIGHT(fd);\n' +
        '}\n' +
        'int g_backtrace_fd = -1;\n'
      );
      const localNode = result.nodes.find(
        n => n.kind === 'variable' && n.name === 'local_level'
      );
      expect(localNode).toBeUndefined();
    });

    // Layer 1: multiple leaked globals after a misparsed function
    it('extracts multiple global variables after misparsed function', () => {
      const result = extractFromSource('test.c',
        'void broken_func(void) {\n' +
        '  #define MACRO(x) (x)\n' +
        '  int a = MACRO(1);\n' +
        '}\n' +
        'int g_x = 1;\n' +
        'int g_y = 2;\n'
      );
      expect(result.nodes.find(n => n.kind === 'variable' && n.name === 'g_x')).toBeDefined();
      expect(result.nodes.find(n => n.kind === 'variable' && n.name === 'g_y')).toBeDefined();
    });

    // Layer 1: leaked function_definition after misparsed body
    it('extracts leaked function definition after misparsed body', () => {
      const result = extractFromSource('test.c',
        'void first(void) {\n' +
        '  #define WRAP(x) (x)\n' +
        '  WRAP(1);\n' +
        '}\n' +
        'int second(void) { return 0; }\n'
      );
      const funcNode = result.nodes.find(
        n => n.kind === 'function' && n.name === 'second'
      );
      expect(funcNode).toBeDefined();
    });

    // Layer 2: g_ prefix variable extracted inside leaked body (safety net)
    it('extracts g_ prefixed variable inside leaked function body (Layer 2)', () => {
      const result = extractFromSource('test.c',
        'void broken(void) {\n' +
        '  #define M(x) (x)\n' +
        '  M(1);\n' +
        '}\n' +
        'int g_config = 42;\n'
      );
      const varNode = result.nodes.find(
        n => n.kind === 'variable' && n.name === 'g_config'
      );
      expect(varNode).toBeDefined();
    });

    // Regression: non-g_ local variable inside NORMAL function still suppressed
    it('does not extract non-g_ local variable inside normal function', () => {
      const result = extractFromSource('test.c',
        'void normal_func(void) {\n' +
        '  int local = 5;\n' +
        '}\n'
      );
      const varNode = result.nodes.find(
        n => n.kind === 'variable' && n.name === 'local'
      );
      expect(varNode).toBeUndefined();
    });

    // Regression: nested named function inside normal body still works
    it('still extracts nested named function inside normal body', () => {
      const result = extractFromSource('test.c',
        'void outer(void) {\n' +
        '  void inner(void) {}\n' +
        '}\n'
      );
      const funcNode = result.nodes.find(
        n => n.kind === 'function' && n.name === 'inner'
      );
      expect(funcNode).toBeDefined();
    });

    // Regression: g_ reference from normal function still tracked
    it('still emits references edge for g_ variable in same file', () => {
      const result = extractFromSource('test.c',
        'int g_counter = 0;\n' +
        'int get(void) { return g_counter; }\n'
      );
      const refs = result.unresolvedReferences.filter(
        r => r.referenceKind === 'references' && r.referenceName === 'g_counter'
      );
      expect(refs.length).toBe(1);
    });

    // Edge case: extern declaration in leaked body — extracted as a declaration
    it('extracts extern declaration in leaked body as a declaration node', () => {
      const result = extractFromSource('test.c',
        'void broken(void) {\n' +
        '  #define M(x) (x)\n' +
        '}\n' +
        'extern int g_external;\n'
      );
      const varNode = result.nodes.find(
        n => n.kind === 'variable' && n.name === 'g_external'
      );
      expect(varNode).toBeDefined();
      expect(varNode!.isDeclaration).toBe(true);
    });

    // Edge case: static global variable in leaked body
    it('extracts static global variable as non-exported in leaked body', () => {
      const result = extractFromSource('test.c',
        'void broken(void) {\n' +
        '  #define M(x) (x)\n' +
        '}\n' +
        'static int s_internal = 0;\n'
      );
      const varNode = result.nodes.find(
        n => n.kind === 'variable' && n.name === 's_internal'
      );
      expect(varNode).toBeDefined();
      expect(varNode?.isExported).toBe(false);
    });

    // Regression: orphaned compound_statement at file scope (K&R C, Google Test
    // macros, or preprocessor-confused function bodies). Tree-sitter does not
    // recognise the enclosing function_definition, so the compound_statement and
    // its declarations land at the translation_unit level. The extractor must
    // NOT treat those declarations as global variables.
    it('does not extract declaration inside orphaned compound_statement', () => {
      const result = extractFromSource('test.c',
        // K&R-style function signature that tree-sitter won't recognize as
        // function_definition, followed by the orphaned compound_statement.
        'int syncsearch(have, buf, len)\n' +
        'unsigned FAR *have;\n' +
        'const unsigned char FAR *buf;\n' +
        'unsigned len;\n' +
        '{\n' +
        '    unsigned got;\n' +
        '    unsigned next;\n' +
        '}\n'
      );
      const gotNode = result.nodes.find(
        n => n.kind === 'variable' && n.name === 'got'
      );
      const nextNode = result.nodes.find(
        n => n.kind === 'variable' && n.name === 'next'
      );
      expect(gotNode).toBeUndefined();
      expect(nextNode).toBeUndefined();
    });

    it('does not extract declaration inside macro-expanded compound_statement (C++)', () => {
      const result = extractFromSource('test.cpp',
        // Google Test macro: tree-sitter sees a macro_invocation followed by
        // an orphaned compound_statement whose declarations look top-level.
        'TEST(Foo, Bar)\n' +
        '{\n' +
        '    int local_var = 42;\n' +
        '    ObString ob_str;\n' +
        '}\n'
      );
      const localVar = result.nodes.find(
        n => n.kind === 'variable' && n.name === 'local_var'
      );
      const obStr = result.nodes.find(
        n => n.kind === 'variable' && n.name === 'ob_str'
      );
      expect(localVar).toBeUndefined();
      expect(obStr).toBeUndefined();
    });
  });

  describe('Dart imports', () => {
    it('should extract dart: import', () => {
      const code = `import 'dart:async';`;
      const result = extractFromSource('main.dart', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('dart:async');
      expect(importNode?.signature).toBe("import 'dart:async';");
    });

    it('should extract package import', () => {
      const code = `import 'package:flutter/material.dart';`;
      const result = extractFromSource('app.dart', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('package:flutter/material.dart');
    });

    it('should extract aliased import', () => {
      const code = `import 'package:http/http.dart' as http;`;
      const result = extractFromSource('api.dart', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('package:http/http.dart');
      expect(importNode?.signature).toContain('as http');
    });

    it('should extract multiple imports', () => {
      const code = `
import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
`;
      const result = extractFromSource('main.dart', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('dart:async');
      expect(names).toContain('dart:convert');
      expect(names).toContain('package:flutter/material.dart');
    });

    it('should extract relative import', () => {
      const code = `import '../utils/helpers.dart';`;
      const result = extractFromSource('lib/main.dart', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('../utils/helpers.dart');
    });
  });

  describe('Liquid imports', () => {
    it('should extract render tag', () => {
      const code = `{% render 'loading-spinner' %}`;
      const result = extractFromSource('template.liquid', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('loading-spinner');
      expect(importNode?.signature).toContain('render');
    });

    it('should extract section tag', () => {
      const code = `{% section 'header' %}`;
      const result = extractFromSource('layout/theme.liquid', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('header');
      expect(importNode?.signature).toContain('section');
    });

    it('should extract include tag', () => {
      const code = `{% include 'icon-cart' %}`;
      const result = extractFromSource('snippets/header.liquid', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('icon-cart');
      expect(importNode?.signature).toContain('include');
    });

    it('should extract render with whitespace control', () => {
      const code = `{%- render 'price' -%}`;
      const result = extractFromSource('snippets/product.liquid', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('price');
    });

    it('should extract multiple imports', () => {
      const code = `
{% section 'header' %}
{% render 'loading-spinner' %}
{% render 'cart-drawer' %}
`;
      const result = extractFromSource('layout/theme.liquid', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('header');
      expect(names).toContain('loading-spinner');
      expect(names).toContain('cart-drawer');
    });
  });
});

// =============================================================================
// Pascal / Delphi Extraction
// =============================================================================

describe('Pascal / Delphi Extraction', () => {
  describe('Language detection', () => {
    it('should detect Pascal files', () => {
      expect(detectLanguage('UAuth.pas')).toBe('pascal');
      expect(detectLanguage('App.dpr')).toBe('pascal');
      expect(detectLanguage('Package.dpk')).toBe('pascal');
      expect(detectLanguage('App.lpr')).toBe('pascal');
      expect(detectLanguage('MainForm.dfm')).toBe('pascal');
      expect(detectLanguage('MainForm.fmx')).toBe('pascal');
    });

    it('should report Pascal as supported', () => {
      expect(isLanguageSupported('pascal')).toBe(true);
      expect(getSupportedLanguages()).toContain('pascal');
    });
  });

  describe('Unit extraction', () => {
    it('should extract unit as module', () => {
      const code = `unit MyUnit;\ninterface\nimplementation\nend.`;
      const result = extractFromSource('MyUnit.pas', code);

      const moduleNode = result.nodes.find((n) => n.kind === 'module');
      expect(moduleNode).toBeDefined();
      expect(moduleNode?.name).toBe('MyUnit');
      expect(moduleNode?.language).toBe('pascal');
    });

    it('should extract program as module', () => {
      const code = `program MyApp;\nbegin\nend.`;
      const result = extractFromSource('MyApp.dpr', code);

      const moduleNode = result.nodes.find((n) => n.kind === 'module');
      expect(moduleNode).toBeDefined();
      expect(moduleNode?.name).toBe('MyApp');
    });

    it('should fallback to filename when module name is empty', () => {
      // Some .dpr templates use "program;" without a name
      const code = `program;\nuses SysUtils;\nbegin\nend.`;
      const result = extractFromSource('Console.dpr', code);

      const moduleNode = result.nodes.find((n) => n.kind === 'module');
      expect(moduleNode).toBeDefined();
      expect(moduleNode?.name).toBe('Console');
    });
  });

  describe('Uses clause (imports)', () => {
    it('should extract uses as individual imports', () => {
      const code = `unit Test;\ninterface\nuses\n  System.SysUtils,\n  System.Classes;\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const imports = result.nodes.filter((n) => n.kind === 'import');
      expect(imports.length).toBe(2);
      expect(imports.map((n) => n.name)).toContain('System.SysUtils');
      expect(imports.map((n) => n.name)).toContain('System.Classes');
    });

    it('should create unresolved references for imports', () => {
      const code = `unit Test;\ninterface\nuses\n  UAuth;\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const importRef = result.unresolvedReferences.find(
        (r) => r.referenceKind === 'imports'
      );
      expect(importRef).toBeDefined();
      expect(importRef?.referenceName).toBe('UAuth');
    });
  });

  describe('Class extraction', () => {
    it('should extract class declarations', () => {
      const code = `unit Test;\ninterface\ntype\n  TMyClass = class\n  public\n    procedure DoSomething;\n  end;\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const classNode = result.nodes.find((n) => n.kind === 'class');
      expect(classNode).toBeDefined();
      expect(classNode?.name).toBe('TMyClass');
    });

    it('should extract class with inheritance', () => {
      const code = `unit Test;\ninterface\ntype\n  TChild = class(TParent)\n  end;\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const extendsRef = result.unresolvedReferences.find(
        (r) => r.referenceKind === 'extends'
      );
      expect(extendsRef).toBeDefined();
      expect(extendsRef?.referenceName).toBe('TParent');
    });

    it('should extract class with interface implementation', () => {
      const code = `unit Test;\ninterface\ntype\n  TService = class(TInterfacedObject, ILogger)\n  end;\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const extendsRef = result.unresolvedReferences.find(
        (r) => r.referenceKind === 'extends'
      );
      const implementsRef = result.unresolvedReferences.find(
        (r) => r.referenceKind === 'implements'
      );
      expect(extendsRef?.referenceName).toBe('TInterfacedObject');
      expect(implementsRef?.referenceName).toBe('ILogger');
    });
  });

  describe('Record extraction', () => {
    it('should extract records as class nodes', () => {
      const code = `unit Test;\ninterface\ntype\n  TPoint = record\n    X: Double;\n    Y: Double;\n  end;\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const classNode = result.nodes.find((n) => n.kind === 'class');
      expect(classNode).toBeDefined();
      expect(classNode?.name).toBe('TPoint');

      const fields = result.nodes.filter((n) => n.kind === 'field');
      expect(fields.length).toBe(2);
      expect(fields.map((f) => f.name)).toContain('X');
      expect(fields.map((f) => f.name)).toContain('Y');
    });
  });

  describe('Interface extraction', () => {
    it('should extract interface declarations', () => {
      const code = `unit Test;\ninterface\ntype\n  ILogger = interface\n    procedure Log(const AMsg: string);\n  end;\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const ifaceNode = result.nodes.find((n) => n.kind === 'interface');
      expect(ifaceNode).toBeDefined();
      expect(ifaceNode?.name).toBe('ILogger');
    });
  });

  describe('Method extraction', () => {
    it('should extract methods with visibility', () => {
      const code = `unit Test;\ninterface\ntype\n  TMyClass = class\n  private\n    FValue: Integer;\n  public\n    constructor Create;\n    function GetValue: Integer;\n  end;\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const methods = result.nodes.filter((n) => n.kind === 'method');
      expect(methods.length).toBe(2);

      const createMethod = methods.find((m) => m.name === 'Create');
      expect(createMethod?.visibility).toBe('public');

      const getValue = methods.find((m) => m.name === 'GetValue');
      expect(getValue?.visibility).toBe('public');

      const fields = result.nodes.filter((n) => n.kind === 'field');
      const fValue = fields.find((f) => f.name === 'FValue');
      expect(fValue?.visibility).toBe('private');
    });

    it('should detect static methods (class methods)', () => {
      const code = `unit Test;\ninterface\ntype\n  THelper = class\n  public\n    class function Create: THelper; static;\n  end;\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const methods = result.nodes.filter((n) => n.kind === 'method');
      const staticMethod = methods.find((m) => m.name === 'Create');
      expect(staticMethod?.isStatic).toBe(true);
    });
  });

  describe('Enum extraction', () => {
    it('should extract enums with members', () => {
      const code = `unit Test;\ninterface\ntype\n  TColor = (clRed, clGreen, clBlue);\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const enumNode = result.nodes.find((n) => n.kind === 'enum');
      expect(enumNode).toBeDefined();
      expect(enumNode?.name).toBe('TColor');

      const members = result.nodes.filter((n) => n.kind === 'enum_member');
      expect(members.length).toBe(3);
      expect(members.map((m) => m.name)).toEqual(['clRed', 'clGreen', 'clBlue']);
    });
  });

  describe('Property extraction', () => {
    it('should extract properties', () => {
      const code = `unit Test;\ninterface\ntype\n  TObj = class\n  public\n    property Name: string read FName write FName;\n  end;\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const propNode = result.nodes.find((n) => n.kind === 'property');
      expect(propNode).toBeDefined();
      expect(propNode?.name).toBe('Name');
      expect(propNode?.visibility).toBe('public');
    });
  });

  describe('Constant extraction', () => {
    it('should extract constants', () => {
      const code = `unit Test;\ninterface\nconst\n  MAX_RETRIES = 3;\n  APP_NAME = 'MyApp';\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const constants = result.nodes.filter((n) => n.kind === 'constant');
      expect(constants.length).toBe(2);
      expect(constants.map((c) => c.name)).toContain('MAX_RETRIES');
      expect(constants.map((c) => c.name)).toContain('APP_NAME');
    });
  });

  describe('Type alias extraction', () => {
    it('should extract type aliases', () => {
      const code = `unit Test;\ninterface\ntype\n  TUserName = string;\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const aliasNode = result.nodes.find((n) => n.kind === 'type_alias');
      expect(aliasNode).toBeDefined();
      expect(aliasNode?.name).toBe('TUserName');
    });
  });

  describe('Call extraction', () => {
    it('should extract calls from implementation bodies', () => {
      const code = `unit Test;\ninterface\ntype\n  TObj = class\n  public\n    procedure DoWork;\n  end;\nimplementation\nprocedure TObj.DoWork;\nbegin\n  WriteLn('hello');\nend;\nend.`;
      const result = extractFromSource('Test.pas', code);

      const callRef = result.unresolvedReferences.find(
        (r) => r.referenceKind === 'calls'
      );
      expect(callRef).toBeDefined();
      expect(callRef?.referenceName).toBe('WriteLn');
    });
  });

  describe('Containment edges', () => {
    it('should create contains edges for class members', () => {
      const code = `unit Test;\ninterface\ntype\n  TObj = class\n  public\n    procedure Foo;\n  end;\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const classNode = result.nodes.find((n) => n.kind === 'class');
      const methodNode = result.nodes.find((n) => n.kind === 'method');
      expect(classNode).toBeDefined();
      expect(methodNode).toBeDefined();

      const containsEdge = result.edges.find(
        (e) => e.source === classNode?.id && e.target === methodNode?.id && e.kind === 'contains'
      );
      expect(containsEdge).toBeDefined();
    });
  });

  describe('Full fixture: UAuth.pas', () => {
    const code = `unit UAuth;

interface

uses
  System.SysUtils,
  System.Classes;

type
  ITokenValidator = interface
    ['{11111111-1111-1111-1111-111111111111}']
    function Validate(const AToken: string): Boolean;
  end;

  TAuthService = class(TInterfacedObject, ITokenValidator)
  private
    FToken: string;
    FLoginCount: Integer;
    procedure IncLoginCount;
  protected
    function GetToken: string;
  public
    constructor Create;
    destructor Destroy; override;
    function Validate(const AToken: string): Boolean;
    function Login(const AUser, APass: string): string;
    property Token: string read GetToken;
    property LoginCount: Integer read FLoginCount;
  end;

implementation

constructor TAuthService.Create;
begin
  inherited Create;
  FToken := '';
  FLoginCount := 0;
end;

destructor TAuthService.Destroy;
begin
  FToken := '';
  inherited Destroy;
end;

procedure TAuthService.IncLoginCount;
begin
  Inc(FLoginCount);
end;

function TAuthService.GetToken: string;
begin
  Result := FToken;
end;

function TAuthService.Validate(const AToken: string): Boolean;
begin
  Result := AToken <> '';
end;

function TAuthService.Login(const AUser, APass: string): string;
begin
  IncLoginCount;
  if Validate(AUser + ':' + APass) then
  begin
    FToken := AUser;
    Result := 'ok';
  end
  else
    Result := '';
end;

end.`;

    it('should extract all expected nodes', () => {
      const result = extractFromSource('UAuth.pas', code);

      expect(result.errors).toHaveLength(0);

      // Module
      const moduleNode = result.nodes.find((n) => n.kind === 'module');
      expect(moduleNode?.name).toBe('UAuth');

      // Imports
      const imports = result.nodes.filter((n) => n.kind === 'import');
      expect(imports.length).toBe(2);

      // Interface
      const ifaceNode = result.nodes.find((n) => n.kind === 'interface');
      expect(ifaceNode?.name).toBe('ITokenValidator');

      // Class
      const classNode = result.nodes.find((n) => n.kind === 'class');
      expect(classNode?.name).toBe('TAuthService');

      // Methods
      const methods = result.nodes.filter((n) => n.kind === 'method');
      expect(methods.length).toBeGreaterThanOrEqual(6);
      expect(methods.map((m) => m.name)).toContain('Create');
      expect(methods.map((m) => m.name)).toContain('Destroy');
      expect(methods.map((m) => m.name)).toContain('Login');

      // Fields
      const fields = result.nodes.filter((n) => n.kind === 'field');
      expect(fields.length).toBe(2);
      expect(fields.every((f) => f.visibility === 'private')).toBe(true);

      // Properties
      const props = result.nodes.filter((n) => n.kind === 'property');
      expect(props.length).toBe(2);
      expect(props.map((p) => p.name)).toContain('Token');
      expect(props.map((p) => p.name)).toContain('LoginCount');
    });

    it('should extract inheritance and interface implementation', () => {
      const result = extractFromSource('UAuth.pas', code);

      const extendsRef = result.unresolvedReferences.find(
        (r) => r.referenceKind === 'extends'
      );
      expect(extendsRef?.referenceName).toBe('TInterfacedObject');

      const implementsRef = result.unresolvedReferences.find(
        (r) => r.referenceKind === 'implements'
      );
      expect(implementsRef?.referenceName).toBe('ITokenValidator');
    });

    it('should extract calls from implementation', () => {
      const result = extractFromSource('UAuth.pas', code);

      const callRefs = result.unresolvedReferences.filter(
        (r) => r.referenceKind === 'calls'
      );
      expect(callRefs.map((r) => r.referenceName)).toContain('Inc');
      expect(callRefs.map((r) => r.referenceName)).toContain('Validate');
    });
  });

  describe('Full fixture: UTypes.pas', () => {
    const code = `unit UTypes;

interface

uses
  System.SysUtils;

const
  C_MAX_RETRIES = 3;
  C_DEFAULT_NAME = 'Guest';

type
  TUserRole = (urAdmin, urEditor, urViewer);

  TPoint2D = record
    X: Double;
    Y: Double;
  end;

  TUserName = string;

  TUserInfo = class
  public
    type
      TAddress = record
        Street: string;
        City: string;
        Zip: string;
      end;
  private
    FName: TUserName;
    FRole: TUserRole;
    FAddress: TAddress;
  public
    constructor Create(const AName: TUserName; ARole: TUserRole);
    function GetDisplayName: string;
    class function CreateAdmin(const AName: TUserName): TUserInfo; static;
    property Name: TUserName read FName write FName;
    property Role: TUserRole read FRole;
    property Address: TAddress read FAddress write FAddress;
  end;

implementation

constructor TUserInfo.Create(const AName: TUserName; ARole: TUserRole);
begin
  FName := AName;
  FRole := ARole;
end;

function TUserInfo.GetDisplayName: string;
begin
  if FRole = urAdmin then
    Result := '[Admin] ' + FName
  else
    Result := FName;
end;

class function TUserInfo.CreateAdmin(const AName: TUserName): TUserInfo;
begin
  Result := TUserInfo.Create(AName, urAdmin);
end;

end.`;

    it('should extract enums with members', () => {
      const result = extractFromSource('UTypes.pas', code);

      const enumNode = result.nodes.find((n) => n.kind === 'enum');
      expect(enumNode?.name).toBe('TUserRole');

      const members = result.nodes.filter((n) => n.kind === 'enum_member');
      expect(members.length).toBe(3);
      expect(members.map((m) => m.name)).toEqual(['urAdmin', 'urEditor', 'urViewer']);
    });

    it('should extract constants', () => {
      const result = extractFromSource('UTypes.pas', code);

      const constants = result.nodes.filter((n) => n.kind === 'constant');
      expect(constants.length).toBe(2);
      expect(constants.map((c) => c.name)).toContain('C_MAX_RETRIES');
      expect(constants.map((c) => c.name)).toContain('C_DEFAULT_NAME');
    });

    it('should extract type aliases', () => {
      const result = extractFromSource('UTypes.pas', code);

      const aliases = result.nodes.filter((n) => n.kind === 'type_alias');
      expect(aliases.map((a) => a.name)).toContain('TUserName');
    });

    it('should extract records as classes with fields', () => {
      const result = extractFromSource('UTypes.pas', code);

      const classes = result.nodes.filter((n) => n.kind === 'class');
      expect(classes.map((c) => c.name)).toContain('TPoint2D');

      // TPoint2D fields
      const fields = result.nodes.filter((n) => n.kind === 'field');
      expect(fields.map((f) => f.name)).toContain('X');
      expect(fields.map((f) => f.name)).toContain('Y');
    });

    it('should extract static class methods', () => {
      const result = extractFromSource('UTypes.pas', code);

      const methods = result.nodes.filter((n) => n.kind === 'method');
      const staticMethod = methods.find((m) => m.name === 'CreateAdmin');
      expect(staticMethod).toBeDefined();
      expect(staticMethod?.isStatic).toBe(true);
    });

    it('should extract nested types', () => {
      const result = extractFromSource('UTypes.pas', code);

      const classes = result.nodes.filter((n) => n.kind === 'class');
      expect(classes.map((c) => c.name)).toContain('TAddress');
    });
  });
});

// =============================================================================
// DFM/FMX Extraction
// =============================================================================

describe('DFM/FMX Extraction', () => {
  it('should extract components from DFM', () => {
    const code = `object Form1: TForm1
  Left = 0
  Top = 0
  Caption = 'My Form'
  object Button1: TButton
    Left = 10
    Top = 10
    Caption = 'Click Me'
  end
end`;
    const result = extractFromSource('Form1.dfm', code);

    const components = result.nodes.filter((n) => n.kind === 'component');
    expect(components.length).toBe(2);
    expect(components.map((c) => c.name)).toContain('Form1');
    expect(components.map((c) => c.name)).toContain('Button1');

    const button = components.find((c) => c.name === 'Button1');
    expect(button?.signature).toBe('TButton');
  });

  it('should extract nested component hierarchy', () => {
    const code = `object Form1: TForm1
  object Panel1: TPanel
    object Label1: TLabel
      Caption = 'Hello'
    end
  end
end`;
    const result = extractFromSource('Form1.dfm', code);

    const components = result.nodes.filter((n) => n.kind === 'component');
    expect(components.length).toBe(3);

    // Check nesting: Panel1 contains Label1
    const panel = components.find((c) => c.name === 'Panel1');
    const label = components.find((c) => c.name === 'Label1');
    const containsEdge = result.edges.find(
      (e) => e.source === panel?.id && e.target === label?.id && e.kind === 'contains'
    );
    expect(containsEdge).toBeDefined();
  });

  it('should extract event handler references', () => {
    const code = `object Form1: TForm1
  OnCreate = FormCreate
  OnDestroy = FormDestroy
  object Button1: TButton
    OnClick = Button1Click
  end
end`;
    const result = extractFromSource('Form1.dfm', code);

    const refs = result.unresolvedReferences;
    expect(refs.length).toBe(3);
    expect(refs.map((r) => r.referenceName)).toContain('FormCreate');
    expect(refs.map((r) => r.referenceName)).toContain('FormDestroy');
    expect(refs.map((r) => r.referenceName)).toContain('Button1Click');
    expect(refs.every((r) => r.referenceKind === 'references')).toBe(true);
  });

  it('should handle multi-line properties', () => {
    const code = `object Form1: TForm1
  SQL.Strings = (
    'SELECT * FROM users'
    'WHERE active = 1')
  object Button1: TButton
    OnClick = Button1Click
  end
end`;
    const result = extractFromSource('Form1.dfm', code);

    const components = result.nodes.filter((n) => n.kind === 'component');
    expect(components.length).toBe(2);

    const refs = result.unresolvedReferences;
    expect(refs.length).toBe(1);
    expect(refs[0]?.referenceName).toBe('Button1Click');
  });

  it('should handle inherited keyword', () => {
    const code = `inherited Form1: TForm1
  Caption = 'Inherited Form'
  object Button1: TButton
    OnClick = Button1Click
  end
end`;
    const result = extractFromSource('Form1.dfm', code);

    const components = result.nodes.filter((n) => n.kind === 'component');
    expect(components.length).toBe(2);
    expect(components.map((c) => c.name)).toContain('Form1');
  });

  it('should handle item collection properties', () => {
    const code = `object Form1: TForm1
  object StatusBar1: TStatusBar
    Panels = <
      item
        Width = 200
      end
      item
        Width = 200
      end>
  end
end`;
    const result = extractFromSource('Form1.dfm', code);

    const components = result.nodes.filter((n) => n.kind === 'component');
    expect(components.length).toBe(2);
  });

  describe('Full fixture: MainForm.dfm', () => {
    const code = `object frmMain: TfrmMain
  Left = 0
  Top = 0
  Caption = 'CodeGraph DFM Fixture'
  ClientHeight = 480
  ClientWidth = 640
  OnCreate = FormCreate
  OnDestroy = FormDestroy
  object pnlTop: TPanel
    Left = 0
    Top = 0
    Width = 640
    Height = 50
    object lblTitle: TLabel
      Left = 16
      Top = 16
      Caption = 'Authentication Service'
    end
    object btnLogin: TButton
      Left = 540
      Top = 12
      OnClick = btnLoginClick
    end
  end
  object pnlContent: TPanel
    Left = 0
    Top = 50
    object edtUsername: TEdit
      Left = 16
      Top = 16
      OnChange = edtUsernameChange
    end
    object edtPassword: TEdit
      Left = 16
      Top = 48
      OnKeyPress = edtPasswordKeyPress
    end
    object mmoLog: TMemo
      Left = 16
      Top = 88
    end
  end
  object pnlStatus: TStatusBar
    Left = 0
    Top = 440
    Panels = <
      item
        Width = 200
      end
      item
        Width = 200
      end>
  end
end`;

    it('should extract all components', () => {
      const result = extractFromSource('MainForm.dfm', code);

      const components = result.nodes.filter((n) => n.kind === 'component');
      expect(components.length).toBe(9);
      expect(components.map((c) => c.name)).toEqual(
        expect.arrayContaining([
          'frmMain', 'pnlTop', 'lblTitle', 'btnLogin',
          'pnlContent', 'edtUsername', 'edtPassword', 'mmoLog', 'pnlStatus',
        ])
      );
    });

    it('should extract all event handlers', () => {
      const result = extractFromSource('MainForm.dfm', code);

      const refs = result.unresolvedReferences;
      expect(refs.length).toBe(5);
      expect(refs.map((r) => r.referenceName)).toEqual(
        expect.arrayContaining([
          'FormCreate', 'FormDestroy', 'btnLoginClick',
          'edtUsernameChange', 'edtPasswordKeyPress',
        ])
      );
    });
  });
});

describe('Kotlin Multiplatform expect/actual', () => {
  let tempDir: string;
  let cg: CodeGraph;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('links expect declarations to platform actual implementations and surfaces them in impact', async () => {
    const common = path.join(tempDir, 'src', 'commonMain');
    const jvm = path.join(tempDir, 'src', 'jvmMain');
    fs.mkdirSync(common, { recursive: true });
    fs.mkdirSync(jvm, { recursive: true });

    // common source set: expect declarations + a caller that uses them
    fs.writeFileSync(
      path.join(common, 'SystemProps.kt'),
      `package demo.internal

expect fun systemProp(name: String): String?

expect class Platform {
    fun describe(): String
}
`
    );
    fs.writeFileSync(
      path.join(common, 'Caller.kt'),
      `package demo

import demo.internal.systemProp
import demo.internal.Platform

fun useIt(): String {
    val v = systemProp("os.name")
    return Platform().describe() + v
}
`
    );
    // jvm source set: actual implementations
    fs.writeFileSync(
      path.join(jvm, 'SystemProps.kt'),
      `package demo.internal

actual fun systemProp(name: String): String? = System.getProperty(name)

actual class Platform {
    actual fun describe(): String = "JVM"
}
`
    );

    cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.resolveReferences();

    // The expect/actual markers are captured onto the node's decorators.
    const fns = cg.getNodesByKind('function');
    const actualFn = fns.find(
      (n) => n.name === 'systemProp' && n.decorators?.includes('actual')
    );
    const expectFn = fns.find(
      (n) => n.name === 'systemProp' && n.decorators?.includes('expect')
    );
    expect(actualFn).toBeDefined();
    expect(expectFn).toBeDefined();
    expect(actualFn!.filePath).not.toBe(expectFn!.filePath);

    // Editing the JVM actual must surface the common expect AND its caller —
    // before the expect/actual bridge the actual had zero dependents.
    const impact = cg.getImpactRadius(actualFn!.id, 3);
    const impacted = [...impact.nodes.values()].map((n) => n.name);
    expect(impacted).toContain('systemProp'); // the common expect
    expect(impacted).toContain('useIt'); // the caller, reached transitively

    // The bridging edge is a heuristic `calls` edge tagged by the synthesizer.
    const bridge = impact.edges.find(
      (e) =>
        e.target === actualFn!.id &&
        e.provenance === 'heuristic' &&
        (e.metadata as { synthesizedBy?: string } | undefined)?.synthesizedBy ===
          'kotlin-expect-actual'
    );
    expect(bridge).toBeDefined();
    expect(bridge!.source).toBe(expectFn!.id);
  });

  it('links an expect class to an actual typealias (different node kinds)', async () => {
    const common = path.join(tempDir, 'src', 'commonMain');
    const jvm = path.join(tempDir, 'src', 'jvmMain');
    fs.mkdirSync(common, { recursive: true });
    fs.mkdirSync(jvm, { recursive: true });

    fs.writeFileSync(
      path.join(common, 'Lock.kt'),
      `package demo

expect class Lock {
    fun acquire()
}
`
    );
    fs.writeFileSync(
      path.join(jvm, 'Lock.kt'),
      `package demo

actual typealias Lock = java.util.concurrent.locks.ReentrantLock
`
    );

    cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.resolveReferences();

    const aliasNode = cg
      .getNodesByKind('type_alias')
      .find((n) => n.name === 'Lock' && n.decorators?.includes('actual'));
    expect(aliasNode).toBeDefined();

    // The actual typealias is now a cross-file dependency target (linked from
    // the expect class), so it participates in impact rather than being orphaned.
    const impact = cg.getImpactRadius(aliasNode!.id, 3);
    const bridge = impact.edges.find(
      (e) =>
        e.target === aliasNode!.id &&
        (e.metadata as { synthesizedBy?: string } | undefined)?.synthesizedBy ===
          'kotlin-expect-actual'
    );
    expect(bridge).toBeDefined();
  });
});

describe('Scala cross-file dependencies', () => {
  let tempDir: string;
  let cg: CodeGraph;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('links parameterized supertypes, type annotations, and implicit params across files', async () => {
    const src = path.join(tempDir, 'src', 'main', 'scala', 'demo');
    fs.mkdirSync(src, { recursive: true });

    fs.writeFileSync(
      path.join(src, 'Semigroup.scala'),
      `package demo

trait Semigroup[A] {
  def combine(x: A, y: A): A
}
`
    );
    fs.writeFileSync(
      path.join(src, 'Monoid.scala'),
      `package demo

trait Monoid[A] extends Semigroup[A] {
  def empty: A
}
`
    );
    fs.writeFileSync(
      path.join(src, 'Instances.scala'),
      `package demo

object Instances {
  implicit val intMonoid: Monoid[Int] = new Monoid[Int] {
    def empty: Int = 0
    def combine(x: Int, y: Int): Int = x + y
  }
}
`
    );
    fs.writeFileSync(
      path.join(src, 'Folding.scala'),
      `package demo

object Folding {
  def fold[A](xs: List[A])(implicit M: Monoid[A]): A =
    xs.foldLeft(M.empty)(M.combine)
}
`
    );

    cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.resolveReferences();

    const monoid = cg.getNodesByKind('trait').find((n) => n.name === 'Monoid');
    const semigroup = cg.getNodesByKind('trait').find((n) => n.name === 'Semigroup');
    expect(monoid).toBeDefined();
    expect(semigroup).toBeDefined();
    expect(monoid!.filePath).not.toBe(semigroup!.filePath);

    // Parameterized supertype `extends Semigroup[A]` must create an extends edge —
    // the whole point of the fix (the `[A]` used to defeat name matching).
    const semaImpact = cg.getImpactRadius(semigroup!.id, 3);
    expect([...semaImpact.nodes.values()].map((n) => n.name)).toContain('Monoid');

    // Editing Monoid surfaces the cross-file users: the instance val typed
    // `Monoid[Int]` and the method taking it as an implicit (curried) param.
    const impacted = [...cg.getImpactRadius(monoid!.id, 3).nodes.values()].map((n) => n.name);
    expect(impacted).toContain('intMonoid'); // field type annotation
    expect(impacted).toContain('fold'); // trailing implicit parameter list
  });
});

describe('PHP namespace + import resolution', () => {
  let tempDir: string;
  let cg: CodeGraph;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('resolves `use` imports to the namespace-qualified definition and type-hints across files', async () => {
    const src = path.join(tempDir, 'src');
    // Two interfaces with the SAME simple name in different namespaces — the
    // exact ambiguity (Laravel has 7+ `Factory`) that bare-name matching can't
    // resolve. The namespace qualifies them; the `use` import disambiguates.
    fs.mkdirSync(path.join(src, 'Cache'), { recursive: true });
    fs.mkdirSync(path.join(src, 'Mail'), { recursive: true });
    fs.mkdirSync(path.join(src, 'App'), { recursive: true });
    fs.writeFileSync(
      path.join(src, 'Cache', 'Factory.php'),
      `<?php
namespace Contracts\\Cache;

interface Factory {
    public function store(): object;
}
`
    );
    fs.writeFileSync(
      path.join(src, 'Mail', 'Factory.php'),
      `<?php
namespace Contracts\\Mail;

interface Factory {
    public function mailer(): object;
}
`
    );
    fs.writeFileSync(
      path.join(src, 'App', 'Service.php'),
      `<?php
namespace App;

use Contracts\\Cache\\Factory;

class Service {
    public function make(): Factory {
        return resolve(Factory::class);
    }
}
`
    );

    cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.resolveReferences();

    // The PHP namespace is captured into the qualified name, so the two
    // same-named interfaces are distinguishable.
    const cacheFactory = cg
      .getNodesByKind('interface')
      .find((n) => n.qualifiedName === 'Contracts\\Cache::Factory');
    const mailFactory = cg
      .getNodesByKind('interface')
      .find((n) => n.qualifiedName === 'Contracts\\Mail::Factory');
    expect(cacheFactory).toBeDefined();
    expect(mailFactory).toBeDefined();

    // Service `use`s Contracts\Cache\Factory, so editing THAT interface reaches
    // Service.php — and editing the same-named Contracts\Mail\Factory must NOT
    // (the import resolved to the right namespace, not an arbitrary `Factory`).
    const serviceFile = 'src/App/Service.php';
    const cacheReaches = [...cg.getImpactRadius(cacheFactory!.id, 3).nodes.values()].some(
      (n) => (n.filePath ?? '').endsWith(serviceFile)
    );
    const mailReaches = [...cg.getImpactRadius(mailFactory!.id, 3).nodes.values()].some(
      (n) => (n.filePath ?? '').endsWith(serviceFile)
    );
    expect(cacheReaches).toBe(true);
    expect(mailReaches).toBe(false);
  });
});

describe('Ruby mixins (include/extend/prepend)', () => {
  let tempDir: string;
  let cg: CodeGraph;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('links include/extend/prepend to the mixed-in module across files', async () => {
    const lib = path.join(tempDir, 'lib');
    fs.mkdirSync(lib, { recursive: true });

    fs.writeFileSync(
      path.join(lib, 'concerns.rb'),
      `module Trackable
  def track; end
end

module Cacheable
  def cache; end
end

module Loggable
  def log; end
end
`
    );
    fs.writeFileSync(
      path.join(lib, 'model.rb'),
      `class Model
  include Trackable
  prepend Cacheable
  extend Loggable
end
`
    );

    cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.resolveReferences();

    const model = cg.getNodesByKind('class').find((n) => n.name === 'Model');
    expect(model).toBeDefined();

    // All three mixin forms create an `implements` edge Model → module, so
    // editing a concern surfaces every class that mixes it in (across files).
    for (const moduleName of ['Trackable', 'Cacheable', 'Loggable']) {
      const mod = cg.getNodesByKind('module').find((n) => n.name === moduleName);
      expect(mod, moduleName).toBeDefined();
      const impacted = [...cg.getImpactRadius(mod!.id, 3).nodes.values()].map((n) => n.name);
      expect(impacted, `${moduleName} should be depended on by Model`).toContain('Model');
    }
  });

  it('resolves require / require_relative to the required file', async () => {
    const lib = path.join(tempDir, 'lib');
    fs.mkdirSync(path.join(lib, 'app'), { recursive: true });

    // A leaf file whose class is referenced only dynamically — so without
    // require resolution it would look like nothing depends on it.
    fs.writeFileSync(
      path.join(lib, 'app', 'fetcher.rb'),
      `module App
  class Fetcher
    def fetch; end
  end
end
`
    );
    // Pulled in by a load-path `require` …
    fs.writeFileSync(
      path.join(lib, 'app', 'worker.rb'),
      `require "app/fetcher"

module App
  class Worker; end
end
`
    );
    // … and a sibling pulled in by `require_relative`.
    fs.writeFileSync(
      path.join(lib, 'app', 'boot.rb'),
      `require_relative "fetcher"
`
    );

    cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.resolveReferences();

    // The require edges target fetcher.rb's FILE node. Editing it should reach
    // BOTH the load-path requirer (worker.rb) and the require_relative one
    // (boot.rb) — without require resolution its file would have no dependents.
    const fetcher = cg.getNodesByKind('file').find((n) => n.filePath.endsWith('app/fetcher.rb'));
    expect(fetcher, 'fetcher.rb indexed').toBeDefined();
    const reached = [...cg.getImpactRadius(fetcher!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
    expect(reached.some((p) => p.endsWith('app/worker.rb'))).toBe(true);
    expect(reached.some((p) => p.endsWith('app/boot.rb'))).toBe(true);
  });
});

describe('C++ free-function name extraction', () => {
  let tempDir: string;
  let cg: CodeGraph;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('names a free function correctly when it has qualified-type params or a trailing return type', async () => {
    const src = path.join(tempDir, 'src');
    fs.mkdirSync(src, { recursive: true });

    // TableFileName has a `const std::string&` parameter; BuildName uses an
    // `auto … -> std::string` trailing return type. Both used to be named
    // `string` (picked up from the parameter / return type), so callers never
    // resolved and the defining file looked like nothing depended on it.
    fs.writeFileSync(
      path.join(src, 'names.cc'),
      `#include <string>

std::string TableFileName(const std::string& dbname, int number) {
  return dbname;
}

auto BuildName(const std::string& a) -> std::string {
  return a;
}
`
    );
    fs.writeFileSync(
      path.join(src, 'user.cc'),
      `#include <string>

std::string use() {
  return TableFileName("db", 1) + BuildName("x");
}
`
    );

    cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.resolveReferences();

    // The functions are extracted under their real names, not `string`.
    const fns = cg.getNodesByKind('function');
    const tableFn = fns.find((n) => n.name === 'TableFileName');
    const buildFn = fns.find((n) => n.name === 'BuildName');
    expect(tableFn, 'TableFileName extracted (not "string")').toBeDefined();
    expect(buildFn, 'BuildName extracted (not "string")').toBeDefined();

    // And the cross-file calls resolve to them, so editing names.cc surfaces user.cc.
    for (const fn of [tableFn!, buildFn!]) {
      const reached = [...cg.getImpactRadius(fn.id, 3).nodes.values()].map((n) => n.filePath ?? '');
      expect(reached.some((p) => p.endsWith('user.cc')), `${fn.name} should be called from user.cc`).toBe(true);
    }
  });
});

describe('Dart mixins and type references', () => {
  let tempDir: string;
  let cg: CodeGraph;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('links `with` mixins and method parameter/return types across files', async () => {
    const lib = path.join(tempDir, 'lib');
    fs.mkdirSync(lib, { recursive: true });

    fs.writeFileSync(
      path.join(lib, 'models.dart'),
      `class User {
  final String name;
  User(this.name);
}

mixin Loggable {
  void log() {}
}

abstract class Repository {
  User find(int id);
}
`
    );
    fs.writeFileSync(
      path.join(lib, 'service.dart'),
      `import 'models.dart';

class UserService extends Repository with Loggable {
  @override
  User find(int id) => User('x');

  List<User> all() => [];
}
`
    );

    cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.resolveReferences();

    const inModels = (name: string) =>
      cg.getNodesByKind('class').concat(cg.getNodesByKind('module'))
        .find((n) => n.name === name && n.filePath.endsWith('models.dart'));

    // The `with Loggable` mixin records a dependency — editing the mixin surfaces
    // the class that mixes it in (across files). Loggable is a `mixin`, indexed
    // as a class-like node.
    const loggable = cg.getNodesByKind('class').find((n) => n.name === 'Loggable')
      ?? cg.getNodesByKind('module').find((n) => n.name === 'Loggable');
    expect(loggable, 'Loggable mixin indexed').toBeDefined();
    const mixinUsers = [...cg.getImpactRadius(loggable!.id, 3).nodes.values()].map((n) => n.name);
    expect(mixinUsers).toContain('UserService');

    // `User` is used only as a method parameter/return type in service.dart —
    // editing it must still surface service.dart via the type references.
    const user = inModels('User') ?? cg.getNodesByKind('class').find((n) => n.name === 'User');
    expect(user, 'User indexed').toBeDefined();
    const userDeps = [...cg.getImpactRadius(user!.id, 3).nodes.values()].map((n) => n.filePath ?? '');
    expect(userDeps.some((p) => p.endsWith('service.dart'))).toBe(true);
  });
});

describe('Static-member / value-read references', () => {
  let tempDir: string;
  let cg: CodeGraph;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('links a type referenced only via a static field / enum value (and ignores lowercase receivers)', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'JsonScope.java'),
      `class JsonScope {
  static final int EMPTY_DOCUMENT = 1;
}
`
    );
    fs.writeFileSync(
      path.join(tempDir, 'Reader.java'),
      `class Reader {
  private int helper;
  int peek() {
    return JsonScope.EMPTY_DOCUMENT;
  }
  int noop() {
    return this.helper;
  }
}
`
    );

    cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.resolveReferences();

    // JsonScope is used ONLY as `JsonScope.EMPTY_DOCUMENT` (a static-field value
    // read — never constructed or called), so before the static-member pass it
    // had no dependents. Editing it now surfaces Reader.java.
    const scope = cg.getNodesByKind('class').find((n) => n.name === 'JsonScope');
    expect(scope, 'JsonScope indexed').toBeDefined();
    const reached = [...cg.getImpactRadius(scope!.id, 3).nodes.values()].map((n) => n.filePath ?? '');
    expect(reached.some((p) => p.endsWith('Reader.java'))).toBe(true);

    // A lowercase receiver (`this.helper`) must NOT be emitted as a type ref —
    // only Capitalized receivers (types) are. No node named `this`/`helper`
    // should appear as a reference target from peek/noop beyond JsonScope.
    const refTargets = cg
      .getNodesByKind('class')
      .filter((n) => n.name === 'this' || n.name === 'helper');
    expect(refTargets.length).toBe(0);
  });

  it('does not link a static-member read across language families (coincidental name)', async () => {
    // A native (Kotlin) `Build.VERSION` reads the Android system class — it must
    // NOT link to a coincidentally same-named TS class (the cross-language false
    // positive that name-matching produces; `references` edges are language-local).
    fs.writeFileSync(
      path.join(tempDir, 'Build.ts'),
      `export class Build {\n  static version = 1;\n}\n`
    );
    fs.writeFileSync(
      path.join(tempDir, 'Device.kt'),
      `package app\nclass Device {\n  fun sdk(): Int = Build.VERSION\n}\n`
    );

    cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.resolveReferences();

    const tsBuild = cg.getNodesByKind('class').find((n) => n.name === 'Build' && n.filePath.endsWith('Build.ts'));
    expect(tsBuild).toBeDefined();
    // The Kotlin file is `app/Device.kt`; the TS Build must have NO dependent there.
    const deps = [...cg.getImpactRadius(tsBuild!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
    expect(deps.some((p) => p.endsWith('Device.kt'))).toBe(false);
  });
});

describe('Cross-language type/import gate (RN name collisions)', () => {
  let tempDir: string;
  let cg: CodeGraph;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('a TS PascalCase type ref lands on the TS type, never a same-named native class', async () => {
    // react-native-async-storage's example app has a TS `type TestRunner` AND a
    // Kotlin `class TestRunner`. The React PascalCase resolver name-matched the
    // Kotlin `class` (its COMPONENT_KINDS includes `class`) with no language
    // check at confidence 0.8, outranking the (cross-language-penalized 0.5)
    // TS name-match — so a TS ref to `TestRunner` crossed web→jvm. The ref here
    // is intentionally NOT imported: a clean relative import would mask the bug
    // by resolving via the import map before the framework strategy can win.
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ dependencies: { 'react-native': '*' } })
    );
    fs.writeFileSync(
      path.join(tempDir, 'useTests.ts'),
      `export type TestRunner = { run: () => void };\n`
    );
    fs.writeFileSync(
      path.join(tempDir, 'basic.tsx'),
      `export function useBasicTest(r: TestRunner): TestRunner {\n  return r;\n}\n`
    );
    fs.writeFileSync(
      path.join(tempDir, 'TestUtils.kt'),
      `package app\nclass TestRunner {\n  fun run() {}\n}\n`
    );

    cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.resolveReferences();

    const ktRunner = cg
      .getNodesByKind('class')
      .find((n) => n.name === 'TestRunner' && n.filePath.endsWith('TestUtils.kt'));
    expect(ktRunner, 'Kotlin TestRunner class').toBeDefined();
    const ktDeps = [...cg.getImpactRadius(ktRunner!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
    expect(ktDeps.some((p) => p.endsWith('basic.tsx')), 'Kotlin class has NO TS dependent').toBe(false);

    const tsRunner = cg.getNodesByKind('type_alias').find((n) => n.name === 'TestRunner');
    expect(tsRunner, 'TS TestRunner type_alias').toBeDefined();
    const tsDeps = [...cg.getImpactRadius(tsRunner!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
    expect(tsDeps.some((p) => p.endsWith('basic.tsx')), 'TS type captured the ref (re-pointed)').toBe(true);
  });

  it('gates a cross-family import name collision but keeps same-family imports', async () => {
    // A TS `import { Widget }` that only matches a Swift `class Widget` must not
    // create a web→apple dependency — but a sibling TS module imported by
    // another TS file (same family) must still resolve (no over-gating).
    fs.writeFileSync(path.join(tempDir, 'Widget.swift'), `class Widget {\n  func render() {}\n}\n`);
    fs.writeFileSync(
      path.join(tempDir, 'widget.ts'),
      `import { Widget } from './native';\nexport function mount(w: Widget) {}\n`
    );
    fs.writeFileSync(path.join(tempDir, 'util.ts'), `export class Helper {}\n`);
    fs.writeFileSync(
      path.join(tempDir, 'app.ts'),
      `import { Helper } from './util';\nexport const h = new Helper();\n`
    );

    cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.resolveReferences();

    const swiftWidget = cg
      .getNodesByKind('class')
      .find((n) => n.name === 'Widget' && n.filePath.endsWith('.swift'));
    expect(swiftWidget, 'Swift Widget class').toBeDefined();
    const wDeps = [...cg.getImpactRadius(swiftWidget!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
    expect(wDeps.some((p) => p.endsWith('widget.ts')), 'Swift class has NO TS dependent').toBe(false);

    // Same-family control — the TS Helper must still see its TS dependent.
    const helper = cg.getNodesByKind('class').find((n) => n.name === 'Helper');
    expect(helper, 'TS Helper class').toBeDefined();
    const hDeps = [...cg.getImpactRadius(helper!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
    expect(hDeps.some((p) => p.endsWith('app.ts')), 'same-family TS import preserved').toBe(true);
  });
});

describe('Python absolute module import resolution', () => {
  let tempDir: string;
  let cg: CodeGraph;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('links a bare `import pkg.module` of an internal module to its file', async () => {
    // `import conduit.apps.signals` (a Django-style side-effect import, and any
    // dotted absolute module import) had no edge to the module file — only
    // `from x import y` was linked — so a module imported by its dotted path
    // looked like nothing depended on it.
    fs.mkdirSync(path.join(tempDir, 'conduit/apps'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'conduit/__init__.py'), '');
    fs.writeFileSync(path.join(tempDir, 'conduit/apps/__init__.py'), '');
    fs.writeFileSync(path.join(tempDir, 'conduit/apps/signals.py'), `def handler():\n    pass\n`);
    fs.writeFileSync(
      path.join(tempDir, 'conduit/apps/app.py'),
      `import conduit.apps.signals\nimport os\n\nVALUE = 1\n`
    );

    cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.resolveReferences();

    const signals = cg.getNodesByKind('file').find((n) => n.filePath.endsWith('conduit/apps/signals.py'));
    expect(signals, 'signals.py indexed').toBeDefined();
    const deps = [...cg.getImpactRadius(signals!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
    expect(deps.some((p) => p.endsWith('app.py')), 'importer depends on the module').toBe(true);
    // `import os` (stdlib) must NOT fabricate an edge — no os.py file in the repo.
    const osNode = cg.getNodesByKind('file').find((n) => n.filePath.endsWith('/os.py'));
    expect(osNode, 'no stdlib os.py node').toBeUndefined();
  });

  it('Django include() links the root URLconf to the included app urls module', async () => {
    // `url(r'^api/', include('app.urls'))` should record a dependency from the
    // root urlconf onto the included app's `urls.py` — so editing an app's routes
    // surfaces the project urlconf that mounts them.
    fs.mkdirSync(path.join(tempDir, 'app'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'requirements.txt'), `django==4.0\n`);
    fs.writeFileSync(path.join(tempDir, 'app/__init__.py'), '');
    fs.writeFileSync(path.join(tempDir, 'app/views.py'), `def home(request):\n    return None\n`);
    fs.writeFileSync(
      path.join(tempDir, 'app/urls.py'),
      `from django.conf.urls import url\nfrom . import views\nurlpatterns = [url(r'^$', views.home)]\n`
    );
    fs.writeFileSync(
      path.join(tempDir, 'urls.py'),
      `from django.conf.urls import include, url\nurlpatterns = [url(r'^app/', include('app.urls'))]\n`
    );

    cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.resolveReferences();

    const appUrls = cg.getNodesByKind('file').find((n) => n.filePath.endsWith('app/urls.py'));
    expect(appUrls, 'app/urls.py indexed').toBeDefined();
    const deps = [...cg.getImpactRadius(appUrls!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
    expect(deps.some((p) => p.endsWith('urls.py') && !p.endsWith('app/urls.py')), 'root urlconf depends on the included app urls').toBe(true);
  });

  it('resolves `from pkg import submodule` to the submodule under that package, not a same-named one', async () => {
    // FastAPI router-aggregator pattern: `from app.api.routes import authentication`
    // with same-named modules in sibling packages must resolve via the import's
    // SOURCE (the package), not a coincidental same-basename file elsewhere.
    fs.mkdirSync(path.join(tempDir, 'app/api/routes'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'app/api/dependencies'), { recursive: true });
    for (const p of ['app/__init__.py', 'app/api/__init__.py', 'app/api/routes/__init__.py', 'app/api/dependencies/__init__.py']) {
      fs.writeFileSync(path.join(tempDir, p), '');
    }
    fs.writeFileSync(path.join(tempDir, 'app/api/routes/authentication.py'), `def login():\n    pass\n`);
    fs.writeFileSync(path.join(tempDir, 'app/api/dependencies/authentication.py'), `def get_user():\n    pass\n`);
    fs.writeFileSync(
      path.join(tempDir, 'app/api/routes/api.py'),
      `from app.api.routes import authentication\n\nROUTER = authentication\n`
    );

    cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.resolveReferences();

    const routesAuth = cg.getNodesByKind('file').find((n) => n.filePath.endsWith('routes/authentication.py'));
    const depsAuth = cg.getNodesByKind('file').find((n) => n.filePath.endsWith('dependencies/authentication.py'));
    expect(routesAuth && depsAuth).toBeTruthy();
    const routesDeps = [...cg.getImpactRadius(routesAuth!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
    const depsDeps = [...cg.getImpactRadius(depsAuth!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
    expect(routesDeps.some((p) => p.endsWith('routes/api.py')), 'submodule under the imported package is the dependent').toBe(true);
    expect(depsDeps.some((p) => p.endsWith('routes/api.py')), 'same-named module in a sibling package is NOT').toBe(false);
  });
});

describe('Razor / Blazor markup extraction', () => {
  let tempDir: string;
  let cg: CodeGraph;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('links @model and Blazor component tags to their C# types; ignores HTML elements', async () => {
    fs.mkdirSync(path.join(tempDir, 'Views'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'LoginViewModel.cs'),
      `namespace App { public class LoginViewModel { public string Email { get; set; } } }`
    );
    fs.writeFileSync(
      path.join(tempDir, 'ToastComponent.cs'),
      `namespace App { public class ToastComponent { } }`
    );
    fs.writeFileSync(
      path.join(tempDir, 'Views/Login.cshtml'),
      `@model LoginViewModel\n<div class="form">\n  <input asp-for="Email" />\n</div>\n`
    );
    fs.writeFileSync(
      path.join(tempDir, 'Index.razor'),
      `<div>\n  <ToastComponent />\n</div>\n`
    );

    cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.resolveReferences();

    // `@model LoginViewModel` → the view-model class.
    const vm = cg.getNodesByKind('class').find((n) => n.name === 'LoginViewModel');
    expect(vm, 'LoginViewModel class').toBeDefined();
    const vmDeps = [...cg.getImpactRadius(vm!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
    expect(vmDeps.some((p) => p.endsWith('Login.cshtml')), '@model links the view').toBe(true);

    // `<ToastComponent />` → the component class.
    const toast = cg.getNodesByKind('class').find((n) => n.name === 'ToastComponent');
    expect(toast, 'ToastComponent class').toBeDefined();
    const toastDeps = [...cg.getImpactRadius(toast!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
    expect(toastDeps.some((p) => p.endsWith('Index.razor')), 'Blazor tag links the component').toBe(true);

    // HTML elements (`<div>`, `<input>`) must NOT become component references.
    const htmlNodes = cg.getNodesByKind('class').filter((n) => n.name === 'div' || n.name === 'input');
    expect(htmlNodes.length, 'no node for HTML elements').toBe(0);
  });

  it('C# namespaces qualify type names so same-named types are distinct', async () => {
    fs.writeFileSync(path.join(tempDir, 'entity.cs'), `namespace App.Entities { public class CatalogBrand { } }`);
    fs.writeFileSync(path.join(tempDir, 'dto.cs'), `namespace App.Models { public class CatalogBrand { } }`);

    cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();

    const brands = cg.getNodesByKind('class').filter((n) => n.name === 'CatalogBrand');
    expect(brands.length, 'both CatalogBrand classes indexed').toBe(2);
    const qns = brands.map((b) => b.qualifiedName).sort();
    expect(qns[0]).not.toBe(qns[1]); // distinct qualified names (namespace-scoped)
    expect(qns.some((q) => q.includes('Entities') && q.endsWith('CatalogBrand'))).toBe(true);
    expect(qns.some((q) => q.includes('Models') && q.endsWith('CatalogBrand'))).toBe(true);
  });

  it('disambiguates a Razor type ref via @using (incl. folder _Imports.razor)', async () => {
    // `CatalogBrand` exists as both a domain entity and a DTO; the component
    // `@using`s the DTO's namespace (here via the folder _Imports.razor), so the
    // ref must resolve to the DTO, not the same-named entity.
    fs.mkdirSync(path.join(tempDir, 'Models'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'Entities'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'Pages'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'Models/CatalogBrand.cs'), `namespace App.Models { public class CatalogBrand { public int Id { get; set; } } }`);
    fs.writeFileSync(path.join(tempDir, 'Entities/CatalogBrand.cs'), `namespace App.Entities { public class CatalogBrand { public int Id { get; set; } } }`);
    fs.writeFileSync(path.join(tempDir, 'Pages/_Imports.razor'), `@using App.Models\n`);
    fs.writeFileSync(
      path.join(tempDir, 'Pages/List.razor'),
      `<h1>List</h1>\n@code {\n  private CatalogBrand _b = new CatalogBrand();\n}\n`
    );

    cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.resolveReferences();

    const dto = cg.getNodesByKind('class').find((n) => n.qualifiedName === 'App.Models::CatalogBrand');
    const entity = cg.getNodesByKind('class').find((n) => n.qualifiedName === 'App.Entities::CatalogBrand');
    expect(dto && entity, 'both CatalogBrand classes').toBeTruthy();
    const dtoDeps = [...cg.getImpactRadius(dto!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
    const entityDeps = [...cg.getImpactRadius(entity!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
    expect(dtoDeps.some((p) => p.endsWith('List.razor')), 'resolves to the @using\'d DTO').toBe(true);
    expect(entityDeps.some((p) => p.endsWith('List.razor')), 'NOT the same-named entity').toBe(false);
  });

  it('delegates Blazor @code block C# to cover types used in component logic', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'CatalogService.cs'),
      `namespace App { public class CatalogService { public void Load() { } } }`
    );
    fs.writeFileSync(
      path.join(tempDir, 'List.razor'),
      `<h1>Catalog</h1>\n\n@code {\n  private CatalogService _svc = new CatalogService();\n  void Refresh() { _svc.Load(); }\n}\n`
    );

    cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.resolveReferences();

    const svc = cg.getNodesByKind('class').find((n) => n.name === 'CatalogService');
    expect(svc, 'CatalogService class').toBeDefined();
    const deps = [...cg.getImpactRadius(svc!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
    expect(deps.some((p) => p.endsWith('List.razor')), '@code usage links the component to the service').toBe(true);
  });
});

describe('Default import resolution (renamed default export)', () => {
  let tempDir: string;
  let cg: CodeGraph;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('links a renamed default import to the module file', async () => {
    // Express route aggregator: `import articlesController from './controller'`
    // where the module does `export default router`. The renamed local can't be
    // found as a symbol, so the controller file had no dependent — the dependency
    // is on the module file regardless of the default export's name.
    fs.mkdirSync(path.join(tempDir, 'app'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'app/controller.ts'), `const router = { get() {} };\nexport default router;\n`);
    fs.writeFileSync(path.join(tempDir, 'app/routes.ts'), `import myController from './controller';\nexport const api = myController;\n`);

    cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.resolveReferences();

    const controller = cg.getNodesByKind('file').find((n) => n.filePath.endsWith('app/controller.ts'));
    expect(controller, 'controller.ts indexed').toBeDefined();
    const deps = [...cg.getImpactRadius(controller!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
    expect(deps.some((p) => p.endsWith('routes.ts')), 'importer depends on the default-exporting module').toBe(true);
  });
});

describe('Chained method-call resolution (C# extension methods)', () => {
  let tempDir: string;
  let cg: CodeGraph;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('resolves a chained extension-method call (a.b.Method()) to its definition', async () => {
    // ASP.NET DI registration: `builder.Services.AddCoreServices(...)` calls a
    // static extension method elsewhere. A multi-dot receiver chain matched no
    // method-call pattern before, so the extension method had no caller.
    fs.mkdirSync(path.join(tempDir, 'cfg'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'cfg/Ext.cs'),
      `namespace App {\n  public static class Ext {\n    public static object AddCoreServices(this object services, int x) { return services; }\n  }\n}\n`
    );
    fs.writeFileSync(
      path.join(tempDir, 'Program.cs'),
      `namespace App {\n  public class Program {\n    public void Run(object builder) {\n      builder.Services.AddCoreServices(1);\n    }\n  }\n}\n`
    );

    cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.resolveReferences();

    const ext = cg
      .getNodesByKind('method')
      .find((n) => n.name === 'AddCoreServices')
      ?? cg.getNodesByKind('function').find((n) => n.name === 'AddCoreServices');
    expect(ext, 'AddCoreServices defined').toBeDefined();
    const callers = [...cg.getImpactRadius(ext!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
    expect(callers.some((p) => p.endsWith('Program.cs')), 'chained extension call resolves to its definition').toBe(true);
  });
});

describe('Same-directory include + KMP import resolution', () => {
  let tempDir: string;
  let cg: CodeGraph;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('a C/C++ #include resolves to the same-directory header, not a same-named one elsewhere', async () => {
    // A multi-platform native module has a header of the same basename per
    // platform. `windows/Provider.cpp`'s `#include "Storage.h"` means its OWN
    // sibling header — not `apple/Storage.h` (which sorts first and so was
    // picked arbitrarily before, leaving the real local header with 0 deps).
    fs.mkdirSync(path.join(tempDir, 'apple'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'windows'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'apple', 'Storage.h'), `#pragma once\nstruct Storage { int n; };\n`);
    fs.writeFileSync(path.join(tempDir, 'windows', 'Storage.h'), `#pragma once\nstruct Storage { int n; };\n`);
    fs.writeFileSync(
      path.join(tempDir, 'windows', 'Provider.cpp'),
      `#include "Storage.h"\nint use() { Storage s; return s.n; }\n`
    );

    cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.resolveReferences();

    const winHeader = cg.getNodesByKind('file').find((n) => n.filePath.endsWith('windows/Storage.h'));
    const appleHeader = cg.getNodesByKind('file').find((n) => n.filePath.endsWith('apple/Storage.h'));
    expect(winHeader, 'windows/Storage.h indexed').toBeDefined();
    expect(appleHeader, 'apple/Storage.h indexed').toBeDefined();
    const winDeps = [...cg.getImpactRadius(winHeader!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
    const appleDeps = [...cg.getImpactRadius(appleHeader!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
    expect(winDeps.some((p) => p.endsWith('Provider.cpp')), 'same-dir header gets the includer').toBe(true);
    expect(appleDeps.some((p) => p.endsWith('Provider.cpp')), 'other-platform header does NOT').toBe(false);
  });

  it('a Kotlin Multiplatform commonMain import resolves to the expect, not a platform actual', async () => {
    const common = path.join(tempDir, 'src/commonMain/kotlin/app');
    const android = path.join(tempDir, 'src/androidMain/kotlin/app');
    fs.mkdirSync(common, { recursive: true });
    fs.mkdirSync(android, { recursive: true });
    fs.writeFileSync(path.join(common, 'Platform.kt'), `package app\nexpect class PlatformContext\n`);
    fs.writeFileSync(path.join(android, 'Platform.android.kt'), `package app\nactual class PlatformContext\n`);
    fs.writeFileSync(
      path.join(common, 'Db.kt'),
      `package app\nimport app.PlatformContext\nclass Db {\n  fun open(ctx: PlatformContext) {}\n}\n`
    );

    cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.resolveReferences();

    const expectCtx = cg
      .getNodesByKind('class')
      .find((n) => n.name === 'PlatformContext' && n.filePath.endsWith('commonMain/kotlin/app/Platform.kt'));
    expect(expectCtx, 'commonMain expect PlatformContext').toBeDefined();
    const deps = [...cg.getImpactRadius(expectCtx!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
    expect(deps.some((p) => p.endsWith('Db.kt')), 'commonMain import lands on the expect, not the actual').toBe(true);
  });
});

describe('Delphi form code-behind pairing', () => {
  let tempDir: string;
  let cg: CodeGraph;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('links a `.dfm` form to its sibling `.pas` code-behind unit', async () => {
    // A Delphi form unit owns its visual form definition via `{$R *.dfm}`, not a
    // `uses` clause — so a `.dfm` used only as a form definition looked orphaned.
    fs.writeFileSync(path.join(tempDir, 'UFRMAbout.dfm'),
      `object FRMAbout: TFRMAbout\n  Caption = 'About'\nend\n`);
    fs.writeFileSync(path.join(tempDir, 'UFRMAbout.pas'),
      `unit UFRMAbout;\ninterface\nuses Forms;\ntype\n  TFRMAbout = class(TForm)\n  end;\nimplementation\n{$R *.dfm}\nend.\n`);

    cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.resolveReferences();

    const dfm = cg.getNodesByKind('file').find((n) => n.filePath.endsWith('UFRMAbout.dfm'));
    expect(dfm, 'UFRMAbout.dfm file node').toBeDefined();
    const deps = cg.getFileDependents(dfm!.filePath);
    expect(deps.some((p) => p.endsWith('UFRMAbout.pas')), 'the .pas unit links its .dfm form').toBe(true);
  });
});

describe('Liquid Shopify JSON template section resolution', () => {
  let tempDir: string;
  let cg: CodeGraph;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('links a Shopify JSON template section `type` to its sections/<type>.liquid', async () => {
    // Shopify OS 2.0 templates are JSON, referencing sections by `type` — not
    // a `{% section %}` Liquid tag — so a section used only from a JSON template
    // looked unused. The JSON is now indexed and its `type`s linked.
    fs.mkdirSync(path.join(tempDir, 'sections'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'templates/customers'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'sections/main-product.liquid'), `<div>{{ product.title }}</div>\n`);
    fs.writeFileSync(path.join(tempDir, 'sections/main-login.liquid'), `<form>{{ 'customer.login' | t }}</form>\n`);
    fs.writeFileSync(path.join(tempDir, 'templates/product.json'), JSON.stringify({ sections: { main: { type: 'main-product' } }, order: ['main'] }));
    // Nested template dir (templates/customers/login.json) must resolve too.
    fs.writeFileSync(path.join(tempDir, 'templates/customers/login.json'), JSON.stringify({ sections: { main: { type: 'main-login' } }, order: ['main'] }));

    cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.resolveReferences();

    const product = cg.getNodesByKind('file').find((n) => n.filePath.endsWith('sections/main-product.liquid'));
    const login = cg.getNodesByKind('file').find((n) => n.filePath.endsWith('sections/main-login.liquid'));
    expect(product, 'main-product section').toBeDefined();
    expect(login, 'main-login section').toBeDefined();
    expect(cg.getFileDependents(product!.filePath).some((p) => p.endsWith('templates/product.json')), 'top-level JSON template links its section').toBe(true);
    expect(cg.getFileDependents(login!.filePath).some((p) => p.endsWith('customers/login.json')), 'nested JSON template links its section').toBe(true);
  });
});

describe('Lua/Luau require resolution', () => {
  let tempDir: string;
  let cg: CodeGraph;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('resolves a dotted Lua require and an instance-path Luau require to their module files', async () => {
    // The require is the ONLY link (no method call), so coverage here proves the
    // require resolver specifically, not method-call name-matching.
    // Lua dotted module path: require("myapp.config") → lua/myapp/config.lua.
    fs.mkdirSync(path.join(tempDir, 'lua/myapp'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'lua/myapp/config.lua'), `local M = {}\nfunction M.setup() end\nreturn M\n`);
    fs.writeFileSync(path.join(tempDir, 'lua/myapp/init.lua'), `local config = require("myapp.config")\nreturn config\n`);
    // Luau Roblox instance-path require (only the leaf survives extraction):
    // require(script.Util.helper) → src/Util/helper.luau.
    fs.mkdirSync(path.join(tempDir, 'src/Util'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src/Util/helper.luau'), `local H = {}\nfunction H.go() end\nreturn H\n`);
    fs.writeFileSync(path.join(tempDir, 'src/init.luau'), `local helper = require(script.Util.helper)\nreturn helper\n`);

    cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.resolveReferences();

    const config = cg.getNodesByKind('file').find((n) => n.filePath.endsWith('myapp/config.lua'));
    const helper = cg.getNodesByKind('file').find((n) => n.filePath.endsWith('Util/helper.luau'));
    expect(config, 'config.lua file node').toBeDefined();
    expect(helper, 'helper.luau file node').toBeDefined();
    const cfgDeps = cg.getFileDependents(config!.filePath);
    const helpDeps = cg.getFileDependents(helper!.filePath);
    expect(cfgDeps.some((p) => p.endsWith('myapp/init.lua')), 'dotted Lua require resolves to the module').toBe(true);
    expect(helpDeps.some((p) => p.endsWith('src/init.luau')), 'instance-path Luau require resolves to the module').toBe(true);
  });
});

describe('Rust module-path call resolution', () => {
  let tempDir: string;
  let cg: CodeGraph;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('a bare submodule call (`users::router()`) resolves self-relative to the submodule fn', async () => {
    // The canonical Axum router-assembly pattern: a parent module calls each
    // submodule's `router()`. `users::` / `profiles::` are SELF-relative
    // submodule prefixes (2018 edition) — `mod users;` makes `users` a child of
    // the CURRENT module, NOT `crate::users`. Before the fix the bare prefix was
    // resolved crate-relative only (looking for `src/users.rs`), so it found
    // nothing and the handler modules looked dependent-less.
    const http = path.join(tempDir, 'src/http');
    fs.mkdirSync(http, { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src/lib.rs'), `pub mod http;\n`);
    fs.writeFileSync(
      path.join(http, 'mod.rs'),
      `mod users;\nmod profiles;\npub fn api_router() {\n    users::router();\n    profiles::router();\n}\n`
    );
    fs.writeFileSync(path.join(http, 'users.rs'), `pub fn router() -> i32 { 1 }\n`);
    fs.writeFileSync(path.join(http, 'profiles.rs'), `pub fn router() -> i32 { 2 }\n`);

    cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.resolveReferences();

    // Each submodule's same-named `router` fn must get mod.rs as a dependent —
    // proving the bare prefix resolved self-relative AND disambiguated the
    // colliding `router` name to the correct file (not an arbitrary one).
    const routers = cg.getNodesByKind('function').filter((n) => n.name === 'router');
    const usersRouter = routers.find((n) => n.filePath.endsWith('http/users.rs'));
    const profilesRouter = routers.find((n) => n.filePath.endsWith('http/profiles.rs'));
    expect(usersRouter, 'users.rs router fn').toBeDefined();
    expect(profilesRouter, 'profiles.rs router fn').toBeDefined();
    const usersDeps = [...cg.getImpactRadius(usersRouter!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
    const profilesDeps = [...cg.getImpactRadius(profilesRouter!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
    expect(usersDeps.some((p) => p.endsWith('http/mod.rs')), 'users::router() lands on users.rs').toBe(true);
    expect(profilesDeps.some((p) => p.endsWith('http/mod.rs')), 'profiles::router() lands on profiles.rs').toBe(true);
  });

  it('a 3-segment module-path call (`database::profiles::find()`) resolves to the leaf fn', async () => {
    // A 2-level module path — the common `db.run(move |c| database::profiles::find(c))`
    // / `crate::a::b::func()` shape. The reference-resolver pre-filter used to drop any
    // `a::b::c` whose leaf it never checked (it tested only the first segment and the
    // `b::c` remainder, neither of which names a symbol), so the call never reached the
    // Rust path resolver and the leaf module looked dependent-less.
    const routes = path.join(tempDir, 'src/routes');
    const database = path.join(tempDir, 'src/database');
    fs.mkdirSync(routes, { recursive: true });
    fs.mkdirSync(database, { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src/lib.rs'), `pub mod routes;\npub mod database;\n`);
    fs.writeFileSync(path.join(database, 'mod.rs'), `pub mod profiles;\n`);
    fs.writeFileSync(path.join(database, 'profiles.rs'), `pub fn find(id: i32) -> i32 { id }\n`);
    fs.writeFileSync(
      path.join(routes, 'mod.rs'),
      `use crate::database;\npub fn get_profile(id: i32) -> i32 {\n    database::profiles::find(id)\n}\n`
    );

    cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.resolveReferences();

    const find = cg
      .getNodesByKind('function')
      .find((n) => n.name === 'find' && n.filePath.endsWith('database/profiles.rs'));
    expect(find, 'database/profiles.rs find fn').toBeDefined();
    const deps = [...cg.getImpactRadius(find!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
    expect(deps.some((p) => p.endsWith('routes/mod.rs')), 'database::profiles::find() resolves to the leaf fn').toBe(true);
  });

  it('Rocket `routes![…]` / `catchers![…]` macros link the mount to the handler fns', async () => {
    // Tree-sitter leaves the macro body as a raw token tree, so the handler
    // paths inside `routes![a::b::handler, …]` are invisible to the call walker
    // and the handlers — mounted by Rocket at runtime, not called in-repo — look
    // like they have no caller. The route-macro extractor reconstructs each path
    // and emits a reference, which the Rust path resolver links to the handler.
    const routes = path.join(tempDir, 'src/routes');
    fs.mkdirSync(routes, { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src/lib.rs'),
      `mod routes;\nfn not_found() {}\npub fn rocket() {\n` +
      `    rocket::build()\n` +
      `        .mount("/api", routes![routes::users::post_users, routes::users::get_user])\n` +
      `        .register("/", catchers![not_found]);\n}\n`);
    fs.writeFileSync(path.join(routes, 'mod.rs'), `pub mod users;\n`);
    fs.writeFileSync(path.join(routes, 'users.rs'), `pub fn post_users() {}\npub fn get_user() {}\n`);

    cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.resolveReferences();

    const handlers = cg.getNodesByKind('function').filter((n) => n.filePath.endsWith('routes/users.rs'));
    expect(handlers.length, 'both handler fns indexed').toBe(2);
    for (const h of handlers) {
      const deps = [...cg.getImpactRadius(h.id, 2).nodes.values()].map((n) => n.filePath ?? '');
      expect(deps.some((p) => p.endsWith('lib.rs')), `routes![] links ${h.name} to its mount in lib.rs`).toBe(true);
    }
  });
});

describe('SvelteKit load → page synthesizer', () => {
  let tempDir: string;
  let cg: CodeGraph;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('links a +page.svelte to its OWN directory\'s +page.server.js load, not another route\'s', async () => {
    // SvelteKit wires +page.server.js's `load` to +page.svelte's `data` BY FILE
    // PATH — there is no static import — so editing a loader showed no impact on
    // the page it feeds. The synthesizer links each page component to the `load`
    // in its OWN directory (path-deterministic, so it never crosses routes).
    const login = path.join(tempDir, 'src/routes/login');
    const register = path.join(tempDir, 'src/routes/register');
    fs.mkdirSync(login, { recursive: true });
    fs.mkdirSync(register, { recursive: true });
    fs.writeFileSync(path.join(login, '+page.svelte'), `<script>export let data;</script>\n<h1>Login {data.x}</h1>\n`);
    fs.writeFileSync(path.join(login, '+page.server.js'), `export function load() { return { x: 1 }; }\n`);
    fs.writeFileSync(path.join(register, '+page.svelte'), `<script>export let data;</script>\n<h1>Register</h1>\n`);
    fs.writeFileSync(path.join(register, '+page.server.js'), `export function load() { return { y: 2 }; }\n`);

    cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.resolveReferences();

    const loginLoad = cg
      .getNodesByKind('function')
      .find((n) => n.name === 'load' && n.filePath.endsWith('login/+page.server.js'));
    expect(loginLoad, 'login load fn').toBeDefined();
    const impacted = [...cg.getImpactRadius(loginLoad!.id, 3).nodes.values()].map((n) => n.filePath ?? '');
    // editing login's load surfaces login's page (the framework-wired data flow)…
    expect(impacted.some((p) => p.endsWith('login/+page.svelte')), 'load links to its own page').toBe(true);
    // …but never register's page (same-directory only).
    expect(impacted.some((p) => p.endsWith('register/+page.svelte')), 'does not cross routes').toBe(false);
  });
});

describe('Nuxt nested auto-imported component resolution', () => {
  let tempDir: string;
  let cg: CodeGraph;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('links a `<MediaCard/>` usage to components/media/Card.vue (Nuxt dir-prefixed auto-import)', async () => {
    // Nuxt auto-imports a nested component by a DIRECTORY-PREFIXED name —
    // components/media/Card.vue is used as <MediaCard/>, not <Card/> — but the
    // component node is named by basename (`Card`), so the PascalCase usage
    // didn't resolve and the nested component looked unused.
    const media = path.join(tempDir, 'components/media');
    fs.mkdirSync(media, { recursive: true });
    fs.writeFileSync(path.join(media, 'Card.vue'), `<template><div>card</div></template>\n<script setup>defineProps(['item'])</script>\n`);
    fs.writeFileSync(
      path.join(tempDir, 'components/Grid.vue'),
      `<template>\n  <div><MediaCard :item="i" /></div>\n</template>\n<script setup>const i = {}</script>\n`
    );

    cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.resolveReferences();

    const card = cg.getNodesByKind('component').find((n) => n.filePath.endsWith('media/Card.vue'));
    expect(card, 'media/Card.vue component').toBeDefined();
    const deps = [...cg.getImpactRadius(card!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
    expect(deps.some((p) => p.endsWith('components/Grid.vue')), '<MediaCard> links Grid to media/Card.vue').toBe(true);
  });
});

describe('Swift property-wrapper attribute type references', () => {
  let tempDir: string;
  let cg: CodeGraph;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('a Fluent `@Siblings(through: Pivot.self)` links the model to the pivot type', async () => {
    // A many-to-many pivot/join model is referenced ONLY through the relationship
    // property wrapper's metatype argument (`Pivot.self`), never by a controller
    // query. The wrapper type was captured but the argument expression wasn't
    // walked, so the pivot model looked like nothing depended on it.
    fs.writeFileSync(path.join(tempDir, 'Pivot.swift'),
      `import Fluent\nfinal class AcronymCategoryPivot: Model {\n  static let schema = "acronym-category"\n}\n`);
    fs.writeFileSync(path.join(tempDir, 'Acronym.swift'),
      `import Fluent\nfinal class Acronym: Model {\n` +
      `  @Siblings(through: AcronymCategoryPivot.self, from: \\.$acronym, to: \\.$category)\n` +
      `  var categories: [Category]\n}\n`);

    cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.resolveReferences();

    const pivot = cg.getNodesByKind('class').find((n) => n.name === 'AcronymCategoryPivot');
    expect(pivot, 'pivot model class').toBeDefined();
    const deps = [...cg.getImpactRadius(pivot!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
    expect(deps.some((p) => p.endsWith('Acronym.swift')), '@Siblings metatype arg links Acronym to the pivot').toBe(true);
  });
});

describe('Objective-C messages, class receivers, and #import', () => {
  let tempDir: string;
  let cg: CodeGraph;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('resolves single-arg selectors, class-message receivers, and #import headers', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'SDImageCache.h'),
      `#import <Foundation/Foundation.h>
@interface SDImageCache : NSObject
+ (instancetype)sharedCache;
+ (void)storeImage:(NSString *)key;
@end
`
    );
    fs.writeFileSync(
      path.join(tempDir, 'SDImageCache.m'),
      `#import "SDImageCache.h"
@implementation SDImageCache
+ (instancetype)sharedCache { return nil; }
+ (void)storeImage:(NSString *)key { }
@end
`
    );
    fs.writeFileSync(
      path.join(tempDir, 'SDManager.m'),
      `#import "SDImageCache.h"
@interface SDManager : NSObject
@end
@implementation SDManager
- (void)run {
  [SDImageCache sharedCache];
  [SDImageCache storeImage:@"k"];
}
@end
`
    );

    cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.resolveReferences();

    // 1. The single-argument selector `[SDImageCache storeImage:@"k"]` resolves
    //    to the `storeImage:` method — named WITH its colon both at the call site
    //    and the definition (before the fix the call site dropped the colon).
    const storeImage = cg.getNodesByKind('method').find((n) => n.name === 'storeImage:');
    expect(storeImage, 'storeImage: method').toBeDefined();
    const storeCallers = [...cg.getImpactRadius(storeImage!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
    expect(storeCallers.some((p) => p.endsWith('SDManager.m'))).toBe(true);

    // 2. The class-message receiver `[SDImageCache sharedCache]` references the
    //    SDImageCache class (whose @interface lives in the header).
    const cache = cg.getNodesByKind('class').find((n) => n.name === 'SDImageCache');
    expect(cache, 'SDImageCache class').toBeDefined();
    const classDeps = [...cg.getImpactRadius(cache!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
    expect(classDeps.some((p) => p.endsWith('SDManager.m'))).toBe(true);

    // 3. `#import "SDImageCache.h"` resolves to the header FILE — editing it
    //    surfaces both importers.
    const header = cg.getNodesByKind('file').find((n) => n.filePath.endsWith('SDImageCache.h'));
    expect(header, 'SDImageCache.h indexed').toBeDefined();
    const importers = [...cg.getImpactRadius(header!.id, 2).nodes.values()].map((n) => n.filePath ?? '');
    expect(importers.some((p) => p.endsWith('SDManager.m'))).toBe(true);
  });
});

describe('Full Indexing', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should index a TypeScript file', async () => {
    // Create test file
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(
      path.join(srcDir, 'utils.ts'),
      `
export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}
`
    );

    // Initialize and index
    const cg = CodeGraph.initSync(tempDir);
    const result = await cg.indexAll();

    expect(result.success).toBe(true);
    expect(result.filesIndexed).toBe(1);
    expect(result.nodesCreated).toBeGreaterThanOrEqual(2);

    // Check nodes were stored
    const nodes = cg.getNodesInFile('src/utils.ts');
    expect(nodes.length).toBeGreaterThanOrEqual(2);

    const addFunc = nodes.find((n) => n.name === 'add');
    expect(addFunc).toBeDefined();
    expect(addFunc?.kind).toBe('function');

    cg.close();
  });

  it('should index multiple files', async () => {
    // Create test files
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir);

    fs.writeFileSync(
      path.join(srcDir, 'math.ts'),
      `export function add(a: number, b: number) { return a + b; }`
    );

    fs.writeFileSync(
      path.join(srcDir, 'string.ts'),
      `export function capitalize(s: string) { return s.toUpperCase(); }`
    );

    // Initialize and index
    const cg = CodeGraph.initSync(tempDir);
    const result = await cg.indexAll();

    expect(result.success).toBe(true);
    expect(result.filesIndexed).toBe(2);

    const files = cg.getFiles();
    expect(files.length).toBe(2);

    cg.close();
  });

  it('should track file hashes for incremental updates', async () => {
    // Create initial file
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'main.ts'), `export const x = 1;`);

    // Initialize and index
    const cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();

    // Check file is tracked
    const file = cg.getFile('src/main.ts');
    expect(file).toBeDefined();
    expect(file?.contentHash).toBeDefined();

    // Modify file
    fs.writeFileSync(path.join(srcDir, 'main.ts'), `export const x = 2;`);

    // Check for changes
    const changes = cg.getChangedFiles();
    expect(changes.modified).toContain('src/main.ts');

    cg.close();
  });

  it('should sync and detect changes', async () => {
    // Create initial file
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(
      path.join(srcDir, 'main.ts'),
      `export function original() { return 1; }`
    );

    // Initialize and index
    const cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();

    const initialNodes = cg.getNodesInFile('src/main.ts');
    expect(initialNodes.some((n) => n.name === 'original')).toBe(true);

    // Modify file
    fs.writeFileSync(
      path.join(srcDir, 'main.ts'),
      `export function updated() { return 2; }`
    );

    // Sync
    const syncResult = await cg.sync();
    expect(syncResult.filesModified).toBe(1);

    // Check nodes were updated
    const updatedNodes = cg.getNodesInFile('src/main.ts');
    expect(updatedNodes.some((n) => n.name === 'updated')).toBe(true);
    expect(updatedNodes.some((n) => n.name === 'original')).toBe(false);

    cg.close();
  });

  it('should count file-level tracked YAML files as indexed', async () => {
    fs.writeFileSync(path.join(tempDir, 'app.yaml'), 'name: test\n');
    fs.writeFileSync(path.join(tempDir, 'routes.yml'), 'route: value\n');

    const cg = CodeGraph.initSync(tempDir);
    const result = await cg.indexAll();

    expect(result.success).toBe(true);
    expect(result.filesIndexed).toBe(2);
    expect(result.filesSkipped).toBe(0);
    expect(cg.getFiles().map((f) => f.path).sort()).toEqual(['app.yaml', 'routes.yml']);

    cg.close();
  });

  it('should count file-level tracked YAML/Twig files as indexed in indexFiles()', async () => {
    fs.writeFileSync(path.join(tempDir, 'app.yaml'), 'name: test\n');
    fs.writeFileSync(path.join(tempDir, 'view.twig'), '{{ title }}\n');

    const cg = CodeGraph.initSync(tempDir);
    const result = await cg.indexFiles(['app.yaml', 'view.twig']);

    expect(result.success).toBe(true);
    expect(result.filesIndexed).toBe(2);
    expect(result.filesSkipped).toBe(0);

    const tracked = cg.getFiles().map((f) => `${f.path}:${f.language}`).sort();
    expect(tracked).toEqual(['app.yaml:yaml', 'view.twig:twig']);

    cg.close();
  });

  it('should count file-level tracked .properties files as indexed', async () => {
    fs.writeFileSync(path.join(tempDir, 'application.properties'), 'server.port=8080\n');
    fs.writeFileSync(path.join(tempDir, 'log.properties'), 'log.level=INFO\n');

    const cg = CodeGraph.initSync(tempDir);
    const result = await cg.indexAll();

    expect(result.success).toBe(true);
    expect(result.filesIndexed).toBe(2);
    expect(result.filesSkipped).toBe(0);

    cg.close();
  });

  it('should count the full file-level tracked class (yaml/twig/properties) in indexFiles()', async () => {
    fs.writeFileSync(path.join(tempDir, 'app.yaml'), 'name: test\n');
    fs.writeFileSync(path.join(tempDir, 'view.twig'), '{{ title }}\n');
    fs.writeFileSync(path.join(tempDir, 'application.properties'), 'server.port=8080\n');

    const cg = CodeGraph.initSync(tempDir);
    const result = await cg.indexFiles(['app.yaml', 'view.twig', 'application.properties']);

    expect(result.success).toBe(true);
    expect(result.filesIndexed).toBe(3);
    expect(result.filesSkipped).toBe(0);

    const tracked = cg.getFiles().map((f) => `${f.path}:${f.language}`).sort();
    expect(tracked).toEqual(['app.yaml:yaml', 'application.properties:properties', 'view.twig:twig']);

    cg.close();
  });
});

describe('Path Normalization', () => {
  it('should convert backslashes to forward slashes', () => {
    expect(normalizePath('gui\\node_modules\\foo')).toBe('gui/node_modules/foo');
    expect(normalizePath('src\\components\\Button.tsx')).toBe('src/components/Button.tsx');
  });

  it('should leave forward-slash paths unchanged', () => {
    expect(normalizePath('src/components/Button.tsx')).toBe('src/components/Button.tsx');
  });

  it('should handle empty string', () => {
    expect(normalizePath('')).toBe('');
  });
});

describe('Directory Exclusion', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should exclude directories listed in .gitignore', () => {
    // Create structure: src/index.ts + node_modules/pkg/index.js, gitignore node_modules
    const srcDir = path.join(tempDir, 'src');
    const nmDir = path.join(tempDir, 'node_modules', 'pkg');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(nmDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'index.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(nmDir, 'index.js'), 'module.exports = {};');
    fs.writeFileSync(path.join(tempDir, '.gitignore'), 'node_modules/\n');

    const files = scanDirectory(tempDir);

    expect(files).toContain('src/index.ts');
    expect(files.every((f) => !f.includes('node_modules'))).toBe(true);
  });

  it('should exclude nested node_modules via a root .gitignore', () => {
    // A trailing-slash pattern with no leading slash matches at any depth.
    const srcDir = path.join(tempDir, 'packages', 'app', 'src');
    const nmDir = path.join(tempDir, 'packages', 'app', 'node_modules', 'pkg');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(nmDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'index.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(nmDir, 'index.js'), 'module.exports = {};');
    fs.writeFileSync(path.join(tempDir, '.gitignore'), 'node_modules/\n');

    const files = scanDirectory(tempDir);

    expect(files).toContain('packages/app/src/index.ts');
    expect(files.every((f) => !f.includes('node_modules'))).toBe(true);
  });

  it('should apply a nested .gitignore only to its own subtree', () => {
    const appSrc = path.join(tempDir, 'app', 'src');
    fs.mkdirSync(appSrc, { recursive: true });
    fs.writeFileSync(path.join(appSrc, 'keep.ts'), 'export const a = 1;');
    fs.writeFileSync(path.join(appSrc, 'skip.ts'), 'export const b = 2;');
    fs.writeFileSync(path.join(tempDir, 'app', '.gitignore'), 'src/skip.ts\n');
    // A sibling with the same name outside app/ must NOT be ignored.
    const otherDir = path.join(tempDir, 'other', 'src');
    fs.mkdirSync(otherDir, { recursive: true });
    fs.writeFileSync(path.join(otherDir, 'skip.ts'), 'export const c = 3;');

    const files = scanDirectory(tempDir);

    expect(files).toContain('app/src/keep.ts');
    expect(files).not.toContain('app/src/skip.ts');
    expect(files).toContain('other/src/skip.ts');
  });

  it('should always skip .git directories', () => {
    const srcDir = path.join(tempDir, 'src');
    const gitDir = path.join(tempDir, '.git', 'objects');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'index.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(gitDir, 'pack.ts'), 'export const y = 2;');

    const files = scanDirectory(tempDir);

    expect(files).toContain('src/index.ts');
    expect(files.every((f) => !f.includes('.git'))).toBe(true);
  });

  it('should return forward-slash paths on all platforms', () => {
    const srcDir = path.join(tempDir, 'src', 'components');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'Button.tsx'), 'export function Button() {}');

    const files = scanDirectory(tempDir);

    expect(files.length).toBe(1);
    expect(files[0]).toBe('src/components/Button.tsx');
    expect(files[0]).not.toContain('\\');
  });
});

describe('Git Submodules', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should index files inside git submodules (issue #147)', async () => {
    const { execFileSync } = await import('child_process');
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, stdio: 'pipe' });

    // Build a separate "library" repo to use as a submodule source.
    const libDir = path.join(tempDir, '_lib');
    fs.mkdirSync(libDir, { recursive: true });
    git(libDir, 'init', '-q');
    git(libDir, 'config', 'user.email', 'test@test.com');
    git(libDir, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(libDir, 'lib.ts'), 'export const fromSubmodule = 1;');
    git(libDir, 'add', '-A');
    git(libDir, 'commit', '-q', '-m', 'lib init');

    // Build the main repo and add the lib repo as a submodule.
    const mainDir = path.join(tempDir, 'main');
    fs.mkdirSync(mainDir, { recursive: true });
    git(mainDir, 'init', '-q');
    git(mainDir, 'config', 'user.email', 'test@test.com');
    git(mainDir, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(mainDir, 'app.ts'), 'export const app = 1;');
    git(mainDir, 'add', '-A');
    git(mainDir, 'commit', '-q', '-m', 'app init');
    // protocol.file.allow=always is required to add a local-path submodule on
    // recent git versions (CVE-2022-39253 mitigation).
    execFileSync(
      'git',
      ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', libDir, 'libs/lib'],
      { cwd: mainDir, stdio: 'pipe' }
    );
    git(mainDir, 'commit', '-q', '-m', 'add submodule');

    const files = scanDirectory(mainDir);

    expect(files).toContain('app.ts');
    expect(files).toContain('libs/lib/lib.ts');
  });
});

describe('Nested non-submodule git repos', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should index files in embedded git repos run from a git super-repo (issue #193)', async () => {
    const { execFileSync } = await import('child_process');
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, stdio: 'pipe' });

    // Top-level workspace is itself a git repo, holding no source directly —
    // the CMake "super-repo" layout from the issue.
    const root = path.join(tempDir, 'root');
    fs.mkdirSync(path.join(root, 'coding'), { recursive: true });
    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 'test@test.com');
    git(root, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(root, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.10)\n');

    // Two independent clones living inside the workspace (NOT submodules):
    // one with committed source, one with only untracked source.
    const sub1 = path.join(root, 'sub_repo1', 'src');
    fs.mkdirSync(sub1, { recursive: true });
    git(path.join(root, 'sub_repo1'), 'init', '-q');
    git(path.join(root, 'sub_repo1'), 'config', 'user.email', 'test@test.com');
    git(path.join(root, 'sub_repo1'), 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(sub1, 'one.ts'), 'export const one = 1;');
    git(path.join(root, 'sub_repo1'), 'add', '-A');
    git(path.join(root, 'sub_repo1'), 'commit', '-q', '-m', 'sub1 init');

    const sub2 = path.join(root, 'sub_repo2', 'src');
    fs.mkdirSync(sub2, { recursive: true });
    git(path.join(root, 'sub_repo2'), 'init', '-q');
    fs.writeFileSync(path.join(sub2, 'two.ts'), 'export const two = 2;');

    const files = scanDirectory(root);

    // Both committed and untracked source from the nested repos must be found.
    expect(files).toContain('sub_repo1/src/one.ts');
    expect(files).toContain('sub_repo2/src/two.ts');
  });

  it('should respect each embedded repo\'s own .gitignore', async () => {
    const { execFileSync } = await import('child_process');
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, stdio: 'pipe' });

    const root = path.join(tempDir, 'root');
    fs.mkdirSync(root, { recursive: true });
    git(root, 'init', '-q');

    const sub = path.join(root, 'sub_repo', 'src');
    fs.mkdirSync(sub, { recursive: true });
    git(path.join(root, 'sub_repo'), 'init', '-q');
    fs.writeFileSync(path.join(root, 'sub_repo', '.gitignore'), 'src/generated.ts\n');
    fs.writeFileSync(path.join(sub, 'real.ts'), 'export const real = 1;');
    fs.writeFileSync(path.join(sub, 'generated.ts'), 'export const generated = 1;');

    const files = scanDirectory(root);

    expect(files).toContain('sub_repo/src/real.ts');
    expect(files).not.toContain('sub_repo/src/generated.ts');
  });

  // A .gitignore the `ignore` library can't compile to a regex must not abort
  // the whole scan — the bad pattern is dropped, valid ones still apply (#682).
  it('does not crash on a .gitignore with an uncompilable pattern (#682)', () => {
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'build'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'real.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(tempDir, 'build', 'out.ts'), 'export const y = 2;');
    // `\\[` makes the matcher build an unterminated character class — the throw
    // is lazy (at match time), which is what escaped and killed sync.
    fs.writeFileSync(path.join(tempDir, '.gitignore'), 'build/\n\\\\[\n');

    let files: string[] = [];
    expect(() => {
      files = scanDirectory(tempDir);
    }).not.toThrow();
    expect(files).toContain('src/real.ts');
    // The still-valid `build/` rule is honored; only the bad line was dropped.
    expect(files.some((f) => f.startsWith('build/'))).toBe(false);
  });

  // A .gitignore that isn't valid UTF-8 — e.g. encrypted in place by corporate
  // DLP / endpoint software (UTF-16 header + ciphertext) — is skipped whole,
  // not fed to the matcher as garbage patterns (#682).
  it('does not crash on a non-UTF-8 (DLP-encrypted) .gitignore (#682)', () => {
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'real.ts'), 'export const x = 1;');
    const header = Buffer.concat([
      Buffer.from([0x00, 0x00]),
      Buffer.from('[notice][user]', 'utf16le'),
    ]);
    const junk = Buffer.from([0x5b, 0x99, 0xc3, 0x28, 0x5c, 0x5b, 0xff, 0xfd]);
    fs.writeFileSync(path.join(tempDir, '.gitignore'), Buffer.concat([header, junk]));

    let files: string[] = [];
    expect(() => {
      files = scanDirectory(tempDir);
    }).not.toThrow();
    expect(files).toContain('src/real.ts');
  });

  it('buildDefaultIgnore survives a bad .gitignore and still applies valid rules (#682)', () => {
    fs.writeFileSync(path.join(tempDir, '.gitignore'), 'dist/\n\\\\[\n');
    const ig = buildDefaultIgnore(tempDir);
    expect(() => ig.ignores('src/app.ts')).not.toThrow();
    expect(ig.ignores('dist/')).toBe(true); // valid rule survives
    expect(ig.ignores('src/app.ts')).toBe(false);
  });

  it('.codegraphignore adds extra excludes on top of .gitignore', () => {
    fs.writeFileSync(path.join(tempDir, '.gitignore'), 'node_modules/\n');
    fs.writeFileSync(path.join(tempDir, '.codegraphignore'), 'generated/\n');
    const ig = buildDefaultIgnore(tempDir);
    expect(ig.ignores('node_modules/')).toBe(true);  // from .gitignore
    expect(ig.ignores('generated/')).toBe(true);      // from .codegraphignore
    expect(ig.ignores('src/app.ts')).toBe(false);     // not ignored
  });

  it('.codegraphignore negation overrides a rule from a lower layer', () => {
    fs.writeFileSync(path.join(tempDir, '.codegraphignore'), '!dist/\n');
    const ig = buildDefaultIgnore(tempDir);
    expect(ig.ignores('node_modules/')).toBe(true); // default still applies
    expect(ig.ignores('dist/')).toBe(false);        // negation in .codegraphignore
    expect(ig.ignores('src/app.ts')).toBe(false);
  });

  it('.codegraphignore survives bad patterns like .gitignore does', () => {
    fs.writeFileSync(path.join(tempDir, '.codegraphignore'), 'generated/\n\\\\[\n');
    const ig = buildDefaultIgnore(tempDir);
    expect(() => ig.ignores('src/app.ts')).not.toThrow();
    expect(ig.ignores('generated/')).toBe(true); // valid rule survives
    expect(ig.ignores('src/app.ts')).toBe(false);
  });

  // ── Whitelist dialect: a ROOT-ANCHORED negation in .codegraphignore may
  // re-include a path below an excluded parent. Git's spec forbids this (an
  // excluded parent short-circuits everything below), and `/*` +
  // `!/hert_bbu/bbu/api/` used to exclude the whole project. CodeGraph
  // auto-expands such negations into the spec-compliant per-level form, so
  // the natural whitelist spelling now works — identical to hand-writing
  // the expansion. ──

  it('whitelist dialect: anchored negation re-includes a nested subtree under /*', () => {
    fs.writeFileSync(path.join(tempDir, '.codegraphignore'), '/*\n!/hert_bbu/bbu/api/\n');
    const ig = buildDefaultIgnore(tempDir);
    expect(ig.ignores('hert_bbu/bbu/api/api.cpp')).toBe(false); // re-included subtree
    expect(ig.ignores('hert_bbu/bbu/bbu_other.cpp')).toBe(true); // sibling of api/ excluded
    expect(ig.ignores('hert_bbu/hert_top.cpp')).toBe(true); // parent-level content excluded
    expect(ig.ignores('src/main.cpp')).toBe(true);           // everything else excluded
    expect(ig.ignores('main.cpp')).toBe(true);              // root-level file excluded
  });

  it('whitelist dialect is equivalent to the hand-written per-level form', () => {
    // A user who already hand-wrote the spec-compliant expansion keeps the
    // exact same result — the dialect adds rules, never contradicts them.
    fs.writeFileSync(path.join(tempDir, '.codegraphignore'), '/*\n!/hert_bbu/\n/hert_bbu/*\n!/hert_bbu/bbu/\n/hert_bbu/bbu/*\n!/hert_bbu/bbu/api/\n');
    const ig = buildDefaultIgnore(tempDir);
    expect(ig.ignores('hert_bbu/bbu/api/api.cpp')).toBe(false);
    expect(ig.ignores('hert_bbu/bbu/bbu_other.cpp')).toBe(true);
    expect(ig.ignores('src/main.cpp')).toBe(true);
  });

  it('whitelist dialect works through the real filesystem walk', () => {
    for (const [dir, file] of [
      ['hert_bbu/bbu/api', 'api.cpp'],
      ['hert_bbu/bbu', 'other.cpp'],
      ['src', 'main.cpp'],
    ] as const) {
      fs.mkdirSync(path.join(tempDir, dir), { recursive: true });
      fs.writeFileSync(path.join(tempDir, dir, file), 'int f() { return 0; }\n');
    }
    fs.writeFileSync(path.join(tempDir, '.codegraphignore'), '/*\n!/hert_bbu/bbu/api/\n');

    const files = scanDirectory(tempDir);

    expect(files).toContain('hert_bbu/bbu/api/api.cpp');
    expect(files.every((f) => f !== 'src/main.cpp' && f !== 'hert_bbu/bbu/other.cpp')).toBe(true);
  });

  it('whitelist dialect: sibling negations share one /*-level exclusion without clobbering each other', () => {
    fs.writeFileSync(path.join(tempDir, '.codegraphignore'), '/*\n!/a/b/\n!/a/c/\n');
    const ig = buildDefaultIgnore(tempDir);
    expect(ig.ignores('a/b/keep.cpp')).toBe(false);
    expect(ig.ignores('a/c/keep.cpp')).toBe(false);
    expect(ig.ignores('a/other.cpp')).toBe(true); // a/ content outside b/ and c/ excluded
  });

  it('whitelist dialect: a bare-FILE anchored negation re-includes the file itself', () => {
    fs.writeFileSync(path.join(tempDir, '.codegraphignore'), '/*\n!/a/b/c.cpp\n');
    const ig = buildDefaultIgnore(tempDir);
    expect(ig.ignores('a/b/c.cpp')).toBe(false); // the named file re-included
    expect(ig.ignores('a/b/d.cpp')).toBe(true); // its sibling stays excluded
  });

  it('non-anchored negations keep plain git semantics (dialect does not expand them)', () => {
    fs.writeFileSync(path.join(tempDir, '.gitignore'), 'generated/\n');
    fs.writeFileSync(path.join(tempDir, '.codegraphignore'), '!dist/\n');
    const ig = buildDefaultIgnore(tempDir);
    expect(ig.ignores('dist/')).toBe(false);     // negation still overrides a lower layer
    expect(ig.ignores('generated/')).toBe(true); // .gitignore rule still applies
  });

  it('glob negations keep plain git semantics (no expansion, parent still short-circuits)', () => {
    fs.writeFileSync(path.join(tempDir, '.codegraphignore'), '/*\n!/a/*/keep/\n');
    const ig = buildDefaultIgnore(tempDir);
    // `a/` is excluded by /* and a glob negation names no concrete level to
    // re-include, so stock git semantics leave the whole tree excluded.
    expect(ig.ignores('a/x/keep/k.cpp')).toBe(true);
  });

  it('expandAnchoredNegations emits per-level rules and merges shared prefixes', () => {
    expect(expandAnchoredNegations('/*\n!/hert_bbu/bbu/api/\n')).toEqual([
      '!/hert_bbu/', '/hert_bbu/*',
      '!/hert_bbu/bbu/', '/hert_bbu/bbu/*',
      '!/hert_bbu/bbu/api/',
    ]);
    expect(expandAnchoredNegations('!/a/b/\n!/a/c/\n')).toEqual([
      '!/a/', '/a/*', '!/a/b/', '!/a/c/',
    ]);
    expect(expandAnchoredNegations('!/a/b/c.cpp\n')).toEqual([
      '!/a/', '/a/*', '!/a/b/', '/a/b/*', '!/a/b/c.cpp/', '!/a/b/c.cpp',
    ]);
    expect(expandAnchoredNegations('!dist/\n')).toEqual([]);   // not root-anchored
    expect(expandAnchoredNegations('!/a/*/c/\n')).toEqual([]); // glob — left to git semantics
    expect(expandAnchoredNegations('')).toEqual([]);
  });

  // .codegraphignore with negation (!) in a git repo: git ls-files won't
  // report the re-included files (they're gitignored), so the fast path
  // must fall back to a filesystem walk.
  it('.codegraphignore negation re-includes a gitignored directory in git mode', async () => {
    const { execFileSync } = await import('child_process');
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, stdio: 'pipe' });

    // Set up a git repo
    git(tempDir, 'init', '-q');
    git(tempDir, 'config', 'user.email', 'test@test.com');
    git(tempDir, 'config', 'user.name', 'Test');

    // .gitignore excludes build/ — those files will NOT be in git ls-files
    fs.writeFileSync(path.join(tempDir, '.gitignore'), 'build/\n');
    // .codegraphignore re-includes build/ with a negation
    fs.writeFileSync(path.join(tempDir, '.codegraphignore'), '!build/\n');

    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'build'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'main.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(tempDir, 'build', 'output.ts'), 'export const y = 1;');

    const files = scanDirectory(tempDir);

    expect(files).toContain('src/main.ts');
    expect(files).toContain('build/output.ts');
  });

  // Performance regression guard: when .codegraphignore has only exclusion
  // rules (no !), the git fast path is retained.
  it('.codegraphignore with only exclusion rules retains git fast path', async () => {
    const { execFileSync } = await import('child_process');
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, stdio: 'pipe' });

    git(tempDir, 'init', '-q');
    git(tempDir, 'config', 'user.email', 'test@test.com');
    git(tempDir, 'config', 'user.name', 'Test');

    // .gitignore excludes build/
    fs.writeFileSync(path.join(tempDir, '.gitignore'), 'build/\n');
    // .codegraphignore only adds exclusion rules, no negations
    fs.writeFileSync(path.join(tempDir, '.codegraphignore'), 'generated/\n');

    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'build'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'generated'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'main.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(tempDir, 'build', 'output.ts'), 'export const y = 1;');
    fs.writeFileSync(path.join(tempDir, 'generated', 'gen.ts'), 'export const z = 1;');

    const files = scanDirectory(tempDir);

    // build/ is gitignored → excluded by git ls-files (git fast path active)
    // generated/ is excluded by .codegraphignore (in-memory filter)
    expect(files).toContain('src/main.ts');
    expect(files).not.toContain('build/output.ts');
    expect(files).not.toContain('generated/gen.ts');
  });

  // hasCodegraphIgnoreNegation edge cases
  it('hasCodegraphIgnoreNegation: comment (#!) is not a negation', () => {
    fs.writeFileSync(path.join(tempDir, '.codegraphignore'), '#! this is a comment\n');
    // hasCodegraphIgnoreNegation is private; test via scanDirectory behavior:
    // no negation → git fast path retained → build/ excluded by .gitignore
    const { execFileSync } = require('child_process');
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, stdio: 'pipe' });
    git(tempDir, 'init', '-q');
    git(tempDir, 'config', 'user.email', 'test@test.com');
    git(tempDir, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(tempDir, '.gitignore'), 'build/\n');
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'build'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'main.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(tempDir, 'build', 'output.ts'), 'export const y = 1;');

    const files = scanDirectory(tempDir);
    expect(files).toContain('src/main.ts');
    // git fast path active: build/ is gitignored → excluded
    expect(files).not.toContain('build/output.ts');
  });

  it('hasCodegraphIgnoreNegation: escaped backslash-! is not a negation', () => {
    fs.writeFileSync(path.join(tempDir, '.codegraphignore'), '\\!not-a-negation\n');
    const { execFileSync } = require('child_process');
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, stdio: 'pipe' });
    git(tempDir, 'init', '-q');
    git(tempDir, 'config', 'user.email', 'test@test.com');
    git(tempDir, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(tempDir, '.gitignore'), 'build/\n');
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'build'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'main.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(tempDir, 'build', 'output.ts'), 'export const y = 1;');

    const files = scanDirectory(tempDir);
    expect(files).toContain('src/main.ts');
    // git fast path retained: build/ is gitignored → excluded
    expect(files).not.toContain('build/output.ts');
  });

  it('hasCodegraphIgnoreNegation: bare ! with no following text is not a negation', () => {
    // A line with only "!" (trimmed length === 1) should not count as negation
    fs.writeFileSync(path.join(tempDir, '.codegraphignore'), '!\n');
    const { execFileSync } = require('child_process');
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, stdio: 'pipe' });
    git(tempDir, 'init', '-q');
    git(tempDir, 'config', 'user.email', 'test@test.com');
    git(tempDir, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(tempDir, '.gitignore'), 'build/\n');
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'build'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'main.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(tempDir, 'build', 'output.ts'), 'export const y = 1;');

    const files = scanDirectory(tempDir);
    expect(files).toContain('src/main.ts');
    expect(files).not.toContain('build/output.ts');
  });

  it('.codegraphignore with multiple negation patterns triggers fallback', async () => {
    const { execFileSync } = await import('child_process');
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, stdio: 'pipe' });

    git(tempDir, 'init', '-q');
    git(tempDir, 'config', 'user.email', 'test@test.com');
    git(tempDir, 'config', 'user.name', 'Test');

    fs.writeFileSync(path.join(tempDir, '.gitignore'), 'build/\ndist/\n');
    fs.writeFileSync(path.join(tempDir, '.codegraphignore'), '!build/\n!dist/\n');

    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'build'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'main.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(tempDir, 'build', 'output.ts'), 'export const y = 1;');
    fs.writeFileSync(path.join(tempDir, 'dist', 'bundle.js'), 'export const z = 1;');

    const files = scanDirectory(tempDir);

    expect(files).toContain('src/main.ts');
    // Both build/ and dist/ are re-included by negation
    expect(files).toContain('build/output.ts');
    expect(files).toContain('dist/bundle.js');
  });

  it('.codegraphignore negation re-includes a file inside a default-ignored directory (non-git)', () => {
    // Non-git project: dist/ is excluded by DEFAULT_IGNORE_PATTERNS,
    // .codegraphignore !dist/ should override and re-include it.
    fs.writeFileSync(path.join(tempDir, '.codegraphignore'), '!dist/\n');

    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'main.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(tempDir, 'dist', 'bundle.js'), '// generated');

    const files = scanDirectory(tempDir);

    expect(files).toContain('src/main.ts');
    // Re-included by .codegraphignore negation
    expect(files).toContain('dist/bundle.js');
  });

  it('.codegraphignore negation re-includes nested files under a re-included dir', () => {
    fs.writeFileSync(path.join(tempDir, '.codegraphignore'), '!generated/\n');

    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'generated', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'main.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(tempDir, 'generated', 'gen.ts'), 'export const y = 1;');
    fs.writeFileSync(path.join(tempDir, 'generated', 'sub', 'nested.ts'), 'export const z = 1;');

    const files = scanDirectory(tempDir);

    expect(files).toContain('src/main.ts');
    expect(files).toContain('generated/gen.ts');
    expect(files).toContain('generated/sub/nested.ts');
  });

  it('.codegraphignore negation overrides a .gitignore exclusion for a specific file', () => {
    fs.writeFileSync(path.join(tempDir, '.gitignore'), '*.generated.ts\n');
    fs.writeFileSync(path.join(tempDir, '.codegraphignore'), '!important.generated.ts\n');

    fs.writeFileSync(path.join(tempDir, 'main.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(tempDir, 'important.generated.ts'), 'export const y = 2;');
    fs.writeFileSync(path.join(tempDir, 'other.generated.ts'), 'export const z = 3;');

    const files = scanDirectory(tempDir);

    expect(files).toContain('main.ts');
    expect(files).toContain('important.generated.ts'); // re-included
    expect(files).not.toContain('other.generated.ts');  // still excluded
  });
});

// =============================================================================
// .git/info/exclude
// =============================================================================

describe('.git/info/exclude', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('is respected via git fast path (git ls-files --exclude-standard)', async () => {
    const { execFileSync } = await import('child_process');
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, stdio: 'pipe' });

    git(tempDir, 'init', '-q');
    git(tempDir, 'config', 'user.email', 'test@test.com');
    git(tempDir, 'config', 'user.name', 'Test');

    // Exclude generated/ via .git/info/exclude
    const excludePath = path.join(tempDir, '.git', 'info', 'exclude');
    fs.appendFileSync(excludePath, '\ngenerated/\n');

    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'generated'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'main.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(tempDir, 'generated', 'gen.ts'), 'export const y = 1;');

    const files = scanDirectory(tempDir);

    expect(files).toContain('src/main.ts');
    // generated/ excluded by .git/info/exclude via --exclude-standard
    expect(files).not.toContain('generated/gen.ts');
  });

  it('is respected alongside .gitignore in git fast path', async () => {
    const { execFileSync } = await import('child_process');
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, stdio: 'pipe' });

    git(tempDir, 'init', '-q');
    git(tempDir, 'config', 'user.email', 'test@test.com');
    git(tempDir, 'config', 'user.name', 'Test');

    // .gitignore excludes build/, .git/info/exclude excludes generated/
    fs.writeFileSync(path.join(tempDir, '.gitignore'), 'build/\n');
    const excludePath = path.join(tempDir, '.git', 'info', 'exclude');
    fs.appendFileSync(excludePath, '\ngenerated/\n');

    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'build'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'generated'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'main.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(tempDir, 'build', 'output.ts'), 'export const y = 1;');
    fs.writeFileSync(path.join(tempDir, 'generated', 'gen.ts'), 'export const z = 1;');

    const files = scanDirectory(tempDir);

    expect(files).toContain('src/main.ts');
    expect(files).not.toContain('build/output.ts');       // .gitignore
    expect(files).not.toContain('generated/gen.ts');       // .git/info/exclude
  });

  it('.git/info/exclude combined with .codegraphignore exclusion rules retains fast path', async () => {
    const { execFileSync } = await import('child_process');
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, stdio: 'pipe' });

    git(tempDir, 'init', '-q');
    git(tempDir, 'config', 'user.email', 'test@test.com');
    git(tempDir, 'config', 'user.name', 'Test');

    // .git/info/exclude excludes generated/
    const excludePath = path.join(tempDir, '.git', 'info', 'exclude');
    fs.appendFileSync(excludePath, '\ngenerated/\n');
    // .codegraphignore adds extra excludes (no negation — fast path retained)
    fs.writeFileSync(path.join(tempDir, '.codegraphignore'), 'tmp/\n');

    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'generated'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'tmp'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'main.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(tempDir, 'generated', 'gen.ts'), 'export const y = 1;');
    fs.writeFileSync(path.join(tempDir, 'tmp', 'scratch.ts'), 'export const z = 1;');

    const files = scanDirectory(tempDir);

    expect(files).toContain('src/main.ts');
    expect(files).not.toContain('generated/gen.ts');  // .git/info/exclude
    expect(files).not.toContain('tmp/scratch.ts');    // .codegraphignore
  });

  // .codegraphignore negation (!) triggers a filesystem walk fallback.
  // .git/info/exclude is now read by buildDefaultIgnore, so it applies
  // to both the git fast path AND the filesystem walk fallback.
  it('.git/info/exclude is respected when .codegraphignore negation forces filesystem walk', async () => {
    const { execFileSync } = await import('child_process');
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, stdio: 'pipe' });

    git(tempDir, 'init', '-q');
    git(tempDir, 'config', 'user.email', 'test@test.com');
    git(tempDir, 'config', 'user.name', 'Test');

    // .git/info/exclude excludes generated/
    const excludePath = path.join(tempDir, '.git', 'info', 'exclude');
    fs.appendFileSync(excludePath, '\ngenerated/\n');
    // .codegraphignore with negation triggers filesystem walk fallback
    fs.writeFileSync(path.join(tempDir, '.codegraphignore'), '!build/\n');

    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'build'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'generated'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'main.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(tempDir, 'build', 'output.ts'), 'export const y = 1;');
    fs.writeFileSync(path.join(tempDir, 'generated', 'gen.ts'), 'export const z = 1;');

    const files = scanDirectory(tempDir);

    // build/ is re-included by .codegraphignore negation (working as intended)
    expect(files).toContain('build/output.ts');
    // generated/ is excluded by .git/info/exclude — now respected in both paths
    expect(files).not.toContain('generated/gen.ts');
  });

  // .codegraphignore is the highest-priority layer: a ! negation there
  // can override an exclusion from .git/info/exclude for specific files.
  it('.codegraphignore negation overrides a .git/info/exclude exclusion for a specific file', async () => {
    const { execFileSync } = await import('child_process');
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, stdio: 'pipe' });

    git(tempDir, 'init', '-q');
    git(tempDir, 'config', 'user.email', 'test@test.com');
    git(tempDir, 'config', 'user.name', 'Test');

    // .git/info/exclude excludes files inside generated/ (but not the dir itself,
    // so the walk can descend and apply per-file negations)
    const excludePath = path.join(tempDir, '.git', 'info', 'exclude');
    fs.appendFileSync(excludePath, '\ngenerated/*\n');
    // .codegraphignore re-includes only important.ts (negation triggers fallback)
    fs.writeFileSync(path.join(tempDir, '.codegraphignore'), '!generated/important.ts\n');

    fs.mkdirSync(path.join(tempDir, 'generated'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'generated', 'important.ts'), 'export const keep = 1;');
    fs.writeFileSync(path.join(tempDir, 'generated', 'junk.ts'), 'export const junk = 1;');

    const files = scanDirectory(tempDir);

    // important.ts re-included by .codegraphignore negation (overrides .git/info/exclude)
    expect(files).toContain('generated/important.ts');
    // junk.ts still excluded by .git/info/exclude
    expect(files).not.toContain('generated/junk.ts');
  });
});

// =============================================================================
// Scala
// =============================================================================

describe('Scala Extraction', () => {
  describe('Language detection', () => {
    it('should detect Scala files', () => {
      expect(detectLanguage('Main.scala')).toBe('scala');
      expect(detectLanguage('script.sc')).toBe('scala');
      expect(detectLanguage('src/UserService.scala')).toBe('scala');
    });

    it('should report Scala as supported', () => {
      expect(isLanguageSupported('scala')).toBe(true);
      expect(getSupportedLanguages()).toContain('scala');
    });
  });

  describe('Class extraction', () => {
    it('should extract class definitions', () => {
      const code = `
class UserService(private val repo: UserRepository) {
  def findUser(id: String): Option[String] = Some(id)
}
`;
      const result = extractFromSource('UserService.scala', code);
      const cls = result.nodes.find((n) => n.kind === 'class' && n.name === 'UserService');
      expect(cls).toBeDefined();
      expect(cls?.language).toBe('scala');
    });

    it('should extract object definitions as class kind', () => {
      const code = `
object DatabaseConfig {
  val url = "jdbc:postgresql://localhost/mydb"
}
`;
      const result = extractFromSource('Config.scala', code);
      const obj = result.nodes.find((n) => n.kind === 'class' && n.name === 'DatabaseConfig');
      expect(obj).toBeDefined();
    });

    it('should extract trait definitions as trait kind', () => {
      const code = `
trait Repository[A] {
  def findById(id: String): Option[A]
  def save(entity: A): Unit
}
`;
      const result = extractFromSource('Repository.scala', code);
      const trait_ = result.nodes.find((n) => n.kind === 'trait' && n.name === 'Repository');
      expect(trait_).toBeDefined();
    });
  });

  describe('Method and function extraction', () => {
    it('should extract method definitions inside a class', () => {
      const code = `
class Calculator {
  def add(a: Int, b: Int): Int = a + b
  def divide(a: Double, b: Double): Double = a / b
}
`;
      const result = extractFromSource('Calculator.scala', code);
      const methods = result.nodes.filter((n) => n.kind === 'method');
      expect(methods.find((m) => m.name === 'add')).toBeDefined();
      expect(methods.find((m) => m.name === 'divide')).toBeDefined();
    });

    it('should extract method signatures', () => {
      const code = `
class Greeter {
  def greet(name: String): String = s"Hello, \${name}!"
}
`;
      const result = extractFromSource('Greeter.scala', code);
      const method = result.nodes.find((n) => n.name === 'greet');
      expect(method?.signature).toContain('name: String');
      expect(method?.signature).toContain('String');
    });

    it('should extract top-level function definitions as functions', () => {
      const code = `
def factorial(n: Int): Int = if (n <= 1) 1 else n * factorial(n - 1)
def greet(name: String): String = s"Hello, \${name}!"
`;
      const result = extractFromSource('utils.scala', code);
      const fns = result.nodes.filter((n) => n.kind === 'function');
      expect(fns.find((f) => f.name === 'factorial')).toBeDefined();
      expect(fns.find((f) => f.name === 'greet')).toBeDefined();
    });
  });

  describe('Val and var extraction', () => {
    it('should extract val inside a class as field', () => {
      const code = `
class Config {
  val timeout: Int = 30
  val host: String = "localhost"
}
`;
      const result = extractFromSource('Config.scala', code);
      const fields = result.nodes.filter((n) => n.kind === 'field');
      expect(fields.find((f) => f.name === 'timeout')).toBeDefined();
      expect(fields.find((f) => f.name === 'host')).toBeDefined();
    });

    it('should extract var inside a class as field', () => {
      const code = `
class Counter {
  var count: Int = 0
}
`;
      const result = extractFromSource('Counter.scala', code);
      const field = result.nodes.find((n) => n.kind === 'field' && n.name === 'count');
      expect(field).toBeDefined();
    });

    it('should extract top-level val as constant', () => {
      const code = `
val MaxConnections: Int = 100
val DefaultTimeout = 30
`;
      const result = extractFromSource('constants.scala', code);
      const consts = result.nodes.filter((n) => n.kind === 'constant');
      expect(consts.find((c) => c.name === 'MaxConnections')).toBeDefined();
    });

    it('should extract top-level var as variable', () => {
      const code = `
var retries: Int = 3
`;
      const result = extractFromSource('state.scala', code);
      const v = result.nodes.find((n) => n.kind === 'variable' && n.name === 'retries');
      expect(v).toBeDefined();
    });

    it('should include type in val/var signature', () => {
      const code = `
class Service {
  val timeout: Int = 30
}
`;
      const result = extractFromSource('Service.scala', code);
      const field = result.nodes.find((n) => n.name === 'timeout');
      expect(field?.signature).toContain('timeout');
      expect(field?.signature).toContain('Int');
    });
  });

  describe('Enum extraction', () => {
    it('should extract enum definitions', () => {
      const code = `
enum Color:
  case Red
  case Green
  case Blue
`;
      const result = extractFromSource('Color.scala', code);
      const enumNode = result.nodes.find((n) => n.kind === 'enum' && n.name === 'Color');
      expect(enumNode).toBeDefined();
    });

    it('should extract enum cases as enum_member', () => {
      const code = `
enum Direction:
  case North
  case South
  case East
  case West
`;
      const result = extractFromSource('Direction.scala', code);
      const members = result.nodes.filter((n) => n.kind === 'enum_member');
      expect(members.find((m) => m.name === 'North')).toBeDefined();
      expect(members.find((m) => m.name === 'South')).toBeDefined();
      expect(members.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('Type alias extraction', () => {
    it('should extract type aliases', () => {
      const code = `
type UserId = String
type UserMap = Map[String, String]
`;
      const result = extractFromSource('types.scala', code);
      const aliases = result.nodes.filter((n) => n.kind === 'type_alias');
      expect(aliases.find((a) => a.name === 'UserId')).toBeDefined();
      expect(aliases.find((a) => a.name === 'UserMap')).toBeDefined();
    });
  });

  describe('Import extraction', () => {
    it('should extract import declarations', () => {
      const code = `
import scala.collection.mutable.ListBuffer
import scala.concurrent.Future
`;
      const result = extractFromSource('imports.scala', code);
      const imports = result.nodes.filter((n) => n.kind === 'import');
      expect(imports.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Visibility modifiers', () => {
    it('should extract private visibility', () => {
      const code = `
class Service {
  private val secret: String = "abc"
  private def helper(): Unit = {}
}
`;
      const result = extractFromSource('Service.scala', code);
      const secretField = result.nodes.find((n) => n.name === 'secret');
      expect(secretField?.visibility).toBe('private');
      const helperMethod = result.nodes.find((n) => n.name === 'helper');
      expect(helperMethod?.visibility).toBe('private');
    });

    it('should extract protected visibility', () => {
      const code = `
class Base {
  protected def helperMethod(): Unit = {}
}
`;
      const result = extractFromSource('Base.scala', code);
      const method = result.nodes.find((n) => n.name === 'helperMethod');
      expect(method?.visibility).toBe('protected');
    });

    it('should default to public visibility', () => {
      const code = `
class Greeter {
  def hello(): Unit = {}
}
`;
      const result = extractFromSource('Greeter.scala', code);
      const method = result.nodes.find((n) => n.name === 'hello');
      expect(method?.visibility).toBe('public');
    });
  });

  describe('Inheritance', () => {
    it('should extract extends relationships', () => {
      const code = `
class AdminUser extends User {
  def adminAction(): Unit = {}
}
`;
      const result = extractFromSource('AdminUser.scala', code);
      const extendsRefs = result.unresolvedReferences.filter((r) => r.referenceKind === 'extends');
      expect(extendsRefs.find((r) => r.referenceName === 'User')).toBeDefined();
    });
  });

  describe('Call extraction', () => {
    it('should extract function call expressions', () => {
      const code = `
def processData(): Unit = {
  val result = computeResult()
  println(result)
}
`;
      const result = extractFromSource('processor.scala', code);
      const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls');
      expect(calls.length).toBeGreaterThan(0);
    });
  });
});

describe('Vue Extraction', () => {
  it('should detect Vue files', () => {
    expect(detectLanguage('App.vue')).toBe('vue');
    expect(detectLanguage('components/Button.vue')).toBe('vue');
    expect(isLanguageSupported('vue')).toBe(true);
  });

  it('should extract component node from a Vue SFC', () => {
    const code = `<template>
  <div>{{ message }}</div>
</template>

<script>
export default {
  data() {
    return { message: 'Hello' };
  }
}
</script>
`;
    const result = extractFromSource('HelloWorld.vue', code);

    const componentNode = result.nodes.find((n) => n.kind === 'component');
    expect(componentNode).toBeDefined();
    expect(componentNode?.name).toBe('HelloWorld');
    expect(componentNode?.language).toBe('vue');
    expect(componentNode?.isExported).toBe(true);
  });

  it('should extract functions from <script> block', () => {
    const code = `<template>
  <button @click="handleClick">Click</button>
</template>

<script>
function handleClick() {
  console.log('clicked');
}

const count = 0;
</script>
`;
    const result = extractFromSource('Button.vue', code);

    const componentNode = result.nodes.find((n) => n.kind === 'component');
    expect(componentNode).toBeDefined();
    expect(componentNode?.name).toBe('Button');

    const funcNode = result.nodes.find((n) => n.kind === 'function' && n.name === 'handleClick');
    expect(funcNode).toBeDefined();
    expect(funcNode?.language).toBe('vue');
  });

  it('should extract from <script setup lang="ts"> block', () => {
    const code = `<template>
  <div>{{ count }}</div>
</template>

<script setup lang="ts">
import { ref } from 'vue';

const count = ref(0);

function increment(): void {
  count.value++;
}
</script>
`;
    const result = extractFromSource('Counter.vue', code);

    const componentNode = result.nodes.find((n) => n.kind === 'component');
    expect(componentNode).toBeDefined();
    expect(componentNode?.name).toBe('Counter');

    const funcNode = result.nodes.find((n) => n.kind === 'function' && n.name === 'increment');
    expect(funcNode).toBeDefined();
    expect(funcNode?.language).toBe('vue');

    // All nodes should be marked as vue language
    for (const node of result.nodes) {
      expect(node.language).toBe('vue');
    }
  });

  it('should extract calls from top-level <script setup> initializers', () => {
    const code = `<template>
  <div>{{ token }}</div>
</template>

<script setup lang="ts">
import { getTokenMp } from './api/upload';

const token = getTokenMp();
</script>
`;
    const result = extractFromSource('Issue425Setup.vue', code);

    const call = result.unresolvedReferences.find(
      (ref) => ref.referenceKind === 'calls' && ref.referenceName === 'getTokenMp'
    );
    expect(call).toBeDefined();
  });

  it('should extract calls from Vue Options API object methods', () => {
    const code = `<template>
  <button @click="save">Save</button>
</template>

<script>
import { getTokenMp } from './api/upload';

export default {
  methods: {
    save() {
      return getTokenMp();
    }
  },
  setup() {
    return getTokenMp();
  }
}
</script>
`;
    const result = extractFromSource('Issue425Options.vue', code);

    const calls = result.unresolvedReferences.filter(
      (ref) => ref.referenceKind === 'calls' && ref.referenceName === 'getTokenMp'
    );
    expect(calls).toHaveLength(2);
  });

  it('should extract component usages from the Vue template (PascalCase + kebab, skipping built-ins) (#629)', () => {
    const code = `<template>
  <div class="wrap">
    <UserCard :user="u" />
    <my-button>Click</my-button>
    <Transition><span>x</span></Transition>
  </div>
</template>

<script setup lang="ts">
import UserCard from './UserCard.vue';
import MyButton from './MyButton.vue';
</script>
`;
    const result = extractFromSource('Host.vue', code);
    const refs = result.unresolvedReferences
      .filter((r) => r.referenceKind === 'references')
      .map((r) => r.referenceName);

    expect(refs).toContain('UserCard'); // PascalCase tag
    expect(refs).toContain('MyButton'); // kebab <my-button> → MyButton
    expect(refs).not.toContain('Transition'); // Vue built-in skipped
    expect(refs).not.toContain('Div'); // native HTML element skipped
    expect(refs).not.toContain('Span');
  });

  it('should extract from both <script> and <script setup> blocks', () => {
    const code = `<template>
  <div>{{ msg }}</div>
</template>

<script>
export default {
  name: 'DualScript'
}
</script>

<script setup>
const msg = 'hello';

function greet() {
  return msg;
}
</script>
`;
    const result = extractFromSource('DualScript.vue', code);

    const componentNode = result.nodes.find((n) => n.kind === 'component');
    expect(componentNode).toBeDefined();

    const greetFunc = result.nodes.find((n) => n.kind === 'function' && n.name === 'greet');
    expect(greetFunc).toBeDefined();
  });

  it('should create component node for template-only Vue file', () => {
    const code = `<template>
  <div>Static content</div>
</template>
`;
    const result = extractFromSource('Static.vue', code);

    const componentNode = result.nodes.find((n) => n.kind === 'component');
    expect(componentNode).toBeDefined();
    expect(componentNode?.name).toBe('Static');
    expect(componentNode?.language).toBe('vue');

    // Only the component node should exist (no script nodes)
    expect(result.nodes.length).toBe(1);
  });

  it('should create containment edges from component to script nodes', () => {
    const code = `<template>
  <div>{{ value }}</div>
</template>

<script setup lang="ts">
const value = 42;
</script>
`;
    const result = extractFromSource('Contained.vue', code);

    const componentNode = result.nodes.find((n) => n.kind === 'component');
    expect(componentNode).toBeDefined();

    // Should have containment edges from component to child nodes
    const containEdges = result.edges.filter(
      (e) => e.source === componentNode!.id && e.kind === 'contains'
    );
    expect(containEdges.length).toBeGreaterThan(0);
  });
});

describe('Instantiates + Decorates edge extraction', () => {
  it('emits an instantiates ref for `new Foo()`', () => {
    const code = `
class Foo {}
function bootstrap() { return new Foo(); }
`;
    const result = extractFromSource('app.ts', code);
    const ref = result.unresolvedReferences.find(
      (r) => r.referenceKind === 'instantiates' && r.referenceName === 'Foo'
    );
    expect(ref).toBeDefined();
  });

  it('strips type-argument suffix from generic constructors', () => {
    const code = `
class Container<T> { constructor(_: T) {} }
function go() { return new Container<string>('x'); }
`;
    const result = extractFromSource('app.ts', code);
    const ref = result.unresolvedReferences.find(
      (r) => r.referenceKind === 'instantiates'
    );
    expect(ref).toBeDefined();
    // Container<string> must be normalised to "Container" — otherwise
    // resolution can never match the class node.
    expect(ref!.referenceName).toBe('Container');
  });

  it('keeps trailing identifier from qualified `new ns.Foo()`', () => {
    const code = `
const ns = { Foo: class {} };
function go() { return new ns.Foo(); }
`;
    const result = extractFromSource('app.ts', code);
    const ref = result.unresolvedReferences.find(
      (r) => r.referenceKind === 'instantiates'
    );
    // We can't always resolve which Foo, but the name should be the
    // simple identifier so name-matching has a chance.
    expect(ref?.referenceName).toBe('Foo');
  });

  it('emits a decorates ref for `@Foo class X {}`', () => {
    const code = `
function Foo(_arg: string) { return (cls: any) => cls; }
@Foo('x')
class X {}
`;
    const result = extractFromSource('app.ts', code);
    const decorClass = result.unresolvedReferences.find(
      (r) => r.referenceKind === 'decorates' && r.referenceName === 'Foo'
    );
    expect(decorClass).toBeDefined();
  });

  it('does NOT attribute a prior class\'s decorator to the next class', () => {
    // Regression: the sibling-walk must stop at the first non-
    // decorator separator. `@A class Foo {} @B class Bar {}` must
    // produce `decorates(Foo, A)` and `decorates(Bar, B)` — never
    // `decorates(Bar, A)`.
    const code = `
function A(cls: any) { return cls; }
function B(cls: any) { return cls; }
@A
class Foo {}
@B
class Bar {}
`;
    const result = extractFromSource('app.ts', code);
    const decoratesEdges = result.unresolvedReferences.filter(
      (r) => r.referenceKind === 'decorates'
    );
    // Exactly one decorates ref per decorated class, no cross-attribution.
    const fromBar = decoratesEdges.filter((r) =>
      result.nodes.find((n) => n.id === r.fromNodeId && n.name === 'Bar')
    );
    expect(fromBar.length).toBe(1);
    expect(fromBar[0]!.referenceName).toBe('B');
  });

  it('emits a decorates ref for `@Foo method() {}`', () => {
    const code = `
function Get(p: string) { return (t: any, k: string) => t; }
class Svc {
  @Get('/x') method() { return 1; }
}
`;
    const result = extractFromSource('app.ts', code);
    const decorMethod = result.unresolvedReferences.find(
      (r) => r.referenceKind === 'decorates' && r.referenceName === 'Get'
    );
    expect(decorMethod).toBeDefined();
    // The decorated symbol must be `method`, not the constructor or class.
    const decoratedNode = result.nodes.find((n) => n.id === decorMethod!.fromNodeId);
    expect(decoratedNode?.name).toBe('method');
  });
});

// =============================================================================
// Lua
// =============================================================================

describe('Lua Extraction', () => {
  describe('Language detection', () => {
    it('should detect Lua files', () => {
      expect(detectLanguage('init.lua')).toBe('lua');
      expect(detectLanguage('src/util.lua')).toBe('lua');
    });

    it('should report Lua as supported', () => {
      expect(isLanguageSupported('lua')).toBe(true);
      expect(getSupportedLanguages()).toContain('lua');
    });
  });

  describe('Function extraction', () => {
    it('should extract global and local functions', () => {
      const code = `
function configure(opts) return opts end
local function helper(x) return x * 2 end
`;
      const result = extractFromSource('init.lua', code);
      const funcs = result.nodes.filter((n) => n.kind === 'function').map((n) => n.name);
      expect(funcs).toContain('configure');
      expect(funcs).toContain('helper');
      const configure = result.nodes.find((n) => n.name === 'configure');
      expect(configure?.language).toBe('lua');
      expect(configure?.signature).toBe('(opts)');
    });

    it('should split table/method functions into a receiver and method name', () => {
      const code = `
function M.connect(host, port) return host end
function M:send(data) return self end
`;
      const result = extractFromSource('init.lua', code);
      const methods = result.nodes.filter((n) => n.kind === 'method');
      const connect = methods.find((m) => m.name === 'connect');
      expect(connect?.qualifiedName).toBe('M::connect');
      const send = methods.find((m) => m.name === 'send');
      expect(send?.qualifiedName).toBe('M::send');
    });
  });

  describe('Variable extraction', () => {
    it('should extract local variable declarations', () => {
      const code = `
local M = {}
local count = 0
`;
      const result = extractFromSource('mod.lua', code);
      const vars = result.nodes.filter((n) => n.kind === 'variable').map((n) => n.name);
      expect(vars).toContain('M');
      expect(vars).toContain('count');
    });
  });

  describe('Import extraction (require)', () => {
    it('should extract require() in local declarations and bare calls', () => {
      const code = `
local socket = require("socket")
local http = require "resty.http"
require("side.effect")
`;
      const result = extractFromSource('net.lua', code);
      const imports = result.nodes.filter((n) => n.kind === 'import').map((n) => n.name);
      expect(imports).toContain('socket');
      expect(imports).toContain('resty.http');
      expect(imports).toContain('side.effect');

      const ref = result.unresolvedReferences.find(
        (r) => r.referenceKind === 'imports' && r.referenceName === 'socket'
      );
      expect(ref).toBeDefined();
    });

    // Regression: the tree-sitter-wasms Lua grammar (ABI 13) corrupts the shared
    // WASM heap under web-tree-sitter 0.25, dropping nested calls/imports on every
    // parse after the first. We vendor the ABI-15 grammar instead — this guards it
    // by extracting several sources in sequence and asserting the LAST still works.
    it('should keep extracting require across many sequential parses', () => {
      let last;
      for (let i = 0; i < 8; i++) {
        last = extractFromSource(`f${i}.lua`, `local m = require("module.${i}")\nreturn m\n`);
      }
      const imports = last!.nodes.filter((n) => n.kind === 'import').map((n) => n.name);
      expect(imports).toContain('module.7');
    });
  });

  describe('Call extraction', () => {
    it('should record intra-file calls as resolvable references', () => {
      const code = `
local function helper(x) return x end
local function run(y) return helper(y) end
`;
      const result = extractFromSource('calls.lua', code);
      const call = result.unresolvedReferences.find(
        (r) => r.referenceKind === 'calls' && r.referenceName === 'helper'
      );
      expect(call).toBeDefined();
    });
  });
});

// =============================================================================
// Luau (typed superset of Lua — https://luau.org)
// =============================================================================

describe('Luau Extraction', () => {
  describe('Language detection', () => {
    it('should detect Luau files', () => {
      expect(detectLanguage('init.luau')).toBe('luau');
      expect(detectLanguage('src/Client.luau')).toBe('luau');
    });

    it('should report Luau as supported', () => {
      expect(isLanguageSupported('luau')).toBe(true);
      expect(getSupportedLanguages()).toContain('luau');
    });
  });

  describe('Type aliases', () => {
    it('should extract `type` and `export type` definitions', () => {
      const code = `
export type Vector = { x: number, y: number }
type Handler = (msg: string) -> boolean
`;
      const result = extractFromSource('types.luau', code);
      const aliases = result.nodes.filter((n) => n.kind === 'type_alias');
      const vector = aliases.find((a) => a.name === 'Vector');
      expect(vector).toBeDefined();
      expect(vector?.isExported).toBe(true);
      const handler = aliases.find((a) => a.name === 'Handler');
      expect(handler).toBeDefined();
      expect(handler?.isExported).toBe(false);
    });
  });

  describe('Typed functions and methods', () => {
    it('should capture typed signatures and split methods by receiver', () => {
      const code = `
function configure(opts: { debug: boolean }): boolean
	return opts.debug
end
function Client:fetch(path: string): Response
	return path
end
`;
      const result = extractFromSource('client.luau', code);
      const configure = result.nodes.find((n) => n.kind === 'function' && n.name === 'configure');
      expect(configure?.language).toBe('luau');
      expect(configure?.signature).toBe('(opts: { debug: boolean }): boolean');
      const fetch = result.nodes.find((n) => n.kind === 'method' && n.name === 'fetch');
      expect(fetch?.qualifiedName).toBe('Client::fetch');
    });
  });

  describe('Imports and variables', () => {
    it('should extract string and Roblox instance-path require imports', () => {
      const code = `
local http = require("http")
local Signal = require(script.Parent.Signal)
local count = 0
`;
      const result = extractFromSource('mod.luau', code);
      const imports = result.nodes.filter((n) => n.kind === 'import').map((n) => n.name);
      expect(imports).toContain('http'); // string require
      expect(imports).toContain('Signal'); // Roblox instance-path require
      const vars = result.nodes.filter((n) => n.kind === 'variable').map((n) => n.name);
      expect(vars).toContain('count');
    });
  });
});

// =============================================================================
// Objective-C
// =============================================================================

describe('Objective-C Extraction', () => {
  const sample = `
#import <Foundation/Foundation.h>
#import "MyClass.h"

@interface MyClass : NSObject <NSCopying>
@property (nonatomic, copy) NSString *name;
- (void)greet;
- (void)doThing:(id)x with:(id)y;
+ (instancetype)shared;
@end

@implementation MyClass

- (void)greet {
    NSLog(@"Hello");
    [self doWork];
}

- (void)doThing:(id)x with:(id)y {
    [self notify:x];
}

+ (instancetype)shared {
    return [[MyClass alloc] init];
}

@end

void helperFunction(int count) {
    MyClass *obj = [MyClass shared];
    [obj greet];
}
`;

  it('should extract classes, methods, functions, and imports', () => {
    const result = extractFromSource('App.m', sample);

    const classes = result.nodes.filter((n) => n.kind === 'class');
    expect(classes.filter((c) => c.name === 'MyClass')).toHaveLength(1);

    const methods = result.nodes.filter((n) => n.kind === 'method');
    expect(methods.map((m) => m.name).sort()).toEqual(['doThing:with:', 'greet', 'shared']);

    const shared = methods.find((m) => m.name === 'shared');
    expect(shared?.isStatic).toBe(true);

    const properties = result.nodes.filter((n) => n.kind === 'property');
    expect(properties.some((p) => p.name === 'name')).toBe(true);

    const functions = result.nodes.filter((n) => n.kind === 'function');
    expect(functions.some((f) => f.name === 'helperFunction')).toBe(true);

    const imports = result.nodes.filter((n) => n.kind === 'import').map((n) => n.name);
    expect(imports).toContain('Foundation/Foundation.h');
    expect(imports).toContain('MyClass.h');
  });

  it('should record inheritance and protocol conformance', () => {
    const result = extractFromSource('App.m', sample);
    const extendsRefs = result.unresolvedReferences.filter((r) => r.referenceKind === 'extends');
    const implementsRefs = result.unresolvedReferences.filter((r) => r.referenceKind === 'implements');
    expect(extendsRefs.map((r) => r.referenceName)).toContain('NSObject');
    expect(implementsRefs.map((r) => r.referenceName)).toContain('NSCopying');
  });

  it('should record message sends and C calls', () => {
    const result = extractFromSource('App.m', sample);
    const calls = result.unresolvedReferences
      .filter((r) => r.referenceKind === 'calls')
      .map((r) => r.referenceName);
    expect(calls).toEqual(expect.arrayContaining(['NSLog', 'doWork', 'MyClass.shared', 'obj.greet']));
  });

  it('should reconstruct multi-keyword selectors at the call site so they resolve to the method definition', () => {
    // Regression for the gap discovered post-#165: message_expression's
    // multi-keyword form `[obj a:1 b:2]` was only emitting the first keyword,
    // so calls never resolved to multi-part method definitions like
    // `GET:parameters:headers:progress:success:failure:`. The call-site name
    // must match the method-definition name with full keywords + trailing colons.
    const code = `
@implementation Caller
- (void)demo {
    NSMutableDictionary *d = [NSMutableDictionary new];
    [d setObject:@"v" forKey:@"k"];
    [d setObject:@"v2" forKey:@"k2" withRetry:@YES];
    [self touchesBegan:nil withEvent:nil];
}
@end
`;
    const result = extractFromSource('Caller.m', code);
    const calls = result.unresolvedReferences
      .filter((r) => r.referenceKind === 'calls')
      .map((r) => r.referenceName);
    expect(calls).toEqual(
      expect.arrayContaining([
        'd.setObject:forKey:',
        'd.setObject:forKey:withRetry:',
        'touchesBegan:withEvent:',
      ])
    );
  });

  it('should not classify pure C headers with @end in comments as objc', () => {
    const cHeader = '/* @end of file */\n#ifndef STDIO_H\nvoid printf(const char *);\n#endif\n';
    expect(detectLanguage('stdio.h', cHeader)).toBe('c');
  });

  it('should extract protocol declarations', () => {
    const code = `
@protocol DataSource <NSObject>
- (NSInteger)numberOfItems;
@end
`;
    const result = extractFromSource('DataSource.h', code);
    const protocol = result.nodes.find((n) => n.kind === 'protocol' && n.name === 'DataSource');
    expect(protocol).toBeDefined();
  });

  it('should report Objective-C as supported', () => {
    expect(isLanguageSupported('objc')).toBe(true);
    expect(getSupportedLanguages()).toContain('objc');
  });
});

describe('Regression: issue-specific extraction fixes', () => {
  it('indexes inner functions of an anonymous AMD/CommonJS module wrapper (#528)', () => {
    const code = `
define(['dep'], function (dep) {
  function innerHelper(x) { return x + 1; }
  function compute(y) { return innerHelper(y); }
  return { compute: compute };
});
`;
    const result = extractFromSource('amd-module.js', code);
    const fns = result.nodes.filter((n) => n.kind === 'function').map((n) => n.name);
    expect(fns).toContain('innerHelper');
    expect(fns).toContain('compute');
  });

  it('attaches Go methods on generic receivers to their type (#583)', () => {
    const code = `
package main

type Stack[T any] struct { items []T }

func (s *Stack[T]) Push(v T) { s.items = append(s.items, v) }
func (s Stack[T]) Len() int { return len(s.items) }
`;
    const result = extractFromSource('stack.go', code);
    const methods = result.nodes.filter((n) => n.kind === 'method');
    expect(methods.find((m) => m.name === 'Push')?.qualifiedName).toBe('Stack::Push');
    expect(methods.find((m) => m.name === 'Len')?.qualifiedName).toBe('Stack::Len');
  });

  it('indexes new module extensions: .mts/.cts (TS) and .xsjs/.xsjslib (JS) (#366, #556)', () => {
    expect(isSourceFile('mod.mts')).toBe(true);
    expect(isSourceFile('mod.cts')).toBe(true);
    expect(isSourceFile('service.xsjs')).toBe(true);
    expect(isSourceFile('lib.xsjslib')).toBe(true);
    expect(detectLanguage('mod.mts')).toBe('typescript');
    expect(detectLanguage('service.xsjs')).toBe('javascript');

    // End-to-end: a .mts file is parsed as TS, a .xsjs file as JS.
    const ts = extractFromSource('mod.mts', 'export function hello(): number { return 1; }');
    expect(ts.nodes.find((n) => n.name === 'hello' && n.kind === 'function')).toBeDefined();
    const js = extractFromSource('service.xsjs', 'function handleRequest() { return 1; }');
    expect(js.nodes.find((n) => n.name === 'handleRequest' && n.kind === 'function')).toBeDefined();
  });
});

describe('Import / re-export dependency linking (blast-radius recall)', () => {
  // An import IS a dependency, but extraction only emits references for calls,
  // instantiations, type annotations, and inheritance — so a symbol imported and
  // then merely re-exported, placed in a registry array, passed as an argument,
  // or used in JSX produced no cross-file edge, leaving the providing file with a
  // false "0 dependents". These tests pin the import/re-export binding linking.
  it('emits an imports reference per named, aliased, and default import binding', () => {
    const code = `
import { widget, helper as h } from './foo';
import Thing from './thing';
import * as NS from './ns';
export const registry = [widget];
`;
    const result = extractFromSource('bar.ts', code);
    const names = result.unresolvedReferences
      .filter((r) => r.referenceKind === 'imports')
      .map((r) => r.referenceName);
    expect(names).toContain('widget');   // named import → local name
    expect(names).toContain('h');        // aliased import → local alias
    expect(names).toContain('Thing');    // default import
    expect(names).toContain('NS');       // namespace import → linked to the module file as a dependency
  });

  it('emits an imports reference per re-exported binding', () => {
    const result = extractFromSource('barrel.ts', `export { alpha, beta as b } from './source';`);
    const names = result.unresolvedReferences
      .filter((r) => r.referenceKind === 'imports')
      .map((r) => r.referenceName);
    // Re-export links the SOURCE-side name, not the local alias.
    expect(names).toContain('alpha');
    expect(names).toContain('beta');
  });

  it('a value imported/re-exported but never called still makes the importer a dependent', async () => {
    const dir = createTempDir();
    try {
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'foo.ts'),
        `export const widget = { n: 1 };\nexport function helper(): void {}\n`
      );
      // bar uses widget ONLY in an array and re-exports helper — neither is
      // called/typed, so before import-linking bar had no edge to foo at all.
      fs.writeFileSync(
        path.join(dir, 'src', 'bar.ts'),
        `import { widget } from './foo';\nexport { helper } from './foo';\nexport const registry = [widget];\n`
      );
      const cg = CodeGraph.initSync(dir, { config: { include: ['src/**/*.ts'], exclude: [] } });
      await cg.indexAll();
      cg.resolveReferences();
      expect(cg.getFileDependents('src/foo.ts')).toContain('src/bar.ts');
      cg.destroy();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('a namespace import touched only via a value-member read still links the module file', async () => {
    const dir = createTempDir();
    try {
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src', 'foo.ts'), `export const SOME_CONST = 42;\n`);
      // `foo` is imported as a namespace and used ONLY via a value-member read
      // (no call, no type) — `foo.helper()` would link on its own, but a bare
      // `foo.SOME_CONST` would not, so the module-import backstop must link it.
      fs.writeFileSync(path.join(dir, 'src', 'bar.ts'), `import * as foo from './foo';\nexport const x = foo.SOME_CONST;\n`);
      const cg = CodeGraph.initSync(dir, { config: { include: ['src/**/*.ts'], exclude: [] } });
      await cg.indexAll();
      cg.resolveReferences();
      expect(cg.getFileDependents('src/foo.ts')).toContain('src/bar.ts');
      cg.destroy();
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe('Python import dependency linking (blast-radius recall)', () => {
  // Same recall gap as TS: Python only linked called/instantiated imports, so a
  // name brought in with `from module import X` and then merely stored, used as
  // a decorator/argument, or re-exported through an `__init__.py` produced no
  // cross-file edge — the providing module showed a false "0 dependents".
  it('emits an imports reference per name in a `from module import ...` (incl. value/aliased)', () => {
    const code = [
      'from foo import helper, widget',
      'from foo import Thing as T',
      'from . import sibling',
      'from bar import *',
    ].join('\n');
    const names = extractFromSource('mod.py', code)
      .unresolvedReferences.filter((r) => r.referenceKind === 'imports')
      .map((r) => r.referenceName);
    expect(names).toContain('helper');
    expect(names).toContain('widget');   // value import
    expect(names).toContain('T');        // aliased import → local name
    expect(names).toContain('sibling');  // `from . import <name>`
    expect(names).not.toContain('*');    // wildcard import has no names
  });

  it('a Python value imported but never called still makes the importer a dependent', async () => {
    const dir = createTempDir();
    try {
      fs.mkdirSync(path.join(dir, 'pkg'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'pkg', 'foo.py'), `widget = {"n": 1}\ndef helper():\n    return 1\n`);
      // bar imports widget+helper but only stores widget in a list — nothing is
      // called, so before import-linking bar had no edge to foo.
      fs.writeFileSync(path.join(dir, 'pkg', 'bar.py'), `from foo import widget, helper\nregistry = [widget]\n`);
      const cg = CodeGraph.initSync(dir, { config: { include: ['pkg/**/*.py'], exclude: [] } });
      await cg.indexAll();
      cg.resolveReferences();
      expect(cg.getFileDependents('pkg/foo.py')).toContain('pkg/bar.py');
      cg.destroy();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('resolves `from . import submodule` + `submodule.func()` to the submodule', async () => {
    const dir = createTempDir();
    try {
      fs.mkdirSync(path.join(dir, 'pkg'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'pkg', '__init__.py'), '');
      fs.writeFileSync(path.join(dir, 'pkg', 'certs.py'), `def where():\n    return "/ca.pem"\n`);
      // certs is an imported MODULE (a file), and certs.where() is a qualified
      // call through it — the receiver isn't a symbol, so plain name-matching
      // can't link it. Also exercises the Python relative-dot path fix (`.certs`).
      fs.writeFileSync(path.join(dir, 'pkg', 'utils.py'), `from . import certs\ndef go():\n    return certs.where()\n`);
      const cg = CodeGraph.initSync(dir, { config: { include: ['pkg/**/*.py'], exclude: [] } });
      await cg.indexAll();
      cg.resolveReferences();
      expect(cg.getFileDependents('pkg/certs.py')).toContain('pkg/utils.py');
      cg.destroy();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('a module import is a dependency even when the used member is re-exported elsewhere', async () => {
    const dir = createTempDir();
    try {
      fs.mkdirSync(path.join(dir, 'pkg'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'pkg', '__init__.py'), '');
      // `where` is NOT defined in certs.py (re-exported from a 3rd-party pkg), so
      // member resolution can't find it — the module-import backstop must still
      // record utils -> certs. (Mirrors requests' real `certs.where`.)
      fs.writeFileSync(path.join(dir, 'pkg', 'certs.py'), `from external_ca import where\n`);
      fs.writeFileSync(path.join(dir, 'pkg', 'utils.py'), `from . import certs\nCA = certs.where()\n`);
      const cg = CodeGraph.initSync(dir, { config: { include: ['pkg/**/*.py'], exclude: [] } });
      await cg.indexAll();
      cg.resolveReferences();
      expect(cg.getFileDependents('pkg/certs.py')).toContain('pkg/utils.py');
      cg.destroy();
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe('Go cross-package composite literals (blast-radius recall)', () => {
  // Go function calls and type references across packages already resolved, but
  // struct composite literals — `render.XML{...}` / `pkga.Widget{...}` — were not
  // extracted at all, so a package whose types are only INSTANTIATED elsewhere
  // (gin's render/binding implementations) showed 0 dependents.
  it('links a cross-package struct composite literal to the defining package', async () => {
    const dir = createTempDir();
    try {
      fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/proj\n\ngo 1.21\n');
      fs.mkdirSync(path.join(dir, 'render'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'render', 'xml.go'), `package render\n\ntype XML struct { Data any }\n`);
      fs.writeFileSync(path.join(dir, 'app.go'), `package main\n\nimport "example.com/proj/render"\n\nfunc handle() any { return render.XML{} }\n`);
      const cg = CodeGraph.initSync(dir, { config: { include: ['**/*.go'], exclude: [] } });
      await cg.indexAll();
      cg.resolveReferences();
      expect(cg.getFileDependents('render/xml.go')).toContain('app.go');
      cg.destroy();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('links a composite literal in a package-level var registry', async () => {
    const dir = createTempDir();
    try {
      fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/proj\n\ngo 1.21\n');
      fs.mkdirSync(path.join(dir, 'render'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'render', 'xml.go'), `package render\n\ntype XML struct {}\nfunc (XML) Render() {}\n`);
      // The implementation is registered only in a top-level `var registry = {...}`
      // map literal — the body walker doesn't cover top-level declarations, so this
      // exercises the var-initializer walking added for Go.
      fs.writeFileSync(path.join(dir, 'reg.go'), `package main\n\nimport "example.com/proj/render"\n\ntype R interface { Render() }\n\nvar registry = map[string]R{ "xml": render.XML{} }\n`);
      const cg = CodeGraph.initSync(dir, { config: { include: ['**/*.go'], exclude: [] } });
      await cg.indexAll();
      cg.resolveReferences();
      expect(cg.getFileDependents('render/xml.go')).toContain('reg.go');
      cg.destroy();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('attributes a call inside a top-level closure (cobra RunE) to the var, not the file (#693)', async () => {
    const dir = createTempDir();
    try {
      fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/proj\n\ngo 1.21\n');
      // Wire is called ONLY from the anonymous RunE closure inside a top-level
      // `var rootCmd = &Cmd{...}` — previously the call leaked to the file node,
      // so `callers(Wire)` surfaced a file (or read as "no caller"). It must now
      // attribute to the enclosing var.
      fs.writeFileSync(path.join(dir, 'factory.go'), `package main\n\nfunc Wire() error { return nil }\n`);
      fs.writeFileSync(
        path.join(dir, 'root.go'),
        `package main\n\ntype Cmd struct{ RunE func() error }\n\nvar rootCmd = &Cmd{\n\tRunE: func() error { return Wire() },\n}\n`
      );
      const cg = CodeGraph.initSync(dir, { config: { include: ['**/*.go'], exclude: [] } });
      await cg.indexAll();
      cg.resolveReferences();

      const wire = cg.getNodesByName('Wire').find((n) => n.kind === 'function');
      expect(wire).toBeDefined();
      const callers = cg.getCallers(wire!.id).map((c) => c.node);
      expect(callers.some((n) => n.kind === 'variable' && n.name === 'rootCmd')).toBe(true);
      expect(callers.some((n) => n.kind === 'file')).toBe(false);
      cg.destroy();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('links a parenthesized pointer type conversion `(*T)(x)` to the type', async () => {
    const dir = createTempDir();
    try {
      fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/proj\n\ngo 1.21\n');
      fs.writeFileSync(path.join(dir, 'types.go'), `package main\n\ntype Wrapped struct { N int }\n`);
      // `(*Wrapped)(x)` parses as a call whose callee is the parenthesized type
      // `(*Wrapped)` — without normalization it dropped on the floor.
      fs.writeFileSync(path.join(dir, 'use.go'), `package main\n\nfunc run(x *int) { _ = (*Wrapped)(x) }\n`);
      const cg = CodeGraph.initSync(dir, { config: { include: ['**/*.go'], exclude: [] } });
      await cg.indexAll();
      cg.resolveReferences();
      expect(cg.getFileDependents('types.go')).toContain('use.go');
      cg.destroy();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('links an implementation reached only through a Go interface (implicit satisfaction, #584)', async () => {
    const dir = createTempDir();
    try {
      fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/proj\n\ngo 1.21\n');
      fs.mkdirSync(path.join(dir, 'codec'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'codec', 'api.go'), `package codec\n\ntype Core interface {\n\tMarshal(v any) ([]byte, error)\n}\n\nvar API Core\n`);
      // jsonApi satisfies Core structurally (no `implements` keyword) and is
      // reached ONLY through the interface (API.Marshal). Without implicit
      // interface satisfaction + dispatch, json.go shows 0 dependents.
      fs.writeFileSync(path.join(dir, 'codec', 'json.go'), `package codec\n\ntype jsonApi struct{}\n\nfunc (j jsonApi) Marshal(v any) ([]byte, error) { return nil, nil }\n\nfunc init() { API = jsonApi{} }\n`);
      const cg = CodeGraph.initSync(dir, { config: { include: ['**/*.go'], exclude: [] } });
      await cg.indexAll();
      cg.resolveReferences();
      expect(cg.getFileDependents('codec/json.go')).toContain('codec/api.go');
      cg.destroy();
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe('C# records (blast-radius recall)', () => {
  // Records are ubiquitous in modern C# (DTOs, value objects, CQRS messages),
  // but `record` / `record struct` declarations weren't extracted as types — so
  // every reference, generic-type-argument, and `new` of a record dropped on the
  // floor and the defining file showed 0 dependents. (#237)
  it('extracts a record as a graph node (record class + record struct)', () => {
    const r = extractFromSource('r.cs', `namespace P;\npublic record Box(int N);\npublic record struct Pt(int X);\n`);
    expect(r.nodes.find((n) => n.name === 'Box' && (n.kind === 'class' || n.kind === 'struct'))).toBeDefined();
    expect(r.nodes.find((n) => n.name === 'Pt' && (n.kind === 'class' || n.kind === 'struct'))).toBeDefined();
  });

  it('resolves references / instantiations of a record across files', async () => {
    const dir = createTempDir();
    try {
      fs.writeFileSync(path.join(dir, 'types.cs'), `namespace P;\npublic record Box(int N);\n`);
      // Box is used as a generic type argument and instantiated — both require
      // Box to be a node to resolve.
      fs.writeFileSync(
        path.join(dir, 'use.cs'),
        `using System.Collections.Generic;\nnamespace P;\npublic class User {\n    public IEnumerable<Box> Boxes { get; }\n    public Box Make() => new Box(1);\n}\n`
      );
      const cg = CodeGraph.initSync(dir, { config: { include: ['**/*.cs'], exclude: [] } });
      await cg.indexAll();
      cg.resolveReferences();
      expect(cg.getFileDependents('types.cs')).toContain('use.cs');
      cg.destroy();
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe('Rust cross-module recall', () => {
  function rustProject(files: Record<string, string>): string {
    const dir = createTempDir();
    fs.writeFileSync(path.join(dir, 'Cargo.toml'), '[package]\nname = "proj"\nversion = "0.1.0"\nedition = "2021"\n');
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, 'src', rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    return dir;
  }

  it('extracts a struct literal `Foo { .. }` as an instantiation across modules', async () => {
    const dir = rustProject({
      'lib.rs': 'pub mod types;\npub mod consumer;\n',
      'types.rs': 'pub struct Widget { pub n: i32 }\n',
      'consumer.rs': 'use crate::types::Widget;\npub fn build() -> Widget { Widget { n: 1 } }\n',
    });
    try {
      const cg = CodeGraph.initSync(dir, { config: { include: ['src/**/*.rs'], exclude: [] } });
      await cg.indexAll();
      cg.resolveReferences();
      expect(cg.getFileDependents('src/types.rs')).toContain('src/consumer.rs');
      cg.destroy();
    } finally { cleanupTempDir(dir); }
  });

  it('extracts trait method declarations and bridges trait dispatch to the impl', async () => {
    const dir = rustProject({
      'lib.rs': 'pub mod types;\npub mod consumer;\n',
      'types.rs': 'pub trait Render { fn render(&self) -> i32; }\n',
      // Mine implements Render structurally; reached via &dyn Render dispatch.
      'consumer.rs': 'use crate::types::Render;\npub struct Mine { pub x: i32 }\nimpl Render for Mine { fn render(&self) -> i32 { self.x } }\n',
    });
    try {
      const cg = CodeGraph.initSync(dir, { config: { include: ['src/**/*.rs'], exclude: [] } });
      await cg.indexAll();
      cg.resolveReferences();
      // implements edge (Mine -> Render) makes types.rs a dependent of consumer.rs's struct.
      expect(cg.getFileDependents('src/types.rs')).toContain('src/consumer.rs');
      cg.destroy();
    } finally { cleanupTempDir(dir); }
  });

  it('links `pub use` re-export hubs to the modules they re-export', async () => {
    const dir = rustProject({
      'lib.rs': 'pub mod api;\n',
      'api/mod.rs': 'mod widget;\npub use self::widget::Widget;\n',
      'api/widget.rs': 'pub struct Widget { pub n: i32 }\n',
    });
    try {
      const cg = CodeGraph.initSync(dir, { config: { include: ['src/**/*.rs'], exclude: [] } });
      await cg.indexAll();
      cg.resolveReferences();
      // The re-export hub depends on the module it re-exports from.
      expect(cg.getFileDependents('src/api/widget.rs')).toContain('src/api/mod.rs');
      cg.destroy();
    } finally { cleanupTempDir(dir); }
  });

  it('resolves a qualified path to the correct module when the leaf name collides', async () => {
    const dir = rustProject({
      'lib.rs': 'pub mod fast;\npub mod slow;\npub mod hub;\n',
      'fast.rs': 'pub fn read() -> i32 { 1 }\n',
      'slow.rs': 'pub fn read() -> i32 { 2 }\n',
      // `read` exists in BOTH fast.rs and slow.rs — module-path resolution must
      // send this re-export to fast.rs specifically, not name-match either.
      'hub.rs': 'pub use crate::fast::read;\n',
    });
    try {
      const cg = CodeGraph.initSync(dir, { config: { include: ['src/**/*.rs'], exclude: [] } });
      await cg.indexAll();
      cg.resolveReferences();
      expect(cg.getFileDependents('src/fast.rs')).toContain('src/hub.rs');
      expect(cg.getFileDependents('src/slow.rs')).not.toContain('src/hub.rs');
      cg.destroy();
    } finally { cleanupTempDir(dir); }
  });
});

describe('Java annotations (blast-radius recall)', () => {
  it('indexes @interface definitions and links @Annotation usages to them', async () => {
    const dir = createTempDir();
    try {
      fs.mkdirSync(path.join(dir, 'p'), { recursive: true });
      // The annotation DEFINITION must be a node, and the @MyAnno usages (which
      // live inside a `modifiers` node on the class/field/method) must extract.
      fs.writeFileSync(path.join(dir, 'p', 'MyAnno.java'), `package p;\npublic @interface MyAnno { String value() default ""; }\n`);
      fs.writeFileSync(
        path.join(dir, 'p', 'User.java'),
        `package p;\n@MyAnno("c")\npublic class User {\n  @MyAnno("f") int field;\n  @MyAnno("m") void go() {}\n}\n`
      );
      const cg = CodeGraph.initSync(dir, { config: { include: ['**/*.java'], exclude: [] } });
      await cg.indexAll();
      cg.resolveReferences();
      expect(cg.getFileDependents('p/MyAnno.java')).toContain('p/User.java');
      cg.destroy();
    } finally { cleanupTempDir(dir); }
  });
});

describe('Swift property wrappers / attributes (blast-radius recall)', () => {
  it('links a @propertyWrapper usage to the wrapper type', async () => {
    const dir = createTempDir();
    try {
      fs.mkdirSync(path.join(dir, 'Sources', 'M'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'Sources', 'M', 'Wrap.swift'), `@propertyWrapper\npublic struct Argument<T> { public var wrappedValue: T }\n`);
      // `@Argument` is a Swift attribute on a stored property — it lives in the
      // property's `modifiers` and Swift doesn't extract instance properties as
      // their own nodes, so without the fix the wrapper type has no users.
      fs.writeFileSync(path.join(dir, 'Sources', 'M', 'Cmd.swift'), `public struct MyCommand {\n  @Argument var name: String\n  @Argument var count: Int\n}\n`);
      const cg = CodeGraph.initSync(dir, { config: { include: ['Sources/**/*.swift'], exclude: [] } });
      await cg.indexAll();
      cg.resolveReferences();
      expect(cg.getFileDependents('Sources/M/Wrap.swift')).toContain('Sources/M/Cmd.swift');
      cg.destroy();
    } finally { cleanupTempDir(dir); }
  });
});

describe('Edge re-wiring during sync', () => {
  let tempDir: string;
  let cg: CodeGraph | null = null;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    if (cg) { try { cg.close(); } catch { /* already closed */ } }
    cg = null;
    try {
      if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    } catch { /* Windows file-lock timing */ }
  });

  it('rewires incoming cross-file edges when a changed file is re-indexed', async () => {
    // Set up a C project: a.h declares foo(), b.c calls foo()
    fs.writeFileSync(
      path.join(tempDir, 'a.h'),
      `#ifndef A_H
#define A_H
void foo(void);
#endif
`
    );
    fs.writeFileSync(
      path.join(tempDir, 'a.c'),
      `#include "a.h"
void foo(void) {
  return;
}
`
    );
    fs.writeFileSync(
      path.join(tempDir, 'b.c'),
      `#include "a.h"
void bar(void) {
  foo();
}
`
    );

    // Initial index
    cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.resolveReferences();

    // Find the nodes — getNodesByName returns Node[]
    const fooNodes = cg.getNodesByName('foo');
    const fooDef = fooNodes.find((n) => n.kind === 'function' && n.filePath === 'a.c');
    expect(fooDef).toBeDefined();

    const barNodes = cg.getNodesByName('bar');
    const barDef = barNodes.find((n) => n.kind === 'function' && n.filePath === 'b.c');
    expect(barDef).toBeDefined();

    // b.c calls foo() → verify the cross-file edge exists
    const callers = cg.getCallers(fooDef!.id);
    expect(callers.some((c) => c.node.id === barDef!.id)).toBe(true);

    // Record b.c's indexedAt before sync
    const fileBefore = (cg as any).queries.getFileByPath('b.c');
    expect(fileBefore).toBeDefined();
    const indexedBefore = fileBefore!.indexedAt;

    // Modify a.c (change foo's body, keep the name and signature)
    fs.writeFileSync(
      path.join(tempDir, 'a.c'),
      `#include "a.h"
void foo(void) {
  int x = 1;  /* changed body */
  (void)x;
  return;
}
`
    );

    // Sync
    const result = await cg.sync();

    // The cross-file edge should still exist (rewired to new node ID)
    const fooDefAfter = cg.getNodesByName('foo').find((n) => n.kind === 'function' && n.filePath === 'a.c');
    expect(fooDefAfter).toBeDefined();
    const callersAfter = cg.getCallers(fooDefAfter!.id);
    expect(callersAfter.some((c) => c.node.id === barDef!.id)).toBe(true);

    // b.c should NOT have been re-indexed
    const fileAfter = (cg as any).queries.getFileByPath('b.c');
    expect(fileAfter).toBeDefined();
    expect(fileAfter!.indexedAt).toBe(indexedBefore);

    // No failed rewires — co-importer skipped
    expect(result.failedRewireSourceFiles).toBeUndefined();

    cg.close();
    cg = null;
  });

  it('preserves the unchanged caller reference when a symbol is renamed', async () => {
    // Set up: a.h declares foo(), a.c defines foo(), b.c calls foo()
    fs.writeFileSync(
      path.join(tempDir, 'a.h'),
      `#ifndef A_H
#define A_H
void foo(void);
#endif
`
    );
    fs.writeFileSync(
      path.join(tempDir, 'a.c'),
      `#include "a.h"
void foo(void) { return; }
`
    );
    fs.writeFileSync(
      path.join(tempDir, 'b.c'),
      `#include "a.h"
void bar(void) { foo(); }
`
    );

    cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.resolveReferences();

    const fooDef = cg.getNodesByName('foo').find((n) => n.kind === 'function' && n.filePath === 'a.c');
    expect(fooDef).toBeDefined();
    const barDef = cg.getNodesByName('bar').find((n) => n.kind === 'function' && n.filePath === 'b.c');
    expect(barDef).toBeDefined();
    expect(cg.getCallers(fooDef!.id).some((c) => c.node.id === barDef!.id)).toBe(true);

    // Rename foo → renamed_foo in a.c and a.h
    fs.writeFileSync(
      path.join(tempDir, 'a.h'),
      `#ifndef A_H
#define A_H
void renamed_foo(void);
#endif
`
    );
    fs.writeFileSync(
      path.join(tempDir, 'a.c'),
      `#include "a.h"
void renamed_foo(void) { return; }
`
    );

    const result = await cg.sync();

    // renamed_foo should exist
    const renamedDef = cg.getNodesByName('renamed_foo').find((n) => n.kind === 'function' && n.filePath === 'a.c');
    expect(renamedDef).toBeDefined();

    // Resolver-stamped incoming references are retained directly, without
    // rebuilding the caller and cascading deletes into further source files.
    expect(result.failedRewireSourceFiles ?? []).not.toContain('b.c');
    const raw = (cg as any).db.db;
    expect(raw.prepare(`SELECT status FROM unresolved_refs
      WHERE from_node_id=? AND reference_name='foo'`).get(barDef!.id)?.status).toBe('failed');

    cg.close();
    cg = null;
  });

  it('rewires edges correctly when only comments change (no symbol changes)', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'a.h'),
      `#ifndef A_H
#define A_H
int get_value(void);
#endif
`
    );
    fs.writeFileSync(
      path.join(tempDir, 'a.c'),
      `#include "a.h"
int get_value(void) { return 42; }
`
    );
    fs.writeFileSync(
      path.join(tempDir, 'b.c'),
      `#include "a.h"
int compute(void) { return get_value() + 1; }
`
    );

    cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.resolveReferences();

    const getValueDef = cg.getNodesByName('get_value').find((n) => n.kind === 'function' && n.filePath === 'a.c');
    expect(getValueDef).toBeDefined();
    const computeDef = cg.getNodesByName('compute').find((n) => n.kind === 'function' && n.filePath === 'b.c');
    expect(computeDef).toBeDefined();
    expect(cg.getCallers(getValueDef!.id).some((c) => c.node.id === computeDef!.id)).toBe(true);

    // Modify a.c — only change a comment, no symbol changes
    fs.writeFileSync(
      path.join(tempDir, 'a.c'),
      `#include "a.h"
/* This is a changed comment */
int get_value(void) { return 42; }
`
    );

    const result = await cg.sync();

    // Edge should still exist
    const getValueAfter = cg.getNodesByName('get_value').find((n) => n.kind === 'function' && n.filePath === 'a.c');
    expect(getValueAfter).toBeDefined();
    const callersAfter = cg.getCallers(getValueAfter!.id);
    expect(callersAfter.some((c) => c.node.id === computeDef!.id)).toBe(true);

    // No failed rewires
    expect(result.failedRewireSourceFiles).toBeUndefined();

    cg.close();
    cg = null;
  });
});
