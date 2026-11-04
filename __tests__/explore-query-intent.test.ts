import { describe, it, expect } from 'vitest';
import { parseExploreQuery, consumeQueryPaths } from '../src/upstream-explore/search/query-intent';
import { extractQueryPaths, queryMightContainPaths } from '../src/upstream-explore/search/query-paths';

const tokens = (q: string) => parseExploreQuery(q).symbolTokens;

describe('one lexical query intent for prose, names and paths', () => {
  it.each(['WriterService append_log', '`WriterService`、`append_log`。', '“WriterService”，「append_log」', '（WriterService）【append_log】', '"WriterService"; \'append_log\''])('keeps the same explicit names across wrapping: %s', q => {
    expect(tokens(q)).toEqual(['WriterService', 'append_log']);
  });
  it('keeps ordinary short bags and CJK identifiers in appearance order', () => {
    expect(tokens('DataRequest task validate')).toEqual(['DataRequest', 'task', 'validate']);
    expect(tokens('入口 末端')).toEqual(['入口', '末端']);
    expect(tokens('NavMeshAgent类型 类')).toEqual(['NavMeshAgent', '类型']);
    expect(tokens('寻路服务.计算路径 로그인')).toEqual(['寻路服务.计算路径', '로그인']);
    expect(tokens('auth.ts état на')).toEqual(['auth', 'état']);
  });
  it('does not destroy C++ qualification or Erlang name/arity spelling', () => {
    expect(tokens('`net::Writer::append_log`，mod:run/3 init/2')).toEqual(['net::Writer::append_log', 'mod.run', 'init']);
  });
  it.each(['mod:fn t:method', '`mod:fn`，「t:method」', "'mod:fn'; 't:method'"])(
    'normalizes Erlang and Lua qualifications without arity: %s', query => {
      expect(tokens(query)).toEqual(['mod.fn', 't.method']);
    });
  it('does not turn query field prefixes, C++ qualification or paths into module names', () => {
    expect(tokens('kind:function lang:lua language:erlang path:src name:render')).toEqual([]);
    expect(tokens('kind:call/2 name:render/1')).toEqual([]);
    expect(tokens('app::render src/2fa/helper.cpp C:/source/main.cpp')).toEqual(['app::render']);
  });
  it('retains source ranges and original spellings for diagnostics', () => {
    const raw = '调查「Reader::read_next」、`close_stream`。';
    const ir = parseExploreQuery(raw);
    for (const m of ir.mentions) expect(raw.slice(m.start, m.end)).toBe(m.raw);
    expect(ir.mentions.find(m => m.normalized === 'Reader::read_next')).toMatchObject({ raw: '「Reader::read_next」', quoted: true, kind: 'symbol', selected: true });
    expect(ir.raw).toBe(raw); expect(ir.searchQuery).toBe(raw);
  });
  it.each([
    '暂拟三个新字段：`sample_state`、`sample_clock`。',
    '现有字段：`sample_state`、`sample_clock`。',
    '不新增字段 `sample_state`，保留 `sample_clock`。',
    '是否新增字段 `sample_state`？检查 `sample_clock`。',
    'Proposed fields: `sample_state`, `sample_clock`.',
    'Existing fields: `sample_state`, `sample_clock`.',
    'Do not add `sample_state`; reuse `sample_clock`.',
    'Rename `sample_state` to `sample_clock`.',
  ])('retains names regardless of surrounding proposal, existence or change wording: %s', raw => {
    const ir = parseExploreQuery(raw);
    expect(ir.symbolTokens).toEqual(expect.arrayContaining(['sample_state', 'sample_clock']));
    expect(ir.searchSymbols).toEqual(expect.arrayContaining(['sample_state', 'sample_clock']));
    expect(ir.searchQuery).toBe(raw);
    for (const mention of ir.mentions) expect(mention).not.toHaveProperty('intent');
    expect(ir.omitted.some(omission => String(omission.reason) === 'proposed')).toBe(false);
  });
  it('deduplicates before applying the cap without promoting later quoted repetitions', () => {
    const ir = parseExploreQuery('alpha gamma alpha `alpha` Beta `gamma` Delta', { maxNamedTokens: 3 });
    expect(ir.symbolTokens).toEqual(['alpha', 'gamma', 'Beta']);
    expect(ir.omitted.filter(o => o.reason === 'duplicate').map(o => o.normalized)).toEqual(['alpha', 'alpha', 'gamma']);
    expect(ir.omitted.filter(o => o.reason === 'named-token-limit').map(o => o.normalized)).toEqual(['Delta']);
  });
  it('does not cancel or classify repeated names after different wording', () => {
    const ir = parseExploreQuery('新字段：`status_code`。已有 `status_code` 需要兼容。');
    expect(ir.symbolTokens.filter(name => name === 'status_code')).toEqual(['status_code']);
    expect(ir.mentions.filter(m => m.normalized === 'status_code')).toHaveLength(2);
    expect(ir.mentions.filter(m => m.normalized === 'status_code').every(m => m.selected)).toBe(true);
  });
  it('keeps all clear symbols searchable beyond the named-target budget', () => {
    const names = Array.from({ length: 20 }, (_, i) => `Stage${i}Handler`);
    const ir = parseExploreQuery(names.map(x => '`' + x + '`').join('，'));
    expect(ir.symbolTokens).toEqual(names.slice(0, 16)); expect(ir.searchSymbols).toEqual(names);
    expect(ir.omitted.filter(o => o.reason === 'named-token-limit').map(o => o.normalized)).toEqual(names.slice(16));
  });
  it.each(['before', 'between', 'after'])('takes the first sixteen unique names across scripts and wrappers: %s', order => {
    const code = [...Array.from({ length: 15 }, (_, i) => `Stage${i}Writer`), '写入检查点']
      .map(name => ({ raw: '`' + name + '`', name }));
    const prose = [
      { raw: '“当前没有采样”', name: '当前没有采样' },
      { raw: '「等待下一轮处理」', name: '等待下一轮处理' },
      { raw: '『状态暂时未知』', name: '状态暂时未知' },
    ];
    const pieces = order === 'before' ? [...prose, ...code]
      : order === 'after' ? [...code, ...prose] : [...code.slice(0, 7), ...prose, ...code.slice(7)];
    const ir = parseExploreQuery(pieces.map(p => p.raw).join('，'));
    expect(ir.namedTokenLimit).toBe(16);
    expect(ir.symbolTokens).toEqual(pieces.slice(0, 16).map(p => p.name));
    expect(ir.omitted.filter(o => o.reason === 'named-token-limit').map(o => o.normalized))
      .toEqual(pieces.slice(16).map(p => p.name));
  });
  it('does not prefer a later code-shaped or quoted ASCII name over an earlier CJK name', () => {
    const first = ['“读取服务”', ...Array.from({ length: 15 }, (_, i) => `layer${i}`)];
    const ir = parseExploreQuery([...first, '`LastService`', '"render"', 'LAST_VALUE'].join(' '));
    expect(ir.symbolTokens).toEqual(['读取服务', ...first.slice(1)]);
    expect(ir.omitted.filter(o => o.reason === 'named-token-limit').map(o => o.normalized))
      .toEqual(['LastService', 'render', 'LAST_VALUE']);
    expect(ir.searchSymbols).toEqual(expect.arrayContaining(['LastService', 'render', 'LAST_VALUE']));
  });
  it('caps the wider lexical candidates at sixty-four in first-appearance order', () => {
    const names = Array.from({ length: 70 }, (_, i) => `Stage${i}Handler`);
    const ir = parseExploreQuery(names.map(name => '`' + name + '`').join(' '));
    expect(ir.symbolTokens).toEqual(names.slice(0, 16));
    expect(ir.searchSymbols).toEqual(names.slice(0, 64));
  });
  it('does not reorder or drop ordinary quoted CJK names below the budget', () => {
    expect(tokens('“当前尚未写入” `ReadStore` 「读取服务」 `写入服务`'))
      .toEqual(['当前尚未写入', 'ReadStore', '读取服务', '写入服务']);
  });
  it('does not invent fragments from slashed bracketed paths', () => {
    const ir = parseExploreQuery('`src/routes/(group)/[id]/+page.svelte`，`renderPage`');
    expect(ir.symbolTokens).toEqual(['renderPage']);
    expect(ir.mentions.find(m => m.kind === 'path')?.normalized).toBe('src/routes/(group)/[id]/+page.svelte');
  });
  it('bounds mention storage and reports truncation', () => {
    const ir = parseExploreQuery(Array.from({ length: 700 }, (_, i) => `Item${i}`).join(' '));
    expect(ir.mentions.length).toBeLessThanOrEqual(512);
    expect(ir.omitted.some(x => x.reason === 'mention-limit')).toBe(true);
    expect(parseExploreQuery(Array.from({ length: 511 }, (_, i) => `Item${i}`).join(' ') + ' file.ts TailName').mentions.length).toBeLessThanOrEqual(512);
  });
});

describe('shared intent in path pinning', () => {
  it.each([
    "Don't modify src/runtime/writer.cpp; it's used by ReaderService",
    "The writer's src/runtime/writer.cpp; reader's ReaderService",
    "The writers' src/runtime/writer.cpp; ReaderService's behavior",
    'Don’t modify src/runtime/writer.cpp; it’s used by ReaderService',
    "Don't modify 'src/runtime/writer.cpp'; it's used by 'ReaderService'",
  ])('does not interpret contractions or possessives as quote wrappers: %s', raw => {
    const ir = parseExploreQuery(raw);
    const result = extractQueryPaths(raw, ['src/runtime/writer.cpp'], { intent: ir });
    expect(result.pinnedFiles).toEqual(['src/runtime/writer.cpp']);
    expect(ir.mentions.find(m => m.kind === 'path')?.normalized).toBe('src/runtime/writer.cpp');
    if (!raw.includes("ReaderService's")) expect(ir.symbolTokens).toContain('ReaderService');
  });
  it('keeps ordinary single-quoted names and internal apostrophes inside quoted paths', () => {
    const raw = "'src/writer's state.cpp' 'ReaderService'";
    const ir = parseExploreQuery(raw);
    expect(extractQueryPaths(raw, ["src/writer's state.cpp"], { intent: ir }).pinnedFiles).toEqual(["src/writer's state.cpp"]);
    expect(ir.symbolTokens).toEqual(['ReaderService']);
    expect(ir.mentions.find(m => m.normalized === 'ReaderService')?.quoted).toBe(true);
  });
  it.each(['`src/runtime/writer.cpp`，检查等待', '“src/runtime/writer.cpp”。检查等待', '【src/runtime/writer.cpp】；检查等待', '(src/runtime/writer.cpp)，检查等待', '[src/runtime/writer.cpp]；检查等待'])('recognizes a path adjacent to CJK punctuation: %s', query => {
    const ir = parseExploreQuery(query);
    expect(queryMightContainPaths(query)).toBe(true);
    expect(extractQueryPaths(ir.pathQuery, ['src/runtime/writer.cpp'], { intent: ir }).pinnedFiles).toEqual(['src/runtime/writer.cpp']);
  });
  it('keeps route groups, bracket segments, line references and quoted path spaces', () => {
    const file = 'src/routes/(secure)/[key]/user page.ts';
    const raw = '`' + file + ':12-24`，检查';
    const ir = parseExploreQuery(raw);
    const result = extractQueryPaths(raw, [file], { intent: ir });
    expect(result.pinnedFiles).toEqual([file]); expect(result.lineAnchors).toEqual([{ file, start: 12, end: 24 }]);
  });
  it('keeps punctuation inside an explicitly quoted filename', () => {
    const file = 'src/记录，说明.ts';
    expect(extractQueryPaths('`' + file + '`，继续', [file]).pinnedFiles).toEqual([file]);
  });
  it('uses the same qualified symbols to disambiguate same-basename files', () => {
    const files = ['src/a/options.ts', 'src/b/options.ts'];
    const raw = '`options.ts`，`ReaderSettings`';
    const ir = parseExploreQuery(raw);
    const seen: string[] = [];
    const result = extractQueryPaths(raw, files, { intent: ir, symbolFiles: symbol => { seen.push(symbol); return symbol === 'ReaderSettings' ? [files[1]!] : []; } });
    expect(result.pinnedFiles).toEqual([files[1]]); expect(seen).toContain('ReaderSettings');
  });
  it.each(['config.ts `render`', 'config.ts “render”', "config.ts 'render'"])(
    'uses an explicitly quoted lowercase name to disambiguate actual definitions: %s', raw => {
      const files = ['src/a/config.ts', 'src/b/config.ts'];
      const ir = parseExploreQuery(raw);
      const seen: string[] = [];
      const result = extractQueryPaths(raw, files, { intent: ir, symbolFiles: symbol => { seen.push(symbol); return symbol === 'render' ? [files[1]!] : []; } });
      expect(result.pinnedFiles).toEqual([files[1]]);
      expect(result.setAsideMatches).toEqual([{ span: 'config.ts', files: [files[0]] }]);
      expect(seen).toEqual(['render']);
    });
  it.each(['config.ts render'])(
    'does not use unquoted prose for basename disambiguation: %s', raw => {
      const files = ['src/a/config.ts', 'src/b/config.ts'];
      const seen: string[] = [];
      const result = extractQueryPaths(raw, files, { intent: parseExploreQuery(raw), symbolFiles: symbol => { seen.push(symbol); return symbol === 'render' ? [files[1]!] : []; } });
      expect(result.pinnedFiles).toEqual(files); expect(seen).not.toContain('render');
    });
  it('checks actual definitions even when prose calls the quoted name proposed', () => {
    const files = ['src/a/config.ts', 'src/b/config.ts'];
    const raw = 'config.ts; Proposed method: `render`';
    const seen: string[] = [];
    const result = extractQueryPaths(raw, files, { intent: parseExploreQuery(raw), symbolFiles: symbol => {
      seen.push(symbol); return symbol === 'render' ? [files[1]!] : [];
    } });
    expect(result.pinnedFiles).toEqual([files[1]]);
    expect(seen).toContain('render');
  });
  it('does not resolve same-basename ambiguity without distinguishing definitions', () => {
    const files = ['src/a/config.ts', 'src/b/config.ts'];
    const raw = 'config.ts `render`';
    for (const definers of [[], files, ['src/unrelated/config.ts']]) {
      const result = extractQueryPaths(raw, files, { intent: parseExploreQuery(raw), symbolFiles: () => definers });
      expect(result.pinnedFiles).toEqual(files); expect(result.setAsideMatches).toEqual([]);
    }
  });
  it('consumes path aliases without losing independent names or their appearance order', () => {
    const query = '`ReaderService.ts`，`ReaderService`；暂拟新字段：`future_state`。';
    const ir = parseExploreQuery(query);
    const result = extractQueryPaths(query, ['src/ReaderService.ts'], { intent: ir });
    expect(result.consumedPathTokens).toEqual(['ReaderService.ts']);
    const consumed = consumeQueryPaths(ir, result.consumedPathTokens!);
    expect(consumed.symbolTokens).toContain('ReaderService');
    expect(consumed.symbolTokens).toContain('future_state');
    expect(consumed.searchQuery).not.toContain('ReaderService.ts');
    expect(consumed.raw).toBe(query);
    for (const m of consumed.mentions) expect(query.slice(m.start, m.end)).toBe(m.raw);
    expect(consumed.omitted).toContainEqual({ normalized: 'ReaderService.ts', reason: 'path-consumed' });
    expect(consumeQueryPaths(parseExploreQuery('ReaderService.ts'), ['ReaderService.ts']).symbolTokens).toEqual([]);
    const both = parseExploreQuery('FirstService.ts SecondService.ts independentName');
    expect(consumeQueryPaths(consumeQueryPaths(both, ['FirstService.ts']), ['SecondService.ts']).symbolTokens).toEqual(['independentName']);
  });
  it('refunds a consumed path alias slot to the next eligible target', () => {
    const ir = parseExploreQuery('ReaderService.ts `loadRecord` `closeStore`', { maxNamedTokens: 2 });
    const consumed = consumeQueryPaths(ir, ['ReaderService.ts']);
    expect(consumed.symbolTokens).toEqual(['loadRecord', 'closeStore']);
  });
  it('leaves an unresolved natural-language slash phrase available to retrieval', () => {
    const raw = 'input/output behavior';
    expect(extractQueryPaths(raw, ['src/read.ts']).strippedQuery).toBe(raw);
  });
});
