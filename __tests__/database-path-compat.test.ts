import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import CodeGraph from '../src';
import { DatabaseConnection, getDatabasePath } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { findNearestCodeGraphRoot, isInitialized } from '../src/directory';
import { getDaemonPidPath, getDaemonSocketPath } from '../src/mcp/daemon-paths';
import { FileLock } from '../src/utils';

describe('database path compatibility', () => {
  let root: string;
  let legacy: string;
  let preferred: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-path-compat-'));
    legacy = path.join(root, '.codegraph', 'codegraph.db');
    preferred = path.join(root, '.codegraph-wx', 'codegraph.db');
    vi.stubEnv('CODEGRAPH_DIR', '');
    vi.stubEnv('CODEGRAPH_LEGACY_COMPAT', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function seed(dbPath: string, version: string): void {
    const db = DatabaseConnection.initialize(dbPath);
    try {
      new QueryBuilder(db.getDb()).setMetadata('indexed_with_version', version);
    } finally {
      db.close();
    }
  }

  function openedVersion(): string | null {
    const cg = CodeGraph.openSync(root);
    try { return cg.getIndexBuildInfo().version; } finally { cg.close(); }
  }

  it('creates fresh indexes in .codegraph-wx without creating a legacy database', () => {
    const cg = CodeGraph.initSync(root);
    cg.close();
    expect(getDatabasePath(root)).toBe(preferred);
    expect(fs.existsSync(preferred)).toBe(true);
    expect(fs.existsSync(legacy)).toBe(false);
  });

  it('opens an existing legacy index in place by default, without importing it', () => {
    seed(legacy, 'legacy');
    expect(getDatabasePath(root)).toBe(legacy);
    expect(isInitialized(root)).toBe(true);
    expect(openedVersion()).toBe('legacy');
    expect(fs.existsSync(preferred)).toBe(false);
    expect(findNearestCodeGraphRoot(path.join(root, 'src', 'nested'))).toBe(root);
  });

  it('keeps init on an existing legacy project idempotent during compatibility', () => {
    seed(legacy, 'legacy');
    expect(() => CodeGraph.initSync(root)).toThrow(/already initialized/);
    expect(fs.existsSync(preferred)).toBe(false);
    expect(openedVersion()).toBe('legacy');
  });

  it('pins writes and uninitialization to the database an instance actually opened', async () => {
    seed(legacy, 'legacy');
    const old = CodeGraph.openSync(root);
    seed(preferred, 'preferred');
    const lockPath = path.join(path.dirname(preferred), 'codegraph.lock');
    const newLock = new FileLock(lockPath);
    let removed = false;
    newLock.acquire();
    try {
      const result = await old.indexFiles([]);
      expect(result.success).toBe(true);
      expect(fs.existsSync(lockPath)).toBe(true);
      old.uninitialize();
      removed = true;
      expect(fs.existsSync(legacy)).toBe(false);
      expect(fs.existsSync(preferred)).toBe(true);
    } finally {
      if (!removed) old.close();
      newLock.release();
    }
  });

  it('selects distinct daemon endpoints and pidfiles for old and new databases', () => {
    seed(legacy, 'legacy');
    const oldSocket = getDaemonSocketPath(root);
    const oldPid = getDaemonPidPath(root);
    expect(path.dirname(oldPid)).toBe(path.dirname(legacy));
    seed(preferred, 'preferred');
    expect(getDaemonSocketPath(root)).not.toBe(oldSocket);
    expect(path.dirname(getDaemonPidPath(root))).toBe(path.dirname(preferred));
    vi.stubEnv('CODEGRAPH_DIR', '.codegraph');
    expect(getDaemonSocketPath(root)).toBe(oldSocket);
    expect(getDaemonPidPath(root)).toBe(oldPid);
  });

  it('prefers the new database when both indexes exist', () => {
    seed(legacy, 'legacy');
    seed(preferred, 'preferred');
    expect(getDatabasePath(root)).toBe(preferred);
    expect(openedVersion()).toBe('preferred');
  });

  it('still uses the legacy database if the new directory has no database', () => {
    seed(legacy, 'legacy');
    fs.mkdirSync(path.dirname(preferred));
    fs.writeFileSync(path.join(path.dirname(preferred), 'daemon.log'), 'incomplete initialization');
    expect(getDatabasePath(root)).toBe(legacy);
    expect(openedVersion()).toBe('legacy');
  });

  it('does not mask a corrupt preferred database by returning legacy results', () => {
    seed(legacy, 'legacy');
    fs.mkdirSync(path.dirname(preferred));
    fs.writeFileSync(preferred, 'corrupt preferred database');
    expect(getDatabasePath(root)).toBe(preferred);
    // Isolate the failed SQLite open so Windows releases its file handle when
    // the child exits, even if the SQLite adapter cannot finish construction.
    const child = spawnSync(process.execPath, [
      '--liftoff-only', '-e',
      'require(process.argv[1]).default.openSync(process.argv[2])',
      path.resolve(__dirname, '../dist'), root,
    ], { encoding: 'utf8', env: process.env });
    expect(child.status).toBe(1);
    expect(child.stderr).toContain('not a database');
  });

  it.each(['0', 'false'])('disables automatic legacy discovery with %s', disabled => {
    seed(legacy, 'legacy');
    vi.stubEnv('CODEGRAPH_LEGACY_COMPAT', disabled);
    expect(getDatabasePath(root)).toBe(preferred);
    expect(isInitialized(root)).toBe(false);
    expect(findNearestCodeGraphRoot(root)).toBeNull();
    expect(() => CodeGraph.openSync(root)).toThrow(/not initialized/);
    const cg = CodeGraph.initSync(root);
    cg.close();
    expect(fs.existsSync(preferred)).toBe(true);
    expect(fs.existsSync(legacy)).toBe(true);
  });

  it('does not let compatibility override an explicit CODEGRAPH_DIR', () => {
    seed(legacy, 'legacy');
    seed(preferred, 'preferred');
    vi.stubEnv('CODEGRAPH_DIR', '.custom-index');
    expect(getDatabasePath(root)).toBe(path.join(root, '.custom-index', 'codegraph.db'));
    expect(isInitialized(root)).toBe(false);
  });

  it('keeps an explicitly selected legacy directory usable when automatic fallback is off', () => {
    seed(legacy, 'legacy');
    vi.stubEnv('CODEGRAPH_DIR', '.codegraph');
    vi.stubEnv('CODEGRAPH_LEGACY_COMPAT', '0');
    expect(getDatabasePath(root)).toBe(legacy);
    expect(openedVersion()).toBe('legacy');
  });

  it.each(['.codegraph', '.codegraph-wx'])('keeps CLI, MCP search and sync working with %s', async directory => {
    vi.stubEnv('CODEGRAPH_DIR', directory);
    fs.writeFileSync(path.join(root, 'main.c'), 'int legacyOnly(void) { return 1; }\n');
    const initialized = await CodeGraph.init(root, { index: true });
    initialized.close();
    vi.stubEnv('CODEGRAPH_DIR', '');

    const run = (...args: string[]) => spawnSync(process.execPath, [
      '--liftoff-only', path.resolve(__dirname, '../dist/bin/codegraph.js'), ...args,
    ], { cwd: root, encoding: 'utf8', env: { ...process.env, CODEGRAPH_NO_DAEMON: '1' } });
    const status = run('status', '--json');
    expect(status.status, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout).indexPath).toBe(path.join(root, directory));
    const query = run('query', 'legacyOnly', '--json');
    expect(query.status, query.stderr).toBe(0);
    expect(query.stdout).toContain('legacyOnly');

    // Production uses CommonJS lazy requires; exercise the built MCP module
    // so cross-project discovery loads the same index implementation as CLI.
    const { ToolHandler } = require('../dist/mcp/tools') as typeof import('../src/mcp/tools');
    const handler = new ToolHandler(null);
    try {
      expect(handler.getTools().map(tool => tool.name)).toContain('search');
      const result = await handler.execute('search', { query: 'legacyOnly', projectPath: root });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      expect(JSON.stringify(result.content)).toContain('legacyOnly');
    } finally {
      handler.closeAll();
    }

    fs.writeFileSync(path.join(root, 'main.c'), 'int afterSync(void) { return 2; }\n');
    const sync = run('sync');
    expect(sync.status, sync.stderr).toBe(0);
    const updated = run('query', 'afterSync', '--json');
    expect(updated.status, updated.stderr).toBe(0);
    expect(updated.stdout).toContain('afterSync');
    if (directory === '.codegraph') expect(fs.existsSync(preferred)).toBe(false);
  });
});
