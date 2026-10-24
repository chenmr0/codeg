import { describe, expect, it } from 'vitest';
import type { Node } from '../src/types';
import { renderExploreSources, type ExploreSourceFile } from '../src/mcp/explore-selection';

const node = (name: string, startLine: number, endLine: number, kind = 'function') =>
  ({ id: name, name, startLine, endLine, kind, language: 'cpp' } as Node);
const body = (name: string, length: number) => [`int ${name}() {`,
  ...Array.from({ length }, (_, i) => `  consume_${name}(${i});`), `} // FINISH_${name}`].join('\n');
const source = (path: string, content: string, nodes: Node[], ids: string[] = []): ExploreSourceFile => ({
  path, content, nodes, priority: () => 0, connectivity: () => 1, skeleton: false, bodyAllowed: () => true,
  protectedNodeIds: new Set(ids),
});
const render = (files: ExploreSourceFile[], total = 2400, perFile = 700, maxFiles = 8) =>
  renderExploreSources('### Source Code\n\n', files, { maxOutputChars: total, maxCharsPerFile: perFile,
    maxFiles, lineNumbers: true, headerSymbols: 8 });

describe('Explicit explore target selection', () => {
  it('protects two independent exact bodies before a large ordinary neighbor', () => {
    const out = render([
      source('neighbor.cpp', body('noise', 160), [node('noise', 1, 162)]),
      source('first.cpp', body('save', 8), [node('save', 1, 10)], ['save']),
      source('second.cpp', body('restore', 8), [node('restore', 1, 10)], ['restore']),
    ], 1700, 700, 2);
    expect(out).toContain('FINISH_save'); expect(out).toContain('FINISH_restore');
    expect(out).not.toContain('FINISH_noise'); expect(out.match(/^#### /gm)).toHaveLength(2);
    expect(out.length).toBeLessThanOrEqual(1700);
  });
  it('returns executable evidence for a large exact body after a small body in the same file', () => {
    const f = source('worker.cpp', body('small', 2) + '\n' + body('long_target', 140),
      [node('small', 1, 4), node('long_target', 5, 146)], ['small', 'long_target']);
    const out = render([f], 1500, 650);
    expect(out).toContain('FINISH_small'); expect(out).toContain('consume_long_target(0)');
    expect(out).not.toContain('FINISH_long_target');
    expect(out).toMatch(/Omitted target: worker\.cpp:5-146 long_target; shown 5-\d+; missing \d+-146/);
    expect(out).not.toContain('complete selected bodies'); expect(out.length).toBeLessThanOrEqual(1500);
  });
  it('starts a requested tail range at its actual location and never expands to the enclosing function', () => {
    const f = source('ending.cpp', body('container', 98), [node('container', 1, 100)]);
    f.requestedRanges = [{ start: 90, end: 94 }];
    const out = render([f]);
    expect(out).toContain('90\t  consume_container(88)');
    expect(out).toContain('94\t  consume_container(92)');
    expect(out).not.toContain('1\tint container'); expect(out).not.toContain('FINISH_container');
    expect(out).toContain('ending.cpp:90-94 requested source range; shown 90-94; missing none');
  });
  it('renders an oversized range without AST nodes and reports its exact remaining interval', () => {
    const content = Array.from({ length: 300 }, (_, i) => `line_${i + 1}_with_source_payload();`).join('\n');
    const f = source('unindexed.inc', content, []);
    f.requestedRanges = [{ start: 200, end: 290 }];
    const out = render([f], 1250, 600);
    expect(out).toContain('200\tline_200_with_source_payload();');
    expect(out).not.toContain('1\tline_1_'); expect(out).not.toContain('290\t');
    expect(out).toMatch(/unindexed\.inc:200-290 requested source range; shown 200-\d+; missing \d+-290/);
    expect(out.length).toBeLessThanOrEqual(1250);
  });
  it('keeps an explicit multiline span free of unrequested preceding and following functions', () => {
    const f = source('ranges.cpp', 'int before() {\n return 11;\n}\n// requested A\n// requested B\n// requested C\nint after() {\n return 22;\n}',
      [node('before', 1, 3), node('after', 7, 9)]);
    f.requestedRanges = [{ start: 4, end: 6 }];
    const out = render([f]);
    expect(out).toContain('4\t// requested A'); expect(out).toContain('6\t// requested C');
    expect(out).not.toContain('int before'); expect(out).not.toContain('int after');
    f.protectedNodeIds = new Set(['after']);
    expect(render([f])).toContain('return 22');
  });
  it('protects explicit spans before pinned files while respecting maxFiles', () => {
    const pin = source('pinned.cpp', body('hint', 2), [node('hint', 1, 4)]); pin.pinned = true;
    const range = source('span.txt', 'one\ntwo\nthree\nfour', []); range.requestedRanges = [{ start: 2, end: 3 }];
    const exact = source('exact.cpp', body('target', 2), [node('target', 1, 4)], ['target']);
    const out = render([pin, exact, range], 2000, 700, 1);
    expect(out.match(/^#### /gm)).toHaveLength(1); expect(out).toContain('#### span.txt');
    expect(out).not.toContain('FINISH_target');
    expect(out).toContain('exact.cpp:1-4 target; shown none; missing 1-4; file omitted by maxFiles');
  });
  it('does not let a pinned declaration outline displace its canonical exact definition', () => {
    const declaration = source('thing.h', 'class Thing {\n  int act();\n};',
      [node('Thing', 1, 3, 'class'), { ...node('declaration', 2, 2, 'method'), isDeclaration: true }]);
    declaration.pinned = true; declaration.requestedRanges = [{ start: 2, end: 2 }];
    const definition = source('thing.cpp', body('act', 3), [node('act', 1, 5)], ['act']);
    const out = render([declaration, definition], 2000, 700, 1);
    expect(out).toContain('FINISH_act'); expect(out).not.toContain('#### thing.h');
  });
  it('gives a path-only unindexed file bounded source with truthful coverage', () => {
    const f = source('config.inc', Array.from({ length: 100 }, (_, i) => `SETTING_${i} = value_${i};`).join('\n'), []);
    f.pinned = true;
    const out = render([f], 1000, 500);
    expect(out).toContain('1\tSETTING_0'); expect(out).not.toContain('SETTING_99');
    expect(out).toContain('config.inc:1-100 requested file'); expect(out).toContain('missing ');
    expect(out.length).toBeLessThanOrEqual(1000);
  });
  it('still gives a pinned file useful source when its only indexed body is oversized', () => {
    const f = source('large.cpp', body('large', 200), [node('large', 1, 202)]); f.pinned = true;
    const out = render([f], 1400, 600);
    expect(out).toContain('consume_large(0)'); expect(out).not.toContain('FINISH_large');
    expect(out).toMatch(/Omitted body: large\.cpp:1-202 large; shown 1-\d+; missing \d+-202/);
    expect(out.length).toBeLessThanOrEqual(1400);
  });
  it('does not claim an out-of-bounds requested range was emitted', () => {
    const f = source('short.txt', 'a\nb\nc', []); f.requestedRanges = [{ start: 2, end: 7 }];
    const out = render([f]);
    expect(out).toContain('short.txt:2-7 requested source range; shown 2-3; missing 4-7');
    expect(out).not.toContain('Complete target');
  });
  it('accounts for long paths, fences, line numbers and ledger without slicing source lines', () => {
    const f = source('nested/'.repeat(20) + 'budget.cpp', body('bounded', 80), [node('bounded', 1, 82)], ['bounded']);
    for (const total of [250, 500, 900, 1600]) {
      const out = render([f], total, 600);
      expect(out.length).toBeLessThanOrEqual(total);
      expect((out.match(/^```/gm) ?? []).length % 2).toBe(0);
      for (const line of out.split('\n').filter(line => /^\d+\t/.test(line))) {
        expect(line).toMatch(/\{\s*$|\);\s*$|FINISH_bounded$/);
      }
    }
  });
  it('does not invoke target selection for unrelated IDs in a shared protected set', () => {
    const f = source('normal.cpp', body('normal', 2), [node('normal', 1, 4)]);
    const old = render([f]);
    f.protectedNodeIds = new Set(['other-file-target']);
    expect(render([f])).toBe(old);
  });
  it('treats fields as source targets without expanding the whole owner type', () => {
    const f = source('record.h', 'struct Record {\n  int slot =\n    42;\n};',
      [node('Record', 1, 4, 'struct'), node('slot', 2, 3, 'variable')], ['slot']);
    const out = render([f]);
    expect(out).toContain('3\t    42;');
    expect(out).toContain('record.h:2-3 slot; shown 2-3; missing none');
  });
  it('does not let a relevance skeleton gate suppress an exact callable body', () => {
    const f = source('sibling.cpp', body('chosen', 4), [node('chosen', 1, 6)], ['chosen']);
    f.skeleton = true; f.bodyAllowed = () => false;
    const out = render([f]);
    expect(out).toContain('FINISH_chosen');
    expect(out).toContain('sibling.cpp:1-6 chosen; shown 1-6; missing none');
  });
  it('reports an exact type as an outline with the original missing range, never a complete class body', () => {
    const content = ['class Worker {', ...Array.from({ length: 90 }, (_, i) => `  int slot_${i};`), '};'].join('\n');
    const f = source('worker.h', content, [node('Worker', 1, 92, 'class')], ['Worker']);
    const out = render([f], 2000, 700);
    expect(out).toContain('1\tclass Worker {'); expect(out).not.toContain('slot_0');
    expect(out).toContain('Outline only: worker.h:1-92 Worker; shown 1; missing 2-92');
    expect(out).not.toContain('Complete target: worker.h');
    expect(out).not.toContain('worker.h:1-1 Worker');
    expect(out.length).toBeLessThanOrEqual(2000);
  });
  it('labels an unresolved exact method declaration as declaration evidence, never a complete implementation', () => {
    // The implementation may have been omitted by the freshness guard, leaving
    // this independently fresh declaration as the only safe indexed evidence.
    const f = source('worker.h', 'class Worker {\n  int commit();\n};',
      [{ ...node('commit', 2, 2, 'method'), isDeclaration: true }], ['commit']);
    const out = render([f]);
    expect(out).toContain('2\t  int commit();');
    expect(out).toContain('Declaration only: worker.h:2-2 commit; shown 2; missing none; body not included');
    expect(out).not.toContain('Complete target');
  });
  it('keeps the original multiline declaration range when only its signature outline is shown', () => {
    const f = source('api.h', 'int dispatch(\n  int first,\n  int second);',
      [{ ...node('dispatch', 1, 3), isDeclaration: true }], ['dispatch']);
    const out = render([f]);
    expect(out).toContain('Declaration only: api.h:1-3 dispatch; shown 1; missing 2-3; body not included');
    expect(out).not.toContain('Complete target');
  });
});
