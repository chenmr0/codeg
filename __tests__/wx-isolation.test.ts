import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src';
import { codeGraphDirName, findNearestCodeGraphRoot, getCodeGraphDir, isCodeGraphDataDir } from '../src/directory';
import { getDaemonPidPath, getDaemonSocketPath } from '../src/mcp/daemon-paths';
import { getWxCliCommand } from '../src/cli/launcher';
import { FileLock } from '../src/utils';
import { scanDirectory } from '../src/extraction';

describe('wx runtime isolation', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-isolation-'));
    vi.stubEnv('CODEGRAPH_DIR', '');
    vi.stubEnv('CODEGRAPH_RUST_SCAN', '0');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('does not discover, import, lock or delete the community index', () => {
    const community = path.join(root, '.codegraph');
    fs.mkdirSync(community);
    const sentinel = Buffer.from('community database: must never be opened by wx');
    fs.writeFileSync(path.join(community, 'codegraph.db'), sentinel);
    fs.writeFileSync(path.join(community, 'daemon.pid'), String(process.pid));
    const communityLock = new FileLock(path.join(community, 'codegraph.lock'));
    communityLock.acquire();
    try {
      expect(CodeGraph.isInitialized(root)).toBe(false);
      expect(findNearestCodeGraphRoot(root)).toBeNull();
      expect(() => CodeGraph.openSync(root)).toThrow(/not initialized/);
      expect(fs.existsSync(getCodeGraphDir(root))).toBe(false);

      const wx = CodeGraph.initSync(root);
      try {
        expect(codeGraphDirName()).toBe('.codegraph-wx');
        expect(findNearestCodeGraphRoot(root)).toBe(root);
        const wxLock = new FileLock(path.join(getCodeGraphDir(root), 'codegraph.lock'));
        wxLock.acquire();
        wxLock.release();
        expect(fs.readFileSync(path.join(community, 'codegraph.lock'), 'utf8')).toBe(String(process.pid));
      } finally {
        wx.uninitialize();
      }
      expect(fs.existsSync(getCodeGraphDir(root))).toBe(false);
      expect(fs.readFileSync(path.join(community, 'codegraph.db'))).toEqual(sentinel);
      expect(fs.readFileSync(path.join(community, 'daemon.pid'), 'utf8')).toBe(String(process.pid));
    } finally {
      communityLock.release();
    }
  });

  it('excludes wx data directories only, without a special community exclusion', () => {
    for (const dir of ['.codegraph', '.codegraph-other', '.codegraph-wx', '.codegraph-wx-win']) {
      fs.mkdirSync(path.join(root, dir));
      fs.writeFileSync(path.join(root, dir, 'sentinel.c'), 'int sentinel;');
    }
    expect(isCodeGraphDataDir('.codegraph')).toBe(false);
    expect(isCodeGraphDataDir('.codegraph-other')).toBe(false);
    const files = scanDirectory(root).map(file => file.replace(/\\/g, '/'));
    expect(files.sort()).toEqual(['.codegraph-other/sentinel.c', '.codegraph/sentinel.c']);
  });

  it('uses a distinct IPC endpoint and pidfile for every wx data directory', () => {
    // Also exercises the POSIX long-path socket fallback when run on Linux/macOS.
    const project = path.join(root, 'long-project-name-'.repeat(12));
    const first = getDaemonSocketPath(project);
    const firstPid = getDaemonPidPath(project);
    expect(first).toContain('codegraph-wx-');
    vi.stubEnv('CODEGRAPH_DIR', '.codegraph-wx-second');
    expect(getDaemonSocketPath(project)).not.toBe(first);
    expect(getDaemonPidPath(project)).not.toBe(firstPid);
    expect(getDaemonSocketPath(project)).toBe(getDaemonSocketPath(project));
  });

  it('binds generated launchers to this package even when PATH has no codegraph', () => {
    vi.stubEnv('PATH', '');
    const cli = getWxCliCommand();
    expect(cli.command).toBe(process.execPath);
    expect(cli.args).toEqual([path.resolve(__dirname, '../dist/bin/codegraph.js')]);
    expect(fs.existsSync(cli.args[0])).toBe(true);
  });
});
