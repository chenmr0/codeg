import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { CODEAGENT_REMINDER_EXTENSION_SOURCE } from '../src/installer/codeagent-reminder-extension';

describe('CodeAgent CodeGraph native-tool reminder extension', () => {
  let dir: string;
  let afterHook: (input: any, output: any) => Promise<void>;
  let messagesHook: (input: any, output: any) => Promise<void>;
  let eventHook: (input: any) => Promise<void>;

  const userMsg = (content: unknown) => ({
    type: 'user',
    message: { role: 'user', content },
  });
  const assistantMsg = () => ({
    type: 'assistant',
    message: { role: 'assistant', content: 'done' },
  });
  const toolOutput = (output: string) => ({ output, title: '', metadata: {} });

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-codeagent-reminder-'));
    const extensionFile = path.join(dir, 'codegraph-wx-reminder.mjs');
    fs.writeFileSync(extensionFile, CODEAGENT_REMINDER_EXTENSION_SOURCE);
    const extensionModule = await import(`${pathToFileURL(extensionFile).href}?test=${Date.now()}-${Math.random()}`);
    const extension = await extensionModule.default({
      client: { getSessionId: () => 's1' },
      directory: dir,
      worktree: dir,
    });
    afterHook = extension.tool.executeAfter;
    messagesHook = extension.experimental.chat.messagesTransform;
    eventHook = extension.event;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does nothing when the current repository is not indexed', async () => {
    const output = toolOutput('int main() {}');
    await afterHook({ tool: 'read', sessionID: 's1', args: { file_path: 'main.cpp' } }, output);
    const messages = [userMsg('hello')];
    await messagesHook({}, { messages });
    expect(output.output).toBe('int main() {}');
    expect(messages[0].message.content).toBe('hello');
  });

  it('appends a real reminder to the last user message after indexed source read without changing tool output', async () => {
    fs.mkdirSync(path.join(dir, '.codegraph-wx'));
    const first = toolOutput('int main() {}');
    await afterHook({ tool: 'read', sessionID: 's1', args: { file_path: 'main.cpp' } }, first);
    expect(first.output).toBe('int main() {}');

    const messages = [userMsg('hello')];
    await messagesHook({}, { messages });
    expect(messages).toHaveLength(1);
    expect(messages[0].message.content).toContain('[CODEGRAPH_WX_DYNAMIC_SYSTEM_REMINDER]');
    expect(messages[0].message.content).toContain('优先使用 CodeGraph wx 系列工具，而不是read、grep、Bash源码搜索等。');
    expect(messages[0].message.content).not.toContain('<system-reminder>');

    // The reminder stays armed across model requests so an auxiliary model
    // request cannot consume it before the main agent sees it.
    const repeated = [userMsg('next')];
    await messagesHook({}, { messages: repeated });
    expect(repeated[0].message.content).toContain('优先使用 CodeGraph wx 系列工具');

    // Reusing the same message array must not duplicate the reminder.
    await messagesHook({}, { messages: repeated });
    expect(repeated[0].message.content).toContain('优先使用 CodeGraph wx 系列工具');
    expect(repeated[0].message.content.indexOf('[CODEGRAPH_WX_DYNAMIC_SYSTEM_REMINDER]'))
      .toBe(repeated[0].message.content.lastIndexOf('[CODEGRAPH_WX_DYNAMIC_SYSTEM_REMINDER]'));
  });

  it('appends a text block when the last user message content is an array', async () => {
    fs.mkdirSync(path.join(dir, '.codegraph-wx'));
    await afterHook({ tool: 'read', sessionID: 's1', args: { file_path: 'main.cpp' } }, toolOutput('source'));

    const messages = [userMsg([{ type: 'text', text: 'x' }])];
    await messagesHook({}, { messages });
    const content = messages[0].message.content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: 'text', text: 'x' });
    expect(content[1].text).toContain('优先使用 CodeGraph wx 系列工具');
  });

  it('injects copy-on-write without mutating the original message object', async () => {
    fs.mkdirSync(path.join(dir, '.codegraph-wx'));
    await afterHook({ tool: 'read', sessionID: 's1', args: { file_path: 'main.cpp' } }, toolOutput('source'));

    const original = userMsg('hello');
    const messages = [original];
    await messagesHook({}, { messages });
    expect(messages[0].message.content).toContain('优先使用 CodeGraph wx 系列工具');
    // The session history object must stay untouched — normalized messages
    // can share references with it.
    expect(original.message.content).toBe('hello');
  });

  it('does not arm the reminder for docs', async () => {
    fs.mkdirSync(path.join(dir, '.codegraph-wx'));

    await afterHook({ tool: 'read', sessionID: 's1', args: { file_path: 'README.md' } }, toolOutput('# Guide'));
    const messages = [userMsg('hello')];
    await messagesHook({}, { messages });
    expect(messages[0].message.content).toBe('hello');
  });

  it('recognizes source paths in grep output and clears or re-arms around CodeGraph use', async () => {
    fs.mkdirSync(path.join(dir, '.codegraph-wx'));
    const grep = toolOutput('src/channel.cpp:42: get_dfc()');
    await afterHook({ tool: 'grep', sessionID: 's1', args: { path: 'src', pattern: 'get_dfc' } }, grep);
    const armed = [userMsg('hello')];
    await messagesHook({}, { messages: armed });
    expect(armed[0].message.content).toContain('优先使用 CodeGraph wx 系列工具');
    expect(grep.output).toBe('src/channel.cpp:42: get_dfc()');

    await afterHook({ tool: 'mcp__codegraph__search', sessionID: 's1', args: { query: 'get_dfc' } }, toolOutput('community hit'));
    const stillArmed = [userMsg('hello')];
    await messagesHook({}, { messages: stillArmed });
    expect(stillArmed[0].message.content).toContain('[CODEGRAPH_WX_DYNAMIC_SYSTEM_REMINDER]');
    await afterHook({ tool: 'mcp__codegraph_wx__search', sessionID: 's1', args: { query: 'get_dfc' } }, toolOutput('hit'));
    const cleared = [userMsg('hello')];
    await messagesHook({}, { messages: cleared });
    expect(cleared[0].message.content).toBe('hello');

    const nextGrep = toolOutput('src/channel.cpp:42: get_dfc()');
    await afterHook({ tool: 'grep', sessionID: 's1', args: { path: 'src', pattern: 'get_dfc' } }, nextGrep);
    const rearmed = [userMsg('hello')];
    await messagesHook({}, { messages: rearmed });
    expect(rearmed[0].message.content).toContain('优先使用 CodeGraph wx 系列工具');
  });

  it('recognizes Bash source discovery without intercepting build commands', async () => {
    fs.mkdirSync(path.join(dir, '.codegraph-wx'));

    const listing = toolOutput('src/channel.cpp\nsrc/channel.h');
    await afterHook({ tool: 'bash', sessionID: 's1', args: { command: 'Get-ChildItem src' } }, listing);
    const armed = [userMsg('hello')];
    await messagesHook({}, { messages: armed });
    expect(armed[0].message.content).toContain('Bash源码搜索');

    await afterHook({ tool: 'mcp__codegraph_wx__files', sessionID: 's1', args: { path: 'src' } }, toolOutput('hit'));
    const build = toolOutput('src/channel.cpp: compiling');
    await afterHook({ tool: 'bash', sessionID: 's1', args: { command: 'npm run build' } }, build);
    const notArmed = [userMsg('hello')];
    await messagesHook({}, { messages: notArmed });
    expect(notArmed[0].message.content).toBe('hello');

    const exactRead = toolOutput('int channel();');
    await afterHook({ tool: 'bash', sessionID: 's1', args: { command: 'Get-Content src/channel.cpp' } }, exactRead);
    const rearmed = [userMsg('hello')];
    await messagesHook({}, { messages: rearmed });
    expect(rearmed[0].message.content).toContain('优先使用 CodeGraph wx 系列工具');
  });

  it('recognizes PowerShell source discovery', async () => {
    fs.mkdirSync(path.join(dir, '.codegraph-wx'));
    await afterHook({ tool: 'powershell', sessionID: 's1', args: { command: 'Get-ChildItem src' } }, toolOutput('src/channel.cpp'));
    const armed = [userMsg('hello')];
    await messagesHook({}, { messages: armed });
    expect(armed[0].message.content).toContain('优先使用 CodeGraph wx 系列工具');
  });

  it('arms on source glob patterns but not on docs patterns', async () => {
    fs.mkdirSync(path.join(dir, '.codegraph-wx'));

    await afterHook({ tool: 'glob', sessionID: 's1', args: { pattern: 'src/**/*.cpp' } }, toolOutput('src/channel.cpp'));
    const armed = [userMsg('hello')];
    await messagesHook({}, { messages: armed });
    expect(armed[0].message.content).toContain('优先使用 CodeGraph wx 系列工具');

    await afterHook({ tool: 'mcp__codegraph_wx__files', sessionID: 's1', args: { path: 'src' } }, toolOutput('hit'));
    await afterHook({ tool: 'glob', sessionID: 's1', args: { pattern: '*.md' } }, toolOutput('README.md'));
    const notArmed = [userMsg('hello')];
    await messagesHook({}, { messages: notArmed });
    expect(notArmed[0].message.content).toBe('hello');
  });

  it('does not redirect a read of a file edited in the same session', async () => {
    fs.mkdirSync(path.join(dir, '.codegraph-wx'));
    await afterHook({ tool: 'edit', sessionID: 's1', args: { file_path: 'main.cpp' } }, toolOutput('done'));
    await afterHook({ tool: 'read', sessionID: 's1', args: { file_path: 'main.cpp' } }, toolOutput('new source'));
    const messages = [userMsg('hello')];
    await messagesHook({}, { messages });
    expect(messages[0].message.content).toBe('hello');
  });

  it('clears pending reminders when implementation starts or the session ends', async () => {
    fs.mkdirSync(path.join(dir, '.codegraph-wx'));
    const read = () => afterHook(
      { tool: 'read', sessionID: 's1', args: { file_path: 'main.cpp' } },
      toolOutput('source'),
    );
    const expectCleared = async () => {
      const messages = [userMsg('hello')];
      await messagesHook({}, { messages });
      expect(messages[0].message.content).toBe('hello');
    };

    await read();
    await afterHook({ tool: 'edit', sessionID: 's1', args: { file_path: 'other.cpp' } }, toolOutput('done'));
    await expectCleared();

    await read();
    await eventHook({ type: 'session.idle', sessionID: 's1' });
    await expectCleared();

    // Non-idle events and events without a sessionID leave the flag armed.
    await read();
    await eventHook({ type: 'session.created', sessionID: 's1' });
    const stillArmed = [userMsg('hello')];
    await messagesHook({}, { messages: stillArmed });
    expect(stillArmed[0].message.content).toContain('优先使用 CodeGraph wx 系列工具');

    await eventHook({ type: 'session.idle' });
    const stillArmed2 = [userMsg('hello')];
    await messagesHook({}, { messages: stillArmed2 });
    expect(stillArmed2[0].message.content).toContain('优先使用 CodeGraph wx 系列工具');
  });

  it('leaves messages untouched when there is no user message to append to', async () => {
    fs.mkdirSync(path.join(dir, '.codegraph-wx'));
    await afterHook({ tool: 'read', sessionID: 's1', args: { file_path: 'main.cpp' } }, toolOutput('source'));

    const empty: unknown[] = [];
    await messagesHook({}, { messages: empty });
    expect(empty).toEqual([]);

    const onlyAssistant = [assistantMsg()];
    await messagesHook({}, { messages: onlyAssistant });
    expect(onlyAssistant[0].message.content).toBe('done');

    const noContent = [{ type: 'user', message: { role: 'user' } }];
    await messagesHook({}, { messages: noContent });
    expect(noContent[0].message).toEqual({ role: 'user' });
  });

  it('arms the main session when a subagent falls back to native search', async () => {
    fs.mkdirSync(path.join(dir, '.codegraph-wx'));
    // Subagent tool calls carry the subagent's agentId as sessionID; the
    // main session (s1, from client.getSessionId) must also be armed so the
    // orchestrator's next request sees the reminder.
    await afterHook({ tool: 'read', sessionID: 'agent-1', args: { file_path: 'main.cpp' } }, toolOutput('source'));
    const messages = [userMsg('hello')];
    await messagesHook({}, { messages });
    expect(messages[0].message.content).toContain('优先使用 CodeGraph wx 系列工具');
  });
});
