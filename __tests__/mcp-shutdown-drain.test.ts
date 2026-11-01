/** Actual stdio JSON-RPC shutdown must drain portable connections and publication cleanup. */
import { it, expect } from 'vitest';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { spawn } from 'child_process'; import readline from 'readline';
const { CodeGraph } = require('../dist') as typeof import('../src');
const { getCodeGraphDir } = require('../dist/directory') as typeof import('../src/directory');
const { DatabaseSync } = require('node:sqlite');
function databaseIdentity(data: string): string {
  const db = new DatabaseSync(path.join(data, 'codegraph.db'), { readOnly: true });
  try {
    const id = db.prepare("SELECT value FROM project_metadata WHERE key='portable:database-id-v1'").get()?.value;
    if (typeof id !== 'string' || !id) throw new Error('Missing portable database identity');
    return id;
  } finally { db.close(); }
}
function operationDirectories(data: string): string[] {
  return fs.readdirSync(path.join(data, '.runtime', 'portable')).filter(name => /^[0-9a-f-]{36}$/.test(name));
}
function publicationIdle(data: string): boolean {
  const db = new DatabaseSync(path.join(data, '.runtime', 'portable', 'gate.sqlite'), { readOnly: true });
  try { const state = db.prepare('SELECT mode,journal FROM state WHERE id=1').get(); return state?.mode === 'idle' && state?.journal === null; }
  catch (error) { if (/locked|busy/i.test(String(error))) return false; throw error; }
  finally { db.close(); }
}
it('normal stdin EOF waits for portable readers and maintenance before exit 0', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-stdio-drain-'));
  const argv = process.execArgv; process.execArgv = ['--liftoff-only'];
  let child: ReturnType<typeof spawn> | undefined;
  let graph: InstanceType<typeof CodeGraph> | undefined;
  try {
    fs.writeFileSync(path.join(root, 'main.c'), 'int shutdown_old_symbol(void) { return 1; }\n');
    graph = await CodeGraph.init(root, { index: true });
    const data = getCodeGraphDir(root), oldIdentity = databaseIdentity(data);
    expect(graph.isPortableStorage()).toBe(true);
    expect(fs.existsSync(path.join(data, 'CURRENT'))).toBe(false);
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
    const currentIdentity = databaseIdentity(data); expect(currentIdentity).not.toBe(oldIdentity);
    graph.close(); await graph.whenIdle(); graph = undefined;
    // The child must have released old native handles for publication to finish.
    // EOF must also finish any current connection maintenance without parent cleanup.
    expect(fs.existsSync(path.join(data, 'codegraph.db'))).toBe(true);
    const after = await query('shutdown_new_symbol');
    expect(after.result.isError, JSON.stringify(after)).toBeFalsy();
    expect(after.result.content.map((item: any) => item.text ?? '').join('\n')).toContain('### shutdown_new_symbol (');
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Graceful exit timeout: ${stderr}`)), 15000);
      child!.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    child.stdin!.end();
    expect(await exited).toEqual({ code: 0, signal: null });
    // No parent-side collection or recovery: child exit certifies its drain.
    expect(operationDirectories(data)).toEqual([]);
    expect(publicationIdle(data)).toBe(true);
    expect(databaseIdentity(data)).toBe(currentIdentity);
    expect(fs.existsSync(path.join(data, 'CURRENT'))).toBe(false);
    expect(stderr).not.toContain('Shutdown drain timed out');
    lines.close();
  } finally {
    if (graph) { graph.close(); await graph.whenIdle(); }
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL'); await new Promise(resolve => child!.once('close', resolve));
    }
    process.execArgv = argv;
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 45000);

it('live stdio MCP automatically retires three background rebuilds with no intervening requests', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-stdio-drain-'));
  const argv = process.execArgv; process.execArgv = ['--liftoff-only'];
  let child: ReturnType<typeof spawn> | undefined;
  let graph: InstanceType<typeof CodeGraph> | undefined;
  try {
    fs.writeFileSync(path.join(root, 'main.c'), 'int shutdown_old_symbol(void) { return 1; }\n');
    graph = await CodeGraph.init(root, { index: true });
    const data = getCodeGraphDir(root), oldIdentity = databaseIdentity(data);
    expect(graph.isPortableStorage()).toBe(true);
    expect(fs.existsSync(path.join(data, 'CURRENT'))).toBe(false);
    graph.close(); await graph.whenIdle(); graph = undefined;
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
    let previousIdentity = oldIdentity;
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
      // Observe persisted state only. Do not invoke a parent facade, recovery or
      // collector that could manufacture the child's automatic retirement result.
      await waitUntil(() => {
        if (!publicationIdle(data)) return false;
        try { return databaseIdentity(data) !== previousIdentity; }
        catch (error) {
          if (/locked|busy|unable to open|ENOENT/i.test(String(error))) return false;
          throw error;
        }
      });
      const nextIdentity = databaseIdentity(data);
      await waitUntil(() => operationDirectories(data).length === 0 && publicationIdle(data));
      expect(nextIdentity).not.toBe(previousIdentity);
      expect(fs.existsSync(path.join(data, 'CURRENT'))).toBe(false);
      previousIdentity = nextIdentity;
      // Deliberately no tools/call: the idle cached/default facades themselves
      // must release each replaced database handle without another request or exit.
    }
    const after = await query('shutdown_new_symbol');
    expect(after.result.isError, JSON.stringify(after)).toBeFalsy();
    expect(after.result.content.map((item: any) => item.text ?? '').join('\n')).toContain('### shutdown_new_symbol (');
    const currentIdentity = previousIdentity;
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Graceful exit timeout: ${stderr}`)), 15000);
      child!.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    child.stdin!.end();
    expect(await exited).toEqual({ code: 0, signal: null });
    // No parent-side collection or recovery: child exit certifies its drain.
    expect(operationDirectories(data)).toEqual([]);
    expect(publicationIdle(data)).toBe(true);
    expect(databaseIdentity(data)).toBe(currentIdentity);
    expect(fs.existsSync(path.join(data, 'CURRENT'))).toBe(false);
    expect(stderr).not.toContain('Shutdown drain timed out');
    lines.close();
  } finally {
    if (graph) { graph.close(); await graph.whenIdle(); }
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL'); await new Promise(resolve => child!.once('close', resolve));
    }
    process.execArgv = argv;
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 45000);
