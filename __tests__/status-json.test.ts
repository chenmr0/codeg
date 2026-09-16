/**
 * Tests for the CI/scripting fields `codegraph status --json` exposes (issue
 * #329): the `version`, `indexPath`, and `lastIndexed` fields, plus the
 * matching `CodeGraph.getLastIndexedAt()` library method.
 *
 * The CLI itself is exercised end-to-end against the built binary so the JSON
 * field names survive future refactors of the underlying plumbing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');
const PKG_VERSION = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf-8'),
).version as string;

function runStatusJson(cwd: string): Record<string, unknown> {
  const stdout = execFileSync(process.execPath, [BIN, 'status', '--json'], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // JSON mode prints exactly one line to stdout; be defensive about any stray
  // leading output by parsing the last non-empty line.
  const line = stdout.trim().split('\n').filter(Boolean).pop()!;
  return JSON.parse(line);
}

describe('codegraph status --json — CI fields (#329)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-status-json-'));
  });
  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('getLastIndexedAt() is null before indexing and a recent ms timestamp after', async () => {
    const cg = CodeGraph.initSync(tempDir);
    expect(cg.getLastIndexedAt()).toBeNull();

    fs.writeFileSync(path.join(tempDir, 'a.ts'), 'export const x = 1;\n');
    const before = Date.now();
    await cg.indexAll();
    const after = Date.now();

    const last = cg.getLastIndexedAt();
    expect(last).not.toBeNull();
    expect(typeof last).toBe('number');
    expect(last!).toBeGreaterThanOrEqual(before - 1000);
    expect(last!).toBeLessThanOrEqual(after + 1000);
    cg.close();
  });

  it('status --json on an UNINITIALIZED project reports version + indexPath + lastIndexed:null', () => {
    const out = runStatusJson(tempDir);
    expect(out.initialized).toBe(false);
    expect(out.version).toBe(PKG_VERSION);
    expect(typeof out.indexPath).toBe('string');
    expect(out.indexPath as string).toContain('.codegraph-wx');
    expect(out.lastIndexed).toBeNull();
  });

  it('status --json on an INDEXED project reports version + indexPath + a round-trippable lastIndexed', async () => {
    fs.writeFileSync(path.join(tempDir, 'a.ts'), 'export const x = 1;\n');
    const before = Date.now();
    const cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    const after = Date.now();
    cg.close();

    const out = runStatusJson(tempDir);
    expect(out.initialized).toBe(true);
    expect(out.version).toBe(PKG_VERSION);
    expect(out.indexPath as string).toContain('.codegraph-wx');
    expect(typeof out.lastIndexed).toBe('string');
    // ISO string that round-trips back into the index window.
    const ms = Date.parse(out.lastIndexed as string);
    expect(ms).toBeGreaterThanOrEqual(before - 1000);
    expect(ms).toBeLessThanOrEqual(after + 1000);
  });

  it('init exits successfully but reports and persists explicitly incomplete coverage', () => {
    fs.writeFileSync(path.join(tempDir, 'a.c'), 'int answer(void) { return 42; }\n');
    const initialized = spawnSync(process.execPath, [BIN, 'init', tempDir], {
      cwd: tempDir,
      encoding: 'utf-8',
      env: {
        ...process.env,
        CI: '1',
        CODEGRAPH_NO_DAEMON: '1',
        CODEGRAPH_NO_SYNTHESIS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    expect(initialized.status).toBe(0);
    expect(`${initialized.stdout}\n${initialized.stderr}`).toContain(
      'Initialized with incomplete graph coverage'
    );

    const out = runStatusJson(tempDir);
    const index = out.index as {
      completeness: string;
      diagnostics: Array<{ code?: string }>;
    };
    expect(index.completeness).toBe('incomplete');
    expect(index.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'synthesis_disabled' })
    );
  });

  it('status explains that a base-only file is usable but missing macro-generated declarations', () => {
    const cg = CodeGraph.initSync(tempDir);
    const queries = (cg as unknown as {
      queries: { setMetadata(key: string, value: string): void };
    }).queries;
    queries.setMetadata('index_completeness', 'incomplete');
    queries.setMetadata('index_diagnostics', JSON.stringify([{
      severity: 'warning',
      code: 'declaration_macro_recovery_skipped',
      filePath: 'src/macros.cpp',
      message:
        'Base AST symbols were indexed, but declarations generated only by macros may be missing.',
    }]));
    cg.close();

    const status = spawnSync(process.execPath, [BIN, 'status'], {
      cwd: tempDir,
      encoding: 'utf-8',
      env: { ...process.env, CODEGRAPH_NO_DAEMON: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = `${status.stdout}\n${status.stderr}`;

    expect(status.status).toBe(0);
    expect(output).toContain('Base AST symbols were indexed');
    expect(output).toContain('retry full declaration-macro recovery');
    expect(output).toContain('codegraph sync');
    expect(output).not.toContain('Fix the reported file errors');
  });
});
