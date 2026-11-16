import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import CodeGraph from '../src';
import { createUpstreamExploreGraph } from '../src/mcp/upstream-explore-adapter';
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
function seeds(query: string) {
  const db = graph!.getExploreQueryConnection();
  return designSeedIds(db, query).map(id => db.prepare('SELECT name,file_path FROM nodes WHERE id=?').get(id));
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

it('indexes module documentation through the built CLI and recalls the documented ALD definitions in Explore', async () => {
  execFileSync('git', ['init', '-q'], { cwd: root });
  write('ald/Design.md', doc);
  write('other/ald_logcode.h', '#define REDUCEBIN_ALD_INFO_LOG_OTHER(msg) msg\n');
  write('ald/unrelated.h', '#define REDUCEBIN_ALD_INFO_LOG_WRONG(msg) msg\n');
  write('other/Design.md', '- 不相关词语 `REDUCEBIN_ALD_INFO_LOG_OTHER`');
  write('.gitignore', 'other/Design.md\n');
  command('init', root);
  graph = CodeGraph.openSync(root);
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

it('updates on document-only sync, symbol changes, and deletion while preserving ordinary Explore', async () => {
  graph = await CodeGraph.init(root, { index: true });
  const ordinary = async () => [...(await createUpstreamExploreGraph(graph!).findRelevantContext('aldCorePidInit')).nodes.keys()];
  const baseline = await ordinary();
  expect(baseline.length).toBeGreaterThan(0);
  expect(seeds('中心层信息日志')).toEqual([]);
  write('ald/Design.md', doc);
  graph.close(); await graph.whenIdle(); graph = undefined;
  command('sync');
  graph = CodeGraph.openSync(root);
  expect(seeds(descriptions[0]!).map(row => row.name)).toEqual([macros[0]]);
  write('ald/Design.md', '- `REDUCEBIN_ALD_INFO_LOG*`：链路握手追踪');
  const result = await graph.sync();
  expect(result.filesAdded + result.filesModified + result.filesRemoved).toBe(0);
  expect(seeds(descriptions[0]!)).toEqual([]);
  expect(seeds('链路握手追踪').map(row => row.name)).toEqual([macros[0]]);
  write('ald/include/ald_logcode.h', '#define REDUCEBIN_ALD_INFO_LOG_NEW(msg) msg\n');
  await graph.sync({ adaptive: false });
  expect(seeds('链路握手追踪').map(row => row.name)).toEqual(['REDUCEBIN_ALD_INFO_LOG_NEW']);
  fs.unlinkSync(path.join(root, 'ald/Design.md'));
  await graph.sync();
  expect(seeds('链路握手追踪')).toEqual([]);
  expect(await ordinary()).toEqual(baseline);
}, 90000);


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
  const expected = { name: 'CTRLTOP_PORT_CONFIG_STATUS_ENUM', file_path: 'beqm/bbutop_common.h' };
  expect(seeds('端口配置状态')).toContainEqual(expected);
  expect(seeds('未配置、已配置、配置失败')).toContainEqual(expected);
  expect(seeds('设备属性查询').map(s => s.name)).toEqual(['DeviceObject']);
  for (const query of ['设备编号', '只是一个示例', '密钥轮换', '识别拓扑节点', '报表管理']) expect(seeds(query)).toEqual([]);
  const db = graph.getExploreQueryConnection();
  const evidence = JSON.parse(db.prepare('SELECT value FROM project_metadata WHERE key=?').get('explore:design-documents-v1').value);
  expect(evidence).toContainEqual(expect.objectContaining({document: 'beqm/design.md', file: expected.file_path,
    symbol: expected.name, evidence: expect.stringContaining('配置失败')}));
  expect(evidence.some((entry: { evidence: string }) => entry.evidence.includes('Device Object'))).toBe(false);
});

it('previews the current draft against an explicit module without changing Explore bindings', async () => {
  write('ald/Design.md', doc);
  write('other/ald_logcode.h', '#define REDUCEBIN_ALD_INFO_LOG_OTHER(msg) msg\n');
  graph = await CodeGraph.init(root, { index: true });
  const original = seeds('中心层信息日志');
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-preview-'));
  try {
    const draft = path.join(external, '设计草稿.md');
    const text = '- `REDUCEBIN_ALD_INFO_LOG*`：业务接入追踪';
    fs.writeFileSync(draft, text);
    const report = JSON.parse(command('mappings', 'preview', draft, '--path', path.join(root, 'ald'), '--json').toString());
    expect(report).toMatchObject({ module: 'ald', mappings: [{ reference: 'REDUCEBIN_ALD_INFO_LOG*',
      evidence: text, definitions: [{ name: macros[0], file: 'ald/include/ald_logcode.h', line: 1 }] }] });
    write('ald/Design.md', text);
    const preview = command('mappings', 'preview', 'ald/Design.md', '--path', root).toString();
    expect(preview).toContain(text);
    expect(preview).toContain('ald/include/ald_logcode.h:1');
    expect(preview).toContain(macros[0]);
    expect(seeds('中心层信息日志')).toEqual(original);
    expect(seeds('业务接入追踪')).toEqual([]);
    fs.writeFileSync(draft, '文档只谈业务概念，没有代码引用。');
    expect(JSON.parse(command('mappings', 'preview', draft, '--json').toString()).mappings).toEqual([]);
  } finally { fs.rmSync(external, { recursive: true, force: true }); }
}, 90000);
