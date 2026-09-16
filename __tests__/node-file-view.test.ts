/**
 * Guarded codegraph_wx_node MCP file mode. Agent calls must request either a
 * structural outline (`symbolsOnly`) or an explicit source window capped at
 * 500 lines. Oversized requests are corrected in-place; bare/full-file reads
 * and mixed symbol/file-window parameters are rejected before source reaches
 * the model.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

describe('codegraph_wx_node guarded MCP file mode', () => {
  let dir: string;
  let cg: CodeGraph;
  let h: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fileview-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(
      path.join(dir, 'src', 'a.ts'),
      'export function helper(x: number) {\n  return x + 1;\n}\nexport class Widget {\n  build() { return helper(1); }\n}\n',
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'b.ts'),
      "import { helper } from './a';\n\n// a comment between symbols\nconst SETTING = 7;\nexport function useHelper() { return helper(2) + SETTING; }\n",
    );
    // A config/data file (#383): its values may be secrets and must never be
    // dumped verbatim by the file-view.
    fs.writeFileSync(
      path.join(dir, 'src', 'application.properties'),
      'spring.datasource.password=SUPERSECRET123\nserver.port=8080\n',
    );
    // A large file: exceeds the file-view line budget, so it must be windowed
    // honestly (not silently truncated).
    fs.writeFileSync(
      path.join(dir, 'src', 'big.ts'),
      'export function big() {\n' +
        Array.from({ length: 2000 }, (_, i) => `  const v${i} = ${i};`).join('\n') +
        '\n  return 0;\n}\n',
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'many.ts'),
      Array.from({ length: 100 }, (_, i) => `export function fn${i}() { return ${i}; }`).join('\n') + '\n',
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'large-class.ts'),
      'export class LargeClass {\n' +
        Array.from({ length: 75 }, (_, i) => `  method${i}() { return ${i}; }`).join('\n') +
        '\n}\n',
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'huge-class.ts'),
      'export class HugeClass {\n' +
        Array.from({ length: 400 }, (_, i) => `  method${i}() { return "${'x'.repeat(40)}-${i}"; }`).join('\n') +
        '\n}\n',
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'signature-noise.cpp'),
      [
        'class Buffer {',
        'public:',
        '  int pos() const;',
        '  int size() const;',
        '  int serialize(char *buf, int &pos);',
        '};',
        '',
      ].join('\n'),
    );
    cg = CodeGraph.initSync(dir, { config: { include: ['**/*.ts', '**/*.cpp', '**/*.properties'], exclude: [] } });
    await cg.indexAll();
    h = new ToolHandler(cg);
  });

  afterEach(() => {
    if (cg) cg.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const text = async (args: Record<string, unknown>): Promise<string> =>
    (await h.execute('node', args)).content.map((c) => c.text).join('\n');

  it('rejects a bare file instead of returning whole-file source', async () => {
    const result = await h.execute('node', { file: 'b.ts' });
    const out = result.content.map((c) => c.text).join('\n');
    expect(result.isError).toBe(true);
    expect(out).toMatch(/rejects bare|symbolsOnly/i);
    expect(out).not.toContain('const SETTING = 7');
  });

  it('returns a bounded source window in Read-compatible numbered form', async () => {
    const out = await text({ file: 'b.ts', offset: 1, limit: 7 });
    // Byte-for-byte Read shape: line 1 is "1<TAB>import …", NOT space-padded.
    expect(out).toMatch(/^1\timport \{ helper \} from '\.\/a';$/m);
    expect(out).toContain('// a comment between symbols'); // inter-symbol gap (Read has it; old reconstruction dropped it)
    expect(out).toContain('const SETTING = 7'); // top-level statement
    expect(out).toContain('useHelper'); // the symbol body too
    expect(out).not.toContain('```'); // Read has no code fence; neither do we
  });

  it('keeps repeated dependency paths out of file-window output', async () => {
    const out = await text({ file: 'a.ts', offset: 1, limit: 7 });
    expect(out).toMatch(/lines 1[–-]7 of 7/i);
    expect(out).not.toMatch(/used by/i);
    expect(out).not.toContain('src/b.ts');
    expect(out).toContain('return x + 1'); // still returns the source
  });

  it('offset/limit narrow the window exactly like Read', async () => {
    const out = await text({ file: 'big.ts', offset: 1000, limit: 3 });
    // Window starts at the requested line, numbered exactly: "1000<TAB>  const v998 = 998;"
    expect(out).toMatch(/^1000\t {2}const v998 = 998;$/m);
    expect(out).not.toMatch(/^1\t/m); // line 1 is NOT shown
    expect(out).toMatch(/lines 1000[–-]1002 of \d+/); // honest pagination note
  });

  it('an offset past EOF is reported, not a crash', async () => {
    const out = await text({ file: 'a.ts', offset: 9999, limit: 10 });
    expect(out).toMatch(/past the end/i);
  });

  it('rejects a partially bounded file window', async () => {
    const onlyOffset = await h.execute('node', { file: 'big.ts', offset: 1 });
    const onlyLimit = await h.execute('node', { file: 'big.ts', limit: 20 });
    expect(onlyOffset.isError).toBe(true);
    expect(onlyLimit.isError).toBe(true);
    expect(onlyOffset.content[0]!.text).toMatch(/both offset and limit/i);
    expect(onlyLimit.content[0]!.text).toMatch(/both offset and limit/i);
  });

  it('auto-clamps file windows over 500 lines instead of requiring a correction call', async () => {
    const result = await h.execute('node', { file: 'big.ts', offset: 1, limit: 545 });
    const out = result.content.map((item) => item.text).join('\n');
    expect(result.isError).not.toBe(true);
    expect(out).toMatch(/Requested 545 lines; safely clamped to 500/i);
    expect(out).toMatch(/^500\t/m);
    expect(out).not.toMatch(/^501\t/m);
  });

  it('does NOT dump a config/data file (yaml/properties) — #383 secret safety', async () => {
    const out = await text({ file: 'application.properties', symbolsOnly: true });
    expect(out).not.toContain('SUPERSECRET123'); // the value never reaches the agent
    expect(out).toMatch(/symbols|indexed/i);
    expect(out).not.toContain('server.port=8080');
  });

  it('symbolsOnly returns the structural map, not the source', async () => {
    const out = await text({ file: 'a.ts', symbolsOnly: true });
    const helper = cg.getNodesByName('helper')[0]!;
    expect(out).toContain('### Symbols');
    expect(out).toContain('helper');
    expect(out).toContain('Widget');
    expect(out).toContain(`:${helper.startLine}-${helper.endLine}`);
    expect(out).not.toContain('return x + 1'); // bodies are NOT included in the map
    expect(out).toMatch(/batch 1[–-]8 precise.*codegraph_wx_node\(targets/i);
    expect(out).not.toMatch(/drop `symbolsOnly`/i);
  });

  it('symbolsOnly reports dependent count without listing dependent paths', async () => {
    const out = await text({ file: 'a.ts', symbolsOnly: true });
    expect(out).toMatch(/used by 1 file/i);
    expect(out).not.toContain('src/b.ts');
  });

  it('caps a large outline and tells the agent to filter instead of reading the file', async () => {
    const out = await text({ file: 'many.ts', symbolsOnly: true });
    expect(out).toContain('fn0');
    expect(out).not.toContain('fn99');
    expect(out).toMatch(/capped at 60 of 100/i);
    expect(out).toMatch(/outlineQuery/i);
    expect(out).toMatch(/do not read the file/i);
  });

  it('returns source for a many-member container and truncates only oversized source', async () => {
    const out = await text({ symbol: 'LargeClass', includeCode: true });
    expect(out).toContain('```typescript');
    expect(out).toContain('export class LargeClass');
    expect(out).toContain('method74()');
    expect(out).not.toMatch(/Members \(/);
    expect(out).not.toMatch(/Source truncated at line/i);

    const huge = await text({ symbol: 'HugeClass', includeCode: true });
    expect(huge).toContain('```typescript');
    expect(huge).toContain('export class HugeClass');
    expect(huge).toMatch(/Source truncated at line/i);
    expect(huge.match(/```/g)).toHaveLength(2);
    expect(huge).not.toMatch(/Members \(/);

    const search = await h.execute('search', {
      query: 'HugeClass',
      includeCode: 'if_unique',
    });
    const searchText = search.content.map((item) => item.text).join('\n');
    expect(searchText).toMatch(/source included and safely truncated/i);
    expect(searchText).toMatch(/Source truncated at line/i);
    expect(searchText).not.toMatch(/structural outline was included/i);
  });

  it('auto-corrects copied file-outline knobs when an exact symbol is supplied', async () => {
    const result = await h.execute('node', {
      symbol: 'LargeClass',
      file: 'large-class.ts',
      symbolsOnly: true,
      outlineQuery: 'method7',
      outlineLimit: 5,
    });
    const out = result.content.map((c) => c.text).join('\n');
    expect(result.isError).not.toBe(true);
    expect(out).toMatch(/Automatically used symbol mode/i);
    expect(out).toMatch(/Members \(75; showing 40\)/);
    expect(out).not.toContain('method74');
  });

  it('filters an outline by leaf symbol name', async () => {
    const out = await text({
      file: 'many.ts',
      symbolsOnly: true,
      outlineQuery: 'fn99',
      outlineLimit: 5,
    });
    expect(out).toContain('fn99');
    expect(out).not.toMatch(/`fn9`/);
    expect(out).toMatch(/1 match outlineQuery="fn99"/i);
  });

  it('does not match outline filters against parameter names in signatures', async () => {
    const out = await text({
      file: 'signature-noise.cpp',
      symbolsOnly: true,
      outlineQuery: 'pos|size',
      outlineLimit: 5,
    });
    expect(out).toContain('Buffer::pos');
    expect(out).toContain('Buffer::size');
    expect(out).not.toContain('Buffer::serialize');
  });

  it('infers symbolsOnly for a file with outline knobs', async () => {
    const result = await h.execute('node', {
      file: 'many.ts',
      outlineQuery: 'fn99',
      outlineLimit: 5,
    });
    const out = result.content[0]!.text;
    expect(result.isError).not.toBe(true);
    expect(out).toMatch(/Automatically inferred `symbolsOnly=true`/i);
    expect(out).toContain('fn99');
    expect(out).not.toContain('return 99');
  });

  it('does not expand a container-name outline query through qualified member names', async () => {
    const out = await text({
      file: 'large-class.ts',
      symbolsOnly: true,
      outlineQuery: 'LargeClass',
      outlineLimit: 50,
    });
    expect(out).toMatch(/1 match outlineQuery="LargeClass"/i);
    expect(out).toContain('LargeClass');
    expect(out).not.toContain('method0');
  });

  it('steers a partial file window away from pagination', async () => {
    const out = await text({ file: 'big.ts', offset: 1, limit: 10 });
    expect(out).toMatch(/do not.*next file window/i);
    expect(out).not.toMatch(/pass `offset`\/`limit` for another range/i);
  });

  it('rejects includeCode in file mode', async () => {
    const result = await h.execute('node', {
      file: 'a.ts',
      includeCode: true,
      offset: 1,
      limit: 5,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/includeCode is only valid in symbol mode/i);
  });

  it('rejects symbol mode mixed with file-window arguments', async () => {
    const result = await h.execute('node', {
      symbol: 'helper',
      file: 'a.ts',
      offset: 1,
      limit: 5,
      includeCode: true,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/symbol mode cannot use offset/i);
    expect(result.content[0]!.text).toContain('Known symbol:');
    expect(result.content[0]!.text).toContain('Unknown symbol in file:');
  });

  it('auto-corrects symbolsOnly mixed with copied source-window fields', async () => {
    const result = await h.execute('node', {
      file: 'a.ts',
      symbolsOnly: true,
      offset: 1,
      limit: 5,
    });
    const out = result.content[0]!.text;
    expect(result.isError).not.toBe(true);
    expect(out).toMatch(/Automatically used `symbolsOnly` outline mode/i);
    expect(out).toContain('### Symbols');
    expect(out).toContain('helper');
    expect(out).not.toContain('return x + 1');
  });

  it('still works as a normal symbol lookup (no regression)', async () => {
    const out = await text({ symbol: 'helper', includeCode: true });
    expect(out).toContain('helper');
    expect(out).toContain('return x + 1');
  });

  it('a miss returns a helpful message, not a crash', async () => {
    const out = await text({ file: 'does-not-exist.ts', symbolsOnly: true });
    expect(out).toMatch(/no indexed file matches/i);
  });
});
