import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CodeGraph } from '../src';
import { QueryBuilder } from '../src/db/queries';
import { DatabaseConnection } from '../src/db';
import { beginSourceWrite, finishSourceWrite } from '../src/sync/source-ownership';
import * as planning from '../src/sync/rebuild-controller';

let root: string;
let graph: CodeGraph;
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-portable-small-'));
  fs.writeFileSync(path.join(root, 'first.c'), 'int first(void) { return 1; }\n');
  graph = await CodeGraph.init(root, { index: true });
});
afterEach(async () => {
  vi.restoreAllMocks();
  graph?.close();
  await graph?.whenIdle();
  fs.rmSync(root, { recursive: true, force: true });
});

it('opens without graph statistics and reuses the tracked file list on a healthy empty sync', async () => {
  graph.close();
  await graph.whenIdle();
  const stats = vi.spyOn(QueryBuilder.prototype, 'getStats');
  graph = await CodeGraph.open(root);
  expect(stats).not.toHaveBeenCalled();
  const planner = vi.spyOn(planning, 'runAdaptiveReadWorker');
  const files = vi.spyOn(QueryBuilder.prototype, 'getAllFiles');
  const result = await graph.sync();
  expect(result).toMatchObject({ complete: true, filesChecked: 1, filesModified: 0 });
  expect(files).toHaveBeenCalledTimes(1);
  expect(planner).not.toHaveBeenCalled();
  const writer = vi.spyOn(DatabaseConnection, 'open');
  expect(await graph.sync()).toMatchObject({ complete: true, filesChecked: 1, filesModified: 0 });
  expect(writer).not.toHaveBeenCalled();
  fs.writeFileSync(path.join(root, 'first.c'), 'int replaced(void) { return 1000; }\n');
  expect(await graph.sync()).toMatchObject({ complete: true, filesModified: 1 });
  expect(writer).toHaveBeenCalled();
  expect(graph.getNodesByName('replaced')).toHaveLength(1);
  expect(planner).not.toHaveBeenCalled();
});

it('repairs dirty macro evidence on a zero-change sync before returning read-only again', async () => {
  await graph.sync();
  const db = DatabaseConnection.open(graph.getDatabaseFilePath());
  try {
    const queries = new QueryBuilder(db.getDb());
    const owned = beginSourceWrite(db.getDb());
    expect(owned).not.toBeNull();
    queries.setMetadata('resolution:cpp-macro-evidence-clean-v1', 'interrupted');
    expect(finishSourceWrite(db.getDb(), owned, true)).toBe(true);
  } finally { db.close(); }
  const writer = vi.spyOn(DatabaseConnection, 'open');
  expect(await graph.sync()).toMatchObject({ complete: true, filesModified: 0 });
  expect(writer).toHaveBeenCalled();
  writer.mockClear();
  expect(await graph.sync()).toMatchObject({ complete: true, filesModified: 0 });
  expect(writer).not.toHaveBeenCalled();
});

it('sees sources created by an SDK progress callback after the strategy decision', async () => {
  let created = false;
  const result = await graph.sync({ onProgress(progress) {
    if (progress.phase === 'scanning' && !created) {
      created = true;
      fs.writeFileSync(path.join(root, 'later.c'), 'int later(void) { return 2; }\n');
    }
  } });
  expect(result).toMatchObject({ complete: true, filesAdded: 1 });
  expect(graph.getNodesByName('later')).toHaveLength(1);
});
