/**
 * C++ namespace support: extraction (qualifiedName carries `ns::` prefix),
 * `codegraph_wx_node` lookup (`ns::symbol`), and decl-def pairing of a
 * namespace-scoped class's out-of-line method definition.
 *
 * Before this support, `cppExtractor` never built a namespace node nor pushed
 * it onto the scope stack, so a struct inside `namespace pre_process_buff {}`
 * was extracted with `qualifiedName = "UbuffOffset"` (simple name). That made
 * `codegraph node pre_process_buff::UbuffOffset` return "Symbol not found"
 * (matchesSymbol's qualified-name suffix check never matched) and left two
 * same-named structs in different namespaces indistinguishable.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

describe('C++ namespace extraction & lookup', () => {
  let dir: string;
  let cg: CodeGraph;
  let h: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cppns-'));
    cg = await CodeGraph.init(dir, { silent: true });
    h = new ToolHandler(cg);
  });

  afterEach(() => {
    if (cg) cg.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Write the files and index them. */
  const indexFiles = async (files: Record<string, string>) => {
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), content);
    }
    await cg.indexAll();
  };

  const db = () => (cg as any).db.db;
  const qn = (qualifiedName: string) =>
    db().prepare('SELECT * FROM nodes WHERE qualified_name = ?').get(qualifiedName) as any;
  const nodesByKind = (kind: string) =>
    db().prepare('SELECT * FROM nodes WHERE kind = ?').all(kind) as any[];
  const containsFrom = (sourceId: string) =>
    db()
      .prepare(
        `SELECT t.qualified_name tgt_qn, t.kind tgt_kind FROM edges e
         JOIN nodes t ON t.id = e.target
         WHERE e.source = ? AND e.kind = 'contains'`
      )
      .all(sourceId) as any[];
  const text = async (args: Record<string, unknown>): Promise<string> =>
    (await h.execute('node', args)).content.map((c: any) => c.text).join('\n');

  it('scopes a struct inside a named namespace (qn carries ns:: prefix)', async () => {
    await indexFiles({
      'a.h':
        'namespace pre_process_buff {\n' +
        '  struct UbuffOffset {\n' +
        '    int _framework;\n' +
        '  };\n' +
        '}\n',
    });

    const s = qn('pre_process_buff::UbuffOffset');
    expect(s, 'struct should exist with ns:: prefix qn').toBeTruthy();
    expect(s.kind).toBe('struct');
    expect(s.name).toBe('UbuffOffset');

    // namespace node was created
    const ns = nodesByKind('namespace');
    expect(ns.length).toBe(1);
    expect(ns[0].name).toBe('pre_process_buff');

    // contains edge namespace -> struct (and namespace -> file via stack base)
    const kids = containsFrom(ns[0].id);
    expect(kids.some((k) => k.tgt_qn === 'pre_process_buff::UbuffOffset' && k.tgt_kind === 'struct')).toBe(true);

    // field inside the struct also carries the full prefix (buildQualifiedName
    // joins the whole scope stack: file -> namespace -> struct -> field)
    const f = qn('pre_process_buff::UbuffOffset::_framework');
    expect(f, 'field should carry ns::Struct::field qn').toBeTruthy();
    expect(f.kind).toBe('field');
  });

  it('nested namespace blocks (namespace A { namespace B { ... } })', async () => {
    await indexFiles({
      'b.h': 'namespace A {\n  namespace B {\n    struct X {};\n  }\n}\n',
    });
    expect(qn('A::B::X'), 'nested blocks produce A::B::X qn').toBeTruthy();
    // Both A and B namespace nodes exist
    const ns = nodesByKind('namespace').map((n) => n.name);
    expect(ns).toContain('A');
    expect(ns).toContain('B');
  });

  it('nested namespace specifier (namespace A::B { ... })', async () => {
    await indexFiles({
      'c.h': 'namespace A::B {\n  struct X {};\n}\n',
    });
    // The A::B specifier keeps the full "A::B" text as one node name, so
    // buildQualifiedName joins it as a single segment.
    expect(qn('A::B::X'), 'A::B specifier produces A::B::X qn').toBeTruthy();
  });

  it('anonymous namespace keeps simple-name qn and creates no namespace node', async () => {
    await indexFiles({
      'd.h': 'namespace {\n  struct X {};\n}\n',
    });
    expect(qn('X'), 'anonymous-namespace struct keeps simple name').toBeTruthy();
    // No `::X` prefix qn is synthesized
    expect(qn('::X')).toBeFalsy();
    expect(nodesByKind('namespace').length, 'no namespace node for anonymous block').toBe(0);
  });

  it('scopes free functions, classes, and methods inside a namespace', async () => {
    await indexFiles({
      'e.h':
        'namespace ns {\n' +
        '  void free();\n' +
        '  class C {\n' +
        '  public:\n' +
        '    void m();\n' +
        '  };\n' +
        '}\n',
    });
    expect(qn('ns::free'), 'namespace-scoped free function').toBeTruthy();
    expect(qn('ns::C'), 'namespace-scoped class').toBeTruthy();
    expect(qn('ns::C::m'), 'namespace-scoped class method').toBeTruthy();
  });

  it('codegraph_wx_node resolves a ns::symbol qualified lookup (was "not found")', async () => {
    await indexFiles({
      'a.h':
        'namespace pre_process_buff {\n' +
        '  struct UbuffOffset { int _framework; };\n' +
        '}\n' +
        'namespace pre_process_buff_123 {\n' +
        '  struct UbuffOffset { int _framework; };\n' +
        '}\n',
    });
    const out = await text({ symbol: 'pre_process_buff::UbuffOffset' });
    expect(out, 'qualified lookup must not return "not found"').not.toContain('not found');
    expect(out).toContain('UbuffOffset');
  });

  it('codegraph_wx_node lists same-named structs with their namespace qn to disambiguate', async () => {
    await indexFiles({
      'a.h':
        'namespace pre_process_buff {\n' +
        '  struct UbuffOffset { int _framework; };\n' +
        '}\n' +
        'namespace pre_process_buff_123 {\n' +
        '  struct UbuffOffset { int _framework; };\n' +
        '}\n',
    });
    const out = await text({ symbol: 'UbuffOffset' });
    expect(out).toContain('2 definitions named "UbuffOffset"');
    // displaySymbol surfaces the qualifiedName so the two are distinguishable
    expect(out).toContain('pre_process_buff::UbuffOffset');
    expect(out).toContain('pre_process_buff_123::UbuffOffset');
  });
});

describe('C++ namespace decl-def pairing', () => {
  let dir: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cppns-dd-'));
    cg = await CodeGraph.init(dir, { silent: true });
  });

  afterEach(() => {
    if (cg) cg.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const definesEdges = () => {
    const db = (cg as any).db.db;
    return db
      .prepare(
        `SELECT s.qualified_name src_qn, s.file_path src_path, s.end_line src_endline, s.start_line src_line,
                t.qualified_name tgt_qn, t.file_path tgt_path,
                json_extract(e.metadata,'$.synthesizedBy') synthBy
         FROM edges e
         JOIN nodes s ON s.id = e.source
         JOIN nodes t ON t.id = e.target
         WHERE e.kind = 'defines'`
      )
      .all() as any[];
  };

  it('pairs a namespace-scoped class method def with its header declaration', async () => {
    fs.writeFileSync(
      path.join(dir, 'ns.h'),
      '#pragma once\nnamespace ns {\n  class C {\n  public:\n    void m();\n  };\n}\n'
    );
    fs.writeFileSync(
      path.join(dir, 'ns.cpp'),
      '#include "ns.h"\nvoid ns::C::m() {\n}\n'
    );
    await cg.indexAll();

    const edges = definesEdges();
    // The in-class declaration builds qn `ns::C::m` (buildQualifiedName joins the
    // namespace node onto the stack); the out-of-line definition `void ns::C::m()`
    // sets qn via the receiver-type override. Both share the last-two-segments
    // key `C::m`, so cppDeclDefEdges pairs them.
    const pair = edges.find(
      (e) => e.synthBy === 'cpp-decl-def' && e.src_qn === 'ns::C::m' && e.tgt_qn === 'ns::C::m'
    );
    expect(pair, 'namespace-scoped decl-def pair must be synthesized').toBeTruthy();
    expect(pair.src_path.endsWith('ns.cpp')).toBe(true); // definition (has body)
    expect(pair.tgt_path.endsWith('ns.h')).toBe(true); // declaration
    expect(pair.src_endline).toBeGreaterThan(pair.src_line);
  });
});