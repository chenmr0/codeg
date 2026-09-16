import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { OPENCODE_REMINDER_PLUGIN_SOURCE } from '../src/installer/opencode-reminder-plugin';

describe('OpenCode CodeGraph native-tool reminder plugin', () => {
  let dir: string;
  let afterHook: (input: any, output: any) => Promise<void>;
  let systemHook: (input: any, output: any) => Promise<void>;
  let eventHook: (input: any) => Promise<void>;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-opencode-reminder-'));
    const pluginFile = path.join(dir, 'codegraph-wx-reminder.mjs');
    fs.writeFileSync(pluginFile, OPENCODE_REMINDER_PLUGIN_SOURCE);
    const pluginModule = await import(`${pathToFileURL(pluginFile).href}?test=${Date.now()}-${Math.random()}`);
    const plugin = await pluginModule.CodeGraphReminderPlugin({ directory: dir, worktree: dir });
    afterHook = plugin['tool.execute.after'];
    systemHook = plugin['experimental.chat.system.transform'];
    eventHook = plugin.event;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does nothing when the current repository is not indexed', async () => {
    const output = { output: 'int main() {}', title: '', metadata: {} };
    await afterHook({ tool: 'read', sessionID: 's1', args: { filePath: 'main.cpp' } }, output);
    const system = { system: ['base'] };
    await systemHook({ sessionID: 's1' }, system);
    expect(output.output).toBe('int main() {}');
    expect(system.system).toEqual(['base']);
  });

  it('injects a real system reminder after indexed source read without changing tool output', async () => {
    fs.mkdirSync(path.join(dir, '.codegraph-wx'));
    const first = { output: 'int main() {}', title: '', metadata: {} };
    await afterHook({ tool: 'read', sessionID: 's1', args: { filePath: 'main.cpp' } }, first);
    expect(first.output).toBe('int main() {}');

    const firstSystem = { system: ['base'] };
    await systemHook({ sessionID: 's1' }, firstSystem);
    expect(firstSystem.system).toHaveLength(2);
    expect(firstSystem.system[1]).toContain('[CODEGRAPH_WX_DYNAMIC_SYSTEM_REMINDER]');
    expect(firstSystem.system[1]).toContain('优先使用 CodeGraph wx 系列工具，而不是read、grep、Bash源码搜索等。');
    expect(firstSystem.system[1]).not.toContain('<system-reminder>');

    // The reminder stays armed across model requests so an auxiliary model
    // request cannot consume it before the main agent sees it.
    const repeatedSystem = { system: ['base'] };
    await systemHook({ sessionID: 's1' }, repeatedSystem);
    expect(repeatedSystem.system).toHaveLength(2);

    // Reusing the same output array must not duplicate the system entry.
    await systemHook({ sessionID: 's1' }, repeatedSystem);
    expect(repeatedSystem.system).toHaveLength(2);
  });

  it('does not arm the reminder for docs', async () => {
    fs.mkdirSync(path.join(dir, '.codegraph-wx'));

    const docs = { output: '# Guide', title: '', metadata: {} };
    await afterHook({ tool: 'read', sessionID: 's1', args: { filePath: 'README.md' } }, docs);
    const system = { system: ['base'] };
    await systemHook({ sessionID: 's1' }, system);
    expect(system.system).toEqual(['base']);
  });

  it('recognizes source paths in grep output and clears or re-arms around CodeGraph use', async () => {
    fs.mkdirSync(path.join(dir, '.codegraph-wx'));
    const grep = { output: 'src/channel.cpp:42: get_dfc()', title: '', metadata: {} };
    await afterHook({ tool: 'grep', sessionID: 's1', args: { path: 'src', pattern: 'get_dfc' } }, grep);
    const armed = { system: ['base'] };
    await systemHook({ sessionID: 's1' }, armed);
    expect(armed.system.join('\n')).toContain('优先使用 CodeGraph wx 系列工具');
    expect(grep.output).toBe('src/channel.cpp:42: get_dfc()');

    await afterHook({ tool: 'codegraph_search', sessionID: 's1', args: { query: 'get_dfc' } }, { output: 'community hit' });
    const stillArmed = { system: ['base'] };
    await systemHook({ sessionID: 's1' }, stillArmed);
    expect(stillArmed.system.join('\n')).toContain('优先使用 CodeGraph wx 系列工具');
    await afterHook({ tool: 'codegraph_wx_search', sessionID: 's1', args: { query: 'get_dfc' } }, { output: 'hit' });
    const cleared = { system: ['base'] };
    await systemHook({ sessionID: 's1' }, cleared);
    expect(cleared.system).toEqual(['base']);

    const nextGrep = { output: 'src/channel.cpp:42: get_dfc()', title: '', metadata: {} };
    await afterHook({ tool: 'grep', sessionID: 's1', args: { path: 'src', pattern: 'get_dfc' } }, nextGrep);
    const rearmed = { system: ['base'] };
    await systemHook({ sessionID: 's1' }, rearmed);
    expect(rearmed.system.join('\n')).toContain('优先使用 CodeGraph wx 系列工具');
  });

  it('recognizes Bash source discovery without intercepting build commands', async () => {
    fs.mkdirSync(path.join(dir, '.codegraph-wx'));

    const listing = { output: 'src/channel.cpp\nsrc/channel.h', title: '', metadata: {} };
    await afterHook({ tool: 'bash', sessionID: 's1', args: { command: 'Get-ChildItem src' } }, listing);
    const armed = { system: ['base'] };
    await systemHook({ sessionID: 's1' }, armed);
    expect(armed.system.join('\n')).toContain('Bash源码搜索');

    await afterHook({ tool: 'codegraph_wx_files', sessionID: 's1', args: { path: 'src' } }, { output: 'hit' });
    const build = { output: 'src/channel.cpp: compiling', title: '', metadata: {} };
    await afterHook({ tool: 'bash', sessionID: 's1', args: { command: 'npm run build' } }, build);
    const notArmed = { system: ['base'] };
    await systemHook({ sessionID: 's1' }, notArmed);
    expect(notArmed.system).toEqual(['base']);

    const exactRead = { output: 'int channel();', title: '', metadata: {} };
    await afterHook({ tool: 'bash', sessionID: 's1', args: { command: 'Get-Content src/channel.cpp' } }, exactRead);
    const rearmed = { system: ['base'] };
    await systemHook({ sessionID: 's1' }, rearmed);
    expect(rearmed.system.join('\n')).toContain('优先使用 CodeGraph wx 系列工具');
  });

  it('does not redirect a read of a file edited in the same session', async () => {
    fs.mkdirSync(path.join(dir, '.codegraph-wx'));
    await afterHook({ tool: 'edit', sessionID: 's1', args: { filePath: 'main.cpp' } }, { output: 'done' });
    const output = { output: 'new source', title: '', metadata: {} };
    await afterHook({ tool: 'read', sessionID: 's1', args: { filePath: 'main.cpp' } }, output);
    const system = { system: ['base'] };
    await systemHook({ sessionID: 's1' }, system);
    expect(system.system).toEqual(['base']);
  });

  it('clears pending reminders when implementation starts or the session ends', async () => {
    fs.mkdirSync(path.join(dir, '.codegraph-wx'));
    const read = () => afterHook(
      { tool: 'read', sessionID: 's1', args: { filePath: 'main.cpp' } },
      { output: 'source', title: '', metadata: {} },
    );
    const expectCleared = async () => {
      const system = { system: ['base'] };
      await systemHook({ sessionID: 's1' }, system);
      expect(system.system).toEqual(['base']);
    };

    await read();
    await afterHook({ tool: 'edit', sessionID: 's1', args: { filePath: 'other.cpp' } }, { output: 'done' });
    await expectCleared();

    await read();
    await eventHook({ event: { type: 'session.idle', properties: { sessionID: 's1' } } });
    await expectCleared();

    await read();
    await eventHook({ event: { type: 'session.deleted', properties: { info: { id: 's1' } } } });
    await expectCleared();
  });
});
