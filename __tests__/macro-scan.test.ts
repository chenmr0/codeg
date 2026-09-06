import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildMacroContext, scanMacroContribution } from '../src/extraction/macro-scan';
import { scanCppMacroDefinitions, selectUnambiguousCppMacroDefinitions } from '../src/extraction/declaration-macros';
import { decodeNativeMacroRow, rustMacroMode } from '../src/extraction/rust-macros';

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
  it('does not enable the prototype via the existing directory scanner switch', () => {
    vi.stubEnv('CODEGRAPH_RUST_SCAN', '1'); vi.stubEnv('CODEGRAPH_RUST_MACROS', 'auto');
    expect(rustMacroMode()).toBe('off');
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
