import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { rustMacroBinaryPath } from '../src/extraction/rust-macros';
import type { QueryBuilder } from '../src/db/queries';

const binary = rustMacroBinaryPath();
describe.skipIf(!fs.existsSync(binary))('macro scanner sync graph parity', () => {
  const roots: string[] = [];
  beforeAll(async () => { await initGrammars(); await loadGrammarsForLanguages(['c', 'cpp']); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
  it('preserves graph results through add/modify/delete and avoids work on no-op', async () => {
    const exercise = async (mode: string, lookup: 'full' | 'auto') => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-macro-sync-')); roots.push(root);
      fs.mkdirSync(path.join(root, 'src'));
      const write = (file: string, source: string) => fs.writeFileSync(path.join(root, file), source);
      write('.codegraphignore', '/*\n!/src/\n');
      write('src/defs.h', '#define DECL(name) int name;\n#define EMPTY\n');
      write('src/base.c', 'int base(void) { return 1; }\n');
      vi.stubEnv('CODEGRAPH_RUST_MACROS', mode); vi.stubEnv('CODEGRAPH_RUST_MACROS_PATH', binary);
      vi.stubEnv('CODEGRAPH_SYNC_NAME_LOOKUP', lookup);
      let cg = CodeGraph.initSync(root);
      const messages: string[] = [];
      const logger = vi.spyOn(console, 'log').mockImplementation((...a) => messages.push(a.join(' ')));
      const snapshots = [];
      try {
        await cg.indexAll();
        const sync = async () => { cg.close(); cg = CodeGraph.openSync(root); return cg.sync({ verbose: true }); };
        const snapshot = () => {
          const queries = (cg as unknown as { queries: QueryBuilder }).queries;
          const nodes = queries.getAllNodes();
          return { nodes: nodes.map(n => ({ kind: n.kind, name: n.name, qualifiedName: n.qualifiedName, filePath: n.filePath,
            language: n.language, startLine: n.startLine, endLine: n.endLine,
            startColumn: n.startColumn, endColumn: n.endColumn, signature: n.signature })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
            edges: nodes.flatMap(n => queries.getOutgoingEdges(n.id)).map(({ id: _id, ...edge }) => edge)
              .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) };
        };
        write('src/mixed.h', '#include "defs.h"\nDECL(recovered)\n' + Array.from({ length: 25 }, (_, i) => `#define SPEC_${i} \\\n /*中文*/ {1, 2, 3},\n`).join(''));
        write('src/use.c', '#include "mixed.h"\nint get(void) { return base(); }\n');
        expect((await sync()).filesAdded).toBe(2);
        expect(messages.some(m => m.includes(`macro-detail mode=${mode === '1' ? 'rust' : 'ts'}`))).toBe(true);
        expect(messages.some(m => /tail-detail .*orphanAndSynthesisMs=\d+ms .*maintenanceMs=\d+ms/.test(m))).toBe(true);
        expect(messages.some(m => /refs-detail scope=changed complete=true .*files=2 refs=\d+ .*symbolNamesLoadMs=\d+ms/.test(m))).toBe(true);
        expect(messages.some(m => m.includes('refs-detail') && m.includes(`nameLookup=${lookup === 'auto' ? 'indexed' : 'full'}`))).toBe(true);
        if (lookup === 'auto') expect(messages.some(m => m.includes('refs-detail') && m.includes('symbolNamesLoadMs=0ms symbolNamesSetMs=0ms'))).toBe(true);
        expect(cg.getNodesByName('recovered').length).toBeGreaterThan(0);
        snapshots.push(snapshot());
        write('src/mixed.h', '#include "defs.h"\nDECL(updated_recovered)\n');
        expect((await sync()).filesModified).toBe(1); snapshots.push(snapshot());
        fs.unlinkSync(path.join(root, 'src/mixed.h'));
        expect((await sync()).filesRemoved).toBe(1); snapshots.push(snapshot());
        messages.length = 0;
        expect((await sync()).filesAdded).toBe(0);
        expect(messages.some(m => m.includes('macro-detail'))).toBe(false);
        expect(messages.some(m => m.includes('refs-detail'))).toBe(false);
      } finally { cg.close(); logger.mockRestore(); }
      return snapshots;
    };
    const baseline = await exercise('0', 'full');
    expect(await exercise('0', 'auto')).toEqual(baseline);
    expect(await exercise('1', 'full')).toEqual(baseline);
    expect(await exercise('1', 'auto')).toEqual(baseline);
  }, 30_000);
});
