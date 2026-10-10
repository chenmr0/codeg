import { describe, expect, it } from 'vitest';
import { boundLocateOutput, countLocateTokens } from '../src/locate/output';
import { candidateGuide, clueText } from '../src/locate/guide';
import { emptyLocateResult, type LocateCandidate, type LocateResult } from '../src/locate/types';

function fixture(): LocateResult {
  const result = emptyLocateResult({ projectPath: 'project', document: { signals: [], snippets: [], truncated: false },
    timeoutMs: 45000, maxCandidates: 10, maxTokens: 6000, maxTokensPerClue: 1500 });
  const first: LocateCandidate = {
    symbol: 'Capture::save', kind: 'method', filePath: 'src/capture.cpp', startLine: 10, endLine: 15, score: 90,
    confidence: 'high', role: 'direct', source: '10\tvoid Capture::save() {\n11\t  // capture\n12\t  prepare();\n13\t  write();', tokens: 0, truncated: true,
    evidence: [{ kind: 'definition', clue: 'Capture::save', documentLine: 3, sourceLine: 10, documentText: '需要让 `Capture::save` 报告保存失败。' },
      { kind: 'graph', clue: 'Capture::write', documentLine: 3, sourceLine: 13, sourceFile: 'src/capture.cpp', fromSymbol: 'Capture::save', toSymbol: 'Capture::write', relationKind: 'calls' }],
  };
  const second: LocateCandidate = { ...first, symbol: 'Capture::write', startLine: 12, score: 80,
    evidence: [{ kind: 'definition', clue: 'Capture::write', documentLine: 3, sourceLine: 12, documentText: first.evidence[0]!.documentText }, first.evidence[1]!],
    source: '12\t  prepare();\n13\t  write();\n14\t  finish();\n15\t}' };
  const third: LocateCandidate = { ...first, symbol: 'Capture::report', startLine: 30, endLine: 60,
    evidence: [{ kind: 'definition', clue: 'Capture::report', documentLine: 5, sourceLine: 30 }],
    source: '30\tvoid Capture::report() {\n31\t  notify();' };
  result.candidates = [first, second, third];
  result.clues = [
    { text: 'Capture::save', status: 'verified', documentLine: 3, origin: 'prose' },
    { text: 'Movie::record', status: 'out_of_scope', documentLine: 7, origin: 'prose' },
    { text: 'ImaginaryService', status: 'index_miss', documentLine: 9, origin: 'draft' },
    { text: 'UI_CAPTURE', status: 'source_match', documentLine: 2, origin: 'prose', filePath: 'src/ui.cpp', sourceLine: 8 },
  ];
  result.notes = ['文档第 10 行的草案接收返回值，但当前定义返回 void。'];
  result.partial = true; result.stopReasons = ['neighbor_limit'];
  return result;
}

describe('locate prefetched source context', () => {
  it('puts source first, deduplicates shared lines and marks exact missing ranges', () => {
    const { output, result } = boundLocateOutput(fixture(), 'text');
    expect(output).toContain('# 需求相关源码上下文');
    expect(output).toContain('已预取 8 行当前源码，覆盖 1 个文件中的 3 个相关定义');
    expect(output.indexOf('```cpp')).toBeLessThan(output.indexOf('## 相关调用与关系'));
    expect(output).not.toContain('## 需求与源码对应');
    expect(output).not.toContain('文档原文');
    expect(output).not.toContain('建议优先阅读');
    expect(output.match(/13\t  write\(\);/g)).toHaveLength(1);
    expect(output.match(/### `src\/capture.cpp`/g)).toHaveLength(1);
    expect(output).toContain('已提供行：10–15、30–31。');
    expect(output).toContain('...（中间行未展示）...');
    // Overlap from a second candidate completes the first one's displayed span.
    expect(output).not.toContain('尚未提供 14–15 行');
    expect(output).toContain('已提供 30–31 行；尚未提供 32–60 行，可按需补查');
    expect(output).not.toContain('不要重新读取');
    expect(output).not.toContain('score=');
    expect(output).not.toContain('confidence=');
    expect(output).not.toContain('neighbor_limit');
    expect(output).not.toContain('邻居数量达到上限');
    expect(output).not.toContain('预取范围说明');
    expect(output).not.toContain('本次结果不完整');
    expect(output).not.toContain('无需因此重复调用 `locate`');
    expect(output).toContain('`codegraph_node`（`symbol`、`file`、`includeCode: true`）');
    expect(output).toContain('`codegraph_search`（`query` 仅填符号名，`includeCode: "if_unique"`）');
    expect(output).toContain('建议使用codegraph进一步按需查询');
    expect(output).not.toContain('预算是上限，无需用满');
    expect(output).not.toContain('o200k_base');
    expect(output).toContain('索引未命中，不证明源码不存在');
    expect(output).toContain('按文档范围排除');
    expect(output).toContain('当前定义返回 void');
    expect(countLocateTokens(output)).toBe(result.budget.outputTokens);
  });

  it('keeps document excerpts and ranking diagnostics in verbose output only', () => {
    const { output } = boundLocateOutput(fixture(), 'text', true);
    expect(output).toContain('需要让 `Capture::save` 报告保存失败。');
    expect(output.match(/文档原文（第 3 行）/g)).toHaveLength(1);
    expect(output.indexOf('## 匹配依据（详细）')).toBeGreaterThan(output.indexOf('```cpp'));
    expect(output).toContain('score=');
  });

  it('does not present retained positions as already provided source', () => {
    const input = fixture();
    input.candidates.forEach(c => { c.source = ''; });
    const { output } = boundLocateOutput(input, 'text');
    expect(output).toContain('已预取 0 行当前源码，覆盖 0 个文件中的 0 个相关定义');
    expect(output).toContain('本次仅保留位置线索，未提供源码');
    expect(output).toContain('尚未提供 10–15 行');
    expect(output).not.toContain('## 已预取源码');
  });

  it('uses structured edge direction, merges duplicate sites, and labels heuristic evidence', () => {
    const result = fixture();
    result.candidates[0]!.evidence[1]!.provenance = 'heuristic';
    result.candidates[0]!.evidence[1]!.detail = 'incorrect legacy prose must not determine direction';
    const output = boundLocateOutput(result, 'text').output;
    expect(output.match(/`Capture::save` → `Capture::write`/g)).toHaveLength(1);
    expect(output).toContain('调用，推断关系');
    expect(output).toContain('src/capture.cpp:13');
    expect(output).not.toContain('incorrect legacy prose');
    expect(output).not.toContain('已确认完整调用链');
  });

  it('closes source fences even when source contains markdown fences', () => {
    const result = fixture();
    result.candidates[0]!.source = '10\tconst char *text = "```";\n11\treturn;';
    const output = boundLocateOutput(result, 'text').output;
    expect(output).toContain('````cpp');
    const fences = output.split('\n').filter(l => /^`{3,}(?:\w+)?$/.test(l));
    expect(fences).toHaveLength(2);
    expect(fences[0]!.match(/^`+/)![0]).toBe(fences[1]);
  });

  it('does not substitute a definition location when a graph edge has no call-site line', () => {
    const result = fixture();
    result.candidates[0]!.evidence[1]!.sourceLine = 0;
    const output = boundLocateOutput(result, 'text').output;
    expect(output).toContain('索引未记录调用行');
    expect(output).not.toContain('src/capture.cpp:0');
  });

  for (const format of ['text', 'json'] as const) for (const verbose of [false, true]) {
    it(`enforces both token limits for ${format}, verbose=${verbose}`, () => {
      const input = fixture(); input.budget.maxTokens = 512; input.budget.maxTokensPerClue = 260;
      const { result, output } = boundLocateOutput(input, format, verbose);
      expect(result.candidates.length).toBeGreaterThan(0);
      expect(countLocateTokens(output)).toBeLessThanOrEqual(512);
      expect(countLocateTokens(output)).toBe(result.budget.outputTokens);
      if (result.budget.omittedCandidates || result.budget.omittedClues) expect(result.stopReasons).toContain('output_token_limit');
      for (const candidate of result.candidates) {
        expect(countLocateTokens(JSON.stringify(candidate))).toBeLessThanOrEqual(260);
        expect(countLocateTokens(candidateGuide(candidate))).toBeLessThanOrEqual(260);
      }
      for (const clue of result.clues) expect(countLocateTokens(clueText(clue))).toBeLessThanOrEqual(260);
      if (format === 'json') expect(JSON.parse(output).backend).toBe('index+source');
      else {
        expect(output.includes('## 调试信息')).toBe(verbose);
        expect(output.includes('score=')).toBe(verbose);
        const fences = output.split('\n').filter(l => /^`{3,}(?:\w+)?$/.test(l));
        expect(fences.length % 2).toBe(0);
      }
      const again = boundLocateOutput(result, format, verbose);
      expect(again.output).toBe(output);
    });
  }
});
