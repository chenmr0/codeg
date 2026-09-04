/**
 * Pure-macro data header fast path (B-2).
 *
 * tree-sitter-c degenerates to ~O(n^2) on files made of many `#define`
 * directives once macro bodies carry inline block comments or very long rows
 * (measured: 20 macros 16.7s → 40 macros 67.6s, parse tree collapses to 0-2
 * macros), so such files yield no extractable symbols beyond macro names and
 * the C extractor skips the parse, collecting macro names via regex instead.
 *
 * Detection is a structural whitelist over comment/literal-masked text: every
 * non-blank masked line must be a preprocessor directive (or a continuation of
 * one). The earlier "zero semicolons" blacklist wrongly skipped files whose
 * real declarations carry no semicolon (`void real_fn(void) {}`) and counted
 * semicolons living only inside license-banner comments, so these tests pin
 * both directions: data tables skip, real code of any shape never does.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { extractFromSource } from '../src/extraction/tree-sitter';
import { getParser, initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  // Only the grammars under test — loading every grammar OOMs the WASM V8
  // zone on Windows (see memory notes) and this suite needs just C and C++.
  await loadGrammarsForLanguages(['c', 'cpp']);
});

/** Dangling-continuation shape: every line of every macro ends with ` \`. */
function genPureMacroHeader(n: number): string {
  let s = '#ifndef _SPEC_H\n#define _SPEC_H\n\n';
  for (let i = 0; i < n; i++) {
    s += `#define SPEC_${String(i).padStart(3, '0')} \\\n`;
    s += `  /* CAP_${i} */ \\\n`;
    s += `  { 0x05015000, 159244, 50000, 512, 0, 0, 0, 0, 0, 500, 750, 1000, 19000, 0, 3, 6, 9, 0, 1, 2, 4, 0, 0, 0, 0, 0, 0x10002, 0, 0, 0, 0, 0, 245760, 0, 2, 16, 4, 0, 0, 1, 1, 7, 1, 1, 0, 0, 1, 1, 0, 0, 0, 512, 512, 5120, 2, 1, 1, 1, 0, 0, 0, 0, 0, 1, 0, 6, 0}, \\\n`;
  }
  // drop the trailing ", \" so the last macro actually terminates
  s = s.replace(/, \\\n$/, '\n');
  s += '\n#endif\n';
  return s;
}

/** n simple one-line data macros (plus an include guard). */
function genSimpleMacros(n: number): string {
  let s = '#ifndef _H\n#define _H\n\n';
  for (let i = 0; i < n; i++) s += `#define M${String(i).padStart(3, '0')} { 1, 2 }\n`;
  s += '\n#endif\n';
  return s;
}

/** User-reported shape: multi-line bodies, inline block comments in data
 * rows, every row except the last continued with `, \`. */
function genUserShapeMacros(n: number): string {
  let s = '#ifndef _H\n#define _H\n\n';
  for (let i = 0; i < n; i++) {
    s += `#define TBL_${String(i).padStart(3, '0')} \\\n`;
    for (let r = 0; r < 3; r++) {
      s += `  { 28, /* row ${r} */ 28, 28, 28, 28, 28 }, \\\n`;
    }
    s += `  { 6, 6, 23, 28, 28, 28 }\n\n`;
  }
  s += '#endif\n';
  return s;
}

const macroNames = (r: ReturnType<typeof extractFromSource>) =>
  r.nodes.filter((n) => n.kind === 'macro');
const skipped = (r: ReturnType<typeof extractFromSource>) =>
  r.errors.some((e) => e.code === 'skipped_macro_data_header');

/** Assert the first parser input before entering a potentially pathological
 * synchronous parse. A missing F transform must fail, not hang the suite. */
function extractWithExpectedParseSource(source: string, expected: string) {
  const parser = getParser('c')!;
  const parse = parser.parse.bind(parser);
  const guard = vi.spyOn(parser, 'parse').mockImplementation((...args) => {
    if (guard.mock.calls.length === 1 && args[0] !== expected) {
      throw new Error('Unexpected initial parser input: macro comment masking regression');
    }
    return parse(...args);
  });
  try {
    const result = extractFromSource('specmodedef.h', source, 'c');
    expect(guard).toHaveBeenCalled();
    // Compare as a boolean to avoid printing a huge fixture on failure.
    expect(guard.mock.calls[0]?.[0] === expected).toBe(true);
    return result;
  } finally {
    guard.mockRestore();
  }
}

describe('pure-macro data header fast path', () => {
  it('skips parse, emits every macro name, and warns', () => {
    const src = genPureMacroHeader(100);
    const r = extractFromSource('specmode.h', src, 'c');

    // Skipped path is O(n) — must be well under the O(n^2) baseline (seconds).
    expect(r.durationMs).toBeLessThan(500);

    // 100 data macros + 1 include-guard macro.
    const macros = macroNames(r);
    expect(macros.length).toBe(101);
    expect(macros.some((n) => n.name === '_SPEC_H')).toBe(true);
    expect(macros.some((n) => n.name === 'SPEC_000')).toBe(true);
    expect(macros.some((n) => n.name === 'SPEC_099')).toBe(true);

    // file node + contains edges from file to every macro.
    expect(r.nodes.some((n) => n.kind === 'file')).toBe(true);
    expect(r.edges.filter((e) => e.kind === 'contains').length).toBe(101);

    // Warn surfaced so users can see the skip and force-parse if they want.
    expect(skipped(r)).toBe(true);
  });

  it('skips the user-reported shape: multi-line bodies with inline block comments', () => {
    const src = genUserShapeMacros(25);
    const r = extractFromSource('configtbl.h', src, 'c');

    // This shape measured 16.7s at 20 macros before the whitelist fix (its
    // banner semicolons used to push it off the fast path).
    expect(r.durationMs).toBeLessThan(500);
    expect(skipped(r)).toBe(true);
    const macros = macroNames(r);
    expect(macros.length).toBe(26); // 25 data macros + guard
    expect(macros.some((n) => n.name === 'TBL_000')).toBe(true);
    expect(macros.some((n) => n.name === 'TBL_024')).toBe(true);
  });

  it('skips a data header whose semicolons are only inside comments', () => {
    const banner = '/*\n * Copyright (c) 2020 X Co., Ltd.\n * 文件标识: config.h;\n */\n';
    const r = extractFromSource('banner.h', banner + genSimpleMacros(20), 'c');

    expect(skipped(r)).toBe(true);
    expect(macroNames(r).length).toBe(21); // 20 + guard
    expect(r.durationMs).toBeLessThan(500);
  });

  it('does not skip a real function definition without a semicolon', () => {
    // `void real_fn(void) {}` carries no ';' — the old zero-semicolon
    // heuristic skipped this file and dropped the function entirely.
    const src = genSimpleMacros(20) + '\nvoid real_fn(void) {}\n';
    const r = extractFromSource('realfn.h', src, 'c');

    expect(skipped(r)).toBe(false);
    expect(r.nodes.some((n) => n.kind === 'function' && n.name === 'real_fn')).toBe(true);
  });

  it('does not extract ghost macros from comments', () => {
    const src =
      genSimpleMacros(20) +
      '\n/*\n历史遗留，勿删:\n#define GHOST 1\n*/\n';
    const r = extractFromSource('ghost.h', src, 'c');

    expect(skipped(r)).toBe(true);
    const macros = macroNames(r);
    expect(macros.some((n) => n.name === 'GHOST')).toBe(false);
    expect(macros.some((n) => n.name === 'M000')).toBe(true);
  });

  it('does not skip files with real declarations (semicolons)', () => {
    const src = '#ifndef H\n#define H\nint foo(void) { return 0; }\n#endif\n';
    const r = extractFromSource('normal.h', src, 'c');

    expect(skipped(r)).toBe(false);
    expect(r.nodes.some((n) => n.kind === 'function' && n.name === 'foo')).toBe(true);
  });

  it('does not skip a cross-line function-like macro header', () => {
    // `#define FN\` + newline `(x) …` is a function-like macro whose header
    // spans lines. The fast path would truncate its signature to
    // `#define FN` and misclassify it, so such files must keep the parse.
    const src =
      genSimpleMacros(24) +
      '#define FN\\\n(x) ((x) + 1)\n';
    const r = extractFromSource('crossline.h', src, 'c');

    expect(skipped(r)).toBe(false);
    // The parse path yields the full signature including the parameter list.
    const fn = r.nodes.find((n) => n.kind === 'macro' && n.name === 'FN');
    expect(fn?.signature).toContain('(x)');
  });

  it('does not skip a file with a non-ASCII macro name', () => {
    // The regex fast path cannot extract non-ASCII identifiers at all, while
    // the tree-sitter parse can, so such files must keep the parse path.
    const src =
      genSimpleMacros(24) +
      '#define 宏函数(x) ((x) + 1)\n';
    const r = extractFromSource('nonascii.h', src, 'c');

    expect(skipped(r)).toBe(false);
    expect(r.nodes.some((n) => n.kind === 'macro' && n.name === '宏函数')).toBe(true);
  });

  it('a backslash followed by a comment does not swallow the next line', () => {
    // After masking, `#define BROKEN \ /* note */` looks like a trailing
    // continuation, which would treat the next line's real function as part
    // of the macro body. The tree-sitter parse does not swallow it, so the
    // fast path must not either.
    const src =
      genSimpleMacros(24) +
      '#define BROKEN \\ /* note */\nvoid real_fn(void) {}\n';
    const r = extractFromSource('fakecont.h', src, 'c');

    expect(skipped(r)).toBe(false);
    expect(r.nodes.some((n) => n.kind === 'function' && n.name === 'real_fn')).toBe(true);
  });

  it('does not skip files with typedef/struct/enum (type keywords)', () => {
    let src = '#ifndef H\n#define H\n\n';
    for (let i = 0; i < 100; i++) src += `#define M_${i} { 1, 2 }\n`;
    // A typedef keeps this on the normal path even though it has many #defines.
    src += 'typedef struct { int a; } S;\n#endif\n';
    const r = extractFromSource('types.h', src, 'c');

    expect(skipped(r)).toBe(false);
  });

  it('does not skip files with function-like macros', () => {
    let src = '#ifndef H\n#define H\n\n';
    for (let i = 0; i < 100; i++) src += `#define FN_${i}(x) ((x) + ${i})\n`;
    src += '#endif\n';
    const r = extractFromSource('fnmacros.h', src, 'c');

    expect(skipped(r)).toBe(false);
  });

  it('does not skip C++ (the pathology is C-only)', () => {
    const src = genPureMacroHeader(100);
    const r = extractFromSource('specmode.h', src, 'cpp');

    expect(skipped(r)).toBe(false);
  });

  it('CODEGRAPH_FORCE_PARSE=1 forces the normal parse path', () => {
    const src = genPureMacroHeader(30);
    const prev = process.env.CODEGRAPH_FORCE_PARSE;
    process.env.CODEGRAPH_FORCE_PARSE = '1';
    try {
      const r = extractFromSource('force.h', src, 'c');
      expect(skipped(r)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.CODEGRAPH_FORCE_PARSE;
      else process.env.CODEGRAPH_FORCE_PARSE = prev;
    }
  });

  it('a handful of macros is not enough to trigger the skip', () => {
    // 5 macros, no declarations — still below the defineCount >= 20 threshold,
    // so this stays on the normal path (small files parse fine anyway).
    const src = genPureMacroHeader(5);
    const r = extractFromSource('small.h', src, 'c');

    expect(skipped(r)).toBe(false);
    // Still extracts whatever the normal path would.
    expect(r.nodes.some((n) => n.kind === 'file')).toBe(true);
  });

  it('blanks macro-body comments of a mixed header instead of degenerating (plan F)', () => {
    // Data macros + real declarations cannot take the fast path, but their
    // inline body comments used to collapse the parse: this exact shape
    // measured 17.3s with 3 of 102 macros surviving. Plan F blanks the
    // directive-body comments before parsing; everything survives, in ms.
    let body = '';
    for (let i = 0; i < 30; i++) {
      body += `#define TBL_${String(i).padStart(3, '0')} \\\n`;
      for (let r = 0; r < 3; r++) {
        body += `  { 28, /* row ${r} */ 28, 28, 28 }, \\\n`;
      }
      body += `  { 6, 6, 23, 28 }\n\n`;
    }
    const src = `#ifndef _H\n#define _H\n\ntypedef struct { int a; } S;\n\n${body}#endif\n`;
    const r = extractFromSource('mixed.h', src, 'c');

    expect(skipped(r)).toBe(false); // typedef keeps the normal path
    expect(r.durationMs).toBeLessThan(500);
    expect(macroNames(r).some((n) => n.name === 'TBL_000')).toBe(true);
    expect(macroNames(r).some((n) => n.name === 'TBL_029')).toBe(true);
    expect(r.nodes.some((n) => n.kind === 'struct' || n.kind === 'type_alias')).toBe(true);
  });

  it('skips a file whose macro bodies lost their continuation backslashes', () => {
    // Rows like a data table but WITHOUT the trailing backslash are top-level
    // brace residue. Real code can never be a whole top-level `{...}` row, and
    // the normal parse of such a file degenerates (~O(n²), collapsed tree — a
    // 485KB repro parsed 8.2 minutes), so the whitelist treats the residue as
    // inert data and keeps the file on the fast path.
    let body = '';
    for (let i = 0; i < 30; i++) {
      body += `#define ROW_${String(i).padStart(3, '0')} \\\n`;
      for (let r = 0; r < 3; r++) body += `  { 28, 28, 28 }\n`;
      body += '\n';
    }
    const r = extractFromSource('residue.h', `#ifndef _H\n#define _H\n\n${body}#endif\n`, 'c');

    expect(skipped(r)).toBe(true);
    expect(r.durationMs).toBeLessThan(500);
    expect(macroNames(r).some((n) => n.name === 'ROW_000')).toBe(true);
    expect(macroNames(r).some((n) => n.name === 'ROW_029')).toBe(true);
  });

  it.each([
    ['LF', '\n', ''],
    ['LF with trailing blanks', '\n', ' \t'],
    ['CRLF', '\r\n', ''],
    ['CRLF with trailing blanks', '\r\n', ' \t'],
  ])('accepts a residue trailing backslash under %s', (_label, newline, blanks) => {
    // These rows are outside every #define. A trailing backslash may be
    // ignored for DATA validation, but must not start a directive body.
    const src = (
      genSimpleMacros(24) +
      '  { 28, /* 载波 */ 28 } \\' + blanks + '\n' +
      '  { 6, 6, 23 }\n'
    ).replace(/\n/g, newline);
    const r = extractFromSource('residue_slash.h', src, 'c');

    expect(skipped(r)).toBe(true);
    expect(macroNames(r)).toHaveLength(25);
    expect(macroNames(r).find((n) => n.name === 'M000')?.startLine).toBe(4);
  });

  it('keeps D3-sized residue headers fast with or without a trailing backslash', () => {
    const lines = ['#ifndef _H', '#define _H', ''];
    const residueLineIndexes: number[] = [];
    const row = `    { ${Array(23).fill(28).join(', ')} }`;
    for (let i = 0; i < 100; i++) {
      lines.push(`#define ROW_${String(i).padStart(3, '0')} \\`);
      for (let r = 0; r < 50; r++) {
        // The first row belongs to the directive. The second is genuinely
        // top-level residue because the first row has no continuation.
        if (r === 1) residueLineIndexes.push(lines.length);
        lines.push(row);
      }
      lines.push('');
    }
    lines.push('#endif', '');
    const source = lines.join('\n');
    expect(source.length).toBeGreaterThan(450_000);
    // A future regression should fail immediately, not hang CI inside the
    // synchronous, minutes-long tree-sitter parse of this large fixture.
    const parseGuard = vi.spyOn(getParser('c')!, 'parse').mockImplementation(() => {
      throw new Error('D3-sized residue must use the fast path');
    });
    try {
      const baseline = extractFromSource('large_residue.h', source, 'c');
      expect(skipped(baseline)).toBe(true);
      for (const index of residueLineIndexes) lines[index] += ' \\';
      const continued = extractFromSource('large_residue.h', lines.join('\n'), 'c');

      expect(skipped(continued)).toBe(true);
      expect(parseGuard).not.toHaveBeenCalled();
      expect(baseline.durationMs).toBeLessThan(500);
      expect(continued.durationMs).toBeLessThan(500);
      expect(macroNames(continued)).toHaveLength(101);
      const metadata = (r: ReturnType<typeof extractFromSource>) => macroNames(r).map((n) => ({
        id: n.id, name: n.name, startLine: n.startLine, endLine: n.endLine,
        startColumn: n.startColumn, endColumn: n.endColumn, signature: n.signature,
      }));
      expect(metadata(continued)).toEqual(metadata(baseline));
      expect(macroNames(continued).find((n) => n.name === 'ROW_000')?.startLine).toBe(4);
      expect(macroNames(continued).find((n) => n.name === 'ROW_099')?.startLine).toBe(5152);
    } finally {
      parseGuard.mockRestore();
    }
  });

  it('a residue trailing backslash does not swallow the next real function', () => {
    const src = genSimpleMacros(24) +
      '{ 28, 28 } \\\nvoid real_fn(void) {}\n';
    const r = extractFromSource('residue_then_function.h', src, 'c');

    expect(skipped(r)).toBe(false);
    expect(r.nodes.some((n) => n.kind === 'function' && n.name === 'real_fn')).toBe(true);
  });

  it.each([
    ['embedded backslash', '{ 28, \\28 }'],
    ['standalone backslash', '\\'],
    ['multiple trailing backslashes', '{ 28, 28 } ' + '\\'.repeat(2)],
    ['backslash followed by a block comment', '{ 28, 28 } \\ /* note */'],
    ['backslash followed by a string', '{ 28, 28 } \\ "note"'],
  ])('rejects non-suffix residue escapes: %s', (_label, row) => {
    // No real declaration is appended: rejection must be caused by the
    // unsafe residue itself, not an unrelated declaration later in the file.
    const r = extractFromSource('unsafe_residue.h', genSimpleMacros(24) + row + '\n', 'c');
    expect(skipped(r)).toBe(false);
  });

  it('real code still keeps a residue file on the normal parse path', () => {
    // The residue allowance must not swallow actual declarations.
    let body = '';
    for (let i = 0; i < 30; i++) body += `#define ROW_${String(i).padStart(3, '0')} \\\n  { 28, 28, 28 }\n\n`;
    const src = `#ifndef _H\n#define _H\n\n${body}int real_fn(void) { return 0; }\n\n#endif\n`;
    const r = extractFromSource('residue_code.h', src, 'c');

    expect(skipped(r)).toBe(false);
    expect(r.nodes.some((n) => n.kind === 'function' && n.name === 'real_fn')).toBe(true);
  });

  it('a brace-shaped line carrying real code is not residue', () => {
    // `{} int real_fn(void) { return 0; }` begins with `{` and ends with `}`
    // but is real code; the tree-sitter parse recovers the function, so the
    // residue whitelist (data tokens only) must reject the line.
    const src =
      genSimpleMacros(24) +
      '{} int real_fn(void) { return 0; }\n';
    const r = extractFromSource('brace_code.h', src, 'c');

    expect(skipped(r)).toBe(false);
    expect(r.nodes.some((n) => n.kind === 'function' && n.name === 'real_fn')).toBe(true);
  });

  it('plan F never blanks the closer of a comment opened outside a directive', () => {
    // A block comment opened at top level spans into a line that LOOKS like a
    // directive inside the mask; blanking that line's `* /` would destroy the
    // comment boundary and swallow everything up to the NEXT comment closer —
    // TRAP, live (and only later) used to vanish. The single-scan lexer keeps
    // the global comment state, so the comment stays intact and every symbol
    // survives.
    const src =
      genSimpleMacros(24) +
      '/* documentation\n' +
      ' /* example marker */ #define TRAP 1\n' +
      'int live;\n' +
      '/* trailing note */\n' +
      'int later;\n';
    const r = extractFromSource('trap.h', src, 'c');

    expect(skipped(r)).toBe(false);
    const names = r.nodes.map((n) => n.name);
    expect(names).toContain('TRAP');
    expect(names).toContain('live');
    expect(names).toContain('later');
  });

  it('handles CRLF line endings identically', () => {
    const crlf = (s: string) => s.replace(/\r?\n/g, '\r\n');

    // No-semicolon function keeps the normal path under CRLF.
    const fn = extractFromSource('crlf_realfn.h', crlf(genSimpleMacros(20) + '\nvoid real_fn(void) {}\n'), 'c');
    expect(skipped(fn)).toBe(false);
    expect(fn.nodes.some((n) => n.kind === 'function' && n.name === 'real_fn')).toBe(true);

    // Ghost macro in a CRLF comment is skipped without becoming a node.
    const gh = extractFromSource(
      'crlf_ghost.h',
      crlf(genSimpleMacros(20) + '\n/*\n历史遗留:\n#define GHOST 1\n*/\n'),
      'c',
    );
    expect(skipped(gh)).toBe(true);
    expect(macroNames(gh).some((n) => n.name === 'GHOST')).toBe(false);

    // Line numbers stay correct when \r is present.
    const first = macroNames(fn).find((n) => n.name === 'M000');
    expect(first?.startLine).toBe(4); // #ifndef, #define _H, blank, M000
  });

  it('string literals do not open comments or become directives', () => {
    // A code line whose string contains `/*` and `#define` stays code.
    const code = extractFromSource(
      'strcode.h',
      genSimpleMacros(20) + '\nconst char *s = "/* not a comment; #define FAKE 1";\n',
      'c',
    );
    expect(skipped(code)).toBe(false);

    // A macro whose BODY is a string keeps the fast path and keeps the
    // string content in its signature (sliced from the original bytes).
    const mac = extractFromSource(
      'strmacro.h',
      genSimpleMacros(20) + '\n#define M100 "text; /* weird */"\n',
      'c',
    );
    expect(skipped(mac)).toBe(true);
    const m100 = macroNames(mac).find((n) => n.name === 'M100');
    expect(m100?.signature).toBe('#define M100 "text; /* weird */"');
  });

  it.each([
    ['LF', 20, false, '\n'],
    ['LF with a following small macro', 20, true, '\n'],
    ['large LF table', 302, false, '\n'],
    ['large CRLF table with a following small macro', 302, true, '\r\n'],
  ] as const)('blanks a single giant macro with an extern-C wrapper: %s', (_label, entries, followingMacro, newline) => {
    // Both sizes exceed the directive threshold, but neither reaches the
    // macro-count threshold. Only CAP comments may change in the parser
    // input; wrapper/lint comments and the real declaration stay intact.
    // Guard the parser input so a regression on these large fixtures fails
    // before entering the pathological traversal.
    const record = (last: boolean) =>
      `    { 0x05015000, 0, { 8, 9, 0, 300, 2, 0, 6, 6, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 1500, 300, 500, 500, 700, 1200, 65535, 700, 300, 65535, 65535, 65535, 65535, 8, 24, 0, 2038, 2038, 2038, 2038, 2038, 2038, 2038, 2038, 0, 0, 0 }, { 255, 0 }, { 1400, 1400, 3, 2600, 1400, 0, 0, 0, 25, 1, 1400, 2038, 2038, 2038, 2038, 2038, 2038, 2038, 2038 }, { 6000000, 937500, 6200, 6200, 0, 1400, 0, 24, 144, 24, 1, 0, 0, 0, 600000, 93750 } },` +
      (last ? '' : ' \\');
    let body = '';
    for (let i = 0; i < entries; i++) {
      body += `    /* CAP_UBBPFW${i}_NR_L2_ONLY */ \\\n${record(i === entries - 1)}\n`;
    }
    const directive = `#define L2INF_HAL_SPEC_ALL_DEFS_NOINF \\\n${body}`;
    expect(directive.replace(/\n/g, '').length).toBeGreaterThan(8192);
    const src = (
      `#ifndef L2INF_HAL_SPECMODEDEF_NOINF_H\n#define L2INF_HAL_SPECMODEDEF_NOINF_H\n\n` +
      `#if defined(__cplusplus) && __cplusplus\nextern "C" {\n#endif /* __cplusplus */\n` +
      `/*lint -e798 */\n${directive}/*lint +e798 */\n` +
      (followingMacro ? `#define TABLE_COUNT ${entries}\n` : '') +
      '/* keep the declaration comment */\nint live;\n' +
      `#if defined(__cplusplus) && __cplusplus\n}\n#endif /* __cplusplus */\n\n#endif /* _H */\n`
    ).replace(/\n/g, newline);
    expect(src.match(/^#define\b/gm)).toHaveLength(followingMacro ? 3 : 2);
    const expected = src.replace(/\/\* CAP_[^\r\n]*?\*\//g, (comment) => ' '.repeat(comment.length));
    expect(expected === src).toBe(false);
    const r = extractWithExpectedParseSource(src, expected);

    expect(skipped(r)).toBe(false); // extern "C" keeps the normal path
    expect(r.durationMs).toBeLessThan(500);
    const macros = macroNames(r);
    expect(macros.some((n) => n.name === 'L2INF_HAL_SPEC_ALL_DEFS_NOINF')).toBe(true);
    expect(macros.some((n) => n.name === 'L2INF_HAL_SPECMODEDEF_NOINF_H')).toBe(true);
    expect(macros.find((n) => n.name === 'L2INF_HAL_SPEC_ALL_DEFS_NOINF')?.startLine).toBe(8);
    expect(macros).toHaveLength(followingMacro ? 3 : 2);
    if (followingMacro) {
      expect(macros.find((n) => n.name === 'TABLE_COUNT')).toMatchObject({
        signature: `#define TABLE_COUNT ${entries}${newline}`,
        startLine: src.split('\n').findIndex((line) => line.startsWith('#define TABLE_COUNT')) + 1,
      });
    }
    expect(r.nodes.find((n) => n.name === 'live')).toMatchObject({
      kind: 'variable',
      startLine: src.split('\n').findIndex((line) => line.startsWith('int live;')) + 1,
    });
  });

  it.each([
    ['LF below threshold', '\n', 8191, false],
    ['LF at threshold', '\n', 8192, false],
    ['CRLF below threshold', '\r\n', 8191, false],
    ['CRLF at threshold', '\r\n', 8192, false],
    ['LF at EOF', '\n', 8192, true],
    ['CRLF at EOF', '\r\n', 8192, true],
  ] as const)('counts the final non-continued macro body line: %s', (_label, newline, size, atEof) => {
    const header = '#define TABLE \\';
    const comment = '/* table row */';
    const continued = `  ${comment} \\`;
    const tailPrefix = '  { 0';
    const tailSuffix = ' }';
    const paddingSize = size - header.length - continued.length - tailPrefix.length - tailSuffix.length;
    const tail = tailPrefix + ' '.repeat(paddingSize) + tailSuffix;
    // Threshold units exclude line terminators. Almost all of the size is
    // in the final line, which intentionally has NO trailing backslash.
    expect(header.length + continued.length + tail.length).toBe(size);
    const src = [header, continued, tail, ...(atEof ? [] : ['int live;', ''])].join(newline);
    const expected = size >= 8192 ? src.replace(comment, ' '.repeat(comment.length)) : src;
    const r = extractWithExpectedParseSource(src, expected);
    expect(skipped(r)).toBe(false);
    expect(macroNames(r).map((n) => n.name)).toEqual(['TABLE']);
    if (!atEof) expect(r.nodes.some((n) => n.name === 'live')).toBe(true);
  });

  it('does not count unrelated continued lines after a completed small macro', () => {
    const src = '#define SMALL 1 /* keep macro comment */\n' +
      `/* ${'padding '.repeat(1100)} */ \\\nint live;\n`;
    expect(src.length).toBeGreaterThan(8192);
    const r = extractWithExpectedParseSource(src, src);
    expect(macroNames(r).map((n) => n.name)).toEqual(['SMALL']);
    expect(r.nodes.some((n) => n.name === 'live')).toBe(true);
  });

  it('does not add together separate sub-threshold macros', () => {
    const src = ['FIRST', 'SECOND'].map((name) =>
      `#define ${name} \\\n  /* keep */ ${' '.repeat(5000)}1\n`,
    ).join('') + 'int live;\n';
    expect(src.length).toBeGreaterThan(8192);
    const r = extractWithExpectedParseSource(src, src);
    expect(macroNames(r).map((n) => n.name)).toEqual(['FIRST', 'SECOND']);
    expect(r.nodes.some((n) => n.name === 'live')).toBe(true);
  });

  it('handles a Chinese banner with semicolons and a ghost define', () => {
    const banner =
      '/*\n * 文件标识: 复杂载波规格目标配置表;\n * 说明: 表格数据;\n#define GHOST_CN 1\n */\n';
    const r = extractFromSource('cn.h', banner + genSimpleMacros(20), 'c');

    expect(skipped(r)).toBe(true);
    const macros = macroNames(r);
    expect(macros.some((n) => n.name === 'GHOST_CN')).toBe(false);
    // Masking is length-preserving per UTF-16 code unit, so the first macro
    // still sits on its physical line: 5 banner lines, #ifndef, #define _H,
    // a blank line, then M000. (Before the line-local-blank regex fix the
    // match swallowed the blank line and reported line 8.)
    expect(macros.find((n) => n.name === 'M000')?.startLine).toBe(9);
  });
});
