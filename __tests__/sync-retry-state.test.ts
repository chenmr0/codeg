import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeRetrySafeComments, retryFingerprint, SyncRetryState } from '../src/extraction/sync-retry-state';
import type { ExtractionResult, FileRecord, Node, UnresolvedReference } from '../src/types';
import type { QueryBuilder } from '../src/db/queries';

afterEach(() => vi.unstubAllEnvs());

const source = 'int target(void) { return 1; }\n';
function extraction(overrides: Partial<Node> = {}): ExtractionResult {
  return { nodes: [{ id: 'id', kind: 'function', name: 'target', qualifiedName: 'target',
    filePath: 'api.c', language: 'c', startLine: 1, endLine: 1, startColumn: 0,
    endColumn: 29, updatedAt: 1, signature: 'int target(void)', ...overrides }],
    edges: [], unresolvedReferences: [], errors: [], durationMs: 0 };
}

function fixture() {
  const metadata = new Map<string, string>();
  const files = new Map<string, FileRecord>();
  const names = new Map<string, string[]>();
  const query = {
    getMetadata: (key: string) => metadata.get(key) ?? null,
    setMetadata: (key: string, value: string) => { metadata.set(key, value); },
    getMetadataByPrefix: (prefix: string) => [...metadata].filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value })),
    applyMetadataChanges: (changes: Record<string, string | null>) => {
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) metadata.delete(key); else metadata.set(key, value);
      }
    },
    getFileByPath: (file: string) => files.get(file),
    getNodeNamesByFiles: (paths: string[]) => [...new Set(paths.flatMap(file => names.get(file) ?? []))],
    getFailedReferenceNames: () => ['lost_name'],
  } as unknown as QueryBuilder;
  const store = (state: SyncRetryState, text = source, file = 'api.c', result = extraction()) => {
    state.beforeStore(file, text, text, 'c', result, files.get(file));
    files.set(file, { path: file, contentHash: text, language: 'c', size: text.length,
      modifiedAt: 1, indexedAt: 1, nodeCount: result.nodes.length, errors: result.errors });
    names.set(file, result.nodes.map(node => node.name));
  };
  const baseline = new SyncRetryState(query);
  store(baseline);
  baseline.complete();
  return { metadata, files, names, query, store };
}

describe('conservative comment proof', () => {
  it('removes only lexically real standalone prose block comments, including CRLF', () => {
    for (const newline of ['\n', '\r\n']) {
      const code = source.replace(/\n/g, newline);
      expect(normalizeRetrySafeComments(`/* revision 1 */${newline}${code}  /* revision 2 */${newline}`))
        .toBe(code.trimEnd());
    }
    expect(normalizeRetrySafeComments('const char *s = "/* not a comment */";\n'))
      .toBe('const char *s = "/* not a comment */";');
  });

  it.each([
    '/* Type receiver; */', '// Type receiver', '/*\nType receiver\n*/',
    '/* #define MAGIC */', '/* a(b) */', '/* @annotation */',
    '/* <Type> */', '/* x = y */', '/* nested /* text */',
  ])('retains raw-inference-sensitive comment %s', comment => {
    expect(normalizeRetrySafeComments(source + comment + '\n')).not.toBe(normalizeRetrySafeComments(source));
  });

  it.each([
    '#define M\\\n 1\n', '#define M \\ \r\n 1\n', 'auto s = R"(raw)";\n',
    'int x = __LINE__;\n', '/* unterminated', 'char *s = "unterminated',
    '// continuation\\\n/* comment */\n', '??/\n',
  ])('rejects uncertain lexical input %s', text => {
    expect(normalizeRetrySafeComments(text)).toBeNull();
  });

  it('retains inline comments and top-level multiline comment state', () => {
    expect(normalizeRetrySafeComments('int /* prose */ x;\n')).toBe('int /* prose */ x;');
    const trap = '/* top\n/* harmless prose */\nint live;\n';
    expect(normalizeRetrySafeComments(trap)).toBe(trap.trimEnd());
  });

  it('keeps whitespace-delimited macro splices and continued comments verbatim', () => {
    for (const code of ['#define M \\\n    /* macro prose */ \\\n    1\n',
      '#define MSG(type) text, \\\n#type " expected"\n',
      '// continued comment \\\n    /* not a separate comment */\n',
      '/* block \\\n    continued */\n', 'const char *s = "text \\\n    text";\n']) {
      expect(normalizeRetrySafeComments(code + '/* suffix */\n')).toBe(code.trimEnd());
    }
    expect(normalizeRetrySafeComments('/\\\n* split delimiter */\n')).toBeNull();
    expect(normalizeRetrySafeComments(' \\\n    /* prose */\n')).toBe(' \\\n    /* prose */');
  });

  it('keeps long comment-heavy logical macro lines without removing their bodies', () => {
    const macro = '#define TABLE \\\n' + '    /* item */ { 1, 2, 3 }, \\\n'.repeat(4000) + '    { 4, 5, 6 }\n';
    expect(normalizeRetrySafeComments(macro + '/* suffix */\n')).toBe(macro.trimEnd());
  });

  it('ignores positions but invalidates changed signatures, return types, kinds and edges', () => {
    const original = retryFingerprint(source, 'c', extraction());
    expect(retryFingerprint(source + '/* note */\n', 'c', extraction({
      id: 'new-id', startLine: 2, updatedAt: 100, docstring: 'note',
    }))).toBe(original);
    for (const change of [{ signature: 'int target(int x)' }, { returnType: 'Widget' },
      { kind: 'method' as const }, { qualifiedName: 'Other::target' }]) {
      expect(retryFingerprint(source, 'c', extraction(change))).not.toBe(original);
    }
    const withEdge = extraction();
    withEdge.edges.push({ source: 'id', target: 'id', kind: 'contains' });
    expect(retryFingerprint(source, 'c', withEdge)).not.toBe(original);
    expect(retryFingerprint(source, 'python', extraction())).toBeNull();
    const withError = extraction();
    withError.errors.push({ message: 'incomplete', severity: 'warning' });
    expect(retryFingerprint(source, 'c', withError)).toBeNull();
  });
});

describe('write-ahead retry state', () => {
  it('skips only untouched C/C++ refs after a consumed matching baseline', () => {
    const f = fixture();
    const state = new SyncRetryState(f.query);
    f.store(state, source + '/* revision 2 */\n');
    const plan = state.plan(true);
    expect(plan.filtered).toBe(true);
    const ref = { filePath: 'caller.cpp', language: 'cpp' } as UnresolvedReference;
    expect(plan.shouldRetry(ref)).toBe(false);
    expect(plan.shouldRetry({ ...ref, filePath: 'api.c', language: 'c' })).toBe(true);
    expect(plan.shouldRetry({ ...ref, language: 'python' })).toBe(true);
    expect(plan.shouldRetry({ ...ref, language: undefined })).toBe(true);
    expect(plan.shouldRetry({ ...ref, filePath: undefined })).toBe(true);
    expect(state.plan(true, ['caller.cpp']).shouldRetry(ref)).toBe(true);
    expect(state.plan(false).filtered).toBe(false);
  });

  it.each(['return 2', 'int added;', '#include "new.h"', '#define NEW 1', '/* Type receiver; */'])
    ('falls back for a code/directive/risky-comment edit: %s', edit => {
      const f = fixture();
      const state = new SyncRetryState(f.query);
      f.store(state, source + edit + '\n');
      expect(state.plan(true).filtered).toBe(false);
    });

  it('does not cancel an unsafe contribution with a stable same-name file', () => {
    const f = fixture();
    const state = new SyncRetryState(f.query);
    f.store(state, source + '/* comment */\n');
    f.store(state, source, 'new.c', extraction({ filePath: 'new.c' }));
    expect(state.plan(true)).toMatchObject({ filtered: false, names: ['target'] });
  });

  it.each([null, '{bad', '{"version":"old"}'])('cold or invalid baseline %s retains full retry', value => {
    const f = fixture();
    if (value === null) f.metadata.delete('sync-retry:done:api.c');
    else f.metadata.set('sync-retry:done:api.c', value);
    const state = new SyncRetryState(f.query);
    f.store(state, source + '/* comment */\n');
    expect(state.plan(true).filtered).toBe(false);
  });

  it('disable switch retains journaling and full retries', () => {
    const f = fixture();
    vi.stubEnv('CODEGRAPH_NO_SYNC_RETRY_FILTER', '1');
    const state = new SyncRetryState(f.query);
    f.store(state, source + '/* comment */\n');
    expect(state.plan(true).filtered).toBe(false);
    expect(f.metadata.has('sync-retry:pending:api.c')).toBe(true);
  });

  it('recovers after store without promoting its unconsumed proof, merging successive edits', () => {
    const f = fixture();
    const done = f.metadata.get('sync-retry:done:api.c');
    const interrupted = new SyncRetryState(f.query);
    f.store(interrupted, source + '/* comment */\n');
    expect(f.metadata.get('sync-retry:done:api.c')).toBe(done);
    const recovered = new SyncRetryState(f.query);
    expect(recovered.hasWork).toBe(true);
    expect(recovered.plan(true).filtered).toBe(false);
    f.store(recovered, 'int replacement;\n', 'api.c', extraction({ name: 'replacement' }));
    expect(recovered.plan(true).names).toEqual(expect.arrayContaining(['target', 'replacement']));
    recovered.complete();
    expect(new SyncRetryState(f.query).hasWork).toBe(false);
    expect(f.metadata.get('sync-retry:done:api.c')).not.toBe(done);
  });

  it('invalidates before delete/re-add and never promotes an unstored hash', () => {
    const f = fixture();
    const state = new SyncRetryState(f.query);
    state.beforeDelete('api.c');
    f.files.delete('api.c');
    f.store(state, source);
    expect(state.plan(true).filtered).toBe(false);
    f.files.delete('api.c');
    state.complete();
    expect(f.metadata.has('sync-retry:done:api.c')).toBe(false);
  });

  it('recovers malformed journal conservatively across all failed names', () => {
    const f = fixture();
    f.metadata.set('sync-retry:pending:api.c', '{broken');
    const state = new SyncRetryState(f.query);
    expect(state.plan(true)).toMatchObject({ filtered: false });
    expect(state.plan(true).names).toContain('lost_name');
    f.store(state, source + '/* another edit */\n');
    // A second interruption after overwriting the malformed entry must not
    // lose the conservative name set discovered during its first recovery.
    expect(new SyncRetryState(f.query).plan(true).names).toContain('lost_name');
  });

  it('journals forced fallback as scoped work without adding a global retry or reusable proof', () => {
    const f = fixture();
    const state = new SyncRetryState(f.query);
    state.finishPrimaryExtraction();
    f.store(state, 'int extra;\n', 'other.c', extraction({ name: 'extra' }));
    const recovered = new SyncRetryState(f.query);
    expect(recovered.filePaths).toEqual(['other.c']);
    expect(recovered.plan(true).names).toEqual([]);
    expect(recovered.plan(true).filtered).toBe(false);
    recovered.complete();
    expect(JSON.parse(f.metadata.get('sync-retry:done:other.c')!).fingerprint).toBeNull();
  });
});
