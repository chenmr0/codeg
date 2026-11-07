/** Built-product acceptance of the migrated query adapter on target sync policy. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { CodeGraph as Graph } from '../src';
import type { ToolHandler as Handler } from '../src/mcp/tools';
const { CodeGraph } = require('../dist') as typeof import('../src');
const { ToolHandler } = require('../dist/mcp/tools') as typeof import('../src/mcp/tools');
const { DatabaseSync } = require('node:sqlite');
let root: string, graph: Graph | undefined, handler: Handler | undefined;
let previousArgv: string[];
function git(...args: string[]) {
  return execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=test@localhost',
    '-c', 'commit.gpgSign=false', ...args], { cwd: root, encoding: 'utf8' }).trim();
}
function write(name: string, value: number) {
  fs.writeFileSync(path.join(root, 'service.c'), `int ${name}(int value) {\n  return value + ${value};\n}\n`);
}
function persistentState() {
  const db = new DatabaseSync(graph!.getDatabaseFilePath(), { readOnly: true });
  try {
    return {
      id: db.prepare("SELECT value FROM project_metadata WHERE key='portable:database-id-v1'").get()?.value,
      vocabulary: db.prepare("SELECT name FROM sqlite_master WHERE name='name_segment_vocab'").get(),
    };
  } finally { db.close(); }
}
async function answer(query: string) {
  const result = await handler!.execute('explore', { query, maxFiles: 2 });
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return result.content.map(part => part.text ?? '').join('\n');
}
beforeEach(() => {
  previousArgv = process.execArgv; process.execArgv = ['--liftoff-only'];
  vi.stubEnv('NODE_OPTIONS', '');
  vi.stubEnv('CODEGRAPH_NO_DAEMON', '1');
  vi.stubEnv('CODEGRAPH_ENABLE_EXPLORE', '1');
  vi.stubEnv('CODEGRAPH_MCP_TOOLS', 'explore');
  vi.stubEnv('CODEGRAPH_EXPLORE_DEDUP', '0');
  vi.stubEnv('CODEGRAPH_ALL_LANGUAGES', '1');
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-explore-adaptive-publish-'));
  fs.writeFileSync(path.join(root, '.codegraphrc.json'), JSON.stringify({ sync: { adaptive: {
    rules: { fileScale: { minChangedFiles: 1 }, oldNodeScale: { enabled: false } },
  } } }));
});
afterEach(async () => {
  if (handler) { handler.closeAll(); await handler.whenIdle(); handler = undefined; }
  if (graph) { await graph.whenIdle(); graph.close(); await graph.whenIdle(); graph = undefined; }
  vi.restoreAllMocks(); vi.unstubAllEnvs(); process.execArgv = previousArgv;
  fs.rmSync(root, { recursive: true, force: true });
});
it.each([false, true])('refreshes warmed Explore after automatic publication (branch changes during build=%s)', async branchSwitch => {
  write('OriginalOrderStore', 731);
  if (branchSwitch) {
    git('init', '--quiet', '-b', 'planned');
    fs.writeFileSync(path.join(root, '.gitignore'), '.codegraph*/\n');
    git('add', '.'); git('commit', '--quiet', '-m', 'initial');
  }
  graph = await CodeGraph.init(root, { index: true });
  handler = new ToolHandler(graph);
  const before = persistentState(); expect(before.id).toBeTruthy();
  expect(await answer('OriginalOrderStore')).toContain('return value + 731;');
  const warm = await answer('OriginalOrderStore'); expect(warm).toContain('return value + 731;');
  write('CandidatePurchaseLedger', 947);
  if (branchSwitch) {
    git('commit', '--quiet', '-am', 'trigger rebuild');
    git('switch', '--quiet', '-c', 'latest');
    write('FinalShipmentJournal', 997);
    git('commit', '--quiet', '-am', 'latest source');
    git('switch', '--quiet', 'planned');
    const preload = path.resolve(__dirname, 'fixtures/checkout-during-portable-build.cjs').split(path.sep).join('/');
    vi.stubEnv('NODE_OPTIONS', `--require="${preload}"`);
  }
  const result = await graph.sync();
  expect(result.complete).toBe(true);
  expect(result.adaptive?.strategy, result.adaptive?.reason).toBe('rebuild');
  expect(persistentState().id).not.toBe(before.id);
  const expectedName = branchSwitch ? 'FinalShipmentJournal' : 'CandidatePurchaseLedger';
  const expectedBody = branchSwitch ? 'return value + 997;' : 'return value + 947;';
  const first = await answer(expectedName), second = await answer(expectedName);
  expect(first).toContain(expectedBody); expect(second).toBe(first);
  expect(first).not.toContain('return value + 731;');
  expect(graph.getNodesByName('OriginalOrderStore')).toHaveLength(0);
  if (branchSwitch) {
    expect(git('branch', '--show-current')).toBe('latest');
    expect(graph.getNodesByName('CandidatePurchaseLedger')).toHaveLength(0);
    expect(first).not.toContain('return value + 947;');
  }
  expect(graph.getPortableCatchup()).toBeNull();
  const published = persistentState(); expect(published.vocabulary).toBeUndefined();
  expect(await graph.sync()).toMatchObject({ complete: true, filesAdded: 0, filesModified: 0, filesRemoved: 0 });
  expect(persistentState()).toEqual(published);
  expect(await answer(expectedName)).toBe(first);
}, 90_000);
