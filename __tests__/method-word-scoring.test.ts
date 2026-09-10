import { describe, expect, it, vi } from 'vitest';
import { matchMethodCall } from '../src/resolution/name-matcher';
import { ResolutionTextCache, splitNameWords } from '../src/resolution/text-cache';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types';
import type { Language, Node } from '../src/types';

function method(id: string, owner: string, language: Language = 'cpp'): Node {
  return { id, name: 'flush', kind: 'method', qualifiedName: `${owner}::flush`, filePath: 'types.h',
    language, startLine: 1, endLine: 1, startColumn: 0, endColumn: 1, updatedAt: 1 };
}
function reference(receiver: string): UnresolvedRef {
  return { fromNodeId: 'caller', filePath: 'main.cpp', language: 'cpp', referenceName: `${receiver}.flush`,
    referenceKind: 'calls', line: 1, column: 0 };
}
function context(nodes: Node[], normalized = true): ResolutionContext {
  const cache = new ResolutionTextCache();
  return {
    getNodesInFile: () => [], getNodesByName: name => nodes.filter(n => n.name === name),
    getNodesByQualifiedName: () => [], getNodesByKind: () => [], getNodesByLowerName: () => [],
    getAllFiles: () => [], getProjectRoot: () => '/test', getImportMappings: () => [],
    fileExists: () => false, readFile: () => null,
    getNameWords: name => cache.nameWords(name),
    ...(normalized ? { getLowerNameWords: (name: string) => cache.lowerNameWords(name) } : {}),
  };
}

// Frozen pre-optimization scoring rule: a differential oracle for ordering,
// duplicate receiver words, language preference, and the acceptance threshold.
function legacyChoice(nodes: Node[], receiver: string): { id: string; confidence: number } | null {
  const methods = nodes.filter(n => n.kind === 'method' && n.name === 'flush');
  const same = methods.filter(n => n.language === 'cpp');
  const candidates = same.length ? same : methods;
  if (candidates.length === 1 && candidates[0]!.language === 'cpp') return { id: candidates[0]!.id, confidence: 0.7 };
  if (candidates.length < 2) return null;
  const words = splitNameWords(receiver);
  let best: Node | undefined, bestScore = 0;
  for (const candidate of candidates) {
    const classWords = splitNameWords(candidate.qualifiedName);
    const score = words.filter(w => classWords.some(cw => cw.toLowerCase() === w.toLowerCase())).length +
      (candidate.language === 'cpp' ? 1 : 0);
    if (score > bestScore) { best = candidate; bestScore = score; }
  }
  return best && bestScore >= 2 ? { id: best.id, confidence: 0.65 } : null;
}

describe('method word scoring', () => {
  it('matches legacy decisions for candidate order, language fallback and repeated words', () => {
    const corpus = [method('a', 'Audio'), method('b', 'AudioWriter'), method('c', 'Writer::Audio'),
      method('d', 'HTTPServer'), method('e', 'Other'), method('f', 'AudioWriter', 'typescript'),
      method('g', 'Other', 'java'), { ...method('field', 'AudioWriter'), kind: 'field' as const }];
    for (const receiver of ['audio', 'audioWriter', 'audioAudio', 'HTTPServer', 'obj.audioWriter', 'x', 'unrelated']) {
      for (let mask = 0; mask < 1 << corpus.length; mask++) {
        const selected = corpus.filter((_, i) => mask & 1 << i);
        if (mask % 2) selected.reverse();
        const expected = legacyChoice(selected, receiver);
        for (const normalized of [false, true]) {
          const result = matchMethodCall(reference(receiver), context(selected, normalized));
          expect(result ? { id: result.targetNodeId, confidence: result.confidence } : null).toEqual(expected);
          if (result) expect(result.resolvedBy).toBe('instance-method');
        }
      }
    }
  });

  it('stops at the first maximum score and retains the first tied candidate', () => {
    const nodes = [method('first', 'AudioWriter'), method('tied', 'Other::AudioWriter'),
      ...Array.from({ length: 1000 }, (_, i) => method(`other-${i}`, `Other${i}`))];
    const ctx = context(nodes);
    const words = vi.fn(ctx.getLowerNameWords!);
    ctx.getLowerNameWords = words;
    expect(matchMethodCall(reference('audioWriter'), ctx)?.targetNodeId).toBe('first');
    expect(words.mock.calls.map(([name]) => name)).toEqual(['audioWriter', 'AudioWriter::flush']);
  });

  it('keeps looking when a later candidate can score higher', () => {
    expect(matchMethodCall(reference('audioWriter'), context([
      method('partial', 'Audio'), method('full', 'AudioWriter'), method('tie', 'Other::AudioWriter'),
    ]))?.targetNodeId).toBe('full');
  });

  it('keeps duplicate receiver words as separate score contributions', () => {
    const result = matchMethodCall(reference('audioAudio'), context([
      method('match', 'Audio', 'java'), method('other', 'Other', 'typescript'),
    ]));
    expect(result?.targetNodeId).toBe('match');
    expect(result?.confidence).toBe(0.65);
  });

  it('uses the same-language candidate before a stronger cross-language overlap', () => {
    const result = matchMethodCall(reference('audioWriter'), context([
      method('foreign', 'AudioWriter', 'java'), method('local', 'Other'),
    ]));
    expect(result?.targetNodeId).toBe('local');
    expect(result?.confidence).toBe(0.7);
  });

  it('notices changed candidate names and ordering on warm text-cache lookups', () => {
    const nodes = [method('first', 'AudioWriter'), method('second', 'Writer::Audio')];
    const ctx = context(nodes);
    expect(matchMethodCall(reference('audioWriter'), ctx)?.targetNodeId).toBe('first');
    nodes.reverse();
    expect(matchMethodCall(reference('audioWriter'), ctx)?.targetNodeId).toBe('second');
    nodes[0]!.qualifiedName = 'Other::flush';
    expect(matchMethodCall(reference('audioWriter'), ctx)?.targetNodeId).toBe('first');
  });
});
