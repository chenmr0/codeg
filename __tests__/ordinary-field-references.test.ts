import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { fieldReferencesEnabled } from '../src/field-reference-policy';

beforeAll(async () => { await initGrammars(); await loadGrammarsForLanguages(['c', 'cpp']); });
afterEach(() => vi.unstubAllEnvs());
const db = (graph: CodeGraph) => (graph as any).db.db;
const fieldEdges = (graph: CodeGraph) => db(graph).prepare("SELECT t.name, e.kind FROM edges e JOIN nodes t ON t.id=e.target WHERE t.kind='field' AND e.kind='references' ORDER BY t.name").all();
const shape = (graph: CodeGraph) => db(graph).prepare('SELECT kind,source,target,line,col FROM edges ORDER BY kind,source,target,line,col').all();

describe('ordinary C/C++ field reference policy', () => {
  it.each(['int value;', 'const int value=1;', 'static int value;', 'unsigned value;', 'char value[8];', 'int *value;'])('marks trusted data: %s', declaration => {
    const field = extractFromSource('a.cpp', `struct S { ${declaration} };`).nodes.find(n => n.kind === 'field' && n.name === 'value');
    expect(field?.ordinaryField).toBe(true);
  });
  it.each(['int (*value)(int);', 'int (*value[2])(int);', 'Callback value;', 'std::function<int(int)> value;', 'void *value;'])('keeps callable/unknown: %s', declaration => {
    const fields = extractFromSource('a.cpp', `struct S { ${declaration} };`).nodes.filter(n => n.kind === 'field');
    expect(fields.every(n => !n.ordinaryField)).toBe(true);
  });
  it('has a default-off explicit escape hatch', () => {
    vi.stubEnv('CODEGRAPH_FIELD_REFERENCES', ''); expect(fieldReferencesEnabled()).toBe(false);
    vi.stubEnv('CODEGRAPH_FIELD_REFERENCES', '1'); expect(fieldReferencesEnabled()).toBe(true);
  });
  it('omits only data refs, keeps declarations and restores refs after a no-change policy switch', async () => {
    vi.stubEnv('CODEGRAPH_FIELD_REFERENCES', '0');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-policy-'));
    fs.writeFileSync(path.join(root, 'a.cpp'), 'struct S { int value; int (*callback)(int); int read(){return value;} auto get(){return callback;} };\nint helper(){return 1;} int caller(){return helper();}\n');
    const graph = await CodeGraph.init(root, {silent: true});
    try {
      expect((await graph.indexAll()).complete).toBe(true);
      expect(db(graph).prepare("SELECT COUNT(*) n FROM nodes WHERE kind='field'").get().n).toBe(2);
      expect(fieldEdges(graph).some((r:any) => r.name==='value')).toBe(false);
      expect(fieldEdges(graph).some((r:any) => r.name==='callback')).toBe(true);
      const callsBefore = db(graph).prepare("SELECT source,target,line,col FROM edges WHERE kind='calls' ORDER BY source,target,line,col").all();
      expect(callsBefore.length).toBeGreaterThan(0);
      expect(db(graph).prepare("SELECT COUNT(*) n FROM unresolved_refs WHERE status='suppressed_field'").get().n).toBeGreaterThan(0);
      expect(db(graph).prepare("SELECT COUNT(*) n FROM unresolved_refs WHERE status='pending'").get().n).toBe(0);
      vi.stubEnv('CODEGRAPH_FIELD_REFERENCES', '1');
      await graph.sync();
      expect(fieldEdges(graph).some((r:any) => r.name==='value')).toBe(true);
      expect(db(graph).prepare("SELECT source,target,line,col FROM edges WHERE kind='calls' ORDER BY source,target,line,col").all()).toEqual(callsBefore);
      vi.stubEnv('CODEGRAPH_FIELD_REFERENCES', '0');
      await graph.sync();
      expect(fieldEdges(graph).some((r:any) => r.name==='value')).toBe(false);
    } finally { graph.close(); fs.rmSync(root, {recursive:true,force:true}); }
  });
  it('revisits header-only ordinary/callback changes and matches fresh', async () => {
    vi.stubEnv('CODEGRAPH_FIELD_REFERENCES', '0');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-lifecycle-'));
    const live = path.join(root,'live'), freshDir = path.join(root,'fresh'); fs.mkdirSync(live); fs.mkdirSync(freshDir);
    const use = '#include "types.hpp"\nint S::read() { return !!member; }\n';
    fs.writeFileSync(path.join(live,'use.cpp'), use);
    fs.writeFileSync(path.join(live,'types.hpp'), 'struct S { int member; int read(); };\n');
    const graph = await CodeGraph.init(live, {silent:true});
    try {
      await graph.indexAll();
      for (const declaration of ['int (*member)(int);', 'int member;', 'int renamed;', 'int (*member)(int);']) {
        const header = `struct S { ${declaration} int read(); };\n`;
        fs.writeFileSync(path.join(live,'types.hpp'), header);
        await graph.sync();
        fs.writeFileSync(path.join(freshDir,'types.hpp'), header); fs.writeFileSync(path.join(freshDir,'use.cpp'),use);
        const fresh = await CodeGraph.init(freshDir,{silent:true});
        try { await fresh.indexAll(); expect(shape(graph)).toEqual(shape(fresh)); }
        finally {fresh.close(); fs.rmSync(path.join(freshDir,'.codegraph-wx'),{recursive:true,force:true});}
      }
    } finally {graph.close();fs.rmSync(root,{recursive:true,force:true});}
  }, 60000);
});
