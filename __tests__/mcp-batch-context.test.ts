import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { formatStaleBanner, getStaticTools, ToolHandler } from '../src/mcp/tools';
import { formatRawSourceEvidence, scanRawSourceEvidence } from '../src/mcp/raw-source-evidence';

describe('MCP bounded batch context and literal search', () => {
  let dir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    vi.stubEnv('CODEGRAPH_SEARCH_FUZZY', undefined);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-batch-context-'));
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src', 'flow.ts'),
      [
        'export function helper(x: number) { return x + 1; }',
        'export function first() { return helper(1); }',
        'export function second() { return first(); }',
        'export const TABLE_NAME = "__all_virtual_demo";',
        '// REGISTER_CHANNEL(TABLE_NAME)',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'relations.ts'),
      [
        'export function relationTarget() { return 1; }',
        'export function relationCaller() {',
        '  relationTarget();',
        '  relationTarget();',
        '  return relationTarget();',
        '}',
        '',
      ].join('\n'),
    );
    fs.mkdirSync(path.join(dir, 'src', 'path-near', 'module'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'src', 'path-far'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src', 'path-near', 'module', 'ranked.ts'),
      [
        'export function rankedTarget() { return "near"; }',
        'export function batchRankedTarget() { return "near"; }',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'path-far', 'ranked.ts'),
      [
        'export function rankedTarget() { return "far"; }',
        'export function batchRankedTarget() { return "far"; }',
        '// PathSoftRawOnlySymbol intentionally has no indexed declaration.',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'widget.generated.ts'),
      'export const GENERATED_MARKER = "__all_virtual_demo";\n',
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'raw_gap.ts'),
      '// RAW_ONLY_MISSING_MARKER and SECOND_RAW_GAP are intentionally not AST symbols.\n',
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'raw_scope_target.ts'),
      '// PATH_SCOPED_RAW_MARKER belongs to the requested file.\n',
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'raw_scope_other.ts'),
      '// PATH_SCOPED_RAW_MARKER must not leak through a different file scope.\n',
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'overloads.h'),
      [
        'struct ObDtlLinkedBuffer {};',
        'class ObDtlBasicChannel {',
        'public:',
        '  int push_back_send_list(ObDtlLinkedBuffer *buffer);',
        '  int push_back_send_list();',
        '};',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'overloads.cpp'),
      [
        '#include "overloads.h"',
        'int ObDtlBasicChannel::push_back_send_list() { return 0; }',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'metrics.h'),
      [
        'namespace common { struct ObNewRow {}; struct ObAddr {}; }',
        'struct ObVirtualChannelInfo {};',
        'class TransferMetrics {',
        'public:',
        '  int get_row(ObVirtualChannelInfo &chan_info, common::ObNewRow *&row);',
        '  int make_channel(const common::ObAddr &addr);',
        '};',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'metrics.cpp'),
      [
        '#include "metrics.h"',
        'using common::ObAddr;',
        'using common::ObNewRow;',
        'int TransferMetrics::get_row(ObVirtualChannelInfo &info, ObNewRow *&result) { return 0; }',
        'int TransferMetrics::make_channel(const ObAddr &address) { return 0; }',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'value_types.h'),
      [
        'enum DeliveryMode {',
        '  DELIVERY_DISABLED = -2,',
        '  DELIVERY_BUFFERED = 4, // wire-compatible value',
        '};',
        'struct PointerConfig {',
        '  int64_t *count;',
        '  const char *label;',
        '};',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'named_container.h'),
      [
        'class NamedContainer {',
        'public:',
        '  NamedContainer();',
        '  explicit NamedContainer(int value);',
        '  int run();',
        '};',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'named_container.cpp'),
      [
        '#include "named_container.h"',
        'NamedContainer::NamedContainer() {}',
        'NamedContainer::NamedContainer(int value) {}',
        'int NamedContainer::run() { return 1; }',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'forward_container_fwd.h'),
      'class ForwardContainer;\n',
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'forward_container.h'),
      'class ForwardContainer { public: int run(); };\n',
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'forward_container.cpp'),
      '#include "forward_container.h"\nint ForwardContainer::run() { return 7; }\n',
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'virtual_dispatch.h'),
      [
        'class VirtualBase {',
        'public:',
        '  virtual int attach(int value) = 0;',
        '};',
        'class VirtualDerived : public VirtualBase {',
        'public:',
        '  int attach(int value) override;',
        '};',
        'int invoke_virtual(VirtualBase *channel);',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'virtual_dispatch.cpp'),
      [
        '#include "virtual_dispatch.h"',
        'int VirtualDerived::attach(int value) { return value + 1; }',
        'int invoke_virtual(VirtualBase *channel) { return channel->attach(7); }',
        '',
      ].join('\n'),
    );
    for (const name of ['alpha', 'beta', 'gamma']) {
      fs.writeFileSync(
        path.join(dir, 'src', `wide_${name}.ts`),
        [
          `export function wide_${name}() { return ${name.length}; }`,
          ...Array.from({ length: 149 }, (_, index) => `// ${name}-${index} ${'x'.repeat(120)}`),
          '',
        ].join('\n'),
      );
    }
    fs.writeFileSync(
      path.join(dir, 'src', 'wide_combined.ts'),
      Array.from({ length: 360 }, (_, index) => `// combined-${index} ${'z'.repeat(120)}`).join('\n') + '\n',
    );
    for (const name of ['one', 'two', 'three']) {
      fs.writeFileSync(
        path.join(dir, 'src', `manifest_${name}.ts`),
        [
          `export function manifest_${name}() {`,
          ...Array.from({ length: 110 }, (_, index) => `  // ${name}-${index} ${'m'.repeat(110)}`),
          `  return ${name.length};`,
          '}',
          '',
        ].join('\n'),
      );
    }
    cg = CodeGraph.initSync(dir, {
      config: { include: ['src/**/*.ts', 'src/**/*.h', 'src/**/*.cpp'], exclude: [] },
    });
    await cg.indexAll();
    const db = (cg as any).db.getDb();
    const noArgDefinition = db.prepare(
      `SELECT id FROM nodes
       WHERE name = 'push_back_send_list' AND file_path = 'src/overloads.cpp'`,
    ).get() as { id: string };
    const pointerDeclaration = db.prepare(
      `SELECT id FROM nodes
       WHERE name = 'push_back_send_list' AND file_path = 'src/overloads.h'
         AND signature LIKE '%ObDtlLinkedBuffer%'`,
    ).get() as { id: string };
    const first = db.prepare(
      `SELECT id FROM nodes WHERE name = 'first' AND file_path = 'src/flow.ts'`,
    ).get() as { id: string };
    const second = db.prepare(
      `SELECT id FROM nodes WHERE name = 'second' AND file_path = 'src/flow.ts'`,
    ).get() as { id: string };
    const helper = db.prepare(
      `SELECT id FROM nodes WHERE name = 'helper' AND file_path = 'src/flow.ts'`,
    ).get() as { id: string };
    const insertEdge = db.prepare(
      `INSERT INTO edges (source, target, kind, provenance)
       VALUES (?, ?, 'calls', 'relationship-overload-test')`,
    );
    // Give each overload a distinct caller and callee so an accidental merge
    // is observable even when the language resolver would not connect a
    // declaration-only overload on its own.
    insertEdge.run(first.id, noArgDefinition.id);
    insertEdge.run(noArgDefinition.id, helper.id);
    insertEdge.run(second.id, pointerDeclaration.id);
    insertEdge.run(pointerDeclaration.id, second.id);
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    cg?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const output = async (tool: string, args: Record<string, unknown>) =>
    (await handler.execute(tool, args)).content.map((c) => c.text).join('\n');

  it('publishes the two optimized MCP tools', () => {
    const names = getStaticTools().map((tool) => tool.name);
    expect(names).toContain('context');
    expect(names).toContain('text_search');
    expect(names.some((name) => name.startsWith('codegraph_'))).toBe(false);
  });

  it('scopes a stale warning to only the files it names', () => {
    const banner = formatStaleBanner([
      { path: 'src/stale.cpp', lastSeenMs: Date.now(), indexing: false },
    ]);
    expect(banner).toMatch(/ONLY the files listed above are stale/i);
    expect(banner).toMatch(/Every unlisted file.*fresh/i);
  });

  it('does not claim unlisted files are fresh while startup catch-up is unfinished', () => {
    const banner = formatStaleBanner([
      { path: 'src/stale.cpp', lastSeenMs: Date.now(), indexing: true },
    ], true);
    expect(banner).toMatch(/watcher-confirmed stale files/i);
    expect(banner).toMatch(/additional recently changed files may be stale/i);
    expect(banner).not.toMatch(/Every unlisted file.*fresh/i);
  });

  it('returns several exact symbol bodies in one call without repetitive trails', async () => {
    const out = await output('context', {
      targets: [
        { symbol: 'first', file: 'flow.ts' },
        { symbol: 'second', file: 'flow.ts' },
      ],
    });
    expect(out).toContain('return helper(1)');
    expect(out).toContain('return first()');
    expect(out).not.toContain('### Trail');
    expect(out).toMatch(/Exact symbols and merged file ranges are included above/i);
  });

  it('accepts native node targets and routes them through one merged implementation bundle', async () => {
    const out = await output('node', {
      targets: [
        { symbol: 'first', file: 'flow.ts' },
        { symbol: 'second', file: 'flow.ts' },
      ],
      includeRelations: false,
    });
    expect(out).toMatch(/Native codegraph_node batch mode/i);
    expect(out).toContain('return helper(1)');
    expect(out).toContain('return first()');
    expect(out).not.toContain('### Trail');

    const manifest = await output('node', {
      targets: [{ file: 'src/metrics.cpp', symbols: ['get_row', 'make_channel'] }],
      expand: 'declaration_definition',
      expectedMissing: ['send_bytes_'],
    });
    expect(manifest).toMatch(/Native codegraph_node batch mode/i);
    expect(manifest).toContain('src/metrics.cpp');
    expect(manifest).toContain('src/metrics.h');
    expect(manifest).toContain('expected-new: send_bytes_');
    expect(manifest).toContain('CONFIRMED_ABSENT');

    const mixed = await handler.execute('node', {
      targets: [{ symbol: 'first' }],
      symbol: 'second',
    });
    expect(mixed.isError).toBe(true);
    expect(mixed.content[0]?.text).toMatch(/cannot combine targets with top-level symbol/i);

    const batchOnly = await handler.execute('node', {
      symbol: 'first',
      expectedMissing: ['send_bytes_'],
    });
    expect(batchOnly.isError).toBe(true);
    expect(batchOnly.content[0]?.text).toMatch(/expectedMissing are batch-only/i);
  });

  it('renders a deterministic file-scoped symbol manifest and expands declaration-definition partners', async () => {
    const out = await output('context', {
      targets: [{
        file: 'src/metrics.cpp',
        symbols: ['get_row', 'make_channel'],
      }],
      expand: 'declaration_definition',
    });
    expect(out).toMatch(/Manifest-driven implementation context/i);
    expect(out).toContain('src/metrics.cpp');
    expect(out).toContain('src/metrics.h');
    expect(out).toContain('TransferMetrics::get_row');
    expect(out).toContain('TransferMetrics::make_channel');
  });

  it('groups several literal edit anchors in one manifest file target', async () => {
    const out = await output('context', {
      targets: [{
        file: 'src/flow.ts',
        texts: ['TABLE_NAME', 'REGISTER_CHANNEL'],
        contextLines: 0,
      }],
    });
    expect(out).toMatch(/Manifest-driven implementation context/i);
    expect(out).toContain('4\texport const TABLE_NAME');
    expect(out).toContain('5\t// REGISTER_CHANNEL');
  });

  it('returns complete manifest sections plus omitted labels instead of an empty over-budget preflight', async () => {
    const out = await output('context', {
      targets: [
        { file: 'src/manifest_one.ts', symbols: ['manifest_one'] },
        { file: 'src/manifest_two.ts', symbols: ['manifest_two'] },
        { file: 'src/manifest_three.ts', symbols: ['manifest_three'] },
      ],
    });
    expect(out).toMatch(/Manifest-driven implementation context/i);
    expect(out).toContain('export function manifest_one');
    expect(out).toMatch(/Complete sections omitted by output budget/i);
    expect(out).not.toMatch(/Context preflight.*source not emitted/i);
  });

  it('verifies expected-new identifiers without using them for target discovery', async () => {
    const out = await output('context', {
      targets: [{ symbol: 'first', file: 'flow.ts' }],
      expectedMissing: ['send_bytes_'],
    });
    expect(out).toMatch(/Manifest-driven implementation context/i);
    expect(out).toContain('expected-new: send_bytes_');
    expect(out).toContain('CONFIRMED_ABSENT');
    expect(out).toMatch(/do not rerun Grep/i);
  });

  it('batch-verifies unresolved manifest symbols against current source', async () => {
    const out = await output('context', {
      targets: [{
        file: 'src/raw_gap.ts',
        symbols: ['RAW_ONLY_MISSING_MARKER', 'ActuallyAbsentManifestSymbol'],
      }],
    });
    expect(out).toContain('RAW_ONLY_MISSING_MARKER');
    expect(out).toContain('RAW_MATCHES');
    expect(out).toContain('ActuallyAbsentManifestSymbol');
    expect(out).toContain('CONFIRMED_ABSENT');
  });

  it('adds raw occurrences when a precise relationship traversal is empty', async () => {
    const out = await output('callers', { symbol: 'wide_alpha' });
    expect(out).toMatch(/No callers found/i);
    expect(out).toMatch(/Found 1 raw-source match/i);
    expect(out).toContain('RAW_MATCHES');
    expect(out).toMatch(/raw text alone is not classified as a caller/i);
  });

  it('inlines source during search when one logical symbol remains', async () => {
    const out = await output('search', {
      query: 'first',
      path: 'flow.ts',
      includeCode: 'if_unique',
    });
    expect(out).toMatch(/Unique exact result; source included/i);
    expect(out).toContain('return helper(1)');
    expect(out).toMatch(/source included in this response/i);
  });

  it('returns exact enum and struct declarations across search, node, and manifest routes', async () => {
    const search = await output('search', {
      queries: [
        { query: 'DeliveryMode', includeCode: 'if_unique' },
        { query: 'PointerConfig', includeCode: 'if_unique' },
      ],
    });
    expect(search.match(/Unique exact result; source included/gi)).toHaveLength(2);
    expect(search).toContain('DELIVERY_DISABLED = -2');
    expect(search).toContain('DELIVERY_BUFFERED = 4, // wire-compatible value');
    expect(search).toContain('int64_t *count;');
    expect(search).toContain('const char *label;');
    expect(search).not.toMatch(/Members \(/);

    const node = await output('node', { symbol: 'PointerConfig', includeCode: true });
    expect(node).toContain('int64_t *count;');
    expect(node).toContain('const char *label;');
    expect(node).not.toMatch(/Members \(/);

    const manifest = await output('node', {
      targets: [{ file: 'src/value_types.h', symbols: ['DeliveryMode', 'PointerConfig'] }],
    });
    expect(manifest).toContain('DELIVERY_DISABLED = -2');
    expect(manifest).toContain('int64_t *count;');
  });

  it('accepts a callable signature directly in search and never guesses a bad signature', async () => {
    const precise = await output('search', {
      query: 'int push_back_send_list(ObDtlLinkedBuffer *buffer)',
      includeCode: 'if_unique',
    });
    expect(precise).toContain('push_back_send_list(ObDtlLinkedBuffer *buffer)');
    expect(precise).toMatch(/No indexed definition found/i);
    expect(precise).toContain('DECLARATION_ONLY');
    expect(precise).toMatch(/Found 3 raw-source matches/i);

    const bad = await output('search', {
      query: 'push_back_send_list',
      signature: 'push_back_send_list(double value)',
      includeCode: 'if_unique',
    });
    expect(bad).toMatch(/Signature hint did not match/i);
    expect(bad).toMatch(/No source was inlined/i);
    expect(bad).toMatch(/Raw-source fallback was skipped/i);
    expect(bad).not.toMatch(/raw-source (?:match|scan)/i);
  });

  it('returns raw source hits when an exact graph symbol is missing', async () => {
    const out = await output('search', { query: 'RAW_ONLY_MISSING_MARKER' });
    expect(out).toMatch(/No exact, case-sensitive match/i);
    expect(out).toContain('RAW_MATCHES');
    expect(out).toMatch(/src\/raw_gap\.ts:\s*\n\s*Line 1:/i);
    expect(out).toMatch(/index\/parser gap/i);
  });

  it('claims absence only after a complete current-source scan', async () => {
    const out = await output('search', { query: 'TotallyAbsentSymbol' });
    expect(out).toMatch(/No exact, case-sensitive match/i);
    expect(out).toContain('CONFIRMED_ABSENT');
    expect(out).toMatch(/complete scan of \d+ file/i);
    expect(out).toMatch(/do not rerun Grep/i);
  });

  it('uses bundled ripgrep for complete raw evidence when the indexed scope is visible', async () => {
    const previous = process.env.CODEGRAPH_RAW_EVIDENCE_BACKEND;
    process.env.CODEGRAPH_RAW_EVIDENCE_BACKEND = 'ripgrep';
    try {
      const report = await scanRawSourceEvidence(cg, [{
        label: 'RAW_ONLY_MISSING_MARKER',
        needle: 'RAW_ONLY_MISSING_MARKER',
      }]);
      expect(report.backend).toMatch(/ripgrep|hybrid/);
      expect(report.states[0]?.matchingLines).toBe(1);
      expect(formatRawSourceEvidence(report)).toMatch(/Found 1 raw-source match/i);
      expect(formatRawSourceEvidence(report)).not.toMatch(/server-side|KiB|MiB/i);
    } finally {
      if (previous === undefined) delete process.env.CODEGRAPH_RAW_EVIDENCE_BACKEND;
      else process.env.CODEGRAPH_RAW_EVIDENCE_BACKEND = previous;
    }
  });

  it('does not apply the Node byte budget to a complete ripgrep scan', async () => {
    const previous = process.env.CODEGRAPH_RAW_EVIDENCE_BACKEND;
    process.env.CODEGRAPH_RAW_EVIDENCE_BACKEND = 'ripgrep';
    try {
      const report = await scanRawSourceEvidence(cg, [{
        label: 'RipgrepBudgetIndependentMissingSymbol',
        needle: 'RipgrepBudgetIndependentMissingSymbol',
      }], 1);
      const out = formatRawSourceEvidence(report);
      expect(report.backend).toBe('ripgrep');
      expect(report.totalScannedBytes).toBeGreaterThan(1);
      expect(report.budgetReached).toBe(false);
      expect(out).toContain('CONFIRMED_ABSENT');
      expect(out).not.toContain('INCONCLUSIVE');
    } finally {
      if (previous === undefined) delete process.env.CODEGRAPH_RAW_EVIDENCE_BACKEND;
      else process.env.CODEGRAPH_RAW_EVIDENCE_BACKEND = previous;
    }
  });

  it('pushes an exact path down to ripgrep instead of scanning then filtering the repository', async () => {
    const previous = process.env.CODEGRAPH_RAW_EVIDENCE_BACKEND;
    process.env.CODEGRAPH_RAW_EVIDENCE_BACKEND = 'ripgrep';
    try {
      const report = await scanRawSourceEvidence(cg, [{
        label: 'PATH_SCOPED_RAW_MARKER',
        needle: 'PATH_SCOPED_RAW_MARKER',
        path: 'src/raw_scope_target.ts',
      }]);
      expect(report.backend).toMatch(/ripgrep|hybrid/);
      expect(report.totalScannedFiles).toBe(1);
      expect(report.states[0]?.eligibleFiles).toBe(1);
      expect(report.states[0]?.matchingLines).toBe(1);
      expect(report.states[0]?.snippets[0]?.file).toBe('src/raw_scope_target.ts');
    } finally {
      if (previous === undefined) delete process.env.CODEGRAPH_RAW_EVIDENCE_BACKEND;
      else process.env.CODEGRAPH_RAW_EVIDENCE_BACKEND = previous;
    }
  });

  it('returns inconclusive when the raw-evidence wall-clock budget is exhausted', async () => {
    const previous = process.env.CODEGRAPH_RAW_EVIDENCE_BACKEND;
    process.env.CODEGRAPH_RAW_EVIDENCE_BACKEND = 'ripgrep';
    try {
      const report = await scanRawSourceEvidence(cg, [{
        label: 'DeadlineLimitedMissingSymbol',
        needle: 'DeadlineLimitedMissingSymbol',
      }], undefined, { timeoutMs: 1 });
      const out = formatRawSourceEvidence(report);
      expect(report.timeBudgetReached).toBe(true);
      expect(out).toContain('INCONCLUSIVE');
      expect(out).not.toContain('CONFIRMED_ABSENT');
      expect(out).toMatch(/time budget reached/i);
    } finally {
      if (previous === undefined) delete process.env.CODEGRAPH_RAW_EVIDENCE_BACKEND;
      else process.env.CODEGRAPH_RAW_EVIDENCE_BACKEND = previous;
    }
  });

  it('propagates request cancellation into raw evidence', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await handler.execute('search', {
      query: 'CancelledMissingSymbol',
    }, { signal: controller.signal });
    const out = result.content.map((entry) => entry.text).join('\n');
    expect(out).toContain('INCONCLUSIVE');
    expect(out).not.toContain('CONFIRMED_ABSENT');
    expect(out).toMatch(/request cancelled/i);
  });

  it('caps wrong-owner recovery before grouping a high-frequency leaf', async () => {
    vi.stubEnv('CODEGRAPH_SEARCH_FUZZY', '1');
    const db = (cg as any).db.getDb();
    const insert = db.prepare(
      `INSERT INTO nodes (
         id, kind, name, qualified_name, file_path, language,
         start_line, end_line, start_column, end_column, signature, updated_at
       ) VALUES (?, 'method', 'reuse', ?, 'src/flow.ts', 'cpp', 1, 1, 0, 1, ?, ?)`
    );
    for (let index = 0; index < 70; index++) {
      insert.run(
        `high-frequency-reuse-${index}`,
        `IndexedOwner${index}::reuse`,
        `int IndexedOwner${index}::reuse()`,
        Date.now(),
      );
    }

    const out = await output('search', {
      query: 'MissingOwner::reuse',
      includeCode: 'if_unique',
      limit: 5,
    });
    expect(out).toMatch(/Qualified owner mismatch/i);
    expect(out).toMatch(/High-frequency leaf guard: 70 candidates/i);
    expect(out).toMatch(/no repository text scan or all-pairs overload comparison/i);
    expect(out).not.toMatch(/raw-source (?:match|scan)/i);
  });

  it('bounds legacy owner pairing when path narrows a high-frequency leaf below the candidate cap', async () => {
    vi.stubEnv('CODEGRAPH_SEARCH_FUZZY', '1');
    const db = (cg as any).db.getDb();
    const insert = db.prepare(
      `INSERT INTO nodes (
         id, kind, name, qualified_name, file_path, language,
         start_line, end_line, start_column, end_column, signature,
         is_declaration, updated_at
       ) VALUES (?, 'method', 'process', ?, ?, 'cpp', 1, 1, 0, 1, ?, ?, ?)`
    );
    db.exec('BEGIN');
    try {
      for (let index = 0; index < 1_000; index++) {
        const scoped = index < 60;
        const owner = scoped ? `ScopedOwner${index}` : `OtherOwner${index}`;
        insert.run(
          `bounded-process-${index}`,
          `${owner}::process`,
          index === 0
            ? 'src/single-process.cpp'
            : scoped ? 'src/scoped-process.cpp' : 'src/other-process.cpp',
          `int ${owner}::process()`,
          scoped ? 1 : 0,
          Date.now(),
        );
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    const originalExact = cg.getNodesBySymbolExact.bind(cg);
    const originalByName = cg.getNodesByName.bind(cg);
    let repeatedLeafLookups = 0;
    let sameNameQueries = 0;
    (cg as any).getNodesBySymbolExact = (symbol: string) => {
      if (symbol === 'process') repeatedLeafLookups++;
      return originalExact(symbol);
    };
    (cg as any).getNodesByName = (name: string) => {
      if (name === 'process') sameNameQueries++;
      return originalByName(name);
    };
    try {
      const narrowOut = await output('search', {
        query: 'MissingOwner::process',
        path: 'single-process.cpp',
        limit: 5,
      });
      expect(narrowOut).toMatch(/Qualified owner mismatch/i);
      expect(narrowOut).not.toMatch(/legacy pairing budget/i);
      expect(repeatedLeafLookups).toBe(0);
      expect(sameNameQueries).toBeLessThanOrEqual(2);

      repeatedLeafLookups = 0;
      sameNameQueries = 0;
      const out = await output('search', {
        query: 'MissingOwner::process',
        path: 'scoped-process.cpp',
        includeCode: 'if_unique',
        limit: 5,
      });
      expect(out).toMatch(/Qualified owner mismatch/i);
      expect(out).toMatch(/59 scoped candidates × 1000 same-leaf candidates/i);
      expect(out).toMatch(/50000-comparison legacy pairing budget/i);
      expect(out).toMatch(/all-candidates legacy fallback was skipped/i);
      expect(repeatedLeafLookups).toBe(0);
      expect(sameNameQueries).toBeLessThanOrEqual(2);

      repeatedLeafLookups = 0;
      sameNameQueries = 0;
      const bareOut = await output('search', {
        query: 'process',
        limit: 5,
      });
      expect(bareOut).toMatch(/Search Results \(5 found\)/i);
      expect(repeatedLeafLookups).toBeLessThanOrEqual(1);
      expect(sameNameQueries).toBeLessThanOrEqual(1);
    } finally {
      (cg as any).getNodesBySymbolExact = originalExact;
      (cg as any).getNodesByName = originalByName;
      db.prepare(`DELETE FROM nodes WHERE id LIKE 'bounded-process-%'`).run();
    }
  });

  it('reuses raw evidence only inside an unchanged actively-watched source epoch', async () => {
    const originalIsWatching = cg.isWatching.bind(cg);
    const originalPending = cg.getPendingFiles.bind(cg);
    (cg as any).isWatching = () => true;
    (cg as any).getPendingFiles = () => [];
    try {
      const first = await scanRawSourceEvidence(cg, [{
        label: 'first label',
        needle: 'RAW_ONLY_MISSING_MARKER',
      }]);
      const second = await scanRawSourceEvidence(cg, [{
        label: 'declaration-only label',
        needle: 'RAW_ONLY_MISSING_MARKER',
        purpose: 'declaration_only',
      }]);
      expect(first.cacheHit).toBe(false);
      expect(second.cacheHit).toBe(true);
      const cachedOut = formatRawSourceEvidence(second);
      expect(cachedOut).toContain('DECLARATION_ONLY');
      expect(cachedOut).not.toMatch(/source-epoch|server-side|KiB|MiB/i);

      (cg as any).getPendingFiles = () => [{ path: 'src/raw_gap.ts' }];
      const afterEdit = await scanRawSourceEvidence(cg, [{
        label: 'after edit',
        needle: 'RAW_ONLY_MISSING_MARKER',
      }]);
      expect(afterEdit.cacheHit).toBe(false);

      (cg as any).getPendingFiles = () => [];
      const partialOne = await scanRawSourceEvidence(cg, [{
        label: 'partial one',
        needle: 'BudgetLimitedMissingSymbol',
      }], 1);
      const partialTwo = await scanRawSourceEvidence(cg, [{
        label: 'partial two',
        needle: 'BudgetLimitedMissingSymbol',
      }], 1);
      expect(partialOne.cacheHit).toBe(false);
      expect(partialTwo.cacheHit).toBe(false);
    } finally {
      (cg as any).isWatching = originalIsWatching;
      (cg as any).getPendingFiles = originalPending;
    }
  });

  it('marks a budget-limited raw scan inconclusive instead of claiming absence', async () => {
    const report = await scanRawSourceEvidence(cg, [{
      label: 'BudgetLimitedMissingSymbol',
      needle: 'BudgetLimitedMissingSymbol',
    }], 1);
    const out = formatRawSourceEvidence(report);
    expect(out).toContain('INCONCLUSIVE');
    expect(out).not.toContain('CONFIRMED_ABSENT');
    expect(out).toMatch(/scan budget reached/i);
  });

  it('does not misread a natural-language question containing parentheses as a signature', async () => {
    const out = await output('search', { query: 'how does first() work?' });
    expect(out).toMatch(/symbol name|符号名/i);
    expect(out).not.toContain('return helper(1)');
  });

  it('corrects a unique symbol capitalization mismatch in the same call', async () => {
    vi.stubEnv('CODEGRAPH_SEARCH_FUZZY', '1');
    const out = await output('search', {
      query: 'namedcontainer',
      includeCode: 'if_unique',
    });
    expect(out).toMatch(/Case-insensitive unique correction/i);
    expect(out).toContain('NamedContainer (class)');
  });

  it('applies the same capitalization correction to relationship tools', async () => {
    const out = await output('callers', { symbol: 'FIRST' });
    expect(out).toMatch(/Case-insensitive exact-name correction/i);
    expect(out).toContain('second (function)');
  });

  it('uses search path as a soft exact-candidate hint and skips line after a path miss', async () => {
    const matched = await output('search', {
      query: 'rankedTarget',
      path: 'path-near/module',
    });
    expect(matched).toContain('matched 1 of 2 exact candidate');
    expect(matched).toContain('src/path-near/module/ranked.ts');
    expect(matched).not.toContain('src/path-far/ranked.ts');

    const fallback = await output('search', {
      query: 'rankedTarget',
      path: '/usr1/checkout/src/path-near/module',
      line: 999,
    });
    expect(fallback).toMatch(/matched no exact candidate/i);
    expect(fallback).toMatch(/Line hint 999 was not applied/i);
    expect(fallback).toContain('src/path-near/module/ranked.ts');
    expect(fallback).toContain('src/path-far/ranked.ts');
    expect(fallback.indexOf('src/path-near/module/ranked.ts'))
      .toBeLessThan(fallback.indexOf('src/path-far/ranked.ts'));
    expect(fallback).not.toMatch(/No exact match|closest matches/i);
  });

  it('keeps blank search paths backward-compatible with an omitted optional hint', async () => {
    const omitted = await output('search', { query: 'first' });
    const blank = await output('search', { query: 'first', path: '' });
    const whitespace = await output('search', { query: 'first', path: '   ' });
    expect(blank).toBe(omitted);
    expect(whitespace).toBe(omitted);

    const batch = await output('search', {
      queries: [{ query: 'first', path: '' }],
    });
    expect(batch).toContain('first (function)');
    expect(batch).not.toMatch(/path must not be blank/i);
  });

  it('applies independent soft path semantics to each native batch query', async () => {
    const out = await output('search', {
      queries: [
        { query: 'rankedTarget', path: 'path-far' },
        { query: 'batchRankedTarget', path: '/checkout/src/path-near/module' },
      ],
    });
    const first = out.slice(out.indexOf('## rankedTarget'), out.indexOf('\n\n---\n\n'));
    const second = out.slice(out.indexOf('## batchRankedTarget'));
    expect(first).toContain('src/path-far/ranked.ts');
    expect(first).not.toContain('src/path-near/module/ranked.ts');
    expect(second).toMatch(/matched no exact candidate/i);
    expect(second.indexOf('src/path-near/module/ranked.ts'))
      .toBeLessThan(second.indexOf('src/path-far/ranked.ts'));
  });

  it('uses path only as secondary ranking for fuzzy fallback', async () => {
    vi.stubEnv('CODEGRAPH_SEARCH_FUZZY', '1');
    const out = await output('search', {
      query: 'rankedTarge',
      path: 'path-far',
      limit: 10,
    });
    expect(out).toMatch(/No exact match/i);
    expect(out).toMatch(/secondary ranking signal/i);
    expect(out).toContain('src/path-far/ranked.ts');
    expect(out).toContain('src/path-near/module/ranked.ts');
    expect(out.indexOf('src/path-far/ranked.ts'))
      .toBeLessThan(out.indexOf('src/path-near/module/ranked.ts'));
  });

  it('does not hard-scope raw evidence to a missed soft path hint', async () => {
    const out = await output('search', {
      query: 'PathSoftRawOnlySymbol',
      path: 'path-near/module',
    });
    expect(out).toContain('RAW_MATCHES');
    expect(out).toContain('src/path-far/ranked.ts');
  });

  it('keeps definition-first implementation delivery when a path hint selects a header declaration', async () => {
    const out = await output('search', {
      query: 'push_back_send_list',
      path: 'overloads.h',
      signature: 'push_back_send_list()',
      includeCode: 'if_unique',
    });
    expect(out).toContain('src/overloads.cpp');
    expect(out).toContain('int ObDtlBasicChannel::push_back_send_list() { return 0; }');
  });

  it('shows every direct call site together with caller and callee definition ranges', async () => {
    const callers = await output('callers', { symbol: 'relationTarget' });
    expect(callers).toContain('relationCaller (function)');
    expect(callers).toContain('call sites: src/relations.ts:3, src/relations.ts:4, src/relations.ts:5');
    expect(callers).toContain('caller: src/relations.ts:2-6');

    const callees = await output('callees', { symbol: 'relationCaller' });
    expect(callees).toContain('relationTarget (function)');
    expect(callees).toContain('definition: src/relations.ts:1-1');
    expect(callees).toContain('call sites: src/relations.ts:3, src/relations.ts:4, src/relations.ts:5');
  });

  it('batches selected container members without returning the whole container', async () => {
    const out = await output('context', {
      targets: [
        { symbol: 'NamedContainer', file: 'named_container.h', members: ['run'] },
        { symbol: 'first', file: 'flow.ts' },
      ],
    });
    expect(out).toContain('member: run');
    expect(out).toContain('access boundary for member: run');
    expect(out).toMatch(/^2\tpublic:$/m);
    expect(out).toContain('includes edit-ready comments/neighbors');
    expect(out).toMatch(/^5\t {2}int run\(\);$/m);
    expect(out).toContain('int NamedContainer::run() { return 1; }');
    expect(out).not.toContain('Members (3; showing 3)');
    expect(out).toContain('return helper(1)');
  });

  it('selects the sole concrete container definition over forward declarations', async () => {
    const out = await output('context', {
      targets: [{ symbol: 'ForwardContainer', members: ['run'] }],
    });
    expect(out).not.toMatch(/container target is not unique/i);
    expect(out).toContain('src/forward_container.h');
    expect(out).toContain('int ForwardContainer::run() { return 7; }');
  });

  it('merges overlapping and adjacent file windows and text anchors', async () => {
    const out = await output('context', {
      targets: [
        { file: 'flow.ts', offset: 1, limit: 3 },
        { file: 'flow.ts', text: 'TABLE_NAME', contextLines: 0 },
      ],
    });
    expect(out).toMatch(/merged current-source ranges 1-4/i);
    expect(out.match(/^1\texport function helper/gm)).toHaveLength(1);
    expect(out.match(/^4\texport const TABLE_NAME/gm)).toHaveLength(1);
    expect(out).not.toMatch(/used by/i);
  });

  it('auto-recovers text plus offset/limit as an asserted explicit window', async () => {
    const out = await output('context', {
      targets: [{ file: 'flow.ts', text: 'TABLE_NAME', offset: 1, limit: 4 }],
    });
    expect(out).toMatch(/treated text as a window assertion/i);
    expect(out).toMatch(/text assertion matched: TABLE_NAME/i);
    expect(out).toMatch(/merged current-source ranges 1-4/i);
    expect(out).toContain('export const TABLE_NAME');
    expect(out).not.toMatch(/cannot combine/i);
  });

  it('auto-clamps an oversized context file window in place', async () => {
    const out = await output('context', {
      targets: [{ file: 'flow.ts', offset: 1, limit: 650 }],
    });
    expect(out).toMatch(/safely clamped to 500 lines/i);
    expect(out).toContain('TABLE_NAME');
  });

  it('defaults a limit-only context window to offset 1', async () => {
    const out = await output('context', {
      targets: [{ file: 'flow.ts', limit: 3 }],
    });
    expect(out).toContain('merged current-source ranges 1-3');
    expect(out).toMatch(/defaulted missing file-window offset to 1/i);
    expect(out).toContain('return helper(1)');
  });

  it('emits a broad multi-file batch when its rendered source fits the character budget', async () => {
    const out = await output('context', {
      targets: ['flow.ts', 'metrics.h', 'named_container.h'].map((file) => ({
        file,
        offset: 1,
        limit: 120,
      })),
    });
    expect(out).not.toMatch(/Context preflight.*source not emitted/i);
    expect(out).not.toMatch(/above the 20000-character batch budget/i);
    expect(out).toContain('TransferMetrics');
    expect(out).toContain('NamedContainer');
  });

  it('preflights an over-budget file batch before emitting source', async () => {
    const out = await output('context', {
      targets: ['alpha', 'beta', 'gamma'].map((name) => ({
        file: `wide_${name}.ts`,
        offset: 1,
        limit: 150,
      })),
    });
    expect(out).toMatch(/Context preflight.*source not emitted/i);
    expect(out).toMatch(/3 windows totaling 450 requested lines/i);
    expect(out).toMatch(/above the 20000-character batch budget/i);
    expect(out).toContain('wide_alpha');
    expect(out).not.toContain('alpha-100');
    expect(out).toMatch(/Do not use Read/i);
  });

  it('preflights merged same-file windows instead of truncating the trailing range', async () => {
    const out = await output('context', {
      targets: [
        { file: 'src/wide_combined.ts', offset: 1, limit: 120 },
        { file: 'src/wide_combined.ts', offset: 121, limit: 120 },
        { file: 'src/wide_combined.ts', offset: 241, limit: 120 },
      ],
    });
    expect(out).toMatch(/Context preflight.*source not emitted/i);
    expect(out).toMatch(/3 windows totaling 360 requested lines/i);
    expect(out).not.toContain('combined-0');
    expect(out).not.toMatch(/precise file batch truncated/i);
  });

  it('prefers a named container over same-name constructors unless precisely pinned', async () => {
    const contextOut = await output('context', {
      targets: [
        { symbol: 'NamedContainer', file: 'named_container.h' },
        { symbol: 'first', file: 'flow.ts' },
      ],
    });
    expect(contextOut).toContain('NamedContainer (class)');
    expect(contextOut).toContain('class NamedContainer {');
    expect(contextOut).toContain('explicit NamedContainer(int value);');
    expect(contextOut).not.toContain('Members (3; showing 3)');
    expect(contextOut).not.toMatch(/distinct overload candidates/i);

    const nodeOut = await output('node', {
      symbol: 'NamedContainer',
      file: 'named_container.h',
      includeCode: true,
    });
    expect(nodeOut).toContain('NamedContainer (class)');
    expect(nodeOut).toContain('class NamedContainer {');
    expect(nodeOut).not.toMatch(/definitions named "NamedContainer"/i);

    const constructorOut = await output('context', {
      targets: [
        {
          symbol: 'NamedContainer',
          file: 'named_container.h',
          signature: 'NamedContainer(int value)',
        },
        { symbol: 'first', file: 'flow.ts' },
      ],
    });
    expect(constructorOut).toContain('explicit NamedContainer(int value)');
  });

  it('returns same-name overload candidates together instead of silently choosing one', async () => {
    const out = await output('context', {
      targets: [
        { symbol: 'push_back_send_list', file: 'overloads.h' },
        { symbol: 'first', file: 'flow.ts' },
      ],
    });
    expect(out).toMatch(/distinct overload candidates/i);
    expect(out).toContain('push_back_send_list(ObDtlLinkedBuffer *buffer)');
    expect(out).toContain('push_back_send_list()');
    expect(out).not.toMatch(/ambiguous.*add file\/line/i);
  });

  it('refuses to aggregate callers, callees, or impact across distinct overloads', async () => {
    for (const tool of ['callers', 'callees', 'impact']) {
      const out = await output(tool, { symbol: 'push_back_send_list' });
      expect(out).toMatch(/Ambiguous relationship target/i);
      expect(out).toMatch(/No (callers|callees|impact) traversal was run/i);
      expect(out).toContain('push_back_send_list(ObDtlLinkedBuffer *buffer)');
      expect(out).toContain('push_back_send_list()');
      expect(out).not.toContain('first (function)');
      expect(out).not.toContain('second (function)');
    }
  });

  it('uses a signature hint to select one overload for every relationship tool', async () => {
    const callers = await output('callers', {
      symbol: 'push_back_send_list',
      signature: 'push_back_send_list(ObDtlLinkedBuffer *buffer)',
    });
    expect(callers).toContain('second (function)');
    expect(callers).not.toContain('first (function)');

    const callees = await output('callees', {
      symbol: 'int push_back_send_list(ObDtlLinkedBuffer *buffer)',
    });
    expect(callees).toContain('second (function)');
    expect(callees).not.toContain('helper (function)');

    const impact = await output('impact', {
      symbol: 'push_back_send_list',
      signature: 'push_back_send_list(ObDtlLinkedBuffer *buffer)',
      depth: 1,
    });
    expect(impact).toContain('second:3');
    expect(impact).not.toContain('first:2');
  });

  it('uses canonical C++ parameter matching for a relationship signature hint', async () => {
    const out = await output('callers', {
      symbol: 'make_channel',
      signature: 'make_channel(const common::ObAddr &addr)',
    });
    expect(out).not.toMatch(/Ambiguous relationship target/i);
    expect(out).not.toMatch(/Signature hint did not match/i);
    expect(out).toMatch(/No callers found for.*make_channel/i);
  });

  it('uses file and line to select the intended overload without nearest guessing', async () => {
    const callers = await output('callers', {
      symbol: 'push_back_send_list',
      file: 'overloads.cpp',
      line: 2,
    });
    expect(callers).toContain('first (function)');
    expect(callers).not.toContain('second (function)');

    const badLine = await output('impact', {
      symbol: 'push_back_send_list',
      file: 'overloads.cpp',
      line: 999,
    });
    expect(badLine).toMatch(/line hint is outside every matching symbol body/i);
    expect(badLine).toMatch(/No impact traversal was run/i);
    expect(badLine).not.toContain('affects');
  });

  it('treats a bad signature as an assertion failure instead of falling back', async () => {
    const out = await output('callees', {
      symbol: 'push_back_send_list',
      file: 'overloads.h',
      signature: 'push_back_send_list(double value)',
    });
    expect(out).toMatch(/Signature hint did not match/i);
    expect(out).toMatch(/No callees traversal was run/i);
    expect(out).not.toContain('helper (function)');
    expect(out).not.toContain('second (function)');
    expect(out).toMatch(/Raw-source fallback was skipped/i);
    expect(out).not.toMatch(/raw-source (?:match|scan)/i);
  });

  it('does not collapse a different overload behind a stale legacy defines edge', async () => {
    const db = (cg as any).db.getDb();
    const definition = db.prepare(
      `SELECT id FROM nodes
       WHERE name = 'push_back_send_list' AND file_path = 'src/overloads.cpp'`,
    ).get() as { id: string };
    const pointerDeclaration = db.prepare(
      `SELECT id FROM nodes
       WHERE name = 'push_back_send_list' AND file_path = 'src/overloads.h'
         AND signature LIKE '%ObDtlLinkedBuffer%'`,
    ).get() as { id: string };
    db.prepare(
      `INSERT OR IGNORE INTO edges (source, target, kind, provenance)
       VALUES (?, ?, 'defines', 'legacy-test')`,
    ).run(definition.id, pointerDeclaration.id);

    const out = await output('context', {
      targets: [
        { symbol: 'push_back_send_list' },
        { symbol: 'first', file: 'flow.ts' },
      ],
    });
    expect(out).toContain('push_back_send_list(ObDtlLinkedBuffer *buffer)');
    expect(out).toMatch(/distinct overload candidates/i);
  });

  it('can narrow same-file overloads with an optional signature hint', async () => {
    const out = await output('context', {
      targets: [
        {
          symbol: 'push_back_send_list',
          file: 'overloads.h',
          signature: 'push_back_send_list(ObDtlLinkedBuffer *buffer)',
        },
        { symbol: 'first', file: 'flow.ts' },
      ],
    });
    expect(out).toContain('push_back_send_list(ObDtlLinkedBuffer *buffer)');
    expect(out.match(/^4\t.*push_back_send_list/gm)).toHaveLength(1);
    expect(out).toContain('Other overloads (summary only)');
  });

  it('does not silently select the nearest overload when a line hint misses', async () => {
    const out = await output('context', {
      targets: [
        { symbol: 'push_back_send_list', file: 'overloads.cpp', line: 999 },
        { symbol: 'first', file: 'flow.ts' },
      ],
    });
    expect(out).toMatch(/line hint is outside every matching symbol body/i);
    expect(out).toMatch(/No nearest overload was selected/i);
    expect(out).toContain('overloads.cpp:2');
  });

  it('does not silently select a symbol when the file hint misses', async () => {
    const out = await output('node', {
      symbol: 'push_back_send_list',
      file: 'missing.cpp',
      line: 2,
      includeCode: true,
    });
    expect(out).toMatch(/file hint matched no exact symbol candidate/i);
    expect(out).toContain('overloads.cpp:2');
    expect(out).toContain('overloads.h:4');
    expect(out).toMatch(/definitions named "push_back_send_list"/i);
  });

  it('summarizes sibling overloads after a precise single-node lookup', async () => {
    const out = await output('node', {
      symbol: 'push_back_send_list',
      file: 'overloads.cpp',
      line: 2,
      includeCode: true,
    });
    expect(out).toContain('Other overloads (summary only)');
    expect(out).toContain('push_back_send_list(ObDtlLinkedBuffer *buffer)');
    expect(out).toMatch(/no indexed definition found for this exact overload/i);
    expect(out).toMatch(/codegraph_callers.*codegraph_callees/i);
  });

  it('marks a directly requested declaration-only overload as authoritative', async () => {
    const out = await output('node', {
      symbol: 'push_back_send_list',
      file: 'overloads.h',
      line: 4,
      includeCode: true,
    });
    expect(out).toMatch(/No indexed definition found for this exact overload/i);
    expect(out).toMatch(/do not use Grep or text search merely to verify absence/i);
  });

  it('uses canonical C++ matching when an older index is missing its defines edge', async () => {
    const db = (cg as any).db.getDb();
    db.prepare(
      `DELETE FROM edges
       WHERE kind = 'defines' AND (source IN (
         SELECT id FROM nodes WHERE name = 'get_row'
       ) OR target IN (
         SELECT id FROM nodes WHERE name = 'get_row'
       ))`,
    ).run();

    const out = await output('node', {
      symbol: 'get_row',
      file: 'metrics.h',
      line: 5,
      includeCode: true,
    });
    expect(out).toMatch(/Location:.*metrics\.cpp:4/i);
    expect(out).toMatch(/Declaration endpoints[^]*metrics\.h:5/i);
    expect(out).not.toMatch(/No indexed definition found/i);

    const batchOut = await output('context', {
      targets: [
        { symbol: 'get_row' },
        { symbol: 'first', file: 'flow.ts' },
      ],
    });
    expect(batchOut).toMatch(/implementation source included.*declaration endpoint referenced compactly/i);
    expect(batchOut).toContain('int TransferMetrics::get_row');

    db.prepare(
      `DELETE FROM edges
       WHERE kind = 'defines' AND (source IN (
         SELECT id FROM nodes WHERE name = 'make_channel'
       ) OR target IN (
         SELECT id FROM nodes WHERE name = 'make_channel'
       ))`,
    ).run();
    const qualifiedTypeOut = await output('node', {
      symbol: 'make_channel',
      file: 'metrics.h',
      line: 6,
      includeCode: true,
    });
    expect(qualifiedTypeOut).toMatch(/Location:.*metrics\.cpp:5/i);
    expect(qualifiedTypeOut).toMatch(/Declaration endpoints[^]*metrics\.h:6/i);
    expect(qualifiedTypeOut).not.toMatch(/No indexed definition found/i);
  });

  it('makes declaration-only overload status explicit in symbol search', async () => {
    const out = await output('search', { query: 'push_back_send_list' });
    expect(out).toMatch(/declaration — no indexed definition found for this exact overload/i);
    expect(out).toMatch(/authoritative for the current index/i);
    expect(out).toContain('DECLARATION_ONLY');
    expect(out).toMatch(/other overloads or call sites.*not definitions of this exact overload/i);
  });

  it('does not pair same-signature declarations and definitions from unrelated owners', async () => {
    fs.writeFileSync(
      path.join(dir, 'src', 'owners.h'),
      'class Alpha { public: int run(int value); };\nclass Beta { public: int run(int value); };\n',
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'owners.cpp'),
      '#include "owners.h"\nint Beta::run(int value) { return value; }\n',
    );
    await cg.sync({ paths: ['src/owners.h', 'src/owners.cpp'] });

    const out = await output('node', {
      symbol: 'run',
      file: 'owners.h',
      line: 1,
      includeCode: true,
    });
    expect(out).toMatch(/No indexed definition found for this exact overload/i);
    expect(out).not.toMatch(/Definition:.*owners\.cpp:2/i);
  });

  it('accepts a copied callable signature directly in the symbol field', async () => {
    const out = await output('context', {
      targets: [
        { symbol: 'push_back_send_list(ObDtlLinkedBuffer *buffer)', file: 'overloads.h' },
        { symbol: 'first', file: 'flow.ts' },
      ],
    });
    expect(out).toContain('push_back_send_list(ObDtlLinkedBuffer *buffer)');
    expect(out.match(/^4\t.*push_back_send_list/gm)).toHaveLength(1);
    expect(out).toContain('Other overloads (summary only)');
  });

  it('can opt into relation trails for a batch', async () => {
    const out = await output('context', {
      targets: [
        { symbol: 'first', file: 'flow.ts' },
        { symbol: 'second', file: 'flow.ts' },
      ],
      includeRelations: true,
    });
    expect(out).toContain('### Trail');
  });

  it('omits relation trails by default and returns them only when explicitly requested', async () => {
    const defaultOut = await output('node', {
      symbol: 'first',
      includeCode: true,
    });
    const withRelations = await output('node', {
      symbol: 'first',
      includeCode: true,
      includeRelations: true,
    });
    expect(defaultOut).not.toContain('### Trail');
    expect(defaultOut).not.toContain('Called by');
    expect(withRelations).toContain('### Trail');
    expect(withRelations).toContain('Called by');
  });

  it('accepts one precise context target without forcing a correction call', async () => {
    const single = await handler.execute('context', { targets: [{ symbol: 'first', file: 'flow.ts' }] });
    const singleOut = single.content.map((c) => c.text).join('\n');
    const invalid = await handler.execute('context', { targets: 'first' });
    const empty = await handler.execute('context', { targets: [] });
    const blank = await handler.execute('context', {
      targets: [{ symbol: 'first' }, { symbol: '   ' }],
    });
    expect(single.isError).not.toBe(true);
    expect(singleOut).toMatch(/One precise context target was supplied/i);
    expect(singleOut).toContain('return helper(1)');
    expect(invalid.isError).toBe(true);
    expect(empty.isError).toBe(true);
    expect(blank.isError).toBe(true);
  });

  it('auto-parses JSON-stringified context targets, including the observed missing-key-quote typo', async () => {
    const stringified = await handler.execute('context', {
      targets: JSON.stringify([{ symbol: 'first', file: 'flow.ts' }]),
    });
    const stringifiedOut = stringified.content.map((c) => c.text).join('\n');
    expect(stringified.isError).not.toBe(true);
    expect(stringifiedOut).toContain('return helper(1)');
    expect(stringifiedOut).toMatch(/parsed JSON-stringified targets/i);

    const repaired = await handler.execute('context', {
      targets: '[{"file":"src/flow.ts", offset":1, "limit":2}]',
    });
    const repairedOut = repaired.content.map((c) => c.text).join('\n');
    expect(repaired.isError).not.toBe(true);
    expect(repairedOut).toContain('1\texport function helper');
    expect(repairedOut).toMatch(/repaired a missing opening quote/i);
  });

  it('auto-converts one or several bare file targets into compact symbol outlines', async () => {
    const single = await handler.execute('context', {
      targets: [{ file: 'src/flow.ts' }],
    });
    const singleOut = single.content.map((c) => c.text).join('\n');
    expect(single.isError).not.toBe(true);
    expect(singleOut).toContain('Automatically converted bare context file target');
    expect(singleOut).toContain('### Symbols');
    expect(singleOut).toContain('`first`');
    expect(singleOut).not.toContain('2\texport function first');

    const batch = await handler.execute('context', {
      targets: [
        { file: 'src/flow.ts' },
        { file: 'src/metrics.cpp' },
      ],
    });
    const batchOut = batch.content.map((c) => c.text).join('\n');
    expect(batch.isError).not.toBe(true);
    expect(batchOut).toMatch(/Precise implementation context \(2\/2 targets resolved\)/i);
    expect(batchOut).toContain('**src/flow.ts**');
    expect(batchOut).toContain('**src/metrics.cpp**');
    expect(batchOut).toContain('`first`');
    expect(batchOut).toContain('TransferMetrics::get_row');
    expect(batchOut).toMatch(/targets\[0\].*compact symbol outline/i);
    expect(batchOut).toMatch(/targets\[1\].*compact symbol outline/i);
  });

  it('applies symbolsOnly, OR filters, and outlineLimit inside node targets', async () => {
    const out = await output('node', {
      targets: [{
        file: 'src/flow.ts',
        symbolsOnly: true,
        outlineQuery: 'first|TABLE_NAME',
        outlineLimit: 8,
      }],
    });
    expect(out).toMatch(/outline OR="first\|table_name"/i);
    expect(out).toContain('`first`');
    expect(out).toContain('`TABLE_NAME`');
    expect(out).not.toContain('`helper`');
  });

  it('aggregates callers across an exact C++ virtual dispatch family', async () => {
    const out = await output('callers', {
      symbol: 'VirtualDerived::attach',
      signature: 'attach(int value)',
    });
    expect(out).toContain('invoke_virtual');
    expect(out).toMatch(/Virtual dispatch family expanded/i);
  });

  it('batch-searches literals in a bounded path and skips generated source by default', async () => {
    const out = await output('text_search', {
      queries: ['__all_virtual_demo', 'REGISTER_CHANNEL'],
      path: 'src',
      contextLines: 0,
    });
    expect(out).toContain('src/flow.ts:4');
    expect(out).toContain('src/flow.ts:4-5');
    expect(out).toMatch(/1 unique window/i);
    expect(out.match(/^4\texport const TABLE_NAME/gm)).toHaveLength(1);
    expect(out.match(/^5\t\/\/ REGISTER_CHANNEL/gm)).toHaveLength(1);
    expect(out).not.toContain('widget.generated.ts');
    expect(out).toMatch(/1 generated file\(s\) skipped/i);
    expect(out).toMatch(/do not repeat.*Grep/i);
  });

  it('includes generated source only when explicitly requested', async () => {
    const out = await output('text_search', {
      queries: ['__all_virtual_demo'],
      path: 'src',
      includeGenerated: true,
      maxMatchesPerQuery: 5,
    });
    expect(out).toContain('widget.generated.ts');
  });

  it('auto-includes one exact generated file unless explicitly disabled', async () => {
    const automatic = await output('text_search', {
      queries: ['GENERATED_MARKER'],
      path: 'src/widget.generated.ts',
    });
    const disabled = await output('text_search', {
      queries: ['GENERATED_MARKER'],
      path: 'src/widget.generated.ts',
      includeGenerated: false,
    });
    expect(automatic).toContain('widget.generated.ts');
    expect(automatic).toMatch(/exact generated file auto-included/i);
    expect(disabled).toMatch(/after generated files were excluded/i);
  });

  it('recovers an exact global symbol for an identifier missing in the literal path', async () => {
    const out = await output('text_search', {
      queries: ['wide_alpha'],
      path: 'src/flow.ts',
      contextLines: 0,
    });
    expect(out).toMatch(/wide_alpha.*0 matches/i);
    expect(out).toMatch(/Exact symbol recovery/i);
    expect(out).toContain('src/wide_alpha.ts');
    expect(out).toContain('export function wide_alpha()');
    expect(out).toMatch(/do not call `codegraph_search` or Grep/i);
  });

  it('rejects unbounded or malformed literal searches', async () => {
    const noPath = await handler.execute('text_search', { queries: ['TABLE_NAME'] });
    const rootPath = await handler.execute('text_search', {
      queries: ['TABLE_NAME'],
      path: '.',
    });
    const blankQuery = await handler.execute('text_search', {
      queries: ['   '],
      path: 'src',
    });
    const regexShapedButLiteral = await output('text_search', {
      queries: ['TABLE_.*'],
      path: 'src',
    });
    expect(noPath.isError).toBe(true);
    expect(rootPath.isError).toBe(true);
    expect(blankQuery.isError).toBe(true);
    expect(regexShapedButLiteral).toMatch(/0 matches/i);
  });
});
