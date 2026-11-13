/** Uses production daemon and proxy over TCP only as a test transport. Build first. */
import { afterEach, expect, it } from 'vitest';
import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { Daemon } from '../dist/mcp/daemon';
let server: net.Server | undefined, root: string | undefined;
const sockets: net.Socket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  if (root) fs.rmSync(root, { recursive: true, force: true });
});
it.each([0, 4100])('strict proxy requires explicit acknowledgement after hello delay %dms', async delay => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-strict-ack-'));
  const daemon = new Daemon(root, { persistent: true, idleTimeoutMs: 0, maxIdleMs: 0 });
  server = net.createServer(s => { sockets.push(s); (daemon as any).handleConnection(s); });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  const script = `const net=require('net');const {readHelloLine,runVerifiedServiceProxy}=require(${JSON.stringify(path.resolve(__dirname, '../dist/mcp/proxy'))});
    (async()=>{const s=net.createConnection(${port},'127.0.0.1');s.setEncoding('utf8');await readHelloLine(s);await new Promise(r=>setTimeout(r,${delay}));await runVerifiedServiceProxy(s)})().catch(e=>{console.error(e.message);process.exit(1)});`;
  const child = spawn(process.execPath, ['-e', script], { env: { ...process.env, CODEGRAPH_PPID_POLL_MS: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  let out = '', err = '';
  child.stdout.on('data', chunk => { out += chunk; if (!delay && out.includes('"id":1')) child.stdin.end(); });
  child.stderr.on('data', chunk => err += chunk);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })+'\n');
  const code = await new Promise<number | null>(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 8500);
    child.on('close', code => { clearTimeout(timer); resolve(code); });
  });
  if (delay) {
    expect(out, 'a strict proxy must not send MCP before daemon confirms strict policy').not.toContain('"id":1');
    expect(code).toBe(1); expect(err).toMatch(/strict.*acknowledg/i);
  } else {
    expect(code, err).toBe(0); expect(out).toContain('"id":1');
    expect(out).not.toContain('codegraph_client_ack');
  }
}, 12000);

it.each(['missing', 'wrong-policy', 'malformed', 'oversized', 'closed'])('rejects %s strict confirmation without forwarding application data', async mode => {
  const { confirmStrictServiceSession } = await import('../dist/mcp/proxy');
  let inbound = '';
  server = net.createServer(s => {
    sockets.push(s); s.setEncoding('utf8');
    s.on('data', chunk => {
      inbound += chunk;
      if (mode === 'wrong-policy') s.write('{"codegraph_client_ack":1,"sharedRequired":false}\n');
      if (mode === 'malformed') s.write('not-json\n');
      if (mode === 'oversized') s.write('x'.repeat(5000));
      if (mode === 'closed') s.end();
    });
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const s = net.createConnection((server.address() as net.AddressInfo).port, '127.0.0.1'); sockets.push(s);
  await expect(confirmStrictServiceSession(s)).rejects.toThrow();
  expect(s.destroyed).toBe(true);
  expect(JSON.parse(inbound.trim())).toMatchObject({ codegraph_client: 1, sharedRequired: true });
  expect(inbound).not.toContain('tools/call');
}, 6000);
