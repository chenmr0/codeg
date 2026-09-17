import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ALL_TARGETS } from '../src/installer/targets/registry';
import { opencodeTarget } from '../src/installer/targets/opencode';
import { codeagentTarget } from '../src/installer/targets/codeagent';
import { getCodeGraphPermissions, getMcpServerConfig } from '../src/installer/targets/shared';
import { CODEGRAPH_INSTRUCTIONS_BLOCK } from '../src/installer/instructions-template';
import { INSTRUCTION_MARKERS, resetManagedSections } from '../src/installer/managed-sections';
import { atomicWriteFileSync, readConfigFile, removeConfigFile, withConfigTransaction } from '../src/installer/config-transaction';

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  const renameSync = vi.fn(actual.renameSync);
  return { ...actual, renameSync, default: { ...actual, renameSync } };
});

const legacy = '<!-- CODEGRAPH_START -->\nuser-edited legacy block\n<!-- CODEGRAPH_END -->';
const wx = '<!-- CODEGRAPH_WX_START -->\nuser-edited wx block\n<!-- CODEGRAPH_WX_END -->';
const json = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
function put(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe('managed installer migration', () => {
  let home: string;
  let cwd: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-migration-'));
    cwd = process.cwd();
    process.chdir(home);
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('XDG_CONFIG_HOME', path.join(home, '.config'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.chdir(cwd);
    fs.rmSync(home, { recursive: true, force: true });
  });

  for (const target of ALL_TARGETS) {
    for (const location of ['global', 'local'] as const) {
      it(`${target.id}/${location}: resets both MCP names and all marked blocks; repeats without writes`, () => {
        const files = target.describePaths(location);
        const config = files.find(file => /\.jsonc?$/.test(file))!;
        const instructions = files.find(file => /(?:AGENTS|CLAUDE|GEMINI)\.md$/.test(file))!;
        const section = target.id === 'opencode' ? 'mcp' : 'mcpServers';
        const sibling = { command: 'community-custom', args: ['--keep'] };
        put(config, JSON.stringify({ theme: 'keep', [section]: {
          codegraph: { command: 'old-edited', env: { CUSTOM: 'old' } },
          codegraph_wx: { command: 'wx-edited', enabled: false, timeout: 42 },
          codegraph_community: sibling,
        } }));
        const prefix = '\uFEFFUser prefix  \r\n';
        const middle = '\r\nKeep between blocks  \r\n';
        const suffix = '\r\nUser suffix without newline';
        put(instructions, prefix + legacy + middle + wx + legacy + suffix);
        const first = target.install(location, { autoAllow: true });
        const result = json(config);
        expect(result.theme).toBe('keep');
        expect(result[section].codegraph).toBeUndefined();
        expect(result[section].codegraph_community).toEqual(sibling);
        if (target.id !== 'opencode') expect(result[section].codegraph_wx).toEqual(getMcpServerConfig());
        else {
          expect(result.mcp.codegraph_wx.enabled).toBe(true);
          expect(result.mcp.codegraph_wx.timeout).toBeUndefined();
          expect(result.mcp.codegraph_wx.command).toContain('--mcp');
        }
        expect(fs.readFileSync(instructions, 'utf8')).toBe(prefix + CODEGRAPH_INSTRUCTIONS_BLOCK + middle + suffix);
        expect(first.notes?.some(note => note.includes('Backup:'))).toBe(true);
        const backupRoot = path.join(home, '.codegraph-wx', 'install-backups');
        const backups = fs.readdirSync(backupRoot);
        const second = target.install(location, { autoAllow: true });
        expect(second.files.every(file => file.action === 'unchanged')).toBe(true);
        expect(second.notes).toBeUndefined();
        expect(fs.readdirSync(backupRoot)).toEqual(backups);
      });
    }
  }

  it('OpenCode removes old plugin files and duplicate MCP keys, preserving comments and unrelated plugins', () => {
    const dir = path.join(home, '.config', 'opencode');
    const config = path.join(dir, 'opencode.jsonc');
    put(config, '{\n// keep this comment\n"mcp": {"codegraph": {}, "codegraph": {"custom":true}, "other": {"keep":true}}\n}');
    const oldPlugin = path.join(dir, 'plugins', 'codegraph-reminder.js');
    const other = path.join(dir, 'plugins', 'my-reminder.js');
    put(oldPlugin, 'user edits inside managed filename');
    put(other, 'keep plugin');
    opencodeTarget.install('global', { autoAllow: false });
    const text = fs.readFileSync(config, 'utf8');
    expect(text).toContain('// keep this comment');
    expect(text).not.toContain('"codegraph"');
    expect(text).toContain('"other"');
    expect(fs.existsSync(oldPlugin)).toBe(false);
    expect(fs.readFileSync(other, 'utf8')).toBe('keep plugin');
    const backupRoot = path.join(home, '.codegraph-wx', 'install-backups');
    const backupDir = path.join(backupRoot, fs.readdirSync(backupRoot)[0]!);
    const manifest = json(path.join(backupDir, 'manifest.json'));
    const entry = manifest.files.find((file: any) => file.path === oldPlugin);
    expect(fs.readFileSync(path.join(backupDir, entry.backup), 'utf8')).toBe('user edits inside managed filename');
  });

  for (const location of ['global', 'local'] as const) {
    it(`CodeAgent/${location}: removes the disabled explore allow rule on reinstall`, () => {
      const settings = path.join(home, '.cac', 'settings.json');
      put(settings, JSON.stringify({ permissions: {
        allow: ['mcp__codegraph_wx__explore', 'mcp__codegraph__explore', 'mcp__codegraph_wx__search', 'Bash(git status)'],
        deny: ['Bash(rm *)'],
      } }));
      codeagentTarget.install(location, { autoAllow: true });
      const permissions = json(settings).permissions;
      expect(permissions.allow).not.toContain('mcp__codegraph_wx__explore');
      expect(permissions.allow).not.toContain('mcp__codegraph__explore');
      expect(permissions.allow).toContain('mcp__codegraph_wx__search');
      expect(permissions.allow).toContain('Bash(git status)');
      expect(permissions.deny).toEqual(['Bash(rm *)']);
      const first = fs.readFileSync(settings, 'utf8');
      codeagentTarget.install(location, { autoAllow: true });
      expect(fs.readFileSync(settings, 'utf8')).toBe(first);
    });

    it(`CodeAgent/${location}: resets fixed extension paths and permissions without matching unrelated basenames`, () => {
      const dir = path.join(home, '.cac');
      const oldFile = path.join(dir, 'extensions', 'codegraph-reminder.ts');
      const newFile = path.join(dir, 'extensions', 'codegraph-wx-reminder.ts');
      const config = path.join(dir, 'extensions.json');
      const prefix = location === 'global' ? './extensions/' : './.cac/extensions/';
      const other = { path: './custom/codegraph-wx-reminder.ts', options: { keep: true } };
      put(config, JSON.stringify({ extra: true, extensions: [oldFile, [prefix + 'codegraph-reminder.ts', { custom: true }], { path: newFile, options: { custom: true } }, other] }));
      put(oldFile, 'customized old');
      put(newFile, 'customized new');
      const settings = path.join(dir, 'settings.json');
      put(settings, JSON.stringify({ permissions: { allow: ['mcp__codegraph__search', 'mcp__codegraph_wx__custom', 'Bash(git status)'], deny: ['Bash(rm *)'] },
        hooks: { Stop: [{ hooks: [{ command: 'codegraph sync-if-dirty' }, { command: 'echo keep' }] }] } }));
      codeagentTarget.install(location, { autoAllow: false });
      expect(fs.existsSync(oldFile)).toBe(false);
      expect(fs.readFileSync(newFile, 'utf8')).not.toBe('customized new');
      expect(json(config)).toEqual({ extra: true, extensions: [other, prefix + 'codegraph-wx-reminder.ts'] });
      expect(json(settings).permissions).toEqual({ allow: ['Bash(git status)'], deny: ['Bash(rm *)'] });
      expect(json(settings).hooks.Stop[0].hooks).toEqual([{ command: 'echo keep' }]);
      codeagentTarget.install(location, { autoAllow: true });
      expect(json(settings).permissions.allow).toEqual(['Bash(git status)', ...getCodeGraphPermissions()]);
    });
  }

  it.each([
    '<!-- CODEGRAPH_START -->missing end',
    '<!-- CODEGRAPH_END -->',
    '<!-- CODEGRAPH_START --><!-- CODEGRAPH_WX_END -->',
    '<!-- CODEGRAPH_START -->' + wx + '<!-- CODEGRAPH_END -->',
  ])('rejects malformed marker pairs before changing any files: %s', malformed => {
    const config = path.join(home, '.cac.json');
    const instructions = path.join(home, '.cac', 'AGENTS.md');
    const original = '{"mcpServers":{"codegraph":{"custom":true}}}';
    put(config, original);
    put(instructions, malformed);
    expect(() => codeagentTarget.install('global', { autoAllow: true })).toThrow(/marker/);
    expect(fs.readFileSync(config, 'utf8')).toBe(original);
    expect(fs.readFileSync(instructions, 'utf8')).toBe(malformed);
    expect(fs.existsSync(path.join(home, '.cac', 'settings.json'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.codegraph-wx', 'install-backups'))).toBe(false);
  });

  it('rejects malformed JSONC and invalid settings shapes without applying earlier planned changes', () => {
    const config = path.join(home, '.config', 'opencode', 'opencode.jsonc');
    put(config, '{"mcp": {"codegraph": {}, BROKEN}}');
    expect(() => opencodeTarget.install('global', { autoAllow: false })).toThrow(/JSONC/);
    expect(fs.readFileSync(config, 'utf8')).toContain('BROKEN');
    put(path.join(home, '.cac', 'settings.json'), '{"permissions":{"allow":"bad"}}');
    expect(() => codeagentTarget.install('global', { autoAllow: true })).toThrow(/must be an array/);
    expect(fs.existsSync(path.join(home, '.cac.json'))).toBe(false);
  });

  it('handles JSONC BOM and repeated current entries, and rejects ambiguous duplicate wrappers', () => {
    const config = path.join(home, '.config', 'opencode', 'opencode.jsonc');
    put(config, '\uFEFF{"mcp": {}}');
    opencodeTarget.install('global', { autoAllow: false });
    const entry = JSON.stringify(JSON.parse(fs.readFileSync(config, 'utf8').replace(/^\uFEFF/, '')).mcp.codegraph_wx);
    put(config, `{"mcp":{"codegraph_wx":${entry},"codegraph_wx":${entry}}}`);
    opencodeTarget.install('global', { autoAllow: false });
    expect(fs.readFileSync(config, 'utf8').match(/"codegraph_wx"/g)).toHaveLength(1);
    const ambiguous = '{"mcp":{},"mcp":{"codegraph":{}}}';
    put(config, ambiguous);
    expect(() => opencodeTarget.install('global', { autoAllow: false })).toThrow(/Duplicate.*mcp/);
    expect(fs.readFileSync(config, 'utf8')).toBe(ambiguous);
  });

  it('rolls back prior writes, removals and new files after a later write fails', async () => {
    const existing = path.join(home, 'existing.json');
    const removed = path.join(home, 'old.js');
    const created = path.join(home, 'new.js');
    const failing = path.join(home, 'last.json');
    put(existing, '\uFEFForiginal\r\n');
    put(removed, 'old custom script');
    const rename = (await vi.importActual<typeof import('fs')>('fs')).renameSync;
    vi.mocked(fs.renameSync).mockImplementation((source, destination) => {
      if (destination === failing) throw new Error('injected write failure');
      return rename(source, destination);
    });
    expect(() => withConfigTransaction('test rollback', () => {
      atomicWriteFileSync(existing, 'updated');
      expect(readConfigFile(existing)).toBe('updated');
      removeConfigFile(removed);
      atomicWriteFileSync(created, 'created');
      atomicWriteFileSync(failing, 'failure');
      return { notes: [] };
    })).toThrow(/Configuration changes rolled back/);
    expect(fs.readFileSync(existing, 'utf8')).toBe('\uFEFForiginal\r\n');
    expect(fs.readFileSync(removed, 'utf8')).toBe('old custom script');
    expect(fs.existsSync(created)).toBe(false);
    expect(fs.existsSync(failing)).toBe(false);
  });

  it('detects concurrent changes instead of overwriting the newer configuration', () => {
    const file = path.join(home, 'settings.json');
    put(file, 'original');
    expect(() => withConfigTransaction('concurrent change', () => {
      atomicWriteFileSync(file, 'installer result');
      put(file, 'saved by client');
      return { notes: [] };
    })).toThrow(/changed during install/);
    expect(fs.readFileSync(file, 'utf8')).toBe('saved by client');
  });

  it('removes every managed block while retaining the exact outside text', () => {
    expect(resetManagedSections('a' + legacy + 'b' + wx + 'c', INSTRUCTION_MARKERS).content).toBe('abc');
  });
});
