import { describe, expect, it } from 'vitest';
import { sliceLines } from '../src/resolution/source-lines';

function originalSliceLines(content: string, startLine?: number, endLine?: number): string | null {
  if (!startLine || !endLine) return null;
  return content.split('\n').slice(startLine - 1, endLine).join('\n');
}

describe('sliceLines', () => {
  it.each([
    ['one line', 'first', 1, 1, 'first'],
    ['inclusive line bounds', 'first\nsecond\nthird', 1, 2, 'first\nsecond'],
    ['middle line', 'first\nsecond\nthird', 2, 2, 'second'],
    ['last line without a final LF', 'first\nsecond\nthird', 3, 3, 'third'],
    ['last nonempty line with a final LF', 'first\nsecond\n', 2, 2, 'second'],
    ['trailing empty line', 'first\nsecond\n', 3, 3, ''],
    ['including the trailing empty line', 'first\nsecond\n', 2, 3, 'second\n'],
    ['end beyond the trailing empty line', 'first\nsecond\n', 2, 100, 'second\n'],
    ['start after the trailing empty line', 'first\nsecond\n', 4, 100, ''],
    ['start beyond EOF', 'first\nsecond', 3, 100, ''],
    ['end beyond EOF', 'first\nsecond', 2, 100, 'second'],
    ['empty input', '', 1, 1, ''],
    ['empty input beyond EOF', '', 2, 3, ''],
    ['empty first line', '\nsecond', 1, 1, ''],
    ['consecutive empty lines', 'first\n\n\nlast', 2, 3, '\n'],
    ['only LF characters', '\n\n', 1, 3, '\n\n'],
    ['reversed bounds', 'first\nsecond\nthird', 3, 1, ''],
    ['adjacent reversed bounds', 'first\nsecond\nthird', 2, 1, ''],
    ['huge safe start', 'first\nsecond', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, ''],
    ['huge safe end', 'first\nsecond\n', 1, Number.MAX_SAFE_INTEGER, 'first\nsecond\n'],
  ])('%s', (_name, content, startLine, endLine, expected) => {
    expect(sliceLines(content, startLine, endLine)).toBe(expected);
  });

  it('splits only at LF and preserves CRLF, lone CR and Unicode line separators', () => {
    const content = 'first\r\nsecond\rstill second\u2028still second\u2029still second\r\nthird\r\n';
    expect(sliceLines(content, 1, 1)).toBe('first\r');
    expect(sliceLines(content, 2, 2)).toBe('second\rstill second\u2028still second\u2029still second\r');
    expect(sliceLines(content, 2, 3)).toBe('second\rstill second\u2028still second\u2029still second\r\nthird\r');
    expect(sliceLines(content, 3, 4)).toBe('third\r\n');
    expect(sliceLines('one\rtwo', 1, 1)).toBe('one\rtwo');
    expect(sliceLines('one\rtwo', 2, 2)).toBe('');
  });

  it('preserves exact UTF-16 code units, including paired and unpaired surrogates', () => {
    const lines = ['😀中文e\u0301', '\ud800lone high', 'lone low\udc00', '\ud83d', '\ude00', '\0𝄞', ''];
    const content = lines.join('\n');
    for (let startLine = 1; startLine <= lines.length + 1; startLine++) {
      for (let endLine = 1; endLine <= lines.length + 1; endLine++) {
        expect(sliceLines(content, startLine, endLine)).toBe(originalSliceLines(content, startLine, endLine));
      }
    }
    expect(sliceLines(content, 4, 5)).toBe('\ud83d\n\ude00');
  });

  it('returns null for every falsy bound, including zero, negative zero, NaN and undefined', () => {
    const missingBounds = [undefined, 0, -0, Number.NaN];
    for (const bound of missingBounds) {
      for (const content of ['', 'first\nsecond\n']) {
        expect(sliceLines(content, bound, 2)).toBeNull();
        expect(sliceLines(content, 1, bound)).toBeNull();
        expect(sliceLines(content, bound, bound)).toBeNull();
      }
    }
    expect(sliceLines('first\nsecond')).toBeNull();
  });

  it('preserves the original slice coercion for fractional, negative, infinite and unsafe bounds', () => {
    const bounds = [
      undefined, Number.NaN, -Infinity, -Number.MAX_VALUE, -Number.MAX_SAFE_INTEGER,
      -20, -5, -2, -1, -0.75, -Number.MIN_VALUE, -0, 0, Number.MIN_VALUE,
      0.25, 0.75, 1, 1.25, 1.75, 2, 2.5, 4, 5, 6, 20,
      Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, Number.MAX_VALUE, Infinity,
    ];
    for (const content of ['', '\n', 'a\nb\nc\nd', 'a\r\nb\n\nc\r\n']) {
      for (const startLine of bounds) {
        for (const endLine of bounds) {
          expect(sliceLines(content, startLine, endLine), `bounds ${String(startLine)}, ${String(endLine)}`)
            .toBe(originalSliceLines(content, startLine, endLine));
        }
      }
    }
  });

  it('matches the original for 12,000 deterministic randomized strings and ranges', () => {
    let state = 0x7a31c9e5;
    const random = (limit: number): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return Math.floor((state / 0x100000000) * limit);
    };
    const fragments = ['a', 'beta', '\n', '\n\n', '\r\n', '\r', '中文', '😀', '𝄞', 'e\u0301', '\u2028', '\u2029', '\ud800', '\udc00', '\0', ''];
    const unusualBounds = [
      undefined, 0, -0, Number.NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER + 1, -Number.MAX_SAFE_INTEGER, Number.MAX_VALUE,
      -Number.MAX_VALUE, Number.MIN_VALUE, -Number.MIN_VALUE,
    ];

    for (let iteration = 0; iteration < 12_000; iteration++) {
      let content = '';
      const fragmentCount = random(80);
      for (let i = 0; i < fragmentCount; i++) content += fragments[random(fragments.length)]!;
      const lineCount = content.split('\n').length;
      const bound = (kind: number): number | undefined => {
        switch (kind % 4) {
          case 0: return 1 + random(lineCount + 10);
          case 1: return random(lineCount * 2 + 20) - lineCount - 10;
          case 2: return (random(lineCount * 8 + 80) - lineCount * 4 - 40) / 4;
          default: return unusualBounds[random(unusualBounds.length)];
        }
      };
      // Half the samples exercise the positive-safe-integer fast path; the
      // remainder cover all combinations of integral and fallback bounds.
      const startLine = bound(iteration % 2 === 0 ? 0 : Math.floor(iteration / 2));
      const endLine = bound(iteration % 2 === 0 ? 0 : Math.floor(iteration / 8));
      expect(sliceLines(content, startLine, endLine), `seed 0x7a31c9e5, case ${iteration}, bounds ${String(startLine)}, ${String(endLine)}`)
        .toBe(originalSliceLines(content, startLine, endLine));
    }
  });

  it('preserves short selected ranges in a large source, including near EOF', () => {
    const lineCount = 75_000;
    const lines = Array.from({ length: lineCount }, (_, i) => `line ${i + 1}: 中文😀 ${'x'.repeat(48)}\r`);
    const content = `${lines.join('\n')}\n`;
    for (const [startLine, endLine] of [[1, 2], [37_499, 37_501], [74_999, 75_000], [75_000, 75_001], [75_001, 75_002], [75_002, 75_003]]) {
      expect(sliceLines(content, startLine, endLine)).toBe(originalSliceLines(content, startLine, endLine));
    }
    expect(sliceLines(content, 37_500, 37_500)).toBe(lines[37_499]);
    expect(sliceLines(content, lineCount, lineCount)).toBe(lines[lineCount - 1]);
    expect(sliceLines(content, lineCount, lineCount + 1)).toBe(`${lines[lineCount - 1]}\n`);
    expect(sliceLines(content, lineCount + 1, lineCount + 1)).toBe('');
  });
});
