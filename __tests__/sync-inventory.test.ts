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

it('reuses one git enumeration and one stat per tracked path, including an unstaged deletion and a touch', async () => {
  vi.stubEnv('CODEGRAPH_RUST_SCAN', '0');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sync-inventory-'));
  const db = DatabaseConnection.initialize(path.join(root, '.codegraph-wx', 'codegraph.db'));
  try {
    const queries = new QueryBuilder(db.getDb());
    const extractor = new ExtractionOrchestrator(root, queries);
    execFileSync('git', ['init', '-q'], { cwd: root });
    for (const name of ['keep', 'touched', 'deleted']) {
      fs.writeFileSync(path.join(root, name + '.c'), `int ${name}(void) { return 1; }\n`);
      await extractor.indexFile(name + '.c');
    }
    execFileSync('git', ['add', 'deleted.c'], { cwd: root });
    fs.unlinkSync(path.join(root, 'deleted.c'));
    const touched = path.join(root, 'touched.c');
    const stat = fs.statSync(touched);
    fs.utimesSync(touched, stat.atime, new Date(stat.mtimeMs + 5000));

    const tracked = queries.getAllFiles();
    const inventory = await scanSyncInventory(root, true);
    expect(inventory.diagnostics?.scan.mode).toBe('git');
    expect(inventory.paths).toContain('deleted.c');
    expect(await summarizeSyncCandidates(root, inventory, tracked)).toEqual({
      addedPaths: [],
      pathsCount: 2,
      affectedOldNodes: tracked.filter(row => row.path !== 'keep.c').reduce((n, row) => n + row.nodeCount, 0),
      totalOldNodes: tracked.reduce((n, row) => n + row.nodeCount, 0),
    });
    const reload = vi.spyOn(queries, 'getAllFiles');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await extractor.sync(undefined, undefined, true, undefined, undefined, undefined,
      undefined, undefined, undefined, { inventory, tracked });
    expect(result).toMatchObject({ filesAdded: 0, filesModified: 0, filesRemoved: 1 });
    expect(reload).not.toHaveBeenCalled();
    expect(queries.getFileByPath('deleted.c')).toBeNull();
    // Three preflight stats, one post-read stat to certify the touch.
    expect(inventory.diagnostics?.counts).toMatchObject({ statChecks: 4, statErrors: 1, statUnchanged: 1,
      sameHashStatUpdated: 1, existsChecks: 1 });
  } finally {
    db.close();
    await db.whenIdle();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
