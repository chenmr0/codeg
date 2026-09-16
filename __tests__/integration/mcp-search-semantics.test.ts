/**
 * codegraph_wx_search defaults to case-sensitive exact lookup with raw evidence.
 * The server environment can opt into case correction, fuzzy suggestions,
 * and owner recovery. No tool parameter selects the search mode.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../../src/index';
import { getStaticTools, ToolHandler } from '../../src/mcp/tools';

describe('codegraph_wx_search semantics — exact by default, fuzzy via environment', () => {
  let tempDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    vi.stubEnv('CODEGRAPH_SEARCH_FUZZY', undefined);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-search-sem-'));
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });

    // Exact-name targets: a top-level `helper` function AND a `helper`
    // method on a class (two distinct nodes sharing the bare name), plus a
    // `helperSync` function that must NOT surface under an exact `helper`
    // search (prefix noise / case-folded lookalike).
    fs.writeFileSync(
      path.join(tempDir, 'src', 'a.ts'),
      `export function helper(): void { return; }\n` +
      `export function helperSync(): void { return; }\n`
    );
    fs.writeFileSync(
      path.join(tempDir, 'src', 'b.ts'),
      `export class Widget {\n` +
      `  helper(): void { return; }\n` +
      `}\n`
    );
    // A fuzzy-fallback target: searching `nonexist` (no exact match) should
    // surface `nonexistThing` with a warning, not an empty result.
    fs.writeFileSync(
      path.join(tempDir, 'src', 'c.ts'),
      `export function nonexistThing(): void { return; }\n` +
      `export function missing_symbol_helper(): void { return; }\n` +
      // A class whose name shares the `helper` prefix (case-folded) — used by
      // the kind-filter test: an exact `helper` search filtered to kind=class
      // has no exact match, so it must fall back to fuzzy and surface this.
      `export class HelperUtils { value = 1; }\n`
    );
    fs.writeFileSync(
      path.join(tempDir, 'src', 'service.h'),
      'class Service { public: int execute(int value); };\n',
    );
    fs.writeFileSync(
      path.join(tempDir, 'src', 'service.cpp'),
      '#include "service.h"\nint Service::execute(int value) { return value + 1; }\n',
    );
    fs.writeFileSync(
      path.join(tempDir, 'src', 'raw_markers.cpp'),
      '// FIRST_RAW_MARKER and SECOND_RAW_MARKER intentionally remain comments.\n',
    );

    cg = await CodeGraph.init(tempDir, {
      config: { include: ['**/*.ts', '**/*.h', '**/*.cpp'], exclude: [] },
    });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (cg) cg.destroy();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('returns every exact-name definition and excludes prefix lookalikes', async () => {
    const result = await handler.execute('search', { query: 'helper' });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;

    // The exact name `helper` (both the function and the method) is present.
    expect(text).toContain('### helper (function)');
    expect(text).toContain('### helper (method)');
    // The prefix lookalike `helperSync` must NOT leak in.
    expect(text).not.toContain('helperSync');
    // An exact hit carries no fuzzy-fallback warning.
    expect(text).not.toMatch(/⚠️ No exact match/);
  });

  it('falls back to fuzzy matches with a warning when no exact match exists', async () => {
    vi.stubEnv('CODEGRAPH_SEARCH_FUZZY', '1');
    const result = await handler.execute('search', { query: 'nonexist' });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;

    // No exact `nonexist`, so the closest fuzzy match surfaces, flagged.
    expect(text).toMatch(/⚠️ No exact match for "nonexist"/);
    expect(text).toContain('nonexistThing');
  });

  it('adds exact raw evidence behind fuzzy results for a distinctive identifier', async () => {
    vi.stubEnv('CODEGRAPH_SEARCH_FUZZY', '1');
    const result = await handler.execute('search', { query: 'missing_symbol' });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toMatch(/⚠️ No exact match for "missing_symbol"/);
    expect(text).toContain('missing_symbol_helper');
    expect(text).toMatch(/No raw-source matches/i);
    expect(text).toContain('CONFIRMED_ABSENT');
  });

  it('strict mode skips the expensive search chain and retains exact raw evidence', async () => {
    const search = vi.spyOn(cg, 'searchNodes');
    const result = await handler.execute('search', { query: 'missing_symbol' });
    expect(result.isError).toBeFalsy();
    expect(search).not.toHaveBeenCalled();
    expect(result.content[0]!.text).toContain('No exact, case-sensitive match');
    expect(result.content[0]!.text).not.toContain('missing_symbol_helper');
    expect(result.content[0]!.text).toContain('CONFIRMED_ABSENT');
  });

  it('strict mode does not correct case or recover an unknown owner', async () => {
    const search = vi.spyOn(cg, 'searchNodes');
    for (const query of ['HelperSync', 'LegacyService::execute']) {
      const result = await handler.execute('search', { query, includeCode: 'if_unique' });
      expect(result.isError).toBeFalsy();
      expect(result.content[0]!.text).toContain('No exact, case-sensitive match');
      expect(result.content[0]!.text).not.toContain('```');
      expect(result.content[0]!.text).not.toContain('Case-insensitive');
    }
    expect(search).not.toHaveBeenCalled();
  });

  it('strict mode preserves unique implementation delivery and signature assertions', async () => {
    const result = await handler.execute('search', {
      query: 'Service::execute', includeCode: 'if_unique',
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain('return value + 1');
    const mismatch = await handler.execute('search', {
      query: 'Service::execute', signature: 'void execute()', includeCode: 'if_unique',
    });
    expect(mismatch.content[0]!.text).toContain('Signature hint did not match');
    expect(mismatch.content[0]!.text).not.toContain('```');
  });

  it('strict mode does not turn a kind or line mismatch into an absence scan', async () => {
    const search = vi.spyOn(cg, 'searchNodes');
    for (const constraints of [{ kind: 'class' }, { line: 1000 }]) {
      const result = await handler.execute('search', { query: 'helper', ...constraints });
      expect(result.isError).toBeFalsy();
      expect(result.content[0]!.text).toContain('satisfy the requested kind/line constraints');
      expect(result.content[0]!.text).not.toContain('HelperUtils');
      expect(result.content[0]!.text).not.toContain('CONFIRMED_ABSENT');
      expect(result.content[0]!.text).not.toMatch(/raw-source/i);
    }
    expect(search).not.toHaveBeenCalled();
  });

  it('inherits strict mode across a batch and shares a single raw scan', async () => {
    const search = vi.spyOn(cg, 'searchNodes');
    const files = vi.spyOn(cg, 'getFiles');
    const result = await handler.execute('search', {
      queries: ['FIRST_RAW_MARKER', { query: 'SECOND_RAW_MARKER' }, { query: 'helperSync', includeCode: 'if_unique' }],
    });
    expect(result.isError).toBeFalsy();
    expect(search).not.toHaveBeenCalled();
    expect(files).toHaveBeenCalledTimes(1);
    expect(result.content[0]!.text).toContain('raw_markers.cpp');
    expect(result.content[0]!.text).toContain('function helperSync');
  });

  it('enables fuzzy matching for single and batch requests only when the environment is 1', async () => {
    const search = vi.spyOn(cg, 'searchNodes');
    for (const setting of [undefined, '', '0', 'false', 'true']) {
      vi.stubEnv('CODEGRAPH_SEARCH_FUZZY', setting);
      const strict = await handler.execute('search', { query: 'nonexist' });
      expect(strict.content[0]!.text).not.toContain('nonexistThing');
    }
    expect(search).not.toHaveBeenCalled();
    vi.stubEnv('CODEGRAPH_SEARCH_FUZZY', '1');
    const fuzzy = await handler.execute('search', { query: 'nonexist' });
    expect(fuzzy.content[0]!.text).toContain('nonexistThing');
    const batch = await handler.execute('search', { queries: ['nonexist', { query: 'HelperSync', includeCode: 'if_unique' }] });
    expect(batch.content[0]!.text).toContain('nonexistThing');
    expect(batch.content[0]!.text).toContain('Case-insensitive unique correction');
    expect(batch.content[0]!.text).toContain('function helperSync');
    expect(search).toHaveBeenCalled();
  });

  it('does not expose search-mode parameters on the tool or batch items', () => {
    const schema = getStaticTools().find(tool => tool.name === 'search')!.inputSchema as any;
    expect(schema.properties).not.toHaveProperty('exact');
    expect(schema.properties).not.toHaveProperty('fuzzy');
    expect(schema.properties.queries.items.properties).not.toHaveProperty('exact');
    expect(schema.properties.queries.items.properties).not.toHaveProperty('fuzzy');
  });

  it('falls back to fuzzy with a warning when the kind filter eliminates the exact match', async () => {
    vi.stubEnv('CODEGRAPH_SEARCH_FUZZY', '1');
    // `helper` exists, but only as a function and a method — not as a class.
    // Filtering kind=class yields no exact match, so it must fall back to
    // fuzzy and surface the class-typed prefix candidate `HelperUtils` with
    // the warning (rather than returning an empty result).
    const result = await handler.execute('search', {
      query: 'helper',
      kind: 'class',
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toMatch(/⚠️ No exact match for "helper"/);
    expect(text).toContain('HelperUtils');
    expect(text).not.toMatch(/raw-source (?:match|scan)/i);
  });

  it('resolves a qualified input exactly and exposes the qualified name', async () => {
    const result = await handler.execute('search', { query: 'Widget.helper' });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toContain('### helper (method)');
    expect(text).toContain('Qualified: `Widget::helper`');
    expect(text).not.toContain('### helper (function)');
    expect(text).not.toMatch(/closest matches/i);
  });

  it('auto-corrects a stray quote in includeCode instead of failing the call', async () => {
    const result = await handler.execute('search', {
      query: 'helperSync',
      includeCode: 'if_unique"',
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toMatch(/Automatically corrected includeCode/i);
    expect(text).toContain('function helperSync');
  });

  it('uses path to disambiguate same-named exact symbols before limiting', async () => {
    const result = await handler.execute('search', {
      query: 'helper',
      path: 'src/b.ts',
      limit: 1,
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toContain('src/b.ts');
    expect(text).not.toContain('src/a.ts');
  });

  it('uses path and line to pin one physical node among repeated qualified names', async () => {
    const queries = (cg as unknown as {
      queries: { insertNode(node: Record<string, unknown>): void };
    }).queries;
    for (let line = 1; line <= 120; line++) {
      queries.insertNode({
        id: `function:mcp-test-f-${line}`,
        kind: 'function',
        name: 'TEST_F',
        qualifiedName: 'tests::TEST_F',
        filePath: 'src/repeated.cpp',
        language: 'cpp',
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: 1,
        updatedAt: Date.now(),
      });
    }

    const result = await handler.execute('search', {
      query: 'tests::TEST_F',
      path: 'src/repeated.cpp',
      line: 119,
      limit: 1,
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toContain('src/repeated.cpp:119');
    expect(text).not.toContain('src/repeated.cpp:118');
  });

  it('does not fuzzy-fallback for an unknown qualified input', async () => {
    const result = await handler.execute('search', { query: 'Foo.bar' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain('No exact, case-sensitive match');
  });

  it('returns one implementation body plus a compact declaration pointer for one exact overload', async () => {
    const result = await handler.execute('search', {
      query: 'Service::execute',
      includeCode: 'if_unique',
    });
    const text = result.content[0]!.text;
    expect(result.isError).toBeFalsy();
    expect(text).toContain('int Service::execute(int value) { return value + 1; }');
    expect(text).toMatch(/Declaration:.*int execute\(int value\).*service\.h:1/i);
    expect(text.match(/```cpp/g)).toHaveLength(1);
    expect(text).toMatch(/implementation source included/i);
  });

  it('expands a qualified declaration hit through its defines edge when the definition name is less qualified', async () => {
    const db = (cg as any).db.getDb();
    db.prepare(
      `UPDATE nodes SET qualified_name = 'execute'
       WHERE name = 'execute' AND file_path = 'src/service.cpp'`,
    ).run();

    const result = await handler.execute('search', {
      query: 'Service::execute',
      includeCode: 'if_unique',
    });
    const text = result.content[0]!.text;
    expect(result.isError).toBeFalsy();
    expect(text).toContain('return value + 1');
    expect(text).toMatch(/Declaration:.*service\.h:1/i);
  });

  it('recovers a wrong qualified owner from exact leaf candidates without raw scanning', async () => {
    vi.stubEnv('CODEGRAPH_SEARCH_FUZZY', '1');
    const result = await handler.execute('search', {
      query: 'LegacyService::execute',
      includeCode: 'if_unique',
    });
    const text = result.content[0]!.text;
    expect(result.isError).toBeFalsy();
    expect(text).toMatch(/Qualified owner mismatch/i);
    expect(text).toContain('Service::execute');
    expect(text).toContain('return value + 1');
    expect(text).not.toMatch(/raw-source (?:match|scan)/i);
  });

  it('does not inline unrelated leaf candidates when the requested owner exists', async () => {
    vi.stubEnv('CODEGRAPH_SEARCH_FUZZY', '1');
    const result = await handler.execute('search', {
      query: 'Widget::execute',
      includeCode: 'if_unique',
    });
    const text = result.content[0]!.text;
    expect(result.isError).toBeFalsy();
    expect(text).toMatch(/Qualified owner mismatch/i);
    expect(text).toMatch(/owner `Widget` is indexed.*no direct member `execute`/i);
    expect(text).not.toContain('return value + 1');
    expect(text).not.toMatch(/Source was not inlined because \d+ logical leaf candidates/i);
  });

  it('deduplicates identical source blocks across batch query sections', async () => {
    vi.stubEnv('CODEGRAPH_SEARCH_FUZZY', '1');
    const result = await handler.execute('search', {
      queries: [
        { query: 'LegacyService::execute', includeCode: 'if_unique' },
        { query: 'Service::execute', includeCode: 'if_unique' },
      ],
    });
    const text = result.content[0]!.text;
    expect(result.isError).toBeFalsy();
    expect(text.match(/return value \+ 1/g)).toHaveLength(1);
    expect(text).toMatch(/identical source already included for `LegacyService::execute`/i);
  });

  it('batches symbol queries and emits one shared multi-pattern raw fallback report', async () => {
    const result = await handler.execute('search', {
      queries: [
        { query: 'helperSync', includeCode: 'if_unique' },
        { query: 'FIRST_RAW_MARKER' },
        { query: 'SECOND_RAW_MARKER' },
      ],
    });
    const text = result.content[0]!.text;
    expect(result.isError).toBeFalsy();
    expect(text).toMatch(/Batch symbol search \(3 queries\)/i);
    expect(text).toContain('function helperSync');
    expect(text.match(/Found 1 raw-source match/g)).toHaveLength(2);
    expect(text).toMatch(/Found 1 raw-source match for `FIRST_RAW_MARKER`/i);
    expect(text).toMatch(/Found 1 raw-source match for `SECOND_RAW_MARKER`/i);
    expect(text).not.toMatch(/server-side|Coverage:|KiB|MiB/i);
  });
});
