import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { buildMacroContext, scanMacroContribution } from '../src/extraction/macro-scan';
import { scanCppMacroDefinitions, selectUnambiguousCppMacroDefinitions } from '../src/extraction/declaration-macros';
import { AUTO_RUST_MACRO_FILES, decodeNativeMacroRow, rustMacroMode } from '../src/extraction/rust-macros';

describe('macro context baseline and protocol', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-macro-base-')); vi.stubEnv('CODEGRAPH_RUST_MACROS', '0'); });
  afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });
  it('keeps legacy regex quirks rather than mixing semantic fixes into a port', () => {
    const source = '\n/*\n#define GHOST 3\n*/\n#define N /*x\n*/\n#define FN\\\n(x) x\n#define 宏 1\n';
    const actual = scanMacroContribution(source);
    expect(actual.names).toEqual([...source.matchAll(/^\s*#\s*define\s+([A-Za-z_]\w*)/gm)].map(m => m[1]));
    expect(actual.bodyless).toEqual([...source.matchAll(/^\s*#\s*define\s+([A-Za-z_]\w*)(?!\s*\()(?:[ \t]*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/[ \t]*)?)?[ \t]*$/gm)].map(m => m[1]));
    expect(selectUnambiguousCppMacroDefinitions(actual.definitions)).toEqual(selectUnambiguousCppMacroDefinitions(scanCppMacroDefinitions(source)));
  });
  it('preserves ordered conflict handling and observes changes without persistent state', async () => {
    fs.writeFileSync(path.join(root, 'a.h'), '#define X 1\n#define SAFE\n#define SAME 4\n');
    fs.writeFileSync(path.join(root, 'b.h'), '#define X 2\n#define SAME 4\n');
    const first = await buildMacroContext(root, ['a.h', 'b.h', 'missing.h']);
    expect([...first.names]).toEqual(['X', 'SAFE', 'SAME']);
    expect(first.definitions.map(d => d.name)).toEqual(['SAFE', 'SAME']);
    expect(first.metrics.readErrors).toBe(1);
    fs.writeFileSync(path.join(root, 'b.h'), '#define X 1\n');
    expect((await buildMacroContext(root, ['a.h', 'b.h'])).definitions.map(d => d.name)).toEqual(['X', 'SAFE', 'SAME']);
    expect((await buildMacroContext(root, ['b.h'])).definitions.map(d => d.name)).toEqual(['X']);
  });
  it('falls back completely when the independent helper is missing', async () => {
    fs.writeFileSync(path.join(root, 'a.h'), '#define A 1\n');
    vi.stubEnv('CODEGRAPH_RUST_MACROS', '1'); vi.stubEnv('CODEGRAPH_RUST_MACROS_PATH', path.join(root, 'missing.exe'));
    const result = await buildMacroContext(root, ['a.h']);
    expect([...result.names]).toEqual(['A']); expect(result.metrics.mode).toBe('fallback');
    expect(result.metrics.reason).toBe('binary-missing');
  });
  it('keeps TypeScript authoritative when automatic artifact validation is unavailable', async () => {
    fs.writeFileSync(path.join(root, 'auto.h'), '#define AUTO_SAFE 1\n');
    vi.stubEnv('CODEGRAPH_RUST_MACROS', undefined);
    vi.stubEnv('CODEGRAPH_RUST_MACROS_PATH', path.join(root, 'missing-helper'));
    const result = await buildMacroContext(root, Array(AUTO_RUST_MACRO_FILES).fill('auto.h'));
    expect(result.metrics).toMatchObject({ mode: 'ts', reason: 'binary-missing',
      readFiles: AUTO_RUST_MACRO_FILES });
    expect([...result.names]).toEqual(['AUTO_SAFE']);
  });
  it.each(['missing', 'file', 'no-c-family', 'all-ignored'])('rejects %s benchmark input before emitting samples', kind => {
    let target = root;
    if (kind === 'missing') target = path.join(root, 'absent');
    if (kind === 'file') { target = path.join(root, 'file.h'); fs.writeFileSync(target, '#define A 1\n'); }
    if (kind === 'no-c-family') fs.writeFileSync(path.join(root, 'file.py'), 'value = 1\n');
    if (kind === 'all-ignored') {
      fs.writeFileSync(path.join(root, 'file.h'), '#define A 1\n');
      fs.writeFileSync(path.join(root, '.codegraphignore'), '*.h\n');
    }
    const result = spawnSync(process.execPath, [path.resolve('scripts/benchmark-macro-context.mjs'), target, '1'], {
      encoding: 'utf8', windowsHide: true, timeout: 15000,
      env: { ...process.env, CODEGRAPH_RUST_SCAN: '0', GIT_OPTIONAL_LOCKS: '0' },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('"round"');
    expect(result.stderr).toContain(kind === 'missing' ? 'Project directory is unavailable (ENOENT)' :
      kind === 'file' ? 'Project path is not a directory' : 'No C/C++/ObjC candidates');
    expect(result.stderr).not.toContain('Benchmark rejected: disabled');
    expect(fs.existsSync(path.join(root, '.codegraph-wx'))).toBe(false);
  });
  it('uses a bounded automatic threshold independent of the directory scanner switch', () => {
    vi.stubEnv('CODEGRAPH_RUST_SCAN', '1'); vi.stubEnv('CODEGRAPH_RUST_MACROS', 'auto');
    expect(rustMacroMode(AUTO_RUST_MACRO_FILES - 1, 'linux', 'x64')).toBe('off');
    expect(rustMacroMode(AUTO_RUST_MACRO_FILES, 'linux', 'x64')).toBe('auto');
    expect(rustMacroMode(AUTO_RUST_MACRO_FILES, 'win32', 'x64')).toBe('auto');
    expect(rustMacroMode(AUTO_RUST_MACRO_FILES, 'darwin', 'arm64')).toBe('off');
    vi.stubEnv('CODEGRAPH_RUST_MACROS', '0');
    expect(rustMacroMode(AUTO_RUST_MACRO_FILES, 'linux', 'x64')).toBe('off');
    vi.stubEnv('CODEGRAPH_RUST_MACROS', '1'); expect(rustMacroMode()).toBe('on');
    vi.stubEnv('CODEGRAPH_RUST_MACROS', 'verify'); expect(rustMacroMode()).toBe('verify');
  });
  const row = { protocol: 1, path: 'a.h', status: 'ok', reason: 'none', bytes: 1, readMs: 0, scanMs: 0,
    contribution: { names: ['A'], bodyless: [], definitions: [{ name: 'A', parameters: null, replacement: '1' }] } };
  it.each([
    { ...row, path: 'wrong.h' }, { ...row, protocol: 2 }, { ...row, bytes: -1 },
    { ...row, scanMs: NaN }, { ...row, status: 'partial' },
    { ...row, contribution: { ...row.contribution, names: ['bad name'] } },
    { ...row, contribution: { ...row.contribution, definitions: [{ name: 'A', parameters: null, replacement: 'x'.repeat(65537) }] } },
    { ...row, contribution: { ...row.contribution, definitions: [{ name: 'A', parameters: null, replacement: '1', start: 0 }] } },
    { ...row, status: 'fallback' },
  ])('rejects malformed or reordered native responses', value => {
    expect(() => decodeNativeMacroRow(value, 'a.h')).toThrow();
  });
});
