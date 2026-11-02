import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDirectory, getCodeGraphDir, validateDirectory } from '../src/directory';
import { appendAdaptiveLog } from '../src/sync/adaptive-log';
import CodeGraph from '../src/index';

const roots: string[] = [];
function root(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-runtime-artifacts-'));
  roots.push(directory);
  return directory;
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('user-managed Git exclusions', () => {
  it.each(['.codegraph-wx', '.custom-index'])('does not create .gitignore during init or validation (%s)', name => {
    vi.stubEnv('CODEGRAPH_DIR', name === '.codegraph-wx' ? '' : name);
    const project = root();
    createDirectory(project);
    expect(validateDirectory(project)).toEqual({ valid: true, errors: [] });
    expect(fs.existsSync(path.join(project, '.gitignore'))).toBe(false);
    expect(fs.existsSync(path.join(getCodeGraphDir(project), '.gitignore'))).toBe(false);
  });
  it('preserves existing project and data-directory .gitignore byte for byte', () => {
    vi.stubEnv('CODEGRAPH_DIR', '');
    const project = root(), data = path.join(project, '.codegraph-wx');
    fs.mkdirSync(data);
    const bytes = Buffer.from('# user-managed\r\nsecret.db\r\n');
    for (const dir of [project, data]) fs.writeFileSync(path.join(dir, '.gitignore'), bytes);
    createDirectory(project);
    expect(validateDirectory(project).valid).toBe(true);
    for (const dir of [project, data]) expect(fs.readFileSync(path.join(dir, '.gitignore'))).toEqual(bytes);
  });
  it('does not repair a missing ignore file in a legacy data directory', () => {
    vi.stubEnv('CODEGRAPH_DIR', ''); vi.stubEnv('CODEGRAPH_LEGACY_COMPAT', '1');
    const project = root(), data = path.join(project, '.codegraph');
    fs.mkdirSync(data); fs.writeFileSync(path.join(data, 'codegraph.db'), '');
    expect(getCodeGraphDir(project)).toBe(data);
    expect(validateDirectory(project)).toEqual({ valid: true, errors: [] });
    expect(fs.existsSync(path.join(data, '.gitignore'))).toBe(false);
  });
});

describe('runtime-only adaptive diagnostics', () => {
  it.each(['.codegraph-wx', '.codegraph', '.custom-index'])('writes and rotates inside runtime, retaining old logs (%s)', name => {
    const data = path.join(root(), name); fs.mkdirSync(data);
    for (const suffix of ['', '.1']) fs.writeFileSync(path.join(data, 'adaptive-sync.log' + suffix), 'old' + suffix);
    appendAdaptiveLog(data, 'decision');
    const log = path.join(data, '.runtime', 'adaptive-sync.log');
    expect(fs.readFileSync(log, 'utf8')).toBe('decision\n');
    const large = 'x'.repeat(1024 * 1024 + 1); fs.writeFileSync(log, large);
    appendAdaptiveLog(data, 'rebuild-failed');
    expect(fs.readFileSync(log, 'utf8')).toBe('rebuild-failed\n');
    expect(fs.readFileSync(log + '.1', 'utf8')).toBe(large);
    for (const suffix of ['', '.1']) expect(fs.readFileSync(path.join(data, 'adaptive-sync.log' + suffix), 'utf8')).toBe('old' + suffix);
  });
  it('does not create root logs and tolerates unavailable runtime diagnostics', () => {
    const data = root();
    appendAdaptiveLog(data, 'decision');
    expect(fs.readdirSync(data)).toEqual(['.runtime']);
    const blocked = root(); fs.writeFileSync(path.join(blocked, '.runtime'), 'not a directory');
    expect(() => appendAdaptiveLog(blocked, 'failure')).not.toThrow();
    expect(fs.readdirSync(blocked)).toEqual(['.runtime']);
  });
});

it('real portable init and sync only create database and runtime entries', async () => {
  vi.stubEnv('CODEGRAPH_DIR', '');
  const project = root();
  fs.writeFileSync(path.join(project, 'main.ts'), 'export function hello() { return 1; }\n');
  const graph = await CodeGraph.init(project);
  try {
    await graph.indexAll();
    expect((await graph.sync()).complete).toBe(true);
  } finally { graph.close(); await graph.whenIdle(); }
  const data = getCodeGraphDir(project);
  expect(fs.readdirSync(data).sort()).toEqual(['.runtime', 'codegraph.db']);
  expect(fs.readFileSync(path.join(data, '.runtime', 'adaptive-sync.log'), 'utf8')).toContain('[adaptive-sync]');
  expect(fs.existsSync(path.join(project, '.gitignore'))).toBe(false);
});
