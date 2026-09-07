import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

let directory: string;
let cg: CodeGraph;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sync-retry-filter-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  cg?.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
const write = (file: string, source: string) => fs.writeFileSync(path.join(directory, file), source);
const raw = () => (cg as any).db.db;
const pending = () => raw().prepare("SELECT key FROM project_metadata WHERE key GLOB 'sync-retry:pending:*'").all();
const retryLog = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls
  .map(args => String(args[0])).filter(line => line.startsWith('[sync] failed-ref-retry'));

function seedFailed(count: number, language = 'cpp'): void {
  const caller = cg.getNodesByName('caller').find(node => node.kind === 'function')!;
  // Deliberately incompatible: constructor references cannot bind a function.
  const stmt = raw().prepare("INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, file_path, language, status, name_tail) VALUES (?, 'target', 'instantiates', ?, 0, 'caller.cpp', ?, 'failed', 'target')");
  for (let i = 0; i < count; i++) stmt.run(caller.id, 1000 + i, language);
}

describe('safe-comment retry integration', () => {
  it('establishes a cold baseline, scans >500 skipped rows, retains foreign refs and falls back on code changes', async () => {
    const code = 'int target(void) { return 1; }\n';
    write('provider.c', code);
    write('caller.cpp', 'int caller() { return 0; }\n');
    cg = CodeGraph.initSync(directory);
    await cg.indexAll();
    seedFailed(503);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    write('provider.c', code + '/* revision 1 */\n');
    await cg.sync({ paths: ['provider.c'], verbose: true });
    expect(retryLog(log).at(-1)).toMatch(/mode=full .*scanned=503 attempted=503 skipped=0/);
    expect(pending()).toHaveLength(0);

    seedFailed(1, 'python');
    log.mockClear();
    write('provider.c', code + '/* revision 2 longer */\n');
    const result = await cg.sync({ paths: ['provider.c'], verbose: true });
    expect(result.filesChecked).toBe(1);
    expect(retryLog(log).at(-1)).toMatch(/mode=safe-comments .*scanned=504 attempted=1 skipped=503/);

    log.mockClear();
    vi.stubEnv('CODEGRAPH_NO_SYNC_RETRY_FILTER', '1');
    write('provider.c', code + '/* revision 3 disabled */\n');
    await cg.sync({ paths: ['provider.c'], verbose: true });
    expect(retryLog(log).at(-1)).toMatch(/mode=full .*scanned=504 attempted=504 skipped=0/);
    vi.unstubAllEnvs();

    log.mockClear();
    write('provider.c', code.replace('return 1', 'return 200'));
    await cg.sync({ paths: ['provider.c'], verbose: true });
    expect(retryLog(log).at(-1)).toMatch(/mode=full .*scanned=504 attempted=504 skipped=0/);
  });

  it.each(['after-store', 'during-retry', 'before-ack'])('recovers %s interruption during a no-change next sync', async failureStage => {
    write('caller.c', 'int caller(void) { return late_api(); }\n');
    write('provider.c', 'int existing(void) { return 1; }\n');
    cg = CodeGraph.initSync(directory);
    await cg.indexAll();
    write('provider.c', 'int existing(void) { return 1; }\nint late_api(void) { return 2; }\n');
    const queries = (cg as any).queries;
    let fault: ReturnType<typeof vi.spyOn>;
    if (failureStage === 'after-store') {
      fault = vi.spyOn((cg as any).resolver, 'runPostExtract').mockImplementationOnce(() => { throw new Error('injected interruption'); });
    } else if (failureStage === 'during-retry') {
      fault = vi.spyOn(queries, 'getFailedReferenceRetryBatch').mockImplementationOnce(() => { throw new Error('injected interruption'); });
    } else {
      const apply = queries.applyMetadataChanges.bind(queries);
      fault = vi.spyOn(queries, 'applyMetadataChanges').mockImplementation((changes: any) => {
        if (changes['sync-retry:pending:provider.c'] === null) throw new Error('injected interruption');
        return apply(changes);
      });
    }
    await expect(cg.sync({ paths: ['provider.c'] })).rejects.toThrow('injected interruption');
    expect(cg.getNodesByName('late_api')).toHaveLength(1);
    expect(pending()).toHaveLength(1);
    expect((cg as any).orchestrator.syncRetryState).toBeUndefined();
    fault.mockRestore();
    // A new CodeGraph instance proves the journal is durable, not an in-memory
    // work queue accidentally left alive by the failing call.
    cg.close();
    cg = CodeGraph.openSync(directory);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const recovered = await cg.sync({ verbose: true });
    expect(recovered.filesAdded + recovered.filesModified).toBe(0);
    expect(pending()).toHaveLength(0);
    expect(retryLog(log).at(-1)).toContain('mode=full');
    const caller = cg.getNodesByName('caller')[0]!;
    const target = cg.getNodesByName('late_api')[0]!;
    expect(cg.getOutgoingEdges(caller.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'calls', target: target.id }),
    ]));
    expect(raw().prepare("SELECT COUNT(*) n FROM unresolved_refs WHERE reference_name = 'late_api'").get().n).toBe(0);
  });

  it('journals scoped co-importer fallback without a second historical retry sweep', async () => {
    write('defs.h', 'namespace ns { inline int target_v1() { return 1; } }\n');
    write('caller.cpp', '#include "defs.h"\nint caller() { return ns::target_v1(); }\n');
    cg = CodeGraph.initSync(directory);
    await cg.indexAll();
    // Force the legacy unstamped-edge path; stamped refs no longer require
    // caller re-extraction and therefore intentionally create no caller proof.
    raw().prepare(`UPDATE edges SET metadata=NULL WHERE kind='calls' AND source IN
      (SELECT id FROM nodes WHERE name='caller')`).run();
    write('defs.h', 'namespace ns { inline int target_v2() { return 2; } }\n');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cg.sync({ paths: ['defs.h'], verbose: true });
    expect(retryLog(log)).toHaveLength(1);
    expect(retryLog(log).every(line => line.includes('mode=full'))).toBe(true);
    expect(pending()).toHaveLength(0);
    expect(raw().prepare("SELECT key FROM project_metadata WHERE key = 'sync-retry:done:caller.cpp'").get()).toBeTruthy();
  });
});
