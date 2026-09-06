import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { streamRustMacros } from '../src/extraction/rust-macros';
import { buildMacroContext } from '../src/extraction/macro-scan';
vi.mock('child_process', () => ({ spawn: vi.fn() }));

describe('bounded macro transport failure recovery', () => {
  let root: string;
  let output: PassThrough;
  let close: (code: number) => void;
  let respond: () => void;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-macro-pipe-'));
    vi.stubEnv('CODEGRAPH_RUST_MACROS', '1'); vi.stubEnv('CODEGRAPH_RUST_MACROS_PATH', process.execPath);
    vi.mocked(spawn).mockImplementation(() => {
      const child = new EventEmitter();
      const input = new PassThrough(); output = new PassThrough();
      let closed = false;
      close = code => { if (closed) return; closed = true; output.end(); queueMicrotask(() => child.emit('close', code)); };
      input.on('finish', () => queueMicrotask(() => respond()));
      return Object.assign(child, { stdin: input, stdout: output, stderr: new PassThrough(),
        kill: () => { close(1); return true; } }) as ReturnType<typeof spawn>;
    });
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
  const row = { protocol: 1, path: 'a.h', status: 'ok', reason: 'none', bytes: 10, readMs: 0, scanMs: 0,
    contribution: { names: ['A'], bodyless: [], definitions: [{ name: 'A', parameters: null, replacement: '中文😀' }] } };
  const collect = async () => { const rows = []; for await (const r of streamRustMacros(root, ['a.h'])) rows.push(r); return rows; };
  it('handles records split inside UTF-8 characters', async () => {
    respond = () => { for (const byte of Buffer.from(JSON.stringify(row) + '\n')) output.write(Buffer.from([byte])); close(0); };
    expect(await collect()).toEqual([row]);
  });
  it.each(['partial', 'missing', 'extra', 'bad-json', 'wrong-order', 'exit-error'])('rejects %s streams', async mode => {
    respond = () => {
      if (mode === 'partial') output.write(JSON.stringify(row));
      else if (mode === 'extra') output.write(JSON.stringify(row) + '\n' + JSON.stringify(row) + '\n');
      else if (mode === 'bad-json') output.write('not-json\n');
      else if (mode === 'wrong-order') output.write(JSON.stringify({ ...row, path: 'b.h' }) + '\n');
      else if (mode === 'exit-error') output.write(JSON.stringify(row) + '\n');
      close(mode === 'exit-error' ? 1 : 0);
    };
    await expect(collect()).rejects.toThrow();
  });
  it('rejects a hung helper on a bounded timer', async () => {
    vi.stubEnv('CODEGRAPH_RUST_MACROS_TIMEOUT_MS', '100'); respond = () => {};
    await expect(collect()).rejects.toThrow('timeout');
  });
  it('rejects invalid UTF-8 rather than indexing replacement characters', async () => {
    respond = () => {
      output.write(Buffer.concat([Buffer.from(JSON.stringify(row).replace('中文😀', 'PLACEHOLDER').split('PLACEHOLDER')[0]!),
        Buffer.from([255]), Buffer.from(JSON.stringify(row).replace('中文😀', 'PLACEHOLDER').split('PLACEHOLDER')[1]! + '\n')]));
      close(0);
    };
    await expect(collect()).rejects.toThrow('response-encoding');
  });
  it('discards already delivered native data before rebuilding a failed context', async () => {
    fs.writeFileSync(path.join(root, 'a.h'), '#define REAL 1\n');
    respond = () => { output.write(JSON.stringify(row) + '\n'); setTimeout(() => close(1), 5); };
    const context = await buildMacroContext(root, ['a.h']);
    expect(context.metrics.mode).toBe('fallback'); expect([...context.names]).toEqual(['REAL']);
    expect(context.definitions.map(d => d.name)).toEqual(['REAL']);
  });
});
