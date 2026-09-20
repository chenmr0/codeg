import { describe, expect, it } from 'vitest';
import { CODEGRAPH_INSTRUCTIONS_BLOCK } from '../src/installer/instructions-template';
import { getCodeGraphPermissions } from '../src/installer/targets/shared';
import { SERVER_INSTRUCTIONS } from '../src/mcp/server-instructions';
import { getStaticTools, ToolHandler } from '../src/mcp/tools';

describe('MCP codegraph_node context-budget guidance', () => {
  const nodeTool = () => getStaticTools().find((tool) => tool.name === 'node')!;

  it('advertises symbol-first guarded file mode', () => {
    const tool = nodeTool();
    expect(tool.description).toMatch(/Prefer SYMBOL MODE/i);
    expect(tool.description).toMatch(/Bare-file\/full-file reads are rejected/i);
    expect(tool.description).not.toMatch(/use it whenever you would Read/i);
  });

  it('publishes bounded file-window guidance without schema-rejecting an auto-correctable request', () => {
    const properties = nodeTool().inputSchema.properties;
    expect(properties.targets?.minItems).toBe(1);
    expect(properties.targets?.maxItems).toBe(8);
    const nodeTarget = properties.targets?.items as any;
    expect(nodeTarget.properties.symbols.maxItems).toBe(32);
    expect(nodeTarget.properties.texts.maxItems).toBe(8);
    expect(nodeTarget.properties.outlineQueries.maxItems).toBe(8);
    expect(nodeTarget.properties.outlineLimit.maximum).toBe(80);
    expect(properties.expand?.enum).toEqual(['declaration_definition', 'none']);
    expect(properties.expectedMissing?.maxItems).toBe(8);
    expect(nodeTool().description).toMatch(/Native BATCH MODE/i);
    expect(properties.limit?.minimum).toBe(1);
    expect(properties.limit?.maximum).toBeUndefined();
    expect(properties.limit?.description).toMatch(/safely clamped to 500/i);
    expect(properties.offset?.minimum).toBe(1);
    expect(properties.outlineLimit?.maximum).toBe(80);
    expect(properties.includeRelations?.default).toBe(false);
    expect(properties.includeCode?.description).toMatch(/safely truncated/i);
    expect(nodeTool().description).toMatch(/relations are omitted by default/i);
  });

  it('publishes bounded batch-context and literal-search schemas', () => {
    const search = getStaticTools().find((tool) => tool.name === 'search')!;
    const context = getStaticTools().find((tool) => tool.name === 'context')!;
    const textSearch = getStaticTools().find((tool) => tool.name === 'text_search')!;
    expect(search.inputSchema.properties.includeCode?.enum).toEqual(['never', 'if_unique']);
    expect(search.inputSchema.properties.signature?.type).toBe('string');
    expect(search.inputSchema.properties.queries?.maxItems).toBe(8);
    expect(search.inputSchema.required).toEqual([]);
    expect(context.inputSchema.properties.targets?.minItems).toBe(1);
    expect(context.inputSchema.properties.targets?.maxItems).toBe(8);
    const contextTarget = context.inputSchema.properties.targets?.items as any;
    expect(contextTarget.properties.members.maxItems).toBe(32);
    expect(contextTarget.properties.offset.description).toMatch(/defaults to 1/i);
    expect(contextTarget.properties.limit.description).toMatch(/maximum 500/i);
    expect(contextTarget.properties.text.description).toMatch(/assertion/i);
    expect(contextTarget.properties.symbolsOnly.type).toBe('boolean');
    expect(contextTarget.properties.outlineQueries.maxItems).toBe(8);
    expect(contextTarget.properties.outlineLimit.maximum).toBe(80);
    expect(context.description).toMatch(/members.*offset.*text/i);
    expect(context.description).toMatch(/preflight/i);
    expect(context.description).toMatch(/bare.*file.*compact symbol outline/i);
    expect(context.description).toMatch(/JSON-stringified targets array is parsed automatically/i);
    expect(textSearch.inputSchema.properties.queries?.maxItems).toBe(8);
    expect(textSearch.inputSchema.required).toEqual(['queries', 'path']);
    expect(textSearch.description).toMatch(/zero-match identifier/i);
    expect(textSearch.description).toMatch(/exact generated file/i);
  });

  it('publishes exact overload hints for every relationship tool', () => {
    for (const name of ['callers', 'callees', 'impact']) {
      const tool = getStaticTools().find((candidate) => candidate.name === name)!;
      expect(tool.inputSchema.properties.file?.type).toBe('string');
      expect(tool.inputSchema.properties.line?.minimum).toBe(1);
      expect(tool.inputSchema.properties.signature?.type).toBe('string');
      expect(tool.description).toMatch(/no graph traversal|no impact traversal/i);
    }
  });

  it('keeps server instructions aligned with runtime guards', () => {
    expect(Buffer.byteLength(SERVER_INSTRUCTIONS, 'utf8')).toBeLessThan(5_000);
    expect(SERVER_INSTRUCTIONS).toMatch(/exact file[^]*line[^]*codegraph_node\(file=/i);
    expect(SERVER_INSTRUCTIONS).not.toContain('use the host Read tool');
    expect(SERVER_INSTRUCTIONS).toContain('{ file, symbolsOnly: true }');
    expect(SERVER_INSTRUCTIONS).toContain('{ file, offset, limit<=500 }');
    expect(SERVER_INSTRUCTIONS).toMatch(/rejects bare\/full-file reads/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/ONE `codegraph_(?:node|context).*targets/i);
    expect(SERVER_INSTRUCTIONS).toContain('codegraph_node(targets=[...])');
    expect(SERVER_INSTRUCTIONS).toMatch(/Preflight is decided by the 20K character budget/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/queries=.*multi-pattern raw-source scan/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/implementation source[^]*compact[^]*declaration pointer/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/virtual-dispatch[^]*family/i);
    expect(SERVER_INSTRUCTIONS).toContain('includeCode: "if_unique"');
    expect(SERVER_INSTRUCTIONS).toMatch(/safely truncated[^]*rather than replaced by an outline/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/trails are off[^]*by default/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/selected container[^]*text[^]*file windows/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/bare[^]*file[^]*compact symbol outline/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/JSON-stringified[^]*parsed automatically/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/ONE `codegraph_text_search` call/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/zero-match identifier/i);
    expect(SERVER_INSTRUCTIONS).toContain('DECLARATION_ONLY');
    expect(SERVER_INSTRUCTIONS).toMatch(/compact\s+raw-source matches/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/backend[^]*cache details[^]*omitted/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/file[^]*line[^]*signature/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/do[^]*not aggregate/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/Do not paginate[^]*file windows/i);
    expect(SERVER_INSTRUCTIONS).not.toMatch(/any time you'd use the `Read` tool/i);
  });

  it('keeps the reviewed Chinese exploration protocol with the existing tool names', () => {
    expect(CODEGRAPH_INSTRUCTIONS_BLOCK).toContain('## codegraph 源码探索协议');
    expect(CODEGRAPH_INSTRUCTIONS_BLOCK).toContain('<!-- CODEGRAPH_START -->');
    expect(CODEGRAPH_INSTRUCTIONS_BLOCK).toContain('<!-- CODEGRAPH_END -->');
    expect(CODEGRAPH_INSTRUCTIONS_BLOCK).not.toContain('CODEGRAPH_WX_');
    expect(CODEGRAPH_INSTRUCTIONS_BLOCK).not.toContain('codegraph_wx_');
    expect(CODEGRAPH_INSTRUCTIONS_BLOCK).toContain('最小充分上下文');
    expect(CODEGRAPH_INSTRUCTIONS_BLOCK).toContain('symbolsOnly=true');
    expect(CODEGRAPH_INSTRUCTIONS_BLOCK).toContain('limit<=500');
    expect(CODEGRAPH_INSTRUCTIONS_BLOCK).toContain('codegraph_context');
    expect(CODEGRAPH_INSTRUCTIONS_BLOCK).toContain('includeCode="if_unique"');
    expect(CODEGRAPH_INSTRUCTIONS_BLOCK).toContain('实现源码和紧凑的声明位置指针');
    expect(CODEGRAPH_INSTRUCTIONS_BLOCK).toContain('CODEGRAPH_SEARCH_FUZZY=1');
    expect(CODEGRAPH_INSTRUCTIONS_BLOCK).toContain('codegraph_search(queries=[...])');
    expect(CODEGRAPH_INSTRUCTIONS_BLOCK).toContain('默认 `includeRelations=false`');
    expect(CODEGRAPH_INSTRUCTIONS_BLOCK).toMatch(/outlineQueries/i);
    expect(CODEGRAPH_INSTRUCTIONS_BLOCK).toContain('基类声明和派生实现两端的调用方');
    expect(CODEGRAPH_INSTRUCTIONS_BLOCK).toContain('codegraph_text_search');
    expect(CODEGRAPH_INSTRUCTIONS_BLOCK).toContain('codegraph_node');
    expect(CODEGRAPH_INSTRUCTIONS_BLOCK).toContain('codegraph_node(targets=[...])');
    expect(CODEGRAPH_INSTRUCTIONS_BLOCK).toContain('DECLARATION_ONLY');
    expect(CODEGRAPH_INSTRUCTIONS_BLOCK).toContain('Scan incomplete');
    expect(CODEGRAPH_INSTRUCTIONS_BLOCK).toContain('项目级提示');
    expect(CODEGRAPH_INSTRUCTIONS_BLOCK).toContain('file');
    expect(CODEGRAPH_INSTRUCTIONS_BLOCK).toContain('line');
    expect(CODEGRAPH_INSTRUCTIONS_BLOCK).toContain('signature');
    expect(CODEGRAPH_INSTRUCTIONS_BLOCK).toContain('关系工具不会聚合不同逻辑重载');
    expect(CODEGRAPH_INSTRUCTIONS_BLOCK).not.toContain('codegraph_codegraph_node');
    expect(CODEGRAPH_INSTRUCTIONS_BLOCK).toContain('裸调用 `codegraph_node(file=<文件>)`');
    expect(CODEGRAPH_INSTRUCTIONS_BLOCK).toContain('**不得再调用 `node` 重读。**');
    expect(CODEGRAPH_INSTRUCTIONS_BLOCK).toContain('信息充分后停止重复探索');
    expect(CODEGRAPH_INSTRUCTIONS_BLOCK).not.toMatch(/Use it INSTEAD of Read/i);
  });

  it('auto-allows the optimized batch tools for Claude-compatible clients', () => {
    const permissions = getCodeGraphPermissions();
    expect(permissions).toContain('mcp__codegraph__context');
    expect(permissions).toContain('mcp__codegraph__text_search');
    expect(permissions).not.toContain('mcp__codegraph__explore');
    expect(permissions.some((permission) => permission.startsWith('mcp__codegraph__codegraph_'))).toBe(false);
  });

  it('does not accept the removed prefixed raw MCP names', async () => {
    const result = await new ToolHandler(null).execute('codegraph_node', { symbol: 'Widget' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/Unknown tool: codegraph_node/);
  });
});
