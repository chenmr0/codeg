import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { codeagentTarget } from '../src/installer/targets/codeagent';
import { getCodeAgentMcpServerConfig } from '../src/installer/codeagent-config';
import { getCodeGraphPermissions, getMcpServerConfig } from '../src/installer/targets/shared';
import { CODEGRAPH_INSTRUCTIONS_BLOCK } from '../src/installer/instructions-template';
import { CODEAGENT_REMINDER_EXTENSION_SOURCE } from '../src/installer/codeagent-reminder-extension';
import type { Location } from '../src/installer/targets/types';

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  const renameSync = vi.fn(actual.renameSync);
  return { ...actual, renameSync, default: { ...actual, renameSync } };
});

const wxBlock = '<!-- CODEGRAPH_WX_START -->\nold wx rules\n<!-- CODEGRAPH_WX_END -->';
const oldBlock = '<!-- CODEGRAPH_START -->\nold rules\n<!-- CODEGRAPH_END -->';
const json = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
function put(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe('CAC migration from the wx installer', () => {
  let home: string;
  let project: string;
  let previousCwd: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cac-migration-'));
    project = path.join(home, 'project');
    fs.mkdirSync(project);
    previousCwd = process.cwd();
    process.chdir(project);
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.chdir(previousCwd);
    fs.rmSync(home, { recursive: true, force: true });
  });

  function paths(location: Location) {
    const base = location === 'global' ? home : project;
    const config = path.join(base, '.cac');
    return {
      config,
      mcp: path.join(base, location === 'global' ? '.cac.json' : '.mcp.json'),
      settings: path.join(config, 'settings.json'),
      instructions: location === 'global' ? path.join(config, 'AGENTS.md') : path.join(base, 'AGENTS.md'),
      extensions: path.join(config, 'extensions.json'),
      legacy: path.join(config, 'extensions/codegraph-wx-reminder.ts'),
      current: path.join(config, 'extensions/codegraph-reminder.ts'),
      prefix: location === 'global' ? './extensions/' : './.cac/extensions/',
    };
  }

  function seed(location: Location, dual: boolean) {
    const p = paths(location);
    put(p.mcp, JSON.stringify({ extra: true, mcpServers: {
      codegraph_wx: { command: 'node', args: ['old-codegraph.js', 'serve', '--mcp'] },
      ...(dual ? { codegraph: getMcpServerConfig() } : {}),
      codegraph_other: { command: 'keep' }, other: { command: 'other', env: { KEEP: 'yes' } },
    } }));
    put(p.settings, JSON.stringify({ custom: true, permissions: {
      allow: ['mcp__codegraph_wx__explore', 'mcp__codegraph_wx__search', 'mcp__other__search',
        'Bash(git status)', ...(dual ? ['mcp__codegraph__explore', 'mcp__codegraph__search'] : [])],
      deny: ['Bash(rm *)'], ask: ['Bash(git push *)'],
    } }));
    put(p.instructions, 'before\n' + wxBlock + '\nmiddle\n' + (dual ? oldBlock : '') + '\nafter\n');
    put(p.legacy, 'user-customized old wx extension');
    if (dual) put(p.current, CODEAGENT_REMINDER_EXTENSION_SOURCE);
    put(p.extensions, JSON.stringify({ extra: true, extensions: [
      p.prefix + 'codegraph-wx-reminder.ts', [p.legacy, { legacy: true }],
      ...(dual ? [p.prefix + 'codegraph-reminder.ts', { path: p.current }] : []),
      { path: './custom/codegraph-reminder.ts', options: { keep: true } },
      { path: './custom/codegraph-wx-reminder.ts', options: { keep: true } },
      '@scope/codegraph-reminder',
    ] }));
    return p;
  }

  function backups() {
    const root = path.join(home, '.codegraph-wx/install-backups');
    return fs.existsSync(root) ? fs.readdirSync(root).map(name => path.join(root, name)) : [];
  }

  for (const location of ['global', 'local'] as const) {
    it.each(['relative', 'obsolete-absolute'])(location + ': refreshes a current-only MCP launcher: %s', kind => {
      const p = paths(location);
      const old = kind === 'relative' ? getMcpServerConfig() : {
        type: 'stdio', command: path.join(home, 'old node', 'node.exe'),
        args: [path.join(home, 'old install', 'dist/bin/codegraph.js'), 'serve', '--mcp'],
      };
      put(p.mcp, JSON.stringify({ mcpServers: { codegraph: old, other: { command: 'keep' } } }));
      codeagentTarget.install(location, { autoAllow: false });
      const first = fs.readFileSync(p.mcp, 'utf8');
      expect(json(p.mcp).mcpServers).toEqual({
        codegraph: { type: 'stdio', command: process.execPath,
          args: [path.resolve(__dirname, '../dist/bin/codegraph.js'), 'serve', '--mcp'] },
        other: { command: 'keep' },
      });
      const beforeBackups = backups();
      codeagentTarget.install(location, { autoAllow: false });
      expect(fs.readFileSync(p.mcp, 'utf8')).toBe(first);
      expect(backups()).toEqual(beforeBackups);
    });

    it(location + ': print-config uses the same absolute launcher without writing files', () => {
      const p = paths(location);
      const printed = codeagentTarget.printConfig(location);
      const config = JSON.parse(printed.slice(printed.indexOf('{')));
      expect(config.mcpServers.codegraph).toEqual(getCodeAgentMcpServerConfig());
      expect(config.mcpServers.codegraph.command).toBe(process.execPath);
      expect(config.mcpServers.codegraph.args[0]).toBe(path.resolve(__dirname, '../dist/bin/codegraph.js'));
      expect(fs.existsSync(p.mcp)).toBe(false);
      expect(backups()).toEqual([]);
    });

    it.each([false, true])(location + ': consolidates legacy-only/dual config, backs up exact bytes and is idempotent: %s', dual => {
      const p = seed(location, dual);
      const otherScope = paths(location === 'global' ? 'local' : 'global');
      put(otherScope.mcp, '{"mcpServers":{"codegraph_wx":{"command":"other-scope"}}}');
      const sourceFiles = [p.mcp, p.settings, p.instructions, p.extensions, p.legacy, p.current];
      const before = new Map(sourceFiles.filter(file => fs.existsSync(file)).map(file => [file, fs.readFileSync(file)]));
      const indexFile = path.join(project, '.codegraph-wx/codegraph.db');
      put(indexFile, 'index-must-not-change');
      expect(codeagentTarget.detect(location).alreadyConfigured).toBe(true);
      const result = codeagentTarget.install(location, { autoAllow: true });
      const servers = json(p.mcp).mcpServers;
      expect(servers.codegraph_wx).toBeUndefined();
      expect(servers.codegraph).toEqual(getCodeAgentMcpServerConfig());
      expect(servers.codegraph.command).toBe(process.execPath);
      expect(servers.codegraph.args).toEqual([
        path.resolve(__dirname, '../dist/bin/codegraph.js'), 'serve', '--mcp',
      ]);
      expect(path.isAbsolute(servers.codegraph.command)).toBe(true);
      expect(path.isAbsolute(servers.codegraph.args[0])).toBe(true);
      expect(servers.codegraph_other).toEqual({ command: 'keep' });
      expect(servers.other).toEqual({ command: 'other', env: { KEEP: 'yes' } });
      expect(json(p.mcp).extra).toBe(true);
      expect(json(p.settings)).toEqual({ custom: true, permissions: {
        allow: ['mcp__other__search', 'Bash(git status)', ...getCodeGraphPermissions()],
        deny: ['Bash(rm *)'], ask: ['Bash(git push *)'],
      } });
      expect(fs.readFileSync(p.instructions, 'utf8')).toBe('before\n' + CODEGRAPH_INSTRUCTIONS_BLOCK + '\nmiddle\n\nafter\n');
      expect(json(p.extensions)).toEqual({ extra: true, extensions: [
        { path: './custom/codegraph-reminder.ts', options: { keep: true } },
        { path: './custom/codegraph-wx-reminder.ts', options: { keep: true } },
        '@scope/codegraph-reminder', p.prefix + 'codegraph-reminder.ts',
      ] });
      expect(fs.existsSync(p.legacy)).toBe(false);
      expect(fs.readFileSync(p.current, 'utf8')).toBe(CODEAGENT_REMINDER_EXTENSION_SOURCE);
      expect(fs.readFileSync(indexFile, 'utf8')).toBe('index-must-not-change');
      expect(json(otherScope.mcp).mcpServers.codegraph_wx.command).toBe('other-scope');
      expect(result.files.some(file => file.path === p.legacy && file.action === 'removed')).toBe(true);
      const backup = backups()[0]!;
      const manifest = json(path.join(backup, 'manifest.json'));
      for (const [file, original] of before) {
        const entry = manifest.files.find((entry: any) => entry.path === file);
        if (entry) expect(fs.readFileSync(path.join(backup, entry.backup))).toEqual(original);
        else expect(fs.readFileSync(file)).toEqual(original);
      }
      expect(result.notes?.some(note => note.includes('Backup:'))).toBe(true);
      const installed = new Map(sourceFiles.filter(file => fs.existsSync(file)).map(file => [file, fs.readFileSync(file)]));
      const second = codeagentTarget.install(location, { autoAllow: true });
      expect(second.files.every(file => file.action === 'unchanged')).toBe(true);
      expect(second.notes).toBeUndefined();
      expect(backups()).toEqual([backup]);
      for (const [file, content] of installed) expect(fs.readFileSync(file)).toEqual(content);
    });

    it(location + ': removes retired wx allows without granting permissions when autoAllow is false', () => {
      const p = seed(location, true);
      codeagentTarget.install(location, { autoAllow: false });
      expect(json(p.settings).permissions.allow).toEqual([
        'mcp__other__search', 'Bash(git status)', 'mcp__codegraph__explore', 'mcp__codegraph__search',
      ]);
      expect(json(p.settings).permissions.deny).toEqual(['Bash(rm *)']);
      expect(json(p.mcp).mcpServers.codegraph_wx).toBeUndefined();
      expect(fs.existsSync(p.legacy)).toBe(false);
    });

    it(location + ': uninstall removes both generations and preserves unrelated content', () => {
      const p = seed(location, true);
      codeagentTarget.uninstall(location);
      expect(Object.keys(json(p.mcp).mcpServers)).toEqual(['codegraph_other', 'other']);
      expect(json(p.settings).permissions.allow).toEqual(['mcp__other__search', 'Bash(git status)']);
      expect(fs.readFileSync(p.instructions, 'utf8')).toBe('before\n\nmiddle\n\nafter\n');
      expect(json(p.extensions).extensions).toHaveLength(3);
      expect(fs.existsSync(p.legacy)).toBe(false);
      expect(fs.existsSync(p.current)).toBe(false);
    });
  }

  it.each(['markers', 'extensions'])('validates the entire migration before touching files: %s', failure => {
    const p = seed('global', true);
    if (failure === 'markers') put(p.instructions, 'before\n<!-- CODEGRAPH_WX_START -->\nmissing end');
    else put(p.extensions, '{"extensions":{"not":"an array"}}');
    const files = [p.mcp, p.settings, p.instructions, p.extensions, p.legacy, p.current];
    const before = files.map(file => fs.readFileSync(file));
    expect(() => codeagentTarget.install('global', { autoAllow: true })).toThrow();
    files.forEach((file, i) => expect(fs.readFileSync(file)).toEqual(before[i]));
    expect(backups()).toEqual([]);
  });

  it('rolls back already-written settings if a later file replacement fails', () => {
    const p = seed('global', true);
    const files = [p.mcp, p.settings, p.instructions, p.extensions, p.legacy, p.current];
    const before = files.map(file => fs.readFileSync(file));
    const originalRename = vi.mocked(fs.renameSync).getMockImplementation()!;
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      if (String(to) === p.instructions) throw new Error('simulated config write failure');
      originalRename(from, to);
    });
    expect(() => codeagentTarget.install('global', { autoAllow: true })).toThrow(/rolled back/);
    files.forEach((file, i) => expect(fs.readFileSync(file)).toEqual(before[i]));
    expect(backups()).toHaveLength(1);
  });
});
