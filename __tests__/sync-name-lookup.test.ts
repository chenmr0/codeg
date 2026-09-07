import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import CodeGraph from '../src/index';
import type { QueryBuilder } from '../src/db/queries';

const roots: string[] = [];
const graphs: CodeGraph[] = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const cg of graphs.splice(0)) cg.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const temporary = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sync-names-')); roots.push(root); return root; };
const access = (cg: CodeGraph) => cg as unknown as { queries: QueryBuilder; db: { db: any } };
const sorted = (rows: unknown[]) => rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

describe('medium sync indexed-name epoch', () => {
  it('preserves >512 changed refs and >500 historical retries without moving the full-name load to the tail', async () => {
    const run = async (mode: string) => {
      vi.stubEnv('CODEGRAPH_SYNC_NAME_LOOKUP', mode);
      vi.stubEnv('CODEGRAPH_PARSE_WORKERS', '2');
      const root = temporary();
      fs.writeFileSync(path.join(root, 'old.c'), 'int base(void) { return 1; }\nint caller(void) { return 0; }\n');
      const cg = CodeGraph.initSync(root); graphs.push(cg);
      await cg.indexAll();
      const { queries, db } = access(cg);
      const caller = cg.getNodesByName('caller')[0]!;
      const seed = db.db.prepare("INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, file_path, language, status, name_tail) VALUES (?, 'late_api', ?, ?, 0, 'old.c', 'c', 'failed', 'late_api')");
      db.db.transaction(() => {
        for (let i = 0; i < 6262; i++) seed.run(caller.id, i % 3 === 0 ? 'instantiates' : 'calls', i + 100);
      })();
      for (let i = 0; i < 14; i++) {
        fs.writeFileSync(path.join(root, `added_${i}.c`),
          (i === 0 ? 'int late_api(void) { return 2; }\n' : '') +
          `int changed_${i}(void) {\nint value = 0;\n` +
          Array.from({ length: 105 }, (_, n) => `value += ${n % 21 === 0 ? 'absent_api' : 'base'}();\n`).join('') +
          'return value;\n}\n');
      }
      const names = vi.spyOn(queries, 'getAllNodeNames');
      const messages: string[] = [];
      const log = vi.spyOn(console, 'log').mockImplementation((...args) => messages.push(args.join(' ')));
      const result = await cg.sync({ verbose: true });
      expect(result).toMatchObject({ filesAdded: 14, filesModified: 0, filesRemoved: 0 });
      const detail = messages.find(m => m.startsWith('[sync] refs-detail scope=changed'))!;
      expect(Number(detail.match(/ refs=(\d+)/)?.[1])).toBeGreaterThan(512);
      const retry = messages.find(m => m.startsWith('[sync] refs-detail scope=failed-retry'))!;
      expect(retry).toContain('refs=6262');
      expect(messages.find(m => m.startsWith('[sync] failed-ref-retry'))).toContain('scanned=6262 attempted=6262 skipped=0');
      if (mode === 'auto') {
        expect(names).not.toHaveBeenCalled();
        for (const line of [detail, retry]) {
          expect(line).toContain('nameLookup=indexed');
          expect(line).toContain('symbolNamesLoadMs=0ms symbolNamesSetMs=0ms');
        }
        expect(retry).toContain('cache=warm');
      } else expect(names).toHaveBeenCalledTimes(1);
      const nodes = queries.getAllNodes();
      const snapshot = {
        nodes: sorted(nodes.map(({ updatedAt: _updatedAt, ...node }) => node)),
        edges: sorted(nodes.flatMap(n => queries.getOutgoingEdges(n.id)).map(({ id: _id, ...edge }) => edge)),
        failed: db.db.prepare('SELECT from_node_id, reference_name, reference_kind, line, col, status, candidates FROM unresolved_refs ORDER BY from_node_id, reference_name, reference_kind, line').all(),
      };
      expect(db.db.prepare("SELECT COUNT(*) n FROM unresolved_refs WHERE reference_name = 'late_api' AND status = 'failed'").get().n).toBe(2088);
      expect(db.db.prepare("SELECT COUNT(*) n FROM unresolved_refs WHERE status = 'pending'").get().n).toBe(0);
      const calls = names.mock.calls.length;
      expect((await cg.sync()).filesAdded).toBe(0);
      expect(names.mock.calls.length).toBe(calls);
      names.mockRestore(); log.mockRestore(); cg.close();
      return snapshot;
    };
    expect(await run('auto')).toEqual(await run('full'));
  }, 60_000);

  it('CLI summary uses complete syncPipeline timing, not the extraction-only result duration', async () => {
    const root = temporary();
    fs.writeFileSync(path.join(root, 'a.c'), 'int base(void) { return 1; }\n');
    const cg = CodeGraph.initSync(root); graphs.push(cg);
    await cg.indexAll(); cg.close();
    fs.writeFileSync(path.join(root, 'b.c'), 'int use(void) { return base(); }\n');
    const output = execFileSync(process.execPath, ['--liftoff-only', path.resolve('dist/bin/codegraph.js'), 'sync', '-v'], {
      cwd: root, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, CODEGRAPH_PARSE_WORKERS: '1' },
    });
    const pipeline = Number(output.match(/syncPipeline=(\d+)ms/)?.[1]);
    const summary = output.match(/nodes in ([\d.]+)(ms|s)/);
    expect(pipeline).toBeGreaterThan(0); expect(summary).toBeTruthy();
    const displayed = Number(summary![1]) * (summary![2] === 's' ? 1000 : 1);
    expect(Math.abs(displayed - pipeline)).toBeLessThanOrEqual(101);
  }, 30_000);
});
