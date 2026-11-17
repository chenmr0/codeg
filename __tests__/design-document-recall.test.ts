import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import CodeGraph from '../src';
import { ReferenceResolver } from '../src/resolution';
import { createUpstreamExploreGraph } from '../src/mcp/upstream-explore-adapter';
import { loadTermMappings, type TermMappingRule } from '../src/term-mappings';
import { designSeedIds } from '../src/design-recall';

const cli = path.resolve(__dirname, '../dist/bin/codegraph.js');
let root: string, graph: CodeGraph | undefined;
const macros = ['REDUCEBIN_ALD_INFO_LOG1', 'REDUCEBIN_ALD_ERROR_LOG1',
  'REDUCEBIN_ALDPXY_INFO_LOG1', 'REDUCEBIN_ALDPXY_ERROR_LOG1'];
const descriptions = ['中心层信息日志', '中心层错误日志', '适配层信息日志', '适配层错误日志'];
const doc = [
  '### 日志记录机制与接口', '', 'ALD模块使用REDUCEBIN日志记录接口，日志宏定义`ald_logcode.h`中：', '',
  ...macros.map((m, i) => '- `' + m.slice(0, -1) + '*`：' + descriptions[i]),
  '', '**PID初始化函数**：', '', '- 中心层`aldCorePidInit()`', '- 适配层`aldprxyPidInit()`',
  '', '### 自处理任务', '', '- 扫描超时定时器`aldScanTimeoutProc()`',
  '', '### 信号量', '', '- **ALD_SCAN_MUTEX**：保护扫描队列',
].join('\n');

function write(relative: string, value: string) {
  const filename = path.join(root, relative);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, value);
}
function command(...args: string[]) {
  return execFileSync(process.execPath, ['--liftoff-only', cli, ...args], {
    cwd: root, timeout: 60000, stdio: 'pipe', env: { ...process.env, CI: '1', CODEGRAPH_NO_DAEMON: '1' },
  });
}
const active = () => path.join(graph!.getDataDirectory(), 'term-mappings.json');
const rules = (): TermMappingRule[] => JSON.parse(fs.readFileSync(active(), 'utf8')).rules;
function seeds(query: string) {
  const db = graph!.getExploreQueryConnection();
  return designSeedIds(db, query, loadTermMappings(graph!.getDataDirectory())).map(id => db.prepare('SELECT name,file_path FROM nodes WHERE id=?').get(id));
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-design-'));
  write('ald/include/ald_logcode.h', macros.map(m => '#define ' + m + '(msg) log(msg)').join('\n') + '\n');
  write('ald/ald.c', 'int aldScanTimeoutProc(void){return 1;}\nint aldCorePidInit(void){return 2;}\nint aldprxyPidInit(void){return 3;}\n#define ALD_SCAN_MUTEX 42\n');
});
afterEach(async () => {
  graph?.close(); await graph?.whenIdle(); graph = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

it('generates mappings only on explicit CLI sync and recalls the documented ALD definitions', async () => {
  execFileSync('git', ['init', '-q'], { cwd: root });
  write('ald/Design.md', doc);
  write('other/ald_logcode.h', '#define REDUCEBIN_ALD_INFO_LOG_OTHER(msg) msg\n');
  write('ald/unrelated.h', '#define REDUCEBIN_ALD_INFO_LOG_WRONG(msg) msg\n');
  write('other/Design.md', '- 不相关词语 `REDUCEBIN_ALD_INFO_LOG_OTHER`');
  write('.gitignore', 'other/Design.md\n');
  expect(command('init', root).toString()).not.toContain('Term mappings:');
  graph = CodeGraph.openSync(root);
  expect(fs.existsSync(active())).toBe(false);
  command('sync', root);
  expect(fs.existsSync(active())).toBe(false);
  command('sync', root, '--regenerate-term-mappings');
  expect(fs.existsSync(path.join(graph.getDataDirectory(), 'review'))).toBe(false);
  const db = graph.getExploreQueryConnection();
  expect(db.prepare('SELECT value FROM project_metadata WHERE key=?').get('explore:design-documents-v1')).toBeUndefined();
  expect(rules()).toContainEqual({ terms: ['中心层信息日志'], symbols: [macros[0]],
    design: { document: 'ald/Design.md', documentLine: 5 } });
  expect(command('explore', '增加一条中心层信息日志').toString()).toContain('REDUCEBIN_ALD_INFO_LOG1');
  expect(seeds('不相关词语')).toEqual([]);
  for (let i = 0; i < descriptions.length; i++) {
    const query = '增加一条' + descriptions[i];
    expect(seeds(query)).toEqual([{ name: macros[i], file_path: 'ald/include/ald_logcode.h' }]);
    const context = await createUpstreamExploreGraph(graph).findRelevantContext(query);
    expect([...context.nodes.values()].some(n => n.name === macros[i] && n.filePath === 'ald/include/ald_logcode.h')).toBe(true);
  }
  expect(seeds('中心层需要补一条信息级日志').map(row => row.name)).toEqual([macros[0]]);
  expect(seeds('扫描超时定时器').map(row => row.name)).toContain('aldScanTimeoutProc');
  expect(seeds('中心层PID初始化函数').map(row => row.name)).toContain('aldCorePidInit');
  expect(seeds('保护扫描队列').map(row => row.name)).toContain('ALD_SCAN_MUTEX');
  expect(seeds('增加一条日志')).toEqual([]);
  expect(seeds('完全无关的业务请求')).toEqual([]);
  expect(graph.getFiles().some(f => f.path.endsWith('.md'))).toBe(false);
}, 90000);

it('resolves symbols across source moves within a module and skips ambiguous bindings', async () => {
  const header = 'ald/include/ald_logcode.h';
  const source = '#define REDUCEBIN_ALD_INFO_LOG1(msg) msg\n#define REDUCEBIN_ALD_INFO_LOG2(msg) msg\n';
  write(header, source);
  write('ald/Design.md', doc);
  write('ald-other/ald_logcode.h', source);
  graph = await CodeGraph.init(root, { index: true });
  await graph.sync({ regenerateTermMappings: true });
  const symbols = ['REDUCEBIN_ALD_INFO_LOG1', 'REDUCEBIN_ALD_INFO_LOG2'];
  expect(rules()).toContainEqual({ terms: ['中心层信息日志'], symbols,
    design: { document: 'ald/Design.md', documentLine: 5 } });
  write('ald/include/moved.h', source);
  fs.unlinkSync(path.join(root, header));
  await graph.sync({ adaptive: false });
  expect(seeds('中心层信息日志')).toEqual(symbols.map(name => ({ name, file_path: 'ald/include/moved.h' })));

  write(header, '#define REDUCEBIN_ALD_INFO_LOG1(msg) msg\n#define REDUCEBIN_ALD_INFO_LOG3(msg) msg\n');
  await graph.sync({ adaptive: false });
  expect(seeds('中心层信息日志').map(row => row.name)).toEqual([symbols[1]]);
  await graph.sync({ regenerateTermMappings: true });
  expect(rules()).toContainEqual({ terms: ['中心层信息日志'], symbols: ['REDUCEBIN_ALD_INFO_LOG3'],
    design: { document: 'ald/Design.md', documentLine: 5 } });
});

it.each([false, true])('discovers uppercase DESIGN.md on sync of an existing project (git=%s)', async useGit => {
  if (useGit) execFileSync('git', ['init', '-q'], { cwd: root });
  write('beqm/src/device.c', 'int deviceInit(void) { return 1; }\n');
  command('init', root);

  write('ald/DESIGN.md', doc);
  write('beqm/DESIGN.md', '- 设备初始化`deviceInit()`');
  command('sync', root);
  graph = CodeGraph.openSync(root);
  expect(fs.existsSync(active())).toBe(false);
  command('sync', root, '--regenerate-term-mappings');
  expect(rules()).toContainEqual({
    terms: ['中心层信息日志'], symbols: [macros[0]], design: { document: 'ald/DESIGN.md', documentLine: 5 },
  });
  expect(rules()).toContainEqual({
    terms: ['设备初始化'], symbols: ['deviceInit'], design: { document: 'beqm/DESIGN.md', documentLine: 1 },
  });
}, 90000);

it('preserves manual edits during sync and replaces them only on explicit regeneration', async () => {
  graph = await CodeGraph.init(root, { index: true });
  const ordinary = async () => [...(await createUpstreamExploreGraph(graph!).findRelevantContext('aldCorePidInit')).nodes.keys()];
  const baseline = await ordinary();
  expect(baseline.length).toBeGreaterThan(0);
  expect(fs.existsSync(active())).toBe(false);
  await graph.sync({ regenerateTermMappings: true });
  expect(rules()).toEqual([]);
  const manual = JSON.stringify({ rules: [{ terms: ['自定义业务'], symbols: ['aldCorePidInit'] }] });
  fs.writeFileSync(active(), manual);
  fs.utimesSync(active(), 123456789, 123456789);
  const stamp = fs.statSync(active()).mtimeMs;
  // A plain sync must not even parse the new document.
  const design = path.join(root, 'ald/Design.md');
  fs.writeFileSync(design, Buffer.from([0xff, 0xfe]));
  command('sync');
  expect(() => command('sync', '--regenerate-term-mappings')).toThrow();
  expect(fs.readFileSync(active(), 'utf8')).toBe(manual);
  expect(fs.statSync(active()).mtimeMs).toBe(stamp);
  expect(fs.readdirSync(graph.getDataDirectory()).filter(name => name.endsWith('.tmp'))).toEqual([]);

  write('ald/Design.md', '- `REDUCEBIN_ALD_INFO_LOG*`：日志打印模块初始化');
  const result = await graph.sync();
  expect(result.filesAdded + result.filesModified + result.filesRemoved).toBe(0);
  expect(fs.statSync(active()).mtimeMs).toBe(stamp);
  expect(command('sync', '-q', '--regenerate-term-mappings').toString()).toBe('');
  expect(rules()).toEqual([{ terms: ['日志打印模块初始化'], symbols: [macros[0]],
    design: { document: 'ald/Design.md', documentLine: 1 } }]);
  expect(command('explore', '日志打印模块是怎样的').toString()).toContain(macros[0]);

  const generated = fs.readFileSync(active());
  write('ald/include/ald_logcode.h', '#define REDUCEBIN_ALD_INFO_LOG_NEW(msg) msg\n');
  await graph.sync({ adaptive: false });
  expect(fs.readFileSync(active())).toEqual(generated);
  expect(seeds('日志打印模块是怎样的')).toEqual([]);
  await graph.sync({ regenerateTermMappings: true });
  expect(seeds('日志打印模块是怎样的').map(row => row.name)).toEqual(['REDUCEBIN_ALD_INFO_LOG_NEW']);
  fs.unlinkSync(design);
  await graph.sync();
  expect(seeds('日志打印模块是怎样的')).toHaveLength(1);
  await graph.sync({ regenerateTermMappings: true });
  expect(rules()).toEqual([]);
  expect(await ordinary()).toEqual(baseline);
  fs.unlinkSync(active());
  await graph.sync();
  expect(fs.existsSync(active())).toBe(false);
}, 90000);

it('preserves a manual configuration across a published rebuild and regenerates from the next published index', async () => {
  const built = require('../dist') as typeof import('../src');
  const argv = process.execArgv;
  process.execArgv = ['--liftoff-only'];
  try {
    write('ald/Design.md', '- `logOriginal()`：日志打印模块初始化');
    const source = 'ald/log.c';
    write(source, 'int logOriginal(void) { return 0; }');
    graph = await built.CodeGraph.init(root, { index: true });
    const manual = '{"rules":[{"terms":["手工术语"],"symbols":["logOriginal"]}]}';
    fs.writeFileSync(active(), manual);
    fs.utimesSync(active(), 123456789, 123456789);
    const stamp = fs.statSync(active()).mtimeMs;
    const adaptiveFallback = { minChangedFiles: 1, minChangedFraction: 0.01, minWorkFraction: 0.01 };
    write(source, 'int logAfterFirstBuild(void) { return 10; }');
    expect((await graph.sync({ adaptiveFallback })).adaptive?.strategy).toBe('rebuild');
    expect(fs.readFileSync(active(), 'utf8')).toBe(manual);
    expect(fs.statSync(active()).mtimeMs).toBe(stamp);
    write(source, 'int logAfterSecondBuild(void) { return 123; }');
    write('ald/Design.md', '- `logAfterSecondBuild()`：日志打印模块初始化');
    expect((await graph.sync({ adaptiveFallback, regenerateTermMappings: true })).adaptive?.strategy).toBe('rebuild');
    expect(rules()).toEqual([{ terms: ['日志打印模块初始化'], symbols: ['logAfterSecondBuild'],
      design: { document: 'ald/Design.md', documentLine: 1 } }]);
  } finally { process.execArgv = argv; }
}, 90000);

it('defers document reads and generation errors until explicitly requested', async () => {
  const design = 'ald/Design.md';
  write(design, 'a'.repeat(1024 * 1024 + 1));
  graph = await CodeGraph.init(root, { index: true });
  expect(graph.getIndexCompleteness().status).toBe('complete');
  expect(fs.existsSync(active())).toBe(false);
  await graph.sync();
  expect(fs.existsSync(active())).toBe(false);
  await expect(graph.sync({ regenerateTermMappings: true })).rejects.toThrow(/Design document exceeds 1 MiB/);
  write(design, doc);
  await graph.sync({ regenerateTermMappings: true });
  expect(seeds('中心层信息日志').map(row => row.name)).toEqual([macros[0]]);
}, 90000);

it('keeps physical Markdown lines across reference definitions, code fences, repeated entries, nested lists and table rows', async () => {
  const entry = '- `aldCorePidInit()`：中心层初始化';
  const input = [
    '[link]: /unrelated', '', '~~~md', entry, '~~~', '', // 1–6
    entry, entry, '  - 扫描超时`aldScanTimeoutProc()`', '', // 7–10
    '| 函数 | 说明 |', '| --- | --- |', '| `aldCorePidInit()` | 核心初始化 |',
    '| `aldprxyPidInit()` | 代理初始化 |',
  ];
  write('ald/DESIGN.md', input.join('\r\n'));
  graph = await CodeGraph.init(root, { index: true });
  await graph.sync({ regenerateTermMappings: true });
  const positions = () => rules().map(rule => [rule.symbols[0], rule.design?.document, rule.design?.documentLine]);
  const expected = [
    ['aldCorePidInit', 'ald/DESIGN.md', 7], ['aldCorePidInit', 'ald/DESIGN.md', 8],
    ['aldScanTimeoutProc', 'ald/DESIGN.md', 9], ['aldCorePidInit', 'ald/DESIGN.md', 13],
    ['aldprxyPidInit', 'ald/DESIGN.md', 14],
  ];
  expect(positions()).toEqual(expected);
  write('ald/DESIGN.md', '\r\n' + input.join('\r\n'));
  await graph.sync({ regenerateTermMappings: true });
  expect(positions()).toEqual(expected.map(([symbol, document, line]) => [symbol, document, Number(line) + 1]));
});

it('requires local evidence: accepts explicit typed labels, rejects concepts, counterexamples and ambiguous definitions', async () => {
  write('beqm/bbutop_common.h', 'enum CTRLTOP_PORT_CONFIG_STATUS_ENUM { NOT_SET, SET };\nstruct DeviceObject { int id; };\n');
  write('beqm/old.c', 'static int duplicated(void){return 1;}\n');
  write('beqm/new.c', 'static int duplicated(void){return 2;}\n');
  write('beqm/design.md', [
    '### 2.1.2 关键枚举类型  **端口配置状态 (CTRLTOP_PORT_CONFIG_STATUS_ENUM)** - bbutop_common.h',
    '', '- 定义端口的配置状态（未配置、已配置、配置失败等）',
    '', '### 设备结构', '', '- **设备对象（Device Object）**：表示物理设备，包含设备编号',
    '- 这段描述提到 `DeviceObject` 只是一个示例',
    '- `DeviceObject`：请勿使用该类型进行密钥轮换',
    '- `duplicated()`：识别拓扑节点',
    '- `absentIdentifier()`：报表管理',
    '', '| 接口 | 用途 |', '|---|---|', '| `DeviceObject` | 设备属性查询 |',
  ].join('\n'));
  graph = await CodeGraph.init(root, { index: true });
  await graph.sync({ regenerateTermMappings: true });
  const expected = { name: 'CTRLTOP_PORT_CONFIG_STATUS_ENUM', file_path: 'beqm/bbutop_common.h' };
  expect(seeds('端口配置状态')).toContainEqual(expected);
  expect(seeds('未配置、已配置、配置失败')).toContainEqual(expected);
  expect(seeds('设备属性查询').map(s => s.name)).toEqual(['DeviceObject']);
  for (const query of ['设备编号', '只是一个示例', '密钥轮换', '识别拓扑节点', '报表管理']) expect(seeds(query)).toEqual([]);
  const report = JSON.parse(command('mappings', 'preview', 'beqm/design.md', '--json').toString());
  expect(report.mappings).toContainEqual(expect.objectContaining({
    document: 'beqm/design.md', documentLine: 3, reference: expected.name, evidence: expect.stringContaining('配置失败') }));
  expect(report.mappings.some((entry: { evidence: string }) => entry.evidence.includes('Device Object'))).toBe(false);
  expect(rules().find(rule => rule.symbols.includes(expected.name))?.design).toEqual({ document: 'beqm/design.md', documentLine: 1 });
});

it('previews the current draft against an explicit module without changing Explore bindings', async () => {
  write('ald/Design.md', doc);
  write('other/ald_logcode.h', '#define REDUCEBIN_ALD_INFO_LOG_OTHER(msg) msg\n');
  graph = await CodeGraph.init(root, { index: true });
  await graph.sync({ regenerateTermMappings: true });
  const original = seeds('中心层信息日志');
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-preview-'));
  try {
    const draft = path.join(external, '设计草稿.md');
    const text = '- `REDUCEBIN_ALD_INFO_LOG*`：业务接入追踪';
    fs.writeFileSync(draft, text);
    const exported = path.join(external, 'term-mappings.json');
    const report = JSON.parse(command('mappings', 'preview', draft, '--path', path.join(root, 'ald'), '--output', exported, '--json').toString());
    expect(JSON.parse(fs.readFileSync(exported, 'utf8')).rules).toEqual([
      { terms: ['业务接入追踪'], symbols: [macros[0]], design: { document: draft, documentLine: 1 } },
    ]);
    expect(() => command('mappings', 'preview', draft, '--path', path.join(root, 'ald'), '--output', exported)).toThrow();
    expect(report).toMatchObject({ module: 'ald', mappings: [{ reference: 'REDUCEBIN_ALD_INFO_LOG*',
      evidence: text, definitions: [{ name: macros[0], file: 'ald/include/ald_logcode.h', line: 1 }] }] });
    write('ald/Design.md', text);
    const preview = command('mappings', 'preview', 'ald/Design.md', '--path', root).toString();
    expect(preview).toContain('ald/Design.md:1');
    expect(preview).toContain(text);
    expect(preview).toContain('ald/include/ald_logcode.h:1');
    expect(preview).toContain(macros[0]);
    expect(seeds('中心层信息日志')).toEqual(original);
    expect(seeds('业务接入追踪')).toEqual([]);
    fs.writeFileSync(draft, '文档只谈业务概念，没有代码引用。');
    expect(JSON.parse(command('mappings', 'preview', draft, '--json').toString()).mappings).toEqual([]);
  } finally { fs.rmSync(external, { recursive: true, force: true }); }
}, 90000);

it('explains the same named symbols and real mapped candidates for text and a requirement file', async () => {
  write('ald/DESIGN.md', '- `REDUCEBIN_ALD_INFO_LOG*`：中心层信息日志');
  write('ald/include/log2.h', '#define log2 1\n');
  graph = await CodeGraph.init(root, { index: true });
  await graph.sync({ regenerateTermMappings: true });
  const config = [...rules(), { terms: ['进程启动', '启动进程'], symbols: [macros[0], 'aldCorePidInit', 'MissingSymbol'] }];
  fs.writeFileSync(active(), JSON.stringify({ rules: config }));
  const query = '进程启动时，在 aldCorePidInit() 和 FutureLogHook() 增加一条中心层信息日志';
  write('需求.md', query);
  const plain = command('explore', query).toString();
  const explained = command('explore', query, '--explain').toString();
  expect(command('explore', '--explain', '--query-file', '需求.md').toString()).toBe(explained);
  expect(explained.endsWith(plain)).toBe(true);
  const detail = explained.slice(0, -plain.length);
  expect(detail).toContain('原文提到的符号（索引已确认）：aldCorePidInit\n');
  expect(detail).toContain('原文中的标识符（索引未确认）：FutureLogHook\n');
  expect(detail).toContain('进程启动（手工短语匹配） → REDUCEBIN_ALD_INFO_LOG1、aldCorePidInit\n');
  expect(detail).toContain('中心层信息日志（文档相似匹配，ald/DESIGN.md:1） → REDUCEBIN_ALD_INFO_LOG1\n');
  expect(detail).not.toContain('MissingSymbol');
  expect(detail).not.toContain('启动进程');
  const noHit = command('explore', '--explain', '查看 ald/include/log2.h 与未来业务目标').toString();
  expect(noHit).toContain('原文提到的符号（索引已确认）：无\n');
  expect(noHit).toContain('命中的术语 → 召回候选符号\n无\n');
}, 90000);

it('explains fuzzy document matches even if their definitions are ambiguous or missing', async () => {
  write('ald/duplicate.h', '#define REDUCEBIN_ALD_INFO_LOG1(msg) msg\n');
  graph = await CodeGraph.init(root, { index: true });
  const term = '日志打印模块初始化';
  const design = { document: 'ald/Design.md', documentLine: 4 };
  fs.writeFileSync(active(), JSON.stringify({ rules: [
    { terms: [term, '风扇过热'], symbols: [macros[0], 'MissingSymbol', 'aldScanTimeoutProc'], design },
    { terms: [term, '风扇过热'], symbols: [macros[0]], design: { ...design, documentLine: 8 } },
  ] }));
  const query = '日志打印模块是怎样的';
  const plain = command('explore', query).toString();
  const explained = command('explore', '--explain', query).toString();
  expect(explained.endsWith(plain)).toBe(true);
  const detail = explained.slice(0, -plain.length);
  expect(detail).toContain('原文提到的符号（索引已确认）：无');
  expect(detail).toContain('日志打印模块初始化（文档相似匹配，ald/Design.md:4） → aldScanTimeoutProc\n');
  expect(detail).toContain('日志打印模块初始化（文档相似匹配，ald/Design.md:8） → 无候选\n');
  expect(detail).not.toMatch(/风扇过热|MissingSymbol|REDUCEBIN_ALD_INFO_LOG1/);
}, 90000);

it('reports only admitted symbols when manual and document rules share the candidate budget', async () => {
  const names = Array.from({ length: 41 }, (_, n) => 'ALD_BUDGET_' + n);
  write('ald/include/budget.h', names.map(name => '#define ' + name + ' 1').join('\n'));
  graph = await CodeGraph.init(root, { index: true });
  const term = '预算查询';
  const design = { document: 'ald/DESIGN.md', documentLine: 1 };
  fs.writeFileSync(active(), JSON.stringify({ rules: [
    { terms: [term], symbols: names.slice(0, 16) },
    { terms: [term], symbols: names.slice(16, 40), design },
    { terms: [term], symbols: names.slice(40), design: { ...design, documentLine: 2 } },
  ] }));
  const plain = command('explore', term).toString();
  const explained = command('explore', '--explain', term).toString();
  expect(explained.endsWith(plain)).toBe(true);
  const detail = explained.slice(0, -plain.length);
  expect(detail).toContain('（手工短语匹配） → ' + names.slice(0, 16).join('、') + '\n');
  expect(detail).toContain('ald/DESIGN.md:1） → ' + names.slice(16, 24).join('、') + '\n');
  expect(detail).toContain('ald/DESIGN.md:2） → 无候选\n');
}, 90000);

it.each([2, 4])('lists the admitted file and line for each same-named manual candidate (total=%i)', async total => {
  for (let i = 1; i <= total; i++) {
    write('ald/part' + i + '.c', '\n'.repeat(i) + 'static int sameName(void) { return ' + i + '; }\n');
  }
  graph = await CodeGraph.init(root, { index: true });
  fs.writeFileSync(active(), JSON.stringify({ rules: [{ terms: ['设备状态查询'], symbols: ['sameName'] }] }));
  const query = '设备状态查询';
  const plain = command('explore', query).toString();
  const explained = command('explore', query, '--explain').toString();
  expect(explained.endsWith(plain)).toBe(true);
  const detail = explained.slice(0, -plain.length);
  const expected = total === 2 ? '2/2：ald/part1.c:2、ald/part2.c:3' : '3/4：ald/part1.c:2、ald/part2.c:3、ald/part3.c:4';
  expect(detail).toContain('设备状态查询（手工短语匹配） → sameName（同名候选 ' + expected + '）\n');
  expect(detail).not.toContain('ald/part4.c');
}, 90000);

it('preserves the previous mappings on incomplete source sync and regenerates after recovery', async () => {
  write('ald/Design.md', doc);
  graph = await CodeGraph.init(root, { index: true });
  const manual = JSON.stringify({ rules: [{ terms: ['手工条目'], symbols: ['aldCorePidInit'] }] });
  fs.writeFileSync(active(), manual);
  fs.utimesSync(active(), 123456789, 123456789);
  const stamp = fs.statSync(active()).mtimeMs;
  fs.appendFileSync(path.join(root, 'ald/ald.c'), '\nint changedForSync(void) { return 7; }\n');
  const fault = vi.spyOn(ReferenceResolver.prototype, 'synthesizeIncrementalCCpp')
    .mockRejectedValueOnce(new Error('injected C/C++ synthesis failure'));
  try {
    await expect(graph.sync({ adaptive: false, regenerateTermMappings: true })).rejects.toThrow('require a complete sync');
    expect(fault).toHaveBeenCalled();
    expect(graph.getIndexCompleteness().status).toBe('incomplete');
    expect(fs.readFileSync(active(), 'utf8')).toBe(manual);
    expect(fs.statSync(active()).mtimeMs).toBe(stamp);
  } finally { fault.mockRestore(); }
  expect((await graph.sync({ adaptive: false, regenerateTermMappings: true })).complete).toBe(true);
  expect(rules()).toContainEqual(expect.objectContaining({ terms: [descriptions[0]], symbols: [macros[0]] }));
}, 90000);
