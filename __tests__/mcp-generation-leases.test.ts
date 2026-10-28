import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import * as readline from 'readline';
import { ToolHandler } from '../src/mcp/tools';
import { MCPEngine } from '../src/mcp/engine';
import { getCodeGraphDir } from '../src/directory';
import { resolveGeneration } from '../src/sync/generation-store';
import type CodeGraph from '../src/index';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

// These facade-level tests deliberately avoid SQLite: they verify that the
// request lease pins an entire object, including async calls across publication.
// Storage and real read-only SQL are covered by the generation integration tests.
class Graph {
  static opened: Graph[] = [];
  closed = false;
  closeCount = 0;
  unwatch = vi.fn();
  abortActiveWork = vi.fn();
  constructor(readonly root: string, readonly file: string) {}
  static openReadOnlySync(root: string) {
    const graph = new Graph(root, resolveGeneration(getCodeGraphDir(root)).databasePath);
    this.opened.push(graph);
    return graph;
  }
  getProjectRoot() { return this.root; }
  getDatabaseFilePath() { return this.file; }
  getIndexDataReadiness() { return null; }
  getIndexCompleteness() { return { status: 'complete' }; }
  getPendingFiles() { return []; }
  isIndexing() { return false; }
  close() { this.closed = true; this.closeCount++; }
}

describe('MCP generation request leases', () => {
  let root: string;
  let base: Graph;
  let handler: ToolHandler;
  const internal = () => handler as any;
  function publish(id: string) {
    const dir = path.join(getCodeGraphDir(root), 'generations', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'codegraph.db'), 'fixture');
    const manifest = JSON.stringify({ version: 1, generation: id, token: randomUUID(), complete: true });
    fs.writeFileSync(path.join(dir, 'READY.json'), manifest);
    fs.writeFileSync(path.join(getCodeGraphDir(root), 'CURRENT'), manifest);
  }
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-generation-'));
    fs.mkdirSync(getCodeGraphDir(root));
    const db = path.join(getCodeGraphDir(root), 'codegraph.db');
    fs.writeFileSync(db, 'fixture');
    base = new Graph(root, db);
    Graph.opened = [];
    handler = new ToolHandler(base as unknown as CodeGraph);
    vi.spyOn(internal(), 'withWorktreeNotice').mockImplementation(result => result);
    vi.spyOn(internal(), 'handleFiles').mockImplementation(async () => {
      const graph = internal().getCodeGraph() as Graph;
      if (graph.closed) throw new Error('closed reader');
      return { content: [{ type: 'text', text: graph.file }] };
    });
  });
  afterEach(() => {
    handler.closeAll();
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function query() {
    const result = await handler.execute('files', {});
    expect(result.isError).toBeFalsy();
    return result.content[0]!.text;
  }
  it('keeps legacy/default ownership and reuses a whole published reader', async () => {
    expect(await query()).toBe(base.file);
    expect(Graph.opened).toHaveLength(0);
    publish('g-one');
    expect(await query()).toContain('g-one');
    expect(await query()).toContain('g-one');
    expect(Graph.opened).toHaveLength(1);
    expect(base.closeCount).toBe(0);
    handler.closeAll(); handler.closeAll();
    expect(base.closeCount).toBe(0);
    expect(Graph.opened[0]!.closeCount).toBe(1);
  });
  it('pins an in-flight reader while a new request observes the new generation', async () => {
    publish('g-one'); await query();
    const entered = deferred(), resume = deferred();
    vi.spyOn(internal(), 'handleFiles').mockImplementationOnce(async () => {
      const first = internal().getCodeGraph() as Graph;
      entered.resolve(); await resume.promise;
      const second = internal().getCodeGraph() as Graph;
      expect(second).toBe(first); expect(first.closed).toBe(false);
      return { content: [{ type: 'text', text: first.file }] };
    });
    const oldRequest = query(); await entered.promise;
    publish('g-two');
    expect(await query()).toContain('g-two');
    expect(Graph.opened[0]!.closed).toBe(false);
    resume.resolve();
    expect(await oldRequest).toContain('g-one');
    expect(Graph.opened[0]!.closeCount).toBe(1);
    expect(Graph.opened[1]!.closed).toBe(false);
  });
  it('releases the retired reader on an exceptional request exit', async () => {
    publish('g-one'); await query();
    const entered = deferred(), resume = deferred();
    vi.spyOn(internal(), 'handleFiles').mockImplementationOnce(async () => {
      internal().getCodeGraph(); entered.resolve(); await resume.promise;
      throw new Error('injected query failure');
    });
    const pending = handler.execute('files', {}); await entered.promise;
    publish('g-two'); await query(); resume.resolve();
    expect((await pending).isError).toBe(true);
    expect(Graph.opened[0]!.closeCount).toBe(1);
  });
  it('closeAll waits for owned in-flight readers and never closes the engine facade', async () => {
    publish('g-one'); await query();
    const entered = deferred(), resume = deferred();
    vi.spyOn(internal(), 'handleFiles').mockImplementationOnce(async () => {
      const graph = internal().getCodeGraph() as Graph;
      entered.resolve(); await resume.promise;
      expect(graph.closed).toBe(false);
      expect(internal().getCodeGraph()).toBe(graph);
      return { content: [{ type: 'text', text: graph.file }] };
    });
    const pending = query(); await entered.promise;
    handler.closeAll(); expect(Graph.opened[0]!.closed).toBe(false);
    resume.resolve(); await pending;
    expect(Graph.opened[0]!.closeCount).toBe(1);
    expect(base.closeCount).toBe(0);
    expect((await handler.execute('files', {})).isError).toBe(true);
  });
  it('keeps cross-project aliases pinned through shutdown and closes each owner once', async () => {
    handler.closeAll();
    handler = new ToolHandler(null);
    const alias = path.join(root, 'nested');
    internal().projectCache.set(root, base);
    internal().projectCache.set(alias, base);
    vi.spyOn(internal(), 'withWorktreeNotice').mockImplementation(result => result);
    const entered = deferred(), resume = deferred();
    vi.spyOn(internal(), 'handleFiles').mockImplementation(async () => {
      const first = internal().getCodeGraph(alias) as Graph;
      expect(internal().getCodeGraph(root)).toBe(first);
      entered.resolve(); await resume.promise;
      expect(internal().getCodeGraph(alias)).toBe(first);
      expect(first.closed).toBe(false);
      return { content: [{ type: 'text', text: first.file }] };
    });
    const pending = handler.execute('files', { projectPath: alias });
    await entered.promise;
    handler.closeAll(); handler.closeAll();
    expect(base.closeCount).toBe(0);
    resume.resolve();
    expect((await pending).isError).toBeFalsy();
    expect(base.closeCount).toBe(1);
    expect(internal().projectCache.size).toBe(0);
  });
  it('engine stop cancels work immediately but defers a borrowed legacy DB close', async () => {
    const engine = new MCPEngine({ watch: false });
    (engine as any).cg = base;
    (engine as any).toolHandler = handler;
    const entered = deferred(), resume = deferred();
    vi.spyOn(internal(), 'handleFiles').mockImplementationOnce(async () => {
      const graph = internal().getCodeGraph() as Graph;
      entered.resolve(); await resume.promise;
      expect(graph.closed).toBe(false);
      expect(internal().getCodeGraph()).toBe(graph);
      return { content: [{ type: 'text', text: graph.file }] };
    });
    const pending = query(); await entered.promise;
    engine.stop();
    expect(base.unwatch).toHaveBeenCalledOnce();
    expect(base.abortActiveWork).toHaveBeenCalledOnce();
    expect(base.closeCount).toBe(0);
    resume.resolve(); await pending;
    expect(base.closeCount).toBe(1);
    engine.stop(); expect(base.closeCount).toBe(1);
  });
  it('stopAndDrain waits for admitted request postprocessing before resolving', async () => {
    const engine = new MCPEngine({ watch: false });
    (engine as any).cg = base;
    (engine as any).toolHandler = handler;
    const entered = deferred(), resume = deferred();
    vi.spyOn(internal(), 'handleFiles').mockImplementationOnce(async () => {
      internal().getCodeGraph(); entered.resolve(); await resume.promise;
      return { content: [{ type: 'text', text: 'done' }] };
    });
    const pending = handler.execute('files', {}); await entered.promise;
    let drained = false;
    const stopping = engine.stopAndDrain().then(() => { drained = true; });
    await Promise.resolve(); expect(drained).toBe(false); expect(base.closeCount).toBe(0);
    resume.resolve(); expect((await pending).isError).toBeFalsy(); await stopping;
    expect(drained).toBe(true); expect(base.closeCount).toBe(1);
  });
  it('bounds a stuck request drain without prematurely closing its leased graph', async () => {
    const engine = new MCPEngine({ watch: false });
    (engine as any).cg = base;
    (engine as any).toolHandler = handler;
    const entered = deferred(), resume = deferred();
    vi.spyOn(internal(), 'handleFiles').mockImplementationOnce(async () => {
      internal().getCodeGraph(); entered.resolve(); await resume.promise;
      return { content: [{ type: 'text', text: 'done' }] };
    });
    const pending = handler.execute('files', {}); await entered.promise;
    await engine.stopAndDrain(10);
    expect(base.closeCount).toBe(0);
    resume.resolve(); await pending;
    expect(base.closeCount).toBe(1);
  });
  it('awaits a cancelled writer unwind before closing its default connection', async () => {
    const engine = new MCPEngine({ watch: false });
    (engine as any).cg = base;
    (engine as any).toolHandler = handler;
    const unwound = deferred();
    vi.spyOn(base, 'isIndexing').mockReturnValue(true);
    (base as any).whenIdle = () => unwound.promise;
    const stopping = engine.stopAndDrain();
    expect(base.abortActiveWork).toHaveBeenCalledOnce();
    expect(base.closeCount).toBe(0);
    unwound.resolve(); await stopping;
    expect(base.closeCount).toBe(1);
  });
  it('does not silently fall back to a stale generation if CURRENT is malformed', async () => {
    publish('g-one'); await query();
    fs.writeFileSync(path.join(getCodeGraphDir(root), 'CURRENT'), '{broken');
    const result = await handler.execute('files', {});
    expect(result.isError).toBe(true);
    expect(Graph.opened).toHaveLength(1);
  });
});

import RealCodeGraph from '../src/index';
import { scanRawSourceEvidence } from '../src/mcp/raw-source-evidence';

describe('MCP published generation with real SQLite facades', () => {
  const roots: string[] = [];
  const graphs: RealCodeGraph[] = [];
  const handlers: ToolHandler[] = [];
  afterEach(() => {
    handlers.splice(0).forEach(handler => handler.closeAll());
    graphs.splice(0).forEach(graph => graph.close());
    roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
    vi.restoreAllMocks();
  });
  async function fixture(symbol: string) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-real-generation-'));
    roots.push(root);
    fs.writeFileSync(path.join(root, 'api.c'), `int ${symbol}(void) { return 1; }\nint caller(void) { return ${symbol}(); }\n`);
    const graph = RealCodeGraph.initSync(root);
    graphs.push(graph);
    expect((await graph.indexAll()).complete).toBe(true);
    return { root, graph };
  }
  async function publishCopy(root: string, source: RealCodeGraph, id: string) {
    const sourceFile = source.getDatabaseFilePath();
    source.close(); graphs.splice(graphs.indexOf(source), 1);
    const destination = path.join(getCodeGraphDir(root), 'generations', id);
    fs.mkdirSync(destination, { recursive: true });
    fs.copyFileSync(sourceFile, path.join(destination, 'codegraph.db'));
    const manifest = JSON.stringify({ version: 1, generation: id, token: randomUUID(), complete: true });
    fs.writeFileSync(path.join(destination, 'READY.json'), manifest);
    fs.writeFileSync(path.join(getCodeGraphDir(root), 'CURRENT'), manifest);
  }
  it('keeps a legacy data root pinned when a preferred index appears later', async () => {
    const original = await fixture('legacy_owner_symbol');
    const replacement = await fixture('preferred_other_symbol');
    original.graph.close(); graphs.splice(graphs.indexOf(original.graph), 1);
    fs.renameSync(path.join(original.root, '.codegraph-wx'), path.join(original.root, '.codegraph'));
    const legacy = RealCodeGraph.openSync(original.root); graphs.push(legacy);
    expect(legacy.getDataDirectory()).toBe(path.join(original.root, '.codegraph'));
    const replacementFile = replacement.graph.getDatabaseFilePath();
    replacement.graph.close(); graphs.splice(graphs.indexOf(replacement.graph), 1);
    fs.mkdirSync(path.join(original.root, '.codegraph-wx'));
    fs.copyFileSync(replacementFile, path.join(original.root, '.codegraph-wx', 'codegraph.db'));
    expect(getCodeGraphDir(original.root)).toBe(path.join(original.root, '.codegraph-wx'));
    const handler = new ToolHandler(legacy); handlers.push(handler);
    const result = await handler.execute('files', {});
    expect(result.isError).toBeFalsy();
    const reader = [...(handler as any).generationReaders.values()][0].graph as RealCodeGraph;
    expect(reader.getDataDirectory()).toBe(path.join(original.root, '.codegraph'));
    expect(reader.searchNodes('legacy_owner_symbol').length).toBeGreaterThan(0);
    expect(reader.searchNodes('preferred_other_symbol')).toHaveLength(0);
  });
  it('keeps raw-source cache watcher guards separate from the pinned SQL reader', async () => {
    const original = await fixture('raw_cache_marker');
    const reader = RealCodeGraph.openReadOnlySync(original.root); graphs.push(reader);
    expect(reader.isWatching()).toBe(false);
    let pending = false, current = true;
    const options = { sourceState: {
      isWatching: () => true,
      getPendingFiles: () => pending ? ['api.c'] : [],
      isCurrentGeneration: () => current,
    } };
    const specs = [{ label: 'marker', needle: 'raw_cache_marker' }];
    expect((await scanRawSourceEvidence(reader, specs, undefined, options)).cacheHit).toBe(false);
    expect((await scanRawSourceEvidence(reader, specs, undefined, options)).cacheHit).toBe(true);
    pending = true;
    expect((await scanRawSourceEvidence(reader, specs, undefined, options)).cacheHit).toBe(false);
    pending = false;
    expect((await scanRawSourceEvidence(reader, specs, undefined, options)).cacheHit).toBe(false);
    expect((await scanRawSourceEvidence(reader, specs, undefined, options)).cacheHit).toBe(true);
    current = false;
    expect((await scanRawSourceEvidence(reader, specs, undefined, options)).cacheHit).toBe(false);
  });
  it('pins a native legacy reader across first publication while SDK reads move forward', async () => {
    const original = await fixture('before_switch');
    const replacement = await fixture('after_switch');
    const handler = new ToolHandler(original.graph); handlers.push(handler);
    const entered = deferred(), resume = deferred();
    let pinned!: RealCodeGraph;
    vi.spyOn(handler as any, 'handleFiles').mockImplementationOnce(async () => {
      pinned = (handler as any).getCodeGraph();
      expect(pinned).not.toBe(original.graph);
      expect(pinned.searchNodes('before_switch').length).toBeGreaterThan(0);
      entered.resolve(); await resume.promise;
      expect((handler as any).getCodeGraph()).toBe(pinned);
      expect(pinned.searchNodes('before_switch').length).toBeGreaterThan(0);
      expect(pinned.searchNodes('after_switch')).toHaveLength(0);
      return { content: [{ type: 'text', text: 'old reader completed' }] };
    });
    const pending = handler.execute('files', {}); await entered.promise;
    await publishCopy(original.root, replacement.graph, 'g-first');
    expect(original.graph.searchNodes('after_switch').length).toBeGreaterThan(0);
    const newer = await handler.execute('search', { query: 'after_switch' });
    expect(newer.isError).toBeFalsy(); expect(newer.content[0]!.text).toContain('after_switch');
    resume.resolve(); expect((await pending).isError).toBeFalsy();
    expect(() => (pinned as any).db.getDb().prepare('SELECT 1').get()).toThrow();
  });
  it.each([false, true])('keeps native readiness and SQL facades alive through stop (failure=%s)', async failure => {
    const { graph } = await fixture('shutdown_symbol');
    const handler = new ToolHandler(graph); handlers.push(handler);
    const engine = new MCPEngine({ watch: false });
    (engine as any).cg = graph;
    (engine as any).toolHandler = handler;
    const baseClose = vi.spyOn(graph, 'close');
    const entered = deferred(), resume = deferred();
    let reader!: RealCodeGraph;
    let readerClose!: ReturnType<typeof vi.spyOn>;
    const original = (handler as any).handleSearch.bind(handler);
    vi.spyOn(handler as any, 'handleSearch').mockImplementationOnce(async args => {
      reader = (handler as any).getCodeGraph();
      expect(reader).not.toBe(graph);
      readerClose = vi.spyOn(reader, 'close');
      entered.resolve(); await resume.promise;
      expect(reader.searchNodes('shutdown_symbol').length).toBeGreaterThan(0);
      if (failure) throw new Error('injected query failure');
      return original(args);
    });
    const pending = handler.execute('search', { query: 'shutdown_symbol' });
    await entered.promise;
    engine.stop(); engine.stop();
    expect(baseClose).not.toHaveBeenCalled();
    expect(readerClose).not.toHaveBeenCalled();
    expect((await handler.execute('search', { query: 'shutdown_symbol' })).isError).toBe(true);
    resume.resolve();
    const result = await pending;
    expect(result.isError ?? false, result.content[0]!.text).toBe(failure);
    expect(result.content[0]!.text).toContain(failure ? 'injected query failure' : 'shutdown_symbol');
    expect(result.content[0]!.text).not.toContain('CodeGraph is closed');
    expect(baseClose).toHaveBeenCalledTimes(1);
    expect(readerClose).toHaveBeenCalledTimes(1);
    graphs.splice(graphs.indexOf(graph), 1);
  });

  it('keeps a separate process request pinned while later MCP requests read the publication', async () => {
    const original = await fixture('process_old_symbol');
    const replacement = await fixture('process_new_symbol');
    const child = spawn(process.execPath, ['--liftoff-only',
      path.resolve(__dirname, '../node_modules/vite-node/vite-node.mjs'), '--script',
      path.join(__dirname, 'fixtures/mcp-generation-reader.ts'), original.root],
    { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '' } });
    const messages = new Map<string, any>();
    const waiters = new Map<string, (value: any) => void>();
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', line => {
      let value: any;
      try { value = JSON.parse(line); } catch { return; }
      const waiter = waiters.get(value.event);
      if (waiter) { waiters.delete(value.event); waiter(value); }
      else messages.set(value.event, value);
    });
    const receive = (event: string): Promise<any> => {
      if (messages.has(event)) return Promise.resolve(messages.get(event));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Missing child ${event}: ${stderr}`)), 15000);
        waiters.set(event, value => { clearTimeout(timer); resolve(value); });
      });
    };
    const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + '\n');
    try {
      await receive('ready');
      send({ id: 'old', args: { query: 'process_old_symbol', pause: true } });
      const admitted = await receive('admitted');
      expect(admitted.file).toBe(original.graph.getDatabaseFilePath());
      await publishCopy(original.root, replacement.graph, 'g-process');
      const handler = new ToolHandler(original.graph); handlers.push(handler);
      const newResult = await handler.execute('search', { query: 'process_new_symbol' });
      expect(newResult.isError, newResult.content[0]!.text).toBeFalsy();
      expect(newResult.content[0]!.text).toContain('process_new_symbol');
      send({ id: 'new', args: { query: 'process_new_symbol' } });
      const newer = await receive('new');
      expect(newer.result.isError).toBeFalsy();
      expect(newer.result.content[0].text).toContain('process_new_symbol');
      send({ action: 'stop' }); await receive('stopped');
      send({ action: 'release' });
      const older = await receive('old');
      expect(older.result.isError, older.result.content[0].text).toBeFalsy();
      expect(older.result.content[0].text).toContain('process_old_symbol');
      expect(older.result.content[0].text).not.toContain('process_new_symbol');
    } finally {
      lines.close();
      child.kill('SIGKILL');
      await new Promise<void>(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else child.once('exit', () => resolve());
      });
    }
  }, 30000);

  it('queries the published whole graph without mutating or closing the legacy owner', async () => {
    const original = await fixture('before_switch');
    const replacement = await fixture('after_switch');
    const handler = new ToolHandler(original.graph); handlers.push(handler);
    const before = await handler.execute('search', { query: 'before_switch' });
    expect(before.isError).toBeFalsy();
    expect(before.content[0]!.text).toContain('before_switch');
    await publishCopy(original.root, replacement.graph, 'g-real');
    for (const [tool, args] of [
      ['search', { query: 'after_switch' }],
      ['callers', { symbol: 'after_switch' }],
      ['files', {}],
      ['status', {}],
    ] as const) {
      const result = await handler.execute(tool, args);
      expect(result.isError, result.content[0]!.text).toBeFalsy();
      if (tool === 'search') expect(result.content[0]!.text).toContain('after_switch');
      if (tool === 'callers') expect(result.content[0]!.text).toContain('caller');
    }
    expect(original.graph.searchNodes('after_switch').length).toBeGreaterThan(0);
    expect(path.basename(path.dirname(original.graph.getDatabaseFilePath()))).not.toBe('g-real');
    const reader = [...(handler as any).generationReaders.values()][0].graph as RealCodeGraph;
    expect(reader.getDatabaseFilePath()).toContain('g-real');
    expect(() => (reader as any).db.getDb().prepare("INSERT INTO metadata (key,value) VALUES ('bad','bad')").run()).toThrow();
  });
});
