import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { Node } from '../types';
import { getDatabasePath } from '../db';
import { createDatabase } from '../db/sqlite-adapter';
import { QueryBuilder } from '../db/queries';
import { canonicalQualifiedName, lastQualifierPart, matchesSymbol } from '../search/symbol-match';
import { isExcluded, signalWeight } from './signals';
import { emptyLocateResult, type LocateTask, type LocateResult, type LocateCandidate, type LocateEvidence } from './types';

interface Work { node: Node; score: number; direct: boolean; evidence: LocateEvidence[] }
const MAX_NODES = 200;
const MAX_FILES = 24;
const MAX_EDGES = 400;
const KINDS = new Set(['function', 'method', 'class', 'struct', 'interface', 'enum', 'constant', 'variable', 'type_alias']);
const normalLine = (text: string) => text.trim().replace(/\s+/g, ' ');
const sqlLike = (text: string) => text.replace(/[\\%_]/g, '\\$&');

/** All retrieval starts in the index. Reads only a bounded set of current source files. */
export function runLocate(task: LocateTask, checkpoint: (result: LocateResult) => void): LocateResult {
  const started = performance.now();
  const result = emptyLocateResult(task);
  const dbPath = getDatabasePath(task.projectPath);
  if (!fs.existsSync(dbPath)) throw new Error(`CodeGraph index missing in ${task.projectPath}. Run codegraph init first.`);
  const { db } = createDatabase(dbPath, { readOnly: true });
  const queries = new QueryBuilder(db);
  const work = new Map<string, Work>();
  const source = new Map<string, string[] | null>();
  const matches = new Map<string, Node[]>();
  const excluded = new Set<string>();
  const timedOut = () => {
    if (performance.now() - started < task.timeoutMs - 300) return false;
    if (!result.stopReasons.includes('deadline')) result.stopReasons.push('deadline');
    return true;
  };
  const stop = (reason: string) => { if (!result.stopReasons.includes(reason)) result.stopReasons.push(reason); };
  const readSource = (filePath: string): string[] | null => {
    if (source.has(filePath)) return source.get(filePath)!;
    if (source.size >= MAX_FILES) { stop('source_file_limit'); return null; }
    source.set(filePath, null);
    try {
      const absolute = fs.realpathSync(path.resolve(task.projectPath, filePath));
      const relative = path.relative(task.projectPath, absolute);
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('outside project');
      const stat = fs.statSync(absolute);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('not a bounded source file');
      const content = fs.readFileSync(absolute, 'utf8');
      const indexed = db.prepare('SELECT content_hash FROM files WHERE path = ?').get(filePath);
      if (!indexed || indexed.content_hash !== createHash('sha256').update(content).digest('hex')) {
        stop('stale_source_content'); return null;
      }
      const lines = content.split(/\r?\n/);
      source.set(filePath, lines);
      result.stats.readFiles++;
      return lines;
    } catch { stop('source_unavailable'); return null; }
  };
  const add = (node: Node, score: number, direct: boolean, evidence: LocateEvidence) => {
    if ((!KINDS.has(node.kind) && !(node.kind === 'file' && evidence.kind === 'path')) || excluded.has(node.id)) return;
    let item = work.get(node.id);
    if (!item) {
      if (work.size >= MAX_NODES) { stop('node_limit'); return; }
      item = { node, score, direct, evidence: [] }; work.set(node.id, item);
    }
    item.score = Math.max(item.score, score);
    item.direct ||= direct;
    if (item.evidence.length < 12 && !item.evidence.some(e => e.kind === evidence.kind && e.clue === evidence.clue && e.sourceLine === evidence.sourceLine)) item.evidence.push(evidence);
  };
  const publish = () => {
    result.stats.elapsedMs = Math.round(performance.now() - started);
    result.stats.examinedNodes = work.size;
    result.partial = result.stopReasons.length > 0;
    checkpoint(result);
  };
  try {
    db.exec('PRAGMA query_only = ON');
    // Use one consistent index generation, even if another process is syncing.
    db.exec('BEGIN');
    if (queries.getMetadata('index_completeness') === 'incomplete') {
      stop('index_incomplete'); result.notes.push('索引标记为不完整；未命中不表示源码不存在。');
    }
    if (task.document.truncated) stop('document_clue_limit');
    result.notes.push('纯本地规则定位；代码块来源标签不是真实性判断，置信度表示定位证据强度。索引未命中不等于源码不存在。');
    // SQL limits are applied before materialization, including overloaded/common names.
    const bare = db.prepare('SELECT id FROM nodes WHERE name = ? ORDER BY is_declaration, file_path, start_line LIMIT 65');
    const qualified = db.prepare("SELECT id FROM nodes WHERE name = ? AND (replace(qualified_name, '.', '::') = ? OR replace(qualified_name, '.', '::') LIKE ? ESCAPE '\\') ORDER BY is_declaration, file_path, start_line LIMIT 65");
    for (let i = 0; i < task.document.signals.length; i++) {
      if (timedOut()) break;
      const signal = task.document.signals[i]!;
      if (signal.kind !== 'symbol') continue;
      const name = lastQualifierPart(signal.text);
      const wanted = canonicalQualifiedName(signal.text);
      const rows = name === signal.text ? bare.all(name) : qualified.all(name, wanted, '%::' + sqlLike(wanted));
      if (rows.length > 64) stop('symbol_match_limit');
      const nodes = rows.slice(0, 64).map(row => queries.getNodeById(row.id)).filter((n): n is Node => !!n && matchesSymbol(n, signal.text));
      matches.set(signal.text, nodes);
      result.stats.searchedClues++;
      result.clues[i]!.status = isExcluded(signal) ? 'out_of_scope' : nodes.length ? 'index_match' : 'index_miss';
      if (isExcluded(signal)) nodes.forEach(n => excluded.add(n.id));
    }
    for (const signal of task.document.signals) {
      if (isExcluded(signal) || signal.kind !== 'symbol') continue;
      // A snippet's unqualified spelling corroborates its explicit owner rather than
      // introducing every unrelated same-named method into the candidate pool.
      if (!signal.text.includes('::') && !signal.text.includes('.') && signal.mentions.every(m => m.origin !== 'prose') &&
          task.document.signals.some(s => s.text !== signal.text && s.kind === 'symbol' && !isExcluded(s) &&
            lastQualifierPart(s.text) === signal.text && (matches.get(s.text)?.length ?? 0) > 0)) continue;
      const nodes = matches.get(signal.text) ?? [];
      const weight = signalWeight(signal);
      // Prototype + definition is normal; several implementation owners are ambiguous.
      const owners = new Set(nodes.filter(n => !n.isDeclaration).map(n => n.filePath + ':' + n.qualifiedName));
      const ambiguous = owners.size > 1;
      for (const node of nodes.slice(0, 16)) {
        const base = (signal.text === lastQualifierPart(signal.text) ? 52 : 70) * weight - (ambiguous ? 22 : 0);
        add(node, base, weight >= 0.5, { kind: 'definition', clue: signal.text, documentLine: signal.mentions[0]!.line, sourceLine: node.startLine,
          ...(ambiguous ? { detail: '同名定义有多个候选，需结合其他证据' } : {}) });
      }
    }
    for (const signal of task.document.signals.filter(s => s.kind === 'path' && !isExcluded(s))) {
      const raw = signal.text.replace(/:\d+(?::\d+)?$/, '').replace(/\\/g, '/');
      const file = path.isAbsolute(raw) ? path.relative(task.projectPath, raw).replace(/\\/g, '/') : raw.replace(/^\.\//, '');
      const line = Number(/:(\d+)(?::\d+)?$/.exec(signal.text)?.[1]);
      const rows = line
        ? db.prepare('SELECT id FROM nodes WHERE file_path = ? AND start_line <= ? AND end_line >= ? ORDER BY end_line - start_line LIMIT 4').all(file, line, line)
        : db.prepare("SELECT id FROM nodes WHERE file_path = ? AND kind = 'file' LIMIT 1").all(file);
      for (const row of rows) {
        const node = queries.getNodeById(row.id);
        if (node) add(node, line ? 62 : 50, true, { kind: 'path', clue: signal.text, documentLine: signal.mentions[0]!.line, sourceLine: line || 1 });
      }
    }
    publish();
    // A single bounded graph hop; no fixed-point expansion into common utility hubs.
    const outgoing = db.prepare("SELECT target AS partner, kind, line, provenance FROM edges WHERE source = ? AND kind IN ('calls','implements','overrides') ORDER BY id LIMIT 21");
    const incoming = db.prepare("SELECT source AS partner, kind, line, provenance FROM edges WHERE target = ? AND kind IN ('calls','implements','overrides') ORDER BY id LIMIT 21");
    const seeds = [...work.values()].filter(w => w.direct && !w.node.isDeclaration && w.node.kind !== 'file').sort((a, b) => b.score - a.score).slice(0, 12);
    for (const seed of seeds) {
      if (timedOut() || result.stats.graphEdges >= MAX_EDGES) { if (result.stats.graphEdges >= MAX_EDGES) stop('edge_limit'); break; }
      if (!readSource(seed.node.filePath)) continue;
      for (const [direction, statement] of [['outgoing', outgoing], ['incoming', incoming]] as const) {
        const edges = statement.all(seed.node.id);
        if (edges.length > 20) stop('neighbor_limit');
        for (const edge of edges.slice(0, 20)) {
          if (result.stats.graphEdges >= MAX_EDGES) break;
          result.stats.graphEdges++;
          const node = queries.getNodeById(edge.partner);
          if (!node) continue;
          add(node, 27, false, { kind: 'graph', clue: seed.node.qualifiedName, documentLine: seed.evidence[0]!.documentLine,
            // Zero means the index has no call-site line; never substitute a definition line.
            sourceLine: Number(edge.line) > 0 ? Number(edge.line) : 0,
            sourceFile: direction === 'outgoing' ? seed.node.filePath : node.filePath,
            fromSymbol: direction === 'outgoing' ? seed.node.qualifiedName : node.qualifiedName,
            toSymbol: direction === 'outgoing' ? node.qualifiedName : seed.node.qualifiedName,
            relationKind: edge.kind, provenance: edge.provenance ?? undefined,
            detail: direction === 'outgoing' ? `${seed.node.name} --${edge.kind}--> ${node.name} (${seed.node.filePath})` : `${node.name} --${edge.kind}--> ${seed.node.name} (${node.filePath})` });
        }
      }
    }
    const verified = new Set<string>();
    const ranked: LocateCandidate[] = [];
    const ordered = [...work.values()].sort((a, b) => b.score - a.score || a.node.filePath.localeCompare(b.node.filePath) || a.node.startLine - b.node.startLine);
    for (const item of ordered) {
      if (timedOut()) break;
      const { node } = item;
      const lines = readSource(node.filePath);
      if (!lines) continue;
      // Verify the indexed definition is still at this location; don't pretend stale spans are exact.
      const tail = lastQualifierPart(node.name);
      const head = lines.slice(node.startLine - 1, Math.min(node.endLine, node.startLine + 7)).join('\n');
      if (node.startLine < 1 || node.endLine > lines.length || (node.kind !== 'file' && !head.includes(tail))) { stop('stale_source_location'); continue; }
      for (const evidence of item.evidence.filter(e => e.kind === 'definition' || e.kind === 'path')) verified.add(evidence.clue);
      const body = lines.slice(node.startLine - 1, node.endLine);
      let snippetScore = 0;
      for (const snippet of task.document.snippets) {
        if (snippet.origin !== 'code') continue;
        const useful = snippet.lines.map(normalLine).filter(l => l.length >= 18);
        if (useful.length < 2) continue;
        const normalized = body.map(normalLine);
        let matched = 0;
        let position = -1;
        for (const line of useful) {
          const next = normalized.indexOf(line, position + 1);
          if (next >= 0) { matched++; position = next; }
        }
        if (matched >= 2 && matched / useful.length >= 0.6) {
          snippetScore = 24;
          item.evidence.push({ kind: 'snippet', clue: `${matched}/${useful.length} 行片段匹配`, documentLine: snippet.line, sourceLine: node.startLine + position });
        }
      }
      for (const signal of task.document.signals.filter(s => !isExcluded(s) && signalWeight(s) >= 0.5 &&
        (s.kind === 'literal' || (s.kind === 'symbol' && s.text.length >= 5 && (matches.get(s.text)?.length ?? 0) === 0)))) {
        const escaped = signal.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(signal.kind === 'symbol' ? `(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])` : escaped);
        const line = body.findIndex(l => pattern.test(l));
        if (line >= 0) { snippetScore = Math.max(snippetScore, 16); item.evidence.push({ kind: signal.kind === 'literal' ? 'literal' : 'source_anchor', clue: signal.text, documentLine: signal.mentions[0]!.line, sourceLine: node.startLine + line }); }
      }
      const connections = new Set(item.evidence.filter(e => e.kind === 'graph').map(e => e.clue)).size;
      const functionLike = node.kind === 'function' || node.kind === 'method';
      let score = item.score + snippetScore + Math.min(18, connections * 6) + (functionLike ? 4 : -10);
      if (node.isDeclaration) score -= 24;
      if (functionLike && node.endLine - node.startLine <= 1 && !snippetScore) score -= 8;
      if (/\b(test|tests|__tests__|3rdparty|vendor)\b|\.(test|spec)\./.test(node.filePath)) score -= 18;
      if (!functionLike && node.kind !== 'file' && node.endLine - node.startLine > 80) score -= 25;
      if (!item.direct && connections < 2 && !snippetScore) continue;
      // Shared one-line accessors often connect many seeds without explaining the issue.
      if (!item.direct && !snippetScore && node.endLine - node.startLine <= 1) continue;
      if (score < 38) continue;
      // Prefer a substantive overload to a one-line forwarding/clearing wrapper.
      if (functionLike && node.endLine - node.startLine <= 1 && ordered.some(other => other.node.id !== node.id &&
        other.node.filePath === node.filePath && other.node.qualifiedName === node.qualifiedName && !other.node.isDeclaration &&
        other.node.endLine - other.node.startLine >= 3)) score -= 12;
      const focus = item.evidence.find(e => e.kind === 'snippet' || e.kind === 'literal' || e.kind === 'source_anchor')?.sourceLine ?? node.startLine;
      // Short definitions can fit whole. Long ones get a focused window; the renderer
      // reports exact shown ranges instead of claiming the whole definition was read.
      const whole = body.length <= 80 && body.join('\n').length <= 5000;
      const start = whole ? node.startLine : Math.max(node.startLine, focus - 4);
      const end = whole ? node.endLine : Math.min(node.endLine, start + 15);
      const numbered: string[] = [];
      let sourceChars = 0;
      for (let line = start; line <= end; line++) {
        const text = `${line}\t${lines[line - 1]}`;
        if (sourceChars + text.length + 1 > 6000) break;
        numbered.push(text); sourceChars += text.length + 1;
      }
      ranked.push({ symbol: node.qualifiedName, kind: node.kind, filePath: node.filePath, startLine: node.startLine, endLine: node.endLine,
        score: Math.round(score), confidence: item.direct && (snippetScore > 0 || connections >= 2) ? 'high' : 'medium',
        role: item.direct ? 'direct' : 'related', signature: node.signature,
        evidence: [...item.evidence.filter(e => e.kind !== 'graph'), ...item.evidence.filter(e => e.kind === 'graph')].slice(0, 8),
        source: numbered.join('\n'), tokens: 0, truncated: start !== node.startLine || numbered.length !== body.length });
      // Checkpoints preserve useful results if a later synchronous DB query exceeds the deadline.
      result.candidates = [...ranked].sort((a, b) => b.score - a.score).slice(0, task.maxCandidates);
      publish();
    }
    for (const clue of result.clues) {
      if (clue.status !== 'out_of_scope' && verified.has(clue.text)) clue.status = 'verified';
      if (clue.status !== 'index_miss' && clue.status !== 'unverified') continue;
      const signal = task.document.signals.find(s => s.text === clue.text)!;
      if (signal.kind === 'path') continue;
      const escaped = clue.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(signal.kind === 'symbol' ? `(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])` : escaped);
      for (const [filePath, lines] of source) {
        const line = lines?.findIndex(text => pattern.test(text)) ?? -1;
        if (line >= 0) { clue.status = 'source_match'; clue.filePath = filePath; clue.sourceLine = line + 1; break; }
      }
    }
    ranked.sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine);
    result.candidates = [];
    const counts = new Map<string, number>();
    for (const candidate of ranked) {
      if (result.candidates.some(c => c.filePath === candidate.filePath && c.symbol === candidate.symbol)) continue;
      const count = counts.get(candidate.filePath) ?? 0;
      if (count >= 4 || (!count && counts.size >= 5)) continue;
      counts.set(candidate.filePath, count + 1);
      result.candidates.push(candidate);
      if (result.candidates.length >= task.maxCandidates) break;
    }
    result.files = [...counts.keys()].map(filePath => ({ filePath, symbols: result.candidates.filter(c => c.filePath === filePath).map(c => c.symbol) }));
    checkDraftReturns(task, matches, verified, result);
    publish();
    return result;
  } finally { db.close(); }
}

function checkDraftReturns(task: LocateTask, matches: Map<string, Node[]>, verified: Set<string>, result: LocateResult): void {
  for (const snippet of task.document.snippets.filter(s => s.origin === 'draft')) {
    for (let i = 0; i < snippet.lines.length; i++) {
      const assignment = /\b(?:auto|const|let)\s+\w+\s*=\s*([\w:]+)\s*\(/.exec(snippet.lines[i]!);
      if (!assignment) continue;
      const name = assignment[1]!;
      const qualifiedClues = [...matches.keys()].filter(clue => verified.has(clue) && clue !== lastQualifierPart(clue) && lastQualifierPart(clue) === lastQualifierPart(name));
      const nodes = [...new Map([...matches].filter(([clue]) => verified.has(clue) && (!qualifiedClues.length || qualifiedClues.includes(clue))).flatMap(([, list]) => list)
        .filter(n => !n.isDeclaration && matchesSymbol(n, name)).map(n => [n.id, n])).values()];
      // Only report a signature mismatch when one current implementation is identified.
      if (nodes.length === 1 && (nodes[0]!.returnType === 'void' || /^void\b/.test(nodes[0]!.signature ?? ''))) {
        const n = nodes[0]!;
        result.notes.push(`文档第 ${snippet.line + i} 行草案接收 ${name} 返回值，但匹配定义返回 void（${n.filePath}:${n.startLine}）；局部字段不是已有接口的证据。`);
      }
    }
  }
}
