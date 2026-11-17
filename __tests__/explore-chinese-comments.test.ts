import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import CodeGraph from '../src';
import { ToolHandler } from '../src/mcp/tools';
import { matchChineseComments } from '../src/comment-recall';
import { CHINESE_COMMENT_PREFIX } from '../src/types';
import { createDatabase } from '../src/db/sqlite-adapter';
import { scanCppMacroDefinitions } from '../src/extraction/declaration-macros';
import { loadGrammarsForLanguages } from '../src/extraction/grammars';
import { extractFromSource } from '../src/extraction/tree-sitter';

let root: string, graph: CodeGraph | undefined;
const write = (file: string, body: string) => fs.writeFileSync(path.join(root, file), body);
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-zh-comments-')); });
afterEach(async () => {
  graph?.close(); await graph?.whenIdle(); graph = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});
function matches(query: string) {
  const db = graph!.getExploreQueryConnection();
  return matchChineseComments(db, query).map(({comment}) => ({
    name: db.prepare('SELECT name FROM nodes WHERE id=?').get(comment.nodeId)?.name,
    field: comment.field, line: comment.line,
  }));
}

it('returns source for separate requirement clauses in one MCP and CLI Explore', async () => {
  write('send.c', '/* 强制发送完成后等待回包 */\nint zzSubmit(void) { return 731; }\n');
  write('poll.c', 'int zzPoll(void) {\n  // 空队列等待消息唤醒\n  return 947;\n}\n');
  write('misc.c', 'const char *label="忽略字面常量";\n// 独立文件尾部注释\n');
  graph = await CodeGraph.init(root, { index: true });
  const query = '需求：强制发送后等待回包；空队列等待消息唤醒。';
  expect(matches(query)).toEqual(expect.arrayContaining([
    { name: 'zzSubmit', field: 'head', line: 1 }, { name: 'zzPoll', field: 'body', line: 2 },
  ]));
  expect(matches('忽略字面常量')).toEqual([]);
  expect(matches('独立文件尾部注释')).toEqual([]);
  expect(matches('zzSubmit')).toEqual([]);
  const handler = new ToolHandler(graph);
  try {
    const reply = await handler.execute('explore', { query });
    expect(reply.isError).not.toBe(true);
    expect(reply.content[0]?.text).toContain('return 731;');
    expect(reply.content[0]?.text).toContain('return 947;');
  } finally { handler.closeAll(); }
  write('need.md', query);
  const answer = execFileSync(process.execPath, [path.resolve(__dirname, '../dist/bin/codegraph.js'), 'explore',
    '--explain', '--query-file', 'need.md'], { cwd: root, encoding: 'utf8', env: { ...process.env, CODEGRAPH_NO_DAEMON: '1' } });
  expect(answer).toContain('函数头，send.c:1');
  expect(answer).toContain('函数体，poll.c:2');
  expect(answer).toContain('return 947;');
}, 60_000);

it('refreshes retained functions on comment-only edits and clears removed evidence', async () => {
  const source = (text: string) => 'int keep(void) {\n  /* ' + text + ' */\n  return 0;\n}\n';
  write('keep.c', source('队列背压等待'));
  graph = await CodeGraph.init(root, { index: true });
  const target = [{ name: 'keep', field: 'body', line: 2 }];
  expect(matches('背压')).toEqual(target);
  write('keep.c', source('重装备份索引'));
  await graph.sync({ adaptive: false });
  expect(matches('背压')).toEqual([]);
  expect(matches('备份索引')).toEqual(target);
  write('keep.c', source('English only'));
  await graph.sync({ adaptive: false });
  expect(matches('备份索引')).toEqual([]);
  write('keep.c', source('重装备份索引'));
  await graph.sync({ adaptive: false });
  fs.unlinkSync(path.join(root,'keep.c'));
  await graph.sync({ adaptive: false });
  expect(matches('备份索引')).toEqual([]);
  expect(graph.getExploreQueryConnection().prepare('SELECT key FROM project_metadata WHERE key=?').get(CHINESE_COMMENT_PREFIX+'keep.c')).toBeUndefined();
}, 60_000);

it('does not cache rolled-back changes and observes other SQLite writers', () => {
  const file = path.join(root, 'changes.db');
  const { db } = createDatabase(file);
  const { db: writer } = createDatabase(file);
  try {
    db.exec('CREATE TABLE project_metadata(key TEXT PRIMARY KEY, value TEXT)');
    const key = CHINESE_COMMENT_PREFIX + 'gate.c';
    db.prepare('INSERT INTO project_metadata VALUES (?,?)').run(key, JSON.stringify([
      { nodeId: 'gate', field: 'body', line: 2, text: '队列背压等待' },
    ]));
    const hits = () => matchChineseComments(db,'背压').map(match => match.comment.nodeId);
    expect(hits()).toEqual(['gate']);
    expect(() => db.transaction(() => {
      db.prepare('DELETE FROM project_metadata WHERE key=?').run(key);
      expect(hits()).toEqual([]);
      throw Error('rollback');
    })()).toThrow('rollback');
    expect(hits()).toEqual(['gate']);
    writer.prepare('DELETE FROM project_metadata WHERE key=?').run(key);
    expect(hits()).toEqual([]);
  } finally { writer.close(); db.close(); }
});

it('uses the innermost callable, exported function documentation and real Python docstrings', async () => {
  write('nested.ts', '/** 入口检查 */\nexport function outer() {\n  function nested() { /* 独立回退策略 */ return 1; }\n  return nested();\n}\n');
  write('module.py', 'def read_data():\n    """读取结算账单"""\n    value = "交易字符串"\n    return value\n');
  graph = await CodeGraph.init(root,{index:true});
  expect(matches('入口检查')).toEqual([{ name:'outer',field:'head',line:1 }]);
  expect(matches('独立回退策略')).toEqual([{ name:'nested',field:'body',line:3 }]);
  expect(matches('结算账单')).toEqual([{ name:'read_data',field:'head',line:2 }]);
  expect(matches('交易字符串')).toEqual([]);
}, 60_000);

it('keeps a trailing note separate from documentation of the next function', async () => {
  write('api.c', [
    'int marker = 1; // 无关库存标记',
    '// 请求合并规则',
    'int combine(void) { return 11; }',
    'int spare = 2; // 外部队列标记',
    'int idle(void) { return 21; }',
  ].join('\n'));
  graph = await CodeGraph.init(root, { index: true });
  expect(matches('请求合并规则')).toEqual([{ name: 'combine', field: 'head', line: 2 }]);
  expect(matches('无关库存标记')).toEqual([]);
  expect(matches('外部队列标记')).toEqual([]);
}, 60_000);

it('binds primary source comments to final nodes after C++ declaration macro recovery', async () => {
  await loadGrammarsForLanguages(['cpp']);
  const result = extractFromSource('unit.cpp',
    'DECLARE(next)\nint settle() {\n  // 归还备用令牌\n  return 9;\n}\n', 'cpp',
    undefined, undefined, undefined, scanCppMacroDefinitions('#define DECLARE(name) int name();'));
  expect(result.nodes.find(n => n.name === 'next')?.kind).toBe('function');
  expect(result.errors).toEqual([]);
  expect(result.chineseComments).toEqual([{
    nodeId: result.nodes.find(n => n.name === 'settle')!.id, field: 'body', line: 3, text: '// 归还备用令牌',
  }]);
});

it('retains both Python documentation sources and excludes tuple and formatted-string expressions', async () => {
  write('account.py', [
    '# 账户状态入口', 'def settle():', '    ("归还" "备用令牌")', '    return 1',
    'def ordinary():', '    "库存标记",', 'def formatted():', '    f"用户编号{1}"',
  ].join('\n'));
  graph = await CodeGraph.init(root, { index: true });
  expect(matches('账户状态入口')).toEqual([{ name: 'settle', field: 'head', line: 1 }]);
  expect(matches('归还备用令牌')).toEqual([{ name: 'settle', field: 'head', line: 3 }]);
  expect(matches('库存标记')).toEqual([]);
  expect(matches('用户编号')).toEqual([]);
}, 60_000);

it.each(['vue', 'svelte'])('preserves comment locations and owners in two embedded %s scripts', async ext => {
  const file = 'Widget.' + ext;
  write(file, [
    '<script>', '// 设置活跃状态', 'function toggle() { return 1; }', '</script>',
    '<script', ' lang="ts">', 'function toggle() {', '  // 回收过期缓存', '  return 2;', '}', '</script>',
  ].join('\n'));
  graph = await CodeGraph.init(root, { index: true });
  const db = graph.getExploreQueryConnection();
  for (const [query, field, commentLine, fnLine] of [
    ['设置活跃状态', 'head', 2, 3], ['回收过期缓存', 'body', 8, 7],
  ] as const) {
    const hits = matchChineseComments(db, query);
    expect(hits).toHaveLength(1);
    expect(hits[0].comment).toMatchObject({ field, line: commentLine });
    expect(db.prepare('SELECT file_path,start_line FROM nodes WHERE id=?').get(hits[0].comment.nodeId))
      .toMatchObject({ file_path: file, start_line: fnLine });
  }
}, 60_000);

it('shows the matching body comment and neighbouring implementation in an oversized function', async () => {
  const statements = Array.from({ length: 1100 }, (_, i) => '  value += ' + i + '; // arithmetic padding for this example');
  statements.splice(850, 0, '  // 归还备用令牌', '  value *= 913;');
  write('long.c', ['int settle(int value) {', ...statements, '  return value;', '}'].join('\n'));
  graph = await CodeGraph.init(root, { index: true });
  const handler = new ToolHandler(graph);
  try {
    const reply = await handler.execute('explore', { query: '归还备用令牌' });
    expect(reply.isError).not.toBe(true);
    const text = reply.content[0]?.text ?? '';
    expect(text).toMatch(/\d+\t +\/\/ 归还备用令牌/);
    expect(text).toContain('value *= 913;');
    expect(text.length).toBeLessThanOrEqual(25_000);
  } finally { handler.closeAll(); }
}, 60_000);

it('preserves evidence for a second clause when four functions share the first', async () => {
  const repeated = ['first', 'second', 'third', 'fourth'].map(name =>
    '// 临时清理策略\nint ' + name + '(void) { return 1; }');
  write('many.c', [...repeated, 'int recover(void) {\n  // 恢复编码布局和读取设置\n  return 7;\n}'].join('\n'));
  graph = await CodeGraph.init(root, { index: true });
  const hits = matches('临时清理策略；恢复编码布局');
  expect(hits).toHaveLength(4);
  expect(hits.map(hit => hit.name)).toContain('recover');
}, 60_000);
