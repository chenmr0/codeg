import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { cancelRawEvidenceScans, runRawEvidenceWorker } from '../src/mcp/raw-source-worker-client';
import { formatRawSourceEvidence } from '../src/mcp/raw-source-evidence';
import type { RawEvidenceTask } from '../src/mcp/raw-source-types';

let root: string;
let task: RawEvidenceTask;
const marker = 'RAW_WORKER_EXISTING_MARKER';

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-raw-worker-'));
  const text = `// ${marker}\nint worker_fixture() { return 1; }\n`;
  fs.writeFileSync(path.join(root, 'source.cpp'), text);
  fs.writeFileSync(path.join(root, 'extra.cpp'), text);
  task = {
    projectRoot: root,
    files: [{ path: 'source.cpp', size: Buffer.byteLength(text) }],
    specs: [{ label: marker, needle: marker, path: 'source.cpp', mode: 'identifier' }],
    omittedQueries: 0, timeoutMs: 8000, maxScannedBytes: 512 * 1024 * 1024,
    backend: 'ripgrep',
  };
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('isolated raw-source workers', () => {
  it('preserves a completed scan when the caller thread is blocked beyond the scan budget', async () => {
    let blocked = false;
    const startedAt = performance.now();
    const report = await runRawEvidenceWorker({}, { ...task, timeoutMs: 1000 }, undefined, (progress) => {
      if (!blocked && progress.event === 'start') {
        blocked = true;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1400);
      }
    });
    expect(blocked).toBe(true);
    expect(performance.now() - startedAt).toBeGreaterThan(1400);
    expect(report.backend).toBe('ripgrep');
    expect(report.timeBudgetReached).toBe(false);
    expect(report.totalScannedFiles).toBe(1);
    expect(report.states[0]?.matchingLines).toBe(1);
    expect(formatRawSourceEvidence(report)).not.toContain('INCONCLUSIVE');
  });

  it('still enforces a real worker-side deadline', async () => {
    const report = await runRawEvidenceWorker({}, { ...task, timeoutMs: 0 });
    expect(report.timeBudgetReached).toBe(true);
    expect(report.cancelled).toBe(false);
    expect(formatRawSourceEvidence(report)).toContain('INCONCLUSIVE');
    expect(formatRawSourceEvidence(report)).not.toContain('CONFIRMED_ABSENT');
  });

  it('cancels active scans and reaps every started child before resolving', async () => {
    const controller = new AbortController();
    const pids: number[] = [];
    const report = await runRawEvidenceWorker({}, task, controller.signal, (progress) => {
      if (progress.event === 'start' && progress.pid) {
        pids.push(progress.pid);
        controller.abort();
      }
    });
    expect(pids.length).toBeGreaterThan(0);
    expect(report.cancelled).toBe(true);
    expect(formatRawSourceEvidence(report)).not.toContain('CONFIRMED_ABSENT');
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
  });

  it('removes cancelled queued work without starting a worker, then admits later work', async () => {
    const first = runRawEvidenceWorker({}, task);
    const second = runRawEvidenceWorker({}, task);
    const controller = new AbortController();
    let started = false;
    const queued = runRawEvidenceWorker({}, task, controller.signal, () => { started = true; });
    controller.abort();
    expect((await queued).cancelled).toBe(true);
    expect(started).toBe(false);
    expect((await Promise.all([first, second])).every(report => !report.cancelled)).toBe(true);
    expect((await runRawEvidenceWorker({}, task)).states[0]?.matchingLines).toBe(1);
  });

  it('cancels all active and queued scans owned by a closing project', async () => {
    const owner = {};
    const pending = Array.from({ length: 3 }, () => runRawEvidenceWorker(owner, task));
    cancelRawEvidenceScans(owner);
    expect((await Promise.all(pending)).every(report => report.cancelled)).toBe(true);
  });

  it('returns worker failures explicitly and releases the worker slot', async () => {
    const invalid = { ...task, files: [{ path: null, size: 1 }] } as unknown as RawEvidenceTask;
    await expect(runRawEvidenceWorker({}, invalid)).rejects.toThrow();
    const recovered = await runRawEvidenceWorker({}, { ...task, backend: 'node' });
    expect(recovered.backend).toBe('node');
    expect(recovered.states[0]?.matchingLines).toBe(1);
  });

  it('falls back inside the worker when ripgrep cannot start', async () => {
    const report = await runRawEvidenceWorker({}, { ...task, rgPath: path.join(root, 'missing-rg') });
    expect(report.backend).toBe('node');
    expect(report.states[0]?.matchingLines).toBe(1);
  });

  it('cleans up an active rg when the host exits without waiting for cancellation', async () => {
    // Use the source-mode loader in this standalone host too, so this test
    // does not accidentally validate a stale dist build or require a prebuild.
    const bootstrap = `
      const fs = require('fs');
      const ts = require(${JSON.stringify(require.resolve('typescript'))});
      require.extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
      }).outputText, filename);
      const { runRawEvidenceWorker } = require(${JSON.stringify(path.resolve('src/mcp/raw-source-worker-client.ts'))});
      runRawEvidenceWorker({}, ${JSON.stringify(task)}, undefined, progress => {
        if (progress.event === 'start' && progress.pid) process.send({ pid: progress.pid }, () => process.exit(0));
      }).catch(error => { console.error(error); process.exit(1); });
    `;
    const child = spawn(process.execPath, ['-e', bootstrap], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const pids: number[] = [];
    let stderr = '';
    child.stderr!.on('data', data => { stderr += data; });
    child.on('message', (message: { pid: number }) => pids.push(message.pid));
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('close', resolve);
      child.once('error', reject);
    });
    expect(code, stderr).toBe(0);
    expect(pids.length).toBeGreaterThan(0);
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
  });
});
