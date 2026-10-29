/** Real processes: atomic CURRENT admission, operation leases, and fail-closed corruption. */
import { afterEach, expect, it } from 'vitest';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { fork, type ChildProcess } from 'child_process'; import readline from 'readline';
const moduleRoot = path.resolve(__dirname, '..');
const { CodeGraph } = require('../dist') as typeof import('../src');
const store = require('../dist/sync/generation-store') as typeof import('../src/sync/generation-store');
const roots: string[] = [], children: Peer[] = [], releaseMarkers: string[] = [];
class Peer {
  child: ChildProcess; stderr = ''; private next = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private events: any[] = []; private waits: Array<{ name: string; resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
  private rpcPending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(root: string, readonly role: 'sdk' | 'mcp' | 'publisher' | 'cold') {
    const env = { ...process.env, NODE_OPTIONS: '', CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_NO_WATCH: '1', CODEGRAPH_MCP_CATCHUP_BUDGET_MS: '10000' };
    delete env.CODEGRAPH_ADAPTIVE_SYNC;
    this.child = fork(path.join(__dirname, 'fixtures/generation-admission-ipc.cjs'), [moduleRoot, root, role],
      { env, execArgv: ['--liftoff-only'], stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    this.child.stderr!.on('data', chunk => { this.stderr += chunk; });
    this.child.on('message', (message: any) => {
      if (message.reply !== undefined) {
        const pending = this.pending.get(message.reply); if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(message.reply);
        if (message.error) pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code })); else pending.resolve(message.value);
      } else {
        const index = this.waits.findIndex(wait => wait.name === message.event);
        if (index >= 0) { const [wait] = this.waits.splice(index, 1); clearTimeout(wait.timer); wait.resolve(message); }
        else this.events.push(message);
      }
    });
    readline.createInterface({ input: this.child.stdout! }).on('line', line => {
      try { const message = JSON.parse(line), pending = this.rpcPending.get(message.id); if (!pending) return;
        clearTimeout(pending.timer); this.rpcPending.delete(message.id); pending.resolve(message);
      } catch { /* No test commands share the protocol stdout channel. */ }
    });
    this.child.on('exit', (code, signal) => {
      const error = new Error(`Peer ${role} exited ${code}/${signal}: ${this.stderr}`);
      for (const pending of [...this.pending.values(), ...this.rpcPending.values(), ...this.waits]) { clearTimeout(pending.timer); pending.reject(error); }
      this.pending.clear(); this.rpcPending.clear(); this.waits = [];
    });
    children.push(this);
  }
  event(name: string): Promise<any> {
    const index = this.events.findIndex(event => event.event === name);
    if (index >= 0) return Promise.resolve(this.events.splice(index, 1)[0]);
    return new Promise((resolve, reject) => { const wait = { name, resolve, reject, timer: setTimeout(() => reject(new Error(`IPC ${name} timeout: ${this.stderr}`)), 12000) }; this.waits.push(wait); });
  }
  call(action: string, args: Record<string, unknown> = {}): Promise<any> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`IPC ${action} timeout: ${this.stderr}`)); }, 12000);
      this.pending.set(id, { resolve, reject, timer }); this.child.send({ id, action, ...args });
    });
  }
  rpc(method: string, params: unknown): Promise<any> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.rpcPending.delete(id); reject(new Error(`RPC ${method} timeout: ${this.stderr}`)); }, 12000);
      this.rpcPending.set(id, { resolve, reject, timer });
      this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async ready(): Promise<void> {
    await this.event('ready');
    if (this.role === 'mcp') {
      await this.rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'admission-ipc', version: '1' } });
      this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      await this.query('generation_B'); // Completes ordinary startup catch-up before publication.
    }
  }
  query(query: string): Promise<any> { return this.role === 'mcp' ? this.rpc('tools/call', { name: 'search', arguments: { query, includeCode: 'never' } }) : this.call('query', { query }); }
  async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Graceful peer exit timeout')), 12000);
      this.child.once('exit', (code, signal) => { clearTimeout(timer); code === 0 && signal === null ? resolve() : reject(new Error(`Unexpected exit ${code}/${signal}`)); });
    });
    if (this.role === 'mcp') this.child.stdin!.end(); else await this.call('stop');
    await exited;
  }
}
afterEach(async () => {
  for (const marker of releaseMarkers.splice(0)) fs.writeFileSync(marker, 'release');
  for (const peer of children.splice(0)) {
    if (peer.child.exitCode === null && peer.child.signalCode === null) {
      const exited = new Promise(resolve => peer.child.once('exit', resolve)); peer.child.kill('SIGKILL'); await exited;
    }
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-admission-ipc-')); roots.push(root);
  fs.writeFileSync(path.join(root, 'main.c'), 'int generation_B(void) { return 1; }\n');
  const graph = await CodeGraph.init(root, { index: true });
  const old = store.resolveGeneration(graph.getDataDirectory()), nodeId = graph.searchNodes('generation_B')[0]!.node.id;
  graph.close(); await store.drainGenerationCollections(); return { root, old, nodeId, data: path.join(root, '.codegraph-wx') };
}
function hasHit(result: any, role: string, name: string) {
  if (role === 'sdk') return result.some((item: any) => item.name === name);
  return !result.error && !result.result?.isError && result.result.content.some((item: any) => item.text?.includes(`### ${name} (`));
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 6000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Automatic retirement deadline'); await new Promise(resolve => setTimeout(resolve, 20)); }
}

it.each(['sdk', 'mcp'] as const)('%s resolves CURRENT while the cross-process lifecycle gate is held, never an unleased path', async role => {
  const f = await fixture(), reader = new Peer(f.root, role), publisher = new Peer(f.root, 'publisher');
  await reader.ready(); await publisher.ready();
  const marker = path.join(f.root, '.release-manifest'); releaseMarkers.push(marker);
  await reader.call('arm-manifest', { release: marker });
  const request = reader.query('generation_B');
  await reader.event('manifest-read-under-test');
  const attempt = await publisher.call('probe-gate');
  fs.writeFileSync(marker, 'release'); // Always unblock before assertions or publication.
  expect(attempt.acquired).toBe(false); expect(attempt.elapsed).toBeLessThan(1500);
  expect(hasHit(await request, role, 'generation_B')).toBe(true);
  const published = await publisher.call('publish'); expect(published.result.adaptive?.strategy).toBe('rebuild');
  expect(hasHit(await reader.query('generation_C'), role, 'generation_C')).toBe(true);
  await until(() => !fs.existsSync(path.dirname(f.old.databasePath)));
  await reader.stop(); await publisher.stop();
}, 45000);

it.each(['sdk-getCode', 'sdk-buildContext', 'mcp-getCode', 'sdk-getCode-ownWriter'] as const)('%s pins one public asynchronous operation across publication and releases it at completion', async mode => {
  const role = mode.startsWith('mcp') ? 'mcp' : 'sdk', method = mode.endsWith('buildContext') ? 'buildContext' : 'getCode';
  const f = await fixture(), reader = new Peer(f.root, role), publisher = new Peer(f.root, 'publisher');
  await reader.ready(); await publisher.ready(); await reader.call('arm-context', { method });
  const operation = role === 'mcp'
    ? reader.rpc('tools/call', { name: 'node', arguments: { symbol: 'generation_B', file: 'main.c', includeCode: true, includeRelations: true } })
    : reader.call(method === 'getCode' ? 'get-code' : 'build-context', { nodeId: f.nodeId });
  void operation.catch(() => {}); // Cleanup may terminate a deliberately paused failed test.
  expect((await reader.event('operation-pinned')).before).toEqual({ old: ['generation_B'], fresh: [] });
  const ownWriter = mode.endsWith('ownWriter');
  const published = await (ownWriter ? reader.call('publish-own') : publisher.call('publish'));
  expect(published.result.adaptive?.strategy).toBe('rebuild');
  expect(published.current.id).not.toBe(f.old.id);
  expect(fs.existsSync(f.old.databasePath)).toBe(true);
  expect(hasHit(await reader.query('generation_C'), role, 'generation_C')).toBe(true);
  expect(fs.existsSync(f.old.databasePath)).toBe(true); // The older operation still owns B.
  if (ownWriter) await reader.call('close-facade'); // A closed caller cannot close its in-flight operation.
  await reader.call('resume-context');
  expect((await reader.event('operation-resumed')).after).toEqual({ old: ['generation_B'], fresh: [] });
  const result = await operation;
  if (role === 'mcp') { expect(result.error).toBeUndefined(); expect(result.result.isError).toBeFalsy(); }
  await until(() => !fs.existsSync(path.dirname(f.old.databasePath)));
  if (ownWriter) await expect(reader.query('generation_C')).rejects.toThrow(/closed/);
  else expect(hasHit(await reader.query('generation_C'), role, 'generation_C')).toBe(true);
  await reader.stop(); await publisher.stop();
}, 45000);

it.each(['sdk', 'mcp'] as const)('%s rejects malformed, mismatched, missing, and unsafe CURRENT targets and recovers without fallback', async role => {
  const f = await fixture(), reader = new Peer(f.root, role); await reader.ready();
  const currentPath = path.join(f.data, 'CURRENT'), readyPath = path.join(path.dirname(f.old.databasePath), 'READY.json');
  const current = fs.readFileSync(currentPath, 'utf8'), ready = fs.readFileSync(readyPath, 'utf8');
  const original = JSON.parse(current);
  const mutations = [
    () => fs.writeFileSync(currentPath, '{broken'),
    () => fs.writeFileSync(readyPath, JSON.stringify({ ...JSON.parse(ready), token: '00000000-0000-0000-0000-000000000000' })),
    () => fs.writeFileSync(currentPath, JSON.stringify({ ...original, generation: 'g-missing-target' })),
    () => fs.writeFileSync(currentPath, JSON.stringify({ ...original, generation: '../unsafe-target' })),
  ];
  for (const mutate of mutations) {
    try {
      mutate();
      if (role === 'sdk') await expect(reader.query('generation_B')).rejects.toThrow();
      else { const result = await reader.query('generation_B'); expect(Boolean(result.error || result.result?.isError)).toBe(true); }
    } finally { fs.writeFileSync(currentPath, current); fs.writeFileSync(readyPath, ready); }
    expect(hasHit(await reader.query('generation_B'), role, 'generation_B')).toBe(true);
  }
  await reader.stop();
}, 45000);


it.each(['openSync', 'open', 'isInitialized', 'findNearestCodeGraphRoot', 'validateDirectory', 'createDirectory'])(
  'cold %s protects directory admission with the cross-process gate', async method => {
    const f = await fixture(), reader = new Peer(f.root, 'cold'), publisher = new Peer(f.root, 'publisher');
    await reader.ready(); await publisher.ready();
    const marker = path.join(f.root, '.release-cold-manifest'); releaseMarkers.push(marker);
    await reader.call('arm-manifest', { release: marker });
    const request = reader.call('cold-probe', { method }); void request.catch(() => {});
    await reader.event('manifest-read-under-test');
    const attempt = await publisher.call('probe-gate');
    fs.writeFileSync(marker, 'release');
    expect(attempt.acquired).toBe(false);
    const result = await request;
    if (method.startsWith('open')) expect(result).toContain('generation_B');
    else if (method === 'validateDirectory') expect(result.valid).toBe(true);
    else expect(result).toBeTruthy();
    const published = await publisher.call('publish');
    expect(published.result.adaptive?.strategy).toBe('rebuild');
    await reader.stop(); await publisher.stop();
  }, 45000);

it.each(['openSync', 'open'])('cold %s re-admits CURRENT after its earlier preflight generation is collected', async method => {
  const f = await fixture(), reader = new Peer(f.root, 'cold'), publisher = new Peer(f.root, 'publisher');
  await reader.ready(); await publisher.ready();
  const marker = path.join(f.root, '.release-after-preflight'); releaseMarkers.push(marker);
  await reader.call('arm-after-preflight', { release: marker });
  const request = reader.call('cold-probe', { method }); void request.catch(() => {});
  await reader.event('preflight-complete');
  const published = await publisher.call('publish');
  expect(published.result.adaptive?.strategy).toBe('rebuild');
  await until(() => !fs.existsSync(f.old.databasePath));
  fs.writeFileSync(marker, 'release');
  expect(await request).toEqual(['generation_C']);
  await reader.stop(); await publisher.stop();
}, 45000);

it.each(['openSync', 'open', 'isInitialized', 'findNearestCodeGraphRoot', 'validateDirectory', 'createDirectory'])(
  'cold %s rejects genuine published-state corruption without legacy fallback', async method => {
    const f = await fixture(), reader = new Peer(f.root, 'cold'); await reader.ready();
    const currentPath = path.join(f.data, 'CURRENT'), readyPath = path.join(path.dirname(f.old.databasePath), 'READY.json');
    const current = fs.readFileSync(currentPath, 'utf8'), ready = fs.readFileSync(readyPath, 'utf8');
    const original = JSON.parse(current);
    for (const mutate of [
      () => fs.writeFileSync(currentPath, '{broken'),
      () => fs.writeFileSync(readyPath, JSON.stringify({ ...JSON.parse(ready), token: '00000000-0000-0000-0000-000000000000' })),
      () => fs.writeFileSync(currentPath, JSON.stringify({ ...original, generation: 'g-missing-target' })),
      () => fs.writeFileSync(currentPath, JSON.stringify({ ...original, generation: '../unsafe-target' })),
    ]) {
      try { mutate(); await expect(reader.call('cold-probe', { method })).rejects.toThrow(); }
      finally { fs.writeFileSync(currentPath, current); fs.writeFileSync(readyPath, ready); }
    }
    await expect(reader.call('cold-probe', { method })).resolves.toBeTruthy();
    await reader.stop();
  }, 45000);
