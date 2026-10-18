import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { buildMacroContext, scanMacroContribution } from '../src/extraction/macro-scan';
import { AUTO_RUST_MACRO_FILES, rustMacroBinaryPath, streamRustMacros } from '../src/extraction/rust-macros';

const binary = rustMacroBinaryPath();
const available = fs.existsSync(binary);
if (process.env.CODEGRAPH_RUST_MACROS_EXPECT === '1') it('requires a real helper', () => expect(available).toBe(true));
describe.skipIf(!available)('native macro scanner differential', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-macro-native-')); vi.stubEnv('CODEGRAPH_RUST_MACROS_PATH', binary); });
  afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });
  const compare = async (sources: string[], requireNative = true): Promise<void> => {
    const files = sources.map((source, i) => { const name = `f${i}.h`; fs.writeFileSync(path.join(root, name), source); return name; });
    let used = 0;
    for await (const row of streamRustMacros(root, files)) {
      if (row.status === 'ok') {
        used++; expect(row.contribution, row.path).toEqual(scanMacroContribution(sources[files.indexOf(row.path)]!));
      }
    }
    if (requireNative) expect(used).toBe(sources.length);
    vi.stubEnv('CODEGRAPH_RUST_MACROS', '0'); const ts = await buildMacroContext(root, files);
    vi.stubEnv('CODEGRAPH_RUST_MACROS', '1'); const native = await buildMacroContext(root, files);
    expect(native.metrics.mode, native.metrics.reason).toBe('rust');
    expect([...native.names]).toEqual([...ts.names]); expect([...native.bodyless]).toEqual([...ts.bodyless]);
    expect(native.definitions).toEqual(ts.definitions);
    vi.stubEnv('CODEGRAPH_RUST_MACROS', 'verify'); const verified = await buildMacroContext(root, files);
    expect(verified.metrics.mode, verified.metrics.reason).toBe('verify');
  };
  it('matches data tables, declarations, CRLF, Chinese comments, variadics and broken shapes', async () => {
    await compare([
      '#ifndef GUARD\n#define GUARD\nextern "C" {\n#define TABLE \\\n/*中文😀*/ \\\n{1, 2, 0xff}, \\\n{3, 4},\n}\n#endif\n',
      '#define A 1\r\n#define EMPTY\r\n#define F(x, rest...) x + rest\r\n#define V(...) __VA_ARGS__\r\n',
      '/*\n#define GHOST 1\n*/\n#define N\n(x)\n#define M //note\n#define K /*note*/\n',
      '#pragma thing \\\n#define INSIDE 1\n#define OUTSIDE 2\n',
      '#define FN\\\n(x) x\n#define F(,) 3\n#define F2(x,(y)) y\n#define N_NULL "null"\n',
      Array.from({ length: 100 }, (_, i) => `#define SPEC_${i} \\\n /* CAP_${i} */ \\\n {${'0, '.repeat(1500)}1},\n`).join(''),
      '#define TOO_BIG ' + 'x'.repeat(65537) + '\n#define LIMIT ' + '😀'.repeat(32768) + '\n',
    ]);
  });
  it('defers exotic lexical shapes to the unchanged TS implementation', async () => {
    await compare(['#\ndefine N 1\n', '#define\nN 1\n', '#define N /*start\n*/\n',
      '#define 宏(x) x\n', '#define N\u00a0 1\n', '#define N 1\r#define M 2',
      '#define N /*one*/ /*two*/\n', '\ufeff#define BOM 1\n', '#define A 1\u2028#define B 2\n'], false);
  });
  it('matches deterministic combinations, including directive continuations', async () => {
    let seed = 1987;
    const pick = <T>(values: T[]): T => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return values[seed % values.length]!; };
    const sources = Array.from({ length: 400 }, () => {
      const lines = Array.from({ length: 6 }, () => pick(['', '  ', '/*', '*/', '(x)', '#pragma P \\',
        `${pick(['#define ', '# define ', '\t#define\t'])}${pick(['A', 'ABC', '_N', 'X9'])}${pick(['', ' ', ' 1', '(x) x', ' // c', ' /* c */', ' \\', '() ', '(a, args...) a'])}`]));
      return lines.join(pick(['\n', '\r\n'])) + '\n';
    });
    await compare(sources, false);
  });
  it('handles unreadable, invalid UTF-8 and oversized sources without losing the context', async () => {
    fs.writeFileSync(path.join(root, 'bad.h'), Buffer.from([35, 100, 101, 102, 105, 110, 101, 32, 78, 32, 255]));
    fs.writeFileSync(path.join(root, 'large.h'), '#define A 1\n' + ' '.repeat(8 * 1024 * 1024));
    vi.stubEnv('CODEGRAPH_RUST_MACROS', '1');
    const c = await buildMacroContext(root, ['bad.h', 'large.h', 'missing.h']);
    expect(c.metrics.mode, c.metrics.reason).toBe('rust'); expect(c.metrics.fallbackFiles).toBe(3);
    expect([...c.names]).toEqual(['N', 'A']); expect(c.metrics.readErrors).toBe(1);
  });
  it('automatically uses only a validated helper at the large-context threshold', async () => {
    fs.writeFileSync(path.join(root, 'auto.h'), '#define AUTO_MACRO 1\n');
    vi.stubEnv('CODEGRAPH_RUST_MACROS', undefined);
    const small = await buildMacroContext(root, ['auto.h']);
    expect(small.metrics).toMatchObject({ mode: 'ts', reason: 'disabled' });
    const large = await buildMacroContext(root, Array(AUTO_RUST_MACRO_FILES).fill('auto.h'));
    expect(large.metrics).toMatchObject({ mode: 'rust', reason: 'none', files: AUTO_RUST_MACRO_FILES });
    expect([...large.names]).toEqual(['AUTO_MACRO']);
    expect(large.definitions.map(definition => definition.name)).toEqual(['AUTO_MACRO']);
  });
});
