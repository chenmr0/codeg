import { describe, expect, it } from 'vitest';
import type { Node } from '../src/types';
import { renderExploreSources, type ExploreSourceFile } from '../src/mcp/explore-selection';

const body = (name: string, count: number) => [`int ${name}() {`,
  ...Array.from({ length: count }, (_, index) => `  operation_${name}(${index});`), `} // END_${name}`].join('\n');
const node = (name: string, start: number, end: number, kind = 'function'): Node =>
  ({ id: name, name, kind, startLine: start, endLine: end, language: 'cpp' } as Node);
const file = (path: string, content: string, nodes: Node[], priority = 0): ExploreSourceFile => ({
  path, content, nodes, priority: () => priority, connectivity: () => 1,
  skeleton: false, bodyAllowed: () => true, relevance: 1, worth: 1,
});
const render = (files: ExploreSourceFile[], budget = 3000, perFile = 1200, maxFiles = 8) =>
  renderExploreSources('### Source Code\n\n', files, { maxOutputChars: budget, maxCharsPerFile: perFile,
    maxFiles, lineNumbers: true, headerSymbols: 8 });
const sourceLines = (out: string) => [...out.matchAll(/^(\d+)\t/gm)].map(match => Number(match[1]));

describe('P3 file allocation and important source windows', () => {
  it('keeps two complete mechanisms beside a large entry and its late call site', () => {
    const big = file('dispatch.cpp', body('dispatch', 200), [node('dispatch', 1, 202)]);
    big.spine = true; big.focusLines = new Map([['dispatch', [190]]]);
    const out = render([big, file('check.cpp', body('validate', 7), [node('validate', 1, 9)]),
      file('store.cpp', body('persist', 7), [node('persist', 1, 9)])]);
    expect(out).toContain('END_validate'); expect(out).toContain('END_persist');
    expect(out).toContain('1\tint dispatch()'); expect(out).toContain('190\t  operation_dispatch(188)');
    expect(out).not.toContain('END_dispatch'); expect(out).toContain('dispatch.cpp:1-202 dispatch; shown ');
    expect(out.length).toBeLessThanOrEqual(3000);
  });
  it('gives a large body a head and tail focus after a complete small function in the same file', () => {
    const f = file('worker.cpp', body('small', 2) + '\n' + body('heavy', 200),
      [node('small', 1, 4), node('heavy', 5, 206)]);
    f.focusLines = new Map([['heavy', [199]]]);
    const out = render([f], 2000, 1300);
    expect(out).toContain('END_small'); expect(out).toContain('5\tint heavy()');
    expect(out).toContain('199\t  operation_heavy(193)'); expect(out).not.toContain('100\t  operation_heavy(94)');
    expect(out).toContain('... (gap) ...'); expect(out).toContain('partial body');
    expect(out.length).toBeLessThanOrEqual(2000);
  });
  it('honors a per-node body allowance in a skeleton file when the body needs a window', () => {
    const f = file('relative.cpp', body('handler', 200), [node('handler', 1, 202)]);
    f.skeleton = true; f.focusLines = new Map([['handler', [180]]]);
    const out = render([f], 1800, 1100);
    expect(out).toContain('180\t  operation_handler(178)');
    expect(out).not.toContain('signatures only'); expect(out).not.toContain('END_handler');
  });
  it('uses focus windows for an oversized protected member without losing its same-file sibling', () => {
    const f = file('member.cpp', body('tiny', 2) + '\n' + body('process', 200),
      [node('tiny', 1, 4), node('process', 5, 206)]);
    f.protectedNodeIds = new Set(['tiny', 'process']); f.focusLines = new Map([['process', [190]]]);
    const out = render([f], 2000, 1300);
    expect(out).toContain('END_tiny'); expect(out).toContain('190\t  operation_process(184)');
    expect(out).toContain('Omitted target: member.cpp:5-206 process; shown ');
    expect(out).not.toContain('Complete target: member.cpp:5-206'); expect(out.length).toBeLessThanOrEqual(2000);
  });
  for (const targeted of [false, true]) {
    it(`adds a late-call window after a complete body borrowed beyond the ordinary file cap (targeted=${targeted})`, () => {
      const content = Array.from({ length: 400 }, (_, index) => `statement_${index + 1}(); // ${'x'.repeat(75)}`).join('\n');
      const f = file('example.cpp', content, [node('first', 1, 100), node('second', 101, 400)]);
      if (targeted) f.protectedNodeIds = new Set(['first', 'second']);
      f.focusLines = new Map([['second', [390]]]);
      const out = render([f], 24000, 7000);
      expect(out).toContain('100\tstatement_100();');
      expect(out).toContain('390\tstatement_390();');
      expect(out).not.toContain('250\tstatement_250();');
      expect(out).toContain('example.cpp:101-400 second; shown ');
      expect(out.length).toBeLessThanOrEqual(24000);
    });
  }
  it('keeps literal multiline source targets within their requested range even with external focus lines', () => {
    const f = file('range.cpp', body('whole', 98), [node('whole', 1, 100)]);
    f.requestedRanges = [{ start: 70, end: 74 }]; f.focusLines = new Map([['whole', [95]]]);
    const out = render([f], 1500, 900);
    expect(sourceLines(out)).toEqual([70, 71, 72, 73, 74]);
    expect(out).toContain('range.cpp:70-74 requested source range; shown 70-74; missing none');
  });
  it('completes a processing body before a higher-score peer fills its allowance with lower-tier members', () => {
    const primary = file('entry.cpp', body('entry', 2) + '\n' + body('process', 100),
      [node('entry', 1, 4), node('process', 5, 106)]);
    primary.priority = value => value.name === 'entry' ? 1.25 : 1.5; primary.relevance = 10; primary.named = true;
    const names = Array.from({ length: 16 }, (_, index) => `helper_${index}`);
    const peer = file('support.cpp', names.map(name => body(name, 8)).join('\n'),
      names.map((name, index) => node(name, index * 10 + 1, (index + 1) * 10)), 2);
    peer.relevance = 100;
    const out = render([primary, peer], 6000, 1200);
    expect(out).toContain('END_entry'); expect(out).toContain('END_process');
    expect(out).toContain('END_helper_0'); expect(out.length).toBeLessThanOrEqual(6000);
  });
  it('preserves a compact member group when a large file has much greater relevance', () => {
    const giant = file('engine.cpp', body('giant', 200), [node('giant', 1, 202)], 2); giant.relevance = 100;
    const group = file('policy.h', [body('a', 2), body('b', 2), body('c', 2)].join('\n'),
      [node('a', 1, 4), node('b', 5, 8), node('c', 9, 12)], 2); group.relevance = 0.0001;
    const out = render([giant, group], 2200, 1000);
    for (const name of ['a', 'b', 'c']) expect(out).toContain(`END_${name}`);
    expect(out).toContain('int giant()'); expect(out.length).toBeLessThanOrEqual(2200);
  });
  it('charges long paths, gaps, numbered lines and ledgers within every tested envelope', () => {
    const f = file('long/'.repeat(25) + 'entry.cpp', body('execute', 180), [node('execute', 1, 182)]);
    f.focusLines = new Map([['execute', [150, 170]]]);
    for (const budget of [180, 300, 600, 1100, 2400]) {
      const out = render([f], budget, 1100);
      expect(out.length).toBeLessThanOrEqual(budget);
      expect((out.match(/^```/gm) ?? []).length % 2).toBe(0);
      for (const line of out.split('\n').filter(line => /^\d+\t/.test(line))) {
        expect(line).toMatch(/\{$|\);$|END_execute$/);
      }
    }
  });
  it('retains a large direct graph neighbor below the lexical cliff without promoting ordinary noise', () => {
    const primary = file('primary.cpp', body('anchor', 3), [node('anchor', 1, 5)]);
    primary.relevance = 200; primary.named = true;
    const related = file('related.cpp', body('related', 200), [node('related', 1, 202)], 3);
    related.relevance = 9;
    const noise = file('noise.cpp', body('unrelated', 200), [node('unrelated', 1, 202)], 4);
    noise.relevance = 9;
    const out = render([primary, related, noise], 3500, 1200, 2);
    expect(out).toContain('END_anchor'); expect(out).toContain('#### related.cpp');
    expect(out).not.toContain('#### noise.cpp'); expect(out).toContain('noise.cpp:1-202 unrelated; shown none; missing 1-202');
    expect(out.length).toBeLessThanOrEqual(3500);
  });
  it('uses otherwise idle budget and a free file slot for a deferred low-score neighbor', () => {
    const primary = file('primary.cpp', body('anchor', 3), [node('anchor', 1, 5)]);
    primary.relevance = 100; primary.named = true;
    const deferred = file('deferred.cpp', body('later', 100), [node('later', 1, 102)], 4);
    deferred.relevance = 1;
    const out = render([primary, deferred], 5000, 700, 2);
    expect(out).toContain('END_anchor'); expect(out).toContain('END_later');
    expect(out.match(/^#### /gm)).toHaveLength(2); expect(out.length).toBeLessThanOrEqual(5000);
    const oneFile = render([primary, deferred], 5000, 700, 1);
    expect(oneFile).toContain('END_anchor'); expect(oneFile).not.toContain('#### deferred.cpp');
  });
  it('funds a deferred oversized-body window before its constant and container filler', () => {
    const primary = file('primary.cpp', body('anchor', 3), [node('anchor', 1, 5)]);
    primary.relevance = 100; primary.named = true;
    const content = body('huge', 200) + '\n' + Array.from({ length: 26 }, (_, index) => `CONST_PAYLOAD_${index} = ${'x'.repeat(25)};`).join('\n');
    const later = file('deferred.cpp', content,
      [node('huge', 1, 202), node('payload', 203, 228, 'constant')], 4);
    later.relevance = 1;
    const out = render([primary, later], 2200, 1200, 2);
    expect(out).toContain('END_anchor'); expect(out).toContain('1\tint huge()');
    expect(out).toContain('2\t  operation_huge(0);');
    expect(out).not.toContain('CONST_PAYLOAD_25');
    expect(out).toContain('deferred.cpp:1-202 huge; shown ');
    expect(out.length).toBeLessThanOrEqual(2200);
  });
  it('preserves an independent compact direct mechanism before same-tier filler in a high-score main file', () => {
    const primary = file('primary.cpp', [body('named', 40), body('fillerA', 80), body('fillerB', 40)].join('\n'),
      [node('named', 1, 42), node('fillerA', 43, 124), node('fillerB', 125, 166)]);
    primary.priority = value => value.name === 'named' ? 0 : 3; primary.relevance = 180; primary.named = true;
    const mechanism = file('mechanism.cpp', body('prepare', 12) + '\n' + body('validate', 12),
      [node('prepare', 1, 14), node('validate', 15, 28)], 3);
    mechanism.relevance = 12;
    const out = render([primary, mechanism], 5000, 1600);
    expect(out).toContain('END_named'); expect(out).toContain('END_prepare'); expect(out).toContain('END_validate');
    expect(out.length).toBeLessThanOrEqual(5000);
  });
  it('is invariant under equal-length symbol and file renaming', () => {
    const make = (name: string, path: string) => {
      const f = file(path, body(name, 200), [node(name, 1, 202)]);
      f.focusLines = new Map([[name, [150, 180]]]); return f;
    };
    const first = render([make('alpha', 'first.cpp')], 2000, 1200);
    const second = render([make('omega', 'other.cpp')], 2000, 1200);
    expect(sourceLines(first)).toEqual(sourceLines(second));
    expect(first.length).toBe(second.length);
  });
  it('keeps containers as outlines instead of selecting their surrounding member envelope', () => {
    const content = ['class Container {', body('member', 180), '};'].join('\n');
    const f = file('types.h', content, [node('Container', 1, 184, 'class'), node('member', 2, 183)]);
    f.protectedNodeIds = new Set(['Container']); f.bodyAllowed = () => false;
    const out = render([f], 2000, 1100);
    expect(out).toContain('1\tclass Container'); expect(out).not.toContain('operation_member');
    expect(out).toContain('Outline only: types.h:1-184 Container');
  });
});
