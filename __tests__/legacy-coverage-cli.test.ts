import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
import type { QueryBuilder } from '../src/db/queries';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');
let directory: string;

function run(...args: string[]): string {
  const result = spawnSync(process.execPath, ['--liftoff-only', BIN, ...args], {
    cwd: directory, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, CI: '1', CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_NO_SYNTHESIS: '0' },
  });
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return `${result.stdout}\n${result.stderr}`;
}

function status(): Record<string, unknown> {
  return JSON.parse(run('status', '--json').split('\n').find(line => line.startsWith('{'))!).index;
}

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-legacy-coverage-cli-'));
  fs.writeFileSync(path.join(directory, 'api.c'), 'int target(void) { return 1; }\n');
  const cg = CodeGraph.initSync(directory);
  try {
    expect((await cg.indexAll()).complete).toBe(true);
    // Unit simulation of known old metadata, not a historical-engine fixture.
    const queries = (cg as unknown as { queries: QueryBuilder }).queries;
    queries.applyMetadataChanges({
      indexed_with_version: '1.1.1', indexed_with_extraction_version: '34',
      index_completeness: 'complete', index_diagnostics: '[]',
      index_synthesis_completed_version: null, index_synthesis_verification_started: null,
    });
  } finally { cg.close(); }
});

afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

describe('CLI legacy coverage messaging (simulated old metadata)', () => {
  it('reports usable, unverified coverage in status JSON and text', () => {
    expect(status()).toMatchObject({
      completeness: 'unknown', legacyUnverified: true, diagnostics: [],
      coverageWarning: expect.stringContaining('Run "codegraph index"'),
    });
    const output = run('status');
    expect(output).toContain('legacy index usable; synthesis coverage unverified');
    expect(output).toContain('Indexed source files are up to date');
    expect(output).toContain('Run "codegraph index" to refresh extraction and verify coverage');
    expect(output).not.toContain('codegraph index -f');
    expect(output).not.toContain('or "codegraph sync"');
    expect(output).not.toContain('Coverage:  complete');
  });

  it('keeps unchanged sync nonblocking without presenting it as verified', () => {
    const output = run('sync');
    expect(output).toContain('No source changes; legacy synthesis coverage is unverified');
    expect(output).toContain('Legacy index is usable; synthesis coverage is unverified');
    expect(output).toContain('Run "codegraph index" to verify and upgrade coverage');
    expect(output).not.toContain('graph coverage is incomplete');
    expect(output).not.toContain('Already up to date');
    expect(status()).toMatchObject({ completeness: 'unknown', legacyUnverified: true, diagnostics: [] });
  });

  it.each([false, true])('returns exit zero for a successful legacy edit (enrolled=%s)', enrolled => {
    if (enrolled) run('sync');
    fs.appendFileSync(path.join(directory, 'api.c'), '\n/* changed */\n');
    const output = run('sync');
    expect(output).toContain('Legacy index is usable; synthesis coverage is unverified');
    expect(output).not.toContain('graph coverage is incomplete');
    expect(status()).toMatchObject({ completeness: 'unknown', legacyUnverified: true, diagnostics: [] });
  });

  it('ordinary index verifies and upgrades coverage without a force flag', () => {
    run('index');
    const verified = status();
    expect(verified).toMatchObject({ completeness: 'complete', diagnostics: [], reindexRecommended: false });
    expect(verified).not.toHaveProperty('legacyUnverified');
    expect(verified).not.toHaveProperty('coverageWarning');
    expect(run('sync')).toContain('Already up to date');
  });

  it('retains actual incomplete diagnostics instead of the legacy notice', async () => {
    const cg = await CodeGraph.open(directory);
    try {
      const queries = (cg as unknown as { queries: QueryBuilder }).queries;
      queries.applyMetadataChanges({
        index_completeness: 'incomplete', index_diagnostics: JSON.stringify([{
          severity: 'warning', code: 'synthesis_disabled', message: 'Dynamic-edge synthesis was disabled.',
        }]),
      });
    } finally { cg.close(); }
    expect(status()).toMatchObject({ completeness: 'incomplete', diagnostics: [
      expect.objectContaining({ code: 'synthesis_disabled' }),
    ] });
    const output = run('status');
    expect(output).toContain('Dynamic-edge synthesis was disabled.');
    expect(output).not.toContain('Legacy index is usable');
  });
});
