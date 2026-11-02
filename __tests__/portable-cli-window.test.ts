import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
const { CodeGraph } = require('../dist') as typeof import('../src');
const { PortableCoordinator } = require('../dist/sync/portable/protocol') as typeof import('../src/sync/portable/protocol');
const { getCodeGraphDir } = require('../dist/directory') as typeof import('../src/directory');
const { DatabaseSync } = require('node:sqlite');
const directories: string[] = [];
const cli = path.resolve(__dirname, '../dist/bin/codegraph.js');

function run(root: string) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--liftoff-only', cli, 'query', 'window_symbol', '--json', '--path', root], {
      env: { ...process.env, CODEGRAPH_NO_DAEMON: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI query did not terminate')); }, 15000);
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

async function drainingProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cli-window-'));
  directories.push(root);
  fs.writeFileSync(path.join(root, 'main.cpp'), 'int window_symbol() { return 1; }\n');
  const graph = await CodeGraph.init(root, { index: true });
  graph.close(); await graph.whenIdle();
  const coordinator = new PortableCoordinator(getCodeGraphDir(root));
  const writer = coordinator.acquireWriter();
  const gate = new DatabaseSync(path.join(coordinator.runtime, 'gate.sqlite'));
  // Model a live publisher's final drain without a slow rebuild in this test.
  gate.prepare("UPDATE state SET mode='draining' WHERE id=1").run();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    gate.prepare("UPDATE state SET mode='idle' WHERE id=1").run();
    gate.close(); writer.release();
  };
  return { root, release };
}

afterEach(() => {
  for (const root of directories.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('CLI query admission during portable publication', () => {
  it('waits through a short drain and returns real query JSON', async () => {
    const { root, release } = await drainingProject();
    const timer = setTimeout(release, 1200);
    try {
      const result = await run(root);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).some((row: any) => row.node.name === 'window_symbol')).toBe(true);
    } finally { clearTimeout(timer); release(); }
  }, 30000);

  it('fails nonzero rather than reporting empty success after the bounded wait', async () => {
    const { root, release } = await drainingProject();
    try {
      const started = performance.now();
      const result = await run(root);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/draining|busy/i);
      expect(result.stdout).not.toContain('[]');
      expect(performance.now() - started).toBeGreaterThanOrEqual(1900);
    } finally { release(); }
  }, 30000);
});
