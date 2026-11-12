import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
const { DatabaseSync } = require('node:sqlite');
import type { SqliteDatabase } from '../src/db/sqlite-adapter';
import { checkTermMappings, formatMappingsCheck } from '../src/cli/term-mappings-check';

let directory: string;
let db: InstanceType<typeof DatabaseSync>;
function write(symbols: string[] = ['getChannel']) {
  fs.writeFileSync(path.join(directory, 'term-mappings.json'), JSON.stringify({ rules: [{ terms: ['信道配置'], symbols }] }));
}
function graph(status: 'complete' | 'incomplete' | 'unknown' = 'complete', stale = false) {
  return {
    getExploreQueryConnection: () => db as unknown as SqliteDatabase,
    getIndexCompleteness: () => ({ status, diagnostics: [] }),
    isIndexStale: () => stale,
    getChangedFiles: vi.fn(() => ({ added: [] as string[], modified: [] as string[], removed: [] as string[] })),
  };
}
function insert(id: string, name = 'getChannel', qualifiedName = name, kind = 'function') {
  db.prepare('INSERT INTO nodes VALUES (?, ?, ?, ?, ?, ?)').run(id, name, qualifiedName, kind, `${id}.cpp`, 12);
}
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mapping-check-'));
  db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE nodes (id TEXT, name TEXT, qualified_name TEXT, kind TEXT, file_path TEXT, start_line INTEGER)');
});
afterEach(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });

describe('maintainer mappings validation', () => {
  it('reports precise case-sensitive names and qualified names without scanning source by default', () => {
    write(['getChannel', 'Radio::getRadioCfg', 'getchannel', 'getChannelOld']);
    insert('channel'); insert('cfg', 'getRadioCfg', 'Radio::getRadioCfg');
    const reader = graph();
    const report = checkTermMappings(directory, reader);
    expect(report.results.map(result => result.status)).toEqual(['FOUND', 'FOUND', 'NOT_FOUND_IN_INDEX', 'NOT_FOUND_IN_INDEX']);
    expect(report.results[0]?.candidates[0]).toMatchObject({ name: 'getChannel', filePath: 'channel.cpp', startLine: 12 });
    expect(reader.getChangedFiles).not.toHaveBeenCalled();
    expect(report.source.status).toBe('not_checked');
    expect(report.exitCode).toBe(1);
    expect(formatMappingsCheck(report)).toContain('does not prove');
  });

  it('counts all same-name candidates without inferring uniqueness from a display limit', () => {
    write(); for (let index = 0; index < 27; index++) insert(`candidate${index}`);
    const report = checkTermMappings(directory, graph());
    expect(report.results[0]).toMatchObject({ status: 'MULTIPLE', count: 27, truncated: true });
    expect(report.results[0]?.candidates).toHaveLength(20);
    expect(report.exitCode).toBe(0);
    expect(formatMappingsCheck(report)).toContain('Showing 20 of 27');
  });

  it('deduplicates repeated symbols across rules', () => {
    fs.writeFileSync(path.join(directory, 'term-mappings.json'), JSON.stringify({ rules: [
      { terms: ['信道'], symbols: ['getChannel'] }, { terms: ['参数'], symbols: ['getChannel'] },
    ] }));
    insert('channel');
    expect(checkTermMappings(directory, graph())).toMatchObject({ ruleCount: 2, uniqueSymbolCount: 1, exitCode: 0 });
  });

  it('does not count file or import nodes as a target symbol', () => {
    write(['getChannel']); insert('file', 'getChannel', 'getChannel', 'file'); insert('import', 'getChannel', 'getChannel', 'import');
    expect(checkTermMappings(directory, graph()).results[0]?.status).toBe('NOT_FOUND_IN_INDEX');
  });

  it.each(['incomplete', 'unknown'] as const)('does not certify missing symbols against %s coverage', status => {
    write(['getChannel', 'missing']); insert('channel');
    const report = checkTermMappings(directory, graph(status));
    expect(report.results.map(result => result.status)).toEqual(['FOUND', 'UNVERIFIED']);
    expect(report.exitCode).toBe(2);
  });

  it('does not certify missing symbols from an old extractor version', () => {
    write();
    const report = checkTermMappings(directory, graph('complete', true));
    expect(report.results[0]?.status).toBe('UNVERIFIED'); expect(report.exitCode).toBe(2);
  });

  it('only scans source when explicitly requested and downgrades unsynchronized results', () => {
    write(); const reader = graph();
    reader.getChangedFiles.mockReturnValue({ added: [], modified: ['radio.cpp'], removed: [] });
    const report = checkTermMappings(directory, reader, { checkSource: true });
    expect(reader.getChangedFiles).toHaveBeenCalledOnce();
    expect(report.source).toEqual({ status: 'changed', added: 0, modified: 1, removed: 0 });
    expect(report.results[0]?.status).toBe('UNVERIFIED'); expect(report.exitCode).toBe(2);
  });

  it('reports synchronized source separately from coverage', () => {
    write(); insert('channel');
    expect(checkTermMappings(directory, graph(), { checkSource: true })).toMatchObject({ source: { status: 'unchanged' }, exitCode: 0 });
  });

  it('does not scan a mismatched working tree', () => {
    write(); const reader = graph();
    const report = checkTermMappings(directory, reader, { checkSource: true, worktreeMismatch: true });
    expect(reader.getChangedFiles).not.toHaveBeenCalled();
    expect(report.source.status).toBe('unverified'); expect(report.exitCode).toBe(2);
  });

  it('distinguishes absent index and malformed config from a valid missing symbol', () => {
    write();
    expect(checkTermMappings(directory)).toMatchObject({ exitCode: 2, results: [{ status: 'UNVERIFIED' }] });
    fs.writeFileSync(path.join(directory, 'term-mappings.json'), '{');
    const reader = graph();
    const query = vi.spyOn(reader, 'getExploreQueryConnection');
    const invalid = checkTermMappings(directory, reader);
    expect(invalid.exitCode).toBe(2); expect(invalid.errors.length).toBeGreaterThan(0); expect(query).not.toHaveBeenCalled();
  });

  it('reports absent configuration as an incomplete check', () => {
    expect(checkTermMappings(directory, graph())).toMatchObject({ exitCode: 2, ruleCount: 0, results: [] });
  });

  it('handles database and source scan failures as unverified without retrying writes', () => {
    write(); const reader = graph();
    reader.getChangedFiles.mockImplementation(() => { throw new Error('Source scan unavailable'); });
    const report = checkTermMappings(directory, reader, { checkSource: true });
    expect(report.exitCode).toBe(2); expect(report.errors).toContain('Source scan unavailable');
    expect(report.results[0]?.status).toBe('UNVERIFIED');
  });
});
