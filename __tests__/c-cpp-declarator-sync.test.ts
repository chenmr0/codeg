import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';
import { EXTRACTION_VERSION } from '../src/extraction/extraction-version';

describe('C/C++ declaration identity persisted graph', () => {
  it('sync removes stale symbols and matches a fresh full index, including edges', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'declarator-sync-'));
    const incrementalDir = path.join(root, 'incremental'), freshDir = path.join(root, 'fresh');
    fs.mkdirSync(incrementalDir); fs.mkdirSync(freshDir);
    const before = 'typedef int OldType;\nstruct Device { enum OldEnum { OLD=1 }; };\n';
    const after = 'typedef int Existing;\ntypedef Existing Alias, *Pointer, Array[4], (*Callback)(int arg);\nusing u32 = unsigned;\nstruct Device { enum : u32 { READY=1 }; };\n';
    const consumer = '#include "types.hpp"\nint read() { return Device::READY; }\n';
    fs.writeFileSync(path.join(incrementalDir, 'types.hpp'), before);
    const incremental = await CodeGraph.init(incrementalDir, { silent: true });
    let fresh: CodeGraph | undefined;
    try {
      expect((await incremental.indexAll()).complete).toBe(true);
      fs.writeFileSync(path.join(incrementalDir, 'types.hpp'), after);
      fs.writeFileSync(path.join(incrementalDir, 'use.cpp'), consumer);
      const synced = await incremental.sync();
      expect(synced.errors.filter(e => e.severity === 'error')).toEqual([]);
      fs.writeFileSync(path.join(freshDir, 'types.hpp'), after);
      fs.writeFileSync(path.join(freshDir, 'use.cpp'), consumer);
      fresh = await CodeGraph.init(freshDir, { silent: true });
      expect((await fresh.indexAll()).complete).toBe(true);
      const db = (graph: CodeGraph) => (graph as any).db.db;
      const nodes = (graph: CodeGraph) => db(graph).prepare('SELECT id,kind,name,qualified_name,file_path,start_line,end_line FROM nodes ORDER BY id').all();
      const edges = (graph: CodeGraph) => db(graph).prepare('SELECT kind,source,target FROM edges ORDER BY kind,source,target').all();
      expect(nodes(incremental)).toEqual(nodes(fresh));
      expect(edges(incremental)).toEqual(edges(fresh));
      const indexed = nodes(incremental) as Array<{kind: string; name: string; qualified_name: string}>;
      expect(indexed.some(n => n.name === 'OldType' || n.name === 'OLD' || n.name === 'OldEnum')).toBe(false);
      expect(indexed.filter(n => n.kind === 'type_alias' && n.name === 'Existing')).toHaveLength(1);
      for (const name of ['Alias', 'Pointer', 'Array', 'Callback']) expect(indexed.some(n => n.kind === 'type_alias' && n.name === name)).toBe(true);
      expect(indexed.some(n => n.kind === 'enum_member' && n.qualified_name === 'Device::READY')).toBe(true);
      expect(db(incremental).prepare("SELECT COUNT(*) n FROM edges e LEFT JOIN nodes s ON e.source=s.id LEFT JOIN nodes t ON e.target=t.id WHERE s.id IS NULL OR t.id IS NULL").get().n).toBe(0);
      expect(EXTRACTION_VERSION).toBeGreaterThan(24);
    } finally {
      incremental.destroy(); fresh?.destroy();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
