import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

/**
 * End-to-end test for the C++ declaration-definition pairing synthesizer
 * (`cppDeclDefEdges`). A class member function's prototype (in a .h header)
 * and its out-of-line definition (in a .cpp file) are extracted as two
 * separate nodes with no edge between them — the declaration is a graph
 * dead-end. The synthesizer bridges them with a `defines` edge (definition
 * → declaration), strictly gated to cases where the receiver class is
 * verifiable in the graph.
 */
describe('cpp-decl-def synthesizer', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpp-decldef-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Helper: query all `defines` edges with joined node attrs. */
  const definesEdges = (db: any) =>
    db
      .prepare(
        `SELECT s.name src_name, s.qualified_name src_qn, s.kind src_kind,
                s.file_path src_path, s.start_line src_line, s.end_line src_endline,
                s.signature src_signature,
                t.name tgt_name, t.qualified_name tgt_qn, t.kind tgt_kind,
                t.file_path tgt_path, t.start_line tgt_line, t.signature tgt_signature,
                e.provenance, json_extract(e.metadata,'$.synthesizedBy') synthBy,
                json_extract(e.metadata,'$.registeredAt') registeredAt
         FROM edges e
         JOIN nodes s ON s.id = e.source
         JOIN nodes t ON t.id = e.target
         WHERE e.kind = 'defines'`
      )
      .all() as any[];

  it('pairs a class method definition with its header declaration (case A: class indexed)', async () => {
    fs.writeFileSync(
      path.join(dir, 'foo.h'),
      `#pragma once
class Foo {
public:
  void bar();
  int baz();
};
`
    );
    fs.writeFileSync(
      path.join(dir, 'foo.cpp'),
      `#include "foo.h"
void Foo::bar() {
  baz();
}
int Foo::baz() {
  return 42;
}
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const edges = definesEdges(db);
    cg.close?.();

    // Two pairs: Foo::bar (def→decl) and Foo::baz (def→decl).
    expect(edges.length).toBe(2);

    const barEdge = edges.find((e) => e.src_qn === 'Foo::bar');
    expect(barEdge).toBeTruthy();
    // Direction: definition (multi-line, .cpp) → declaration (single-line, .h).
    expect(barEdge.src_path.endsWith('foo.cpp')).toBe(true);
    expect(barEdge.src_endline).toBeGreaterThan(barEdge.src_line); // has body
    expect(barEdge.tgt_path.endsWith('foo.h')).toBe(true);
    expect(barEdge.tgt_qn).toBe('Foo::bar');
    expect(barEdge.synthBy).toBe('cpp-decl-def');
    expect(barEdge.provenance).toBe('heuristic');
    expect(barEdge.registeredAt).toMatch(/foo\.h:\d+/);
  });

  it('pairs same-header out-of-line definitions without crossing overloads or case-sensitive owners', async () => {
    fs.writeFileSync(path.join(dir, 'inline.h'), `namespace left {
class Channel;
class Channel { public: int wait(); int wait(int); };
int Channel::wait() { return 1; }
int Channel::wait(int value) { return value; }
}
namespace Left { class Channel { public: int wait(); }; }
`);
    const cg = await CodeGraph.init(dir, { silent: true });
    try {
      await cg.indexAll();
      const edges = definesEdges((cg as any).db.db);
      expect(edges).toHaveLength(2);
      expect(edges.every(e => e.src_qn === 'left::Channel::wait' && e.tgt_qn === e.src_qn)).toBe(true);
      expect(edges.every(e => e.src_signature.includes('(int') === e.tgt_signature.includes('(int'))).toBe(true);
    } finally { cg.close(); }
  });

  it('does NOT pair free functions (strict mode — no class context to verify)', async () => {
    fs.writeFileSync(
      path.join(dir, 'free.h'),
      `#pragma once
int compute(int x);
`
    );
    fs.writeFileSync(
      path.join(dir, 'free.cpp'),
      `#include "free.h"
int compute(int x) {
  return x * 2;
}
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const edges = definesEdges(db);
    cg.close?.();

    // Strict mode: free functions are not paired (a bare-name function node
    // can't be distinguished from a downgraded class-member declaration).
    expect(edges.length).toBe(0);
  });

  it('does NOT pair when there is no matching declaration', async () => {
    fs.writeFileSync(
      path.join(dir, 'solo.cpp'),
      `class Solo {
public:
  int run() {
    return 1;
  }
};
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const edges = definesEdges(db);
    cg.close?.();

    // Only an inline definition, no separate declaration node → no pair.
    expect(edges.length).toBe(0);
  });

  it('does NOT pollute the call graph — defines edges are invisible to getCallers/getCallees', async () => {
    fs.writeFileSync(
      path.join(dir, 'call.h'),
      `#pragma once
class Call {
public:
  void outer();
  void inner();
};
`
    );
    fs.writeFileSync(
      path.join(dir, 'call.cpp'),
      `#include "call.h"
void Call::outer() {
  inner();
}
void Call::inner() {
}
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;

    // Find the declaration node for Call::outer (single-line, in .h).
    const declRow = db
      .prepare(
        `SELECT id FROM nodes WHERE qualified_name = 'Call::outer' AND file_path LIKE '%call.h%'`
      )
      .get() as any;
    expect(declRow).toBeTruthy();

    // The declaration node must have zero callers/callees via call-graph edges
    // (defines is not in the calls/references/imports set getCallers follows).
    const declCallees = cg.getCallees(declRow.id);
    const declCallers = cg.getCallers(declRow.id);
    expect(declCallees.length).toBe(0);
    expect(declCallers.length).toBe(0);

    // The definition node's callees must contain inner (the real call), and
    // must NOT contain the declaration node.
    const defRow = db
      .prepare(
        `SELECT id FROM nodes WHERE qualified_name = 'Call::outer' AND file_path LIKE '%call.cpp%'`
      )
      .get() as any;
    const defCallees = cg.getCallees(defRow.id);
    expect(defCallees.some((c) => c.node.qualifiedName === 'Call::inner')).toBe(true);
    expect(defCallees.some((c) => c.node.id === declRow.id)).toBe(false);

    // But defines edges DO exist — proving the link is structural, not call-graph.
    const edges = definesEdges(db);
    expect(edges.some((e) => e.src_qn === 'Call::outer')).toBe(true);
    cg.close?.();
  });

  it('pairs static methods', async () => {
    fs.writeFileSync(
      path.join(dir, 'stat.h'),
      `#pragma once
class Stat {
public:
  static int count();
};
`
    );
    fs.writeFileSync(
      path.join(dir, 'stat.cpp'),
      `#include "stat.h"
int Stat::count() {
  return 1;
}
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const edges = definesEdges(db);
    cg.close?.();

    const edge = edges.find((e) => e.src_qn === 'Stat::count');
    expect(edge).toBeTruthy();
    expect(edge.tgt_qn).toBe('Stat::count');
    expect(edge.src_path.endsWith('stat.cpp')).toBe(true);
    expect(edge.tgt_path.endsWith('stat.h')).toBe(true);
  });

  it('pairs overloaded methods by parameter list without cross-linking overloads', async () => {
    fs.writeFileSync(
      path.join(dir, 'ov.h'),
      `#pragma once
class Ov {
public:
  int init();
  int init(int x);
};
`
    );
    fs.writeFileSync(
      path.join(dir, 'ov.cpp'),
      `#include "ov.h"
int Ov::init() {
  return 0;
}
int Ov::init(int x) {
  return x;
}
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const edges = definesEdges(db);
    cg.close?.();

    // Both qualifiedNames collapse to Ov::init, but their indexed signatures
    // distinguish the two overloads. Each definition must link only to its own
    // declaration — not to every same-name declaration.
    const initEdges = edges.filter((e) => e.src_qn === 'Ov::init');
    expect(initEdges.length).toBe(2);
    // Every edge goes from a .cpp definition to a .h declaration.
    expect(initEdges.every((e) => e.src_path.endsWith('ov.cpp') && e.tgt_path.endsWith('ov.h'))).toBe(true);
    const normalizedPairs = initEdges.map((e) => [e.src_signature, e.tgt_signature].join(' -> '));
    expect(normalizedPairs.some((pair) => pair.includes('init()') && !pair.includes('init(int x)'))).toBe(true);
    expect(normalizedPairs.some((pair) => pair.includes('init(int x) -> int init(int x)'))).toBe(true);
  });

  it('does not attach a no-arg definition to a declaration-only pointer overload', async () => {
    fs.writeFileSync(
      path.join(dir, 'channel.h'),
      `#pragma once
struct Buffer {};
class Channel {
public:
  int push(Buffer *buffer);
  int push();
};
`
    );
    fs.writeFileSync(
      path.join(dir, 'channel.cpp'),
      `#include "channel.h"
int Channel::push() {
  return 0;
}
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const pushEdges = definesEdges(db).filter((e) => e.src_qn === 'Channel::push');
    cg.close?.();

    expect(pushEdges).toHaveLength(1);
    expect(pushEdges[0]!.src_signature).toContain('Channel::push()');
    expect(pushEdges[0]!.tgt_signature).toBe('int push()');
  });

  it('rejects a parsed parameter mismatch even when only one node exists on each side', async () => {
    fs.writeFileSync(
      path.join(dir, 'single.h'),
      `#pragma once
struct Buffer {};
class Single {
public:
  int push(Buffer *buffer);
};
`
    );
    fs.writeFileSync(
      path.join(dir, 'single.cpp'),
      `#include "single.h"
int Single::push() {
  return 0;
}
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const pushEdges = definesEdges(db).filter((e) => e.src_qn === 'Single::push');
    cg.close?.();

    expect(pushEdges).toHaveLength(0);
  });

  it('pairs OceanBase-style declarations after canonicalizing defaults, names, qualification, and callbacks', async () => {
    fs.writeFileSync(
      path.join(dir, 'channel.h'),
      `#pragma once
#include <functional>
namespace common { struct ObNewRow {}; }
struct ObDtlMsg {};
struct ObDtlLinkedBuffer {};
struct ObVirtualChannelInfo {};
class Channel {
public:
  int send(const ObDtlMsg &msg, long timeout_ts = 0, bool is_eof = false);
  int get_row(ObVirtualChannelInfo &chan_info, common::ObNewRow *&row);
  int send1(std::function<int(const ObDtlLinkedBuffer &buffer)> &proc, long timeout);
  int push(ObDtlLinkedBuffer *buffer);
};
`,
    );
    fs.writeFileSync(
      path.join(dir, 'channel.cpp'),
      `#include "channel.h"
using common::ObNewRow;
int Channel::send(const ObDtlMsg &packet, long deadline, bool eof) { return eof ? 1 : 0; }
int Channel::get_row(ObVirtualChannelInfo &info, ObNewRow *&result) { return result ? 1 : 0; }
int Channel::send1(std::function<int(const ObDtlLinkedBuffer &)> &callback, long deadline) { return 0; }
`,
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const channelEdges = definesEdges(db).filter((edge) =>
      ['Channel::send', 'Channel::get_row', 'Channel::send1', 'Channel::push'].includes(edge.src_qn),
    );
    cg.close?.();

    expect(channelEdges.filter((edge) => edge.src_qn === 'Channel::send')).toHaveLength(1);
    expect(channelEdges.filter((edge) => edge.src_qn === 'Channel::get_row')).toHaveLength(1);
    expect(channelEdges.filter((edge) => edge.src_qn === 'Channel::send1')).toHaveLength(1);
    expect(channelEdges.some((edge) => edge.src_qn === 'Channel::push')).toBe(false);
  });

  it('does NOT pair inline definitions in the same file as their declaration', async () => {
    // Header with an inline-defined method — definition and declaration are
    // the same node (or same file), so no cross-file pair should be created.
    fs.writeFileSync(
      path.join(dir, 'inl.h'),
      `#pragma once
class Inl {
public:
  int calc() { return 1; }
};
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const edges = definesEdges(db);
    cg.close?.();

    expect(edges.length).toBe(0);
  });

  it('surfaces the definition call trail on a dead-end declaration node via formatDeclDef', async () => {
    fs.writeFileSync(
      path.join(dir, 'trail.h'),
      `#pragma once
class Trail {
public:
  void start();
  void finish();
};
`
    );
    fs.writeFileSync(
      path.join(dir, 'trail.cpp'),
      `#include "trail.h"
void Trail::start() {
  finish();
}
void Trail::finish() {
}
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;

    // The declaration node for Trail::start has no callers/callees of its own.
    // But via the defines edge it should reach the definition's call trail.
    const declRow = db
      .prepare(
        `SELECT id FROM nodes WHERE qualified_name = 'Trail::start' AND file_path LIKE '%trail.h%'`
      )
      .get() as any;
    expect(declRow).toBeTruthy();

    // formatTrail is private; reach it through the MCP tool surface by
    // invoking the node handler indirectly. Instead, verify the structural
    // precondition: the declaration has an incoming defines edge whose source
    // (the definition) has callees. That's exactly what formatDeclDef surfaces.
    const defEdge = db
      .prepare(
        `SELECT e.source FROM edges e WHERE e.kind = 'defines' AND e.target = ?`
      )
      .get(declRow.id) as any;
    expect(defEdge).toBeTruthy();

    const defCallees = cg.getCallees(defEdge.source);
    expect(defCallees.some((c) => c.node.qualifiedName === 'Trail::finish')).toBe(true);
    cg.close?.();
  });
});
