import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) {
    const resolved = path.resolve(dir);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) ||
        !path.basename(resolved).startsWith('cg-profile-')) {
      throw new Error('Unexpected profiling fixture directory');
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

describe('optional init profiling preload', () => {
  it('preserves worker messages and captures current-thread work only when enabled', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-profile-'));
    temporary.push(dir);
    const fixture = path.join(dir, 'fixture.cjs');
    fs.writeFileSync(fixture, `
const assert = require('node:assert/strict');
const { Worker, isMainThread, parentPort } = require('node:worker_threads');
if (!isMainThread) {
  parentPort.on('message', message => {
    if (message instanceof Uint8Array) {
      parentPort.postMessage(message);
      return;
    }
    assert.deepEqual(message, { type: 'test', payload: [1, 2, 3] });
    const start = performance.now();
    while (performance.now() - start < 40) {}
    parentPort.postMessage({ type: 'result', payload: message.payload.map(n => n * 2) });
  });
} else {
  const worker = new Worker(__filename);
  worker.once('message', async message => {
    assert.deepEqual(message, { type: 'result', payload: [2, 4, 6] });
    console.log(JSON.stringify(message));
    worker.once('message', async bytes => {
      assert(bytes instanceof Uint8Array);
      assert.deepEqual([...bytes], [7, 8, 9]);
      await worker.terminate();
    });
    const bytes = new Uint8Array([7, 8, 9]);
    worker.postMessage(bytes, [bytes.buffer]);
    assert.equal(bytes.byteLength, 0);
  });
  worker.postMessage({ type: 'test', payload: [1, 2, 3] });
}
`);
    const output = path.join(dir, 'profile.json');
    const preload = path.resolve('scripts/profile-init.cjs');
    const env = { ...process.env };
    delete env.CODEGRAPH_PROFILE_OUTPUT;
    delete env.CODEGRAPH_PROFILE_BUILD;
    const baseline = spawnSync(process.execPath, ['--require', preload, fixture], { env, encoding: 'utf8', timeout: 10_000 });
    expect(baseline.status, baseline.stderr).toBe(0);
    expect(fs.existsSync(output)).toBe(false);
    const measured = spawnSync(process.execPath, ['--require', preload, fixture], {
      env: { ...env, CODEGRAPH_PROFILE_OUTPUT: output, CODEGRAPH_PROFILE_BUILD: dir },
      encoding: 'utf8', timeout: 10_000,
    });
    expect(measured.status, measured.stderr).toBe(0);
    expect(measured.stdout).toBe(baseline.stdout);
    const profile = JSON.parse(fs.readFileSync(output, 'utf8'));
    expect(profile.tasks).toHaveLength(1);
    const task = profile.tasks[0];
    expect(task.end - task.start).toBeGreaterThanOrEqual(35);
    expect(task.sent.type).toBe('test');
    expect(task.received).toBeGreaterThanOrEqual(task.end);
    expect(task.start).toBeGreaterThanOrEqual(task.sent.time);
    if (typeof (process as unknown as { threadCpuUsage?: unknown }).threadCpuUsage === 'function') {
      expect(task.cpuMs).toBeGreaterThanOrEqual(0);
    } else expect(task.cpuMs).toBeNull();
  });
});
