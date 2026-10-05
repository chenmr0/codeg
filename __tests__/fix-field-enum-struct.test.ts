// 根因 A 修复验证：类内 enum/struct/class 无尾随声明符 + 匿名 enum/struct
// 运行: npx vitest run __tests__/fix-field-enum-struct.test.ts
//
// 修复目标（src/extraction/tree-sitter.ts）:
//   修复点 1: extractField 开头下钻 enum_specifier/struct_specifier/class_specifier 子节点
//   修复点 2: extractEnum 匿名 enum 仍遍历成员（不 push nodeStack）
//   修复点 3: extractStruct 匿名 struct 仍遍历 field（不 push nodeStack）
import { describe, it, expect, beforeAll } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

function kinds(code: string): Record<string, number> {
  const r = extractFromSource('test.cpp', code, 'cpp');
  const counts: Record<string, number> = {};
  for (const n of r.nodes) {
    const key = n.kind;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function names(code: string, kind: string): string[] {
  const r = extractFromSource('test.cpp', code, 'cpp');
  return r.nodes.filter(n => n.kind === kind).map(n => n.name);
}

describe('根因 A 修复 - 类内 type 定义边界', () => {
  beforeAll(async () => {
    await initGrammars();
    await loadAllGrammars();
  });

  it('类内 enum 无声明符: enum E { A, B };', () => {
    const code = `class C {\npublic:\n  enum E { A, B };\n  int x;\n};`;
    expect(names(code, 'enum')).toContain('E');
    expect(names(code, 'enum_member').sort()).toEqual(['A', 'B']);
    expect(names(code, 'field')).toContain('x');
  });

  it('类内 enum 带声明符: enum E { A, B } e;', () => {
    const code = `class C {\npublic:\n  enum E { A, B } e;\n  int x;\n};`;
    expect(names(code, 'enum')).toContain('E');
    expect(names(code, 'enum_member').sort()).toEqual(['A', 'B']);
    // 带声明符时 e 仍被提取为 field
    expect(names(code, 'field')).toContain('e');
    expect(names(code, 'field')).toContain('x');
  });

  it('类内 struct 无声明符: struct S { int a; };', () => {
    const code = `class C {\npublic:\n  struct S { int a; };\n  int x;\n};`;
    expect(names(code, 'struct')).toContain('S');
    expect(names(code, 'field')).toContain('a');
    expect(names(code, 'field')).toContain('x');
  });

  it('类内 struct 带声明符: struct S { int a; } s;', () => {
    const code = `class C {\npublic:\n  struct S { int a; } s;\n  int x;\n};`;
    expect(names(code, 'struct')).toContain('S');
    expect(names(code, 'field')).toContain('a');
    expect(names(code, 'field')).toContain('s');
    expect(names(code, 'field')).toContain('x');
  });

  it('类内 class 嵌套: class Inner { public: int y; };', () => {
    const code = `class Outer {\npublic:\n  class Inner { public: int y; };\n  int x;\n};`;
    expect(names(code, 'class')).toContain('Outer');
    expect(names(code, 'class')).toContain('Inner');
    expect(names(code, 'field')).toContain('y');
    expect(names(code, 'field')).toContain('x');
  });

  it('类内匿名 enum: enum { A, B };', () => {
    const code = `class C {\npublic:\n  enum { A, B };\n  int x;\n};`;
    // 匿名 enum 使用与 clangd 一致的稳定名称，便于按位置精确查询。
    expect(names(code, 'enum')).toContain('(anonymous enum)');
    // 成员必须被提取
    expect(names(code, 'enum_member').sort()).toEqual(['A', 'B']);
    expect(names(code, 'field')).toContain('x');
  });

  it('类内匿名 struct: struct { int a; int b; };', () => {
    const code = `class C {\npublic:\n  struct { int a; int b; };\n  int x;\n};`;
    // 匿名 struct 使用与 clangd 一致的稳定名称，便于按位置精确查询。
    expect(names(code, 'struct')).toContain('(anonymous struct)');
    expect(names(code, 'field')).toContain('a');
    expect(names(code, 'field')).toContain('b');
    expect(names(code, 'field')).toContain('x');
  });

  it('类内 typedef enum 不受影响（走 type_definition）', () => {
    const code = `class C {\npublic:\n  typedef enum { A, B } MyEnum;\n  int x;\n};`;
    expect(names(code, 'enum')).toContain('MyEnum');
    expect(names(code, 'enum_member').sort()).toEqual(['A', 'B']);
    expect(names(code, 'field')).toContain('x');
  });

  it('类内 enum class (scoped): enum class E : int { A, B };', () => {
    const code = `class C {\npublic:\n  enum class E : int { A, B };\n  int x;\n};`;
    expect(names(code, 'enum')).toContain('E');
    expect(names(code, 'enum_member').sort()).toEqual(['A', 'B']);
    expect(names(code, 'field')).toContain('x');
  });

  // 无回归：方法声明仍正常
  it('无回归: 方法声明 void bar();', () => {
    const code = `class C {\npublic:\n  void bar();\n  int x;\n};`;
    expect(names(code, 'method')).toContain('bar');
    expect(names(code, 'field')).toContain('x');
    expect(names(code, 'enum').length).toBe(0);
    expect(names(code, 'struct').length).toBe(0);
  });

  // 无回归：多字段声明
  it('无回归: 多字段 int x, *p;', () => {
    const code = `class C {\npublic:\n  int x, *p;\n};`;
    expect(names(code, 'field').sort()).toEqual(['p', 'x']);
  });

  // 无回归：forward declaration 不触发（class Foo; 无 body）
  it('无回归: 类内 forward declaration class Foo; 不下钻', () => {
    const code = `class C {\npublic:\n  class Foo;\n  int x;\n};`;
    // class Foo; 无 body，不应被作为嵌套 class 提取（forward decl）
    expect(names(code, 'field')).toContain('x');
  });

  // 嵌套 struct 内含 enum
  it('嵌套: struct 内 enum', () => {
    const code = `class C {\npublic:\n  struct S { enum E { A, B }; int a; };\n  int x;\n};`;
    expect(names(code, 'struct')).toContain('S');
    expect(names(code, 'enum')).toContain('E');
    expect(names(code, 'enum_member').sort()).toEqual(['A', 'B']);
    expect(names(code, 'field')).toContain('a');
    expect(names(code, 'field')).toContain('x');
  });
});

describe('根因 A 修复 - OceanBase 结构的自包含回归 fixture', () => {
  beforeAll(async () => {
    await initGrammars();
    await loadAllGrammars();
  });

  it('ob_virtual_show_trace.h: SYS_COLUMN 类内 enum 应被提取', () => {
    // Reduced regression shape, not a dependency on a developer's checkout.
    // Keep nested namespaces, class scope, explicit enum values and a method
    // after the enum so traversal must resume normally.
    const source = `
namespace oceanbase {
namespace observer {
class ObVirtualShowTrace {
public:
  enum SYS_COLUMN {
    SVR_IP = 16,
    SPAN_ID,
    LOGS,
  };
  int inner_get_next_row();
};
}
}
`;
    const r = extractFromSource('ob_virtual_show_trace.h', source, 'cpp');
    const enums = r.nodes.filter(n => n.kind === 'enum');
    const members = r.nodes.filter(n => n.kind === 'enum_member');
    // SYS_COLUMN 应被提取为 enum
    expect(enums.some(n => n.name === 'SYS_COLUMN')).toBe(true);
    // 其成员 SVR_IP/SPAN_ID 等应被提取
    expect(members.some(n => n.name === 'SVR_IP')).toBe(true);
    expect(members.some(n => n.name === 'SPAN_ID')).toBe(true);
    expect(members.some(n => n.name === 'LOGS')).toBe(true);
    expect(r.nodes.some(n => n.kind === 'method' && n.name === 'inner_get_next_row')).toBe(true);
  });

  it('ob_pl_compile_utils.h: CompileType 类内 enum 应被提取', () => {
    const source = `
namespace oceanbase {
namespace pl {
class ObPLCompileUtils {
public:
  enum CompileType {
    COMPILE_INVALID = 0,
    COMPILE_PROCEDURE,
    COMPILE_FUNCTION,
  };
  static int compile(CompileType type);
};
}
}
`;
    const r = extractFromSource('ob_pl_compile_utils.h', source, 'cpp');
    const enums = r.nodes.filter(n => n.kind === 'enum');
    const members = r.nodes.filter(n => n.kind === 'enum_member');
    expect(enums.some(n => n.name === 'CompileType')).toBe(true);
    // CompileType 的成员应以 COMPILE_ 开头（COMPILE_INVALID / COMPILE_PROCEDURE 等）
    expect(members.some(n => n.name?.startsWith('COMPILE_'))).toBe(true);
    expect(members.map(n => n.name)).toEqual(expect.arrayContaining(['COMPILE_INVALID', 'COMPILE_PROCEDURE', 'COMPILE_FUNCTION']));
    expect(r.nodes.some(n => n.kind === 'method' && n.name === 'compile')).toBe(true);
  });
});
