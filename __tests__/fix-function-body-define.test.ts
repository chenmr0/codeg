// 根因 E 修复验证：函数体内 #define 宏提取 + 宏参数不产生虚假 references 边
// 运行: npx vitest run __tests__/fix-function-body-define.test.ts
//
// 修复目标（src/extraction/tree-sitter.ts）:
//   visitFunctionBody 的 visitForCallsAndStructure 增加 macroTypes 分支，
//   遇 preproc_def/preproc_function_def 调 extractMacro 并 return，
//   与 visitNode 的 macroTypes + skipChildren 行为对齐。
import { describe, it, expect, beforeAll } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

function macroNames(code: string, lang = 'cpp'): string[] {
  const r = extractFromSource('test.' + lang, code, lang);
  return r.nodes.filter(n => n.kind === 'macro').map(n => n.name);
}

function refNames(code: string, lang = 'cpp'): string[] {
  const r = extractFromSource('test.' + lang, code, lang);
  return r.unresolvedReferences
    .filter(ref => ref.referenceKind === 'references')
    .map(ref => ref.referenceName);
}

describe('根因 E 修复 - 函数体内 #define 宏提取', () => {
  beforeAll(async () => {
    await initGrammars();
    await loadAllGrammars();
  });

  it('函数体内 object-like macro: #define FOO 42', () => {
    const code = `int f() {\n  #define FOO 42\n  return FOO;\n}`;
    expect(macroNames(code)).toContain('FOO');
  });

  it('函数体内 function-like macro: #define MAX(a,b) ...', () => {
    const code = `int f() {\n  #define MAX(a, b) ((a) > (b) ? (a) : (b))\n  return MAX(1, 2);\n}`;
    expect(macroNames(code)).toContain('MAX');
  });

  it('多行 function-like macro (\\ 续行)', () => {
    const code = [
      'int f() {',
      '  #define ALLOCATE(ctx, idx, class, ptr)    \\',
      '  do {                                        \\',
      '    if (nullptr == iter_alloc) {              \\',
      '      ptr = new class();                      \\',
      '    }                                         \\',
      '  } while (false)',
      '  return 0;',
      '}',
    ].join('\n');
    expect(macroNames(code)).toContain('ALLOCATE');
  });

  it('宏参数不产生 references 边', () => {
    // 修复前: preproc_function_def 的 preproc_params 下 identifier (a, b)
    // 落入默认 identifier 分支，产生虚假 references 边。
    // 修复后: macroTypes 分支 return，不再遍历子节点。
    const code = `int f() {\n  #define MAX(a, b) ((a) > (b) ? (a) : (b))\n  return MAX(1, 2);\n}`;
    const refs = refNames(code);
    // 宏参数 a, b 不应出现在 references 边中
    expect(refs).not.toContain('a');
    expect(refs).not.toContain('b');
  });

  it('无回归: 顶层宏仍正常提取', () => {
    const code = `#define TOP 1\nint f() { return TOP; }`;
    expect(macroNames(code)).toContain('TOP');
  });

  it('无回归: 函数体内调用不受影响', () => {
    const code = `int bar();\nint f() {\n  return bar();\n}`;
    const r = extractFromSource('test.cpp', code, 'cpp');
    const calls = r.unresolvedReferences.filter(ref => ref.referenceKind === 'calls')
      .map(ref => ref.referenceName);
    expect(calls).toContain('bar');
  });

  it('无回归: 函数体内局部变量声明', () => {
    const code = `int f() {\n  int x = 1;\n  return x;\n}`;
    const r = extractFromSource('test.cpp', code, 'cpp');
    // 不应产生异常节点，函数仍提取
    expect(r.nodes.some(n => n.kind === 'function' && n.name === 'f')).toBe(true);
  });

  it('C 语言同样生效', () => {
    const code = `int f() {\n  #define FOO 42\n  return FOO;\n}`;
    expect(macroNames(code, 'c')).toContain('FOO');
  });

  it('OceanBase 结构的自包含 fixture: 函数内 ALLOCATE_CG_ITER / FREE_CG_ITER', () => {
    // Preserve the regression shape: class method body, multiline local
    // function-like macros, use sites, and #undef before leaving the function.
    const source = [
      'namespace oceanbase { namespace storage {',
      'class ObColumnOrientedSSTable { public: int scan(); };',
      'int ObColumnOrientedSSTable::scan() {',
      '  #define ALLOCATE_CG_ITER(type, ptr) \\',
      '    do { ptr = new type(); } while (false)',
      '  #define FREE_CG_ITER(ptr) \\',
      '    do { delete ptr; ptr = nullptr; } while (false)',
      '  int *iter = nullptr;',
      '  ALLOCATE_CG_ITER(int, iter);',
      '  FREE_CG_ITER(iter);',
      '  #undef ALLOCATE_CG_ITER',
      '  #undef FREE_CG_ITER',
      '  return 0;',
      '}',
      '} }',
    ].join('\n');
    const r = extractFromSource('ob_column_oriented_sstable.cpp', source, 'cpp');
    const macros = r.nodes.filter(n => n.kind === 'macro').map(n => n.name);
    expect(macros.some(n => n === 'ALLOCATE_CG_ITER')).toBe(true);
    expect(macros.some(n => n === 'FREE_CG_ITER')).toBe(true);
    expect(r.nodes.some(n => n.name === 'scan' && n.kind === 'method')).toBe(true);
    expect(r.unresolvedReferences.filter(ref => ref.referenceKind === 'references').map(ref => ref.referenceName)).not.toContain('ptr');
  });
});