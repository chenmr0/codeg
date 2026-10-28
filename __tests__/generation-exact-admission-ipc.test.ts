/** Independent publisher races precisely between an admitted B and its native open. */
import { afterEach, expect, it } from 'vitest';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { fork, type ChildProcess } from 'child_process'; import readline from 'readline';
const moduleRoot = path.resolve(__dirname, '..');
const { CodeGraph } = require('../dist') as typeof import('../src');
const store = require('../dist/sync/generation-store') as typeof import('../src/sync/generation-store');
const roots: string[] = [], peers: Peer[] = [];
class Peer {
  child: ChildProcess; stderr = ''; private next = 1; private events: any[] = [];
  private waiting: Array<{ name: string; resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(root: string, readonly role: 'sdk' | 'mcp' | 'publisher') {
    const env = { ...process.env, NODE_OPTIONS: '', CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_NO_WATCH: '1', CODEGRAPH_MCP_CATCHUP_BUDGET_MS: '10000' };
    delete env.CODEGRAPH_ADAPTIVE_SYNC;
    this.child = fork(path.join(__dirname, 'fixtures/generation-exact-admission-ipc.cjs'), [moduleRoot, root, role],
      { env, execArgv: ['--liftoff-only'], stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    this.child.stderr!.on('data', chunk => { this.stderr += chunk; });
    this.child.on('message', (message: any) => {
      if (message.reply !== undefined) {
        const p = this.pending.get(message.reply); if (!p) return;
        this.pending.delete(message.reply); clearTimeout(p.timer);
        message.error ? p.reject(new Error(message.error.message)) : p.resolve(message.value);
      } else {
        const index = this.waiting.findIndex(p => p.name === message.event);
        if (index < 0) this.events.push(message);
        else { const [p] = this.waiting.splice(index, 1); clearTimeout(p.timer); p.resolve(message); }
      }
    });
    readline.createInterface({ input: this.child.stdout! }).on('line', line => {
      try { const message = JSON.parse(line), p = this.pending.get(message.id); if (!p) return;
        this.pending.delete(message.id); clearTimeout(p.timer); p.resolve(message);
      } catch { /* Only JSON-RPC results use stdout. */ }
    });
    this.child.on('exit', (code, signal) => {
      const error = new Error(`Peer ${role} exited ${code}/${signal}: ${this.stderr}`);
      for (const p of [...this.pending.values(), ...this.waiting]) { clearTimeout(p.timer); p.reject(error); }
      this.pending.clear(); this.waiting = [];
    });
    peers.push(this);
  }
  event(name: string): Promise<any> {
    const index = this.events.findIndex(e => e.event === name);
    if (index >= 0) return Promise.resolve(this.events.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const p = { name, resolve, reject, timer: setTimeout(() => reject(new Error(`Event ${name} timeout: ${this.stderr}`)), 15000) };
      this.waiting.push(p);
    });
  }
  private request(send: (id: number) => void): Promise<any> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Peer request timeout: ${this.stderr}`)); }, 15000);
      this.pending.set(id, { resolve, reject, timer }); send(id);
    });
  }
  call(action: string, args: object = {}): Promise<any> { return this.request(id => this.child.send({ id, action, ...args })); }
  rpc(method: string, params: object): Promise<any> { return this.request(id => this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params })+'\n')); }
  async ready(): Promise<void> {
    await this.event('ready');
    if (this.role === 'mcp') {
      await this.rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'exact-admission-ipc', version: '1' } });
      this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })+'\n');
      // Intentionally NO tool warmup: exercise the very first native cache miss.
    }
  }
  query(query: string): Promise<any> { return this.role === 'mcp' ? this.rpc('tools/call', { name: 'search', arguments: { query, includeCode: 'never' } }) : this.call('query', { query }); }
  async stop(): Promise<void> {
    const exited = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Graceful exit timeout')), 12000);
      this.child.once('exit', (code, signal) => { clearTimeout(timer); code===0 && signal===null ? resolve() : reject(new Error(`Unexpected exit ${code}/${signal}`)); });
    });
    if (this.role === 'mcp') this.child.stdin!.end(); else await this.call('stop');
    await exited;
  }
}
afterEach(async () => {
  for (const root of roots) fs.writeFileSync(path.join(root, '.release-exact-admission'), 'release');
  for (const p of peers.splice(0)) {
    if (p.child.exitCode===null && p.child.signalCode===null) {
      const exited = new Promise(resolve => p.child.once('exit', resolve)); p.child.kill('SIGKILL'); await exited;
    }
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function hit(result: any, role: string, name: string): boolean {
  return role==='sdk' ? result.some((row: any) => row.name===name) :
    !result.error && !result.result?.isError && result.result.content.some((c: any) => c.text?.includes(`### ${name} (`));
}
it.each(['sdk','mcp'] as const)('%s opens exactly admitted B after another process publishes C and attempts GC', async role => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-exact-admission-')); roots.push(root);
  fs.writeFileSync(path.join(root, 'main.c'), 'int generation_B(void) { return 1; }\n');
  const graph = await CodeGraph.init(root, { index: true }), data = graph.getDataDirectory();
  const old = store.resolveGeneration(data); graph.close(); await store.drainGenerationCollections();
  const reader = new Peer(root, role), publisher = new Peer(root, 'publisher');
  await reader.ready(); await publisher.ready();
  fs.writeFileSync(path.join(root, '.arm-exact-admission'), 'arm');
  const query = reader.query('generation_B'); void query.catch(() => {});
  const admitted = await reader.event('admitted-before-open');
  expect(admitted.generation).toBe(old.id);
  // Admission has exited the root gate while retaining its independent B lease.
  let published: any, gate: any, oldWasPresent = false;
  try {
    gate = await publisher.call('probe-gate');
    published = await publisher.call('publish');
    oldWasPresent = fs.existsSync(old.databasePath);
  } finally { fs.writeFileSync(path.join(root, '.release-exact-admission'), 'release'); }
  expect(gate.acquired).toBe(true);
  expect(published.result.adaptive?.strategy).toBe('rebuild'); expect(published.current.id).not.toBe(old.id);
  expect(oldWasPresent).toBe(true);
  const opened = await reader.event('exact-reader-opened');
  expect(opened.databasePath).toBe(old.databasePath); expect(opened.old).toEqual(['generation_B']); expect(opened.fresh).toEqual([]);
  expect(hit(await query, role, 'generation_B')).toBe(true);
  expect(hit(await reader.query('generation_C'), role, 'generation_C')).toBe(true);
  const deadline = Date.now()+6000;
  while (fs.existsSync(path.dirname(old.databasePath))) {
    if (Date.now()>deadline) throw Error('B was not automatically collected after its operation released');
    await new Promise(resolve => setTimeout(resolve,20));
  }
  expect(reader.child.exitCode).toBeNull(); // GC precedes reader/MCP shutdown.
  await reader.stop(); await publisher.stop();
},45000);
