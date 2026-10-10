import type { LocateCandidate, LocateEvidence, LocateResult } from './types';

function inline(text: string): string {
  const value = text.replace(/[\r\n]+/g, ' ');
  const longest = Math.max(0, ...(value.match(/`+/g) ?? []).map(s => s.length));
  const fence = '`'.repeat(longest + 1);
  const pad = value.startsWith('`') || value.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${value}${pad}${fence}`;
}

export function sourceLines(candidate: LocateCandidate): Map<number, string> {
  const lines = new Map<number, string>();
  for (const text of candidate.source.split('\n')) {
    const match = /^(\d+)\t(.*)$/.exec(text);
    if (match && Number(match[1]) >= candidate.startLine && Number(match[1]) <= candidate.endLine) {
      lines.set(Number(match[1]), match[2]!);
    }
  }
  return lines;
}

function ranges(numbers: number[]): string {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const spans: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const first = sorted[i]!;
    let last = first;
    while (sorted[i + 1] === last + 1) { i++; last++; }
    spans.push(first === last ? String(first) : `${first}–${last}`);
  }
  return spans.join('、');
}

function position(candidate: LocateCandidate): string {
  return `${candidate.filePath}:${candidate.startLine}-${candidate.endLine}`;
}

function evidenceText(evidence: LocateEvidence, candidate: LocateCandidate): string | undefined {
  const at = inline(`${evidence.sourceFile ?? candidate.filePath}:${evidence.sourceLine}`);
  switch (evidence.kind) {
    case 'definition': return `文档第 ${evidence.documentLine} 行提到 ${inline(evidence.clue)}，精确匹配此定义${evidence.detail ? `；${evidence.detail}` : ''}。`;
    case 'path': return `文档第 ${evidence.documentLine} 行的路径 ${inline(evidence.clue)} 定位到此处。`;
    case 'snippet': return `文档第 ${evidence.documentLine} 行起的代码节选与 ${at} 附近源码匹配（${evidence.clue}）。`;
    case 'literal': return `文档第 ${evidence.documentLine} 行的字符串 ${inline(evidence.clue)} 出现在 ${at}。`;
    case 'source_anchor': return `文档第 ${evidence.documentLine} 行的 ${inline(evidence.clue)} 在 ${at} 原文命中；未当作独立符号定义。`;
    default: return undefined;
  }
}

function candidateMapping(candidate: LocateCandidate, rank: number, quotedLines?: Set<number>): string {
  const lines = [`${rank}. ${inline(candidate.symbol)} — ${inline(position(candidate))}`];
  const direct = candidate.evidence.filter(e => e.kind !== 'graph');
  const evidence = direct.length ? direct : candidate.evidence.slice(0, 1);
  for (const item of evidence) {
    const text = evidenceText(item, candidate);
    if (text) lines.push(`   - ${text}`);
    else lines.push(`   - 由文档第 ${item.documentLine} 行线索 ${inline(item.clue)} 的索引关系扩展得到，非文档直接命中。`);
  }
  const quote = candidate.evidence.find(e => e.documentText && !quotedLines?.has(e.documentLine));
  if (quote) {
    lines.push(`   - 文档原文（第 ${quote.documentLine} 行）：${inline(quote.documentText!)}`);
    quotedLines?.add(quote.documentLine);
  }
  return lines.join('\n');
}

function relations(candidates: LocateCandidate[], restrictToSelected: boolean): string[] {
  const selected = new Set(candidates.map(c => c.symbol));
  const grouped = new Map<string, { e: LocateEvidence; lines: number[] }>();
  for (const candidate of candidates) for (const e of candidate.evidence) {
    if (e.kind !== 'graph' || !e.fromSymbol || !e.toSymbol || !e.sourceFile || !e.relationKind) continue;
    if (restrictToSelected && (!selected.has(e.fromSymbol) || !selected.has(e.toSymbol))) continue;
    const key = JSON.stringify([e.fromSymbol, e.toSymbol, e.sourceFile, e.relationKind, e.provenance]);
    const group = grouped.get(key) ?? { e, lines: [] };
    if (e.sourceLine > 0) group.lines.push(e.sourceLine);
    grouped.set(key, group);
  }
  const labels: Record<string, string> = { calls: '调用', implements: '实现', overrides: '重写' };
  return [...grouped.values()].map(({ e, lines }) =>
    `- ${inline(e.fromSymbol!)} → ${inline(e.toSymbol!)}（${labels[e.relationKind!] ?? e.relationKind}${e.provenance === 'heuristic' ? '，推断关系' : ''}；${inline(lines.length ? `${e.sourceFile}:${ranges(lines)}` : e.sourceFile!)}${lines.length ? '' : '，索引未记录调用行'}）`);
}

function sourceBlock(filePath: string, candidates: LocateCandidate[]): string {
  const merged = new Map<number, string>();
  for (const candidate of candidates) for (const [line, text] of sourceLines(candidate)) {
    if (!merged.has(line)) merged.set(line, text);
  }
  if (!merged.size) return '';
  const sorted = [...merged].sort((a, b) => a[0] - b[0]);
  const code: string[] = [];
  let previous = 0;
  for (const [line, text] of sorted) {
    if (previous && line > previous + 1) code.push('', '...（中间行未展示）...', '');
    code.push(`${line}\t${text}`); previous = line;
  }
  const body = code.join('\n');
  const fence = '`'.repeat(Math.max(3, 1 + Math.max(0, ...(body.match(/`+/g) ?? []).map(s => s.length))));
  const extension = filePath.split('.').pop()?.toLowerCase() ?? '';
  const lang: Record<string, string> = { cpp: 'cpp', cc: 'cpp', cxx: 'cpp', h: 'cpp', hpp: 'cpp', c: 'c', py: 'python', ts: 'typescript', tsx: 'tsx', js: 'javascript', rs: 'rust', go: 'go', java: 'java', cs: 'csharp', lua: 'lua' };
  const definitions = candidates.map(candidate => {
    const shown = sorted.map(([line]) => line).filter(line => line >= candidate.startLine && line <= candidate.endLine);
    if (!shown.length) return '';
    const full = shown.length === candidate.endLine - candidate.startLine + 1;
    return `- ${inline(candidate.symbol)}：定义 ${candidate.startLine}–${candidate.endLine}；${full ? '已提供完整定义' : `已提供 ${ranges(shown)} 行`}。`;
  }).filter(Boolean);
  return [`### ${inline(filePath)}`, '', definitions.join('\n'), '', `已提供行：${ranges(sorted.map(([line]) => line))}。`, '', `${fence}${lang[extension] ?? 'text'}`, body, fence].join('\n');
}

function coverage(candidate: LocateCandidate, displayed?: Set<number>): string | undefined {
  const shown = displayed ? [...displayed].filter(line => line >= candidate.startLine && line <= candidate.endLine) : [...sourceLines(candidate).keys()];
  if (shown.length === candidate.endLine - candidate.startLine + 1) return undefined;
  const missing: string[] = [];
  let cursor = candidate.startLine;
  for (const line of [...shown].sort((a, b) => a - b)) {
    if (line > cursor) missing.push(cursor === line - 1 ? String(cursor) : `${cursor}–${line - 1}`);
    cursor = line + 1;
  }
  if (cursor <= candidate.endLine) missing.push(cursor === candidate.endLine ? String(cursor) : `${cursor}–${candidate.endLine}`);
  return `- ${inline(candidate.symbol)}（${inline(position(candidate))}）：${shown.length ? `已提供 ${ranges(shown)} 行` : '本次未提供源码'}；尚未提供 ${missing.join('、')} 行，可按需补查。`;
}

export function clueText(clue: LocateResult['clues'][number]): string {
  const origin: Record<string, string> = { prose: '正文', code: '代码块', draft: '草案', pseudocode: '伪代码' };
  const status: Record<string, string> = {
    out_of_scope: '按文档范围排除', index_miss: '索引未命中，不证明源码不存在',
    index_match: '仅索引命中，未作为独立源码线索展开', verified: '定义或位置已核验，未展开为单独条目',
    unverified: '本次未核验', source_match: '仅源码原文命中，未定位为独立定义',
  };
  return `- ${inline(clue.text)}（文档第 ${clue.documentLine} 行，${origin[clue.origin]}）：${status[clue.status]}${clue.filePath && clue.sourceLine ? `；${inline(`${clue.filePath}:${clue.sourceLine}`)}` : ''}。`;
}

const STOP_REASONS: Record<string, string> = {
  deadline: '查询达到时间上限', cancelled: '查询已取消', index_incomplete: '索引尚不完整',
  stale_source_content: '部分源码与索引内容不同，已跳过', stale_source_location: '部分索引位置失效，已跳过', source_unavailable: '部分源码不可读或超出读取范围',
};

/** Conservative per-candidate accounting, even where the guide later merges shared content. */
export function candidateGuide(candidate: LocateCandidate): string {
  return [candidateMapping(candidate, 20), ...relations([candidate], false), sourceBlock(candidate.filePath, [candidate]), coverage(candidate) ?? '',
    `${candidate.symbol}: score=${candidate.score}, confidence=${candidate.confidence}, role=${candidate.role}, tokens<=${candidate.tokens}, truncated=${candidate.truncated}`].join('\n\n');
}

export function renderLocateGuide(result: LocateResult, verbose = false): string {
  const displayed = new Map<string, Set<number>>();
  for (const candidate of result.candidates) {
    const lines = displayed.get(candidate.filePath) ?? new Set<number>();
    for (const line of sourceLines(candidate).keys()) lines.add(line);
    displayed.set(candidate.filePath, lines);
  }
  const lineCount = [...displayed.values()].reduce((sum, lines) => sum + lines.size, 0);
  const fileCount = [...displayed.values()].filter(lines => lines.size).length;
  const definitionCount = result.candidates.filter(c => [...(displayed.get(c.filePath) ?? [])].some(line => line >= c.startLine && line <= c.endLine)).length;
  const sections = ['# 需求相关源码上下文',
    `已预取 ${lineCount} 行当前源码，覆盖 ${fileCount} 个文件中的 ${definitionCount} 个相关定义（实验性功能）。可直接用于分析，减少重复 grep/read；其他代码按需继续查询。仅标明的行范围已提供。`];
  if (result.projectPath) sections.push(`项目：${inline(result.projectPath)}。以下源码路径相对此目录。`);
  if (result.candidates.length) {
    const byFile = new Map<string, LocateCandidate[]>();
    for (const c of result.candidates) { const entries = byFile.get(c.filePath) ?? []; entries.push(c); byFile.set(c.filePath, entries); }
    const blocks = [...byFile].map(([file, candidates]) => sourceBlock(file, candidates)).filter(Boolean);
    if (blocks.length) sections.push('## 已预取源码', ...blocks);
    else sections.push('本次仅保留位置线索，未提供源码；位置和限制见下文。');
    const graph = relations(result.candidates, true);
    if (graph.length) sections.push('## 相关调用与关系', '来自索引的静态关系，不代表完整运行路径。', graph.join('\n'));
  } else sections.push('本次未保留源码或位置线索，请检查下方限制说明。');
  const notes = result.notes.filter(n => !n.startsWith('纯本地规则定位；'));
  if (notes.length) sections.push('## 核验提示', ...notes.map(n => `- ${n}`));
  const excluded = result.clues.filter(c => c.status === 'out_of_scope');
  const missed = result.clues.filter(c => c.status === 'index_miss');
  if (excluded.length || missed.length) {
    sections.push('## 其他查询结果');
    if (excluded.length) sections.push(`按文档范围排除：${excluded.map(c => `${inline(c.text)}（文档 ${c.documentLine} 行）`).join('、')}。`);
    if (missed.length) sections.push(`索引未命中，不证明源码不存在：${missed.map(c => `${inline(c.text)}（文档 ${c.documentLine} 行）`).join('、')}。`);
  }
  const supplementary = result.clues.filter(c => c.status === 'unverified' || (c.status === 'source_match' &&
    (!c.filePath || !c.sourceLine || !displayed.get(c.filePath)?.has(c.sourceLine))));
  if (supplementary.length) sections.push('## 补充命中与待核验', supplementary.map(clueText).join('\n'));
  const omitted = result.candidates.map(c => coverage(c, displayed.get(c.filePath))).filter((s): s is string => !!s);
  const stops = result.stopReasons.map(r => STOP_REASONS[r]).filter(Boolean);
  sections.push('## 未覆盖范围');
  if (omitted.length) sections.push(omitted.join('\n'));
  else if (result.candidates.length) sections.push('上述候选的完整定义均已提供；其他源码尚未预取。');
  if (stops.length) sections.push(`查询状态：${stops.join('；')}。`);
  if (result.budget.omittedCandidates || result.budget.omittedClues) sections.push(`因输出预算省略 ${result.budget.omittedCandidates} 条源码候选、${result.budget.omittedClues} 条文档线索记录。`);
  sections.push('建议使用codegraph进一步按需查询，已知符号和文件用 `codegraph_node`（`symbol`、`file`、`includeCode: true`）；尚未定位的符号用 `codegraph_search`（`query` 仅填符号名，`includeCode: "if_unique"`）。');
  if (verbose) {
    const quoted = new Set<number>();
    sections.push('## 匹配依据（详细）', result.candidates.map((c, i) => candidateMapping(c, i + 1, quoted)).join('\n\n'));
    sections.push('## 调试信息', `检索耗时 ${result.stats.elapsedMs} ms；查询 ${result.stats.searchedClues} 条线索；检查 ${result.stats.examinedNodes} 个节点、${result.stats.graphEdges} 条边、${result.stats.readFiles} 个文件。`,
      result.candidates.map(c => `- ${inline(c.symbol)}：score=${c.score}, confidence=${c.confidence}, role=${c.role}, tokens<=${c.tokens}, truncated=${c.truncated}`).join('\n'));
  }
  return sections.join('\n\n') + '\n';
}
