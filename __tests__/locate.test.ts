import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { CodeGraph } from '../src';
import { extractLocateDocument, isExcluded } from '../src/locate/signals';
import { locateIssue, readLocateDocument } from '../src/locate';
import { boundLocateOutput, countLocateTokens } from '../src/locate/output';
import { emptyLocateResult, type LocateResult } from '../src/locate/types';

describe('locate document anchors', () => {
  it('keeps provenance, ignores locals and distinguishes intent from verified code', () => {
    const doc = extractLocateDocument('需要 `Capture::save`。\n本次不修改 `Movie::record`。\n\n### 伪代码\n```text\nCapture::imaginary(frame)\n```\n### 改动草案\n```cpp\nauto result = save(frame);\nif (result.success) notify(result.reason);\n```');
    expect(doc.signals.find(s => s.text === 'Capture::save')?.mentions[0]?.origin).toBe('prose');
    expect(isExcluded(doc.signals.find(s => s.text === 'Movie::record')!)).toBe(true);
    expect(doc.signals.find(s => s.text === 'Capture::imaginary')?.mentions[0]?.origin).toBe('pseudocode');
    expect(doc.signals.find(s => s.text === 'save')?.mentions[0]?.origin).toBe('draft');
    expect(doc.signals.map(s => s.text)).not.toContain('success');
    expect(doc.signals.map(s => s.text)).not.toContain('result');
  });

  it('does not treat negative requirements as scope exclusions', () => {
    const doc = extractLocateDocument('`Capture::save` 不能忽略写入错误，也不能误报成功。');
    expect(isExcluded(doc.signals[0]!)).toBe(false);
    const contrast = extractLocateDocument('本次不修改 `Movie::record`，但需要改 `Capture::save`。');
    expect(isExcluded(contrast.signals[0]!)).toBe(true);
    expect(isExcluded(contrast.signals[1]!)).toBe(false);
  });

  it('deduplicates repeated identifiers and bounds a noisy document', () => {
    const doc = extractLocateDocument(Array.from({ length: 200 }, (_, i) => '`Symbol_' + i + '`').join('\n') + '\n`Symbol_0`');
    expect(doc.signals.length).toBe(64);
    expect(doc.truncated).toBe(true);
    expect(doc.signals.filter(s => s.text === 'Symbol_0')).toHaveLength(1);
  });

  it('extracts the mixed Chinese MAME sample without local draft fields', () => {
    const doc = extractLocateDocument(fs.readFileSync(path.resolve('docs/examples/locate/mame-snapshot-feedback.md'), 'utf8'));
    for (const symbol of ['video_manager::record_frame', 'running_machine::schedule_save']) {
      expect(isExcluded(doc.signals.find(s => s.text === symbol)!)).toBe(true);
    }
    expect(doc.snippets.map(s => s.origin)).toEqual(['pseudocode', 'code', 'code', 'draft']);
    expect(doc.signals.map(s => s.text)).not.toContain('result.success');
    expect(doc.signals.map(s => s.text)).not.toContain('snapshot');
    expect(doc.signals.map(s => s.text)).not.toContain('category');
  });
});

describe('locate exact token budgets', () => {
  function largeResult(): LocateResult {
    const result = emptyLocateResult({ projectPath: '中文项目', document: { signals: [], snippets: [], truncated: false }, timeoutMs: 45000, maxCandidates: 10, maxTokens: 1100, maxTokensPerClue: 260 });
    result.candidates = Array.from({ length: 10 }, (_, i) => ({
      symbol: `Capture::save${i}`, kind: 'method', filePath: 'src/截图.cpp', startLine: 10, endLine: 50, score: 90 - i,
      confidence: 'high' as const, role: 'direct' as const, signature: 'void save();', tokens: 0, truncated: false,
      evidence: [{ kind: 'definition' as const, clue: `Capture::save${i}`, documentLine: 3, sourceLine: 10 }],
      source: Array.from({ length: 40 }, (_, n) => `${n}\t保存中文字符和 emoji 😀; \\"quoted\\"; <|endoftext|>`).join('\n'),
    }));
    return result;
  }
  for (const format of ['json', 'text'] as const) it(`caps actual ${format} output and each candidate`, () => {
    const { result, output } = boundLocateOutput(largeResult(), format);
    expect(countLocateTokens(output)).toBe(result.budget.outputTokens);
    expect(result.budget.outputTokens).toBeLessThanOrEqual(1100);
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.partial).toBe(true);
    for (const candidate of result.candidates) {
      expect(countLocateTokens(JSON.stringify(candidate))).toBeLessThanOrEqual(260);
      expect(candidate.tokens).toBeLessThanOrEqual(260);
    }
    if (format === 'json') expect(JSON.parse(output).experimental).toBe(true);
  });
});

describe('indexed locate integration', () => {
  let root: string;
  const oldEnv = process.env.CODEGRAPH_EXPERIMENTAL_LOCATE;
  const cpp = `namespace util { bool write_png() { return true; } }
class Capture {
public:
  void save_snapshot() {
    shared_accessor();
    bool error = util::write_png();
    if (error) { const char *message = "Error generating PNG for snapshot"; }
  }
  void save_active() { shared_accessor(); save_snapshot(); }
  void record_frame() { save_snapshot(); }
  int shared_accessor() { return 1; }
};
class Other { public: void save_snapshot() {} };
`;
  const document = '需要完善 `Capture::save_active` 和 `Capture::save_snapshot` 的截图反馈。\n本次不修改 `Capture::record_frame`。\n旧笔记提到 `SnapshotNotificationService`。\n### 代码摘录\n```cpp\nbool error = util::write_png();\nif (error) { const char *message = "Error generating PNG for snapshot"; }\n```\n### 改动草案\n```cpp\nauto result = Capture::save_snapshot();\nif (result.success) notify(result.reason);\n```';
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-locate-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src/capture.cpp'), cpp);
    const cg = await CodeGraph.init(root, { index: false });
    try { await cg.indexAll(); } finally { cg.destroy(); }
    delete process.env.CODEGRAPH_EXPERIMENTAL_LOCATE;
  }, 60000);
  afterAll(() => {
    if (oldEnv === undefined) delete process.env.CODEGRAPH_EXPERIMENTAL_LOCATE; else process.env.CODEGRAPH_EXPERIMENTAL_LOCATE = oldEnv;
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('finds current exact definitions, excludes scope noise and reports missing names', async () => {
    const result = await locateIssue(root, document);
    const names = result.candidates.map(c => c.symbol);
    expect(names.some(n => n.endsWith('Capture::save_snapshot'))).toBe(true);
    expect(names.some(n => n.endsWith('Capture::save_active'))).toBe(true);
    expect(names.some(n => n.includes('Other'))).toBe(false);
    expect(names.some(n => n.endsWith('record_frame'))).toBe(false);
    expect(names.some(n => n.endsWith('shared_accessor'))).toBe(false);
    expect(result.clues.find(c => c.text === 'SnapshotNotificationService')?.status).toBe('index_miss');
    expect(result.notes.some(n => n.includes('void'))).toBe(true);
    expect(result.candidates.some(c => c.evidence.some(e => e.kind === 'snippet'))).toBe(true);
    const save = result.candidates.find(c => c.symbol.endsWith('Capture::save_snapshot'))!;
    expect(save.source.split('\n')[0]).toMatch(new RegExp(`^${save.startLine}\\t`));
    expect(save.source.split('\n').at(-1)).toMatch(new RegExp(`^${save.endLine}\\t`));
    expect(save.evidence.some(e => e.documentText?.includes('截图反馈'))).toBe(true);
    expect(result.stats.graphEdges).toBeGreaterThan(0);
    expect(countLocateTokens(JSON.stringify(result) + '\n')).toBeLessThanOrEqual(result.budget.maxTokens);
  }, 20000);

  it('interrupts worker work at a deadline and supports pre-cancellation', async () => {
    const timed = await locateIssue(root, document, { timeoutMs: 1 });
    expect(timed.partial).toBe(true);
    expect(timed.stopReasons).toContain('deadline');
    const aborted = await locateIssue(root, document, { signal: AbortSignal.abort() });
    expect(aborted.stopReasons).toContain('cancelled');
    const controller = new AbortController();
    const pending = locateIssue(root, document, { signal: controller.signal });
    controller.abort();
    expect((await pending).stopReasons).toContain('cancelled');
  });

  it('locates explicit paths with and without a source line', async () => {
    for (const text of ['请检查 `src/capture.cpp:5`。', '请检查 `src/capture.cpp`。']) {
      const result = await locateIssue(root, text);
      expect(result.candidates.some(c => c.filePath === 'src/capture.cpp')).toBe(true);
    }
  });

  it('does not turn repeated document references into extra ranking evidence', async () => {
    const once = await locateIssue(root, '需要修改 `Capture::save_snapshot`。');
    const repeated = await locateIssue(root, '需要修改 `Capture::save_snapshot`。\n'.repeat(50));
    expect(repeated.candidates.map(c => [c.symbol, c.score])).toEqual(once.candidates.map(c => [c.symbol, c.score]));
  });

  it('rejects invalid inputs and ignores the retired environment switch', async () => {
    await expect(locateIssue(path.join(root, 'src'), document)).rejects.toThrow('index missing');
    await expect(locateIssue(root, ' ')).rejects.toThrow('empty');
    await expect(locateIssue(root, document, { maxTokens: 512, maxTokensPerClue: 900 })).rejects.toThrow('must not exceed');
    process.env.CODEGRAPH_EXPERIMENTAL_LOCATE = '0';
    try { expect((await locateIssue(root, document)).candidates.length).toBeGreaterThan(0); }
    finally { delete process.env.CODEGRAPH_EXPERIMENTAL_LOCATE; }
  });

  it('accepts document files and rejects oversized or invalid UTF-8 input', () => {
    const file = path.join(root, 'issue.md');
    fs.writeFileSync(file, document);
    expect(readLocateDocument(file)).toBe(document);
    fs.writeFileSync(file, Buffer.alloc(128 * 1024 + 1));
    expect(() => readLocateDocument(file)).toThrow('128 KiB');
    fs.writeFileSync(file, Buffer.from([0xff]));
    expect(() => readLocateDocument(file)).toThrow();
  });

  it('CLI is available without a switch, enforces XOR input, and outputs file/text results to stdout', () => {
    const cli = path.resolve('dist/bin/codegraph.js');
    const run = (args: string[], legacySwitch?: string, cwd = root) => {
      const env = { ...process.env };
      delete env.CODEGRAPH_EXPERIMENTAL_LOCATE;
      if (legacySwitch !== undefined) env.CODEGRAPH_EXPERIMENTAL_LOCATE = legacySwitch;
      return spawnSync(process.execPath, ['--liftoff-only', cli, ...args], {
        cwd, encoding: 'utf8', timeout: 15000, windowsHide: true, env,
      });
    };
    expect(run(['--help']).stdout).toMatch(/\n\s+locate/);
    expect(run(['--help'], '0').stdout).toMatch(/\n\s+locate/);
    expect(run(['locate', '--file', 'x', '--text', 'y']).status).toBe(1);
    fs.writeFileSync(path.join(root, 'issue.md'), document);
    // The documented minimal command resolves the indexed project from the cwd.
    const direct = run(['locate', '--file', 'issue.md', '--json']);
    expect(direct.status, direct.stderr).toBe(0);
    expect(JSON.parse(direct.stdout).candidates.length).toBeGreaterThan(0);
    // A nested cwd finds the nearest indexed parent; even a legacy "0" has no effect.
    const nested = run(['locate', '--file', '../issue.md', '--json'], '0', path.join(root, 'src'));
    expect(nested.status, nested.stderr).toBe(0);
    expect(JSON.parse(nested.stdout).candidates.length).toBeGreaterThan(0);
    for (const input of [['--file', path.join(root, 'issue.md')], ['--text', document]]) {
      const output = run(['locate', ...input, '--path', root, '--json', '--max-tokens', '1800', '--max-tokens-per-clue', '400']);
      expect(output.status, output.stderr).toBe(0);
      const result = JSON.parse(output.stdout);
      expect(result.candidates.length).toBeGreaterThan(0);
      expect(countLocateTokens(output.stdout)).toBeLessThanOrEqual(1800);
      expect(countLocateTokens(output.stdout)).toBe(result.budget.outputTokens);
    }
    for (const verbose of [false, true]) {
      const output = run(['locate', '--text', document, '--path', root, '--max-tokens', '1800', '--max-tokens-per-clue', '400', ...(verbose ? ['--verbose'] : [])]);
      expect(output.status, output.stderr).toBe(0);
      expect(output.stdout).toContain('# 需求相关源码上下文');
      expect(output.stdout).toContain('## 已预取源码');
      expect(output.stdout.includes('文档原文')).toBe(verbose);
      expect(output.stdout.includes('## 调试信息')).toBe(verbose);
      expect(output.stdout.includes('score=')).toBe(verbose);
      expect(countLocateTokens(output.stdout)).toBeLessThanOrEqual(1800);
      expect(output.stdout).not.toMatch(/输出 \d+\/\d+ tokens/);
    }
  }, 40000);

  it('does not present stale source locations as verified candidates', async () => {
    const file = path.join(root, 'src/capture.cpp');
    fs.writeFileSync(file, '\n' + cpp);
    try {
      const result = await locateIssue(root, document);
      expect(result.candidates).toHaveLength(0);
      expect(result.stopReasons).toContain('stale_source_content');
    } finally { fs.writeFileSync(file, cpp); }
  });
});
