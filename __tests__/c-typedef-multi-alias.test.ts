import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

/**
 * Regression test for the C `typedef struct/enum Tag { ... } A, B;` multi-alias
 * declaration. Reading a single `declarator` field drops the second+ aliases.
 * Enumerate declarator fields, preserve the primary type's field ownership,
 * and retain tags as real struct/enum nodes rather than inventing aliases.
 */
describe('c typedef multi-alias extraction', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-typedef-alias-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  type Row = {
    kind: string;
    name: string;
    qualified_name: string;
    start_line: number;
    end_line: number;
  };

  /** Index a single header, return all nodes in it + the type_of edge count. */
  const indexHeader = async (content: string): Promise<{ ns: Row[]; typeOf: number }> => {
    fs.writeFileSync(path.join(dir, 't.h'), content);
    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const ns = db
      .prepare(
        'SELECT kind, name, qualified_name, start_line, end_line FROM nodes WHERE file_path = ? ORDER BY start_line, name',
      )
      .all('t.h') as Row[];
    const typeOf = (
      db.prepare("SELECT COUNT(*) c FROM edges WHERE kind = 'type_of'").get() as any
    ).c as number;
    cg.close?.();
    return { ns, typeOf };
  };

  it('补建 typedef struct 多别名与 tag 名（主节点不变、字段仍挂主节点）', async () => {
    const { ns, typeOf } = await indexHeader(
      `typedef struct MsgCB {\n  int x;\n  unsigned char aucValue[4];\n} MSG_CB, MsgBlock;\n`,
    );
    const byName = (n: string) => ns.filter((x) => x.name === n);

    // 主节点不变：struct MSG_CB，跨整块 1-4
    expect(byName('MSG_CB')).toHaveLength(1);
    expect(byName('MSG_CB')[0]!.kind).toBe('struct');
    expect(byName('MSG_CB')[0]!.start_line).toBe(1);
    expect(byName('MSG_CB')[0]!.end_line).toBe(4);

    // 字段仍挂主节点（qualified_name 用主节点名）
    expect(ns.some((x) => x.name === 'x' && x.qualified_name === 'MSG_CB::x')).toBe(true);
    expect(
      ns.some((x) => x.name === 'aucValue' && x.qualified_name === 'MSG_CB::aucValue'),
    ).toBe(true);

    // 第 2 个别名补建为 type_alias
    expect(byName('MsgBlock')).toHaveLength(1);
    expect(byName('MsgBlock')[0]!.kind).toBe('type_alias');
    expect(byName('MsgBlock')[0]!.start_line).toBe(1);

    // struct tag retains its actual type, rather than becoming a typedef alias.
    expect(byName('MsgCB')).toHaveLength(1);
    expect(byName('MsgCB')[0]!.kind).toBe('struct');

    // 不加任何 type_of 边
    expect(typeOf).toBe(0);
  });

  it('普通 typedef 多别名也补建，且不加边', async () => {
    const { ns, typeOf } = await indexHeader(`typedef int A, B;\n`);
    expect(ns.filter((x) => x.name === 'A' && x.kind === 'type_alias')).toHaveLength(1);
    expect(ns.filter((x) => x.name === 'B' && x.kind === 'type_alias')).toHaveLength(1);
    expect(typeOf).toBe(0);
  });

  it('tag 与别名同名时去重，不重复建节点', async () => {
    const { ns } = await indexHeader(`typedef struct Foo {\n  int a;\n} Foo;\n`);
    // 主节点仍是 struct Foo；tag 名与主名相同，去重跳过，不建 type_alias Foo
    expect(ns.filter((x) => x.name === 'Foo' && x.kind === 'struct')).toHaveLength(1);
    expect(ns.filter((x) => x.name === 'Foo' && x.kind === 'type_alias')).toHaveLength(0);
  });

  it('匿名 struct 多别名不建 tag 节点', async () => {
    const { ns } = await indexHeader(`typedef struct {\n  int b;\n} B1, B2;\n`);
    expect(ns.filter((x) => x.name === 'B1' && x.kind === 'struct')).toHaveLength(1);
    expect(ns.filter((x) => x.name === 'B2' && x.kind === 'type_alias')).toHaveLength(1);
  });

  it('typedef enum 多别名与 tag 名也补建', async () => {
    const { ns } = await indexHeader(`typedef enum Color { RED, GREEN } Color, ColorT;\n`);
    const byName = (n: string) => ns.filter((x) => x.name === n);
    // 主节点：enum Color
    expect(byName('Color').filter((x) => x.kind === 'enum')).toHaveLength(1);
    // 第 2 别名补建为 type_alias
    expect(byName('ColorT').filter((x) => x.kind === 'type_alias')).toHaveLength(1);
    // tag 名 Color 与主名同名 → 去重，不重复建 type_alias Color
    expect(byName('Color').filter((x) => x.kind === 'type_alias')).toHaveLength(0);
  });
});
