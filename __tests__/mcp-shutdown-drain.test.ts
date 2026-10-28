/** Actual stdio JSON-RPC process shutdown must drain last-reader retirement GC. */
import { it, expect } from 'vitest';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { spawn } from 'child_process'; import readline from 'readline';
const { CodeGraph } = require('../dist') as typeof import('../src');
const { getCodeGraphDir } = require('../dist/directory') as typeof import('../src/directory');
const { resolveGeneration, collectRetiredGenerations } = require('../dist/sync/generation-store') as typeof import('../src/sync/generation-store');
it('normal stdin EOF waits for default/readers close and queued GC before exit 0', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-stdio-drain-'));
  const argv = process.execArgv; process.execArgv = ['--liftoff-only'];
  let child: ReturnType<typeof spawn> | undefined;
  let graph: InstanceType<typeof CodeGraph> | undefined;
  try {
    fs.writeFileSync(path.join(root, 'main.c'), 'int shutdown_old_symbol(void) { return 1; }\n');
    graph = await CodeGraph.init(root, { index: true });
    const data = getCodeGraphDir(root), old = resolveGeneration(data);
    expect(old.id).not.toBeNull();
    child = spawn(process.execPath, ['--liftoff-only', path.resolve(__dirname, '../dist/bin/codegraph.js'),
      'serve', '--mcp', '--path', root], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: '', CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_NO_WATCH: '1', CODEGRAPH_MCP_CATCHUP_BUDGET_MS: '10000' } });
    let stderr = '', id = 0;
    child.stderr!.on('data', chunk => { stderr += chunk; });
    const pending = new Map<number, (value: any) => void>();
    const lines = readline.createInterface({ input: child.stdout! });
    lines.on('line', line => {
      try { const message = JSON.parse(line); pending.get(message.id)?.(message); } catch { /* diagnostics */ }
    });
    const rpc = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
      const request = ++id;
      const timer = setTimeout(() => { pending.delete(request); reject(new Error(`RPC timeout: ${stderr}`)); }, 15000);
      pending.set(request, value => { clearTimeout(timer); pending.delete(request); resolve(value); });
      child!.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: request, method, params }) + '\n');
    });
    await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'drain-test', version: '1' } });
    const query = (query: string) => rpc('tools/call', { name: 'search', arguments: { query } });
    const before = await query('shutdown_old_symbol');
    expect(before.error, JSON.stringify(before)).toBeUndefined();
    expect(before.result.isError, JSON.stringify(before)).toBeFalsy();
    expect(before.result.content.map((item: any) => item.text ?? '').join('\n')).toContain('### shutdown_old_symbol (');
    // The configured admission budget above waits for child startup catch-up.
    fs.writeFileSync(path.join(root, '.gitignore'), '# configuration rebuild\n');
    fs.writeFileSync(path.join(root, 'main.c'), 'int shutdown_new_symbol(void) { return 2; }\n');
    const rebuilt = await graph.sync();
    expect(rebuilt.adaptive?.strategy).toBe('rebuild');
    const current = resolveGeneration(data); expect(current.id).not.toBe(old.id);
    graph.close(); graph = undefined;
    await collectRetiredGenerations(data);
    // An idle facade may already have retired A before shutdown. Either way
    // EOF must leave no retired directory and must preserve the current DB.
    expect(fs.existsSync(current.databasePath)).toBe(true);
    const after = await query('shutdown_new_symbol');
    expect(after.result.isError, JSON.stringify(after)).toBeFalsy();
    expect(after.result.content.map((item: any) => item.text ?? '').join('\n')).toContain('### shutdown_new_symbol (');
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Graceful exit timeout: ${stderr}`)), 15000);
      child!.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    child.stdin!.end();
    expect(await exited).toEqual({ code: 0, signal: null });
    // No parent-side collection here: successful child exit certifies its drain.
    expect(fs.existsSync(path.dirname(old.databasePath))).toBe(false);
    expect(fs.existsSync(current.databasePath)).toBe(true);
    expect(stderr).not.toContain('Shutdown drain timed out');
    lines.close();
  } finally {
    graph?.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL'); await new Promise(resolve => child!.once('close', resolve));
    }
    process.execArgv = argv;
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 45000);

it('live stdio MCP automatically collects three background rebuilds with no intervening requests', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-stdio-drain-'));
  const argv = process.execArgv; process.execArgv = ['--liftoff-only'];
  let child: ReturnType<typeof spawn> | undefined;
  let graph: InstanceType<typeof CodeGraph> | undefined;
  try {
    fs.writeFileSync(path.join(root, 'main.c'), 'int shutdown_old_symbol(void) { return 1; }\n');
    graph = await CodeGraph.init(root, { index: true });
    const data = getCodeGraphDir(root), old = resolveGeneration(data);
    expect(old.id).not.toBeNull();
    graph.close(); graph = undefined;
    await collectRetiredGenerations(data);
    child = spawn(process.execPath, ['--liftoff-only', path.resolve(__dirname, '../dist/bin/codegraph.js'),
      'serve', '--mcp', '--path', root], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: '', CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_NO_WATCH: '', CODEGRAPH_WATCH_DEBOUNCE_MS: '20', CODEGRAPH_MCP_CATCHUP_BUDGET_MS: '10000' } });
    let stderr = '', id = 0;
    child.stderr!.on('data', chunk => { stderr += chunk; });
    const pending = new Map<number, (value: any) => void>();
    const lines = readline.createInterface({ input: child.stdout! });
    lines.on('line', line => {
      try { const message = JSON.parse(line); pending.get(message.id)?.(message); } catch { /* diagnostics */ }
    });
    const rpc = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
      const request = ++id;
      const timer = setTimeout(() => { pending.delete(request); reject(new Error(`RPC timeout: ${stderr}`)); }, 15000);
      pending.set(request, value => { clearTimeout(timer); pending.delete(request); resolve(value); });
      child!.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: request, method, params }) + '\n');
    });
    await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'drain-test', version: '1' } });
    const query = (query: string) => rpc('tools/call', { name: 'search', arguments: { query } });
    const before = await query('shutdown_old_symbol');
    expect(before.error, JSON.stringify(before)).toBeUndefined();
    expect(before.result.isError, JSON.stringify(before)).toBeFalsy();
    expect(before.result.content.map((item: any) => item.text ?? '').join('\n')).toContain('### shutdown_old_symbol (');
    let previous = old;
    const waitUntil = async (predicate: () => boolean) => {
      const until = Date.now() + 15000;
      while (!predicate()) {
        if (Date.now() > until) throw new Error(`Background rebuild/collection timed out: ${stderr}`);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    };
    for (let step = 1; step <= 3; step++) {
      fs.writeFileSync(path.join(root, '.gitignore'), `# background rebuild ${step}\n`);
      fs.writeFileSync(path.join(root, 'main.c'), `int shutdown_new_symbol(void) { return ${step}; }\n`);
      // Observe the manifest only: no parent lease release or collector may
      // manufacture the automatic GC result we are asserting in this process.
      await waitUntil(() => JSON.parse(fs.readFileSync(path.join(data, 'CURRENT'), 'utf8')).generation !== previous.id);
      const manifest = JSON.parse(fs.readFileSync(path.join(data, 'CURRENT'), 'utf8'));
      const current = { id: manifest.generation, databasePath: path.join(data, 'generations', manifest.generation, 'codegraph.db') };
      await waitUntil(() => !fs.existsSync(path.dirname(previous.databasePath)));
      expect(fs.readdirSync(path.join(data, 'generations'))).toEqual([current.id]);
      previous = current;
      // Deliberately no tools/call: the idle cached/default facades themselves
      // must not retain each retired generation until the next request or exit.
    }
    const after = await query('shutdown_new_symbol');
    expect(after.result.isError, JSON.stringify(after)).toBeFalsy();
    expect(after.result.content.map((item: any) => item.text ?? '').join('\n')).toContain('### shutdown_new_symbol (');
    const current = previous;
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Graceful exit timeout: ${stderr}`)), 15000);
      child!.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    child.stdin!.end();
    expect(await exited).toEqual({ code: 0, signal: null });
    // No parent-side collection here: successful child exit certifies its drain.
    expect(fs.existsSync(path.dirname(old.databasePath))).toBe(false);
    expect(fs.existsSync(current.databasePath)).toBe(true);
    expect(stderr).not.toContain('Shutdown drain timed out');
    lines.close();
  } finally {
    graph?.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL'); await new Promise(resolve => child!.once('close', resolve));
    }
    process.execArgv = argv;
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 45000);
