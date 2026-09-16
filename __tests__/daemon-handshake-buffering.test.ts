import { afterEach, describe, expect, it } from 'vitest';
import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Daemon } from '../src/mcp/daemon';

describe('daemon handshake message handoff', () => {
  const sockets: net.Socket[] = [];
  let server: net.Server | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.destroy();
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    server = undefined;
    directory = undefined;
  });

  it.each([true, false])('preserves pipelined MCP requests with client hello=%s', async (withHello) => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-handshake-buffering-'));
    const daemon = new Daemon(directory, { idleTimeoutMs: 0, maxIdleMs: 0 });
    // Exercise the production connection/session path without starting the
    // detached process lifecycle or requiring an indexed project for ping.
    server = net.createServer(socket => {
      sockets.push(socket);
      (daemon as unknown as { handleConnection(socket: net.Socket): void }).handleConnection(socket);
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address() as net.AddressInfo;
    const client = net.createConnection(address.port, '127.0.0.1');
    sockets.push(client);
    client.setEncoding('utf8');
    const messages: Array<{ id?: number; codegraph?: string; result?: unknown }> = [];
    let buffer = '';
    let sent = false;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('MCP requests were lost during handshake handoff')), 2_000);
      client.once('error', error => { clearTimeout(timer); reject(error); });
      client.on('data', chunk => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          messages.push(message);
          if (message.codegraph && !sent) {
            sent = true;
            const first = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
              protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: '握手测试', version: '1' },
            } };
            const ping = { jsonrpc: '2.0', id: 2, method: 'ping' };
            const batch = withHello
              ? [{ codegraph_client: 1, pid: process.pid, hostPid: process.pid }, first, ping]
              : [first, ping];
            // One write deliberately places ordinary MCP bytes in the hello
            // reader's tail. Those bytes must survive its listener handoff.
            client.write(batch.map(entry => JSON.stringify(entry)).join('\n') + '\n');
          }
          if (messages.some(entry => entry.id === 1) && messages.some(entry => entry.id === 2)) {
            clearTimeout(timer);
            resolve();
          }
        }
      });
    });
    expect(messages.filter(message => message.id === 1)).toHaveLength(1);
    expect(messages.find(message => message.id === 2)?.result).toEqual({});
  });
});
