/** Identity checks must fail closed, independently of local socket permissions. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(), hello: vi.fn(), spawn: vi.fn(), alive: vi.fn(),
  socket: { setEncoding: vi.fn(), destroy: vi.fn() },
  connect: vi.fn(),
}));
vi.mock('fs', () => ({ readFileSync: mocks.readFile }));
vi.mock('net', () => ({ createConnection: mocks.connect }));
vi.mock('../src/mcp/index', () => ({ resolveDaemonRoot: (root: string) => root, spawnDetachedDaemon: mocks.spawn }));
vi.mock('../src/directory', () => ({ getCodeGraphDir: (root: string) => path.join(root, '.codegraph-wx') }));
vi.mock('../src/mcp/daemon', () => ({ isProcessAlive: mocks.alive }));
vi.mock('../src/mcp/proxy', () => ({ readHelloLine: mocks.hello }));
vi.mock('../src/mcp/version', () => ({ CodeGraphPackageVersion: 'test-version' }));
import { connectService, getServiceStatus, startService } from '../src/mcp/service';
import { getDaemonSocketPath } from '../src/mcp/daemon-paths';

const root = path.resolve('service-probe-fixture');
const endpoint = getDaemonSocketPath(root);
function hello() {
  return { protocol: 1, codegraph: 'test-version', pid: 12345, socketPath: endpoint,
    service: { version: 1, instance: 'unique-instance', projectRoot: root,
      dataDir: path.join(root, '.codegraph-wx'), persistent: true } };
}
function errno(code: string) { return Object.assign(new Error(code), { code }); }

beforeEach(() => {
  vi.resetAllMocks();
  mocks.connect.mockReturnValue(mocks.socket);
  mocks.hello.mockResolvedValue(hello());
  mocks.readFile.mockReturnValue(JSON.stringify({ pid: 12345, version: 'test-version', socketPath: endpoint, startedAt: 1 }));
});

describe('shared service identity probe (mock transport)', () => {
  it('accepts a matching persistent daemon without starting another process', async () => {
    expect(await startService(root)).toMatchObject({ running: true, pid: 12345, mode: 'persistent' });
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.socket.destroy).toHaveBeenCalledOnce();
  });

  it('rejects a connected daemon whose PID lock disappeared rather than treating it as absent', async () => {
    mocks.readFile.mockImplementation(() => { throw errno('ENOENT'); });
    await expect(startService(root)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.socket.destroy).toHaveBeenCalledOnce();
  });

  it.each(['ENOENT', 'ECONNREFUSED'])('reports unavailable endpoint %s as not running', async code => {
    mocks.hello.mockRejectedValue(errno(code));
    await expect(getServiceStatus(root)).resolves.toEqual({ running: false, projectRoot: root });
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.socket.destroy).toHaveBeenCalledOnce();
  });

  it.each(['version', 'project', 'dataDir', 'protocol', 'endpoint', 'instance', 'serviceVersion', 'pid'])('rejects %s mismatch and does not launch a replacement', async field => {
    const greeting = hello();
    if (field === 'version') greeting.codegraph = 'other-version';
    if (field === 'project') greeting.service.projectRoot = path.resolve('another-project');
    if (field === 'dataDir') greeting.service.dataDir = path.join(root, '.other');
    if (field === 'protocol') greeting.protocol = 2;
    if (field === 'endpoint') greeting.socketPath += '-other';
    if (field === 'instance') greeting.service.instance = '';
    if (field === 'serviceVersion') greeting.service.version = 2;
    if (field === 'pid') greeting.pid = 1;
    mocks.hello.mockResolvedValue(greeting);
    await expect(startService(root)).rejects.toThrow('identity/version mismatch');
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.socket.destroy).toHaveBeenCalledOnce();
  });

  it.each(['invalid', 'pid', 'version', 'endpoint'])('rejects %s lock identity', async field => {
    const lock = { pid: 12345, version: 'test-version', socketPath: endpoint, startedAt: 1 };
    if (field === 'pid') lock.pid++;
    if (field === 'version') lock.version = 'other';
    if (field === 'endpoint') lock.socketPath += '-other';
    mocks.readFile.mockReturnValue(field === 'invalid' ? '{}' : JSON.stringify(lock));
    await expect(connectService(root)).rejects.toThrow('identity/version mismatch');
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.socket.destroy).toHaveBeenCalledOnce();
  });

  it('refuses automatic daemons for strict clients and persistent start without changing their lifecycle', async () => {
    const greeting = hello(); greeting.service.persistent = false;
    mocks.hello.mockResolvedValue(greeting);
    await expect(connectService(root)).rejects.toThrow('automatic daemon');
    await expect(startService(root)).rejects.toThrow('automatic daemon');
    await expect(getServiceStatus(root)).resolves.toMatchObject({ running: true, mode: 'automatic' });
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.socket.destroy).toHaveBeenCalledTimes(3);
  });

  it('rejects non-boolean persistence metadata', async () => {
    const greeting = hello();
    Object.assign(greeting.service, { persistent: 'false' });
    mocks.hello.mockResolvedValue(greeting);
    await expect(connectService(root)).rejects.toThrow('identity/version mismatch');
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('strict connect never starts a missing service', async () => {
    mocks.hello.mockRejectedValue(errno('ENOENT'));
    await expect(connectService(root)).rejects.toThrow('service is not running');
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('does not hide permission errors as an absent endpoint', async () => {
    mocks.hello.mockRejectedValue(errno('EPERM'));
    await expect(startService(root)).rejects.toMatchObject({ code: 'EPERM' });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
