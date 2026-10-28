/** Acceptance checks against an independent fresh index. Synthetic cost history
 * is used solely to choose the rebuild branch, never as timing evidence.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import type { CodeGraph as Graph } from '../src';
import type { AdaptiveCostHistory, AdaptiveCostSample } from '../src/sync/adaptive-plan';
const { CodeGraph } = require('../dist') as typeof import('../src');
const { adaptiveRuntimeKey, createAdaptivePlan, chooseAdaptiveStrategy } =
  require('../dist/sync/adaptive-plan') as typeof import('../src/sync/adaptive-plan');
const { DatabaseSync } = require('node:sqlite');

const roots: string[] = [];
const graphs: Graph[] = [];
function directory(): string { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-acceptance-')); roots.push(root); return root; }
function keep(graph: Graph): Graph { graphs.push(graph); return graph; }
afterEach(() => {
  for (const graph of graphs.splice(0)) graph.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function source(root: string, replacement = false): void {
  fs.writeFileSync(path.join(root, 'main.cpp'), replacement
    ? 'int target_leaf() { return 222; }\nint target_caller() { return target_leaf(); }\nint outer_caller() { return target_caller(); }\n'
    : 'int old_leaf() { return 1; }\nint old_caller() { return old_leaf(); }\n');
  fs.writeFileSync(path.join(root, 'independent.cpp'), 'int independent_symbol() { return 7; }\n');
}
function canonical(value: unknown): unknown {
  if (value instanceof Map) return [...value.entries()].sort(([a], [b]) => String(a).localeCompare(String(b))).map(([key, entry]) => [key, canonical(entry)]);
  if (Array.isArray(value)) return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort()
      .filter(key => !['updated_at', 'indexed_at', 'modified_at', 'updatedAt', 'indexedAt', 'modifiedAt'].includes(key))
      // Edge ids are insertion counters; stable node ids remain part of the comparison.
      .filter(key => key !== 'id' || typeof object.id === 'string')
      .map(key => [key, canonical(object[key])]));
  }
  return value;
}
function normalizedTables(databasePath: string): Record<string, unknown> {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try { return Object.fromEntries(['files', 'nodes', 'edges', 'unresolved_refs'].map(table => [table, canonical(db.prepare('SELECT * FROM ' + table).all())])); }
  finally { db.close(); }
}
async function artificialRebuildHistory(root: string, graph: Graph): Promise<void> {
  const plan = await createAdaptivePlan(root, graph.getFiles(), { runtimeKey: adaptiveRuntimeKey(root, graph.getBackend()) });
  const sample: AdaptiveCostSample = {
    kind: 'incremental', runtimeKey: plan.runtimeKey, configFingerprint: plan.snapshot.configFingerprint,
    totalFiles: plan.totalFiles, totalBytes: plan.totalBytes, totalNodes: plan.totalNodes,
    durationMs: 100_000, changedFiles: plan.changedFiles, affectedOldNodes: plan.affectedOldNodes,
    changedBytes: plan.changedBytes, addedFiles: plan.added.length, modifiedFiles: plan.modified.length,
    removedFiles: plan.removed.length, shape: plan.shape, recordedAt: Date.now(),
  };
  const history: AdaptiveCostHistory = { version: 1, samples: [
    { ...sample, kind: 'full', durationMs: 1_000 }, sample, { ...sample }, { ...sample },
  ] };
  expect(chooseAdaptiveStrategy(plan, history).strategy).toBe('rebuild');
  fs.writeFileSync(path.join(graph.getDataDirectory(), 'adaptive-cost-history.json'), JSON.stringify(history));
}

describe('adaptive rebuild final validation', () => {
  it('matches an independent fresh-init graph and meaningful public queries', async () => {
    const originalArgv = process.execArgv;
    const nodeOptions = process.env.NODE_OPTIONS;
    process.execArgv = ['--liftoff-only']; delete process.env.NODE_OPTIONS;
    try {
      const root = directory(); const freshRoot = directory(); source(root);
      const writer = keep(await CodeGraph.init(root, { index: true }));
      source(root, true); source(freshRoot, true);
      await artificialRebuildHistory(root, writer);
      expect((await writer.sync()).complete).toBe(true);
      expect(fs.existsSync(path.join(writer.getDataDirectory(), 'CURRENT'))).toBe(true);
      const rebuilt = keep(CodeGraph.openReadOnlySync(root));
      const fresh = keep(await CodeGraph.init(freshRoot, { index: true }));
      expect(fresh.getIndexCompleteness().status).toBe('complete');
      expect(normalizedTables(rebuilt.getDatabaseFilePath())).toEqual(normalizedTables(fresh.getDatabaseFilePath()));
      for (const query of ['target_leaf', 'target_caller', 'independent_symbol']) {
        const actual = rebuilt.searchNodes(query).map(row => row.node.id).sort();
        expect(actual.length).toBeGreaterThan(0);
        expect(actual).toEqual(fresh.searchNodes(query).map(row => row.node.id).sort());
      }
      const node = rebuilt.searchNodes('target_leaf').find(row => row.node.name === 'target_leaf')!.node;
      const callers = rebuilt.getCallers(node.id);
      expect(callers.some(row => row.node.name === 'target_caller')).toBe(true);
      expect(canonical(callers)).toEqual(canonical(fresh.getCallers(node.id)));
      expect(canonical(rebuilt.getContext(node.id))).toEqual(canonical(fresh.getContext(node.id)));
      const impact = rebuilt.getImpactRadius(node.id);
      expect(impact.nodes.size).toBeGreaterThan(1);
      expect(canonical(impact)).toEqual(canonical(fresh.getImpactRadius(node.id)));
      expect(rebuilt.searchNodes('old_leaf').some(row => row.node.name === 'old_leaf')).toBe(false);
    } finally {
      process.execArgv = originalArgv;
      if (nodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = nodeOptions;
    }
  }, 60_000);

  it('rejects every indexing/database mutation on an explicit pinned read-only facade', async () => {
    const root = directory(); source(root);
    const writer = keep(await CodeGraph.init(root, { index: true }));
    const reader = keep(CodeGraph.openReadOnlySync(root));
    const before = normalizedTables(writer.getDatabaseFilePath());
    await expect(reader.sync()).rejects.toThrow(/read-only/);
    await expect(reader.indexAll()).rejects.toThrow(/read-only/);
    await expect(reader.indexFiles(['main.cpp'])).rejects.toThrow(/read-only/);
    expect(() => reader.clear()).toThrow(/read-only/);
    expect(() => reader.optimize()).toThrow(/read-only/);
    expect(() => reader.uninitialize()).toThrow(/read-only/);
    expect(normalizedTables(writer.getDatabaseFilePath())).toEqual(before);
  }, 60_000);

  it('fails closed when a published native generation is opened through forced WASM', async () => {
    const originalArgv = process.execArgv; const nodeOptions = process.env.NODE_OPTIONS;
    process.execArgv = ['--liftoff-only']; delete process.env.NODE_OPTIONS;
    try {
      const root = directory(); source(root);
      const writer = keep(await CodeGraph.init(root, { index: true })); source(root, true);
      await artificialRebuildHistory(root, writer);
      expect((await writer.sync()).complete).toBe(true);
      const manifest = fs.readFileSync(path.join(writer.getDataDirectory(), 'CURRENT'), 'utf8');
      const script = `
        const {ensureSqlJsReady}=require('./dist/db/sqlite-adapter');
        const {CodeGraph}=require('./dist');
        (async()=>{ await ensureSqlJsReady();
          try { const g=await CodeGraph.open(process.argv[1]); g.close(); throw Error('UNEXPECTED_WRITABLE_OPEN'); }
          catch(e) { if(!String(e).includes('connections require the node:sqlite backend')) throw e;
            console.log('EXPECTED_NATIVE_GENERATION_REJECTION'); }
        })().catch(e=>{ console.error(e); process.exitCode=1; });`;
      const output = execFileSync(process.execPath, ['--liftoff-only', '-e', script, root], {
        cwd: path.resolve(__dirname, '..'), env: { ...process.env, CODEGRAPH_FORCE_WASM: '1', NODE_OPTIONS: '' },
        encoding: 'utf8', timeout: 30_000,
      });
      expect(output).toContain('EXPECTED_NATIVE_GENERATION_REJECTION');
      // A previously opened facade must not bypass the same native-only admission
      // when it forwards a writer from the retired flat database into CURRENT.
      const priorForce = process.env.CODEGRAPH_FORCE_WASM;
      process.env.CODEGRAPH_FORCE_WASM = '1';
      try { await expect(writer.sync({ adaptive: false })).rejects.toThrow(/require the node:sqlite backend/); }
      finally { if (priorForce === undefined) delete process.env.CODEGRAPH_FORCE_WASM; else process.env.CODEGRAPH_FORCE_WASM = priorForce; }
      expect(fs.existsSync(path.join(writer.getDataDirectory(), 'codegraph.lock'))).toBe(false);
      expect(fs.readFileSync(path.join(writer.getDataDirectory(), 'CURRENT'), 'utf8')).toBe(manifest);
      expect(writer.searchNodes('target_leaf').some(row => row.node.name === 'target_leaf')).toBe(true);
    } finally {
      process.execArgv = originalArgv;
      if (nodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = nodeOptions;
    }
  }, 60_000);

  // Known upstream baseline failure, NOT an adaptive functional pass. Reproduced on
  // untouched 1765271 with identical dependencies: sql.js cached statement errors.
  // See docs/benchmarks/evidence/adaptive-sync-20261028/wasm-baseline-diagnostic.log. Remove fails
  // only when the independent adapter bug is repaired and this contract passes.
  it.fails('KNOWN BASELINE FAILURE: real sql.js init/sync fallback without CURRENT', () => {
    const root = directory(); source(root);
    const script = `
      const fs=require('fs'), path=require('path');
      const {ensureSqlJsReady}=require('./dist/db/sqlite-adapter');
      const {CodeGraph}=require('./dist');
      (async()=>{
        await ensureSqlJsReady();
        const graph=await CodeGraph.init(process.argv[1], {index:true});
        try {
          if(graph.getBackend()!=='sql-js') throw Error('WASM fallback was not exercised');
          fs.writeFileSync(path.join(process.argv[1],'main.cpp'),'int wasm_updated_symbol(){return 456;}\\n');
          const decisions=[];
          const result=await graph.sync({onAdaptiveDecision:d=>decisions.push(d)});
          if(result.complete!==true) throw Error('WASM sync incomplete');
          if(!graph.searchNodes('wasm_updated_symbol').some(r=>r.node.name==='wasm_updated_symbol')) throw Error('WASM query stale');
          if(fs.existsSync(path.join(graph.getDataDirectory(),'CURRENT'))) throw Error('WASM published a generation');
          if(!decisions.length||decisions.some(d=>d.strategy!=='incremental')) throw Error('WASM did not stay incremental');
          console.log(JSON.stringify({backend:graph.getBackend(),complete:result.complete,decisions}));
        } finally {graph.close();}
      })().catch(e=>{console.error(e);process.exitCode=1;});`;
    const output = execFileSync(process.execPath, ['--liftoff-only', '-e', script, root], {
      cwd: path.resolve(__dirname, '..'), env: { ...process.env, CODEGRAPH_FORCE_WASM: '1', NODE_OPTIONS: '' },
      encoding: 'utf8', timeout: 60_000,
    });
    expect(output).toContain('"backend":"sql-js"');
    expect(output).toContain('"complete":true');
  }, 70_000);
});
