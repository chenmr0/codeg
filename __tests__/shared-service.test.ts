/** Opt-in persistent service, exercised through the built public CLI and real MCP. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { CodeGraph } from '../src';
import { getCodeGraphDir } from '../src/directory';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');
const env = { ...process.env, CODEGRAPH_NO_WATCH: '1', CODEGRAPH_DAEMON_INTERNAL: '', CODEGRAPH_SERVICE_INTERNAL: '', CODEGRAPH_NO_DAEMON: '', CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '250', CODEGRAPH_DAEMON_MAX_IDLE_MS: '500', CODEGRAPH_PPID_POLL_MS: '100' };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(fn: () => T | undefined | false, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = fn(); if (value) return value as T; await sleep(20); }
  throw new Error('Timed out waiting for service test condition');
}

function command(root: string, args: string[], extra: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: root, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', chunk => out += chunk.toString());
    child.stderr.on('data', chunk => err += chunk.toString());
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`CLI timed out: ${args.join(' ')}\n${out}\n${err}`)); }, 40_000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

interface Client { child: ChildProcessWithoutNullStreams; responses: Map<number, any>; stderr: string; }
function client(root: string, strict = true, extra: NodeJS.ProcessEnv = {}): Client {
  const child = spawn(process.execPath, [BIN, 'serve', '--mcp', '--path', root, ...(strict ? ['--shared-required'] : [])], { cwd: root, env: { ...env, ...extra }, stdio: ['pipe', 'pipe', 'pipe'] });
  const state: Client = { child, responses: new Map(), stderr: '' };
  child.on('error', () => {}); child.stdin.on('error', () => {});
  let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk.toString(); let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { const value = JSON.parse(line); if (typeof value.id === 'number') state.responses.set(value.id, value); } catch { /* stderr only diagnostics are expected */ }
    }
  });
  child.stderr.on('data', chunk => state.stderr += chunk.toString());
  return state;
}
async function request(c: Client, id: number, method: string, params: unknown) {
  c.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return until(() => c.responses.get(id));
}
async function initialize(c: Client, root?: string) {
  return request(c, 1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'shared-test', version: '1' }, ...(root ? { rootUri: pathToFileURL(root).href } : {}) });
}
async function indexedRoot(base: string, name: string) {
  const root = path.join(base, name); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'example.ts'), `export function ${name}Marker() { return 42; }\n`);
  const cg = CodeGraph.initSync(root);
  try { await cg.indexAll(); } finally { cg.close(); }
  return fs.realpathSync(root);
}

// Each test owns and cleans up all its real subprocesses and isolated project roots.
describe('Explicit shared MCP service', () => {
  let base: string;
  let root: string;
  const clients: Client[] = [];
  const roots: string[] = [];
  beforeEach(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-shared-service-'));
    root = await indexedRoot(base, 'alpha'); roots.push(root);
  });
  afterEach(async () => {
    for (const c of clients) if (c.child.exitCode === null) c.child.kill('SIGKILL');
    clients.length = 0;
    for (const r of roots) {
      try { await command(r, ['service', 'stop', '--path', r, '--json']); } catch { /* best effort */ }
      // Fallback only for test-owned actual daemon pids, never our planted live-lock PID.
      try { const record = JSON.parse(fs.readFileSync(path.join(getCodeGraphDir(r), 'daemon.pid'), 'utf8')); if (record.pid !== process.pid) process.kill(record.pid, 'SIGKILL'); } catch { /* gone */ }
    }
    roots.length = 0; await sleep(80); fs.rmSync(base, { recursive: true, force: true });
  });

  it('strict connection fails without starting a daemon or local engine', async () => {
    const result = await command(root, ['serve', '--mcp', '--shared-required', '--path', root]);
    expect(result.code).toBe(1); expect(result.err).toContain('not running');
    expect(fs.existsSync(path.join(getCodeGraphDir(root), 'daemon.pid'))).toBe(false);
    const status = await command(root, ['service', 'status', '--path', root, '--json']);
    expect(status.code).toBe(0); expect(JSON.parse(status.out).running).toBe(false);
  }, 30_000);

  it('two independent clients call tools on one persistent daemon and reconnect after exit', async () => {
    const started = await command(root, ['service', 'start', '--path', root, '--json', '--no-watch']);
    expect(started.code, started.err + started.out).toBe(0);
    const service = JSON.parse(started.out); expect(service.mode).toBe('persistent');
    const again = await command(root, ['service', 'start', '--path', root, '--json']);
    expect(JSON.parse(again.out).pid).toBe(service.pid);
    const a = client(root), b = client(root); clients.push(a, b);
    for (const c of [a, b]) {
      expect((await initialize(c, root)).result.serverInfo.name).toBe('codegraph');
      const result = await request(c, 2, 'tools/call', { name: 'search', arguments: { query: 'alphaMarker' } });
      expect(result.error).toBeUndefined(); expect(result.result.isError).not.toBe(true);
      expect(JSON.stringify(result.result)).toContain('alphaMarker');
    }
    a.child.stdin.end(); await until(() => a.child.exitCode !== null);
    const active = await request(b, 3, 'tools/call', { name: 'status', arguments: {} });
    expect(active.error).toBeUndefined(); expect(active.result.isError).not.toBe(true);
    b.child.stdin.end(); await until(() => b.child.exitCode !== null);
    // Much longer than both supplied automatic idle timeouts, even with zero clients.
    await sleep(900);
    const status = await command(root, ['service', 'status', '--path', root, '--json']);
    expect(JSON.parse(status.out).pid).toBe(service.pid);
    const c = client(root); clients.push(c); await initialize(c);
    expect((await request(c, 4, 'tools/call', { name: 'search', arguments: { query: 'alphaMarker' } })).result.isError).not.toBe(true);
    const stopped = await command(root, ['service', 'stop', '--path', root, '--json']);
    expect(stopped.code, stopped.out + stopped.err).toBe(0); expect(JSON.parse(stopped.out).running).toBe(false);
    await until(() => c.child.exitCode !== null);
    expect((await command(root, ['serve', '--mcp', '--shared-required', '--path', root])).code).toBe(1);
  }, 60_000);

  it('projects have separate daemons and persistent sessions reject cross-project initialization/calls', async () => {
    const beta = await indexedRoot(base, 'beta'); roots.push(beta);
    const aStatus = JSON.parse((await command(root, ['service', 'start', '--path', root, '--json'])).out);
    const bStatus = JSON.parse((await command(beta, ['service', 'start', '--path', beta, '--json'])).out);
    expect(aStatus.pid).not.toBe(bStatus.pid);
    const a = client(root); clients.push(a);
    expect((await initialize(a, beta)).error.code).toBe(-32602);
    expect((await request(a, 2, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' }, rootUri: pathToFileURL(root).href })).result.serverInfo.name).toBe('codegraph');
    expect((await request(a, 3, 'tools/call', { name: 'search', arguments: { query: 'betaMarker', projectPath: beta } })).error.code).toBe(-32602);
    expect(JSON.stringify((await request(a, 4, 'tools/call', { name: 'search', arguments: { query: 'alphaMarker' } })).result)).toContain('alphaMarker');
  }, 60_000);

  it.skipIf(process.platform === 'win32')('canonicalizes symlink paths to the same service', async () => {
    const alias = path.join(base, 'alias'); fs.symlinkSync(root, alias, 'dir');
    const a = await command(root, ['service', 'start', '--path', root, '--json']);
    const b = await command(root, ['service', 'start', '--path', alias, '--json']);
    expect(a.code).toBe(0); expect(b.code).toBe(0); expect(JSON.parse(a.out).pid).toBe(JSON.parse(b.out).pid);
  }, 30_000);

  it('refuses to replace an existing automatic daemon or silently attach strict clients to it', async () => {
    const old = client(root, false, { CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '15000', CODEGRAPH_DAEMON_MAX_IDLE_MS: '15000' }); clients.push(old);
    await initialize(old, root);
    await request(old, 2, 'tools/call', { name: 'status', arguments: {} });
    const status = JSON.parse((await command(root, ['service', 'status', '--path', root, '--json'])).out);
    expect(status.mode).toBe('automatic');
    const start = await command(root, ['service', 'start', '--path', root, '--json']); expect(start.code).toBe(1); expect(start.out).toContain('automatic');
    const strict = await command(root, ['serve', '--mcp', '--shared-required', '--path', root]); expect(strict.code).toBe(1); expect(strict.err).toContain('automatic');
    expect(JSON.parse((await command(root, ['service', 'status', '--path', root, '--json'])).out).pid).toBe(status.pid);
    expect((await request(old, 3, 'tools/call', { name: 'status', arguments: {} })).result.isError).not.toBe(true);
  }, 60_000);

  it('never kills or replaces a live unreachable pidfile holder', async () => {
    const pidfile = path.join(getCodeGraphDir(root), 'daemon.pid');
    fs.writeFileSync(pidfile, JSON.stringify({ pid: process.pid, version: 'unknown', socketPath: 'not-a-socket', startedAt: 1 }));
    const started = await command(root, ['service', 'start', '--path', root, '--json']);
    expect(started.code).toBe(1); expect(started.out).toContain('live but unreachable');
    const stopped = await command(root, ['service', 'stop', '--path', root, '--json']); expect(stopped.code).toBe(0);
    expect(JSON.parse(fs.readFileSync(pidfile, 'utf8')).pid).toBe(process.pid);
  }, 30_000);

  it('recovers a dead lock and validates strict mode flags', async () => {
    fs.writeFileSync(path.join(getCodeGraphDir(root), 'daemon.pid'), JSON.stringify({ pid: 2147483647, version: 'unknown', socketPath: '', startedAt: 1 }));
    const started = await command(root, ['service', 'start', '--path', root, '--json']); expect(started.code, started.out + started.err).toBe(0);
    expect(JSON.parse(started.out).mode).toBe('persistent');
    expect((await command(root, ['serve', '--shared-required', '--path', root])).code).toBe(1);
    expect((await command(root, ['serve', '--mcp', '--shared-required'])).code).toBe(1);
    expect((await command(root, ['serve', '--mcp', '--shared-required', '--path', root], { CODEGRAPH_NO_DAEMON: '1' })).code).toBe(1);
  }, 40_000);

  it('does not stop or query an outer service from an uninitialized nested worktree', async () => {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: root });
    const inner = path.join(root, 'inner');
    execFileSync('git', ['worktree', 'add', '-qb', 'inner', inner], { cwd: root });
    fs.mkdirSync(path.join(root, 'src'));
    const started = await command(root, ['service', 'start', '--path', root, '--json', '--no-watch']);
    expect(started.code, started.out + started.err).toBe(0);
    const original = JSON.parse(started.out);
    const active = client(root); clients.push(active); await initialize(active, root);
    const stopped = await command(root, ['service', 'stop', '--path', inner, '--json']);
    expect(stopped.code).toBe(1); expect(stopped.out).toContain('No initialized CodeGraph');
    const strict = await command(root, ['serve', '--mcp', '--shared-required', '--path', inner]);
    expect(strict.code).toBe(1); expect(strict.err).toContain('No initialized CodeGraph');
    const status = JSON.parse((await command(root, ['service', 'status', '--path', root, '--json'])).out);
    expect(status.pid).toBe(original.pid); expect(status.instance).toBe(original.instance);
    expect(JSON.stringify((await request(active, 2, 'tools/call', { name: 'search', arguments: { query: 'alphaMarker' } })).result)).toContain('alphaMarker');
    const subdir = JSON.parse((await command(root, ['service', 'status', '--path', path.join(root, 'src'), '--json'])).out);
    expect(subdir.pid).toBe(original.pid);
  }, 60_000);

  it('keeps ordinary clients cross-project capable on a persistent daemon while strict clients reject B', async () => {
    const beta = await indexedRoot(base, 'beta'); roots.push(beta);
    const started = await command(root, ['service', 'start', '--path', root, '--json']);
    expect(started.code, started.out + started.err).toBe(0);
    const ordinary = client(root, false), strict = client(root); clients.push(ordinary, strict);
    await initialize(ordinary, root); await initialize(strict, root);
    const args = { name: 'search', arguments: { query: 'betaMarker', projectPath: beta } };
    const result = await request(ordinary, 2, 'tools/call', args);
    expect(result.error).toBeUndefined(); expect(result.result.isError).not.toBe(true);
    expect(JSON.stringify(result.result)).toContain('betaMarker');
    expect((await request(strict, 2, 'tools/call', args)).error.code).toBe(-32602);
  }, 60_000);

  it.skipIf(process.platform !== 'win32')('shares a Windows service across path and rootUri casing', async () => {
    const started = await command(root, ['service', 'start', '--path', root, '--json']);
    expect(started.code, started.out + started.err).toBe(0);
    const uppercase = root.toUpperCase();
    const status = await command(root, ['service', 'status', '--path', uppercase, '--json']);
    expect(status.code).toBe(0); expect(JSON.parse(status.out).pid).toBe(JSON.parse(started.out).pid);
    const c = client(uppercase); clients.push(c);
    expect((await initialize(c, root.toLowerCase())).error).toBeUndefined();
    expect(JSON.stringify((await request(c, 2, 'tools/call', { name: 'search', arguments: { query: 'alphaMarker', projectPath: root.toUpperCase() } })).result)).toContain('alphaMarker');
  }, 60_000);

});
