/** Real TCP byte transport exercising production daemon/session/engine code.
 * The product still uses local Unix sockets/named pipes; this diagnostic does
 * not claim that its CLI lifecycle has been verified on restricted runners. */
import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import CodeGraph from '../dist';
import { Daemon } from '../dist/mcp/daemon';

let base: string | undefined, server: net.Server | undefined, daemon: Daemon | undefined;
const sockets: net.Socket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  if (daemon) { const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    try { await daemon.stop('isolated routing test'); } finally { exit.mockRestore(); }
  }
  if (base) fs.rmSync(base, { recursive: true, force: true });
  base = undefined; server = undefined; daemon = undefined; vi.unstubAllEnvs();
});
async function indexed(name: string) {
  const root = path.join(base!, name); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'example.c'), `int ${name}Marker(void) { return 42; }\n`);
  const graph = CodeGraph.initSync(root);
  try { await graph.indexAll(); } finally { await graph.whenIdle(); graph.close(); await graph.whenIdle(); }
  return root;
}
async function connect(strict: boolean, port: number) {
  const socket = net.createConnection(port, '127.0.0.1'); sockets.push(socket); socket.setEncoding('utf8');
  let buffer = ''; const responses = new Map<number, any>();
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.on('data', chunk => {
      buffer += chunk.toString(); let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        if (msg.codegraph) { socket.write(JSON.stringify({ codegraph_client: 1, pid: process.pid, hostPid: null, ...(strict ? { sharedRequired: true } : {}) }) + '\n'); resolve(); }
        if (msg.id !== undefined) responses.set(msg.id, msg);
      }
    });
  });
  return async (id: number, method: string, params: unknown) => {
    socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    const end = Date.now() + 10000;
    while (!responses.has(id)) { if (Date.now() > end) throw new Error('response timeout'); await new Promise(resolve => setTimeout(resolve, 10)); }
    return responses.get(id);
  };
}
it('ordinary and strict sessions on one persistent daemon retain different project policies', async () => {
  vi.stubEnv('CODEGRAPH_NO_WATCH', '1');
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-session-route-'));
  const a = await indexed('alpha'), b = await indexed('beta');
  daemon = new Daemon(a, { persistent: true });
  server = net.createServer(socket => { sockets.push(socket); (daemon as any).handleConnection(socket); });
  await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as net.AddressInfo).port;
  const ordinary = await connect(false, port), strict = await connect(true, port);
  const init = { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'routing-test', version: '1' }, rootUri: pathToFileURL(a).href };
  expect((await ordinary(1, 'initialize', init)).error).toBeUndefined();
  expect((await strict(1, 'initialize', init)).error).toBeUndefined();
  const args = { name: 'search', arguments: { query: 'betaMarker', projectPath: b } };
  const found = await ordinary(2, 'tools/call', args);
  expect(found.error).toBeUndefined(); expect(found.result.isError, JSON.stringify(found.result)).not.toBe(true); expect(JSON.stringify(found.result)).toContain('betaMarker');
  expect((await strict(2, 'tools/call', args)).error.code).toBe(-32602);
  expect(JSON.stringify((await strict(3, 'tools/call', { name: 'search', arguments: { query: 'alphaMarker' } })).result)).toContain('alphaMarker');
}, 30000);
