/**
 * CODEGRAPH_MCP_TOOLS allowlist — lets an operator (or an A/B harness) trim the
 * exposed MCP tool surface without touching the client config. Inert when unset.
 * Filtering happens in ListTools (getTools) and is enforced again on execute().
 *
 * Explore is available by default and can be explicitly disabled.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { getStaticTools, ToolHandler } from '../src/mcp/tools';

const ENV = 'CODEGRAPH_MCP_TOOLS';
const EXPLORE_ENV = 'CODEGRAPH_ENABLE_EXPLORE';

describe('CODEGRAPH_MCP_TOOLS allowlist', () => {
  const allowlistOriginal = process.env[ENV];
  const exploreOriginal = process.env[EXPLORE_ENV];
  afterEach(() => {
    if (allowlistOriginal === undefined) delete process.env[ENV];
    else process.env[ENV] = allowlistOriginal;
    if (exploreOriginal === undefined) delete process.env[EXPLORE_ENV];
    else process.env[EXPLORE_ENV] = exploreOriginal;
  });

  const listed = () => new ToolHandler(null).getTools().map(t => t.name).sort();

  it('lists explore by default in static and dynamic discovery', () => {
    delete process.env[ENV];
    delete process.env[EXPLORE_ENV];
    const all = listed();
    expect(all).toContain('explore');
    expect(getStaticTools().map(t => t.name).sort()).toEqual(all);
    expect(all).toContain('context');
    expect(all).toContain('text_search');
    expect(all.every((name) => !name.startsWith('codegraph_'))).toBe(true);
    expect(all.length).toBeGreaterThanOrEqual(7);
  });

  it('exposes codegraph_explore when CODEGRAPH_ENABLE_EXPLORE=1', () => {
    delete process.env[ENV];
    process.env[EXPLORE_ENV] = '1';
    const all = listed();
    expect(all).toContain('explore');
    expect(all.length).toBeGreaterThanOrEqual(8);
  });

  it.each(['0', 'false'])('honors the explicit Explore opt-out %s even when allowlisted', async value => {
    process.env[EXPLORE_ENV] = value;
    process.env[ENV] = 'explore,node';
    expect(listed()).toEqual(['node']);
    expect(getStaticTools().map(t => t.name)).toEqual(['node']);
    expect((await new ToolHandler(null).execute('explore', {})).content[0].text).toMatch(/disabled/);
  });

  it('filters ListTools to the allowlisted short names', () => {
    process.env[EXPLORE_ENV] = '1';
    process.env[ENV] = 'explore,search,node';
    expect(listed()).toEqual(['explore', 'node', 'search']);
  });

  it('allowlists the new exact context and literal text search tools', () => {
    process.env[ENV] = 'context,text_search';
    expect(listed()).toEqual(['context', 'text_search']);
  });

  it('requires short raw names and ignores prefixed allowlist entries', () => {
    process.env[EXPLORE_ENV] = '1';
    process.env[ENV] = ' codegraph_explore , search ';
    expect(listed()).toEqual(['search']);
  });

  it('treats a whitespace allowlist as unset', () => {
    process.env[ENV] = '   ';
    delete process.env[EXPLORE_ENV];
    expect(listed()).toContain('explore');
  });

  it('rejects a disabled tool on execute (defense in depth)', async () => {
    process.env[ENV] = 'node';
    const res = await new ToolHandler(null).execute('explore', {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/disabled/);
  });

  it('lets an allowlisted tool past the guard', async () => {
    process.env[ENV] = 'search';
    // No CodeGraph attached, so it fails *after* the allowlist guard — the
    // "disabled" message must NOT appear, proving the guard passed it through.
    const res = await new ToolHandler(null).execute('search', { query: 'x' });
    expect(res.content[0].text).not.toMatch(/disabled/);
  });
});
