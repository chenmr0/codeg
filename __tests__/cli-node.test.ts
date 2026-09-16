/**
 * `codegraph node` CLI command — covers the same two modes as the MCP
 * `codegraph_wx_node` tool (file-view and symbol-view), via the shared
 * `buildNodeView` rendering core in `src/cli/node-view.ts`. Real files + real
 * SQLite (no DB mocking), mirroring `node-file-view.test.ts`'s setup.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { buildNodeView, type NodeViewArgs } from '../src/cli/node-view';

describe('codegraph node (CLI twin of codegraph_wx_node)', () => {
  let dir: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cli-node-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(
      path.join(dir, 'src', 'a.ts'),
      'export function helper(x: number) {\n  return x + 1;\n}\nexport class Widget {\n  build() { return helper(1); }\n}\n',
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'b.ts'),
      "import { helper } from './a';\n\n// a comment between symbols\nconst SETTING = 7;\nexport function useHelper() { return helper(2) + SETTING; }\n",
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'application.properties'),
      'spring.datasource.password=SUPERSECRET123\nserver.port=8080\n',
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'big.ts'),
      'export function big() {\n' +
        Array.from({ length: 2000 }, (_, i) => `  const v${i} = ${i};`).join('\n') +
        '\n  return 0;\n}\n',
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
    cg = CodeGraph.initSync(dir, { config: { include: ['**/*.ts', '**/*.properties'], exclude: [] } });
    await cg.indexAll();
  });

  afterEach(() => {
    if (cg) cg.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const view = (args: NodeViewArgs) => buildNodeView(cg, args);

  // --------------------------------------------------------------------------
  // File mode
  // --------------------------------------------------------------------------

  it('reads a whole file like Read — `<n>\\t<line>` numbering, gaps + imports included', async () => {
    const out = await view({ file: 'b.ts' });
    expect(out.text).toMatch(/^1\timport \{ helper \} from '\.\/a';$/m);
    expect(out.text).toContain('// a comment between symbols');
    expect(out.text).toContain('const SETTING = 7');
    expect(out.text).not.toContain('```');
  });

  it('leads with a one-line blast-radius header', async () => {
    const out = await view({ file: 'a.ts' });
    expect(out.text).toMatch(/used by 1 file: src\/b\.ts/);
    expect(out.text).toContain('return x + 1');
  });

  it('offset/limit narrow the window exactly like Read', async () => {
    const out = await view({ file: 'big.ts', offset: 1000, limit: 3 });
    expect(out.text).toMatch(/^1000\t {2}const v998 = 998;$/m);
    expect(out.text).not.toMatch(/^1\t/m);
    expect(out.text).toMatch(/lines 1000[–-]1002 of \d+/);
  });

  it('an offset past EOF is reported, not a crash', async () => {
    const out = await view({ file: 'a.ts', offset: 9999 });
    expect(out.text).toMatch(/past the end/i);
  });

  it('paginates a large file honestly — explicit window note, never a silent truncate', async () => {
    const out = await view({ file: 'big.ts' });
    expect(out.text).toMatch(/lines 1[–-]\d+ of \d+/);
    expect(out.text).toMatch(/^1\texport function big/m);
  });

  it('does NOT dump a config/data file (properties) — secret safety (#383)', async () => {
    const out = await view({ file: 'application.properties' });
    expect(out.text).not.toContain('SUPERSECRET123');
    expect(out.text.toLowerCase()).toMatch(/values withheld|configuration/);
  });

  it('symbolsOnly returns the structural outline, not the source', async () => {
    const out = await view({ file: 'a.ts', symbolsOnly: true });
    const helper = cg.getNodesByName('helper')[0]!;
    expect(out.text).toContain('helper');
    expect(out.text).toContain('Widget');
    expect(out.text).toContain(`:${helper.startLine}-${helper.endLine}`);
    expect(out.text).not.toContain('return x + 1');
    expect(out.json).toMatchObject({ mode: 'file-symbols' });
    expect((out.json as any).symbols.length).toBeGreaterThan(0);
  });

  it('a file miss returns a helpful message, not a crash', async () => {
    const out = await view({ file: 'does-not-exist.ts' });
    expect(out.text).toMatch(/no indexed file matches/i);
    expect(out.json).toMatchObject({ mode: 'file-not-found' });
  });

  it('--json for file mode yields a structured payload with source + dependents', async () => {
    const out = await view({ file: 'b.ts' });
    const json = out.json as any;
    expect(json.mode).toBe('file');
    expect(json.filePath).toBe('src/b.ts');
    expect(json.totalLines).toBeGreaterThan(0);
    expect(json.source).toContain('useHelper');
    expect(json.dependents).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // Symbol mode
  // --------------------------------------------------------------------------

  it('symbol mode omits relations by default and supports an explicit trail', async () => {
    const defaultOut = await view({ symbol: 'useHelper' });
    const useHelper = cg.getNodesByName('useHelper')[0]!;
    expect(defaultOut.text).toContain('## useHelper');
    expect(defaultOut.text).toContain(
      `**Location:** ${useHelper.filePath}:${useHelper.startLine}-${useHelper.endLine}`,
    );
    expect(defaultOut.text).not.toContain('### Trail');

    const withRelations = await view({ symbol: 'useHelper', includeRelations: true });
    const helper = cg.getNodesByName('helper')[0]!;
    expect(withRelations.text).toMatch(/Calls →.*helper.*src\/a\.ts/);
    expect(withRelations.text).toContain(`${helper.filePath}:${helper.startLine}-${helper.endLine}`);
  });

  it('--code includes the symbol body (numbered like Read)', async () => {
    const out = await view({ symbol: 'helper', includeCode: true, includeRelations: true });
    expect(out.text).toContain('```typescript');
    expect(out.text).toContain('return x + 1');
    const json = out.json as any;
    expect(json.mode).toBe('symbol');
    expect(json.match.code).toContain('return x + 1');
    expect(json.match.callers.length).toBeGreaterThan(0); // Widget.build + useHelper call it
  });

  it('a small container returns exact source with --code', async () => {
    const out = await view({ symbol: 'Widget', includeCode: true });
    expect(out.text).toContain('```typescript');
    expect(out.text).toContain('build() { return helper(1); }');
    expect(out.text).not.toContain('**Members');
    expect(out.json).toMatchObject({ mode: 'symbol', match: { outline: null } });
  });

  it('a many-member container returns source rather than an outline', async () => {
    const out = await view({ symbol: 'LargeClass', includeCode: true });
    expect(out.text).toContain('```typescript');
    expect(out.text).toContain('method74()');
    expect(out.text).not.toContain('**Members');
    expect(out.json).toMatchObject({ mode: 'symbol', match: { outline: null } });
  });

  it('oversized container source is truncated with a closed code block', async () => {
    const out = await view({ symbol: 'HugeClass', includeCode: true });
    expect(out.text).toContain('```typescript');
    expect(out.text).toMatch(/Source truncated at line/i);
    expect(out.text.match(/```/g)).toHaveLength(2);
    expect(out.text).not.toContain('**Members');
  });

  it('same-name overloads are all listed in one call (no --code)', async () => {
    // Two functions named `helper`? Only one here, so use a name with a single
    // hit to exercise the single-match path; add a second helper to force multi.
    fs.writeFileSync(
      path.join(dir, 'src', 'c.ts'),
      'export function helper() { return 42; }\n',
    );
    await cg.sync();
    const out = await view({ symbol: 'helper' });
    // Multiple definitions → lists every complete file:start-end range and hints at --code.
    expect(out.text).toMatch(/definitions named "helper"/);
    expect(out.text).toMatch(/--code/);
    for (const helper of cg.getNodesByName('helper')) {
      expect(out.text).toContain(`${helper.filePath}:${helper.startLine}-${helper.endLine}`);
    }
    expect(out.json).toMatchObject({ mode: 'symbol-multi' });
  });

  it('--file pins an overloaded name to the definition in that file', async () => {
    fs.writeFileSync(
      path.join(dir, 'src', 'c.ts'),
      'export function helper() { return 42; }\n',
    );
    await cg.sync();
    const out = await view({ symbol: 'helper', file: 'c.ts', includeCode: true });
    // Narrowed to the c.ts overload: its body is 42, not x + 1.
    expect(out.text).toContain('return 42');
    expect(out.text).not.toContain('return x + 1');
  });

  it('--line pins a specific overload by nearest start line', async () => {
    fs.writeFileSync(
      path.join(dir, 'src', 'c.ts'),
      '// preamble one\n// preamble two\nexport function helper() { return 42; }\n',
    );
    await cg.sync();
    // a.ts helper starts at line 1; c.ts helper now starts at line 3. Pinning
    // --line to the a.ts start line narrows to a.ts (the only def whose body
    // contains that line), not c.ts.
    const aHelper = cg.getNodesByName('helper').find((n) => n.filePath === 'src/a.ts')!;
    const out = await view({ symbol: 'helper', line: aHelper.startLine, includeCode: true });
    expect(out.text).toContain('return x + 1');
    expect(out.json).toMatchObject({ mode: 'symbol' });
  });

  it('a symbol miss returns a helpful message', async () => {
    const out = await view({ symbol: 'doesNotExist' });
    expect(out.text).toMatch(/not found in the codebase/);
    expect(out.json).toMatchObject({ mode: 'symbol-not-found' });
  });

  it('qualified name (Class.method) resolves to the method', async () => {
    const out = await view({ symbol: 'Widget.build', includeCode: true });
    expect(out.text).toContain('## build');
    expect(out.text).toContain('helper(1)');
  });
});
