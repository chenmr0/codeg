import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import CodeGraph from '../src/index';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');
let root: string;
function command(args: string[]) {
  const result = spawnSync(process.execPath, ['--liftoff-only', BIN, 'mappings', 'check', ...args], {
    cwd: root, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CI: '1' },
  });
  expect(result.error).toBeUndefined(); return result;
}
function config(symbols: string[]) {
  fs.mkdirSync(path.join(root, '.codegraph-wx'), { recursive: true });
  fs.writeFileSync(path.join(root, '.codegraph-wx', 'term-mappings.json'), JSON.stringify({ rules: [{ terms: ['信道配置'], symbols }] }));
}
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mapping-cli-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('built mappings check CLI', () => {
  it('reports invalid config and missing index without creating a database', () => {
    config(['getChannel']);
    const missing = command(['--json']);
    expect(missing.status, missing.stderr).toBe(2);
    expect(JSON.parse(missing.stdout)).toMatchObject({ index: { status: 'unavailable' }, results: [{ status: 'UNVERIFIED' }] });
    expect(fs.existsSync(path.join(root, '.codegraph-wx', 'codegraph.db'))).toBe(false);
    fs.writeFileSync(path.join(root, '.codegraph-wx', 'term-mappings.json'), 'not json');
    const invalid = command(['--json']); expect(invalid.status, invalid.stderr).toBe(2);
    expect(JSON.parse(invalid.stdout).errors.length).toBeGreaterThan(0);
  });

  it('checks a real index without syncing changed sources or altering database bytes', async () => {
    fs.writeFileSync(path.join(root, 'radio.cpp'), 'int getChannel() { return 1; }\n');
    const graph = CodeGraph.initSync(root);
    try { await graph.indexAll(); } finally { graph.close(); await graph.whenIdle(); }
    config(['getChannel', 'getRadioCfg']);
    const dbPath = path.join(root, '.codegraph-wx', 'codegraph.db');
    const hash = () => createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');
    const before = hash();
    const plain = command(['--json']);
    expect(plain.status, plain.stderr).toBe(1);
    expect(JSON.parse(plain.stdout)).toMatchObject({ source: { status: 'not_checked' }, results: [{ status: 'FOUND' }, { status: 'NOT_FOUND_IN_INDEX' }] });
    fs.appendFileSync(path.join(root, 'radio.cpp'), 'int getRadioCfg() { return 2; }\n');
    const changed = command(['--json', '--check-source']);
    expect(changed.status, changed.stderr).toBe(2);
    expect(JSON.parse(changed.stdout)).toMatchObject({ source: { status: 'changed', modified: 1 }, results: [{ status: 'FOUND' }, { status: 'UNVERIFIED' }] });
    expect(hash()).toBe(before);
  }, 60000);
});
