import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';
import type { QueryBuilder } from '../src/db/queries';

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

describe('full-index pipeline admission', () => {
  const directories: string[] = [];
  const graphs: CodeGraph[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(fsp.readFile).mockImplementation(fs.promises.readFile);
    for (const cg of graphs.splice(0)) cg.close();
    for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });
  const fixture = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-index-pipeline-'));
    directories.push(dir);
    for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(dir, `${i}.ts`), `export function value_${i}() { return ${i}; }`);
    const cg = CodeGraph.initSync(dir);
    graphs.push(cg);
    return { dir, cg, queries: (cg as unknown as { queries: QueryBuilder }).queries };
  };

  it('stores out-of-order reads in order and continues past a per-file read failure', async () => {
    const { cg, queries } = fixture();
    const original = fs.promises.readFile;
    let release!: () => void, laterRead!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const later = new Promise<void>(resolve => { laterRead = resolve; });
    vi.mocked(fsp.readFile).mockImplementation((async (file: any, options: any) => {
      if (String(file).endsWith(`${path.sep}0.ts`)) await gate;
      if (String(file).endsWith(`${path.sep}1.ts`)) laterRead();
      if (String(file).endsWith(`${path.sep}2.ts`)) throw new Error('simulated read failure');
      return original(file, options);
    }) as typeof fsp.readFile);
    const store = vi.spyOn(queries, 'storeFileBundle');
    const run = cg.indexAll();
    try {
      await Promise.race([later, run]);
      expect(store).not.toHaveBeenCalled();
      release();
      const result = await run;
      expect(result.filesIndexed).toBe(7);
      expect(result.filesErrored).toBe(1);
      expect(result.complete).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({ code: 'read_error', filePath: '2.ts' }));
      expect(store.mock.calls.map(([bundle]) => bundle.file.path)).toEqual(['0.ts', '1.ts', '3.ts', '4.ts', '5.ts', '6.ts', '7.ts']);
    } finally {
      release();
      await run;
    }
  });

  it('honors cancellation from progress before submitting the next write', async () => {
    const { cg, queries } = fixture();
    const abort = new AbortController();
    const store = vi.spyOn(queries, 'storeFileBundle');
    const result = await cg.indexAll({ signal: abort.signal, onProgress: progress => {
      if (progress.phase === 'parsing' && progress.currentFile === '0.ts') abort.abort();
    } });
    expect(result.success).toBe(false);
    expect(result.filesIndexed).toBe(0);
    expect(result.errors).toContainEqual(expect.objectContaining({ message: 'Aborted' }));
    await new Promise(resolve => setImmediate(resolve));
    expect(store).not.toHaveBeenCalled();
  });

  it('propagates a storage failure without consuming later parse results', async () => {
    const { cg, queries } = fixture();
    const write = queries.storeFileBundle.bind(queries);
    const store = vi.spyOn(queries, 'storeFileBundle').mockImplementation(bundle => {
      if (bundle.file.path === '1.ts') throw new Error('simulated disk failure');
      return write(bundle);
    });
    await expect(cg.indexAll()).rejects.toThrow('simulated disk failure');
    await new Promise(resolve => setImmediate(resolve));
    expect(store.mock.calls.map(([bundle]) => bundle.file.path)).toEqual(['0.ts', '1.ts']);
  });
});
