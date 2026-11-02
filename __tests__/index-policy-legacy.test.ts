/** Real release migration: point CODEGRAPH_LEGACY_DIST at a built 1765271 and,
 * optionally, CODEGRAPH_BUGGY_POLICY_DIST at a built 40cb69e to cover v1 poisoning.
 * These fixtures are created by released code, not by editing a modern database.
 */
import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const { DatabaseSync } = require('node:sqlite');
import { CodeGraph } from '../src';
import { SEMANTIC_CONFIG_KEY, SEMANTIC_REINDEX_PENDING } from '../src/sync/index-policy';
const legacy = process.env.CODEGRAPH_LEGACY_DIST;
const buggy = process.env.CODEGRAPH_BUGGY_POLICY_DIST;
let root: string | undefined;
let graph: CodeGraph | undefined;
afterEach(async () => {
  graph?.close(); await graph?.whenIdle(); graph = undefined;
  if (root) fs.rmSync(root, { recursive: true, force: true }); root = undefined;
});
function run(dist: string, operation: 'init' | 'sync') {
  const result = spawnSync(process.execPath, ['--liftoff-only', '-e', `
    const {CodeGraph}=require(process.argv[1]);
    (async()=>{const g=process.argv[3]==='init' ? await CodeGraph.init(process.argv[2],{index:true}) : CodeGraph.openSync(process.argv[2]);
      const result=process.argv[3]==='sync' ? await g.sync() : null;
      const targets=g.getCallees(g.getNodesByName('caller')[0].id).filter(x=>x.node.name==='target').map(x=>x.node.filePath);
      const keys=['index:semantic-config-v1','index:semantic-config-v2','adaptive:index-config-v1'];
      const filename=g.getDatabaseFilePath?.() ?? require(process.argv[1]+'/db').getDatabasePath(process.argv[2]);
      g.close(); await g.whenIdle?.();
      const db=new (require('node:sqlite').DatabaseSync)(filename,{readOnly:true});
      const metadata=keys.map(key=>[key,db.prepare('SELECT value FROM project_metadata WHERE key=?').get(key)?.value ?? null]); db.close();
      console.log('RESULT '+JSON.stringify({result,targets,metadata}));})().catch(e=>{console.error(e);process.exitCode=1});
  `, dist, root!, operation], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, CODEGRAPH_ALL_LANGUAGES: '1' } });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout.split('\n').find(line => line.startsWith('RESULT '))!.slice(7));
}
for (const mode of ['missing', 'poisoned', 'healthy-v1'] as const) {
  it.skipIf(!legacy || (mode !== 'missing' && !buggy))(`repairs real released ${mode} database and makes the next sync a no-op`, async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-real-policy-'));
    fs.writeFileSync(path.join(root, 'a.ts'), 'export function target() { return 1; }\n');
    fs.writeFileSync(path.join(root, 'b.ts'), 'export function target() { return 2; }\n');
    fs.writeFileSync(path.join(root, 'use.ts'), 'import { target } from "@target"; export function caller() { return target(); }\n');
    const config = (target: string) => fs.writeFileSync(path.join(root!, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@target': [target] } } }));
    config('a.ts');
    const original = run(legacy!, 'init');
    expect(original.targets).toEqual(['a.ts']);
    expect(original.metadata.every(([, value]: [string, string | null]) => value === null)).toBe(true);
    if (mode !== 'healthy-v1') config('b.ts');
    if (mode !== 'missing') {
      const prior = run(buggy!, 'sync');
      expect(prior.result.complete).toBe(true); expect(prior.result.filesModified).toBe(0);
      expect(prior.targets).toEqual(['a.ts']);
      expect(prior.metadata.find(([key]: [string]) => key === 'index:semantic-config-v1')[1]).not.toBeNull();
    }
    graph = CodeGraph.openSync(root);
    const result = await graph.sync();
    expect(result.complete).toBe(true); expect(result.filesModified).toBe(3);
    const targets = graph.getCallees(graph.getNodesByName('caller')[0]!.id).filter(x => x.node.name === 'target').map(x => x.node.filePath);
    expect(targets).toEqual([mode === 'healthy-v1' ? 'a.ts' : 'b.ts']);
    // Reopen the active file: portable sync may have forwarded to a bound writer.
    graph.close(); await graph.whenIdle(); graph = CodeGraph.openSync(root);
    const db = new DatabaseSync(graph.getDatabaseFilePath(), { readOnly: true });
    try {
      expect(db.prepare('SELECT value FROM project_metadata WHERE key=?').get(SEMANTIC_CONFIG_KEY)).toBeDefined();
      expect(db.prepare('SELECT value FROM project_metadata WHERE key=?').get(SEMANTIC_REINDEX_PENDING)).toBeUndefined();
    } finally { db.close(); }
    expect((await graph.sync({ adaptive: false })).filesModified).toBe(0);
  }, 60_000);
}
