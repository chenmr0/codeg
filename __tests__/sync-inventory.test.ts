import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ExtractionOrchestrator, scanSyncInventory, summarizeSyncCandidates } from '../src/extraction';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each(['full', 'scoped'])('reuses exact %s changes including an unstaged deletion and a touch', async (mode) => {
  vi.stubEnv('CODEGRAPH_RUST_SCAN', '0');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sync-inventory-'));
  const db = DatabaseConnection.initialize(path.join(root, '.codegraph-wx', 'codegraph.db'));
  try {
    const queries = new QueryBuilder(db.getDb());
    const extractor = new ExtractionOrchestrator(root, queries);
    execFileSync('git', ['init', '-q'], { cwd: root });
    for (const name of ['keep', 'touched', 'deleted', 'modified', 'outside']) {
      fs.writeFileSync(path.join(root, name + '.c'), `int ${name}(void) { return 1; }\n`);
      await extractor.indexFile(name + '.c');
    }
    execFileSync('git', ['add', 'deleted.c'], { cwd: root });
    fs.unlinkSync(path.join(root, 'deleted.c'));
    const touched = path.join(root, 'touched.c');
    const stat = fs.statSync(touched);
    fs.utimesSync(touched, stat.atime, new Date(stat.mtimeMs + 5000));
    fs.writeFileSync(path.join(root, 'modified.c'), 'int replacement(void) { return 123; }\n');
    fs.writeFileSync(path.join(root, 'added.c'), 'int added(void) { return 1; }\n');
    if (mode === 'scoped') fs.unlinkSync(path.join(root, 'outside.c'));

    const tracked = queries.getAllFiles();
    const scope = mode === 'scoped' ? ['keep.c', 'touched.c', 'modified.c', 'deleted.c', 'added.c'] : undefined;
    const inventory = await scanSyncInventory(root, true, scope);
    expect(inventory.diagnostics?.scan.mode).toBe(scope ? 'scoped' : 'git');
    expect(inventory.paths).toContain('deleted.c');
    const changedBytes = ['added.c', 'modified.c'].reduce((n, file) => n + fs.statSync(path.join(root, file)).size, 0);
    const stableBytes = tracked.filter(row => !['deleted.c', 'modified.c'].includes(row.path)).reduce((n, row) => n + row.size, 0);
    expect(await summarizeSyncCandidates(root, inventory, tracked)).toEqual({
      added: ['added.c'], modified: ['modified.c'], removed: ['deleted.c'], changedFiles: 3, changedBytes,
      affectedOldNodes: tracked.filter(row => ['deleted.c', 'modified.c'].includes(row.path)).reduce((n, row) => n + row.nodeCount, 0),
      totalNodes: tracked.reduce((n, row) => n + row.nodeCount, 0), totalFiles: 5,
      totalBytes: stableBytes + changedBytes, hasStatChanges: true, needsRecovery: false,
    });
    const reload = vi.spyOn(queries, 'getAllFiles');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await extractor.sync(undefined, scope, true, undefined, undefined, undefined,
      undefined, undefined, undefined, { inventory, tracked });
    expect(result).toMatchObject({ filesAdded: 1, filesModified: 1, filesRemoved: 1 });
    expect(reload).not.toHaveBeenCalled();
    expect(queries.getFileByPath('deleted.c')).toBeNull();
    expect(queries.getFileByPath('outside.c')).toBeTruthy();
    // The touch is verified once before the decision and its stat is updated by the writer.
    expect(inventory.diagnostics?.counts).toMatchObject({ statChecks: scope ? 5 : 6, statErrors: 1,
      hashReadAttempts: 3, statUnchanged: scope ? 1 : 2, sameHashStatUpdated: 1, existsChecks: 1 });
  } finally {
    db.close();
    await db.whenIdle();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
