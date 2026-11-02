/** The built CLI must never unlock a farther project across a nearer boundary. */
import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
const { CodeGraph } = require('../dist') as typeof import('../src');
const { PortableCoordinator } = require('../dist/sync/portable/protocol') as typeof import('../src/sync/portable/protocol');
const { getCodeGraphDir } = require('../dist/directory') as typeof import('../src/directory');

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function initialize(root: string) {
  const graph = CodeGraph.initSync(root);
  graph.close(); await graph.whenIdle();
}
function deadOwnerPid(): number {
  // spawnSync waits/reaps the real short-lived process. No guessed PID and no
  // namespace-dependent hard-coded "dead" owner is used in these lock files.
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { encoding: 'utf8', timeout: 10000 });
  expect(child.status, child.stderr).toBe(0);
  expect(child.pid).toBeGreaterThan(0);
  let code: string | undefined;
  try { process.kill(child.pid, 0); } catch (error) { code = (error as NodeJS.ErrnoException).code; }
  expect(code).toBe('ESRCH');
  return child.pid;
}
function staleLock(root: string, pid: number) {
  const lock = path.join(getCodeGraphDir(root), 'codegraph.lock');
  const contents = `${pid}\nfixture-${path.basename(root)}\n`;
  fs.writeFileSync(lock, contents, { flag: 'wx', mode: 0o600 });
  return { lock, contents };
}
async function fixture(childInitialized = false) {
  vi.stubEnv('CODEGRAPH_DIR', '.codegraph-wx');
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-nested-unlock-')); roots.push(parent);
  const child = path.join(parent, 'nested'), sub = path.join(child, 'sub');
  fs.mkdirSync(sub, { recursive: true });
  await initialize(parent);
  if (childInitialized) await initialize(child);
  else {
    // An interrupted initial build has coordination/runtime state but has not
    // installed an active database. Its root lock is still an unlock boundary.
    new PortableCoordinator(getCodeGraphDir(child));
    expect(fs.existsSync(path.join(getCodeGraphDir(child), 'codegraph.db'))).toBe(false);
  }
  const pid = deadOwnerPid(), parentLock = staleLock(parent, pid);
  return { parent, child, sub, pid, parentLock };
}
function unlock(cwd: string, args: string[]) {
  return spawnSync(process.execPath, ['--liftoff-only', path.resolve(__dirname, '../dist/bin/codegraph.js'), 'unlock', ...args], {
    cwd, encoding: 'utf8', input: '', timeout: 30000,
    env: { ...process.env, CI: '1', CODEGRAPH_ALLOW_UNSAFE_NODE: '1', CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_NO_WATCH: '1' },
  });
}

it('offline unlock from an interrupted nested project removes only its nearest stale lock', async () => {
  const { child, sub, pid, parentLock } = await fixture();
  const childLock = staleLock(child, pid), result = unlock(sub, ['--offline']);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(fs.existsSync(childLock.lock)).toBe(false);
  expect(fs.readFileSync(parentLock.lock, 'utf8')).toBe(parentLock.contents);
}, 40000);

it('without offline confirmation neither nested nor ancestor lock is modified', async () => {
  const { child, sub, pid, parentLock } = await fixture();
  const childLock = staleLock(child, pid), result = unlock(sub, []);
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(result.stdout + result.stderr).toContain('--offline');
  expect(fs.readFileSync(childLock.lock, 'utf8')).toBe(childLock.contents);
  expect(fs.readFileSync(parentLock.lock, 'utf8')).toBe(parentLock.contents);
}, 40000);

it('an initialized nearest project without a lock stops traversal to an ancestor stale lock', async () => {
  const { sub, parentLock } = await fixture(true);
  const result = unlock(sub, ['--offline']);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout + result.stderr).toMatch(/No lock file found/i);
  expect(fs.readFileSync(parentLock.lock, 'utf8')).toBe(parentLock.contents);
}, 40000);

it('an explicit nested start path follows the same nearest initialized boundary', async () => {
  const { parent, child, sub, pid, parentLock } = await fixture(true);
  const childLock = staleLock(child, pid), result = unlock(parent, [sub, '--offline']);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(fs.existsSync(childLock.lock)).toBe(false);
  expect(fs.readFileSync(parentLock.lock, 'utf8')).toBe(parentLock.contents);
}, 40000);
