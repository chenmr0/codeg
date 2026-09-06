import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { scanDirectory, scanDirectoryAsync } from '../src/extraction';
import { ScanDiagnostics } from '../src/extraction/sync-diagnostics';
import { decodeRustSnapshot, runRustScan, rustScanMode, automaticRustScanStatus, type RustScanCapture } from '../src/extraction/rust-scan';
import { clearCanonicalCache } from '../src/utils';

vi.mock('../src/extraction/rust-scan', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/extraction/rust-scan')>();
  return { ...actual, runRustScan: vi.fn(actual.runRustScan), automaticRustScanStatus: vi.fn(actual.automaticRustScanStatus) };
});

let dir: string;
let cg: CodeGraph | undefined;
const write = (file: string, text = 'int value;\n') => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};
const response = (paths: string[]) => ({ protocol: 1, ok: true, elapsedMs: 1, reason: '',
  files: paths.map(file => { const stat = fs.statSync(path.join(dir, file));
    return { path: file, size: stat.size, mtimeMs: Math.floor(stat.mtimeMs) }; }),
  counters: { directories: 2, entries: paths.length + 2, metadata: paths.length } });
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rust-scan-'));
  cg = undefined;
  vi.stubEnv('CODEGRAPH_RUST_SCAN', '0');
  vi.stubEnv('CODEGRAPH_HYBRID_SCAN', '0');
  vi.mocked(runRustScan).mockReset();
  vi.mocked(automaticRustScanStatus).mockReset();
  write('.codegraphignore', '/*\n!/src/\n');
  write('src/a.c');
  clearCanonicalCache();
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); clearCanonicalCache();
  cg?.close(); fs.rmSync(dir, { recursive: true, force: true });
});

describe('Rust scan protocol and fail-closed integration', () => {
  it('honors explicit off without launching or inspecting a helper', () => {
    expect(rustScanMode()).toBe('off');
    expect(scanDirectory(dir)).toEqual(['src/a.c']);
    expect(runRustScan).not.toHaveBeenCalled();
    expect(automaticRustScanStatus).not.toHaveBeenCalled();
  });

  it('defaults to auto and uses only an available validated helper', () => {
    vi.stubEnv('CODEGRAPH_RUST_SCAN', undefined);
    expect(rustScanMode()).toBe('auto');
    vi.mocked(automaticRustScanStatus).mockReturnValue({ ready: true, reason: 'none' });
    vi.mocked(runRustScan).mockImplementation(() => decodeRustSnapshot(response(['src/a.c'])));
    const diag = new ScanDiagnostics();
    expect(scanDirectory(dir, undefined, diag)).toEqual(['src/a.c']);
    expect(diag.nativeStatus).toBe('used');
  });

  it.each(['binary-missing', 'binary-unverified', 'binary-checksum', 'unsupported-platform'])(
    'auto falls back without executing a helper on %s', reason => {
      vi.stubEnv('CODEGRAPH_RUST_SCAN', undefined);
      vi.mocked(automaticRustScanStatus).mockReturnValue({ ready: false, reason });
      const diag = new ScanDiagnostics();
      expect(scanDirectory(dir, undefined, diag)).toEqual(['src/a.c']);
      expect(runRustScan).not.toHaveBeenCalled();
      expect(diag).toMatchObject({ nativeStatus: 'fallback', nativeReason: reason });
    });

  it.each(['protocol', 'duplicate', 'traversal', 'absolute', 'data-dir', 'negative-size', 'fractional-time', 'partial', 'bad-count'])
    ('rejects invalid native output: %s', shape => {
      const value: any = response(['src/a.c']);
      if (shape === 'protocol') value.protocol++;
      if (shape === 'duplicate') value.files.push(value.files[0]);
      if (shape === 'traversal') value.files[0].path = '../outside.c';
      if (shape === 'absolute') value.files[0].path = '/outside.c';
      if (shape === 'data-dir') value.files[0].path = '.codegraph-other/secret.c';
      if (shape === 'negative-size') value.files[0].size = -1;
      if (shape === 'fractional-time') value.files[0].mtimeMs += 0.5;
      if (shape === 'partial') value.ok = false;
      if (shape === 'bad-count') value.counters.metadata = 50;
      expect(() => decodeRustSnapshot(value)).toThrow();
    });

  it('captures validated metadata only in on mode', async () => {
    vi.stubEnv('CODEGRAPH_RUST_SCAN', '1');
    vi.mocked(runRustScan).mockImplementation(() => decodeRustSnapshot(response(['src/a.c'])));
    const capture: RustScanCapture = {};
    const diag = new ScanDiagnostics();
    const progress = vi.fn();
    expect(await scanDirectoryAsync(dir, progress, diag, capture)).toEqual(['src/a.c']);
    expect(diag).toMatchObject({ mode: 'rust', nativeStatus: 'used', nativeMetadata: 1 });
    expect(capture.snapshot?.stats.get('src/a.c')?.size).toBe(11);
    expect(progress).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledWith(1, 'src/a.c');
    expect(runRustScan).toHaveBeenCalledWith(expect.objectContaining({
      protocol: 1, rootRules: expect.arrayContaining(['/*\n!/src/\n', '!/src/']),
    }));
  });

  it.each([true, false])('verification keeps JS authoritative when parity=%s', same => {
    vi.stubEnv('CODEGRAPH_RUST_SCAN', 'verify');
    vi.mocked(runRustScan).mockImplementation(() => decodeRustSnapshot(response(same ? ['src/a.c'] : [])));
    const capture: RustScanCapture = {};
    const diag = new ScanDiagnostics();
    expect(scanDirectory(dir, undefined, diag, capture)).toEqual(['src/a.c']);
    expect(diag.nativeStatus).toBe(same ? 'verified' : 'mismatch');
    expect(capture.snapshot).toBeUndefined();
  });

  it('rejects mtime/size disagreement in verification', () => {
    vi.stubEnv('CODEGRAPH_RUST_SCAN', 'verify');
    const value = response(['src/a.c']); value.files[0]!.size++;
    vi.mocked(runRustScan).mockReturnValue(decodeRustSnapshot(value));
    const diag = new ScanDiagnostics();
    expect(scanDirectory(dir, undefined, diag)).toEqual(['src/a.c']);
    expect(diag.nativeStatus).toBe('mismatch');
  });

  it.each(['binary-missing', 'process-failed', 'unsupported-rule', 'symlink'])
    ('falls back on %s without carrying native metadata', reason => {
      vi.stubEnv('CODEGRAPH_RUST_SCAN', '1');
      vi.mocked(runRustScan).mockImplementation(() => { throw new Error(reason); });
      const capture: RustScanCapture = { snapshot: decodeRustSnapshot(response([])) };
      const diag = new ScanDiagnostics();
      expect(scanDirectory(dir, undefined, diag, capture)).toEqual(['src/a.c']);
      expect(diag).toMatchObject({ nativeStatus: 'fallback', nativeReason: reason, mode: 'walk' });
      expect(capture.snapshot).toBeUndefined();
    });

  it('does not swallow progress callback exceptions or invoke callbacks twice', () => {
    vi.stubEnv('CODEGRAPH_RUST_SCAN', '1');
    vi.mocked(runRustScan).mockImplementation(() => decodeRustSnapshot(response(['src/a.c'])));
    const progress = vi.fn(() => { throw new Error('cancel'); });
    expect(() => scanDirectory(dir, progress)).toThrow('cancel');
    expect(progress).toHaveBeenCalledTimes(1);
  });

  it('does not replace a Git-only or hybrid route', () => {
    vi.stubEnv('CODEGRAPH_RUST_SCAN', '1');
    write('.codegraphignore', 'generated/\n');
    const diag = new ScanDiagnostics(); scanDirectory(dir, undefined, diag);
    expect(diag.nativeReason).toBe('requires-walk-negation');
    expect(runRustScan).not.toHaveBeenCalled();
  });

  it('uses snapshot metadata during full no-op sync without changing file records', async () => {
    cg = CodeGraph.initSync(dir); await cg.indexAll();
    const before = cg.getFile('src/a.c');
    vi.stubEnv('CODEGRAPH_RUST_SCAN', '1');
    vi.mocked(runRustScan).mockImplementation(() => decodeRustSnapshot(response(['src/a.c'])));
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await cg.sync({ verbose: true });
    expect(result).toMatchObject({ filesAdded: 0, filesModified: 0, filesRemoved: 0 });
    expect(cg.getFile('src/a.c')).toEqual(before);
    const counts = logs.mock.calls.map(args => String(args[0])).find(line => line.includes('reconcile-counts'))!;
    expect(counts).toContain('existsChecks=0 statChecks=0 statUnchanged=1');
    expect(counts).toContain('snapshotPresence=1 snapshotStats=1');
  });

  it('still reads/hashes changed content and removes confirmed missing files', async () => {
    cg = CodeGraph.initSync(dir); await cg.indexAll();
    write('src/a.c', 'int modified_value;\n'); write('src/b.c', 'int added_value;\n');
    vi.stubEnv('CODEGRAPH_RUST_SCAN', '1');
    vi.mocked(runRustScan).mockImplementation(() => decodeRustSnapshot(response(['src/a.c', 'src/b.c'])));
    expect(await cg.sync()).toMatchObject({ filesModified: 1, filesAdded: 1 });
    expect(cg.getNodesByName('modified_value')).toHaveLength(1);
    fs.unlinkSync(path.join(dir, 'src/a.c'));
    vi.mocked(runRustScan).mockImplementation(() => decodeRustSnapshot(response(['src/b.c'])));
    expect(await cg.sync()).toMatchObject({ filesRemoved: 1 });
    expect(cg.getNodesByName('modified_value')).toHaveLength(0);
  });

  it('does not broaden scoped watcher sync or reuse a previous native snapshot', async () => {
    cg = CodeGraph.initSync(dir); await cg.indexAll();
    write('src/a.c', 'int changed;\n'); write('src/b.c', 'int not_in_scope;\n');
    vi.stubEnv('CODEGRAPH_RUST_SCAN', '1');
    vi.mocked(runRustScan).mockImplementation(() => decodeRustSnapshot(response(['src/a.c', 'src/b.c'])));
    expect(await cg.sync({ paths: ['src/a.c'] })).toMatchObject({ filesChecked: 1, filesModified: 1, filesAdded: 0 });
    expect(cg.getFile('src/b.c')).toBeNull();
  });
});
