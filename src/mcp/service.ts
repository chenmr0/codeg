/** Explicit, opt-in local service control. Never signals a PID from a file. */
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { getCodeGraphDir } from '../directory';
import { resolveDaemonRoot, spawnDetachedDaemon } from './index';
import { decodeLockInfo, getDaemonPidPath, getDaemonSocketPath } from './daemon-paths';
import { isProcessAlive, type DaemonHello } from './daemon';
import { readHelloLine } from './proxy';
import { CodeGraphPackageVersion } from './version';
import { sameProjectPath } from './project-identity';

export interface ServiceStatus {
  running: boolean;
  projectRoot: string;
  pid?: number;
  version?: string;
  mode?: 'persistent' | 'automatic';
  instance?: string;
}

function rootFor(projectPath: string): string {
  const root = resolveDaemonRoot(projectPath, { respectGitBoundary: true });
  if (!root) throw new Error('No initialized CodeGraph project found; run codegraph init first');
  return root;
}

async function probe(root: string): Promise<{ socket: net.Socket; hello: DaemonHello } | null> {
  const endpoint = getDaemonSocketPath(root);
  const socket = net.createConnection(endpoint);
  socket.setEncoding('utf8');
  let connected = false;
  try {
    const hello = await readHelloLine(socket);
    connected = true;
    const lock = decodeLockInfo(fs.readFileSync(getDaemonPidPath(root), 'utf8'));
    const service = hello.service;
    if (hello.protocol !== 1 || hello.codegraph !== CodeGraphPackageVersion ||
        !Number.isSafeInteger(hello.pid) || hello.pid <= 1 ||
        hello.socketPath !== endpoint || !lock || lock.pid !== hello.pid ||
        lock.socketPath !== endpoint || lock.version !== hello.codegraph ||
        service?.version !== 1 || typeof service.instance !== 'string' || !service.instance ||
        typeof service.persistent !== 'boolean' ||
        typeof service.projectRoot !== 'string' || !sameProjectPath(service.projectRoot, root) ||
        typeof service.dataDir !== 'string' || !sameProjectPath(service.dataDir, path.resolve(getCodeGraphDir(root)))) {
      throw new Error('Service identity/version mismatch or older daemon; refusing to manage or attach. Stop it with its original launcher first.');
    }
    return { socket, hello };
  } catch (error) {
    socket.destroy();
    const code = (error as NodeJS.ErrnoException).code;
    if (!connected && (code === 'ENOENT' || code === 'ECONNREFUSED')) return null;
    throw error;
  }
}

function status(root: string, hello: DaemonHello): ServiceStatus {
  return { running: true, projectRoot: root, pid: hello.pid, version: hello.codegraph,
    mode: hello.service!.persistent ? 'persistent' : 'automatic', instance: hello.service!.instance };
}

export async function getServiceStatus(projectPath: string): Promise<ServiceStatus> {
  const root = rootFor(projectPath);
  const result = await probe(root);
  if (!result) return { running: false, projectRoot: root };
  result.socket.destroy();
  return status(root, result.hello);
}

export async function connectService(projectPath: string, requirePersistent = true) {
  const root = rootFor(projectPath);
  const result = await probe(root);
  if (!result) throw new Error('Shared service is not running; use codegraph service start first');
  if (requirePersistent && !result.hello.service!.persistent) {
    result.socket.destroy();
    throw new Error('An automatic daemon is running. Explicitly stop it before starting a persistent service; existing clients will disconnect.');
  }
  return result;
}

export async function startService(projectPath: string): Promise<ServiceStatus> {
  const root = rootFor(projectPath);
  const existing = await probe(root);
  if (existing) {
    existing.socket.destroy();
    if (!existing.hello.service!.persistent) throw new Error('An automatic daemon is already running; explicitly stop it first. Existing clients will disconnect.');
    return status(root, existing.hello);
  }
  // An unreachable live lock is not ours to replace (could be starting or a PID reuse).
  try {
    const lock = decodeLockInfo(fs.readFileSync(getDaemonPidPath(root), 'utf8'));
    if (lock && isProcessAlive(lock.pid)) throw new Error('Daemon lock belongs to a live but unreachable process; refusing to replace it');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  spawnDetachedDaemon(root, true);
  for (let i = 0; i < 240; i++) {
    await new Promise(resolve => setTimeout(resolve, 25));
    const result = await probe(root);
    if (!result) continue;
    result.socket.destroy();
    if (!result.hello.service!.persistent) throw new Error('Another launcher started an automatic daemon; not changing its lifecycle');
    return status(root, result.hello);
  }
  throw new Error('Timed out starting shared service; check service status and daemon.log before retrying');
}

export async function stopService(projectPath: string): Promise<ServiceStatus> {
  const root = rootFor(projectPath);
  const connection = await probe(root);
  if (!connection) return { running: false, projectRoot: root };
  const { socket, hello } = connection;
  // Bind the shutdown to the process on THIS connection, never to a recycled PID.
  await new Promise<void>((resolve, reject) => {
    let buffer = '';
    let acknowledged = false;
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Service shutdown not confirmed; it may still be draining work')); }, 30_000);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      socket.destroy();
      error ? reject(error) : resolve();
    };
    socket.on('error', finish);
    socket.on('data', chunk => {
      buffer += chunk.toString();
      if (buffer.length > 4096) return finish(new Error('Invalid service stop response'));
      if (!buffer.includes('\n')) return;
      try { acknowledged = JSON.parse(buffer.split('\n')[0]!).serviceStopped === hello.service!.instance; }
      catch { return finish(new Error('Invalid service stop response')); }
    });
    socket.on('close', () => finish(acknowledged ? undefined : new Error('Service closed without acknowledging shutdown')));
    socket.write(JSON.stringify({ codegraph_client: 1, pid: process.pid, hostPid: null, serviceStop: hello.service!.instance }) + '\n');
  });
  // ACK means admission closed; wait for graceful engine drain/lock cleanup as well.
  for (let i = 0; i < 300; i++) {
    try {
      const lock = decodeLockInfo(fs.readFileSync(getDaemonPidPath(root), 'utf8'));
      if (!lock || lock.pid !== hello.pid) break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
    if (i === 299) throw new Error('Service acknowledged stop but is still draining; check status before retrying');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return getServiceStatus(root);
}
