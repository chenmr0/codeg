import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
import { EXTRACTION_VERSION } from '../src/extraction/extraction-version';

const roots: string[] = [];
const graphs: CodeGraph[] = [];
afterEach(() => {
  for (const graph of graphs.splice(0)) graph.destroy();
  for (const root of roots.splice(0)) fs.rmSync(root, {recursive:true, force:true});
});

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-admission-'));
  roots.push(root);
  return root;
}

function write(root: string, phase: number) {
  const label = phase ? 'caption' : 'label';
  const type = phase ? 'long' : 'int';
  const files: Record<string,string> = {
    'macros.hpp': '#define DECL_METHOD(name) ' + type + ' name(' + type + ' value);\n'
      + '#define MAKE_CASE(owner) class owner { public: void body(); }; void owner::body()\n',
    'api.hpp': '#include "macros.hpp"\nclass Gauge { public:\n DECL_METHOD(run)\n static const char ' + label + '[];\n};\n',
    'api.cpp': '#include "api.hpp"\n' + type + ' Gauge::run(' + type + ' value) { return value; }\n'
      + 'const char Gauge::' + label + '[] = "gauge";\n',
    'case.cpp': '#include "macros.hpp"\nMAKE_CASE(' + (phase ? 'NextCase' : 'FirstCase') + ')\n{\n int local_only = 1;\n}\n',
    'fragment.hpp': 'case 1: selected = ' + (phase ? 4 : 2) + '; break;\n',
    'use.cpp': '#include "api.hpp"\nint caller() { Gauge g; return g.run(1); }\n'
      + 'int choose(int input) { int selected = 0; switch(input) {\n#include "fragment.hpp"\n} return selected; }\n',
  };
  for (const [file, source] of Object.entries(files)) fs.writeFileSync(path.join(root,file),source);
  return Object.keys(files);
}

// Compare persisted semantic identities and graph topology, not wall-clock
// stamps, auto-increment edge IDs or JSON object property order.
function snapshot(graph: CodeGraph) {
  const db = (graph as any).db.db;
  return {
    nodes: db.prepare('SELECT id,kind,name,qualified_name,file_path,start_line,end_line,start_column,end_column,signature,is_declaration FROM nodes ORDER BY id').all(),
    edges: db.prepare('SELECT source,target,kind,line,col,provenance FROM edges ORDER BY source,target,kind,line,col,provenance').all(),
  };
}

describe('symbol-admission changes through index and sync', () => {
  it('keeps typedef and enum-initializer corrections identical across sync and fresh indexing', async () => {
    const root = project();
    const writePhase = (dir: string, phase: number) => {
      fs.writeFileSync(path.join(dir, 'api.hpp'), 'typedef unsigned Word;\n'
        + `typedef Word ${phase ? 'Next' : 'First'}[4], *Pointer;\n`
        + (phase ? 'struct Mode { using VALUE = int; };\n' : 'enum class Mode { VALUE };\n')
        + 'int object(Mode::VALUE);\nint first(int), second(double);\n');
    };
    writePhase(root, 0);
    const graph = CodeGraph.initSync(root); graphs.push(graph);
    await graph.indexAll();
    for (const phase of [1, 0]) {
      writePhase(root, phase);
      await graph.sync({paths:['api.hpp']});
      const freshRoot = project(); writePhase(freshRoot, phase);
      const fresh = CodeGraph.initSync(freshRoot); graphs.push(fresh);
      await fresh.indexAll();
      expect(snapshot(graph)).toEqual(snapshot(fresh));
      expect(graph.getNodesByName('object')).toEqual([
        expect.objectContaining({kind:phase ? 'function' : 'variable'}),
      ]);
      expect(graph.getNodesByName('Word')).toHaveLength(1);
      expect(graph.getNodesByName(phase ? 'First' : 'Next')).toEqual([]);
    }
  }, 30_000);

  it('keeps qualified method identities consistent when namespaces change during sync', async () => {
    const root = project();
    const writeNamespace = (dir: string, ns: string) => {
      fs.writeFileSync(path.join(dir, 'api.hpp'), `namespace ${ns} {\nstruct Box { int run(); };\nint Box::run() { return 1; }\n}\n`);
      fs.writeFileSync(path.join(dir, 'use.cpp'), `#include "api.hpp"\nint caller() { ${ns}::Box box; return box.run(); }\n`);
    };
    writeNamespace(root, 'first');
    const graph = CodeGraph.initSync(root); graphs.push(graph);
    await graph.indexAll();
    for (const ns of ['second', 'first']) {
      writeNamespace(root, ns);
      await graph.sync();
      const freshRoot = project(); writeNamespace(freshRoot, ns);
      const fresh = CodeGraph.initSync(freshRoot); graphs.push(fresh);
      await fresh.indexAll();
      expect(snapshot(graph)).toEqual(snapshot(fresh));
      expect(graph.getNodesByName('run').every(n => n.qualifiedName === `${ns}::Box::run`)).toBe(true);
      expect(graph.getNodesByName('run')).toHaveLength(2);
    }
  }, 30_000);

  it('keeps full-index and incremental graphs equal through macro and static-member changes', async () => {
    const root = project(); write(root,0);
    const graph = CodeGraph.initSync(root); graphs.push(graph);
    await graph.indexAll();
    expect(graph.getNodesByName('DECL_METHOD').filter(n => n.kind !== 'macro')).toEqual([]);
    expect(graph.getNodesByName('MAKE_CASE').every(n => n.kind === 'macro')).toBe(true);
    expect(graph.getNodesByName('body')).toEqual([
      expect.objectContaining({kind:'method',qualifiedName:'FirstCase::body',endLine:5}),
    ]);
    expect(graph.getNodesByName('selected')).toEqual([]);
    expect(graph.getNodesByName('local_only')).toEqual([]);
    expect(graph.getNodesByName('label').filter(n => n.kind === 'constant')).toEqual([
      expect.objectContaining({qualifiedName:'Gauge::label'}),
    ]);

    for (const phase of [1,0]) {
      const paths = write(root,phase);
      const result = await graph.sync({paths});
      expect(result.filesModified).toBeGreaterThan(0);
      const freshRoot = project(); write(freshRoot,phase);
      const fresh = CodeGraph.initSync(freshRoot); graphs.push(fresh);
      await fresh.indexAll();
      expect(snapshot(graph)).toEqual(snapshot(fresh));
      expect(graph.getNodesByName(phase ? 'FirstCase' : 'NextCase')).toEqual([]);
      expect(graph.getNodesByName(phase ? 'label' : 'caption')).toEqual([]);
    }
    const noChange = await graph.sync();
    expect(noChange.filesModified).toBe(0);
  }, 30_000);

  it('marks the previous extraction shape stale until a full rebuild stamps the new version', async () => {
    const root = project(); write(root,0);
    const graph = CodeGraph.initSync(root); graphs.push(graph);
    await graph.indexAll();
    (graph as unknown as { queries: { setMetadata(k: string, v: string): void } }).queries.setMetadata(
      'indexed_with_extraction_version', String(EXTRACTION_VERSION - 1),
    );
    expect(graph.isIndexStale()).toBe(true);
    await graph.indexAll();
    expect(graph.isIndexStale()).toBe(false);
    expect(graph.getIndexBuildInfo().extractionVersion).toBe(EXTRACTION_VERSION);
  }, 30_000);

  it('invalidates warm context when the last definition is removed or its file is deleted', async () => {
    const root = project();
    const defs = path.join(root, 'defs.hpp');
    const consumer = path.join(root, 'consumer.cpp');
    fs.writeFileSync(defs, '#define FIELD(name) int name;\n');
    fs.writeFileSync(consumer, 'FIELD(first)\n');
    const graph = CodeGraph.initSync(root); graphs.push(graph);
    await graph.indexAll();
    expect(graph.getNodesByName('first')).toContainEqual(expect.objectContaining({kind:'variable'}));

    fs.writeFileSync(defs, '// no definitions remain\n');
    fs.writeFileSync(consumer, 'FIELD(second)\n');
    await graph.sync({paths:['defs.hpp','consumer.cpp']});
    expect(graph.getNodesByName('second').some(n => n.kind === 'variable')).toBe(false);

    fs.writeFileSync(defs, '#define FIELD(name) long name;\n');
    fs.writeFileSync(consumer, 'FIELD(third)\n');
    await graph.sync({paths:['defs.hpp','consumer.cpp']});
    expect(graph.getNodesByName('third')).toContainEqual(expect.objectContaining({kind:'variable'}));

    fs.unlinkSync(defs);
    await graph.sync({paths:['defs.hpp']});
    fs.writeFileSync(consumer, 'FIELD(fourth)\n');
    await graph.sync({paths:['consumer.cpp']});
    expect(graph.getNodesByName('fourth').some(n => n.kind === 'variable')).toBe(false);
  }, 30_000);
});
