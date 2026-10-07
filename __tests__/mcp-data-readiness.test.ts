import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';
import { MCPEngine } from '../src/mcp/engine';
import { __emitWatchEventForTests } from '../src/sync/watcher';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

describe('MCP data readiness during a real refresh', () => {
  let folder: string;
  let cg: CodeGraph;
  let handler: ToolHandler;
  const releases: Array<() => void> = [];
  const work: Array<Promise<unknown>> = [];
  const internal = () => cg as any;
  const text = async (tool: string, args: Record<string, unknown>) => {
    const response = await handler.execute(tool, args);
    expect(response.isError, response.content.map(c => c.text).join('\n')).toBeFalsy();
    return response.content.map(c => c.text).join('\n');
  };
  const edit = () => fs.appendFileSync(path.join(folder, 'api.c'), '\nint added(void) { return 7; }\n');
  function pause(object: any, method: string) {
    const entered = deferred(), release = deferred();
    const original = object[method].bind(object);
    vi.spyOn(object, method).mockImplementationOnce(async (...args: any[]) => {
      entered.resolve();
      await release.promise;
      return original(...args);
    });
    releases.push(release.resolve);
    return { entered: entered.promise, release: release.resolve };
  }
  function sync() {
    const p = cg.sync();
    work.push(p);
    handler.setCatchUpGate(p.then(result => {
      if (result.complete === false) throw new Error('incomplete refresh');
    }));
    return p;
  }
  async function watchEventsOnly() {
    cg.watch({ inertForTests: true, debounceMs: 60_000 }); await cg.waitUntilWatcherReady();
    // This suite controls the refresh boundary explicitly. The existing
    // staleness suite covers the real debounce/automatic-sync lifecycle.
    vi.spyOn(internal().watcher, 'scheduleSync').mockImplementation(() => {});
  }

  beforeEach(async () => {
    vi.stubEnv('CODEGRAPH_MCP_CATCHUP_BUDGET_MS', '0');
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-readiness-'));
    fs.writeFileSync(path.join(folder, 'api.h'), 'int target(int value);\nint declaration_only(int value);\n');
    fs.writeFileSync(path.join(folder, 'api.c'), '#include "api.h"\nint target(int value) { return value; }\n');
    fs.writeFileSync(path.join(folder, 'caller.c'), '#include "api.h"\nint caller(void) { return target(1); }\n');
    cg = CodeGraph.initSync(folder);
    expect((await cg.indexAll()).complete).toBe(true);
    handler = new ToolHandler(cg);
  });
  afterEach(async () => {
    releases.splice(0).forEach(release => release());
    await Promise.allSettled(work.splice(0));
    cg?.unwatch();
    handler?.closeAll();
    cg?.close();
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    if (folder) fs.rmSync(folder, { recursive: true, force: true });
  });

  it('warns before storage, then serves symbol-only data silently while relationships resolve', async () => {
    edit();
    const extraction = pause(internal().orchestrator, 'sync');
    const resolution = pause(internal().resolver, 'resolveFilesAndPersist');
    const p = sync();
    await extraction.entered;
    expect(cg.getIndexDataReadiness()).toMatchObject({ symbolsReady: false, relationshipsReady: false });
    expect(await text('search', { query: 'target' })).toContain('Index refresh is still running');
    extraction.release();
    await resolution.entered;
    expect(cg.getIndexDataReadiness()).toMatchObject({ symbolsReady: true, relationshipsReady: false });
    const search = await text('search', { queries: ['added', 'target', 'declaration_only'] });
    expect(search).toContain('added');
    expect(search).not.toMatch(/⚠️|no indexed definition|authoritative for the current index/i);
    const node = await text('node', { symbol: 'declaration_only', includeCode: true });
    expect(node).toContain('declaration_only');
    expect(node).not.toMatch(/⚠️|Declaration \/ Definition|authoritative/i);
    const outline = await text('node', { file: 'api.h', symbolsOnly: true });
    expect(outline).not.toMatch(/⚠️|used by|no other indexed file depends/i);
    const callers = await text('callers', { symbol: 'target' });
    expect(callers).toContain('Symbol data is ready; relationship data is incomplete');
    expect(callers).not.toContain('No callers found');
    const explicit = await text('node', { symbol: 'declaration_only', includeRelations: true });
    expect(explicit).toContain('relationship data is incomplete');
    expect(explicit).not.toContain('Treat this as authoritative');
    expect(await text('status', {})).toContain('**Symbol data:** ready');
    resolution.release(); await p;
    expect(await text('callers', { symbol: 'target' })).not.toContain('⚠️');
    expect(await text('node', { symbol: 'declaration_only' })).toContain('No indexed definition found');
  });

  it('clears data warnings during maintenance without prematurely completing sync', async () => {
    edit(); const maintenance = pause(internal().db, 'runMaintenance');
    const p = sync(); await maintenance.entered;
    expect(cg.isIndexing()).toBe(true);
    expect(cg.getIndexDataReadiness()).toMatchObject({ symbolsReady: true, relationshipsReady: true });
    expect(await text('callers', { symbol: 'target' })).not.toContain('⚠️');
    expect(await text('node', { symbol: 'declaration_only', includeRelations: true })).not.toContain('⚠️');
    expect(await text('status', {})).toContain('**Relationship data:** ready');
    maintenance.release(); expect((await p).complete).toBe(true);
  });

  it('does not advertise symbol readiness before a late co-importer re-extraction', async () => {
    edit();
    const original = internal().orchestrator.sync.bind(internal().orchestrator);
    vi.spyOn(internal().orchestrator, 'sync').mockImplementationOnce(async (...args: any[]) => ({
      ...await original(...args), failedRewireSourceFiles: ['caller.c'],
    }));
    const fallback = pause(internal().orchestrator, 'indexFile');
    const p = sync(); await fallback.entered;
    expect(cg.getIndexDataReadiness()?.symbolsReady).toBe(false);
    expect(await text('search', { query: 'added' })).toContain('Index refresh is still running');
    fallback.release(); expect((await p).complete).toBe(true);
    expect(cg.getIndexDataReadiness()?.symbolsReady).toBe(true);
  });

  it('revokes readiness on another watcher event, even in the same millisecond', async () => {
    await watchEventsOnly();
    vi.spyOn(Date, 'now').mockReturnValue(123456);
    edit(); __emitWatchEventForTests(folder, 'api.c');
    const resolution = pause(internal().resolver, 'resolveFilesAndPersist');
    const p = sync(); await resolution.entered;
    expect(cg.getIndexDataReadiness()?.symbolsReady).toBe(true);
    fs.appendFileSync(path.join(folder, 'api.c'), '\nint later(void) { return 8; }\n');
    __emitWatchEventForTests(folder, 'api.c');
    expect(cg.getIndexDataReadiness()?.symbolsReady).toBe(false);
    expect(await text('search', { query: 'added' })).toContain('Index refresh is still running');
    resolution.release(); await p;
  });

  it('keeps concurrent symbol and relationship requests isolated', async () => {
    edit(); const resolution = pause(internal().resolver, 'resolveFilesAndPersist');
    const p = sync(); await resolution.entered;
    const source = pause(cg, 'getCode');
    const node = text('node', { symbol: 'added', includeCode: true });
    await source.entered;
    const callers = await text('callers', { symbol: 'target' });
    expect(callers).toContain('relationship data is incomplete');
    source.release(); expect(await node).not.toContain('⚠️');
    resolution.release(); await p;
  });

  it('rechecks readiness after an awaited source read', async () => {
    await watchEventsOnly();
    const source = pause(cg, 'getCode');
    const request = text('node', { symbol: 'target', file: 'api.c', includeCode: true });
    await source.entered;
    edit(); __emitWatchEventForTests(folder, 'api.c');
    source.release();
    expect(await request).toContain('symbol results may be stale or incomplete');
  });

  it('keeps relationship warnings after a nonthrowing incomplete synthesis result', async () => {
    edit();
    vi.spyOn(internal().resolver, 'synthesizeIncrementalCCpp').mockRejectedValueOnce(new Error('test synthesis failure'));
    const result = await sync();
    expect(result.complete).toBe(false);
    expect(cg.getIndexDataReadiness()).toMatchObject({ symbolsReady: true, relationshipsReady: false });
    expect(await text('search', { query: 'added' })).not.toContain('⚠️');
    expect(await text('callers', { symbol: 'target' })).toContain('relationship data is incomplete');
  });

  it('MCP engine retains a warning for complete:false even when sync resolves', async () => {
    const engine = new MCPEngine({ watch: false });
    (engine as any).cg = cg;
    (engine as any).toolHandler = handler;
    vi.spyOn(cg, 'sync').mockResolvedValueOnce({
      complete: false, filesChecked: 3, filesAdded: 0, filesModified: 0,
      filesRemoved: 0, nodesUpdated: 0, durationMs: 1,
    });
    (engine as any).catchUpSync();
    await new Promise(resolve => setImmediate(resolve));
    expect(await text('search', { query: 'target' })).toContain('Startup index refresh was incomplete');
  });

  it('also publishes symbol readiness during full indexing', async () => {
    edit(); const resolution = pause(cg, 'resolveReferencesBatched');
    const p = cg.indexAll({ force: true }); work.push(p);
    handler.setCatchUpGate(p.then(() => undefined));
    await resolution.entered;
    expect(cg.getIndexDataReadiness()).toMatchObject({ symbolsReady: true, relationshipsReady: false });
    expect(await text('search', { query: 'added' })).not.toContain('⚠️');
    expect(await text('callers', { symbol: 'target' })).toContain('relationship data is incomplete');
    resolution.release(); expect((await p).complete).toBe(true);
  });

  it('does not certify node data when cross-file finalization reports errors', async () => {
    edit();
    const failure = vi.spyOn(internal().resolver, 'hasPostExtractErrors').mockReturnValue(true);
    const resolution = pause(internal().resolver, 'resolveFilesAndPersist');
    const p = sync(); await resolution.entered;
    expect(cg.getIndexDataReadiness()?.symbolsReady).toBe(false);
    expect(await text('search', { query: 'added' })).toContain('Index refresh is still running');
    failure.mockRestore(); resolution.release(); await p;
  });

  it('does not certify a scoped refresh that omits already pending files', async () => {
    await watchEventsOnly();
    edit(); __emitWatchEventForTests(folder, 'api.c');
    fs.appendFileSync(path.join(folder, 'caller.c'), '\nint outside_scope(void) { return 9; }\n');
    __emitWatchEventForTests(folder, 'caller.c');
    const resolution = pause(internal().resolver, 'resolveFilesAndPersist');
    const p = cg.sync({ paths: ['api.c'] }); work.push(p);
    handler.setCatchUpGate(p.then(() => undefined));
    await resolution.entered;
    expect(cg.getIndexDataReadiness()?.symbolsReady).toBe(false);
    expect(await text('search', { query: 'outside_scope' })).toContain('Index refresh is still running');
    resolution.release(); await p;
  });

  it('does not let an old completed proof hide a later persisted incomplete index', async () => {
    internal().queries.setMetadata('index_completeness', 'incomplete');
    internal().queries.setMetadata('index_diagnostics', JSON.stringify([
      { code: 'synthesis_failed', severity: 'error', message: 'another refresh failed' },
    ]));
    expect(cg.getIndexDataReadiness()).toMatchObject({ symbolsReady: false, relationshipsReady: false });
    expect(await text('search', { query: 'target' })).toContain('symbol results may be stale or incomplete');
  });

  it('does not attach one project refresh warning to a different project', async () => {
    const other = path.join(folder, 'other'); fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'other.c'), 'int separate(void) { return 1; }\n');
    const separate = CodeGraph.initSync(other); await separate.indexAll();
    // ToolHandler's lazy CommonJS opener is exercised by compiled integration
    // tests; retain the real TS graph here instead of requiring TS through CJS.
    (handler as any).projectCache.set(other, separate);
    handler.setCatchUpGate(new Promise<void>(() => {}));
    expect(await text('search', { query: 'separate', projectPath: other })).not.toContain('⚠️');
  });

  it('does not resurrect an old ready state when the watcher stops or restarts', async () => {
    await watchEventsOnly();
    edit(); __emitWatchEventForTests(folder, 'api.c');
    expect(cg.getIndexDataReadiness()?.symbolsReady).toBe(false);
    cg.unwatch();
    expect(cg.getIndexDataReadiness()?.symbolsReady).toBe(false);
    expect(await text('search', { query: 'target' })).toContain('symbol results may be stale or incomplete');
    await watchEventsOnly();
    expect(cg.getIndexDataReadiness()?.symbolsReady).toBe(false);
    expect((await cg.sync()).complete).toBe(true);
    expect(cg.getIndexDataReadiness()?.symbolsReady).toBe(true);
  });

  it('warns relationship queries when changes are still in the watcher debounce window', async () => {
    await watchEventsOnly();
    fs.writeFileSync(path.join(folder, 'caller.c'), 'int caller(void) { return 0; }\n');
    __emitWatchEventForTests(folder, 'caller.c');
    expect(cg.isIndexing()).toBe(false);
    const result = await text('callers', { symbol: 'target' });
    expect(result).toContain('symbol results may be stale or incomplete');
    expect(result).toContain('caller'); // retain the partial graph, with a warning
  });
});
